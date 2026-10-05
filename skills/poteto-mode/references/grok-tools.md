# Grok Build tools for pstack

Use this mapping when the root runs on Grok Build CLI, including a T3 Code thread using that provider. The Grok process is the parent harness. T3's model picker label does not select a pstack provider or change a configured descriptor. Resolve models through [provider-dispatch.md](provider-dispatch.md).

## Tools

| Shared action | Grok Build equivalent |
|---|---|
| Read, search, edit, run commands | `read_file`, `grep`, `list_dir`, `search_replace`, `run_terminal_command`. Use the names and parameters advertised in the session; some CLI versions call the shell tool `run_terminal_cmd`. |
| Invoke a skill | Load its `SKILL.md` and follow it. Grok reads pstack through its Claude plugin compatibility, `.grok/skills`, or configured skill paths. |
| `Agent` / `spawn_agent` | `spawn_subagent`, retaining the returned subagent ID. |
| `TaskOutput` / wait for a child | `get_command_or_subagent_output` with `task_ids: [id]`. A positive `timeout_ms` waits; zero gives a snapshot. |
| Background Bash | Shell tool with `block_until_ms: 0`, retaining its task ID. |
| `TaskStop` | `kill_command_or_subagent` with the retained `task_id`. |
| Agent list for an audit | The IDs the root recorded in the program's `children.tsv`, queried through the output tool. Todo items are not running agents. |
| Message an owner | `send_subagent_message` when advertised. Otherwise wait for its code-ready return and resume it with `spawn_subagent` and `resume_from`, using the same `subagent_type`. An active child cannot be resumed. |
| `AskUserQuestion` | Ask in the conversation. |
| `run` / `verify` | Read the project's driver skill and drive the real app through it. There is no Claude built-in to invoke. |
| Instructions and transcript | Project `AGENTS.md`, global `~/.grok/AGENTS.md`, and sessions under `~/.grok`. |

## Native lanes and owners

For `grok:*`, match the descriptor to its matrix family and dispatch `pstack-<stem>-<effort>` as the `subagent_type`. Plugin agents are namespaced, such as `pstack:pstack-grok-4-7-xhigh`; use the exact advertised name. The generated agent definition binds the model and effort. Skill frontmatter does not bind either, and a prompt asking a child to use a model does not change its model. Pass the complete task, grounding paths, access mode and unique output location. Launch with `background: true`, then drain every handle before judging. If the definition or the spawn tool is unavailable, record a named dropout.

For a writer, create its dedicated worktree first and pass `cwd` to the spawn, or use native `isolation: "worktree"`. These two arguments are mutually exclusive. A reader receives the actual checkout. Ordinary lane definitions deny recursive agents; a child executes its assignment without choosing providers or starting another pstack workflow.

`inherit-parent` and `auto` use `pstack:poteto-agent`, with no model or effort override, and retain the parent's connected MCP tools. Tell that helper to execute only the assigned role. An autopilot owner on a native authoring row uses `pstack:pstack-owner-<stem>-<effort>` in its own worktree. Owner definitions retain spawning tools and read poteto-mode before work. If the authoring row names an external provider, use an inherited native owner for the lifecycle and have it dispatch the implementation through that row's runner route. The external implementation lane remains a bounded child; it is not the owner.

The root → owner → helper tree requires an effective `[subagents] max_depth = 2` or higher in Grok's `config.toml`, loaded before the root starts. The default is one: it removes spawning from the owner even though its definition permits it. Every setup plan must prove the nested call with a fresh marker and retain both IDs before writing the Grok sheet, independently of cached model-family probes. At the start of an autopilot program in a new root, prove that same tree before launching writers; record the root session ID and the two observed handles in the program artifacts. A setup proof observed in this root can supply it. If the depth is insufficient, report the required config change and session restart. A bounded helper must not start another playbook; a deeper tree needs an explicitly configured depth and its own live proof.

Claude and Codex descriptors go directly through `pstack-runner --parent grok`. Start them with the shell's `block_until_ms: 0`, retain their IDs, and drain their receipts with the output tool. Preserve the root's actual sandbox. A root sandbox that blocks a CLI produces a dropout. T3's Full access launch uses `grok agent --always-approve stdio` without a Grok sandbox; that does not change the confinement the runner applies to its children.

## Autopilot objective and audit

Grok CLI 1.0.46 advertises `/goal` over the same ACP stdio protocol T3 uses. Arm the full objective in the root session with `/goal <objective>`. When only the user-facing slash command can create it, provide the exact line for the operator to type in that same T3 thread, as on Claude when its goal-creation tool is absent. A goal in a separate CLI process does not arm this root. At each pickup and audit, read this session's `goal/state.json` and the `plan_file` it names under `~/.grok/sessions` (or the configured `GROK_HOME`). Match the root session ID; do not use another session's goal. Use the advertised `update_goal` tool to report progress or completion only after the playbook's predicate holds; the tool appears when a goal is active. Save the objective, holds, reports and handles beside the program's artifacts so a resumed root can reconcile them. If the runtime has no goal command, report that capability as unavailable rather than claiming an armed autonomous program.

Arm the 30-minute root audit with `monitor`, running `node <plugin>/skills/poteto-mode/scripts/grok-audit-ticker.ts --program <reports directory>`, with `persistent: true`. Retain its task ID. Each output line wakes the root with a tick naming the program. On that tick, re-read the governing playbook and active goal, audit each owner and its `children.tsv`, and apply the playbook's stuck-lane policy. Grok's `/loop` and `scheduler_create` run detached subagents and do not perform this audit by the root that owns the handles. A monitor has a ten-hour ceiling in CLI 1.0.46; re-arm it during an audit before that ceiling and stop the old handle. Stop the ticker when the program finishes or the operator pauses it. If monitor notifications do not reach this client, keep the root supervising with output waits of at most 60 seconds and perform the audit when 30 minutes have elapsed since the recorded tick. If the session disconnects or ends, the operator resumes the same root and its native goal; reconcile old handles before spawning replacements.

Without active messaging, an owner returns its code-ready head and trail to the root. The root verifies that head, then resumes the completed owner with the verdict and fix-forward or merge instruction. Keep each current verdict tied to its head as the playbook requires. An owner never treats elapsed time or an unread message as a clean verdict.

For recurring babysit work inside an owner, run the PR watcher's blocking `drive` loop as the Claude owner adaptation does. Keep the loop's handle and drain it before ending a non-interactive session. Verify cancellation through the retained task handle and preserve the runner's cancelled receipt.

## Setup and permissions

Run setup with `--parent grok`. It stores the sheet and probe ledger under `~/.grok` and mirrors the sheet in one bounded block in `~/.grok/AGENTS.md`. Grok may also load Claude instructions. At dispatch time, the Grok sheet is authoritative; a Claude sheet included by compatibility is for the Claude parent. Each parent's probes stay independent.

For the standing-authorization check, pass the observed effective session mode to `authorize.ts check --parent grok --permission-mode <mode>`. `always-approve` and `bypassPermissions` pass this tool-approval check. Read the current launch flags or session mode rather than inferring it from T3's label or the config file. Other modes require operator intervention at prompted actions. This check does not grant permission to merge and does not bypass deny rules or hooks; the task's authorization and playbook gates still govern mutations.

The runtime contracts are documented in [Grok subagents](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/16-subagents.md), [background tasks](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/20-background-tasks.md), [project rules](https://docs.x.ai/build/features/project-rules), and [T3's Grok adapter](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/provider/acp/GrokAcpSupport.ts).
