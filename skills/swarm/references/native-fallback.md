# Native swarm fallback

The optional `swarm fallback` row in the current parent's model sheet authorizes one substitute per swarm worker. It holds exactly one registered `<provider>:<model>@<effort>` descriptor from that parent's native provider. It has no default, takes no alias or list, and adds no worker to N. An absent row disables substitution. Read it with `setup-pstack.ts state --parent <parent>` before fan-out so a malformed or foreign-provider setting fails validation. Setup's `plan --swarm-fallback <descriptor>` enables it; `plan --swarm-fallback off` removes it through the normal probe and write flow.

The parent makes the decision and launches the substitute. The runner still executes one assigned descriptor and never falls back. Apply this policy only to swarm workers, including swarms invoked by a playbook. Other roles keep their own dropout policies.

## Eligibility

Check the worker's required capabilities and authorized routes before dispatch, following [provider dispatch](../../poteto-mode/references/provider-dispatch.md). Substitute only for an evidenced execution impediment:

- No supported, authorized route for the configured worker supplies a required capability while preserving the required access restrictions. Record the missing capability and concrete cause. A pre-dispatch finding can skip the original launch.
- A terminal provider or launcher failure prevented a valid execution, such as missing authentication, an unavailable model, a failed child process, invalid provider output, or a served-model mismatch. Retain the failure receipt or native tool error.

`ISSUES`, a failed test, a defect, disagreement, and an unsatisfactory answer are task results. They do not trigger fallback. A `BLOCKED` label or nonzero command exit inside a worker is insufficient by itself; verify that its cause is an eligible execution impediment. Missing SHAs or measurement method follow Swarm's result-validation rule on the original descriptor.

Honor user and caller stop requests. A `cancelled` receipt alone is insufficient: distinguish an intentional stop from a provider-originated terminal failure. Unchanged running state is not failure. Reconcile an uncertain launch or still-active attempt before replacing it. Technical cleanup of a failed attempt does not cancel the task, but retain the underlying failure evidence separately from its cleanup signal. Existing task deadlines and cost limits cover both attempts; an exhausted limit leaves a gap.

Keep the configured arm as a gap in a model comparison, a race with named model arms, or a worker whose contract requires another provider. These tasks cannot use this fallback. A native substitute also cannot satisfy an independent review by reusing the author's context. If the fallback resolves to the original descriptor, it supplies no replacement; use the ordinary gap policy.

## Replacement

Before launching, establish that the substitute can meet the same tools, confinement, independence and concurrency requirements. Native execution alone proves none of these. Required source access needs a successful source operation, not a tool listing. If no compliant native execution is available under the [lifecycle rules](../../poteto-mode/references/native-lifecycle.md), record a gap.

Launch one fresh native context with the fallback's configured model and effort. Give it the original task, scope, exact revision or snapshot, completion criteria and remaining limits. Include the execution impediment as context, without treating the previous attempt's conclusions as independent evidence. Use distinct output paths and preserve the original receipt. For a writer, retain its partial changes and give the replacement its own worktree or output directory based on the agreed starting snapshot. Any later adoption of partial work requires inspection and validation by the parent.

A confirmed provider-wide failure may justify skipping other not-yet-started attempts with the same cause in this swarm. Record the evidence for each affected worker, check eligibility separately, and let healthy workers finish. A task-specific missing capability does not establish a provider-wide outage.

One substitute is the entire fallback allowance for that worker. Do not chain substitutes or respawn the fallback for missing evidence. If it fails execution or does not return a valid result, retain the gap. A valid `ISSUES` result still reports issues.

## Accounting

Validate the substitute's result against the original criteria. A completed invocation is not proof of coverage or approval. Original and replacement attempts occupy one worker entry and contribute at most one valid result or independent opinion. Coverage still needs every required slice, and serial replacements cannot prove a requirement for simultaneous execution.

In the consolidated report, record the worker ID, original descriptor, original failure or pre-dispatch skip evidence, fallback descriptor, effective model evidence, result and remaining gaps. Identify a served model only when the provider reports it; otherwise mark the requested model as unconfirmed. Count every provider whose writing enters the final artifact as an executor for subsequent cross-family selection.
