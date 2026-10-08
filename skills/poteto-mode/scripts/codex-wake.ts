#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { childEnvironment } from "./runner/child.ts";
import { localSocket } from "./codex-local-socket.ts";

const SELF = fileURLToPath(import.meta.url);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object from the local Codex host");
  return Object.fromEntries(Object.entries(value));
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Expected a nonempty string");
  return value;
}
function save(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  renameSync(temporary, path);
}
function read(path: string): ObjectValue { return object(JSON.parse(readFileSync(path, "utf8"))); }

/** JSON-RPC uses the exact local host; the adapter never creates a model session. */
class Host {
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private sequence = 0;
  private readonly connection;
  readonly exited: Promise<void>;
  private readonly directory: string;
  constructor(socket: string, state: string) {
    this.directory = join(state, `host-${randomUUID()}`);
    mkdirSync(this.directory, { mode: 0o700 });
    const startedAt = new Date().toISOString();
    save(join(this.directory, "connection.json"), { socket, startedAt });
    this.connection = localSocket(socket);
    this.exited = this.connection.then(({ socket: ws }) => new Promise<void>((done) => {
      ws.addEventListener("message", (event) => {
        appendFileSync(join(this.directory, "received.jsonl"), String(event.data) + "\n", { mode: 0o600 });
        try {
          const message = object(JSON.parse(String(event.data)));
          if (typeof message.id !== "number") return;
          const request = this.pending.get(message.id);
          if (!request) return;
          this.pending.delete(message.id);
          if (message.error) request.reject(new Error(text(object(message.error).message)));
          else request.resolve(message.result);
        } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
      });
      ws.addEventListener("close", (event) => {
        save(join(this.directory, "connection.json"), { socket, startedAt, closedAt: new Date().toISOString(), code: event.code, reason: event.reason });
        this.fail(new Error(`Local Codex connection closed (${event.code})`)); done();
      }, { once: true });
      ws.addEventListener("error", () => this.fail(new Error("Local Codex WebSocket error")));
    }), (error) => { this.fail(error); });
  }
  private fail(error: Error): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
  private async send(message: unknown): Promise<void> {
    const { socket } = await this.connection;
    if (socket.readyState !== WebSocket.OPEN) throw new Error("Local Codex connection is closed");
    const line = JSON.stringify(message);
    appendFileSync(join(this.directory, "sent.jsonl"), line + "\n", { mode: 0o600 });
    socket.send(line);
  }
  async call(method: string, params: unknown): Promise<ObjectValue> {
    await this.connection;
    const id = ++this.sequence;
    let timer: ReturnType<typeof setTimeout>;
    const result = new Promise<unknown>((resolveRequest, reject) => {
      timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Local Codex control request timed out: ${method}`)); }, 30_000);
      this.pending.set(id, { resolve: resolveRequest, reject });
      this.send({ id, method, params }).catch(reject);
    });
    try { return object(await result); } finally { clearTimeout(timer!); }
  }
  async initialize(): Promise<void> {
    await this.call("initialize", { clientInfo: { name: "pstack-local-wake", version: "1" }, capabilities: { experimentalApi: true } });
    await this.send({ method: "initialized" });
  }
  async close(): Promise<void> {
    const connection = await this.connection.catch(() => null);
    if (!connection) return;
    connection.socket.close();
    const timer = setTimeout(connection.dispose, 1_000);
    try { await this.exited; } finally { clearTimeout(timer); connection.dispose(); }
  }
}

export interface WakeRequest {
  readonly threadId: string;
  readonly socket: string;
  readonly delayMs: number;
  readonly payload: string;
}
interface Manifest extends WakeRequest {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly armedAt: string;
  readonly dueAt: string;
  readonly payloadSha256: string;
}
interface ArmedContext {
  readonly threadId: string;
  readonly eventId: string;
  readonly pid: number;
  readonly dueAt: string;
  readonly modelEvidence: "host-configuration";
  readonly configuredModel?: string | null;
  readonly configuredEffort?: string | null;
  readonly cwd?: string | null;
}
export type WakeReceipt =
  | { readonly status: "starting" }
  | (ArmedContext & { readonly status: "armed" })
  | (ArmedContext & { readonly status: "cancelled"; readonly completedAt: string })
  | (ArmedContext & { readonly status: "dispatching"; readonly dispatchAt: string })
  | (ArmedContext & { readonly status: "queued"; readonly dispatchAt: string; readonly completedAt: string; readonly queuedSubmissionId: string })
  | (ArmedContext & { readonly status: "delivery-unknown"; readonly dispatchAt?: string; readonly completedAt: string; readonly error: string })
  | (Partial<ArmedContext> & { readonly status: "failed"; readonly completedAt: string; readonly error: string });
type QueueRemoval =
  | { readonly status: "cancelled" | "already-consumed"; readonly queuedSubmissionId: string }
  | { readonly status: "not-pending"; readonly note: string };
type CancellationReceipt = QueueRemoval & { readonly at: string };
export interface WakeStatus {
  readonly state: string;
  readonly eventId: string;
  readonly threadId: string;
  readonly receipt: WakeReceipt;
  readonly cancellation: CancellationReceipt | null;
  readonly workerCancellation: CancellationReceipt | null;
}
function timestamp(value: unknown): string {
  const result = text(value);
  if (!Number.isFinite(Date.parse(result))) throw new Error("Invalid wake timestamp");
  return result;
}
function optionalText(value: unknown): string | null | undefined {
  return value === undefined || value === null ? value : text(value);
}
function errorText(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid wake error");
  return value;
}
function armedContext(value: ObjectValue): ArmedContext {
  const threadId = text(value.threadId), eventId = text(value.eventId);
  if (!UUID.test(threadId) || !UUID.test(eventId) || typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0
    || value.modelEvidence !== "host-configuration") throw new Error("Invalid armed wake receipt");
  return { threadId, eventId, pid: value.pid, dueAt: timestamp(value.dueAt), modelEvidence: "host-configuration",
    configuredModel: optionalText(value.configuredModel), configuredEffort: optionalText(value.configuredEffort), cwd: optionalText(value.cwd) };
}
function readReceipt(state: string): WakeReceipt {
  const path = join(state, "receipt.json");
  if (!existsSync(path)) return { status: "starting" };
  const value = read(path);
  switch (value.status) {
    case "starting": return { ...value, status: "starting" };
    case "armed": return { ...value, ...armedContext(value), status: "armed" };
    case "cancelled": return { ...value, ...armedContext(value), status: "cancelled", completedAt: timestamp(value.completedAt) };
    case "dispatching": return { ...value, ...armedContext(value), status: "dispatching", dispatchAt: timestamp(value.dispatchAt) };
    case "queued": return { ...value, ...armedContext(value), status: "queued", dispatchAt: timestamp(value.dispatchAt),
      completedAt: timestamp(value.completedAt), queuedSubmissionId: text(value.queuedSubmissionId) };
    // Older workers could fail to persist dispatching before recording delivery-unknown.
    case "delivery-unknown": return { ...value, ...armedContext(value), status: "delivery-unknown",
      ...(value.dispatchAt === undefined ? {} : { dispatchAt: timestamp(value.dispatchAt) }),
      completedAt: timestamp(value.completedAt), error: errorText(value.error) };
    case "failed": return { ...value, ...(["threadId", "eventId", "pid", "dueAt", "modelEvidence", "configuredModel", "configuredEffort", "cwd"].some((key) => key in value) ? armedContext(value) : {}), status: "failed",
      completedAt: timestamp(value.completedAt), error: errorText(value.error) };
    default: throw new Error("Invalid wake receipt status");
  }
}
function readCancellation(path: string): CancellationReceipt | null {
  if (!existsSync(path)) return null;
  const value = read(path), at = timestamp(value.at);
  switch (value.status) {
    case "cancelled": case "already-consumed": return { ...value, status: value.status, queuedSubmissionId: text(value.queuedSubmissionId), at };
    case "not-pending": return { ...value, status: "not-pending", note: text(value.note), at };
    default: throw new Error("Invalid wake cancellation status");
  }
}
function saveReceipt(path: string, receipt: WakeReceipt): void { save(path, receipt); }
function saveCancellation(path: string, removal: QueueRemoval): void { save(path, { ...removal, at: new Date().toISOString() }); }
function manifest(state: string): Manifest {
  const value = read(join(state, "request.json"));
  if (value.schemaVersion !== 1 || typeof value.delayMs !== "number" || !Number.isSafeInteger(value.delayMs) || value.delayMs <= 0
    || !UUID.test(text(value.threadId)) || !UUID.test(text(value.eventId)) || !isAbsolute(text(value.socket)) || !Number.isFinite(Date.parse(text(value.dueAt)))) throw new Error("Invalid wake request");
  return { schemaVersion: 1, threadId: text(value.threadId), socket: text(value.socket), payload: text(value.payload),
    delayMs: value.delayMs, eventId: text(value.eventId), armedAt: text(value.armedAt), dueAt: text(value.dueAt), payloadSha256: text(value.payloadSha256) };
}
export function wakeStatus(state: string): WakeStatus {
  const request = manifest(state);
  return { state, eventId: request.eventId, threadId: request.threadId,
    receipt: readReceipt(state), cancellation: readCancellation(join(state, "cancellation.json")),
    workerCancellation: readCancellation(join(state, "worker-cancellation.json")) };
}

export async function armWake(state: string, request: WakeRequest): Promise<WakeStatus & { readonly duplicate?: true }> {
  if (process.platform === "win32") throw new Error("Local wake requires POSIX detached processes and a Unix socket");
  if (!isAbsolute(state) || !isAbsolute(request.socket) || !UUID.test(request.threadId)) throw new Error("Wake requires an absolute state directory, local socket path, and exact thread UUID");
  if (!Number.isSafeInteger(request.delayMs) || request.delayMs <= 0 || request.delayMs > 2_147_483_647) throw new Error("Delay must be a positive runtime-safe integer in milliseconds");
  if (!request.payload.trim()) throw new Error("Wake payload is empty");
  const payloadSha256 = createHash("sha256").update(request.payload).digest("hex");
  if (existsSync(state)) {
    const previous = manifest(state);
    if (previous.threadId !== request.threadId || previous.socket !== request.socket || previous.delayMs !== request.delayMs || previous.payloadSha256 !== payloadSha256) throw new Error("This wake state belongs to another request; use a new state directory for a new event");
    return { ...wakeStatus(state), duplicate: true };
  }
  mkdirSync(state, { mode: 0o700 }); // Exclusive reservation; concurrent arms cannot both spawn.
  save(join(state, "request.json"), { ...request, schemaVersion: 1, eventId: randomUUID(), armedAt: new Date().toISOString(), dueAt: new Date(Date.now() + request.delayMs).toISOString(), payloadSha256 });
  const stdout = openSync(join(state, "worker.stdout"), "wx", 0o600), stderr = openSync(join(state, "worker.stderr"), "wx", 0o600);
  const child = spawn(process.execPath, [SELF, "worker", "--state", state], {
    detached: true, env: childEnvironment(), stdio: ["ignore", stdout, stderr, "ipc"],
  });
  closeSync(stdout); closeSync(stderr);
  save(join(state, "worker.json"), { argv: [process.execPath, SELF, "worker", "--state", state], pid: child.pid, startedAt: new Date().toISOString() });
  await new Promise<void>((ready, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`Wake worker exited before arming (${code}); inspect ${state}`)));
    child.once("message", (message) => {
      const result = object(message);
      if (result.error) reject(new Error(text(result.error)));
      else ready();
    });
  });
  child.disconnect(); child.unref();
  return wakeStatus(state);
}

async function removePending(host: Host, request: Manifest): Promise<QueueRemoval> {
  let cursor: string | undefined;
  do {
    const page = await host.call("thread/queue/list", { threadId: request.threadId, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(page.data)) throw new Error("Invalid Codex queue page");
    for (const item of page.data.map(object)) {
      if (item.clientUserMessageId !== request.eventId) continue;
      const queuedSubmissionId = text(item.id);
      const deleted = await host.call("thread/queue/delete", { threadId: request.threadId, queuedSubmissionId });
      return { status: deleted.deleted === true ? "cancelled" : "already-consumed", queuedSubmissionId };
    }
    cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
  } while (cursor);
  return { status: "not-pending", note: "No pending event found; an already started turn is not interrupted." };
}

export async function cancelWake(state: string): Promise<WakeStatus & { readonly cancellationRequested?: true }> {
  const request = manifest(state);
  writeFileSync(join(state, "cancel.request"), "cancel\n", { mode: 0o600 });
  const receipt = readReceipt(state);
  switch (receipt.status) {
    case "armed": case "starting": return { ...wakeStatus(state), cancellationRequested: true };
    case "cancelled": case "failed": return wakeStatus(state);
    case "dispatching": case "queued": case "delivery-unknown": break;
    default: { const unexpected: never = receipt; throw new Error(`Unexpected wake receipt: ${unexpected}`); }
  }
  const host = new Host(request.socket, state);
  try {
    await host.initialize();
    const cancellation = await removePending(host, request);
    saveCancellation(join(state, "cancellation.json"), cancellation);
  } finally { await host.close(); }
  return wakeStatus(state);
}

async function work(state: string): Promise<void> {
  const lock = openSync(join(state, "worker.lock"), "wx", 0o600);
  closeSync(lock); // Retained after completion: this event is never replayed.
  const request = manifest(state), receiptPath = join(state, "receipt.json");
  const host = new Host(request.socket, state);
  let context: ArmedContext | undefined;
  let dispatch: Extract<WakeReceipt, { status: "dispatching" }> | undefined;
  let cancel = (): void => {};
  const stop = (): void => { writeFileSync(join(state, "cancel.request"), "cancel\n", { mode: 0o600 }); cancel(); };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  try {
    await host.initialize();
    const thread = object((await host.call("thread/read", { threadId: request.threadId, includeTurns: false })).thread);
    if (thread.id !== request.threadId || thread.ephemeral === true) throw new Error("Wake target must be the exact persisted thread");
    const status = object(thread.status).type;
    if (status !== "idle" && status !== "active") throw new Error("Wake target is not loaded in this local host. Resume it in the CLI on this socket before arming; queue alone cannot wake an unloaded session.");
    context = { threadId: request.threadId, eventId: request.eventId, pid: process.pid, dueAt: request.dueAt,
      configuredModel: optionalText(thread.model), configuredEffort: optionalText(thread.reasoningEffort), modelEvidence: "host-configuration", cwd: optionalText(thread.cwd) };
    saveReceipt(receiptPath, { ...context, status: "armed" });
    const waiting = new Promise<boolean>((done) => {
      let settled = false;
      const finish = (value: boolean): void => { if (settled) return; settled = true; clearTimeout(timer); watcher.close(); done(value); };
      const watcher = watch(state, () => { if (existsSync(join(state, "cancel.request"))) finish(true); });
      watcher.once("error", () => finish(true));
      const timer = setTimeout(() => finish(existsSync(join(state, "cancel.request"))), Math.max(0, Date.parse(request.dueAt) - Date.now()));
      cancel = () => finish(true);
      process.send?.({ armed: true });
      if (existsSync(join(state, "cancel.request"))) finish(true);
    });
    const cancelled = await Promise.race([waiting, host.exited.then(() => { cancel(); throw new Error("Local Codex host disconnected before the event"); })]);
    if (cancelled) { saveReceipt(receiptPath, { ...context, status: "cancelled", completedAt: new Date().toISOString() }); return; }
    // Recheck the same host before dispatch. Never resume a closed target as a side effect.
    const current = object((await host.call("thread/read", { threadId: request.threadId, includeTurns: false })).thread);
    if (!["idle", "active"].includes(String(object(current.status).type))) throw new Error("Target unloaded before the event; no message was sent");
    if (existsSync(join(state, "cancel.request"))) { saveReceipt(receiptPath, { ...context, status: "cancelled", completedAt: new Date().toISOString() }); return; }
    dispatch = { ...context, status: "dispatching", dispatchAt: new Date().toISOString() };
    saveReceipt(receiptPath, dispatch);
    const result = await host.call("thread/queue/add", { threadId: request.threadId, clientUserMessageId: request.eventId,
      input: [{ type: "text", text: `[pstack local wake ${request.eventId}]\n${request.payload}` }] });
    const queued = object(result.queuedSubmission);
    if (queued.clientUserMessageId !== request.eventId) throw new Error("Codex returned a different queue event identity");
    if (existsSync(join(state, "cancel.request"))) saveCancellation(join(state, "worker-cancellation.json"), await removePending(host, request));
    saveReceipt(receiptPath, { ...dispatch, status: "queued", queuedSubmissionId: text(queued.id), completedAt: new Date().toISOString() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failure = { error: message, completedAt: new Date().toISOString() };
    saveReceipt(receiptPath, dispatch ? { ...dispatch, ...failure, status: "delivery-unknown" } : { ...context, ...failure, status: "failed" });
    if (process.connected) process.send?.({ error: message });
    process.exitCode = 1;
  } finally {
    await host.close();
    process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop);
    if (process.connected) process.disconnect?.();
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    state: { type: "string" }, thread: { type: "string" }, socket: { type: "string" },
    "delay-ms": { type: "string" }, payload: { type: "string" }, help: { type: "boolean" },
  } });
  if (values.help) { console.log("codex-wake <arm|status|cancel> --state <absolute unique directory>\narm: --thread <UUID> --delay-ms <milliseconds> --payload <file> [--socket <local Unix socket>]\nOne event per state directory. Requires a persisted thread loaded in that local Codex host."); return; }
  const state = text(values.state);
  if (!isAbsolute(state)) throw new Error("--state must be absolute");
  const [command] = positionals;
  if (command === "worker") { await work(state); return; }
  if (command === "status") { console.log(JSON.stringify(wakeStatus(state))); return; }
  if (command === "cancel") { console.log(JSON.stringify(await cancelWake(state))); return; }
  if (command !== "arm" || positionals.length !== 1) throw new Error("Expected arm, status, or cancel; see --help");
  const configHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  console.log(JSON.stringify(await armWake(state, { threadId: text(values.thread), delayMs: Number(values["delay-ms"]),
    socket: values.socket ? resolve(values.socket) : join(configHome, "app-server-control", "app-server-control.sock"), payload: readFileSync(text(values.payload), "utf8") })));
}
if (process.argv[1] && resolve(process.argv[1]) === SELF) main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
