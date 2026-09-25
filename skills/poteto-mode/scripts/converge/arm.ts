import { parseArgs } from 'node:util';
import { array, integer, jsonHash, object, repoName, sha, string, type Dossier } from './contract.ts';
import { admitPull, api, checks, command, comments, isPublication, pages, principal, pull, snapshot, trusted, verdictStatus, workflowRun, type Trusted } from './github.ts';
import { decide, linkedDossier, retainedLanes } from './publish.ts';
import { analyze } from './reconcile.ts';

async function trunkHealth(t: Trusted): Promise<void> {
  const tip = sha(object(await api(`repos/${t.repo}/commits/${encodeURIComponent(t.config.trunk)}`)).sha);
  const run = await workflowRun(t, tip, 'push');
  if (!run || run.status !== 'completed' || run.conclusion !== 'success') throw new Error('Trunk Tests is not successful at the current tip');
  const jobs = (await pages(`repos/${t.repo}/actions/runs/${integer(run.id)}/attempts/${integer(run.run_attempt)}/jobs`, 'jobs')).map(v => object(v));
  if (!jobs.some(j => j.name === t.config.tests.job && j.conclusion === 'success' && j.head_sha === tip)) throw new Error('Trunk test job is not successful at the current tip');
}
const unfinished = ['queued', 'in_progress', 'waiting', 'requested', 'pending'];
async function protection(t: Trusted, head: string, pending: boolean): Promise<void> {
  const protection = object(await api(`repos/${t.repo}/branches/${encodeURIComponent(t.config.trunk)}/protection`));
  const statusChecks = object(protection.required_status_checks, 'required status checks');
  const required = array(statusChecks.checks).map(v => { const c = object(v); return { context: string(c.context), appId: c.app_id === null || c.app_id === -1 ? null : integer(c.app_id) }; });
  for (const context of array(statusChecks.contexts).map(v => string(v))) if (!required.some(c => c.context === context)) required.push({ context, appId: null });
  const rules = array(await api(`repos/${t.repo}/rules/branches/${encodeURIComponent(t.config.trunk)}`)).map(v => object(v));
  for (const rule of rules) if (rule.type === 'required_status_checks') {
    for (const v of array(object(rule.parameters).required_status_checks)) {
      const c = object(v);
      required.push({ context: string(c.context), appId: c.integration_id === null || c.integration_id === undefined ? null : integer(c.integration_id) });
    }
  }
  for (const context of t.config.requiredChecks) if (!required.some(c => c.context === context)) throw new Error('Branch protection missing required context: ' + context);
  const observed = await checks(t.repo, head);
  if (!pending) {
    const latestTests = await workflowRun(t, head);
    if (!latestTests || latestTests.status !== 'completed' || latestTests.conclusion !== 'success') throw new Error('Latest exact-head Tests attempt is not successful');
  }
  for (const c of required) {
    if (c.context === 'verdict') { if (c.appId !== null) throw new Error('Verdict context has unsupported app binding'); continue; }
    const match = observed.filter(check => check.context === c.context && check.head === head && (c.appId === null || c.appId === check.appId));
    if (pending) { if (match.some(check => check.state !== 'success' && !unfinished.includes(check.state))) throw new Error('Required protected check failed: ' + c.context); continue; }
    if (!match.some(check => check.state === 'success')) throw new Error('Required protected check is not successful: ' + c.context);
  }
}
interface Verified { dossier: Dossier; url: string; fingerprint: string }
/** A pre-pr certificate is assembled at one trunk tip, and its publication decided over the PR text of that moment; its lanes never read PR text. So every arm re-derives it: the certificate authorizes merge only while the same patch under the same policy re-derives VERIFIED from its retained coverage, over the current text, at the tip the arm reads. That binds the trunk tip at arm time, not the tip the merge lands on. */
async function rederivePrePr(t: Trusted, pr: number, v: Verified): Promise<void> {
  const r = v.dossier.round;
  const current = await snapshot(t.repo, pr, r.configPath, 'pre-pr');
  if (current.trusted.sha !== t.sha) throw new Error('Trunk moved during re-derivation');
  if (current.inputFingerprint !== v.fingerprint) throw new Error('PR text changed during re-derivation');
  const report = analyze(current, { id: r.id, configPath: r.configPath, execution: 'pre-pr' });
  if (report.round.head !== r.head || report.round.patch_id !== r.patch_id || report.round.verificationDigest !== r.verificationDigest) throw new Error('Certificate patch or policy differs at trunk tip ' + t.sha);
  const decision = decide(report, retainedLanes(report.lanes, v.dossier, v.url));
  if (decision.verdict !== 'VERIFIED') throw new Error(`Certificate is no longer VERIFIED at trunk tip ${t.sha}: ${decision.verdict}`);
}
async function verdict(t: Trusted, pr: number, head: string, author: number): Promise<Verified> {
  const status = await verdictStatus(t.repo, pr, head, author);
  if (status.kind !== 'trusted') throw new Error(status.reason);
  const { dossier, commentId } = await linkedDossier(t.repo, pr, head, author, status.commentId);
  const r = dossier.round;
  if (r.execution === 'converge' && r.contract !== t.sha) throw new Error('Verdict identity or execution does not authorize merge');
  const all = await comments(t.repo, pr);
  const publications = all.filter(c => isPublication(c, author));
  const newest = publications.sort((a, b) => integer(b.id) - integer(a.id))[0];
  if (!newest || newest.id !== commentId) throw new Error('A newer converge round supersedes this verdict');
  const live = await pull(t.repo, pr);
  const fingerprint = jsonHash({ body: live.body, comments: all.filter(c => !isPublication(c, author)).map(c => [c.id, c.body, c.updated_at]) });
  if (r.execution === 'converge' && fingerprint !== dossier.inputFingerprint) throw new Error('PR text changed after verification');
  return { dossier, url: status.url, fingerprint };
}
export async function disarm(repo: string, pr: number): Promise<boolean> {
  if (!(await pull(repo, pr)).autoMerge) return false;
  command('gh', ['pr', 'merge', String(pr), '--repo', repo, '--disable-auto']);
  return true;
}
export async function arm(options: { repo: string; pr: number; head: string; verdict: string; dryRun: boolean; configPath?: string; pending?: boolean }): Promise<{ kind: 'dry-run' | 'armed'; head: string; steps: string[] }> {
  const repo = repoName(options.repo);
  const head = sha(options.head);
  if (options.verdict !== 'VERIFIED' || !Number.isSafeInteger(options.pr) || options.pr < 1) throw new Error('Arm requires a PR number and VERIFIED');
  try {
    const t = await trusted(repo, options.configPath ?? '.cursor/converge.json');
    admitPull(await pull(repo, options.pr), t.config, head);
    await trunkHealth(t);
    await protection(t, head, options.pending === true);
    const author = await principal();
    const verified = await verdict(t, options.pr, head, author);
    admitPull(await pull(repo, options.pr), t.config, head);
    if (sha(object(await api(`repos/${repo}/commits/${encodeURIComponent(t.config.trunk)}`)).sha) !== t.sha) throw new Error('Trunk moved before arm');
    const r = verified.dossier.round;
    if (r.execution === 'pre-pr') await rederivePrePr(t, options.pr, verified);
    const rederived = r.execution === 'pre-pr' ? 'Re-derived the pre-pr verdict' + (r.contract === t.sha ? '' : ` from contract ${r.contract}`) + ` at trunk tip ${t.sha}` + (verified.fingerprint === verified.dossier.inputFingerprint ? '' : ' over changed PR text') : null;
    await trunkHealth(t);
    await protection(t, head, options.pending === true);
    if (jsonHash(await verdict(t, options.pr, head, author)) !== jsonHash(verified)) throw new Error('Verdict changed before arm');
    admitPull(await pull(repo, options.pr), t.config, head);
    const steps = ['Read latest push-to-trunk Tests', 'Read live protection and required checks', 'Read trusted exact-head verdict', ...(rederived ? [rederived] : []), 'gh pr merge --squash --auto --match-head-commit ' + head + (options.pending ? ' (checks pending)' : '')];
    if (options.dryRun) return { kind: 'dry-run', head, steps };
    command('gh', ['pr', 'merge', String(options.pr), '--repo', repo, '--squash', '--auto', '--match-head-commit', head]);
    const after = await pull(repo, options.pr);
    if (after.state === 'open') admitPull(after, t.config, head);
    return { kind: 'armed', head, steps };
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
