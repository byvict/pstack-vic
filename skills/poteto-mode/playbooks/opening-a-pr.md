### Opening a PR

Invoked at the end of every other playbook.

**Worktree.** Work from a git worktree off current trunk. Follow [Parallel PR delivery](../references/parallel-delivery.md): each independent writing task owns one branch and worktree; read-only helpers may share it, writing helpers use separate worktrees. Preserve unrelated work before starting a clean checkout. Never reset or clean another owner's checkout. Use the repository's local setup for isolated databases, ports and caches.

**Commits.** Commit liberally. Rebase into small, ordered commits before opening PRs. Each commit is a future PR: landable, ordered to tell the story. Every commit that carries code a lane or you wrote keeps its `Pstack-Author` trailers through the rebase (the [Authorship trailer](../references/provider-dispatch.md#authorship-trailer) of provider dispatch); a squash that merges commits gathers every `Pstack-Author` line of the commits it merges into the trailer block (the last paragraph) of the squashed message, because git leaves the earlier ones mid-message, where they are a gap, and a fixup discards its message with its trailers. Amend when the fix belongs in a just-made commit. New commit when separable.

**PRs.** Run `/deslop` over the diff before commit. Run `/no-comments` before review. Write every PR title, PR description, and commit body with `/technical-writing`, then apply `/unslop`. Apply every technical-writing layer except Diátaxis. Use one word for each action, keep articles, and avoid `-ing` when a plain verb works.

**Titles.** Use Conventional Commits in the form `type(scope): subject`. Use `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, or `perf` as the type. Use the changed area, such as `pstack` or `poteto-mode`, as the scope. Keep the subject short and imperative. Name a real symbol when one carries the change. For example, `fix(pstack): retarget opening-a-pr babysit trigger`. Do not add a trailing period.

**Descriptions.** The PR body is a briefing, not the lab notebook. A reviewer who has the diff should learn why the change exists, what is out of scope, and how you proved the change works. The squash commit body is the PR body. If the body would make the squash commit longer than about 40 lines, cut the body.

Use these sections in order. Drop a section when it has nothing to say.

- `## Why`. State the intent and approach in one or two short paragraphs. Do not list SHAs or rebase genealogy. Do not add a "based on main" preamble.
- `## Scope`. Use bullets to list real symbols and paths. Name both sides of a rename or retarget. State what is in and out only when the boundary matters. Do not write a file-by-file essay.
- `## Tradeoffs`. Name only rejected alternatives that a reviewer would otherwise ask about. Skip this section when there was no real choice.
- `## Blast Radius`. In one to three sentences, name who or what the change touches and why the change is safe or risky. State the continuing cost if main stays red without the fix.
- `## Verification`. Name each real run path and its outcome. For a performance change, report one primary number with its unit in `before → after` form. Link the arena or swarm directory for the remaining evidence. Do not include sample-size methodology, swarm recitals, or metric tables.

After these sections, attach videos or screenshots when they prove a claim. Do not paste full SHAs, swarm or arena lane recitals, lever-correction essays, file-by-file checklists, or "CLEAN" verdicts. Put these details in a linked artifact. Do not use `## Summary` or `## Test plan` boilerplate. A commit body does not restate its subject.

**Forge.** Resolve the forge before the first PR operation and keep that choice for create, edit, view, watch, and merge. GitHub CLI (`gh`) is the default. If `command -v origin` succeeds and Origin can resolve the repository, prefer `origin pr ...`. If Origin is absent or cannot resolve the repository, stay on `gh` and record the fallback. Do not require Graphite (`gt`).

**Size and stacks.** Prefer five narrow PRs to one large PR. A stack is a base-branch chain. The root PR targets trunk. Each child branch rebases onto its parent's exact tip and its PR targets the parent branch. Create a child with `origin pr create --status open --base <parent-branch>` or `gh pr create --base <parent-branch>` according to the resolved forge. Retarget an existing child with `origin pr edit <pr> --base <parent-branch>` or `gh pr edit <pr> --base <parent-branch>`. Branch from trunk only for independent work. Rebase on trunk before substantial stack work.

**Linear targets.** Before every PR creation, pin the pushed head as `FULL_HEAD` and save the description in `BODY_FILE`. Use the PR's intended base as `BASE_REF`, including a parent branch for a stack child. Prepare and validate that file:

    node <plugin>/skills/poteto-mode/scripts/converge/converge-pr-body --repo OWNER/REPO --base BASE_REF --head FULL_HEAD --body-file BODY_FILE
    node <plugin>/skills/poteto-mode/scripts/converge/converge-pr-body --repo OWNER/REPO --base BASE_REF --head FULL_HEAD --body-file BODY_FILE --check

The helper reads the complete pushed commit comparison and preserves the immutable `Pstack-Linear` URL trailers. It adds one plain `Ignore KEY` line for each issue target; project targets need no override. Apply this step even when `postMerge.linear` is disabled or the repository has no `prePr` contract. Malformed trailers, a truncated comparison, or a missing override must be resolved before creation. Use the checked file as the PR body and require `git rev-parse HEAD` to equal `FULL_HEAD` immediately before creation. After any body edit, rerun `--check` before creation or publication.

[Linear's GitHub integration](https://linear.app/docs/github#faq) can link from the branch name and update status on merge without a closing keyword. A plain `Ignore KEY` or `skip KEY` in the description prevents that issue's automatic linking and status updates. The guard accepts complete standalone directives outside quotes, code, and HTML comments. Keep reciprocal PR and issue URLs in the author handoff so the post-merge owner can find both artifacts. Keep team automation settings as configured.

**Readiness.** Open every PR ready, never as a draft. With Origin, pass `--status open`. With `gh`, omit `--draft`. Cloud-agent PR tools default to draft, so set `draft: false` on every PR creation call. If a PR still opens as a draft, run `origin pr ready <number>` or `gh pr ready <number>` according to the resolved forge. Run `origin pr view <number>` or `gh pr view <number>` before you refer to PR status.

**Pré-PR and arm.** In a repository whose `.cursor/converge.json` has a `prePr` block, run [Pré-PR](pre-pr.md) before `gh pr create`; its **Deliver** half creates the PR, publishes the Certificado and arms auto-merge with `--pending`. Arriving from Pré-PR step 7, create the PR and return to its step 8; Pré-PR is not run again. Never launch a cloud owner. A repository without `prePr` opens the PR and ends; nothing certifies it locally. In a `prePr` repository, the local converge daemon certifies a PR that arrives without a Certificado (Dependabot, a manual PR) on its next tick once the PR's tests check has completed on the head, or 30 minutes after the PR opened, whichever comes first; after a manual `gh pr create`, `node <plugin>/skills/poteto-mode/scripts/converge/converge-local nudge` wakes the daemon instead of waiting for its interval.

**Babysit.** Opening a PR does not start a babysit. Post the URL and keep building. Finish the phase or stack first. Run a separate babysit pass only when the user asks for one after the whole stack exists. A babysit for each new PR stalls the build and spends checks on commits that later waves restart. Push back when feedback drifts from intent.

A subagent that opens a PR runs `interrogate`, `/deslop`, and `/no-comments`. It returns the URL and does not babysit. Return to the parent.
