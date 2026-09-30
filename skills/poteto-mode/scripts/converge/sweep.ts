import { parseArgs } from 'node:util';
import { integer, object, repoName, sha, string } from './contract.ts';
import { api, pages, principal, pull, RequestError, timedChecks, trusted, verdictStatus, type Pull, type Trusted } from './github.ts';
import { verdictGate, type Gate } from './gate.ts';
import { arm, armCommand, disarm, passing, requiredChecks, MERGES_AT_ONCE } from './arm.ts';

export interface Swept { pr: number; head: string; outcome: 'armed' | 'disarmed' | 'merged' | 'dry-run' | 'skipped' | 'refused'; reason: string }
/** GitHub merged 20 armed PRs 5 to 90 seconds after their last required check passed, and left one open for 18 minutes, green and `clean`, until a session read it (pstack-vic#59). Past this many minutes the merge was missed, not slow. */
export const STALL_MINUTES = 5;
/** When the last required check run passed, for a PR that GitHub reports as mergeable now and whose required check runs all passed at least STALL_MINUTES ago; null for any other. The `verdict` status has no run: the gate certified it, and it precedes every arm. */
async function stalledSince(t: Trusted, p: Pull): Promise<string | null> {
  if (!MERGES_AT_ONCE.includes(p.mergeState)) return null;
  const observed = await timedChecks(t.repo, p.head);
  let last: string | null = null;
  for (const c of await requiredChecks(t)) {
    if (c.context === 'verdict') continue;
    const run = observed.find(check => check.context === c.context && (c.appId === null || c.appId === check.appId));
    if (!run || !passing.includes(run.state) || run.completedAt === null) return null;
    if (last === null || Date.parse(run.completedAt) > Date.parse(last)) last = run.completedAt;
  }
  return last !== null && Date.now() - Date.parse(last) >= STALL_MINUTES * 60_000 ? last : null;
}
/** GitHub's auto-merge missed an armed PR it reports as mergeable, so the sweep runs the arm command again: on such a PR gh merges at once, and GitHub still enforces the required checks. A command that fails is not a refusal of the PR, so nothing is disarmed; the read after it says what happened. */
async function unstick(t: Trusted, p: Pull, since: string, dryRun: boolean): Promise<Pick<Swept, 'outcome' | 'reason'>> {
  const stalled = `auto-merge stalled since ${since}`;
  if (dryRun) return { outcome: 'dry-run', reason: `${stalled}, would run the arm command again` };
  try { armCommand(t.repo, p.number, p.head); }
  catch (error) { if (!(error instanceof RequestError)) throw error; }
  const after = await pull(t.repo, p.number);
  if (after.merged) return { outcome: 'merged', reason: `${stalled}, merged after the arm command` };
  if (after.state !== 'open') return { outcome: 'skipped', reason: 'PR is no longer open' };
  return { outcome: 'refused', reason: `${stalled}, still open after the arm command` };
}
const disarmed = { 'would disarm': 'would disarm auto-merge', disarmed: 'auto-merge disarmed', 'already off': 'auto-merge already off', closed: 'PR merged or closed before disarm', 'still armed': 'auto-merge still pending after disarm' } as const;
async function observedDisarm(repo: string, pr: number, dryRun: boolean): Promise<keyof typeof disarmed> {
  if (dryRun) return 'would disarm';
  let ran: boolean | null = null;
  try { ran = await disarm(repo, pr); }
  catch (error) { if (!(error instanceof RequestError)) throw error; }
  const after = await pull(repo, pr);
  if (after.state !== 'open') return 'closed';
  if (after.autoMerge) return 'still armed';
  return ran === false ? 'already off' : 'disarmed';
}
/** A trunk contract that does not load, for any reason, leaves no policy anyone can check an armed PR against, so the sweep fails safe and disarms. */
async function contract(repo: string, configPath?: string): Promise<Trusted | { failure: string }> {
  try { return await trusted(repo, configPath ?? '.cursor/converge.json'); }
  catch (error) {
    if (!(error instanceof Error)) throw error;
    return { failure: 'Trunk contract unavailable: ' + error.message };
  }
}
async function withoutContract(repo: string, pr: number, failure: string, dryRun: boolean): Promise<Swept> {
  const p = await pull(repo, pr);
  if (!p.autoMerge) return { pr, head: p.head, outcome: 'refused', reason: failure };
  return { pr, head: p.head, outcome: 'refused', reason: failure + ', ' + disarmed[await observedDisarm(repo, pr, dryRun)] };
}
async function judge(repo: string, pr: number, author: number, options: { configPath?: string; dryRun: boolean }): Promise<Swept> {
  const t = await contract(repo, options.configPath);
  if ('failure' in t) return withoutContract(repo, pr, t.failure, options.dryRun);
  const p = await pull(repo, pr);
  try { return await decideOne(t, p, author, options); }
  catch (error) { return { pr, head: p.head, outcome: 'refused', reason: error instanceof Error ? error.message : 'Sweep failed' }; }
}
async function decideOne(t: Trusted, p: Pull, author: number, options: { configPath?: string; dryRun: boolean }): Promise<Swept> {
  const pr = p.number;
  const head = p.head;
  const result = (outcome: Swept['outcome'], reason: string): Swept => ({ pr, head, outcome, reason });
  if (p.state !== 'open') return result('skipped', 'PR is no longer open');
  if (p.base !== t.config.trunk) return result('skipped', 'base is not trunk');
  const held = p.labels.some(label => t.config.holdLabels.includes(label));
  if (held && p.autoMerge) {
    const done = await observedDisarm(t.repo, pr, options.dryRun);
    const outcome = ({ 'would disarm': 'dry-run', disarmed: 'disarmed', 'already off': 'skipped', closed: 'refused', 'still armed': 'refused' } as const)[done];
    return result(outcome, done === 'disarmed' ? 'hold label' : 'hold label, ' + disarmed[done]);
  }
  if (held) return result('skipped', 'hold label');
  if (p.autoMerge) {
    const gate = await verdictGate(t, pr, head, author).catch((error: unknown): Gate => ({ kind: 'refused', reason: error instanceof Error ? error.message : 'Verdict gate failed' }));
    if (gate.kind !== 'certified') return result('refused', gate.reason + ', ' + disarmed[await observedDisarm(t.repo, pr, options.dryRun)]);
    const since = await stalledSince(t, p);
    if (since === null) return result('skipped', 'auto-merge already pending');
    const done = await unstick(t, p, since, options.dryRun);
    return result(done.outcome, done.reason);
  }
  if (p.draft) return result('skipped', 'draft');
  const verdict = await verdictStatus(t.repo, pr, head, author);
  if (verdict.kind === 'none') return result('skipped', 'no trusted verdict on head');
  if (verdict.kind === 'foreign') return result('refused', verdict.reason);
  const armed = await arm({ repo: t.repo, pr, head, verdict: 'VERIFIED', dryRun: options.dryRun, configPath: options.configPath, pending: true });
  return result(armed.kind, armed.rederived ?? '');
}
async function eachOpen(repo: string, base: string, one: (pr: number) => Promise<Swept>): Promise<{ swept: Swept[] }> {
  const open = (await pages(`repos/${repo}/pulls?state=open&base=${encodeURIComponent(base)}`)).map(v => object(v));
  const swept: Swept[] = [];
  for (const listed of open.sort((a, b) => integer(a.number) - integer(b.number))) {
    const pr = integer(listed.number);
    try { swept.push(await one(pr)); }
    catch (error) { swept.push({ pr, head: sha(object(listed.head).sha), outcome: 'refused', reason: error instanceof Error ? error.message : 'Sweep failed' }); }
  }
  return { swept };
}
/** `trusted` is the trunk contract the sweep judged against, read at the trunk tip, or null when it did not load; the daemon's post-merge pass reuses it. */
export async function sweep(options: { repo: string; configPath?: string; dryRun: boolean }): Promise<{ swept: Swept[]; failure: string | null; trusted: Trusted | null }> {
  const repo = repoName(options.repo);
  const t = await contract(repo, options.configPath);
  if ('failure' in t) {
    const { swept } = await eachOpen(repo, string(object(await api(`repos/${repo}`)).default_branch), pr => withoutContract(repo, pr, t.failure, options.dryRun));
    return { swept, failure: t.failure, trusted: null };
  }
  const author = await principal();
  return { ...(await eachOpen(t.repo, t.config.trunk, pr => judge(t.repo, pr, author, options))), failure: null, trusted: t };
}
export async function main(args: string[]): Promise<number> {
  try {
    const { values } = parseArgs({ args, options: { repo: { type: 'string' }, config: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } } });
    if (!values.repo) throw new Error('Usage: converge-sweep --repo owner/repo [--config path] [--dry-run]');
    const result = await sweep({ repo: values.repo, configPath: values.config, dryRun: values['dry-run'] });
    process.stdout.write(JSON.stringify({ swept: result.swept }, null, 2) + '\n');
    if (result.failure) process.stderr.write(result.failure + '\n');
    return result.failure || result.swept.some(s => s.outcome === 'refused') ? 1 : 0;
  } catch (error) { process.stderr.write((error instanceof Error ? error.message : 'Sweep failed') + '\n'); return 1; }
}
