# Pré-PR plan: implementation notes

These notes carry what the parts already built taught the parts still to build. Read them before you start a part of [the plan](2026-09-24-pre-pr.md). The plan's code blocks for Parts 1 to 3 are history now. The code and [`converge-contract.md`](../../../skills/poteto-mode/references/converge-contract.md) are the reference. Decisions that belong to Victor live as Linear sub-issues of CLI-192. Since 2026-09-28 the notes also serve [`2026-09-28-converge-local.md`](2026-09-28-converge-local.md); new notes start at N28.

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

**Stack children, before Part 4 (N14; CLI-195).** PR byvict/pstack-vic#33. Outside the plan:
- **One compare for both `pre-pr` rounds.** The PR snapshot under `pre-pr` reads its files and diff through the function the branch snapshot uses, GitHub's compare of the trunk contract commit and the head. It no longer calls `gh pr diff` or the PR's file list, which start at the PR base. The 300-file limit of the compare now applies to the PR round too.
- **Base admission by execution.** `admitPull` takes the execution. Only `pre-pr` admits a base other than trunk, in the reconcile snapshot and at publication. The arm, `converge` and `verdict-only` still refuse it, and the sweep still skips it.
- **`start.ts` runs the gate first.** A certified child returns `kind: certified` with no Cursor call. An uncertified child refuses (`PR base differs from trunk`) and writes no intent. A `converge` verdict on a PR whose base left trunk refuses too.
- **Measured before the code.** In a lab repository (trunk T0, parent P1 and P2, child C1 on P2), the child's merge base with trunk stayed at T0 after a squash merge of the parent, a rebase of the parent, a new parent commit and an unrelated trunk commit. `git diff main...child | git patch-id --stable` stayed the same in every case. Only a rebase of the child changed its head and patch id.

**Part 4a, the unsandboxed certifier (CLI-198).** PR byvict/pstack-vic#38, released as 0.2.4. It departs from the plan in five ways:
- **A fourth refusal.** Admission also refuses a certifier whose `checkout.headBefore` differs from the round head (`Certifier lane ran on another head`). A lane launched on the wrong head is a different fault from a lane that moved HEAD.
- **Refusals before any receipt.** `validateOptions` calls the same `requireSupportedMode` as `invocationCommand`, so a `cursor` lane and a parent with `CODEX_SANDBOX` are refused before the runner reserves paths. A `--cwd` outside a git worktree is refused the same way.
- **`GROK_CONFIG` removed.** The child loses `GROK_CONFIG`, because Grok lets an inline overlay win over `GROK_CONFIG_PATH`.
- **When git fails after the lane.** The child's exit is recorded first. The lane then ends `child-failed` with `checkout: null`, and its exit code is kept.
- **After review (Codex gpt-6-sol).** The git reads during the lane are asynchronous and share the lane's deadline and cancellation latch, so a stalled `git status` ends `timed-out` instead of blocking. They read the worktree root resolved before the child, so a lane that repoints a `--cwd` symlink cannot send the after-read to a clean copy. A lane that hides a change from git (`assume-unchanged`, `skip-worktree`, `.git/info/exclude`) still passes the record; that belongs to the accepted risk of an unsandboxed lane.

## Open, by part

Numbers follow the ledgers of Parts 1 to 3.

### Part 2 and Part 3 of the 2026-09-28 plan

- **Stacks (CLI-195).** The Pré-PR playbook must say how to open a stack. The child targets its parent branch and is certified on its own head against trunk, so its certificate covers the parent's patch too. Publish the child while its base is the parent, and do not arm it. The sweep arms it after GitHub retargets it to trunk. GitHub retargets only when the parent's branch is deleted after the merge. Both Clinext and pstack-vic delete head branches on merge; pstack-vic turned it on on 2026-09-25. A child whose parent changes the feature map, a Recipe the child reaches, `converge.json`, the verify skill or the Tests workflow certifies only after the parent merges, because the policy is read on trunk. Only a rebase of the child calls for a new certificate.
- **N1.** Publication runs while CI is pending, and it refuses a PR body with `check:`, `test:` or `artifact:` claims. The Pré-PR playbook must not write those claims into the PR body.
- **N4.** A lane receipt that starts before its manifest's `createdAt` is refused. In Part 2, playbook step 3 writes `manifest.json` before the launch.
- **N5.** Each run passes `--cwd <worktree at the pushed head>` and an argv that joins exactly to the contract command, on a clean checkout. In Part 2, playbook step 2 passes that `--cwd`.
- **N7.** `assemble` requires `--adjust-rounds N`. In Part 2, playbook step 6 passes it.
- **N11.** Evidence files are named after the lane and artifact id, with no round. A second certifier pass in the same run directory collides. Recover in a new run directory.
- **Steps 4 and 5 of the 2026-09-24 plan's Task 4.2 (CLI-194).** `.cursor/converge.json` exists, with `hold` in `requiredChecks`. Victor runs the label and ruleset commands from CLI-194's PR body. Until he does, every arm on pstack-vic refuses (`Branch protection missing required context: verdict`).
- **N20.** The contract requires any writer to disarm before it pushes to an armed PR, because a force-push back to an earlier certified head keeps that head's VERIFIED status. The plan's `repair.md` prompt must say so.
- **N23.** The first sweep after trunk moves past an armed `converge` PR's contract commit disarms that PR. It stays refused until its owner republishes with `--retain` and arms again. The owner prompt in `start.ts` and the `converge.md` rewrite must say so.
- **N29.** The playbook has no place for a retried lane's first attempt. `assemble` admits every `lanes/*/manifest.json`, the runner refuses to overwrite an output or a receipt, and the artifact prefix fixes the lane id, so a relaunch in the same `RUN` needs the old lane directory moved out of `lanes/`. The PR 1 delivery (2026-09-28) moved it to `RUN/attempts/pre-pr-reviewer-1/`. `pre-pr.md` should name that place, or require a new `RUN` for a relaunch.
- **N30.** PR 1's certificate (byvict/pstack-vic#41) is schema 1. The installed 0.2.5 `assemble` writes `schemaVersion: 1` and `authorProvider`, and the 0.3.0 `parseCertificate` that PR 1 ships refuses it (`Unknown certificate schema`). So PR 1 is published and armed with the installed 0.2.5 tooling, and nothing on 0.3.0 may judge it before it merges: no plugin update and no sweep from the tip of `main` before the merge.
- **N31.** macOS `TMPDIR` ends with a slash (`/var/folders/…/T/`), so `${TMPDIR:-/tmp}/pre-pr/…` gives `T//pre-pr`. Admission compares resolved paths, so this is harmless. The PR 1 delivery normalized it to one slash, so that the manifest, the receipt and `assemble` spell the paths the same way.
- **N32.** `{{artifactPrefix}}` in `pre-pr-prompts.md` can mean the relative prefix that admission checks or the absolute directory where the lane writes. The prompt text should name both: write under `{{laneDirectory}}/artifacts/converge/<round>/<lane>/`, and list paths relative to `{{laneDirectory}}`.
- **N35.** Only a Grok reviewer can write risk-proof artifacts from a `read-only` lane in this version. Claude's plan mode and Codex's read-only sandbox write no file, and the runner writes `output.json` from the lane's final response. So a round whose `hardList` has a `requires-proof` entry needs a Grok `pre-pr reviewer`; with any other family, assembly refuses as `INCONCLUSIVE` (`Reviewer risk proof unavailable` or `Verifier did not prove required risk safe`). `pre-pr.md` step 3 and `converge-contract.md` say so. Open for a later runner change.
- **N36.** The certificate lists its runs in the byte order of their record files, not in contract order. PR 1's certificate lists `matrix`, `test-bun`, `test`, because `test-bun.json` sorts before `test.json`. Admission and publication accept it, so it is cosmetic. But the contract lists the skipped runs of a `ci-only` round in contract order, and a reader comparing certificates could expect the same order for recorded runs.
- **N37.** The runner reserves `output.json` and `receipt.json` as empty `0600` files when it launches a lane. A watcher that takes "the file exists" as done reads an empty output; completion comes from the runner's exit or from a non-empty receipt. A runner that dies before it writes also leaves the empty reservations, and then moving the lane directory out of `lanes/` (N29) is the only way to relaunch in the same `RUN`.
- **N38.** Not a defect. The verdict comment and the dossier carry the PR round, and the certificate's branch round appears only under `certificate.round`. On PR 1 the comment marker names round `6e1ad622-5760-459e-901a-81cf5df44f7d` and the certificate names `8cea248e-963e-4a88-b08c-53e7aaf4ca25`. The contract says so, but a reader who looks for the certificate's round in the marker finds the other id.

### Part 4 of the 2026-09-28 plan

- **N13.** `clean` is read before each run, so a contract run that leaves non-ignored untracked files makes every later run in the same worktree record `clean: false`. pstack-vic's `npm test` and `npm run test:bun` leave none (measured 2026-09-25). Check each Clinext contract run the same way.
- **N26 (CLI-194).** Clinext needs the same `hold` check before its sweep arms with `--pending`, because `--pending` refuses a contract without `hold` in `requiredChecks`. Copy `.github/workflows/hold.yml`, add `hold` to `requiredChecks` in `.cursor/converge.json`, and add `hold` with `app_id` 15368 to the classic protection's `required_status_checks`. Keep the "Workflow Run Failed" Automation filtered on `Tests` and `Secrets scan`, so a failed `hold` run never launches a repair owner.

### Later

- **N22.** `publish.ts` could mark the `verdict` statuses of superseded heads as `error`. That would close the reused-head case in structure instead of by rule.

### Rollout

- **N8.** When the new tooling republishes a `converge` round that older tooling already posted, it refuses the round as divergent. The body gains `"certificate": null`, so the bytes differ. Recovery is a new round.

## Resolved

- **N16.** Resolved by the 2026-09-28 spec: no Automation races the Raiz; the daemon waits 30 minutes before certifying a new PR.
- **N9.** Resolved by 0.3.0: the certificate binds one PNG and one text per feature plus risk-proof artifacts.
- **N18, N19.** Absorbed: a certificate the policy invalidates becomes `recertify` work for the daemon; narrowing the policy digest stays a later optimization (CLI-193).
- **N21.** No object: the daemon runs under the Mac's `gh` login, the account that publishes.
- **N15.** No object after 0.5.0; until then the daemon skips a PR whose verdict execution is `converge`.
- **N28.** Resolved in Part 2: the runner writes a lane's final response to `--output` over anything the lane wrote there, so both blocks of `pre-pr-prompts.md` now end with the JSON as the final response instead of telling the lane to write the file (found in the PR 1 delivery, 2026-09-28, where the reviewer's first attempt left 721 bytes of prose in `output.json`).
- **N33.** Resolved for PR 1 by its first Ajuste round (27a4d0f): a documentary dead link is blocking under 0.2.5 `decide`, so the 0.3.0 changelog entry names the plan and the design that arrive with PR 2 without linking them; a plan that splits its docs across PRs needs every link to resolve at each head.
- **N34.** Resolved by Part 2 (Task 2.4): the 0.2.5 `opening-a-pr.md` launched the Cloud owner for every ready PR in a repository with `.cursor/converge.json`; its **Pré-PR and arm** paragraph now runs Pré-PR, whose **Deliver** half publishes and arms with `--pending`, and never launches a cloud owner.
- **N27 (CLI-198).** In the Part 4a proof, an `unsandboxed` lane's shell still listed `CLAUDE_CODE_OAUTH_TOKEN`, `CURSOR_API_KEY` and `CLINEXT_TOKEN_COUNT_KEY` under the `core` policy, because zsh reads `~/.zshenv` again for every command, after Grok builds the environment. The overlay variants `ignore_default_excludes = false` and `[toolset.bash] login_shell_capture = false` did not help. A `read-only` control lane saw the same three by inheritance from the parent, because the overlay applied only to `unsandboxed`. Resolved on 2026-09-25 in two parts. On Victor's machine, `~/.zshenv` skips its credential exports when `GROK_AGENT` is set, which Grok sets in the lane's shell (backup `~/.zshenv.pre-n27`). In 0.2.5, every Grok lane runs under the `core` overlay. Afterwards a control lane in each mode saw 37 variable names, none with `TOKEN`, `KEY` or `SECRET`, and `node`, `npm` and `git` still ran (sessions `01a0d99a-ca30-71e1-8fc8-abe6ccdaabbc`, `01a0d99a-f98a-7a83-bcb3-62abe0b35b31`, `01a0d99b-26f7-7d21-bd72-848324c43cd4`). The guard depends on `GROK_AGENT`, which the `grok.env-policy` touchpoint of `update-clis` watches. Raw trail: `~/Dev/Skills/pstack-vic-runs/2026-09-25-parte-4a/env-probe/`.
- **N24 (CLI-197, CLI-198).** No sandboxed Grok lane on macOS drives the app: Grok's Seatbelt profile grants no `file-write*` on `/dev`, so `openpty` fails, and Chromium dies in IOKit and on `bootstrap_check_in`, which custom profiles cannot allow (measured 2026-09-25, Grok CLI 1.0.41). Victor chose a runner mode, and Part 4a shipped it in 0.2.4: `unsandboxed`, Grok only, `--cwd` a git worktree, HEAD and `git status` in the receipt's `checkout`, admission of a certifier only from a clean `unsandboxed` receipt, and the environment policy through a `GROK_CONFIG_PATH` overlay. The proof ran through the runner on 2026-09-25 in a disposable Clinext worktree at `11b09bbae`: `LAUNCH=0 DOCTOR=0 DRIVE=0 CLEANUP=0`, receipt `complete` with `grok-4.7-build`, `checkout.headBefore` and `checkout.headAfter` both `11b09bbae`, `statusAfter` empty, Grok session `01a0d938-689a-70d1-b84c-a9128a533ec2`, on the PR's final runner code. The receipt is at `~/Dev/Skills/pstack-vic-runs/2026-09-25-parte-4a/lane2/receipt.json`. A first run on an earlier commit of the same PR (session `01a0d925-f116-7f63-8b1b-522736525367`, `lane/`) gave the same result. N27 records what the environment policy did not cover at first.
- **N25 (CLI-196).** The four authoring volume rows now default to the parent's native code family: Opus in Claude Code and Sol in Codex, both at xhigh. `pre-pr reviewer` stays Grok, so a first-run plan has no warning on either parent (measured with `setup-pstack.ts plan` on an empty home, 2026-09-25). `swarm workers` and `how explorer` stay Grok (0.2.1).
- **N6.** A Grok 4.7 `read-only` lane wrote a file in `$TMPDIR`, and the same write failed in its checkout and under `$HOME/.codex` (Grok CLI 1.0.41, measured 2026-09-25). Grok's documentation also lists `~/.grok`, `/tmp` and `/var/tmp` as writable in `read-only`. The certifier was to stay `read-only`, with no new mode; N24 and CLI-197 superseded that part on 2026-09-25, because no sandboxed Grok lane drives the app on macOS. `RUN` must live under a temp root, and `converge-contract.md` says so (Part 3).
- **N2.** A late publication with `test:` or `artifact:` claims no longer changes the policy digest. The `pre-pr` snapshot reads no CI, so the CI runner sources stay out of it (Part 1).
- **N3.** Superseded by N14 and CLI-195.
- **N12, N14.** Resolved by CLI-195 (PR byvict/pstack-vic#33). The branch round and the PR round of `pre-pr` read their files and diff through one function, the compare of the contract commit and the head. Their patch ids therefore come from the same source by structure, and the first real PR has nothing to confirm. A stack child now publishes with its base on the parent.
- **N10.** The arm bound the verdict's contract commit to the current trunk tip. Part 2's verdict gate re-derives instead.
- **N17 (CLI-194).** A required `hold` check now stops GitHub's auto-merge after a pending arm. The `hold` workflow fails while `needs-victor` is on the PR, and `converge-arm --pending` refuses a contract without `hold` in `requiredChecks`. `converge-contract.md`, under Merge and progress, lists the check's limits. The same PR fixed the arm on a trunk that only rulesets protect. GitHub answers its classic protection read with 404 `Branch not protected`, and the arm used to fail there before any gate.
