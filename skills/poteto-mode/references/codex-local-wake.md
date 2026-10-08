# Local Codex wake

Use the installed CLI's queue to deliver one later prompt to an **exact persisted thread already loaded in a running local Codex app-server**. The adapter is a local control command, not a scheduler or a replacement for the upstream loop payload. Keep the payload and cadence required by the active playbook. Rearm explicitly with a new state directory only while that program still needs another tick.

```sh
node <plugin>/skills/poteto-mode/scripts/codex-wake.ts arm \
  --state /absolute/evidence/unique-event \
  --thread <exact-thread-uuid> \
  --socket /absolute/local/control.sock \
  --delay-ms 3600000 --payload /absolute/tick-prompt.txt
node <plugin>/skills/poteto-mode/scripts/codex-wake.ts status --state /absolute/evidence/unique-event
node <plugin>/skills/poteto-mode/scripts/codex-wake.ts cancel --state /absolute/evidence/unique-event
```

Run `arm` from the local controller with access to the socket. The observed macOS workspace sandbox could not access the control socket; do not widen worker permissions to make the command work. A host tool can invoke this command outside the worker sandbox. Without such a control path, retain the operator's explicit tick. The optional socket default is `$CODEX_HOME/app-server-control/app-server-control.sock` (or `~/.codex/...`); no service is installed or started implicitly. The local host must remain running and keep the thread loaded. One-shot `codex exec --ephemeral` cannot supply that lifecycle.

`arm` reserves a private directory and returns after its owned detached worker confirms the target and timer. The caller may then finish its turn. Repeating the identical request with the same directory returns `duplicate: true`, including after completion; changing the payload or target requires a new directory. There is one event, with a stable UUID, and no automatic retry. A lost acknowledgement becomes `delivery-unknown`: inspect the native queue and thread history instead of replaying it. This avoids claiming exactly-once model execution across crashes.

Cancellation before dispatch prevents submission. After submission, cancellation deletes only the matching still-pending queue entry. A consumed event may already have started a turn; cancellation reports that limit and does not interrupt unrelated work. The timer and connection close after delivery, cancellation or failure. Killing the host or restarting the machine does not produce a durable scheduler.

The state directory retains the immutable request/payload hash, worker PID and command, stdout/stderr, receipt, cancellation records, and original JSON-RPC messages per connection. `queued` means acceptance, **not execution**. Confirm `turn/completed` and the real payload effect separately. Model/effort in the receipt are host configuration, not backend attestation.

## Installed protocol

Codex CLI 0.161.0 advertises `codex queue --thread --message --remote unix://...`. On an unloaded thread that command accepted a submission without starting a turn. The adapter therefore checks `thread/read` before arming and before dispatch and refuses unloaded or ephemeral targets. It sends `thread/queue/add` with `clientUserMessageId`, and uses `thread/queue/list` and `thread/queue/delete` for cancellation. It never resumes or creates a model thread or changes its model, effort, cwd or permissions.

The installed `codex app-server generate-json-schema --experimental` defines these versioned fields. Unix sockets require WebSocket HTTP Upgrade; `app-server proxy` only copies bytes. Node 24's standard WebSocket supplies framing through a single-use loopback-to-Unix bridge, closed to new connections after its unguessable path is consumed. No network host or remote worker is accepted. See the [official app-server transport documentation](https://developers.openai.com/codex/app-server) and [local exercise record](../../../docs/research/2026-10-07-local-executor-contracts.md).
