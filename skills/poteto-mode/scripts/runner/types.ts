// Copied from open-pstack 1.4.1 (de67e6b) runner/types.ts. Change from the
// original: PARENTS, PROVIDERS, and EFFORTS are read from model-matrix.json
// through scripts/model-matrix.ts instead of being literal constants, so a
// family added to the matrix reaches the runner without a code change.

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
  readonly executable: string | null;
  readonly preflight: {
    readonly argv: readonly string[];
    readonly status: "passed" | "failed" | "timed-out" | "cancelled" | "not-run";
    readonly evidence: string;
  };
  readonly argv: readonly string[];
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly reportedModel: string | null;
  readonly modelVerified: boolean;
  readonly modelEvidence: "provider-report" | "pinned-argv" | null;
  readonly sessionId: string | null;
  readonly usage: NormalizedUsage | null;
  readonly costUsd: number | null;
  readonly error: {
    readonly message: string;
    readonly evidence: string;
  } | null;
}

export class UsageError extends Error {}
