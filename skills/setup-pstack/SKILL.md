---
name: setup-pstack
description: Configure pstack's provider-qualified models, per-lane requested effort, and parent-owned routes per role. Verifies every distinct family-and-effort pair on native Claude and Codex lanes, external CLI lanes, and Cursor cloud lanes before writing the override sheet. Use for /setup-pstack, "configure pstack models", or changing pstack's model choices.
---

# Setup pstack

Configure one portable model sheet for the current parent harness. Read [`provider-dispatch.md`](../poteto-mode/references/provider-dispatch.md) before probing or writing anything. Its model matrix, descriptor grammar, route table, and role defaults are the contract. Each lane carries its own effort, so two roles may run the same family at different efforts. Do not add a second configuration file, a runtime resolver, or a weaker-model fallback.

The deterministic half of this skill is `scripts/setup-pstack.ts`, next to this file (Node 24, no dependencies; run it as `node <this skill's directory>/scripts/setup-pstack.ts <subcommand>`). It reads the matrix, reads and normalizes the current sheet, renders the new one, runs the external probes through the runner, refuses to write while any probe is missing, and writes with snapshot, read-back, and restore. You own the conversation (parent, efforts, role changes, confirmation) and the native one-turn probes. Every subcommand prints JSON; `--help` prints the usage. Never edit the sheet or the integration files by hand, and never paste a rendered sheet as the result.

Claude Code writes `~/.claude/pstack-models.md` and loads it from `~/.claude/CLAUDE.md` with:

```text
@~/.claude/pstack-models.md
```

Codex writes `~/.codex/pstack-models.md`. Codex has no `@` include, so the script mirrors the sheet's exact bytes inside one bounded block in `~/.codex/AGENTS.md` and keeps the sheet as the editable source of truth:

```text
<!-- pstack:models:begin -->
<exact contents of ~/.codex/pstack-models.md>
<!-- pstack:models:end -->
```

## Steps

### 1. Establish the parent

Use the harness and tool surface running this skill: Claude Code (`--parent claude`) or Codex (`--parent codex`). Environment markers may corroborate that top-level answer, but do not launch a child and ask it to detect where it came from. Record the parent because the same descriptor takes a different route in each harness.

### 2. Load current state

```shell
node scripts/setup-pstack.ts state --parent <parent>
```

The JSON says whether the parent's sheet exists (`exists`), its path, the normalized rows, the rolling-alias `migrations` it applied in memory (a provider-qualified Claude model whose component starts with `claude-fable-` or `claude-opus-` followed by digits and hyphens becomes `fable` or `opus`, preserving provider, effort, role, and lane order), and one `efforts` entry per matrix family with its `status`, the distinct `efforts` in use, and the `rows` that use them. A family's status is `current` (every lane of the family shares one effort), `mixed` (its lanes use two or more efforts; a valid sheet, not a conflict), `unassigned` (first run: the matrix Default effort is proposed), or `outside-map` (no role uses the family, so no effort can persist for it; Sol is outside the first-run map by the 2026-09-17 decision).

The script stops on inconsistent state: an unknown or duplicate role row, a bare host-native slug, a versioned Claude model outside the two migration families, a provider/model pair outside the matrix, or an effort outside the family's Selectable efforts. Show the error verbatim and resolve it with the operator before going on. Do not probe or write while any inconsistency is unresolved.

### 3. Show the map as a table, then ask only for the roles that change

Show the whole map as one markdown table, one row per role in matrix order, with three columns: the role, what the lane does (the role's `description` from `model-matrix.json`, the "What the lane does" column of the role table in `provider-dispatch.md`), and the current lanes (the loaded rows on a rerun, the first-run map below on a first run; a migrated descriptor shows normalized, with the original from step 2 noted under the table). Below the table, one line with the `outside-map` families and one line with the families available on this parent and their route (native or external runner). Never offer a reset of a customized sheet to the first-run assignments.

Then one `AskUserQuestion` with a single question: keep the map as shown, or change roles. Options are "Keep everything" first (the default, and the recommended answer on a rerun), then "Change roles", with "Other" for the operator to type the changes directly, one per line as `<role>: <lane>[, <lane>]`, or a family-wide move such as "all grok to xhigh". A typed line that names a role and its lanes is a complete answer for that role; do not ask about it again.

When the operator chose "Change roles" without typing lanes, ask which roles in one question (`multiSelect`, the roles as options in matrix order, four per call when they do not fit, "Other" for labels typed by name). Then, only for the roles named without lanes, one `AskUserQuestion` call per role with two questions in this order. Both questions carry the role's `description` so the operator knows what the lane does before choosing. Roles the operator did not name are never asked about.

1. **Model.** Options are the current value first, labeled "(keep)", then three more in this order until four options are filled: the role's matrix default for this parent when it differs from the current value, then the remaining families in matrix order, then `inherit-parent` and `auto`. Each family option names its model and its route for this parent (native or external runner). The families and aliases that did not fit are typed under "Other" by family name. For a role whose lane is an alias, the options are the current alias first, then the other alias, then families in matrix order.
2. **Effort.** Options are the current effort first, labeled "(keep)", then the family's remaining Selectable efforts in matrix order, dropping `low` when it is not current; the dropped one is typed under "Other". Say in the question that the effort is ignored when the model answer is an alias. Empty input keeps the current lanes; on a first run it accepts the matrix proposal.

A panel role (a list) gets one question instead of two: the current lanes as the "(keep)" option, the parent's matrix default panel when it differs, and "Other" for a typed list of descriptors, one per lane, in the order they should run. Explain that one lane runs per entry and that the list length is the fan-out count.

Each lane keeps the effort written in its descriptor, so `bug-fix: codex:gpt-5.6-sol@xhigh` next to `hillclimb: codex:gpt-5.6-sol@high` is a valid map; there is no per-family effort question. A role that brings a family into the map carries that family's effort in its answer. Why and Reflect roles need the parent's live MCP surface, so recommend `inherit-parent` or `auto` for them in the question.

### 4. Collect the changes

Every answer that differs from the current lanes becomes one `--role "<label>=<lane>[, <lane>]"` for step 5. Answers equal to the current lanes produce no flag. When the operator wants to move a whole family to one effort ("all grok to xhigh"), use `--effort <family>=<effort>` once instead of repeating the same answer across roles; it rewrites every lane of that family and the per-role answers apply after it, so a family-wide rewrite plus a named exception fits in one plan.

### 5. Plan

```shell
node scripts/setup-pstack.ts plan --parent <parent> \
  [--effort <family>=<effort>]... [--role "<label>=<lane>[, <lane>]"]...
```

The plan is the in-memory render: it starts from the loaded rows (or the first-run map), materializes any missing documented role from the defaults, rewrites every lane of a family named in `--effort` to that effort, then applies the named role changes lane by lane. It refuses an unqualified slug, an unknown role or family, an effort outside the family's row, and a family-wide `--effort` for a family outside the map. A family-wide `--effort` updates every lane of that family and moves no role.

The output carries `dir` (a fresh run directory holding `plan.json`; pass `--dir` to choose it), the distinct `efforts` per family in the final map, the `rows`, the `sheet` bytes, the `migrations`, and one probe `pair` per distinct family-and-effort in the map (`fable@medium`, `sol@xhigh`) with its route for this parent and, for native pairs, how to probe it. A family used at two efforts gets two pairs.

### 6. Probe every pair

```shell
node scripts/setup-pstack.ts probe --dir <dir> [--timeout <seconds>] \
  [--repo <owner/name> --pr <number>]
```

External pairs (route `runner`) run at once through the external runner in `read-only` mode, each with its own prompt, output, and receipt named after the pair under the run directory, after the provider preflight proves credentials (`claude auth status --json`, `codex login status`, `grok models` listing the requested model, or, for the `cursor` provider, `GET /v1/models` on the Cursor cloud agents API with `CURSOR_API_KEY` from the environment). A pair passes only when its receipt is `complete` for exactly the requested provider, model, and effort, the model is verified (provider report) or pinned by argv (Codex and Cursor), and the output carries the pair's unique marker. Exit code 1 means at least one external pair failed: report the failing pair, provider, and `detail`, stop, and write nothing. There is no implicit timeout; pass `--timeout` only when the operator gives a real deadline.

When the plan contains an HTTP pair, pass both `--repo <owner/name>` and `--pr <number>` to `probe` for its authorized pull request. These flags belong only to `probe`; the target is not saved in the plan or sheet. The script validates the target before creating probe artifacts or launching any pair and forwards it only to HTTP lanes. Omit both flags for a plan without HTTP pairs. Cursor probes require `CURSOR_API_KEY` and Git read access to the remote repository. See [HTTP lanes](../poteto-mode/references/provider-dispatch.md#http-lanes) for authentication, remote-head evidence, and its attribution limit.

Native pairs (route `native`) are listed under `native` with the `pair` id and the `prompt` to send. Run each one yourself through the parent's primitive: on Claude Code, one turn of the mapped `pstack-<stem>-<effort>` agent (`Agent` with that `subagent_type`); on Codex, one `spawn_agent` turn with the listed `model` and `reasoning_effort`. Two native pairs of one family are two agents (`pstack-fable-medium` and `pstack-fable-max`), one turn each. When the Codex parent has no `multi_agent` (so `spawn_agent` is unavailable), run the same prompt as one turn of the parent's own CLI instead: `codex exec --model <model> --config 'model_reasoning_effort="<effort>"' --sandbox read-only --skip-git-repo-check --ephemeral`; the Codex CLI is the parent's native process, not the external launcher. Then record the exact reply:

```shell
node scripts/setup-pstack.ts attest --dir <dir> --pair <family>@<effort> --observed "<exact reply text>"
```

`attest` refuses a reply that lacks the marker. Never call the external launcher for the parent's own provider, and never attest a reply you did not observe. A login-status command alone proves credentials, not that the requested model and effort flags run. Receipts and native transcripts prove the requested effort and the route; they do not prove a provider's hidden applied reasoning depth.

### 7. Confirm and commit

Show any rolling-alias migrations as original and normalized descriptors. Show the route table for this parent and every rendered row from `plan.json`. Say when `inherit-parent` or `auto` reduces a panel's provider diversity. Why and Reflect require the parent's live MCP surface; keep their roles on `inherit-parent` or `auto`, because the bounded external runner deliberately omits ambient MCPs. For panel roles, one lane runs per entry and the list length is the fan-out count. `arena cross-judge pool` is a list from which Arena chooses a provider different from the parent and base candidate when possible. `swarm workers` is the default for every worker unless a race explicitly assigns another descriptor.

Ask for confirmation. After the operator confirms:

```shell
node scripts/setup-pstack.ts write --dir <dir>
```

`write` verifies every pair of the plan against the run directory first and refuses (exit 1, nothing touched) while any probe is missing or failed. It then snapshots the sheet and the parent integration, renders the integration, compares, writes only what changed, reads both back, and restores every snapshot if a write or read-back fails. The result names each target as `created`, `updated`, or `unchanged`. An unchanged rerun is byte-identical and reports both as `unchanged`.

### 8. How the integration is wired

On Claude Code, the integration is the single `@~/.claude/pstack-models.md` line in `~/.claude/CLAUDE.md`: appended once on first run, left alone when present, inconsistent when duplicated. On Codex, it is the exact sheet bytes between one `<!-- pstack:models:begin -->` and `<!-- pstack:models:end -->` pair in `~/.codex/AGENTS.md`: one block appended at the end on first run, the whole block replaced on a rerun. Missing, duplicated, or reversed markers, or a directory where a file should be, stop the write as inconsistent state instead of guessing a boundary.

Do not copy the model sheet between harnesses without rerunning the parent-specific probes; route availability can differ even on the same host.

### 9. Behavioral smoke

Before declaring setup complete, run one small read-only mixed panel from this parent: every chosen descriptor, distinct output/receipt paths, and an independent cross-judge. Launch Claude-native agents and every external process in the background with retained handles, then drain them. Verify the native transcript entries and every external receipt. A structural config check or unit test is not a substitute.

Report the sheet path, parent route table, per-pair probe results, smoke results, and external elapsed/token/cost receipts. Re-running this skill re-probes and updates the same sheet. Do not claim the provider exposed hidden applied-effort observability.

## First-run role maps

The maps below are rendered from `model-matrix.json` by `scripts/render-model-matrix.ts`, one per parent because the frontier solo roles take the parent's native frontier family. They only seed the plan on a first run; selected efforts and explicit role changes always replace their values before writing. Never paste one as the result.

<!-- role-sheet:begin -->

Claude Code parent:

```markdown
# pstack model configuration

Provider-qualified per-role choices. Read the installed pstack provider-dispatch reference before dispatching a configured role. Every documented role remains present. `inherit-parent` and `auto` use the parent model natively and still count as one panel lane.

feature, refactoring: grok:grok-4.6@xhigh
bug-fix: grok:grok-4.6@xhigh
perf-issue: grok:grok-4.6@xhigh
hillclimb: grok:grok-4.6@xhigh
judgment and prose: claude:fable@max
hardest tasks: claude:fable@max
how explorer: grok:grok-4.6@xhigh
how explainer: claude:fable@max
why investigators: inherit-parent
why synthesizer: inherit-parent
reflect tooling: inherit-parent
reflect judgment, divergent, synthesizer: inherit-parent
arena runners: claude:fable@max, codex:gpt-6-astra@max, grok:grok-4.6@xhigh, claude:opus@xhigh
arena cross-judge pool: claude:fable@max, codex:gpt-6-astra@max, grok:grok-4.6@xhigh, claude:opus@xhigh
swarm workers: grok:grok-4.6@xhigh
architect runners: claude:fable@max, codex:gpt-6-astra@max, grok:grok-4.6@xhigh, claude:opus@xhigh
interrogate reviewers: claude:fable@max, codex:gpt-6-astra@max, grok:grok-4.6@xhigh, claude:opus@xhigh
pr verifier: cursor:composer-2.5@high
pr reviewer: cursor:grok-4.6@high
pr fixer, simple: cursor:composer-2.5@high
pr fixer, complex: cursor:grok-4.6@xhigh
pr diagnosis pool: cursor:muse-spark-1.3@high, cursor:glm-5.2@high, cursor:gemini-3.1-pro@high, cursor:kimi-k3@high
```

Codex parent:

```markdown
# pstack model configuration

Provider-qualified per-role choices. Read the installed pstack provider-dispatch reference before dispatching a configured role. Every documented role remains present. `inherit-parent` and `auto` use the parent model natively and still count as one panel lane.

feature, refactoring: grok:grok-4.6@xhigh
bug-fix: grok:grok-4.6@xhigh
perf-issue: grok:grok-4.6@xhigh
hillclimb: grok:grok-4.6@xhigh
judgment and prose: codex:gpt-6-astra@max
hardest tasks: codex:gpt-6-astra@max
how explorer: grok:grok-4.6@xhigh
how explainer: codex:gpt-6-astra@max
why investigators: inherit-parent
why synthesizer: inherit-parent
reflect tooling: inherit-parent
reflect judgment, divergent, synthesizer: inherit-parent
arena runners: claude:fable@max, codex:gpt-6-astra@max, grok:grok-4.6@xhigh, claude:opus@xhigh
arena cross-judge pool: claude:fable@max, codex:gpt-6-astra@max, grok:grok-4.6@xhigh, claude:opus@xhigh
swarm workers: grok:grok-4.6@xhigh
architect runners: claude:fable@max, codex:gpt-6-astra@max, grok:grok-4.6@xhigh, claude:opus@xhigh
interrogate reviewers: claude:fable@max, codex:gpt-6-astra@max, grok:grok-4.6@xhigh, claude:opus@xhigh
pr verifier: cursor:composer-2.5@high
pr reviewer: cursor:grok-4.6@high
pr fixer, simple: cursor:composer-2.5@high
pr fixer, complex: cursor:grok-4.6@xhigh
pr diagnosis pool: cursor:muse-spark-1.3@high, cursor:glm-5.2@high, cursor:gemini-3.1-pro@high, cursor:kimi-k3@high
```

<!-- role-sheet:end -->
