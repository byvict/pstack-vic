// One probe lane through the external runner, and its verdict. Shared by
// setup-pstack (the first time a parent uses a family) and update-clis (a new
// CLI version). The lane runs the launcher as a child process, exactly as a
// parent would, and the verdict reads only what the lane left behind: the
// receipt, the output file and, in write mode, probe.txt in its working
// directory.
//
// Node 24, type stripping, no dependencies: erasable TypeScript only.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AccessMode, RepoTarget } from "./types.ts";

export const RUNNER_LAUNCHER = join(import.meta.dirname, "pstack-runner");

/** What a lane must prove: the pair it ran, and the marker it echoed. */
export interface ProbeExpectation {
  readonly provider: string;
  readonly model: string;
  readonly effort: string;
  readonly marker: string;
}

/** A command the launcher runs under, e.g. `codex sandbox <flags> --`, started from `cwd`. */
export interface LaneWrapper {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

export interface ProbeLane extends ProbeExpectation {
  readonly parent: string;
  /** Read-only asks for the marker; isolated-write also asks the lane to run `ls` and create probe.txt in `cwd`. */
  readonly mode?: AccessMode;
  /** The launcher's --parent is simulated: drop the Claude Code identity a real Codex parent would not carry. */
  readonly simulatedParent?: boolean;
  readonly wrap?: LaneWrapper;
  /** Consecutive tokens the receipt argv must contain, e.g. ["--sandbox", "none"]. */
  readonly requireArgv?: readonly string[];
  /** Where to keep everything the lane printed (launcher and wrapper, stdout then stderr). */
  readonly transcriptPath?: string;
  readonly cwd: string;
  readonly promptPath: string;
  readonly outputPath: string;
  readonly receiptPath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutSeconds?: number | null;
  /** The pull request an http lane works on; never passed to a cli lane. */
  readonly target?: RepoTarget;
}

export interface LaneVerdict {
  readonly passed: boolean;
  readonly detail: string;
}

export function probePrompt(marker: string): string {
  return `This is a connectivity probe. Reply with exactly this token and nothing else: ${marker}\n`;
}

export const PROBE_FILE = "probe.txt";

export function writeProbePrompt(marker: string): string {
  return [
    "This is a write probe.",
    "First run `ls` in your working directory.",
    `Then create a file named ${PROBE_FILE} in your working directory whose entire content is this token: ${marker}`,
    "Finally reply with exactly the token and nothing else.",
    "",
  ].join("\n");
}

const CLAUDE_CODE_IDENTITY = /^(CLAUDECODE|CLAUDE_CODE_.*)$/;

function laneEnvironment(lane: ProbeLane): NodeJS.ProcessEnv {
  if (!lane.simulatedParent || lane.parent !== "codex") return lane.env;
  return Object.fromEntries(Object.entries(lane.env).filter(([key]) => !CLAUDE_CODE_IDENTITY.test(key)));
}

function containsRun(haystack: readonly string[], needle: readonly string[]): boolean {
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    if (needle.every((token, offset) => haystack[start + offset] === token)) return true;
  }
  return false;
}

interface RunnerReceiptLike {
  readonly status?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly mode?: string;
  readonly modelVerified?: boolean;
  readonly modelEvidence?: string | null;
  readonly reportedModel?: string | null;
  readonly argv?: readonly string[];
  readonly error?: { readonly message?: string } | null;
}

/**
 * Judge one probe from its receipt and output: the lane completed, ran the
 * requested pair at the requested effort, proved the model (provider report or
 * argv pin), and echoed the marker.
 */
export function judgeLane(expected: ProbeExpectation, receiptPath: string, outputPath: string): LaneVerdict {
  if (!existsSync(receiptPath)) return { passed: false, detail: "no receipt written" };
  let receipt: RunnerReceiptLike;
  try {
    receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as RunnerReceiptLike;
  } catch (error) {
    return { passed: false, detail: `receipt is not JSON: ${(error as Error).message}` };
  }
  if (receipt.status !== "complete") {
    const why = receipt.error?.message ? `: ${receipt.error.message}` : "";
    return { passed: false, detail: `receipt status ${receipt.status ?? "missing"}${why}` };
  }
  if (receipt.provider !== expected.provider || receipt.model !== expected.model || receipt.effort !== expected.effort) {
    return {
      passed: false,
      detail: `receipt ran ${receipt.provider}:${receipt.model}@${receipt.effort}, plan asked ${expected.provider}:${expected.model}@${expected.effort}`,
    };
  }
  if (receipt.modelVerified !== true && receipt.modelEvidence !== "pinned-argv") {
    return { passed: false, detail: `model not verified (evidence ${receipt.modelEvidence ?? "none"})` };
  }
  const output = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "";
  if (!output.includes(expected.marker)) {
    return { passed: false, detail: `output lacks the marker ${expected.marker}` };
  }
  const evidence = receipt.modelEvidence === "provider-report" ? `reported ${receipt.reportedModel}` : "pinned by argv";
  return { passed: true, detail: `complete, ${evidence}, marker echoed` };
}

/** judgeLane, then what the lane's mode and shape add: the receipt argv and, in write mode, probe.txt. */
export function judgeProbe(lane: ProbeLane): LaneVerdict {
  const base = judgeLane(lane, lane.receiptPath, lane.outputPath);
  if (!base.passed) return base;
  const details = [base.detail];
  if (lane.requireArgv !== undefined) {
    const argv = (JSON.parse(readFileSync(lane.receiptPath, "utf8")) as RunnerReceiptLike).argv ?? [];
    const wanted = lane.requireArgv.join(" ");
    if (!containsRun(argv, lane.requireArgv)) return { passed: false, detail: `receipt argv lacks "${wanted}": ${argv.join(" ")}` };
    details.push(`argv has ${wanted}`);
  }
  if (lane.mode === "isolated-write") {
    const file = join(lane.cwd, PROBE_FILE);
    if (!existsSync(file)) return { passed: false, detail: `${PROBE_FILE} is missing from ${lane.cwd}` };
    const content = readFileSync(file, "utf8").trim();
    if (content !== lane.marker) {
      return { passed: false, detail: `${PROBE_FILE} holds ${JSON.stringify(content.slice(0, 200))}, expected ${lane.marker}` };
    }
    details.push(`${PROBE_FILE} written`);
  }
  return { passed: true, detail: details.join(", ") };
}

/** Write the probe prompt, run the launcher (under the wrapper, if any), and judge the lane when it exits. */
export function runProbeLane(lane: ProbeLane): Promise<LaneVerdict> {
  const mode = lane.mode ?? "read-only";
  writeFileSync(lane.promptPath, mode === "read-only" ? probePrompt(lane.marker) : writeProbePrompt(lane.marker), { mode: 0o600 });
  const args = [
    RUNNER_LAUNCHER,
    "--parent", lane.parent,
    "--provider", lane.provider,
    "--model", lane.model,
    "--effort", lane.effort,
    "--mode", mode,
    "--prompt", lane.promptPath,
    "--cwd", lane.cwd,
    "--output", lane.outputPath,
    "--receipt", lane.receiptPath,
  ];
  if (lane.timeoutSeconds) args.push("--timeout", String(lane.timeoutSeconds));
  if (lane.target !== undefined) {
    args.push("--repo", `${lane.target.owner}/${lane.target.name}`, "--pr", String(lane.target.pullNumber));
  }
  const [command, argv] = lane.wrap === undefined
    ? [process.execPath, args]
    : [lane.wrap.command, [...lane.wrap.args, process.execPath, ...args]];
  return new Promise((resolve) => {
    const child = spawn(command, argv, {
      cwd: lane.wrap?.cwd,
      env: laneEnvironment(lane),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    if (lane.transcriptPath === undefined) child.stdout?.resume();
    else child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on("error", (error) => {
      resolve({ passed: false, detail: `could not launch the runner: ${error.message}` });
    });
    child.on("close", () => {
      if (lane.transcriptPath !== undefined) writeFileSync(lane.transcriptPath, `${stdout}${stderr}`, { mode: 0o600 });
      const verdict = judgeProbe(lane);
      const detail = verdict.passed || stderr.trim().length === 0 ? verdict.detail : `${verdict.detail}\n${stderr.trim().slice(0, 2_000)}`;
      resolve({ passed: verdict.passed, detail });
    });
  });
}
