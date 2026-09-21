import { spawn } from "node:child_process";
import type {
  HttpEvidence,
  HttpRunnerOptions,
  Lane,
  LaneContext,
  LaneFailure,
  LaneOutcome,
  RemoteRun,
} from "./types.ts";

export const CURSOR_ENV = {
  /** Required. Basic auth user; the password is empty. */
  apiKey: "CURSOR_API_KEY",
  /** Test seam. Honored only when its hostname is loopback. */
  baseUrl: "PSTACK_CURSOR_BASE_URL",
  /** Test seam. Honored only alongside an accepted baseUrl override. */
  pollIntervalMs: "PSTACK_CURSOR_POLL_MS",
  /** Test seam. Replaces the github.com URL for `git ls-remote` only; same acceptance rule as pollIntervalMs. */
  gitRemote: "PSTACK_CURSOR_GIT_REMOTE",
} as const;

const DEFAULT_BASE_URL = "https://api.cursor.com";
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const REQUEST_BUDGET_MS = 60_000;
const CANCEL_BUDGET_MS = 10_000;
const MAX_CONSECUTIVE_POLL_FAILURES = 5;
const EVIDENCE_LIMIT = 4_000;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

export function httpLane(
  options: HttpRunnerOptions,
  env: NodeJS.ProcessEnv = process.env
): Lane {
  const ev: HttpEvidence = {
    kind: "http",
    preflight: { argv: ["GET", "/v1/models"], status: "not-run", evidence: "" },
    argv: ["POST", "/v1/agents", options.model, options.effort],
    remote: { agentId: null, runId: null, agentUrl: null, pushedBranches: [] },
  };
  const endpoint = resolveEndpoint(env);
  return { evidence: ev, run: (context) => runCursorLane(options, endpoint, env, ev, context) };
}

interface Endpoint {
  readonly baseUrl: string;
  readonly pollIntervalMs: number;
  readonly apiKey: string | null;
  readonly gitRemote: string | null;
}

function loopbackOrigin(value: string | undefined): string | null {
  if (value === undefined) return null;
  try {
    const url = new URL(value);
    return LOOPBACK_HOSTS.has(url.hostname) ? url.origin : null;
  } catch {
    return null;
  }
}

function resolveEndpoint(env: NodeJS.ProcessEnv): Endpoint {
  const apiKey = env[CURSOR_ENV.apiKey]?.trim() || null;
  const override = loopbackOrigin(env[CURSOR_ENV.baseUrl]);
  const pollOverride = Number(env[CURSOR_ENV.pollIntervalMs]);
  const pollAccepted = override !== null && Number.isFinite(pollOverride) && pollOverride > 0;
  const gitRemote = env[CURSOR_ENV.gitRemote]?.trim() || null;
  return {
    apiKey,
    baseUrl: override ?? DEFAULT_BASE_URL,
    pollIntervalMs: pollAccepted ? pollOverride : DEFAULT_POLL_INTERVAL_MS,
    gitRemote: override === null ? null : gitRemote,
  };
}

type Reply =
  | { readonly kind: "ok"; readonly body: unknown }
  | { readonly kind: "failed"; readonly httpStatus: number | null; readonly detail: string }
  | { readonly kind: "aborted" };

interface CursorClient {
  request(
    method: "GET" | "POST",
    path: string,
    signal: AbortSignal,
    body?: unknown
  ): Promise<Reply>;
}

function head(text: string): string {
  return text.trim().slice(0, EVIDENCE_LIMIT);
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
  return `${error.message}${cause}`;
}

function cursorClient(endpoint: Endpoint, apiKey: string): CursorClient {
  const authorization = `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;
  return {
    async request(method, path, signal, body) {
      const headers: Record<string, string> = { authorization, accept: "application/json" };
      if (body !== undefined) headers["content-type"] = "application/json";
      let status: number;
      let text: string;
      try {
        const response = await fetch(`${endpoint.baseUrl}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal,
        });
        status = response.status;
        text = await response.text();
      } catch (error) {
        if (signal.aborted) return { kind: "aborted" };
        return { kind: "failed", httpStatus: null, detail: describeError(error) };
      }
      if (status < 200 || status >= 300) {
        return { kind: "failed", httpStatus: status, detail: `HTTP ${status}: ${head(text)}` };
      }
      try {
        return { kind: "ok", body: JSON.parse(text) as unknown };
      } catch {
        return {
          kind: "failed",
          httpStatus: status,
          detail: `HTTP ${status} with a non-JSON body: ${head(text)}`,
        };
      }
    },
  };
}

function requestSignal(context: LaneContext): AbortSignal {
  const remaining = context.deadlineAt === null
    ? REQUEST_BUDGET_MS
    : Math.min(REQUEST_BUDGET_MS, context.deadlineAt - Date.now());
  return AbortSignal.any([
    context.cancellation.abortSignal,
    AbortSignal.timeout(Math.max(1, remaining)),
  ]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringsOf(value: unknown, pick: (entry: unknown) => string | null): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value as unknown[]) {
    const picked = pick(entry);
    if (picked !== null) out.push(picked);
  }
  return out;
}

interface LaunchParam {
  readonly id: string;
  readonly value: string;
}

type Variant = readonly LaunchParam[];

/**
 * What /v1/models says about a model: the parameter ids it lists and the
 * id+value combinations (variants) a launch must match exactly.
 */
interface ModelEntry {
  readonly parameters: ReadonlySet<string>;
  readonly variants: readonly Variant[];
}

type ModelInventory = ReadonlyMap<string, ModelEntry>;

function decodeParams(value: unknown): Variant {
  if (!Array.isArray(value)) return [];
  const params: LaunchParam[] = [];
  for (const entry of value as unknown[]) {
    if (isRecord(entry) && typeof entry.id === "string" && typeof entry.value === "string") {
      params.push({ id: entry.id, value: entry.value });
    }
  }
  return params;
}

function decodeInventory(body: unknown): ModelInventory | null {
  if (!isRecord(body) || !Array.isArray(body.items)) return null;
  const models = new Map<string, ModelEntry>();
  for (const item of body.items as unknown[]) {
    if (!isRecord(item) || typeof item.id !== "string") continue;
    const parameters = new Set(
      stringsOf(item.parameters, (entry) => (isRecord(entry) && typeof entry.id === "string" ? entry.id : null))
    );
    const variants = Array.isArray(item.variants)
      ? (item.variants as unknown[]).flatMap((variant): Variant[] =>
        isRecord(variant) ? [decodeParams(variant.params)] : []
      )
      : [];
    models.set(item.id, { parameters, variants });
  }
  return models;
}

function describeParams(params: Variant): string {
  return params.map((param) => `${param.id}=${param.value}`).join(" ");
}

function sameParams(left: Variant, right: Variant): boolean {
  return (
    left.length === right.length &&
    left.every((param) => right.some((other) => other.id === param.id && other.value === param.value))
  );
}

type ModelSelection =
  | { readonly kind: "ready"; readonly params: Variant }
  | { readonly kind: "missing"; readonly message: string; readonly evidence: string };

function selectModel(models: ModelInventory, modelId: string, effort: string): ModelSelection {
  const entry = models.get(modelId);
  if (entry === undefined) {
    return {
      kind: "missing",
      message: `model ${modelId} is not in the Cursor inventory`,
      evidence: `available models: ${[...models.keys()].join(", ")}`,
    };
  }
  const wanted: LaunchParam[] = [];
  if (entry.parameters.has("effort")) wanted.push({ id: "effort", value: effort });
  if (entry.parameters.has("fast")) wanted.push({ id: "fast", value: "false" });
  // The launch must quote a listed variant verbatim (measured: a hand-built
  // params list is refused as invalid_model). A model that publishes no
  // variant table leaves nothing to quote, so the wanted list goes as is.
  if (entry.variants.length === 0) return { kind: "ready", params: wanted };
  const variant = entry.variants.find((candidate) => sameParams(candidate, wanted));
  if (variant !== undefined) return { kind: "ready", params: variant };
  return {
    kind: "missing",
    message: `model ${modelId} has no variant for effort ${effort} with fast=false`,
    evidence: `model ${modelId} variants:\n${entry.variants.map(describeParams).join("\n")}`,
  };
}

function decodeLaunch(body: unknown): RemoteRun {
  const agent = isRecord(body) && isRecord(body.agent) ? body.agent : {};
  const run = isRecord(body) && isRecord(body.run) ? body.run : {};
  return {
    agentId: typeof agent.id === "string" ? agent.id : null,
    runId: typeof run.id === "string" ? run.id : null,
    agentUrl: typeof agent.url === "string" ? agent.url : null,
    pushedBranches: [],
  };
}

type RunState = "pending" | "finished" | "failed" | "cancelled" | "unknown";

const RUN_STATES: Readonly<Record<string, RunState>> = {
  CREATING: "pending",
  RUNNING: "pending",
  FINISHED: "finished",
  ERROR: "failed",
  EXPIRED: "failed",
  CANCELLED: "cancelled",
};

interface RunSnapshot {
  readonly state: RunState;
  readonly status: string;
  readonly text: string | null;
}

// The run body's git.branches names the branch the agent worked on, which
// with workOnCurrentBranch is the PR head whether or not anything was pushed
// (measured 2026-09-21 on a read-only run). Push evidence comes from the
// remote heads instead; see remoteHeads.
function decodeSnapshot(body: unknown): RunSnapshot | null {
  if (!isRecord(body) || typeof body.status !== "string") return null;
  return {
    state: RUN_STATES[body.status] ?? "unknown",
    status: body.status,
    text: typeof body.result === "string" && body.result.length > 0 ? body.result : null,
  };
}

/** Branch name to commit SHA, from `git ls-remote --heads`. */
type RemoteHeads = ReadonlyMap<string, string>;

type HeadsReply =
  | { readonly kind: "ok"; readonly heads: RemoteHeads }
  | { readonly kind: "failed"; readonly detail: string };

const HEAD_PREFIX = "refs/heads/";

function parseHeads(text: string): RemoteHeads {
  const heads = new Map<string, string>();
  for (const line of text.split("\n")) {
    const [sha, ref] = line.split("\t");
    if (sha !== undefined && sha.length > 0 && ref !== undefined && ref.startsWith(HEAD_PREFIX)) {
      heads.set(ref.slice(HEAD_PREFIX.length), sha);
    }
  }
  return heads;
}

function remoteHeads(
  url: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal
): Promise<HeadsReply> {
  return new Promise((resolve) => {
    const child = spawn("git", ["ls-remote", "--heads", url], {
      cwd,
      env: { ...env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
    let stdout = "";
    let stderr = "";
    let failure: string | null = null;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      failure = describeError(error);
    });
    child.once("close", (code) => {
      if (failure === null && code === 0) {
        resolve({ kind: "ok", heads: parseHeads(stdout) });
        return;
      }
      resolve({
        kind: "failed",
        detail: head(stderr) || failure || `git ls-remote exited with status ${code}`,
      });
    });
  });
}

/** Heads whose SHA is new or changed since `before`, sorted. */
function pushedBetween(before: RemoteHeads, after: RemoteHeads): readonly string[] {
  return [...after]
    .filter(([name, sha]) => before.get(name) !== sha)
    .map(([name]) => name)
    .sort();
}

function failed(status: LaneFailure, message: string, evidence: string = ""): LaneOutcome {
  return { kind: "failed", status, error: { message, evidence } };
}

function stoppedBeforeLaunch(
  ev: HttpEvidence,
  wake: "cancelled" | "timed-out",
  context: LaneContext,
  phase: string,
  evidence: string = ""
): LaneOutcome {
  if (ev.preflight.status === "not-run") ev.preflight = { ...ev.preflight, status: wake };
  return failed(
    wake,
    wake === "cancelled"
      ? `launcher received ${context.cancellation.signal} ${phase}`
      : `explicit deadline elapsed ${phase}`,
    evidence
  );
}

function preflightFailed(ev: HttpEvidence, evidence: string): void {
  ev.preflight = { ...ev.preflight, status: "failed", evidence };
}

const UNVERIFIED_PUSHES = "could not verify pushed branches";

async function runCursorLane(
  options: HttpRunnerOptions,
  endpoint: Endpoint,
  env: NodeJS.ProcessEnv,
  ev: HttpEvidence,
  context: LaneContext
): Promise<LaneOutcome> {
  if (endpoint.apiKey === null) {
    return failed("unavailable-cli", `${CURSOR_ENV.apiKey} is not set`);
  }
  const client = cursorClient(endpoint, endpoint.apiKey);

  const beforePreflight = await context.wait(0);
  if (beforePreflight !== "ready") {
    return stoppedBeforeLaunch(ev, beforePreflight, context, "before authentication preflight");
  }

  const inventory = await client.request("GET", "/v1/models", requestSignal(context));
  if (inventory.kind === "aborted") {
    const why = await context.wait(0);
    if (why !== "ready") {
      return stoppedBeforeLaunch(ev, why, context, "during authentication preflight");
    }
    preflightFailed(ev, "no answer within the request budget");
    return failed("unavailable-cli", "authentication preflight did not answer", ev.preflight.evidence);
  }
  if (inventory.kind === "failed") {
    preflightFailed(ev, inventory.detail);
    return inventory.httpStatus === 401 || inventory.httpStatus === 403
      ? failed("unauthenticated", "authentication preflight was refused", inventory.detail)
      : failed("unavailable-cli", "authentication preflight failed", inventory.detail);
  }
  const models = decodeInventory(inventory.body);
  if (models === null) {
    preflightFailed(ev, head(JSON.stringify(inventory.body)));
    return failed("unavailable-cli", "model inventory had an unexpected shape", ev.preflight.evidence);
  }
  const selection = selectModel(models, options.model, options.effort);
  if (selection.kind === "missing") {
    preflightFailed(ev, selection.evidence);
    return failed("unavailable-model", selection.message, selection.evidence);
  }
  ev.preflight = {
    ...ev.preflight,
    status: "passed",
    evidence: `authenticated; model ${options.model} available${
      selection.params.length > 0 ? ` as ${describeParams(selection.params)}` : ""
    }`,
  };

  const beforeLaunch = await context.wait(0);
  if (beforeLaunch !== "ready") {
    return stoppedBeforeLaunch(ev, beforeLaunch, context, "before launching the cloud agent");
  }
  const { owner, name, pullNumber } = options.target;
  const repoUrl = `https://github.com/${owner}/${name}`;
  const gitRemote = endpoint.gitRemote ?? repoUrl;
  const before = await remoteHeads(gitRemote, options.cwd, env, requestSignal(context));
  if (before.kind === "failed") {
    const why = await context.wait(0);
    if (why !== "ready") {
      return stoppedBeforeLaunch(ev, why, context, "during the remote head snapshot");
    }
    if (options.mode === "read-only") return failed("child-failed", UNVERIFIED_PUSHES, before.detail);
  }
  // An isolated-write lane may push, so a failed baseline only costs it the
  // pushedBranches record; a read-only lane fails closed above.
  const baseline = before.kind === "ok" ? before.heads : null;
  const launch = await client.request("POST", "/v1/agents", requestSignal(context), {
    name: `pstack ${owner}/${name}#${pullNumber} ${options.model}@${options.effort}`,
    repos: [{ url: repoUrl, prUrl: `${repoUrl}/pull/${pullNumber}` }],
    workOnCurrentBranch: true,
    autoCreatePR: false,
    model: { id: options.model, params: selection.params },
    prompt: { text: context.prompt },
  });
  const launchInFlight =
    "the launch request was in flight; a cloud agent may exist without its id reaching this receipt";
  if (launch.kind === "aborted") {
    const why = await context.wait(0);
    if (why !== "ready") {
      return stoppedBeforeLaunch(ev, why, context, "during the launch request", launchInFlight);
    }
    return failed("child-failed", "the launch request did not answer", launchInFlight);
  }
  if (launch.kind === "failed") {
    return failed("child-failed", "the launch request failed", launch.detail);
  }
  ev.remote = decodeLaunch(launch.body);
  const { agentId, runId } = ev.remote;
  if (agentId === null || runId === null) {
    return failed(
      "child-failed",
      "the launch response lacked the agent or run id",
      head(JSON.stringify(launch.body))
    );
  }

  const runPath = `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`;
  const cancel = cancelOnce(client, ev, runPath);
  let failures = 0;
  let lastFailure = "";
  for (;;) {
    const reply = await client.request("GET", runPath, requestSignal(context));
    if (reply.kind === "aborted") {
      const why = await context.wait(0);
      if (why !== "ready") return cancel(why, context);
      failures += 1;
      lastFailure = "poll request exceeded its budget";
    } else if (reply.kind === "failed") {
      failures += 1;
      lastFailure = reply.detail;
    } else {
      const snapshot = decodeSnapshot(reply.body);
      if (snapshot === null) {
        failures += 1;
        lastFailure = `unexpected run shape: ${head(JSON.stringify(reply.body))}`;
      } else {
        failures = 0;
        if (snapshot.state === "finished" && baseline !== null) {
          const after = await remoteHeads(gitRemote, options.cwd, env, requestSignal(context));
          if (after.kind === "failed" && options.mode === "read-only") {
            return failed("child-failed", UNVERIFIED_PUSHES, after.detail);
          }
          if (after.kind === "ok") {
            ev.remote = { ...ev.remote, pushedBranches: pushedBetween(baseline, after.heads) };
          }
        }
        if (snapshot.state !== "pending") {
          return terminalOutcome(options, ev, snapshot.state, snapshot, reply.body);
        }
      }
    }
    if (failures >= MAX_CONSECUTIVE_POLL_FAILURES) {
      return failed("child-failed", `${failures} consecutive poll requests failed`, lastFailure);
    }
    const wake = await context.wait(endpoint.pollIntervalMs);
    if (wake !== "ready") return cancel(wake, context);
  }
}

function cancelOnce(
  client: CursorClient,
  ev: HttpEvidence,
  runPath: string
): (wake: "cancelled" | "timed-out", context: LaneContext) => Promise<LaneOutcome> {
  let pending: Promise<string> | null = null;
  return async (wake, context) => {
    if (pending === null) {
      const path = `${runPath}/cancel`;
      ev.argv = [...ev.argv, "POST", path];
      pending = client
        .request("POST", path, AbortSignal.timeout(CANCEL_BUDGET_MS))
        .then((reply) =>
          reply.kind === "ok"
            ? "cancel acknowledged"
            : reply.kind === "failed"
              ? `cancel request failed: ${reply.detail}`
              : "cancel request exceeded its budget"
        );
    }
    const evidence = await pending;
    return failed(
      "cancelled",
      wake === "cancelled"
        ? `launcher received ${context.cancellation.signal} while polling the cloud agent; cancel requested`
        : "explicit deadline elapsed while polling the cloud agent; cancel requested",
      evidence
    );
  };
}

function terminalOutcome(
  options: HttpRunnerOptions,
  ev: HttpEvidence,
  state: Exclude<RunState, "pending">,
  snapshot: RunSnapshot,
  body: unknown
): LaneOutcome {
  const raw = head(JSON.stringify(body));
  switch (state) {
    case "finished": {
      const pushed = ev.remote.pushedBranches;
      if (options.mode === "read-only" && pushed.length > 0) {
        return failed("child-failed", `read-only lane pushed ${pushed.join(", ")}`, raw);
      }
      if (snapshot.text === null) {
        return failed("malformed-output", "finished run carried no result text", raw);
      }
      return {
        kind: "produced",
        parsed: {
          text: snapshot.text,
          reportedModel: null,
          sessionId: ev.remote.agentId,
          usage: null,
          costUsd: null,
        },
      };
    }
    case "failed":
      return failed("child-failed", `cloud run ended with status ${snapshot.status}`, raw);
    case "cancelled":
      return failed("child-failed", "cloud run was cancelled remotely, not by this launcher", raw);
    case "unknown":
      return failed("child-failed", `cloud run reported an unknown status ${snapshot.status}`, raw);
  }
}
