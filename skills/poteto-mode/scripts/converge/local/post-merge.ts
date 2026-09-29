import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trunkTests } from '../arm.ts';
import { array, instant, integer, object, oneOf, repoName, sha, string, type PostMerge, type Run } from '../contract.ts';
import { api, pages, type Trusted } from '../github.ts';
import type { LocalConfig, RepoConfig } from './config.ts';
import { writeJsonFile } from './ledger.ts';
import { LEASE_TTL_HOURS, readLease, releaseLease, takeLease } from './lease.ts';
import { exitStatus, KILL_GRACE_MS } from './raiz.ts';

/** More new trunk commits than this since the handled tip fail the pass instead of replaying them: the daemon was off or stuck, and someone should look. */
export const POST_MERGE_MAX_COMMITS = 50;
export const POST_MERGE_RUN_MINUTES = 20;
export const POST_MERGE_DEFER_HOURS = 24;
/** sysexits' EX_TEMPFAIL: the command asks for another attempt on the next tick. */
export const TEMPFAIL = 75;
export const postMergeOutcomes = ['done', 'deferred', 'failed'] as const;
export type PostMergeOutcome = typeof postMergeOutcomes[number];
export interface PostMergeRun { name: string; exitCode: number | null; logFile: string }
export interface PostMergeAttempt { n: number; startedAt: string; endedAt: string; runs: PostMergeRun[]; outcome: PostMergeOutcome; reason: string; runDirectory: string }
export interface PostMergeLedger { schemaVersion: 1; repo: string; commit: string; pr: number | null; firstAttemptAt: string; attempts: PostMergeAttempt[] }
export interface PostMergeState { schemaVersion: 1; repo: string; tip: string }
/** One commit as a pass left it: `waiting` started nothing this pass (not ready, or no checkout), `dry-run` names the runs it would start. */
export interface Handled { commit: string; pr: number | null; outcome: PostMergeOutcome | 'waiting' | 'dry-run'; reason: string; ledger: string; runDirectory: string | null }
/** `tip` is the trunk tip the pass worked toward, `handled` the tip it leaves stored, and `note` why it ran no commit: a first pass, or another holder's lease. */
export interface PostMergeReport { tip: string; handled: string | null; note: string | null; commits: Handled[]; errors: string[] }
/** `runCapMs` replaces the 20-minute cap in tests; `env` is the environment the commands start from, the tick's by default. */
export interface PostMergeOptions { dryRun: boolean; leaseBy: string; runCapMs?: number; env?: NodeJS.ProcessEnv }
interface Pass { config: LocalConfig; repo: RepoConfig; t: Trusted; postMerge: PostMerge; options: PostMergeOptions; errors: string[] }

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function slug(repo: string): string { return repoName(repo).replace('/', '-'); }
export function postMergeStateFile(stateDirectory: string, repo: string): string { return join(stateDirectory, 'post-merge', `${slug(repo)}.json`); }
export function postMergeLedgerFile(stateDirectory: string, repo: string, commit: string): string { return join(stateDirectory, 'post-merge', slug(repo), `${sha(commit)}.json`); }
/** Beside the branch leases, so `status` lists it; a branch lease is named `<owner>-<repo>-<branch>`, and no owner starts with `post-merge-`. */
export function postMergeLeaseFile(stateDirectory: string, repo: string): string { return join(stateDirectory, 'leases', `post-merge--${slug(repo)}.json`); }
function readJson<T>(file: string, parse: (value: unknown) => T, label: string): T | null {
  try { return parse(JSON.parse(readFileSync(file, 'utf8'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Invalid ${label} ${file}: ${message(error)}`);
  }
}
function parseState(value: unknown): PostMergeState {
  const v = object(value, 'post-merge state');
  if (v.schemaVersion !== 1) throw new Error('Unknown post-merge state schema');
  return { schemaVersion: 1, repo: repoName(v.repo), tip: sha(v.tip) };
}
function parseAttempt(value: unknown): PostMergeAttempt {
  const v = object(value, 'post-merge attempt');
  return { n: integer(v.n), startedAt: instant(v.startedAt, 'attempt start'), endedAt: instant(v.endedAt, 'attempt end'),
    runs: array(v.runs).map(raw => { const r = object(raw, 'post-merge run'); return { name: string(r.name), exitCode: r.exitCode === null ? null : integer(r.exitCode), logFile: string(r.logFile) }; }),
    outcome: oneOf(v.outcome, postMergeOutcomes), reason: string(v.reason), runDirectory: string(v.runDirectory) };
}
function parseLedger(value: unknown): PostMergeLedger {
  const v = object(value, 'post-merge ledger');
  if (v.schemaVersion !== 1) throw new Error('Unknown post-merge ledger schema');
  return { schemaVersion: 1, repo: repoName(v.repo), commit: sha(v.commit), pr: v.pr === null ? null : integer(v.pr), firstAttemptAt: instant(v.firstAttemptAt, 'first attempt'), attempts: array(v.attempts).map(parseAttempt) };
}
export function readPostMergeState(file: string): PostMergeState | null { return readJson(file, parseState, 'post-merge state file'); }
export function readPostMergeLedger(file: string): PostMergeLedger | null { return readJson(file, parseLedger, 'post-merge ledger'); }

/** One command, its argv split on single spaces, without a shell, in the tick's process group: a bootout of the sweep job ends it with the tick. */
function runCommand(argv: string[], options: { cwd: string; env: NodeJS.ProcessEnv; logFile: string; capMs: number }): Promise<{ exitCode: number | null; timedOut: boolean }> {
  return new Promise(resolve => {
    const log = openSync(options.logFile, 'a', 0o600);
    let child: ChildProcess;
    try { child = spawn(argv[0] ?? '', argv.slice(1), { cwd: options.cwd, env: options.env, stdio: ['ignore', log, log] }); }
    finally { closeSync(log); }
    let timedOut = false;
    let done = false;
    let escalation: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      escalation = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
      escalation.unref();
    }, options.capMs);
    const finish = (exitCode: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(escalation);
      resolve({ exitCode, timedOut });
    };
    child.on('error', () => { if (child.pid === undefined) finish(null); });
    child.on('exit', (code, signal) => finish(exitStatus(code, signal)));
  });
}
/** The runs in order; the first that does not exit 0 ends the attempt. */
async function runAll(runs: Run[], options: { cwd: string; runDirectory: string; env: NodeJS.ProcessEnv; capMs: number }): Promise<{ runs: PostMergeRun[]; outcome: PostMergeOutcome; reason: string }> {
  const done: PostMergeRun[] = [];
  for (const run of runs) {
    const logFile = join(options.runDirectory, `${run.name}.log`);
    const exit = await runCommand(run.command.split(' '), { cwd: options.cwd, env: options.env, logFile, capMs: options.capMs });
    done.push({ name: run.name, exitCode: exit.exitCode, logFile });
    if (exit.timedOut) return { runs: done, outcome: 'failed', reason: 'timeout' };
    if (exit.exitCode === null) return { runs: done, outcome: 'failed', reason: `${run.name} did not start` };
    if (exit.exitCode === TEMPFAIL) return { runs: done, outcome: 'deferred', reason: `${run.name} exited ${TEMPFAIL}` };
    if (exit.exitCode !== 0) return { runs: done, outcome: 'failed', reason: `${run.name} exited ${exit.exitCode}` };
  }
  return { runs: done, outcome: 'done', reason: '' };
}
/** In the primary checkout: a fetch of one commit, and a worktree under RUN; never a branch there. */
function git(checkout: string, args: string[]): void {
  const result = spawnSync('git', ['-C', checkout, ...args], { encoding: 'utf8', timeout: 300_000 });
  if (result.error || result.status !== 0) throw new Error(`git ${args[0]} failed: ${(result.stderr || result.error?.message || '').trim()}`);
}
/** The PR that merged the commit into trunk, or null for a direct push. */
async function mergedPull(t: Trusted, commit: string): Promise<number | null> {
  const found = (await pages(`repos/${t.repo}/commits/${commit}/pulls`)).map(v => object(v, 'pull')).find(p => typeof p.merged_at === 'string' && object(p.base, 'pull base').ref === t.config.trunk);
  return found ? integer(found.number) : null;
}
/** Why the commit cannot run yet, or null when it can. `error` marks a wait the tick reports: a finished run or test job without success, which only a rerun ends. */
async function notReady(t: Trusted, postMerge: PostMerge, commit: string): Promise<{ reason: string; error: boolean } | null> {
  if (postMerge.after === 'none') return null;
  const tests = await trunkTests(t, commit);
  if (tests === 'green') return null;
  if (tests === 'pending') return { reason: `${t.config.tests.workflow} has not completed on the commit`, error: false };
  return { reason: `${tests === 'run failed' ? t.config.tests.workflow : t.config.tests.job} did not succeed on the commit`, error: true };
}
function failureComment(ledger: PostMergeLedger, file: string): string {
  const last = ledger.attempts[ledger.attempts.length - 1];
  return [`The local converge daemon's post-merge stopped on commit ${ledger.commit}: ${last?.reason}.`, '', 'Runs:', ...(last?.runs ?? []).map(r => `- ${r.name} ${r.exitCode === null ? 'did not start' : `exited ${r.exitCode}`} (${r.logFile})`), '', `Later trunk commits wait. Delete \`${file}\` to retry.`].join('\n');
}
function runDirectory(repo: string, commit: string, n: number): string {
  return join(tmpdir(), 'converge-local', 'post-merge', `${slug(repo)}-${commit.slice(0, 8)}-${n}-${Math.floor(Date.now() / 1000)}`);
}
/** One attempt on a commit: readiness, its PR, a detached worktree of it, the runs, the ledger, and for a failure one comment on the merged PR. A checkout that fails records nothing: the machine, not the commit, is at fault, and the next pass tries again. */
async function attempt(p: Pass, commit: string, ledger: PostMergeLedger | null): Promise<Handled> {
  const file = postMergeLedgerFile(p.config.stateDirectory, p.repo.repo, commit);
  const waiting = await notReady(p.t, p.postMerge, commit);
  if (waiting) {
    if (waiting.error) p.errors.push(`${commit} waits: ${waiting.reason}`);
    return { commit, pr: ledger?.pr ?? null, outcome: 'waiting', reason: waiting.reason, ledger: file, runDirectory: null };
  }
  const pr = ledger ? ledger.pr : await mergedPull(p.t, commit);
  const n = (ledger?.attempts.length ?? 0) + 1;
  const run = runDirectory(p.repo.repo, commit, n);
  if (p.options.dryRun) return { commit, pr, outcome: 'dry-run', reason: p.postMerge.runs.map(r => `${r.name}: ${r.command}`).join('; '), ledger: file, runDirectory: run };
  mkdirSync(run, { recursive: true, mode: 0o700 });
  const checkout = join(run, 'checkout');
  try {
    git(p.repo.checkout, ['fetch', '--quiet', 'origin', commit]);
    git(p.repo.checkout, ['worktree', 'add', '--quiet', '--detach', checkout, commit]);
  } catch (error) {
    p.errors.push(`${commit}: checkout failed: ${message(error)}`);
    return { commit, pr, outcome: 'waiting', reason: `checkout failed: ${message(error)}`, ledger: file, runDirectory: run };
  }
  const startedAt = new Date().toISOString();
  const env = { ...(p.options.env ?? process.env), PSTACK_REPO: p.repo.repo, PSTACK_COMMIT: commit, PSTACK_PR: pr === null ? '' : String(pr), PSTACK_CHECKOUT: p.repo.checkout, PSTACK_PLUGIN_DIR: p.config.pluginDir };
  let result: Awaited<ReturnType<typeof runAll>>;
  try { result = await runAll(p.postMerge.runs, { cwd: checkout, runDirectory: run, env, capMs: p.options.runCapMs ?? POST_MERGE_RUN_MINUTES * 60_000 }); }
  finally {
    try { git(p.repo.checkout, ['worktree', 'remove', '--force', checkout]); }
    catch (error) { p.errors.push(`${commit}: worktree not removed: ${message(error)}`); }
  }
  const endedAt = new Date().toISOString();
  const firstAttemptAt = ledger?.firstAttemptAt ?? startedAt;
  if (result.outcome === 'deferred' && Date.parse(endedAt) - Date.parse(firstAttemptAt) >= POST_MERGE_DEFER_HOURS * 3_600_000) result = { ...result, outcome: 'failed', reason: `${result.reason} for ${POST_MERGE_DEFER_HOURS} hours since ${firstAttemptAt}` };
  const updated: PostMergeLedger = { schemaVersion: 1, repo: p.repo.repo, commit, pr, firstAttemptAt, attempts: [...(ledger?.attempts ?? []), { n, startedAt, endedAt, runs: result.runs, outcome: result.outcome, reason: result.reason, runDirectory: run }] };
  writeJsonFile(file, updated);
  if (result.outcome === 'failed') {
    p.errors.push(`${commit} failed: ${result.reason}; delete ${file} to retry`);
    if (pr !== null) {
      try { await api(`repos/${p.t.repo}/issues/${pr}/comments`, { body: failureComment(updated, file) }); }
      catch (error) { p.errors.push(`${commit}: failure comment failed: ${message(error)}`); }
    }
  }
  return { commit, pr, outcome: result.outcome, reason: result.reason, ledger: file, runDirectory: run };
}
/** The queue's next commit: a ledger that ends `done` only advances, one that ends `failed` stops the queue with its error again, anything else gets an attempt. */
async function next(p: Pass, commit: string): Promise<Handled> {
  const file = postMergeLedgerFile(p.config.stateDirectory, p.repo.repo, commit);
  const ledger = readPostMergeLedger(file);
  const last = ledger?.attempts[ledger.attempts.length - 1];
  if (ledger && last?.outcome === 'done') return { commit, pr: ledger.pr, outcome: 'done', reason: 'done on an earlier pass', ledger: file, runDirectory: last.runDirectory };
  if (ledger && last?.outcome === 'failed') {
    p.errors.push(`${commit} failed: ${last.reason}; delete ${file} to retry`);
    return { commit, pr: ledger.pr, outcome: 'failed', reason: last.reason, ledger: file, runDirectory: last.runDirectory };
  }
  return attempt(p, commit, ledger);
}
/** The trunk commits after `from` up to the tip, oldest first, along the first parent. A tip that does not descend from `from`, a compare that lists fewer commits than it counts, or more than POST_MERGE_MAX_COMMITS commits fail the pass before anything runs. */
async function newCommits(t: Trusted, from: string, stateFile: string): Promise<string[]> {
  const reset = `delete ${stateFile} to start again from the current tip`;
  const compared = object(await api(`repos/${t.repo}/compare/${from}...${t.sha}?per_page=100`), 'compare');
  if (compared.status !== 'ahead') throw new Error(`trunk tip ${t.sha} does not descend from the handled tip ${from}; ${reset}`);
  const listed = array(compared.commits).map(v => object(v, 'commit'));
  const total = integer(compared.total_commits);
  if (total !== listed.length) throw new Error(`the compare from ${from} lists ${listed.length} of ${total} commits; ${reset}`);
  const parents = new Map(listed.map(c => [sha(c.sha), array(c.parents).map(parent => sha(object(parent, 'parent').sha))]));
  const chain: string[] = [];
  for (let at = t.sha; at !== from;) {
    if (chain.length === POST_MERGE_MAX_COMMITS) throw new Error(`more than ${POST_MERGE_MAX_COMMITS} trunk commits since the handled tip ${from}; ${reset}`);
    const first = parents.get(at)?.[0];
    if (first === undefined) throw new Error(`the first-parent chain from ${t.sha} does not reach the handled tip ${from}; ${reset}`);
    chain.push(at);
    at = first;
  }
  return chain.reverse();
}
/** Why another holder's valid lease keeps this holder off the repository's pass, or null. */
function otherHolder(stateDirectory: string, repo: string, by: string): string | null {
  const lease = readLease(postMergeLeaseFile(stateDirectory, repo));
  return lease && lease.by !== by ? `post-merge of ${repo} is leased by ${lease.by} until ${lease.expiresAt}` : null;
}
/** Runs `work` under the repository's pass lease, bound to this pid; a dry run takes none. */
async function leased(p: Pass, work: () => Promise<void>): Promise<void> {
  if (p.options.dryRun) return work();
  const file = postMergeLeaseFile(p.config.stateDirectory, p.repo.repo);
  takeLease(file, { by: p.options.leaseBy, ttlHours: LEASE_TTL_HOURS, pid: process.pid });
  try { await work(); }
  finally {
    try { releaseLease(file, p.options.leaseBy); }
    catch (error) { p.errors.push(message(error)); }
  }
}
/** The sweep tick's pass over one repository whose trunk contract has `postMerge`. It never throws: a failure lands in `errors`, and the stored tip stays where it was. */
export async function postMergePass(config: LocalConfig, repo: RepoConfig, t: Trusted, postMerge: PostMerge, options: PostMergeOptions): Promise<PostMergeReport> {
  const report: PostMergeReport = { tip: t.sha, handled: null, note: null, commits: [], errors: [] };
  const p: Pass = { config, repo, t, postMerge, options, errors: report.errors };
  const stateFile = postMergeStateFile(config.stateDirectory, repo.repo);
  try {
    const holder = options.dryRun ? null : otherHolder(config.stateDirectory, repo.repo, options.leaseBy);
    if (holder) { report.note = holder; return report; }
    await leased(p, async () => {
      const stored = readPostMergeState(stateFile);
      if (!stored) {
        if (options.dryRun) { report.note = 'first pass: would store the trunk tip and run nothing'; return; }
        writeJsonFile(stateFile, { schemaVersion: 1, repo: repo.repo, tip: t.sha });
        report.handled = t.sha;
        report.note = 'first pass: stored the trunk tip and ran nothing';
        return;
      }
      report.handled = stored.tip;
      if (stored.tip === t.sha) return;
      for (const commit of await newCommits(t, stored.tip, stateFile)) {
        const handled = await next(p, commit);
        report.commits.push(handled);
        if (handled.outcome !== 'done') return;
        if (!options.dryRun) writeJsonFile(stateFile, { schemaVersion: 1, repo: repo.repo, tip: commit });
        report.handled = commit;
      }
    });
  } catch (error) { report.errors.push(message(error)); }
  return report;
}
