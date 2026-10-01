import {
  loadMatrix,
  type Family,
  type ModelMatrix,
} from "../../../../scripts/model-matrix.ts";

export const MATRIX: ModelMatrix = loadMatrix();
export const PARENTS: readonly string[] = Object.keys(MATRIX.parents);
export const PROVIDERS: readonly string[] = Object.keys(MATRIX.providers);
export const EFFORTS: readonly string[] = MATRIX.efforts;
export const ACCESS_MODES = ["read-only", "isolated-write"] as const;

export type Parent = string;
export type Provider = string;
export type Effort = string;
export type AccessMode = (typeof ACCESS_MODES)[number];

/** The CLI binary the matrix assigns to a provider, or null for an unknown provider. */
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

export interface RunnerOptions {
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

export interface RunnerReceipt {
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
  /** Resolved binary, or null when it was not on PATH. */
  readonly executable: string | null;
  readonly preflight: PreflightRecord;
  readonly argv: readonly string[];
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly reportedModel: string | null;
  readonly modelVerified: boolean;
  readonly modelEvidence: "provider-report" | "pinned-argv" | null;
  readonly sessionId: string | null;
  readonly usage: NormalizedUsage | null;
  readonly costUsd: number | null;
  readonly error: ReceiptError | null;
}

export type CancellationSignal = "SIGINT" | "SIGTERM";

export interface RunCancellation {
  readonly promise: Promise<CancellationSignal>;
  readonly signal: CancellationSignal | null;
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
 * The half of a receipt the lane fills in as it runs. Mutable on purpose: the
 * lane keeps it current so the post-reservation catch in runLane can still
 * write a truthful receipt when the lane throws mid-way. finish() snapshots it.
 */
export interface CliEvidence {
  executable: string | null;
  preflight: PreflightRecord;
  argv: readonly string[];
  exitCode: number | null;
  signal: string | null;
}

/** Everything a lane can end as. Only finish() may mint "complete". */
export type LaneFailure = Exclude<ReceiptStatus, "complete">;

export type LaneOutcome =
  | { readonly kind: "produced"; readonly parsed: ParsedOutput }
  | { readonly kind: "failed"; readonly status: LaneFailure; readonly error: ReceiptError };

/** One lane, prepared before reservation, run after it. */
export interface Lane {
  readonly evidence: CliEvidence;
  run(context: LaneContext): Promise<LaneOutcome>;
}

export class UsageError extends Error {}
