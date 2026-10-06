---
name: swarm
description: "Use only when the user explicitly names this skill or an active pstack workflow calls it. Run a set of parallel workers and consolidate their results."
---

# Swarm

Fan out N parallel workers. They may cover separate slices, race the same brief, or mix both. The parent waits, aggregates, and returns one report.

**Dispatch contract.** Before fan-out, preserve each worker's configured descriptor and resolve its execution route against the task's requirements through [`provider-dispatch.md`](../poteto-mode/references/provider-dispatch.md). For external Grok workers, apply its [transport selection rule](../poteto-mode/references/provider-dispatch.md#explicit-grok-acp-tasks). The parent starts native and external lanes; workers never route themselves. On Codex, resolve remaining Claude tool names via [`codex-tools.md`](../poteto-mode/references/codex-tools.md).

## Start

Open a todolist with one entry per phase before launching anything.

1. Frame
2. Fan out
3. Aggregate
4. Report

## Phase A: Frame

1. State the done predicate and the artifact or report the swarm must return.
2. Choose the shape. Partition into slices, race N workers on identical briefs, or mix both. For a race or mixed shape, declare `first pass`, `rank all`, or `best-of` before spawning.
3. Set N from the user or derive it from the shape. N is total workers, not the number that run at once.
4. Pick the worker descriptor from `swarm workers` in the current harness's pstack model sheet when present. Otherwise use the `swarm workers` row of the role table in `provider-dispatch.md`. For a model race, name each arm's descriptor up front.
   Check the optional `swarm fallback` setting through setup's `state` command. When configured, read the [native fallback policy](references/native-fallback.md) before fan-out; it governs capability gaps, terminal execution failures and replacement accounting. An absent setting leaves fallback disabled.
5. Give each worker its own writable output when it writes. When workers verify or measure commits, each brief names the exact SHAs. A measurement brief also names the method (sample count, what one sample is, order). The worker records both in its result.

## Phase B: Fan out

Schedule all N workers through provider dispatch's [native lifecycle rules](../poteto-mode/references/native-lifecycle.md). Native lanes use background subagents; external lanes invoke the launcher as background work with retained task/session handles. Never use Claude's foreground Bash path for a long worker. Every writer runs in its assigned worktree or output directory. Isolation comes from those paths, not the provider.

When a worker must start from a non-default branch, check that branch out in the worker's own worktree and name the worktree path in its brief.

Every brief stands alone. Include the goal, scope, exact slice or race arm, how to verify, and what to report. Reports use `PASS`, `ISSUES`, or `BLOCKED` with evidence. A worker that can prove a defect reports `ISSUES` and lists every issue it can prove, not only the first.

For a capability gap or terminal execution failure, apply the [native fallback policy](references/native-fallback.md) when configured. If disabled, ineligible or unsuccessful, proceed with the remaining workers and note the provider, model, and failure evidence. Keep the affected required slice as a gap.

## Phase C: Aggregate

Read the terminal results. Drop a result that does not record the SHAs and method its brief names, and respawn that worker once on its original descriptor. After a second miss, record a gap. A fallback attempt gets no additional respawn. A gap does not count as a pass. For coverage, every required slice needs a result. For a race, apply the selection rule declared up front. Use first pass, rank all, or best-of. Do not paste raw worker dumps.

Keep a compact result table, one-line evidenced issues, and explicit gaps or dropouts.

## Phase D: Report

Return one consolidated in-chat report with the table, issue one-liners, gaps or dropouts, and the race rule when used.
