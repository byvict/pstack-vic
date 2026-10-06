import { childEnvironment, findExecutable, runProcess, stageOverlay, type ProcessResult } from "./child.ts";
export { childEnvironment, findExecutable } from "./child.ts";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  reportedModelMatches as familyReportMatches,
  type Family,
} from "../../../../scripts/model-matrix.ts";
import {
  configOverlay,
  invocationCommand,
  preflightCommand,
  type CommandSpec,
} from "./commands.ts";
import { grokAcpExecution, readT3Attachment } from "./grok-acp.ts";
import { parseProviderOutput, ProviderResultError, reportedModelMatches } from "./parse-output.ts";
import {
  cliFor,
  familyOf,
  MATRIX,
  UsageError,
  type CancellationSignal,
  type CliEvidence,
  type Lane,
  type LaneContext,
  type LaneFailure,
  type LaneOutcome,
  type ModelStreams,
  type ParsedOutput,
  type PreflightRecord,
  type Provider,
  type ReceiptStatus,
  type RunCancellation,
  type RunnerOptions,
  type ExecutionRequest,
  type PreparedAttempt,
  type PreparedContext,
  type AcpDetail,
  type RunnerReceipt,
  type WaitOutcome,
} from "./types.ts";

const ERROR_EVIDENCE_LIMIT = 4_000;
const GROK_PREFLIGHT_RETRY_DELAY_MS = 5_000;

export interface RunResult {
  readonly exitCode: number;
  readonly receipt: RunnerReceipt;
}

// A provider stream opens with a multi-kilobyte init event and ends with the
// result event that says why the lane failed, so a head-only window kept the
// tool list and dropped the error (measured 2026-09-18, Grok lane). Keep the
// head for preflight-style failures and the tail for the terminal event.
const EVIDENCE_HEAD = 1_000;
const EVIDENCE_GAP = "\n[…]\n";

export function evidence(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= ERROR_EVIDENCE_LIMIT) return trimmed;
  const tailLength = ERROR_EVIDENCE_LIMIT - EVIDENCE_HEAD - EVIDENCE_GAP.length;
  return `${trimmed.slice(0, EVIDENCE_HEAD)}${EVIDENCE_GAP}${trimmed.slice(-tailLength)}`;
}

function removeIfExists(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}

function reserve(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const descriptor = openSync(path, "wx", 0o600);
  closeSync(descriptor);
}

function modelStreamPaths(receiptPath: string): { stdoutPath: string; stderrPath: string } {
  return { stdoutPath: `${receiptPath}.stdout`, stderrPath: `${receiptPath}.stderr` };
}

function reserveOutputs(options: RunnerOptions): ModelStreams | null {
  const streams = options.transport === "grok-acp" ? null : modelStreamPaths(options.receiptPath);
  const paths = [options.outputPath, options.receiptPath, ...(streams === null ? [] : [streams.stdoutPath, streams.stderrPath])];
  const resolved = paths.map((path) => resolve(path));
  if (new Set(resolved).size !== paths.length || resolved.includes(resolve(options.promptPath))) {
    throw new UsageError("prompt, output, receipt, and stream paths must be distinct");
  }
  const created: string[] = [];
  let stdout: number | null = null;
  try {
    for (const path of paths.slice(0, 2)) {
      reserve(path);
      created.push(path);
    }
    if (streams === null) return null;
    stdout = openSync(streams.stdoutPath, "wx", 0o600);
    created.push(streams.stdoutPath);
    const stderr = openSync(streams.stderrPath, "wx", 0o600);
    return { stdout, stderr };
  } catch (error) {
    if (stdout !== null) closeSync(stdout);
    for (const path of created) removeIfExists(path);
    throw error;
  }
}

function writeReceipt(path: string, receipt: RunnerReceipt): void {
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function installRunCancellation(): RunCancellation {
  let signal: CancellationSignal | null = null;
  let resolveCancellation!: (value: CancellationSignal) => void;
  const promise = new Promise<CancellationSignal>((resolve) => {
    resolveCancellation = resolve;
  });
  const receive = (next: CancellationSignal): void => {
    if (signal === null) {
      signal = next;
      resolveCancellation(next);
    }
  };
  const onInterrupt = (): void => receive("SIGINT");
  const onTerminate = (): void => receive("SIGTERM");
  globalThis.process.on("SIGINT", onInterrupt);
  globalThis.process.on("SIGTERM", onTerminate);

  return {
    promise,
    get signal() {
      return signal;
    },
    dispose() {
      globalThis.process.off("SIGINT", onInterrupt);
      globalThis.process.off("SIGTERM", onTerminate);
    },
  };
}

async function waitFor(
  delayMs: number,
  deadlineAt: number | null,
  cancellation: RunCancellation
): Promise<WaitOutcome> {
  if (cancellation.signal !== null) return "cancelled";

  const now = Date.now();
  if (deadlineAt !== null && now >= deadlineAt) return "timed-out";
  if (delayMs <= 0) return "ready";

  const readyAt = now + delayMs;
  const wakeAt = deadlineAt === null ? readyAt : Math.min(readyAt, deadlineAt);
  const timerResult: WaitOutcome = wakeAt < readyAt ? "timed-out" : "ready";
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const result = await Promise.race([
      cancellation.promise.then((): WaitOutcome => "cancelled"),
      new Promise<WaitOutcome>((resolveWait) => {
        timer = setTimeout(() => resolveWait(timerResult), wakeAt - now);
      }),
    ]);
    if (cancellation.signal !== null) return "cancelled";
    if (deadlineAt !== null && Date.now() >= deadlineAt) return "timed-out";
    return result;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function grokModelAvailable(value: string, model: string): boolean {
  const escaped = model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_.-])${escaped}($|[^A-Za-z0-9_.-])`).test(value);
}

function preflightPassed(provider: Provider, model: string, result: ProcessResult): boolean {
  if (result.exitCode !== 0 || result.timedOut) return false;
  const combined = `${result.stdout}\n${result.stderr}`;
  switch (cliFor(provider)) {
    case "claude": {
      try {
        const value: unknown = JSON.parse(result.stdout);
        return (
          value !== null &&
          typeof value === "object" &&
          (value as { loggedIn?: unknown }).loggedIn === true
        );
      } catch {
        return false;
      }
    }
    case "codex":
      return /logged in/i.test(combined);
    case "grok":
      return unavailableStatus(combined, model) === "child-failed" &&
        /\blogged in\b/i.test(combined) && grokModelAvailable(combined, model);
    default:
      return false;
  }
}

function successfulPreflightEvidence(provider: Provider, model: string): string {
  return cliFor(provider) === "grok"
    ? `authenticated; model ${model} available`
    : "authenticated";
}

function unavailableStatus(value: string, requestedModel: string): LaneFailure {
  if (
    /\b(not logged in|not authenticated|unauthenticated|login required)\b/i.test(value) ||
    /\b(authentication(?: is)?[ -](failed|failure|required|error)|(?:please|must|need to) sign[ -]in|sign[ -]in (failed|failure|required)|sign in to (continue|proceed))\b/i.test(value)
  ) {
    return "unauthenticated";
  }
  for (const refusal of value.matchAll(/(?:^|[^A-Za-z0-9_.-])(?:model[ \t]+(?:is[ \t]+)?(?:not found|unknown|unavailable|unsupported|not supported|invalid)\b|invalid[ \t]+model(?=$|[^A-Za-z0-9_.-]|\.(?=$|[^A-Za-z0-9_.-])))(?:[ \t]+with[ \t]+this[ \t]+account\b)?(?:(?:[ \t]*:[ \t]*|[ \t]+)("[A-Za-z0-9_.-]+"|'[A-Za-z0-9_.-]+'|\[[A-Za-z0-9_.-]+\]|[A-Za-z0-9_.-]+)[ \t]*(?:[.!?][ \t]*)?$|(?=[ \t]*(?:$|[.!?](?=$|[ \t]))))/gim)) {
    const subject = refusal[1];
    if (subject === undefined || grokModelAvailable(subject, requestedModel)) return "unavailable-model";
  }
  for (const refusal of value.matchAll(/(?:^|[ \t])(?:model[ \t]*:[ \t]*)?(?:"([A-Za-z0-9_.-]+)"|'([A-Za-z0-9_.-]+)'|\[([A-Za-z0-9_.-]+)\]|([A-Za-z0-9_.-]+))[ \t]+(?:is[ \t]+)?(not found|unknown|unavailable|unsupported|not supported|invalid)\b/gim)) {
    const subject = refusal[1] ?? refusal[2] ?? refusal[3] ?? refusal[4];
    if (grokModelAvailable(subject, requestedModel)) return "unavailable-model";
  }
  return "child-failed";
}

function preflightFailureStatus(
  provider: Provider,
  model: string,
  value: string
): LaneFailure {
  const status = unavailableStatus(value, model);
  if (status !== "child-failed") return status;
  return cliFor(provider) === "grok" && !grokModelAvailable(value, model)
    ? "unavailable-model"
    : "unauthenticated";
}

function retriedPreflightEvidence(
  first: string,
  second: string,
  secondPassed: boolean
): string {
  const firstLabel = "attempt 1 failed:\n";
  const secondLabel = `\n\nattempt 2 ${secondPassed ? "passed" : "failed"}:\n`;
  const payloadLimit = ERROR_EVIDENCE_LIMIT - firstLabel.length - secondLabel.length;
  const firstLimit = Math.floor(payloadLimit / 2);
  const secondLimit = payloadLimit - firstLimit;
  return `${firstLabel}${first.slice(0, firstLimit)}${secondLabel}${second.slice(0, secondLimit)}`;
}

function statusExitCode(status: ReceiptStatus): number {
  switch (status) {
    case "complete":
      return 0;
    case "cancelled":
      return 130;
    case "malformed-output":
      return 65;
    case "unavailable-cli":
    case "unavailable-model":
      return 69;
    case "child-failed":
      return 70;
    case "unauthenticated":
      return 77;
    case "timed-out":
      return 124;
  }
}

interface ModelProof {
  readonly reportedModel: string | null;
  readonly modelVerified: boolean;
  readonly modelEvidence: "provider-report" | "pinned-argv" | null;
}

function modelProof(
  provider: Provider,
  requested: string,
  reported: string | null
): ModelProof {
  if (reportedModelMatches(provider, requested, reported)) {
    return {
      reportedModel: reported,
      modelVerified: true,
      modelEvidence: "provider-report",
    };
  }
  const family = familyOf(provider, requested);
  if (family !== null && family.reportedModel === null && reported === null) {
    return {
      reportedModel: null,
      modelVerified: false,
      modelEvidence: "pinned-argv",
    };
  }
  return {
    reportedModel: reported,
    modelVerified: false,
    modelEvidence: null,
  };
}

type Terminal =
  | { readonly kind: "complete"; readonly parsed: ParsedOutput; readonly proof: ModelProof }
  | Extract<LaneOutcome, { readonly kind: "failed" }>;

function applyModelProof(options: RunnerOptions, outcome: LaneOutcome): Terminal {
  if (outcome.kind === "failed") return outcome;
  const proof = modelProof(options.provider, options.model, outcome.parsed.reportedModel);
  if (proof.modelVerified || proof.modelEvidence === "pinned-argv") {
    return { kind: "complete", parsed: outcome.parsed, proof };
  }
  return {
    kind: "failed",
    status: "malformed-output",
    error: {
      message: `requested model ${options.model} was not reported by ${options.provider}`,
      evidence: `reported model: ${outcome.parsed.reportedModel ?? "none"}`,
    },
  };
}

function finish(
  options: RunnerOptions,
  started: number,
  evidence: CliEvidence,
  outcome: LaneOutcome
): RunResult {
  const terminal = applyModelProof(options, outcome);
  const completed = Date.now();
  const identity = {
    schemaVersion: 1 as const,
    parent: options.parent,
    provider: options.provider,
    model: options.model,
    effort: options.effort,
    mode: options.mode,
    cwd: options.cwd,
    promptPath: options.promptPath,
    outputPath: options.outputPath,
    ...(options.transport === "grok-acp"
      ? { stdoutPath: null, stderrPath: null }
      : modelStreamPaths(options.receiptPath)),
  };
  const status: ReceiptStatus = terminal.kind === "complete" ? "complete" : terminal.status;
  const timing = {
    startedAt: new Date(started).toISOString(),
    completedAt: new Date(completed).toISOString(),
    elapsedMs: completed - started,
  };
  const fields = terminal.kind === "complete"
    ? {
      ...terminal.proof,
      sessionId: terminal.parsed.sessionId,
      usage: terminal.parsed.usage,
      costUsd: terminal.parsed.costUsd,
      error: null,
    }
    : {
      ...(terminal.metadata === undefined
        ? { reportedModel: null, modelVerified: false, modelEvidence: null }
        : modelProof(options.provider, options.model, terminal.metadata.reportedModel)),
      sessionId: terminal.metadata?.sessionId ?? null,
      usage: terminal.metadata?.usage ?? null,
      costUsd: terminal.metadata?.costUsd ?? null,
      error: terminal.error,
    };
  const receipt: RunnerReceipt = {
    ...identity,
    status,
    ...timing,
    executable: evidence.executable,
    preflight: evidence.preflight,
    argv: evidence.argv,
    exitCode: evidence.exitCode,
    signal: evidence.signal,
    ...(evidence.acp === undefined ? {} : { acp: evidence.acp }),
    ...fields,
  };

  if (terminal.kind === "complete") {
    writeFileSync(options.outputPath, terminal.parsed.text, { encoding: "utf8", mode: 0o600 });
  } else {
    removeIfExists(options.outputPath);
  }
  writeReceipt(options.receiptPath, receipt);
  return { exitCode: statusExitCode(status), receipt };
}

/**
 * A family of the same provider whose reportedModel pattern matches `model`
 * although `model` is not that family's requested slug: a concrete revision
 * pinned where the rolling family name belongs (for example
 * `claude-fable-5-1` instead of `fable`).
 */
export function pinnedFamily(provider: Provider, model: string): Family | null {
  return (
    MATRIX.families.find(
      (f) =>
        f.provider === provider &&
        f.model !== model &&
        familyReportMatches(f, model)
    ) ?? null
  );
}

export function validateOptions(options: RunnerOptions): void {
  validateRoute(options);
  if (!(options.parent in MATRIX.parents)) {
    throw new UsageError(`parent ${options.parent} is not in model-matrix.json`);
  }
  if (!(options.provider in MATRIX.providers)) {
    throw new UsageError(`provider ${options.provider} is not in model-matrix.json`);
  }
  if (options.model.trim().length === 0) throw new UsageError("model must not be empty");
  const pinned = pinnedFamily(options.provider, options.model);
  if (pinned !== null) {
    throw new UsageError(
      `${options.provider} model ${options.model} is a version pin of family ${pinned.family}; normalize it to ${pinned.model} before invoking the runner`
    );
  }
  const family = familyOf(options.provider, options.model);
  if (family === null) {
    throw new UsageError(
      `${options.provider}:${options.model} is not a family in model-matrix.json`
    );
  }
  if (!family.efforts.includes(options.effort)) {
    throw new UsageError(
      `${family.family} does not select effort ${options.effort} (allowed: ${family.efforts.join(" ")})`
    );
  }
  if (
    options.timeoutMs !== null &&
    (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
  ) {
    throw new UsageError("timeout must be greater than zero");
  }
  if (!existsSync(options.promptPath) || !statSync(options.promptPath).isFile()) {
    throw new UsageError(`prompt is not a file: ${options.promptPath}`);
  }
  if (!existsSync(options.cwd) || !statSync(options.cwd).isDirectory()) {
    throw new UsageError(`cwd is not a directory: ${options.cwd}`);
  }
  if (
    options.promptPath === options.outputPath ||
    options.promptPath === options.receiptPath
  ) {
    throw new UsageError("prompt, output, and receipt paths must be distinct");
  }
}

function stoppedBeforeChild(
  ev: CliEvidence,
  wake: "cancelled" | "timed-out",
  cancellation: RunCancellation,
  phase: string
): LaneOutcome {
  if (ev.preflight.status === "not-run") ev.preflight = { ...ev.preflight, status: wake };
  return {
    kind: "failed",
    status: wake,
    error: {
      message: wake === "cancelled"
        ? `launcher received ${cancellation.signal} ${phase}`
        : `explicit deadline elapsed ${phase}`,
      evidence: "",
    },
  };
}

function preparedLane(
  options: ExecutionRequest,
  invocation: CommandSpec,
  attempt: PreparedAttempt,
  env: NodeJS.ProcessEnv = childEnvironment(),
  sanitize: (value: string) => string = (value) => value,
  acp?: AcpDetail,
): Lane {
  const preflight = preflightCommand(options.provider);
  const ev: CliEvidence = {
    executable: null,
    preflight: {
      argv: [preflight.command, ...preflight.args],
      status: "not-run",
      evidence: "",
    },
    argv: [invocation.command, ...invocation.args],
    exitCode: null,
    signal: null,
    ...(acp === undefined ? {} : { acp }),
  };
  return { evidence: ev, sanitize, run: (context) => runPreparedLane(options, invocation, preflight, ev, context, attempt, env, sanitize) };
}

async function runPreparedLane(
  options: ExecutionRequest,
  invocation: CommandSpec,
  preflight: CommandSpec,
  ev: CliEvidence,
  context: LaneContext,
  attempt: PreparedAttempt,
  env: NodeJS.ProcessEnv,
  sanitize: (value: string) => string,
): Promise<LaneOutcome> {
  const { deadlineAt, cancellation } = context;
  const executable = findExecutable(invocation.command, env.PATH, options.cwd);
  ev.executable = executable;
  ev.argv = [executable ?? invocation.command, ...invocation.args];

  const beforePreflight = await context.wait(0);
  if (beforePreflight !== "ready") {
    return stoppedBeforeChild(ev, beforePreflight, cancellation, "before authentication preflight");
  }

  if (executable === null) {
    return {
      kind: "failed",
      status: "unavailable-cli",
      error: { message: `${invocation.command} executable not found`, evidence: "" },
    };
  }

  let preflightResult = await runProcess(
    executable,
    preflight,
    options.cwd,
    env,
    "",
    deadlineAt,
    cancellation,
    ev
  );
  let rawPreflightEvidence = evidence(sanitize(`${preflightResult.stdout}\n${preflightResult.stderr}`));
  let passed = preflightPassed(options.provider, options.model, preflightResult);
  let preflightEvidence = passed
    ? successfulPreflightEvidence(options.provider, options.model)
    : rawPreflightEvidence;

  if (
    cliFor(options.provider) === "grok" &&
    !passed &&
    preflightResult.cancelledBy === null &&
    !preflightResult.timedOut &&
    preflightFailureStatus(options.provider, options.model, rawPreflightEvidence) ===
      "unauthenticated"
  ) {
    ev.preflight = {
      argv: [executable, ...preflight.args],
      status: "failed",
      evidence: rawPreflightEvidence,
    };

    const retryWait = await context.wait(GROK_PREFLIGHT_RETRY_DELAY_MS);
    if (retryWait !== "ready") {
      ev.preflight = { ...ev.preflight, status: retryWait };
      return stoppedBeforeChild(ev, retryWait, cancellation, "during authentication preflight retry delay");
    }

    const firstPreflightEvidence = rawPreflightEvidence;
    preflightResult = await runProcess(
      executable,
      preflight,
      options.cwd,
      env,
      "",
      deadlineAt,
      cancellation,
      ev
    );
    rawPreflightEvidence = evidence(sanitize(`${preflightResult.stdout}\n${preflightResult.stderr}`));
    passed = preflightPassed(options.provider, options.model, preflightResult);
    preflightEvidence = retriedPreflightEvidence(
      firstPreflightEvidence,
      passed
        ? successfulPreflightEvidence(options.provider, options.model)
        : rawPreflightEvidence,
      passed
    );
  }

  const preflightState: PreflightRecord = {
    argv: [executable, ...preflight.args],
    status: preflightResult.cancelledBy !== null
      ? "cancelled"
      : preflightResult.timedOut
        ? "timed-out"
        : passed
          ? "passed"
          : "failed",
    evidence: preflightEvidence,
  };
  ev.preflight = preflightState;

  if (preflightState.status !== "passed") {
    ev.exitCode = preflightResult.exitCode;
    ev.signal = preflightResult.signal;
    const status: LaneFailure = preflightResult.cancelledBy !== null
      ? "cancelled"
      : preflightResult.timedOut
        ? "timed-out"
        : preflightFailureStatus(options.provider, options.model, rawPreflightEvidence);
    return {
      kind: "failed",
      status,
      error: {
        message: preflightResult.cancelledBy !== null
          ? `launcher received ${preflightResult.cancelledBy} during preflight`
          : preflightResult.timedOut
            ? "authentication preflight timed out"
            : "authentication or model preflight failed",
        evidence: preflightEvidence,
      },
    };
  }

  const beforeModel = await context.wait(0);
  if (beforeModel !== "ready") {
    return stoppedBeforeChild(ev, beforeModel, cancellation, "before model execution");
  }

  return attempt({ ...context, executable, environment: env, evidence: ev });
}

function cliLane(options: Extract<ExecutionRequest, { kind: "cli" }>): Lane {
  const invocation = invocationCommand(options);
  return preparedLane(options, invocation, (context) => runCliAttempt(options, invocation, context));
}

async function runCliAttempt(
  options: Extract<ExecutionRequest, { kind: "cli" }>,
  invocation: CommandSpec,
  context: PreparedContext,
): Promise<LaneOutcome> {
  const result = await runModel(options, context.executable, invocation, context.environment, context, context.evidence);

  let parsed: ParsedOutput | null = null;
  let parseError: unknown = null;
  if (
    result.cancelledBy === null &&
    !result.timedOut &&
    (result.exitCode === 0 || (cliFor(options.provider) === "grok" && result.stdout.trim().length > 0))
  ) {
    try {
      parsed = parseProviderOutput(options.provider, result.stdout, result.stderr, options.model);
    } catch (error) {
      parseError = error;
    }
  }
  const providerFailure = parseError instanceof ProviderResultError ? parseError : null;
  const rawFailureEvidence = `${result.stderr}\n${result.stdout}`;

  if (result.cancelledBy !== null || result.timedOut || providerFailure !== null || result.exitCode !== 0) {
    const status: LaneFailure = result.cancelledBy !== null
      ? "cancelled"
      : result.timedOut
        ? "timed-out"
        : providerFailure?.status ?? unavailableStatus(rawFailureEvidence, options.model);
    return {
      kind: "failed",
      status,
      error: {
        message: result.cancelledBy !== null
          ? result.signal === result.cancelledBy
            ? `launcher received ${result.cancelledBy}; signal was sent to child`
            : `launcher received ${result.cancelledBy} after child exited`
          : result.timedOut
            ? `launcher exceeded the explicit ${options.timeoutMs}ms deadline`
            : providerFailure?.message ?? `child exited with status ${result.exitCode}`,
        evidence: evidence(providerFailure === null
          ? rawFailureEvidence
          : `${providerFailure.message}\n${rawFailureEvidence}`),
      },
      metadata: providerFailure?.metadata,
    };
  }

  if (parsed === null) {
    return {
      kind: "failed",
      status: "malformed-output",
      error: {
        message: parseError instanceof Error ? parseError.message : String(parseError),
        evidence: evidence(rawFailureEvidence),
      },
    };
  }
  return { kind: "produced", parsed };
}

/** The model child. A Grok lane gets its config overlay for the child's lifetime. */
async function runModel(
  options: RunnerOptions,
  executable: string,
  invocation: CommandSpec,
  env: NodeJS.ProcessEnv,
  context: LaneContext,
  ev: CliEvidence
): Promise<ProcessResult> {
  const overlay = configOverlay(options);
  const staged = overlay === null ? null : stageOverlay(env, overlay);
  let result: ProcessResult;
  try {
    result = await runProcess(
      executable,
      invocation,
      options.cwd,
      staged?.env ?? env,
      context.prompt,
      context.deadlineAt,
      context.cancellation,
      ev,
      context.streamFiles ?? undefined
    );
  } finally {
    if (staged !== null) rmSync(staged.directory, { recursive: true, force: true });
  }
  ev.exitCode = result.exitCode;
  ev.signal = result.signal;
  return result;
}

export async function runLane(
  options: RunnerOptions,
  started: number = Date.now()
): Promise<RunResult> {
  validateOptions(options);
  const deadlineAt = options.timeoutMs === null ? null : started + options.timeoutMs;
  const request = executionRequest(options);
  const lane = request.kind === "cli" ? cliLane(request) : (() => {
    const execution = grokAcpExecution(request, childEnvironment());
    return preparedLane(request, execution.command, execution.attempt, execution.environment, execution.sanitize, execution.acp);
  })();
  const cancellation = installRunCancellation();
  let streamFiles: ModelStreams | null = null;
  try {
    streamFiles = reserveOutputs(options);
    try {
      const context: LaneContext = {
        prompt: readFileSync(options.promptPath, "utf8"),
        deadlineAt,
        cancellation,
        streamFiles,
        wait: (delayMs) => waitFor(delayMs, deadlineAt, cancellation),
      };
      const outcome = await lane.run(context);
      const checkpoint = await context.wait(0);
      if (checkpoint !== "ready" && lane.evidence.acp !== undefined) lane.evidence.acp.shutdownIntent = checkpoint;
      return finish(options, started, lane.evidence, checkpoint === "ready" || (outcome.kind === "failed" && outcome.status === checkpoint)
        ? outcome
        : stoppedBeforeChild(lane.evidence, checkpoint, cancellation, "before receipt completion"));
    } catch (error) {
      const signal = cancellation.signal;
      const status: LaneFailure = signal !== null
        ? "cancelled"
        : deadlineAt !== null && Date.now() >= deadlineAt
          ? "timed-out"
          : "child-failed";
      const message = error instanceof Error ? error.message : String(error);
      const ev = lane.evidence;
      if (ev.preflight.status === "not-run" && status !== "child-failed") {
        ev.preflight = { ...ev.preflight, status };
      }
      return finish(options, started, ev, {
        kind: "failed",
        status,
        error: {
          message: status === "cancelled"
            ? `launcher received ${signal} after reserving output paths`
            : status === "timed-out"
              ? "explicit deadline elapsed after reserving output paths"
              : "launcher failed after reserving output paths",
          evidence: evidence(lane.sanitize?.(message) ?? message),
        },
      });
    }
  } finally {
    cancellation.dispose();
    if (streamFiles !== null) {
      closeSync(streamFiles.stdout);
      closeSync(streamFiles.stderr);
    }
  }
}

export function resolvedOptions(options: RunnerOptions): RunnerOptions {
  return {
    ...options,
    promptPath: resolve(options.promptPath),
    cwd: resolve(options.cwd),
    outputPath: resolve(options.outputPath),
    receiptPath: resolve(options.receiptPath),
    ...(options.mcpConfigPath === undefined ? {} : { mcpConfigPath: resolve(options.mcpConfigPath) }),
  };
}

export function validateRoute(options: RunnerOptions): void {
  if (options.transport === undefined || options.transport === "cli") {
    if (options.mode === "full-access") throw new UsageError("full-access requires --transport grok-acp");
    if (options.mcpConfigPath !== undefined) throw new UsageError("MCP configuration requires --transport grok-acp");
    return;
  }
  if (options.transport !== "grok-acp") throw new UsageError("unsupported transport");
  if (options.parent !== "codex" && options.parent !== "claude") throw new UsageError("Grok ACP requires parent codex or claude; use Grok's native subagent primitive");
  if (options.provider !== "grok") throw new UsageError("Grok ACP requires provider grok");
  if (options.mode !== "full-access") throw new UsageError("Grok ACP requires explicit --mode full-access");
}

function executionRequest(options: RunnerOptions): ExecutionRequest {
  validateRoute(options);
  const files = {
    model: options.model, effort: options.effort, promptPath: options.promptPath, cwd: options.cwd,
    outputPath: options.outputPath, receiptPath: options.receiptPath, timeoutMs: options.timeoutMs,
  };
  if (options.transport === "grok-acp") {
    if ((options.parent !== "codex" && options.parent !== "claude") || options.provider !== "grok" || options.mode !== "full-access") throw new UsageError("invalid Grok ACP request");
    return { ...files, kind: "grok-acp", parent: options.parent, provider: "grok", mode: "full-access",
      t3: options.mcpConfigPath === undefined ? null : readT3Attachment(options.mcpConfigPath) };
  }
  if (options.mode === "full-access") throw new UsageError("full-access requires Grok ACP");
  return { ...files, kind: "cli", parent: options.parent, provider: options.provider, mode: options.mode };
}
