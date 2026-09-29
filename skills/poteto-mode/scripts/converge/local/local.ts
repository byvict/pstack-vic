import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { oneOf, sha } from '../contract.ts';
import { api, command, openPulls, pull, trusted as trustedContract, viewer, type Account, type Trusted } from '../github.ts';
import { sweep, type Swept } from '../sweep.ts';
import { classify, skipCause, type Classified } from './classify.ts';
import { defaultConfigFile, defaultStateDirectory, loadConfig, type LocalConfig, type RepoConfig } from './config.ts';
import { install, installWhenIdle, uninstall, JOBS, WAKEABLE, type InstallOptions, type Job, type Wakeable } from './launchd.ts';
import { consumeWakes, nudge } from './wake.ts';
import { postMergeOne, postMergePass, postMergeStatus, type PostMergeReport } from './post-merge.ts';
import { tickWatch, watchErrors } from './watch.ts';
import { currentLedger, deferredBackoffUntil, exhausted, launchBackoffUntil, ledgerFile, markHeld, readLedger, withAttempt, withLaunchFailure, workKinds, writeLedger, DEFERRED_BACKOFF_MINUTES, LAUNCH_FAILURE_BACKOFF_MINUTES, type Attempt, type Ledger, type WorkKind } from './ledger.ts';
import { LEASE_TTL_HOURS, leaseFile, readLease, releaseLease, takeLease, type Lease } from './lease.ts';
import { attemptFrom, launchRaiz, raizLane, LaunchFailure, type RaizInput } from './raiz.ts';

const CONTRACT_PATH = '.cursor/converge.json';
export interface Launch { repo: string; pr: number; work: WorkKind; runDirectory: string; attempt: Omit<Attempt, 'n'> | null }
export interface TickReport { job: 'raiz'; trustedAuthors: string[]; classified: Classified[]; launched: Launch | null; held: { repo: string; pr: number; reason: string }[]; errors: string[] }
/** `capMs` and `launchFailureMs` replace the attempt cap and `LAUNCH_FAILURE_MINUTES` in tests. */
export interface RaizTickOptions { dryRun: boolean; now?: number; only?: { repo: string; pr: number; kind?: WorkKind }; capMs?: number; launchFailureMs?: number; env?: NodeJS.ProcessEnv }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function holdComment(ledger: Ledger, reason: string): string {
  return [`The local converge daemon stopped on head ${ledger.head}: ${reason}.`, '', 'Attempts:', ...ledger.attempts.map(a => `- ${a.n}. ${a.kind} ${a.outcome}: ${a.reason} (${a.runDirectory})`), '', 'Remove the hold label to let it try again.'].join('\n');
}
/** Label, then ledger, then comment. Once the label is on, classify skips the PR, so a failed write or comment never holds it twice; a failed comment is reported and the hold stands. */
async function hold(t: Trusted, file: string, ledger: Ledger, reason: string, now: number, report: TickReport): Promise<void> {
  await api(`repos/${t.repo}/issues/${ledger.pr}/labels`, { labels: [t.config.holdLabels[0]] });
  const held = markHeld(ledger, now);
  writeLedger(file, held);
  report.held.push({ repo: t.repo, pr: ledger.pr, reason });
  try { await api(`repos/${t.repo}/issues/${ledger.pr}/comments`, { body: holdComment(held, reason) }); }
  catch (error) { report.errors.push(`${t.repo}#${ledger.pr}: hold comment failed: ${message(error)}`); }
}
/** Unique per launch: a skipped attempt that the re-read PR explains records nothing, so the attempt number repeats, and the launch time keeps the next RUN fresh. */
function runDirectory(repo: string, pr: number, head: string, n: number): string {
  return join(tmpdir(), 'converge-local', `${repo.replace('/', '-')}-${pr}-${head.slice(0, 8)}-${n}-${Math.floor(Date.now() / 1000)}`);
}
/** One pass of the raiz job: classify every open PR of every repository, launch one Raiz on the first with work, record its attempt. The sheet row is read first, so a bad row launches nothing and reads nothing. An error for one PR is reported and the pass goes on, until a Raiz was launched: then the pass ends. A launch failure is such an error, records no attempt, and counts on the head's ledger: after MAX_LAUNCH_FAILURES the PR is skipped for LAUNCH_FAILURE_BACKOFF_MINUTES. */
export async function tickRaiz(config: LocalConfig, options: RaizTickOptions): Promise<TickReport> {
  const now = options.now ?? Date.now();
  const report: TickReport = { job: 'raiz', trustedAuthors: [], classified: [], launched: null, held: [], errors: [] };
  const lane = raizLane(readFileSync(config.sheetPath, 'utf8'), config.parent);
  const only = options.only;
  if (only && !config.repos.some(r => r.repo === only.repo)) throw new Error(`${only.repo} is not in the configuration ${config.file}`);
  const leaseBy = `daemon:${process.pid}`;
  async function visit(repo: RepoConfig, t: Trusted, author: number, trusted: string[], number: number): Promise<void> {
    const p = await pull(repo.repo, number);
    const classified = await classify(t, p, author, { now, leased: branch => readLease(leaseFile(config.stateDirectory, repo.repo, branch), now) !== null, trusted, force: only?.kind });
    const entry = report.classified.push(classified) - 1;
    if (classified.kind !== 'pending') return;
    const file = ledgerFile(config.stateDirectory, repo.repo, number);
    const ledger = currentLedger(readLedger(file), repo.repo, number, classified.head, p.labels.some(label => t.config.holdLabels.includes(label)));
    const cap = exhausted(ledger, now);
    if (cap) {
      if (options.dryRun) report.held.push({ repo: repo.repo, pr: number, reason: cap });
      else await hold(t, file, ledger, cap, now, report);
      return;
    }
    const launchUntil = launchBackoffUntil(ledger, now);
    if (launchUntil) {
      // The failures were tick errors already; the skip stays one, so a machine problem keeps showing as exit 1 while the other PRs get the ticks.
      const reason = `${ledger.launchFailures.length} launch failures on head ${classified.head}; next launch after ${launchUntil} (${LAUNCH_FAILURE_BACKOFF_MINUTES} minutes after the last)`;
      report.classified[entry] = { kind: 'skipped', repo: repo.repo, pr: number, head: classified.head, reason };
      report.errors.push(`${repo.repo}#${number}: ${reason}`);
      return;
    }
    const until = deferredBackoffUntil(ledger, now);
    if (until) {
      report.classified[entry] = { kind: 'skipped', repo: repo.repo, pr: number, head: classified.head, reason: `deferred backoff until ${until} (${DEFERRED_BACKOFF_MINUTES} minutes after the last deferred attempt)` };
      return;
    }
    const launch: Launch = { repo: repo.repo, pr: number, work: classified.work, runDirectory: runDirectory(repo.repo, number, classified.head, ledger.attempts.length + 1), attempt: null };
    if (options.dryRun) { report.launched = launch; return; }
    const lease = leaseFile(config.stateDirectory, repo.repo, classified.branch);
    takeLease(lease, { by: leaseBy, ttlHours: LEASE_TTL_HOURS, pid: process.pid, now });
    report.launched = launch;
    try {
      const input: RaizInput = { repo: repo.repo, pr: number, kind: classified.work, head: classified.head, branch: classified.branch, checkout: repo.checkout, runDirectory: launch.runDirectory, pluginDir: config.pluginDir, sheetPath: config.sheetPath, leaseBy };
      const launched = await launchRaiz(input, lane, { capMs: options.capMs, env: options.env });
      try { launch.attempt = attemptFrom(input, launched, options.launchFailureMs); }
      catch (error) {
        if (error instanceof LaunchFailure) {
          // A ledger that cannot be written must not hide the launch failure, so both reach the report.
          try { writeLedger(file, withLaunchFailure(ledger, { at: launched.endedAt, reason: error.reason })); }
          catch (writeError) { report.errors.push(`${repo.repo}#${number}: launch failure not recorded: ${message(writeError)}`); }
        }
        throw error;
      }
      if (!launch.attempt && launched.outcome) {
        // A Raiz may skip only for catch-up step 1's causes. A skip the live PR does not explain counts against the head, so a Raiz that always skips still meets the caps.
        const live = await pull(repo.repo, number);
        if (!skipCause(t, live, classified.head)) launch.attempt = { kind: input.kind, startedAt: launched.startedAt, endedAt: launched.endedAt, outcome: 'failed', reason: `skipped without cause: ${launched.outcome.reason}`, runDirectory: input.runDirectory };
      }
      if (launch.attempt) {
        const updated = withAttempt(ledger, launch.attempt);
        writeLedger(file, updated);
        // An attempt can run for hours: the caps see its real end, not the tick's start.
        const ended = Math.max(now, Date.parse(launch.attempt.endedAt));
        const capNow = exhausted(updated, ended);
        if (capNow) await hold(t, file, updated, capNow, ended, report);
      }
    } finally {
      try { releaseLease(lease, leaseBy); }
      catch (error) { report.errors.push(`${repo.repo}#${number}: ${message(error)}`); }
    }
  }
  // One account for every repository: without it no verdict can be trusted, so the tick visits none.
  let account: Account;
  try { account = await viewer(); }
  catch (error) { report.errors.push(`authenticated account: ${message(error)}`); return report; }
  const trusted = [account.login, ...config.trustedAuthors];
  report.trustedAuthors = trusted;
  for (const repo of config.repos) {
    if (only && only.repo !== repo.repo) continue;
    let t: Trusted, numbers: number[];
    try { t = await trustedContract(repo.repo, CONTRACT_PATH); numbers = only ? [only.pr] : await openPulls(repo.repo); }
    catch (error) { report.errors.push(`${repo.repo}: ${message(error)}`); continue; }
    for (const number of numbers) {
      try { await visit(repo, t, account.id, trusted, number); }
      catch (error) { report.errors.push(`${repo.repo}#${number}: ${message(error)}`); }
      if (!report.launched) continue;
      // The next pending PR must not wait for the interval, and the sweep arms what the attempt certified: both jobs get a wake, which launchd serves once this tick exits.
      if (!options.dryRun) nudge(config.stateDirectory, WAKEABLE);
      return report;
    }
  }
  return report;
}
export interface SweepReport { job: 'sweep'; repos: { repo: string; swept: Swept[]; failure: string | null; postMerge: PostMergeReport | null }[] }
/** After each repository's sweep, the post-merge pass of a trunk contract that has `postMerge`, with the contract the sweep read. `runCapMs` and `env` reach the pass for tests. */
export async function tickSweep(config: LocalConfig, options: { dryRun: boolean; runCapMs?: number; env?: NodeJS.ProcessEnv }): Promise<SweepReport> {
  const repos: SweepReport['repos'] = [];
  for (const repo of config.repos) {
    let result: Awaited<ReturnType<typeof sweep>>;
    try { result = await sweep({ repo: repo.repo, dryRun: options.dryRun }); }
    catch (error) { repos.push({ repo: repo.repo, swept: [], failure: message(error), postMerge: null }); continue; }
    const postMerge = result.trusted?.config.postMerge ?? null;
    repos.push({ repo: repo.repo, swept: result.swept, failure: result.failure, postMerge: result.trusted && postMerge ? await postMergePass(config, repo, result.trusted, postMerge, { dryRun: options.dryRun, leaseBy: `daemon:${process.pid}`, runCapMs: options.runCapMs, env: options.env }) : null });
  }
  return { job: 'sweep', repos };
}
/** The sweep tick's errors: each repository whose sweep failed, each PR it refused, and each post-merge error. */
function sweepErrors(report: SweepReport): string[] {
  return report.repos.flatMap(r => [...(r.failure ? [`${r.repo}: ${r.failure}`] : []), ...r.swept.filter(s => s.outcome === 'refused').map(s => `${r.repo}#${s.pr}: refused: ${s.reason}`), ...(r.postMerge?.errors ?? []).map(error => `${r.repo}: post-merge: ${error}`)]);
}
interface Unreadable { file: string; error: string }
/** The watch job has no wake queue, so its `wakes` is 0; it records instead how many reads it made, which resources changed and which jobs it woke. */
interface WatchSummary { reads: number; changed: string[]; woken: Wakeable[] }
export interface LastTick extends Partial<WatchSummary> { job: Job; startedAt: string; endedAt: string; exitCode: number; errors: string[]; wakes: number }
function lastTickFile(stateDirectory: string, job: Job): string { return join(stateDirectory, `last-tick-${job}.json`); }
function writeLastTick(stateDirectory: string, record: LastTick): void {
  const file = lastTickFile(stateDirectory, record.job);
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
}
function readLastTick(stateDirectory: string, job: Job): LastTick | Unreadable | null {
  const file = lastTickFile(stateDirectory, job);
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : { file, error: message(error) }; }
}
function print(value: unknown): void { process.stdout.write(JSON.stringify(value, null, 2) + '\n'); }
/** Every error goes to stderr too, one line each, beside the JSON report on stdout. */
function printErrors(errors: string[]): void { for (const error of errors) process.stderr.write(error + '\n'); }
/** A real tick records how it ended in `last-tick-<job>.json`, so `status` shows how the last launchd run went; a dry run records nothing. A tick that throws (a bad sheet row) ends with that one error. */
async function tick(config: LocalConfig, job: Job, dryRun: boolean, now: number | undefined): Promise<number> {
  const startedAt = new Date().toISOString();
  // Before the sheet and before GitHub: a wake file left behind would make launchd start the tick again every ThrottleInterval, a bad sheet row included.
  const wakes = dryRun || job === 'watch' ? 0 : consumeWakes(config.stateDirectory, job);
  let errors: string[];
  let watched: WatchSummary | null = job === 'watch' ? { reads: 0, changed: [], woken: [] } : null;
  try {
    if (job === 'sweep') { const report = await tickSweep(config, { dryRun }); print(report); errors = sweepErrors(report); }
    else if (job === 'raiz') { const report = await tickRaiz(config, { dryRun, now }); print(report); errors = report.errors; }
    else {
      const report = await tickWatch(config, { dryRun });
      errors = watchErrors(report);
      // 1440 ticks a day: a quiet one leaves only last-tick-watch.json, so the log holds the ticks that woke a job or failed.
      if (dryRun || report.woken.length || errors.length) print(report);
      watched = { reads: report.repos.reduce((sum, r) => sum + r.reads, 0), changed: report.repos.flatMap(r => r.changed), woken: report.woken };
    }
  } catch (error) { errors = [message(error)]; }
  printErrors(errors);
  const exitCode = errors.length ? 1 : 0;
  if (!dryRun) writeLastTick(config.stateDirectory, { job, startedAt, endedAt: new Date().toISOString(), exitCode, errors, wakes, ...watched });
  return exitCode;
}
function probe(binary: string, args: string[]): string {
  try { command(binary, args); return 'ok'; }
  catch (error) { return message(error); }
}
function jsonFiles(directory: string): string[] { return existsSync(directory) ? readdirSync(directory).filter(name => name.endsWith('.json')).sort() : []; }
/** Read-only: a state file that does not parse shows up as its error, never stops the report. */
export function status(config: LocalConfig, now = Date.now()): Record<string, unknown> {
  let raiz: unknown;
  try { raiz = raizLane(readFileSync(config.sheetPath, 'utf8'), config.parent); } catch (error) { raiz = { error: message(error) }; }
  const leaseDirectory = join(config.stateDirectory, 'leases');
  const leases = jsonFiles(leaseDirectory).flatMap((name): ((Lease & { file: string }) | Unreadable)[] => {
    try { const lease = readLease(join(leaseDirectory, name), now); return lease ? [{ file: name, ...lease }] : []; }
    catch (error) { return [{ file: name, error: message(error) }]; }
  });
  const ledgerDirectory = join(config.stateDirectory, 'ledger');
  const repos = existsSync(ledgerDirectory) ? readdirSync(ledgerDirectory, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort() : [];
  const ledgers = repos.flatMap(repo => jsonFiles(join(ledgerDirectory, repo)).flatMap((name): (Ledger | Unreadable)[] => {
    const file = join(ledgerDirectory, repo, name);
    try { const ledger = readLedger(file); return ledger ? [ledger] : []; }
    catch (error) { return [{ file, error: message(error) }]; }
  }));
  const lastTick = Object.fromEntries(JOBS.map(job => [job, readLastTick(config.stateDirectory, job)]));
  return { config, raiz, gh: probe('gh', ['auth', 'status']), parent: config.parent === 'claude' ? probe('claude', ['auth', 'status', '--json']) : probe('codex', ['login', 'status']), leases, ledgers, postMerge: postMergeStatus(config.stateDirectory), lastTick };
}
const USAGE = 'Usage: converge-local <install [--when-idle]|uninstall|status|tick --job sweep|raiz|watch [--dry-run]|nudge [--job sweep|raiz]|lease --repo R --branch B [--by NAME] [--ttl H] [--pid N]|release --repo R --branch B [--by NAME]|run --repo R --pr N [--kind K] [--dry-run]|post-merge --repo R --commit SHA [--dry-run]> [--config FILE]';
export async function main(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  try {
    const { values } = parseArgs({ args: rest, options: { config: { type: 'string' }, job: { type: 'string' }, 'dry-run': { type: 'boolean', default: false }, repo: { type: 'string' }, branch: { type: 'string' }, by: { type: 'string', default: 'interactive' }, ttl: { type: 'string', default: String(LEASE_TTL_HOURS) }, pid: { type: 'string' }, pr: { type: 'string' }, kind: { type: 'string' }, commit: { type: 'string' }, 'when-idle': { type: 'boolean', default: false }, now: { type: 'string' } } });
    const configFile = values.config ?? defaultConfigFile();
    const config = () => loadConfig(configFile);
    // An interactive session takes the lease whether or not the daemon is configured; a configuration that exists names where the daemon looks.
    const stateDirectory = () => existsSync(configFile) ? config().stateDirectory : defaultStateDirectory();
    const now = values.now === undefined ? undefined : Number(values.now);
    if (now !== undefined && !Number.isFinite(now)) throw new Error('--now takes milliseconds since the epoch');
    switch (subcommand) {
      case 'install': {
        const c = config();
        const options: InstallOptions = { pluginDir: c.pluginDir, configFile: c.file, intervalMinutes: c.intervalMinutes, logDirectory: c.logDirectory, stateDirectory: c.stateDirectory, path: process.env.PATH ?? '', nodePath: process.execPath, parent: c.parent, sheetPath: c.sheetPath };
        print(values['when-idle'] ? await installWhenIdle(options) : install(options)); return 0;
      }
      case 'nudge': {
        // Like lease: a session wakes the daemon whether or not it is configured, and a file that exists names where the jobs watch.
        const jobs = values.job === undefined ? WAKEABLE : WAKEABLE.filter(name => name === values.job);
        if (!jobs.length) throw new Error(USAGE);
        print({ woken: nudge(stateDirectory(), jobs) }); return 0;
      }
      case 'uninstall': print({ removed: uninstall() }); return 0;
      case 'status': print(status(config(), now)); return 0;
      case 'tick': {
        const job = JOBS.find(name => name === values.job);
        if (!job) throw new Error(USAGE);
        return await tick(config(), job, values['dry-run'], now);
      }
      case 'run': {
        if (!values.repo || !values.pr || !/^\d+$/.test(values.pr)) throw new Error(USAGE);
        const kind = values.kind === undefined ? undefined : oneOf(values.kind, workKinds);
        const result = await tickRaiz(config(), { dryRun: values['dry-run'], now, only: { repo: values.repo, pr: Number(values.pr), kind } });
        print(result); printErrors(result.errors); return result.errors.length ? 1 : 0;
      }
      case 'post-merge': {
        if (!values.repo || !values.commit) throw new Error(USAGE);
        const c = config();
        const repo = c.repos.find(r => r.repo === values.repo);
        if (!repo) throw new Error(`${values.repo} is not in the configuration ${c.file}`);
        const commit = sha(values.commit);
        const report = await postMergeOne(c, repo, await trustedContract(repo.repo, CONTRACT_PATH), commit, { dryRun: values['dry-run'], leaseBy: `post-merge:${process.pid}` });
        print({ job: 'post-merge', repo: repo.repo, ...report }); printErrors(report.errors);
        return report.errors.length || report.commits.some(entry => entry.outcome === 'failed' || entry.outcome === 'waiting') ? 1 : 0;
      }
      case 'lease': {
        if (!values.repo || !values.branch) throw new Error(USAGE);
        print(takeLease(leaseFile(stateDirectory(), values.repo, values.branch), { by: values.by, ttlHours: Number(values.ttl), pid: values.pid === undefined ? null : Number(values.pid), now })); return 0;
      }
      case 'release': {
        if (!values.repo || !values.branch) throw new Error(USAGE);
        releaseLease(leaseFile(stateDirectory(), values.repo, values.branch), values.by, now); print({ released: values.branch }); return 0;
      }
      default: throw new Error(USAGE);
    }
  } catch (error) { process.stderr.write((error instanceof SyntaxError ? 'Malformed JSON input' : message(error)) + '\n'); return 1; }
}
