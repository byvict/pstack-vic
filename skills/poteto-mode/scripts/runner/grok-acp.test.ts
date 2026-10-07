import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { clisOutsideFakes, isolatedEnv, isolateProcessEnv } from "./isolated-env.test-helper.ts";
import type { RunnerReceipt } from "./types.ts";

let scratch = "";
let bin = "";
let fixtureRoot = "";
let restore = () => {};
const launcher = join(import.meta.dirname, "pstack-runner");

before(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "pstack-acp-fixture-"));
  bin = join(fixtureRoot, "bin");
  mkdirSync(bin);
  copyFileSync(join(import.meta.dirname, "acp-fixture.test-helper.mjs"), join(bin, "grok"));
  chmodSync(join(bin, "grok"), 0o755);
  execFileSync(join(bin, "grok"), ["--version"], { env: isolatedEnv(fixtureRoot, [bin]), stdio: "ignore" });
  execFileSync(launcher, ["--help"], { env: isolatedEnv(fixtureRoot, [bin]), stdio: "ignore" });
});
after(() => { rmSync(fixtureRoot, { recursive: true, force: true }); });

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "pstack-acp-test-"));
  restore = isolateProcessEnv(scratch, [bin]);
  writeFileSync(join(scratch, "prompt.md"), "Complete the assigned fixture task.");
  writeFileSync(join(scratch, "mcp.json"), JSON.stringify({ schemaVersion: 1, urlEnv: "PSTACK_T3_MCP_URL", bearerTokenEnv: "T3_MCP_BEARER_TOKEN", previewTabId: "tab_fixture" }));
});
afterEach(() => { restore(); rmSync(scratch, { recursive: true, force: true }); });

function args(extra: readonly string[] = []): string[] {
  return ["--parent", "codex", "--provider", "grok", "--model", "grok-4.7", "--effort", "xhigh", "--transport", "grok-acp", "--mode", "full-access",
    "--prompt", join(scratch, "prompt.md"), "--cwd", scratch, "--output", join(scratch, "out.md"), "--receipt", join(scratch, "receipt.json"), ...extra];
}

interface FixtureEvent {
  readonly kind: string;
  readonly pid?: number;
  readonly profilePath?: string;
  readonly overlayPath?: string;
  readonly profile?: string;
  readonly overlay?: string;
  readonly tokenInEnv?: boolean;
  readonly endpointInEnv?: boolean;
  readonly subagents?: string;
  readonly method?: string;
  readonly text?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly code?: number;
}

function events(): FixtureEvent[] {
  const path = join(scratch, "events.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}

function assertClean(): void {
  const started = events().find((event) => event.kind === "started");
  if (started === undefined) return;
  assert.ok(started.profilePath && started.overlayPath && started.pid);
  assert.equal(existsSync(started.profilePath), false, "profile survived cleanup");
  assert.equal(existsSync(started.overlayPath), false, "overlay survived cleanup");
  assert.throws(() => process.kill(started.pid ?? 0, 0), /ESRCH/, "direct child survived cleanup");
}

async function launch(options: {
  readonly scenario?: string;
  readonly extra?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cancelStage?: string;
} = {}): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string; readonly receipt: RunnerReceipt | null }> {
  const child = spawn(launcher, args(options.extra), { env: isolatedEnv(scratch, [bin], {
    FAKE_LOG: join(scratch, "events.jsonl"), FAKE_CASE: options.scenario ?? "happy", FAKE_READY: join(scratch, "ready"),
    ...(options.cancelStage === undefined ? {} : { FAKE_HANG_STAGE: options.cancelStage }), ...options.env,
  }), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  let poll: ReturnType<typeof setInterval> | null = null;
  if (options.cancelStage !== undefined) poll = setInterval(() => {
    if (existsSync(join(scratch, "ready"))) { child.kill("SIGINT"); if (poll !== null) clearInterval(poll); }
  }, 10);
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 30_000);
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  clearTimeout(watchdog);
  if (poll !== null) clearInterval(poll);
  const receiptPath = join(scratch, "receipt.json");
  const receipt: RunnerReceipt | null = existsSync(receiptPath) ? JSON.parse(readFileSync(receiptPath, "utf8")) : null;
  assertClean();
  return { code, stdout, stderr, receipt };
}

const attachmentArgs = () => ["--mcp-config", join(scratch, "mcp.json")];
const attachmentEnv = { PSTACK_T3_MCP_URL: "http://127.0.0.1:43210/mcp", T3_MCP_BEARER_TOKEN: 'fixture-secret-"split\\value' };

describe("Grok ACP through the real runner launcher", () => {
  it("isolates provider executables and cached credentials", () => {
    assert.deepEqual(clisOutsideFakes(process.env.PATH, [bin]), []);
    assert.equal(process.env.HOME, scratch);
  });

  it("completes a host-only turn with final generation, cumulative usage, provider proof and actual shutdown", async () => {
    const result = await launch();
    assert.equal(result.code, 0, result.stderr);
    assert.equal(readFileSync(join(scratch, "out.md"), "utf8"), "FINAL_OK");
    assert.equal(result.receipt?.status, "complete");
    assert.equal(result.receipt?.reportedModel, "grok-4.7-build");
    assert.equal(result.receipt?.modelEvidence, "provider-report");
    assert.deepEqual(result.receipt?.usage, { inputTokens: 30, cachedInputTokens: 7, cacheCreationInputTokens: 3, outputTokens: 4, reasoningTokens: 2, totalTokens: 34 });
    assert.equal(result.receipt?.costUsd, null);
    assert.equal(result.receipt?.exitCode, 143);
    assert.equal(result.receipt?.signal, "SIGTERM");
    assert.equal(result.receipt?.acp?.closeOutcome, "closed");
    assert.deepEqual(result.receipt?.acp?.effectiveTools, ["run_terminal_command", "read_file", "search_replace", "list_dir", "grep"]);
    const log = events();
    assert.equal(log.filter((event) => event.method === "session/prompt").length, 1);
    assert.equal(log.find((event) => event.method === "session/set_model")?.model, "grok-4.7");
    assert.equal(log.find((event) => event.method === "session/set_model")?.effort, "xhigh");
    assert.match(log.find((event) => event.kind === "started")?.profile ?? "", /disallowedTools:\n(?:.*\n)*  - search_tool\n  - use_tool/);
  });

  it("forwards one T3 attachment, injects its tab and removes referenced environment values", async () => {
    const result = await launch({ extra: attachmentArgs(), env: attachmentEnv });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.receipt?.acp?.attachment?.previewTabId, "tab_fixture");
    assert.equal(result.receipt?.acp?.effectiveTools.length, 7);
    const started = events().find((event) => event.kind === "started");
    assert.equal(started?.tokenInEnv, false);
    assert.equal(started?.endpointInEnv, false);
    assert.equal(started?.subagents, "0");
    assert.match(started?.overlay ?? "", /inherit = "core"\n\[subagents\]\nenabled = false/);
    assert.match(events().find((event) => event.kind === "prompt")?.text ?? "", /assigned preview tab tab_fixture/);
  });

  it("accepts late MCP tool expansion alongside the exact builtin catalog and records ambient names", async () => {
    const result = await launch({ scenario: "mcp-expansion", extra: attachmentArgs(), env: { ...attachmentEnv, FAKE_MCP_TOOL: "trusted-other__read_file" } });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(readFileSync(join(scratch, "out.md"), "utf8"), "FINAL_OK");
    assert.deepEqual(result.receipt?.acp?.effectiveTools, ["run_terminal_command", "read_file", "search_replace", "list_dir", "grep", "search_tool", "use_tool", "t3-code__preview_status", "t3-code__preview_click", "t3-code__preview_evaluate", "trusted-other__read_file"]);
    assert.equal(events().filter((event) => event.method === "session/prompt").length, 1);
    assert.ok(events().some((event) => event.kind === "catalog-expanded"));
  });

  it("rejects late MCP tool expansion on a host-only task", async () => {
    const result = await launch({ scenario: "mcp-expansion" });
    assert.equal(result.receipt?.status, "child-failed");
    assert.equal(existsSync(join(scratch, "out.md")), false);
  });

  for (const tool of ["spawn_subagent", "web_search", "t3-code__", "__preview_status", "t3-code__preview status", "t3-code__preview__status"]) {
    it(`rejects forbidden builtin or malformed MCP name ${tool} after expansion`, async () => {
      const result = await launch({ scenario: "mcp-expansion", extra: attachmentArgs(), env: { ...attachmentEnv, FAKE_MCP_TOOL: tool } });
      assert.notEqual(result.code, 0);
      assert.ok(result.receipt);
      assert.equal(existsSync(join(scratch, "out.md")), false);
      assert.equal(events().filter((event) => event.method === "session/prompt").length, 1);
    });
  }

  for (const scenario of ["no-catalog", "extra-tools", "missing-tools", "protocol", "malformed", "unknown-id", "duplicate-id", "early-eof", "early-exit", "rpc-initialize", "rpc-authenticate", "rpc-session\/set_model"]) {
    it(`rejects ${scenario} before inference with a receipt and no output`, async () => {
      const result = await launch({ scenario });
      assert.notEqual(result.code, 0);
      assert.ok(result.receipt);
      assert.equal(existsSync(join(scratch, "out.md")), false);
      assert.equal(events().filter((event) => event.method === "session/prompt").length, 0);
    });
  }

  for (const scenario of ["drift", "permission-request", "wrong-model", "echo-only", "zero-calls", "non-end-turn", "empty-final", "narration-only", "unknown-string-id", "reload-error", "reload-invalid-result"]) {
    it(`rejects ${scenario} after prompting without publishing old narration`, async () => {
      const result = await launch({ scenario });
      assert.notEqual(result.code, 0);
      assert.ok(result.receipt);
      assert.equal(existsSync(join(scratch, "out.md")), false);
      assert.equal(events().filter((event) => event.method === "session/prompt").length, 1);
    });
  }

  for (const scenario of ["split-frames", "auxiliary-model", "server-request", "reload-replies", "close-error", "held-pipes"]) {
    it(`completes ${scenario} and reaps the direct server`, async () => {
      const result = await launch({ scenario });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(readFileSync(join(scratch, "out.md"), "utf8"), "FINAL_OK");
      if (scenario === "server-request") assert.equal(events().find((event) => event.kind === "client-response")?.code, -32601);
      if (scenario === "close-error") assert.equal(result.receipt?.acp?.closeOutcome, "rpc-error");
    });
  }

  it("bounds a pending close without inventing an inference deadline", async () => {
    const result = await launch({ env: { FAKE_HANG_STAGE: "session/close" } });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.receipt?.acp?.closeOutcome, "grace-elapsed");
  });

  for (const cancelStage of ["preflight", "initialize", "authenticate", "session/new", "session/prompt", "session/close", "eof"]) {
    it(`cancels during ${cancelStage}, removes output, and cleans the child`, async () => {
      const result = await launch({ cancelStage });
      assert.equal(result.code, 130, result.stderr);
      assert.equal(result.receipt?.status, "cancelled");
      assert.equal(result.receipt?.signal, "SIGINT");
      assert.equal(existsSync(join(scratch, "out.md")), false);
    });
  }

  for (const phase of ["initialize", "session/prompt", "session/close", "eof"]) {
    it(`enforces the absolute explicit deadline during ${phase}`, async () => {
      const result = await launch({ extra: ["--timeout", "0.8"], env: { FAKE_HANG_STAGE: phase } });
      assert.equal(result.code, 124, result.stderr);
      assert.equal(result.receipt?.status, "timed-out");
      assert.equal(existsSync(join(scratch, "ready")), true, `deadline elapsed before reaching ${phase}`);
      assert.equal(result.receipt?.acp?.stage, phase === "initialize" ? "initialize" : phase === "session/prompt" ? "prompt" : "shutdown");
      assert.equal(existsSync(join(scratch, "out.md")), false);
    });
  }

  it("permits a delayed prompt when no deadline was supplied", async () => {
    const result = await launch({ env: { FAKE_DELAY_STAGE: "session/prompt", FAKE_DELAY_MS: "300" } });
    assert.equal(result.code, 0, result.stderr);
  });

  it("redacts fragmented credentials and escaped credentials before writing any evidence", async () => {
    const result = await launch({ scenario: "secret", extra: attachmentArgs(), env: attachmentEnv });
    assert.equal(result.code, 0, result.stderr);
    const transcript = readFileSync(join(scratch, "receipt.json.events.jsonl"), "utf8");
    const persisted = result.stdout + result.stderr + readFileSync(join(scratch, "out.md"), "utf8") + readFileSync(join(scratch, "receipt.json"), "utf8") + readFileSync(join(scratch, "events.jsonl"), "utf8") + transcript;
    assert.equal(persisted.includes(attachmentEnv.T3_MCP_BEARER_TOKEN), false);
    assert.equal(persisted.includes(JSON.stringify(attachmentEnv.T3_MCP_BEARER_TOKEN).slice(1, -1)), false);
    assert.match(readFileSync(join(scratch, "out.md"), "utf8"), /\[REDACTED\]/);
    assert.equal(result.receipt?.stdoutPath, null);
    assert.equal(result.receipt?.stderrPath, null);
    assert.equal(existsSync(join(scratch, "receipt.json.stdout")), false);
    assert.equal(existsSync(join(scratch, "receipt.json.stderr")), false);
    const trace = transcript.trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(trace.some((event) => event.kind === "tool" && event.update.rawInput?.timeout === 450000));
    assert.ok(trace.some((event) => event.kind === "tool" && event.update.rawOutput?.other === "[REDACTED]"));
    assert.equal(transcript.includes("Private thought"), false);
    assert.equal(transcript.includes("mcpServers"), false);
    assert.equal(statSync(join(scratch, "receipt.json.events.jsonl")).mode & 0o777, 0o600);
  });

  it("retains tool evidence when the exchange times out before a terminal result", async () => {
    const result = await launch({ scenario: "tool-then-hang", extra: ["--timeout", "2"], env: { FAKE_READY: join(scratch, "ready") } });
    assert.equal(result.receipt?.status, "timed-out");
    const trace = readFileSync(join(scratch, "receipt.json.events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(trace.some((event) => event.kind === "tool" && event.update.toolCallId === "tool-1"));
    assert.ok(trace.some((event) => event.kind === "process-exit" && event.timedOut === true));
  });

  it("preserves a colliding event transcript and rolls back only new reservations", async () => {
    writeFileSync(join(scratch, "receipt.json.events.jsonl"), "existing proof");
    const result = await launch({ scenario: "happy" });
    assert.notEqual(result.code, 0);
    assert.equal(readFileSync(join(scratch, "receipt.json.events.jsonl"), "utf8"), "existing proof");
    assert.equal(existsSync(join(scratch, "out.md")), false);
    assert.equal(existsSync(join(scratch, "receipt.json")), false);
  });

  it("retains the authentication-only retry and exactly one prompt", async () => {
    const result = await launch({ scenario: "retry-auth" });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(events().filter((event) => event.kind === "preflight").length, 2);
    assert.equal(events().filter((event) => event.method === "session/prompt").length, 1);
  });

  it("does not retry an unavailable model", async () => {
    const result = await launch({ scenario: "missing-model" });
    assert.equal(result.receipt?.status, "unavailable-model");
    assert.equal(events().filter((event) => event.kind === "preflight").length, 1);
    assert.equal(events().some((event) => event.kind === "started"), false);
  });

  for (const extra of [["--parent", "grok"], ["--provider", "codex"], ["--mode", "read-only"], ["--transport", "cli"], ["--preview-tab", "unbound"]]) {
    it(`rejects invalid route ${extra.join(" ")} before reservation`, async () => {
      const result = await launch({ extra });
      assert.equal(result.code, 64);
      assert.equal(result.receipt, null);
      assert.equal(existsSync(join(scratch, "out.md")), false);
      assert.deepEqual(events(), []);
    });
  }

  it("rejects literal secrets, invalid endpoint references and missing tab before reservation", async () => {
    writeFileSync(join(scratch, "mcp.json"), JSON.stringify({ schemaVersion: 1, urlEnv: "PSTACK_T3_MCP_URL", bearerTokenEnv: "literal-secret" }));
    const result = await launch({ extra: attachmentArgs() });
    assert.equal(result.code, 64);
    assert.equal(result.receipt, null);
    assert.equal(result.stderr.includes("literal-secret"), false);
  });

  it("rejects a non-loopback endpoint without leaking its value", async () => {
    const result = await launch({ extra: attachmentArgs(), env: { ...attachmentEnv, PSTACK_T3_MCP_URL: "https://remote.invalid/private" } });
    assert.equal(result.code, 64);
    assert.equal(result.receipt, null);
    assert.equal(result.stderr.includes("remote.invalid"), false);
  });
});
