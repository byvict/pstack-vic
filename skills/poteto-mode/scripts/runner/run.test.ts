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
import { childEnvironment, evidence, findExecutable, runLane } from "./run.ts";
import { main } from "./cli.ts";
import { cliFor, PROVIDERS, type Provider, type RunnerOptions, type RunnerReceipt } from "./types.ts";
import { matchObject } from "./match-object.test-helper.ts";
import { clisOutsideFakes, isolateProcessEnv } from "./isolated-env.test-helper.ts";

let scratch = "";
let bin = "";
let restoreProcessEnv: () => void = () => {};

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
  out(JSON.stringify({type:"thread.started",thread_id:"o1"}));
  out(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"CODEX_OK"}}));
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
function warm(provider: Provider): void {
  execFileSync(join(bin, cliOf(provider)), [], { env: { PATH: process.env.PATH }, stdio: "ignore" });
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
  "FAKE_GROK_TRANSIENT_UNAUTH_PATH",
  "FAKE_GROK_PREFLIGHT_LOG_PATH",
  "FAKE_GROK_MISSING_MODEL",
  "FAKE_DESCENDANT_HOLDS_PIPES_MS",
  "FAKE_DESCENDANT_PID_PATH",
  "FAKE_SELF_SIGNAL",
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
  clearFakeEnv();
});

afterEach(() => {
  restoreProcessEnv();
  clearFakeEnv();
  rmSync(scratch, { recursive: true, force: true });
});

/** The fake, with the model run replaced by writing these bytes and exiting. */
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

function writeGrok(script: string): void {
  writeFileSync(join(bin, cliOf("grok")), script);
}

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
    const input = options("grok");
    writeGrok(fake.replace("const modelIndex =",
      'writeSync(1, "stream data"); await sleep(10_000);\nconst modelIndex ='));
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
      assert.ok(Date.now() - started < 10_000, "the run waited for the child's 10 s sleep");
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

  it("rejects same-provider recursion", async () => {
    const input = { ...options("claude"), parent: "claude" };
    await assert.rejects(runLane(input), /native to parent/);
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
  it("removes only inherited runtime identity needed to avoid nested detection", () => {
    const source = {
      PATH: "/bin",
      CODEX_THREAD_ID: "codex",
      CODEX_CI: "1",
      CLAUDECODE: "1",
      CLAUDE_CODE_CHILD_SESSION: "1",
      KEEP_ME: "yes",
    };
    assert.deepEqual(childEnvironment("claude", source), {
      PATH: "/bin",
      CLAUDECODE: "1",
      CLAUDE_CODE_CHILD_SESSION: "1",
      KEEP_ME: "yes",
    });
    assert.deepEqual(childEnvironment("codex", source), {
      PATH: "/bin",
      CODEX_THREAD_ID: "codex",
      CODEX_CI: "1",
      KEEP_ME: "yes",
    });
    assert.deepEqual(childEnvironment("grok", source), {
      PATH: "/bin",
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
