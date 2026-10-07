// prepare → exercise → assert follows open-pstack's repository verifier.
// Recipes own the method; models never choose sample counts, warmups or retries.
import assert from "node:assert/strict";
import { globSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { childEnvironment } from "../../skills/poteto-mode/scripts/runner/child.ts";
import type { RunnerReceipt } from "../../skills/poteto-mode/scripts/runner/types.ts";
import { Journal, save } from "./io.ts";
import { assertToolMethod, captureGrokTools, toolEvents } from "./grok-tools.ts";

export const ROUTES = {
  "grok-cli": { parent: "codex", provider: "grok", model: "grok-4.7", effort: "xhigh", transport: "cli" },
  "grok-acp": { parent: "codex", provider: "grok", model: "grok-4.7", effort: "xhigh", transport: "grok-acp" },
  "codex-cli": { parent: "claude", provider: "codex", model: "gpt-6.1-sol", effort: "xhigh", transport: "cli" },
  "claude-cli": { parent: "codex", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", transport: "cli" },
} as const;
export type Route = keyof typeof ROUTES;
export const FEATURES = ["verifier-contracts", "runner-contracts", "setup-contracts", "repository-contracts", "runner-smoke", "inner-timeout", "concurrency"] as const;
export type Feature = typeof FEATURES[number];

export interface Context { repository: string; directory: string; journal: Journal; routes: Route[] }
export interface Observation { assertions: string[]; measurements?: unknown }
export interface Recipe {
  description: string;
  live: boolean;
  prepare(context: Context): Promise<void>;
  exercise(context: Context): Promise<unknown>;
  assert(result: unknown, context: Context): Observation;
}

function tests(patterns: string[]): Recipe {
  return {
    description: "Deterministic contracts with isolated fixtures; no authenticated model sessions.", live: false,
    async prepare() {},
    async exercise(context) {
      const files = globSync(patterns, { cwd: context.repository }).sort();
      assert.ok(files.length, "test selection must not be empty");
      const environment = childEnvironment();
      // Node otherwise silently skips nested suites while exiting zero.
      delete environment.NODE_TEST_CONTEXT;
      return context.journal.run([process.execPath, "--test", "--test-reporter=tap", ...files], { cwd: context.repository, label: "contracts", env: environment });
    },
    assert(result) {
      assert.ok(result && typeof result === "object" && "status" in result && result.status === "complete", "contract test command failed; see command receipts");
      assert.ok("stdout" in result && typeof result.stdout === "string");
      const report = readFileSync(result.stdout, "utf8");
      assert.match(report, /^# pass [1-9][0-9]*$/m, "zero executed passing tests is not a proof");
      assert.match(report, /^# fail 0$/m);
      return { assertions: ["Selected contract tests executed at least one passing test, with zero failures and exit code zero"] };
    },
  };
}

interface LaneResult { directory: string; route: Route; receipt: RunnerReceipt; commandStatus: string }
async function lane(context: Context, route: Route, name: string, prompt: string, prepare?: (directory: string) => void): Promise<LaneResult> {
  const directory = join(context.directory, name);
  mkdirSync(directory, { mode: 0o700 });
  prepare?.(directory);
  writeFileSync(join(directory, "prompt.md"), prompt, { flag: "wx", mode: 0o600 });
  const selected = ROUTES[route];
  const output = join(directory, "output.md"), receiptPath = join(directory, "receipt.json");
  const command = await context.journal.run([
    join(context.repository, "skills/poteto-mode/scripts/runner/pstack-runner"),
    "--parent", selected.parent, "--provider", selected.provider, "--model", selected.model, "--effort", selected.effort,
    "--transport", selected.transport, "--mode", selected.transport === "grok-acp" ? "full-access" : "isolated-write",
    "--cwd", directory, "--prompt", join(directory, "prompt.md"), "--output", output, "--receipt", receiptPath,
  ], { cwd: directory, label: `lane-${route}`, env: childEnvironment() });
  // Even an absent/malformed receipt is diagnosed only after command streams are durable.
  const receipt: RunnerReceipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  if (route === "grok-cli") captureGrokTools(directory, receipt.sessionId);
  return { directory, route, receipt, commandStatus: command.status };
}

function assertLane(result: LaneResult): void {
  const requested = ROUTES[result.route];
  assert.equal(result.commandStatus, "complete", `${result.route}: launcher failed`);
  assert.equal(result.receipt.status, "complete", `${result.route}: ${result.receipt.error?.message}`);
  for (const key of ["parent", "provider", "model", "effort"] as const) assert.equal(result.receipt[key], requested[key]);
  assert.ok(result.receipt.modelVerified || result.receipt.modelEvidence === "pinned-argv", "missing served-model or pinned-argv proof");
  assert.equal(result.receipt.cwd, result.directory);
  assert.equal(result.receipt.promptPath, join(result.directory, "prompt.md"));
  assert.equal(result.receipt.outputPath, join(result.directory, "output.md"));
  if (requested.transport === "grok-acp") {
    assert.equal(result.receipt.acp?.eventsPath, join(result.directory, "receipt.json.events.jsonl"));
    assert.ok(readFileSync(result.receipt.acp.eventsPath, "utf8").includes('"method":"session/prompt"'));
  } else {
    assert.equal(result.receipt.stdoutPath, join(result.directory, "receipt.json.stdout"));
    assert.equal(result.receipt.stderrPath, join(result.directory, "receipt.json.stderr"));
    assert.ok(readFileSync(result.receipt.stdoutPath).length, "empty model transcript");
  }
}

async function prepareRoutes(context: Context): Promise<void> {
  assert.ok(context.routes.length > 0, "live recipes require an explicit --route");
  for (const provider of new Set(context.routes.map((route) => ROUTES[route].provider))) {
    await context.journal.text([provider, "--version"], { cwd: context.repository, label: `version-${provider}`, env: childEnvironment() });
  }
}

const PONG = "Reply with exactly PSTACK_VERIFIER_PONG. Do not use tools or spawn agents.";
function assertPong(result: LaneResult, timing = false): void {
  assertLane(result);
  assert.equal(readFileSync(join(result.directory, "output.md"), "utf8").trim(), "PSTACK_VERIFIER_PONG");
  if (timing) assertNoTools(result.route, result.route === "grok-acp" ? result.receipt.acp!.eventsPath
    : result.route === "grok-cli" ? join(result.directory, "grok-tool-updates.jsonl") : result.receipt.stdoutPath!);
}

export function assertNoTools(route: Route, path: string): void {
  assert.notEqual(route, "claude-cli", "Claude runner output has no complete tool trace; PONG timing is unsupported");
  if (route === "grok-cli" || route === "grok-acp") {
    assert.equal(toolEvents(path, ROUTES[route].transport).length, 0, "PONG method forbids tool calls");
    return;
  }
  const events = readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  for (const event of events) {
    if (route === "codex-cli" && event.type?.startsWith("item.")) {
      assert.ok(["agent_message", "reasoning"].includes(event.item?.type), "PONG method forbids tool or other work items");
    }
  }
}

// Slightly beyond the observed five-minute boundary, not another 40-minute run.
export const INNER_PROBE_MS = 330_000;
export const INNER_REQUEST_MS = 450_000;
export function innerCommand(directory: string): string {
  const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  return `${shellQuote(process.execPath)} ${shellQuote(join(directory, "probe.cjs"))}`;
}
export function innerProbeScript(durationMs = INNER_PROBE_MS): string {
  return `const fs = require('node:fs');
const path = require('node:path');
const log = path.join(__dirname, 'probe-events.jsonl');
const append = (kind) => fs.appendFileSync(log, JSON.stringify({kind, at: Date.now(), pid: process.pid}) + '\\n', {mode: 0o600});
// An accidental extra invocation is evidence, even if it fails the exclusive lock.
append('invoked');
fs.writeFileSync(path.join(__dirname, 'probe.lock'), String(process.pid), {flag: 'wx', mode: 0o600});
append('started');
process.on('SIGTERM', () => { append('SIGTERM'); process.exit(143); });
setTimeout(() => { append('completed'); console.log('PSTACK_INNER_TIMEOUT_COMPLETED'); }, ${durationMs});
`;
}

export function assertInnerEvents(events: { kind: string; at: number }[], durationMs = INNER_PROBE_MS): number {
  assert.equal(events.filter((event) => event.kind === "invoked").length, 1, "inner probe must run exactly once; no warmup or retry");
  const starts = events.filter((event) => event.kind === "started"), ends = events.filter((event) => event.kind === "completed");
  assert.equal(starts.length, 1, "missing inner command start");
  assert.equal(ends.length, 1, "inner command did not survive the requested duration; inspect tool events before attributing the limit");
  const elapsedMs = ends[0].at - starts[0].at;
  assert.ok(elapsedMs >= durationMs, "inner probe ended before its declared duration");
  return elapsedMs;
}

export const recipes: Record<Feature, Recipe> = {
  "verifier-contracts": tests(["scripts/verify/*.test.ts"]),
  "runner-contracts": tests(["skills/poteto-mode/scripts/runner/*.test.ts"]),
  "setup-contracts": tests(["skills/setup-pstack/scripts/*.test.ts"]),
  "repository-contracts": tests(["scripts/*.test.ts", "skills/update-clis/scripts/*.test.ts"]),
  "runner-smoke": {
    description: "One fresh, real model session per selected route; no warmups or retries.", live: true, prepare: prepareRoutes,
    async exercise(context) {
      const results: LaneResult[] = [];
      for (const route of context.routes) results.push(await lane(context, route, route, PONG));
      return results;
    },
    assert(value) {
      const results = value as LaneResult[];
      results.forEach((result) => assertPong(result));
      return { assertions: ["Every selected route produced the exact marker with matching model, effort, paths and preserved streams"], measurements: results.map(({ route, receipt }) => ({ route, elapsedMs: receipt.elapsedMs })) };
    },
  },
  "inner-timeout": {
    description: `Exactly one ${INNER_PROBE_MS} ms terminal command per route, requesting ${INNER_REQUEST_MS} ms from the model's tool. No retries.`,
    live: true, async prepare(context) {
      assert.ok(context.routes.every((route) => route === "grok-cli" || route === "grok-acp"), "inner-timeout currently proves Grok CLI and ACP only");
      await prepareRoutes(context);
    },
    async exercise(context) {
      const results: LaneResult[] = [];
      for (const route of context.routes) {
        const directory = join(context.directory, route);
        const command = innerCommand(directory);
        const result = await lane(context, route, route,
          `Transport capability probe. Use your terminal tool exactly ONCE to run this command in the foreground: ${command}\nSet that tool's timeout to ${INNER_REQUEST_MS} milliseconds. Wait for completion inside that same tool call. Do not background, poll, warm up, retry, alter files, or spawn agents. If the tool stops early, report its actual error and stop. After it returns, reply with its terminal result. This intentionally takes ${INNER_PROBE_MS / 1000} seconds.`,
          (dir) => writeFileSync(join(dir, "probe.cjs"), innerProbeScript(), { flag: "wx", mode: 0o600 }));
        results.push(result);
      }
      return results;
    },
    assert(value, context) {
      const results = value as LaneResult[];
      const measurements = results.map((result) => {
        assertLane(result);
        const path = result.route === "grok-acp" ? result.receipt.acp!.eventsPath : join(result.directory, "grok-tool-updates.jsonl");
        const tool = assertToolMethod(toolEvents(path, ROUTES[result.route].transport), innerCommand(result.directory), INNER_REQUEST_MS);
        const events = readFileSync(join(result.directory, "probe-events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
        return { route: result.route, tool, events, probeDurationMs: INNER_PROBE_MS, laneElapsedMs: result.receipt.elapsedMs };
      });
      save(join(context.directory, "measurements.json"), measurements);
      measurements.forEach((measurement) => assertInnerEvents(measurement.events));
      return { assertions: ["Exactly one fixed tool call per route with the actual requested timeout, and one probe completion lasting at least the declared duration"], measurements };
    },
  },
  concurrency: {
    description: "Four tool-free PONG sessions at each width 1, 2 and 4, per Grok or Codex route; zero warmups; twelve sessions per route. Claude's summary output cannot prove the method. Measures external processes, not native agent slots.",
    live: true, async prepare(context) {
      assert.ok(!context.routes.includes("claude-cli"), "Claude runner output has no complete tool trace; concurrency requires Grok or Codex");
      await prepareRoutes(context);
    },
    async exercise(context) {
      const measurements = [];
      for (const route of context.routes) for (const width of [1, 2, 4]) {
        const started = Date.now();
        const outcomes: PromiseSettledResult<LaneResult>[] = [];
        for (let offset = 0; offset < 4; offset += width) {
          outcomes.push(...await Promise.allSettled(Array.from({ length: width }, (_, index) => lane(context, route, `${route}-w${width}-s${offset + index}`, PONG))));
        }
        const measurement = { route, width, samples: 4, warmups: 0, elapsedMs: Date.now() - started, outcomes };
        measurements.push(measurement);
        save(join(context.directory, "measurements.json"), measurements.map((m) => ({ ...m, outcomes: m.outcomes.map((outcome) => outcome.status === "rejected" ? { status: "rejected", reason: String(outcome.reason) } : outcome) })));
      }
      return measurements;
    },
    assert(value) {
      const measurements = value as { route: Route; width: number; samples: number; warmups: number; elapsedMs: number; outcomes: PromiseSettledResult<LaneResult>[] }[];
      for (const measurement of measurements) for (const outcome of measurement.outcomes) {
        assert.equal(outcome.status, "fulfilled", "concurrent lane failed; all attempts were retained");
        if (outcome.status === "fulfilled") assertPong(outcome.value, true);
      }
      return { assertions: ["All twelve sessions per route completed; fixed four samples at widths 1, 2, 4; no automatic retries"], measurements: measurements.map(({ outcomes, ...measurement }) => ({ ...measurement, laneElapsedMs: outcomes.map((outcome) => outcome.status === "fulfilled" ? outcome.value.receipt.elapsedMs : null) })) };
    },
  },
};
