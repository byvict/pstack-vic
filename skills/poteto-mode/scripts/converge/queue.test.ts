import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { mergeGroup, parseCandidate, queueRetry, type QueueCandidate, type QueueEntry, type QueueSnapshot } from './queue.ts';
import { dossierFromComment } from './publish.ts';
import { fixture, git, commit, publishCertificate, certifiedPr, prReport } from './fixtures/setup.ts';
import { pull, trusted } from './github.ts';
import { classify } from './local/classify.ts';
import { protectedObservations, protectedResult } from './protection.ts';

const trunk = 'a'.repeat(40), first = 'd'.repeat(40), combined = 'e'.repeat(40);
const candidate: QueueCandidate = { repo: 'Example/app', baseSha: first, headSha: combined, baseRef: 'refs/heads/main', headRef: 'refs/heads/gh-readonly-queue/main/pr-2-generated' };
const entries: QueueEntry[] = [
  { id: 'MQ_1', position: 1, state: 'AWAITING_CHECKS', base: trunk, head: first, pr: 1, prHead: 'b'.repeat(40) },
  { id: 'MQ_2', position: 2, state: 'AWAITING_CHECKS', base: first, head: combined, pr: 2, prHead: 'c'.repeat(40) },
];
function snapshot(): QueueSnapshot { return { trunk, candidateHead: combined, entries: structuredClone(entries) }; }
function event(c = candidate) { return { action: 'checks_requested', repository: { full_name: c.repo }, merge_group: { base_sha: c.baseSha, head_sha: c.headSha, base_ref: c.baseRef, head_ref: c.headRef } }; }

test('the exact event candidate uses the entire live queue prefix, not its immediate base or branch-name PR', () => {
  assert.deepEqual(parseCandidate(event(), { repo: candidate.repo, head: combined, ref: candidate.headRef }), candidate);
  assert.deepEqual(mergeGroup(candidate, snapshot()), { ...candidate, baseSha: trunk, members: [{ pr: 1, head: entries[0]?.prHead }, { pr: 2, head: entries[1]?.prHead }] });
  const firstCandidate = { ...candidate, baseSha: trunk, headSha: first };
  assert.deepEqual(mergeGroup(firstCandidate, { ...snapshot(), candidateHead: first }).members, [{ pr: 1, head: entries[0]?.prHead }]);
});
test('a predecessor merged at its exact synthetic SHA becomes the current root, without recertifying protected trunk', () => {
  const remaining = entries[1]; assert.ok(remaining);
  assert.deepEqual(mergeGroup(candidate, { trunk: first, candidateHead: combined, entries: [{ ...remaining, position: 1 }] }), { ...candidate, baseSha: first, members: [{ pr: 2, head: remaining.prHead }] });
});
for (const [name, change] of [
  ['reordered members', (s: QueueSnapshot) => { s.entries.reverse(); s.entries.forEach((e, i) => e.position = i + 1); }],
  ['missing predecessor', (s: QueueSnapshot) => { s.entries.shift(); }],
  ['missing candidate', (s: QueueSnapshot) => { s.entries.pop(); }],
  ['stale trunk base', (s: QueueSnapshot) => { s.trunk = 'f'.repeat(40); }],
  ['moved group ref', (s: QueueSnapshot) => { s.candidateHead = first; }],
  ['unbuilt predecessor', (s: QueueSnapshot) => { const e = s.entries[0]; if (e) e.head = null; }],
  ['unmergeable candidate', (s: QueueSnapshot) => { const e = s.entries[1]; if (e) e.state = 'UNMERGEABLE'; }],
  ['duplicate position', (s: QueueSnapshot) => { const e = s.entries[1]; if (e) e.position = 1; }],
] satisfies [string, (s: QueueSnapshot) => void][]) test(`group identity refuses ${name}`, () => { const s = snapshot(); change(s); assert.throws(() => mergeGroup(candidate, s)); });
for (const expected of [{ repo: 'Other/app', head: combined, ref: candidate.headRef }, { repo: candidate.repo, head: first, ref: candidate.headRef }, { repo: candidate.repo, head: combined, ref: 'refs/heads/another' }]) test(`event identity refuses ${JSON.stringify(expected)}`, () => assert.throws(() => parseCandidate(event(), expected), /workflow candidate/));

type Fixture = ReturnType<typeof fixture>;
function edit(f: Fixture, change: (live: ReturnType<Fixture['read']>) => void) { const live = f.read(); change(live); Object.assign(f.state, live); f.save(); }
function queued(f: Fixture) {
  const c = { ...candidate, baseSha: f.state.trunk, headSha: first };
  edit(f, live => {
    live.queueEnabled = true; live.queueHead = first;
    live.queueEntry = { state: 'AWAITING_CHECKS', headCommit: { oid: first } };
    live.queueEntries = [{ id: 'MQ_1', position: 1, state: 'AWAITING_CHECKS', baseCommit: { oid: live.trunk }, headCommit: { oid: first }, pullRequest: { number: 1, headRefOid: live.head } }];
  });
  return c;
}
function run(f: Fixture, mode = 'verdict', c = queued(f), extra: string[] = [], env: NodeJS.ProcessEnv = {}) {
  const path = join(f.directory, 'event.json'); writeFileSync(path, JSON.stringify(event(c)));
  return f.run('converge-queue', [mode, '--repo', c.repo, '--event', path, '--head', c.headSha, '--ref', c.headRef, '--publisher', '7', ...extra], env);
}
test('Actions re-derives a real pre-pr certificate with the pinned publisher, even though the token viewer differs', t => {
  const f = fixture(); t.after(f.cleanup); publishCertificate(f);
  edit(f, live => { live.viewerId = 999; });
  const viewers = () => f.calls().filter(a => a.some(s => s.includes('query=query { viewer'))).length;
  const before = viewers();
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).members, [{ pr: 1, head: f.state.head }]);
  assert.equal(viewers(), before, 'the Actions validator uses the protected publisher pin');
});
for (const fault of ['missing', 'foreign', 'stale', 'superseded', 'held', 'changed-head', 'policy', 'truncated']) test(`group certificate refuses ${fault}`, t => {
  const f = fixture(); t.after(f.cleanup); publishCertificate(f); const c = queued(f);
  edit(f, live => {
    if (fault === 'missing') live.statuses = [];
    if (fault === 'foreign') live.statuses[0].creator.id = 8;
    if (fault === 'stale') {
      const d = dossierFromComment(live.comments[0]); d.round.head = 'f'.repeat(40);
      live.comments[0].body = `<!-- converge:v1 ${d.round.id} -->\n\`\`\`json\n${JSON.stringify(d)}\n\`\`\`\n`;
    }
    if (fault === 'superseded') live.comments.push({ ...live.comments[0], id: 101 });
    if (fault === 'held') live.hold = true;
    if (fault === 'changed-head') live.head = 'f'.repeat(40);
    if (fault === 'policy') live.blobs['verify/SKILL.md'] += '\nNew mandatory evidence.';
    if (fault === 'truncated') live.queueTruncated = true;
  });
  const result = run(f, 'verdict', c); assert.notEqual(result.status, 0, result.stdout);
  assert.equal(f.read().mutations.length, 0, 'a group gate never writes a publication, status or queue');
});
test('live membership changed during certificate reads is refused against the updated original head', t => {
  const f = fixture(); t.after(f.cleanup); publishCertificate(f); const c = queued(f);
  edit(f, live => { live.after = { endpoint: 'queue', reads: 1, set: { queueEntries: [{ ...live.queueEntries[0], pullRequest: { number: 1, headRefOid: 'f'.repeat(40) } }] } }; });
  const result = run(f, 'verdict', c); assert.notEqual(result.status, 0); assert.match(result.stderr, /PR head moved/);
});
for (const path of ['.cursor/converge.json', 'features/login.md', '.github/workflows/tests.yml']) test(`a preceding queued PR cannot change ${path} under a later certificate derived from old trunk`, t => {
  const f = fixture(); t.after(f.cleanup); publishCertificate(f); const c = { ...queued(f), baseSha: first, headSha: combined };
  edit(f, live => {
    const head2 = 'f'.repeat(40);
    const original = live.comments[0]; const d = dossierFromComment(original); d.round.pr = 2;
    const second = { ...original, id: 302, html_url: 'https://github.com/Example/app/pull/2#issuecomment-302', body: `<!-- converge:v1 ${d.round.id} -->\n\`\`\`json\n${JSON.stringify(d).replaceAll(live.head, head2)}\n\`\`\`\n` };
    live.memberHeads = [head2]; live.memberComments = { 2: [second] };
    live.statuses.push({ ...live.statuses[0], id: 303, sha: head2, target_url: second.html_url });
    live.pulls = [{ number: 2, head: { sha: head2, ref: 'change-2', repo: { full_name: 'Example/app' } }, base: { ref: 'main' }, state: 'open', draft: false, body: live.body, labels: [], user: { id: 10, login: 'author', type: 'User' }, auto_merge: null, created_at: live.createdAt }];
    live.queueHead = combined;
    live.queueEntries.push({ id: 'MQ_2', position: 2, state: 'AWAITING_CHECKS', baseCommit: { oid: first }, headCommit: { oid: combined }, pullRequest: { number: 2, headRefOid: head2 } });
    live.groupFiles = [{ filename: path, status: 'modified' }];
  });
  const result = run(f, 'verdict', c); assert.notEqual(result.status, 0); assert.match(result.stderr, /Merge group changes certificate policy/);
});
test('a group verdict waits for exact synthetic-head checks and rejects a combined failure despite green PR checks', t => {
  const f = fixture(); t.after(f.cleanup); publishCertificate(f); const c = queued(f);
  edit(f, live => { live.refChecks = { [first]: live.checks.map((check: Record<string, unknown>) => ({ ...check, conclusion: check.name === 'Run test suite' ? 'failure' : 'success' })) }; });
  const result = run(f, 'verdict', c, ['--wait'], { GITHUB_ACTIONS: 'true', GH_TOKEN: 'synthetic-read-token' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Combined protected check failed.*Run test suite/);
  assert.equal(f.read().mutations.length, 0);
});
test('a ready exact-head group uses the read-only Actions token and branch-summary protection, not admin APIs', t => {
  const f = fixture(); t.after(f.cleanup); publishCertificate(f); const c = queued(f);
  edit(f, live => { live.requireInstallationChecks = true; });
  const result = run(f, 'verdict', c, ['--wait'], { GITHUB_ACTIONS: 'true', GH_TOKEN: 'synthetic-read-token' });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(f.calls().some(a => a[1] === 'repos/Example/app/branches/main'));
  assert.ok(!f.calls().some(a => a[1]?.endsWith('/protection')));
});
for (const [state, strict, pending] of [['success', 0, 0], ['failure', 1, 1], ['error', 1, 1], ['pending', 1, 0]] as const) test(`legacy required status ${state} admits strict=${strict === 0} and pending=${pending === 0}`, t => {
  const f = fixture(); t.after(f.cleanup); publishCertificate(f);
  edit(f, live => {
    live.protected.push('Legacy build'); live.statusContexts = ['Legacy build'];
    live.statuses.push({ id: 900, context: 'Legacy build', state, sha: live.head, updated_at: '2026-09-30T00:00:00Z' });
  });
  const args = ['--repo', 'Example/app', '--pr', '1', '--head', f.state.head, '--verdict', 'VERIFIED', '--dry-run'];
  assert.equal(f.run('converge-arm', args).status, strict);
  assert.equal(f.run('converge-arm', [...args, '--pending']).status, pending);
  assert.equal(f.read().mutations.length, 0);
});
test('an exact group accepts a latest successful legacy status after an earlier failed one', t => {
  const f = fixture(); t.after(f.cleanup); publishCertificate(f); const c = queued(f);
  edit(f, live => {
    live.protected.push('Legacy build'); live.statusContexts = ['Legacy build'];
    live.statuses.push({ id: 800, context: 'Legacy build', state: 'failure', sha: c.headSha }, { id: 900, context: 'Legacy build', state: 'success', sha: c.headSha });
  });
  const result = run(f, 'verdict', c, ['--wait']);
  assert.equal(result.status, 0, result.stderr); assert.equal(f.read().mutations.length, 0);
});
for (const pair of [['success', 'failure'], ['failure', 'success']] as const) test(`same-name check=${pair[0]} and legacy status=${pair[1]} both have to pass arm and group validation`, t => {
  const f = fixture(); t.after(f.cleanup); publishCertificate(f);
  edit(f, live => {
    live.checks[1].conclusion = pair[0];
    live.statuses.push({ id: 900, context: 'Secrets scan', state: pair[1], sha: live.head });
  });
  const args = ['--repo', 'Example/app', '--pr', '1', '--head', f.state.head, '--verdict', 'VERIFIED', '--dry-run'];
  assert.notEqual(f.run('converge-arm', args).status, 0);
  assert.notEqual(f.run('converge-arm', [...args, '--pending']).status, 0);
  const c = queued(f); edit(f, live => { live.statuses.push({ id: 901, context: 'Secrets scan', state: pair[1], sha: c.headSha }); });
  const result = run(f, 'verdict', c, ['--wait']); assert.notEqual(result.status, 0); assert.match(result.stderr, /Combined protected check failed/);
});
test('an unbound legacy status cannot satisfy an app-bound requirement, and original-head green cannot prove a group', async t => {
  const f = fixture(); t.after(f.cleanup); const c = queued(f);
  edit(f, live => {
    live.checks = live.checks.filter((check: { name: string }) => check.name !== 'Secrets scan');
    live.statuses.push({ id: 900, context: 'Secrets scan', state: 'success', sha: c.headSha, creator: { id: 15368 } }, { id: 901, context: 'Original only', state: 'success', sha: live.head });
  });
  const observed = await withFixture(f, () => protectedObservations('Example/app', c.headSha));
  assert.equal(protectedResult({ context: 'Secrets scan', appId: 15368 }, observed).found, false);
  assert.equal(protectedResult({ context: 'Original only', appId: null }, observed).found, false);
});
test('a foreign newer run never hides failure from the app protection actually requires', t => {
  const f = fixture(); t.after(f.cleanup); publishCertificate(f);
  edit(f, live => { live.checks[1].conclusion = 'failure'; live.checks.push({ id: 900, name: 'Secrets scan', status: 'completed', conclusion: 'success', app: { id: 99 } }); });
  const result = f.run('converge-arm', ['--repo', 'Example/app', '--pr', '1', '--head', f.state.head, '--verdict', 'VERIFIED', '--pending', '--dry-run']);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Required protected check failed: Secrets scan/);
});
test('a live hold dequeues a PR even when native queue admission left autoMerge null', t => {
  const f = fixture(); t.after(f.cleanup); publishCertificate(f); queued(f); edit(f, live => { live.hold = true; });
  const path = join(f.directory, 'invalidate.json'); writeFileSync(path, JSON.stringify({ repository: { full_name: 'Example/app' }, pull_request: { number: 1 } }));
  const result = f.run('converge-queue', ['invalidate', '--repo', 'Example/app', '--event', path, '--publisher', '7']);
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).invalidated[0].dequeued, true);
  assert.deepEqual(f.read().mutations, [['dequeue', 'PR_1']]);
  assert.equal(f.read().autoMerge, false);
});
test('a comment after the group certificate also invalidates the live queue admission', t => {
  const f = fixture(); t.after(f.cleanup); publishCertificate(f); queued(f);
  edit(f, live => { live.comments.push({ id: 301, user: { id: 10, login: 'author' }, body: 'Please verify the result.', created_at: '2026-09-22T00:00:00Z', updated_at: '2026-09-22T00:00:00Z' }); });
  const path = join(f.directory, 'invalidate.json'); writeFileSync(path, JSON.stringify({ repository: { full_name: 'Example/app' }, issue: { number: 1, pull_request: {} } }));
  const result = f.run('converge-queue', ['invalidate', '--repo', 'Example/app', '--event', path, '--publisher', '7']);
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).invalidated[0].dequeued, true);
});
for (const fallback of [false, true]) test(`trusted review invalidation derives live GitHub PR associations, commit fallback=${fallback}, without artifacts`, t => {
  const f = fixture(); t.after(f.cleanup); publishCertificate(f); queued(f);
  edit(f, live => {
    live.hold = true;
    live.reviewSignal = { id: 99, status: 'completed', event: 'pull_request_review_comment', head_sha: first, pull_requests: fallback ? [] : [{ number: 1 }] };
    live.commitPulls = { [first]: [{ number: 1 }] };
  });
  const path = join(f.directory, 'review.json'); writeFileSync(path, JSON.stringify({ action: 'completed', repository: { full_name: 'Example/app' }, workflow_run: { id: 99, pull_requests: [{ number: 900 }] } }));
  const result = f.run('converge-queue', ['invalidate', '--repo', 'Example/app', '--event', path, '--publisher', '7']);
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout).invalidated.map((r: { pr: number; dequeued: boolean }) => [r.pr, r.dequeued]), [[1, true]]);
  assert.ok(!f.calls().some(a => String(a[1]).includes('/artifacts')));
  assert.equal(f.calls().some(a => String(a[1]).includes(`/commits/${first}/pulls`)), fallback);
});
for (const [name, signal] of [
  ['foreign event', { id: 99, status: 'completed', event: 'pull_request', pull_requests: [{ number: 1 }] }],
  ['unfinished run', { id: 99, status: 'in_progress', event: 'pull_request_review', pull_requests: [{ number: 1 }] }],
  ['missing association', { id: 99, status: 'completed', event: 'pull_request_review', head_sha: first, pull_requests: [] }],
] satisfies [string, Record<string, unknown>][]) test(`review signal refuses ${name} without a queue write`, t => {
  const f = fixture(); t.after(f.cleanup); queued(f); edit(f, live => { live.reviewSignal = signal; });
  const path = join(f.directory, 'review.json'); writeFileSync(path, JSON.stringify({ action: 'completed', repository: { full_name: 'Example/app' }, workflow_run: { id: 99 } }));
  const result = f.run('converge-queue', ['invalidate', '--repo', 'Example/app', '--event', path, '--publisher', '7']);
  assert.notEqual(result.status, 0); assert.equal(f.read().mutations.length, 0);
});
test('a new publication refuses active queue membership before it writes any verdict', t => {
  const f = fixture(); t.after(f.cleanup); const dir = certifiedPr(f); const report = prReport(f); queued(f);
  const result = f.run('publish.ts', ['--report', report, '--certificate', join(dir, 'certificate.json'), '--evidence', join(f.directory, 'evidence')]);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /dequeue it before publishing/); assert.equal(f.read().statuses.length, 0);
});
test('a queue removal requires a strictly newer trusted certificate before another admission', t => {
  const f = fixture(); t.after(f.cleanup); publishCertificate(f); const d = dossierFromComment(f.read().comments[0]);
  const gate = { kind: 'certified' as const, dossier: d, publishedAt: '2026-09-30T12:00:00Z', url: 'https://example.invalid', fingerprint: '', rederived: null };
  const removal = { kind: 'removed' as const, at: gate.publishedAt, reason: 'failed_checks', head: combined };
  assert.match(queueRetry(removal, gate) ?? '', /new certificate is required/);
  assert.equal(queueRetry(removal, { ...gate, publishedAt: '2026-09-30T12:00:01Z' }), null);
  assert.equal(queueRetry({ kind: 'eligible' }, gate), null);
});
async function withFixture<T>(f: Fixture, work: () => Promise<T>): Promise<T> {
  const saved = { PATH: process.env.PATH, CONVERGE_FIXTURE: process.env.CONVERGE_FIXTURE };
  process.env.PATH = f.directory + ':' + process.env.PATH; process.env.CONVERGE_FIXTURE = f.statePath;
  try { return await work(); }
  finally { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
}
test('the sweep and daemon leave native queued candidates to GitHub, without autoMerge or a five-minute retry', async t => {
  const f = fixture(); t.after(f.cleanup); publishCertificate(f); queued(f); edit(f, live => { live.pulls = [{ number: 1, head: { sha: live.head } }]; live.mergeState = 'clean'; });
  const swept = f.run('converge-sweep', ['--repo', 'Example/app']); assert.equal(swept.status, 0, swept.stderr); assert.equal(JSON.parse(swept.stdout).swept[0].reason, 'merge queue owns this candidate');
  const state = await withFixture(f, async () => classify(await trusted('Example/app', '.cursor/converge.json'), await pull('Example/app', 1), 7, { now: Date.now(), leased: () => false, trusted: ['author', 'converge'] }));
  assert.equal(state.kind, 'idle'); assert.match(state.reason, /merge queue owns/); assert.equal(f.read().mutations.length, 0);
});
test('a rejected combined candidate is repair work, and sweep ticks never reenqueue its old certificate', async t => {
  const f = fixture(); t.after(f.cleanup); publishCertificate(f);
  edit(f, live => { live.queueEnabled = true; live.queueEvent = { __typename: 'RemovedFromMergeQueueEvent', createdAt: '2026-09-30T00:00:00Z', reason: 'failed_checks', beforeCommit: { oid: combined } }; live.pulls = [{ number: 1, head: { sha: live.head } }]; });
  for (let attempt = 0; attempt < 2; attempt++) { const swept = f.run('converge-sweep', ['--repo', 'Example/app']); assert.notEqual(swept.status, 0); assert.match(swept.stdout, /a new certificate is required/); }
  const state = await withFixture(f, async () => classify(await trusted('Example/app', '.cursor/converge.json'), await pull('Example/app', 1), 7, { now: Date.now(), leased: () => false, trusted: ['author', 'converge'] }));
  assert.equal(state.kind, 'pending'); if (state.kind === 'pending') assert.equal(state.work, 'repair'); assert.match(state.reason, new RegExp(combined)); assert.equal(f.read().mutations.length, 0);
});
for (const [queue, red, expected] of [[true, false, 0], [false, false, 1], [true, true, 1]] as const) test(`native queue=${queue} admits pending trunk CI=${!red}, expected exit ${expected}`, t => {
  const f = fixture(); t.after(f.cleanup); publishCertificate(f);
  edit(f, live => { live.queueEnabled = queue; live.pushRuns = { [live.trunk]: { status: red ? 'completed' : 'in_progress', conclusion: red ? 'failure' : null } }; });
  const result = f.run('converge-arm', ['--repo', 'Example/app', '--pr', '1', '--head', f.state.head, '--verdict', 'VERIFIED', '--pending', '--dry-run']); assert.equal(result.status, expected, result.stderr);
});
test('two independently green PRs combine without a text conflict and fail their behavioral suite', t => {
  const f = fixture(); t.after(f.cleanup); const repo = join(f.directory, 'combination'); mkdirSync(repo); git(repo, ['init', '-q', '-b', 'main']);
  for (const file of ['a', 'b']) writeFileSync(join(repo, `${file}.json`), '{"allocation":4}\n');
  writeFileSync(join(repo, 'suite.mjs'), `import { readFileSync } from 'node:fs';\nconst total = ['a','b'].reduce((sum, name) => sum + JSON.parse(readFileSync(name + '.json')).allocation, 0);\nconsole.log('combined allocation ' + total + ' (limit 10)');\nprocess.exitCode = total > 10 ? 1 : 0;\n`);
  const base = commit(repo, 'base');
  const suite = () => spawnSync(process.execPath, ['suite.mjs'], { cwd: repo, encoding: 'utf8' });
  git(repo, ['checkout', '-q', '-b', 'candidate-a']); writeFileSync(join(repo, 'a.json'), '{"allocation":6}\n'); const a = commit(repo, 'first independent PR'); const singleA = suite(); assert.equal(singleA.status, 0, singleA.stdout);
  git(repo, ['checkout', '-q', '-b', 'candidate-b', base]); writeFileSync(join(repo, 'b.json'), '{"allocation":6}\n'); const b = commit(repo, 'second independent PR'); const singleB = suite(); assert.equal(singleB.status, 0, singleB.stdout);
  git(repo, ['checkout', '-q', 'candidate-a']); git(repo, ['merge', '--no-edit', 'candidate-b']); const group = git(repo, ['rev-parse', 'HEAD']); const together = suite();
  assert.equal(together.status, 1, together.stdout); assert.match(together.stdout, /combined allocation 12/); assert.equal(git(repo, ['rev-parse', 'main']), base);
  t.diagnostic(JSON.stringify({ base, a, b, group, individualA: singleA.status, individualB: singleB.status, combined: together.status, conflict: false }));
});
