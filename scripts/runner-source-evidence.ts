import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { save } from "./verify/io.ts";

export function object(value: unknown, label = "evidence"): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), `${label}: expected an object`);
  return Object.fromEntries(Object.entries(value));
}

function string(value: unknown, label: string): string {
  assert.ok(typeof value === "string" && value.trim(), `${label}: expected a non-empty string`);
  return value;
}

function integer(value: unknown, label: string): number {
  assert.ok(typeof value === "number" && Number.isSafeInteger(value), `${label}: expected an integer`);
  return value;
}

export function parseEvidenceJson(text: string, label: string): unknown {
  try { return JSON.parse(text); }
  catch { throw new Error(`${label}: invalid JSON`); }
}

export function sourceReceipt(value: unknown, route: "codex-cli" | "grok-cli" | "grok-acp") {
  const receipt = object(value, "receipt");
  const status = string(receipt.status, "receipt.status");
  assert.ok(["complete", "cancelled", "unavailable-cli", "unauthenticated", "unavailable-model", "timed-out", "child-failed", "malformed-output"].includes(status), "receipt.status: unknown status");
  assert.ok(typeof receipt.modelVerified === "boolean", "receipt.modelVerified: expected a boolean");
  assert.ok(receipt.modelEvidence === null || receipt.modelEvidence === "provider-report" || receipt.modelEvidence === "pinned-argv", "receipt.modelEvidence: invalid evidence kind");
  const sessionId = receipt.sessionId === null ? null : string(receipt.sessionId, "receipt.sessionId");
  const capabilities = object(receipt.capabilities, "receipt.capabilities");
  const capabilitiesSha256 = string(capabilities.sha256, "receipt.capabilities.sha256");
  assert.match(capabilitiesSha256, /^[a-f0-9]{64}$/, "receipt.capabilities.sha256: expected a SHA-256 digest");
  const eventsPath = route === "codex-cli" ? string(receipt.stdoutPath, "receipt.stdoutPath")
    : route === "grok-acp" ? string(object(receipt.acp, "receipt.acp").eventsPath, "receipt.acp.eventsPath") : null;
  return { status, model: string(receipt.model, "receipt.model"), effort: string(receipt.effort, "receipt.effort"),
    mode: string(receipt.mode, "receipt.mode"), modelVerified: receipt.modelVerified, modelEvidence: receipt.modelEvidence,
    sessionId, capabilitiesSha256, eventsPath };
}

export function codexEvents(path: string): unknown[] {
  return readFileSync(path, "utf8").split("\n").flatMap((line, index) => line.trim()
    ? [parseEvidenceJson(line, `${path}:${index + 1}`)] : []);
}

export async function retainSourceFailure<T>(directory: string, run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (error) {
    save(join(directory, "assertions.json"), { status: "failed", error: String(error) });
    throw error;
  }
}

export interface SourceCall {
  id: string;
  source: string;
  tool: string;
  arguments: Record<string, unknown> | null;
  result: Record<string, unknown>;
  text: string;
  resultBytes: number;
}

function mcpText(result: Record<string, unknown>, label: string): string {
  assert.ok(result.isError === undefined || typeof result.isError === "boolean", `${label}.isError: expected a boolean`);
  assert.ok(Array.isArray(result.content), `${label}.content: expected an array`);
  return result.content.flatMap((raw, index) => {
    const block = object(raw, `${label}.content[${index}]`);
    string(block.type, `${label}.content[${index}].type`);
    if (block.type !== "text") return [];
    assert.ok(typeof block.text === "string", `${label}.content[${index}].text: expected a string`);
    return [block.text];
  }).join("\n");
}

function grokOutput(value: unknown, label: string): Record<string, unknown> {
  const output = object(value, label);
  if (output.type !== undefined) string(output.type, `${label}.type`);
  return output;
}

export function sourceCalls(events: unknown[], provider: "codex" | "grok"): SourceCall[] {
  const inputs = new Map<string, { tool: string; arguments: Record<string, unknown> }>();
  return events.flatMap((raw, index) => {
    const label = `event[${index}]`, event = object(raw, label);
    if (provider === "codex") {
      string(event.type, `${label}.type`);
      if (event.type !== "item.completed") return [];
      const item = object(event.item, `${label}.item`);
      string(item.type, `${label}.item.type`);
      if (item.type !== "mcp_tool_call") return [];
      const id = string(item.id, `${label}.item.id`), source = string(item.server, `${label}.item.server`), tool = string(item.tool, `${label}.item.tool`);
      const status = string(item.status, `${label}.item.status`);
      assert.ok(["in_progress", "completed", "failed"].includes(status), `${label}.item.status: invalid tool status`);
      const arguments_ = item.arguments === undefined ? null : object(item.arguments, `${label}.item.arguments`);
      if (status !== "completed") return [];
      if (item.error !== null) { object(item.error, `${label}.item.error`); return []; }
      const result = object(item.result, `${label}.item.result`), text = mcpText(result, `${label}.item.result`);
      if (result.isError === true) return [];
      return [{ id, source, tool, arguments: arguments_, result, text, resultBytes: JSON.stringify(result).length }];
    }
    const update = object(event.update, `${label}.update`), id = string(update.toolCallId, `${label}.update.toolCallId`);
    if (update.rawInput !== undefined) {
      const input = object(update.rawInput, `${label}.update.rawInput`);
      if (input.tool_name !== undefined) {
        const next = { tool: string(input.tool_name, `${label}.update.rawInput.tool_name`), arguments: object(input.tool_input, `${label}.update.rawInput.tool_input`) };
        const prior = inputs.get(id);
        assert.ok(!prior || isDeepStrictEqual(prior, next), `${label}: conflicting Grok input for ${id}`);
        inputs.set(id, next);
      }
    }
    if (update.status !== undefined) assert.ok(["pending", "in_progress", "completed", "failed"].includes(string(update.status, `${label}.update.status`)), `${label}.update.status: invalid tool status`);
    if (update.rawOutput === undefined) return [];
    const output = grokOutput(update.rawOutput, `${label}.update.rawOutput`);
    if (output.type !== "MCP") return [];
    const source = string(output.server_name, `${label}.update.rawOutput.server_name`), tool = string(output.tool_name, `${label}.update.rawOutput.tool_name`);
    const input = inputs.get(id);
    assert.ok(!input || input.tool === `${source}__${tool}`, `${label}: Grok result tool does not match input for ${id}`);
    const result = object(output.output, `${label}.update.rawOutput.output`);
    if (update.status !== "completed" || result.OkayOutput === undefined || result.ErrorOutput !== undefined) return [];
    assert.ok(typeof result.OkayOutput === "string", `${label}.update.rawOutput.output.OkayOutput: expected a string`);
    return [{ id, source, tool, arguments: input?.arguments ?? null, result, text: result.OkayOutput, resultBytes: result.OkayOutput.length }];
  });
}

function officialPage(value: unknown): string {
  const url = new URL(string(value, "documentation URL"));
  assert.ok(url.protocol === "https:" && !url.username && !url.password
    && ["developers.openai.com", "platform.openai.com", "learn.chatgpt.com"].includes(url.host), "Expected an official OpenAI documentation URL");
  url.hash = "";
  return url.href;
}

function documentResults(call: SourceCall): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];
  for (const key of ["structured_content", "structuredContent"]) {
    const value = call.result[key];
    if (value !== undefined && value !== null) results.push(object(value, `${call.id}.${key}`));
  }
  if (!results.length || call.text.trim().startsWith("{")) results.push(object(parseEvidenceJson(call.text, `${call.id}.document`), `${call.id}.document`));
  else if (call.text.trim()) assert.equal(call.text, string(results[0].content, `${call.id}.document.content`), `${call.id}: conflicting document content`);
  return results;
}

export function assertDocsSource(calls: SourceCall[], source: string) {
  const searches = calls.flatMap((call, index) => {
    if (call.source !== source || call.tool !== "search_openai_docs") return [];
    const query = string(object(call.arguments, `${call.id}.arguments`).query, `${call.id}.query`);
    if (!/\bcodex\b/i.test(query) || !/\bmcp\b/i.test(query)) return [];
    const result = object(parseEvidenceJson(call.text, `${call.id}.search result`), `${call.id}.search result`);
    assert.ok(Array.isArray(result.hits) && result.hits.length, `${call.id}: missing documentation search hits`);
    return [{ id: call.id, index, urls: result.hits.map((hit) => officialPage(object(hit, `${call.id}.hit`).url)) }];
  });
  assert.ok(searches.length, `Missing successful ${source}.search_openai_docs for Codex MCP`);
  for (const [index, call] of calls.entries()) {
    if (call.source !== source || call.tool !== "fetch_openai_doc") continue;
    const url = officialPage(object(call.arguments, `${call.id}.arguments`).url);
    const search = searches.find((entry) => entry.index < index && entry.urls.includes(url));
    if (!search) continue;
    let text = call.text, returnedUrl: string | null = null;
    if (call.result.structured_content != null || call.result.structuredContent != null || text.trim().startsWith("{")) {
      const documents = documentResults(call);
      text = string(documents[0].content, `${call.id}.fetch content`);
      for (const document of documents) {
        returnedUrl = officialPage(document.url);
        assert.equal(returnedUrl, url, `${call.id}: fetched response identifies another target`);
        assert.equal(string(document.content, `${call.id}.fetch content`), text, `${call.id}: conflicting fetched content`);
      }
    }
    assert.match(text, /^#\s+\S.+/m, `${call.id}: missing fetched Markdown document`);
    assert.ok(!/^\s*(?:#{1,6}\s*)?(?:error\b|not found\b|failed\b|no content\b)/i.test(text), `${call.id}: fetched error response`);
    assert.ok(text.replace(/^#{1,6}\s+.*$/gm, "").trim(), `${call.id}: empty fetched document body`);
    return { searchId: search.id, fetchId: call.id, requestedUrl: url, returnedUrl,
      identity: returnedUrl ? "returned-url" : "unavailable-in-markdown" };
  }
  assert.fail(`Missing successful ${source}.fetch_openai_doc on a preceding search hit`);
}

export function assertPrivateDocument(calls: SourceCall[], target: string) {
  for (const call of calls) {
    if (call.source !== "codex_apps" || call.tool !== "linear.get_document") continue;
    const requested = string(object(call.arguments, `${call.id}.arguments`).id, `${call.id}.arguments.id`);
    if (requested !== target) continue;
    const identities = documentResults(call).map((document) => {
      const id = string(document.id, `${call.id}.document.id`);
      const slugId = document.slugId === undefined ? null : string(document.slugId, `${call.id}.document.slugId`);
      const url = document.url === undefined ? null : string(document.url, `${call.id}.document.url`);
      if (url !== null) {
        const parsed = new URL(url);
        assert.ok(parsed.protocol === "https:" && parsed.host === "linear.app" && !parsed.username && !parsed.password
          && parsed.pathname.includes("/document/"), `${call.id}.document.url: expected a Linear document URL`);
      }
      string(document.content, `${call.id}.document.content`);
      assert.ok(id === target || slugId === target || url === target, `${call.id}: returned private document identity does not match ${target}`);
      return { id, slugId, url };
    });
    assert.ok(identities.every((identity) => identity.id === identities[0].id), `${call.id}: conflicting private document identities`);
    return { callId: call.id, requested, ...identities[0] };
  }
  assert.fail("Missing successful call to the assigned private Linear document");
}

export function assertReadonlyLocation(directory: string, writable = ["/tmp", "/var/tmp", tmpdir(), join(homedir(), ".grok")]): void {
  const target = realpathSync(directory);
  for (const root of writable.filter(existsSync)) {
    const path = relative(realpathSync(root), target);
    assert.ok(path === ".." || path.startsWith(`..${sep}`), `Read-only proof must be outside writable sandbox exception ${root}`);
  }
}

export function terminalResults(events: unknown[], provider: "codex" | "grok") {
  return events.flatMap((raw, index) => {
    const label = `event[${index}]`, event = object(raw, label);
    if (provider === "codex") {
      string(event.type, `${label}.type`);
      if (event.type !== "item.completed") return [];
      const item = object(event.item, `${label}.item`);
      string(item.type, `${label}.item.type`);
      if (item.type !== "command_execution") return [];
      assert.ok(typeof item.aggregated_output === "string", `${label}.item.aggregated_output: expected a string`);
      return [{ id: string(item.id, `${label}.item.id`), command: string(item.command, `${label}.item.command`),
        exitCode: integer(item.exit_code, `${label}.item.exit_code`), output: item.aggregated_output }];
    }
    const update = object(event.update, `${label}.update`);
    if (update.status !== "completed" && update.status !== "failed") return [];
    const output = grokOutput(update.rawOutput, `${label}.update.rawOutput`);
    if (output.type !== "Bash") return [];
    assert.ok(typeof output.output_for_prompt === "string", `${label}.update.rawOutput.output_for_prompt: expected a string`);
    return [{ id: string(update.toolCallId, `${label}.update.toolCallId`), command: string(output.command, `${label}.update.rawOutput.command`),
      exitCode: integer(output.exit_code, `${label}.update.rawOutput.exit_code`), output: output.output_for_prompt }];
  });
}

export function skillWasRead(events: unknown[], provider: "codex" | "grok", skill: string, text: string): boolean {
  if (provider === "codex") return terminalResults(events, provider).some((call) => call.exitCode === 0 && call.output.includes(text));
  return events.some((raw, index) => {
    const label = `event[${index}]`, update = object(object(raw, label).update, `${label}.update`);
    if (update.status !== "completed") return false;
    const output = grokOutput(update.rawOutput, `${label}.update.rawOutput`);
    if (output.FileContent === undefined) return false;
    const file = object(output.FileContent, `${label}.FileContent`);
    return string(file.absolute_path, `${label}.FileContent.absolute_path`) === skill
      && string(file.raw_output, `${label}.FileContent.raw_output`) === text;
  });
}

export function assertReadonlyResult(events: unknown[], provider: "codex" | "grok", digest: string, forbidden: string) {
  // The parent writes this fixed script before launch. Accept only its execution,
  // not assistant prose, MCP content, an echoed command or an unrelated failure.
  const attempts = terminalResults(events, provider).filter((call) => typeof call.command === "string"
    && /^(?:python3 readonly-probe\.py|\/bin\/(?:zsh|bash|sh) -lc ['"]python3 readonly-probe\.py['"])$/.test(call.command));
  assert.equal(attempts.length, 1, "Expected one completed execution of the controlled write probe");
  const attempt = attempts[0];
  assert.equal(attempt.exitCode, 1, "Controlled write probe did not fail");
  assert.ok(attempt.output.includes(digest), "Missing computed digest in terminal result");
  assert.ok(attempt.output.includes(forbidden), "Denial did not name the controlled target");
  assert.match(attempt.output, /PermissionError:.*(?:Operation not permitted|Permission denied)|OSError:.*Read-only file system/);
  return attempt;
}
