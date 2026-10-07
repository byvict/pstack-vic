// Adapted from open-pstack verify-open-pstack/io.ts; provenance in NOTICE.md.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export function save(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  renameSync(temporary, path);
}

export function freshRoot(path: string, repository: string): string {
  if (!isAbsolute(path)) throw new Error("Output must be an absolute, new directory outside the repository");
  const absolute = resolve(path);
  const parent = realpathSync(dirname(absolute));
  const target = join(parent, basename(absolute));
  const relation = relative(realpathSync(repository), target);
  if (relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation))) throw new Error("Output must be outside the repository");
  mkdirSync(target, { mode: 0o700 }); // EEXIST preserves earlier attempts.
  return target;
}

export interface CommandResult {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly pid: number | null;
  readonly startedAt: string;
  readonly elapsedMs: number;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly status: "complete" | "failed" | "timed-out" | "cancelled";
  readonly stdout: string;
  readonly stderr: string;
  readonly receipt: string;
  readonly error?: string;
}

export interface CommandOptions {
  readonly cwd: string;
  readonly label: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: string;
  readonly timeoutMs?: number;
}

/** Every subprocess, including preparation, writes through owned file descriptors.
 * Parsing and exit-code policy belong to the recipe, after this receipt exists.
 * Only process groups created here may be killed. No host-wide process search.
 */
export class Journal {
  readonly root: string;
  readonly signal: AbortSignal;
  private sequence = 0;

  constructor(root: string, signal: AbortSignal = new AbortController().signal) {
    if (process.platform === "win32") throw new Error("Verifier supervision requires POSIX process groups");
    this.root = root;
    this.signal = signal;
    mkdirSync(join(root, "commands"), { mode: 0o700 });
  }

  async run(argv: readonly string[], options: CommandOptions): Promise<CommandResult> {
    if (this.signal.aborted) throw new Error("Verification cancelled before command launch");
    if (!argv.length || !/^[a-z0-9-]+$/.test(options.label)) throw new Error("Invalid command or label");
    if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 2_147_483_647)) throw new Error("Invalid command deadline");
    const directory = join(this.root, "commands", `${String(++this.sequence).padStart(4, "0")}-${options.label}`);
    mkdirSync(directory, { mode: 0o700 });
    const stdout = join(directory, "stdout"), stderr = join(directory, "stderr"), receipt = join(directory, "command.json");
    const started = Date.now();
    const identity = { argv, cwd: resolve(options.cwd), startedAt: new Date(started).toISOString(), stdout, stderr, receipt };
    save(receipt, { ...identity, status: "starting", pid: null, timeoutMs: options.timeoutMs ?? null });
    const descriptors: number[] = [];
    let pid: number | null = null;
    let exitCode: number | null = null, exitSignal: string | null = null, error: string | undefined;
    let stopped: "timed-out" | "cancelled" | undefined;
    let exited: Promise<void> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined, escalation: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals): void => {
      if (pid === null) return;
      try { process.kill(-pid, signal); }
      catch (failure) { if ((failure as NodeJS.ErrnoException).code !== "ESRCH") throw failure; }
    };
    const stop = (reason: "timed-out" | "cancelled"): void => {
      if (stopped !== undefined) return;
      stopped = reason;
      kill("SIGTERM");
      escalation = setTimeout(() => kill("SIGKILL"), 1_000);
    };
    const onAbort = (): void => stop("cancelled");
    try {
      const out = openSync(stdout, "wx", 0o600); descriptors.push(out);
      const err = openSync(stderr, "wx", 0o600); descriptors.push(err);
      let input: number | "ignore" = "ignore";
      if (options.input !== undefined) {
        const path = join(directory, "stdin");
        writeFileSync(path, options.input, { flag: "wx", mode: 0o600 });
        input = openSync(path, "r"); descriptors.push(input);
      }
      const child = spawn(argv[0], argv.slice(1), { cwd: options.cwd, env: options.env ?? process.env,
        detached: true, stdio: [input, out, err] });
      exited = new Promise<void>((resolveDone) => {
        child.once("error", (failure) => { error = failure.message; resolveDone(); });
        child.once("exit", (code, signal) => { exitCode = code; exitSignal = signal; resolveDone(); });
      });
      pid = child.pid ?? null;
      save(receipt, { ...identity, status: "running", pid, timeoutMs: options.timeoutMs ?? null });
      this.signal.addEventListener("abort", onAbort, { once: true });
      if (this.signal.aborted) onAbort();
      if (options.timeoutMs !== undefined) deadline = setTimeout(() => stop("timed-out"), Math.max(1, started + options.timeoutMs - Date.now()));
      await exited;
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    } finally {
      clearTimeout(deadline); clearTimeout(escalation);
      this.signal.removeEventListener("abort", onAbort);
      // A command cannot leave work behind after its terminal receipt.
      kill("SIGKILL");
      await exited;
      for (const descriptor of descriptors) closeSync(descriptor);
    }
    const result: CommandResult = { ...identity, pid, elapsedMs: Date.now() - started, exitCode, signal: exitSignal,
      status: stopped ?? (error === undefined && exitCode === 0 ? "complete" : "failed"), ...(error === undefined ? {} : { error }) };
    save(receipt, result);
    return result;
  }

  async text(argv: readonly string[], options: CommandOptions): Promise<string> {
    const result = await this.run(argv, options);
    if (result.status !== "complete") throw new Error(`${options.label}: ${result.status}; evidence: ${result.receipt}`);
    return readFileSync(result.stdout, "utf8");
  }
}
