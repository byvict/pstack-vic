# Native agent capacity and lifecycle

Read this before native fan-out, a later phase, or a replacement dispatch. Provider dispatch selects the configured model and effort. This contract decides when a native agent can run and whether an existing handle can carry the task.

## Plan against the current host

Inspect the tools and their schemas in this session. Record which operations can spawn, list, wait, send a new task to an idle agent, interrupt, and close an agent. Use only advertised operations. A provider name does not establish which lifecycle tools its host exposes.

Keep a small handle inventory in the run's existing notes: assigned model and effort, task, working directory, required tools, status, and result path. Reconcile it with the host's agent list when available. Use the host's reported capacity and accounting scope, including the root and descendants when they count. An unknown limit stays unknown; do not hard-code four or infer available slots from the number of running agents alone.

On Claude Code 2.1.293 (measured 2026-10-08 in the desktop app): the completion notification of a worktree-isolated agent carries its `worktreePath` and `worktreeBranch`; `TaskStop` on an agent also kills the background shell commands it left running, while its worktree and files stay; an agent stopped by `TaskStop` still accepted `SendMessage` and resumed in place, contrary to the host documentation, so a stop is not a guarantee against a later resume; the root's `ListAgents` lists peer sessions and running agents (a just-launched agent appears after a few seconds), not completed ones, so the handle inventory stays in the run's notes; the documented default is 20 concurrent subagents (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`) and a spawn depth of 3. A worktree-isolated agent cannot run `bash -c` text or a long foreground `sleep`; the host refuses both and points to `run_in_background`, whose command outlives the agent's turn.

Completion produces a result. It does not prove that the host released the thread's slot. Interruption stops a turn and is not closure either. Mark a handle released only when a documented host operation or capacity report establishes that fact. A failed spawn consumes no lane result; keep its error as evidence.

Plan all phases before filling the first wave. Account for later model/effort combinations and roles that need a fresh context, including a judge or independent verifier. When completed handles cannot be released, reserve native capacity for roles that require its tools. Assign excess tasks to fresh runner sessions when they satisfy [provider dispatch's alternative-route conditions](provider-dispatch.md#when-native-dispatch-is-unavailable). If neither route can supply a required context, record the affected gap before dispatch. Waiting alone cannot make a retained handle disappear.

## Dispatch within capacity

A fan-out phase includes all requested lanes, but only the available window runs at once. Start independent native and external work together. Keep excess native tasks queued, collect terminal results, then launch the next eligible wave. N is the requested lane count, not a promise of N simultaneous native threads. Preserve each lane's descriptor, brief, output, and coverage accounting across waves.

Prefer a fresh agent for new work, including a fix round, retry, follow-up, or next queue item. Give it consolidated scope: the original brief, later directives, prior report, branch, and current evidence. A PR owner role can outlive its agent.

Reuse an existing agent only when its task needs costly-to-transfer agent-local state, such as uncommitted work or a running process, or when native capacity prevents a fresh dispatch. For either exception, all of these must hold:

- The agent is idle, its previous result has been collected, and its previous assignment is finished.
- Its assigned model and effort match the new descriptor exactly. An instruction in a follow-up cannot change either. Resolve aliases to their actual assignment before comparing.
- Its tools and working directory support the new task's access and write scope. Required MCP access still needs a successful source call under the provider-dispatch MCP rule.
- Retained context is compatible with the role. Separate candidates and independent review opinions need separate contexts. An author cannot become its own independent verifier or cross-judge. Reuse does not create another independent vote.

Record the reuse reason, handle, descriptor, prior task, and new task in the existing run notes. Send one complete brief through the advertised operation that starts a new turn on an idle agent. Keep new outputs separate from the prior result. Mere familiarity is not a reuse reason. Do not interrupt a healthy task to force reuse or rely on a status message to start a new turn.

If closure is available, collect the result and preserve its artifacts before closing a finished agent that is no longer needed. Check the operation's result before treating its slot as free. If the close operation is absent, keep the handle as idle and retained. Use a compatible idle handle or leave the task queued while a usable running handle finishes.

If concurrency itself is part of the proof, such as a simultaneous race or load measurement, waves do not satisfy it. Report the unmet execution requirement rather than claiming the same result from serial execution.

## When no valid native dispatch remains

On a capacity rejection, reconcile the inventory and apply the rules above. Retry after confirmed release, or once after a newly completed task when the host's release behavior is unknown. If completion still leaves spawning blocked, retain that evidence and consider compatible reuse; do not keep retrying an unchanged state. When native execution cannot supply the required context, apply [provider dispatch's alternative route](provider-dispatch.md#when-native-dispatch-is-unavailable). A fresh same-provider runner session can satisfy an independent review; a retained author context cannot.

If no valid route remains, record the affected lane as a dropout under the calling skill's policy. Continue independent work; a required missing lane never counts as a pass. Preserve the configured provider, model, and effort except when the calling skill authorizes a [configured swarm fallback](../../swarm/references/native-fallback.md). Use the runner for separate CLI sessions so its isolation and receipts apply; the parent never impersonates a missing reviewer.

Report the observed limit or exact tool error, retained handles, unavailable operation, and affected lanes. Distinguish an observed capacity rejection from an inference about why the host retains a thread. Missing `close_agent` alone does not prove a host leak.
