import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fixture, moveTrunk, publishCertificate } from './fixtures/setup.ts';

function published(f: ReturnType<typeof fixture>) {
  const report = join(f.directory, 'report.json');
  assert.equal(f.run('converge-reconcile', ['--repo', 'Example/app', '--pr', '1', '--output', report]).status, 0);
  assert.equal(f.run('publish.ts', ['--report', report, '--evidence', join(f.directory, 'evidence')]).status, 0);
}
function listed(f: ReturnType<typeof fixture>, extra: Record<string, unknown>[] = []) {
  const live = f.read();
  live.pulls = [{ number: 1, head: { sha: live.head, ref: 'change' }, base: { ref: 'main' }, state: 'open', draft: false, labels: live.hold ? [{ name: 'needs-victor' }] : [], auto_merge: live.autoMerge ? {} : null, user: { id: 10, login: 'author', type: 'User' }, body: live.body }, ...extra];
  Object.assign(f.state, live); f.save();
}
function other(number: number, fields: Record<string, unknown>) {
  return { number, head: { sha: 'e'.repeat(40), ref: 'other' }, base: { ref: 'main' }, state: 'open', draft: false, labels: [], auto_merge: null, user: { id: 10, login: 'author', type: 'User' }, body: '', ...fields };
}
function outcomes(stdout: string) {
  return JSON.parse(stdout).swept.map((s: { pr: number; outcome: string; reason: string }) => [s.pr, s.outcome, s.reason]);
}
function merge(head: string) {
  return [['pr', 'merge', '1', '--repo', 'Example/app', '--squash', '--auto', '--match-head-commit', head]];
}
test('sweep arms the certified PR on trunk and skips the stacked, held, armed and draft ones', t => {
  const f = fixture(); t.after(f.cleanup); published(f);
  listed(f, [other(2, { base: { ref: 'change' } }), other(3, { labels: [{ name: 'needs-victor' }] }), other(4, { auto_merge: {} }), other(5, { draft: true })]);
  const result = f.run('converge-sweep', ['--repo', 'Example/app']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(outcomes(result.stdout), [[1, 'armed', ''], [2, 'skipped', 'base is not trunk'], [3, 'skipped', 'hold label'], [4, 'skipped', 'auto-merge already pending'], [5, 'skipped', 'draft']]);
  assert.deepEqual(f.read().mutations, merge(f.state.head));
});
test('sweep skips a PR without a trusted verdict and exits 0', t => {
  const f = fixture(); t.after(f.cleanup); listed(f);
  const result = f.run('converge-sweep', ['--repo', 'Example/app']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(outcomes(result.stdout), [[1, 'skipped', 'no trusted verdict on head']]);
  assert.deepEqual(f.read().mutations, []);
});
test('sweep reports a refused arm without stopping and exits 1', t => {
  const f = fixture(); t.after(f.cleanup); published(f);
  const live = f.read(); live.trunkRed = true; Object.assign(f.state, live); f.save(); listed(f, [other(2, { draft: true })]);
  const result = f.run('converge-sweep', ['--repo', 'Example/app']);
  assert.equal(result.status, 1);
  assert.deepEqual(outcomes(result.stdout), [[1, 'refused', 'Trunk Tests is not successful at the current tip'], [2, 'skipped', 'draft']]);
  assert.deepEqual(f.read().mutations, []);
});
test('sweep arms a certificate published before trunk moved, and its dry run makes no mutation', t => {
  const f = fixture(); t.after(f.cleanup); publishCertificate(f);
  moveTrunk(f); listed(f);
  const dry = f.run('converge-sweep', ['--repo', 'Example/app', '--dry-run']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.deepEqual(outcomes(dry.stdout), [[1, 'dry-run', '']]);
  assert.deepEqual(f.read().mutations, []);
  const result = f.run('converge-sweep', ['--repo', 'Example/app']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(outcomes(result.stdout), [[1, 'armed', '']]);
  assert.deepEqual(f.read().mutations, merge(f.state.head));
});
test('sweep refuses a VERIFIED verdict status from another account and exits 1', t => {
  const f = fixture(); t.after(f.cleanup);
  const live = f.read(); live.statuses = [{ context: 'verdict', state: 'success', description: 'VERIFIED by converge', target_url: 'https://github.com/Example/app/pull/1#issuecomment-100', id: 200, creator: { id: 8, login: 'other-bot' } }]; Object.assign(f.state, live); f.save(); listed(f);
  const result = f.run('converge-sweep', ['--repo', 'Example/app']);
  assert.equal(result.status, 1);
  assert.deepEqual(outcomes(result.stdout), [[1, 'refused', 'VERIFIED verdict status was posted by another account: other-bot']]);
  assert.deepEqual(f.read().mutations, []);
});
