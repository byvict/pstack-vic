# Codex wake: native schedule and local queue

Keep the payload and cadence required by the active playbook. At the current upstream pin, Autopilot-full step 6 and Autopilot-stack step 2 require **one audit per hour**, including their owner/children liveness checks, decision trails, stuck-lane handling and termination condition. The 30-minute text in the historical ADR 0005 is not the current cadence. A timer is a trigger; it does not perform the audit.

## Select the host mechanism

Prefer the host's native **heartbeat attached to the exact root thread** when its announced scheduling tool supports the required interval. In the Codex desktop app, use `automation_update` with kind `heartbeat`, the root's exact `targetThreadId`, the active playbook's complete audit prompt and an hourly interval for Autopilot. Retain the returned automation ID, inspect its target/prompt/schedule, then finish the turn. Update that same ID when the program changes; do not create a second schedule for the same audit. Keep it active until no delegated work remains, including after the last merge, and delete it on stop/completion. A scheduled prompt needs the same permissions and tools as an ordinary turn. Verify the resulting turn and its side effects; saving the schedule proves only registration.

If the native scheduler is absent or cannot express the required cadence, use the installed CLI queue to deliver one later prompt to an **exact persisted thread already loaded in a running local Codex app-server**. The adapter below is a local control command, not a service or a replacement audit loop. Choose one trigger mechanism per program. An event-driven watcher must retain its upstream trigger rather than gain a second sleep loop.

The desktop heartbeat and CLI queue are distinct host surfaces. A heartbeat does not require the model's sandbox to open a control socket. The queue adapter does. CLI queue acceptance by itself does not load a thread. Keep the selected host running; neither this contract nor upstream requires unattended work after closing the host or rebooting. See the [comparison and real exercises](../../../docs/research/2026-10-08-codex-wake-lifecycle.md).

## Arm one local event

```sh
node <plugin>/skills/poteto-mode/scripts/codex-wake.ts arm \
  --state /absolute/evidence/unique-event \
  --thread <exact-thread-uuid> \
  --socket /absolute/local/control.sock \
  --delay-ms 3600000 --payload /absolute/tick-prompt.txt
node <plugin>/skills/poteto-mode/scripts/codex-wake.ts status --state /absolute/evidence/unique-event
node <plugin>/skills/poteto-mode/scripts/codex-wake.ts observe --state /absolute/evidence/unique-event
node <plugin>/skills/poteto-mode/scripts/codex-wake.ts cancel --state /absolute/evidence/unique-event
```

Run `arm` from the local controller with access to the socket. The observed macOS workspace sandbox could not access the control socket; do not widen worker permissions to make the command work. A host tool can invoke this command outside the worker sandbox. Without such a control path, retain the operator's explicit tick. The optional socket default is `$CODEX_HOME/app-server-control/app-server-control.sock` (or `~/.codex/...`); no service is installed or started implicitly. The local host must remain running and keep the thread loaded. One-shot `codex exec --ephemeral` cannot supply that lifecycle.

`arm` reserves a private directory and returns after its owned detached worker confirms the target and timer. The caller may then finish its turn. Repeating the identical request with the same directory returns `duplicate: true`, including after completion; changing the payload or target requires a new directory. There is one event, with a stable UUID, and no automatic retry. A lost acknowledgement becomes `delivery-unknown`: inspect the native queue and thread history instead of replaying it. This avoids claiming exactly-once model execution across crashes.

Cancellation before dispatch prevents submission. After submission, cancellation deletes only the matching still-pending queue entry. A consumed event may already have started a turn; cancellation reports that limit and does not interrupt unrelated work. The timer and connection close after delivery, cancellation or failure. Killing the host or restarting the machine does not produce a durable scheduler.

The state directory retains the immutable request/payload hash, worker PID and command, stdout/stderr, receipt, cancellation records, and original JSON-RPC messages per connection. `status` reads local records without contacting the host. Model/effort in the receipt are host configuration, not backend attestation.

## Confirm, reconcile, or cancel

`observe` reads the exact thread, paginates its native queue and full turn history, and matches `clientUserMessageId`/user-message `clientId` to the event UUID. It saves a new timestamped observation without overwriting the send receipt or earlier captures. It never resumes the session or sends the payload again.

| Evidence | Decision |
| --- | --- |
| `armed` | Timer confirmed; root may finish its turn. |
| `queued` | Host accepted the message. Execution is still unconfirmed. |
| Observation `pending` | Matching submission was in the queue. Wait for consumption or cancel that item. |
| Observation `consumed` | History contains the event's user message. Inspect every matching turn's ID/status. `inProgress`, `failed` and `interrupted` are not a successful audit. |
| Matching turn `completed` plus checked audit side effects | That audit completed. Decide whether the program still needs another tick. |
| `delivery-unknown` or stale `dispatching` | Run `observe`; reconcile queue/history/effects without replay. A recovered completed turn leaves the original uncertain transport receipt intact. |
| Observation `unobserved` | No match in this snapshot. Absence does not prove non-delivery, successful cancellation, or safe replay. Retain uncertainty and inspect the host/records. |
| `cancellationRequested: true` | Local cancellation intent recorded; confirm the worker's terminal `cancelled` receipt. |
| Cancellation `cancelled` | The matching pending queue item was deleted, or the timer ended before submission. |
| Cancellation `already-consumed` / `not-pending` | Deletion did not establish cancellation. Observe history; an existing turn is not interrupted. |
| Host unavailable/unloaded, failed timer, or observation error | Report the interrupted audit coverage. Explicitly restore the host/session through its normal client before deciding the next tick. |

Queue and history reads are sequential snapshots, not a transaction. A message can move between them. If it appears in both, the observation preserves both facts. Multiple matching turns remain visible; a quoted UUID in assistant text does not count. An RPC/protocol failure is an error, not an empty successful observation. Payload effects remain program-specific and require a real check, even after a completed turn.

Cancel on stand-down and record the result for each event. If cancellation raced with `dispatching`, inspect the final send/worker-cancellation records and observe again; request acceptance is not confirmation. After a lost reply, a confirmed pending-item deletion is sufficient; a missing item alone is not. Do not interrupt the root's other work to cancel an already consumed event.

## Rearm and release owned resources

For the queue fallback, the root/controller explicitly arms a new state directory for the next required tick before yielding while the program remains active. Retain the program's intended next due time and pass its remaining delay; avoid silently adding audit runtime to an hourly cadence. A missed deadline is interrupted coverage to report and reconcile, not permission to replay uncertain events or emit a burst of catch-up audits. Stop rearming when the upstream termination condition is met or the operator stops the program.

Run the controller with socket access while retaining the worker sandbox. To operate a dedicated local host, launch `codex app-server --listen unix:///absolute/control.sock` under a retained foreground/background process handle and use the normal CLI client (`codex resume --remote unix:///absolute/control.sock <exact-UUID>`) or explicit app-server `thread/resume` to load the authorized root. Session selection, configuration and resumption belong to that controller, not `arm`. A closed `codex exec` process is not a resident host.

Timers close their connections and exit after submission, cancellation or failure. Retain their PIDs/receipts and the dedicated host/client handles; at program end cancel pending events, confirm timer exits, then close only the host/client processes the program owns. Do not stop a shared host or search-and-kill other Codex processes. No launchd job, login hook, personal configuration edit, reboot recovery, or exactly-once execution across crashes is part of this contract.

## Reproduce the isolated queue proof

From a clean candidate checkout, run:

```sh
node scripts/prove-codex-wake.mjs \
  --output /absolute/new-evidence-directory --model <explicit-Codex-model>
```

The authenticated exercise consumes model usage. It retains source SHA/hashes, CLI/schema captures, commands/streams, RPC events, payload effects and owned process handles. It creates a disposable program directory and dedicated host, injects a lost queue acknowledgement through a local proxy, and closes its processes. Its **30-second cadence is accelerated testing**. The fixture audits file-backed owner/children data; it is not a full Autopilot delivery. `--working-tree` labels development evidence explicitly.

## Installed protocol

Codex CLI 0.161.0 advertises `codex queue --thread --message --remote unix://...`. On an unloaded thread that command accepted a submission without starting a turn. The adapter therefore checks `thread/read` before arming and before dispatch and refuses unloaded or ephemeral targets. It sends `thread/queue/add` with `clientUserMessageId`, and uses `thread/queue/list` and `thread/queue/delete` for cancellation. It never resumes or creates a model thread or changes its model, effort, cwd or permissions.

The installed `codex app-server generate-json-schema --experimental` defines these versioned fields. Unix sockets require WebSocket HTTP Upgrade; `app-server proxy` only copies bytes. Node 24's standard WebSocket supplies framing through a single-use loopback-to-Unix bridge, closed to new connections after its unguessable path is consumed. No network host or remote worker is accepted. See the [official app-server transport documentation](https://developers.openai.com/codex/app-server) and [local exercise record](../../../docs/research/2026-10-07-local-executor-contracts.md).
