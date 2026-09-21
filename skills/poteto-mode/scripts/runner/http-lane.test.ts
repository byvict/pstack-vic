import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURSOR_ENV } from "./http-lane.ts";
import { findExecutable, runLane } from "./run.ts";
import type { AccessMode, RunnerReceipt } from "./types.ts";
import { matchObject } from "./match-object.test-helper.ts";

type RunStatus = "CREATING" | "RUNNING" | "FINISHED" | "ERROR" | "CANCELLED" | "EXPIRED";

interface FakeModel {
  readonly id: string;
  readonly efforts?: readonly string[];
}

interface FakeScript {
  readonly models?: readonly FakeModel[];
  /** Status code the preflight answers with instead of the inventory. */
  readonly modelsStatus?: number;
  readonly runs?: readonly RunStatus[];
  readonly result?: string;
  readonly branches?: readonly { readonly repoUrl: string; readonly branch?: string; readonly prUrl?: string }[];
  readonly pollStatus?: number;
  readonly cancelStatus?: number;
  /** Runs right before the fake answers FINISHED; the push cases push from the work clone here. */
  readonly beforeFinish?: () => void;
}

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly auth: string | undefined;
  readonly body: unknown;
}

interface FakeCursor {
  readonly baseUrl: string;
  readonly requests: readonly RecordedRequest[];
  close(): Promise<void>;
}

const INVENTORY: readonly FakeModel[] = [
  { id: "composer-2.5" },
  { id: "grok-4.6", efforts: ["low", "medium", "high", "xhigh"] },
];

const REPO_URL = "https://github.com/acme/app";
const RUN_PATH = "/v1/agents/bc_1/runs/run_1";
const BASIC_AUTH = `Basic ${Buffer.from("test-key:").toString("base64")}`;

function modelItem(model: FakeModel): unknown {
  const effort = model.efforts === undefined
    ? []
    : [{ id: "effort", displayName: "Effort", values: model.efforts.map((value) => ({ value })) }];
  return {
    id: model.id,
    displayName: model.id,
    parameters: [...effort, { id: "fast", displayName: "Fast", values: [{ value: "true" }, { value: "false" }] }],
    variants: [],
  };
}

const fakes: FakeCursor[] = [];

async function fakeCursor(script: FakeScript = {}): Promise<FakeCursor> {
  const requests: RecordedRequest[] = [];
  const runs = script.runs ?? ["FINISHED"];
  let polls = 0;
  const server = createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      raw += chunk;
    });
    request.on("end", () => {
      const method = request.method ?? "";
      const path = request.url ?? "";
      requests.push({
        method,
        path,
        auth: request.headers.authorization,
        body: raw.length > 0 ? (JSON.parse(raw) as unknown) : null,
      });
      const answer = (status: number, body: unknown): void => {
        response.writeHead(status, { "content-type": "application/json", connection: "close" });
        response.end(JSON.stringify(body));
      };
      if (method === "GET" && path === "/v1/models") {
        if (script.modelsStatus !== undefined) {
          answer(script.modelsStatus, { error: "refused" });
        } else {
          answer(200, { items: (script.models ?? INVENTORY).map(modelItem) });
        }
      } else if (method === "POST" && path === "/v1/agents") {
        answer(200, {
          agent: { id: "bc_1", status: "CREATING", url: "https://cursor.com/agents/bc_1", latestRunId: "run_1" },
          run: { id: "run_1", status: "CREATING", createdAt: "2026-09-21T12:00:00.000Z" },
        });
      } else if (method === "GET" && path === RUN_PATH) {
        if (script.pollStatus !== undefined) {
          answer(script.pollStatus, { error: "poll refused" });
        } else {
          const status = runs[Math.min(polls, runs.length - 1)];
          polls += 1;
          if (status === "FINISHED") script.beforeFinish?.();
          answer(200, {
            id: "run_1",
            agentId: "bc_1",
            status,
            createdAt: "2026-09-21T12:00:00.000Z",
            updatedAt: "2026-09-21T12:00:01.000Z",
            ...(status === "FINISHED" ? { result: script.result ?? "pong" } : {}),
            git: { branches: script.branches ?? [{ repoUrl: REPO_URL }] },
          });
        }
      } else if (method === "POST" && path === `${RUN_PATH}/cancel`) {
        answer(script.cancelStatus ?? 200, { id: "run_1" });
      } else {
        answer(404, { error: `no route for ${method} ${path}` });
      }
    });
  });
  server.unref();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fake did not bind a port");
  const fake: FakeCursor = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  fakes.push(fake);
  return fake;
}

function paths(fake: FakeCursor): string[] {
  return fake.requests.map((request) => `${request.method} ${request.path}`);
}

// One bare remote and one work clone serve every case: a lane's baseline is
// taken at its own start, so earlier pushes never count against a later lane.
let fixture = "";
let bareRepo = "";
let workClone = "";
let gitLog = "";
let previousPath: string | undefined;

const GIT_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
} as const;

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, env: { ...process.env, ...GIT_ENV }, stdio: ["ignore", "pipe", "pipe"] });
}

function pushBranch(branch: string): void {
  git(workClone, "commit", "--allow-empty", "--quiet", "-m", branch);
  git(workClone, "push", "--quiet", "origin", `HEAD:refs/heads/${branch}`);
}

function lsRemoteCalls(): string[] {
  if (!existsSync(gitLog)) return [];
  return readFileSync(gitLog, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("ls-remote --heads "));
}

before(() => {
  fixture = mkdtempSync(join(tmpdir(), "pstack-http-lane-git-"));
  bareRepo = join(fixture, "remote.git");
  workClone = join(fixture, "work");
  gitLog = join(fixture, "git.log");
  const realGit = findExecutable("git", process.env.PATH, fixture);
  assert.ok(realGit !== null, "git is required on PATH");
  mkdirSync(join(fixture, "bin"));
  writeFileSync(
    join(fixture, "bin", "git"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(gitLog)}\nexec ${JSON.stringify(realGit)} "$@"\n`,
    { mode: 0o755 }
  );
  git(fixture, "init", "--quiet", "--bare", "--initial-branch=main", bareRepo);
  git(fixture, "clone", "--quiet", bareRepo, workClone);
  pushBranch("main");
  previousPath = process.env.PATH;
  process.env.PATH = `${join(fixture, "bin")}:${previousPath ?? ""}`;
});

after(() => {
  process.env.PATH = previousPath;
  rmSync(fixture, { recursive: true, force: true });
});

let scratch = "";
const ENV_KEYS = [
  CURSOR_ENV.apiKey,
  CURSOR_ENV.baseUrl,
  CURSOR_ENV.pollIntervalMs,
  CURSOR_ENV.gitRemote,
] as const;
let previousEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "pstack-http-lane-test-"));
  writeFileSync(join(scratch, "prompt.md"), "Reply with the single word pong");
  previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
  await Promise.all(fakes.splice(0).map((fake) => fake.close()));
  rmSync(scratch, { recursive: true, force: true });
});

interface LaneOverrides {
  readonly apiKey?: string | null;
  readonly timeoutMs?: number | null;
  readonly mode?: AccessMode;
  readonly model?: string;
  readonly effort?: string;
  readonly suffix?: string;
  readonly started?: number;
  readonly gitRemote?: string;
}

interface LaneRun {
  readonly exitCode: number;
  readonly receipt: RunnerReceipt;
  readonly outputPath: string;
}

async function runHttpLane(fake: FakeCursor, overrides: LaneOverrides = {}): Promise<LaneRun> {
  if (overrides.apiKey === null) delete process.env[CURSOR_ENV.apiKey];
  else process.env[CURSOR_ENV.apiKey] = overrides.apiKey ?? "test-key";
  process.env[CURSOR_ENV.baseUrl] = fake.baseUrl;
  process.env[CURSOR_ENV.pollIntervalMs] = "5";
  process.env[CURSOR_ENV.gitRemote] = overrides.gitRemote ?? bareRepo;
  const suffix = overrides.suffix ?? "lane";
  const outputPath = join(scratch, `${suffix}.out`);
  const receiptPath = join(scratch, `${suffix}.receipt.json`);
  const result = await runLane(
    {
      parent: "claude",
      provider: "cursor",
      model: overrides.model ?? "composer-2.5",
      effort: overrides.effort ?? "high",
      mode: overrides.mode ?? "read-only",
      promptPath: join(scratch, "prompt.md"),
      cwd: scratch,
      outputPath,
      receiptPath,
      timeoutMs: overrides.timeoutMs ?? null,
      target: { owner: "acme", name: "app", pullNumber: 7 },
    },
    overrides.started ?? Date.now()
  );
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as RunnerReceipt;
  assert.deepEqual(receipt, JSON.parse(JSON.stringify(result.receipt)));
  return { exitCode: result.exitCode, receipt, outputPath };
}

describe("cursor http lane", () => {
  it("completes a FINISHED run with a pinned-argv receipt and the measured launch body", async () => {
    const fake = await fakeCursor({ runs: ["CREATING", "RUNNING", "FINISHED"], result: "pong" });
    const { exitCode, receipt, outputPath } = await runHttpLane(fake);

    assert.equal(exitCode, 0);
    assert.equal(readFileSync(outputPath, "utf8"), "pong");
    matchObject(receipt, {
      schemaVersion: 1,
      status: "complete",
      provider: "cursor",
      model: "composer-2.5",
      effort: "high",
      executable: null,
      exitCode: null,
      signal: null,
      reportedModel: null,
      modelVerified: false,
      modelEvidence: "pinned-argv",
      sessionId: "bc_1",
      usage: null,
      costUsd: null,
      error: null,
      preflight: { argv: ["GET", "/v1/models"], status: "passed", evidence: "authenticated; model composer-2.5 available" },
      argv: ["POST", "/v1/agents", "composer-2.5", "high"],
      remote: { agentId: "bc_1", runId: "run_1", agentUrl: "https://cursor.com/agents/bc_1", pushedBranches: [] },
    });
    assert.ok(!JSON.stringify(receipt).includes(fake.baseUrl));
    assert.ok(!JSON.stringify(receipt).includes("127.0.0.1"));

    assert.deepEqual(paths(fake), [
      "GET /v1/models",
      "POST /v1/agents",
      `GET ${RUN_PATH}`,
      `GET ${RUN_PATH}`,
      `GET ${RUN_PATH}`,
    ]);
    assert.ok(fake.requests.every((request) => request.auth === BASIC_AUTH));
    assert.deepEqual(fake.requests[1].body, {
      name: "pstack acme/app#7 composer-2.5@high",
      repos: [{ url: REPO_URL, prUrl: `${REPO_URL}/pull/7` }],
      workOnCurrentBranch: true,
      autoCreatePR: false,
      model: { id: "composer-2.5", params: [] },
      prompt: { text: "Reply with the single word pong" },
    });
  });

  it("sends effort only when the model lists it and never sends fast", async () => {
    const grok = await fakeCursor();
    const grokLane = await runHttpLane(grok, { model: "grok-4.6", effort: "xhigh", suffix: "grok" });
    assert.equal(grokLane.exitCode, 0);
    matchObject(grokLane.receipt, {
      argv: ["POST", "/v1/agents", "grok-4.6", "xhigh"],
      preflight: { evidence: "authenticated; model grok-4.6 available with effort xhigh" },
    });
    matchObject(grok.requests[1].body as Record<string, unknown>, {
      model: { id: "grok-4.6", params: [{ id: "effort", value: "xhigh" }] },
    });
    assert.ok(!JSON.stringify(grok.requests[1].body).includes("fast"));

    const composer = await fakeCursor();
    await runHttpLane(composer, { suffix: "composer" });
    matchObject(composer.requests[1].body as Record<string, unknown>, {
      model: { id: "composer-2.5", params: [] },
    });
    assert.ok(!JSON.stringify(composer.requests[1].body).includes("fast"));

    const narrow = await fakeCursor({ models: [{ id: "grok-4.6", efforts: ["low", "medium"] }] });
    const refused = await runHttpLane(narrow, { model: "grok-4.6", effort: "xhigh", suffix: "narrow" });
    assert.equal(refused.exitCode, 69);
    matchObject(refused.receipt, {
      status: "unavailable-model",
      preflight: { status: "failed" },
      error: {
        message: "model grok-4.6 does not select effort xhigh",
        evidence: "model grok-4.6 lists effort values: low, medium",
      },
      remote: { agentId: null, runId: null },
    });
    assert.deepEqual(paths(narrow), ["GET /v1/models"]);
  });

  it("reports a missing key as unavailable-cli without sending a request", async () => {
    const fake = await fakeCursor();
    const { exitCode, receipt, outputPath } = await runHttpLane(fake, { apiKey: null });
    assert.equal(exitCode, 69);
    assert.equal(existsSync(outputPath), false);
    matchObject(receipt, {
      status: "unavailable-cli",
      preflight: { argv: ["GET", "/v1/models"], status: "not-run", evidence: "" },
      argv: ["POST", "/v1/agents", "composer-2.5", "high"],
      error: { message: "CURSOR_API_KEY is not set", evidence: "" },
      remote: { agentId: null, runId: null, agentUrl: null, pushedBranches: [] },
    });
    assert.deepEqual(paths(fake), []);
  });

  it("maps 401 and 403 to unauthenticated and any other preflight failure to unavailable-cli", async () => {
    for (const status of [401, 403]) {
      const fake = await fakeCursor({ modelsStatus: status });
      const { exitCode, receipt } = await runHttpLane(fake, { suffix: `refused-${status}` });
      assert.equal(exitCode, 77);
      matchObject(receipt, {
        status: "unauthenticated",
        preflight: { status: "failed" },
        error: { message: "authentication preflight was refused" },
      });
      assert.ok(receipt.preflight.evidence.startsWith(`HTTP ${status}:`));
      assert.deepEqual(paths(fake), ["GET /v1/models"]);
    }

    const broken = await fakeCursor({ modelsStatus: 500 });
    const server = await runHttpLane(broken, { suffix: "server-error" });
    assert.equal(server.exitCode, 69);
    matchObject(server.receipt, { status: "unavailable-cli", preflight: { status: "failed" } });
    assert.ok(server.receipt.error?.evidence.startsWith("HTTP 500:"));

    const gone = await fakeCursor();
    await gone.close();
    const network = await runHttpLane(gone, { suffix: "network" });
    assert.equal(network.exitCode, 69);
    matchObject(network.receipt, { status: "unavailable-cli", preflight: { status: "failed" } });
    assert.ok((network.receipt.error?.evidence ?? "").length > 0);
    assert.deepEqual(paths(gone), []);
  });

  it("reports a model absent from the inventory and lists every inventory id", async () => {
    const fake = await fakeCursor({ models: [{ id: "composer-9" }, { id: "grok-4.6", efforts: ["high"] }] });
    const { exitCode, receipt } = await runHttpLane(fake);
    assert.equal(exitCode, 69);
    matchObject(receipt, {
      status: "unavailable-model",
      preflight: { status: "failed", evidence: "available models: composer-9, grok-4.6" },
      error: {
        message: "model composer-2.5 is not in the Cursor inventory",
        evidence: "available models: composer-9, grok-4.6",
      },
    });
    assert.deepEqual(paths(fake), ["GET /v1/models"]);
  });

  it("treats ERROR and EXPIRED as child-failed with the state in the message", async () => {
    for (const state of ["ERROR", "EXPIRED"] as const) {
      const fake = await fakeCursor({ runs: ["RUNNING", state] });
      const { exitCode, receipt, outputPath } = await runHttpLane(fake, { suffix: state });
      assert.equal(exitCode, 70);
      assert.equal(existsSync(outputPath), false);
      matchObject(receipt, {
        status: "child-failed",
        preflight: { status: "passed" },
        argv: ["POST", "/v1/agents", "composer-2.5", "high"],
        remote: { agentId: "bc_1", runId: "run_1" },
        error: { message: `cloud run ended with status ${state}` },
      });
      assert.equal(paths(fake).filter((path) => path.startsWith("POST")).length, 1);
    }
  });

  it("treats a CANCELLED run this launcher did not cancel as child-failed", async () => {
    const fake = await fakeCursor({ runs: ["RUNNING", "CANCELLED"] });
    const { exitCode, receipt } = await runHttpLane(fake);
    assert.equal(exitCode, 70);
    matchObject(receipt, {
      status: "child-failed",
      argv: ["POST", "/v1/agents", "composer-2.5", "high"],
      error: { message: "cloud run was cancelled remotely, not by this launcher" },
    });
    assert.ok(!paths(fake).includes(`POST ${RUN_PATH}/cancel`));
  });

  it("cancels on the lane deadline, records the cancel request in argv, and receipts cancelled", async () => {
    const fake = await fakeCursor({ runs: ["RUNNING"] });
    const { exitCode, receipt, outputPath } = await runHttpLane(fake, { timeoutMs: 60 });
    assert.equal(exitCode, 130);
    assert.equal(existsSync(outputPath), false);
    matchObject(receipt, {
      status: "cancelled",
      signal: null,
      exitCode: null,
      preflight: { status: "passed" },
      argv: ["POST", "/v1/agents", "composer-2.5", "high", "POST", `${RUN_PATH}/cancel`],
      remote: { agentId: "bc_1", runId: "run_1" },
      error: {
        message: "explicit deadline elapsed while polling the cloud agent; cancel requested",
        evidence: "cancel acknowledged",
      },
    });
    const recorded = paths(fake);
    assert.equal(recorded.at(-1), `POST ${RUN_PATH}/cancel`);
    assert.equal(recorded.filter((path) => path === `POST ${RUN_PATH}/cancel`).length, 1);
    assert.ok(recorded.includes(`GET ${RUN_PATH}`));
  });

  it("times out before any request when the deadline elapsed at launcher entry", async () => {
    const fake = await fakeCursor();
    const { exitCode, receipt } = await runHttpLane(fake, { timeoutMs: 100, started: Date.now() - 1_000 });
    assert.equal(exitCode, 124);
    matchObject(receipt, {
      status: "timed-out",
      preflight: { status: "timed-out" },
      error: { message: "explicit deadline elapsed before authentication preflight" },
      remote: { agentId: null },
    });
    assert.deepEqual(paths(fake), []);
  });

  it("takes the push verdict from the remote heads, not from the branch named in the run body", async () => {
    const seen = lsRemoteCalls().length;
    const fake = await fakeCursor({
      runs: ["RUNNING", "FINISHED"],
      branches: [{ repoUrl: "github.com/acme/app", branch: "main", prUrl: `${REPO_URL}/pull/7` }],
    });
    const { exitCode, receipt, outputPath } = await runHttpLane(fake);
    assert.equal(exitCode, 0);
    assert.equal(readFileSync(outputPath, "utf8"), "pong");
    matchObject(receipt, { status: "complete", remote: { agentId: "bc_1", pushedBranches: [] } });
    assert.deepEqual(lsRemoteCalls().slice(seen), [
      `ls-remote --heads ${bareRepo}`,
      `ls-remote --heads ${bareRepo}`,
    ]);
    assert.ok(!JSON.stringify(receipt).includes(bareRepo));
  });

  it("fails a read-only lane whose run pushed a new branch and records it on an isolated-write lane", async () => {
    const pushed = await fakeCursor({ beforeFinish: () => pushBranch("cursor/x") });
    const readOnly = await runHttpLane(pushed, { suffix: "read-only" });
    assert.equal(readOnly.exitCode, 70);
    assert.equal(existsSync(readOnly.outputPath), false);
    matchObject(readOnly.receipt, {
      status: "child-failed",
      error: { message: "read-only lane pushed cursor/x" },
      remote: { agentId: "bc_1", pushedBranches: ["cursor/x"] },
    });

    const writer = await fakeCursor({ beforeFinish: () => pushBranch("cursor/y") });
    const isolated = await runHttpLane(writer, { mode: "isolated-write", suffix: "isolated-write" });
    assert.equal(isolated.exitCode, 0);
    assert.equal(readFileSync(isolated.outputPath, "utf8"), "pong");
    matchObject(isolated.receipt, {
      status: "complete",
      mode: "isolated-write",
      remote: { pushedBranches: ["cursor/y"] },
    });
  });

  it("counts a new commit on an existing branch as a push", async () => {
    const pushed = await fakeCursor({ beforeFinish: () => pushBranch("main") });
    const readOnly = await runHttpLane(pushed, { suffix: "read-only" });
    assert.equal(readOnly.exitCode, 70);
    matchObject(readOnly.receipt, {
      status: "child-failed",
      error: { message: "read-only lane pushed main" },
      remote: { pushedBranches: ["main"] },
    });

    const writer = await fakeCursor({ beforeFinish: () => pushBranch("main") });
    const isolated = await runHttpLane(writer, { mode: "isolated-write", suffix: "isolated-write" });
    assert.equal(isolated.exitCode, 0);
    matchObject(isolated.receipt, { status: "complete", remote: { pushedBranches: ["main"] } });
  });

  it("fails a read-only lane closed before launch when the remote cannot be read, and lets an isolated-write lane complete", async () => {
    const missing = join(scratch, "missing.git");
    const seen = lsRemoteCalls().length;
    const readOnlyFake = await fakeCursor();
    const readOnly = await runHttpLane(readOnlyFake, { suffix: "read-only", gitRemote: missing });
    assert.equal(readOnly.exitCode, 70);
    assert.equal(existsSync(readOnly.outputPath), false);
    matchObject(readOnly.receipt, {
      status: "child-failed",
      preflight: { status: "passed" },
      argv: ["POST", "/v1/agents", "composer-2.5", "high"],
      error: { message: "could not verify pushed branches" },
      remote: { agentId: null, runId: null, pushedBranches: [] },
    });
    assert.ok(readOnly.receipt.error?.evidence.includes(missing));
    assert.deepEqual(paths(readOnlyFake), ["GET /v1/models"]);
    assert.equal(lsRemoteCalls().length - seen, 1);

    const writerFake = await fakeCursor();
    const isolated = await runHttpLane(writerFake, { mode: "isolated-write", suffix: "isolated-write", gitRemote: missing });
    assert.equal(isolated.exitCode, 0);
    assert.equal(readFileSync(isolated.outputPath, "utf8"), "pong");
    matchObject(isolated.receipt, { status: "complete", remote: { agentId: "bc_1", pushedBranches: [] } });
    assert.equal(lsRemoteCalls().length - seen, 2);
  });

  it("gives up after five consecutive failed poll requests", async () => {
    const fake = await fakeCursor({ pollStatus: 500 });
    const { exitCode, receipt } = await runHttpLane(fake);
    assert.equal(exitCode, 70);
    matchObject(receipt, {
      status: "child-failed",
      remote: { agentId: "bc_1", runId: "run_1" },
      error: { message: "5 consecutive poll requests failed" },
    });
    assert.ok(receipt.error?.evidence.startsWith("HTTP 500:"));
    assert.equal(paths(fake).filter((path) => path === `GET ${RUN_PATH}`).length, 5);
    assert.ok(!paths(fake).includes(`POST ${RUN_PATH}/cancel`));
  });

  it("refuses to complete a finished run that carried no result text", async () => {
    const fake = await fakeCursor({ result: "" });
    const { exitCode, receipt, outputPath } = await runHttpLane(fake);
    assert.equal(exitCode, 65);
    assert.equal(existsSync(outputPath), false);
    matchObject(receipt, {
      status: "malformed-output",
      error: { message: "finished run carried no result text" },
    });
  });
});
