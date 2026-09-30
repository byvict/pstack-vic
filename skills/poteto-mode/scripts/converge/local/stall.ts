import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { instant, integer, object, repoName, sha, string } from '../contract.ts';
import { writeJsonFile } from './ledger.ts';

/** Nine times the slowest CI run measured on either repository (13.2 minutes on Clinext): an armed PR still open after this is stuck, not slow. */
export const ARMED_STALL_HOURS = 2;
/** Every refusal a re-certification cures is `recertify`, so what stays refused is a race, which clears within a tick, or an anomaly. */
export const REFUSAL_STALL_HOURS = 1;
/** Since when the tick has seen `key` hold the PR on `head`. */
export interface Waiting { schemaVersion: 1; repo: string; pr: number; head: string; key: string; since: string }

function waitingDirectory(stateDirectory: string, repo: string): string { return join(stateDirectory, 'waiting', repoName(repo).replace('/', '-')); }
export function waitingFile(stateDirectory: string, repo: string, pr: number): string { return join(waitingDirectory(stateDirectory, repo), `${integer(pr)}.json`); }
export function parseWaiting(value: unknown): Waiting {
  const v = object(value, 'stall clock');
  if (v.schemaVersion !== 1) throw new Error('Unknown stall clock schema');
  return { schemaVersion: 1, repo: repoName(v.repo), pr: integer(v.pr), head: sha(v.head), key: string(v.key), since: instant(v.since, 'stall clock start') };
}
export function readWaiting(file: string): Waiting | null {
  try { return parseWaiting(JSON.parse(readFileSync(file, 'utf8'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Invalid stall clock file ${file}: ${(error as Error).message}`);
  }
}
export function writeWaiting(file: string, waiting: Waiting): void { writeJsonFile(file, waiting); }
/** A removal with no read, so a PR without a stall never reads a file that could be corrupt. */
export function clearWaiting(file: string): void { rmSync(file, { force: true }); }
/** Removes the clock of every PR of the repository that is no longer open: nothing else visits a closed PR, and a PR reopened on the same head must not inherit its old clock. */
export function pruneWaiting(stateDirectory: string, repo: string, open: number[]): void {
  const directory = waitingDirectory(stateDirectory, repo);
  if (!existsSync(directory)) return;
  for (const name of readdirSync(directory)) if (!open.some(pr => `${pr}.json` === name)) rmSync(join(directory, name), { force: true });
}
