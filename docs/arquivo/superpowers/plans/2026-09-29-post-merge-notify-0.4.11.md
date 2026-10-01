> Arquivo histórico. Este documento descreve o converge, que saiu do plugin na 0.5.0 pelo [ADR 0005](../../../adr/0005-autopilot-substitui-converge.md), em 2026-09-30. Nada aqui vale mais, e parte dos links não abre.

# Post-merge notifications 0.4.11 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a recorded post-merge failure and a hold visible on the operator's Mac. Both already post one comment, but the comment goes out under the PR author's own `gh` account, and GitHub notifies no one of their own comment (R98 of the [post-merge plan](2026-09-29-post-merge-0.4.10.md)).

**Architecture:** A new `local/notify.ts` runs `osascript -e 'display notification …'` with a 10-second cap and returns why it failed instead of throwing. Two hooks call it where the comment already goes out once: `attempt()` in `local/post-merge.ts`, when it records `failed`, and `hold()` in `local/local.ts`. A notification that fails is one more tick error, and nothing else changes.

**Tech Stack:** Node 24 with type stripping, `node --test`, `osascript` (part of macOS); the fake GitHub fixture in `skills/poteto-mode/scripts/converge/fixtures/`, which now also writes a fake `osascript`.

**Spec:** the approved report `~/Dev/Skills/pstack-vic-runs/2026-09-29-pos-merge-aviso/relatorio.md` and its evidence file, including the launchd probe: `osascript` run from a throwaway LaunchAgent in `gui/501` (Aqua session, no TTY, minimal `PATH`) exited 0 in 0.15 s with no permission prompt, and both probe notifications reached Notification Center under Script Editor. The **Local daemon** section of [`converge-contract.md`](../../../skills/poteto-mode/references/converge-contract.md) must stay true to the code.

## Global Constraints

- Node 24, no runtime dependencies, erasable TypeScript only, explicit `.ts` import specifiers. `osascript` runs through `spawnSync` with an argv array, never a shell string.
- Tests never show a real notification: every converge fixture puts a fake `osascript` first on `PATH`, and the only real `osascript` call in the suite is a macOS-only `return "…"` that shows nothing.
- No fake, copy or link of a binary under `skills/`. Fakes live in each test's temporary directory.
- Version 0.4.11 in `package.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json` (`version` and `ref`), and the `--ref` lines of `README.md` and `docs/reference.md`. `docs/pre-pr.md` and `scripts/after-merge.test.ts` name versions as history and as fixture data, so they do not follow the bump.

## Review Focus

1. **osascript absent** (a Linux runner, a `PATH` without `/usr/bin`). The tick must go on, report `notification failed: osascript did not start: spawnSync osascript ENOENT`, and keep the hold. Task 2, test "a hold with no osascript on PATH still stands".
2. **osascript that hangs** (a permission prompt on a future macOS). The cap must end it with `SIGKILL` at 10 seconds. Task 1, the timeout case with a 0.3-second cap.
3. **Quotes and backslashes in the text.** A reason or a repository name must not break the AppleScript string. Task 1, the escaping test and the macOS-only round trip through AppleScript's own parser.
4. **The error a failed ledger repeats on every tick.** It must not notify again. Task 2, test "a failed commit stops the queue…".

## Rulings

One line per decision, then its cost if wrong. The numbering continues the post-merge plan (last was R98).

- **R99.** The notification is `osascript -e 'display notification "BODY" with title "TITLE" subtitle "SUBTITLE" sound name "Basso"'`, run by the tick after the ledger and the comment, with a 10-second cap and `SIGKILL`, and it returns an error instead of throwing. `terminal-notifier` would add a dependency; `osascript` ships with macOS; cost if wrong: none found, the probe ran under launchd.
- **R100.** No configuration field. macOS already has the switch: System Settings > Notifications > Script Editor turns the notifications off, or sets the Alerts style that stays on screen; cost if wrong: turning it off also mutes any other script that notifies through `osascript`.
- **R101.** The sender is Script Editor, the owner of `osascript`. A sender named for pstack needs a signed app bundle or `terminal-notifier`; the title `Converge local` names the source instead; cost if wrong: the sender line does not say pstack.
- **R102.** One notification per recorded failure and one per hold. The hooks sit where the comment already goes out once: `attempt()` when it records `failed`, and `hold()`, whose label makes classify skip the PR. `next()`, which repeats a failed ledger's error on every tick, notifies nothing; cost if wrong: a notification dismissed unread shows again only in `status`, the log and the PR comment.
- **R103.** The errors a tick repeats without recording a failure notify nothing: a red push Tests run, a checkout that fails, more than 50 commits, a tip that does not descend, a file that does not parse. They have no ledger to record that they were shown, and a notification on every tick would ring every 10 minutes; cost if wrong: a stuck pass stays silent until someone reads `status` or the log. A follow-up can add a shown-marker if it bites.
- **R104.** A commit deferred with exit 75 notifies only when the deferral turns into a failure after 24 hours, as the post-merge design's window says; cost if wrong: a release that defers on a network outage stays silent for a day.
- **R105.** A notification that fails is a tick error (`SHA: notification failed: CAUSE` in the post-merge pass, `OWNER/REPO#N: notification failed: CAUSE` for a hold), like a comment that fails, so the tick exits 1; the failure or the hold stays recorded and the comment stays posted; cost if wrong: a Mac whose notifications fail shows exit 1 on those ticks, which already exit 1 for a post-merge failure.
- **R106.** The branch was built on the post-merge branch while it was in flight (0.4.8, then 0.4.10 after its rebase on 0.4.9), and it is certified only after that PR merges: the post-merge PR changes `.cursor/converge.json`, and the contract certifies a stack child whose parent changes a policy file only after the parent merges. So this PR targets trunk, not the parent branch, and takes trunk's version plus one; by R94, a PR that merges first moves it; cost if wrong: one more rebase and renumbering.

## Tasks

### Task 1: `local/notify.ts`

- [x] `Notice { title, subtitle, body }`, `NOTIFY_TIMEOUT_MS = 10_000`, `appleScriptString(text)` (escapes a backslash and a double quote), and `notify(notice, { env?, timeoutMs? }): string | null`. Results: `null` on exit 0; `osascript did not start: MESSAGE`, for a spawn error or an argument Node refuses to pass, such as one with a NUL byte; `osascript did not finish within N s`; `osascript ended by SIGNAL`; `osascript exited CODE[: STDERR]`.
- [x] `notify.test.ts`: the exact `-e` script for a text with quotes and backslashes, recorded by a fake; on macOS, the real `osascript` returns the escaped string unchanged; exit 2 with stderr, a 0.3-second cap on a fake that ignores `SIGTERM`, an empty `PATH` and a NUL byte each return their cause.

### Task 2: the hooks

- [x] `fixtures/setup.ts`: every fixture writes a fake `osascript` (shell builtins only) that appends its arguments to `osascript.calls` beside it and exits with the code in `osascript-exit` when that file exists; `f.notices()` reads the calls.
- [x] `attempt()` notifies after the failure comment: title `Converge local`, subtitle the repository, body `Post-merge stopped on commit SHA8: REASON (PR #N)`, without the PR part for a direct push. `hold()` notifies after the hold comment: `Held OWNER/REPO#N: REASON`.
- [x] Tests: one notice after the failing tick and none on the next; the body without a PR; one notice per hold across two ticks; a fake that exits 1 reports `notification failed` and leaves the failure, the comment and the hold standing; a hold with no `osascript` on `PATH` still stands.

### Task 3: docs and version

- [x] `converge-contract.md`, **Local daemon**: the notification after the failure comment and after the hold comment, and a closing paragraph on what notifies, what does not, the switch in System Settings and the `notification failed` error. `docs/reference.md`: the same in Portuguese.
- [x] Version 0.4.11 in the files the constraints list; `CHANGES.md` entry.
- [x] `npm test`, `npm run test:bun`, `npm run matrix:check`, `npm run agents:check`, `npm run collision:check`, `claude plugin validate .`, `git diff --check`; an ad hoc `--strict` typecheck of the changed files.

### Task 4 (controller): certification, PR, arm

- [ ] After the post-merge PR merges: rebase on trunk, renumber if R94 asks, then Pré-PR (full track: the changed code is outside `prePr.light.paths`), PR, publish, arm.
