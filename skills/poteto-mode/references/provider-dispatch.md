# Provider dispatch

pstack model choices are provider-qualified descriptors:

```text
<provider>:<model>@<effort>
```

## Model matrix

The matrix lives in [`model-matrix.json`](../../../model-matrix.json) at the plugin root. The block below is rendered from it by `scripts/render-model-matrix.ts`; edit the JSON, not the table.

<!-- model-matrix:begin -->

| Family | Provider | Model | Default effort | Selectable efforts | Native in | Claude-native agent stem | Replaces (Cursor 0.15.2) |
|---|---|---|---|---|---|---|---|
| fable | claude | `fable` | max | low medium high xhigh max | claude | `fable` | `claude-fable-5-1-thinking-{effort}` |
| opus | claude | `opus` | xhigh | low medium high xhigh max | claude | `opus` | `claude-opus-5-thinking-{effort}` |
| sol | codex | `gpt-5.6-sol` | max | low medium high xhigh max | codex | - | `gpt-5.6-sol-{effort}` |
| astra | codex | `gpt-6-astra` | max | low medium high xhigh max | codex | - | - |
| grok | grok | `grok-4.6` | xhigh | low medium high xhigh max | - | - | `grok-4.6-fast-{effort}` |
| cursor-grok | cursor | `grok-4.6` | high | low high xhigh | - | - | - |
| composer | cursor | `composer-2.5` | high | high | - | - | - |
| kimi | cursor | `kimi-k3` | high | low high | - | - | - |
| glm | cursor | `glm-5.2` | high | high | - | - | - |
| gemini-pro | cursor | `gemini-3.1-pro` | high | high | - | - | - |
| muse | cursor | `muse-spark-1.3` | high | low high xhigh | - | - | - |

The allowed effort universe is exactly `low`, `medium`, `high`, `xhigh`, `max`. First-run requested efforts are the Default effort cell of each row. A Claude-native agent stem of `-` means the family has no Claude-native agent. Otherwise the shipped agent name is `pstack-<stem>-<effort>`. Aliases `inherit-parent` and `auto` are not families and carry no effort.

### Route table

| Parent | `claude:*` | `codex:*` | `cursor:*` | `grok:*` |
|---|---|---|---|---|
| Claude Code | native `Agent` | external runner | external runner | external runner |
| Codex | external runner | native `spawn_agent` | external runner | external runner |

<!-- model-matrix:end -->

`fable` and `opus` are Claude Code's rolling aliases. Claude resolves each alias to the latest available family revision. A runner receipt keeps the requested alias in `model` and the concrete provider-reported revision in `reportedModel`; verification accepts only a report matching that family's `reportedModel` pattern in the matrix (a numeric `claude-fable-*` or `claude-opus-*` revision).

Grok Build CLI 1.0.5 reports the served model as `grok-4.6-build` in the result event's `modelUsage` (measured 2026-09-17); the grok family's `reportedModel` pattern accepts that build suffix and nothing else.

`sol` and `astra` share the `codex` CLI, its flags, and its output parser. They differ only in the `--model` argument. Codex also exposes an `ultra` effort that delegates tasks automatically; it is outside the effort universe because a pstack child never delegates.

## Role defaults

Skills name roles by the labels below, the same labels `/setup-pstack` writes to the model sheet (`~/.claude/pstack-models.md` on Claude Code, `~/.codex/pstack-models.md` on Codex). A sheet line overrides the default of its role. Without a sheet, a role takes its cell for the current parent. The block is rendered from `model-matrix.json`; edit the JSON, not the table.

<!-- role-defaults:begin -->

| Role | What the lane does | Claude Code parent | Codex parent |
|---|---|---|---|
| `feature, refactoring` | Writes the code of a feature or a behavior-preserving refactor in its own worktree; the parent reviews the diff. | `grok:grok-4.6@xhigh` | `grok:grok-4.6@xhigh` |
| `bug-fix` | Reproduces a reported defect, finds the root cause, and writes the fix with runtime evidence. | `grok:grok-4.6@xhigh` | `grok:grok-4.6@xhigh` |
| `perf-issue` | Traces a measured slowness against a baseline and implements the improvement. | `grok:grok-4.6@xhigh` | `grok:grok-4.6@xhigh` |
| `hillclimb` | Iterates hypotheses on one metric with before/after measurements, one commit per accepted win. | `grok:grok-4.6@xhigh` | `grok:grok-4.6@xhigh` |
| `judgment and prose` | Writes and judges prose: docs, PR descriptions, summaries, explanations, syntheses. | `claude:fable@max` | `codex:gpt-6-astra@max` |
| `hardest tasks` | Implements the hardest changes: cross-cutting design, subtle concurrency or algorithms, vague intent, or a precise multi-step sequence. | `claude:fable@max` | `codex:gpt-6-astra@max` |
| `how explorer` | Reads a subsystem in read-only mode and reports how it works, with file and line evidence. | `grok:grok-4.6@xhigh` | `grok:grok-4.6@xhigh` |
| `how explainer` | Turns the explorers' findings into the explanation the how skill delivers. | `claude:fable@max` | `codex:gpt-6-astra@max` |
| `why investigators` | Investigate why something was built this way across git history, tickets, and the parent's MCP sources; needs the parent's MCPs, so it stays on an alias. | `inherit-parent` | `inherit-parent` |
| `why synthesizer` | Merges the why investigators' findings into one answer; same MCP constraint, stays on an alias. | `inherit-parent` | `inherit-parent` |
| `reflect tooling` | Reads transcripts and skills to find lessons after a long task with the parent's tools; stays on an alias for the MCP reason. | `inherit-parent` | `inherit-parent` |
| `reflect judgment, divergent, synthesizer` | Judges, dissents on, and synthesizes the lessons the reflect skill captures; stays on an alias for the MCP reason. | `inherit-parent` | `inherit-parent` |
| `arena runners` | Each lane attempts the same task in parallel; the arena picks a base and grafts the strongest parts of the others. One lane per entry. | `claude:fable@max`, `codex:gpt-6-astra@max`, `grok:grok-4.6@xhigh`, `claude:opus@xhigh` | `claude:fable@max`, `codex:gpt-6-astra@max`, `grok:grok-4.6@xhigh`, `claude:opus@xhigh` |
| `arena cross-judge pool` | Judges the arena candidates; the arena picks a provider different from the parent and the base candidate when possible. | `claude:fable@max`, `codex:gpt-6-astra@max`, `grok:grok-4.6@xhigh`, `claude:opus@xhigh` | `claude:fable@max`, `codex:gpt-6-astra@max`, `grok:grok-4.6@xhigh`, `claude:opus@xhigh` |
| `swarm workers` | Default worker for every swarm lane: coverage matrices, races, gauntlets, exploration partitions. | `grok:grok-4.6@xhigh` | `grok:grok-4.6@xhigh` |
| `architect runners` | Each lane proposes a design (types, module shape) for the same problem before implementation. One lane per entry. | `claude:fable@max`, `codex:gpt-6-astra@max`, `grok:grok-4.6@xhigh`, `claude:opus@xhigh` | `claude:fable@max`, `codex:gpt-6-astra@max`, `grok:grok-4.6@xhigh`, `claude:opus@xhigh` |
| `interrogate reviewers` | Each lane reviews the diff adversarially from its own angle; a different provider per lane widens the blind spots covered. | `claude:fable@max`, `codex:gpt-6-astra@max`, `grok:grok-4.6@xhigh`, `claude:opus@xhigh` | `claude:fable@max`, `codex:gpt-6-astra@max`, `grok:grok-4.6@xhigh`, `claude:opus@xhigh` |
| `pr verifier` | Runs the gates and the live lane of a ready PR and reconciles evidence against claims; never writes code. | `cursor:composer-2.5@high` | `cursor:composer-2.5@high` |
| `pr reviewer` | Reads the base-to-head diff of a PR that touches an irreversible or contained class and reports regressions with a failure scenario and file and line. | `cursor:grok-4.6@high` | `cursor:grok-4.6@high` |
| `pr fixer, simple` | Repairs one named cause of a single file, a lint or type failure, or a confirmed finding with a concrete disproof, in the PR branch. | `cursor:composer-2.5@high` | `cursor:composer-2.5@high` |
| `pr fixer, complex` | Repairs a cross-file or behavior-changing cause in the PR branch; the second and last attempt. | `cursor:grok-4.6@xhigh` | `cursor:grok-4.6@xhigh` |
| `pr diagnosis pool` | Read-only diagnosers that each name the root cause of a failed fix with evidence; two that agree decide. | `cursor:muse-spark-1.3@high`, `cursor:glm-5.2@high`, `cursor:gemini-3.1-pro@high`, `cursor:kimi-k3@high` | `cursor:muse-spark-1.3@high`, `cursor:glm-5.2@high`, `cursor:gemini-3.1-pro@high`, `cursor:kimi-k3@high` |

A list is a panel: one lane per entry, in this order. A role whose two columns differ takes the parent's native frontier family. Aliases run on the parent model through its native subagent primitive.

<!-- role-defaults:end -->

A lane's effort is its own. Two roles, or two lanes of one panel, may name the same family at different efforts (`bug-fix: codex:gpt-5.6-sol@xhigh` next to `hillclimb: codex:gpt-5.6-sol@high`). The parent dispatches each descriptor as written, through the agent or runner flags of that effort, and `/setup-pstack` probes each distinct family-and-effort pair the sheet uses. A family has no effort of its own; the Default effort column above seeds first-run lanes only.

## Read-time normalization

Normalize configured descriptors before matching them to the matrix or choosing a route. If a provider-qualified Claude model starts with `claude-fable-` or `claude-opus-` and its remaining revision contains only digits and hyphens, replace that model component in memory with `fable` or `opus`. Preserve provider, effort, role, and lane order. Use only the normalized descriptor for native dispatch or runner argv. Never pass the versioned predecessor to Claude.

This read-time rule makes an older installed sheet use the latest family revision immediately without writing user files. Once per parent run, report that the persisted sheet is stale and that `/setup-pstack` will rewrite it after its normal probes and confirmation. Unknown versioned Claude models remain invalid. The external runner rejects a missed Fable or Opus version pin instead of silently executing it.

`fast` is part of Cursor's Grok selector, not a Grok Build CLI model or effort flag. The portable Grok route pins the current CLI model `grok-4.6`. The first-run Grok effort is `xhigh`.

## The parent owns the route

The top-level harness resolves the route once. A child receives an assigned provider, model, effort, access mode, prompt, working directory, and output path. A child never detects the harness, chooses a provider, or launches another model. Environment markers may corroborate the top-level harness before fan-out, but nested processes inherit parent markers and must not use them for routing.

The route table is the one rendered above from `model-matrix.json`: a provider is native in exactly one parent and goes through the external runner everywhere else.

`inherit-parent` and `auto` remain aliases. They use the parent's current model and effort through its native subagent primitive. In a panel they still consume one lane, but they reduce provider diversity; say so in the synthesis record.

## Native lanes

Native dispatch avoids a second CLI startup and its base context.

- Claude Code: match the descriptor's `(provider, model)` to one model-matrix row, then dispatch it through `pstack-<stem>-<effort>` using that row's Claude-native agent stem and the descriptor's effort. Those definitions select the rolling model alias, requested effort, and `background: true`. Pass the complete task, grounding paths, access mode, and unique output location in the `Agent` prompt. Retain the task handle and drain it only after fan-out.
- Codex: call `spawn_agent` with the descriptor's model and `reasoning_effort`, the complete task, grounding paths, access mode, and unique output location. Use an isolated worktree for a writer. Codex subagents already run concurrently.

Do not send a same-provider descriptor to the external runner. It rejects that call because the native route is cheaper and already available.

## External lanes

The launcher lives at `skills/poteto-mode/scripts/runner/pstack-runner` under the installed plugin. The parent writes the complete candidate prompt to a unique file, creates a unique output directory or worktree, and invokes the launcher directly. Do not put another agent in front of it.

```text
pstack-runner \
  --parent <claude|codex> \
  --provider <claude|codex|cursor|grok> \
  --model <real CLI model> \
  --effort <low|medium|high|xhigh|max> \
  --mode <read-only|isolated-write> \
  --prompt <unique prompt file> \
  --cwd <repository or dedicated worktree> \
  --output <unique final-response file> \
  --receipt <unique receipt file> \
  [--timeout <seconds>] \
  [--repo <owner/name> --pr <number>]
```

Pass arguments as an argv array or quote every path. Never interpolate prompt text into a shell command. The launcher preflights the assigned CLI and authentication, invokes the model exactly once, disables recursive agents and ambient skill dispatch where the CLI supports it, restricts the built-in tool surface, and records the exact provider/model/effort flags. External lanes do not receive the parent's MCP surface. Keep MCP-dependent Why and Reflect roles on `inherit-parent` or `auto`. The launcher never falls back.

Grok authentication preflight has one bounded retry. If the first `grok models` result would be classified as unauthenticated, the runner waits five seconds and tries the same preflight once more. A second failure is terminal. The delay and second attempt share the runner's absolute deadline and cancellation latch, and the receipt keeps evidence from both attempts. Model execution is never retried.

## HTTP lanes

A provider whose matrix row says `transport: "http"` has no CLI binary. Today that is `cursor`, the Cursor cloud agents API. The generated family table above lists every `cursor` family. The launcher reaches it from `skills/poteto-mode/scripts/runner/http-lane.ts` and shares everything else with a CLI lane: the exclusive output and receipt reservation, the one absolute deadline, the SIGINT and SIGTERM latch, receipt writing, and `modelProof`.

An http lane needs `--repo <owner/name>` and `--pr <number>`, the GitHub pull request the cloud agent works on. A CLI lane refuses both flags. `CURSOR_API_KEY` must be in the launcher's environment. Without it the lane exits 69 with an `unavailable-cli` receipt whose message is `CURSOR_API_KEY is not set`, the same dropout shape as a missing binary.

The lane runs in this order. Preflight is `GET /v1/models` with Basic auth from the key. A 401 or 403 is `unauthenticated`. A model id absent from the inventory is `unavailable-model`, with the inventory ids in the error evidence. The launch request sends the params of the model's variant whose `effort` is the requested effort, when the model lists an `effort` parameter (`grok-4.6` does, `composer-2.5` does not), and whose `fast` is `false`, when the model lists a `fast` parameter. The API refuses params that match no variant, and `grok-4.6` and `composer-2.5` default to the `fast` variant (measured 2026-09-21), so the launcher never sends `fast: true`. This measurement does not cover the other Cursor families. Launch is `POST /v1/agents` with the prompt file's text, `workOnCurrentBranch: true`, and `autoCreatePR: false`. Poll is `GET /v1/agents/{id}/runs/{runId}` every 30 seconds until `FINISHED`, `ERROR`, `CANCELLED`, or `EXPIRED`. `FINISHED` writes the run's `result` to `--output`. `ERROR` and `EXPIRED` are `child-failed`. A `CANCELLED` the launcher did not request is `child-failed` too, because a `cancelled` receipt promises that this launcher received a signal or reached its deadline.

When the deadline or the latch fires after launch, the launcher writes a `cancelled` receipt. Unless a terminal API status was already observed, it sends `POST /v1/agents/{id}/runs/{runId}/cancel` once. Five consecutive poll failures, an unknown status, or an unexpected polling error also trigger that cleanup, while preserving the original failure. The cancel request has an independent ten-second budget. Its acknowledgement confirms acceptance of the request, not that the run stopped. Cancellation during final head verification still produces a `cancelled` receipt and no output, without cancelling a run already known to be terminal. Before launch, a deadline is `timed-out` and a signal is `cancelled`, as on a CLI lane.

The receipt keeps `schemaVersion: 1`. On an http lane `executable`, `exitCode`, and `signal` are null, `preflight.argv` is `["GET", "/v1/models"]`, and `argv` starts with `["POST", "/v1/agents", "<model id>", "<effort>"]`. A cancel request is appended after those four, and `error.evidence` records its result. `remote` carries `agentId`, `runId`, `agentUrl`, and `heads`. The `heads` record is `{ kind: "not-taken" }` before a comparison, `{ kind: "unverified", reason }` when a snapshot fails, or `{ kind: "observed", changedBranches }` after two successful snapshots. On a CLI lane `remote` is null. The Cursor API reports no served model, so a complete http receipt has `reportedModel: null` and `modelEvidence: "pinned-argv"`, like Codex.

Read-only verification happens after the fact. The prompt carries the read-only clause, and the launcher snapshots the repository's remote heads with `git ls-remote --heads` before launch and after a `FINISHED` run. New, moved, and deleted heads appear in the sorted `remote.heads.changedBranches` list in both modes. The snapshots cannot attribute those changes to this run. Another actor's push, even to the same branch, makes read-only verification fail closed with `child-failed` and `could not verify read-only execution: remote heads changed: <branches>`. A failed snapshot produces `child-failed` with `could not verify read-only execution: remote head snapshot unavailable`. Isolated-write may complete while recording the same observation or snapshot failure. Unchanged snapshots show no observed head changes; they cannot detect a write that was restored between snapshots or changes outside branch heads. The run body's `git.branches[]` names the working branch even without a push (measured 2026-09-21), so the launcher does not use it for attribution.

Three environment variables exist for tests: `PSTACK_CURSOR_BASE_URL` points the client at a fake server and is honored only when the host is loopback, and `PSTACK_CURSOR_POLL_MS` and `PSTACK_CURSOR_GIT_REMOTE` shorten the poll interval and redirect the `ls-remote` snapshots only alongside an accepted override. A non-loopback override is ignored.

The parent tool sandbox still governs whether a subscribed child CLI can reach its credentials and network. Run setup's live probe from the actual parent profile. A blocked external CLI is a loud dropout, not a reason to elevate permissions or substitute a model silently.

The parent invocation must itself be resumable background work:

- Claude Code: call the launcher through a Bash tool invocation with `run_in_background: true` and retain its task ID. A foreground Bash tool call has an automatic ten-minute ceiling even when the runner's own timeout is longer. Shelling out with `&` and losing the task handle is not equivalent.
- Codex: run the launcher in a persistent exec session that returns a session ID, then wait or poll that handle. Do not hold one foreground tool call open for the model's full runtime.

Start the background process, continue launching the other lanes, then drain their handles. Native and external lanes belong in the same fan-out phase. Draining is the parent's job in every harness mode: in an interactive session a finished background task wakes the parent, but a non-interactive parent (`claude -p`, `codex exec`) is never woken, and a turn that ends "waiting for the lanes" ends the session and cancels every running lane (receipts come back `cancelled`, measured 2026-09-18). There, block on each handle (`TaskOutput` with `block`, `wait_agent`, the exec session wait) until every lane has its receipt or result before judging.

The runner and its preflight have no implicit timeout. Do not invent a duration from role, mode, or a convenient round number; real implementation lanes can run for 90 minutes or much longer. Pass `--timeout` only when the user, an external service deadline, or a measured task contract supplies a real bound. That value starts at wrapper entry, before module loading and argument parsing, and remains one absolute deadline across setup, preflight, model execution, and output capture. It is never a fresh allowance per child, and long waits are armed in runtime-safe chunks without shortening the supplied deadline. Otherwise supervise liveness through the retained background task/session handle and cancel manually only on evidence that the run is dead. Cancel through that retained handle so the runner receives SIGINT or SIGTERM, sends it to an active child when one remains, stops waiting on inherited output pipes, removes the empty output reservation, and writes a `cancelled` receipt. Preserve that receipt; a retry is a new attempt with new unique output and receipt paths. Unchanged running state is not a dropout, and Claude's ten-minute foreground ceiling is never a reason to terminate a healthy lane.

Read-only mode maps to Claude plan mode with project-only settings and an explicit tool list, Codex's read-only sandbox, and Grok's `read-only` sandbox with a read-oriented tool list. Grok's built-in read-only profile deliberately keeps its own state and system temporary directories writable, so point a read-only Grok lane at the actual checkout rather than a worktree under `/tmp`, `/var/tmp`, or the host's temporary directory. `isolated-write` maps to Claude `acceptEdits` with project-only settings, Codex `workspace-write`, and Grok's `workspace` sandbox with a write-capable tool list. Grok lanes run in always-approve (`--permission-mode bypassPermissions`) in both modes: Grok's permission engine prompts for shell segments its heuristics do not clear, a headless prompt cancels the whole turn in every other mode (`acceptEdits`, `plan` and `dontAsk` were all measured on 2026-09-18, and the trigger is repo-dependent), and Grok's own docs send unattended automation to always-approve. A lane cannot answer a prompt, so confinement is the sandbox's job, never the prompt's. Give every writer only a dedicated worktree or output directory. Never route a writer into the primary checkout.

A Codex parent runs the launcher inside its own seatbelt and exports `CODEX_SANDBOX` to it. Grok cannot initialise a nested seatbelt profile there and refuses to start, so when the launcher sees that marker it hands Grok the built-in `none` profile and the outer Codex sandbox governs the lane; plan mode, the tool list, and `--no-subagents` still apply, and the receipt `argv` records the profile used. Grok also writes its session under `~/.grok`, which that seatbelt blocks, so a Codex parent needs `sandbox_workspace_write.network_access = true` and `~/.grok` in `sandbox_workspace_write.writable_roots` (in `~/.codex/config.toml`, or per session with `-c`); without them the Grok lane is a receipt-bearing dropout (`unavailable-model`, `FS_PERMISSION_DENIED`). Claude lanes start normally inside that seatbelt (measured with Codex 0.154.0, Grok CLI 1.0.5, Claude Code 2.1.273).

Every concurrent external lane needs distinct prompt, output, and receipt paths. The launcher reserves output and receipt paths exclusively and refuses to overwrite them.

## Completion and dropouts

Success requires all of these:

1. Exit status `0`.
2. Receipt status `complete`.
3. Either `modelVerified: true` with `modelEvidence: "provider-report"`, or a Codex or Cursor receipt with `reportedModel: null`, `modelVerified: false`, and `modelEvidence: "pinned-argv"`. For Claude's `fable` and `opus` aliases, the concrete provider report must match the family's `reportedModel` pattern. Codex 0.154.0 accepts the exact `--model` argument but does not report the served model in its `--json` stream (measured 2026-09-17 with `gpt-6-astra`). The Cursor cloud agents API reports no served model either (measured 2026-09-21), so its families pin by argv the same way.
4. A non-empty output file.

The receipt also carries elapsed time, token usage when the CLI exposes it, and cost when available. Keep it with the arena or review artifacts so parent-harness comparisons are evidence-based.

Any missing CLI, failed login, unavailable model, explicit timeout, cancellation, catchable post-reservation launcher failure, non-zero child exit, malformed result, or model mismatch is a receipt-bearing dropout. Record it and apply the calling skill's existing dropout policy. A `cancelled` receipt proves that the runner received the signal; its `signal` field is non-null only when the runner sent that signal to a still-active direct CLI child, and remains null when cancellation only stopped a post-exit pipe drain. The provider CLI owns any processes it starts beneath that direct child; the receipt does not claim a process-tree kill. Do not delete or overwrite the receipt. Never substitute the parent model, retry another provider, or reinterpret an external descriptor as a native model slug.

Start native and external lanes in the same fan-out phase, then wait for all of them before judging. A judge must not read candidate paths while their owners are still writing.
