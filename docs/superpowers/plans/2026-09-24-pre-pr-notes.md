# Pré-PR plan: implementation notes

These notes carry what the parts already built taught the parts still to build. Read them before you start a part of [the plan](2026-09-24-pre-pr.md). The plan's code blocks for Parts 1 to 3 are history now. The code and [`converge-contract.md`](../../../skills/poteto-mode/references/converge-contract.md) are the reference. Decisions that belong to Victor live as Linear sub-issues of CLI-192.

## Built

**Part 1, the Certificado.** PR byvict/pstack-vic#28, merged as 66b4d37. It departs from the plan in five ways:
- The published dossier embeds the certificate.
- `converge-certify assemble` requires `--adjust-rounds N`.
- `converge-certify run --cwd` records the head and whether the checkout is clean.
- `toolingRef` is `pstack-vic@<version>`.
- A `pre-pr` snapshot reads no CI state.

**Part 2, the reactive half.** PR byvict/pstack-vic#29, merged as 9094bf6. It departs from the plan in six ways:
- **One verdict gate.** `verdictGate()` in `gate.ts` decides for `converge-arm`, `converge-sweep` and `start.ts`. It refuses only at seven named conditions, and every other failure is an error each caller handles safely.
- **Re-derivation on every gate run.** The gate re-derives a `pre-pr` verdict at the trunk tip it reads and over the current PR text. It requires the same patch id and policy digest, and a VERIFIED decision from the retained coverage. This resolves N10.
- **Sweep disarms.** The sweep disarms an armed PR when the gate refuses it or fails on it, and every armed PR on the default branch when the trunk contract does not load.
- **Publication behind auto-merge.** Publication refuses while auto-merge is pending, unless the retry would write nothing.
- **`start.ts` result.** `start.ts` returns `kind: launched` or `kind: certified`.
- **Plan change.** The plan's Part 4 `sweep.md` prompt now reports its JSON in the Automation run output and never comments on a PR.

**Part 3, the roles.** PR byvict/pstack-vic#31. It departs from the plan in five ways:
- **One table of single-lane rows.** `singleLaneRows()` in `setup-pstack.ts` holds the two cloud rows and the three pre-pr rows. It derives their lanes from `roleProviders` in `converge/contract.ts`, the rule that admission applies. The pre-pr rows take no alias. `pre-pr fixer` takes the reviewer's lanes, because admission has no rule for the fixer.
- **Warnings in two places.** `plan` and `write` both print the cross-family warnings on stderr, and the plan JSON carries them in `warnings`.
- **Plan schema 4.** `plan.json` moves to `schemaVersion: 4`, so the script refuses a plan saved by 0.1.11.
- **CHANGES.** `CHANGES.md` had no `## Unreleased`. The Part 1 and Part 2 entries became 0.2.0 entries, and Part 3 has its own.
- **Plan change.** The plan's Part 4 step 1 now picks `RUN` under `${TMPDIR:-/tmp}`. See N6.

## Open, by part

Numbers follow the ledgers of Parts 1 to 3.

### Before Part 4

- **Stack children (N3, N14; CLI-195).** Today a stack child never gets a verdict. Publication refuses while its base is the parent branch, and the PR snapshot takes its patch id from `gh pr diff` against that base. After the retarget, publication refuses at the moved tip. The proposal is a small code PR: a `pre-pr` PR snapshot compares against trunk, and publication of a `pre-pr` verdict accepts a non-trunk base. The arm still requires trunk, and the sweep arms the child after the retarget.

### Part 4, playbooks and the pstack-vic contract

- **N1.** Publication runs while CI is pending, and it refuses a PR body with `check:`, `test:` or `artifact:` claims. The Pré-PR playbook must not write those claims into the PR body.
- **N4.** A lane receipt that starts before its manifest's `createdAt` is refused. In Task 4.1, playbook step 3 lists `manifest.json` after the launch. It must come before the launch.
- **N5.** Each run passes `--cwd <worktree at the pushed head>` and an argv that joins exactly to the contract command, on a clean checkout. In Task 4.1, playbook step 2 omits `--cwd`.
- **N7.** In Task 4.1, playbook step 6 calls `assemble` without `--adjust-rounds N`, which is required.
- **N11.** Evidence files are named after the lane and artifact id, with no round. A second certifier pass in the same run directory collides. Recover in a new run directory.
- **N12.** On the first real PR, confirm that the branch round's patch id equals the PR round's (`gh pr diff` against the compare diff).
- **N15.** No Automation and no sweeper may comment on a PR. A comment changes a `converge` verdict's PR text, and the next sweep disarms that PR. `pr-opened.md` still comments "certified head, no owner". That is harmless for a `pre-pr` verdict, which re-derives over changed text, but check it again when you write that prompt.
- **N16.** The "PR opened" Automation can run `start.ts` before the Raiz publishes. A full cloud owner then launches on a PR that is about to be certified, and its later publication refuses while auto-merge is pending. Either add a signal (a body marker plus a bounded poll) or accept the cost.
- **N17 (CLI-194).** After a pending arm, nothing supervises the PR until the next sweep, and a hold applied in between does not stop GitHub's auto-merge. The recommendation is a required `hold` check. It must land before the playbook relies on `--pending`.
- **N20.** The contract requires any writer to disarm before it pushes to an armed PR, because a force-push back to an earlier certified head keeps that head's VERIFIED status. The plan's `repair.md` prompt must say so.
- **N23.** The first sweep after trunk moves past an armed `converge` PR's contract commit disarms that PR. It stays refused until its owner republishes with `--retain` and arms again. The owner prompt in `start.ts` and the `converge.md` rewrite must say so.

### Part 5, Clinext

- **N13.** `clean` is read before each run, so a contract run that leaves non-ignored untracked files makes every later run in the same worktree record `clean: false`. pstack-vic's `npm test` and `npm run test:bun` leave none (measured 2026-09-25). Check each Clinext contract run the same way.
- **N24.** A certifier lane is Grok `read-only`, and it cannot write inside its checkout (N6). The verify-clinext `launch` always rewrites the generated contact helpers inside the checkout (`tools/generate-contact-helpers.js` through `writePreservingEol`, called from `helpers/run.mjs`). So `launch` fails in a certifier lane. Vite's dependency cache under `client/node_modules/.vite` is the next likely write, which is a guess, not a measurement. Make `launch` write nothing inside the checkout. Then prove it with one Grok `read-only` lane that runs launch, doctor and cleanup, with `VERIFY_RUN_DIR` and `VERIFY_EVIDENCE_DIR` under `$TMPDIR`.
- **N9.** The comment embeds the whole certificate, about 3 KB plus 250 B per artifact. 57 Clinext features with 3 artifacts each come to about 69.8 K characters, over GitHub's 65,536-character comment limit. Publication refuses such a body. Choose a smaller certificate form before Part 5.
- **N18, N19 (CLI-193).** Any change to a file in the policy digest invalidates every outstanding certificate. In Clinext, at least 12 of 91 merges in 14 days changed such a file (measured 2026-09-25). Separately, a merge can land at a later trunk tip than the gate checked. The recommendation is to narrow the policy comparison to what the certificate uses, and not to serialize merges.
- **N21.** `start.ts` now calls `principal()` and the gate under the "PR opened" Automation's credentials. Verify that its token can run the GraphQL viewer query and read statuses and comments. Also verify that it is the same account that publishes.

### Later

- **N25.** The matrix defaults keep the four volume authoring rows on Grok, and `pre-pr reviewer` is Grok. A first-run sheet therefore prints four warnings, and the Pré-PR playbook would refuse it. Victor's sheets are crossed: Opus authors in Claude Code, and Sol authors in Codex. Moving the matrix defaults is Victor's call in `/setup-pstack`.
- **N22.** `publish.ts` could mark the `verdict` statuses of superseded heads as `error`. That would close the reused-head case in structure instead of by rule.

### Rollout

- **N8.** When the new tooling republishes a `converge` round that older tooling already posted, it refuses the round as divergent. The body gains `"certificate": null`, so the bytes differ. Recovery is a new round.

## Resolved

- **N6.** A Grok 4.7 `read-only` lane wrote a file in `$TMPDIR`, and the same write failed in its checkout and under `$HOME/.codex` (Grok CLI 1.0.41, measured 2026-09-25). Grok's documentation also lists `~/.grok`, `/tmp` and `/var/tmp` as writable in `read-only`. The certifier stays `read-only`, with no new mode. `RUN` must live under a temp root, and `converge-contract.md` says so (Part 3).
- **N2.** A late publication with `test:` or `artifact:` claims no longer changes the policy digest. The `pre-pr` snapshot reads no CI, so the CI runner sources stay out of it (Part 1).
- **N3.** Superseded by N14 and CLI-195.
- **N10.** The arm bound the verdict's contract commit to the current trunk tip. Part 2's verdict gate re-derives instead.
