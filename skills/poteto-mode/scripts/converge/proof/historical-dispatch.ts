import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { array, digest, hash, integer, object, oneOf, repoName, sha, string } from '../contract.ts';
import { command as defaultCommand, type Command } from '../github.ts';
import { loadMatrix, resolveDescriptor } from '../../../../../scripts/model-matrix.ts';
import { runLane, resolvedOptions, type RunResult } from '../../runner/run.ts';
import { laneOptions, type Parent, type RunnerOptions } from '../../runner/types.ts';
import { originalOf, type Original } from './plant.ts';
import {
  collectRemoteEvidence, resolveCursorEndpoint, type CollectedRemote, type CursorEndpoint,
} from './historical-cursor.ts';

export type Role = 'pr verifier' | 'pr reviewer';
export type HistoricalIdentity = Readonly<{
  recordIndex: number; repo: string; head: string; base: string; carrierHead: string;
}>;

export type HistoricalHost = Readonly<{
  now?: () => Date;
  command?: Command;
  runLane?: (options: RunnerOptions) => Promise<RunResult>;
  fetch?: typeof fetch;
  endpoint?: CursorEndpoint;
}>;

export type CarrierIdentity = Readonly<{
  repo: string;
  workRoot: string;
  carrierPr: number;
  carrierHead: string;
}>;

export type DispatchSpec = Readonly<{
  parent: Parent;
  role: Role;
  descriptor: string;
  identity: HistoricalIdentity;
  opaqueId: string;
  directory: string;
  carrierPr: number;
  cwd: string;
  prompt: string;
}>;

export type LaunchedHandle = Readonly<{ agentId: string; runId: string }>;

export type HistoricalIntent = Readonly<{
  recordIndex: number;
  role: Role;
  descriptor: string;
  parent: string;
  repo: string;
  carrierPr: number;
  carrierHead: string;
  head: string;
  base: string;
  opaqueId: string;
  cwd: string;
  promptPath: string;
  outputPath: string;
  receiptPath: string;
  promptDigest: string;
  createdAt: string;
}>;

export type ReceiptRecovery =
  | Readonly<{ kind: 'launched'; handle: LaunchedHandle; receipt: Original }>
  | Readonly<{ kind: 'definite-no-launch'; receipt: Original }>
  | Readonly<{ kind: 'unknown'; receipt: Original | null; reason: string }>;

export type PreparedAttempt = Readonly<{
  intent: Original;
  prompt: Original;
  directory: string;
  promptPath: string;
  outputPath: string;
  receiptPath: string;
  createdAt: string;
  opaqueId: string;
}>;

const HOLD_LABEL = 'needs-victor';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function originMatches(origin: string, repo: string): boolean {
  const expected = repoName(repo).toLowerCase();
  const trimmed = origin.trim().replace(/\.git$/, '');
  const https = trimmed.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)$/i);
  if (https?.[1]?.toLowerCase() === expected) return true;
  const ssh = trimmed.match(/^git@github\.com:([^/]+\/[^/]+)$/i);
  if (ssh?.[1]?.toLowerCase() === expected) return true;
  const host = trimmed.match(/github\.com[/:]([^/]+\/[^/]+)$/i);
  return host?.[1]?.toLowerCase() === expected;
}

export function validateCarrier(input: CarrierIdentity, command: Command = defaultCommand): void {
  const repo = repoName(input.repo);
  const workRoot = resolve(input.workRoot);
  const carrierHead = sha(input.carrierHead);
  const head = sha(command('git', ['-C', workRoot, 'rev-parse', 'HEAD']).trim());
  if (head !== carrierHead) throw new Error('Work root HEAD is not the supplied carrier');
  const origin = command('git', ['-C', workRoot, 'remote', 'get-url', 'origin']).trim();
  if (!originMatches(origin, repo)) throw new Error('Work root origin is not the carrier repository');
  const view = object(JSON.parse(command('gh', [
    'pr', 'view', String(input.carrierPr), '--repo', repo,
    '--json', 'number,state,isDraft,headRefOid,headRefName,labels',
  ])), 'carrier pr');
  if (integer(view.number) !== input.carrierPr) throw new Error('Carrier PR identity mismatch');
  const state = string(view.state).toUpperCase();
  if (state === 'MERGED') throw new Error('Carrier PR is merged');
  if (state !== 'OPEN') throw new Error('Carrier PR is not open');
  if (view.isDraft === true) throw new Error('Carrier PR is a draft');
  if (sha(view.headRefOid) !== carrierHead) throw new Error('Carrier PR head is not the supplied carrier');
  const labels = array(view.labels).map(item => string(object(item, 'label').name));
  if (!labels.includes(HOLD_LABEL)) throw new Error('Carrier PR is not held');
}

function writeExclusive(path: string, value: unknown): Original {
  mkdirSync(resolve(path, '..'), { recursive: true, mode: 0o700 });
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
  try { writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (!isRecord(error) || error.code !== 'EEXIST') throw error;
    const existing = readFileSync(path);
    if (hash(existing) !== hash(bytes)) throw new Error('Immutable historical evidence conflict');
    return originalOf(path, existing);
  }
  return originalOf(path, bytes);
}

export function persistJson(path: string, value: unknown): void {
  mkdirSync(resolve(path, '..'), { recursive: true, mode: 0o700 });
  const tmp = path + '.tmp';
  const text = JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2) + '\n';
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

export function claimRun(runFile: string, hooks: Readonly<{ afterDeadOwner?: () => void }> = {}): () => void {
  const lock = runFile + '.lock';
  const token = randomUUID();
  const candidate = `${lock}.candidate-${token}`;
  const contendedTombstones = new Set<string>();
  mkdirSync(candidate, { mode: 0o700 });
  writeFileSync(join(candidate, 'owner.json'), JSON.stringify({ pid: process.pid, token }) + '\n', { flag: 'wx', mode: 0o600 });
  while (true) {
    try {
      renameSync(candidate, lock);
      return () => {
        try {
          const owner = object(JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')), 'historical lock owner');
          if (owner.token === token) rmSync(lock, { recursive: true });
        } catch { /* lock already released or transferred */ }
      };
    } catch (error) {
      if (!isRecord(error) || !['EEXIST', 'ENOTEMPTY', 'ENOTDIR'].includes(String(error.code))) {
        rmSync(candidate, { recursive: true, force: true });
        throw error;
      }
    }
    let pid: number;
    let observedToken: string;
    try {
      if (statSync(lock).isDirectory()) {
        const owner = object(JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')), 'historical lock owner');
        pid = integer(owner.pid);
        observedToken = string(owner.token);
      } else {
        const legacy = readFileSync(lock, 'utf8');
        pid = integer(Number(legacy));
        observedToken = `legacy-${hash(legacy)}`;
      }
    } catch {
      rmSync(candidate, { recursive: true, force: true });
      throw new Error('Historical run lock exists without a recoverable owner');
    }
    try { process.kill(pid, 0); }
    catch (error) {
      if (!isRecord(error) || error.code !== 'ESRCH') {
        rmSync(candidate, { recursive: true, force: true });
        throw new Error('Historical run is owned by another process');
      }
      hooks.afterDeadOwner?.();
      const tombstone = `${lock}.stale-${observedToken}`;
      try { renameSync(lock, tombstone); }
      catch (renameError) {
        if (isRecord(renameError) && ['EEXIST', 'ENOTEMPTY', 'ENOENT'].includes(String(renameError.code))) {
          if (contendedTombstones.has(tombstone)) {
            rmSync(candidate, { recursive: true, force: true });
            throw new Error('Historical stale lock identity was already reclaimed');
          }
          contendedTombstones.add(tombstone);
          continue;
        }
        rmSync(candidate, { recursive: true, force: true });
        throw renameError;
      }
      continue;
    }
    rmSync(candidate, { recursive: true, force: true });
    throw new Error('Historical run is owned by another process');
  }
}

export function opaqueAttemptId(identity: HistoricalIdentity, role: Role): string {
  return hash(`${identity.head}:${role}:${identity.recordIndex}`).slice(0, 12);
}

export function prepareAttempt(spec: DispatchSpec, now: Date): PreparedAttempt {
  const directory = resolve(spec.directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const promptPath = join(directory, 'prompt.txt');
  const outputPath = join(directory, 'output.json');
  const receiptPath = join(directory, 'receipt.json');
  const createdAt = now.toISOString();
  const prompt = spec.prompt;
  let promptOriginal: Original;
  if (existsSync(promptPath)) promptOriginal = originalOf(promptPath);
  else promptOriginal = writeExclusive(promptPath, prompt);
  if (promptOriginal.sha256 !== hash(prompt)) throw new Error('Historical prompt changed after intent');
  const intentPath = join(directory, 'intent.json');
  const intended = {
      schemaVersion: 1,
      recordIndex: spec.identity.recordIndex,
      role: spec.role,
      descriptor: spec.descriptor,
      parent: spec.parent,
      repo: spec.identity.repo,
      carrierPr: spec.carrierPr,
      carrierHead: spec.identity.carrierHead,
      head: spec.identity.head,
      base: spec.identity.base,
      opaqueId: spec.opaqueId,
      cwd: spec.cwd,
      promptPath,
      outputPath,
      receiptPath,
      promptDigest: promptOriginal.sha256,
      createdAt,
    };
  const intent = existsSync(intentPath) ? originalOf(intentPath) : writeExclusive(intentPath, intended);
  const saved = parseIntent(intentPath);
  if (saved.recordIndex !== intended.recordIndex || saved.role !== intended.role || saved.descriptor !== intended.descriptor
    || saved.parent !== intended.parent || saved.repo !== intended.repo || saved.carrierPr !== intended.carrierPr
    || saved.carrierHead !== intended.carrierHead || saved.head !== intended.head || saved.base !== intended.base
    || saved.opaqueId !== intended.opaqueId || resolve(saved.cwd) !== resolve(intended.cwd)
    || resolve(saved.promptPath) !== resolve(intended.promptPath) || resolve(saved.outputPath) !== resolve(intended.outputPath)
    || resolve(saved.receiptPath) !== resolve(intended.receiptPath) || saved.promptDigest !== intended.promptDigest) {
    throw new Error('Historical intent conflicts with the requested attempt');
  }
  return {
    intent,
    prompt: promptOriginal,
    directory,
    promptPath,
    outputPath,
    receiptPath,
    createdAt: saved.createdAt,
    opaqueId: spec.opaqueId,
  };
}

function splitRepo(repo: string): { owner: string; name: string } {
  const [owner, name] = repoName(repo).split('/');
  if (!owner || !name) throw new Error('Invalid repository');
  return { owner, name };
}

export function runnerOptionsFor(spec: DispatchSpec, prepared: PreparedAttempt): RunnerOptions {
  const resolved = resolveDescriptor(loadMatrix(), spec.descriptor);
  const { owner, name } = splitRepo(spec.identity.repo);
  return resolvedOptions(laneOptions({
    parent: spec.parent,
    provider: resolved.family.provider,
    model: resolved.family.model,
    effort: resolved.descriptor.effort,
    mode: 'read-only',
    promptPath: prepared.promptPath,
    cwd: spec.cwd,
    outputPath: prepared.outputPath,
    receiptPath: prepared.receiptPath,
    timeoutMs: null,
  }, { owner, name, pullNumber: spec.carrierPr }));
}

export async function launchPrepared(spec: DispatchSpec, prepared: PreparedAttempt, host: HistoricalHost): Promise<RunResult> {
  const options = runnerOptionsFor(spec, prepared);
  const run = host.runLane ?? runLane;
  return run(options);
}

export function recoverReceipt(receiptPath: string): ReceiptRecovery {
  if (!existsSync(receiptPath)) return { kind: 'unknown', receipt: null, reason: 'Launch has no receipt' };
  const receiptBytes = readFileSync(receiptPath);
  const receiptOriginal = writeExclusive(join(dirname(receiptPath), 'receipt-originals', `${hash(receiptBytes)}.json`), receiptBytes);
  let receipt: Record<string, unknown>;
  try { receipt = object(JSON.parse(readFileSync(receiptPath, 'utf8')), 'receipt'); }
  catch { return { kind: 'unknown', receipt: receiptOriginal, reason: 'Launch receipt is partial or malformed' }; }
  if (isRecord(receipt.remote)) {
    const remote = receipt.remote;
    if (typeof remote.agentId === 'string' && remote.agentId && typeof remote.runId === 'string' && remote.runId) {
      return { kind: 'launched', handle: { agentId: remote.agentId, runId: remote.runId }, receipt: receiptOriginal };
    }
    const noAgent = remote.agentId === undefined || remote.agentId === null || remote.agentId === '';
    const noRun = remote.runId === undefined || remote.runId === null || remote.runId === '';
    if (noAgent && noRun && receipt.status === 'unavailable-cli') {
      return { kind: 'definite-no-launch', receipt: receiptOriginal };
    }
    return { kind: 'unknown', receipt: receiptOriginal, reason: 'Launch receipt has an incomplete remote identity' };
  }
  if (receipt.remote === null && receipt.status === 'unavailable-cli') {
    return { kind: 'definite-no-launch', receipt: receiptOriginal };
  }
  return { kind: 'unknown', receipt: receiptOriginal, reason: 'Launch receipt does not prove whether remote work was accepted' };
}

export async function collectLaunched(input: {
  handle: LaunchedHandle;
  directory: string;
  host: HistoricalHost;
}): Promise<CollectedRemote> {
  return collectRemoteEvidence({
    agentId: input.handle.agentId,
    runId: input.handle.runId,
    directory: input.directory,
    endpoint: input.host.endpoint ?? resolveCursorEndpoint(),
    fetch: input.host.fetch,
  });
}

export function parseIntent(path: string): HistoricalIntent {
  const v = object(JSON.parse(readFileSync(path, 'utf8')), 'historical intent');
  if (v.schemaVersion !== 1) throw new Error('Unknown historical intent schema');
  return {
    recordIndex: integer(v.recordIndex),
    role: oneOf(v.role, ['pr verifier', 'pr reviewer']),
    descriptor: string(v.descriptor),
    parent: string(v.parent),
    repo: repoName(v.repo),
    carrierHead: sha(v.carrierHead),
    head: sha(v.head),
    base: sha(v.base),
    cwd: string(v.cwd),
    carrierPr: integer(v.carrierPr),
    opaqueId: string(v.opaqueId),
    promptDigest: digest(v.promptDigest),
    createdAt: string(v.createdAt),
    promptPath: string(v.promptPath),
    outputPath: string(v.outputPath),
    receiptPath: string(v.receiptPath),
  };
}
