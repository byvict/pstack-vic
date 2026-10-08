#!/usr/bin/env node
// Live, isolated proof. Requires an authenticated Codex CLI, Node 24 and POSIX.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Journal, freshRoot, save } from "./verify/io.ts";
import { localSocket } from "../skills/poteto-mode/scripts/codex-local-socket.ts";
import { childEnvironment } from "../skills/poteto-mode/scripts/runner/child.ts";

const { values } = parseArgs({ options: { output: { type: "string" }, model: { type: "string" }, "working-tree": { type: "boolean" } } });
assert.ok(values.output && values.model, "Usage: node scripts/prove-codex-wake.mjs --output <new absolute directory> --model <explicit model> [--working-tree]");
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = freshRoot(values.output, repository), cwd = join(out, "program");
mkdirSync(cwd); mkdirSync(join(out, "host"));
const stop = new AbortController(), hostStop = new AbortController();
const journal = new Journal(out, stop.signal), hostJournal = new Journal(join(out, "host"), hostStop.signal);
const env = childEnvironment(), tool = join(repository, "skills/poteto-mode/scripts/codex-wake.ts");
const socketDir = `/tmp/pstack-wake-${randomUUID().slice(0, 8)}`;
mkdirSync(socketDir, { mode: 0o700 });
const socketPath = join(socketDir, "host.sock"), lossPath = join(socketDir, "loss.sock");
const states = [], messages = [], connections = new Set();
let hostProcess, connection, lossProxy, threadId, sequence = 0;
const pending = new Map();
const now = () => new Date().toISOString();
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(predicate, label, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (stop.signal.aborted) throw new Error("Proof interrupted");
    const value = await predicate(); if (value) return value;
    await pause(100);
  }
  throw new Error(`Timed out: ${label}`);
}
const command = (label, argv, working = cwd, input) => journal.text(argv, { label, cwd: working, env, input, timeoutMs: 180_000 });
const wake = async (verb, state, extra = []) => JSON.parse(await command(verb, [process.execPath, tool, verb, "--state", state, ...extra]));
function rpc(method, params) {
  const id = ++sequence, message = { id, method, params };
  appendFileSync(join(out, "rpc.jsonl"), JSON.stringify({ at: now(), direction: "sent", message }) + "\n");
  return new Promise((resolveCall, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout: ${method}`)); }, 30_000);
    pending.set(id, { resolve: resolveCall, reject, timer });
    connection.socket.send(JSON.stringify(message));
  });
}
const completed = () => messages.filter((m) => m.method === "turn/completed" && m.params.threadId === threadId);
async function turn(prompt) {
  const result = await rpc("turn/start", { threadId, input: [{ type: "text", text: prompt }] });
  return result.turn.id;
}
async function completion(id) {
  const message = await until(() => completed().find((m) => m.params.turn.id === id), `turn ${id}`);
  assert.equal(message.params.turn.status, "completed"); return message;
}
async function arm(name, delay = 30_000, socket = socketPath) {
  const state = join(cwd, name); states.push(state);
  const args = ["--thread", threadId, "--socket", socket, "--delay-ms", String(delay), "--payload", join(cwd, "payload.txt")];
  const armed = await wake("arm", state, args);
  return { state, args, eventId: armed.eventId };
}
async function terminal(state) {
  return until(() => {
    const path = join(state, "receipt.json");
    if (!existsSync(path)) return false;
    const receipt = JSON.parse(readFileSync(path));
    return ["queued", "delivery-unknown", "cancelled", "failed"].includes(receipt.status) && receipt;
  }, `terminal receipt ${state}`, 45_000);
}
function audits() { return existsSync(join(cwd, "audits.jsonl")) ? readFileSync(join(cwd, "audits.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []; }

// Forward real WebSocket frames unchanged, dropping only the real queue/add reply.
// This exercises uncertainty against the actual host, not a fake queue implementation.
async function loseAcknowledgement() {
  lossProxy = createServer((downstream) => {
    const upstream = createConnection(socketPath); connections.add(downstream); connections.add(upstream);
    for (const [one, other] of [[downstream, upstream], [upstream, downstream]]) {
      one.on("error", () => other.destroy());
      one.on("close", () => { connections.delete(one); other.destroy(); });
    }
    downstream.pipe(upstream);
    let buffer = Buffer.alloc(0), upgraded = false;
    upstream.on("data", (data) => {
      buffer = Buffer.concat([buffer, data]);
      if (!upgraded) {
        const end = buffer.indexOf("\r\n\r\n"); if (end < 0) return;
        downstream.write(buffer.subarray(0, end + 4)); buffer = buffer.subarray(end + 4); upgraded = true;
      }
      while (buffer.length >= 2) {
        let length = buffer[1] & 127, offset = 2;
        if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
        if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
        if (buffer.length < offset + length) return;
        const frame = buffer.subarray(0, offset + length); buffer = buffer.subarray(offset + length);
        if ((frame[0] & 15) === 1) {
          const message = JSON.parse(frame.subarray(offset).toString());
          if (message.result?.queuedSubmission) {
            save(join(out, "dropped-ack.json"), { at: now(), message });
            downstream.destroy(); upstream.destroy(); return;
          }
        }
        downstream.write(frame);
      }
    });
  });
  await new Promise((done) => lossProxy.listen(lossPath, done));
}

const onStop = () => { stop.abort(); hostStop.abort(); };
process.once("SIGINT", onStop); process.once("SIGTERM", onStop);
let result = { status: "running", startedAt: now() };
save(join(out, "result.json"), result);
try {
  const sha = (await command("source-head", ["git", "rev-parse", "HEAD"], repository)).trim();
  const dirty = await command("source-status", ["git", "status", "--porcelain"], repository);
  assert.ok(!dirty || values["working-tree"], "Commit the candidate or explicitly label --working-tree");
  await command("source-diff", ["git", "diff", "--binary", "HEAD"], repository);
  const sourceFiles = ["scripts/prove-codex-wake.mjs", "skills/poteto-mode/scripts/codex-wake.ts", "skills/poteto-mode/scripts/codex-local-socket.ts"];
  save(join(out, "source.json"), { repository, sha, development: Boolean(dirty), files: Object.fromEntries(sourceFiles.map((p) => [p, createHash("sha256").update(readFileSync(join(repository, p))).digest("hex")])) });
  await command("codex-version", ["codex", "--version"]);
  await command("protocol", ["codex", "app-server", "generate-json-schema", "--experimental", "--out", join(out, "protocol")]);
  await command("git-init", ["git", "init", "-q"]);
  const playbook = readFileSync(join(repository, "skills/poteto-mode/playbooks/autopilot-full.md"), "utf8");
  writeFileSync(join(cwd, "autopilot-full.md"), playbook);
  writeFileSync(join(cwd, "seed.txt"), "PSTACK_WAKE_AUDIT_20261008\n");
  writeFileSync(join(cwd, "decisions.tsv"), "owner\tstate\tside_effect\nfixture-owner\tactive\tseed.txt\n");
  writeFileSync(join(cwd, "children.tsv"), "id\texpected_runtime\tstate\n");
  save(join(cwd, "program.json"), { active: true, owner: "fixture-owner", trail: "decisions.tsv", children: "children.tsv" });
  const payload = "Authorized isolated audit fixture. Execute one audit tick: read autopilot-full.md (the candidate's upstream-derived playbook), program.json, decisions.tsv, children.tsv and seed.txt. Audit the listed owner using the real seed file as its only side effect; there are no delegated agents or PRs in this fixture. Append exactly one JSON line to audits.jsonl with eventId from the pstack local wake envelope, seed (trimmed seed.txt), owner (program.owner), active (program.active), children (0). Then finish your turn. The external controller owns rearming; do not wait, spawn agents, arm timers, or change any other files. This is a 30-second accelerated transport/lifecycle test, not a full Autopilot program.\n";
  writeFileSync(join(cwd, "payload.txt"), payload);
  hostProcess = hostJournal.run(["codex", "app-server", "--listen", `unix://${socketPath}`, "-c", 'approval_policy="never"', "-c", 'sandbox_mode="workspace-write"', "--disable", "plugins", "--disable", "hooks", "--disable", "memories", "--disable", "multi_agent"], { label: "app-server", cwd, env, timeoutMs: 600_000 });
  await until(() => existsSync(socketPath), "owned app-server socket", 20_000);
  connection = await localSocket(socketPath);
  connection.socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)); messages.push(message);
    appendFileSync(join(out, "rpc.jsonl"), JSON.stringify({ at: now(), direction: "received", message }) + "\n");
    if (pending.has(message.id)) {
      const p = pending.get(message.id); pending.delete(message.id); clearTimeout(p.timer);
      message.error ? p.reject(new Error(message.error.message)) : p.resolve(message.result);
    }
  });
  await rpc("initialize", { clientInfo: { name: "pstack-wake-proof", version: "1" }, capabilities: { experimentalApi: true } });
  connection.socket.send(JSON.stringify({ method: "initialized" }));
  const started = await rpc("thread/start", { model: values.model, cwd, approvalPolicy: "never", sandbox: "workspace-write", ephemeral: false,
    config: { model_reasoning_effort: "xhigh", features: { plugins: false, hooks: false, memories: false, multi_agent: false } } });
  threadId = started.thread.id;
  save(join(out, "session.json"), { threadId, socketPath, model: values.model, effort: "xhigh", modelEvidence: "host-configuration", acceleratedDelayMs: 30_000, productionAutopilotDelayMs: 3_600_000 });
  await completion(await turn("Authorized disposable wake test. Read seed.txt and reply READY, then end this turn. Do not write files, wait, or activate a workflow."));

  if (process.platform === "darwin") {
    const sandboxState = join(cwd, "sandbox-probe"); states.push(sandboxState);
    const probe = await journal.run(["codex", "sandbox", "-c", 'sandbox_mode="workspace-write"', "--", process.execPath, tool, "arm", "--state", sandboxState,
      "--thread", threadId, "--socket", socketPath, "--delay-ms", "60000", "--payload", join(cwd, "payload.txt")], { label: "sandbox-arm", cwd, env, timeoutMs: 30_000 });
    save(join(out, "sandbox-access.json"), { command: probe, note: "Capability observation under this host's resolved workspace sandbox; worker permissions are not widened." });
    if (existsSync(join(sandboxState, "request.json"))) { await wake("cancel", sandboxState); await terminal(sandboxState); }
  }

  const first = await arm("tick-1");
  const armedTurn = await completion(await turn("Read tick-1/receipt.json. Reply ARMED and finish this turn immediately. Do not wait, poll, or change files."));
  const firstReceipt = await terminal(first.state);
  assert.equal(firstReceipt.status, "queued");
  assert.ok(armedTurn.params.turn.completedAt * 1000 < Date.parse(firstReceipt.dispatchAt), "arming turn must complete before dispatch");
  await until(() => audits().length === 1, "first payload side effect");
  await until(() => completed().length === 3, "first wake turn completion");
  const observed = await wake("observe", first.state);
  assert.equal(observed.observation.delivery, "consumed");
  assert.equal(observed.observation.turns.length, 1);
  assert.equal(observed.observation.turns[0].status, "completed");
  assert.deepEqual(audits()[0], { eventId: first.eventId, seed: "PSTACK_WAKE_AUDIT_20261008", owner: "fixture-owner", active: true, children: 0 });
  assert.equal((await wake("arm", first.state, first.args)).duplicate, true);

  assert.equal(JSON.parse(readFileSync(join(cwd, "program.json"))).active, true);
  await loseAcknowledgement();
  const second = await arm("tick-2-lost-ack", 30_000, lossPath);
  assert.equal((await terminal(second.state)).status, "delivery-unknown");
  await until(() => audits().length === 2 && completed().length === 4, "rearmed audit with lost acknowledgement");
  const reconciled = await wake("observe", second.state);
  assert.equal(reconciled.receipt.status, "delivery-unknown");
  assert.equal(reconciled.observation.delivery, "consumed");
  assert.equal(reconciled.observation.turns.length, 1);
  assert.equal(reconciled.observation.turns[0].status, "completed");
  assert.equal((await wake("arm", second.state, second.args)).duplicate, true);
  assert.deepEqual(audits()[1], { eventId: second.eventId, seed: "PSTACK_WAKE_AUDIT_20261008", owner: "fixture-owner", active: true, children: 0 });
  const tooLate = await wake("cancel", second.state);
  assert.equal(tooLate.cancellation.status, "not-pending");

  const busyId = await turn("Run one shell command: node -e \"require('fs').writeFileSync('busy.txt','busy');setTimeout(()=>{},15000)\". After it exits, reply DONE and end the turn. Do nothing else.");
  await until(() => existsSync(join(cwd, "busy.txt")), "busy turn side effect");
  const queued = await arm("cancel-pending", 1_000);
  assert.equal((await terminal(queued.state)).status, "queued");
  assert.equal((await wake("observe", queued.state)).observation.delivery, "pending");
  assert.equal((await wake("cancel", queued.state)).cancellation.status, "cancelled");
  await completion(busyId);

  const future = await arm("cancel-timer", 3_000);
  save(join(cwd, "program.json"), { active: false, owner: "fixture-owner" });
  await wake("cancel", future.state);
  assert.equal((await terminal(future.state)).status, "cancelled");
  await pause(4_000);
  assert.equal(audits().length, 2);
  assert.equal(completed().length, 5);
  assert.deepEqual((await rpc("thread/queue/list", { threadId })).data, []);
  for (const event of [first, second]) {
    const inputs = messages.filter((m) => m.method === "item/started" && m.params.threadId === threadId && m.params.item.type === "userMessage" && m.params.item.clientId === event.eventId);
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].params.item.content[0].text, `[pstack local wake ${event.eventId}]\n${payload}`);
  }
  const hostLoss = await arm("host-loss", 60_000);
  hostStop.abort(); await hostProcess;
  assert.equal((await terminal(hostLoss.state)).status, "failed");
  result = { ...result, status: "complete", completedAt: now(), threadId, first, second, observed, reconciled, tooLate,
    assertions: ["arming turn completed before dispatch", "exact persisted thread", "two real audit effects", "explicit rearm while active", "payload unchanged", "duplicate suppressed", "lost reply reconciled without replay", "pending item deleted before consumption", "timer cancelled on stand-down", "consumed event not interrupted", "host loss reported as failure"] };
} catch (error) {
  result = { ...result, status: "failed", completedAt: now(), error: String(error), stack: error.stack };
  process.exitCode = 1;
} finally {
  // Cancellation is attempted only for events created by this invocation.
  const cleanup = [];
  for (const state of states) {
    if (!existsSync(join(state, "request.json"))) continue;
    writeFileSync(join(state, "cancel.request"), "cancel\n");
  }
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error("Proof closed")); }
  connection?.socket.close(); connection?.dispose();
  for (const stream of connections) stream.destroy();
  if (lossProxy) await new Promise((done) => lossProxy.close(done));
  hostStop.abort(); if (hostProcess) await hostProcess;
  for (const state of states) {
    const workerFile = join(state, "worker.json");
    if (!existsSync(workerFile)) continue;
    const { pid } = JSON.parse(readFileSync(workerFile));
    let alive = true;
    for (let i = 0; i < 30; i++) {
      try { process.kill(pid, 0); } catch { alive = false; break; }
      await pause(100);
    }
    cleanup.push({ state, pid, exited: !alive });
  }
  rmSync(socketDir, { recursive: true, force: true });
  if (cleanup.some((item) => !item.exited)) { result.status = "failed"; result.cleanupError = "Owned timer still alive"; process.exitCode = 1; }
  save(join(out, "result.json"), { ...result, cleanup });
  process.removeListener("SIGINT", onStop); process.removeListener("SIGTERM", onStop);
  console.log(JSON.stringify({ status: result.status, output: out, error: result.error }));
}
