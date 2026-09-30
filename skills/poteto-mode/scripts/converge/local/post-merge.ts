import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trunkTests } from '../arm.ts';
import { array, instant, integer, object, oneOf, repoName, sha, string, type PostMerge, type Run } from '../contract.ts';
import { api, pages, type Trusted } from '../github.ts';
import type { LocalConfig, RepoConfig } from './config.ts';
import { writeJsonFile } from './ledger.ts';
import { LEASE_TTL_HOURS, readLease, releaseLease, takeLease } from './lease.ts';
import { notify } from './notify.ts';
import { exitStatus, KILL_GRACE_MS, raizLane } from './raiz.ts';
import { parseLinearCheckpoint, reconcileLinear, type LinearCheckpoint, type LinearResult } from './linear.ts';
import { admitLinearMerge } from './linear-trust.ts';

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
export interface PostMergeCheckpoint { commands: { name: string; command: string; logFile: string }[]; linear: LinearCheckpoint | null }
export interface PostMergeLedger { schemaVersion: 1; repo: string; commit: string; pr: number | null; firstAttemptAt: string; attempts: PostMergeAttempt[]; checkpoint?: PostMergeCheckpoint }
export interface PostMergeState { schemaVersion: 1; repo: string; tip: string }
/** One commit as a pass left it: `waiting` started nothing this pass (not ready, or no checkout), `dry-run` names the runs it would start. */
export interface Handled { commit: string; pr: number | null; outcome: PostMergeOutcome | 'waiting' | 'dry-run'; reason: string; ledger: string; runDirectory: string | null }
/** `tip` is the trunk tip the pass worked toward, `handled` the tip it leaves stored, and `note` why it ran no commit: a first pass, or another holder's lease. */
export interface PostMergeReport { tip: string; handled: string | null; note: string | null; commits: Handled[]; errors: string[] }
/** `runCapMs` replaces the 20-minute cap in tests; `env` is the environment the commands start from, the tick's by default. */
export interface PostMergeOptions { dryRun: boolean; leaseBy: string; runCapMs?: number; env?: NodeJS.ProcessEnv; planPath?: string; manual?: boolean }
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
  return { schemaVersion: 1, repo: repoName(v.repo), commit: sha(v.commit), pr: v.pr === null ? null : integer(v.pr), firstAttemptAt: instant(v.firstAttemptAt, 'first attempt'), attempts: array(v.attempts).map(parseAttempt), ...(v.checkpoint === undefined ? {} : { checkpoint: parseCheckpoint(v.checkpoint) }) };
}
function parseCheckpoint(value: unknown): PostMergeCheckpoint {
  const v = object(value, 'post-merge checkpoint');
  return { commands: array(v.commands).map(raw => { const r = object(raw); return { name: string(r.name), command: string(r.command), logFile: string(r.logFile) }; }), linear: v.linear === null ? null : parseLinearCheckpoint(v.linear) };
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
async function runAll(runs: Run[], options: { cwd: string; runDirectory: string; env: NodeJS.ProcessEnv; capMs: number; checkpoint: PostMergeCheckpoint; onSuccess: () => void }): Promise<{ runs: PostMergeRun[]; outcome: PostMergeOutcome; reason: string }> {
  const done: PostMergeRun[] = [];
  for (const run of runs) {
    const prior = options.checkpoint.commands.find(r => r.name === run.name && r.command === run.command);
    if (prior) { done.push({ name: run.name, exitCode: 0, logFile: prior.logFile }); continue; }
    const logFile = join(options.runDirectory, `${run.name}.log`);
    const exit = await runCommand(run.command.split(' '), { cwd: options.cwd, env: options.env, logFile, capMs: options.capMs });
    done.push({ name: run.name, exitCode: exit.exitCode, logFile });
    if (exit.timedOut) return { runs: done, outcome: 'failed', reason: 'timeout' };
    if (exit.exitCode === null) return { runs: done, outcome: 'failed', reason: `${run.name} did not start` };
    if (exit.exitCode === TEMPFAIL) return { runs: done, outcome: 'deferred', reason: `${run.name} exited ${TEMPFAIL}` };
    if (exit.exitCode !== 0) return { runs: done, outcome: 'failed', reason: `${run.name} exited ${exit.exitCode}` };
    options.checkpoint.commands.push({ ...run, logFile });
    options.onSuccess();
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
function red(t: Trusted, tests: 'run failed' | 'job failed'): string { return `${tests === 'run failed' ? t.config.tests.workflow : t.config.tests.job} did not succeed on the commit`; }
/** Why the commit cannot run yet, or null when it can. `error` marks a wait the tick reports: a finished run or test job without success, which only a rerun ends. */
async function notReady(t: Trusted, postMerge: PostMerge, commit: string): Promise<{ reason: string; error: boolean } | null> {
  if (postMerge.after === 'none') return null;
  const tests = await trunkTests(t, commit);
  if (tests === 'green') return null;
  if (tests === 'pending') return { reason: `${t.config.tests.workflow} has not completed on the commit`, error: false };
  return { reason: red(t, tests), error: true };
}
export function redTrunkFile(stateDirectory: string, repo: string, commit: string): string { return join(stateDirectory, 'red-trunk', slug(repo), `${sha(commit)}.json`); }
/** One notification per red trunk commit. The record goes first: a write that fails leaves the notification to the next tick, where a notification sent first would ring on every tick. */
async function notifyRedTrunk(stateDirectory: string, t: Trusted, commit: string, reason: string, errors: string[]): Promise<void> {
  const file = redTrunkFile(stateDirectory, t.repo, commit);
  if (existsSync(file)) return;
  let pr: number | null;
  try {
    pr = await mergedPull(t, commit);
    writeJsonFile(file, { schemaVersion: 1, repo: t.repo, commit, pr, reason, notifiedAt: new Date().toISOString() });
  } catch (error) { errors.push(`${commit}: red trunk not recorded: ${message(error)}`); return; }
  const cause = notify({ title: 'Converge local', subtitle: t.repo, body: `Trunk red at ${commit.slice(0, 8)}: ${reason}${pr === null ? '' : ` (PR #${pr})`}` });
  if (cause) errors.push(`${commit}: notification failed: ${cause}`);
}
/** `reason` is null while the tip is green or pending. */
export interface RedTrunk { commit: string; reason: string | null; errors: string[] }
/** The sweep tick's look at the trunk tip of a repository whose contract has no `postMerge`, where no pass reads trunk's push Tests: a red tip notifies once, and adds no error, since the sweep already refuses every arm on a red trunk. */
export async function redTrunkTip(stateDirectory: string, t: Trusted, dryRun: boolean): Promise<RedTrunk> {
  const report: RedTrunk = { commit: t.sha, reason: null, errors: [] };
  try {
    const tests = await trunkTests(t, t.sha);
    if (tests !== 'run failed' && tests !== 'job failed') return report;
    report.reason = red(t, tests);
    if (!dryRun) await notifyRedTrunk(stateDirectory, t, t.sha, report.reason, report.errors);
  } catch (error) { report.errors.push(`red trunk: ${message(error)}`); }
  return report;
}
function retryCommand(repo: string, commit: string): string { return `converge-local post-merge --repo ${repo} --commit ${commit}`; }
function failureComment(ledger: PostMergeLedger): string {
  const last = ledger.attempts[ledger.attempts.length - 1];
  return [`The local converge daemon's post-merge stopped on commit ${ledger.commit}: ${last?.reason}.`, '', 'Runs:', ...(last?.runs ?? []).map(r => `- ${r.name} ${r.exitCode === null ? 'did not start' : `exited ${r.exitCode}`} (${r.logFile})`), '', `Later trunk commits wait. Retry with \`${retryCommand(ledger.repo, ledger.commit)}\`, retaining the ledger.`].join('\n');
}
function runDirectory(repo: string, commit: string, n: number): string {
  return join(tmpdir(), 'converge-local', 'post-merge', `${slug(repo)}-${commit.slice(0, 8)}-${n}-${Math.floor(Date.now() / 1000)}`);
}
/** A checkout that fails records nothing: the machine, not the commit, is at fault, and the next pass tries again. */
async function attempt(p: Pass, commit: string, ledger: PostMergeLedger | null): Promise<Handled> {
  const file = postMergeLedgerFile(p.config.stateDirectory, p.repo.repo, commit);
  const waiting = await notReady(p.t, p.postMerge, commit);
  if (waiting) {
    if (waiting.error) {
      p.errors.push(`${commit} waits: ${waiting.reason}`);
      if (!p.options.dryRun) await notifyRedTrunk(p.config.stateDirectory, p.t, commit, waiting.reason, p.errors);
    }
    return { commit, pr: ledger?.pr ?? null, outcome: 'waiting', reason: waiting.reason, ledger: file, runDirectory: null };
  }
  const pr = ledger ? ledger.pr : await mergedPull(p.t, commit);
  const n = (ledger?.attempts.length ?? 0) + 1;
  const run = runDirectory(p.repo.repo, commit, n);
  if (p.options.dryRun) {
    const commands = p.postMerge.runs.map(r => `${r.name}: ${r.command}`).join('; ');
    const linear = p.postMerge.linear ? await linearStep(p, commit, file, p.repo.checkout, run, ledger?.checkpoint?.linear ?? null, () => undefined) : null;
    return { commit, pr, outcome: 'dry-run', reason: commands + (linear ? `${commands ? '; ' : ''}linear: ${JSON.stringify(linear)}` : ''), ledger: file, runDirectory: run };
  }
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
  const checkpoint = ledger?.checkpoint ?? { commands: [], linear: null };
  const firstAttemptAt = ledger?.firstAttemptAt ?? startedAt;
  const saved: PostMergeLedger = { schemaVersion: 1, repo: p.repo.repo, commit, pr, firstAttemptAt, attempts: ledger?.attempts ?? [], checkpoint };
  const save = () => writeJsonFile(file, saved);
  let result: Awaited<ReturnType<typeof runAll>>;
  try {
    result = await runAll(p.postMerge.runs, { cwd: checkout, runDirectory: run, env, capMs: p.options.runCapMs ?? POST_MERGE_RUN_MINUTES * 60_000, checkpoint, onSuccess: save });
    if (result.outcome === 'done' && p.postMerge.linear) {
      const linear = await linearStep(p, commit, file, checkout, run, checkpoint.linear, value => { checkpoint.linear = value; save(); });
      const logFile = linear.logs.at(-1) ?? join(run, 'linear.json');
      writeJsonFile(join(run, 'linear.json'), linear);
      let outcome: PostMergeOutcome;
      switch (linear.kind) {
        case 'deferred': outcome = 'deferred'; break;
        case 'failed': case 'refused': outcome = 'failed'; break;
        case 'done': case 'dry-run': outcome = 'done'; break;
        default: { const exhaustive: never = linear.kind; outcome = exhaustive; }
      }
      result = { runs: [...result.runs, { name: 'linear', exitCode: outcome === 'deferred' ? TEMPFAIL : outcome === 'failed' ? 1 : 0, logFile }], outcome, reason: `linear: ${linear.reason}` };
    }
  }
  finally {
    try { git(p.repo.checkout, ['worktree', 'remove', '--force', checkout]); }
    catch (error) { p.errors.push(`${commit}: worktree not removed: ${message(error)}`); }
  }
  const endedAt = new Date().toISOString();
  if (result.outcome === 'deferred' && Date.parse(endedAt) - Date.parse(firstAttemptAt) >= POST_MERGE_DEFER_HOURS * 3_600_000) result = { ...result, outcome: 'failed', reason: `${result.reason} for ${POST_MERGE_DEFER_HOURS} hours since ${firstAttemptAt}` };
  const updated: PostMergeLedger = { ...saved, attempts: [...(ledger?.attempts ?? []), { n, startedAt, endedAt, runs: result.runs, outcome: result.outcome, reason: result.reason, runDirectory: run }] };
  writeJsonFile(file, updated);
  if (result.outcome === 'failed') {
    p.errors.push(`${commit} failed: ${result.reason}; retry with ${retryCommand(p.repo.repo, commit)}, retaining the ledger`);
    if (pr !== null) {
      try { await api(`repos/${p.t.repo}/issues/${pr}/comments`, { body: failureComment(updated) }); }
      catch (error) { p.errors.push(`${commit}: failure comment failed: ${message(error)}`); }
    }
    const cause = notify({ title: 'Converge local', subtitle: p.repo.repo, body: `Post-merge stopped on commit ${commit.slice(0, 8)}: ${result.reason}${pr === null ? '' : ` (PR #${pr})`}` });
    if (cause) p.errors.push(`${commit}: notification failed: ${cause}`);
  }
  return { commit, pr, outcome: result.outcome, reason: result.reason, ledger: file, runDirectory: run };
}
async function linearStep(p: Pass, commit: string, file: string, checkout: string, runDirectory: string, checkpoint: LinearCheckpoint | null, save: (value: LinearCheckpoint) => void): Promise<LinearResult> {
  const result = (kind: LinearResult['kind'], reason: string): LinearResult => ({ kind, reason, effects: checkpoint?.effects ?? [], logs: checkpoint?.logPaths ?? [] });
  try {
    const admission = await admitLinearMerge(p.t, commit);
    if (admission.kind !== 'admitted') return result(admission.kind === 'noop' ? 'done' : 'refused', admission.reason);
    const lane = raizLane(readFileSync(p.config.sheetPath, 'utf8'), p.config.parent);
    return await reconcileLinear({ merge: admission.merge, lane, checkout, pluginDir: p.config.pluginDir, runDirectory: join(runDirectory, 'linear'), ledgerFile: file, checkpoint, save, dryRun: p.options.dryRun, env: p.options.env, capMs: p.options.runCapMs ?? POST_MERGE_RUN_MINUTES * 60_000, planPath: p.options.planPath, manual: p.options.manual });
  } catch (error) { return result('deferred', `Linear admission or runtime unavailable: ${message(error)}`); }
}
/** The queue's next commit: a ledger that ends `done` only advances, one that ends `failed` stops the queue with its error again, anything else gets an attempt. */
async function next(p: Pass, commit: string): Promise<Handled> {
  const file = postMergeLedgerFile(p.config.stateDirectory, p.repo.repo, commit);
  const ledger = readPostMergeLedger(file);
  const last = ledger?.attempts[ledger.attempts.length - 1];
  if (ledger && last?.outcome === 'done') return { commit, pr: ledger.pr, outcome: 'done', reason: 'done on an earlier pass', ledger: file, runDirectory: last.runDirectory };
  if (ledger && last?.outcome === 'failed') {
    p.errors.push(`${commit} failed: ${last.reason}; retry with ${retryCommand(p.repo.repo, commit)}, retaining the ledger`);
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
/** A trunk contract that loaded without `postMerge` drops the stored tip, so a block added back later starts with a first pass instead of replaying every commit since. The ledgers stay as history. */
export function forgetPostMerge(stateDirectory: string, repo: string): void { rmSync(postMergeStateFile(stateDirectory, repo), { force: true }); }
/** The sweep tick's pass over one repository whose trunk contract has `postMerge`. It never throws: a failure lands in `errors`, and the stored tip stays where it was. */
export async function postMergePass(config: LocalConfig, repo: RepoConfig, t: Trusted, postMerge: PostMerge, options: PostMergeOptions): Promise<PostMergeReport> {
  const report: PostMergeReport = { tip: t.sha, handled: null, note: null, commits: [], errors: [] };
  const p: Pass = { config, repo, t, postMerge, options: { ...options, manual: false }, errors: report.errors };
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
/** `converge-local post-merge`: one attempt on a trunk commit, whatever its ledger says, after the same readiness check. The stored tip never moves here; the next tick reads the ledger, and a `done` releases the queue. */
export async function postMergeOne(config: LocalConfig, repo: RepoConfig, t: Trusted, commit: string, options: PostMergeOptions): Promise<PostMergeReport> {
  const postMerge = t.config.postMerge;
  if (!postMerge) throw new Error(`${repo.repo} has no postMerge block in its trunk contract`);
  if (commit !== t.sha && object(await api(`repos/${t.repo}/compare/${commit}...${t.sha}`), 'compare').status !== 'ahead') throw new Error(`${commit} is not a trunk commit: the tip ${t.sha} does not descend from it`);
  const holder = options.dryRun ? null : otherHolder(config.stateDirectory, repo.repo, options.leaseBy);
  if (holder) throw new Error(holder);
  const report: PostMergeReport = { tip: t.sha, handled: readPostMergeState(postMergeStateFile(config.stateDirectory, repo.repo))?.tip ?? null, note: null, commits: [], errors: [] };
  const p: Pass = { config, repo, t, postMerge, options: { ...options, manual: true }, errors: report.errors };
  await leased(p, async () => { report.commits.push(await attempt(p, commit, readPostMergeLedger(postMergeLedgerFile(config.stateDirectory, repo.repo, commit)))); });
  return report;
}
interface Open { commit: string; pr: number | null; outcome: PostMergeOutcome; reason: string; attempts: number; file: string }
interface Unreadable { file: string; error: string }
/** For `status`: each repository with a stored tip, that tip, and every commit whose latest attempt is `deferred` or `failed`; a file that does not parse shows up as its error. */
export function postMergeStatus(stateDirectory: string): unknown[] {
  const directory = join(stateDirectory, 'post-merge');
  const json = (path: string) => existsSync(path) ? readdirSync(path).filter(name => name.endsWith('.json')).sort() : [];
  return json(directory).map(name => {
    const file = join(directory, name);
    let state: PostMergeState | null;
    try { state = readPostMergeState(file); } catch (error) { return { file, error: message(error) }; }
    const ledgers = join(directory, name.slice(0, -'.json'.length));
    const commits = json(ledgers).flatMap((entry): (Open | Unreadable)[] => {
      const ledgerFile = join(ledgers, entry);
      try {
        const ledger = readPostMergeLedger(ledgerFile);
        const last = ledger?.attempts[ledger.attempts.length - 1];
        return ledger && last && last.outcome !== 'done' ? [{ commit: ledger.commit, pr: ledger.pr, outcome: last.outcome, reason: last.reason, attempts: ledger.attempts.length, file: ledgerFile }] : [];
      } catch (error) { return [{ file: ledgerFile, error: message(error) }]; }
    });
    return { repo: state?.repo ?? name, tip: state?.tip ?? null, commits };
  });
}
