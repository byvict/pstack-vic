// Copied from open-pstack 1.4.1 (de67e6b) runner/run.ts. Changes from the
// original:
// - Node 24 instead of Bun: node:child_process.spawn replaces Bun.spawn, a PATH
//   lookup replaces Bun.which, Node readable streams replace ReadableStream
//   readers. Exit codes for signal-killed children are 128 + signal number,
//   matching what Bun's `exited` resolved to.
// - validateOptions consults model-matrix.json: the parent/provider route must
//   be "runner", the (provider, model) pair must be a matrix family, the effort
//   must be selectable for it, and a model matching another family's
//   reportedModel pattern is a version pin that must be normalized first.
// Every contract of the original is kept: parent owns the route, no fallback,
// no implicit timeout, authentication preflight before execution, one Grok
// preflight retry, exclusive output and receipt reservations.

import { spawn, type ChildProcess } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { constants as osConstants } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import {
  routeFor,
  reportedModelMatches as familyReportMatches,
  type Family,
} from "../../../../scripts/model-matrix.ts";
import { invocationCommand, preflightCommand, type CommandSpec } from "./commands.ts";
import { parseProviderOutput, reportedModelMatches } from "./parse-output.ts";
import {
  cliFor,
  familyOf,
  MATRIX,
  UsageError,
  type Provider,
  type ReceiptStatus,
  type RunnerOptions,
  type RunnerReceipt,
} from "./types.ts";

const ERROR_EVIDENCE_LIMIT = 4_000;
const GROK_PREFLIGHT_RETRY_DELAY_MS = 5_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

interface ProcessResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly cancelledBy: CancellationSignal | null;
}

type CancellationSignal = "SIGINT" | "SIGTERM";

interface RunCancellation {
  readonly promise: Promise<CancellationSignal>;
  readonly signal: CancellationSignal | null;
  dispose(): void;
}

type RetryWaitResult = "ready" | "cancelled" | "timed-out";

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

function reserveOutputs(options: RunnerOptions): void {
  if (options.outputPath === options.receiptPath) {
    throw new UsageError("output and receipt paths must differ");
  }
  reserve(options.outputPath);
  try {
    reserve(options.receiptPath);
  } catch (error) {
    removeIfExists(options.outputPath);
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

const CODEX_IDENTITY = [
  "CODEX_THREAD_ID",
  "CODEX_SESSION_ID",
  "CODEX_CI",
  "CODEX_SHELL",
  "CODEX_SANDBOX",
  "CODEX_SANDBOX_NETWORK_DISABLED",
  "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
] as const;

const CLAUDE_IDENTITY = [
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS",
] as const;

export function childEnvironment(
  provider: Provider,
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const result = { ...source };
  const cli = cliFor(provider);
  const remove = cli === "claude"
    ? CODEX_IDENTITY
    : cli === "codex"
      ? CLAUDE_IDENTITY
      : [...CODEX_IDENTITY, ...CLAUDE_IDENTITY];
  for (const key of remove) delete result[key];
  return result;
}

/** Resolve a command on PATH the way Bun.which did: first executable regular file wins. */
export function findExecutable(
  command: string,
  path: string | undefined,
  cwd: string
): string | null {
  const candidates = command.includes("/")
    ? [isAbsolute(command) ? command : resolve(cwd, command)]
    : (path ?? "")
        .split(delimiter)
        .filter((entry) => entry.length > 0)
        .map((entry) => join(entry, command));
  for (const candidate of candidates) {
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

function exitCodeOf(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  const number = signal === null ? 0 : (osConstants.signals[signal] ?? 0);
  return 128 + number;
}

interface Spawned {
  readonly child: ChildProcess;
  readonly exited: Promise<number>;
}

function spawnChild(
  executable: string,
  spec: CommandSpec,
  cwd: string,
  env: NodeJS.ProcessEnv
): Spawned {
  const child = spawn(executable, [...spec.args], {
    cwd,
    env,
    stdio: [spec.stdin === "prompt" ? "pipe" : "ignore", "pipe", "pipe"],
  });
  const exited = new Promise<number>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit(exitCodeOf(code, signal)));
  });
  // A rejection is observed by whoever awaits `exited`; keep Node from
  // reporting it as unhandled when the race that would have observed it has
  // already settled.
  exited.catch(() => undefined);
  return { child, exited };
}

async function terminate(
  spawned: Spawned,
  signal: CancellationSignal = "SIGTERM"
): Promise<boolean> {
  const { child, exited } = spawned;
  if (child.pid === undefined) return false;
  if (child.exitCode !== null || child.signalCode !== null) return false;
  child.kill(signal);
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let done: boolean;
  try {
    done = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolveGrace) => {
        graceTimer = setTimeout(() => resolveGrace(false), 1_000);
      }),
    ]);
  } finally {
    if (graceTimer !== null) clearTimeout(graceTimer);
  }
  if (!done) {
    child.kill("SIGKILL");
    await exited;
  }
  return true;
}

interface StreamCapture {
  readonly result: Promise<string>;
  cancel(): Promise<void>;
}

function captureStream(stream: Readable | null): StreamCapture {
  if (stream === null) {
    return { result: Promise.resolve(""), async cancel() {} };
  }
  const decoder = new TextDecoder();
  let text = "";
  let finished = false;
  let cancellationRequested = false;

  const result = new Promise<string>((resolveText, rejectText) => {
    const finish = (): void => {
      if (finished) return;
      finished = true;
      text += decoder.decode();
      resolveText(text);
    };
    stream.on("data", (chunk: Buffer) => {
      text += decoder.decode(chunk, { stream: true });
    });
    stream.once("end", finish);
    stream.once("close", finish);
    stream.once("error", (error) => {
      if (cancellationRequested) {
        finish();
      } else if (!finished) {
        finished = true;
        rejectText(error);
      }
    });
  });

  return {
    result,
    async cancel() {
      cancellationRequested = true;
      stream.destroy();
      await result.catch(() => undefined);
    },
  };
}

type ProcessEvent =
  | { readonly kind: "exited"; readonly exitCode: number }
  | { readonly kind: "cancelled"; readonly signal: CancellationSignal }
  | { readonly kind: "timed-out" };

async function runProcess(
  executable: string,
  spec: CommandSpec,
  cwd: string,
  env: NodeJS.ProcessEnv,
  prompt: string,
  deadlineAt: number | null,
  cancellation: RunCancellation
): Promise<ProcessResult> {
  const spawned = spawnChild(executable, spec, cwd, env);
  const { child } = spawned;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  const stdoutCapture = captureStream(child.stdout);
  const stderrCapture = captureStream(child.stderr);
  const streams = Promise.all([stdoutCapture.result, stderrCapture.result]);
  const exited = spawned.exited.then((exitCode): ProcessEvent => ({
    kind: "exited",
    exitCode,
  }));
  const cancelled = cancellation.promise.then((signal): ProcessEvent => ({
    kind: "cancelled",
    signal,
  }));
  const deadline: Promise<ProcessEvent> | null = deadlineAt === null
    ? null
    : new Promise((resolveDeadline) => {
      const arm = (): void => {
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) {
          resolveDeadline({ kind: "timed-out" });
          return;
        }
        deadlineTimer = setTimeout(arm, Math.min(remaining, MAX_TIMER_DELAY_MS));
      };
      arm();
    });
  try {
    if (spec.stdin === "prompt") {
      const stdin = child.stdin;
      if (stdin === null) throw new Error("child stdin pipe was not created");
      // The child may exit before reading the prompt; a broken pipe is not a
      // launcher failure, the child's exit status is.
      stdin.on("error", () => undefined);
      stdin.end(prompt);
    }

    const completions = [exited, cancelled];
    if (deadline !== null) completions.push(deadline);
    const first = await Promise.race(completions);

    let outcome = first;
    let captured: readonly [string, string] | null = null;
    let signalSent: CancellationSignal | null = null;

    if (first.kind === "exited") {
      const drains: Array<Promise<
        | { readonly kind: "drained"; readonly captured: readonly [string, string] }
        | ProcessEvent
      >> = [
        streams.then((value) => ({ kind: "drained" as const, captured: value })),
        cancelled,
      ];
      if (deadline !== null) drains.push(deadline);
      const drain = await Promise.race(drains);
      if (drain.kind === "drained") {
        captured = drain.captured;
        if (deadlineAt !== null && Date.now() >= deadlineAt) {
          outcome = { kind: "timed-out" };
        }
      } else {
        outcome = drain;
      }
    }

    const cancelledBy = cancellation.signal;
    const timedOut = cancelledBy === null && outcome.kind === "timed-out";
    if (cancelledBy !== null) {
      if (await terminate(spawned, cancelledBy)) signalSent = cancelledBy;
    } else if (timedOut) {
      if (await terminate(spawned)) signalSent = "SIGTERM";
    }
    if (captured === null) {
      await Promise.all([stdoutCapture.cancel(), stderrCapture.cancel()]);
      captured = await streams;
    }

    return {
      exitCode: await spawned.exited,
      signal: signalSent,
      stdout: captured[0],
      stderr: captured[1],
      timedOut,
      cancelledBy,
    };
  } catch (error) {
    await terminate(spawned, cancellation.signal ?? "SIGTERM").catch(() => false);
    await Promise.all([stdoutCapture.cancel(), stderrCapture.cancel()]);
    await Promise.allSettled([stdoutCapture.result, stderrCapture.result]);
    throw error;
  } finally {
    if (deadlineTimer !== null) clearTimeout(deadlineTimer);
  }
}

async function waitForGrokPreflightRetry(
  deadlineAt: number | null,
  cancellation: RunCancellation
): Promise<RetryWaitResult> {
  if (cancellation.signal !== null) return "cancelled";

  const now = Date.now();
  if (deadlineAt !== null && now >= deadlineAt) return "timed-out";

  const retryAt = now + GROK_PREFLIGHT_RETRY_DELAY_MS;
  const wakeAt = deadlineAt === null ? retryAt : Math.min(retryAt, deadlineAt);
  const timerResult: RetryWaitResult = wakeAt < retryAt ? "timed-out" : "ready";
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const result = await Promise.race([
      cancellation.promise.then((): RetryWaitResult => "cancelled"),
      new Promise<RetryWaitResult>((resolveWait) => {
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
      return /logged in/i.test(combined) && combined.includes(model);
    default:
      return false;
  }
}

function successfulPreflightEvidence(provider: Provider, model: string): string {
  return cliFor(provider) === "grok"
    ? `authenticated; model ${model} available`
    : "authenticated";
}

function unavailableStatus(value: string): ReceiptStatus {
  if (/not logged in|unauthenticated|authentication|sign in|login required/i.test(value)) {
    return "unauthenticated";
  }
  if (/model.{0,40}(not found|unknown|unavailable|unsupported|not supported|invalid)|invalid.{0,20}model/i.test(value)) {
    return "unavailable-model";
  }
  return "child-failed";
}

function preflightFailureStatus(
  provider: Provider,
  model: string,
  value: string
): ReceiptStatus {
  const status = unavailableStatus(value);
  if (status !== "child-failed") return status;
  return cliFor(provider) === "grok" && !value.includes(model)
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

function modelProof(
  provider: Provider,
  requested: string,
  reported: string | null
): {
  readonly reportedModel: string | null;
  readonly modelVerified: boolean;
  readonly modelEvidence: "provider-report" | "pinned-argv" | null;
} {
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

function completeReceipt(
  options: RunnerOptions,
  partial: Omit<RunnerReceipt, "schemaVersion" | "parent" | "provider" | "model" | "effort" | "mode" | "cwd" | "promptPath" | "outputPath">
): RunnerReceipt {
  return {
    schemaVersion: 1,
    parent: options.parent,
    provider: options.provider,
    model: options.model,
    effort: options.effort,
    mode: options.mode,
    cwd: options.cwd,
    promptPath: options.promptPath,
    outputPath: options.outputPath,
    ...partial,
  };
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
  if (!(options.parent in MATRIX.parents)) {
    throw new UsageError(`parent ${options.parent} is not in model-matrix.json`);
  }
  if (cliFor(options.provider) === null) {
    throw new UsageError(`provider ${options.provider} is not in model-matrix.json`);
  }
  if (routeFor(MATRIX, options.parent, options.provider) === "native") {
    throw new UsageError(
      `provider ${options.provider} is native to parent ${options.parent}; use the parent subagent primitive`
    );
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

interface LaneProgress {
  executable: string | null;
  preflight: RunnerReceipt["preflight"];
  argv: readonly string[];
}

async function executeLane(
  options: RunnerOptions,
  cancellation: RunCancellation,
  started: number,
  deadlineAt: number | null,
  invocation: CommandSpec,
  preflight: CommandSpec,
  progress: LaneProgress
): Promise<RunResult> {
  const startedAt = new Date(started).toISOString();
  const prompt = readFileSync(options.promptPath, "utf8");
  const env = childEnvironment(options.provider);
  const executable = findExecutable(invocation.command, env.PATH, options.cwd);
  progress.executable = executable;
  progress.argv = [executable ?? invocation.command, ...invocation.args];

  let preflightState = progress.preflight;
  let receipt: RunnerReceipt;

  const finishWithoutChild = (
    status: "cancelled" | "timed-out",
    phase: string
  ): RunResult => {
    const completed = Date.now();
    const receivedSignal = status === "cancelled" ? cancellation.signal : null;
    const terminalPreflight = preflightState.status === "not-run"
      ? { ...preflightState, status }
      : preflightState;
    receipt = completeReceipt(options, {
      status,
      startedAt,
      completedAt: new Date(completed).toISOString(),
      elapsedMs: completed - started,
      executable,
      preflight: terminalPreflight,
      argv: [executable ?? invocation.command, ...invocation.args],
      exitCode: null,
      signal: null,
      reportedModel: null,
      modelVerified: false,
      modelEvidence: null,
      sessionId: null,
      usage: null,
      costUsd: null,
      error: {
        message: receivedSignal === null
          ? `explicit deadline elapsed ${phase}`
          : `launcher received ${receivedSignal} ${phase}`,
        evidence: "",
      },
    });
    removeIfExists(options.outputPath);
    writeReceipt(options.receiptPath, receipt);
    return { exitCode: statusExitCode(status), receipt };
  };

  if (cancellation.signal !== null) {
    return finishWithoutChild("cancelled", "before authentication preflight");
  }
  if (deadlineAt !== null && Date.now() >= deadlineAt) {
    return finishWithoutChild("timed-out", "before authentication preflight");
  }

  if (executable === null) {
    const completed = Date.now();
    receipt = completeReceipt(options, {
      status: "unavailable-cli",
      startedAt,
      completedAt: new Date(completed).toISOString(),
      elapsedMs: completed - started,
      executable: null,
      preflight: preflightState,
      argv: [invocation.command, ...invocation.args],
      exitCode: null,
      signal: null,
      reportedModel: null,
      modelVerified: false,
      modelEvidence: null,
      sessionId: null,
      usage: null,
      costUsd: null,
      error: {
        message: `${invocation.command} executable not found`,
        evidence: "",
      },
    });
    removeIfExists(options.outputPath);
    writeReceipt(options.receiptPath, receipt);
    return { exitCode: statusExitCode(receipt.status), receipt };
  }

  const preflightExecutable = executable;
  let preflightResult = await runProcess(
    preflightExecutable,
    preflight,
    options.cwd,
    env,
    "",
    deadlineAt,
    cancellation
  );
  let rawPreflightEvidence = evidence(`${preflightResult.stdout}\n${preflightResult.stderr}`);
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
    preflightState = {
      argv: [preflightExecutable, ...preflight.args],
      status: "failed",
      evidence: rawPreflightEvidence,
    };
    progress.preflight = preflightState;

    const retryWait = await waitForGrokPreflightRetry(deadlineAt, cancellation);
    if (retryWait !== "ready") {
      preflightState = {
        ...preflightState,
        status: retryWait === "cancelled" ? "cancelled" : "timed-out",
      };
      progress.preflight = preflightState;
      return finishWithoutChild(
        retryWait === "cancelled" ? "cancelled" : "timed-out",
        "during authentication preflight retry delay"
      );
    }

    const firstPreflightEvidence = rawPreflightEvidence;
    preflightResult = await runProcess(
      preflightExecutable,
      preflight,
      options.cwd,
      env,
      "",
      deadlineAt,
      cancellation
    );
    rawPreflightEvidence = evidence(`${preflightResult.stdout}\n${preflightResult.stderr}`);
    passed = preflightPassed(options.provider, options.model, preflightResult);
    preflightEvidence = retriedPreflightEvidence(
      firstPreflightEvidence,
      passed
        ? successfulPreflightEvidence(options.provider, options.model)
        : rawPreflightEvidence,
      passed
    );
  }

  preflightState = {
    argv: [preflightExecutable, ...preflight.args],
    status: preflightResult.cancelledBy !== null
      ? "cancelled"
      : preflightResult.timedOut
        ? "timed-out"
        : passed
          ? "passed"
          : "failed",
    evidence: preflightEvidence,
  };
  progress.preflight = preflightState;

  if (preflightState.status !== "passed") {
    const completed = Date.now();
    const preflightFailure = preflightFailureStatus(
      options.provider,
      options.model,
      rawPreflightEvidence
    );
    const status: ReceiptStatus = preflightResult.cancelledBy !== null
      ? "cancelled"
      : preflightResult.timedOut
        ? "timed-out"
        : preflightFailure;
    receipt = completeReceipt(options, {
      status,
      startedAt,
      completedAt: new Date(completed).toISOString(),
      elapsedMs: completed - started,
      executable,
      preflight: preflightState,
      argv: [executable, ...invocation.args],
      exitCode: preflightResult.exitCode,
      signal: preflightResult.signal,
      reportedModel: null,
      modelVerified: false,
      modelEvidence: null,
      sessionId: null,
      usage: null,
      costUsd: null,
      error: {
        message: preflightResult.cancelledBy !== null
          ? `launcher received ${preflightResult.cancelledBy} during preflight`
          : preflightResult.timedOut
            ? "authentication preflight timed out"
            : "authentication or model preflight failed",
        evidence: preflightEvidence,
      },
    });
    removeIfExists(options.outputPath);
    writeReceipt(options.receiptPath, receipt);
    return { exitCode: statusExitCode(status), receipt };
  }

  if (cancellation.signal !== null) {
    return finishWithoutChild("cancelled", "before model execution");
  }
  if (deadlineAt !== null && Date.now() >= deadlineAt) {
    return finishWithoutChild("timed-out", "before model execution");
  }

  const result = await runProcess(
    executable,
    invocation,
    options.cwd,
    env,
    prompt,
    deadlineAt,
    cancellation
  );
  const completed = Date.now();
  const base = {
    startedAt,
    completedAt: new Date(completed).toISOString(),
    elapsedMs: completed - started,
    executable,
    preflight: preflightState,
    argv: [executable, ...invocation.args],
    exitCode: result.exitCode,
    signal: result.signal,
  } as const;

  if (result.cancelledBy !== null || result.timedOut || result.exitCode !== 0) {
    const rawFailureEvidence = `${result.stderr}\n${result.stdout}`;
    const failureEvidence = evidence(rawFailureEvidence);
    const status: ReceiptStatus = result.cancelledBy !== null
      ? "cancelled"
      : result.timedOut
        ? "timed-out"
        : unavailableStatus(rawFailureEvidence);
    receipt = completeReceipt(options, {
      ...base,
      status,
      reportedModel: null,
      modelVerified: false,
      modelEvidence: null,
      sessionId: null,
      usage: null,
      costUsd: null,
      error: {
        message: result.cancelledBy !== null
          ? result.signal === result.cancelledBy
            ? `launcher received ${result.cancelledBy}; signal was sent to child`
            : `launcher received ${result.cancelledBy} after child exited`
          : result.timedOut
            ? `launcher exceeded the explicit ${options.timeoutMs}ms deadline`
            : `child exited with status ${result.exitCode}`,
        evidence: failureEvidence,
      },
    });
    removeIfExists(options.outputPath);
    writeReceipt(options.receiptPath, receipt);
    return { exitCode: statusExitCode(status), receipt };
  }

  try {
    const parsed = parseProviderOutput(
      options.provider,
      result.stdout,
      result.stderr,
      options.model
    );
    const proof = modelProof(
      options.provider,
      options.model,
      parsed.reportedModel
    );
    if (!proof.modelVerified && proof.modelEvidence !== "pinned-argv") {
      throw new Error(
        `requested model ${options.model} was not reported by ${options.provider}`
      );
    }
    writeFileSync(options.outputPath, parsed.text, { encoding: "utf8", mode: 0o600 });
    receipt = completeReceipt(options, {
      ...base,
      status: "complete",
      ...proof,
      sessionId: parsed.sessionId,
      usage: parsed.usage,
      costUsd: parsed.costUsd,
      error: null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    removeIfExists(options.outputPath);
    receipt = completeReceipt(options, {
      ...base,
      status: "malformed-output",
      reportedModel: null,
      modelVerified: false,
      modelEvidence: null,
      sessionId: null,
      usage: null,
      costUsd: null,
      error: {
        message,
        evidence: evidence(`${result.stderr}\n${result.stdout}`),
      },
    });
  }

  writeReceipt(options.receiptPath, receipt);
  return { exitCode: statusExitCode(receipt.status), receipt };
}

export async function runLane(
  options: RunnerOptions,
  started: number = Date.now()
): Promise<RunResult> {
  validateOptions(options);
  const deadlineAt = options.timeoutMs === null ? null : started + options.timeoutMs;
  const invocation = invocationCommand(options);
  const preflight = preflightCommand(options.provider);
  const progress: LaneProgress = {
    executable: null,
    preflight: {
      argv: [preflight.command, ...preflight.args],
      status: "not-run",
      evidence: "",
    },
    argv: [invocation.command, ...invocation.args],
  };
  const cancellation = installRunCancellation();
  try {
    reserveOutputs(options);
    try {
      return await executeLane(
        options,
        cancellation,
        started,
        deadlineAt,
        invocation,
        preflight,
        progress
      );
    } catch (error) {
      const completed = Date.now();
      const signal = cancellation.signal;
      const status: ReceiptStatus = signal !== null
        ? "cancelled"
        : deadlineAt !== null && completed >= deadlineAt
          ? "timed-out"
          : "child-failed";
      const message = error instanceof Error ? error.message : String(error);
      const terminalPreflight = progress.preflight.status === "not-run" && status !== "child-failed"
        ? { ...progress.preflight, status }
        : progress.preflight;
      const receipt = completeReceipt(options, {
        status,
        startedAt: new Date(started).toISOString(),
        completedAt: new Date(completed).toISOString(),
        elapsedMs: completed - started,
        executable: progress.executable,
        preflight: terminalPreflight,
        argv: progress.argv,
        exitCode: null,
        signal: null,
        reportedModel: null,
        modelVerified: false,
        modelEvidence: null,
        sessionId: null,
        usage: null,
        costUsd: null,
        error: {
          message: status === "cancelled"
            ? `launcher received ${signal} after reserving output paths`
            : status === "timed-out"
              ? "explicit deadline elapsed after reserving output paths"
              : "launcher failed after reserving output paths",
          evidence: evidence(message),
        },
      });
      removeIfExists(options.outputPath);
      writeReceipt(options.receiptPath, receipt);
      return { exitCode: statusExitCode(status), receipt };
    }
  } finally {
    cancellation.dispose();
  }
}

export function resolvedOptions(options: RunnerOptions): RunnerOptions {
  return {
    ...options,
    promptPath: resolve(options.promptPath),
    cwd: resolve(options.cwd),
    outputPath: resolve(options.outputPath),
    receiptPath: resolve(options.receiptPath),
  };
}
