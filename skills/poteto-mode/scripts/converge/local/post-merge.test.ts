import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commit, fixture, git } from '../fixtures/setup.ts';
import { loadConfig } from './config.ts';
import { writeJsonFile } from './ledger.ts';
import { tickSweep } from './local.ts';
import { POST_MERGE_DEFER_HOURS, postMergeLedgerFile, postMergeStateFile, type Handled, type PostMergeLedger } from './post-merge.ts';

type F = ReturnType<typeof fixture>;
const isolated = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const merged = (number: number) => ({ number, merged_at: '2026-09-29T21:35:41Z', base: { ref: 'main' } });
function edit(f: F, change: (live: ReturnType<F['read']>) => void) { const live = f.read(); change(live); Object.assign(f.state, live); f.save(); }
/** A trunk of `count` real commits on a bare origin that the primary checkout knows only as a remote, so a pass must fetch each commit it runs. The fake GitHub's tip is the first commit, and every commit's push Tests are green. */
function trunk(f: F, count: number, postMerge: Record<string, unknown> = { runs: [{ name: 'release', command: 'fake-release' }] }) {
  const origin = join(f.directory, 'origin.git');
  const work = join(f.directory, 'work');
  mkdirSync(work);
  git(f.directory, ['init', '-q', '--bare', origin]);
  git(work, ['init', '-q', '-b', 'main']);
  const commits = Array.from({ length: count }, (_, i) => { writeFileSync(join(work, 'n.txt'), String(i)); return commit(work, `trunk ${i}`); });
  git(work, ['push', '-q', origin, 'main']);
  const checkout = f.checkout();
  git(checkout, ['remote', 'add', 'origin', origin]);
  edit(f, live => {
    const config = JSON.parse(live.blobs['.cursor/converge.json']); config.postMerge = postMerge; live.blobs['.cursor/converge.json'] = JSON.stringify(config);
    live.trunkHistory = commits.map((sha, i) => ({ sha, parents: i ? [commits[i - 1]] : [] }));
    live.pushRuns = Object.fromEntries(commits.map(sha => [sha, { status: 'completed', conclusion: 'success' }]));
    live.trunk = commits[0];
  });
  const state = join(f.directory, 'state');
  const file = join(f.directory, 'converge-local.json');
  writeFileSync(file, JSON.stringify({ parent: 'claude', repos: [{ repo: 'Example/app', checkout }], pluginDir: f.directory, stateDirectory: state, sheetPath: join(f.directory, 'sheet.md'), logDirectory: f.directory }));
  // The post-merge command: it records its environment, its directory and the commit checked out there, prints a line, and exits with the code in `exits/<commit>` (0 without one), or sleeps when `sleep` exists.
  writeFileSync(join(f.directory, 'fake-release'), '#!/bin/sh\nprintf "%s|%s|%s|%s|%s|%s|%s\\n" "$PSTACK_REPO" "$PSTACK_COMMIT" "$PSTACK_PR" "$PSTACK_CHECKOUT" "$PSTACK_PLUGIN_DIR" "$(pwd -P)" "$(git rev-parse HEAD)" >> "$FAKE_DIR/released.txt"\necho "release output"\nif [ -f "$FAKE_DIR/sleep" ]; then exec sleep 30; fi\nif [ -f "$FAKE_DIR/exits/$PSTACK_COMMIT" ]; then exit "$(cat "$FAKE_DIR/exits/$PSTACK_COMMIT")"; fi\n');
  chmodSync(join(f.directory, 'fake-release'), 0o755);
  mkdirSync(join(f.directory, 'exits'));
  return { commits, checkout, file, state, stateFile: postMergeStateFile(state, 'Example/app'), ledger: (sha: string) => postMergeLedgerFile(state, 'Example/app', sha) };
}
const env = (f: F) => ({ ...isolated, FAKE_DIR: f.directory, TMPDIR: join(f.directory, 'tmp') });
const sweepTick = (f: F, file: string, extra: string[] = []) => f.run('converge-local', ['tick', '--job', 'sweep', '--config', file, ...extra], env(f));
const pass = (stdout: string) => JSON.parse(stdout).repos[0].postMerge;
const outcomes = (stdout: string) => pass(stdout).commits.map((c: Handled) => [c.commit, c.outcome, c.reason]);
const released = (f: F) => existsSync(join(f.directory, 'released.txt')) ? readFileSync(join(f.directory, 'released.txt'), 'utf8').trim().split('\n').map(line => line.split('|')) : [];
const ledgerOf = (file: string): PostMergeLedger => JSON.parse(readFileSync(file, 'utf8'));
/** tickSweep in this process, for the options the command does not take. */
async function inProcess<T>(f: F, run: () => Promise<T>): Promise<T> {
  const values: Record<string, string> = { PATH: `${f.directory}:${process.env.PATH}`, CONVERGE_FIXTURE: f.statePath, ...env(f) };
  const saved = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  try { return await run(); }
  finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}

test('the first sweep tick with a postMerge block stores the trunk tip and runs nothing; while trunk stands still the pass reads nothing more', t => {
  const f = fixture(); t.after(f.cleanup);
  const { commits, file, stateFile } = trunk(f, 2);
  const first = sweepTick(f, file);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(pass(first.stdout), { tip: commits[0], handled: commits[0], note: 'first pass: stored the trunk tip and ran nothing', commits: [], errors: [] });
  assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')), { schemaVersion: 1, repo: 'Example/app', tip: commits[0] });
  assert.deepEqual(released(f), []);
  const before = f.calls().length;
  const second = sweepTick(f, file);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(pass(second.stdout), { tip: commits[0], handled: commits[0], note: null, commits: [], errors: [] });
  assert.deepEqual(f.calls().slice(before).filter(call => /compare|commits\/[a-f0-9]{40}\/pulls|\/runs/.test(String(call[1]))), [], 'no compare, no PR lookup, no Tests read');
});
test('new trunk commits run oldest first, each in a detached worktree of its commit with the PSTACK variables, and the handled tip advances commit by commit', t => {
  const f = fixture(); t.after(f.cleanup);
  const { commits, checkout, file, stateFile, ledger } = trunk(f, 3);
  assert.equal(sweepTick(f, file).status, 0);
  const primary = [git(checkout, ['branch', '--list']), git(checkout, ['rev-parse', 'HEAD'])];
  edit(f, live => { live.trunk = commits[2]; live.commitPulls = { [commits[1]]: [{ ...merged(40), merged_at: null }, merged(41)] }; });
  const result = sweepTick(f, file);
  assert.equal(result.status, 0, result.stderr);
  const report = pass(result.stdout);
  assert.deepEqual(report.commits.map((c: Handled) => [c.commit, c.pr, c.outcome]), [[commits[1], 41, 'done'], [commits[2], null, 'done']]);
  assert.equal(report.handled, commits[2]);
  const lines = released(f);
  assert.deepEqual(lines.map(l => [l[0], l[1], l[2], l[3], l[4], l[6]]), [['Example/app', commits[1], '41', checkout, f.directory, commits[1]], ['Example/app', commits[2], '', checkout, f.directory, commits[2]]]);
  assert.deepEqual(lines.map(l => l[5]), report.commits.map((c: Handled) => join(realpathSync(String(c.runDirectory)), 'checkout')));
  const first = ledgerOf(ledger(commits[1]));
  assert.deepEqual([first.schemaVersion, first.repo, first.commit, first.pr, first.attempts.map(a => [a.n, a.outcome, a.reason])], [1, 'Example/app', commits[1], 41, [[1, 'done', '']]]);
  assert.deepEqual(first.attempts[0]?.runs.map(r => [r.name, r.exitCode]), [['release', 0]]);
  assert.equal(readFileSync(String(first.attempts[0]?.runs[0]?.logFile), 'utf8'), 'release output\n');
  assert.match(String(first.attempts[0]?.runDirectory), new RegExp(`/converge-local/post-merge/Example-app-${commits[1]?.slice(0, 8)}-1-\\d+$`));
  assert.equal(statSync(ledger(commits[1])).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).tip, commits[2]);
  assert.equal(git(checkout, ['worktree', 'list', '--porcelain']).match(/^worktree /gm)?.length, 1, 'every worktree is removed');
  assert.deepEqual([git(checkout, ['branch', '--list']), git(checkout, ['rev-parse', 'HEAD'])], primary, 'no branch created or moved in the primary checkout');
});
test('a commit whose push Tests have not completed, or have no run yet, waits without an error, and the commits after it wait too', t => {
  const f = fixture(); t.after(f.cleanup);
  const { commits, file, ledger } = trunk(f, 3);
  assert.equal(sweepTick(f, file).status, 0);
  edit(f, live => { live.trunk = commits[2]; live.pushRuns[commits[1]] = { status: 'in_progress', conclusion: null }; });
  const waiting = sweepTick(f, file);
  assert.equal(waiting.status, 0, waiting.stderr);
  assert.deepEqual(pass(waiting.stdout).commits, [{ commit: commits[1], pr: null, outcome: 'waiting', reason: 'Tests has not completed on the commit', ledger: ledger(commits[1]), runDirectory: null }]);
  edit(f, live => { live.pushRuns = Object.fromEntries(Object.entries(live.pushRuns).filter(([sha]) => sha !== commits[1])); });
  const none = sweepTick(f, file);
  assert.equal(none.status, 0, none.stderr);
  assert.deepEqual(outcomes(none.stdout), [[commits[1], 'waiting', 'Tests has not completed on the commit']]);
  assert.deepEqual(released(f), []);
  assert.equal(existsSync(ledger(commits[1])), false);
  edit(f, live => { live.pushRuns[commits[1]] = { status: 'completed', conclusion: 'success' }; });
  assert.deepEqual(outcomes(sweepTick(f, file).stdout).map((o: string[]) => o[1]), ['done', 'done']);
});
test('with after none, a commit runs without its push Tests', t => {
  const f = fixture(); t.after(f.cleanup);
  const { commits, file } = trunk(f, 2, { runs: [{ name: 'release', command: 'fake-release' }], after: 'none' });
  assert.equal(sweepTick(f, file).status, 0);
  edit(f, live => { live.trunk = commits[1]; live.pushRuns = {}; });
  assert.deepEqual(outcomes(sweepTick(f, file).stdout), [[commits[1], 'done', '']]);
});
test('a commit whose push Tests or test job did not succeed waits, reported as an error, until a rerun turns it green', t => {
  const f = fixture(); t.after(f.cleanup);
  const { commits, file, ledger } = trunk(f, 2);
  assert.equal(sweepTick(f, file).status, 0);
  edit(f, live => { live.trunk = commits[1]; live.pushRuns[commits[1]] = { status: 'completed', conclusion: 'failure' }; });
  const red = sweepTick(f, file);
  assert.equal(red.status, 1);
  assert.equal(red.stderr, `Example/app: post-merge: ${commits[1]} waits: Tests did not succeed on the commit\n`);
  edit(f, live => { live.pushRuns[commits[1]] = { status: 'completed', conclusion: 'success', jobConclusion: 'failure' }; });
  assert.equal(sweepTick(f, file).stderr, `Example/app: post-merge: ${commits[1]} waits: Run test suite did not succeed on the commit\n`);
  assert.equal(existsSync(ledger(commits[1])), false, 'a wait records no attempt');
  edit(f, live => { live.pushRuns[commits[1]] = { status: 'completed', conclusion: 'success' }; });
  assert.deepEqual(outcomes(sweepTick(f, file).stdout), [[commits[1], 'done', '']]);
});
test('exit 75 defers the commit: the tip stays, the next tick tries again, and a 75 after 24 hours of deferring fails', t => {
  const f = fixture(); t.after(f.cleanup);
  const { commits, file, ledger } = trunk(f, 3);
  assert.equal(sweepTick(f, file).status, 0);
  edit(f, live => { live.trunk = commits[2]; });
  writeFileSync(join(f.directory, 'exits', String(commits[1])), '75');
  const deferred = sweepTick(f, file);
  assert.equal(deferred.status, 0, deferred.stderr);
  assert.deepEqual([outcomes(deferred.stdout), pass(deferred.stdout).handled], [[[commits[1], 'deferred', 'release exited 75']], commits[0]]);
  assert.equal(git(join(f.directory, 'checkout'), ['worktree', 'list', '--porcelain']).match(/^worktree /gm)?.length, 1, 'a deferred attempt removes its worktree too');
  assert.equal(sweepTick(f, file).status, 0);
  assert.deepEqual(ledgerOf(ledger(commits[1])).attempts.map(a => [a.n, a.outcome]), [[1, 'deferred'], [2, 'deferred']]);
  const aged = ledgerOf(ledger(commits[1]));
  aged.firstAttemptAt = new Date(Date.now() - (POST_MERGE_DEFER_HOURS + 1) * 3_600_000).toISOString();
  writeFileSync(ledger(commits[1]), JSON.stringify(aged));
  const failed = sweepTick(f, file);
  assert.equal(failed.status, 1);
  assert.deepEqual(outcomes(failed.stdout), [[commits[1], 'failed', `release exited 75 for 24 hours since ${aged.firstAttemptAt}`]]);
});
test('a failed commit stops the queue, comments once on its merged PR, shows in status, repeats the error on every tick, and runs again once its ledger is deleted', t => {
  const f = fixture(); t.after(f.cleanup);
  const { commits, file, ledger } = trunk(f, 3);
  assert.equal(sweepTick(f, file).status, 0);
  edit(f, live => { live.trunk = commits[2]; live.commitPulls = { [commits[1]]: [merged(41)] }; });
  writeFileSync(join(f.directory, 'exits', String(commits[1])), '1');
  const failed = sweepTick(f, file);
  assert.equal(failed.status, 1);
  const error = `Example/app: post-merge: ${commits[1]} failed: release exited 1; delete ${ledger(commits[1])} to retry`;
  assert.equal(failed.stderr, error + '\n');
  const logFile = ledgerOf(ledger(commits[1])).attempts[0]?.runs[0]?.logFile;
  assert.deepEqual(f.read().posted, [{ pr: 41, body: [`The local converge daemon's post-merge stopped on commit ${commits[1]}: release exited 1.`, '', 'Runs:', `- release exited 1 (${logFile})`, '', `Later trunk commits wait. Delete \`${ledger(commits[1])}\` to retry.`].join('\n') }]);
  assert.deepEqual(released(f).map(l => l[1]), [commits[1]], 'the later commit waits');
  const again = sweepTick(f, file);
  assert.equal(again.stderr, error + '\n');
  assert.equal(f.read().posted.length, 1, 'one comment per recorded failure');
  assert.equal(released(f).length, 1, 'a failed commit never runs again on its own');
  rmSync(ledger(commits[1])); rmSync(join(f.directory, 'exits', String(commits[1])));
  const retried = sweepTick(f, file);
  assert.equal(retried.status, 0, retried.stderr);
  assert.deepEqual(outcomes(retried.stdout).map((o: string[]) => o[1]), ['done', 'done']);
});
test('a failure comment that cannot be posted leaves the failure standing and names the comment', t => {
  const f = fixture(); t.after(f.cleanup);
  const { commits, file, ledger } = trunk(f, 2);
  assert.equal(sweepTick(f, file).status, 0);
  edit(f, live => { live.trunk = commits[1]; live.commitPulls = { [commits[1]]: [merged(41)] }; live.failPost = 'issues/41/comments'; });
  writeFileSync(join(f.directory, 'exits', String(commits[1])), '1');
  const failed = sweepTick(f, file);
  assert.equal(failed.status, 1);
  assert.equal(failed.stderr, `Example/app: post-merge: ${commits[1]} failed: release exited 1; delete ${ledger(commits[1])} to retry\nExample/app: post-merge: ${commits[1]}: failure comment failed: gh request failed\n`);
  assert.equal(ledgerOf(ledger(commits[1])).attempts[0]?.outcome, 'failed');
});
test('a ledger that already ends done only advances the tip', t => {
  const f = fixture(); t.after(f.cleanup);
  const { commits, file, ledger } = trunk(f, 3);
  assert.equal(sweepTick(f, file).status, 0);
  const at = new Date().toISOString();
  writeJsonFile(ledger(String(commits[1])), { schemaVersion: 1, repo: 'Example/app', commit: commits[1], pr: null, firstAttemptAt: at, attempts: [{ n: 1, startedAt: at, endedAt: at, runs: [], outcome: 'done', reason: '', runDirectory: '/tmp/earlier' }] });
  edit(f, live => { live.trunk = commits[2]; });
  const result = sweepTick(f, file);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(outcomes(result.stdout), [[commits[1], 'done', 'done on an earlier pass'], [commits[2], 'done', '']]);
  assert.deepEqual(released(f).map(l => l[1]), [commits[2]]);
});
test('a tip that does not descend from the handled tip, more than 50 commits and a truncated compare fail the pass and store nothing', t => {
  const f = fixture(); t.after(f.cleanup);
  const { commits, file, stateFile } = trunk(f, 2);
  assert.equal(sweepTick(f, file).status, 0);
  const reset = `delete ${stateFile} to start again from the current tip`;
  const store = (tip: string) => writeFileSync(stateFile, JSON.stringify({ schemaVersion: 1, repo: 'Example/app', tip }));
  const gone = 'e'.repeat(40);
  store(gone); edit(f, live => { live.trunk = commits[1]; });
  const forced = sweepTick(f, file);
  assert.equal(forced.status, 1);
  assert.equal(forced.stderr, `Example/app: post-merge: trunk tip ${commits[1]} does not descend from the handled tip ${gone}; ${reset}\n`);
  const many = Array.from({ length: 52 }, (_, i) => String(i).padStart(40, '0'));
  store(String(many[0])); edit(f, live => { live.trunkHistory = many.map((sha, i) => ({ sha, parents: i ? [many[i - 1]] : [] })); live.trunk = many[51]; });
  assert.equal(sweepTick(f, file).stderr, `Example/app: post-merge: more than 50 trunk commits since the handled tip ${many[0]}; ${reset}\n`);
  edit(f, live => { live.trunk = many[5]; live.compareLimit = 2; });
  assert.equal(sweepTick(f, file).stderr, `Example/app: post-merge: the compare from ${many[0]} lists 2 of 5 commits; ${reset}\n`);
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).tip, many[0]);
  assert.deepEqual(released(f), []);
});
test('a state or ledger file that does not parse fails the pass with the file named, runs nothing and stores nothing', t => {
  const f = fixture(); t.after(f.cleanup);
  const { commits, file, stateFile, ledger } = trunk(f, 2);
  assert.equal(sweepTick(f, file).status, 0);
  edit(f, live => { live.trunk = commits[1]; });
  mkdirSync(join(ledger(String(commits[1])), '..'), { recursive: true }); writeFileSync(ledger(String(commits[1])), '{');
  const badLedger = sweepTick(f, file);
  assert.equal(badLedger.status, 1);
  assert.match(badLedger.stderr, new RegExp(`^Example/app: post-merge: Invalid post-merge ledger ${ledger(String(commits[1]))}: `));
  writeFileSync(stateFile, '{'); rmSync(ledger(String(commits[1])));
  const badState = sweepTick(f, file);
  assert.equal(badState.status, 1);
  assert.match(badState.stderr, new RegExp(`^Example/app: post-merge: Invalid post-merge state file ${stateFile}: `));
  assert.equal(readFileSync(stateFile, 'utf8'), '{', 'never re-anchored in silence');
  assert.deepEqual(released(f), []);
});
test('a command that does not start fails the attempt with exitCode null', t => {
  const f = fixture(); t.after(f.cleanup);
  const { commits, file, ledger } = trunk(f, 2, { runs: [{ name: 'release', command: 'no-such-command-anywhere' }] });
  assert.equal(sweepTick(f, file).status, 0);
  edit(f, live => { live.trunk = commits[1]; });
  const result = sweepTick(f, file);
  assert.equal(result.status, 1);
  assert.deepEqual(outcomes(result.stdout), [[commits[1], 'failed', 'release did not start']]);
  assert.equal(ledgerOf(ledger(String(commits[1]))).attempts[0]?.runs[0]?.exitCode, null);
});
test('a command past its cap is killed and the attempt fails with reason timeout', async t => {
  const f = fixture(); t.after(f.cleanup);
  const { commits, file, ledger } = trunk(f, 2);
  assert.equal(sweepTick(f, file).status, 0);
  edit(f, live => { live.trunk = commits[1]; });
  writeFileSync(join(f.directory, 'sleep'), '');
  const report = await inProcess(f, () => tickSweep(loadConfig(file), { dryRun: false, runCapMs: 300 }));
  assert.deepEqual(report.repos[0]?.postMerge?.commits.map(c => [c.outcome, c.reason]), [['failed', 'timeout']]);
  assert.equal(ledgerOf(ledger(String(commits[1]))).attempts[0]?.runs[0]?.exitCode, 143);
});
test('a commit the checkout cannot fetch is an error with no attempt, tried again on the next tick', t => {
  const f = fixture(); t.after(f.cleanup);
  const { commits, file, ledger } = trunk(f, 2);
  assert.equal(sweepTick(f, file).status, 0);
  const ghost = 'f'.repeat(40);
  edit(f, live => { live.trunkHistory.push({ sha: ghost, parents: [commits[1]] }); live.pushRuns[ghost] = { status: 'completed', conclusion: 'success' }; live.trunk = ghost; });
  const result = sweepTick(f, file);
  assert.equal(result.status, 1);
  assert.deepEqual(outcomes(result.stdout).map((o: string[]) => [o[0], o[1]]), [[commits[1], 'done'], [ghost, 'waiting']]);
  assert.match(result.stderr, new RegExp(`^Example/app: post-merge: ${ghost}: checkout failed: git fetch failed: `, 'm'));
  assert.equal(existsSync(ledger(ghost)), false);
  assert.equal(pass(result.stdout).handled, commits[1]);
});
test('a dry run prints what the pass would run and writes nothing', t => {
  const f = fixture(); t.after(f.cleanup);
  const { commits, file, state, stateFile, ledger } = trunk(f, 3);
  const fresh = sweepTick(f, file, ['--dry-run']);
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.deepEqual(pass(fresh.stdout), { tip: commits[0], handled: null, note: 'first pass: would store the trunk tip and run nothing', commits: [], errors: [] });
  assert.equal(existsSync(state), false);
  assert.equal(sweepTick(f, file).status, 0);
  edit(f, live => { live.trunk = commits[2]; });
  const dry = sweepTick(f, file, ['--dry-run']);
  assert.equal(dry.status, 0, dry.stderr);
  const [entry] = pass(dry.stdout).commits;
  assert.deepEqual([entry.commit, entry.outcome, entry.reason, entry.ledger], [commits[1], 'dry-run', 'release: fake-release', ledger(String(commits[1]))]);
  assert.match(entry.runDirectory, /\/converge-local\/post-merge\/Example-app-[0-9a-f]{8}-1-\d+$/);
  assert.equal(existsSync(entry.runDirectory), false);
  assert.equal(existsSync(join(state, 'post-merge', 'Example-app')), false);
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).tip, commits[0]);
  assert.deepEqual(released(f), []);
});
