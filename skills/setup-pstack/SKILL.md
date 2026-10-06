---
name: setup-pstack
description: Configure pstack's provider-qualified models, per-lane requested effort, and parent-owned routes per role. Probe each new family before writing the sheet; Grok also requires a fresh owner → helper capability check on every setup. Use for /setup-pstack, "configure pstack models", or changing pstack's model choices.
---

# Setup pstack

Configure one portable model sheet for the current parent harness. Read [`provider-dispatch.md`](../poteto-mode/references/provider-dispatch.md) before probing or writing anything. Its model matrix, descriptor grammar, route table, and role defaults are the contract. Each lane carries its own effort, so two roles may run the same family at different efforts. Do not add a second configuration file, a runtime resolver, or a weaker-model fallback. The `pick` subcommand is none of these: it applies the Cross-family selection rule of `provider-dispatch.md` to a row the operator wrote, and never leaves that row.

The deterministic half of this skill is `scripts/setup-pstack.ts`, next to this file (Node 24, no dependencies; run it as `node <this skill's directory>/scripts/setup-pstack.ts <subcommand>`). It reads the matrix, reads and normalizes the current sheet, renders the new one, runs the external probes through the runner, refuses to write while any required probe is missing, and writes with snapshot, read-back, and restore. You own the conversation (parent, efforts, role changes, confirmation) and the native one-turn probes. Every subcommand prints JSON; `--help` prints the usage. Never edit the sheet or the integration files by hand, and never paste a rendered sheet as the result. A sixth subcommand, `pick`, is not a setup step: a skill calls it at dispatch time to take one lane from a pool row. A second script, `scripts/authorize.ts`, checks the operator's standing authorization (step 10).

Every subcommand resolves `<config-home>` once with the [harness config-home rule](../poteto-mode/references/codex-tools.md#harness-config-homes). The script reads `CLAUDE_CONFIG_DIR` and `CODEX_HOME` from the shell that runs it, and uses the resolved home for every write, snapshot, restoration, and readback. Current-state reads start there and follow the import of a copied profile (step 2).

Claude Code writes `<config-home>/pstack-models.md` and loads it from `<config-home>/CLAUDE.md` using the import rule in step 8. When `<config-home>` is the default home, the import is exactly the legacy line:

```text
@~/.claude/pstack-models.md
```

Only when `CLAUDE_CONFIG_DIR` redirects the home is it exactly `@./pstack-models.md`, relative to the importing file's directory.

Codex writes `<config-home>/pstack-models.md`. Codex has no `@` include, so the script mirrors the sheet's exact bytes inside one bounded block in `<config-home>/AGENTS.md` and keeps the sheet as the editable source of truth:

```text
<!-- pstack:models:begin -->
<exact contents of the resolved model sheet>
<!-- pstack:models:end -->
```

Grok writes `~/.grok/pstack-models.md` and mirrors the same bounded block in `~/.grok/AGENTS.md`. Read [grok-tools.md](../poteto-mode/references/grok-tools.md) for its native tools, aliases and session approval mode. The Grok sheet governs a Grok root even when compatibility loads a Claude sheet.

Before probing Grok, verify that its root loaded `[subagents] max_depth = 2` or higher from `config.toml`. The default depth of one prevents an autopilot owner from creating a helper. If necessary, set this key while preserving the other settings and restart the Grok session. A config read is supporting evidence; the owner → helper probe in step 6 is the capability gate. Do not claim that the current root picked up a config change without restarting it.

Next to each parent's sheet, `pstack-probes.json` is the probe ledger: one entry per family (`<provider>:<model>`) this parent has verified, with the descriptor probed, when, and the evidence (the run directory, or `operator` for a family the operator vouched for). Effort is not part of the key. A family in the ledger is never probed again, whatever effort a lane gives it. A new provider or a new model (a family added to the matrix, or a family whose model changed) is missing from the ledger and gets one probe. `write` adds each family it probed. To force a family to be probed again, delete its entry. A ledger that does not parse, or a directory at its path, stops `plan` as inconsistent state.

The Grok `ownerProbe` is separate from that ledger. Every new plan gets a fresh marker and requires a live owner → helper proof from this root, even when `pairs` is empty. An older plan's evidence cannot satisfy the fresh marker. This capability proves session nesting; it does not change or invalidate cached model-family results.

## Steps

### 1. Establish the parent

Use the harness and tool surface running this skill: Claude Code (`--parent claude`) Codex (`--parent codex`), or Grok Build (`--parent grok`), including T3 Code on that provider. Environment markers may corroborate that top-level answer, but do not launch a child and ask it to detect where it came from. Record the parent because the same descriptor takes a different route in each harness.

### 2. Load current state

```shell
node scripts/setup-pstack.ts state --parent <parent>
```

The JSON says whether the parent's sheet exists (`exists`), its path (`sheetPath`, inside `configHome`), where the rows came from (`source`), the normalized rows, the `migrations` it applied in memory (old Fable revisions become `fable`; `opus` and old Opus revisions become `claude-opus-5-5`; `gpt-5.6-sol` becomes `gpt-6-sol`, preserving provider, effort, role, and lane order), and one `efforts` entry per matrix family with its `status`, the distinct `efforts` in use, and the `rows` that use them. A family's status is `current` (every lane of the family shares one effort), `mixed` (its lanes use two or more efforts; a valid sheet, not a conflict), `unassigned` (first run: the matrix Default effort is proposed), or `outside-map` (no role uses the family, so no effort can persist for it; on a Claude Code parent, Sol is outside the first-run map by the 2026-09-17 decision, and on a Codex parent it is the default of the four authoring rows).

The `source` is the sheet itself, the sheet that `<config-home>/CLAUDE.md` imports from elsewhere (a copied profile), the Codex or Grok `AGENTS.md` block when the sheet is missing, or `first-run`. `missingImport` names an import whose target does not exist. When `source` is not the sheet, name it and the destination `sheetPath` in step 7, because the write carries its rows into `<config-home>/pstack-models.md`.

The script stops on inconsistent state: an unknown or duplicate role row, a bare host-native slug, an unregistered Claude model, a provider/model pair outside the matrix, an effort outside the family's Selectable efforts, two sheet imports in `CLAUDE.md`, broken block markers in `AGENTS.md`, or a sheet whose lanes differ from those of the import target or of the block. Show the error verbatim and resolve it with the operator before going on. Do not probe or write while any inconsistency is unresolved.

### 3. Show the map as a table, then ask only for the roles that change

Show the whole map as one markdown table, one row per role in matrix order, with three columns: the role, what the lane does (the role's `description` from `model-matrix.json`, the "What the lane does" column of the role table in `provider-dispatch.md`), and the current lanes (the loaded rows on a rerun, the first-run map below on a first run; a migrated descriptor shows normalized, with the original from step 2 noted under the table). Below the table, one line with the `outside-map` families and one line with the families available on this parent and their route (native or external runner). Never offer a reset of a customized sheet to the first-run assignments.

Then one `AskUserQuestion` with a single question: keep the map as shown, or change roles. Options are "Keep everything" first (the default, and the recommended answer on a rerun), then "Change roles", with "Other" for the operator to type the changes directly, one per line as `<role>: <lane>[, <lane>]`, or a family-wide move such as "all grok to xhigh". A typed line that names a role and its lanes is a complete answer for that role; do not ask about it again.

When the operator chose "Change roles" without typing lanes, ask which roles in one question (`multiSelect`, the roles as options in matrix order, four per call when they do not fit, "Other" for labels typed by name). Then, only for the roles named without lanes, one `AskUserQuestion` call per role with two questions in this order. Both questions carry the role's `description` so the operator knows what the lane does before choosing. Roles the operator did not name are never asked about.

1. **Model.** Options are the current value first, labeled "(keep)", then three more in this order until four options are filled: the role's matrix default for this parent when it differs from the current value, then the remaining families in matrix order, then `inherit-parent` and `auto`. Each family option names its model and its route for this parent (native or external runner). The families and aliases that did not fit are typed under "Other" by family name. For a role whose lane is an alias, the options are the current alias first, then the other alias, then families in matrix order.
2. **Effort.** Options are the current effort first, labeled "(keep)", then the family's remaining Selectable efforts in matrix order, dropping `low` when it is not current; the dropped one is typed under "Other". Say in the question that the effort is ignored when the model answer is an alias. Empty input keeps the current lanes; on a first run it accepts the matrix proposal.

A panel role (a list) gets one question instead of two: the current lanes as the "(keep)" option, the parent's matrix default panel when it differs, and "Other" for a typed list of descriptors, one per lane, in the order they should run. Explain that one lane runs per entry and that the list length is the fan-out count.

A pool role (`arena cross-judge pool`, `trail reviewer pool`) gets the same single question with a different explanation: one lane runs, and the order of the list is the order of preference. For `trail reviewer pool`, say that the lane that runs is the first entry from a provider that wrote none of the work, that this parent's own provider never qualifies, and that the row therefore needs at least one other provider and takes no alias. Two other providers keep a reviewer available when a lane of one of them wrote.

Each lane keeps the effort written in its descriptor, so `bug-fix: codex:gpt-6-sol@xhigh` next to `hillclimb: codex:gpt-6-sol@high` is a valid map; there is no per-family effort question. A role that brings a family into the map carries that family's effort in its answer. Why and Reflect roles need the parent's live MCP surface, so recommend `inherit-parent` or `auto` for them in the question.

### 4. Collect the changes

Every answer that differs from the current lanes becomes one `--role "<label>=<lane>[, <lane>]"` for step 5. Answers equal to the current lanes produce no flag. When the operator wants to move a whole family to one effort ("all grok to xhigh"), use `--effort <family>=<effort>` once instead of repeating the same answer across roles; it rewrites every lane of that family and the per-role answers apply after it, so a family-wide rewrite plus a named exception fits in one plan.

### 5. Plan

```shell
node scripts/setup-pstack.ts plan --parent <parent> \
  [--effort <family>=<effort>]... [--role "<label>=<lane>[, <lane>]"]...
```

The plan is the in-memory render: it starts from the loaded rows (or the first-run map), materializes any missing documented role from the defaults, rewrites every lane of a family named in `--effort` to that effort, then applies the named role changes lane by lane. It refuses an unqualified slug, an unknown role or family, an effort outside the family's row, and a family-wide `--effort` for a family outside the map. It also refuses a `trail reviewer pool` row that holds an alias or names no provider other than this parent's own, because such a row can never yield a reviewer. A family-wide `--effort` updates every lane of that family and moves no role.

The output carries `dir` (a fresh run directory holding `plan.json`; pass `--dir` to choose it), the distinct `efforts` per family in the final map, the `rows`, the `sheet` bytes, the `migrations`, `verified` (the families of the map already in this parent's ledger, which are not probed), and `pairs`: one probe per family of the map missing from the ledger, at the family's lowest effort in use (`sol@high` when `sol` runs at `high` and `xhigh`), with its route for this parent and, for native pairs, how to probe it. A plan that only changes efforts or moves roles between verified families has no `pairs`. `warnings` lists the rows that are valid but can leave a run without a lane, such as a `trail reviewer pool` with one provider besides the parent's. Show each warning to the operator in step 7.

### 6. Probe new families

Skip this step only when both `pairs` is empty and `ownerProbe` is null. Otherwise:

```shell
node scripts/setup-pstack.ts probe --dir <dir> [--timeout <seconds>]
```

External pairs (route `runner`) of the plan run at once through the external runner in `read-only` mode, each with its own prompt, output, and receipt named after the pair under the run directory, after the CLI proves credentials (`claude auth status --json`, `codex login status`, or `grok models` listing the requested model). A pair passes only when its receipt is `complete` for exactly the requested provider, model, and effort, the model is verified (provider report) or pinned by argv (Codex), and the output carries the pair's unique marker. Exit code 1 means at least one external pair failed: report the failing pair, provider, and `detail`, stop, and write nothing. There is no implicit timeout; pass `--timeout` only when the operator gives a real deadline.

Native pairs (route `native`) are listed under `native` with the `pair` id and the `prompt` to send. Run each one yourself through the parent's primitive: on Claude Code, one turn of the mapped `pstack-<stem>-<effort>` agent (`Agent` with that `subagent_type`); on Codex, one `spawn_agent` turn with the listed `model` and `reasoning_effort`. On Grok, spawn the listed `ownerAgent` using its exact advertised plugin name, such as `pstack:pstack-owner-grok-4-7-xhigh`. Its probe prompt requires it to spawn the listed ordinary `agent`, drain that helper and relay the marker and helper ID. Retain the owner's ID too. The definitions supply model and effort for both levels; retrieve results through `get_command_or_subagent_output`. A direct root → helper reply does not pass the Grok probe. When the Codex parent has no `multi_agent` (so `spawn_agent` is unavailable), run the same prompt as one turn of the parent's own CLI instead: `codex exec --model <model> --config 'model_reasoning_effort="<effort>"' --sandbox read-only --skip-git-repo-check --ephemeral`; the Codex CLI is the parent's native process, not the external launcher. Then record the exact reply:

```shell
node scripts/setup-pstack.ts attest --dir <dir> --pair <family>@<effort> --observed "<exact reply text>"
```

For Grok, add `--owner-id <observed owner ID> --child-id <observed helper ID>`. Check both transcript entries before attesting. `attest` refuses a reply that lacks the marker or Grok evidence without two distinct handles. Never call the external launcher for the parent's own provider, and never attest a reply you did not observe. A login-status command alone proves credentials, not that the requested model runs. The probe proves the family and its route on this parent; the other efforts of a verified family are trusted to the matrix's Selectable efforts and are not probed. Receipts and native transcripts do not prove a provider's hidden applied reasoning depth.

On Grok, also attest `--pair owner-nesting` with the fresh `owner.marker`, exact observed reply and the two IDs. A native family probe's prompt includes both markers, so that same owner → helper call can satisfy both attestations. If there are no new native families, dispatch the listed `owner.agent` (`pstack:poteto-agent`) with `owner.prompt`, let it spawn exactly one inherited helper and drain it. Neither level starts another workflow. Never reuse an earlier root's handles or attest a capability from a config read alone.

### 7. Confirm and commit

Show any model migrations as original and normalized descriptors. Show the route table for this parent and every rendered row from `plan.json`. Say which families were probed in step 6 and which were already verified (`verified`). Say when `inherit-parent` or `auto` reduces a panel's provider diversity. Why and Reflect require the parent's live MCP surface; keep their roles on `inherit-parent` or `auto`, because the bounded external runner deliberately omits ambient MCPs. For panel roles, one lane runs per entry and the list length is the fan-out count. `arena cross-judge pool` is a list from which Arena chooses a provider different from the parent and base candidate when possible. `trail reviewer pool` is a list from which one lane reviews a run's decision trail: the first entry from a provider that wrote none of the work, and no lane at all when every entry is from a provider that wrote. Show every `warnings` line of the plan. `swarm workers` is the default for every worker unless a race explicitly assigns another descriptor.

Ask for confirmation. After the operator confirms:

```shell
node scripts/setup-pstack.ts write --dir <dir>
```

`write` refuses a plan made for another config home, so run it with the same `--home` and variable as `plan`. After that it verifies every required family probe and the fresh Grok owner capability against the run directory and refuses (exit 1, nothing touched) while any is missing or failed. It then snapshots the sheet, the parent integration, and the ledger, renders the integration and the ledger (plus one entry per family this plan probed), compares, writes only what changed, reads each back, and restores every snapshot if a write or read-back fails. The result names each target as `created`, `updated`, or `unchanged`. An unchanged rerun is byte-identical and reports all three as `unchanged`.

### 8. How the integration is wired

On Claude Code, the integration is the one `@` import in `<config-home>/CLAUDE.md` whose target's basename is `pstack-models.md`, in any directory or spelling, found the way Claude Code parses imports (an import in a list item counts, and one in a fenced block, a code span or quotes does not). The default home renders exactly `@~/.claude/pstack-models.md`, and a home that `CLAUDE_CONFIG_DIR` redirects renders exactly `@./pstack-models.md`. Zero imports appends one, one is replaced in place with every other byte kept, and more than one stops as inconsistent state before either write. On Codex and Grok, it is the exact sheet bytes between one `<!-- pstack:models:begin -->` and `<!-- pstack:models:end -->` pair in `<config-home>/AGENTS.md` (always `~/.grok/AGENTS.md` on Grok): one block appended at the end on first run, the whole block replaced on a rerun. Missing, duplicated, or reversed markers, or a directory where a file should be, stop the write as inconsistent state instead of guessing a boundary.

Do not copy the model sheet or the ledger between harnesses; route availability can differ even on the same host, so each parent keeps its own ledger and probes a family the first time it uses it.

### 9. Behavioral smoke

Run the smoke only when step 6 probed at least one family. Skip it when the plan had no `pairs`: an effort change or a role move between verified families needs no smoke. Otherwise, before declaring setup complete, run one small read-only mixed panel from this parent: one lane per newly probed family, distinct output/receipt paths, and an independent cross-judge. Launch native agents and every external process in the background with retained handles, then drain them. Verify the native transcript entries and every external receipt. A structural config check or unit test is not a substitute.

Report the sheet path, the ledger path, the parent route table, the families probed and the families already verified, smoke results when a smoke ran, and external elapsed/token/cost receipts. Re-running this skill updates the same sheet and probes only the families missing from this parent's ledger. Do not claim the provider exposed hidden applied-effort observability.

### 10. Standing authorization

Under pstack's playbooks, an agent merges a pull request that no human approved in two cases. An autopilot owner merges its own pull request after the root's clean swarm verdict. The session that runs the Shipping playbook merges after the verdict of that pull request's independent verifier. Claude Code's auto mode blocks that merge by default, under its rules Merge Without Review and Self-Approval. Its classifier reads the user's messages and the commands. It does not read your questions, so an "ok" to your question authorizes nothing. The operator records the decision once, in their own settings. Check the authorization on every run of this skill. When the operator asks only for the authorization, run this step alone:

```shell
node scripts/authorize.ts check --parent <parent>
```

On exit 0, say in one line that the parent is authorized.

On exit 1 on Claude Code, the JSON carries the `reason`, the `entry` and the `grant` command. Show the operator the `entry` in full. Say in their language what the entry allows in every repository:

- In those two cases, an agent submits the selected PR through Shipping after the current independent verdict and required checks pass, binding the validated host, explicit repository and PR, expected head and captured body file. Every operator hold still applies.
- The root spawns owner and verifier subagents and posts verdicts as pull request comments. The root or the owner of that branch may publish only that owned branch: first publication uses `--force-with-lease=refs/heads/<branch>:` and requires an actual new-ref receipt; later waves and rewrites use `--force-with-lease=refs/heads/<branch>:<captured-remote-head>`, captured before the wave and equal to the local pre-wave tip. Shipping validates Git URL resolution and requires canonical forge readback. Git, SSH/TLS authentication, custom transport programs and enabled hooks remain trusted inputs. Pushes suppress implicit tags and submodule recursion; rebases leave other local refs fixed.
- An agent launches pstack's lanes through the runner.

Say what stays blocked:

- `--admin` and any other way around a required check.
- A change to branch protection, rulesets or required checks.
- Everything the other rules protect (destroyed files, branches and history, production, secrets, data that leaves the trust boundary).

Then give the operator the `grant` command to run on a terminal. `apply` shows the entry, asks for a typed yes, keeps every other setting, and copies the old file to `settings.json.before-pstack-authorization`.

The authorization is the operator's act. Never run `apply` yourself, never write the entry into a settings file, and never supply the answer. The script refuses without a terminal for that reason. Claude Code reads `autoMode` from the user's settings and from no repository or plugin, so the plugin cannot ship the entry. When the operator says that `apply` ran, run `check` again and report the result.

On Grok, include `--permission-mode <observed effective session mode>` in the check. Follow [grok-tools.md](../poteto-mode/references/grok-tools.md) to obtain that mode. A config file alone does not prove the mode of a T3 session, and the script writes no Grok approval setting.

On exit 1 on Codex, show the `reason`. Codex has no such list. Codex asks for no approval when `approval_policy` is `"never"` at the top level of `<config-home>/config.toml`. The operator sets that value, or accepts that Codex stops to ask.

The entry names its version (`pstack standing authorization v2`). `check` requires exactly one grant-shaped entry and that entry must be the current exact body. Missing, stale, duplicate and coexisting grants fail without changing settings; the diagnostic identifies which condition was observed. The 0.5.3 safety correction keeps version 2 and requires the operator to review the current entry and run `apply` again. The existing in-place replacement, typed confirmation and backup remain unchanged. To withdraw the authorization, the operator deletes the entry from `autoMode.allow`.

No playbook runs this check. Without the entry, auto mode denies the merge when an autopilot owner or the Shipping session reaches it.

## First-run role maps

The maps below are rendered from `model-matrix.json` by `scripts/render-model-matrix.ts`, one per parent because the frontier solo roles take the parent's native frontier family and the four authoring rows take its native code family. They only seed the plan on a first run; selected efforts and explicit role changes always replace their values before writing. Never paste one as the result.

<!-- role-sheet:begin -->

Claude Code parent:

```markdown
# pstack model configuration

Provider-qualified per-role choices. Read the installed pstack provider-dispatch reference before dispatching a configured role. Every documented role remains present. `inherit-parent` and `auto` use the parent model natively and still count as one panel lane.

feature, refactoring: claude:claude-opus-5-5@xhigh
bug-fix: claude:claude-opus-5-5@xhigh
perf-issue: claude:claude-opus-5-5@xhigh
hillclimb: claude:claude-opus-5-5@xhigh
judgment and prose: claude:fable@max
hardest tasks: claude:fable@max
how explorer: grok:grok-4.6@xhigh
how explainer: claude:fable@max
why investigators: inherit-parent
why synthesizer: inherit-parent
reflect tooling: inherit-parent
reflect judgment, divergent, synthesizer: inherit-parent
arena runners: claude:fable@max, codex:gpt-6-astra@max, grok:grok-4.6@xhigh, claude:claude-opus-5-5@xhigh
arena cross-judge pool: claude:fable@max, codex:gpt-6-astra@max, grok:grok-4.6@xhigh, claude:claude-opus-5-5@xhigh
swarm workers: grok:grok-4.6@xhigh
architect runners: claude:fable@max, codex:gpt-6-astra@max, grok:grok-4.6@xhigh, claude:claude-opus-5-5@xhigh
interrogate reviewers: claude:fable@max, codex:gpt-6-astra@max, grok:grok-4.6@xhigh, claude:claude-opus-5-5@xhigh
trail reviewer pool: claude:claude-opus-5-5@xhigh, codex:gpt-6.1-sol@xhigh, grok:grok-4.7@xhigh
```

Codex parent:

```markdown
# pstack model configuration

Provider-qualified per-role choices. Read the installed pstack provider-dispatch reference before dispatching a configured role. Every documented role remains present. `inherit-parent` and `auto` use the parent model natively and still count as one panel lane.

feature, refactoring: codex:gpt-6-sol@xhigh
bug-fix: codex:gpt-6-sol@xhigh
perf-issue: codex:gpt-6-sol@xhigh
hillclimb: codex:gpt-6-sol@xhigh
judgment and prose: codex:gpt-6-astra@max
hardest tasks: codex:gpt-6-astra@max
how explorer: grok:grok-4.6@xhigh
how explainer: codex:gpt-6-astra@max
why investigators: inherit-parent
why synthesizer: inherit-parent
reflect tooling: inherit-parent
reflect judgment, divergent, synthesizer: inherit-parent
arena runners: claude:fable@max, codex:gpt-6-astra@max, grok:grok-4.6@xhigh, claude:claude-opus-5-5@xhigh
arena cross-judge pool: claude:fable@max, codex:gpt-6-astra@max, grok:grok-4.6@xhigh, claude:claude-opus-5-5@xhigh
swarm workers: grok:grok-4.6@xhigh
architect runners: claude:fable@max, codex:gpt-6-astra@max, grok:grok-4.6@xhigh, claude:claude-opus-5-5@xhigh
interrogate reviewers: claude:fable@max, codex:gpt-6-astra@max, grok:grok-4.6@xhigh, claude:claude-opus-5-5@xhigh
trail reviewer pool: claude:claude-opus-5-5@xhigh, codex:gpt-6.1-sol@xhigh, grok:grok-4.7@xhigh
```

Grok Build parent:

```markdown
# pstack model configuration

Provider-qualified per-role choices. Read the installed pstack provider-dispatch reference before dispatching a configured role. Every documented role remains present. `inherit-parent` and `auto` use the parent model natively and still count as one panel lane.

feature, refactoring: grok:grok-4.7@xhigh
bug-fix: grok:grok-4.7@xhigh
perf-issue: grok:grok-4.7@xhigh
hillclimb: grok:grok-4.7@xhigh
judgment and prose: grok:grok-4.7@xhigh
hardest tasks: grok:grok-4.7@xhigh
how explorer: grok:grok-4.6@xhigh
how explainer: grok:grok-4.7@xhigh
why investigators: inherit-parent
why synthesizer: inherit-parent
reflect tooling: inherit-parent
reflect judgment, divergent, synthesizer: inherit-parent
arena runners: claude:fable@max, codex:gpt-6-astra@max, grok:grok-4.6@xhigh, claude:claude-opus-5-5@xhigh
arena cross-judge pool: claude:fable@max, codex:gpt-6-astra@max, grok:grok-4.6@xhigh, claude:claude-opus-5-5@xhigh
swarm workers: grok:grok-4.6@xhigh
architect runners: claude:fable@max, codex:gpt-6-astra@max, grok:grok-4.6@xhigh, claude:claude-opus-5-5@xhigh
interrogate reviewers: claude:fable@max, codex:gpt-6-astra@max, grok:grok-4.6@xhigh, claude:claude-opus-5-5@xhigh
trail reviewer pool: claude:claude-opus-5-5@xhigh, codex:gpt-6.1-sol@xhigh, grok:grok-4.7@xhigh
```

<!-- role-sheet:end -->
