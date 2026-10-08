import { readCapabilities } from "./capabilities.ts";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs, {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { childEnvironment, evidence, findExecutable, runLane, type RunResult } from "./run.ts";
import { main } from "./cli.ts";
import { cliFor, PROVIDERS, type Provider, type RunnerOptions, type RunnerReceipt } from "./types.ts";
import { matchObject } from "./match-object.test-helper.ts";
import { clisOutsideFakes, isolateProcessEnv } from "./isolated-env.test-helper.ts";

let scratch = "";
let bin = "";
let restoreProcessEnv: () => void = () => {};
let previousNetworkMarker: string | undefined;

function streamPath(path: string | null): string {
  assert.ok(path !== null, "expected a reserved stream artifact path");
  return path;
}

const fake = `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { spawn } from "node:child_process";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const out = (text) => writeSync(1, text + "\\n");
const err = (text) => writeSync(2, text + "\\n");
function publishPid(path, pid) {
  const temporary = path + "." + process.pid + ".tmp";
  writeFileSync(temporary, String(pid));
  renameSync(temporary, path);
}
const args = process.argv.slice(2);
const name = process.argv[1].split("/").at(-1);
const isPreflight =
  (name === "claude" && args[0] === "auth") ||
  (name === "codex" && args[0] === "login") ||
  (name === "grok" && args[0] === "models");
const stage = isPreflight ? "preflight" : "model";
if (process.env.FAKE_REJECT_PARENT_IDENTITY === "1" &&
    (process.env.CLAUDECODE || process.env.CODEX_THREAD_ID)) {
  err("inherited parent session identity");
  process.exit(1);
}
const startedPath = isPreflight
  ? process.env.FAKE_PREFLIGHT_STARTED_PATH
  : process.env.FAKE_MODEL_STARTED_PATH;
if (startedPath) publishPid(startedPath, process.pid);
const cancelStage = process.env.FAKE_CANCEL_STAGE ??
  (process.env.FAKE_CANCEL === "1" ? "model" : "");
if (cancelStage === stage) {
  const stop = (signal) => {
    writeFileSync(process.env.FAKE_TERMINATED_PATH, signal);
    if (process.env.FAKE_IGNORE_SIGNAL !== "1") process.exit(0);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  publishPid(process.env.FAKE_STARTED_PATH, process.pid);
  await sleep(5_000);
}
const delay = Number(
  stage === "preflight"
    ? process.env.FAKE_PREFLIGHT_DELAY_MS ?? 0
    : process.env.FAKE_MODEL_DELAY_MS ?? 0
);
if (delay > 0) await sleep(delay);
if (process.env.FAKE_TIMEOUT === "1" && !args.includes("status") && !args.includes("models")) {
  await sleep(5_000);
}
if (name === "claude" && args[0] === "auth") {
  if (process.env.FAKE_REMOVE_EXECUTABLE_AFTER_PREFLIGHT === "1") {
    unlinkSync(process.argv[1]);
  }
  out(JSON.stringify({loggedIn:true}));
  process.exit(0);
}
if (name === "codex" && args[0] === "login") {
  out("Logged in using ChatGPT");
  process.exit(0);
}
if (name === "grok" && args[0] === "models") {
  if (process.env.FAKE_GROK_PREFLIGHT_LOG_PATH) {
    appendFileSync(process.env.FAKE_GROK_PREFLIGHT_LOG_PATH, "attempt\\n");
  }
  if (process.env.FAKE_GROK_PREFLIGHT_OUTPUT !== undefined) {
    out(process.env.FAKE_GROK_PREFLIGHT_OUTPUT);
    if (process.env.FAKE_GROK_PREFLIGHT_ERROR) err(process.env.FAKE_GROK_PREFLIGHT_ERROR);
    process.exit(0);
  }
  const transientMarker = process.env.FAKE_GROK_TRANSIENT_UNAUTH_PATH;
  if (transientMarker && !existsSync(transientMarker)) {
    publishPid(transientMarker, process.pid);
    out("Available models:\\n  * grok-4.6 (default)");
    err("You are not authenticated.");
    process.exit(0);
  }
  if (process.env.FAKE_GROK_MISSING_MODEL === "1") {
    out("You are logged in with grok.com.\\nAvailable models:\\n  * grok-4.5 (default)");
    process.exit(0);
  }
  if (process.env.FAKE_GROK_UNAUTH === "1") {
    err("Not logged in. Run grok auth login.");
    process.exit(1);
  }
  out("You are logged in with grok.com.\\nAvailable models:\\n  * grok-4.6 (default)");
  process.exit(0);
}
const modelIndex = args.findIndex((value) => value === "--model");
const model = modelIndex >= 0 ? args[modelIndex + 1] : "unknown";
const reportedModel = model === "fable"
  ? "claude-fable-9-9"
  : model === "claude-opus-5-5"
    ? "claude-opus-5-5"
    : model;
if (process.env.FAKE_INVALID_MODEL === "1") {
  err("The requested model is not supported with this account.");
  process.exit(1);
}
if (name === "grok" && stage === "model" && process.env.FAKE_GROK_CONFIG_RECORD_PATH) {
  const overlay = process.env.GROK_CONFIG_PATH ?? null;
  writeFileSync(process.env.FAKE_GROK_CONFIG_RECORD_PATH, JSON.stringify({
    path: overlay,
    content: overlay === null ? null : readFileSync(overlay, "utf8"),
    inline: process.env.GROK_CONFIG ?? null,
  }));
}
if (stage === "model" && process.env.FAKE_DESCENDANT_HOLDS_PIPES_MS) {
  const seconds = Number(process.env.FAKE_DESCENDANT_HOLDS_PIPES_MS) / 1000;
  // By absolute path: the PATH of a lane holds only the fakes and node.
  const descendant = spawn("/bin/sleep", [String(seconds)], {
    stdio: ["ignore", "inherit", "inherit"],
    detached: true,
  });
  if (process.env.FAKE_DESCENDANT_PID_PATH) {
    publishPid(process.env.FAKE_DESCENDANT_PID_PATH, descendant.pid);
  }
  descendant.unref();
}
if (stage === "model" && process.env.FAKE_SELF_SIGNAL) {
  process.kill(process.pid, process.env.FAKE_SELF_SIGNAL);
  await sleep(5_000);
}
if (name === "claude") {
  out(JSON.stringify({result:"CLAUDE_OK",session_id:"c1",usage:{input_tokens:10,output_tokens:2},total_cost_usd:0.01,modelUsage:{[reportedModel]:{}}}));
} else if (name === "codex") {
  const prompt = process.env.FAKE_ECHO_PROMPT === "1" ? readFileSync(0, "utf8") : "CODEX_OK";
  out(JSON.stringify({type:"thread.started",thread_id:process.env.FAKE_ECHO_PROMPT === "1" ? "codex-" + process.pid : "o1"}));
  out(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:prompt}}));
  out(JSON.stringify({type:"turn.completed",usage:{input_tokens:20,cached_input_tokens:5,output_tokens:3,reasoning_output_tokens:1}}));
} else {
  out(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"progress"}]}}));
  out(JSON.stringify({type:"result",subtype:"success",is_error:false,result:"GROK_OK",session_id:"g1",usage:{input_tokens:30,output_tokens:4,total_tokens:34},total_cost_usd:0.02,modelUsage:{[model]:{}}}));
}
if (process.env.FAKE_MODEL_EXITING_PATH) {
  publishPid(process.env.FAKE_MODEL_EXITING_PATH, process.pid);
}
`;

const LAUNCHER = join(import.meta.dirname, "pstack-runner");

/** The binary the runner resolves for a provider: `providers.<provider>.cli` in the matrix. */
function cliOf(provider: Provider): string {
  const cli = cliFor(provider);
  assert.ok(cli, `provider ${provider} has no cli in model-matrix.json`);
  return cli;
}

/** Write the fake under the name of the CLI the runner resolves for the provider. */
function makeExecutable(provider: Provider): void {
  const path = join(bin, cliOf(provider));
  writeFileSync(path, fake);
  chmodSync(path, 0o755);
}

// macOS vets a freshly written executable on its first exec: ~300 ms idle and
// up to 4.7 s with every core busy, against ~0.1 s for a repeat exec (measured
// 2026-09-24). Every test writes new fakes, so a test whose deadline must
// outlast a fake's startup execs the fake once before starting the run.
function warm(provider: Provider, args: readonly string[] = []): void {
  execFileSync(join(bin, cliOf(provider)), args, { env: { PATH: process.env.PATH }, stdio: "ignore" });
}

function options(provider: Provider, suffix: string = provider): RunnerOptions {
  const parent = provider === "codex" ? "claude" : "codex";
  const model =
    provider === "claude"
      ? "fable"
      : provider === "codex"
        ? "gpt-6-sol"
        : "grok-4.6";
  return {
    parent,
    provider,
    model,
    effort: provider === "grok" ? "xhigh" : "max",
    mode: "read-only",
    promptPath: join(scratch, "prompt.md"),
    cwd: scratch,
    outputPath: join(scratch, `${suffix}.out`),
    receiptPath: join(scratch, `${suffix}.receipt.json`),
    timeoutMs: null,
  };
}

function receipt(path: string): RunnerReceipt {
  return JSON.parse(readFileSync(path, "utf8")) as RunnerReceipt;
}

function runnerArgs(input: RunnerOptions): string[] {
  const args = [
    LAUNCHER,
    "--parent", input.parent,
    "--provider", input.provider,
    "--model", input.model,
    "--effort", input.effort,
    "--mode", input.mode,
    "--prompt", input.promptPath,
    "--cwd", input.cwd,
    "--output", input.outputPath,
    "--receipt", input.receiptPath,
  ];
  if (input.timeoutMs !== null) {
    args.push("--timeout", String(input.timeoutMs / 1_000));
  }
  return args;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Runner {
  readonly child: ChildProcess;
  readonly exited: Promise<number>;
  readonly stdout: Promise<string>;
  readonly stderr: Promise<string>;
}

function collect(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (stream === null) return Promise.resolve("");
  return new Promise((resolve) => {
    let text = "";
    stream.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
    });
    stream.on("close", () => resolve(text));
  });
}

let launcherWarmed = false;

function startRunner(
  input: RunnerOptions,
  env: NodeJS.ProcessEnv = {}
): Runner {
  const [launcher, ...args] = runnerArgs(input);
  // A checkout leaves the launcher a fresh executable, which macOS vets on
  // its first exec (see warm). Pay that before any test starts a deadline.
  if (!launcherWarmed) {
    execFileSync(launcher, ["--help"], { stdio: "ignore" });
    launcherWarmed = true;
  }
  const child = spawn(launcher, args, {
    cwd: scratch,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<number>((resolve) => {
    child.once("exit", (code, signal) =>
      resolve(code ?? 128 + (signal === "SIGKILL" ? 9 : signal === "SIGTERM" ? 15 : 0))
    );
  });
  return {
    child,
    exited,
    stdout: collect(child.stdout),
    stderr: collect(child.stderr),
  };
}

async function finish(runner: Runner): Promise<number> {
  const code = await runner.exited;
  await Promise.all([runner.stdout, runner.stderr]);
  return code;
}

async function waitFor(path: string): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (existsSync(path)) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function exitWithin(runner: Runner, milliseconds: number): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const result = await Promise.race([
    runner.exited,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), milliseconds);
    }),
  ]);
  if (timer !== null) clearTimeout(timer);
  if (result !== null) {
    await Promise.all([runner.stdout, runner.stderr]);
    return result;
  }
  runner.child.kill("SIGKILL");
  await runner.exited;
  throw new Error(`runner did not exit within ${milliseconds}ms`);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (!processIsAlive(pid)) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for process ${pid} to exit`);
}

// A whole run pays each fake's first exec (see warm), which alone reached
// 4.7 s with every core busy. A budget that only catches a hang allows about
// twice that, and the Grok retry tests add their 5 s retry delay.
const RUN_BUDGET_MS = 10_000;
const GROK_RETRY_RUN_BUDGET_MS = 5_000 + RUN_BUDGET_MS;

// With a warm fake the launcher reached the model child's exit within 0.5 s
// even with every core busy. The deadline leaves that path room to finish
// first, and the descendant holds the pipes far past the deadline, so a run
// that ends well inside the hold was cut by the deadline rather than by the
// descendant letting go.
const DRAIN_DEADLINE_MS = 4_000;
const DESCENDANT_HOLD_MS = 30_000;

const PREFLIGHT_DEADLINE_MS = 3_000;
const PREFLIGHT_HOLD_MS = 10 * PREFLIGHT_DEADLINE_MS;

const FAKE_ENV = [
  "FAKE_REJECT_PARENT_IDENTITY",
  "FAKE_ECHO_PROMPT",
  "FAKE_TIMEOUT",
  "FAKE_INVALID_MODEL",
  "FAKE_CANCEL",
  "FAKE_CANCEL_STAGE",
  "FAKE_IGNORE_SIGNAL",
  "FAKE_PREFLIGHT_DELAY_MS",
  "FAKE_MODEL_DELAY_MS",
  "FAKE_STARTED_PATH",
  "FAKE_TERMINATED_PATH",
  "FAKE_PREFLIGHT_STARTED_PATH",
  "FAKE_MODEL_STARTED_PATH",
  "FAKE_MODEL_EXITING_PATH",
  "FAKE_REMOVE_EXECUTABLE_AFTER_PREFLIGHT",
  "FAKE_GROK_UNAUTH",
  "FAKE_GROK_PREFLIGHT_OUTPUT",
  "FAKE_GROK_PREFLIGHT_ERROR",
  "FAKE_GROK_TRANSIENT_UNAUTH_PATH",
  "FAKE_GROK_PREFLIGHT_LOG_PATH",
  "FAKE_GROK_MISSING_MODEL",
  "FAKE_DESCENDANT_HOLDS_PIPES_MS",
  "FAKE_DESCENDANT_PID_PATH",
  "FAKE_SELF_SIGNAL",
  "FAKE_CASE",
  "FAKE_LOG",
  "FAKE_GROK_CONFIG_RECORD_PATH",
] as const;

function clearFakeEnv(): void {
  for (const key of FAKE_ENV) delete process.env[key];
}

// runLane reads process.env, and the launcher child inherits it, so the
// isolation goes on process.env itself: every lane of this file, in process or
// under the launcher, sees only the fakes and this node under a temporary HOME.
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "pstack-runner-test-"));
  bin = join(scratch, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "package.json"), '{"type":"module"}\n');
  writeFileSync(join(scratch, "prompt.md"), "Return the marker.");
  for (const provider of PROVIDERS) makeExecutable(provider);
  restoreProcessEnv = isolateProcessEnv(join(scratch, "home"), [bin]);
  previousNetworkMarker = process.env.CODEX_SANDBOX_NETWORK_DISABLED;
  delete process.env.CODEX_SANDBOX_NETWORK_DISABLED;
  clearFakeEnv();
});

afterEach(() => {
  restoreProcessEnv();
  if (previousNetworkMarker === undefined) delete process.env.CODEX_SANDBOX_NETWORK_DISABLED;
  else process.env.CODEX_SANDBOX_NETWORK_DISABLED = previousNetworkMarker;
  clearFakeEnv();
  rmSync(scratch, { recursive: true, force: true });
});

function scriptedModel(
  stdout: string | readonly number[],
  stderr: string | readonly number[],
  exitCode: number
): string {
  const bytes = (value: string | readonly number[]): string =>
    typeof value === "string" ? JSON.stringify(value) : `Buffer.from(${JSON.stringify(value)})`;
  return fake.replace(
    "const modelIndex =",
    `writeSync(1, ${bytes(stdout)}); writeSync(2, ${bytes(stderr)}); process.exit(${exitCode});\nconst modelIndex =`
  );
}

const GROK_PREFLIGHT_ARGS = ["models"];

function writeGrok(script: string): void {
  writeFileSync(join(bin, cliOf("grok")), script);
  warm("grok", GROK_PREFLIGHT_ARGS);
}

describe("capability execution boundary", () => {
  it("passes selected capabilities through execution and records their exact digest", async () => {
    const path = join(scratch, "capabilities.json");
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, agentKind: "owner", web: true }));
    const capabilities = readCapabilities(path);
    const result = await runLane({ ...options("codex"), capabilities });
    assert.equal(result.receipt.status, "complete");
    assert.deepEqual(result.receipt.capabilities, capabilities);
    assert.ok(result.receipt.argv.includes('web_search="live"'));
    assert.equal(result.receipt.argv[result.receipt.argv.indexOf("multi_agent") - 1], "--enable");
  });
});

describe("Codex parent network hint", () => {
  const hint = "likely cause: Codex parent sandbox has network disabled; see provider-dispatch.md#host-and-parent-prerequisites";

  it("decorates an untyped CLI failure and scrubs the marker from the child", async () => {
    process.env.CODEX_SANDBOX_NETWORK_DISABLED = "1";
    const childEnv = join(scratch, "child-env.json");
    writeFileSync(join(bin, "claude"), scriptedModel("", "ENOTFOUND api.anthropic.com\n", 1).replace(
      "const args =",
      `writeFileSync(${JSON.stringify(childEnv)}, JSON.stringify({ marker: process.env.CODEX_SANDBOX_NETWORK_DISABLED ?? null }));\nconst args =`
    ));
    const input = options("claude");
    const result = await runLane(input);
    assert.equal(result.exitCode, 70);
    matchObject(result.receipt, {
      schemaVersion: 1, status: "child-failed", exitCode: 1, signal: null,
      parent: "codex", provider: "claude", model: "fable", effort: "max",
      preflight: { status: "passed" },
      error: { message: `child exited with status 1; ${hint}`, evidence: `${hint}\nENOTFOUND api.anthropic.com` },
    });
    assert.equal(result.receipt.argv[0], join(bin, "claude"));
    assert.deepEqual(JSON.parse(readFileSync(childEnv, "utf8")), { marker: null });
    assert.equal(readFileSync(streamPath(result.receipt.stderrPath), "utf8"), "ENOTFOUND api.anthropic.com\n");
    assert.equal(readFileSync(streamPath(result.receipt.stdoutPath), "utf8"), "");
    assert.equal(existsSync(input.outputPath), false);
  });

  for (const marker of [undefined, "0", "true"]) {
    it(`leaves a plain failure unchanged with marker ${String(marker)}`, async () => {
      if (marker !== undefined) process.env.CODEX_SANDBOX_NETWORK_DISABLED = marker;
      writeGrok(scriptedModel("", "ENOTFOUND grok.com\n", 1));
      const result = await runLane(options("grok"));
      assert.equal(result.exitCode, 70);
      assert.deepEqual(result.receipt.error, { message: "child exited with status 1", evidence: "ENOTFOUND grok.com" });
    });
  }

  it("leaves a Claude parent's failure unchanged with marker 1", async () => {
    process.env.CODEX_SANDBOX_NETWORK_DISABLED = "1";
    writeGrok(scriptedModel("", "ENOTFOUND grok.com\n", 1));
    const result = await runLane({ ...options("grok"), parent: "claude" });
    assert.equal(result.receipt.status, "child-failed");
    assert.deepEqual(result.receipt.error, { message: "child exited with status 1", evidence: "ENOTFOUND grok.com" });
  });

  it("prefixes the hint before bounding evidence and preserves both raw streams", async () => {
    process.env.CODEX_SANDBOX_NETWORK_DISABLED = "1";
    const stdout = "provider startup\n" + "x".repeat(6_000) + "\nuseful terminal tail\n";
    const stderr = "ENOTFOUND grok.com\n";
    writeGrok(scriptedModel(stdout, stderr, 1));
    const result = await runLane(options("grok"));
    assert.equal(result.receipt.error?.message, `child exited with status 1; ${hint}`);
    assert.equal(result.receipt.error?.evidence.length, 4_000);
    assert.ok(result.receipt.error?.evidence.startsWith(`${hint}\n${stderr}`));
    assert.ok(result.receipt.error?.evidence.endsWith("useful terminal tail"));
    assert.equal(readFileSync(streamPath(result.receipt.stdoutPath), "utf8"), stdout);
    assert.equal(readFileSync(streamPath(result.receipt.stderrPath), "utf8"), stderr);
  });

  for (const subtype of ["api_error", "error_during_execution", "cancelled"]) {
    for (const exitCode of [0, 1]) {
      it(`preserves the typed ${subtype} reason after exit ${exitCode}`, async () => {
        process.env.CODEX_SANDBOX_NETWORK_DISABLED = "1";
        const reason = subtype === "cancelled" ? "User cancelled the execution" : "provider permission refused";
        const stdout = JSON.stringify({ type: "result", subtype, is_error: true, errors: [reason],
          session_id: "failed-session", modelUsage: { "grok-4.6-build": {} } }) + "\n";
        writeGrok(scriptedModel(stdout, "ENOTFOUND grok.com\n", exitCode));
        const result = await runLane(options("grok"));
        assert.equal(result.exitCode, subtype === "cancelled" ? 130 : 70);
        matchObject(result.receipt, { status: subtype === "cancelled" ? "cancelled" : "child-failed",
          exitCode, sessionId: "failed-session", reportedModel: "grok-4.6-build", modelVerified: true });
        assert.equal(result.receipt.error?.message, reason);
        assert.ok(result.receipt.error?.evidence.startsWith(reason));
        assert.doesNotMatch(result.receipt.error?.evidence ?? "", /Codex parent sandbox/);
      });
    }
  }

  for (const provider of ["claude", "grok"] as const) {
    it(`keeps successful ${provider} lanes complete under marker 1`, async () => {
      process.env.CODEX_SANDBOX_NETWORK_DISABLED = "1";
      const result = await runLane(options(provider));
      assert.equal(result.exitCode, 0);
      assert.equal(result.receipt.status, "complete");
      assert.equal(result.receipt.error, null);
      assert.equal(readFileSync(result.receipt.outputPath, "utf8").trim(), provider === "claude" ? "CLAUDE_OK" : "GROK_OK");
    });
  }

  for (const [diagnostic, status, exitCode] of [
    ["Invalid model: grok-4.6", "unavailable-model", 69],
    ["Authentication failed", "unauthenticated", 77],
    ["model not found: opaque, tail Authentication failed", "unauthenticated", 77],
  ] as const) {
    it(`keeps ${status} authoritative for ${diagnostic}`, async () => {
      process.env.CODEX_SANDBOX_NETWORK_DISABLED = "1";
      writeGrok(scriptedModel("", diagnostic + "\n", 1));
      const result = await runLane(options("grok"));
      assert.equal(result.exitCode, exitCode);
      assert.equal(result.receipt.status, status);
      assert.deepEqual(result.receipt.error, { message: "child exited with status 1", evidence: diagnostic });
    });
  }

  it("keeps an explicit timeout free of the hint", async () => {
    process.env.CODEX_SANDBOX_NETWORK_DISABLED = "1";
    warm("claude", ["auth", "status"]);
    process.env.FAKE_MODEL_DELAY_MS = "10000";
    const result = await runLane({ ...options("claude"), timeoutMs: 1_000 });
    assert.equal(result.exitCode, 124);
    assert.equal(result.receipt.status, "timed-out");
    assert.doesNotMatch(JSON.stringify(result.receipt.error), /Codex parent sandbox/);
  });

  it("uses the marker captured before preparation even if the parent environment changes", async () => {
    writeGrok(scriptedModel("", "ENOTFOUND grok.com\n", 1));
    for (const marker of ["1", "0"]) {
      process.env.CODEX_SANDBOX_NETWORK_DISABLED = marker;
      const pending = runLane(options("grok", `captured-${marker}`));
      process.env.CODEX_SANDBOX_NETWORK_DISABLED = marker === "1" ? "0" : "1";
      const result = await pending;
      assert.equal(result.receipt.status, "child-failed");
      assert.equal(result.receipt.error?.message, marker === "1" ? `child exited with status 1; ${hint}` : "child exited with status 1");
    }
  });

  it("keeps a literal ACP child failure free of the CLI hint", async () => {
    process.env.CODEX_SANDBOX_NETWORK_DISABLED = "1";
    process.env.FAKE_CASE = "mcp-expansion";
    const eventPath = join(scratch, "acp-events.jsonl");
    process.env.FAKE_LOG = eventPath;
    writeFileSync(join(bin, "grok"), readFileSync(join(import.meta.dirname, "acp-fixture.test-helper.mjs")));
    const input = { ...options("grok", "hint-acp"), model: "grok-4.7", mode: "full-access", transport: "grok-acp" } as const;
    const result = await runLane(input);
    assert.equal(result.exitCode, 70);
    matchObject(result.receipt, {
      status: "child-failed", preflight: { status: "passed" },
      error: { message: "ACP effective tool catalog does not match the assigned profile" },
      acp: { shutdownIntent: "failure" },
    });
    assert.doesNotMatch(result.receipt.error?.evidence ?? "", /likely cause|Codex parent sandbox/);
    assert.equal(existsSync(input.outputPath), false);
    const events = readFileSync(eventPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const started = events.find((event) => event.kind === "started");
    assert.ok(started);
    assert.equal(existsSync(started.profilePath), false);
    assert.equal(existsSync(started.overlayPath), false);
    assert.throws(() => process.kill(started.pid, 0), /ESRCH/);
  });

  it("keeps preflight, unavailable CLI and malformed output free of the hint", async () => {
    process.env.CODEX_SANDBOX_NETWORK_DISABLED = "1";
    process.env.FAKE_GROK_MISSING_MODEL = "1";
    const preflight = await runLane(options("grok", "hint-preflight"));
    assert.equal(preflight.receipt.status, "unavailable-model");
    assert.doesNotMatch(JSON.stringify(preflight.receipt.error), /Codex parent sandbox/);
    writeFileSync(join(bin, "claude"), scriptedModel("invalid output\n", "", 0));
    const malformed = await runLane(options("claude", "hint-malformed"));
    assert.equal(malformed.receipt.status, "malformed-output");
    assert.doesNotMatch(JSON.stringify(malformed.receipt.error), /Codex parent sandbox/);
    rmSync(join(bin, "claude"));
    const missing = await runLane(options("claude", "hint-missing"));
    assert.equal(missing.receipt.status, "unavailable-cli");
    assert.doesNotMatch(JSON.stringify(missing.receipt.error), /Codex parent sandbox/);
  });
});

describe("issue78 terminal results", () => {
  for (const scenario of ["cancel-zero", "cancel-nonzero", "api-error", "api-error-nonzero", "success-streams"]) {
    it(`issue78 ${scenario}`, async () => {
      const input = options("grok");
      const reason = scenario.startsWith("api-error")
        ? "API unavailable"
        : "User cancelled the execution for tool run_terminal_command";
      const terminal = {
        type: "result",
        subtype: scenario.startsWith("api-error") ? "api_error"
          : scenario === "success-streams" ? "success" : "error_during_execution",
        is_error: scenario !== "success-streams",
        stop_reason: scenario.startsWith("cancel") ? "cancelled" : "end_turn",
        errors: [reason],
        result: "GROK_OK",
        session_id: "terminal-session",
        usage: { input_tokens: 30, output_tokens: 4 },
        total_cost_usd: 0.02,
        modelUsage: { "grok-4.6-build": {} },
      };
      const stdout = JSON.stringify(terminal) + "\n";
      const stderr = "startup warning\n".repeat(400) + "\n";
      writeGrok(scriptedModel(stdout, stderr, scenario.endsWith("nonzero") ? 1 : 0));
      const result = await runLane(input);
      const saved = receipt(input.receiptPath);
      assert.equal(saved.status, scenario === "success-streams" ? "complete"
        : scenario.startsWith("api-error") ? "child-failed" : "cancelled");
      assert.equal(result.exitCode, scenario === "success-streams" ? 0
        : scenario.startsWith("api-error") ? 70 : 130);
      assert.equal(saved.exitCode, scenario.endsWith("nonzero") ? 1 : 0);
      matchObject(saved, {
        signal: null,
        reportedModel: "grok-4.6-build",
        modelVerified: true,
        modelEvidence: "provider-report",
        sessionId: "terminal-session",
        usage: { inputTokens: 30, outputTokens: 4 },
        costUsd: 0.02,
      });
      if (scenario !== "success-streams") {
        assert.equal(saved.error?.message, reason);
        assert.ok(saved.error?.evidence.startsWith(reason));
        assert.ok((saved.error?.evidence.length ?? 0) <= 4_000);
        assert.equal(existsSync(input.outputPath), false);
      }
      assert.equal(saved.stdoutPath, `${input.receiptPath}.stdout`);
      assert.equal(saved.stderrPath, `${input.receiptPath}.stderr`);
      assert.deepEqual(readFileSync(streamPath(saved.stdoutPath)), Buffer.from(stdout));
      assert.deepEqual(readFileSync(streamPath(saved.stderrPath)), Buffer.from(stderr));
      assert.equal(statSync(streamPath(saved.stderrPath)).size, 6_401);
      assert.equal(saved.schemaVersion, 1);
      for (const path of [saved.stdoutPath, saved.stderrPath, input.receiptPath]) {
        assert.equal(statSync(streamPath(path)).mode & 0o777, 0o600);
      }
    });
  }

  for (const stream of ["stdout", "stderr"]) {
    it(`rolls back reservations without overwriting an existing ${stream} sidecar`, async () => {
      const input = options("grok");
      const conflict = `${input.receiptPath}.${stream}`;
      writeFileSync(conflict, "operator evidence");
      await assert.rejects(runLane(input));
      assert.equal(readFileSync(conflict, "utf8"), "operator evidence");
      for (const path of [input.outputPath, input.receiptPath,
        `${input.receiptPath}.${stream === "stdout" ? "stderr" : "stdout"}`]) {
        assert.equal(existsSync(path), false, `${path} was left behind`);
      }
    });

    it(`rejects a ${stream} sidecar colliding with the prompt or output`, async () => {
      const input = options("grok");
      const conflict = `${input.receiptPath}.${stream}`;
      writeFileSync(conflict, "operator prompt");
      await assert.rejects(runLane({ ...input, promptPath: conflict }), /must be distinct/);
      assert.equal(readFileSync(conflict, "utf8"), "operator prompt");
      rmSync(conflict);
      await assert.rejects(runLane({ ...input, outputPath: conflict }), /must be distinct/);
      for (const path of [input.outputPath, input.receiptPath,
        `${input.receiptPath}.stdout`, `${input.receiptPath}.stderr`]) {
        assert.equal(existsSync(path), false, `${path} was left behind`);
      }
    });
  }

  it("retains complete streams when writes are partial", async () => {
    const input = options("grok");
    const stdout = JSON.stringify({ type: "result", subtype: "success", is_error: false,
      result: "GROK_OK", modelUsage: { "grok-4.6-build": {} } }) + "\n";
    const stderr = "complete stderr despite partial writes\n";
    writeGrok(scriptedModel(stdout, stderr, 0));
    const originalWrite = fs.writeSync;
    let partialWrites = 0;
    const write = mock.method(fs, "writeSync", (...args: unknown[]) => {
      const [descriptor, data, offset, length] = args;
      if (typeof descriptor !== "number" || !(data instanceof Uint8Array)
        || typeof offset !== "number" || typeof length !== "number") {
        return Reflect.apply(originalWrite, fs, args);
      }
      partialWrites++;
      return originalWrite(descriptor, data, offset, Math.min(length, 7));
    });
    syncBuiltinESMExports();
    try {
      const result = await runLane(input);
      assert.equal(result.exitCode, 0);
      assert.ok(partialWrites > 1);
      assert.deepEqual(readFileSync(streamPath(result.receipt.stdoutPath)), Buffer.from(stdout));
      assert.deepEqual(readFileSync(streamPath(result.receipt.stderrPath)), Buffer.from(stderr));
    } finally {
      write.mock.restore();
      syncBuiltinESMExports();
    }
  });

  it("terminalizes a sidecar write failure without waiting for the child", async () => {
    process.env.CODEX_SANDBOX_NETWORK_DISABLED = "1";
    const input = options("grok");
    writeGrok(fake.replace("const modelIndex =",
      'writeSync(1, "stream data"); await sleep(60_000);\nconst modelIndex ='));
    const originalWrite = fs.writeSync;
    const write = mock.method(fs, "writeSync", (...args: unknown[]) => {
      if (!(args[1] instanceof Uint8Array)) return Reflect.apply(originalWrite, fs, args);
      throw new Error("sidecar storage unavailable");
    });
    syncBuiltinESMExports();
    const started = Date.now();
    try {
      const result = await runLane(input);
      assert.equal(result.exitCode, 70);
      assert.equal(result.receipt.status, "child-failed");
      assert.ok(result.receipt.error?.evidence.includes("sidecar storage unavailable"));
      assert.doesNotMatch(JSON.stringify(result.receipt.error), /Codex parent sandbox/);
      assert.ok(Date.now() - started < 30_000, "the run waited for the child's 60 s sleep");
      assert.equal(existsSync(input.outputPath), false);
      assert.equal(existsSync(streamPath(result.receipt.stdoutPath)), true);
      assert.equal(existsSync(streamPath(result.receipt.stderrPath)), true);
    } finally {
      write.mock.restore();
      syncBuiltinESMExports();
    }
  });

  it("retains undecodable stderr bytes rather than re-encoding captured text", async () => {
    const input = options("grok");
    const bytes = [0, 255, 195, 169, 13, 10];
    writeGrok(fake.replace("const modelIndex =",
      `writeSync(2, Buffer.from(${JSON.stringify(bytes)}));\nconst modelIndex =`));
    const result = await runLane(input);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(readFileSync(streamPath(result.receipt.stderrPath)), Buffer.from(bytes));
  });

  for (const exitCode of [0, 1]) {
    it(`keeps malformed terminal data distinct after child exit ${exitCode}`, async () => {
      const input = options("grok");
      const stdout = '{"type":"result","is_error":true}\n';
      writeGrok(scriptedModel(stdout, "", exitCode));
      const result = await runLane(input);
      assert.equal(result.exitCode, exitCode === 0 ? 65 : 70);
      matchObject(result.receipt, {
        status: exitCode === 0 ? "malformed-output" : "child-failed",
        exitCode, reportedModel: null, modelVerified: false,
        sessionId: null, error: { message: exitCode === 0
          ? "grok result did not contain a valid terminal status" : "child exited with status 1" },
      });
      assert.ok(readFileSync(streamPath(result.receipt.stdoutPath), "utf8").endsWith(stdout));
      assert.equal(existsSync(input.outputPath), false);
    });
  }

  for (const stdout of ['{"type":"system","subtype":"init"}\n', "startup failed\n"]) {
    for (const exitCode of [0, 1]) {
      it(`handles missing Grok terminal output ${JSON.stringify(stdout)} after exit ${exitCode}`, async () => {
        const input = options("grok");
        const stderr = "sandbox startup refused\n";
        writeGrok(scriptedModel(stdout, stderr, exitCode));
        const result = await runLane(input);
        assert.equal(result.exitCode, exitCode === 0 ? 65 : 70);
        matchObject(result.receipt, {
          status: exitCode === 0 ? "malformed-output" : "child-failed",
          exitCode, reportedModel: null, sessionId: null,
        });
        assert.equal(readFileSync(streamPath(result.receipt.stdoutPath), "utf8"), stdout);
        assert.equal(readFileSync(streamPath(result.receipt.stderrPath), "utf8"), stderr);
        assert.equal(existsSync(input.outputPath), false);
      });
    }
  }

  it("does not invent metadata for a valid provider failure", async () => {
    const input = options("grok");
    writeGrok(scriptedModel(
      JSON.stringify({ type: "result", subtype: "api_error", is_error: true, errors: ["API unavailable"] }) + "\n",
      "",
      1
    ));
    const result = await runLane(input);
    assert.equal(result.exitCode, 70);
    matchObject(result.receipt, {
      status: "child-failed", exitCode: 1, reportedModel: null, modelVerified: false,
      modelEvidence: null, sessionId: null, usage: null, costUsd: null,
      error: { message: "API unavailable" },
    });
    assert.ok(readFileSync(streamPath(result.receipt.stdoutPath), "utf8").includes("api_error"));
    assert.equal(existsSync(input.outputPath), false);
  });

  it("keeps launcher cancellation ahead of a typed Grok result", async () => {
    process.env.CODEX_SANDBOX_NETWORK_DISABLED = "1";
    const input = options("grok", "typed-then-cancelled");
    const started = join(scratch, "typed-then-cancelled.started");
    const stdout = JSON.stringify({ type: "result", subtype: "api_error", is_error: true,
      errors: ["API unavailable"], session_id: "terminal-session", modelUsage: { "grok-4.6-build": {} } }) + "\n";
    writeGrok(fake.replace("const modelIndex =",
      `writeSync(1, ${JSON.stringify(stdout)}); publishPid(process.env.FAKE_STARTED_PATH, process.pid); await sleep(5_000);\nconst modelIndex =`));
    const runner = startRunner(input, { FAKE_STARTED_PATH: started });
    await waitFor(started);
    await sleep(200);
    runner.child.kill("SIGTERM");

    assert.equal(await exitWithin(runner, RUN_BUDGET_MS), 130);
    const saved = receipt(input.receiptPath);
    matchObject(saved, {
      status: "cancelled",
      signal: "SIGTERM",
      reportedModel: null,
      sessionId: null,
      error: { message: "launcher received SIGTERM; signal was sent to child" },
    });
    assert.equal(readFileSync(streamPath(saved.stdoutPath), "utf8"), stdout);
    assert.doesNotMatch(JSON.stringify(saved.error), /Codex parent sandbox/);
  });

  it("retains strict model verification for successful Grok results", async () => {
    const input = options("grok");
    writeGrok(fake.replace("modelUsage:{[model]:{}}", 'modelUsage:{"grok-unexpected":{}}'));
    const result = await runLane(input);
    assert.equal(result.exitCode, 65);
    matchObject(result.receipt, { status: "malformed-output", modelVerified: false });
    assert.equal(result.receipt.error?.message, "requested model grok-4.6 was not reported by grok");
    assert.ok(readFileSync(streamPath(result.receipt.stdoutPath), "utf8").includes("grok-unexpected"));
    assert.equal(existsSync(input.outputPath), false);
  });
});

describe("R2 neutral auth-required", () => {
  type Site = { provider: Provider; stage: "success" | "preflight-failure" | "model-failure" };
  type Expected = { exitCode: number; status: "complete" | "unauthenticated" | "unavailable-model" | "child-failed"; attempts: number };
  const sites: Site[] = [
    { provider: "grok", stage: "success" },
    ...PROVIDERS.flatMap((provider): Site[] => [
      { provider, stage: "preflight-failure" },
      { provider, stage: "model-failure" },
    ]),
  ];
  const neutral = ["No authentication required", "No sign-in required", "No sign in required"];

  function neutralOutcome(site: Site): Expected {
    if (site.stage === "success") return { exitCode: 0, status: "complete", attempts: 1 };
    if (site.stage === "model-failure") return { exitCode: 70, status: "child-failed", attempts: 1 };
    return { exitCode: 77, status: "unauthenticated", attempts: site.provider === "grok" ? 2 : 1 };
  }

  async function check(site: Site, diagnostic: string, expected: Expected, listing?: string): Promise<RunResult> {
    const input = options(site.provider, "r2-diagnostic");
    const calls = join(scratch, "r2-invocations.log");
    const preflightOut = listing ?? (site.provider === "grok"
      ? `You are logged in.\nAvailable models: ${input.model}`
      : site.provider === "claude" ? '{"loggedIn":true}' : "Logged in using ChatGPT");
    const preflightErr = site.stage === "model-failure" ? "" : diagnostic;
    const preflightExit = site.stage === "preflight-failure" ? 1 : 0;
    const stdout = site.stage === "model-failure" ? "" : JSON.stringify({
      type: "result", subtype: "success", is_error: false, result: "R2_OK",
      modelUsage: { [input.model]: {} },
    }) + "\n";
    const stderr = site.stage === "model-failure" ? diagnostic : "";
    writeFileSync(join(bin, cliOf(site.provider)), `#!${process.execPath}
import { appendFileSync, writeSync } from "node:fs";
const args = process.argv.slice(2);
if (["models", "auth", "login"].includes(args[0])) {
  appendFileSync(${JSON.stringify(calls)}, "preflight\\n");
  writeSync(1, ${JSON.stringify(preflightOut)});
  writeSync(2, ${JSON.stringify(preflightErr)});
  process.exit(${preflightExit});
}
appendFileSync(${JSON.stringify(calls)}, "model=" + args[args.indexOf("--model") + 1] + "\\n");
writeSync(1, ${JSON.stringify(stdout)});
writeSync(2, ${JSON.stringify(stderr)});
process.exit(${site.stage === "model-failure" ? 1 : 0});
`);
    const result = await runLane(input);
    assert.equal(result.exitCode, expected.exitCode, diagnostic);
    assert.equal(result.receipt.status, expected.status, diagnostic);
    const started = site.stage === "model-failure" || expected.status === "complete";
    assert.equal(readFileSync(calls, "utf8"),
      "preflight\n".repeat(expected.attempts) + (started ? `model=${input.model}\n` : ""));
    assert.equal(result.receipt.preflight.status, started ? "passed" : "failed");
    assert.equal(result.receipt.exitCode, site.stage === "model-failure" || preflightExit === 1 ? 1 : 0);
    assert.equal(result.receipt.argv[result.receipt.argv.indexOf("--model") + 1], input.model);
    assert.deepEqual(result.receipt.preflight.argv, [join(bin, cliOf(site.provider)),
      ...(site.provider === "grok" ? ["models"] : site.provider === "claude" ? ["auth", "status", "--json"] : ["login", "status"])]);
    assert.equal(existsSync(input.outputPath), expected.status === "complete");
    if (expected.status === "complete") assert.equal(readFileSync(input.outputPath, "utf8"), "R2_OK");
    assert.equal(readFileSync(streamPath(result.receipt.stdoutPath), "utf8"), started ? stdout : "");
    assert.equal(readFileSync(streamPath(result.receipt.stderrPath), "utf8"), started ? stderr : "");
    assert.equal(receipt(input.receiptPath).status, expected.status);
    assert.ok(result.receipt.preflight.evidence.length <= 4_000);
    assert.ok((result.receipt.error?.evidence.length ?? 0) <= 4_000);
    if (site.stage === "model-failure") {
      if (diagnostic.length <= 4_000) assert.equal(result.receipt.error?.evidence, diagnostic.trim());
      else assert.ok(result.receipt.error?.evidence.includes("\n[…]\n"));
      assert.equal(result.receipt.error?.message, "child exited with status 1");
    } else if (!started) {
      const emitted = `${preflightOut}\n${preflightErr}`.trim();
      const preserved = expected.attempts === 2
        ? `attempt 1 failed:\n${emitted}\n\nattempt 2 failed:\n${emitted}` : emitted;
      if (emitted.length <= 1_900) assert.equal(result.receipt.preflight.evidence, preserved);
      else {
        assert.ok(result.receipt.preflight.evidence.includes("\n[…]\n"));
        assert.ok(result.receipt.preflight.evidence.startsWith(expected.attempts === 2 ? "attempt 1 failed:\n" : emitted.slice(0, 1_000)));
        assert.equal(result.receipt.preflight.evidence.includes("attempt 2 failed"), expected.attempts === 2);
      }
      assert.equal(result.receipt.error?.evidence, result.receipt.preflight.evidence);
      assert.equal(result.receipt.error?.message, "authentication or model preflight failed");
    }
    return result;
  }

  describe("R2 evidence window", () => {
    function cutNeutral(message: string): string {
      const clause = `${message}.`;
      return `${"x".repeat(2_000)}\n${clause}\n${"z".repeat(2_997 - clause.length)}`;
    }

    for (const site of sites) {
      const model = options(site.provider).model;
      const label = `${site.provider} ${site.stage}`;
      const refusal = `${model} is not supported`;
      for (const message of neutral) {
        for (const competingRefusal of [false, true]) {
          it(`complete neutral clause at cut ${label}: ${message}, refusal ${competingRefusal}`, { timeout: GROK_RETRY_RUN_BUDGET_MS }, async () => {
            const diagnostic = `${competingRefusal ? `${refusal}\n` : ""}${cutNeutral(message)}`;
            const result = await check(site, diagnostic, competingRefusal
              ? { exitCode: 69, status: "unavailable-model", attempts: 1 } : neutralOutcome(site));
            assert.ok(diagnostic.includes(`${message}.`));
            if (result.receipt.error !== null) assert.equal(result.receipt.error.evidence.includes("No "), false);
          });
        }
      }

      it(`owns opaque qualifier across cut ${label}`, { timeout: GROK_RETRY_RUN_BUDGET_MS }, async () => {
        const diagnostic = `${"x".repeat(1_200)} Invalid model: ]${"y".repeat(1_900)} ${refusal}${" z".repeat(1_400)}`;
        const result = await check(site, diagnostic, neutralOutcome(site));
        if (result.receipt.error !== null) assert.equal(result.receipt.error.evidence.includes("Invalid model:"), false);
      });

      it(`auth in dropped middle wins over independent refusal ${label}`, { timeout: GROK_RETRY_RUN_BUDGET_MS }, async () => {
        const diagnostic = `${refusal}\n${"x".repeat(1_200)}\nYou are not authenticated.\n${"z".repeat(4_000)}`;
        const result = await check(site, diagnostic, { exitCode: 77, status: "unauthenticated",
          attempts: site.provider === "grok" && site.stage !== "model-failure" ? 2 : 1 });
        assert.equal(result.receipt.error?.evidence.includes("You are not authenticated"), false);
      });

      it(`requested refusal in dropped middle remains unavailable ${label}`, async () => {
        const diagnostic = `${"x".repeat(1_200)}\n${refusal}\n${"z".repeat(4_000)}`;
        const result = await check(site, diagnostic, { exitCode: 69, status: "unavailable-model", attempts: 1 });
        assert.equal(result.receipt.error?.evidence.includes("is not supported"), false);
      });
    }

    for (const stage of ["success", "preflight-failure"] as const) {
      for (const message of neutral) {
        it(`neutral cut with missing Grok token ${stage}: ${message}`, async () => {
          await check({ provider: "grok", stage }, cutNeutral(message),
            { exitCode: 69, status: "unavailable-model", attempts: 1 },
            "You are logged in.\nAvailable models: grok-5");
        });
      }
    }
  });

  for (const site of sites) {
    const label = `${site.provider} ${site.stage}`;
    const authOutcome: Expected = { exitCode: 77, status: "unauthenticated",
      attempts: site.provider === "grok" && site.stage !== "model-failure" ? 2 : 1 };
    const modelOutcome: Expected = { exitCode: 69, status: "unavailable-model", attempts: 1 };
    const model = options(site.provider).model;
    const refusal = `${model} is not supported`;

    for (const message of neutral) {
      it(`neutral only ${label}: ${message}`, { timeout: GROK_RETRY_RUN_BUDGET_MS }, async () => {
        await check(site, message, neutralOutcome(site));
      });
    }

    for (const [index, separator] of [" ", "\n", "\r", "\r\n", "\u2028", "\u2029"].entries()) {
      const message = neutral[index % neutral.length];
      const auth = ["authentication required", "sign-in required", "sign in required",
        "Sign-in failed", "You are not authenticated", "Not logged in"][index];
      for (const [order, diagnostic] of [
        ["before", `${auth} ${refusal}${separator}${message}`],
        ["after", `${message}${separator}${auth} ${refusal}`],
      ]) {
        it(`auth ${order} neutral ${label} separator ${index}`, { timeout: GROK_RETRY_RUN_BUDGET_MS }, async () => {
          await check(site, diagnostic, authOutcome);
        });
      }
      for (const [order, diagnostic] of [
        ["before", `${refusal}${separator}${message}`],
        ["after", `${message}${separator}${refusal}`],
      ]) {
        it(`refusal ${order} neutral ${label} separator ${index}`, async () => {
          await check(site, diagnostic, modelOutcome);
        });
      }
    }

    for (const [index, scenario] of [
      { diagnostic: `Invalid model: "other-model ${neutral[0]} ${refusal}"`, expected: neutralOutcome(site) },
      { diagnostic: `Invalid model: "other-model authentication required ${neutral[0]} ${refusal}"`, expected: authOutcome },
      { diagnostic: `Invalid model: "other-model ${neutral[1]} sign-in required ${refusal}"`, expected: authOutcome },
      { diagnostic: `${refusal} Invalid model: "other-model ${neutral[2]}"`, expected: modelOutcome },
      { diagnostic: `Invalid model: "other-model ${neutral[2]}"\n${refusal}`, expected: modelOutcome },
    ].entries()) {
      it(`opaque tail ${label} case ${index}`, { timeout: GROK_RETRY_RUN_BUDGET_MS }, async () => {
        await check(site, scenario.diagnostic, scenario.expected);
      });
    }

    for (const message of ["Authentication successful", "Sign-in successful", "Sign in successful", ""]) {
      it(`positive or empty diagnostic ${label}: ${JSON.stringify(message)}`, { timeout: GROK_RETRY_RUN_BUDGET_MS }, async () => {
        await check(site, message, neutralOutcome(site));
      });
    }

    for (const message of ["No authentication failed", "No authentication is required", "No  sign in required"]) {
      it(`keeps existing grammar ${label}: ${message}`, { timeout: GROK_RETRY_RUN_BUDGET_MS }, async () => {
        await check(site, message, authOutcome);
      });
    }
  }
});

describe("runLane", () => {
  it("drives every matrix cli provider through the fake binaries", () => {
    assert.deepEqual(PROVIDERS, ["claude", "codex", "grok"]);
  });

  for (const provider of PROVIDERS) {
    it(`executes and receipts the ${provider} external lane`, async () => {
      const input = options(provider);
      const result = await runLane(input);
      assert.equal(result.exitCode, 0);
      assert.ok(
        readFileSync(input.outputPath, "utf8").includes(provider.toUpperCase())
      );
      matchObject(receipt(input.receiptPath), {
        status: "complete",
        provider,
        model: input.model,
        modelVerified: provider !== "codex",
        modelEvidence: provider === "codex" ? "pinned-argv" : "provider-report",
        preflight: { status: "passed" },
      });
      const saved = receipt(input.receiptPath);
      assert.ok(readFileSync(streamPath(saved.stdoutPath), "utf8").includes(provider.toUpperCase()));
      assert.deepEqual(readFileSync(streamPath(saved.stderrPath)), Buffer.alloc(0));
      for (const path of [saved.stdoutPath, saved.stderrPath]) {
        assert.equal(statSync(streamPath(path)).mode & 0o777, 0o600);
      }
      if (provider === "claude") {
        assert.equal(receipt(input.receiptPath).reportedModel, "claude-fable-9-9");
      }
      if (provider === "grok") {
        assert.equal(receipt(input.receiptPath).reportedModel, "grok-4.6");
      }
    });
  }

  it("runs the pinned Opus 5.5 lane and verifies the served model", async () => {
    const input = { ...options("claude", "opus"), model: "claude-opus-5-5", effort: "xhigh" };
    const result = await runLane(input);
    assert.equal(result.exitCode, 0);
    matchObject(receipt(input.receiptPath), {
      status: "complete",
      model: "claude-opus-5-5",
      reportedModel: "claude-opus-5-5",
      modelVerified: true,
      modelEvidence: "provider-report",
    });
  });

  it("runs the Astra family through the Codex lane with a pinned-argv receipt", async () => {
    const input = { ...options("codex", "astra"), model: "gpt-6-astra" };
    const result = await runLane(input);
    assert.equal(result.exitCode, 0);
    const recorded = receipt(input.receiptPath);
    matchObject(recorded, {
      status: "complete",
      provider: "codex",
      model: "gpt-6-astra",
      reportedModel: null,
      modelVerified: false,
      modelEvidence: "pinned-argv",
    });
    assert.equal(recorded.argv[recorded.argv.indexOf("--model") + 1], "gpt-6-astra");
  });

  it("records Codex's exact argv without fabricating a reported model", async () => {
    const input = options("codex");
    const result = await runLane(input);
    assert.equal(result.exitCode, 0);
    matchObject(receipt(input.receiptPath), {
      status: "complete",
      model: "gpt-6-sol",
      reportedModel: null,
      modelVerified: false,
      modelEvidence: "pinned-argv",
    });
  });

  it("classifies an unavailable model without falling back", async () => {
    process.env.FAKE_INVALID_MODEL = "1";
    const input = options("codex");
    const result = await runLane(input);
    assert.equal(result.exitCode, 69);
    assert.equal(existsSync(input.outputPath), false);
    matchObject(receipt(input.receiptPath), {
      status: "unavailable-model",
      model: "gpt-6-sol",
      reportedModel: null,
      modelVerified: false,
      modelEvidence: null,
    });
  });

  for (const message of ["Authentication successful.", "Sign in successful."]) {
    it(`accepts positive authentication prose: ${message}`, async () => {
      process.env.FAKE_GROK_PREFLIGHT_OUTPUT = `${message}\nYou are logged in.\nAvailable models: grok-4.7`;
      const input = { ...options("grok", "grok-positive-auth"), model: "grok-4.7" };
      const result = await runLane(input);

      assert.equal(result.exitCode, 0);
      assert.equal(readFileSync(input.outputPath, "utf8"), "GROK_OK");
      matchObject(receipt(input.receiptPath), {
        status: "complete", preflight: { status: "passed" },
      });
    });
  }

  for (const provider of PROVIDERS) {
    it(`keeps explicit model-execution authentication failures for ${provider}`, async () => {
      const messages = ["Not logged in.", "You are not authenticated.", "Unauthenticated.",
        "Authentication failed.", "Authentication required.", "Authentication is required.",
        "Please sign in.", "Sign in required.", "Sign-in required.", "Login required.",
        "Sign in failed.", "Sign-in failed.", "Sign in failure.", "Sign-in failure.",
        "Please sign-in.", "Must sign-in.", "Need to sign-in."];
      for (const [index, message] of messages.entries()) {
        writeFileSync(join(bin, cliOf(provider)), scriptedModel("", `${message}\nmodel unavailable`, 1));
        const input = options(provider, `auth-error-${index}`);
        const result = await runLane(input);

        assert.equal(result.exitCode, 77, message);
        assert.equal(existsSync(input.outputPath), false, message);
        matchObject(receipt(input.receiptPath), {
          status: "unauthenticated", exitCode: 1, preflight: { status: "passed" },
        });
      }
    });

    it(`keeps ambiguous authentication labels as child failures for ${provider}`, async () => {
      for (const [index, message] of ["authentication status unavailable", "sign in status unavailable",
        "Authentication successful. Sign in successful."].entries()) {
        writeFileSync(join(bin, cliOf(provider)), scriptedModel("", message, 1));
        const input = options(provider, `ambiguous-auth-${index}`);
        const result = await runLane(input);

        assert.equal(result.exitCode, 70, message);
        assert.equal(existsSync(input.outputPath), false, message);
        matchObject(receipt(input.receiptPath), {
          status: "child-failed", exitCode: 1, preflight: { status: "passed" },
        });
      }
    });
  }

  it("retries an explicit authentication requirement before a model refusal", { timeout: GROK_RETRY_RUN_BUDGET_MS }, async () => {
    process.env.FAKE_GROK_PREFLIGHT_OUTPUT = "You are logged in.\nAvailable models: grok-4.7";
    process.env.FAKE_GROK_PREFLIGHT_ERROR = "Authentication required.\nmodel grok-4.7 is not supported";
    const preflightLog = join(scratch, "grok-auth-required.log");
    const modelStarted = join(scratch, "grok-auth-required.started");
    process.env.FAKE_GROK_PREFLIGHT_LOG_PATH = preflightLog;
    process.env.FAKE_MODEL_STARTED_PATH = modelStarted;
    const input = { ...options("grok", "grok-auth-required"), model: "grok-4.7" };
    const result = await runLane(input);

    assert.equal(result.exitCode, 77);
    assert.equal(readFileSync(preflightLog, "utf8"), "attempt\nattempt\n");
    assert.equal(existsSync(modelStarted), false);
    matchObject(receipt(input.receiptPath), {
      status: "unauthenticated", preflight: { status: "failed" },
    });
  });

  it("executes Grok after an exact model token bounded by punctuation", async () => {
    process.env.FAKE_GROK_PREFLIGHT_OUTPUT = "You are logged in.\nAvailable models: [grok-4.7] (default)";
    const input = { ...options("grok", "grok-exact-token"), model: "grok-4.7" };
    const result = await runLane(input);

    assert.equal(result.exitCode, 0);
    assert.equal(readFileSync(input.outputPath, "utf8"), "GROK_OK");
    matchObject(receipt(input.receiptPath), {
      status: "complete", reportedModel: "grok-4.7",
      preflight: { status: "passed", evidence: "authenticated; model grok-4.7 available" },
    });
  });

  for (const listed of ["grok-4.70", "xgrok-4.7", "grok-4.7-build", "grok-4x7", "grok-4.7_build", "grok-4.7.preview"]) {
    it(`does not accept neighboring Grok model token ${listed}`, async () => {
      process.env.FAKE_GROK_PREFLIGHT_OUTPUT = `You are logged in.\nAvailable models: ${listed}`;
      const preflightLog = join(scratch, "grok-neighbor.log");
      const modelStarted = join(scratch, "grok-neighbor.started");
      process.env.FAKE_GROK_PREFLIGHT_LOG_PATH = preflightLog;
      process.env.FAKE_MODEL_STARTED_PATH = modelStarted;
      const input = { ...options("grok", "grok-neighbor"), model: "grok-4.7" };
      const result = await runLane(input);

      assert.equal(result.exitCode, 69);
      assert.equal(readFileSync(preflightLog, "utf8"), "attempt\n");
      assert.equal(existsSync(modelStarted), false);
      assert.equal(existsSync(input.outputPath), false);
      matchObject(receipt(input.receiptPath), {
        status: "unavailable-model", preflight: { status: "failed" },
      });
    });
  }

  for (const listed of ["grok-4.6", "grok-4.7"]) {
    it(`rejects a requested-model refusal without a model label after listing ${listed}`, async () => {
      process.env.FAKE_GROK_PREFLIGHT_OUTPUT = `You are logged in.\nAvailable models: ${listed}`;
      process.env.FAKE_GROK_PREFLIGHT_ERROR = "grok-4.7 is not supported";
      const modelStarted = join(scratch, "grok-unlabeled-refusal.started");
      process.env.FAKE_MODEL_STARTED_PATH = modelStarted;
      const input = { ...options("grok", "grok-unlabeled-refusal"), model: "grok-4.7" };
      const result = await runLane(input);

      assert.equal(result.exitCode, 69);
      assert.equal(existsSync(modelStarted), false);
      assert.equal(existsSync(input.outputPath), false);
      matchObject(receipt(input.receiptPath), {
        status: "unavailable-model", preflight: { status: "failed" },
      });
    });
  }

  for (const message of ["grok-4.70 is not supported", "feature is not supported",
    "Available models: grok-4.7, feature is not supported", "modeling is not supported",
    "Available model: grok-4.7, feature is not supported", "model: grok-4.7; feature is not supported",
    "grok-4.7,gpt-6-sol is not supported", "grok-4.7:feature is not supported",
    "other-model is not supported", "a.model is not supported", "invalid model-build",
    "Invalid model: grok-4.6", "Invalid model   other-model", 'Invalid model: "other-model"',
    "Invalid model: 'other-model'", "Invalid model: [other-model]",
    "model not found: other-model", "model unknown: other-model", "model unavailable: other-model",
    "model unsupported: other-model", "model not supported: other-model", "model invalid: other-model",
    "model is not supported: other-model", "model not found   other-model",
    "Invalid model: grok-4.7:feature", "Invalid model: grok-4.7,other-model", "invalid model.preview",
    "model not supported with this account: other-model",
    "model not supported with this account: grok-4.7:feature"]) {
    it(`keeps an unrelated refusal separate from the requested Grok id: ${message}`, async () => {
      process.env.FAKE_GROK_PREFLIGHT_OUTPUT = "You are logged in.\nAvailable models: grok-4.7";
      process.env.FAKE_GROK_PREFLIGHT_ERROR = message;
      const input = { ...options("grok", "grok-unrelated-refusal"), model: "grok-4.7" };
      const result = await runLane(input);

      assert.equal(result.exitCode, 0);
      assert.equal(readFileSync(input.outputPath, "utf8"), "GROK_OK");
      matchObject(receipt(input.receiptPath), {
        status: "complete", preflight: { status: "passed" },
      });
    });
  }

  for (const message of ["invalid model", "invalid model.", "Invalid model. Choose another.",
    "model not found", "model not found.", "Invalid model: grok-4.7", "Invalid model   grok-4.7",
    'Invalid model: "grok-4.7"', "Invalid model: 'grok-4.7'", "Invalid model: [grok-4.7]",
    'model not found: "grok-4.7"', "model is not supported: grok-4.7",
    "The requested model is not supported with this account.",
    "model is not supported with this account: grok-4.7"]) {
    it(`rejects a generic or qualified requested Grok refusal: ${message}`, async () => {
      process.env.FAKE_GROK_PREFLIGHT_OUTPUT = "You are logged in.\nAvailable models: grok-4.7";
      process.env.FAKE_GROK_PREFLIGHT_ERROR = message;
      const modelStarted = join(scratch, "grok-qualified-refusal.started");
      process.env.FAKE_MODEL_STARTED_PATH = modelStarted;
      const input = { ...options("grok", "grok-qualified-refusal"), model: "grok-4.7" };
      const result = await runLane(input);

      assert.equal(result.exitCode, 69);
      assert.equal(existsSync(modelStarted), false);
      assert.equal(existsSync(input.outputPath), false);
      matchObject(receipt(input.receiptPath), {
        status: "unavailable-model", preflight: { status: "failed" },
      });
    });
  }

  for (const provider of PROVIDERS) {
    it(`binds qualified account-scoped model refusals during ${provider} execution`, async () => {
      const model = options(provider).model;
      for (const [index, { message, exitCode, status }] of [
        { message: "The requested model is not supported with this account.", exitCode: 69, status: "unavailable-model" },
        { message: `model is not supported with this account: ${model}`, exitCode: 69, status: "unavailable-model" },
        { message: "model is not supported with this account: other-model", exitCode: 70, status: "child-failed" },
        { message: `model is not supported with this account: ${model}:feature`, exitCode: 70, status: "child-failed" },
        { message: "Authentication failed.\nThe requested model is not supported with this account.", exitCode: 77, status: "unauthenticated" },
      ].entries()) {
        writeFileSync(join(bin, cliOf(provider)), scriptedModel("", message, 1));
        const input = options(provider, `account-scoped-model-${index}`);
        const result = await runLane(input);

        assert.equal(result.exitCode, exitCode, message);
        assert.equal(existsSync(input.outputPath), false, message);
        matchObject(receipt(input.receiptPath), {
          status, exitCode: 1, preflight: { status: "passed" },
        });
      }
    });

    it(`keeps unrelated model subjects as child failures during ${provider} execution`, async () => {
      const model = options(provider).model;
      const messages = [`Available models: ${model}, feature is not supported`, "modeling is not supported",
        `Available model: ${model}, feature is not supported`, `model: ${model}; feature is not supported`,
        `${model},gpt-6.1-sol is not supported`, `${model}:feature is not supported`,
        "other-model is not supported", "a.model is not supported", "invalid model-build",
        "Invalid model: other-model", "Invalid model   other-model", 'Invalid model: "other-model"',
        "Invalid model: 'other-model'", "Invalid model: [other-model]",
        "model not found: other-model", "model unknown: other-model", "model unavailable: other-model",
        "model unsupported: other-model", "model not supported: other-model", "model invalid: other-model",
        "model is not supported: other-model", "model not found   other-model",
        `Invalid model: ${model}:feature`, `Invalid model: ${model},other-model`, "invalid model.preview"];
      for (const [index, message] of messages.entries()) {
        writeFileSync(join(bin, cliOf(provider)), scriptedModel("", message, 1));
        const input = options(provider, `unrelated-subject-${index}`);
        const result = await runLane(input);

        assert.equal(result.exitCode, 70, message);
        assert.equal(existsSync(input.outputPath), false, message);
        matchObject(receipt(input.receiptPath), {
          status: "child-failed", exitCode: 1, preflight: { status: "passed" },
        });
      }
    });

    for (const { label, diagnostic, exitCode, status } of [
      { label: "compound comma", diagnostic: "<requested>,gpt-6.1-sol is not supported", exitCode: 77, status: "unauthenticated" },
      { label: "compound colon", diagnostic: "<requested>:feature is not supported", exitCode: 77, status: "unauthenticated" },
      { label: "ambiguous model label", diagnostic: "Available model: <requested>, feature is not supported", exitCode: 77, status: "unauthenticated" },
      { label: "neighboring label token", diagnostic: "<requested>\nother-model is not supported", exitCode: 77, status: "unauthenticated" },
      { label: "qualified neighboring id", diagnostic: "<requested>\nInvalid model: other-model", exitCode: 77, status: "unauthenticated" },
      { label: "qualified neighboring prefix", diagnostic: "<requested>\nmodel not found: other-model", exitCode: 77, status: "unauthenticated" },
      { label: "qualified quoted neighbor", diagnostic: '<requested>\nInvalid model: "other-model"', exitCode: 77, status: "unauthenticated" },
      { label: "qualified compound colon", diagnostic: "Invalid model: <requested>:feature", exitCode: 77, status: "unauthenticated" },
      { label: "qualified compound comma", diagnostic: "Invalid model: <requested>,other-model", exitCode: 77, status: "unauthenticated" },
      { label: "punctuated generic", diagnostic: "<requested>\ninvalid model.", exitCode: 69, status: "unavailable-model" },
      { label: "punctuated generic sentence", diagnostic: "<requested>\nInvalid model. Choose another.", exitCode: 69, status: "unavailable-model" },
      { label: "qualified requested id", diagnostic: "Invalid model: <requested>", exitCode: 69, status: "unavailable-model" },
      { label: "account-scoped qualified neighbor", diagnostic: "<requested>\nmodel not supported with this account: other-model", exitCode: 77, status: "unauthenticated" },
      { label: "account-scoped generic", diagnostic: "<requested>\nThe requested model is not supported with this account.", exitCode: 69, status: "unavailable-model" },
    ]) {
      it(`keeps ${label} separate during ${provider} failed preflight`, { timeout: GROK_RETRY_RUN_BUDGET_MS }, async () => {
        const input = options(provider, "unrelated-preflight-subject");
        const message = diagnostic.replaceAll("<requested>", input.model);
        const modelStarted = join(scratch, "unrelated-preflight.started");
        process.env.FAKE_MODEL_STARTED_PATH = modelStarted;
        writeFileSync(join(bin, cliOf(provider)), fake.replace(
          'if (name === "claude" && args[0] === "auth") {',
          `if (isPreflight) { err(${JSON.stringify(message)}); process.exit(1); }\nif (name === "claude" && args[0] === "auth") {`
        ));
        const result = await runLane(input);

        assert.equal(result.exitCode, exitCode);
        assert.equal(existsSync(modelStarted), false);
        assert.equal(existsSync(input.outputPath), false);
        matchObject(receipt(input.receiptPath), {
          status, preflight: { status: "failed" },
        });
      });
    }

    it(`preserves explicit model refusal forms during ${provider} execution`, async () => {
      const model = options(provider).model;
      const messages = ["model not found", `model ${model} is not supported`, "invalid model",
        `"${model}" is not supported`, `'${model}' is not supported`, `[${model}] is not supported`,
        "invalid model.", "Invalid model. Choose another.", "model not found.",
        `Invalid model: ${model}`, `Invalid model   ${model}`, `Invalid model: "${model}"`,
        `Invalid model: '${model}'`, `Invalid model: [${model}]`,
        `model not found: "${model}"`, `model is not supported: ${model}`];
      for (const [index, message] of messages.entries()) {
        writeFileSync(join(bin, cliOf(provider)), scriptedModel("", message, 1));
        const input = options(provider, `explicit-model-form-${index}`);
        const result = await runLane(input);

        assert.equal(result.exitCode, 69, message);
        assert.equal(existsSync(input.outputPath), false, message);
        matchObject(receipt(input.receiptPath), {
          status: "unavailable-model", exitCode: 1, preflight: { status: "passed" },
        });
      }
    });

    it(`classifies a requested-id model refusal during ${provider} execution`, async () => {
      const input = options(provider, "requested-model-refusal");
      writeFileSync(join(bin, cliOf(provider)), scriptedModel("", `${input.model} is not supported`, 1));
      const result = await runLane(input);

      assert.equal(result.exitCode, 69);
      matchObject(receipt(input.receiptPath), {
        status: "unavailable-model", exitCode: 1, preflight: { status: "passed" },
      });
    });

    it(`keeps a refusal without the requested id as a child failure during ${provider} execution`, async () => {
      writeFileSync(join(bin, cliOf(provider)), scriptedModel("", "feature is not supported", 1));
      const input = options(provider, "unrelated-model-refusal");
      const result = await runLane(input);

      assert.equal(result.exitCode, 70);
      matchObject(receipt(input.receiptPath), {
        status: "child-failed", exitCode: 1, preflight: { status: "passed" },
      });
    });
  }

  const incompleteQualifiedSubjects = [
    'Invalid model: <requested>, other-model', 'Invalid model: <requested>"other-model',
    "Invalid model: <requested>]other-model", "Invalid model: <requested>'other-model",
    'Invalid model: "<requested>', 'Invalid model: [<requested>', 'Invalid model "other-model',
    'model is not supported with this account: <requested>, other-model',
    'model is not supported with this account: <requested>"other-model',
    'model is not supported with this account "other-model',
    'Invalid model: <requested>.', 'Invalid model: <requested>. Choose another.',
    'model not found: <requested>. Choose another.',
    'model is not supported with this account: <requested>. Choose another.',
  ];

  for (const diagnostic of incompleteQualifiedSubjects) {
    it(`requires a complete qualified subject before vetoing a Grok listing: ${diagnostic}`, async () => {
      process.env.FAKE_GROK_PREFLIGHT_OUTPUT = "You are logged in.\nAvailable models: grok-4.7";
      process.env.FAKE_GROK_PREFLIGHT_ERROR = diagnostic.replaceAll("<requested>", "grok-4.7");
      const input = { ...options("grok", "complete-qualified-subject"), model: "grok-4.7" };
      const result = await runLane(input);

      assert.equal(result.exitCode, 0);
      assert.equal(readFileSync(input.outputPath, "utf8"), "GROK_OK");
      matchObject(receipt(input.receiptPath), {
        status: "complete", preflight: { status: "passed" },
      });
    });
  }

  for (const provider of PROVIDERS) {
    for (const diagnostic of incompleteQualifiedSubjects) {
      it(`requires a complete qualified subject during ${provider} failed preflight: ${diagnostic}`, { timeout: GROK_RETRY_RUN_BUDGET_MS }, async () => {
        const input = options(provider, "complete-qualified-preflight");
        const message = `${input.model}\n${diagnostic.replaceAll("<requested>", input.model)}`;
        const modelStarted = join(scratch, "complete-qualified.started");
        process.env.FAKE_MODEL_STARTED_PATH = modelStarted;
        writeFileSync(join(bin, cliOf(provider)), fake.replace(
          'if (name === "claude" && args[0] === "auth") {',
          `if (isPreflight) { err(${JSON.stringify(message)}); process.exit(1); }\nif (name === "claude" && args[0] === "auth") {`
        ));
        const result = await runLane(input);

        assert.equal(result.exitCode, 77);
        assert.equal(existsSync(modelStarted), false);
        assert.equal(existsSync(input.outputPath), false);
        matchObject(receipt(input.receiptPath), {
          status: "unauthenticated", preflight: { status: "failed" },
        });
      });

      it(`requires a complete qualified subject during ${provider} execution: ${diagnostic}`, async () => {
        const input = options(provider, "complete-qualified-model");
        writeFileSync(join(bin, cliOf(provider)), scriptedModel("", diagnostic.replaceAll("<requested>", input.model), 1));
        const result = await runLane(input);

        assert.equal(result.exitCode, 70);
        assert.equal(existsSync(input.outputPath), false);
        matchObject(receipt(input.receiptPath), {
          status: "child-failed", exitCode: 1, preflight: { status: "passed" },
        });
      });
    }

    it(`retains paired punctuation and whitespace outside a complete qualified subject during ${provider} execution`, async () => {
      const model = options(provider).model;
      for (const [index, message] of [`Invalid model: "${model}".`, `Invalid model: [${model}]!`,
        `Invalid model: ${model} .`, `model is not supported with this account: '${model}'?`].entries()) {
        writeFileSync(join(bin, cliOf(provider)), scriptedModel("", message, 1));
        const input = options(provider, `complete-qualified-control-${index}`);
        const result = await runLane(input);

        assert.equal(result.exitCode, 69, message);
        matchObject(receipt(input.receiptPath), {
          status: "unavailable-model", exitCode: 1, preflight: { status: "passed" },
        });
      }
    });
  }

  const opaqueDiagnostics: readonly [string, string][] = [
    ["logger opaque bare", "ERROR Invalid model: \"other-model <requested> is not supported\""],
    ["logger opaque quoted", "\"ERROR\" Invalid model: \"other-model <requested> is not supported\""],
    ["logger opaque bracketed", "[ERROR] Invalid model: \"other-model <requested> is not supported\""],
    ["unrelated direct", "[other-model] invalid"],
    ["unrelated logger prefix", "[ERROR] Invalid model: other-model"],
    ["quoted inner generic", 'Invalid model: "other-model model not found. Choose another."'],
    ["comma inner generic", "Invalid model: other-model, model not found."],
    ["comma inner generic at end", "Invalid model: other-model, model not found"],
    ["account inner generic", 'model is not supported with this account: "other-model model not found. Choose another."'],
    ["quoted inner direct", 'Invalid model: "other-model <requested> is not supported"'],
    ["positive inner prose", 'Invalid model: "other-model feature is supported"'],
    ["first closing bracket", "Invalid model: ] model not found"],
    ["first closing parenthesis", "Invalid model: ) <requested> is not supported"],
    ["first colon", "Invalid model: : model not found"],
    ["invalid head then predicate", "invalid model is not supported"],
    ["model predicate then comma", "model not found, <requested> is not supported"],
    ["invalid head then comma", "Invalid model, <requested> is not supported"],
    ["closed other id then direct", 'Invalid model: "other-model" <requested> is not supported'],
    ["predicate dot suffix", "model not found.preview <requested> is not supported"],
    ["literal dot subject", "Invalid model ."],
  ];
  const independentDiagnostics: [string, string][] = [
    ["logger requested bare", "ERROR Invalid model: <requested>"],
    ["logger requested quoted", "\"ERROR\" Invalid model: <requested>"],
    ["logger requested bracketed", "[ERROR] Invalid model: <requested>"],
    ["requested direct overlapping prefix", "<requested> invalid model: other-model"],
    ["requested direct before logger", "<requested> is not supported; [ERROR] Invalid model: \"other-model <requested> is not supported\""],
    ["earlier direct", '<requested> is not supported; Invalid model: "other-model model not found."'],
    ["later direct", 'Invalid model: "other-model model not found."\n<requested> is not supported'],
    ["later generic", 'Invalid model: "other-model model not found."\nmodel not found'],
  ];
  for (const [label, boundary] of [["CR", "\r"], ["CRLF", "\r\n"],
    ["line separator", "\u2028"], ["paragraph separator", "\u2029"]]) {
    independentDiagnostics.push(
      [`qualified before ${label}`, `Invalid model: <requested>${boundary}Unrelated feature is supported.`],
      [`later direct after ${label}`, `Invalid model: "other-model model not found."${boundary}<requested> is not supported`],
      [`later generic after ${label}`, `Invalid model: "other-model model not found."${boundary}model not found`],
    );
  }
  const authDiagnostics: readonly [string, string][] = [
    ["auth inside rejected tail", 'Invalid model: "other-model Not authenticated. model not found."'],
  ];
  const diagnosticModels: Record<Provider, string> = { claude: "claude-opus-5-5", codex: "gpt-6.1-sol", grok: "grok-4.7" };
  for (const expected of [
    { cases: opaqueDiagnostics, successExit: 0, successStatus: "complete", preflightExit: 77,
      preflightStatus: "unauthenticated", modelExit: 70, modelStatus: "child-failed" },
    { cases: independentDiagnostics, successExit: 69, successStatus: "unavailable-model", preflightExit: 69,
      preflightStatus: "unavailable-model", modelExit: 69, modelStatus: "unavailable-model" },
    { cases: authDiagnostics, successExit: 77, successStatus: "unauthenticated", preflightExit: 77,
      preflightStatus: "unauthenticated", modelExit: 77, modelStatus: "unauthenticated" },
  ] as const) {
    for (const [label, diagnostic] of expected.cases) {
      it(`owns ${label} during Grok successful preflight`, { timeout: GROK_RETRY_RUN_BUDGET_MS }, async () => {
        const input = { ...options("grok", "owned-success"), model: diagnosticModels.grok };
        const started = join(scratch, "owned-success.started");
        const attempts = join(scratch, "owned-success.attempts");
        process.env.FAKE_MODEL_STARTED_PATH = started;
        process.env.FAKE_GROK_PREFLIGHT_LOG_PATH = attempts;
        process.env.FAKE_GROK_PREFLIGHT_OUTPUT = `You are logged in.\nAvailable models: ${input.model}`;
        process.env.FAKE_GROK_PREFLIGHT_ERROR = diagnostic.replaceAll("<requested>", input.model);
        const result = await runLane(input);

        assert.equal(result.exitCode, expected.successExit);
        assert.equal(existsSync(started), expected.successExit === 0);
        assert.equal(existsSync(input.outputPath), expected.successExit === 0);
        if (expected.successExit === 0) assert.equal(readFileSync(input.outputPath, "utf8"), "GROK_OK");
        assert.equal(readFileSync(attempts, "utf8"), "attempt\n".repeat(expected.successExit === 77 ? 2 : 1));
        matchObject(receipt(input.receiptPath), {
          model: input.model, status: expected.successStatus, exitCode: 0,
          preflight: { status: expected.successExit === 0 ? "passed" : "failed" },
        });
      });

      for (const provider of PROVIDERS) {
        it(`owns ${label} during ${provider} failed preflight`, { timeout: GROK_RETRY_RUN_BUDGET_MS }, async () => {
          const input = { ...options(provider, "owned-preflight"), model: diagnosticModels[provider] };
          const message = `${input.model}\n${diagnostic.replaceAll("<requested>", input.model)}`;
          const started = join(scratch, "owned-preflight.started");
          const attempts = join(scratch, "owned-preflight.attempts");
          process.env.FAKE_MODEL_STARTED_PATH = started;
          writeFileSync(join(bin, cliOf(provider)), fake.replace(
            'if (name === "claude" && args[0] === "auth") {',
            `if (isPreflight) { appendFileSync(${JSON.stringify(attempts)}, "attempt\\n"); err(${JSON.stringify(message)}); process.exit(1); }\nif (name === "claude" && args[0] === "auth") {`
          ));
          const result = await runLane(input);

          assert.equal(result.exitCode, expected.preflightExit);
          assert.equal(existsSync(started), false);
          assert.equal(existsSync(input.outputPath), false);
          assert.equal(readFileSync(attempts, "utf8"), "attempt\n".repeat(provider === "grok" && expected.preflightExit === 77 ? 2 : 1));
          matchObject(receipt(input.receiptPath), {
            model: input.model, status: expected.preflightStatus, exitCode: 1, preflight: { status: "failed" },
          });
        });

        it(`owns ${label} during ${provider} execution`, async () => {
          const input = { ...options(provider, "owned-model"), model: diagnosticModels[provider] };
          const started = join(scratch, "owned-model.started");
          const attempts = join(scratch, "owned-model.attempts");
          process.env.FAKE_MODEL_STARTED_PATH = started;
          process.env.FAKE_GROK_PREFLIGHT_OUTPUT = `You are logged in.\nAvailable models: ${input.model}`;
          writeFileSync(join(bin, cliOf(provider)), scriptedModel("", diagnostic.replaceAll("<requested>", input.model), 1).replace(
            'if (name === "claude" && args[0] === "auth") {',
            `if (isPreflight) appendFileSync(${JSON.stringify(attempts)}, "attempt\\n");\nif (name === "claude" && args[0] === "auth") {`
          ));
          const result = await runLane(input);

          assert.equal(result.exitCode, expected.modelExit);
          assert.equal(existsSync(started), true);
          assert.equal(existsSync(input.outputPath), false);
          assert.equal(readFileSync(attempts, "utf8"), "attempt\n");
          matchObject(receipt(input.receiptPath), {
            model: input.model, status: expected.modelStatus, exitCode: 1, preflight: { status: "passed" },
          });
        });
      }
    }
  }

  it("rejects an explicitly unsupported Grok model despite a zero-exit exact listing", async () => {
    process.env.FAKE_GROK_PREFLIGHT_OUTPUT = "You are logged in.\nAvailable models: grok-4.7";
    process.env.FAKE_GROK_PREFLIGHT_ERROR = "model grok-4.7 is not supported";
    const modelStarted = join(scratch, "grok-unsupported.started");
    process.env.FAKE_MODEL_STARTED_PATH = modelStarted;
    const input = { ...options("grok", "grok-unsupported"), model: "grok-4.7" };
    const result = await runLane(input);

    assert.equal(result.exitCode, 69);
    assert.equal(existsSync(modelStarted), false);
    matchObject(receipt(input.receiptPath), {
      status: "unavailable-model", preflight: { status: "failed" },
    });
    assert.ok(receipt(input.receiptPath).preflight.evidence.includes("not supported"));
  });

  it("retries explicit not-authenticated Grok output before failing closed", { timeout: GROK_RETRY_RUN_BUDGET_MS }, async () => {
    process.env.FAKE_GROK_PREFLIGHT_OUTPUT = "You are logged in.\nAvailable models: grok-4.7";
    process.env.FAKE_GROK_PREFLIGHT_ERROR = "You are not authenticated.";
    const preflightLog = join(scratch, "grok-not-authenticated.log");
    const modelStarted = join(scratch, "grok-not-authenticated.started");
    process.env.FAKE_GROK_PREFLIGHT_LOG_PATH = preflightLog;
    process.env.FAKE_MODEL_STARTED_PATH = modelStarted;
    const input = { ...options("grok", "grok-not-authenticated"), model: "grok-4.7" };
    const result = await runLane(input);

    assert.equal(result.exitCode, 77);
    assert.equal(readFileSync(preflightLog, "utf8"), "attempt\nattempt\n");
    assert.equal(existsSync(modelStarted), false);
    matchObject(receipt(input.receiptPath), {
      status: "unauthenticated", preflight: { status: "failed" },
    });
    assert.ok(receipt(input.receiptPath).preflight.evidence.includes("attempt 2 failed"));
  });

  it("rejects glued logged-in words in a Grok listing", { timeout: GROK_RETRY_RUN_BUDGET_MS }, async () => {
    process.env.FAKE_GROK_PREFLIGHT_OUTPUT = "You are logged into.\nAvailable models: grok-4.7";
    const preflightLog = join(scratch, "grok-glued-login.log");
    const modelStarted = join(scratch, "grok-glued-login.started");
    process.env.FAKE_GROK_PREFLIGHT_LOG_PATH = preflightLog;
    process.env.FAKE_MODEL_STARTED_PATH = modelStarted;
    const input = { ...options("grok", "grok-glued-login"), model: "grok-4.7" };
    const result = await runLane(input);

    assert.equal(result.exitCode, 77);
    assert.equal(readFileSync(preflightLog, "utf8"), "attempt\nattempt\n");
    assert.equal(existsSync(modelStarted), false);
    matchObject(receipt(input.receiptPath), {
      status: "unauthenticated", preflight: { status: "failed" },
    });
  });

  it("requires logged-in words for an API-key-only Grok listing", { timeout: GROK_RETRY_RUN_BUDGET_MS }, async () => {
    process.env.FAKE_GROK_PREFLIGHT_OUTPUT = "You are using XAI_API_KEY.\nAvailable models: grok-4.7";
    const preflightLog = join(scratch, "grok-api-key-only.log");
    const modelStarted = join(scratch, "grok-api-key-only.started");
    process.env.FAKE_GROK_PREFLIGHT_LOG_PATH = preflightLog;
    process.env.FAKE_MODEL_STARTED_PATH = modelStarted;
    const input = { ...options("grok", "grok-api-key-only"), model: "grok-4.7" };
    const result = await runLane(input);

    assert.equal(result.exitCode, 77);
    assert.equal(readFileSync(preflightLog, "utf8"), "attempt\nattempt\n");
    assert.equal(existsSync(modelStarted), false);
    matchObject(receipt(input.receiptPath), {
      status: "unauthenticated", preflight: { status: "failed" },
    });
  });

  it("retries a contradictory Grok authentication preflight before running the model", { timeout: GROK_RETRY_RUN_BUDGET_MS }, async () => {
    const transientMarker = join(scratch, "grok-transient-unauth.seen");
    const preflightLog = join(scratch, "grok-transient-unauth.log");
    process.env.FAKE_GROK_TRANSIENT_UNAUTH_PATH = transientMarker;
    process.env.FAKE_GROK_PREFLIGHT_LOG_PATH = preflightLog;
    const modelStarted = join(scratch, "grok-transient-model.started");
    process.env.FAKE_MODEL_STARTED_PATH = modelStarted;
    const input = options("grok", "grok-transient-unauth");
    const result = await runLane(input);

    assert.equal(result.exitCode, 0);
    assert.equal(readFileSync(preflightLog, "utf8"), "attempt\nattempt\n");
    assert.equal(existsSync(modelStarted), true);
    matchObject(receipt(input.receiptPath), {
      status: "complete",
      preflight: { status: "passed" },
    });
    assert.ok(
      receipt(input.receiptPath).preflight.evidence.includes("You are not authenticated.")
    );
    assert.ok(receipt(input.receiptPath).preflight.evidence.includes("attempt 2 passed"));
  });

  it("classifies Grok authentication failure after two consecutive preflights", { timeout: GROK_RETRY_RUN_BUDGET_MS }, async () => {
    process.env.FAKE_GROK_UNAUTH = "1";
    const preflightLog = join(scratch, "grok-unauthenticated.log");
    process.env.FAKE_GROK_PREFLIGHT_LOG_PATH = preflightLog;
    const modelStarted = join(scratch, "grok-model.started");
    process.env.FAKE_MODEL_STARTED_PATH = modelStarted;
    const input = options("grok", "grok-unauthenticated");
    const result = await runLane(input);

    assert.equal(result.exitCode, 77);
    assert.equal(readFileSync(preflightLog, "utf8"), "attempt\nattempt\n");
    assert.equal(existsSync(modelStarted), false);
    matchObject(receipt(input.receiptPath), {
      status: "unauthenticated",
      preflight: { status: "failed" },
    });
    assert.ok(receipt(input.receiptPath).preflight.evidence.includes("attempt 2 failed"));
  });

  it("counts the Grok retry delay against the wrapper deadline", async () => {
    warm("grok");
    const transientMarker = join(scratch, "grok-deadline-unauth.seen");
    const preflightLog = join(scratch, "grok-deadline-unauth.log");
    process.env.FAKE_GROK_TRANSIENT_UNAUTH_PATH = transientMarker;
    process.env.FAKE_GROK_PREFLIGHT_LOG_PATH = preflightLog;
    const modelStarted = join(scratch, "grok-deadline-model.started");
    process.env.FAKE_MODEL_STARTED_PATH = modelStarted;
    const input = {
      ...options("grok", "grok-preflight-retry-deadline"),
      timeoutMs: 3_000,
    };
    const result = await runLane(input);
    const recorded = receipt(input.receiptPath);

    assert.equal(result.exitCode, 124);
    assert.equal(readFileSync(preflightLog, "utf8"), "attempt\n");
    assert.equal(existsSync(modelStarted), false);
    matchObject(recorded, {
      status: "timed-out",
      preflight: { status: "timed-out" },
    });
    assert.ok(recorded.preflight.evidence.includes("You are not authenticated."));
    assert.ok(recorded.elapsedMs < 3_500);
  });

  it("cancels during the Grok retry delay without starting another preflight", async () => {
    const transientMarker = join(scratch, "grok-cancel-unauth.pid");
    const preflightLog = join(scratch, "grok-cancel-unauth.log");
    const input = options("grok", "grok-preflight-retry-cancelled");
    const runner = startRunner(input, {
      FAKE_GROK_TRANSIENT_UNAUTH_PATH: transientMarker,
      FAKE_GROK_PREFLIGHT_LOG_PATH: preflightLog,
    });
    await waitFor(transientMarker);
    await waitForExit(Number(readFileSync(transientMarker, "utf8")));
    await sleep(200);
    runner.child.kill("SIGTERM");

    assert.equal(await exitWithin(runner, 2_000), 130);
    assert.equal(readFileSync(preflightLog, "utf8"), "attempt\n");
    matchObject(receipt(input.receiptPath), {
      status: "cancelled",
      preflight: { status: "cancelled" },
      error: {
        message: "launcher received SIGTERM during authentication preflight retry delay",
      },
    });
  });

  it("does not retry a Grok preflight with a missing model", async () => {
    process.env.FAKE_GROK_MISSING_MODEL = "1";
    const preflightLog = join(scratch, "grok-missing-model.log");
    process.env.FAKE_GROK_PREFLIGHT_LOG_PATH = preflightLog;
    const modelStarted = join(scratch, "grok-missing-model.started");
    process.env.FAKE_MODEL_STARTED_PATH = modelStarted;
    const input = options("grok", "grok-missing-model");
    const result = await runLane(input);

    assert.equal(result.exitCode, 69);
    assert.equal(readFileSync(preflightLog, "utf8"), "attempt\n");
    assert.equal(existsSync(modelStarted), false);
    matchObject(receipt(input.receiptPath), {
      status: "unavailable-model",
      preflight: { status: "failed" },
    });
  });

  it("kills a timed-out child and preserves a failure receipt", async () => {
    process.env.FAKE_TIMEOUT = "1";
    const input = { ...options("claude"), timeoutMs: 30 };
    const result = await runLane(input);
    assert.equal(result.exitCode, 124);
    assert.equal(existsSync(input.outputPath), false);
    assert.equal(receipt(input.receiptPath).status, "timed-out");
  });

  it("does not spawn the model when preflight exhausts the wrapper deadline", async () => {
    const modelStarted = join(scratch, "deadline-model.started");
    const input = { ...options("claude", "preflight-deadline"), timeoutMs: PREFLIGHT_DEADLINE_MS };
    const runner = startRunner(input, {
      FAKE_PREFLIGHT_DELAY_MS: String(PREFLIGHT_HOLD_MS),
      FAKE_MODEL_STARTED_PATH: modelStarted,
    });

    assert.equal(await exitWithin(runner, RUN_BUDGET_MS), 124);
    assert.equal(existsSync(modelStarted), false);
    matchObject(receipt(input.receiptPath), {
      status: "timed-out",
      signal: "SIGTERM",
      preflight: { status: "timed-out" },
    });
  });

  it("lets a delayed wrapper lane finish when timeout is omitted", async () => {
    const input = options("claude", "unbounded-default");
    const runner = startRunner(input, { FAKE_MODEL_DELAY_MS: "400" });

    assert.equal(await exitWithin(runner, RUN_BUDGET_MS), 0);
    matchObject(receipt(input.receiptPath), {
      status: "complete",
      signal: null,
    });
    assert.ok(receipt(input.receiptPath).elapsedMs >= 400);
  });

  it("keeps a very long explicit deadline without timer overflow", async () => {
    const input = {
      ...options("claude", "long-runtime-deadline"),
      timeoutMs: 2_147_483_648,
    };
    const runner = startRunner(input, { FAKE_MODEL_DELAY_MS: "100" });

    assert.equal(await exitWithin(runner, RUN_BUDGET_MS), 0);
    matchObject(receipt(input.receiptPath), {
      status: "complete",
      signal: null,
      exitCode: 0,
    });
  });

  it("counts wrapper import and parsing time against an explicit deadline", async () => {
    const preflightStarted = join(scratch, "expired-preflight.started");
    const modelStarted = join(scratch, "expired-model.started");
    process.env.FAKE_PREFLIGHT_STARTED_PATH = preflightStarted;
    process.env.FAKE_MODEL_STARTED_PATH = modelStarted;
    const input = { ...options("claude", "expired-at-entry"), timeoutMs: 100 };
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await main(
      runnerArgs(input).slice(1),
      Date.now() - 1_000,
      {
        stdout: (value) => stdout.push(value),
        stderr: (value) => stderr.push(value),
      }
    );

    assert.equal(exitCode, 124);
    assert.deepEqual(stdout, []);
    assert.ok(stderr.join("").includes('"status":"timed-out"'));
    assert.equal(existsSync(preflightStarted), false);
    assert.equal(existsSync(modelStarted), false);
    matchObject(receipt(input.receiptPath), {
      status: "timed-out",
      preflight: { status: "timed-out" },
    });
  });

  it("spends one explicit deadline across preflight and model execution", async () => {
    // Each stage alone fits the deadline, preflight with ~800 ms to spare for
    // spawning the warm fake CLI under load; together they exceed it, so only a
    // shared deadline lets preflight pass and still cuts the model short. Left
    // to finish, the two stages would end past the elapsed bound.
    warm("claude");
    process.env.FAKE_PREFLIGHT_DELAY_MS = "1200";
    process.env.FAKE_MODEL_DELAY_MS = "1600";
    const input = { ...options("claude"), timeoutMs: 2_000 };
    const result = await runLane(input);
    const recorded = receipt(input.receiptPath);

    assert.equal(result.exitCode, 124);
    assert.equal(recorded.status, "timed-out");
    assert.equal(recorded.preflight.status, "passed");
    assert.ok(recorded.elapsedMs < 2_700);
  });

  it("bounds a descendant-held pipe by the explicit deadline without fabricating a signal", async () => {
    const descendantPidPath = join(scratch, "deadline-descendant.pid");
    const input = { ...options("claude", "deadline-drain"), timeoutMs: DRAIN_DEADLINE_MS };
    warm("claude");
    const runner = startRunner(input, {
      FAKE_DESCENDANT_HOLDS_PIPES_MS: String(DESCENDANT_HOLD_MS),
      FAKE_DESCENDANT_PID_PATH: descendantPidPath,
    });

    assert.equal(await exitWithin(runner, DESCENDANT_HOLD_MS / 2), 124);
    const recorded = receipt(input.receiptPath);
    matchObject(recorded, {
      status: "timed-out",
      exitCode: 0,
      signal: null,
      preflight: { status: "passed" },
    });
    assert.ok(recorded.elapsedMs < DESCENDANT_HOLD_MS / 2);

    const descendantPid = Number(readFileSync(descendantPidPath, "utf8"));
    if (processIsAlive(descendantPid)) process.kill(descendantPid, "SIGKILL");
  });

  it("does not claim a signal was sent to an already signal-reaped child", async () => {
    const descendantPidPath = join(scratch, "signalled-descendant.pid");
    const input = { ...options("claude", "signalled-drain"), timeoutMs: DRAIN_DEADLINE_MS };
    warm("claude");
    const runner = startRunner(input, {
      FAKE_DESCENDANT_HOLDS_PIPES_MS: String(DESCENDANT_HOLD_MS),
      FAKE_DESCENDANT_PID_PATH: descendantPidPath,
      FAKE_SELF_SIGNAL: "SIGTERM",
    });

    assert.equal(await exitWithin(runner, DESCENDANT_HOLD_MS / 2), 124);
    matchObject(receipt(input.receiptPath), {
      status: "timed-out",
      exitCode: 143,
      signal: null,
      preflight: { status: "passed" },
    });

    const descendantPid = Number(readFileSync(descendantPidPath, "utf8"));
    if (processIsAlive(descendantPid)) process.kill(descendantPid, "SIGKILL");
  });

  it("lets manual cancellation end a post-exit pipe drain without a default timeout", async () => {
    const descendantPidPath = join(scratch, "cancel-descendant.pid");
    const modelExiting = join(scratch, "cancel-model.exiting");
    const input = options("claude", "cancel-drain");
    const runner = startRunner(input, {
      FAKE_DESCENDANT_HOLDS_PIPES_MS: String(DESCENDANT_HOLD_MS),
      FAKE_DESCENDANT_PID_PATH: descendantPidPath,
      FAKE_MODEL_EXITING_PATH: modelExiting,
    });
    await waitFor(modelExiting);
    await waitForExit(Number(readFileSync(modelExiting, "utf8")));
    runner.child.kill("SIGTERM");

    assert.equal(await exitWithin(runner, DESCENDANT_HOLD_MS / 2), 130);
    matchObject(receipt(input.receiptPath), {
      status: "cancelled",
      exitCode: 0,
      signal: null,
      preflight: { status: "passed" },
      error: { message: "launcher received SIGTERM after child exited" },
    });

    const descendantPid = Number(readFileSync(descendantPidPath, "utf8"));
    if (processIsAlive(descendantPid)) process.kill(descendantPid, "SIGKILL");
  });

  it("clears a losing long-deadline timer when the shipped wrapper succeeds", async () => {
    const input = { ...options("claude", "long-deadline"), timeoutMs: 60_000 };
    const runner = startRunner(input);

    assert.equal(await exitWithin(runner, RUN_BUDGET_MS), 0);
    assert.equal(receipt(input.receiptPath).status, "complete");
  });

  it("cancels a preflight with SIGINT and writes a terminal receipt", async () => {
    const input = options("claude", "preflight-cancelled");
    const started = join(scratch, "preflight-child.started");
    const terminated = join(scratch, "preflight-child.terminated");
    const runner = startRunner(input, {
      FAKE_CANCEL_STAGE: "preflight",
      FAKE_STARTED_PATH: started,
      FAKE_TERMINATED_PATH: terminated,
    });
    await waitFor(started);
    runner.child.kill("SIGINT");

    assert.equal(await exitWithin(runner, 3_000), 130);
    assert.equal(readFileSync(terminated, "utf8"), "SIGINT");
    assert.equal(existsSync(input.outputPath), false);
    matchObject(receipt(input.receiptPath), {
      status: "cancelled",
      signal: "SIGINT",
      preflight: { status: "cancelled" },
    });
  });

  it("reaps the child and exits after repeated cancellation with a long deadline", async () => {
    const input = { ...options("codex", "repeated-cancel"), timeoutMs: 60_000 };
    const started = join(scratch, "repeated-child.started");
    const terminated = join(scratch, "repeated-child.terminated");
    const runner = startRunner(input, {
      FAKE_CANCEL: "1",
      FAKE_IGNORE_SIGNAL: "1",
      FAKE_STARTED_PATH: started,
      FAKE_TERMINATED_PATH: terminated,
    });
    await waitFor(started);
    const childPid = Number(readFileSync(started, "utf8"));
    runner.child.kill("SIGTERM");
    await sleep(100);
    runner.child.kill("SIGTERM");

    assert.equal(await exitWithin(runner, 4_000), 130);
    assert.equal(readFileSync(terminated, "utf8"), "SIGTERM");
    assert.equal(processIsAlive(childPid), false);
    assert.equal(existsSync(input.outputPath), false);
    matchObject(receipt(input.receiptPath), {
      status: "cancelled",
      signal: "SIGTERM",
    });
  });

  it("forwards cancellation, preserves its receipt, and permits a new attempt", async () => {
    const input = options("codex", "cancelled");
    const started = join(scratch, "cancelled-child.started");
    const terminated = join(scratch, "cancelled-child.terminated");
    const runner = startRunner(input, {
      FAKE_CANCEL: "1",
      FAKE_STARTED_PATH: started,
      FAKE_TERMINATED_PATH: terminated,
    });
    await waitFor(started);
    runner.child.kill("SIGTERM");

    assert.equal(await finish(runner), 130);
    assert.equal(readFileSync(terminated, "utf8"), "SIGTERM");
    assert.equal(existsSync(input.outputPath), false);
    matchObject(receipt(input.receiptPath), {
      status: "cancelled",
      signal: "SIGTERM",
      exitCode: 0,
      error: { message: "launcher received SIGTERM; signal was sent to child" },
    });

    const samePaths = startRunner(input);
    assert.equal(await finish(samePaths), 64);
    assert.equal(receipt(input.receiptPath).status, "cancelled");

    const retry = options("codex", "cancelled-retry");
    const result = await runLane(retry);
    assert.equal(result.exitCode, 0);
    assert.equal(receipt(retry.receiptPath).status, "complete");
  });

  it("reports a missing CLI without fabricating output", async () => {
    process.env.PATH = join(scratch, "empty-bin");
    mkdirSync(process.env.PATH);
    const input = options("grok");
    const result = await runLane(input);
    assert.equal(result.exitCode, 69);
    assert.equal(existsSync(input.outputPath), false);
    assert.equal(receipt(input.receiptPath).status, "unavailable-cli");
  });

  it("runs simultaneous same-provider lanes only into their unique paths", async () => {
    const first = options("grok", "first");
    const second = options("grok", "second");
    const results = await Promise.all([runLane(first), runLane(second)]);
    assert.deepEqual(results.map((result) => result.exitCode), [0, 0]);
    assert.notEqual(first.outputPath, second.outputPath);
    assert.equal(receipt(first.receiptPath).sessionId, "g1");
    assert.equal(receipt(second.receiptPath).sessionId, "g1");
  });

  it("refuses a second writer for an already-reserved path", async () => {
    const input = options("claude");
    writeFileSync(input.outputPath, "owned");
    await assert.rejects(runLane(input));
    assert.equal(readFileSync(input.outputPath, "utf8"), "owned");
    assert.equal(existsSync(input.receiptPath), false);
  });

  it("terminalizes catchable failures after reserving output paths", async () => {
    const unreadable = options("claude", "unreadable-prompt");
    chmodSync(unreadable.promptPath, 0o000);
    const unreadableRunner = startRunner(unreadable);
    assert.equal(await finish(unreadableRunner), 70);
    chmodSync(unreadable.promptPath, 0o600);

    const preservedReceipt = readFileSync(unreadable.receiptPath, "utf8");
    assert.ok(statSync(unreadable.receiptPath).size > 0);
    assert.equal(existsSync(unreadable.outputPath), false);
    matchObject(receipt(unreadable.receiptPath), {
      status: "child-failed",
      preflight: { status: "not-run" },
      error: { message: "launcher failed after reserving output paths" },
    });

    const samePaths = startRunner(unreadable);
    assert.equal(await finish(samePaths), 64);
    assert.equal(readFileSync(unreadable.receiptPath, "utf8"), preservedReceipt);

    const spawnFailure = options("claude", "spawn-failure");
    const modelStarted = join(scratch, "spawn-failure-model.started");
    const spawnRunner = startRunner(spawnFailure, {
      FAKE_REMOVE_EXECUTABLE_AFTER_PREFLIGHT: "1",
      FAKE_MODEL_STARTED_PATH: modelStarted,
    });
    assert.equal(await finish(spawnRunner), 70);
    assert.equal(existsSync(modelStarted), false);
    assert.equal(existsSync(spawnFailure.outputPath), false);
    matchObject(receipt(spawnFailure.receiptPath), {
      status: "child-failed",
      preflight: { status: "passed" },
    });

    makeExecutable("claude");
    const retry = options("claude", "post-reservation-retry");
    assert.equal((await runLane(retry)).exitCode, 0);
    assert.equal(receipt(retry.receiptPath).status, "complete");
  });

  for (const provider of PROVIDERS) {
    it(`runs a fresh ${provider} session for a ${provider} parent`, async () => {
      process.env.CLAUDECODE = "1";
      process.env.CODEX_THREAD_ID = "retained-parent";
      process.env.FAKE_REJECT_PARENT_IDENTITY = "1";
      const input = { ...options(provider), parent: provider };
      const result = await runLane(input);
      assert.equal(result.exitCode, 0);
      matchObject(receipt(input.receiptPath), {
        status: "complete", parent: provider, provider,
        model: input.model, effort: input.effort, mode: "read-only",
      });
      assert.equal(readFileSync(input.outputPath, "utf8"), `${provider.toUpperCase()}_OK`);
    });
  }

  it("runs two rounds of 14 Codex reviews in small waves with separate prompts, sessions, and receipts", async () => {
    process.env.FAKE_ECHO_PROMPT = "1";
    process.env.FAKE_REJECT_PARENT_IDENTITY = "1";
    process.env.CODEX_THREAD_ID = "retained-parent";
    const sessions = new Set<string>();
    for (let round = 1; round <= 2; round += 1) {
      const inputs = Array.from({ length: 14 }, (_, index) => {
        const name = `round-${round}-review-${index + 1}`;
        const promptPath = join(scratch, `${name}.md`);
        writeFileSync(promptPath, `Review ${name} at commit abc123.\n`);
        return { ...options("codex", name), parent: "codex", model: "gpt-6.1-sol", effort: "xhigh", promptPath };
      });
      for (let offset = 0; offset < inputs.length; offset += 3) {
        const wave = inputs.slice(offset, offset + 3);
        const results = await Promise.all(wave.map((input) => runLane(input)));
        for (const [index, result] of results.entries()) {
          const input = wave[index];
          assert.equal(result.exitCode, 0);
          const recorded = receipt(input.receiptPath);
          matchObject(recorded, {
            status: "complete", parent: "codex", provider: "codex",
            model: "gpt-6.1-sol", effort: "xhigh", mode: "read-only",
            promptPath: input.promptPath, outputPath: input.outputPath,
          });
          assert.ok(recorded.sessionId !== null);
          assert.equal(sessions.has(recorded.sessionId), false);
          sessions.add(recorded.sessionId);
          assert.equal(readFileSync(input.outputPath, "utf8"), readFileSync(input.promptPath, "utf8"));
        }
      }
    }
    assert.equal(sessions.size, 28);
  });

  it("does not turn a same-provider CLI failure into an approval", async () => {
    process.env.FAKE_INVALID_MODEL = "1";
    const input = { ...options("codex"), parent: "codex" };
    const result = await runLane(input);
    assert.notEqual(result.exitCode, 0);
    assert.equal(receipt(input.receiptPath).status, "unavailable-model");
    assert.equal(existsSync(input.outputPath), false);
  });

  it("refuses to forward conversation MCP configuration through a same-provider CLI", async () => {
    const input = { ...options("codex"), parent: "codex", mcpConfigPath: join(scratch, "mcp.json") };
    await assert.rejects(runLane(input), /MCP configuration requires --transport grok-acp/);
    assert.equal(existsSync(input.outputPath), false);
    assert.equal(existsSync(input.receiptPath), false);
  });

  it("rejects a versioned Claude family before it can stay pinned", async () => {
    const input = { ...options("claude"), model: "claude-fable-9-9" };
    await assert.rejects(
      runLane(input),
      /normalize it to fable before invoking the runner/
    );
    assert.equal(existsSync(input.outputPath), false);
    assert.equal(existsSync(input.receiptPath), false);
  });

  it("rejects a pair or effort the matrix does not declare, before reserving paths", async () => {
    const unknownPair = { ...options("claude", "unknown-pair"), model: "sonnet" };
    await assert.rejects(
      runLane(unknownPair),
      /claude:sonnet is not a family in model-matrix.json/
    );
    assert.equal(existsSync(unknownPair.outputPath), false);
    assert.equal(existsSync(unknownPair.receiptPath), false);

    const badEffort = { ...options("grok", "bad-effort"), effort: "ultra" };
    await assert.rejects(runLane(badEffort), /grok does not select effort ultra/);
    assert.equal(existsSync(badEffort.receiptPath), false);

    const unknownProvider = { ...options("grok", "unknown-provider"), provider: "gemini" };
    await assert.rejects(runLane(unknownProvider), /provider gemini is not in model-matrix.json/);
  });
});

describe("Grok environment policy", () => {
  const PARENT_ENV = ["GROK_CONFIG", "GROK_CONFIG_PATH"] as const;
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of PARENT_ENV) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of PARENT_ENV) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  for (const mode of ["read-only", "isolated-write"] as const) {
    it(`runs the ${mode} Grok lane under the lane's overlay and removes it afterwards`, async () => {
      const record = join(scratch, "overlay.json");
      process.env.FAKE_GROK_CONFIG_RECORD_PATH = record;
      process.env.GROK_CONFIG = '{"models":{"default_reasoning_effort":"low"}}';
      process.env.GROK_CONFIG_PATH = join(scratch, "parent-overlay.toml");
      const input = { ...options("grok", mode), mode };
      assert.equal((await runLane(input)).exitCode, 0);
      const seen = JSON.parse(readFileSync(record, "utf8")) as { path: string; content: string; inline: string | null };
      assert.equal(seen.content, '[shell_environment_policy]\ninherit = "core"\n');
      assert.equal(seen.inline, null);
      assert.notEqual(seen.path, process.env.GROK_CONFIG_PATH);
      assert.ok(!seen.path.startsWith(input.cwd));
      assert.equal(existsSync(seen.path), false);
      assert.equal(existsSync(dirname(seen.path)), false);
    });
  }
});

describe("evidence", () => {
  it("keeps short output whole and, past the limit, the head plus the tail", () => {
    assert.equal(evidence("  short  "), "short");
    const init = `{"type":"system","subtype":"init","tools":[${'"x",'.repeat(2_000)}"y"]}`;
    const result = '{"type":"result","subtype":"error","is_error":true,"outcome":"permission_cancelled"}';
    const kept = evidence(`${init}\n${result}`);
    assert.ok(kept.length <= 4_000);
    assert.ok(kept.startsWith(init.slice(0, 1_000)));
    assert.ok(kept.endsWith(result));
    assert.ok(kept.includes("[…]"));
  });
});

describe("childEnvironment", () => {
  it("removes both parents' session identities while preserving configuration and credentials", () => {
    const source = {
      PATH: "/bin",
      CODEX_THREAD_ID: "codex",
      CODEX_CI: "1",
      CLAUDECODE: "1",
      CLAUDE_CODE_CHILD_SESSION: "1",
      CODEX_HOME: "/config/codex",
      CLAUDE_CONFIG_DIR: "/config/claude",
      OPENAI_API_KEY: "fixture-key",
      KEEP_ME: "yes",
    };
    assert.deepEqual(childEnvironment(source), {
      PATH: "/bin",
      CODEX_HOME: "/config/codex",
      CLAUDE_CONFIG_DIR: "/config/claude",
      OPENAI_API_KEY: "fixture-key",
      KEEP_ME: "yes",
    });
  });
});

describe("test isolation", () => {
  it("leaves no provider CLI on the PATH of the lanes once its fake is gone", () => {
    assert.deepEqual(clisOutsideFakes(process.env.PATH, [bin]), [], "a real CLI is on the PATH of the test process");
    for (const provider of PROVIDERS) {
      const cli = cliOf(provider);
      assert.equal(findExecutable(cli, process.env.PATH, scratch), join(bin, cli));
      rmSync(join(bin, cli));
      assert.equal(findExecutable(cli, process.env.PATH, scratch), null, `a real ${cli} is on the test PATH`);
    }
    assert.equal(findExecutable("node", process.env.PATH, scratch), join(process.env.HOME ?? "", ".node-bin", "node"));
    assert.equal(process.env.HOME, join(scratch, "home"));
  });
});

describe("findExecutable", () => {
  it("resolves the first executable regular file on PATH and nothing else", () => {
    const cli = cliOf("claude");
    assert.equal(findExecutable(cli, process.env.PATH, scratch), join(bin, cli));
    assert.equal(findExecutable("no-such-cli", process.env.PATH, scratch), null);
    mkdirSync(join(bin, "a-directory"));
    assert.equal(findExecutable("a-directory", process.env.PATH, scratch), null);
    writeFileSync(join(bin, "not-executable"), "#!/bin/sh\n");
    chmodSync(join(bin, "not-executable"), 0o644);
    assert.equal(findExecutable("not-executable", process.env.PATH, scratch), null);
    assert.equal(findExecutable(`bin/${cli}`, undefined, scratch), join(bin, cli));
  });
});
