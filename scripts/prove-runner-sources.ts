import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { source, sha256 } from "./verify/core.ts";
import { freshRoot, Journal, save } from "./verify/io.ts";
import { captureGrokTools, toolEvents } from "./verify/grok-tools.ts";

const { values } = parseArgs({ options: {
  route: { type: "string" }, model: { type: "string" }, effort: { type: "string" },
  output: { type: "string" }, mode: { type: "string", default: "isolated-write" },
  web: { type: "boolean", default: false },
  "linear-document": { type: "string" }, "working-tree": { type: "boolean", default: false },
} });
assert.ok(values.route && ["codex-cli", "grok-cli", "grok-acp"].includes(values.route), "Pass --route codex-cli|grok-cli|grok-acp");
assert.ok(values.model && values.effort && values.output, "Pass the assigned --model, --effort and a new absolute --output directory");
assert.ok(values.mode === "isolated-write" || values.mode === "read-only", "This proof uses bounded modes only");
assert.ok(!values["linear-document"] || values.route === "codex-cli", "The private connector exercise is specific to Codex");
const repository = resolve(dirname(import.meta.filename), "..");
const directory = freshRoot(values.output, repository);
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => controller.abort(signal));
const journal = new Journal(directory, controller.signal);
const provider = values.route === "codex-cli" ? "codex" : "grok";
const options = { cwd: repository, label: "prepare" };
const binding = await source(journal, repository, "HEAD", "HEAD", values["working-tree"]);
save(join(directory, "source.json"), binding);
await journal.text([provider, "--version"], options);
const workspace = join(directory, "workspace");
mkdirSync(workspace, { mode: 0o700 });
await journal.text(["git", "init", "--quiet", workspace], options);
const skill = join(workspace, ".agents", "skills", "source-proof", "SKILL.md");
mkdirSync(dirname(skill), { recursive: true, mode: 0o700 });
const seed = randomBytes(24).toString("hex") + "\n";
writeFileSync(join(workspace, "seed.txt"), seed, { flag: "wx", mode: 0o600 });
const digest = sha256(seed);
const readonly = values.mode === "read-only";
const action = readonly
  ? "Print the hexadecimal digest with your terminal tool. Then attempt once to write forbidden.txt in this cwd with the terminal tool. This is a controlled sandbox denial test on a disposable directory. Report the denial; do not retry, change permissions or use another tool to write."
  : "Write the hexadecimal digest followed by a newline into skill-effect.txt in this cwd. Read it back to verify the bytes.";
writeFileSync(skill, `---\nname: source-proof\ndescription: Apply the explicitly assigned source-access proof.\n---\n\nUse Python hashlib.sha256 to hash the bytes of seed.txt in the assigned cwd. ${action}\n`, { flag: "wx", mode: 0o600 });
const sources = values.route === "grok-cli" ? [] : [{ name: "pstack_docs", url: "https://developers.openai.com/mcp", tools: ["search_openai_docs", "fetch_openai_doc"] }];
save(join(directory, "capabilities.json"), { schemaVersion: 1, skills: true, web: values.web, mcpSources: sources });
const prompt = `Fresh independent capability exercise. Assigned ${provider}:${values.model}@${values.effort}; no delegation. Work only in ${workspace}. Read and apply ${skill}. `
  + (sources.length ? "Actually call the assigned pstack_docs MCP search_openai_docs for Codex MCP configuration, then fetch_openai_doc on one returned official URL. Use the MCP tools; shell HTTP is not this source proof. " : "")
  + (values["linear-document"] ? `Also call the native Linear get_document connector on document ${values["linear-document"]}. If unavailable, report that source gap; do not extract credentials or install integrations. ` : "")
  + (values.web ? "Also use the native web search/fetch tool on the official OpenAI MCP documentation. This web call is separate from the MCP calls. " : "")
  + "Do not change user configuration. Finish with the observed effects and source operations, without copying private document content. A tool listing or your own assertion does not establish access.";
writeFileSync(join(directory, "prompt.md"), prompt, { flag: "wx", mode: 0o600 });
const command = await journal.run([
  join(repository, "skills/poteto-mode/scripts/runner/pstack-runner"),
  "--parent", "codex", "--provider", provider, "--model", values.model, "--effort", values.effort,
  "--mode", values.mode, "--transport", values.route === "grok-acp" ? "grok-acp" : "cli",
  "--cwd", workspace, "--prompt", join(directory, "prompt.md"), "--capabilities", join(directory, "capabilities.json"),
  "--output", join(directory, "result.md"), "--receipt", join(directory, "receipt.json"),
], { cwd: repository, label: "runner" });
const receipt = JSON.parse(readFileSync(join(directory, "receipt.json"), "utf8"));
let events: unknown[];
if (provider === "grok") {
  const path = values.route === "grok-cli" ? captureGrokTools(workspace, receipt.sessionId) : receipt.acp.eventsPath;
  events = toolEvents(path, values.route === "grok-cli" ? "cli" : "grok-acp");
} else {
  events = readFileSync(receipt.stdoutPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
save(join(directory, "tool-evidence.json"), events);
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}
const sourceCalls = events.flatMap((raw) => {
  const event = object(raw);
  if (provider === "codex") {
    const item = object(event.item), result = object(item.result);
    if (event.type !== "item.completed" || item.type !== "mcp_tool_call" || item.status !== "completed" || item.error !== null || result.isError === true || !Array.isArray(result.content) || result.content.length === 0) return [];
    return [{ id: item.id, source: item.server, tool: item.tool, resultBytes: JSON.stringify(result).length }];
  }
  const update = object(event.update), output = object(update.rawOutput), result = object(output.output);
  if (update.status !== "completed" || output.type !== "MCP" || typeof result.OkayOutput !== "string" || !result.OkayOutput.trim()) return [];
  return [{ id: update.toolCallId, source: output.server_name, tool: output.tool_name, resultBytes: result.OkayOutput.length }];
});
save(join(directory, "source-calls.json"), sourceCalls);
try {
  assert.equal(command.status, "complete");
  assert.equal(receipt.status, "complete");
  assert.equal(receipt.model, values.model);
  assert.equal(receipt.effort, values.effort);
  assert.equal(receipt.mode, values.mode);
  assert.ok(receipt.modelVerified || receipt.modelEvidence === "pinned-argv");
  assert.equal(receipt.capabilities.sha256, sha256(readFileSync(join(directory, "capabilities.json"))));
  const evidence = JSON.stringify(events);
  assert.ok(evidence.includes("SKILL.md"), "Missing skill read evidence");
  if (readonly) {
    assert.equal(existsSync(join(workspace, "forbidden.txt")), false, "Read-only sandbox admitted a write");
    assert.ok(evidence.includes("forbidden.txt"), "Missing controlled write attempt");
    assert.ok(/Operation not permitted|Permission denied|Read-only file system/i.test(evidence), "Missing sandbox denial result");
    assert.ok(evidence.includes(digest), "Missing computed digest in tool evidence");
  } else assert.equal(readFileSync(join(workspace, "skill-effect.txt"), "utf8"), digest + "\n");
  for (const entry of sources) for (const name of entry.tools) {
    assert.ok(sourceCalls.some((call) => call.source === entry.name && call.tool === name), `Missing successful ${entry.name}.${name} result`);
  }
  if (values["linear-document"]) assert.ok(sourceCalls.some((call) => call.source === "codex_apps" && call.tool === "linear.get_document"), "Missing successful private Linear call");
  const after = await source(journal, repository, "HEAD", "HEAD", values["working-tree"]);
  assert.equal(after.digest, binding.digest, "Candidate changed during proof");
  save(join(directory, "assertions.json"), { status: "passed", sourceDigest: binding.digest, sessionId: receipt.sessionId,
    descriptor: `${provider}:${values.model}@${values.effort}`, mode: values.mode, skillEffect: readonly ? "digest and denied write" : digest,
    sourceCalls, webCallRequiresInspection: values.web,
    toolEvidence: join(directory, "tool-evidence.json") });
} catch (error) {
  save(join(directory, "assertions.json"), { status: "failed", error: String(error) });
  throw error;
}
console.log(directory);
