# Codex tool mapping for pstack

pstack skills retain Claude Code tool language (`Skill`, `Agent`, `AskUserQuestion`) in shared prose. On Codex the files are the same; only those tool names resolve differently. Model execution is not translated here. Read [`provider-dispatch.md`](provider-dispatch.md) for the parent-owned Claude/Codex/Grok route table and provider-qualified descriptors.

## Harness config homes

Resolve the current parent's config home once: Claude Code uses `CLAUDE_CONFIG_DIR` when it is set, otherwise `$HOME/.claude`; Codex uses nonempty `CODEX_HOME`, otherwise `$HOME/.codex`. The equivalent quoted shell expressions are:

```bash
"${CLAUDE_CONFIG_DIR-$HOME/.claude}"
"${CODEX_HOME:-$HOME/.codex}"
```

Codex treats an empty `CODEX_HOME` as unset. Claude Code 2.1.289 does not, and with `CLAUDE_CONFIG_DIR` set but empty it reads `settings.json` and `CLAUDE.md` from the directory it starts in. So setup and `authorize.ts` stop on an empty `CLAUDE_CONFIG_DIR` instead of picking a home. Preserve spaces in the resolved path by quoting shell file operands. In shared instructions, `<config-home>` means this resolved parent-specific directory, not literal text to write. Use that same home for setup's sheet and integration writes, snapshots, restoration, and readback. This port keeps Grok Build at `$HOME/.grok`. Grok CLI 1.0.46 documents a `GROK_HOME` override, which neither setup nor the runner follows yet. In this port `setup-pstack.ts` resolves the home with `configHomeFor` and keeps the probe ledger there too, and `authorize.ts` checks the `settings.json` or `config.toml` of the same home. Both scripts refuse a variable that is not an absolute path.

The Claude integration is the one `@` import line in `<config-home>/CLAUDE.md` whose target's basename is `pstack-models.md`, regardless of its existing directory or path spelling. Select current state using [setup-pstack step 2](../../setup-pstack/SKILL.md#2-load-current-state). When `<config-home>` is the default home, render exactly the legacy line:

```text
@~/.claude/pstack-models.md
```

Only when `CLAUDE_CONFIG_DIR` redirects the home, render exactly `@./pstack-models.md`. This relative import resolves from the importing file's directory, where the sheet also lives, so the import line contains no config-directory characters. On a rerun, replace that one line in place, preserving all unrelated bytes. If zero matching import lines exist, append one. If more than one exists, stop and report inconsistent state before either write; do not append another import or guess which one to replace. A `CLAUDE_CONFIG_DIR` that names `$HOME/.claude` is still the default home and keeps the legacy line. The script reads `CLAUDE.md` with the block rules of marked 16, the Markdown lexer of Claude Code 2.1.289. An import on a plain line, in a plain list item or in a plain quote counts. One in front matter, a fenced or indented code block, an HTML block, a code span or a link definition does not. A mention the script cannot place the way Claude Code does stops setup as inconsistent state, for example one glued to emphasis, one inside a link, or one after a list that holds a fenced code block. A new import goes at the end of the file, after a blank line when the last paragraph would leave it in doubt. When the script cannot be sure that the end loads, as inside a code block, an HTML block or a comment, it goes at the top, after any front matter and followed by a blank line.

## Tool actions

Resolve these actions against the current session's advertised tools and schemas. Codex hosts expose different lifecycle operations. Before dispatching or reusing agents, read [native-lifecycle.md](native-lifecycle.md).

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
| Dispatch N parallel subagents | `spawn_agent` calls within the host's capacity, with queued waves per the lifecycle contract |
| Wait for a subagent result | `wait_agent` |
| Start a new task on a compatible idle subagent | `followup_task` when advertised, or the host's documented equivalent; a plain message may not start a turn |
| Stop a running subagent turn | `interrupt_agent` when advertised; this does not establish slot release |
| Free a finished subagent slot | `close_agent` only when advertised and its result establishes release; otherwise retain the idle handle |
| Track tasks (the todolist / `TodoWrite`) | `update_plan` |
| The program's agent list (the audit tick of the autopilot playbooks) and the background task list (Orchestrate's read-only probe) | `list_agents` when advertised, reconciled with retained subagent handles and persistent exec sessions |
| Ask the human a fixed-choice question (`AskUserQuestion`) | Ask in plain text and let the user answer. Codex has no structured-choice tool. |
| Transcript directory (show-me-your-work audit, session pickup) | `~/.codex/sessions/`, same no-glob rule |

Subagent dispatch needs `multi_agent` enabled. Add to `<config-home>/config.toml`, using Codex's [config-home rule](#harness-config-homes):

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
- Resolve each Autopilot-full or Autopilot-stack owner through [Autopilot owners](provider-dispatch.md#autopilot-owners). For a supported native descriptor, use one `spawn_agent` with the row's model and `reasoning_effort`, its own accessible worktree, and instructions to read the `poteto-mode` skill in full first. If the native host cannot supply the descriptor or owner capabilities, select the supported runner owner profile through that rule, preserving the row.
- In Autopilot-full, the root must also attach every PR created by its subagents to its own chat as soon as it receives the URL. In the root chat, call `list_artifacts`. If the PR is missing, call `attach_artifact` with `artifact_type: "pull_request"` and its URL, then call `list_artifacts` again to confirm the attachment. An existing attachment in the root chat satisfies this requirement. On session pickup, recover all PR URLs from the run's reports and reconcile them the same way, including merged PRs. Keep PR creation, verification, and merge ownership as the playbook assigns them.
- There is no `comment-sicko` subagent type either. The **no-comments** skill spawns it on Claude Code; on Codex dispatch a `spawn_agent` whose instructions tell it to read `agents/comment-sicko.md` in full first.
- The port runs every Claude Code subagent on this machine (`isolation: "remote"` is behind a gate and falls back to a worktree), so the **swarm** skill's workers and the fan-out playbooks (`orchestrate`, `autopilot-full`, `autopilot-stack`) isolate writers with worktrees. The same holds on Codex.
- Keep the rest of the policy unchanged. Pass file pointers not inlined context, give each worker its own worktree or branch when they write, review every subagent's diff yourself.

## Models and providers

Do not replace every configured entry with a Codex model. `/setup-pstack` writes portable descriptors of the form `<provider>:<model>@<effort>`; the defaults per role and parent are the role table in `provider-dispatch.md`. In a Codex parent, only `codex:*` is native. Route Claude and Grok descriptors through the external launcher exactly as `provider-dispatch.md` specifies. The default panel intentionally mixes providers and contains no older GPT or Claude substitute.

For an assigned external Grok task that needs PTY or T3 preview, the parent can explicitly choose `--transport grok-acp --mode full-access`. A versioned `--mcp-config` attachment carries endpoint and token environment references and its assigned preview tab. Follow the [Grok ACP contract](provider-dispatch.md#explicit-grok-acp-tasks). This grants host access and admits trusted ambient Grok integrations and hooks. Default CLI calls retain their bounded modes. Grok-native dispatch stays native.

## Claude built-in skills pstack references

Some triggers name skills that ship with Claude Code, not pstack. They do not exist on Codex. Substitute the behavior:

| Claude built-in named in pstack | On Codex |
|---------------------------------|----------|
| `run` (drive a CLI/TUI to see a change work) | Run the app yourself via `shell` and observe the real output. |
| `verify` (drive a UI to confirm a fix) | Drive the UI with whatever automation you have, or hand the user a concrete manual check. Do not claim done without observing the artifact. |
| `skill-creator` (Anthropic's SKILL.md authoring skill) | Follow your platform's skill-authoring guidance; the `writing-skills` skill if present. Keep `name` + `description` frontmatter and progressive disclosure. |
| `loop` (recurring/self-paced re-invocation, used by `babysit`, `shipping`, and the hourly audit tick of the autopilot playbooks, `/loop 1h`) | Preserve the upstream payload and cadence using a host scheduled task or the [local CLI wake adapter](codex-local-wake.md) for a persisted thread loaded in a running local host. The local controller must have socket access; ephemeral/unloaded sessions and a worker sandbox without that access cannot arm it. Each event is finite; explicitly rearm only while the program needs another tick. Without either mechanism, tell the operator to send the tick prompt every hour and run one full tick per prompt. |

## Vendored scripts

`skills/poteto-mode/scripts/` ships the `watch-pr` PR watcher, the `orch` store CLI, `worktree-audit.sh`, and `runner/pstack-runner`. They run the same on Codex; invoke them through `shell`. The external runner is plain Node 24 TypeScript (no Bun) and additionally needs the assigned `claude`, `codex`, or `grok` executable already authenticated. Prefer native `spawn_agent` for Codex lanes; when it cannot meet the task, apply [provider dispatch's alternative route](provider-dispatch.md#when-native-dispatch-is-unavailable). `watch-pr` and `orch` need `bun`; PR work needs `gh`; only Orchestrate needs `gt` (its stacker and `orch frontier`); `worktree-audit.sh` needs `jq` and `rg`. `worktree-audit.sh` reads Claude Code transcripts under `~/.claude/projects/`; point it at your runtime's transcript directory instead when you run it elsewhere.

## Instructions file

Where a pstack skill says "your instructions file", on Codex that is `AGENTS.md` (project root, plus `<config-home>/AGENTS.md` global). On Claude Code it is `CLAUDE.md` (project root, plus `<config-home>/CLAUDE.md` global). Resolve the global directory with the [config-home rule](#harness-config-homes).
