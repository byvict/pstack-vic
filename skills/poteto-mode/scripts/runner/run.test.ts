import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { childEnvironment, evidence, findExecutable, runLane } from "./run.ts";
import { CURSOR_ENV } from "./http-lane.ts";
import { main } from "./cli.ts";
import { MATRIX, type Provider, type RunnerOptions, type RunnerReceipt } from "./types.ts";
import { matchObject } from "./match-object.test-helper.ts";

let scratch = "";
let bin = "";
let previousPath: string | undefined;

// The http lane snapshots this PR's head around the cloud run.
let bareRepo = "";

before(() => {
  bareRepo = mkdtempSync(join(tmpdir(), "pstack-runner-test-remote-"));
  execFileSync("git", ["init", "--quiet", "--bare", bareRepo], { stdio: ["ignore", "pipe", "pipe"] });
  const clone = mkdtempSync(join(tmpdir(), "pstack-runner-test-clone-"));
  try {
    execFileSync("git", ["clone", "--quiet", bareRepo, clone]);
    execFileSync("git", ["commit", "--allow-empty", "--quiet", "-m", "PR head"], { cwd: clone, env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid' } });
    execFileSync("git", ["push", "--quiet", "origin", "HEAD:refs/pull/7/head"], { cwd: clone });
  } finally { rmSync(clone, { recursive: true, force: true }); }
});

after(() => {
  rmSync(bareRepo, { recursive: true, force: true });
});

const CLI_PROVIDERS: readonly string[] = Object.entries(MATRIX.providers)
  .filter(([, spec]) => spec.transport === "cli")
  .map(([name]) => name);

const fake = `#!/usr/bin/env node
import { appendFileSync, existsSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { spawn } from "node:child_process";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const out = (text) => writeSync(1, text + "\\n");
const err = (text) => writeSync(2, text + "\\n");
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
if (startedPath) writeFileSync(startedPath, String(process.pid));
const cancelStage = process.env.FAKE_CANCEL_STAGE ??
  (process.env.FAKE_CANCEL === "1" ? "model" : "");
if (cancelStage === stage) {
  const stop = (signal) => {
    writeFileSync(process.env.FAKE_TERMINATED_PATH, signal);
    if (process.env.FAKE_IGNORE_SIGNAL !== "1") process.exit(0);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  writeFileSync(process.env.FAKE_STARTED_PATH, String(process.pid));
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
    writeFileSync(transientMarker, String(process.pid));
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
  : model === "opus"
    ? "claude-opus-9"
    : model;
if (process.env.FAKE_INVALID_MODEL === "1") {
  err("The requested model is not supported with this account.");
  process.exit(1);
}
if (stage === "model" && process.env.FAKE_DESCENDANT_HOLDS_PIPES_MS) {
  const seconds = Number(process.env.FAKE_DESCENDANT_HOLDS_PIPES_MS) / 1000;
  const descendant = spawn("/bin/sh", ["-c", "sleep " + seconds], {
    stdio: ["ignore", "inherit", "inherit"],
    detached: true,
  });
  if (process.env.FAKE_DESCENDANT_PID_PATH) {
    writeFileSync(process.env.FAKE_DESCENDANT_PID_PATH, String(descendant.pid));
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
  writeFileSync(process.env.FAKE_MODEL_EXITING_PATH, String(process.pid));
}
`;

const LAUNCHER = join(import.meta.dirname, "pstack-runner");

function makeExecutable(name: string): void {
  const path = join(bin, name);
  writeFileSync(path, fake);
  chmodSync(path, 0o755);
}

function options(provider: Provider, suffix: string = provider): RunnerOptions {
  const parent = provider === "codex" ? "claude" : "codex";
  const model =
    provider === "claude"
      ? "fable"
      : provider === "codex"
        ? "gpt-5.6-sol"
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
    target: null,
  };
}

function httpOptions(suffix: string): RunnerOptions {
  return {
    ...options("cursor", suffix),
    parent: "claude",
    model: "composer-2.5",
    effort: "high",
    target: { owner: "acme", name: "app", pullNumber: 7 },
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
  if (input.target !== null) {
    args.push(
      "--repo", `${input.target.owner}/${input.target.name}`,
      "--pr", String(input.target.pullNumber)
    );
  }
  return args;
}

interface FakeCursor {
  readonly env: NodeJS.ProcessEnv;
  readonly requests: readonly string[];
  close(): Promise<void>;
}

async function fakeCursor(finished: boolean): Promise<FakeCursor> {
  const requests: string[] = [];
  const runPath = "/v1/agents/bc_1/runs/run_1";
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const route = `${request.method} ${request.url}`;
      requests.push(route);
      const answer = (body: unknown): void => {
        response.writeHead(200, { "content-type": "application/json", connection: "close" });
        response.end(JSON.stringify(body));
      };
      if (route === "GET /v1/models") {
        answer({ items: [{
          id: "composer-2.5",
          parameters: [{
            id: "fast",
            values: [{ value: "false" }, { value: "true" }],
          }],
          variants: [
            {
              params: [{ id: "fast", value: "true" }],
              isDefault: true,
            },
            {
              params: [{ id: "fast", value: "false" }],
            },
          ],
        }] });
      } else if (route === "POST /v1/agents") {
        answer({ agent: { id: "bc_1", url: "https://cursor.com/agents/bc_1" }, run: { id: "run_1" } });
      } else if (route === `GET ${runPath}`) {
        answer(finished
          ? { id: "run_1", status: "FINISHED", result: "pong", git: { branches: [{ repoUrl: "x" }] } }
          : { id: "run_1", status: "RUNNING" });
      } else if (route === `POST ${runPath}/cancel`) {
        answer({ id: "run_1" });
      } else {
        response.writeHead(404, { connection: "close" });
        response.end();
      }
    });
  });
  server.unref();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fake did not bind a port");
  return {
    env: {
      [CURSOR_ENV.apiKey]: "test-key",
      [CURSOR_ENV.baseUrl]: `http://127.0.0.1:${address.port}`,
      [CURSOR_ENV.pollIntervalMs]: "5",
      [CURSOR_ENV.gitRemote]: bareRepo,
    },
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
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

function startRunner(
  input: RunnerOptions,
  env: NodeJS.ProcessEnv = {}
): Runner {
  const child = spawn(process.execPath, runnerArgs(input), {
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
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (existsSync(path)) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function exitWithin(runner: Runner, milliseconds: number): Promise<number> {
  const result = await Promise.race([
    runner.exited,
    sleep(milliseconds).then(() => null),
  ]);
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
] as const;

function clearFakeEnv(): void {
  for (const key of FAKE_ENV) delete process.env[key];
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "pstack-runner-test-"));
  bin = join(scratch, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "package.json"), '{"type":"module"}\n');
  writeFileSync(join(scratch, "prompt.md"), "Return the marker.");
  for (const name of CLI_PROVIDERS) makeExecutable(name);
  previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${dirname(process.execPath)}:${previousPath ?? ""}`;
  clearFakeEnv();
});

afterEach(() => {
  process.env.PATH = previousPath;
  clearFakeEnv();
  rmSync(scratch, { recursive: true, force: true });
});

describe("runLane", () => {
  it("drives every matrix cli provider through the fake binaries", () => {
    assert.deepEqual(CLI_PROVIDERS, ["claude", "codex", "grok"]);
  });

  for (const provider of CLI_PROVIDERS) {
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
        remote: null,
      });
      if (provider === "claude") {
        assert.equal(receipt(input.receiptPath).reportedModel, "claude-fable-9-9");
      }
      if (provider === "grok") {
        assert.equal(receipt(input.receiptPath).reportedModel, "grok-4.6");
      }
    });
  }

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
      model: "gpt-5.6-sol",
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
      model: "gpt-5.6-sol",
      reportedModel: null,
      modelVerified: false,
      modelEvidence: null,
    });
  });

  it("retries a contradictory Grok authentication preflight before running the model", { timeout: 10_000 }, async () => {
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

  it("classifies Grok authentication failure after two consecutive preflights", { timeout: 10_000 }, async () => {
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
    const transientMarker = join(scratch, "grok-deadline-unauth.seen");
    const preflightLog = join(scratch, "grok-deadline-unauth.log");
    process.env.FAKE_GROK_TRANSIENT_UNAUTH_PATH = transientMarker;
    process.env.FAKE_GROK_PREFLIGHT_LOG_PATH = preflightLog;
    const modelStarted = join(scratch, "grok-deadline-model.started");
    process.env.FAKE_MODEL_STARTED_PATH = modelStarted;
    const input = {
      ...options("grok", "grok-preflight-retry-deadline"),
      timeoutMs: 700,
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
    assert.ok(recorded.elapsedMs < 1_200);
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
    const input = { ...options("claude", "preflight-deadline"), timeoutMs: 300 };
    const runner = startRunner(input, {
      FAKE_PREFLIGHT_DELAY_MS: "1000",
      FAKE_MODEL_STARTED_PATH: modelStarted,
    });

    assert.equal(await exitWithin(runner, 2_000), 124);
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

    assert.equal(await exitWithin(runner, 3_000), 0);
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

    assert.equal(await exitWithin(runner, 2_000), 0);
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
    // Each stage alone fits the deadline with ~800 ms to spare for spawning the
    // fake CLI under load; together they exceed it, so only a shared deadline
    // lets preflight pass and still cuts the model short.
    process.env.FAKE_PREFLIGHT_DELAY_MS = "1200";
    process.env.FAKE_MODEL_DELAY_MS = "1200";
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
    const input = { ...options("claude", "deadline-drain"), timeoutMs: 700 };
    const runner = startRunner(input, {
      FAKE_DESCENDANT_HOLDS_PIPES_MS: "5000",
      FAKE_DESCENDANT_PID_PATH: descendantPidPath,
    });

    assert.equal(await exitWithin(runner, 2_000), 124);
    const recorded = receipt(input.receiptPath);
    matchObject(recorded, {
      status: "timed-out",
      exitCode: 0,
      signal: null,
      preflight: { status: "passed" },
    });
    assert.ok(recorded.elapsedMs < 1_500);

    const descendantPid = Number(readFileSync(descendantPidPath, "utf8"));
    if (processIsAlive(descendantPid)) process.kill(descendantPid, "SIGKILL");
  });

  it("does not claim a signal was sent to an already signal-reaped child", async () => {
    const descendantPidPath = join(scratch, "signalled-descendant.pid");
    const input = { ...options("claude", "signalled-drain"), timeoutMs: 700 };
    const runner = startRunner(input, {
      FAKE_DESCENDANT_HOLDS_PIPES_MS: "5000",
      FAKE_DESCENDANT_PID_PATH: descendantPidPath,
      FAKE_SELF_SIGNAL: "SIGTERM",
    });

    assert.equal(await exitWithin(runner, 2_000), 124);
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
      FAKE_DESCENDANT_HOLDS_PIPES_MS: "5000",
      FAKE_DESCENDANT_PID_PATH: descendantPidPath,
      FAKE_MODEL_EXITING_PATH: modelExiting,
    });
    await waitFor(modelExiting);
    await waitForExit(Number(readFileSync(modelExiting, "utf8")));
    runner.child.kill("SIGTERM");

    assert.equal(await exitWithin(runner, 2_000), 130);
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

    assert.equal(await exitWithin(runner, 3_000), 0);
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

  it("runs the http provider through the launcher without a binary and refuses a reused receipt path before any request", async () => {
    const fake = await fakeCursor(true);
    try {
      const input = httpOptions("cursor-complete");
      const runner = startRunner(input, fake.env);
      assert.equal(await exitWithin(runner, 5_000), 0);
      assert.equal(readFileSync(input.outputPath, "utf8"), "pong");
      matchObject(receipt(input.receiptPath), {
        status: "complete",
        provider: "cursor",
        executable: null,
        exitCode: null,
        signal: null,
        modelEvidence: "pinned-argv",
        argv: ["POST", "/v1/agents", "composer-2.5", "high"],
        remote: { agentId: "bc_1", runId: "run_1", heads: { kind: "observed", changedBranches: [] } },
      });
      assert.deepEqual(fake.requests, [
        "GET /v1/models",
        "POST /v1/agents",
        "GET /v1/agents/bc_1/runs/run_1",
      ]);

      const seen = fake.requests.length;
      const samePaths = startRunner(input, fake.env);
      assert.equal(await finish(samePaths), 64);
      assert.equal(fake.requests.length, seen);
      assert.equal(receipt(input.receiptPath).status, "complete");
    } finally {
      await fake.close();
    }
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    it(`cancels an http lane on ${signal}, sends one cancel request, and receipts cancelled`, async () => {
      const fake = await fakeCursor(false);
      try {
        const input = httpOptions(`cursor-${signal}`);
        const runner = startRunner(input, fake.env);
        for (let attempt = 0; attempt < 300; attempt += 1) {
          if (fake.requests.includes("GET /v1/agents/bc_1/runs/run_1")) break;
          await sleep(10);
        }
        assert.ok(fake.requests.includes("GET /v1/agents/bc_1/runs/run_1"), "the lane never polled");
        runner.child.kill(signal);

        assert.equal(await exitWithin(runner, 3_000), 130);
        assert.equal(existsSync(input.outputPath), false);
        matchObject(receipt(input.receiptPath), {
          status: "cancelled",
          signal: null,
          exitCode: null,
          preflight: { status: "passed" },
          argv: ["POST", "/v1/agents", "composer-2.5", "high", "POST", "/v1/agents/bc_1/runs/run_1/cancel"],
          remote: { agentId: "bc_1", runId: "run_1" },
          error: {
            message: `launcher received ${signal} while polling the cloud agent; cancel requested`,
            evidence: "cancel acknowledged",
          },
        });
        assert.equal(
          fake.requests.filter((route) => route === "POST /v1/agents/bc_1/runs/run_1/cancel").length,
          1
        );
      } finally {
        await fake.close();
      }
    });
  }

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

describe("findExecutable", () => {
  it("resolves the first executable regular file on PATH and nothing else", () => {
    assert.equal(findExecutable("claude", process.env.PATH, scratch), join(bin, "claude"));
    assert.equal(findExecutable("no-such-cli", process.env.PATH, scratch), null);
    mkdirSync(join(bin, "a-directory"));
    assert.equal(findExecutable("a-directory", process.env.PATH, scratch), null);
    writeFileSync(join(bin, "not-executable"), "#!/bin/sh\n");
    chmodSync(join(bin, "not-executable"), 0o644);
    assert.equal(findExecutable("not-executable", process.env.PATH, scratch), null);
    assert.equal(findExecutable("bin/claude", undefined, scratch), join(bin, "claude"));
  });
});
