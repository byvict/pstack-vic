import { checks, verdictStatus, type Pull, type Trusted } from '../github.ts';
import { verdictGate } from '../gate.ts';
import { requiredChecks } from '../arm.ts';
import type { WorkKind } from './ledger.ts';

export const GRACE_MINUTES = 30;
export interface Pending { kind: 'pending'; work: WorkKind; repo: string; pr: number; head: string; branch: string; reason: string }
export interface Skipped { kind: 'skipped'; repo: string; pr: number; head: string; reason: string }
export interface Idle { kind: 'idle'; repo: string; pr: number; head: string; reason: string }
export type Classified = Pending | Skipped | Idle;
const unfinished = ['queued', 'in_progress', 'waiting', 'requested', 'pending'];
const stale = /^Certificate patch or policy differs at trunk tip |^Certificate is no longer VERIFIED at trunk tip /;

/** One PR, one answer, from the same reads the sweep and the arm make. Errors propagate: the caller decides whether one PR's failure stops the tick. */
export async function classify(t: Trusted, p: Pull, author: number, options: { now: number; leased: (branch: string) => boolean }): Promise<Classified> {
  const base = { repo: t.repo, pr: p.number, head: p.head };
  const skipped = (reason: string): Skipped => ({ kind: 'skipped', ...base, reason });
  const pending = (work: WorkKind, reason: string): Pending => ({ kind: 'pending', work, ...base, branch: p.branch, reason });
  if (p.state !== 'open') return skipped('PR is not open');
  if (p.draft) return skipped('draft');
  if (p.labels.some(label => t.config.holdLabels.includes(label))) return skipped('hold label');
  if (p.fork) return skipped('head is in a fork');
  if (p.branch === t.config.trunk) return skipped('head branch is trunk');
  if (options.leased(p.branch)) return skipped('branch is leased');
  const status = await verdictStatus(t.repo, p.number, p.head, author);
  if (status.kind === 'foreign') return skipped(status.reason);
  if (status.kind === 'none') {
    if (options.now - Date.parse(p.createdAt) < GRACE_MINUTES * 60_000) return skipped(`younger than ${GRACE_MINUTES} minutes`);
    return pending('certify', status.reason);
  }
  const gate = await verdictGate(t, p.number, p.head, author);
  if (gate.kind === 'refused') return stale.test(gate.reason) ? pending('recertify', gate.reason) : skipped(gate.reason);
  if (gate.dossier.round.execution !== 'pre-pr') return skipped('verdict from the retired cloud execution');
  const required = await requiredChecks(t);
  const observed = await checks(t.repo, p.head);
  for (const c of required) {
    if (c.context === 'verdict' || c.context === 'hold') continue;
    const failed = observed.find(check => check.context === c.context && (c.appId === null || c.appId === check.appId) && check.state !== 'success' && !unfinished.includes(check.state));
    if (failed) return pending('repair', `Required protected check failed: ${c.context}`);
  }
  return { kind: 'idle', ...base, reason: 'certified; checks green or pending' };
}
