import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { array, hash, integer, object, string } from '../contract.ts';
import { originalOf, type Original } from './plant.ts';

export type Tokens = Readonly<{ input: bigint; cacheRead: bigint; cacheWrite: bigint; output: bigint }>;
export type Usage = Readonly<{
  originalReceipt: Original;
  remoteRun: Readonly<{ agentId: string; runId: string }>;
  rawResponse: Original;
  requestedAt: string;
  receivedAt: string;
  model: string;
  tokens: Tokens;
  apiMoney: Readonly<{ rawCostCents: string; chargedCents: string }>;
}>;
export type CostResult =
  | Readonly<{ kind: 'known'; equivalentNanoUSD: bigint; sources: readonly Usage[] }>
  | Readonly<{ kind: 'unavailable'; reason: string; originalEvidence: readonly Original[] }>;
export type CostSummary = Readonly<{
  perFullPass: readonly Readonly<{ passId: string; cost: CostResult }>[];
  requiredLanesOneToNine: CostResult;
  allCatalogIncludingHumanUpdate: CostResult;
  historicalRoles: CostResult;
  organicEvaluation: CostResult;
}>;
export type PoolPermit = Readonly<{
  observation: Original;
  observedAt: string;
  expiresAt: string;
}>;
export type PoolDecision =
  | Readonly<{ kind: 'permit'; permit: PoolPermit }>
  | Readonly<{ kind: 'denied'; reason: string; observation: Original }>;

const AUDIT_MS = 30 * 60 * 1000;
const STOP_THRESHOLD_PERCENT = 80;
const FULL_PASS_LIMIT_NANO = 500_000_000n;
const PRICE: Readonly<Record<string, Readonly<{ input: bigint; cacheRead: bigint; output: bigint }>>> = {
  'composer-2.5': { input: 500n, cacheRead: 200n, output: 2500n },
  'grok-4.6': { input: 2000n, cacheRead: 500n, output: 6000n },
  'grok-4.7': { input: 2000n, cacheRead: 500n, output: 6000n },
};

export const USAGE_HOST = 'https://api.cursor.com';

function nat(value: unknown, label: string): bigint {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${label}`);
  return BigInt(value);
}

function money(value: unknown, label: string): string {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return String(value);
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return value;
  throw new Error(`Invalid ${label}`);
}

export function parseUsageResponse(value: unknown, runId: string): { tokens: Tokens; apiMoney: Readonly<{ rawCostCents: string; chargedCents: string }> } {
  const v = object(value, 'usage response');
  const run = array(v.runs).map(item => object(item, 'usage run')).find(item => item.id === runId);
  if (!run) throw new Error('Exact run usage is missing');
  const usage = object(run.usage, 'run usage');
  const cost = object(run.cost, 'run cost');
  return {
    tokens: {
      input: nat(usage.inputTokens, 'inputTokens'),
      cacheRead: nat(usage.cacheReadTokens, 'cacheReadTokens'),
      cacheWrite: nat(usage.cacheWriteTokens, 'cacheWriteTokens'),
      output: nat(usage.outputTokens, 'outputTokens'),
    },
    apiMoney: { rawCostCents: money(cost.rawCostCents, 'rawCostCents'), chargedCents: money(cost.chargedCents, 'chargedCents') },
  };
}

export function priceUsage(usage: Usage): CostResult {
  const table = PRICE[usage.model];
  if (!table) return { kind: 'unavailable', reason: `No equivalent-pool price for ${usage.model}`, originalEvidence: [usage.originalReceipt, usage.rawResponse] };
  if (usage.tokens.cacheWrite !== 0n) {
    return { kind: 'unavailable', reason: 'Nonzero cache-write tokens have no authoritative mapping', originalEvidence: [usage.originalReceipt, usage.rawResponse] };
  }
  const equivalentNanoUSD = usage.tokens.input * table.input + usage.tokens.cacheRead * table.cacheRead + usage.tokens.output * table.output;
  return { kind: 'known', equivalentNanoUSD, sources: [usage] };
}

export function combineCosts(results: readonly CostResult[]): CostResult {
  const sources: Usage[] = [];
  const seen = new Set<string>();
  let total = 0n;
  for (const result of results) {
    if (result.kind === 'unavailable') return result;
    for (const usage of result.sources) {
      const id = usage.remoteRun.agentId + '/' + usage.remoteRun.runId;
      if (seen.has(id)) continue;
      seen.add(id);
      sources.push(usage);
      const priced = priceUsage(usage);
      if (priced.kind === 'unavailable') return priced;
      total += priced.equivalentNanoUSD;
    }
  }
  return { kind: 'known', equivalentNanoUSD: total, sources };
}

export function formatUsd(nano: bigint): string {
  const whole = nano / 1_000_000_000n;
  const frac = (nano % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '') || '0';
  return `${whole}.${frac}`;
}

export function fullPassUnderLimit(cost: CostResult): boolean {
  return cost.kind === 'known' && cost.equivalentNanoUSD < FULL_PASS_LIMIT_NANO;
}

export function parsePoolObservation(value: unknown, file: Original, now: Date): PoolDecision {
  const v = object(value, 'pool observation');
  const observedAt = Date.parse(string(v.at));
  if (!Number.isFinite(observedAt)) return { kind: 'denied', reason: 'Pool observation time is invalid', observation: file };
  if (observedAt > now.getTime()) return { kind: 'denied', reason: 'Pool observation is from the future', observation: file };
  const expiresAt = new Date(observedAt + AUDIT_MS).toISOString();
  if (now.getTime() >= observedAt + AUDIT_MS) return { kind: 'denied', reason: 'Pool observation expired; request a fresh audit', observation: file };
  const stop = integer(v.stopThresholdPercent);
  if (stop !== STOP_THRESHOLD_PERCENT) return { kind: 'denied', reason: 'Pool stop threshold must be exactly 80 percent', observation: file };
  const percents = [v.cursorModelsUsedPercent, v.otherModelsUsedPercent, v.grokBotWeeklyUsedPercent].map(item => integer(item));
  if (percents.some(percent => percent < 0 || percent > 100)) {
    return { kind: 'denied', reason: 'Pool percentages must be between 0 and 100', observation: file };
  }
  if (percents.some(percent => percent >= stop)) {
    return { kind: 'denied', reason: 'Observed pool is at or above the stop threshold', observation: file };
  }
  return { kind: 'permit', permit: { observation: file, observedAt: new Date(observedAt).toISOString(), expiresAt } };
}

export function admitLaunch(observationPath: string, now: Date): PoolDecision {
  const file = originalOf(observationPath);
  return parsePoolObservation(JSON.parse(readFileSync(observationPath, 'utf8')), file, now);
}

export type UsageFetch = (url: string) => Promise<unknown>;

type RawUsageReply = Readonly<{ kind: 'raw-http-response'; httpStatus: number; rawBodyBase64: string }>;

function rawUsageReply(value: unknown): RawUsageReply | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind !== 'raw-http-response' || typeof candidate.httpStatus !== 'number'
    || !Number.isInteger(candidate.httpStatus) || typeof candidate.rawBodyBase64 !== 'string') return null;
  const bytes = Buffer.from(candidate.rawBodyBase64, 'base64');
  if (bytes.toString('base64') !== candidate.rawBodyBase64) return null;
  return { kind: 'raw-http-response', httpStatus: candidate.httpStatus, rawBodyBase64: candidate.rawBodyBase64 };
}

function parseSavedResponse(saved: Record<string, unknown>): { httpStatus: number; response: unknown } {
  const httpStatus = integer(saved.httpStatus);
  const encoded = string(saved.rawBodyBase64);
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) throw new Error('Saved usage response bytes are malformed');
  if (httpStatus < 200 || httpStatus >= 300) throw new Error(`Usage API returned HTTP ${httpStatus}`);
  return { httpStatus, response: JSON.parse(bytes.toString('utf8')) };
}

function receiptRemote(receipt: unknown): { agentId: string; runId: string; model: string } | null {
  const v = object(receipt, 'receipt');
  if (v.remote === null || v.remote === undefined) return null;
  const remote = object(v.remote, 'receipt remote');
  if (remote.agentId === null && remote.runId === null) return null;
  const agentId = string(remote.agentId);
  const runId = string(remote.runId);
  if (!/^[A-Za-z0-9_-]+$/.test(agentId) || !/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error('Invalid Cursor run identity');
  return { agentId, runId, model: string(v.model) };
}

export async function recordUsage(options: {
  receiptPath: string;
  evidenceDirectory: string;
  now?: () => Date;
  fetchUsage?: UsageFetch;
}): Promise<Usage | Readonly<{ kind: 'unavailable'; reason: string; evidence: Original }>> {
  const originalReceipt = originalOf(options.receiptPath);
  const receipt = JSON.parse(readFileSync(options.receiptPath, 'utf8'));
  if (hash(readFileSync(options.receiptPath)) !== originalReceipt.sha256) throw new Error('Receipt changed while recording usage');
  const remote = receiptRemote(receipt);
  if (!remote) return { kind: 'unavailable', reason: 'Receipt has no remote run', evidence: originalReceipt };
  const url = `${USAGE_HOST}/v1/agents/${remote.agentId}/usage?runId=${remote.runId}`;
  const directory = resolve(options.evidenceDirectory);
  const rawPath = join(directory, `${remote.runId}.usage.json`);
  if (existsSync(rawPath)) {
    const bytes = readFileSync(rawPath);
    const saved = object(JSON.parse(bytes.toString('utf8')), 'saved usage response');
    if (saved.schemaVersion !== 2 || string(saved.sourceUrl) !== url || string(saved.agentId) !== remote.agentId
      || string(saved.runId) !== remote.runId || JSON.stringify(saved.originalReceipt) !== JSON.stringify(originalReceipt)) {
      throw new Error('Existing usage evidence conflicts with this receipt');
    }
    let parsed: ReturnType<typeof parseUsageResponse>;
    try { parsed = parseUsageResponse(parseSavedResponse(saved).response, remote.runId); }
    catch (error) {
      const reason = error instanceof Error ? error.message : 'Usage response malformed';
      return { kind: 'unavailable', reason, evidence: originalOf(rawPath, bytes) };
    }
    return {
      originalReceipt,
      remoteRun: { agentId: remote.agentId, runId: remote.runId },
      rawResponse: originalOf(rawPath, bytes),
      requestedAt: string(saved.requestedAt),
      receivedAt: string(saved.receivedAt),
      model: remote.model,
      tokens: parsed.tokens,
      apiMoney: parsed.apiMoney,
    };
  }
  const requestedAt = (options.now ?? (() => new Date()))().toISOString();
  const fetchUsage = options.fetchUsage ?? (async (target: string) => {
    const key = process.env.CURSOR_API_KEY;
    if (!key) throw new Error('Cursor credential unavailable');
    const response = await fetch(target, {
      headers: { Authorization: 'Basic ' + Buffer.from(key + ':').toString('base64') },
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
    });
    return {
      kind: 'raw-http-response', httpStatus: response.status,
      rawBodyBase64: Buffer.from(await response.arrayBuffer()).toString('base64'),
    } satisfies RawUsageReply;
  });
  let raw: unknown;
  try { raw = await fetchUsage(url); }
  catch (error) {
    const reason = error instanceof Error ? error.message : 'Usage fetch failed';
    return { kind: 'unavailable', reason, evidence: originalReceipt };
  }
  const receivedAt = (options.now ?? (() => new Date()))().toISOString();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const reply = rawUsageReply(raw) ?? {
    kind: 'raw-http-response' as const, httpStatus: 200,
    rawBodyBase64: Buffer.from(JSON.stringify(raw)).toString('base64'),
  };
  const payload = {
    schemaVersion: 2,
    sourceUrl: url,
    requestedAt,
    receivedAt,
    agentId: remote.agentId,
    runId: remote.runId,
    originalReceipt,
    httpStatus: reply.httpStatus,
    rawBodyBase64: reply.rawBodyBase64,
  };
  const text = JSON.stringify(payload, null, 2) + '\n';
  writeFileSync(rawPath, text, { flag: 'wx', mode: 0o600 });
  const rawResponse = originalOf(rawPath, text);
  let parsed: ReturnType<typeof parseUsageResponse>;
  try { parsed = parseUsageResponse(parseSavedResponse(payload).response, remote.runId); }
  catch (error) {
    const reason = error instanceof Error ? error.message : 'Usage response malformed';
    return { kind: 'unavailable', reason, evidence: rawResponse };
  }
  return {
    originalReceipt,
    remoteRun: { agentId: remote.agentId, runId: remote.runId },
    rawResponse,
    requestedAt,
    receivedAt,
    model: remote.model,
    tokens: parsed.tokens,
    apiMoney: parsed.apiMoney,
  };
}

export function summarizeCost(input: {
  perFullPass: readonly Readonly<{ passId: string; cost: CostResult }>[];
  requiredLanesOneToNine: CostResult;
  allCatalogIncludingHumanUpdate: CostResult;
  historicalRoles: CostResult;
  organicEvaluation: CostResult;
}): CostSummary {
  return input;
}
