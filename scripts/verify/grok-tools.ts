import assert from "node:assert/strict";
import { copyFileSync, chmodSync, constants, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ToolEvent { at: number; update: Record<string, unknown> }
function object(value: unknown, label = "tool evidence"): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), `${label}: expected an object`);
  return Object.fromEntries(Object.entries(value));
}

/** CLI streaming-messages-json omits inner tool calls in Grok 1.0.46. Preserve
 * this probe's own native updates before parsing them; never search other sessions.
 */
export function captureGrokTools(directory: string, sessionId: string | null, grokHome = join(homedir(), ".grok")): string {
  assert.ok(sessionId && /^[A-Za-z0-9_-]{1,100}$/.test(sessionId), "Cannot locate native Grok evidence without a safe session ID");
  const original = join(grokHome, "sessions", encodeURIComponent(directory), sessionId, "updates.jsonl");
  const target = join(directory, "grok-tool-updates.jsonl");
  copyFileSync(original, target, constants.COPYFILE_EXCL);
  chmodSync(target, 0o600);
  return target;
}

export function toolEvents(path: string, transport: "cli" | "grok-acp"): ToolEvent[] {
  const events: ToolEvent[] = [];
  for (const [index, line] of readFileSync(path, "utf8").split("\n").entries()) {
    if (!line.trim()) continue;
    const label = `${path}:${index + 1}`;
    let raw: unknown;
    try { raw = JSON.parse(line); }
    catch { throw new Error(`${label}: invalid JSON`); }
    const frame = object(raw, label);
    if (transport === "grok-acp") {
      assert.ok(typeof frame.kind === "string", `${label}.kind: expected a string`);
      if (frame.kind !== "tool") continue;
      assert.ok(typeof frame.at === "string", `${label}.at: expected a timestamp string`);
      const at = Date.parse(frame.at);
      assert.ok(Number.isFinite(at), `${label}: missing ACP event timestamp`);
      events.push({ at, update: object(frame.update, `${label}.update`) });
    } else {
      if (frame.method !== "session/update") continue;
      const params = object(frame.params, `${label}.params`), update = object(params.update, `${label}.params.update`);
      assert.ok(typeof update.sessionUpdate === "string", `${label}.params.update.sessionUpdate: expected a string`);
      if (!update.sessionUpdate.startsWith("tool_call")) continue;
      const at = object(params._meta, `${label}.params._meta`).agentTimestampMs;
      assert.ok(typeof at === "number" && Number.isFinite(at), `${label}: missing native Grok event timestamp`);
      events.push({ at, update });
    }
  }
  return events;
}

export function assertToolMethod(events: ToolEvent[], command: string, requestedTimeoutMs: number): {
  requestedTimeoutMs: number; toolElapsedMs: number; terminalStatus: unknown; timedOut: boolean;
} {
  const calls = events.filter((event) => event.update.sessionUpdate === "tool_call");
  assert.equal(calls.length, 1, "Expected exactly one tool call; no preparation, warmups or retries inside the model");
  const start = calls[0];
  assert.equal(start.update.title, "run_terminal_command");
  const input = object(start.update.rawInput);
  assert.equal(input.command, command, "Model changed the fixed probe command");
  assert.equal(input.timeout, requestedTimeoutMs, "Model did not request the declared tool timeout");
  assert.ok(input.is_background === undefined || input.is_background === false, "Background work cannot prove a foreground tool duration");
  const terminal = events.filter((event) => event.update.toolCallId === start.update.toolCallId && ["completed", "failed"].includes(String(event.update.status)));
  assert.equal(terminal.length, 1, "Missing or duplicated terminal tool event");
  assert.ok(terminal[0].at >= start.at, "Invalid tool event ordering");
  return { requestedTimeoutMs, toolElapsedMs: terminal[0].at - start.at, terminalStatus: terminal[0].update.status,
    timedOut: object(terminal[0].update.rawOutput).timed_out === true };
}
