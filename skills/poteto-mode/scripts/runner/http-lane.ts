import { spawn } from "node:child_process";
import {
  familyOf,
  type HttpEvidence,
  type HttpRunnerOptions,
  type Lane,
  type LaneContext,
  type LaneFailure,
  type LaneOutcome,
  type RemoteRun,
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
    remote: { agentId: null, runId: null, agentUrl: null, heads: { kind: "not-taken" } },
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

type Params = readonly LaunchParam[];

interface Variant {
  readonly params: Params;
  readonly isDefault: boolean;
}

/**
 * What /v1/models says about a model: the parameter ids it lists and the
 * id+value combinations (variants) a launch must match exactly.
 */
interface ModelEntry {
  readonly parameters: ReadonlySet<string>;
  readonly variants: readonly Variant[];
}

type ModelInventory = ReadonlyMap<string, ModelEntry>;

function decodeParams(value: unknown): Params | null {
  if (!Array.isArray(value)) return null;
  const params: LaunchParam[] = [];
  const ids = new Set<string>();
  for (const entry of value as unknown[]) {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      entry.id.length === 0 ||
      typeof entry.value !== "string" ||
      ids.has(entry.id)
    ) return null;
    ids.add(entry.id);
    params.push({ id: entry.id, value: entry.value });
  }
  return params;
}

function decodeInventory(body: unknown, selectedModelId: string): ModelInventory | null {
  if (!isRecord(body) || !Array.isArray(body.items)) return null;
  const models = new Map<string, ModelEntry>();
  for (const item of body.items as unknown[]) {
    if (!isRecord(item) || typeof item.id !== "string") continue;
    if (models.has(item.id)) {
      if (item.id === selectedModelId) return null;
      continue;
    }
    if (item.id !== selectedModelId) {
      models.set(item.id, { parameters: new Set(), variants: [] });
      continue;
    }
    const parameters = new Set(
      stringsOf(item.parameters, (entry) => (isRecord(entry) && typeof entry.id === "string" ? entry.id : null))
    );
    if (item.variants !== undefined && !Array.isArray(item.variants)) return null;
    const variants: Variant[] = [];
    for (const value of (item.variants ?? []) as unknown[]) {
      if (!isRecord(value)) return null;
      if (value.isDefault !== undefined && typeof value.isDefault !== "boolean") return null;
      const params = decodeParams(value.params);
      if (params === null) return null;
      variants.push({ params, isDefault: value.isDefault === true });
    }
    models.set(item.id, { parameters, variants });
  }
  return models;
}

function describeParams(params: Params): string {
  return params.map((param) => `${param.id}=${param.value}`).join(" ");
}

function sameParams(left: Params, right: Params): boolean {
  return (
    left.length === right.length &&
    left.every((param) => right.some((other) => other.id === param.id && other.value === param.value))
  );
}

type ModelSelection =
  | { readonly kind: "ready"; readonly params: Params; readonly evidence: string }
  | { readonly kind: "missing"; readonly message: string; readonly evidence: string };

type SelectionRequest = Pick<HttpRunnerOptions, "provider" | "model" | "effort">;

type EffortBinding =
  | { readonly kind: "selectable"; readonly id: "effort" | "reasoning" }
  | { readonly kind: "provider-default" };

const CONTROL_IDS = new Set(["effort", "reasoning", "fast"]);

function describeVariants(entry: ModelEntry): string {
  return entry.variants
    .map((variant) => `${describeParams(variant.params) || "[]"}${variant.isDefault ? " [default]" : ""}`)
    .join("\n");
}

function unavailable(modelId: string, entry: ModelEntry, message: string): ModelSelection {
  return {
    kind: "missing",
    message,
    evidence: `model ${modelId} variants:\n${describeVariants(entry) || "(none)"}`,
  };
}

function selectModel(models: ModelInventory, request: SelectionRequest): ModelSelection {
  const entry = models.get(request.model);
  if (entry === undefined) {
    return {
      kind: "missing",
      message: `model ${request.model} is not in the Cursor inventory`,
      evidence: `available models: ${[...models.keys()].join(", ")}`,
    };
  }
  if (entry.variants.length === 0) {
    return unavailable(request.model, entry, `model ${request.model} advertises no variants`);
  }

  const advertisedIds = new Set(entry.variants.flatMap((variant) => variant.params.map((param) => param.id)));
  const hiddenControlIds = [...advertisedIds]
    .filter((id) => CONTROL_IDS.has(id) && !entry.parameters.has(id));
  if (hiddenControlIds.length > 0) {
    return unavailable(
      request.model,
      entry,
      `model ${request.model} has undeclared control parameters: ${hiddenControlIds.join(", ")}`
    );
  }

  const hasEffort = entry.parameters.has("effort");
  const hasReasoning = entry.parameters.has("reasoning");
  if (hasEffort && hasReasoning) {
    return unavailable(
      request.model,
      entry,
      `model ${request.model} advertises both effort and reasoning parameters`
    );
  }

  let effortBinding: EffortBinding;
  if (hasEffort || hasReasoning) {
    effortBinding = { kind: "selectable", id: hasEffort ? "effort" : "reasoning" };
  } else {
    const family = familyOf(request.provider, request.model);
    if (
      family === null ||
      family.efforts.length !== 1 ||
      family.efforts[0] !== request.effort
    ) {
      return unavailable(
        request.model,
        entry,
        `model ${request.model} has no selectable effort parameter for matrix effort ${request.effort}`
      );
    }
    effortBinding = { kind: "provider-default" };
  }

  const defaults = entry.variants.filter((variant) => variant.isDefault);
  if (defaults.length > 1) {
    return unavailable(request.model, entry, `model ${request.model} advertises multiple default variants`);
  }

  const controlledIds = new Set<string>();
  if (effortBinding.kind === "selectable") controlledIds.add(effortBinding.id);
  if (entry.parameters.has("fast")) controlledIds.add("fast");
  const allIds = new Set([...entry.parameters, ...advertisedIds]);
  const uncontrolledIds = [...allIds].filter((id) => !controlledIds.has(id));

  let wanted: LaunchParam[];
  const defaultVariant = defaults[0];
  if (defaultVariant === undefined) {
    if (uncontrolledIds.length > 0) {
      return unavailable(
        request.model,
        entry,
        `model ${request.model} has no default for parameters: ${uncontrolledIds.join(", ")}`
      );
    }
    if (effortBinding.kind === "provider-default") {
      return unavailable(request.model, entry, `model ${request.model} has no declared provider default`);
    }
    wanted = [];
  } else {
    const defaultIds = new Set(defaultVariant.params.map((param) => param.id));
    const missingDefaultIds = uncontrolledIds.filter((id) => !defaultIds.has(id));
    if (missingDefaultIds.length > 0) {
      return unavailable(
        request.model,
        entry,
        `model ${request.model} default omits parameters: ${missingDefaultIds.join(", ")}`
      );
    }
    wanted = defaultVariant.params.map((param) => ({ ...param }));
  }

  const setWanted = (id: string, value: string): void => {
    const index = wanted.findIndex((param) => param.id === id);
    if (index === -1) wanted.push({ id, value });
    else wanted[index] = { id, value };
  };
  if (effortBinding.kind === "selectable") setWanted(effortBinding.id, request.effort);
  if (entry.parameters.has("fast")) setWanted("fast", "false");

  let selected: Variant | undefined;
  for (const variant of entry.variants) {
    if (!sameParams(variant.params, wanted)) continue;
    if (selected !== undefined) {
      return unavailable(request.model, entry, `model ${request.model} advertises duplicate exact variants`);
    }
    selected = variant;
  }
  if (selected === undefined) {
    const control = effortBinding.kind === "selectable"
      ? `${effortBinding.id}=${request.effort}`
      : `provider default for matrix effort ${request.effort}`;
    return unavailable(request.model, entry, `model ${request.model} has no exact variant for ${control}`);
  }
  const params = describeParams(selected.params) || "[]";
  const effortEvidence = effortBinding.kind === "selectable"
    ? `requested effort ${request.effort} selects ${effortBinding.id}=${request.effort}`
    : `requested effort ${request.effort} is not selectable; this matrix label maps to the provider default`;
  return {
    kind: "ready",
    params: selected.params,
    evidence: `authenticated; model ${request.model} available; selected params: ${params}; ${effortEvidence}`,
  };
}

function decodeLaunch(body: unknown): RemoteRun {
  const agent = isRecord(body) && isRecord(body.agent) ? body.agent : {};
  const run = isRecord(body) && isRecord(body.run) ? body.run : {};
  return {
    agentId: typeof agent.id === "string" ? agent.id : null,
    runId: typeof run.id === "string" ? run.id : null,
    agentUrl: typeof agent.url === "string" ? agent.url : null,
    heads: { kind: "not-taken" },
  };
}

type RunSnapshot =
  | { readonly state: "pending" | "unknown"; readonly status: string }
  | { readonly state: "finished"; readonly status: "FINISHED"; readonly text: string | null }
  | { readonly state: "failed"; readonly status: "ERROR" | "EXPIRED" }
  | { readonly state: "cancelled"; readonly status: "CANCELLED" };

// git.branches names the working branch even when no push occurred.
function decodeSnapshot(body: unknown): RunSnapshot | null {
  if (!isRecord(body) || typeof body.status !== "string") return null;
  switch (body.status) {
    case "CREATING":
    case "RUNNING":
      return { state: "pending", status: body.status };
    case "FINISHED":
      return {
        state: "finished", status: body.status,
        text: typeof body.result === "string" && body.result.length > 0 ? body.result : null,
      };
    case "ERROR":
    case "EXPIRED":
      return { state: "failed", status: body.status };
    case "CANCELLED":
      return { state: "cancelled", status: body.status };
    default:
      return { state: "unknown", status: body.status };
  }
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

function changedBetween(before: RemoteHeads, after: RemoteHeads): readonly string[] {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((name) => before.get(name) !== after.get(name))
    .sort();
}

type FailedOutcome = Extract<LaneOutcome, { readonly kind: "failed" }>;

function failed(status: LaneFailure, message: string, evidence: string = ""): FailedOutcome {
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

const UNVERIFIED_HEADS = "could not verify read-only execution: remote head snapshot unavailable";

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
  const models = decodeInventory(inventory.body, options.model);
  if (models === null) {
    preflightFailed(ev, head(JSON.stringify(inventory.body)));
    return failed("unavailable-cli", "model inventory had an unexpected shape", ev.preflight.evidence);
  }
  const selection = selectModel(models, options);
  if (selection.kind === "missing") {
    preflightFailed(ev, selection.evidence);
    return failed("unavailable-model", selection.message, selection.evidence);
  }
  ev.preflight = {
    ...ev.preflight,
    status: "passed",
    evidence: selection.evidence,
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
    ev.remote = { ...ev.remote, heads: { kind: "unverified", reason: before.detail } };
  }
  const afterBaseline = await context.wait(0);
  if (afterBaseline !== "ready") {
    return stoppedBeforeLaunch(ev, afterBaseline, context, "during the remote head snapshot");
  }
  if (before.kind === "failed" && options.mode === "read-only") {
    return failed("child-failed", UNVERIFIED_HEADS, before.detail);
  }
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
  ev.remote = { ...decodeLaunch(launch.body), heads: ev.remote.heads };
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
  let end: RunEnd;
  try {
    end = await observeRun(client, runPath, context, endpoint.pollIntervalMs);
  } catch (error) {
    end = { kind: "abandoned", outcome: failed("child-failed", describeError(error)) };
  }
  if (end.kind === "abandoned") {
    const detail = await cancel();
    return {
      ...end.outcome,
      error: { ...end.outcome.error, evidence: [end.outcome.error.evidence, detail].filter(Boolean).join("\n\n") },
    };
  }

  if (end.snapshot.state === "finished" && baseline !== null) {
    const after = await remoteHeads(gitRemote, options.cwd, env, requestSignal(context));
    ev.remote = {
      ...ev.remote,
      heads: after.kind === "ok"
        ? { kind: "observed", changedBranches: changedBetween(baseline, after.heads) }
        : { kind: "unverified", reason: after.detail },
    };
  }
  const wake = await context.wait(0);
  if (wake !== "ready") {
    return failed(
      "cancelled",
      wake === "cancelled"
        ? `launcher received ${context.cancellation.signal} after the cloud run reached ${end.snapshot.status}; no cancel needed`
        : `explicit deadline elapsed after the cloud run reached ${end.snapshot.status}; no cancel needed`
    );
  }
  return terminalOutcome(options, ev, end.snapshot, end.raw);
}

type TerminalSnapshot = Extract<RunSnapshot, { readonly state: "finished" | "failed" | "cancelled" }>;

type RunEnd =
  | { readonly kind: "terminal"; readonly snapshot: TerminalSnapshot; readonly raw: string }
  | { readonly kind: "abandoned"; readonly outcome: FailedOutcome };

function stoppedWhilePolling(wake: "cancelled" | "timed-out", context: LaneContext): FailedOutcome {
  return failed(
    "cancelled",
    wake === "cancelled"
      ? `launcher received ${context.cancellation.signal} while polling the cloud agent; cancel requested`
      : "explicit deadline elapsed while polling the cloud agent; cancel requested"
  );
}

async function observeRun(
  client: CursorClient,
  runPath: string,
  context: LaneContext,
  pollIntervalMs: number
): Promise<RunEnd> {
  const beforePoll = await context.wait(0);
  if (beforePoll !== "ready") return { kind: "abandoned", outcome: stoppedWhilePolling(beforePoll, context) };
  let failures = 0;
  let lastFailure = "";
  for (;;) {
    const reply = await client.request("GET", runPath, requestSignal(context));
    const snapshot = reply.kind === "ok" ? decodeSnapshot(reply.body) : null;
    const raw = reply.kind === "ok" ? head(JSON.stringify(reply.body)) : "";
    if (snapshot !== null && (snapshot.state === "finished" || snapshot.state === "failed" || snapshot.state === "cancelled")) {
      return { kind: "terminal", snapshot, raw };
    }
    const wake = await context.wait(0);
    if (wake !== "ready") return { kind: "abandoned", outcome: stoppedWhilePolling(wake, context) };
    if (reply.kind === "aborted") {
      failures += 1;
      lastFailure = "poll request exceeded its budget";
    } else if (reply.kind === "failed") {
      failures += 1;
      lastFailure = reply.detail;
    } else if (snapshot === null) {
      failures += 1;
      lastFailure = `unexpected run shape: ${raw}`;
    } else if (snapshot.state === "unknown") {
      return {
        kind: "abandoned",
        outcome: failed("child-failed", `cloud run reported an unknown status ${snapshot.status}`, raw),
      };
    } else {
      failures = 0;
    }
    if (failures >= MAX_CONSECUTIVE_POLL_FAILURES) {
      return { kind: "abandoned", outcome: failed("child-failed", `${failures} consecutive poll requests failed`, lastFailure) };
    }
    const waited = await context.wait(pollIntervalMs);
    if (waited !== "ready") return { kind: "abandoned", outcome: stoppedWhilePolling(waited, context) };
  }
}

function cancelOnce(
  client: CursorClient,
  ev: HttpEvidence,
  runPath: string
): () => Promise<string> {
  let pending: Promise<string> | null = null;
  return () => {
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
        )
        .catch((error: unknown) => `cancel request failed: ${describeError(error)}`);
    }
    return pending;
  };
}

function terminalOutcome(
  options: HttpRunnerOptions,
  ev: HttpEvidence,
  snapshot: TerminalSnapshot,
  raw: string
): LaneOutcome {
  switch (snapshot.state) {
    case "finished": {
      const heads = ev.remote.heads;
      if (options.mode === "read-only") {
        if (heads.kind !== "observed") {
          return failed("child-failed", UNVERIFIED_HEADS, heads.kind === "unverified" ? heads.reason : "remote heads were not compared");
        }
        if (heads.changedBranches.length > 0) {
          return failed(
            "child-failed",
            `could not verify read-only execution: remote heads changed: ${heads.changedBranches.join(", ")}`,
            `The snapshots show new, moved, or deleted heads. The Cursor API cannot attribute these changes to this run or other actors.\n\n${raw}`
          );
        }
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
  }
}
