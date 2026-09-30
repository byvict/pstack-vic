# Stalled auto-merge 0.4.15 Implementation Plan

**Goal:** Merge an armed, certified PR that GitHub's auto-merge left open after every required check passed. On 2026-09-30, pstack-vic#59 stayed open for 18 minutes and 35 seconds in that state and merged only when a session read it.

**Architecture:** In the sweep's armed branch, after the verdict gate certifies, `stalledSince` decides whether the auto-merge stalled: GitHub's own `mergeable_state` says the PR merges now, and every required check run passed at least 5 minutes ago. `unstick` then runs the arm's command again. On such a PR `gh pr merge --auto` merges at once. The sweep reads the PR back and reports `merged`, `skipped` or `refused`. `Pull` gains `mergeState` and `merged`; `timedChecks` reads each check's completion time beside `checks`.

**Tech Stack:** Node 24 with type stripping, `node --test`, the fake GitHub of `skills/poteto-mode/scripts/converge/fixtures/gh.mjs`.

**Spec:** the investigation `~/Dev/Skills/pstack-vic-runs/2026-09-30-auto-merge-parado/evidencias.md`, which Victor approved on 2026-09-30 ("sim", the simple version, after 0.4.14). The **Merge and progress** section of [`converge-contract.md`](../../../skills/poteto-mode/references/converge-contract.md) must stay true to the code.

## Evidence

| Fact | Value |
|---|---|
| #59, last required check passed | 14:21:48 UTC (`test`); `hold` 14:13:46, `verdict` 14:14:25, armed 14:14:55 |
| #59, merged | 14:40:23 UTC, 44 seconds after the first GraphQL read of the PR in 18 minutes |
| What touched #59 in between | The daemon only: watch GETs, four raiz classifications, two sweeps (14:26:26, 14:36:26), each with a REST `GET pulls/59`. No disarm, no label, one `hold` run |
| GitHub's own state at 14:39:53 | `OPEN`, `MERGEABLE`, `CLEAN`, auto-merge set |
| Other armed PRs | 20 (15 pstack-vic, 5 Clinext) merged 5 to 90 seconds after the last required check |
| `gh` 2.101.0, `pkg/cmd/pr/merge/merge.go:593` | `autoMerge: opts.AutoMergeEnable && !isImmediatelyMergeable(pr.MergeStateStatus)`; immediately mergeable is `CLEAN`, `HAS_HOOKS` or `UNSTABLE` |
| Public reports | None found for this symptom. GitHub's page on auto-merge gives no time for the merge |

## Global Constraints

- Node 24, no runtime dependencies, erasable TypeScript only, explicit `.ts` import specifiers.
- Red first: each behavior gets a test that fails for the behavior before the code exists.
- Version 0.4.15 in `package.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json` (`version` and `ref`), and the `--ref` lines of `README.md` and `docs/reference.md`.

## Review Focus

1. **A loop.** The sweep must never run the command where gh would only enable auto-merge again: that mutation moves the PR list, and the watch job would wake the sweep every minute. R127, the "leaves to GitHub" tests.
2. **A merge the gate did not judge.** The command runs only after the gate certified the live head in the same pass, on a PR without a hold label, pinned to that head. `sweep.ts`, `decideOne`.
3. **A disarm for a failed command.** A command that fails must leave the PR armed. R129, test "did not merge as refused and leaves it armed".
4. **The snapshot hash.** `checks()` must return exactly what it returned before. R131, the `timedChecks` test.

## Rulings

One line per decision, then its cost if wrong. The numbering continues the post-arm plan (last was R124).

- **R125.** Version 0.4.15, built on the 0.4.14 branch, which had not merged when this one started. By R94, a PR that merges first moves the number; cost if wrong: one rebase and renumbering.
- **R126.** The action is the arm's own command, not a read. The sweep's REST reads of the PR did not end the stall, and the GraphQL read that preceded the merge is one sample. On a PR GitHub reports as mergeable, gh merges instead of enabling auto-merge, so the outcome does not depend on what wakes GitHub. This is the first merge the daemon makes itself, which Victor approved for this case; cost if wrong: a gh release that changes `isImmediatelyMergeable` makes the command enable auto-merge again, the PR stays open, the sweep reports it `refused` on every tick, and the raiz job holds it after 2 hours.
- **R127.** The command runs only when GitHub's `mergeable_state` is `clean`, `unstable` or `has_hooks`, the three states in which gh merges. In any other state gh would enable auto-merge again, a mutation on every sweep; cost if wrong: a PR whose state GitHub reports as `unknown` or `blocked` while it could merge is left to GitHub, as before this change.
- **R128.** The stall counts 5 minutes from the latest completion time of the required check runs, read from GitHub, so the sweep keeps no state. Five minutes is over three times the slowest merge measured (90 seconds). The `verdict` status is left out: the gate certified it, and it precedes every arm, and an arm on a green PR merges at once; cost if wrong: the sweep and GitHub's auto-merge act on the same PR in the same seconds, which ends in the same squash merge, and the read after the command reports it.
- **R129.** The sweep calls the command, not `arm()`. It reads no trunk health, as GitHub's auto-merge reads none, and `arm()`'s catch disarms, which would turn a failed command into a disarmed PR; cost if wrong: the sweep merges onto a red trunk a PR that GitHub would have merged onto it anyway.
- **R130.** A merged PR is the new outcome `merged` and exits 0. A PR still open is `refused`, so every sweep tick shows it as an error until it moves. A PR closed without a merge is `skipped` (`PR is no longer open`). `Pull` gains `merged` so that the report never calls a closed PR merged; cost if wrong: none found.
- **R131.** `timedChecks` returns each check with its completion time, and `checks` returns the same runs without it, because a snapshot hashes its checks and a report stores them. A required check without a completion time is not stalled; cost if wrong: a run GitHub gives no time for is left to GitHub.
- **R132.** `unstable` counts. It means a check outside the required set is failing or pending, which GitHub's auto-merge ignores too; cost if wrong: the sweep merges a PR with a failing optional check, as GitHub would.
- **R133.** The watch job does not change. The command runs between 5 minutes and 5 minutes plus `intervalMinutes` after the last required check, and sooner when something else wakes the sweep. Victor chose this over a wake from the watch job; cost if wrong: up to 10 minutes more than the faster design.

## Tasks

- [x] **Task 1: reads (`github.ts`, fixture).** `Pull.mergeState` from `mergeable_state` (`unknown` when absent, refused when not a string), `Pull.merged`, `timedChecks`. The fake gh answers `mergeable_state` and `merged`, merges on `pr merge --auto` in the three states, and fails the command before or after it takes effect (`failMerge`).
- [x] **Task 2: the sweep (`sweep.ts`, `arm.ts`).** `MERGES_AT_ONCE` and `armCommand` in `arm.ts`, used by `arm()` and the sweep. `STALL_MINUTES`, `stalledSince`, `unstick` and the outcome `merged` in `sweep.ts`.
- [x] **Task 3: docs and version.** `converge-contract.md` (sweep decision 3, **A stalled auto-merge**, outcomes and exit code, the armed stall of the raiz job), `converge.md`, `CONTEXT.md`, `docs/reference.md`, `docs/pre-pr.md`, `CHANGES.md`, version 0.4.15.
