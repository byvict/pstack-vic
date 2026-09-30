import { parseArgs } from 'node:util';
import { integer, jsonHash, object, repoName, sha, string } from './contract.ts';
import { admitPull, api, branchCommits, command, pages, principal, pull, trusted, workflowRun, type Trusted } from './github.ts';
import { verdictGate } from './gate.ts';
import { linearTargets } from './linear-targets.ts';
import { requireLinearPrBody } from './linear-pr-body.ts';
import { passing, protectedObservations, protectedResult, requiredChecks, unfinished } from './protection.ts';
import { dequeue, queueRetry, queueState } from './queue.ts';

/** How the contract's push Tests run and its test job stand at a trunk commit, read the way the arm reads a green trunk: `pending` while the latest run of the commit has not completed, or when there is none yet. */
export async function trunkTests(t: Trusted, commit: string): Promise<'green' | 'pending' | 'run failed' | 'job failed'> {
  const run = await workflowRun(t, commit, 'push');
  if (!run || run.status !== 'completed') return 'pending';
  if (run.conclusion !== 'success') return 'run failed';
  const jobs = (await pages(`repos/${t.repo}/actions/runs/${integer(run.id)}/attempts/${integer(run.run_attempt)}/jobs`, 'jobs')).map(v => object(v));
  return jobs.some(j => j.name === t.config.tests.job && j.conclusion === 'success' && j.head_sha === commit) ? 'green' : 'job failed';
}
async function trunkHealth(t: Trusted, queue: boolean): Promise<void> {
  const tip = sha(object(await api(`repos/${t.repo}/commits/${encodeURIComponent(t.config.trunk)}`)).sha);
  const tests = await trunkTests(t, tip);
  if (queue && tests === 'pending') return;
  if (tests === 'job failed') throw new Error('Trunk test job is not successful at the current tip');
  if (tests !== 'green') throw new Error('Trunk Tests is not successful at the current tip');
}
async function protection(t: Trusted, head: string, pending: boolean): Promise<void> {
  const required = await requiredChecks(t);
  const observed = await protectedObservations(t.repo, head);
  if (!pending) {
    const latestTests = await workflowRun(t, head);
    if (!latestTests || latestTests.status !== 'completed' || latestTests.conclusion !== 'success') throw new Error('Latest exact-head Tests attempt is not successful');
  }
  for (const c of required) {
    if (c.context === 'verdict') { if (c.appId !== null) throw new Error('Verdict context has unsupported app binding'); continue; }
    const result = protectedResult(c, observed);
    if (pending) { if (result.observations.some(check => !passing.includes(check.state) && !unfinished.includes(check.state))) throw new Error('Required protected check failed: ' + c.context); continue; }
    if (!result.found || !result.observations.every(check => passing.includes(check.state))) throw new Error('Required protected check is not successful: ' + c.context);
  }
}
/** The merge states in which `gh pr merge --auto` merges at once instead of enabling auto-merge (gh's `isImmediatelyMergeable`). */
export const MERGES_AT_ONCE = ['clean', 'unstable', 'has_hooks'];
/** The one command that arms. The head pin refuses a head that moved, whether gh enables auto-merge or merges. */
export function armCommand(repo: string, pr: number, head: string): void {
  command('gh', ['pr', 'merge', String(pr), '--repo', repo, '--squash', '--auto', '--match-head-commit', head]);
}
export async function disarm(repo: string, pr: number): Promise<boolean> {
  const removed = await dequeue(repo, pr);
  if (!(await pull(repo, pr)).autoMerge) return removed;
  command('gh', ['pr', 'merge', String(pr), '--repo', repo, '--disable-auto']);
  return true;
}
export async function arm(options: { repo: string; pr: number; head: string; verdict: string; dryRun: boolean; configPath?: string; pending?: boolean }): Promise<{ kind: 'dry-run' | 'armed'; head: string; steps: string[]; rederived: string | null }> {
  const repo = repoName(options.repo);
  const head = sha(options.head);
  if (options.verdict !== 'VERIFIED' || !Number.isSafeInteger(options.pr) || options.pr < 1) throw new Error('Arm requires a PR number and VERIFIED');
  try {
    const t = await trusted(repo, options.configPath ?? '.cursor/converge.json');
    if (options.pending && !t.config.requiredChecks.includes('hold')) throw new Error('Pending arm requires "hold" in requiredChecks');
    const initial = await pull(repo, options.pr);
    admitPull(initial, t.config, head);
    const targets = linearTargets((await branchCommits(repo, t.sha, head)).map(c => c.message));
    requireLinearPrBody({ body: initial.body, targets });
    const queue = await queueState(repo, options.pr);
    await trunkHealth(t, queue.kind !== 'disabled');
    await protection(t, head, options.pending === true);
    const author = await principal();
    const verified = await verdictGate(t, options.pr, head, author);
    if (verified.kind === 'refused') throw new Error(verified.reason);
    const retry = queueRetry(queue, verified);
    if (retry) throw new Error(retry);
    admitPull(await pull(repo, options.pr), t.config, head);
    if (sha(object(await api(`repos/${repo}/commits/${encodeURIComponent(t.config.trunk)}`)).sha) !== t.sha) throw new Error('Trunk moved before arm');
    await trunkHealth(t, queue.kind !== 'disabled');
    await protection(t, head, options.pending === true);
    const again = await verdictGate(t, options.pr, head, author);
    if (again.kind === 'refused') throw new Error(again.reason);
    if (jsonHash(again) !== jsonHash(verified)) throw new Error('Verdict changed before arm');
    const beforeArm = await pull(repo, options.pr);
    admitPull(beforeArm, t.config, head);
    requireLinearPrBody({ body: beforeArm.body, targets });
    const rederived = verified.rederived;
    const steps = ['Read latest push-to-trunk Tests', 'Read live protection and required checks', 'Read trusted exact-head verdict', ...(rederived ? [rederived] : []), 'gh pr merge --squash --auto --match-head-commit ' + head + (options.pending ? ' (checks pending)' : '')];
    if (options.dryRun) return { kind: 'dry-run', head, steps, rederived };
    const currentQueue = await queueState(repo, options.pr);
    const refusal = queueRetry(currentQueue, again);
    if (refusal) throw new Error(refusal);
    if (currentQueue.kind !== 'queued') armCommand(repo, options.pr, head);
    const after = await pull(repo, options.pr);
    if (after.state === 'open') admitPull(after, t.config, head);
    return { kind: 'armed', head, steps, rederived };
  } catch (error) {
    if (!options.dryRun) {
      try { await disarm(repo, options.pr); }
      catch { throw new Error('Arm refused; auto-merge disarm outcome unknown'); }
    }
    throw error;
  }
}
export async function main(args: string[]): Promise<number> {
  try {
    const { values } = parseArgs({ args, options: { repo: { type: 'string' }, pr: { type: 'string' }, head: { type: 'string' }, verdict: { type: 'string' }, config: { type: 'string' }, pending: { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false } } });
    if (!values.repo || !values.pr || !values.head || !values.verdict || !/^\d+$/.test(values.pr)) throw new Error('Usage: converge-arm --repo owner/repo --pr N --head SHA --verdict VERIFIED [--pending] [--dry-run]');
    const result = await arm({ repo: values.repo, pr: Number(values.pr), head: values.head, verdict: values.verdict, dryRun: values['dry-run'], configPath: values.config, pending: values.pending });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return 0;
  } catch (error) { process.stderr.write((error instanceof SyntaxError ? 'Malformed JSON input' : error instanceof Error ? error.message : 'Arm failed') + '\n'); return 1; }
}
