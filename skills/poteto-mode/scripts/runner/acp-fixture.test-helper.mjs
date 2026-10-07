#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const scenario = process.env.FAKE_CASE ?? "happy";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (value) => appendFileSync(process.env.FAKE_LOG, JSON.stringify(value) + "\n");
if (args[0] === "--version") process.exit(0);
if (args[0] === "models") {
  log({ kind: "preflight", pid: process.pid });
  if (process.env.FAKE_HANG_STAGE === "preflight") {
    setInterval(() => {}, 1_000);
    writeFileSync(process.env.FAKE_READY, String(process.pid));
    await new Promise(() => {});
  }
  if (scenario === "missing-model") {
    writeSync(1, "Logged in. grok-4.6\n");
  } else if (scenario === "retry-auth" && readFileSync(process.env.FAKE_LOG, "utf8").split("\n").filter(Boolean).length === 1) {
    writeSync(2, "Not logged in.\n");
  } else {
    writeSync(1, "Logged in. grok-4.7\n");
  }
  process.exit(0);
}
const profilePath = args[args.indexOf("--agent-profile") + 1];
const overlayPath = process.env.GROK_CONFIG_PATH;
const profile = readFileSync(profilePath, "utf8");
log({ kind: "started", pid: process.pid, args, profilePath, overlayPath, profile,
  overlay: readFileSync(overlayPath, "utf8"), subagents: process.env.GROK_SUBAGENTS,
  tokenInEnv: process.env.T3_MCP_BEARER_TOKEN !== undefined, endpointInEnv: process.env.PSTACK_T3_MCP_URL !== undefined,
});
let token = "";
const sessionId = "fixture-session";
const send = async (value) => {
  const text = JSON.stringify(value) + "\n";
  if (scenario === "split-frames") {
    const half = Math.floor(text.length / 2);
    writeSync(1, text.slice(0, half));
    await delay(2);
    writeSync(1, text.slice(half));
  } else writeSync(1, text);
};
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const update = (sessionUpdate, fields = {}, streamStartMs = 1, method = "session/update") => send({
  jsonrpc: "2.0", method, params: { sessionId, update: { sessionUpdate, ...fields }, _meta: { streamStartMs } },
});
const catalog = (additional = []) => {
  let tools = ["run_terminal_command", "read_file", "search_replace", "list_dir", "grep"];
  if (/^  - use_tool$/m.test(profile.split("disallowedTools:")[0])) tools.push("search_tool", "use_tool");
  if (scenario === "extra-tools") tools.push("spawn_subagent");
  if (scenario === "missing-tools") tools.pop();
  tools.push(...additional);
  return update("available_commands_update", { _meta: { tools } });
};
const keeper = setInterval(() => {}, 1_000);
const input = createInterface({ input: process.stdin });
input.on("line", async (line) => {
  const request = JSON.parse(line);
  if (!request.method) { log({ kind: "client-response", code: request.error?.code }); return; }
  const { id, method, params } = request;
  log({ kind: "request", method, ...(method === "session/set_model" ? { model: params.modelId, effort: params._meta.reasoningEffort } : {}) });
  if (process.env.FAKE_HANG_STAGE === method) {
    writeFileSync(process.env.FAKE_READY, String(process.pid));
    return;
  }
  if (process.env.FAKE_DELAY_STAGE === method) await delay(Number(process.env.FAKE_DELAY_MS));
  if (scenario === "malformed" && method === "initialize") { writeSync(1, "not JSON\n"); return; }
  if (scenario === "early-eof" && method === "initialize") { process.stdout.end(); return; }
  if (scenario === "early-exit" && method === "initialize") process.exit(3);
  if (scenario === "unknown-id" && method === "initialize") { await reply(id + 100, {}); return; }
  if (scenario === `rpc-${method}`) {
    await send({ jsonrpc: "2.0", id, error: { code: -32001, message: `Bearer ${token}` } }); return;
  }
  switch (method) {
    case "initialize":
      await reply(id, { protocolVersion: scenario === "protocol" ? 2 : 1,
        agentCapabilities: { mcpCapabilities: { http: true }, sessionCapabilities: { close: {} } } });
      if (scenario === "duplicate-id") await reply(id, {});
      return;
    case "authenticate": await reply(id, {}); return;
    case "session/new":
      token = params.mcpServers[0]?.headers?.[0]?.value?.replace(/^Bearer /, "") ?? "";
      log({ kind: "session", cwd: params.cwd, forwarded: params.mcpServers.map((server) => ({ type: server.type, name: server.name, url: server.url, headerPresent: Boolean(server.headers?.[0]?.value) })) });
      if (scenario !== "no-catalog") await catalog();
      await reply(id, { sessionId });
      return;
    case "session/set_model":
      await reply(id, { _meta: { model: { Ok: params.modelId } } }); return;
    case "session/prompt": {
      log({ kind: "prompt", text: params.prompt[0].text });
      if (scenario === "reload-replies") {
        await reply("skills-reload", { result: {} });
        await reply("workflows-reload", { result: {} });
      }
      if (scenario === "unknown-string-id") { await reply("unrecognized-reload", { result: {} }); return; }
      if (scenario === "reload-error") { await send({ jsonrpc: "2.0", id: "skills-reload", error: { code: -32000 } }); return; }
      if (scenario === "reload-invalid-result") { await reply("skills-reload", { result: "invalid" }); return; }
      if (scenario === "server-request") await send({ jsonrpc: "2.0", id: "host-request", method: "fs/read_text_file", params: { path: "/forbidden" } });
      if (scenario === "permission-request") { await send({ jsonrpc: "2.0", id: "permission", method: "session/request_permission", params: {} }); return; }
      await update("agent_message_chunk", { content: { type: "text", text: "Earlier narration" } }, 1);
      await update("response_completed", {}, 1, "_x.ai/session_notification");
      await update("tool_call", { toolCallId: "tool-1", title: "run_terminal_command", status: "in_progress", rawInput: { command: "fixture-command", timeout: 450000 } }, 1);
      await update("tool_call_update", { toolCallId: "tool-1", status: "completed", rawOutput: scenario === "secret" ? { result: `Authorization: Bearer ${token}`, other: token } : { result: "fixture-result" } }, 1);
      if (scenario === "tool-then-hang") {
        writeFileSync(process.env.FAKE_READY, String(process.pid));
        return;
      }
      if (scenario === "mcp-expansion") {
        await catalog(["t3-code__preview_status", "t3-code__preview_click", "t3-code__preview_evaluate", ...(process.env.FAKE_MCP_TOOL ? [process.env.FAKE_MCP_TOOL] : [])]);
        log({ kind: "catalog-expanded" });
      }
      if (scenario === "reload-replies") await reply("skills-reload", { result: {} });
      await update("agent_thought_chunk", { content: { type: "text", text: "Private thought" } }, 2);
      if (scenario === "drift") { await update("available_commands_update", { _meta: { tools: ["spawn_subagent"] } }); return; }
      if (scenario !== "empty-final" && scenario !== "narration-only") {
        const text = scenario === "secret" ? `FINAL ${token} ${JSON.stringify(token).slice(1, -1)} Bearer ${token}` : "FINAL_OK";
        await update("agent_message_chunk", { content: { type: "text", text: text.slice(0, 3) } }, 2);
        await update("agent_message_chunk", { content: { type: "text", text: text.slice(3) } }, 2);
        await update("response_completed", {}, 2, "_x.ai/session_notification");
      }
      if (scenario === "secret") {
        writeSync(2, "x".repeat(3_980) + token.slice(0, 3));
        await delay(2);
        writeSync(2, token.slice(3) + " " + JSON.stringify(token).slice(1, -1));
      }
      const modelUsage = scenario === "echo-only" ? {} : {
        [scenario === "wrong-model" ? "grok-4.6" : "grok-4.7-build"]: { modelCalls: 2 },
        ...(scenario === "auxiliary-model" ? { "helper-model": { modelCalls: 1 } } : {}),
      };
      await reply(id, { stopReason: scenario === "non-end-turn" ? "max_tokens" : "end_turn", _meta: { modelId: "grok-4.7", usage: {
        inputTokens: 30, cachedReadTokens: 7, cacheCreationTokens: 3, outputTokens: 4, reasoningTokens: 2, totalTokens: 34,
        modelCalls: scenario === "zero-calls" ? 0 : 2, costUsdTicks: 900, modelUsage,
      } } });
      return;
    }
    case "session/close":
      if (scenario === "close-error") { await send({ jsonrpc: "2.0", id, error: { code: -32000, message: `Bearer ${token}` } }); return; }
      await reply(id, { _meta: { "x.ai/closeOutcome": "closed" } });
      if (scenario === "self-signal") process.kill(process.pid, "SIGTERM");
      return;
  }
});
input.on("close", () => {
  if (process.env.FAKE_HANG_STAGE === "eof") writeFileSync(process.env.FAKE_READY, String(process.pid));
  if (scenario === "held-pipes") {
    const descendant = spawn("/bin/sleep", ["2"], { stdio: ["ignore", "inherit", "inherit"] });
    log({ kind: "descendant", pid: descendant.pid });
    descendant.unref();
    clearInterval(keeper);
    process.exit(0);
  }
});
