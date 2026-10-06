import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runInteractiveChild, stageOverlay, type InteractiveIo } from "./child.ts";
import { grokAcpCommand, grokAcpOverlay, grokAcpProfile, grokAcpTools } from "./commands.ts";
import { modelFromUsage } from "./parse-output.ts";
import {
  UsageError,
  type AcpDetail,
  type GrokAcpRequest,
  type T3Attachment,
  type LaneFailure,
  type LaneOutcome,
  type NormalizedUsage,
  type ParsedOutput,
  type PreparedAttempt,
} from "./types.ts";

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new AcpError("malformed-output", "expected an ACP object");
  return Object.fromEntries(Object.entries(value));
}

function nonempty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new AcpError("malformed-output", `invalid ACP ${field}`);
  return value;
}

class AcpError extends Error {
  readonly status: LaneFailure;
  constructor(status: LaneFailure, message: string) {
    super(message);
    this.status = status;
  }
}

export function readT3Attachment(path: string): T3Attachment {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    const config = record(value);
    if (Object.keys(config).sort().join(",") !== "bearerTokenEnv,previewTabId,schemaVersion,urlEnv" || config.schemaVersion !== 1) throw new Error();
    const urlEnv = nonempty(config.urlEnv, "endpoint environment reference");
    const bearerTokenEnv = nonempty(config.bearerTokenEnv, "token environment reference");
    const previewTabId = nonempty(config.previewTabId, "preview tab identifier");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(urlEnv) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(bearerTokenEnv) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(previewTabId)) throw new Error();
    return { urlEnv, bearerTokenEnv, previewTabId };
  } catch {
    throw new UsageError("T3 MCP configuration requires schemaVersion 1, urlEnv, bearerTokenEnv, and a safe previewTabId");
  }
}

function secretRedactor(secrets: readonly string[]): (value: string) => string {
  const known = secrets.filter((secret) => secret.length > 0);
  const variants = [...new Set(known.flatMap((secret) => [
    secret,
    JSON.stringify(secret).slice(1, -1),
    encodeURIComponent(secret),
    Array.from(secret).map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""),
  ]))].sort((a, b) => b.length - a.length);
  const escaped = known.map((secret) => new RegExp(secret.split("").map((character) => {
    const literal = character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const json = JSON.stringify(character).slice(1, -1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const hex = character.charCodeAt(0).toString(16).padStart(4, "0");
    return `(?:${literal}|${json}|\\\\u${hex})`;
  }).join(""), "gi"));
  return (value) => {
    let safe = value;
    for (const secret of escaped) safe = safe.replace(secret, "[REDACTED]");
    for (const secret of variants) safe = safe.split(secret).join("[REDACTED]");
    return safe.replace(/Authorization\s*:\s*[^\r\n]+/gi, "Authorization: [REDACTED]").replace(/\bBearer\s+[^\s"'\\,}\]\[]+/gi, "Bearer [REDACTED]");
  };
}

interface HttpMcpServer {
  readonly type: "http";
  readonly name: string;
  readonly url: string;
  readonly headers: readonly { readonly name: "Authorization"; readonly value: string }[];
}

function resolveServers(attachment: T3Attachment | null, source: NodeJS.ProcessEnv): readonly HttpMcpServer[] {
  if (attachment === null) return [];
  const reference = attachment;
  return [(() => {
    const endpoint = source[reference.urlEnv];
    const token = source[reference.bearerTokenEnv];
    if (token === undefined || token.trim().length === 0) throw new AcpError("unauthenticated", `MCP token environment reference ${reference.bearerTokenEnv} is unset`);
    if (endpoint === undefined || endpoint.trim().length === 0) throw new AcpError("child-failed", `MCP endpoint environment reference ${reference.urlEnv} is unset`);
    let url: URL;
    try { url = new URL(endpoint); } catch { throw new AcpError("child-failed", "invalid MCP endpoint URL"); }
    if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw new AcpError("child-failed", "MCP endpoint must be HTTP(S) on loopback without credentials, query, or fragment");
    return { type: "http", name: "t3-code", url: url.href, headers: [{ name: "Authorization", value: `Bearer ${token}` }] };
  })()];
}

type SessionEvent =
  | { readonly kind: "catalog"; readonly sessionId: string; readonly tools: readonly string[] }
  | { readonly kind: "text"; readonly sessionId: string; readonly streamStart: number; readonly text: string }
  | { readonly kind: "generation-complete"; readonly sessionId: string }
  | { readonly kind: "tool"; readonly sessionId: string }
  | { readonly kind: "ignored" };

type RpcEnvelope =
  | { readonly kind: "reply"; readonly id: number; readonly result: unknown }
  | { readonly kind: "error"; readonly id: number; readonly code: number }
  | { readonly kind: "request"; readonly id: string | number; readonly method: string }
  | { readonly kind: "event"; readonly event: SessionEvent };

function decodeEvent(method: string, params: unknown): SessionEvent {
  if (method !== "session/update" && method !== "_x.ai/session_notification") return { kind: "ignored" };
  const data = record(params);
  const sessionId = nonempty(data.sessionId, "notification sessionId");
  const update = record(data.update);
  const type = nonempty(update.sessionUpdate, "sessionUpdate");
  switch (type) {
    case "available_commands_update": {
      const tools = record(update._meta).tools;
      if (!Array.isArray(tools) || tools.some((tool: unknown) => typeof tool !== "string")) throw new AcpError("malformed-output", "invalid effective tool catalog");
      return { kind: "catalog", sessionId, tools: tools.map((tool: unknown) => nonempty(tool, "tool name")) };
    }
    case "agent_message_chunk": {
      const content = record(update.content);
      if (content.type !== "text") return { kind: "ignored" };
      if (typeof content.text !== "string") throw new AcpError("malformed-output", "invalid assistant text chunk");
      const streamStart = record(data._meta).streamStartMs;
      if (typeof streamStart !== "number" || !Number.isFinite(streamStart)) throw new AcpError("malformed-output", "assistant generation lacks streamStartMs");
      return { kind: "text", sessionId, streamStart, text: content.text };
    }
    case "response_completed": return { kind: "generation-complete", sessionId };
    case "tool_call":
    case "tool_call_update":
    case "tool_call_delta_chunk": return { kind: "tool", sessionId };
    default: return { kind: "ignored" };
  }
}

function decodeEnvelope(value: unknown): RpcEnvelope {
  const data = record(value);
  if (data.jsonrpc !== "2.0") throw new AcpError("malformed-output", "unsupported ACP RPC envelope");
  if (typeof data.method === "string") {
    if ("result" in data || "error" in data) throw new AcpError("malformed-output", "ambiguous ACP RPC envelope");
    if ("id" in data) {
      if (typeof data.id !== "string" && typeof data.id !== "number") throw new AcpError("malformed-output", "invalid ACP request ID");
      return { kind: "request", id: data.id, method: data.method };
    }
    return { kind: "event", event: decodeEvent(data.method, data.params) };
  }
  if (typeof data.id !== "number" || !Number.isSafeInteger(data.id)) throw new AcpError("malformed-output", "invalid ACP reply ID");
  if (("result" in data) === ("error" in data)) throw new AcpError("malformed-output", "ACP reply requires one result or error");
  if ("error" in data) {
    const code = record(data.error).code;
    if (typeof code !== "number") throw new AcpError("malformed-output", "invalid ACP error code");
    return { kind: "error", id: data.id, code };
  }
  return { kind: "reply", id: data.id, result: data.result };
}

class AcpRpc {
  private sequence = 0;
  private buffer = "";
  private readonly decoder = new TextDecoder();
  private readonly pending = new Map<number, { readonly method: string; readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }>();
  private failure: Error | null = null;
  private readonly io: InteractiveIo;
  private readonly receive: (event: SessionEvent) => void;
  private readonly onData: (chunk: Buffer) => void;
  private readonly onEnd: () => void;
  private readonly onError: () => void;

  constructor(io: InteractiveIo, receive: (event: SessionEvent) => void) {
    this.io = io;
    this.receive = receive;
    this.onData = (chunk) => {
      this.buffer += this.decoder.decode(chunk, { stream: true });
      let newline = this.buffer.indexOf("\n");
      while (newline >= 0 && this.failure === null) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (line.length > 0) {
          try { this.accept(decodeEnvelope(JSON.parse(line))); }
          catch (error) { this.fail(error instanceof AcpError ? error : new AcpError("malformed-output", "invalid ACP JSON frame")); }
        }
        newline = this.buffer.indexOf("\n");
      }
    };
    this.onEnd = () => this.fail(new AcpError("child-failed", "ACP stdout ended before the exchange completed"));
    this.onError = () => this.fail(new AcpError("child-failed", "ACP stdout failed"));
    io.stdout.on("data", this.onData);
    io.stdout.once("end", this.onEnd);
    io.stdout.once("close", this.onEnd);
    io.stdout.once("error", this.onError);
  }

  private fail(error: Error): void {
    if (this.failure !== null) return;
    this.failure = error;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  private accept(envelope: RpcEnvelope): void {
    switch (envelope.kind) {
      case "event": this.receive(envelope.event); return;
      case "request": {
        this.io.write(`${JSON.stringify({ jsonrpc: "2.0", id: envelope.id, error: { code: -32601, message: "Client request unsupported" } })}\n`).catch(() => this.fail(new AcpError("child-failed", "ACP client response write failed")));
        if (envelope.method === "session/request_permission") this.fail(new AcpError("child-failed", "unexpected ACP permission request"));
        return;
      }
      case "reply":
      case "error": {
        const request = this.pending.get(envelope.id);
        if (request === undefined) throw new AcpError("malformed-output", "unknown or duplicate ACP reply ID");
        this.pending.delete(envelope.id);
        if (envelope.kind === "error") request.reject(new AcpError(request.method === "authenticate" ? "unauthenticated" : request.method === "session/set_model" ? "unavailable-model" : "child-failed", `${request.method} RPC error ${envelope.code}`));
        else request.resolve(envelope.result);
        return;
      }
    }
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (this.failure !== null) throw this.failure;
    const id = ++this.sequence;
    const result = new Promise<unknown>((resolve, reject) => this.pending.set(id, { method, resolve, reject }));
    result.catch(() => undefined);
    try { await this.io.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`); }
    catch { this.fail(new AcpError("child-failed", `${method} write failed`)); }
    return result;
  }

  check(): void { if (this.failure !== null) throw this.failure; }

  dispose(): void {
    this.fail(new AcpError("child-failed", "ACP exchange closed"));
    this.io.stdout.off("data", this.onData);
    this.io.stdout.off("end", this.onEnd);
    this.io.stdout.off("close", this.onEnd);
    this.io.stdout.off("error", this.onError);
  }
}

function usageNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new AcpError("malformed-output", `invalid ACP usage ${field}`);
  return value;
}

function terminalOutput(value: unknown, text: string, sessionId: string, acp: AcpDetail, requestedModel: string): ParsedOutput {
  const result = record(value);
  acp.stopReason = nonempty(result.stopReason, "stopReason");
  if (acp.stopReason !== "end_turn") throw new AcpError("malformed-output", "ACP prompt did not end_turn");
  if (text.trim().length === 0) throw new AcpError("malformed-output", "ACP prompt has no final assistant generation");
  const metadata = record(result._meta);
  const cumulative = record(metadata.usage);
  const models = record(cumulative.modelUsage);
  const observed = Object.keys(models);
  acp.observedModels = observed;
  const reportedModel = modelFromUsage(models, "grok", requestedModel);
  if (reportedModel === null || (usageNumber(cumulative.modelCalls, "modelCalls") ?? 0) <= 0 || (usageNumber(record(models[reportedModel]).modelCalls, "modelUsage.modelCalls") ?? 0) <= 0) throw new AcpError("malformed-output", "ACP result lacks served-model call evidence");
  const usage: NormalizedUsage = {
    inputTokens: usageNumber(cumulative.inputTokens, "inputTokens"),
    cachedInputTokens: usageNumber(cumulative.cachedReadTokens, "cachedReadTokens"),
    cacheCreationInputTokens: usageNumber(cumulative.cacheCreationTokens, "cacheCreationTokens"),
    outputTokens: usageNumber(cumulative.outputTokens, "outputTokens"),
    reasoningTokens: usageNumber(cumulative.reasoningTokens, "reasoningTokens"),
    totalTokens: usageNumber(cumulative.totalTokens, "totalTokens"),
  };
  return { text, sessionId, reportedModel, usage, costUsd: null };
}

export function grokAcpExecution(request: GrokAcpRequest, source: NodeJS.ProcessEnv): {
  readonly command: ReturnType<typeof grokAcpCommand>;
  readonly environment: NodeJS.ProcessEnv;
  readonly sanitize: (value: string) => string;
  readonly acp: AcpDetail;
  readonly attempt: PreparedAttempt;
} {
  const environment: NodeJS.ProcessEnv = { ...source, GROK_SUBAGENTS: "0" };
  const sanitize = secretRedactor(request.t3 === null ? [] : [source[request.t3.bearerTokenEnv] ?? ""]);
  if (request.t3 !== null) { delete environment[request.t3.bearerTokenEnv]; delete environment[request.t3.urlEnv]; }
  let servers: readonly HttpMcpServer[];
  try { servers = resolveServers(request.t3, source); } catch (error) { throw new UsageError(sanitize(error instanceof AcpError ? error.message : "invalid T3 MCP references")); }
  const acp: AcpDetail = {
    stage: "preflight", sessionId: null, stopReason: null, observedModels: [], effectiveTools: [], shutdownIntent: null,
    grokSandbox: "off", mcpScope: request.t3 === null ? "none" : "configured-and-forwarded", attachment: request.t3, closeOutcome: null,
  };
  const command = grokAcpCommand("<private-agent-profile>");
  const attempt: PreparedAttempt = async (context): Promise<LaneOutcome> => {
    let directory: string | null = null;
    try {
      const staged = stageOverlay(context.environment, grokAcpOverlay());
      directory = staged.directory;
      const profilePath = join(directory, "lane-profile.md");
      writeFileSync(profilePath, grokAcpProfile(servers.length > 0), { encoding: "utf8", mode: 0o600 });
      const invocation = grokAcpCommand(profilePath);
      context.evidence.argv = [context.executable, ...invocation.args];
      const catalogs = new Map<string, readonly string[]>();
      let sessionId: string | null = null;
      let currentGeneration: { readonly streamStart: number; text: string } | null = null;
      let finalText = "";
      const expected = [...grokAcpTools(servers.length > 0)].sort();
      const checkCatalog = (tools: readonly string[]): void => {
        acp.effectiveTools = tools.map(sanitize);
        if (tools.length !== expected.length || [...tools].sort().some((tool, index) => tool !== expected[index])) throw new AcpError("child-failed", "ACP effective tool catalog does not match the assigned profile");
      };
      const result = await runInteractiveChild({
        executable: context.executable, spec: invocation, cwd: request.cwd, env: staged.env, context, evidence: context.evidence,
        body: async (io) => {
          const rpc = new AcpRpc(io, (event) => {
            if (event.kind === "ignored") return;
            if (event.kind === "catalog") {
              catalogs.set(event.sessionId, event.tools);
              if (event.sessionId === sessionId) checkCatalog(event.tools);
              return;
            }
            if (event.sessionId !== sessionId || acp.stage !== "prompt") return;
            switch (event.kind) {
              case "tool": currentGeneration = null; finalText = ""; return;
              case "text":
                if (currentGeneration === null || currentGeneration.streamStart !== event.streamStart) {
                  currentGeneration = { streamStart: event.streamStart, text: "" };
                  finalText = "";
                }
                currentGeneration.text += event.text;
                return;
              case "generation-complete":
                if (currentGeneration !== null) finalText = currentGeneration.text;
                return;
            }
          });
          try {
            acp.stage = "initialize";
            const initialize = record(await rpc.request("initialize", { protocolVersion: 1, clientInfo: { name: "pstack-runner", version: "1" }, clientCapabilities: {}, _meta: { clientType: "extension" } }));
            if (initialize.protocolVersion !== 1) throw new AcpError("child-failed", "unsupported ACP protocol version");
            const capabilities = record(initialize.agentCapabilities);
            if (servers.length > 0 && record(capabilities.mcpCapabilities).http !== true) throw new AcpError("child-failed", "ACP server does not support HTTP MCP");
            if (!("close" in record(capabilities.sessionCapabilities))) throw new AcpError("child-failed", "ACP server does not support session/close");
            acp.stage = "authenticate";
            await rpc.request("authenticate", { methodId: "cached_token" });
            acp.stage = "session";
            sessionId = nonempty(record(await rpc.request("session/new", { cwd: request.cwd, mcpServers: servers })).sessionId, "sessionId");
            acp.sessionId = sanitize(sessionId);
            const initialCatalog = catalogs.get(sessionId);
            if (initialCatalog !== undefined) checkCatalog(initialCatalog);
            acp.stage = "model";
            const selection = record(await rpc.request("session/set_model", { sessionId, modelId: request.model, _meta: { reasoningEffort: request.effort } }));
            if (record(record(selection._meta).model).Ok !== request.model) throw new AcpError("unavailable-model", "ACP model selection did not accept the assigned model");
            acp.stage = "capability-check";
            const tools = catalogs.get(sessionId);
            if (tools === undefined) throw new AcpError("child-failed", "ACP server did not advertise its effective tool catalog");
            checkCatalog(tools);
            rpc.check();
            const checkpoint = await context.wait(0);
            if (checkpoint !== "ready") throw new AcpError(checkpoint, "ACP exchange stopped before prompting");
            acp.stage = "prompt";
            const prompt = request.t3 !== null
              ? `${context.prompt}\n\nYour parent assigned preview tab ${request.t3.previewTabId}. Use this exact tab for preview work. Do not create or operate another tab.\n`
              : context.prompt;
            const terminal = await rpc.request("session/prompt", { sessionId, prompt: [{ type: "text", text: prompt }] });
            rpc.check();
            const parsed = terminalOutput(terminal, sanitize(finalText), sanitize(sessionId), acp, request.model);
            acp.observedModels = acp.observedModels.map(sanitize);
            const safeParsed = { ...parsed, reportedModel: parsed.reportedModel === null ? null : sanitize(parsed.reportedModel) };
            acp.stage = "shutdown";
            acp.shutdownIntent = "session-complete";
            const close = rpc.request("session/close", { sessionId }).then(
              (value) => {
                try { return record(record(value)._meta)["x.ai/closeOutcome"] === "closed" ? "closed" as const : "rpc-error" as const; }
                catch { return "rpc-error" as const; }
              },
              () => "rpc-error" as const,
            );
            let closeTimer: ReturnType<typeof setTimeout> | null = null;
            try {
              acp.closeOutcome = await Promise.race([close, new Promise<"grace-elapsed">((resolveGrace) => {
                closeTimer = setTimeout(() => resolveGrace("grace-elapsed"), 1_000);
              })]);
            } finally { if (closeTimer !== null) clearTimeout(closeTimer); }
            return safeParsed;
          } finally { rpc.dispose(); }
        },
      });
      context.evidence.exitCode = result.exitCode;
      context.evidence.signal = result.signal;
      acp.observedModels = acp.observedModels.map(sanitize);
      if (acp.stopReason !== null) acp.stopReason = sanitize(acp.stopReason);
      if (result.cancelledBy !== null || result.timedOut) {
        const status = result.cancelledBy !== null ? "cancelled" : "timed-out";
        acp.shutdownIntent = status;
        return { kind: "failed", status, error: { message: status === "cancelled" ? `launcher received ${result.cancelledBy} during ACP ${acp.stage}` : `explicit deadline elapsed during ACP ${acp.stage}`, evidence: sanitize(result.stderr).trim().slice(0, 4_000) } };
      }
      if (result.outcome.kind === "failed") {
        const error = result.outcome.error;
        acp.shutdownIntent = "failure";
        return { kind: "failed", status: error instanceof AcpError ? error.status : "child-failed", error: {
          message: sanitize(error instanceof Error ? error.message : "ACP exchange failed"), evidence: sanitize(result.stderr).trim().slice(0, 4_000),
        } };
      }
      acp.stage = "finished";
      return { kind: "produced", parsed: result.outcome.value };
    } catch (error) {
      acp.shutdownIntent = "failure";
      acp.observedModels = acp.observedModels.map(sanitize);
      return { kind: "failed", status: error instanceof AcpError ? error.status : "child-failed", error: { message: sanitize(error instanceof AcpError ? error.message : "ACP launcher failed"), evidence: "" } };
    } finally { if (directory !== null) rmSync(directory, { recursive: true, force: true }); }
  };
  return { command, environment, sanitize, acp, attempt };
}
