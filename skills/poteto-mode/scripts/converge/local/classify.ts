import { checks, participants, verdictStatus, type Pull, type Trusted } from '../github.ts';
import { verdictGate } from '../gate.ts';
import { passing, requiredChecks, unfinished } from '../arm.ts';
import type { WorkKind } from './ledger.ts';

export const GRACE_MINUTES = 30;
export interface Pending { kind: 'pending'; work: WorkKind; repo: string; pr: number; head: string; branch: string; reason: string }
export interface Skipped { kind: 'skipped'; repo: string; pr: number; head: string; reason: string }
export interface Idle { kind: 'idle'; repo: string; pr: number; head: string; reason: string }
export type Classified = Pending | Skipped | Idle;
const stale = /^Certificate patch or policy differs at trunk tip |^Certificate is no longer VERIFIED at trunk tip /;

export interface ClassifyOptions { now: number; leased: (branch: string) => boolean; trusted: string[]; force?: WorkKind }
/** Logins compare without case, as GitHub does. */
function trusts(trusted: string[], login: string): boolean { return trusted.some(t => t.toLowerCase() === login.toLowerCase()); }
/** One PR, one answer, from the same reads the sweep and the arm make. Errors propagate: the caller decides whether one PR's failure stops the tick. An author outside `trusted` is skipped before any read past the PR record; a pending PR (a forced kind included) is skipped when anyone outside `trusted` commented or reviewed, so no third-party text reaches a Raiz. */
export async function classify(t: Trusted, p: Pull, author: number, options: ClassifyOptions): Promise<Classified> {
  const base = { repo: t.repo, pr: p.number, head: p.head };
  const skipped = (reason: string): Skipped => ({ kind: 'skipped', ...base, reason });
  const pending = (work: WorkKind, reason: string): Pending => ({ kind: 'pending', work, ...base, branch: p.branch, reason });
  if (p.state !== 'open') return skipped('PR is not open');
  if (p.draft) return skipped('draft');
  if (p.labels.some(label => t.config.holdLabels.includes(label))) return skipped('hold label');
  if (p.fork) return skipped('head is in a fork');
  if (!trusts(options.trusted, p.authorLogin)) return skipped(`untrusted author: ${p.authorLogin}`);
  if (p.branch === t.config.trunk) return skipped('head branch is trunk');
  if (options.leased(p.branch)) return skipped('branch is leased');
  const classified = await work();
  if (classified.kind === 'skipped') return classified;
  const result = options.force ? pending(options.force, 'forced by run --kind') : classified;
  if (result.kind !== 'pending') return result;
  // Only a launch hands the PR's text to a Raiz, so only a pending PR pays for these three reads.
  const outsider = (await participants(t.repo, p.number)).find(x => !trusts(options.trusted, x.login));
  return outsider ? skipped(`untrusted ${outsider.role}: ${outsider.login}`) : result;
  async function work(): Promise<Classified> {
    const status = await verdictStatus(t.repo, p.number, p.head, author);
    if (status.kind === 'foreign') return skipped(status.reason);
    if (status.kind === 'none') {
      const created = Date.parse(p.createdAt);
      if (Number.isNaN(created)) throw new Error(`Invalid PR createdAt: ${p.createdAt}`);
      if (options.now - created < GRACE_MINUTES * 60_000) return skipped(`younger than ${GRACE_MINUTES} minutes`);
      return pending('certify', status.reason);
    }
    const gate = await verdictGate(t, p.number, p.head, author);
    if (gate.kind === 'refused') return stale.test(gate.reason) ? pending('recertify', gate.reason) : skipped(gate.reason);
    if (gate.dossier.round.execution !== 'pre-pr') return skipped('verdict from the retired cloud execution');
    const required = await requiredChecks(t);
    const observed = await checks(t.repo, p.head);
    for (const c of required) {
      if (c.context === 'verdict' || c.context === 'hold') continue;
      const failed = observed.find(check => check.context === c.context && (c.appId === null || c.appId === check.appId) && !passing.includes(check.state) && !unfinished.includes(check.state));
      if (failed) return pending('repair', `Required protected check failed: ${c.context}`);
    }
    return { kind: 'idle', ...base, reason: 'certified; checks green or pending' };
  }
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
