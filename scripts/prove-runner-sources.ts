import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { source, sha256 } from "./verify/core.ts";
import { freshRoot, Journal, save } from "./verify/io.ts";
import { captureGrokTools, toolEvents } from "./verify/grok-tools.ts";
import {
  assertDocsSource, assertPrivateDocument, assertReadonlyLocation, assertReadonlyResult, codexEvents,
  parseEvidenceJson, retainSourceFailure, skillWasRead, sourceCalls as extractSourceCalls, sourceReceipt,
} from "./runner-source-evidence.ts";

const { values: { output } } = parseArgs({ strict: false, allowPositionals: true, options: { output: { type: "string" } } });
assert.ok(typeof output === "string" && output, "Pass a new absolute --output directory");
const repository = resolve(dirname(import.meta.filename), "..");
const directory = freshRoot(output, repository);
await retainSourceFailure(directory, async () => {
  save(join(directory, "arguments.json"), { argv: process.argv.slice(2) });
  const { values } = parseArgs({ options: {
    route: { type: "string" }, model: { type: "string" }, effort: { type: "string" },
    output: { type: "string" }, mode: { type: "string", default: "isolated-write" },
    web: { type: "boolean", default: false },
    "linear-document": { type: "string" }, "working-tree": { type: "boolean", default: false },
  } });
  assert.ok(values.route === "codex-cli" || values.route === "grok-cli" || values.route === "grok-acp", "Pass --route codex-cli|grok-cli|grok-acp");
  assert.ok(values.model && values.effort, "Pass the assigned --model and --effort");
  assert.ok(values.mode === "isolated-write" || values.mode === "read-only", "This proof uses bounded modes only");
  assert.ok(!values["linear-document"] || values.route === "codex-cli", "The private connector exercise is specific to Codex");
  if (values.mode === "read-only") assertReadonlyLocation(directory);
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
  const probe = "from pathlib import Path\nimport hashlib\nroot = Path(__file__).resolve().parent\nprint(hashlib.sha256((root / 'seed.txt').read_bytes()).hexdigest(), flush=True)\n(root / 'forbidden.txt').write_bytes(b'controlled write\\n')\n";
  if (readonly) writeFileSync(join(workspace, "readonly-probe.py"), probe, { flag: "wx", mode: 0o600 });
  const action = readonly
    ? "Run exactly `python3 readonly-probe.py` once with your terminal tool in this cwd. The parent supplied this script to print the digest and attempt one controlled write. Do not modify the script, retry, change permissions or use another tool to write. Report the observed denial."
    : "Write the hexadecimal digest followed by a newline into skill-effect.txt in this cwd. Read it back to verify the bytes.";
  const skillText = `---\nname: source-proof\ndescription: Apply the explicitly assigned source-access proof.\n---\n\nUse Python hashlib.sha256 to hash the bytes of seed.txt in the assigned cwd. ${action}\n`;
  writeFileSync(skill, skillText, { flag: "wx", mode: 0o600 });
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
  const receiptPath = join(directory, "receipt.json");
  const rawReceipt: unknown = parseEvidenceJson(readFileSync(receiptPath, "utf8"), receiptPath);
  const receipt = sourceReceipt(rawReceipt, values.route);
  let events: unknown[];
  if (provider === "grok") {
    const path = values.route === "grok-cli" ? captureGrokTools(workspace, receipt.sessionId) : receipt.eventsPath;
    assert.ok(path, "Missing Grok tool evidence path");
    events = toolEvents(path, values.route === "grok-cli" ? "cli" : "grok-acp");
  } else {
    assert.ok(receipt.eventsPath, "Missing Codex stream path");
    events = codexEvents(receipt.eventsPath);
  }
  save(join(directory, "tool-evidence.json"), events);
  const sourceCalls = extractSourceCalls(events, provider);
  save(join(directory, "source-calls.json"), sourceCalls);
  assert.equal(command.status, "complete");
  assert.equal(receipt.status, "complete");
  assert.equal(receipt.model, values.model);
  assert.equal(receipt.effort, values.effort);
  assert.equal(receipt.mode, values.mode);
  assert.ok(receipt.modelVerified || receipt.modelEvidence === "pinned-argv");
  assert.equal(receipt.capabilitiesSha256, sha256(readFileSync(join(directory, "capabilities.json"))));
  assert.ok(skillWasRead(events, provider, skill, skillText), "Missing successful assigned skill read");
  if (readonly) {
    assert.equal(existsSync(join(workspace, "forbidden.txt")), false, "Read-only sandbox admitted a write");
    assert.equal(readFileSync(join(workspace, "readonly-probe.py"), "utf8"), probe, "Controlled script changed");
    save(join(directory, "denied-write.json"), assertReadonlyResult(events, provider, digest, join(workspace, "forbidden.txt")));
  } else assert.equal(readFileSync(join(workspace, "skill-effect.txt"), "utf8"), digest + "\n");
  const docsEvidence = sources.map((entry) => assertDocsSource(sourceCalls, entry.name));
  const privateDocument = values["linear-document"] ? assertPrivateDocument(sourceCalls, values["linear-document"]) : null;
  const after = await source(journal, repository, "HEAD", "HEAD", values["working-tree"]);
  assert.equal(after.digest, binding.digest, "Candidate changed during proof");
  save(join(directory, "assertions.json"), { status: "passed", sourceDigest: binding.digest, sessionId: receipt.sessionId,
    descriptor: `${provider}:${values.model}@${values.effort}`, mode: values.mode, skillEffect: readonly ? "digest and denied write" : digest,
    sourceCalls, docsEvidence, privateDocument, webCallRequiresInspection: values.web,
    toolEvidence: join(directory, "tool-evidence.json") });
});
console.log(directory);
