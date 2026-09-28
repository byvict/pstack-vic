### Pré-PR

**You own the head you certify. Nothing merges that a different family did not review, and nothing ships that the runs and the app did not prove.** Runs between the last commit and the PR, from the Raiz, on the branch's worktree. Vocabulary: `CONTEXT.md` at the plugin root; contract: `../references/converge-contract.md`. Tooling: `skills/poteto-mode/scripts/converge/` under the installed plugin (`<plugin>` below). A repository takes part when its `.cursor/converge.json` on trunk has a `prePr` block; otherwise say `pre-pr skipped: no prePr contract` and go straight to **Opening a PR**.

Two halves. **Certify a pushed head** produces `certificate.json` for one exact head. **Deliver** turns it into a certified PR. The interactive flow runs both; the [Catch-up](catch-up.md) playbook runs both on a PR that already exists.

#### Certify a pushed head

**0. Cross-family gate.** Read the parent's model sheet (`~/.claude/pstack-models.md` or `~/.codex/pstack-models.md`). Collect the author families: the provider of every authoring row that wrote this branch (`feature, refactoring`, and `bug-fix`, `perf-issue`, `hillclimb`, `hardest tasks` when one of them did), plus, in a catch-up, the provider of `converge raiz`. When the provider of `pre-pr reviewer` is in that set, stop, name the row, launch nothing. Keep the set as `AUTHORS` (comma-separated) for step 6.

**1. Lease, push, report.** When `<plugin>/skills/poteto-mode/scripts/converge/converge-local` exists (0.4.0 and later), take the branch lease before the push and renew it before every lane launch and every push: `node <plugin>/skills/poteto-mode/scripts/converge/converge-local lease --repo OWNER/REPO --branch <branch> --by interactive --ttl 3`. A refusal names the other holder; do not touch the branch. Then `git push -u origin <branch>`. Choose `RUN=${TMPDIR:-/tmp}/pre-pr/<repo>-<branch>-<head8>` (must not exist yet; a new head is a new directory, note N11). It lives under the temp root, outside every checkout, so the reviewer's `read-only` lane can write there and the certifier's worktree stays clean. Run:

    node <plugin>/skills/poteto-mode/scripts/converge/converge-certify report --repo OWNER/REPO --head $(git rev-parse HEAD) --directory $RUN

Read `report.json`. `unmappedSurfaces` non-empty: write the missing Receita (feature recipe) on this branch, commit, push, choose a new `RUN`, and start step 1 again. `mode: ci-only` (docs-only) skips steps 2 and 5.

**2. Corridas.** For each `prePr.runs` entry of the trunk contract, in the background so the Raiz keeps its turn, with `--cwd` at a clean checkout of the pushed head (the branch's worktree with no local change; note N5):

    node <plugin>/skills/poteto-mode/scripts/converge/converge-certify run --directory $RUN --name <name> --cwd <worktree> -- <command words...>

The argv is the contract command split on single spaces, nothing added. Wait for every run. A non-zero exit is a defect: fix, commit, push, new `RUN`, back to step 1.

**3. Revisor pré-PR.** Create `$RUN/lanes/pre-pr-reviewer/`, write `prompt.txt` from the **Reviewer** block of `../references/pre-pr-prompts.md` with its placeholders filled, write `manifest.json` (`round` copied from `report.json`, `laneId: "pre-pr-reviewer"`, `role: "pre-pr reviewer"`, `descriptor` = the `pre-pr reviewer` row of the sheet, `prompt: "prompt.txt"`, `promptDigest` = SHA256 of `prompt.txt`, `output: "output.json"`, `receipt: "receipt.json"`, `createdAt` = now in epoch milliseconds), and only then launch (note N4) through provider dispatch with that descriptor, `--mode read-only`, `--cwd <worktree>`, `--prompt $RUN/lanes/pre-pr-reviewer/prompt.txt`, `--output $RUN/lanes/pre-pr-reviewer/output.json`, `--receipt $RUN/lanes/pre-pr-reviewer/receipt.json`. The lane reads the report, the run logs and the diff as data. Read `output.json`: `findings` empty means the review passed. Only Grok's `read-only` sandbox can write the risk-proof artifacts; Claude's and Codex's read-only lanes write no file. So when `report.json`'s `hardList` has a `requires-proof` entry and the `pre-pr reviewer` row is not Grok, assembly will be INCONCLUSIVE (`Reviewer risk proof unavailable`). In this version such a round needs a Grok reviewer: change the sheet row for that round, or accept the refusal.

**4. Ajuste.** With findings: `git worktree add $RUN/fix-<n> <branch>`, then launch the `pre-pr fixer` row, `isolated-write`, `--cwd $RUN/fix-<n>`, with the findings JSON as its input (an alias row runs a native subagent in that worktree instead). Review its diff yourself. Accept: `git merge --ff-only` its commits into the branch. Reject: fix through the author lane. Push, delete `$RUN/lanes`, `$RUN/runs` and `$RUN/report.json`, choose a new `RUN`, back to step 1. Count the rounds. Stop after six, or earlier when two consecutive reviews return the same findings: report the open findings and open no PR.

**5. Certificador.** Only when `report.json` lists `pre-pr certifier` in `lanes`. `git worktree add --detach $RUN/certify $(git rev-parse HEAD)`, give it the repository's dependencies as the repository documents (`npm ci`, or an APFS clone of the primary checkout's `node_modules` when the lockfiles are equal; Clinext needs the root and `client/` trees). Prepare `$RUN/lanes/pre-pr-certifier/` like step 3 with the **Certifier** block of `pre-pr-prompts.md`, then launch the `pre-pr certifier` row with `--mode unsandboxed`, `--cwd $RUN/certify`. Its prompt names the `touchedFeatures` of the report, the verify skill path and the artifact prefix `artifacts/converge/<round id>/pre-pr-certifier/` under its lane directory; every helper call stays under 300 s. After the lane, read `checkout` in its receipt: `headBefore`, `headAfter` and the pushed head must be equal and `statusAfter` empty; otherwise keep the worktree for inspection and treat the lane as refused (step 6 refuses it too). Then `git worktree remove --force $RUN/certify`.

**6. Certificado.**

    node <plugin>/skills/poteto-mode/scripts/converge/converge-certify assemble --directory $RUN --author-provider AUTHORS --output $RUN/certificate.json --adjust-rounds <rounds of step 4>

Refused: read the reason. A finding goes to step 4, a run failure to step 2, an unmapped surface to step 1, a certifier refusal to step 5 with a new `RUN`.

#### Deliver

**7. PR.** When the PR does not exist, run **Opening a PR** on the same head: no commit after step 6, and a new commit restarts at step 1. Never write `check:`, `test:` or `artifact:` claims in the body; publication refuses them while CI is pending (note N1). A stack child targets its parent branch. When the PR exists (catch-up), skip to 8.

**8. Publish and arm.** With the PR number:

    node <plugin>/skills/poteto-mode/scripts/converge/converge-reconcile --repo OWNER/REPO --pr N --output $RUN/pr-report.json --execution pre-pr
    node <plugin>/skills/poteto-mode/scripts/converge/publish.ts --report $RUN/pr-report.json --certificate $RUN/certificate.json --evidence $RUN/evidence
    node <plugin>/skills/poteto-mode/scripts/converge/converge-arm --repo OWNER/REPO --pr N --head <sha> --verdict VERIFIED --pending

Publication refuses while auto-merge is pending on the PR: disarm first (`gh pr merge N --repo OWNER/REPO --disable-auto`), which a catch-up already did before pushing. A refused arm on a red trunk is not a failure: the sweep arms it after the next green trunk. A stack child publishes with its base on the parent and is not armed; the sweep arms it after the parent merges. Release the lease. Report the PR URL, the verdict URL, the arm result, the fixer rounds and any open finding. The Raiz ends here; the local converge daemon owns the PR from here.
