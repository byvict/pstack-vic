import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from '../fixtures/setup.ts';
import { plist } from './launchd.ts';

const headA = '1'.repeat(40);
const headB = '2'.repeat(40);
const pulls = 'repos/Example/app/pulls?state=open&per_page=100';
const trunkChecks = 'repos/Example/app/commits/main/check-runs?filter=all&per_page=100';
const headChecks = (head: string) => `repos/Example/app/commits/${head}/check-runs?filter=all&per_page=100`;
const red = [{ id: 30, name: 'test', status: 'completed', conclusion: 'failure', app: { id: 15368 } }];
function pr(number: number, head: string, fields: Record<string, unknown> = {}) {
  return { number, head: { sha: head, ref: `branch-${number}`, repo: { full_name: 'Example/app' } }, base: { ref: 'main', repo: { full_name: 'Example/app', default_branch: 'main' } }, state: 'open', draft: false, labels: [], ...fields };
}
function configured(f: ReturnType<typeof fixture>, repos = ['Example/app']) {
  const checkout = f.checkout();
  const state = join(f.directory, 'state');
  const file = join(f.directory, 'converge-local.json');
  writeFileSync(file, JSON.stringify({ parent: 'claude', repos: repos.map(repo => ({ repo, checkout })), pluginDir: f.directory, stateDirectory: state, sheetPath: join(f.directory, 'sheet.md'), logDirectory: f.directory }));
  return { file, state, saved: join(state, 'watch', 'Example-app.json') };
}
function edit(f: ReturnType<typeof fixture>, change: (live: ReturnType<ReturnType<typeof fixture>['read']>) => void) {
  const live = f.read(); change(live); Object.assign(f.state, live); f.save();
}
const watch = (f: ReturnType<typeof fixture>, file: string, extra: string[] = []) => f.run('converge-local', ['tick', '--job', 'watch', '--config', file, ...extra]);
const wakeFiles = (state: string, job: string) => existsSync(join(state, 'wake', job)) ? readdirSync(join(state, 'wake', job)).sort() : null;
const lastTick = (state: string) => JSON.parse(readFileSync(join(state, 'last-tick-watch.json'), 'utf8'));
/** The gh calls from `from` on, as [endpoint, the If-None-Match it sent or null], sorted: the check-run reads of a repository run in parallel. */
function reads(f: ReturnType<typeof fixture>, from = 0): [string, string | null][] {
  return f.calls().slice(from).map((call): [string, string | null] => [call[1], call.find((arg, i) => call[i - 1] === '-H' && arg.startsWith('If-None-Match: '))?.slice('If-None-Match: '.length) ?? null]).sort();
}

test('the first watch tick reads the PR list, the trunk check runs and each open head\'s check runs, stores their ETags, wakes nothing and prints nothing', t => {
  const f = fixture(); t.after(f.cleanup);
  const { file, state, saved } = configured(f);
  edit(f, live => { live.pulls = [pr(1, headA), pr(2, headB)]; });
  const result = watch(f, file);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '', 'a tick that woke nothing and failed nothing leaves only last-tick-watch.json');
  assert.deepEqual(reads(f), [[pulls, null], [trunkChecks, null], [headChecks(headA), null], [headChecks(headB), null]].sort());
  assert.ok(f.calls().every(call => call[0] === 'api' && call[2] === '-i' && !call.includes('--method')), 'only GETs, each with the status line');
  const watched = JSON.parse(readFileSync(saved, 'utf8'));
  assert.deepEqual([watched.schemaVersion, watched.repo, watched.trunk, watched.heads], [1, 'Example/app', 'main', [headA, headB]]);
  assert.deepEqual(Object.keys(watched.etags).sort(), [pulls, trunkChecks, headChecks(headA), headChecks(headB)].sort());
  assert.ok(Object.values(watched.etags).every(etag => /^W\/"[0-9a-f]{64}"$/.test(String(etag))));
  assert.deepEqual([wakeFiles(state, 'sweep'), wakeFiles(state, 'raiz'), wakeFiles(state, 'watch')], [null, null, null]);
  const record = lastTick(state);
  assert.deepEqual(Object.keys(record), ['job', 'startedAt', 'endedAt', 'exitCode', 'errors', 'wakes', 'reads', 'changed', 'woken']);
  assert.deepEqual([record.job, record.exitCode, record.errors, record.wakes, record.reads, record.changed, record.woken], ['watch', 0, [], 0, 4, [], []]);
});
test('a watch tick over unchanged resources sends every stored ETag, takes the 304s as unchanged and wakes nothing', t => {
  const f = fixture(); t.after(f.cleanup);
  const { file, state, saved } = configured(f);
  edit(f, live => { live.pulls = [pr(1, headA)]; });
  assert.equal(watch(f, file).status, 0);
  const { etags } = JSON.parse(readFileSync(saved, 'utf8'));
  const before = f.calls().length;
  const again = watch(f, file);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stdout, '');
  assert.deepEqual(reads(f, before), [[pulls, etags[pulls]], [trunkChecks, etags[trunkChecks]], [headChecks(headA), etags[headChecks(headA)]]].sort());
  assert.deepEqual([wakeFiles(state, 'sweep'), wakeFiles(state, 'raiz')], [null, null]);
  assert.deepEqual([lastTick(state).exitCode, lastTick(state).reads, lastTick(state).changed, lastTick(state).woken], [0, 3, [], []]);
});
for (const [name, change, changed, woken] of [
  ['the PR list', live => { live.pulls = [pr(1, headA, { labels: [{ name: 'needs-victor' }] })]; }, [pulls], ['sweep', 'raiz']],
  ['the trunk check runs', live => { live.refChecks = { main: red }; }, [trunkChecks], ['sweep']],
  ['the check runs of an open PR head', live => { live.refChecks = { [headA]: red }; }, [headChecks(headA)], ['raiz']],
] as [string, (live: Record<string, unknown>) => void, string[], string[]][]) {
  test(`a change to ${name} wakes ${woken.join(' and ')}, prints the report, and the next tick is quiet again`, t => {
    const f = fixture(); t.after(f.cleanup);
    const { file, state } = configured(f);
    edit(f, live => { live.pulls = [pr(1, headA)]; });
    assert.equal(watch(f, file).status, 0);
    edit(f, change);
    const result = watch(f, file);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { job: 'watch', repos: [{ repo: 'Example/app', reads: 3, changed, failure: null }], woken });
    for (const job of ['sweep', 'raiz']) assert.equal(wakeFiles(state, job)?.length ?? 0, woken.includes(job) ? 1 : 0, job);
    assert.deepEqual([lastTick(state).changed, lastTick(state).woken], [changed, woken]);
    const quiet = watch(f, file);
    assert.equal(quiet.status, 0, quiet.stderr);
    assert.equal(quiet.stdout, '');
    assert.deepEqual(lastTick(state).woken, []);
  });
}
test('a head seen for the first time is stored without counting as a change; a closed PR drops its head, and with no open PR the tick reads only the PR list', t => {
  const f = fixture(); t.after(f.cleanup);
  const { file, saved } = configured(f);
  edit(f, live => { live.pulls = [pr(1, headA)]; });
  assert.equal(watch(f, file).status, 0);
  edit(f, live => { live.pulls = [pr(1, headA), pr(2, headB)]; live.refChecks = { [headB]: red }; });
  const before = f.calls().length;
  const opened = watch(f, file);
  assert.equal(opened.status, 0, opened.stderr);
  assert.deepEqual(JSON.parse(opened.stdout).repos[0].changed, [pulls], 'the new head\'s check runs are its first read');
  assert.deepEqual(reads(f, before).find(([endpoint]) => endpoint === headChecks(headB)), [headChecks(headB), null]);
  assert.deepEqual(JSON.parse(readFileSync(saved, 'utf8')).heads, [headA, headB]);
  edit(f, live => { live.pulls = []; });
  const closed = watch(f, file);
  assert.equal(closed.status, 0, closed.stderr);
  assert.deepEqual(JSON.parse(closed.stdout).woken, ['sweep', 'raiz']);
  const watched = JSON.parse(readFileSync(saved, 'utf8'));
  assert.deepEqual([watched.trunk, watched.heads, Object.keys(watched.etags)], [null, [], [pulls]]);
  const after = f.calls().length;
  assert.equal(watch(f, file).status, 0);
  assert.deepEqual(reads(f, after).map(([endpoint]) => endpoint), [pulls], 'nothing to arm, so the trunk goes unwatched');
});
test('a repository whose read fails is an error for that repository only: no ETag and no wake for it, exit 1, and the other repository still wakes', t => {
  const f = fixture(); t.after(f.cleanup);
  const { file, state, saved } = configured(f, ['Example/broken', 'Example/app']);
  edit(f, live => { live.pulls = [pr(1, headA)]; });
  const error = 'Example/broken: pulls?state=open&per_page=100: gh request failed';
  const first = watch(f, file);
  assert.equal(first.status, 1);
  assert.equal(first.stderr, error + '\n');
  assert.deepEqual(JSON.parse(first.stdout), { job: 'watch', repos: [{ repo: 'Example/broken', reads: 1, changed: [], failure: 'pulls?state=open&per_page=100: gh request failed' }, { repo: 'Example/app', reads: 3, changed: [], failure: null }], woken: [] });
  assert.equal(existsSync(join(state, 'watch', 'Example-broken.json')), false);
  assert.equal(existsSync(saved), true);
  assert.deepEqual([lastTick(state).exitCode, lastTick(state).errors], [1, [error]]);
  edit(f, live => { live.pulls = [pr(1, headA, { draft: true })]; });
  const second = watch(f, file);
  assert.equal(second.status, 1);
  assert.deepEqual(JSON.parse(second.stdout).woken, ['sweep', 'raiz']);
  assert.deepEqual([wakeFiles(state, 'sweep')?.length, wakeFiles(state, 'raiz')?.length], [1, 1]);
});
test('a read that fails inside a repository keeps its stored ETags and wakes nothing for it, so the next tick still sees the change', t => {
  const f = fixture(); t.after(f.cleanup);
  const { file, state, saved } = configured(f);
  edit(f, live => { live.pulls = [pr(1, headA)]; });
  assert.equal(watch(f, file).status, 0);
  const stored = readFileSync(saved, 'utf8');
  edit(f, live => { live.pulls = [pr(1, headA, { labels: [{ name: 'needs-victor' }] })]; live.failEndpoint = `commits/${headA}/check-runs`; });
  const failed = watch(f, file);
  assert.equal(failed.status, 1);
  assert.equal(failed.stderr, `Example/app: commits/${headA}/check-runs?filter=all&per_page=100: gh request failed\n`);
  assert.deepEqual(JSON.parse(failed.stdout).woken, []);
  assert.deepEqual([wakeFiles(state, 'sweep'), wakeFiles(state, 'raiz')], [null, null]);
  assert.equal(readFileSync(saved, 'utf8'), stored);
  edit(f, live => { live.failEndpoint = ''; });
  const next = watch(f, file);
  assert.equal(next.status, 0, next.stderr);
  assert.deepEqual(JSON.parse(next.stdout).woken, ['sweep', 'raiz']);
});
test('an answer without an ETag is an error for its repository: the watcher could never see that resource change', t => {
  const f = fixture(); t.after(f.cleanup);
  const { file, saved } = configured(f);
  edit(f, live => { live.pulls = [pr(1, headA)]; live.omitEtag = true; });
  const result = watch(f, file);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'Example/app: pulls?state=open&per_page=100: answered 200 without an ETag\n');
  assert.equal(existsSync(saved), false);
});
test('a watch file that does not parse is an error for its repository, which reads everything afresh, wakes nothing and rewrites the file', t => {
  const f = fixture(); t.after(f.cleanup);
  const { file, state, saved } = configured(f);
  edit(f, live => { live.pulls = [pr(1, headA)]; });
  mkdirSync(join(state, 'watch'), { recursive: true }); writeFileSync(saved, '{');
  const broken = watch(f, file);
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /^Example\/app: Invalid watch file .*Example-app\.json: /);
  assert.deepEqual(JSON.parse(broken.stdout).woken, []);
  assert.ok(reads(f).every(([, etag]) => etag === null));
  assert.equal(JSON.parse(readFileSync(saved, 'utf8')).heads[0], headA);
  const next = watch(f, file);
  assert.equal(next.status, 0, next.stderr);
  assert.equal(next.stdout, '');
});
test('a dry run reads with the stored ETags and prints what it would wake, but stores no ETag, leaves no wake and records no tick', t => {
  const f = fixture(); t.after(f.cleanup);
  const { file, state, saved } = configured(f);
  edit(f, live => { live.pulls = [pr(1, headA)]; });
  const fresh = watch(f, file, ['--dry-run']);
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.deepEqual(JSON.parse(fresh.stdout), { job: 'watch', repos: [{ repo: 'Example/app', reads: 3, changed: [], failure: null }], woken: [] });
  assert.equal(existsSync(state), false, 'a dry run writes nothing');
  assert.equal(watch(f, file).status, 0);
  const stored = readFileSync(saved, 'utf8');
  const recorded = readFileSync(join(state, 'last-tick-watch.json'), 'utf8');
  edit(f, live => { live.pulls = [pr(1, headA, { labels: [{ name: 'needs-victor' }] })]; });
  const dry = watch(f, file, ['--dry-run']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.deepEqual([JSON.parse(dry.stdout).repos[0].changed, JSON.parse(dry.stdout).woken], [[pulls], ['sweep', 'raiz']]);
  assert.deepEqual([wakeFiles(state, 'sweep'), wakeFiles(state, 'raiz')], [null, null]);
  assert.equal(readFileSync(saved, 'utf8'), stored);
  assert.equal(readFileSync(join(state, 'last-tick-watch.json'), 'utf8'), recorded);
  const real = watch(f, file);
  assert.deepEqual(JSON.parse(real.stdout).woken, ['sweep', 'raiz'], 'the dry run stored nothing, so the real tick still sees the change');
});
test('nudge refuses the watch job: nothing waits on it', t => {
  const f = fixture(); t.after(f.cleanup);
  const { file, state } = configured(f);
  const result = f.run('converge-local', ['nudge', '--job', 'watch', '--config', file]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^Usage: converge-local .*tick --job sweep\|raiz\|watch .*nudge \[--job sweep\|raiz\]/);
  assert.equal(wakeFiles(state, 'watch'), null);
});
test('the watch plist runs the watch tick at load and every 60 seconds, whatever intervalMinutes says, with no wake queue, and logs to its own file', () => {
  const text = plist('watch', { pluginDir: '/Users/v/Dev/pstack-vic', configFile: '/Users/v/.config/pstack/converge-local.json', intervalMinutes: 10, logDirectory: '/Users/v/Library/Logs', stateDirectory: '/Users/v/Library/Application Support/pstack/converge-local', path: '/usr/bin:/bin', nodePath: '/Users/v/node' });
  assert.match(text, /<key>Label<\/key><string>com\.pstack\.converge-watch<\/string>/);
  assert.match(text, /exec "\/Users\/v\/node" "\/Users\/v\/Dev\/pstack-vic\/skills\/poteto-mode\/scripts\/converge\/converge-local" tick --job watch --config "\/Users\/v\/\.config\/pstack\/converge-local\.json"/);
  assert.match(text, /<key>StartInterval<\/key><integer>60<\/integer>/);
  assert.match(text, /<key>RunAtLoad<\/key><true\/>/);
  assert.doesNotMatch(text, /QueueDirectories/);
  assert.match(text, /<key>StandardOutPath<\/key><string>\/Users\/v\/Library\/Logs\/pstack-converge-watch\.log<\/string>/);
  assert.match(text, /<key>StandardErrorPath<\/key><string>\/Users\/v\/Library\/Logs\/pstack-converge-watch\.log<\/string>/);
});
