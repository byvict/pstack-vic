import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertToolMethod, captureGrokTools, toolEvents } from "./grok-tools.ts";
import { innerCommand, innerProbeScript } from "./recipes.ts";

const start = { at: 1_000, update: { sessionUpdate: "tool_call", toolCallId: "call-1", title: "run_terminal_command", rawInput: { command: "node probe.cjs", timeout: 450_000 } } };
const end = { at: 301_074, update: { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "failed", rawOutput: { timed_out: true } } };

test("tool evidence separates a real timeout from a violated recipe", () => {
  assert.deepEqual(assertToolMethod([start, end], "node probe.cjs", 450_000), {
    requestedTimeoutMs: 450_000, toolElapsedMs: 300_074, terminalStatus: "failed", timedOut: true,
  });
  assert.throws(() => assertToolMethod([start, start, end], "node probe.cjs", 450_000), /exactly one/);
  assert.throws(() => assertToolMethod([start, end], "another command", 450_000), /changed the fixed/);
  assert.throws(() => assertToolMethod([start, end], "node probe.cjs", 600_000), /declared tool timeout/);
  assert.throws(() => assertToolMethod([start], "node probe.cjs", 450_000), /terminal tool event/);
});

test("native CLI and ACP updates preserve the same tool method and timestamps", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pstack-tool-evidence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "probe"); mkdirSync(directory);
  const native = join(root, "sessions", encodeURIComponent(directory), "session-1"); mkdirSync(native, { recursive: true });
  const nativeFrames = [start, end].map((event) => ({ method: "session/update", params: { update: event.update, _meta: { agentTimestampMs: event.at } } }));
  writeFileSync(join(native, "updates.jsonl"), nativeFrames.map((event) => JSON.stringify(event)).join("\n"));
  const copied = captureGrokTools(directory, "session-1", root);
  assert.deepEqual(toolEvents(copied, "cli"), [start, end]);
  assert.equal(statSync(copied).mode & 0o777, 0o600);
  assert.throws(() => captureGrokTools(directory, "session-1", root), /EEXIST/);
  assert.throws(() => captureGrokTools(directory, "..", root), /safe session/);
  const acp = join(root, "acp.jsonl");
  writeFileSync(acp, [start, end].map((event) => JSON.stringify({ kind: "tool", at: new Date(event.at).toISOString(), update: event.update })).join("\n"));
  assert.deepEqual(toolEvents(acp, "grok-acp"), [start, end]);
  // A parse failure cannot erase the original evidence just copied from the CLI.
  rmSync(copied);
  writeFileSync(join(native, "updates.jsonl"), "malformed native output");
  captureGrokTools(directory, "session-1", root);
  assert.throws(() => toolEvents(copied, "cli"));
  assert.equal(readFileSync(copied, "utf8"), "malformed native output");
});

test("the fixed probe command quotes paths without invoking shell substitutions", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pstack-probe-quote-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "quote' dollar$(exit 71) `exit 72`"); mkdirSync(directory);
  writeFileSync(join(directory, "probe.cjs"), innerProbeScript(1));
  assert.match(execFileSync("/bin/sh", ["-c", innerCommand(directory)], { encoding: "utf8" }), /PSTACK_INNER_TIMEOUT_COMPLETED/);
});
