import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertDocsSource, assertPrivateDocument, assertReadonlyLocation, assertReadonlyResult, codexEvents, parseEvidenceJson, retainSourceFailure, skillWasRead, sourceCalls, sourceReceipt, terminalResults } from "./runner-source-evidence.ts";
import { toolEvents } from "./verify/grok-tools.ts";
import { isolatedEnv } from "../skills/poteto-mode/scripts/runner/isolated-env.test-helper.ts";

const digest = "a".repeat(64), forbidden = "/proof/workspace/forbidden.txt";
const output = `${digest}\nPermissionError: [Errno 1] Operation not permitted: '${forbidden}'\n`;
for (const provider of ["codex", "grok"] as const) {
  const event = (command: string, text = output, exitCode = 1): unknown => provider === "codex"
    ? { type: "item.completed", item: { id: "terminal-1", type: "command_execution", command, exit_code: exitCode, aggregated_output: text } }
    : { update: { toolCallId: "terminal-1", status: "completed", rawOutput: { type: "Bash", command, exit_code: exitCode, output_for_prompt: text } } };
  test(`${provider}: requires the controlled execution and its own denial result`, () => {
    const command = provider === "codex" ? "/bin/zsh -lc 'python3 readonly-probe.py'" : "python3 readonly-probe.py";
    assert.equal(assertReadonlyResult([event(command)], provider, digest, forbidden).id, "terminal-1");
    const prose = provider === "codex" ? { type: "item.completed", item: { type: "agent_message", text: output + "python3 readonly-probe.py" } }
      : { update: { status: "completed", rawOutput: { type: "Prose", text: output + "python3 readonly-probe.py" } } };
    assert.throws(() => assertReadonlyResult([prose], provider, digest, forbidden), /one completed execution/);
    assert.throws(() => assertReadonlyResult([event("echo python3 readonly-probe.py"), prose], provider, digest, forbidden), /one completed execution/);
    assert.throws(() => assertReadonlyResult([event(command, "no denial"), prose], provider, digest, forbidden), /Missing computed digest/);
    assert.throws(() => assertReadonlyResult([event(command, output, 0)], provider, digest, forbidden), /did not fail/);
    assert.throws(() => assertReadonlyResult([event(command), event(command)], provider, digest, forbidden), /one completed execution/);
  });
}

test("read-only location rejects writable exceptions, including symlink aliases", () => {
  const root = mkdtempSync(join(tmpdir(), "source-proof-location-"));
  try {
    const writable = join(root, "temp"), outside = join(root, "temp-sibling"), alias = join(root, "alias");
    mkdirSync(writable); mkdirSync(outside); symlinkSync(writable, alias);
    assert.throws(() => assertReadonlyLocation(writable, [writable]), /writable sandbox exception/);
    assert.throws(() => assertReadonlyLocation(alias, [writable]), /writable sandbox exception/);
    assert.doesNotThrow(() => assertReadonlyLocation(outside, [writable]));
  } finally { rmSync(root, { recursive: true }); }
});

const url = "https://developers.openai.com/codex/mcp", otherUrl = "https://developers.openai.com/codex/other";
const search = JSON.stringify({ hits: [{ url }] }), markdown = "# MCP configuration\n\nConfigure Codex with an MCP server.\n";
const document = { id: "document-uuid", slugId: "short-id", content: "The assigned private document.", url: "https://linear.app/team/document/assigned-short-id" };
const receipt = { status: "complete", model: "gpt-6.1-sol", effort: "xhigh", mode: "isolated-write", modelVerified: false,
  modelEvidence: "pinned-argv", sessionId: "session-1", capabilities: { sha256: digest }, stdoutPath: "/proof/receipt.stdout", acp: { eventsPath: "/proof/receipt.events.jsonl" } };

function codexCall(id: string, tool: string, arguments_: unknown, text: string, source = "pstack_docs", result: unknown = { content: [{ type: "text", text }] }): unknown {
  return { type: "item.completed", item: { type: "mcp_tool_call", id, tool, server: source, arguments: arguments_, status: "completed", error: null, result } };
}

function grokCall(id: string, tool: string, arguments_: unknown, text: string): unknown[] {
  return [
    { update: { sessionUpdate: "tool_call", toolCallId: id, rawInput: { tool_name: `pstack_docs__${tool}`, tool_input: arguments_ } } },
    { update: { sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", rawOutput: { type: "MCP", server_name: "pstack_docs", tool_name: tool, output: { OkayOutput: text } } } },
  ];
}

test("receipt boundary validates the consumed fields without truthy coercion", () => {
  assert.equal(sourceReceipt(receipt, "codex-cli").eventsPath, "/proof/receipt.stdout");
  assert.equal(sourceReceipt(receipt, "grok-acp").eventsPath, "/proof/receipt.events.jsonl");
  assert.equal(sourceReceipt(receipt, "grok-cli").eventsPath, null);
  for (const [value, message] of [
    [null, /receipt: expected an object/],
    [{ ...receipt, modelVerified: "false" }, /receipt.modelVerified/],
    [{ ...receipt, modelEvidence: true }, /receipt.modelEvidence/],
    [{ ...receipt, status: "success" }, /receipt.status/],
    [{ ...receipt, sessionId: {} }, /receipt.sessionId/],
    [{ ...receipt, capabilities: [] }, /receipt.capabilities/],
    [{ ...receipt, capabilities: { sha256: "bad" } }, /SHA-256/],
    [{ ...receipt, stdoutPath: 123 }, /receipt.stdoutPath/],
    [{ ...receipt, effort: null }, /receipt.effort/],
  ] as const) assert.throws(() => sourceReceipt(value, "codex-cli"), message);
  assert.throws(() => sourceReceipt({ ...receipt, acp: {} }, "grok-acp"), /receipt.acp.eventsPath/);
});

for (const provider of ["codex", "grok"] as const) {
  const call = (id: string, tool: string, args: unknown, text: string): unknown[] => provider === "codex"
    ? [codexCall(id, tool, args, text)] : grokCall(id, tool, args, text);
  const docs = (query = "Codex MCP configuration", searchText = search, fetchUrl = url, fetchText = markdown) => [
    ...call("search", "search_openai_docs", { query }, searchText),
    ...call("fetch", "fetch_openai_doc", { url: fetchUrl }, fetchText),
  ];

  test(`${provider}: correlates assigned search, arguments, result and following fetch`, () => {
    const calls = sourceCalls(docs(), provider);
    assert.deepEqual(calls[1].arguments, { url });
    assert.deepEqual(assertDocsSource(calls, "pstack_docs"), { searchId: "search", fetchId: "fetch", requestedUrl: url,
      returnedUrl: null, identity: "unavailable-in-markdown" });
    assert.deepEqual(assertDocsSource(sourceCalls(docs(undefined, undefined, undefined, JSON.stringify({ url, content: markdown })), provider), "pstack_docs"),
      { searchId: "search", fetchId: "fetch", requestedUrl: url, returnedUrl: url, identity: "returned-url" });
  });

  test(`${provider}: rejects empty, erroneous and unrelated documentation evidence`, () => {
    for (const events of [
      docs("Weather forecast"), docs(undefined, ""), docs(undefined, "{}"), docs(undefined, '{"hits":[]}'),
      docs(undefined, '{"error":"unavailable"}'), docs(undefined, JSON.stringify({ hits: [{ url: "https://example.com/doc" }] })),
      docs(undefined, undefined, otherUrl), docs(undefined, undefined, undefined, ""),
      docs(undefined, undefined, undefined, "# MCP configuration\n\n"),
      docs(undefined, undefined, undefined, "# Error\n\nFetch failed."),
      docs(undefined, undefined, undefined, '{"error":"not found"}'),
      docs(undefined, undefined, undefined, JSON.stringify({ url: otherUrl, content: markdown })),
      docs(undefined, JSON.stringify({ hits: [{ url }], error: "permission denied" })),
      docs(undefined, undefined, undefined, JSON.stringify({ url, content: markdown, error: "permission denied" })),
      [...call("fetch", "fetch_openai_doc", { url }, markdown), ...call("search", "search_openai_docs", { query: "Codex MCP" }, search)],
    ]) assert.throws(() => assertDocsSource(sourceCalls(events, provider), "pstack_docs"));
    assert.throws(() => assertDocsSource(sourceCalls(docs(), provider), "another_source"), /Missing successful/);
  });
}

test("Codex MCP blocks require text; non-empty arrays and tool errors do not prove access", () => {
  for (const result of [
    { content: [] }, { content: [{ type: "text", text: "  " }] }, { content: [{ type: "image", data: "pixels" }] },
    { isError: true, content: [{ type: "text", text: search }] },
  ]) {
    const calls = sourceCalls([codexCall("search", "search_openai_docs", { query: "Codex MCP" }, "", "pstack_docs", result)], "codex");
    assert.throws(() => assertDocsSource(calls, "pstack_docs"));
  }
  for (const event of [null, { type: "item.completed", item: null }, codexCall("bad", "search_openai_docs", "json-looking arguments", search),
    codexCall("bad", "search_openai_docs", {}, "", "pstack_docs", { content: [{ type: "text", text: {} }] })]) {
    assert.throws(() => sourceCalls([event], "codex"), /event\[0\]/);
  }
});

test("Grok correlates only the same ID and matching tool, retaining arguments from earlier updates", () => {
  const events = grokCall("fetch", "fetch_openai_doc", { url }, markdown);
  assert.deepEqual(sourceCalls(events, "grok")[0].arguments, { url });
  const unrelated = grokCall("another", "fetch_openai_doc", { url: otherUrl }, markdown)[0];
  const calls = sourceCalls([unrelated, events[1]], "grok");
  assert.equal(calls[0].arguments, null);
  assert.throws(() => assertDocsSource(sourceCalls([...grokCall("search", "search_openai_docs", { query: "Codex MCP" }, search), ...[unrelated, events[1]]], "grok"), "pstack_docs"), /fetch.arguments/);
  assert.throws(() => sourceCalls([grokCall("fetch", "search_openai_docs", { query: "Codex MCP" }, search)[0], events[1]], "grok"), /does not match input/);
  assert.throws(() => sourceCalls([events[0], grokCall("fetch", "fetch_openai_doc", { url: otherUrl }, markdown)[0], events[1]], "grok"), /conflicting Grok input/);
  assert.throws(() => sourceCalls(grokCall("bad", "fetch_openai_doc", [], markdown), "grok"), /tool_input/);
});

test("private Codex document requires returned identity and document content", () => {
  const calls = (args: unknown = { id: "document-uuid" }, payload: unknown = document, source = "codex_apps") => sourceCalls([
    codexCall("private", "linear.get_document", args, JSON.stringify(payload), source),
  ], "codex");
  assert.deepEqual(assertPrivateDocument(calls(), "document-uuid"), { callId: "private", requested: "document-uuid", id: "document-uuid", slugId: "short-id", url: document.url });
  assert.equal(assertPrivateDocument(calls({ id: "short-id" }), "short-id").id, "document-uuid");
  for (const entries of [calls(undefined, { ...document, id: "another-document" }), calls(undefined, { ...document, content: "  " }),
    calls(undefined, { content: document.content }), calls(undefined, { error: "not found" }),
    calls(undefined, { ...document, content: "Failed to load document", error: "permission denied" }),
    calls(undefined, { ...document, isError: true }), calls(undefined, { ...document, is_error: true }),
    calls(undefined, { ...document, isError: "false" }),
    calls({ id: "another-document" }), calls(undefined, document, "another_source")]) {
    assert.throws(() => assertPrivateDocument(entries, "document-uuid"));
  }
});

test("structured and textual document identities cannot contradict each other", () => {
  const privateCalls = (text: unknown, structuredContent: unknown) => sourceCalls([
    codexCall("private", "linear.get_document", { id: "short-id" }, "", "codex_apps",
      { content: [{ type: "text", text: JSON.stringify(text) }], structuredContent }),
  ], "codex");
  assert.equal(assertPrivateDocument(privateCalls(document, document), "short-id").id, "document-uuid");
  assert.throws(() => assertPrivateDocument(privateCalls({ ...document, id: "another-uuid" }, document), "short-id"), /conflicting private document identities/);
  assert.throws(() => assertPrivateDocument(privateCalls({ ...document, slugId: "other-id" }, { ...document, id: "another-uuid" }), "short-id"), /does not match/);
  const docsCalls = sourceCalls([
    codexCall("search", "search_openai_docs", { query: "Codex MCP" }, search),
    codexCall("fetch", "fetch_openai_doc", { url }, "", "pstack_docs", {
      content: [{ type: "text", text: JSON.stringify({ url: otherUrl, content: markdown }) }], structuredContent: { url, content: markdown },
    }),
  ], "codex");
  assert.throws(() => assertDocsSource(docsCalls, "pstack_docs"), /another target/);
  const nativeDocs = sourceCalls([
    codexCall("search", "search_openai_docs", { query: "Codex MCP" }, search, "pstack_docs", { content: [{ type: "text", text: search }], structured_content: null }),
    codexCall("fetch", "fetch_openai_doc", { url }, "", "pstack_docs", { content: [{ type: "text", text: markdown }], structured_content: { url: otherUrl, content: markdown } }),
  ], "codex");
  assert.throws(() => assertDocsSource(nativeDocs, "pstack_docs"), /another target/);
  const nativePrivate = sourceCalls([codexCall("private", "linear.get_document", { id: "short-id" }, "", "codex_apps", {
    content: [{ type: "text", text: JSON.stringify(document) }], structured_content: { ...document, id: "another-uuid", slugId: "different-id" },
  })], "codex");
  assert.throws(() => assertPrivateDocument(nativePrivate, "short-id"), /does not match/);
  assert.equal(assertPrivateDocument(sourceCalls([codexCall("private", "linear.get_document", { id: "short-id" }, "", "codex_apps", {
    content: [{ type: "text", text: JSON.stringify(document) }], structured_content: null,
  })], "codex"), "short-id").id, "document-uuid");
});

test("terminal and skill evidence reject malformed fields instead of coercing them", () => {
  assert.throws(() => terminalResults([{ type: "item.completed", item: { type: "command_execution", aggregated_output: {} } }], "codex"), /aggregated_output/);
  assert.throws(() => terminalResults([{ update: { status: "completed", rawOutput: { type: "Bash", output_for_prompt: 42 } } }], "grok"), /output_for_prompt/);
  assert.throws(() => skillWasRead([{ update: { status: "completed", rawOutput: { FileContent: { absolute_path: "/skill", raw_output: {} } } } }], "grok", "/skill", "skill text"), /raw_output/);
  const malformed = [{ update: { toolCallId: "bad", status: "completed", rawOutput: { type: 42 } } }];
  assert.throws(() => sourceCalls(malformed, "grok"), /rawOutput.type/);
  assert.throws(() => terminalResults(malformed, "grok"), /rawOutput.type/);
  assert.throws(() => skillWasRead(malformed, "grok", "/skill", "skill text"), /rawOutput.type/);
  assert.equal(skillWasRead([{ update: { status: "completed", rawOutput: { FileContent: { absolute_path: "/skill", raw_output: "skill text" } } } }], "grok", "/skill", "skill text"), true);
});

test("malformed receipt and event inputs retain failure assertions and original streams", async () => {
  const root = mkdtempSync(join(tmpdir(), "source-proof-inputs-"));
  try {
    for (const [name, input, read] of [
      ["receipt-json", "{broken", (path: string) => sourceReceipt(parseEvidenceJson(readFileSync(path, "utf8"), path), "codex-cli")],
      ["receipt-shape", '{"status":"complete"}', (path: string) => sourceReceipt(parseEvidenceJson(readFileSync(path, "utf8"), path), "codex-cli")],
      ["codex-json", '{"type":"thread.started"}\n{broken', (path: string) => sourceCalls(codexEvents(path), "codex")],
      ["codex-shape", '{"type":"item.completed","item":null}', (path: string) => sourceCalls(codexEvents(path), "codex")],
      ["grok-json", "{broken", (path: string) => sourceCalls(toolEvents(path, "grok-acp"), "grok")],
      ["grok-shape", '{"kind":"tool","at":"2026-10-08T00:00:00Z","update":null}', (path: string) => sourceCalls(toolEvents(path, "grok-acp"), "grok")],
      ["grok-native-shape", '{"method":"session/update","params":{"update":{"sessionUpdate":42}}}', (path: string) => sourceCalls(toolEvents(path, "cli"), "grok")],
      ["grok-method-shape", '{"method":42,"params":{"update":{"sessionUpdate":"tool_call"}}}', (path: string) => sourceCalls(toolEvents(path, "cli"), "grok")],
    ] as const) {
      const directory = join(root, name); mkdirSync(directory);
      const path = join(directory, "input"), stderr = join(directory, "stderr");
      writeFileSync(path, input); writeFileSync(stderr, "original stderr\n");
      await assert.rejects(retainSourceFailure(directory, async () => read(path)));
      const assertions = JSON.parse(readFileSync(join(directory, "assertions.json"), "utf8"));
      assert.equal(assertions.status, "failed");
      assert.match(assertions.error, /invalid JSON|expected|Missing|AssertionError|SyntaxError/);
      assert.equal(readFileSync(path, "utf8"), input);
      assert.equal(readFileSync(stderr, "utf8"), "original stderr\n");
    }
  } finally { rmSync(root, { recursive: true }); }
});

test("proof CLI retains argument validation failure after reserving a new output directory", () => {
  const root = mkdtempSync(join(tmpdir(), "source-proof-cli-"));
  try {
    for (const [name, args, message] of [["invalid-route", ["--route", "unsupported"], /Pass --route/],
      ["invalid-option", ["--unknown-option"], /Unknown option/]] as const) {
      const directory = join(root, name), argv = [...args, "--output", directory];
      const result = spawnSync(process.execPath, [join(import.meta.dirname, "prove-runner-sources.ts"), ...argv], { encoding: "utf8" });
      assert.equal(result.status, 1);
      const assertions = JSON.parse(readFileSync(join(directory, "assertions.json"), "utf8"));
      assert.equal(assertions.status, "failed");
      assert.match(assertions.error, message);
      assert.match(result.stderr, message);
      assert.deepEqual(JSON.parse(readFileSync(join(directory, "arguments.json"), "utf8")), { argv });
    }
  } finally { rmSync(root, { recursive: true }); }
});

test("proof CLI accepts valid local evidence and retains malformed or insufficient runner streams", () => {
  const root = mkdtempSync(join(tmpdir(), "source-proof-runner-"));
  try {
    const bin = join(root, "bin"); mkdirSync(bin);
    symlinkSync("/usr/bin/git", join(bin, "git"));
    writeFileSync(join(bin, "codex"), `#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, writeSync } from "node:fs";
const out = (value) => writeSync(1, JSON.stringify(value) + "\\n");
if (process.argv[2] === "--version") { writeSync(1, "codex fixture\\n"); process.exit(0); }
if (process.argv[2] === "login") { writeSync(1, "Logged in using ChatGPT\\n"); process.exit(0); }
const skill = readFileSync(".agents/skills/source-proof/SKILL.md", "utf8");
const digest = createHash("sha256").update(readFileSync("seed.txt")).digest("hex");
writeFileSync("skill-effect.txt", digest + "\\n");
writeSync(2, "retained fixture stderr\\n");
out({ type: "thread.started", thread_id: "source-fixture" });
out({ type: "item.completed", item: { id: "read", type: "command_execution", command: "cat .agents/skills/source-proof/SKILL.md", exit_code: 0, aggregated_output: skill } });
const call = (id, tool, args, text) => out({ type: "item.completed", item: { id, type: "mcp_tool_call", server: "pstack_docs", tool, arguments: args, status: "completed", error: null, result: { content: [{ type: "text", text }], structured_content: null } } });
call("search", "search_openai_docs", { query: "Codex MCP configuration" }, ${JSON.stringify(search)});
call("fetch", "fetch_openai_doc", { url: ${JSON.stringify(url)} }, process.env.SOURCE_FIXTURE === "empty" ? "" : process.env.SOURCE_FIXTURE === "wrong-target" ? JSON.stringify({ url: ${JSON.stringify(otherUrl)}, content: ${JSON.stringify(markdown)} }) : ${JSON.stringify(markdown)});
if (process.env.SOURCE_FIXTURE === "malformed") writeSync(1, "{malformed\\n");
out({ type: "item.completed", item: { type: "agent_message", text: "Fixture complete." } });
out({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
`, { mode: 0o755 });
    for (const scenario of ["valid", "empty", "wrong-target", "malformed"]) {
      const directory = join(root, scenario);
      const result = spawnSync(process.execPath, [join(import.meta.dirname, "prove-runner-sources.ts"), "--route", "codex-cli",
        "--model", "gpt-6.1-sol", "--effort", "xhigh", "--working-tree", "--output", directory],
      { env: isolatedEnv(join(root, "home"), [bin], { SOURCE_FIXTURE: scenario }), encoding: "utf8" });
      const assertions = JSON.parse(readFileSync(join(directory, "assertions.json"), "utf8"));
      assert.equal(result.status, scenario === "valid" ? 0 : 1, result.stderr);
      assert.equal(assertions.status, scenario === "valid" ? "passed" : "failed", assertions.error);
      if (scenario === "valid") assert.equal(assertions.docsEvidence[0].identity, "unavailable-in-markdown");
      else assert.match(assertions.error, scenario === "malformed" ? /invalid JSON/ : scenario === "empty" ? /missing fetched Markdown/ : /another target/);
      assert.match(readFileSync(join(directory, "receipt.json.stdout"), "utf8"), /source-fixture/);
      assert.equal(readFileSync(join(directory, "receipt.json.stderr"), "utf8"), "retained fixture stderr\n");
      if (scenario === "malformed") assert.match(readFileSync(join(directory, "receipt.json.stdout"), "utf8"), /\{malformed/);
    }
  } finally { rmSync(root, { recursive: true }); }
});
