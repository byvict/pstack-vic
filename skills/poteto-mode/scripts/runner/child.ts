import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants as fsConstants, mkdtempSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import type { CommandSpec, ConfigOverlay } from "./commands.ts";
import { cliFor, type CancellationSignal, type CliEvidence, type Provider, type RunCancellation, type LaneContext, type ModelStreams } from "./types.ts";

const MAX_TIMER_DELAY_MS = 2_147_483_647;
export interface ProcessResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly cancelledBy: CancellationSignal | null;
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

interface StagedOverlay {
  readonly env: NodeJS.ProcessEnv;
  readonly directory: string;
}

export function stageOverlay(env: NodeJS.ProcessEnv, overlay: ConfigOverlay): StagedOverlay {
  const directory = mkdtempSync(join(tmpdir(), "pstack-runner-"));
  const file = join(directory, overlay.fileName);
  try {
    writeFileSync(file, overlay.content, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  const staged: NodeJS.ProcessEnv = { ...env, [overlay.variable]: file };
  for (const key of overlay.unset) delete staged[key];
  return { env: staged, directory };
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
    stdio: [spec.stdin === "none" ? "ignore" : "pipe", "pipe", "pipe"],
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

function captureStream(stream: Readable | null, descriptor?: number): StreamCapture {
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
      if (stream.destroyed) return;
      if (descriptor !== undefined) {
        try {
          let offset = 0;
          while (offset < chunk.byteLength) {
            offset += writeSync(descriptor, chunk, offset, chunk.byteLength - offset);
          }
        } catch (error) {
          stream.destroy(error instanceof Error ? error : new Error(String(error)));
          return;
        }
      }
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

export interface InteractiveIo {
  readonly stdout: Readable;
  write(value: string): Promise<void>;
}

type InteractiveOutcome<T> =
  | { readonly kind: "returned"; readonly value: T }
  | { readonly kind: "failed"; readonly error: unknown };

export interface InteractiveResult<T> extends ProcessResult {
  readonly outcome: InteractiveOutcome<T>;
}

type ChildOperation<T> =
  | { readonly kind: "one-shot"; readonly prompt: string }
  | { readonly kind: "interactive"; readonly body: (io: InteractiveIo) => Promise<T> };

async function withChild<T>(args: {
  readonly executable: string;
  readonly spec: CommandSpec;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly deadlineAt: number | null;
  readonly cancellation: RunCancellation;
  readonly operation: ChildOperation<T>;
  readonly streamFiles?: ModelStreams;
  readonly evidence?: CliEvidence;
}): Promise<InteractiveResult<T>> {
  const { deadlineAt, cancellation } = args;
  if (args.evidence !== undefined) { args.evidence.exitCode = null; args.evidence.signal = null; }
  const spawned = spawnChild(args.executable, args.spec, args.cwd, args.env);
  const { child } = spawned;
  const stdoutCapture = captureStream(child.stdout, args.streamFiles?.stdout);
  const stderrCapture = captureStream(child.stderr, args.streamFiles?.stderr);
  const streams = Promise.all([stdoutCapture.result, stderrCapture.result]);
  streams.catch(() => undefined);
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let bodyResult: Promise<InteractiveOutcome<T>> | null = null;
  const exited = spawned.exited.then((exitCode): ProcessEvent => ({ kind: "exited", exitCode }));
  const cancelled = cancellation.promise.then((signal): ProcessEvent => ({ kind: "cancelled", signal }));
  const deadline: Promise<ProcessEvent> | null = deadlineAt === null ? null : new Promise((resolveDeadline) => {
    const arm = (): void => {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) resolveDeadline({ kind: "timed-out" });
      else deadlineTimer = setTimeout(arm, Math.min(remaining, MAX_TIMER_DELAY_MS));
    };
    arm();
  });
  const stopped = [cancelled, ...(deadline === null ? [] : [deadline])];
  let signalSent: CancellationSignal | null = null;
  let outcome: InteractiveOutcome<T> = { kind: "failed", error: new Error("ACP child did not complete") };
  let captured: readonly [string, string] | null = null;
  let timedOut = false;
  try {
    if (args.operation.kind === "interactive") {
      const stdin = child.stdin;
      const stdout = child.stdout;
      if (stdin === null || stdout === null) throw new Error("interactive child pipes were not created");
      stdin.on("error", () => undefined);
      bodyResult = args.operation.body({
        stdout,
        write: (value) => new Promise<void>((resolveWrite, rejectWrite) => {
          stdin.write(value, (error) => error ? rejectWrite(error) : resolveWrite());
        }),
      }).then(
        (value): InteractiveOutcome<T> => ({ kind: "returned", value }),
        (error: unknown): InteractiveOutcome<T> => ({ kind: "failed", error }),
      );
    } else if (args.spec.stdin === "prompt") {
      const stdin = child.stdin;
      if (stdin === null) throw new Error("child stdin pipe was not created");
      stdin.on("error", () => undefined);
      stdin.end(args.operation.prompt);
    }
    const first = await Promise.race([exited, streams.then(() => exited), ...stopped, ...(bodyResult === null ? [] : [bodyResult])]);
    timedOut = first.kind === "timed-out";
    if (first.kind === "returned" || first.kind === "failed") {
      outcome = first;
      child.stdin?.end();
      if (first.kind === "returned") {
        let graceTimer: ReturnType<typeof setTimeout> | null = null;
        try {
          const grace = await Promise.race([exited, ...stopped, new Promise<{ readonly kind: "grace" }>((resolveGrace) => {
            graceTimer = setTimeout(() => resolveGrace({ kind: "grace" }), 1_000);
          })]);
          timedOut = grace.kind === "timed-out";
        } finally { if (graceTimer !== null) clearTimeout(graceTimer); }
      }
    } else if (first.kind === "exited") {
      if (args.operation.kind === "interactive") {
        outcome = { kind: "failed", error: new Error(`ACP server exited before completion with status ${first.exitCode}`) };
      } else {
        const drain = await Promise.race([
          streams.then((value) => ({ kind: "drained" as const, captured: value })), ...stopped,
        ]);
        if (drain.kind === "drained") captured = drain.captured;
        else timedOut = drain.kind === "timed-out";
      }
    }
    const cancelledBy = cancellation.signal;
    timedOut = cancelledBy === null && (timedOut || (deadlineAt !== null && Date.now() >= deadlineAt));
    const shouldTerminate = args.operation.kind === "interactive" || cancelledBy !== null || timedOut;
    if (shouldTerminate && await terminate(spawned, cancelledBy ?? "SIGTERM")) signalSent = cancelledBy ?? "SIGTERM";
    if (captured === null) {
      await Promise.all([stdoutCapture.cancel(), stderrCapture.cancel()]);
      captured = await streams;
    }
    if (bodyResult !== null) await bodyResult;
    return {
      outcome, exitCode: await spawned.exited, signal: signalSent, stdout: captured[0], stderr: captured[1],
      timedOut: cancellation.signal === null && (timedOut || (deadlineAt !== null && Date.now() >= deadlineAt)),
      cancelledBy: cancellation.signal,
    };
  } catch (error) {
    const signal = cancellation.signal ?? "SIGTERM";
    if (await terminate(spawned, signal).catch(() => false)) signalSent = signal;
    await Promise.all([stdoutCapture.cancel(), stderrCapture.cancel()]);
    await Promise.allSettled([stdoutCapture.result, stderrCapture.result]);
    if (bodyResult !== null) await bodyResult;
    if (args.evidence !== undefined) {
      args.evidence.exitCode = await spawned.exited.catch(() => null);
      args.evidence.signal = signalSent;
    }
    throw error;
  } finally { if (deadlineTimer !== null) clearTimeout(deadlineTimer); }
}

export function runProcess(
  executable: string, spec: CommandSpec, cwd: string, env: NodeJS.ProcessEnv,
  prompt: string, deadlineAt: number | null, cancellation: RunCancellation,
  evidence?: CliEvidence,
  streamFiles?: ModelStreams,
): Promise<ProcessResult> {
  return withChild({ executable, spec, cwd, env, deadlineAt, cancellation, evidence, streamFiles, operation: { kind: "one-shot", prompt } });
}

export function runInteractiveChild<T>(args: {
  readonly executable: string;
  readonly spec: CommandSpec;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly context: LaneContext;
  readonly body: (io: InteractiveIo) => Promise<T>;
  readonly evidence?: CliEvidence;
}): Promise<InteractiveResult<T>> {
  return withChild({ ...args, deadlineAt: args.context.deadlineAt, cancellation: args.context.cancellation,
    operation: { kind: "interactive", body: args.body } });
}
