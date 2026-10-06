### Opening a PR

Before the first PR operation, read the Guarded operations section of `playbooks/shipping.md` under the installed plugin. Capture its operation record and follow its identity, withdrawal, publication, and evidence rules. The invoking playbook retains its topology authority and every operator merge hold.

Invoked at the end of every other playbook.

**Worktree.** Work from a git worktree off main. Subagents inherit it. Multiple `Agent` calls on the same branch each get their own worktree; never recycle a different owner's branch through fetch/reset. Dirty branch with unrelated work: patch out, fresh worktree, apply. Snarled worktree: reset from main, redo minimally.

**Commits.** Commit liberally. Rebase into small, ordered commits before opening PRs. Each commit is a future PR: landable, ordered to tell the story. Amend when the fix belongs in a just-made commit. New commit when separable.

**PRs.** Run `/deslop` over the diff before commit. Run `/no-comments` before review. Write every PR title, PR description, and commit body with `/technical-writing`, then apply `/unslop`. Apply every technical-writing layer except Diátaxis. Use one word for each action, keep articles, and avoid `-ing` when a plain verb works.

**Titles.** Use Conventional Commits in the form `type(scope): subject`. Use `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, or `perf` as the type. Use the changed area, such as `pstack` or `poteto-mode`, as the scope. Keep the subject short and imperative. Name a real symbol when one carries the change. For example, `fix(pstack): retarget opening-a-pr babysit trigger`. Do not add a trailing period.

**Descriptions.** The PR body is a briefing, not the lab notebook. A reviewer who has the diff should learn why the change exists, what it leaves out, what it could break, and how you proved it works, in under a minute. Write short, simple sentences with few identifiers. Do not write walls of text. For a direct agent-assisted squash merge, read the selected PR body into a file and pass it through Guarded operations. Native queues use GitHub repository policy for commit metadata; inspect the actual merge commit and report differences. If the body would make the squash commit longer than about 40 lines, cut the body.

Put each section under a `##` heading, not a bold lead-in, so the sections stand apart. Use these sections in order. Drop a section when it has nothing to say.

- `## Why` gives the problem and the approach in one to three short sentences. Do not list SHAs or rebase genealogy. Do not add a "based on main" preamble.
- `## What changed` has one to three short bullets. Name a real symbol or path only when it carries the change. Name both sides of a rename or retarget.
- `## Scope` always names what the PR covers and what it deliberately leaves out, for example a related follow-up or a known gap. Use one to three short items. Do not list symbols or paths, and do not write a file-by-file essay.
- `## Tradeoffs` names only rejected alternatives that a reviewer would otherwise ask about. Skip this section when there was no real choice.
- `## Blast Radius` gives one or two sentences on who or what the change touches and why that is safe or risky. If main is red, state the cost of leaving it red.
- `## Verification` has one to three bullets. Each bullet names a real run path and its outcome. For a performance change, report one primary number with its unit in `before → after` form. Link the arena or swarm directory for the remaining evidence. Do not include sample-size methodology, swarm recitals, or metric tables.

After these sections, attach videos or screenshots when they prove a claim. Do not paste full SHAs, swarm or arena lane recitals, lever-correction essays, file-by-file checklists, or "CLEAN" verdicts. Put these details in a linked artifact. A commit body does not restate its subject.

**Forge.** Resolve the forge before the first PR operation and keep that choice for create, edit, view, watch, and merge. Use the supported GitHub CLI path from Guarded operations with the captured operation record and explicit `--repo <owner/name>`. Refuse an Origin mutation path because its expected-head adapter is unproven. Never require Graphite (`gt`).

**Built-in PR tool.** Neither Claude Code, Codex nor a Grok root gives the agent a built-in PR tool. Every PR operation goes through the Guarded operations blocks of `playbooks/shipping.md` under the installed plugin, with the captured operation record.

**Size and stacks.** Prefer five narrow PRs to one large PR. A stack is a base-branch chain. The root PR targets trunk. Record the old parent and child tips before restacking. Apply only the child's own range with the Guarded operations `rebase --onto` recipe; its PR targets the parent branch. Without a built-in PR tool, create a child with the complete Guarded operations Create block, and retarget an existing child with the complete Guarded operations Retarget block after withdrawal and readback. Branch from trunk only for independent work. Rebase on trunk before substantial stack work. Use Guarded operations for every push, with First publication for an absent branch and a captured remote SHA before later fix waves.

**Readiness.** Open every PR ready, never as a draft. A built-in PR tool can default to draft; route every creation through the complete Create block rather than a separate tool call. Existing drafts go through the complete Ready block. Use the complete Guarded operations Create block, which binds the recorded branch, published head and base and omits `--draft`. If a PR still opens as a draft, mark it ready through the PR tool, or run the complete Guarded operations Ready block. Run `GH_HOST=<validated-host> gh pr view --repo <owner/name> <number>` before you refer to PR status.

**Babysit.** Opening a PR does not start a babysit. Post the URL and keep building. Finish the phase or stack first. Run a separate babysit pass only when the user asks for one after the whole stack exists. A babysit for each new PR stalls the build and spends checks on commits that later waves restart. Push back when feedback drifts from intent.

A subagent that opens a PR runs `interrogate`, `/deslop`, and `/no-comments`, and posts the URL. Then it returns to the parent without babysitting, unless it is an Autopilot-full or Autopilot-stack owner. That owner's brief assigns the babysit loop and is the ask `playbooks/babysit.md` waits for. The owner starts the loop after its code-ready report and reports merge-ready or STACK-READY as its playbook says. The rules here and in `playbooks/babysit.md` that hold babysitting until a whole stack is built do not apply to that owner.
