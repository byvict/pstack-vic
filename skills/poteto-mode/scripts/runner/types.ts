import {
  loadMatrix,
  type Family,
  type ModelMatrix,
  type Transport,
} from "../../../../scripts/model-matrix.ts";

export const MATRIX: ModelMatrix = loadMatrix();
export const PARENTS: readonly string[] = Object.keys(MATRIX.parents);
export const PROVIDERS: readonly string[] = Object.keys(MATRIX.providers);
export const EFFORTS: readonly string[] = MATRIX.efforts;
export const ACCESS_MODES = ["read-only", "isolated-write", "unsandboxed"] as const;

export type Parent = string;
export type Provider = string;
export type Effort = string;
export type AccessMode = (typeof ACCESS_MODES)[number];

/**
 * How the runner reaches a provider: `cli` spawns providers.<name>.cli, `http`
 * calls the provider's agents API from http-lane.ts. An unknown provider
 * answers `cli` so it fails on the missing binary, where the message is right.
 */
export function transportFor(provider: Provider): Transport {
  return MATRIX.providers[provider]?.transport ?? "cli";
}

/** Providers the matrix reaches over http. Derived, never spelled out. */
export const HTTP_PROVIDERS: readonly string[] = PROVIDERS.filter(
  (provider) => transportFor(provider) === "http"
);

/**
 * The CLI binary the matrix assigns to a provider, or null for an unknown
 * provider or an http one. Only requireCli turns that null into an error.
 */
export function cliFor(provider: Provider): string | null {
  return MATRIX.providers[provider]?.cli ?? null;
}

/** The matrix family for a (provider, model) pair, or null when the pair is not a family. */
export function familyOf(provider: Provider, model: string): Family | null {
  return (
    MATRIX.families.find((f) => f.provider === provider && f.model === model) ??
    null
  );
}

/**
 * The pull request an http lane works on, parsed at the CLI boundary. The
 * runner never carries the raw `owner/name` text, and nothing above
 * http-lane.ts knows this becomes a github.com URL.
 */
export interface RepoTarget {
  readonly owner: string;
  readonly name: string;
  readonly pullNumber: number;
}

export interface LaneOptionsBase {
  readonly parent: Parent;
  readonly provider: Provider;
  readonly model: string;
  readonly effort: Effort;
  readonly mode: AccessMode;
  readonly promptPath: string;
  readonly cwd: string;
  readonly outputPath: string;
  readonly receiptPath: string;
  readonly timeoutMs: number | null;
}

export interface CliRunnerOptions extends LaneOptionsBase {
  readonly target: null;
}

export interface HttpRunnerOptions extends LaneOptionsBase {
  readonly target: RepoTarget;
}

/** A cli lane with a repo target is unrepresentable; so is an http lane without one. */
export type RunnerOptions = CliRunnerOptions | HttpRunnerOptions;

/**
 * The one place the --repo/--pr presence rule lives. parseArgs calls it to
 * build the union; validateOptions calls it again on an already-built value,
 * which covers a caller that reached runLane without the CLI.
 */
export function laneOptions(
  base: LaneOptionsBase,
  target: RepoTarget | null
): RunnerOptions {
  if (transportFor(base.provider) === "http") {
    if (target === null) {
      throw new UsageError(
        `--repo and --pr are required for ${base.provider} (http transport)`
      );
    }
    return { ...base, target };
  }
  if (target !== null) {
    throw new UsageError(
      `--repo and --pr are only accepted for: ${HTTP_PROVIDERS.join(", ")}`
    );
  }
  return { ...base, target: null };
}

export type ReceiptStatus =
  | "complete"
  | "cancelled"
  | "unavailable-cli"
  | "unauthenticated"
  | "unavailable-model"
  | "timed-out"
  | "child-failed"
  | "malformed-output";

export interface NormalizedUsage {
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly totalTokens?: number;
}

export interface ParsedOutput {
  readonly text: string;
  readonly reportedModel: string | null;
  readonly sessionId: string | null;
  readonly usage: NormalizedUsage | null;
  readonly costUsd: number | null;
}

export interface PreflightRecord {
  readonly argv: readonly string[];
  readonly status: "passed" | "failed" | "timed-out" | "cancelled" | "not-run";
  readonly evidence: string;
}

export interface ReceiptError {
  readonly message: string;
  readonly evidence: string;
}

export type HeadsEvidence =
  | { readonly kind: "not-taken" }
  | { readonly kind: "unverified"; readonly reason: string }
  | { readonly kind: "observed"; readonly changedBranches: readonly string[] };

/** The cloud run behind an http lane. Ids are null until launch answers. */
export interface RemoteRun {
  readonly agentId: string | null;
  readonly runId: string | null;
  readonly agentUrl: string | null;
  /** Repository head observations cannot attribute pushes to this run. */
  readonly heads: HeadsEvidence;
}

/**
 * The worktree an `unsandboxed` lane ran in, read through git at the root
 * resolved before the model child starts: HEAD before, HEAD after the child
 * exits, and `git status --porcelain --untracked-files=all` after. The runner
 * only records it; admission refuses a lane that moved HEAD or left changes.
 */
export interface Checkout {
  readonly headBefore: string;
  readonly headAfter: string;
  readonly statusAfter: readonly string[];
}

interface ReceiptBase {
  readonly schemaVersion: 1;
  readonly status: ReceiptStatus;
  readonly parent: Parent;
  readonly provider: Provider;
  readonly model: string;
  readonly effort: Effort;
  readonly mode: AccessMode;
  readonly cwd: string;
  readonly promptPath: string;
  readonly outputPath: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly elapsedMs: number;
  readonly preflight: PreflightRecord;
  readonly argv: readonly string[];
  readonly reportedModel: string | null;
  readonly modelVerified: boolean;
  readonly modelEvidence: "provider-report" | "pinned-argv" | null;
  readonly sessionId: string | null;
  readonly usage: NormalizedUsage | null;
  readonly costUsd: number | null;
  readonly error: ReceiptError | null;
  /** Null in every mode but `unsandboxed`, and there whenever the model child did not exit on its own or git could not read the worktree after it. */
  readonly checkout: Checkout | null;
}

export interface CliReceipt extends ReceiptBase {
  /** Resolved binary, or null when it was not on PATH. */
  readonly executable: string | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  /** A cli lane has no remote run. This null is the discriminant, not a placeholder. */
  readonly remote: null;
}

export interface HttpReceipt extends ReceiptBase {
  readonly executable: null;
  readonly exitCode: null;
  readonly signal: null;
  readonly remote: RemoteRun;
}

/**
 * schemaVersion stays 1: every existing field keeps its type and meaning, and
 * `remote` and `checkout` are additive and nullable. `remote !== null` is how a consumer with
 * no matrix tells the transports apart; there is no `transport` field because
 * `provider` already decides it.
 */
export type RunnerReceipt = CliReceipt | HttpReceipt;

export type CancellationSignal = "SIGINT" | "SIGTERM";

export interface RunCancellation {
  readonly promise: Promise<CancellationSignal>;
  readonly signal: CancellationSignal | null;
  /** Aborts when the latch fires; the fetch-shaped view of the same latch. */
  readonly abortSignal: AbortSignal;
  dispose(): void;
}

export type WaitOutcome = "ready" | "cancelled" | "timed-out";

/** The shared runtime a lane runs inside. The lane factory has already closed over its options. */
export interface LaneContext {
  readonly prompt: string;
  readonly deadlineAt: number | null;
  readonly cancellation: RunCancellation;
  /**
   * Sleep at most `delayMs`, waking early on the latch or the lane deadline,
   * re-checking both after the wake. `wait(0)` is the checkpoint before an
   * action: "ready" only when neither has fired.
   */
  wait(delayMs: number): Promise<WaitOutcome>;
}

/**
 * The transport-shaped half of a receipt. Mutable on purpose: the lane keeps it
 * current so the post-reservation catch in runLane can still write a truthful
 * receipt when the lane throws mid-way. finish() snapshots it.
 */
export type LaneEvidence = CliEvidence | HttpEvidence;

export interface CliEvidence {
  readonly kind: "cli";
  executable: string | null;
  preflight: PreflightRecord;
  argv: readonly string[];
  exitCode: number | null;
  signal: string | null;
  checkout: Checkout | null;
}

export interface HttpEvidence {
  readonly kind: "http";
  preflight: PreflightRecord;
  /** ["POST", "/v1/agents", <model id>, <effort>], plus the cancel request when the lane abandoned the run. Indices 0 to 3 are the pin. */
  argv: readonly string[];
  remote: RemoteRun;
}

/** Everything a lane can end as. Only finish() may mint "complete". */
export type LaneFailure = Exclude<ReceiptStatus, "complete">;

export type LaneOutcome =
  | { readonly kind: "produced"; readonly parsed: ParsedOutput }
  | { readonly kind: "failed"; readonly status: LaneFailure; readonly error: ReceiptError };

/** One transport, prepared before reservation, run after it. */
export interface Lane {
  readonly evidence: LaneEvidence;
  run(context: LaneContext): Promise<LaneOutcome>;
}

export class UsageError extends Error {}
