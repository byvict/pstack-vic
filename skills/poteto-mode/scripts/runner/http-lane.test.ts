import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURSOR_ENV, httpLane } from "./http-lane.ts";
import { findExecutable, runLane } from "./run.ts";
import type { AccessMode, RunnerReceipt } from "./types.ts";
import { matchObject } from "./match-object.test-helper.ts";

type RunStatus = "CREATING" | "RUNNING" | "FINISHED" | "ERROR" | "CANCELLED" | "EXPIRED" | "PAUSED";

/** Variants as `effort=high fast=true` lines; `defaultVariant` names the one the API flags isDefault. */
interface FakeModel {
  readonly id: string;
  readonly variants?: readonly string[];
  readonly defaultVariant?: string;
}

interface FakeScript {
  readonly models?: readonly FakeModel[];
  readonly rawModels?: readonly unknown[];
  /** Status code the preflight answers with instead of the inventory. */
  readonly modelsStatus?: number;
  readonly runs?: readonly RunStatus[];
  readonly result?: string;
  readonly branches?: readonly { readonly repoUrl: string; readonly branch?: string; readonly prUrl?: string }[];
  readonly pollStatus?: number;
  readonly pollReplies?: readonly { readonly status: number; readonly body: unknown }[];
  readonly cancelStatus?: number;
  readonly cancelHang?: boolean;
  readonly beforePoll?: () => void;
  /** Runs right before the fake answers FINISHED; the push cases push from the work clone here. */
  readonly beforeFinish?: () => void | Promise<void>;
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

const GROK_VARIANTS = ["low", "medium", "high", "xhigh"].flatMap((effort) =>
  ["false", "true"].map((fast) => `effort=${effort} fast=${fast}`)
);

const INVENTORY: readonly FakeModel[] = [
  { id: "composer-2.5", variants: ["fast=true", "fast=false"], defaultVariant: "fast=true" },
  { id: "grok-4.7", variants: GROK_VARIANTS, defaultVariant: "effort=high fast=true" },
];

const MUSE_MODEL: FakeModel = {
  id: "muse-spark-1.3",
  variants: [
    "context=300k effort=high",
    "context=1m effort=low",
    "context=1m effort=high",
    "context=1m effort=xhigh",
  ],
  defaultVariant: "context=1m effort=high",
};
const KIMI_MODEL: FakeModel = {
  id: "kimi-k3",
  variants: ["reasoning=low", "reasoning=high", "reasoning=max"],
  defaultVariant: "reasoning=max",
};
const GLM_MODEL: FakeModel = {
  id: "glm-5.2",
  variants: ["reasoning=high", "reasoning=max"],
  defaultVariant: "reasoning=high",
};
const GEMINI_MODEL: FakeModel = {
  id: "gemini-3.1-pro",
  variants: [""],
  defaultVariant: "",
};

const REPO_URL = "https://github.com/acme/app";
const RUN_PATH = "/v1/agents/bc_1/runs/run_1";
const BASIC_AUTH = `Basic ${Buffer.from("test-key:").toString("base64")}`;

function parseParams(variant: string): { id: string; value: string }[] {
  if (variant.length === 0) return [];
  return variant.split(" ").map((pair) => {
    const [id, value] = pair.split("=");
    return { id: id ?? "", value: value ?? "" };
  });
}

function modelItem(model: FakeModel): unknown {
  const variants = (model.variants ?? []).map((line) => ({
    params: parseParams(line),
    displayName: model.id,
    ...(line === model.defaultVariant ? { isDefault: true } : {}),
  }));
  const values = new Map<string, Set<string>>();
  for (const variant of variants) {
    for (const param of variant.params) {
      values.set(param.id, (values.get(param.id) ?? new Set()).add(param.value));
    }
  }
  const parameters = [...values].map(([id, set]) => ({
    id,
    displayName: id,
    values: [...set].map((value) => ({ value })),
  }));
  return {
    id: model.id,
    displayName: model.id,
    ...(parameters.length > 0 ? { parameters } : {}),
    variants,
  };
}

interface InventoryVariant {
  readonly line: string;
  readonly isDefault?: unknown;
}

function inventoryItem(
  id: string,
  parameterIds: readonly string[],
  variants: readonly InventoryVariant[]
): unknown {
  return {
    id,
    parameters: parameterIds.map((parameterId) => ({ id: parameterId })),
    variants: variants.map((variant) => ({
      params: parseParams(variant.line),
      ...(variant.isDefault === undefined ? {} : { isDefault: variant.isDefault }),
    })),
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
    request.on("end", async () => {
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
          answer(200, { items: script.rawModels ?? (script.models ?? INVENTORY).map(modelItem) });
        }
      } else if (method === "POST" && path === "/v1/agents") {
        answer(200, {
          agent: { id: "bc_1", status: "CREATING", url: "https://cursor.com/agents/bc_1", latestRunId: "run_1" },
          run: { id: "run_1", status: "CREATING", createdAt: "2026-09-21T12:00:00.000Z" },
        });
      } else if (method === "GET" && path === RUN_PATH) {
        script.beforePoll?.();
        if (script.pollReplies !== undefined) {
          const reply = script.pollReplies[Math.min(polls++, script.pollReplies.length - 1)];
          assert.ok(reply !== undefined);
          answer(reply.status, reply.body);
        } else if (script.pollStatus !== undefined) {
          answer(script.pollStatus, { error: "poll refused" });
        } else {
          const status = runs[Math.min(polls, runs.length - 1)];
          polls += 1;
          if (status === "FINISHED") await script.beforeFinish?.();
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
        if (script.cancelHang) return;
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

interface LaunchModel {
  readonly id: string;
  readonly params: readonly { readonly id: string; readonly value: string }[];
}

function launchModel(fake: FakeCursor): LaunchModel {
  const launch = fake.requests.find((request) => request.method === "POST" && request.path === "/v1/agents");
  assert.ok(launch !== undefined, "no launch request recorded");
  return (launch.body as { model: LaunchModel }).model;
}

// One bare remote and one work clone serve every case: a lane's baseline is
// taken at its own start, so earlier pushes never count against a later lane.
let fixture = "";
let bareRepo = "";
let workClone = "";
let gitLog = "";
let gitHold = "";
let gitStarted = "";
let gitFail = "";
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

async function waitForGit(): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!existsSync(gitStarted)) {
    assert.ok(performance.now() < deadline, "final snapshot did not reach the Git barrier");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

before(() => {
  fixture = mkdtempSync(join(tmpdir(), "pstack-http-lane-git-"));
  bareRepo = join(fixture, "remote.git");
  workClone = join(fixture, "work");
  gitLog = join(fixture, "git.log");
  gitHold = join(fixture, "git.hold");
  gitStarted = join(fixture, "git.started");
  gitFail = join(fixture, "git.fail");
  const realGit = findExecutable("git", process.env.PATH, fixture);
  assert.ok(realGit !== null, "git is required on PATH");
  mkdirSync(join(fixture, "bin"));
  writeFileSync(
    join(fixture, "bin", "git"),
    `#!${process.execPath}
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(gitLog)}, args.join(" ") + "\\n");
function run() {
  if (args[0] === "ls-remote" && fs.existsSync(${JSON.stringify(gitFail)})) {
    process.stderr.write("snapshot unavailable");
    process.exit(1);
  }
  const child = spawnSync(${JSON.stringify(realGit)}, args, { stdio: "inherit" });
  process.exit(child.status ?? 1);
}
if (args[0] === "ls-remote" && fs.existsSync(${JSON.stringify(gitHold)})) {
  fs.writeFileSync(${JSON.stringify(gitStarted)}, "started");
  const timer = setInterval(() => {
    if (!fs.existsSync(${JSON.stringify(gitHold)})) {
      clearInterval(timer);
      run();
    }
  }, 5);
} else run();
`,
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
  for (const path of [gitHold, gitStarted, gitFail]) rmSync(path, { force: true });
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

interface SuccessfulSelection {
  readonly model: string;
  readonly effort: string;
  readonly inventory: readonly FakeModel[];
  readonly params: readonly { readonly id: string; readonly value: string }[];
  readonly evidence: string;
  readonly suffix: string;
}

async function assertSuccessfulSelection(expected: SuccessfulSelection): Promise<void> {
  const fake = await fakeCursor({ models: expected.inventory, result: "selector ok" });
  const result = await runHttpLane(fake, {
    model: expected.model,
    effort: expected.effort,
    suffix: expected.suffix,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(readFileSync(result.outputPath, "utf8"), "selector ok");
  matchObject(result.receipt, {
    status: "complete",
    model: expected.model,
    effort: expected.effort,
    reportedModel: null,
    modelVerified: false,
    modelEvidence: "pinned-argv",
    preflight: { status: "passed", evidence: expected.evidence },
    remote: { agentId: "bc_1", runId: "run_1", heads: { kind: "observed", changedBranches: [] } },
  });
  assert.deepEqual(launchModel(fake), { id: expected.model, params: expected.params });
  assert.deepEqual(paths(fake), ["GET /v1/models", "POST /v1/agents", `GET ${RUN_PATH}`]);
}

interface RefusedSelection {
  readonly script: FakeScript;
  readonly model: string;
  readonly effort: string;
  readonly suffix: string;
  readonly message: string;
}

async function assertSelectionRefused(expected: RefusedSelection): Promise<void> {
  const snapshots = lsRemoteCalls().length;
  const fake = await fakeCursor(expected.script);
  const result = await runHttpLane(fake, {
    model: expected.model,
    effort: expected.effort,
    suffix: expected.suffix,
  });
  assert.equal(result.exitCode, 69);
  assert.equal(existsSync(result.outputPath), false);
  matchObject(result.receipt, {
    status: "unavailable-model",
    preflight: { status: "failed" },
    error: { message: expected.message },
    remote: { agentId: null, runId: null, heads: { kind: "not-taken" } },
  });
  assert.deepEqual(paths(fake), ["GET /v1/models"]);
  assert.equal(lsRemoteCalls().length, snapshots);
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
      preflight: {
        argv: ["GET", "/v1/models"],
        status: "passed",
        evidence: "authenticated; model composer-2.5 available; selected params: fast=false; requested effort high is not selectable; this matrix label maps to the provider default",
      },
      argv: ["POST", "/v1/agents", "composer-2.5", "high"],
      remote: { agentId: "bc_1", runId: "run_1", agentUrl: "https://cursor.com/agents/bc_1", heads: { kind: "observed", changedBranches: [] } },
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
      model: { id: "composer-2.5", params: [{ id: "fast", value: "false" }] },
      prompt: { text: "Reply with the single word pong" },
    });
  });

  it("quotes the listed variant with the requested effort and fast off, never fast on", async () => {
    const grok = await fakeCursor();
    const grokLane = await runHttpLane(grok, { model: "grok-4.7", effort: "xhigh", suffix: "grok" });
    assert.equal(grokLane.exitCode, 0);
    matchObject(grokLane.receipt, {
      argv: ["POST", "/v1/agents", "grok-4.7", "xhigh"],
      preflight: {
        evidence: "authenticated; model grok-4.7 available; selected params: effort=xhigh fast=false; requested effort xhigh selects effort=xhigh",
      },
    });
    assert.deepEqual(launchModel(grok), {
      id: "grok-4.7",
      params: [{ id: "effort", value: "xhigh" }, { id: "fast", value: "false" }],
    });

    const composer = await fakeCursor();
    const composerLane = await runHttpLane(composer, { suffix: "composer" });
    matchObject(composerLane.receipt, {
      preflight: {
        evidence: "authenticated; model composer-2.5 available; selected params: fast=false; requested effort high is not selectable; this matrix label maps to the provider default",
      },
    });
    assert.deepEqual(launchModel(composer), { id: "composer-2.5", params: [{ id: "fast", value: "false" }] });

    for (const fake of [grok, composer]) {
      const sent = launchModel(fake).params;
      assert.ok(!sent.some((param) => param.id === "fast" && param.value !== "false"));
    }

    const fastOnly = await fakeCursor({
      models: [{ id: "grok-4.7", variants: ["effort=low fast=false", "effort=xhigh fast=true"] }],
    });
    const refused = await runHttpLane(fastOnly, { model: "grok-4.7", effort: "xhigh", suffix: "fast-only" });
    assert.equal(refused.exitCode, 69);
    matchObject(refused.receipt, {
      status: "unavailable-model",
      preflight: { status: "failed" },
      error: {
        message: "model grok-4.7 has no exact variant for effort=xhigh",
        evidence: "model grok-4.7 variants:\neffort=low fast=false\neffort=xhigh fast=true",
      },
      remote: { agentId: null, runId: null },
    });
    assert.deepEqual(paths(fastOnly), ["GET /v1/models"]);

    const bare = await fakeCursor({ models: [{ id: "composer-2.5" }] });
    const plain = await runHttpLane(bare, { suffix: "no-variants" });
    assert.equal(plain.exitCode, 69);
    assert.equal(existsSync(plain.outputPath), false);
    matchObject(plain.receipt, {
      status: "unavailable-model",
      preflight: { status: "failed" },
      error: { message: "model composer-2.5 advertises no variants" },
      remote: { agentId: null, runId: null },
    });
    assert.deepEqual(paths(bare), ["GET /v1/models"]);
  });

  it("selects the advertised variants for every repaired model and effort", async () => {
    const cases: readonly SuccessfulSelection[] = [
      {
        model: "muse-spark-1.3",
        effort: "low",
        inventory: [MUSE_MODEL],
        params: [{ id: "context", value: "1m" }, { id: "effort", value: "low" }],
        evidence: "authenticated; model muse-spark-1.3 available; selected params: context=1m effort=low; requested effort low selects effort=low",
        suffix: "muse-low",
      },
      {
        model: "muse-spark-1.3",
        effort: "high",
        inventory: [MUSE_MODEL],
        params: [{ id: "context", value: "1m" }, { id: "effort", value: "high" }],
        evidence: "authenticated; model muse-spark-1.3 available; selected params: context=1m effort=high; requested effort high selects effort=high",
        suffix: "muse-high",
      },
      {
        model: "muse-spark-1.3",
        effort: "xhigh",
        inventory: [MUSE_MODEL],
        params: [{ id: "context", value: "1m" }, { id: "effort", value: "xhigh" }],
        evidence: "authenticated; model muse-spark-1.3 available; selected params: context=1m effort=xhigh; requested effort xhigh selects effort=xhigh",
        suffix: "muse-xhigh",
      },
      {
        model: "kimi-k3",
        effort: "low",
        inventory: [KIMI_MODEL],
        params: [{ id: "reasoning", value: "low" }],
        evidence: "authenticated; model kimi-k3 available; selected params: reasoning=low; requested effort low selects reasoning=low",
        suffix: "kimi-low",
      },
      {
        model: "kimi-k3",
        effort: "high",
        inventory: [KIMI_MODEL],
        params: [{ id: "reasoning", value: "high" }],
        evidence: "authenticated; model kimi-k3 available; selected params: reasoning=high; requested effort high selects reasoning=high",
        suffix: "kimi-high",
      },
      {
        model: "glm-5.2",
        effort: "high",
        inventory: [GLM_MODEL],
        params: [{ id: "reasoning", value: "high" }],
        evidence: "authenticated; model glm-5.2 available; selected params: reasoning=high; requested effort high selects reasoning=high",
        suffix: "glm-high",
      },
      {
        model: "gemini-3.1-pro",
        effort: "high",
        inventory: [GEMINI_MODEL],
        params: [],
        evidence: "authenticated; model gemini-3.1-pro available; selected params: []; requested effort high is not selectable; this matrix label maps to the provider default",
        suffix: "gemini-high",
      },
    ];

    for (const expected of cases) await assertSuccessfulSelection(expected);
  });

  it("selects Grok 4.7 reasoning_effort while retaining the default 500k context", async () => {
    for (const effort of ["low", "medium", "high", "xhigh"]) {
      await assertSuccessfulSelection({
        model: "grok-4.7",
        effort,
        inventory: [{
          id: "grok-4.7",
          variants: ["256k", "500k"].flatMap((context) =>
            ["low", "medium", "high", "xhigh"].flatMap((level) =>
              ["false", "true"].map((fast) => `context=${context} reasoning_effort=${level} fast=${fast}`)
            )
          ),
          defaultVariant: "context=500k reasoning_effort=high fast=true",
        }],
        params: [{ id: "context", value: "500k" }, { id: "reasoning_effort", value: effort }, { id: "fast", value: "false" }],
        evidence: `authenticated; model grok-4.7 available; selected params: context=500k reasoning_effort=${effort} fast=false; requested effort ${effort} selects reasoning_effort=${effort}`,
        suffix: `grok-47-${effort}`,
      });
    }
  });

  it("rejects undeclared or conflicting reasoning_effort controls", async () => {
    for (const declared of [[], ["effort"], ["reasoning"]]) {
      const parameters = declared.length === 0 ? [] : [...declared, "reasoning_effort"];
      await assertSelectionRefused({
        script: { rawModels: [inventoryItem("grok-4.7", parameters, [
          { line: [...declared.map((id) => `${id}=high`), "reasoning_effort=high"].join(" "), isDefault: true },
        ])] },
        model: "grok-4.7",
        effort: "high",
        suffix: `grok-47-invalid-${declared[0] ?? "hidden"}`,
        message: declared.length === 0
          ? "model grok-4.7 has undeclared control parameters: reasoning_effort"
          : `model grok-4.7 advertises both ${declared[0]} and reasoning_effort parameters`,
      });
    }
  });

  it("uses default metadata instead of variant or parameter order", async () => {
    await assertSuccessfulSelection({
      model: "muse-spark-1.3",
      effort: "low",
      inventory: [{
        id: "muse-spark-1.3",
        variants: [
          "effort=high context=1m",
          "effort=low context=300k",
          "effort=high context=300k",
        ],
        defaultVariant: "effort=high context=300k",
      }],
      params: [{ id: "effort", value: "low" }, { id: "context", value: "300k" }],
      evidence: "authenticated; model muse-spark-1.3 available; selected params: effort=low context=300k; requested effort low selects effort=low",
      suffix: "muse-reordered",
    });
  });

  it("keeps controlled-only inventories compatible without a default marker", async () => {
    await assertSuccessfulSelection({
      model: "grok-4.7",
      effort: "xhigh",
      inventory: [{ id: "grok-4.7", variants: ["effort=low fast=false", "effort=xhigh fast=false"] }],
      params: [{ id: "effort", value: "xhigh" }, { id: "fast", value: "false" }],
      evidence: "authenticated; model grok-4.7 available; selected params: effort=xhigh fast=false; requested effort xhigh selects effort=xhigh",
      suffix: "grok-controlled-only",
    });
  });

  it("rejects ambiguous defaults before selecting an advertised variant", async () => {
    const cases: readonly RefusedSelection[] = [
      {
        script: { rawModels: [inventoryItem("composer-2.5", ["fast"], [
          { line: "fast=false", isDefault: true },
          { line: "fast=false", isDefault: true },
        ])] },
        model: "composer-2.5",
        effort: "high",
        suffix: "identical-defaults",
        message: "model composer-2.5 advertises multiple default variants",
      },
      {
        script: { rawModels: [inventoryItem("grok-4.7", ["effort", "fast"], [
          { line: "effort=low fast=false", isDefault: true },
          { line: "effort=high fast=true", isDefault: true },
          { line: "effort=high fast=false" },
        ])] },
        model: "grok-4.7",
        effort: "high",
        suffix: "unrelated-default",
        message: "model grok-4.7 advertises multiple default variants",
      },
    ];

    for (const expected of cases) await assertSelectionRefused(expected);
  });

  it("rejects inventories that cannot supply a unique complete assignment", async () => {
    const cases: readonly RefusedSelection[] = [
      {
        script: { models: [{ id: "muse-spark-1.3", variants: ["context=1m effort=low"] }] },
        model: "muse-spark-1.3",
        effort: "low",
        suffix: "missing-context-default",
        message: "model muse-spark-1.3 has no default for parameters: context",
      },
      {
        script: { models: [{ id: "gemini-3.1-pro", variants: [""] }] },
        model: "gemini-3.1-pro",
        effort: "high",
        suffix: "gemini-no-default",
        message: "model gemini-3.1-pro has no declared provider default",
      },
      {
        script: { models: [{
          id: "kimi-k3",
          variants: ["reasoning=high", "reasoning=high"],
        }] },
        model: "kimi-k3",
        effort: "high",
        suffix: "duplicate-match",
        message: "model kimi-k3 advertises duplicate exact variants",
      },
      {
        script: { models: [{
          id: "muse-spark-1.3",
          variants: ["context=1m effort=high", "context=300k effort=low"],
          defaultVariant: "context=1m effort=high",
        }] },
        model: "muse-spark-1.3",
        effort: "low",
        suffix: "missing-combination",
        message: "model muse-spark-1.3 has no exact variant for effort=low",
      },
      {
        script: { rawModels: [inventoryItem("muse-spark-1.3", ["context", "effort"], [
          { line: "effort=high", isDefault: true },
          { line: "effort=low" },
        ])] },
        model: "muse-spark-1.3",
        effort: "low",
        suffix: "default-omits-context",
        message: "model muse-spark-1.3 default omits parameters: context",
      },
      {
        script: { rawModels: [{ id: "composer-2.5" }] },
        model: "composer-2.5",
        effort: "high",
        suffix: "absent-variants",
        message: "model composer-2.5 advertises no variants",
      },
    ];

    for (const expected of cases) await assertSelectionRefused(expected);
  });

  it("rejects unsupported and inconsistent control axes", async () => {
    const cases: readonly RefusedSelection[] = [
      {
        script: { models: [{ id: "kimi-k3", variants: [""], defaultVariant: "" }] },
        model: "kimi-k3",
        effort: "high",
        suffix: "kimi-no-axis",
        message: "model kimi-k3 has no selectable effort parameter for matrix effort high",
      },
      {
        script: { models: [{
          id: "grok-4.7",
          variants: ["effort=high reasoning=high fast=false"],
          defaultVariant: "effort=high reasoning=high fast=false",
        }] },
        model: "grok-4.7",
        effort: "high",
        suffix: "both-axes",
        message: "model grok-4.7 advertises both effort and reasoning parameters",
      },
      {
        script: { models: [{ id: "kimi-k3", variants: ["reasoning=max"], defaultVariant: "reasoning=max" }] },
        model: "kimi-k3",
        effort: "high",
        suffix: "reasoning-value-missing",
        message: "model kimi-k3 has no exact variant for reasoning=high",
      },
      {
        script: { rawModels: [inventoryItem("grok-4.7", ["effort"], [
          { line: "effort=high fast=false", isDefault: true },
        ])] },
        model: "grok-4.7",
        effort: "high",
        suffix: "hidden-fast",
        message: "model grok-4.7 has undeclared control parameters: fast",
      },
      {
        script: { rawModels: [inventoryItem("grok-4.7", ["effort", "fast"], [
          { line: "effort=high reasoning=high fast=false", isDefault: true },
        ])] },
        model: "grok-4.7",
        effort: "high",
        suffix: "hidden-reasoning",
        message: "model grok-4.7 has undeclared control parameters: reasoning",
      },
    ];

    for (const expected of cases) await assertSelectionRefused(expected);
  });

  it("rejects malformed variant data instead of changing the advertised assignment", async () => {
    const rawModels: readonly unknown[][] = [
      [{
        id: "gemini-3.1-pro",
        variants: [{ params: [{ id: "effort" }], isDefault: true }],
      }],
      [inventoryItem("kimi-k3", ["reasoning"], [{ line: "reasoning=low reasoning=high" }])],
      [inventoryItem("gemini-3.1-pro", [], [{ line: "", isDefault: "yes" }])],
      [modelItem(GEMINI_MODEL), modelItem(GEMINI_MODEL)],
    ];

    for (const [index, items] of rawModels.entries()) {
      const snapshots = lsRemoteCalls().length;
      const fake = await fakeCursor({ rawModels: items });
      const result = await runHttpLane(fake, {
        model: index === 1 ? "kimi-k3" : "gemini-3.1-pro",
        effort: index === 1 ? "low" : "high",
        suffix: `malformed-${index}`,
      });
      assert.equal(result.exitCode, 69);
      assert.equal(existsSync(result.outputPath), false);
      matchObject(result.receipt, {
        status: "unavailable-cli",
        preflight: { status: "failed" },
        error: { message: "model inventory had an unexpected shape" },
        remote: { agentId: null, runId: null, heads: { kind: "not-taken" } },
      });
      assert.deepEqual(paths(fake), ["GET /v1/models"]);
      assert.equal(lsRemoteCalls().length, snapshots);
    }
  });

  it("ignores malformed variant data for an unrelated inventory model", async () => {
    const fake = await fakeCursor({ rawModels: [
      {
        id: "unrelated-model",
        variants: [{ params: [{ id: "effort" }], isDefault: "yes" }],
      },
      modelItem(GEMINI_MODEL),
    ] });
    const result = await runHttpLane(fake, {
      model: "gemini-3.1-pro",
      effort: "high",
      suffix: "unrelated-malformed",
    });

    assert.equal(result.exitCode, 0);
    assert.equal(readFileSync(result.outputPath, "utf8"), "pong");
    matchObject(result.receipt, {
      status: "complete",
      preflight: {
        status: "passed",
        evidence: "authenticated; model gemini-3.1-pro available; selected params: []; requested effort high is not selectable; this matrix label maps to the provider default",
      },
    });
    assert.deepEqual(launchModel(fake), { id: "gemini-3.1-pro", params: [] });
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
      remote: { agentId: null, runId: null, agentUrl: null, heads: { kind: "not-taken" } },
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
    const fake = await fakeCursor({
      models: [{ id: "composer-9" }, { id: "grok-4.7", variants: ["effort=high fast=false"] }],
    });
    const { exitCode, receipt } = await runHttpLane(fake);
    assert.equal(exitCode, 69);
    matchObject(receipt, {
      status: "unavailable-model",
      preflight: { status: "failed", evidence: "available models: composer-9, grok-4.7" },
      error: {
        message: "model composer-2.5 is not in the Cursor inventory",
        evidence: "available models: composer-9, grok-4.7",
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

  it("cancels on the lane deadline, records the cancel request in argv, and receipts cancelled", async (t) => {
    const afterDeadline = Date.now() + 120_000;
    const fake = await fakeCursor({ runs: ["RUNNING"], beforePoll: () => t.mock.method(Date, "now", () => afterDeadline) });
    const { exitCode, receipt, outputPath } = await runHttpLane(fake, { timeoutMs: 60_000 });
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

  it("observes unchanged heads even when the run names its working branch", async () => {
    const seen = lsRemoteCalls().length;
    const fake = await fakeCursor({
      runs: ["RUNNING", "FINISHED"],
      branches: [{ repoUrl: "github.com/acme/app", branch: "main", prUrl: `${REPO_URL}/pull/7` }],
    });
    const { exitCode, receipt, outputPath } = await runHttpLane(fake);
    assert.equal(exitCode, 0);
    assert.equal(readFileSync(outputPath, "utf8"), "pong");
    matchObject(receipt, { status: "complete", remote: { agentId: "bc_1", heads: { kind: "observed", changedBranches: [] } } });
    assert.deepEqual(lsRemoteCalls().slice(seen), [
      `ls-remote --heads ${bareRepo}`,
      `ls-remote --heads ${bareRepo}`,
    ]);
    assert.ok(!JSON.stringify(receipt).includes(bareRepo));
  });

  it("fails read-only verification on observed new heads and records them for isolated-write", async () => {
    const pushed = await fakeCursor({ beforeFinish: () => pushBranch("cursor/x") });
    const readOnly = await runHttpLane(pushed, { suffix: "read-only" });
    assert.equal(readOnly.exitCode, 70);
    assert.equal(existsSync(readOnly.outputPath), false);
    matchObject(readOnly.receipt, {
      status: "child-failed",
      error: { message: "could not verify read-only execution: remote heads changed: cursor/x" },
      remote: { agentId: "bc_1", heads: { kind: "observed", changedBranches: ["cursor/x"] } },
    });

    const writer = await fakeCursor({ beforeFinish: () => pushBranch("cursor/y") });
    const isolated = await runHttpLane(writer, { mode: "isolated-write", suffix: "isolated-write" });
    assert.equal(isolated.exitCode, 0);
    assert.equal(readFileSync(isolated.outputPath, "utf8"), "pong");
    matchObject(isolated.receipt, {
      status: "complete",
      mode: "isolated-write",
      remote: { heads: { kind: "observed", changedBranches: ["cursor/y"] } },
    });
  });

  it("observes a changed commit on an existing branch without attributing the push", async () => {
    const pushed = await fakeCursor({ beforeFinish: () => pushBranch("main") });
    const readOnly = await runHttpLane(pushed, { suffix: "read-only" });
    assert.equal(readOnly.exitCode, 70);
    matchObject(readOnly.receipt, {
      status: "child-failed",
      error: { message: "could not verify read-only execution: remote heads changed: main" },
      remote: { heads: { kind: "observed", changedBranches: ["main"] } },
    });

    const writer = await fakeCursor({ beforeFinish: () => pushBranch("main") });
    const isolated = await runHttpLane(writer, { mode: "isolated-write", suffix: "isolated-write" });
    assert.equal(isolated.exitCode, 0);
    matchObject(isolated.receipt, { status: "complete", remote: { heads: { kind: "observed", changedBranches: ["main"] } } });
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
      error: { message: "could not verify read-only execution: remote head snapshot unavailable" },
      remote: { agentId: null, runId: null, heads: { kind: "unverified" } },
    });
    assert.ok(readOnly.receipt.error?.evidence.includes(missing));
    assert.deepEqual(paths(readOnlyFake), ["GET /v1/models"]);
    assert.equal(lsRemoteCalls().length - seen, 1);

    const writerFake = await fakeCursor();
    const isolated = await runHttpLane(writerFake, { mode: "isolated-write", suffix: "isolated-write", gitRemote: missing });
    assert.equal(isolated.exitCode, 0);
    assert.equal(readFileSync(isolated.outputPath, "utf8"), "pong");
    matchObject(isolated.receipt, { status: "complete", remote: { agentId: "bc_1", heads: { kind: "unverified" } } });
    assert.equal(lsRemoteCalls().length - seen, 2);
  });

  it("cancels once after five consecutive failed poll requests", async () => {
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
    assert.equal(paths(fake).filter((path) => path === `POST ${RUN_PATH}/cancel`).length, 1);
    assert.match(receipt.error?.evidence ?? "", /cancel acknowledged$/);
  });

  it("keeps the poll failure when cancellation is refused", async () => {
    const fake = await fakeCursor({ pollStatus: 500, cancelStatus: 503 });
    const { receipt, outputPath } = await runHttpLane(fake);
    matchObject(receipt, {
      status: "child-failed",
      error: { message: "5 consecutive poll requests failed" },
      remote: { agentId: "bc_1", runId: "run_1" },
      argv: ["POST", "/v1/agents", "composer-2.5", "high", "POST", `${RUN_PATH}/cancel`],
    });
    assert.match(receipt.error?.evidence ?? "", /^HTTP 500:.*\n\ncancel request failed: HTTP 503:/);
    assert.equal(paths(fake).filter((path) => path === `POST ${RUN_PATH}/cancel`).length, 1);
    assert.equal(existsSync(outputPath), false);
  });

  it("bounds cleanup with an independent ten-second request budget", async (t) => {
    const timeout = AbortSignal.timeout;
    const budgets: number[] = [];
    t.mock.method(AbortSignal, "timeout", (duration: number) => {
      budgets.push(duration);
      return timeout(duration === 10_000 ? 10 : duration);
    });
    const fake = await fakeCursor({ pollStatus: 500, cancelHang: true });
    const { receipt, outputPath } = await runHttpLane(fake);
    matchObject(receipt, { status: "child-failed", error: { message: "5 consecutive poll requests failed" } });
    assert.match(receipt.error?.evidence ?? "", /cancel request exceeded its budget$/);
    assert.equal(budgets.filter((duration) => duration === 10_000).length, 1);
    assert.equal(paths(fake).filter((path) => path === `POST ${RUN_PATH}/cancel`).length, 1);
    assert.equal(existsSync(outputPath), false);
  });

  it("cancels once after five malformed poll replies", async () => {
    const fake = await fakeCursor({ pollReplies: [{ status: 200, body: { status: null } }] });
    const { receipt, outputPath } = await runHttpLane(fake);
    matchObject(receipt, { status: "child-failed", error: { message: "5 consecutive poll requests failed" } });
    assert.match(receipt.error?.evidence ?? "", /^unexpected run shape:.*\n\ncancel acknowledged$/);
    assert.equal(paths(fake).filter((path) => path === `GET ${RUN_PATH}`).length, 5);
    assert.equal(paths(fake).filter((path) => path === `POST ${RUN_PATH}/cancel`).length, 1);
    assert.equal(existsSync(outputPath), false);
  });

  it("cancels an unknown remote state without calling it terminal", async () => {
    const fake = await fakeCursor({ runs: ["PAUSED"] });
    const { receipt } = await runHttpLane(fake);
    matchObject(receipt, { status: "child-failed", error: { message: "cloud run reported an unknown status PAUSED" } });
    assert.match(receipt.error?.evidence ?? "", /cancel acknowledged$/);
    assert.equal(paths(fake).filter((path) => path === `GET ${RUN_PATH}`).length, 1);
    assert.equal(paths(fake).filter((path) => path === `POST ${RUN_PATH}/cancel`).length, 1);
  });

  it("does not mistake object prototype names for known remote states", async () => {
    const fake = await fakeCursor({ pollReplies: [{ status: 200, body: { status: "toString" } }] });
    const { receipt } = await runHttpLane(fake);
    matchObject(receipt, { status: "child-failed", error: { message: "cloud run reported an unknown status toString" } });
    assert.equal(paths(fake).filter((path) => path === `POST ${RUN_PATH}/cancel`).length, 1);
  });

  it("resets consecutive failures after a valid pending poll", async () => {
    const errors = Array.from({ length: 4 }, () => ({ status: 500, body: { error: "try later" } }));
    const fake = await fakeCursor({ pollReplies: [
      ...errors,
      { status: 200, body: { status: "RUNNING" } },
      ...errors,
      { status: 200, body: { status: "FINISHED", result: "pong" } },
    ] });
    const { receipt, outputPath } = await runHttpLane(fake);
    assert.equal(receipt.status, "complete");
    assert.equal(readFileSync(outputPath, "utf8"), "pong");
    assert.equal(paths(fake).filter((path) => path === `GET ${RUN_PATH}`).length, 10);
    assert.ok(!paths(fake).includes(`POST ${RUN_PATH}/cancel`));
  });

  for (const mode of ["read-only", "isolated-write"] as const) {
    it(`reports cancellation during final verification in ${mode}`, async () => {
      const fake = await fakeCursor({ beforeFinish: () => writeFileSync(gitHold, "hold") });
      const running = runHttpLane(fake, { mode });
      try {
        await waitForGit();
        process.emit("SIGINT");
      } finally {
        rmSync(gitHold, { force: true });
      }
      const { receipt, exitCode, outputPath } = await running;
      assert.equal(exitCode, 130);
      assert.equal(existsSync(outputPath), false);
      matchObject(receipt, {
        status: "cancelled",
        error: { message: "launcher received SIGINT after the cloud run reached FINISHED; no cancel needed" },
        remote: { heads: { kind: "unverified" } },
      });
      assert.ok(!paths(fake).includes(`POST ${RUN_PATH}/cancel`));
    });

    it(`reports a deadline after a successful final snapshot in ${mode}`, async (t) => {
      const fake = await fakeCursor({ beforeFinish: () => writeFileSync(gitHold, "hold") });
      const running = runHttpLane(fake, { mode, timeoutMs: 60_000 });
      try {
        await waitForGit();
        const afterDeadline = Date.now() + 120_000;
        t.mock.method(Date, "now", () => afterDeadline);
      } finally {
        rmSync(gitHold, { force: true });
      }
      const { receipt, exitCode, outputPath } = await running;
      assert.equal(exitCode, 130);
      assert.equal(existsSync(outputPath), false);
      matchObject(receipt, {
        status: "cancelled",
        error: { message: "explicit deadline elapsed after the cloud run reached FINISHED; no cancel needed" },
        remote: { heads: { kind: "observed", changedBranches: [] } },
      });
      assert.ok(!paths(fake).includes(`POST ${RUN_PATH}/cancel`));
    });
  }

  it("checks the deadline after a successful baseline before launching", async (t) => {
    writeFileSync(gitHold, "hold");
    const fake = await fakeCursor();
    const running = runHttpLane(fake, { timeoutMs: 60_000 });
    try {
      await waitForGit();
      const afterDeadline = Date.now() + 120_000;
      t.mock.method(Date, "now", () => afterDeadline);
    } finally {
      rmSync(gitHold, { force: true });
    }
    const { receipt, exitCode, outputPath } = await running;
    assert.equal(exitCode, 124);
    assert.equal(existsSync(outputPath), false);
    matchObject(receipt, { status: "timed-out", remote: { agentId: null, runId: null } });
    assert.deepEqual(paths(fake), ["GET /v1/models"]);
  });

  it("prefers a latched signal over the deadline after launch", async (t) => {
    const afterDeadline = Date.now() + 120_000;
    const fake = await fakeCursor({ runs: ["RUNNING"], beforePoll: () => {
      t.mock.method(Date, "now", () => afterDeadline);
      process.emit("SIGTERM");
    } });
    const { receipt, outputPath } = await runHttpLane(fake, { timeoutMs: 60_000 });
    matchObject(receipt, {
      status: "cancelled",
      error: { message: "launcher received SIGTERM while polling the cloud agent; cancel requested", evidence: "cancel acknowledged" },
    });
    assert.equal(existsSync(outputPath), false);
    assert.equal(paths(fake).filter((path) => path === `POST ${RUN_PATH}/cancel`).length, 1);
  });

  it("fails read-only verification when another actor deletes a head", async () => {
    pushBranch("cursor/deleted");
    const fake = await fakeCursor({ beforeFinish: () => git(workClone, "push", "--quiet", "origin", ":refs/heads/cursor/deleted") });
    const { receipt, outputPath } = await runHttpLane(fake);
    matchObject(receipt, {
      status: "child-failed",
      error: { message: "could not verify read-only execution: remote heads changed: cursor/deleted" },
      remote: { heads: { kind: "observed", changedBranches: ["cursor/deleted"] } },
    });
    assert.match(receipt.error?.evidence ?? "", /cannot attribute/);
    assert.equal(existsSync(outputPath), false);
    assert.ok(!("pushedBranches" in (receipt.remote ?? {})));
  });

  it("reports one foreign push as an observation in two overlapping lanes", async () => {
    let finished = 0;
    const bothFinished = Promise.withResolvers<void>();
    const fake = await fakeCursor({ beforeFinish: async () => {
      if (++finished === 2) {
        pushBranch("cursor/foreign");
        bothFinished.resolve();
      }
      await bothFinished.promise;
    } });
    const lanes = [runHttpLane(fake, { suffix: "first" }), runHttpLane(fake, { suffix: "second" })];
    for (const { receipt, outputPath } of await Promise.all(lanes)) {
      matchObject(receipt, {
        status: "child-failed",
        error: { message: "could not verify read-only execution: remote heads changed: cursor/foreign" },
        remote: { heads: { kind: "observed", changedBranches: ["cursor/foreign"] } },
      });
      assert.match(receipt.error?.evidence ?? "", /cannot attribute/);
      assert.equal(existsSync(outputPath), false);
      assert.ok(!("pushedBranches" in (receipt.remote ?? {})));
    }
  });

  it("keeps an unavailable final comparison in both access modes", async () => {
    for (const mode of ["read-only", "isolated-write"] as const) {
      const fake = await fakeCursor({ beforeFinish: () => writeFileSync(gitFail, "fail") });
      const { receipt, outputPath } = await runHttpLane(fake, { mode, suffix: mode });
      matchObject(receipt, { remote: { heads: { kind: "unverified", reason: "snapshot unavailable" } } });
      assert.equal(receipt.status, mode === "read-only" ? "child-failed" : "complete");
      assert.equal(existsSync(outputPath), mode === "isolated-write");
      assert.ok(!paths(fake).includes(`POST ${RUN_PATH}/cancel`));
      rmSync(gitFail, { force: true });
    }
  });

  it("cancels an addressable run when polling throws and preserves the failure", async () => {
    const fake = await fakeCursor({ runs: ["RUNNING"] });
    const lane = httpLane({
      parent: "claude", provider: "cursor", model: "composer-2.5", effort: "high", mode: "read-only",
      promptPath: join(scratch, "prompt.md"), cwd: scratch,
      outputPath: join(scratch, "throw.out"), receiptPath: join(scratch, "throw.receipt.json"),
      timeoutMs: null, target: { owner: "acme", name: "app", pullNumber: 7 },
    }, {
      ...process.env,
      [CURSOR_ENV.apiKey]: "test-key",
      [CURSOR_ENV.baseUrl]: fake.baseUrl,
      [CURSOR_ENV.gitRemote]: bareRepo,
      [CURSOR_ENV.pollIntervalMs]: "5",
    });
    const outcome = await lane.run({
      prompt: "pong", deadlineAt: null,
      cancellation: {
        signal: null, abortSignal: new AbortController().signal,
        promise: new Promise(() => {}), dispose() {},
      },
      wait: async (delayMs) => {
        if (delayMs > 0) throw new Error("poll wait failed");
        return "ready";
      },
    });
    matchObject(outcome, {
      kind: "failed", status: "child-failed",
      error: { message: "poll wait failed", evidence: "cancel acknowledged" },
    });
    assert.equal(paths(fake).filter((path) => path === `POST ${RUN_PATH}/cancel`).length, 1);
    matchObject(lane.evidence, { remote: { agentId: "bc_1", runId: "run_1" } });
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
