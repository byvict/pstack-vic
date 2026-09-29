import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { array, instant, integer, object, oneOf, repoName, sha, string } from '../contract.ts';

export const MAX_FAILED_ATTEMPTS = 2;
/** `deferred` does not count as failed, so a cause that persists (a Dependabot PR that no longer rebases, a stack child waiting on its parent) would relaunch every tick without these two bounds. */
export const MAX_DEFERRED_ATTEMPTS = 3;
export const DEFERRED_BACKOFF_MINUTES = 30;
export const HEAD_WINDOW_HOURS = 6;
export const ATTEMPT_CAP_HOURS = 2;
/** A Raiz that fails to launch (see `LAUNCH_FAILURE_MINUTES` in raiz.ts) records no attempt; without this bound the lowest pending PR would relaunch on every tick and starve the others. */
export const MAX_LAUNCH_FAILURES = 3;
export const LAUNCH_FAILURE_BACKOFF_MINUTES = 60;
export const workKinds = ['repair', 'recertify', 'certify'] as const;
export type WorkKind = typeof workKinds[number];
export const outcomes = ['certified', 'deferred', 'failed', 'skipped'] as const;
export type Outcome = typeof outcomes[number];
export interface Attempt { n: number; kind: WorkKind; startedAt: string; endedAt: string; outcome: Exclude<Outcome, 'skipped'>; reason: string; runDirectory: string }
export interface FailedLaunch { at: string; reason: string }
export interface Ledger { schemaVersion: 1; repo: string; pr: number; head: string; firstAttemptAt: string | null; heldAt: string | null; attempts: Attempt[]; launchFailures: FailedLaunch[] }

export function ledgerFile(stateDirectory: string, repo: string, pr: number): string {
  return join(stateDirectory, 'ledger', repoName(repo).replace('/', '-'), `${integer(pr)}.json`);
}
function parseAttempt(value: unknown): Attempt {
  const v = object(value, 'attempt');
  return { n: integer(v.n), kind: oneOf(v.kind, workKinds), startedAt: instant(v.startedAt, 'attempt start'), endedAt: instant(v.endedAt, 'attempt end'), outcome: oneOf(v.outcome, ['certified', 'deferred', 'failed']), reason: string(v.reason), runDirectory: string(v.runDirectory) };
}
function parseFailedLaunch(value: unknown): FailedLaunch {
  const v = object(value, 'launch failure');
  return { at: instant(v.at, 'launch failure time'), reason: string(v.reason) };
}
export function parseLedger(value: unknown): Ledger {
  const v = object(value, 'ledger');
  if (v.schemaVersion !== 1) throw new Error('Unknown ledger schema');
  return { schemaVersion: 1, repo: repoName(v.repo), pr: integer(v.pr), head: sha(v.head), firstAttemptAt: v.firstAttemptAt === null ? null : instant(v.firstAttemptAt, 'ledger first attempt'), heldAt: v.heldAt === null ? null : instant(v.heldAt, 'ledger hold'), attempts: array(v.attempts).map(parseAttempt), launchFailures: v.launchFailures === undefined ? [] : array(v.launchFailures).map(parseFailedLaunch) };
}
export function readLedger(file: string): Ledger | null {
  try { return parseLedger(JSON.parse(readFileSync(file, 'utf8'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Invalid ledger file ${file}: ${(error as Error).message}`);
  }
}
export function writeLedger(file: string, ledger: Ledger): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(ledger, null, 2) + '\n', { mode: 0o600 });
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
}
/** A new head resets the count, and so does Victor removing the hold label the daemon applied. */
export function currentLedger(existing: Ledger | null, repo: string, pr: number, head: string, held: boolean): Ledger {
  if (existing && existing.head === head && !(existing.heldAt !== null && !held)) return existing;
  return { schemaVersion: 1, repo: repoName(repo), pr: integer(pr), head: sha(head), firstAttemptAt: null, heldAt: null, attempts: [], launchFailures: [] };
}
export function exhausted(ledger: Ledger, now: number): string | null {
  if (ledger.attempts.filter(a => a.outcome === 'failed').length >= MAX_FAILED_ATTEMPTS) return `${MAX_FAILED_ATTEMPTS} failed attempts on head ${ledger.head}`;
  if (ledger.attempts.filter(a => a.outcome === 'deferred').length >= MAX_DEFERRED_ATTEMPTS) return `${MAX_DEFERRED_ATTEMPTS} deferred attempts on head ${ledger.head}`;
  if (ledger.firstAttemptAt !== null && !ledger.attempts.some(a => a.outcome === 'certified') && now - Date.parse(ledger.firstAttemptAt) >= HEAD_WINDOW_HOURS * 3_600_000) return `${HEAD_WINDOW_HOURS} hours since the first attempt on head ${ledger.head}`;
  return null;
}
/** When the latest attempt on the head is `deferred`, the instant its backoff ends, while that is still ahead of `now`; otherwise null. */
export function deferredBackoffUntil(ledger: Ledger, now: number): string | null {
  const last = ledger.attempts.at(-1);
  if (last?.outcome !== 'deferred') return null;
  const until = Date.parse(last.endedAt) + DEFERRED_BACKOFF_MINUTES * 60_000;
  return now < until ? new Date(until).toISOString() : null;
}
export function withAttempt(ledger: Ledger, attempt: Omit<Attempt, 'n'>): Ledger {
  return { ...ledger, launchFailures: [], firstAttemptAt: ledger.firstAttemptAt ?? attempt.startedAt, attempts: [...ledger.attempts, { ...attempt, n: ledger.attempts.length + 1 }] };
}
export function withLaunchFailure(ledger: Ledger, failure: FailedLaunch): Ledger {
  return { ...ledger, launchFailures: [...ledger.launchFailures, failure] };
}
/** After MAX_LAUNCH_FAILURES launch failures on the head since the last recorded attempt, the instant the backoff after the last one ends, while that is still ahead of `now`; otherwise null. */
export function launchBackoffUntil(ledger: Ledger, now: number): string | null {
  const last = ledger.launchFailures.at(-1);
  if (!last || ledger.launchFailures.length < MAX_LAUNCH_FAILURES) return null;
  const until = Date.parse(last.at) + LAUNCH_FAILURE_BACKOFF_MINUTES * 60_000;
  return now < until ? new Date(until).toISOString() : null;
}
export function markHeld(ledger: Ledger, now: number): Ledger {
  return { ...ledger, heldAt: new Date(now).toISOString() };
}
