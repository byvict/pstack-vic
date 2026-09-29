import { integer, object, oneOf, repoName, sha, string } from '../contract.ts';
import { outcomes, workKinds, type Outcome, type WorkKind } from './ledger.ts';

export interface OutcomeFile { schemaVersion: 1; repo: string; pr: number; head: string; kind: WorkKind; outcome: Outcome; reason: string; verdictUrl: string | null; arm: 'armed' | 'refused' | 'not-armed' | null; adjustRounds: number | null; runDirectory: string }
function positive(value: unknown, label: string): number {
  const result = integer(value, label);
  if (result === 0) throw new Error(`Invalid ${label}`);
  return result;
}
function nonEmpty(value: unknown, label: string): string {
  const result = string(value, label);
  if (!result) throw new Error(`Invalid ${label}`);
  return result;
}
export function parseOutcome(value: unknown): OutcomeFile {
  const v = object(value, 'outcome');
  if (v.schemaVersion !== 1) throw new Error('Unknown outcome schema');
  return { schemaVersion: 1, repo: repoName(v.repo), pr: positive(v.pr, 'PR'), head: sha(v.head), kind: oneOf(v.kind, workKinds), outcome: oneOf(v.outcome, outcomes), reason: string(v.reason),
    verdictUrl: v.verdictUrl === null ? null : string(v.verdictUrl), arm: v.arm === null ? null : oneOf(v.arm, ['armed', 'refused', 'not-armed']), adjustRounds: v.adjustRounds === null ? null : integer(v.adjustRounds, 'adjust rounds'), runDirectory: nonEmpty(v.runDirectory, 'run directory') };
}
