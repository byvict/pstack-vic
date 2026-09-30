import { checks, participants, verdictStatus, type Pull, type Trusted } from '../github.ts';
import { verdictGate } from '../gate.ts';
import { passing, protectedObservations, protectedResult, requiredChecks, unfinished } from '../protection.ts';
import { queueRetry, queueState } from '../queue.ts';
import type { WorkKind } from './ledger.ts';
import { ARMED_STALL_HOURS, REFUSAL_STALL_HOURS } from './stall.ts';

/** An uncertified head without a lease is certified once its tests check completed, whatever the conclusion: the head stopped moving for as long as CI took. Until then the PR waits at most this long, the fallback for a repository whose PRs get no check run. */
export const GRACE_MINUTES = 30;
/** A PR the tick does no work on that may still need Victor: the tick holds it once `key` has stood on the head for `hours` (0: at once), with `hold` as the reason and `advice` as the hold comment's last line. */
export interface Stall { key: string; hours: number; hold: string; advice?: string }
export interface Pending { kind: 'pending'; work: WorkKind; repo: string; pr: number; head: string; branch: string; reason: string }
export interface Skipped { kind: 'skipped'; repo: string; pr: number; head: string; reason: string; stall?: Stall }
export interface Idle { kind: 'idle'; repo: string; pr: number; head: string; reason: string; stall?: Stall }
export type Classified = Pending | Skipped | Idle;
/** The gate refusals a re-certification does not cure: races the next tick sees settled. Every other refusal is `recertify`, except text after the verdict, which a Raiz answers first (`respond`). */
const races = ['PR must be open and ready', 'PR head moved'];
const unanswered = /^(?:Comment|Review) after the verdict by /;

export interface ClassifyOptions { now: number; leased: (branch: string) => boolean; trusted: string[]; force?: WorkKind }
/** Logins compare without case, as GitHub does. */
function trusts(trusted: string[], login: string): boolean { return trusted.some(t => t.toLowerCase() === login.toLowerCase()); }
function hours(n: number): string { return `${n} hour${n === 1 ? '' : 's'}`; }
function refusal(reason: string): Stall { return { key: reason, hours: REFUSAL_STALL_HOURS, hold: `the verdict gate refused for ${hours(REFUSAL_STALL_HOURS)}: ${reason}` }; }
/** One PR, one answer, from the same reads the sweep and the arm make. Errors propagate: the caller decides whether one PR's failure stops the tick. An author outside `trusted` is skipped before any read past the PR record; a pending PR (a forced kind included) is skipped with a stall to hold at once when anyone outside `trusted` commented or reviewed, so no text from an unlisted login reaches a Raiz. */
export async function classify(t: Trusted, p: Pull, author: number, options: ClassifyOptions): Promise<Classified> {
  const base = { repo: t.repo, pr: p.number, head: p.head };
  const skipped = (reason: string, stall?: Stall): Skipped => ({ kind: 'skipped', ...base, reason, ...(stall ? { stall } : {}) });
  const pending = (work: WorkKind, reason: string): Pending => ({ kind: 'pending', work, ...base, branch: p.branch, reason });
  if (p.state !== 'open') return skipped('PR is not open');
  if (p.draft) return skipped('draft');
  if (p.labels.some(label => t.config.holdLabels.includes(label))) return skipped('hold label');
  if (p.fork) return skipped('head is in a fork');
  if (!trusts(options.trusted, p.authorLogin)) return skipped(`untrusted author: ${p.authorLogin}`);
  if (p.branch === t.config.trunk) return skipped('head branch is trunk');
  if (options.leased(p.branch)) return skipped('branch is leased');
  const work = async (): Promise<Classified> => {
    const status = await verdictStatus(t.repo, p.number, p.head, author);
    if (status.kind === 'foreign') return skipped(status.reason, refusal(status.reason));
    if (status.kind === 'none') {
      const created = Date.parse(p.createdAt);
      if (Number.isNaN(created)) throw new Error(`Invalid PR createdAt: ${p.createdAt}`);
      if (options.now - created < GRACE_MINUTES * 60_000) {
        const job = t.config.tests.job;
        const tests = (await checks(t.repo, p.head)).find(c => c.context === job);
        if (!tests || unfinished.includes(tests.state)) return skipped(`${job} has not completed on the head and the PR is younger than ${GRACE_MINUTES} minutes`);
      }
      return pending('certify', status.reason);
    }
    const gate = await verdictGate(t, p.number, p.head, author);
    if (gate.kind === 'refused') return unanswered.test(gate.reason) ? pending('respond', gate.reason) : races.includes(gate.reason) ? skipped(gate.reason, refusal(gate.reason)) : pending('recertify', gate.reason);
    if (gate.dossier.round.execution !== 'pre-pr') return skipped('verdict from the retired cloud execution');
    // A stack child's conflict is with its parent branch, which the stack's owner resolves.
    if (p.base === t.config.trunk && p.mergeable === false) return pending('recertify', 'PR conflicts with trunk');
    if (p.base === t.config.trunk) {
      const queue = await queueState(t.repo, p.number);
      const retry = queueRetry(queue, gate);
      if (retry) return pending(queue.kind === 'removed' && queue.reason === 'failed_checks' ? 'repair' : 'recertify', retry);
      if (queue.kind === 'queued') return queue.state === 'UNMERGEABLE' ? pending('repair', `Merge queue candidate ${queue.head ?? 'unavailable'} is UNMERGEABLE`) : { kind: 'idle', ...base, reason: `merge queue owns candidate ${queue.head ?? 'building'} (${queue.state})` };
    }
    const required = await requiredChecks(t);
    const observed = await protectedObservations(t.repo, p.head);
    for (const c of required) {
      if (c.context === 'verdict' || c.context === 'hold') continue;
      const failed = protectedResult(c, observed).observations.find(check => !passing.includes(check.state) && !unfinished.includes(check.state));
      if (failed) return pending('repair', `Required protected check failed: ${c.context}`);
    }
    const idle: Idle = { kind: 'idle', ...base, reason: 'certified; checks green or pending' };
    if (!p.autoMerge) return idle;
    // Armed with every required check passing, GitHub merges within seconds; what it still waits on names the stall.
    const waits = new Set(required.filter(c => c.context !== 'verdict').flatMap(c => {
      const result = protectedResult(c, observed);
      return [...(result.found ? [] : [`${c.context} has no run`]), ...result.observations.flatMap(latest => unfinished.includes(latest.state) ? [`${c.context} has not finished`] : passing.includes(latest.state) ? [] : [`${c.context} concluded ${latest.state}`])];
    }));
    if (p.mergeable === null) waits.add('mergeability not computed');
    return { ...idle, stall: { key: 'armed', hours: ARMED_STALL_HOURS, hold: `auto-merge armed for ${hours(ARMED_STALL_HOURS)} without a merge; GitHub waits on: ${[...waits].join(', ') || 'nothing the daemon can see'}` } };
  };
  const classified = await work();
  if (classified.kind === 'skipped') return classified;
  const result = options.force ? pending(options.force, 'forced by run --kind') : classified;
  if (result.kind !== 'pending') return result;
  // Only a launch hands the PR's text to a Raiz, so only a pending PR pays for these three reads.
  const outsider = (await participants(t.repo, p.number)).find(x => !trusts(options.trusted, x.login));
  if (!outsider) return result;
  const reason = `untrusted ${outsider.role}: ${outsider.login}`;
  return skipped(reason, { key: reason, hours: 0, hold: reason, advice: `Delete that ${outsider.role === 'reviewer' ? 'review' : 'comment'} or add ${outsider.login} to trustedAuthors in the daemon's configuration, then remove the hold label; hiding it is not enough, since GitHub still returns hidden text.` });
}
/** Catch-up step 1's PR conditions, the only causes a Raiz may give for `skipped`: the first that holds on the live PR, or null when none does. */
export function skipCause(t: Trusted, p: Pull, launchedHead: string): string | null {
  if (p.state !== 'open') return 'PR is not open';
  if (p.draft) return 'draft';
  if (p.labels.some(label => t.config.holdLabels.includes(label))) return 'hold label';
  if (p.head !== launchedHead) return 'head moved';
  if (p.branch === t.config.trunk) return 'head branch is trunk';
  return null;
}
