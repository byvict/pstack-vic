# Provider dispatch

On a Grok Build root, read [grok-tools.md](grok-tools.md) before dispatching roles or following Claude tool names. This includes T3 Code sessions on that provider.

pstack model choices are provider-qualified descriptors:

```text
<provider>:<model>@<effort>
```

## Model matrix

The matrix lives in [`model-matrix.json`](../../../model-matrix.json) at the plugin root. The block below is rendered from it by `scripts/render-model-matrix.ts`; edit the JSON, not the table.

<!-- model-matrix:begin -->

| Family | Provider | Model | Default effort | Selectable efforts | Native in | Native agent stem | Replaces (Cursor 0.15.2) |
|---|---|---|---|---|---|---|---|
| fable | claude | `fable` | max | low medium high xhigh max | claude | `fable` | `claude-fable-5-1-thinking-{effort}` |
| opus | claude | `claude-opus-5-5` | xhigh | low medium high xhigh max | claude | `opus` | `claude-opus-5-thinking-{effort}` |
| sol | codex | `gpt-6-sol` | max | low medium high xhigh max | codex | - | `gpt-5.6-sol-{effort}` |
| sol-6-1 | codex | `gpt-6.1-sol` | max | low medium high xhigh max | codex | - | - |
| astra | codex | `gpt-6-astra` | max | low medium high xhigh max | codex | - | - |
| grok | grok | `grok-4.6` | xhigh | low medium high xhigh max | grok | `grok` | `grok-4.6-fast-{effort}` |
| grok-4-7 | grok | `grok-4.7` | xhigh | low medium high xhigh | grok | `grok-4-7` | - |

The allowed effort universe is exactly `low`, `medium`, `high`, `xhigh`, `max`. First-run requested efforts are the Default effort cell of each row. A native agent stem of `-` means the family has no agent definition. Otherwise the shipped agent name is `pstack-<stem>-<effort>`. Aliases `inherit-parent` and `auto` are not families and carry no effort.

### Route table

| Parent | `claude:*` | `codex:*` | `grok:*` |
|---|---|---|---|
| Claude Code | native `Agent` | external runner | external runner |
| Codex | external runner | native `spawn_agent` | external runner |
| Grok Build | external runner | external runner | native `spawn_subagent` |

<!-- model-matrix:end -->

`fable` is a Claude Code rolling alias. The Opus family pins `claude-opus-5-5`. A runner receipt keeps the requested model in `model` and the provider-reported revision in `reportedModel`; verification checks each family against its `reportedModel` pattern.

Grok Build CLI 1.0.5 reports the served model as `grok-4.6-build` in the result event's `modelUsage` (measured 2026-09-17); the grok family's `reportedModel` pattern accepts that build suffix and nothing else.

`sol`, `sol-6-1` and `astra` share the `codex` CLI, its flags, and its output parser. They differ only in the `--model` argument. Codex also exposes an `ultra` effort that delegates tasks automatically; it is outside the effort universe because a pstack child never delegates.

## Role defaults

Skills name roles by the labels below, the same labels `/setup-pstack` writes to the model sheet (`~/.claude/pstack-models.md` on Claude Code, `~/.codex/pstack-models.md` on Codex, `~/.grok/pstack-models.md` on Grok). A sheet line overrides the default of its role. Without a sheet, a role takes its cell for the current parent. The block is rendered from `model-matrix.json`; edit the JSON, not the table.

<!-- role-defaults:begin -->

| Role | What the lane does | Claude Code parent | Codex parent | Grok Build parent |
|---|---|---|---|---|
| `feature, refactoring` | Writes the code of a feature or a behavior-preserving refactor in its own worktree; the parent reviews the diff. | `claude:claude-opus-5-5@xhigh` | `codex:gpt-6-sol@xhigh` | `grok:grok-4.7@xhigh` |
| `bug-fix` | Reproduces a reported defect, finds the root cause, and writes the fix with runtime evidence. | `claude:claude-opus-5-5@xhigh` | `codex:gpt-6-sol@xhigh` | `grok:grok-4.7@xhigh` |
| `perf-issue` | Traces a measured slowness against a baseline and implements the improvement. | `claude:claude-opus-5-5@xhigh` | `codex:gpt-6-sol@xhigh` | `grok:grok-4.7@xhigh` |
| `hillclimb` | Iterates hypotheses on one metric with before/after measurements, one commit per accepted win. | `claude:claude-opus-5-5@xhigh` | `codex:gpt-6-sol@xhigh` | `grok:grok-4.7@xhigh` |
| `judgment and prose` | Writes and judges prose: docs, PR descriptions, summaries, explanations, syntheses. | `claude:fable@max` | `codex:gpt-6-astra@max` | `grok:grok-4.7@xhigh` |
| `hardest tasks` | Implements the hardest changes: cross-cutting design, subtle concurrency or algorithms, vague intent, or a precise multi-step sequence. | `claude:fable@max` | `codex:gpt-6-astra@max` | `grok:grok-4.7@xhigh` |
| `how explorer` | Reads a subsystem in read-only mode and reports how it works, with file and line evidence. | `grok:grok-4.6@xhigh` | `grok:grok-4.6@xhigh` | `grok:grok-4.6@xhigh` |
| `how explainer` | Turns the explorers' findings into the explanation the how skill delivers. | `claude:fable@max` | `codex:gpt-6-astra@max` | `grok:grok-4.7@xhigh` |
| `why investigators` | Investigate why something was built this way across git history, tickets, and the parent's MCP sources; needs the parent's MCPs, so it stays on an alias. | `inherit-parent` | `inherit-parent` | `inherit-parent` |
| `why synthesizer` | Merges the why investigators' findings into one answer; same MCP constraint, stays on an alias. | `inherit-parent` | `inherit-parent` | `inherit-parent` |
| `reflect tooling` | Reads transcripts and skills to find lessons after a long task with the parent's tools; stays on an alias for the MCP reason. | `inherit-parent` | `inherit-parent` | `inherit-parent` |
| `reflect judgment, divergent, synthesizer` | Judges, dissents on, and synthesizes the lessons the reflect skill captures; stays on an alias for the MCP reason. | `inherit-parent` | `inherit-parent` | `inherit-parent` |
| `arena runners` | Each lane attempts the same task in parallel; the arena picks a base and grafts the strongest parts of the others. One lane per entry. | `claude:fable@max`, `codex:gpt-6-astra@max`, `grok:grok-4.6@xhigh`, `claude:claude-opus-5-5@xhigh` | `claude:fable@max`, `codex:gpt-6-astra@max`, `grok:grok-4.6@xhigh`, `claude:claude-opus-5-5@xhigh` | `claude:fable@max`, `codex:gpt-6-astra@max`, `grok:grok-4.6@xhigh`, `claude:claude-opus-5-5@xhigh` |
| `arena cross-judge pool` | Judges the arena candidates; the arena picks a provider different from the parent and the base candidate when possible. | `claude:fable@max`, `codex:gpt-6-astra@max`, `grok:grok-4.6@xhigh`, `claude:claude-opus-5-5@xhigh` | `claude:fable@max`, `codex:gpt-6-astra@max`, `grok:grok-4.6@xhigh`, `claude:claude-opus-5-5@xhigh` | `claude:fable@max`, `codex:gpt-6-astra@max`, `grok:grok-4.6@xhigh`, `claude:claude-opus-5-5@xhigh` |
| `swarm workers` | Default worker for every swarm lane: coverage matrices, races, gauntlets, exploration partitions. | `grok:grok-4.6@xhigh` | `grok:grok-4.6@xhigh` | `grok:grok-4.6@xhigh` |
| `architect runners` | Each lane proposes a design (types, module shape) for the same problem before implementation. One lane per entry. | `claude:fable@max`, `codex:gpt-6-astra@max`, `grok:grok-4.6@xhigh`, `claude:claude-opus-5-5@xhigh` | `claude:fable@max`, `codex:gpt-6-astra@max`, `grok:grok-4.6@xhigh`, `claude:claude-opus-5-5@xhigh` | `claude:fable@max`, `codex:gpt-6-astra@max`, `grok:grok-4.6@xhigh`, `claude:claude-opus-5-5@xhigh` |
| `interrogate reviewers` | Each lane reviews the diff adversarially from its own angle; a different provider per lane widens the blind spots covered. | `claude:fable@max`, `codex:gpt-6-astra@max`, `grok:grok-4.6@xhigh`, `claude:claude-opus-5-5@xhigh` | `claude:fable@max`, `codex:gpt-6-astra@max`, `grok:grok-4.6@xhigh`, `claude:claude-opus-5-5@xhigh` | `claude:fable@max`, `codex:gpt-6-astra@max`, `grok:grok-4.6@xhigh`, `claude:claude-opus-5-5@xhigh` |
| `trail reviewer pool` | Reviews the decision trail of a finished run; one lane runs, the first entry whose provider wrote none of the work. | `claude:claude-opus-5-5@xhigh`, `codex:gpt-6.1-sol@xhigh`, `grok:grok-4.7@xhigh` | `claude:claude-opus-5-5@xhigh`, `codex:gpt-6.1-sol@xhigh`, `grok:grok-4.7@xhigh` | `claude:claude-opus-5-5@xhigh`, `codex:gpt-6.1-sol@xhigh`, `grok:grok-4.7@xhigh` |

A list is a panel: one lane per entry, in this order. A row whose label ends in `pool` is the exception: one lane runs, picked by the Cross-family selection rule below. A role whose parent columns differ takes a family native to each parent: the frontier family for the frontier solo roles, the code family for the four authoring rows. Aliases run on the parent model through its native subagent primitive.

<!-- role-defaults:end -->

A lane's effort is its own. Two roles, or two lanes of one panel, may name the same family at different efforts (`bug-fix: codex:gpt-6-sol@xhigh` next to `hillclimb: codex:gpt-6-sol@high`). The parent dispatches each descriptor as written, through the agent or runner flags of that effort, and `/setup-pstack` probes a family only the first time a parent uses it (a new provider or model), never for an effort change. A family has no effort of its own; the Default effort column above seeds first-run lanes only.

## Read-time normalization

Normalize configured descriptors before matching them to the matrix or choosing a route. Keep an exact matrix model unchanged. Migrate old provider-qualified Fable revisions to `fable`, `opus` and old Opus revisions to `claude-opus-5-5`, and `gpt-5.6-sol` to `gpt-6-sol`. Preserve provider, effort, role, and lane order. Use the normalized descriptor for native dispatch or runner argv.

This read-time rule makes an older installed sheet use the configured families immediately without writing user files. Once per parent run, report that the persisted sheet is stale and that `/setup-pstack` will rewrite it after its normal probes and confirmation. Unknown versioned Claude models remain invalid. The external runner accepts only model IDs registered in the matrix.

The legacy Cursor selector `grok-4.6-fast-{effort}` maps to CLI model `grok-4.6`. The CLI's separate `grok-4.7-build-fast` model is not registered in this matrix. The portable Grok route pins the selected CLI model. Claude and Codex parents retain their Grok 4.6 role defaults; the Grok parent uses 4.7 for its authoring and frontier solo roles. The shared `trail reviewer pool` also names 4.7. Both families default to `xhigh`; Grok 4.7 supports `low`, `medium`, `high`, and `xhigh`. T3 Code's model picker entry "Grok Build" is not a CLI model id: T3 defines it as "use whatever model the Grok session currently runs on", and `grok --model grok-build` fails with `unknown model id` (measured 2026-10-02, Grok CLI 1.0.46). A T3 thread on "Grok Build" runs the CLI's configured default (`grok-4.7` at `xhigh` on this machine) and reports `grok-4.7-build`, the same served model as a `grok:grok-4.7` lane.

## The parent owns the route

The top-level harness resolves the route once. A child receives an assigned provider, model, effort, access mode, prompt, working directory, and output path. A child never detects the harness, chooses a provider, or launches another model. Environment markers may corroborate the top-level harness before fan-out, but nested processes inherit parent markers and must not use them for routing.

An autopilot owner is the one child that dispatches. It is the parent of the lanes it starts, and it resolves their routes by this document on the harness its root runs on. A pool lane stays with the top-level session (see **Cross-family selection**).

The route table is the one rendered above from `model-matrix.json`: a provider is native in exactly one parent and goes through the external runner everywhere else.

`inherit-parent` and `auto` remain aliases. They use the parent's current model and effort through its native subagent primitive. In a panel they still consume one lane, but they reduce provider diversity; say so in the synthesis record.

## Cross-family selection

A pool role is a list from which one lane runs. `trail reviewer pool` reviews the decision trail of a finished run (the **show-me-your-work** skill). `arena cross-judge pool` judges the arena candidates. Both pick their lane with the rule in this section.

Two lanes are cross-family when their providers differ. The provider is the Provider column of the model matrix. The Family column names one model line, so it does not decide: `gpt-6-sol` reviewing `gpt-6-astra` is the same provider, and so is `fable` reviewing `claude-opus-5-5`. The route does not decide either. A `claude:*` lane that a Codex parent launches through the runner is still a Claude lane. Each provider in the matrix serves the models of one vendor. A provider that serves another vendor's models needs a vendor field in the matrix before it enters a pool.

The executors of a piece of work are the providers that wrote it:

- The session that did the work, always. A root session and every native subagent under it, an autopilot owner included, run on the parent's native provider.
- Every lane dispatched with `isolated-write` whose output is part of the result: an authoring lane, the base candidate of an arena, a swarm worker that wrote.

A `read-only` lane is not an executor.

The top-level session picks the lane with the `pick` subcommand of `skills/setup-pstack/scripts/setup-pstack.ts` under the installed plugin. It does not choose by reading the row:

```text
node <plugin>/skills/setup-pstack/scripts/setup-pstack.ts pick \
  --parent <claude|codex|grok> \
  --role "<pool role>" \
  [--executor <provider>]...
```

`--parent` makes the parent's native provider an executor. Pass one `--executor` for each other provider that wrote. The script reads the role's row from the parent's sheet, or the role-table default when the sheet has no such row. It drops every entry whose provider is an executor and every alias, because an alias runs on the parent model. It prints the entries that remain as `eligible`, in the operator's order, the first of them as `chosen`, and the dropped entries as `skipped` with the reason. Exit code 1 means that no entry is eligible.

Dispatch `chosen` as written, with its model and its effort, in `read-only` mode. The parent's provider is always an executor, so the chosen lane is always an external lane. If that lane drops out (see **Completion and dropouts**), keep its receipt and dispatch the next entry of `eligible`. This is the dropout policy of a pool, and the one case where another provider follows a dropout: the operator wrote every entry of the row as an accepted choice. After a dropout, never dispatch a model outside the row and never substitute the parent model.

When `eligible` is empty, or every eligible lane dropped out, the pool yields no cross-family lane. The calling skill says what happens then: for `trail reviewer pool` no lane runs, and for `arena cross-judge pool` the arena skill names the fallback. No skill may count a lane on an executor's provider as cross-family.

Name the lane that ran from its receipt, never from what the lane says about itself: `reportedModel` when `modelEvidence` is `provider-report`, and the requested model marked as not confirmed when it is `pinned-argv`.

A subagent does not launch a pool lane. It returns what the lane needs with its report, and the top-level session runs the script and dispatches.

## Native lanes

Native dispatch avoids a second CLI startup and its base context.

- Claude Code: match the descriptor's `(provider, model)` to one model-matrix row, then dispatch it through `pstack-<stem>-<effort>` using that row's Claude-native agent stem and the descriptor's effort. Those definitions select the registered model, requested effort, and `background: true`. Pass the complete task, grounding paths, access mode, and unique output location in the `Agent` prompt. Retain the task handle and drain it only after fan-out.
- Grok Build: match the descriptor to `pstack-<stem>-<effort>` and call `spawn_subagent` with the exact advertised plugin agent name, `background: true`, the complete task, access mode and unique output location. The agent definition carries the model and effort. Use a dedicated worktree for a writer. Drain the returned ID through `get_command_or_subagent_output`. See [grok-tools.md](grok-tools.md) for owners and aliases.
- Codex: call `spawn_agent` with the descriptor's model and `reasoning_effort`, the complete task, grounding paths, access mode, and unique output location. Use an isolated worktree for a writer. Codex subagents already run concurrently.

Do not send a same-provider descriptor to the external runner. It rejects that call because the native route is cheaper and already available.

## External lanes

The launcher lives at `skills/poteto-mode/scripts/runner/pstack-runner` under the installed plugin. The parent writes the complete candidate prompt to a unique file, creates a unique output directory or worktree, and invokes the launcher directly. Do not put another agent in front of it.

```text
pstack-runner \
  --parent <claude|codex|grok> \
  --provider <claude|codex|grok> \
  --model <real CLI model> \
  --effort <low|medium|high|xhigh|max> \
  --mode <read-only|isolated-write> \
  --prompt <unique prompt file> \
  --cwd <repository or dedicated worktree> \
  --output <unique final-response file> \
  --receipt <unique receipt file> \
  [--timeout <seconds>]
```

Pass arguments as an argv array or quote every path. Never interpolate prompt text into a shell command. The launcher preflights the assigned CLI and authentication, invokes the model exactly once, disables recursive agents and ambient skill dispatch where the CLI supports it, restricts the built-in tool surface, and records the exact provider/model/effort flags. The default CLI route does not receive the parent's MCP surface. Keep MCP-dependent Why and Reflect roles on `inherit-parent` or `auto` unless the parent explicitly assigns a supported Grok ACP task below. The launcher never falls back.

### Explicit Grok ACP tasks

A Codex or Claude parent can assign an external Grok lane a task that needs host shell tools, PTY, or T3 preview through `--transport grok-acp --mode full-access`. The parent selects this route explicitly. Environment markers never select it. A Grok parent keeps native `spawn_subagent`. Model sheets and default CLI calls stay unchanged.

```text
pstack-runner --parent codex --provider grok --model grok-4.7 --effort xhigh \
  --transport grok-acp --mode full-access --mcp-config /run/lane/t3.json \
  --prompt /run/lane/prompt.md --cwd /worktrees/lane \
  --output /run/lane/result.md --receipt /run/lane/receipt.json
```

The optional T3 attachment binds endpoint and token references to the parent's assigned preview tab.

```json
{
  "schemaVersion": 1,
  "urlEnv": "PSTACK_T3_MCP_URL",
  "bearerTokenEnv": "T3_MCP_BEARER_TOKEN",
  "previewTabId": "tab_assigned_by_parent"
}
```

The endpoint must use HTTP or HTTPS on loopback without URL credentials, query, or fragment. Any port is allowed. There is no default endpoint and the file contains no literal credential. Invalid configuration or unset references fail before output reservation. The runner resolves the bearer header in memory and removes both referenced variables from the Grok child environment. Each concurrent verifier receives a separate tab, worktree, and output paths. The runner injects the tab assignment into the task and records it in the ACP receipt.

Omit `--mcp-config` for a host-only task. Host access and MCP forwarding are independent choices. ACP runs Grok with sandbox `off` and always-approve. Full access does not confine filesystem writes to `cwd` or exclude Grok's trusted ambient MCP integrations and hooks. The parent sandbox still applies. Forwarding means configured-and-forwarded access, not a strict connector allowlist. Do not use this route for a task that requires enforced read-only access.

The private YAML-list profile disables recursive agents, workflows, schedulers, and web tools. The runner gates the effective catalog before inference and on later changes. Builtins must be exactly `run_terminal_command`, `read_file`, `search_replace`, `list_dir`, and `grep`, plus `search_tool` and `use_tool` with a T3 attachment. Attached MCPs can later expand the catalog with `server__tool` names, such as `t3-code__preview_status`; the receipt records all advertised names, including ambient MCPs. Each namespace segment starts with a letter or digit and contains only letters, digits, underscores, dots, or hyphens. Duplicate or malformed names and additional builtins fail the lane. Host-only tasks admit no MCP tool names. The core shell environment overlay also disables subagents and the child receives `GROK_SUBAGENTS=0`.

ACP initializes protocol 1, authenticates with `cached_token`, creates one session, selects the exact model and effort, and prompts once. Success requires `end_turn`, a nonempty final assistant generation after tool activity, and served-model usage that passes the shared matrix proof. Requested `modelId` is not proof. Cumulative token usage is normalized and cost remains null because the provider's tick unit is unverified.

Conversation success and server exit are separate. `session/close` gets one second of cleanup grace. Its error or expired grace is receipt evidence, while the runner closes stdin and reaps the direct child. A successful conversation can record child exit `143` and `SIGTERM`. The launcher's status still follows the receipt. Cancellation and an explicit launcher deadline remain authoritative through cleanup. ACP receipts add `acp` progress, catalog, attachment, and shutdown evidence. CLI receipt fields stay unchanged.

The existing setup and update probes exercise the default CLI route. ACP touchpoints have empty `coveredBy` entries until an ACP update probe covers them. A change to an uncovered ACP contract holds the CLI update. The parent must retain production-runner evidence for the actual host and preview task.

Grok authentication preflight has one bounded retry. If the first `grok models` result would be classified as unauthenticated, the runner waits five seconds and tries the same preflight once more. A second failure is terminal. The delay and second attempt share the runner's absolute deadline and cancellation latch, and the receipt keeps evidence from both attempts. Model execution is never retried.

CLI versions change only through the `update-clis` skill (the weekly `pstack-vic-cli-updates` routine, or `/pstack:update-clis` by hand). It reads each release's notes against [`cli-touchpoints.json`](../../update-clis/references/cli-touchpoints.json), installs the new version, and runs these lanes through the launcher before it keeps the version; otherwise it rolls back and holds the version in Linear. Grok keeps `auto_update = false` and the npm `claude` keeps `DISABLE_AUTOUPDATER=1` for that reason. A change to how the launcher uses a CLI (a flag, a parsed event, a sandbox assumption) updates that list in the same change: `update-clis.test.ts` fails when a flag the launcher generates is named in no contract, or when a pointer loses its anchor.

The parent tool sandbox still governs whether a subscribed child CLI can reach its credentials and network. Run setup's live probe from the actual parent profile. A blocked external CLI is a loud dropout, not a reason to elevate permissions or substitute a model silently.

The parent invocation must itself be resumable background work:

- Claude Code: call the launcher through a Bash tool invocation with `run_in_background: true` and retain its task ID. A foreground Bash tool call has an automatic ten-minute ceiling even when the runner's own timeout is longer. Shelling out with `&` and losing the task handle is not equivalent.
- Grok Build: use the shell tool with `block_until_ms: 0`, retain the task ID, and wait through `get_command_or_subagent_output`.
- Codex: run the launcher in a persistent exec session that returns a session ID, then wait or poll that handle. Do not hold one foreground tool call open for the model's full runtime.

Start the background process, continue launching the other lanes, then drain their handles. Native and external lanes belong in the same fan-out phase. Draining is the parent's job in every harness mode: in an interactive session a finished background task wakes the parent, but a non-interactive parent (`claude -p`, `codex exec`, a Grok headless prompt) is never woken, and a turn that ends "waiting for the lanes" ends the session and cancels every running lane (receipts come back `cancelled`, measured 2026-09-18). There, block on each handle (`TaskOutput` with `block`, `wait_agent`, the exec session wait, Grok's output tool) until every lane has its receipt or result before judging.

The runner and its preflight have no implicit timeout. Do not invent a duration from role, mode, or a convenient round number; real implementation lanes can run for 90 minutes or much longer. Pass `--timeout` only when the user, an external service deadline, or a measured task contract supplies a real bound. That value starts at wrapper entry, before module loading and argument parsing, and remains one absolute deadline across setup, preflight, model execution, and output capture. It is never a fresh allowance per child, and long waits are armed in runtime-safe chunks without shortening the supplied deadline. Otherwise supervise liveness through the retained background task/session handle and cancel manually only on evidence that the run is dead. In an autopilot program the owner's `children.tsv` expected runtime (at least the longest past run of that kind; for a runner lane with no past run, the receipts of earlier programs or the standing orders) is the measured task contract: a lane past it with no side effect is stuck per the playbook, and the cancel goes through the retained handle. Cancel through that retained handle so the runner receives SIGINT or SIGTERM, sends it to an active child when one remains, stops waiting on inherited output pipes, removes the empty output reservation, and writes a `cancelled` receipt. Preserve that receipt; a retry is a new attempt with new unique output and receipt paths. Unchanged running state is not a dropout, and Claude's ten-minute foreground ceiling is never a reason to terminate a healthy lane.

Read-only mode maps to Claude plan mode with project-only settings and an explicit tool list, Codex's read-only sandbox, and Grok's `read-only` sandbox with a read-oriented tool list. Grok's built-in read-only profile deliberately keeps its own state and system temporary directories writable, so point a read-only Grok lane at the actual checkout rather than a worktree under `/tmp`, `/var/tmp`, or the host's temporary directory. `isolated-write` maps to Claude `acceptEdits` with project-only settings, Codex `workspace-write`, and Grok's `workspace` sandbox with a write-capable tool list. Grok lanes run in always-approve (`--permission-mode bypassPermissions`) in every mode: Grok's permission engine prompts for shell segments its heuristics do not clear, a headless prompt cancels the whole turn in every other mode (`acceptEdits`, `plan` and `dontAsk` were all measured on 2026-09-18, and the trigger is repo-dependent), and Grok's own docs send unattended automation to always-approve. A lane cannot answer a prompt, so confinement is the sandbox's job, never the prompt's. Give every writer only a dedicated worktree or output directory. Never route a writer into the primary checkout.

Grok's `read-only` and `workspace` profiles bound a lane harder than the profile table says. On macOS the embedded Seatbelt profile grants no write on `/dev`, no IOKit and no `mach-register`, so a sandboxed lane cannot open a pseudo-terminal (tmux: `create window failed: fork failed`), cannot start Playwright's Chromium (`SIGSEGV` at launch), and cannot commit in a linked worktree, because `.git/worktrees/<name>/index.lock` lives in the primary checkout's `.git` (measured 2026-09-25 with Grok CLI 1.0.41 and again 2026-10-02 with 1.0.46, whose macOS backend became `sandbox-exec` in 1.0.44). A lane that must commit hands its diff to the parent, which commits on its own branch. The same argv with `--sandbox off` passes all three, so a harness that launches Grok without a sandbox, such as T3 Code (`grok agent --always-approve stdio`, no `--sandbox`, in every permission mode), sees none of these limits. The default CLI route retains its bounded modes. Its `--tools` list keeps the CLI's configured MCP servers out of the lane. The [explicit full-access ACP route](#explicit-grok-acp-tasks) has a different access grant.

A Codex parent runs the launcher inside its own seatbelt and exports `CODEX_SANDBOX` to it. Grok cannot initialise a nested seatbelt profile there and refuses to start, so when the launcher sees that marker it hands Grok the built-in `none` profile and the outer Codex sandbox governs the lane; plan mode, the tool list, and `--no-subagents` still apply, and the receipt `argv` records the profile used. Grok also writes its session under `~/.grok`, which that seatbelt blocks, so a Codex parent needs `sandbox_workspace_write.network_access = true` and `~/.grok` in `sandbox_workspace_write.writable_roots` (in `~/.codex/config.toml`, or per session with `-c`); without them the Grok lane is a receipt-bearing dropout (`unavailable-model`, `FS_PERMISSION_DENIED`). Claude lanes start normally inside that seatbelt (measured with Codex 0.154.0, Grok CLI 1.0.5, Claude Code 2.1.273).

Every Grok lane, in every mode, runs under an environment policy, because Grok's sandbox limits what a lane writes and not what its shell inherits. Without the policy, a lane's shell saw every variable of the parent, credentials included (N27, measured 2026-09-25 with Grok CLI 1.0.41). For the life of the model child, the launcher writes a config overlay, `[shell_environment_policy]` with `inherit = "core"`, into a temporary directory that it creates, and passes the file as `GROK_CONFIG_PATH`. It removes `GROK_CONFIG` from the child's environment, because an inline value wins over the file. Afterwards it deletes the directory. `~/.grok/config.toml` does not change. The policy cuts what Grok passes to the lane's shell down to a small platform set such as `PATH` and `HOME`. It cannot cut what the shell's own startup files export: zsh reads `~/.zshenv` again for every command. On a machine that exports credentials from `~/.zshenv`, skip those exports when `GROK_AGENT` is set, which Grok sets in the shell it opens for a lane:

```zsh
if [[ -z $GROK_AGENT ]]; then
  export EXAMPLE_API_KEY=...
fi
```

With both in place, a control lane in each mode saw 37 variable names and none with `TOKEN`, `KEY` or `SECRET` in it, and `node`, `npm` and `git` still ran. The guard depends on `GROK_AGENT`, which Grok's documentation does not promise; the `grok.env-policy` entry of `skills/update-clis/references/cli-touchpoints.json` watches it.

Every concurrent external lane needs distinct prompt, output, and receipt paths. The launcher reserves output and receipt paths exclusively and refuses to overwrite them.

## Completion and dropouts

Success requires all of these:

1. Exit status `0`.
2. Receipt status `complete`.
3. Either `modelVerified: true` with `modelEvidence: "provider-report"`, or a Codex receipt with `reportedModel: null`, `modelVerified: false`, and `modelEvidence: "pinned-argv"`. Claude's provider report must match the family's `reportedModel` pattern; Opus must report `claude-opus-5-5`. Codex 0.154.0 accepts the exact `--model` argument but does not report the served model in its `--json` stream (measured 2026-09-17 with `gpt-6-astra`).
4. A non-empty output file.

The receipt also carries elapsed time, token usage when the CLI exposes it, and cost when available. Keep it with the arena or review artifacts so parent-harness comparisons are evidence-based.

Any missing CLI, failed login, unavailable model, explicit timeout, cancellation, catchable post-reservation launcher failure, non-zero CLI child exit, malformed result, or model mismatch is a receipt-bearing dropout. Record it and apply the calling skill's existing dropout policy. For a pool role, that policy is the next eligible entry of the row (see **Cross-family selection**). A `cancelled` receipt proves that the runner received the signal; its `signal` field is non-null only when the runner sent that signal to a still-active direct CLI child, and remains null when cancellation only stopped a post-exit pipe drain. The provider CLI owns any processes it starts beneath that direct child; the receipt does not claim a process-tree kill. Do not delete or overwrite the receipt. Never substitute the parent model, retry another provider outside that pool policy, or reinterpret an external descriptor as a native model slug.

Start native and external lanes in the same fan-out phase, then wait for all of them before judging. A judge must not read candidate paths while their owners are still writing.
