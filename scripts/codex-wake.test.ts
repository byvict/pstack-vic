import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import type { Duplex } from "node:stream";
import { join } from "node:path";
import { armWake, cancelWake, wakeStatus, type WakeRequest } from "../skills/poteto-mode/scripts/codex-wake.ts";

const THREAD = "11111111-1111-4111-8111-111111111111";
let root: string;
let server: Server;
const connections = new Set<Duplex>();
let request: WakeRequest;
async function terminal(state: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const status = wakeStatus(state);
    const receipt = JSON.parse(readFileSync(join(state, "receipt.json"), "utf8"));
    if (["queued", "cancelled", "failed", "delivery-unknown"].includes(receipt.status)) return status;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error("Wake did not reach a terminal receipt");
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "pstack-wake-test-"));
  const socket = join(root, "host.sock");
  writeFileSync(socket + ".thread", JSON.stringify({ id: THREAD, status: { type: "idle" }, ephemeral: false, model: "gpt-6.1-sol", reasoningEffort: "xhigh", cwd: root }));
  server = createServer();
  server.on("upgrade", (upgrade, stream) => {
    const key = upgrade.headers["sec-websocket-key"];
    assert.equal(typeof key, "string");
    const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    stream.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    connections.add(stream); stream.once("close", () => connections.delete(stream));
    stream.on("error", () => {});
    const frame = (opcode: number, bytes: Buffer): void => {
      const header = Buffer.alloc(bytes.length < 126 ? 2 : 4);
      header[0] = 0x80 | opcode; header[1] = bytes.length < 126 ? bytes.length : 126;
      if (bytes.length >= 126) header.writeUInt16BE(bytes.length, 2);
      stream.write(Buffer.concat([header, bytes]));
    };
    const reply = (id: number, result: unknown): void => frame(1, Buffer.from(JSON.stringify({ id, result })));
    let buffer = Buffer.alloc(0);
    stream.on("data", (bytes: Buffer) => {
      buffer = Buffer.concat([buffer, bytes]);
      while (buffer.length >= 2) {
        const opcode = buffer[0]! & 15;
        let length = buffer[1]! & 127, offset = 2;
        if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
        assert.notEqual(length, 127);
        if (buffer.length < offset + 4 + length) return;
        const mask = buffer.subarray(offset, offset + 4); offset += 4;
        const data = Buffer.from(buffer.subarray(offset, offset + length));
        for (let i = 0; i < data.length; i++) data[i] = data[i]! ^ mask[i % 4]!;
        buffer = buffer.subarray(offset + length);
        if (opcode === 8) { frame(8, data); stream.end(); return; }
        if (opcode === 9) { frame(10, data); continue; }
        const line = data.toString(); const m = JSON.parse(line);
        appendFileSync(socket + ".calls", line + "\n");
        if (m.method === "initialized") continue;
        if (m.method === "initialize") { reply(m.id, { userAgent: "fixture" }); continue; }
        if (m.method === "thread/read") { reply(m.id, { thread: JSON.parse(readFileSync(socket + ".thread", "utf8")) }); continue; }
        if (m.method === "thread/queue/add") {
          const item = { id: "queued-1", clientUserMessageId: m.params.clientUserMessageId, input: m.params.input };
          appendFileSync(socket + ".effects", JSON.stringify(m.params) + "\n"); writeFileSync(socket + ".queue", JSON.stringify(item));
          if (existsSync(socket + ".disconnect")) { stream.destroy(); return; }
          reply(m.id, { queuedSubmission: item }); continue;
        }
        if (m.method === "thread/queue/list") { reply(m.id, { data: existsSync(socket + ".queue") ? [JSON.parse(readFileSync(socket + ".queue", "utf8"))] : [], nextCursor: null }); continue; }
        if (m.method === "thread/queue/delete") { const deleted = existsSync(socket + ".queue"); if (deleted) rmSync(socket + ".queue"); reply(m.id, { deleted }); continue; }
        assert.fail(`Unexpected method ${m.method}`);
      }
    });
  });
  await new Promise<void>((done) => server.listen(socket, done));
  request = { threadId: THREAD, socket, delayMs: 300, payload: "Read the assigned sentinel and report it." };
});
afterEach(async () => {
  await new Promise((done) => setTimeout(done, 100));
  for (const stream of connections) stream.destroy();
  await new Promise<void>((done) => server.close(() => done()));
  rmSync(root, { recursive: true, force: true });
});

describe("local Codex wake", () => {
  it("arms, queues exactly one event to the exact thread, and deduplicates later arms", async () => {
    const state = join(root, "job");
    const first = await armWake(state, request);
    assert.equal((await armWake(state, request)).duplicate, true);
    const end = await terminal(state);
    assert.equal((await armWake(state, request)).duplicate, true);
    const effects = readFileSync(request.socket + ".effects", "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(effects.length, 1);
    assert.equal(effects[0].threadId, THREAD);
    assert.equal(effects[0].clientUserMessageId, first.eventId);
    assert.equal(effects[0].input[0].text, `[pstack local wake ${first.eventId}]\nRead the assigned sentinel and report it.`);
    assert.equal(end.threadId, THREAD);
    await assert.rejects(armWake(state, { ...request, payload: "different task" }), /another request/);
  });
  it("cancels an armed event before it can queue, without rearming it", async () => {
    const state = join(root, "job");
    await armWake(state, { ...request, delayMs: 1_000 });
    await cancelWake(state);
    await terminal(state);
    assert.equal(JSON.parse(readFileSync(join(state, "receipt.json"), "utf8")).status, "cancelled");
    assert.equal(existsSync(request.socket + ".effects"), false);
    assert.equal((await armWake(state, { ...request, delayMs: 1_000 })).duplicate, true);
  });
  it("removes only its own still-pending native queue item", async () => {
    const state = join(root, "job");
    await armWake(state, request); await terminal(state);
    const result = await cancelWake(state);
    const cancellation = JSON.parse(readFileSync(join(state, "cancellation.json"), "utf8"));
    assert.equal(cancellation.status, "cancelled");
    assert.equal(cancellation.queuedSubmissionId, "queued-1");
    assert.equal(existsSync(request.socket + ".queue"), false);
    const calls = readFileSync(request.socket + ".calls", "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(calls.find((m) => m.method === "thread/queue/delete").params, { threadId: THREAD, queuedSubmissionId: "queued-1" });
  });
  it("refuses an unloaded target instead of treating queue acceptance as wake", async () => {
    writeFileSync(request.socket + ".thread", JSON.stringify({ id: THREAD, status: { type: "notLoaded" }, ephemeral: false }));
    const state = join(root, "job");
    await assert.rejects(armWake(state, request), /not loaded/);
    assert.equal(JSON.parse(readFileSync(join(state, "receipt.json"), "utf8")).status, "failed");
    assert.equal(existsSync(request.socket + ".effects"), false);
  });
  it("does not replay an event when the host disconnects after accepting it", async () => {
    writeFileSync(request.socket + ".disconnect", "1");
    const state = join(root, "job");
    await armWake(state, request); await terminal(state);
    assert.equal(JSON.parse(readFileSync(join(state, "receipt.json"), "utf8")).status, "delivery-unknown");
    assert.equal((await armWake(state, request)).duplicate, true);
    assert.equal(readFileSync(request.socket + ".effects", "utf8").trim().split("\n").length, 1);
  });
  it("rejects a different thread identity returned by the host", async () => {
    const data = JSON.parse(readFileSync(request.socket + ".thread", "utf8")); data.id = "22222222-2222-4222-8222-222222222222";
    writeFileSync(request.socket + ".thread", JSON.stringify(data));
    await assert.rejects(armWake(join(root, "job"), request), /exact persisted thread/);
    assert.equal(existsSync(request.socket + ".effects"), false);
  });
});
