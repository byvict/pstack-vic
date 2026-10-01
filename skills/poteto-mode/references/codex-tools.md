# Codex tool mapping for pstack

pstack skills retain Claude Code tool language (`Skill`, `Agent`, `AskUserQuestion`) in shared prose. On Codex the files are the same; only those tool names resolve differently. Model execution is not translated here. Read [`provider-dispatch.md`](provider-dispatch.md) for the parent-owned Claude/Codex/Grok route table and provider-qualified descriptors.

## Tool actions

| pstack / Claude action | Codex equivalent |
|------------------------|------------------|
| Read a file | `shell` (`cat`, `head`, `tail`) |
| Create / edit / delete a file | `apply_patch` |
| Run a shell command | `shell` |
| Search file contents / find files | `shell` (`rg`, `grep`, `find`, `ls`) |
| Fetch a URL | `shell` with `curl` / `wget` |
| Search the web | `web_search` |
| Invoke a skill (the `Skill` tool, `/command`) | Skills load natively. Follow the instructions presented. |
| `paths` frontmatter scopes automatic loading | Claude Code only. On Codex, invoke `pstack:typescript-best-practices` by name. |
| Dispatch a subagent (the `Agent`/`Task` tool) | `spawn_agent` |
| Dispatch N parallel subagents in one turn | N `spawn_agent` calls in one response |
| Wait for a subagent result | `wait_agent` |
| Free a finished subagent slot | `close_agent` |
| Track tasks (the todolist / `TodoWrite`) | `update_plan` |
| Arm a `/goal` (the autopilot playbooks; `ProposeGoal` on Claude Code) | `create_goal`, read back with `get_goal`. The goal tools need `goals = true` under `[features]` in `~/.codex/config.toml` and a persistent thread. |
| The program's agent list (the audit tick of the autopilot playbooks) and the background task list (Orchestrate's read-only probe) | The subagents you spawned and have not closed (`spawn_agent` handles) and your persistent exec sessions |
| Ask the human a fixed-choice question (`AskUserQuestion`) | Ask in plain text and let the user answer. Codex has no structured-choice tool. |
| Transcript directory (show-me-your-work audit, session pickup) | `~/.codex/sessions/`, same no-glob rule |

Subagent dispatch needs `multi_agent` enabled. Add to `~/.codex/config.toml`:

```toml
[features]
multi_agent = true
```

Without it, the native Codex lane is a named dropout. Independent external lanes still run, and the parent records the reduced provider count. Never collapse a panel into a sequential single-model pass.

## Subagent policy

poteto-mode's Subagents section sets Claude-specific defaults (`subagent_type: "poteto-agent"`, `isolation: "worktree"`, `run_in_background: true`). On Codex:

- There is no `poteto-agent` subagent type. Route an ad-hoc subagent through poteto-mode's style by dispatching a `spawn_agent` whose instructions tell it to read the `poteto-mode` skill in full first.
- `spawn_agent` calls already run concurrently with your turn, so `run_in_background: true` has no separate flag. Issue the dispatch and continue.
- `spawn_agent` takes no `isolation` parameter. Where the Claude call passes `isolation: "worktree"`, create the worktree with `git worktree add` before the dispatch and name its path in the brief.
- An Autopilot-full or Autopilot-stack owner is one `spawn_agent` with the model and `reasoning_effort` of its authoring row, a worktree of its own, and instructions to read the `poteto-mode` skill in full first.
- There is no `comment-sicko` subagent type either. The **no-comments** skill spawns it on Claude Code; on Codex dispatch a `spawn_agent` whose instructions tell it to read `agents/comment-sicko.md` in full first.
- The port runs every Claude Code subagent on this machine (`isolation: "remote"` is behind a gate and falls back to a worktree), so the **swarm** skill's workers and the fan-out playbooks (`orchestrate`, `autopilot-full`, `autopilot-stack`) isolate writers with worktrees. The same holds on Codex.
- Keep the rest of the policy unchanged. Pass file pointers not inlined context, give each worker its own worktree or branch when they write, review every subagent's diff yourself.

## Models and providers

Do not replace every configured entry with a Codex model. `/setup-pstack` writes portable descriptors of the form `<provider>:<model>@<effort>`; the defaults per role and parent are the role table in `provider-dispatch.md`. In a Codex parent, only `codex:*` is native. Route Claude and Grok descriptors through the external launcher exactly as `provider-dispatch.md` specifies. The default panel intentionally mixes providers and contains no older GPT or Claude substitute.

## Claude built-in skills pstack references

Some triggers name skills that ship with Claude Code, not pstack. They do not exist on Codex. Substitute the behavior:

| Claude built-in named in pstack | On Codex |
|---------------------------------|----------|
| `run` (drive a CLI/TUI to see a change work) | Run the app yourself via `shell` and observe the real output. |
| `verify` (drive a UI to confirm a fix) | Drive the UI with whatever automation you have, or hand the user a concrete manual check. Do not claim done without observing the artifact. |
| `skill-creator` (Anthropic's SKILL.md authoring skill) | Follow your platform's skill-authoring guidance; the `writing-skills` skill if present. Keep `name` + `description` frontmatter and progressive disclosure. |
| `loop` (recurring/self-paced re-invocation, used by `babysit`, `shipping`, and the 30-minute audit tick of the autopilot playbooks) | Codex has no `loop` skill. Re-run the step yourself on a cadence, or use a Codex scheduled task if available. For the 30-minute audit tick, where no scheduled task re-prompts the session, the cadence is the operator's re-prompt. When you state the protocol, tell the operator to send the tick prompt every 30 minutes, and run one full tick on each prompt. |

## Vendored scripts

`skills/poteto-mode/scripts/` ships the `watch-pr` PR watcher, the `orch` store CLI, `worktree-audit.sh`, and `runner/pstack-runner`. They run the same on Codex; invoke them through `shell`. The external runner is plain Node 24 TypeScript (no Bun) and additionally needs the assigned `claude`, `codex`, or `grok` executable already authenticated. It rejects a Codex provider when Codex is the parent because that lane belongs on native `spawn_agent`. `watch-pr` and `orch` need `bun`; PR work needs `gh`; only Orchestrate needs `gt` (its stacker and `orch frontier`); `worktree-audit.sh` needs `jq` and `rg`. `worktree-audit.sh` reads Claude Code transcripts under `~/.claude/projects/`; point it at your runtime's transcript directory instead when you run it elsewhere.

## Instructions file

Where a pstack skill says "your instructions file", on Codex that is `AGENTS.md` (project root, plus `~/.codex/AGENTS.md` global). On Claude Code it is `CLAUDE.md`.
