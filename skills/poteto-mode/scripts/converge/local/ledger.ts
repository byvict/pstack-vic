import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { array, integer, object, oneOf, repoName, sha, string } from '../contract.ts';

export const MAX_FAILED_ATTEMPTS = 2;
export const HEAD_WINDOW_HOURS = 6;
export const ATTEMPT_CAP_HOURS = 2;
export const workKinds = ['repair', 'recertify', 'certify'] as const;
export type WorkKind = typeof workKinds[number];
export const outcomes = ['certified', 'deferred', 'failed', 'skipped'] as const;
export type Outcome = typeof outcomes[number];
export interface Attempt { n: number; kind: WorkKind; startedAt: string; endedAt: string; outcome: Exclude<Outcome, 'skipped'>; reason: string; runDirectory: string }
export interface Ledger { schemaVersion: 1; repo: string; pr: number; head: string; firstAttemptAt: string | null; heldAt: string | null; attempts: Attempt[] }

export function ledgerFile(stateDirectory: string, repo: string, pr: number): string {
  return join(stateDirectory, 'ledger', repoName(repo).replace('/', '-'), `${integer(pr)}.json`);
}
function parseAttempt(value: unknown): Attempt {
  const v = object(value, 'attempt');
  return { n: integer(v.n), kind: oneOf(v.kind, workKinds), startedAt: string(v.startedAt), endedAt: string(v.endedAt), outcome: oneOf(v.outcome, ['certified', 'deferred', 'failed']), reason: string(v.reason), runDirectory: string(v.runDirectory) };
}
export function parseLedger(value: unknown): Ledger {
  const v = object(value, 'ledger');
  if (v.schemaVersion !== 1) throw new Error('Unknown ledger schema');
  return { schemaVersion: 1, repo: repoName(v.repo), pr: integer(v.pr), head: sha(v.head), firstAttemptAt: v.firstAttemptAt === null ? null : string(v.firstAttemptAt), heldAt: v.heldAt === null ? null : string(v.heldAt), attempts: array(v.attempts).map(parseAttempt) };
}
export function readLedger(file: string): Ledger | null {
  return existsSync(file) ? parseLedger(JSON.parse(readFileSync(file, 'utf8'))) : null;
}
export function writeLedger(file: string, ledger: Ledger): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(ledger, null, 2) + '\n', { mode: 0o600 });
}
/** A new head resets the count, and so does Victor removing the hold label the daemon applied. */
export function currentLedger(existing: Ledger | null, repo: string, pr: number, head: string, held: boolean): Ledger {
  if (existing && existing.head === head && !(existing.heldAt !== null && !held)) return existing;
  return { schemaVersion: 1, repo: repoName(repo), pr: integer(pr), head: sha(head), firstAttemptAt: null, heldAt: null, attempts: [] };
}
export function exhausted(ledger: Ledger, now: number): string | null {
  if (ledger.attempts.filter(a => a.outcome === 'failed').length >= MAX_FAILED_ATTEMPTS) return `two failed attempts on head ${ledger.head}`;
  if (ledger.firstAttemptAt !== null && !ledger.attempts.some(a => a.outcome === 'certified') && now - Date.parse(ledger.firstAttemptAt) >= HEAD_WINDOW_HOURS * 3_600_000) return `six hours since the first attempt on head ${ledger.head}`;
  return null;
}
export function withAttempt(ledger: Ledger, attempt: Omit<Attempt, 'n'>): Ledger {
  return { ...ledger, firstAttemptAt: ledger.firstAttemptAt ?? attempt.startedAt, attempts: [...ledger.attempts, { n: ledger.attempts.length + 1, ...attempt }] };
}
export function markHeld(ledger: Ledger, now: number): Ledger {
  return { ...ledger, heldAt: new Date(now).toISOString() };
}
