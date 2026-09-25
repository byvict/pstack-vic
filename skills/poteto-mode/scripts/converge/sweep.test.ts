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
test('sweep arms the certified PR on trunk and skips the stacked, held and draft ones', t => {
  const f = fixture(); t.after(f.cleanup); published(f);
  listed(f, [other(2, { base: { ref: 'change' } }), other(3, { labels: [{ name: 'needs-victor' }] }), other(5, { draft: true })]);
  const result = f.run('converge-sweep', ['--repo', 'Example/app']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(outcomes(result.stdout), [[1, 'armed', ''], [2, 'skipped', 'base is not trunk'], [3, 'skipped', 'hold label'], [5, 'skipped', 'draft']]);
  assert.deepEqual(f.read().mutations, merge(f.state.head));
});
for (const unlinked of [false, true]) test(`sweep skips a PR ${unlinked ? 'whose VERIFIED status has no link' : 'without a verdict status'} and exits 0`, t => {
  const f = fixture(); t.after(f.cleanup);
  if (unlinked) { const live = f.read(); live.statuses = [{ context: 'verdict', state: 'success', description: 'VERIFIED by converge', id: 200, creator: { id: 7 } }]; Object.assign(f.state, live); f.save(); }
  listed(f);
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
for (const dryRun of [false, true]) {
  test(`sweep ${dryRun ? 'dry run reports' : 'disarms'} a held PR whose auto-merge is pending`, t => {
    const f = fixture(); t.after(f.cleanup);
    const live = f.read(); live.hold = true; live.autoMerge = true; Object.assign(f.state, live); f.save(); listed(f);
    const result = f.run('converge-sweep', ['--repo', 'Example/app', ...(dryRun ? ['--dry-run'] : [])]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(outcomes(result.stdout), [[1, dryRun ? 'dry-run' : 'disarmed', dryRun ? 'hold label, would disarm auto-merge' : 'hold label']]);
    assert.deepEqual(f.read().mutations, dryRun ? [] : [['pr', 'merge', '1', '--repo', 'Example/app', '--disable-auto']]);
  });
}
const disabled = [['pr', 'merge', '1', '--repo', 'Example/app', '--disable-auto']];
for (const [name, knobs, outcome, reason, mutations] of [
  ['merged before the disarm', { prState: 'closed', autoMerge: false }, 'refused', 'hold label, PR merged or closed before disarm', []],
  ['still armed after the disarm', { stickyAutoMerge: true }, 'refused', 'hold label, auto-merge still pending after disarm', disabled],
  ['already disarmed', { autoMerge: false }, 'skipped', 'hold label, auto-merge already off', []],
] as const) {
  test(`sweep reports a held armed PR ${name} as ${outcome}`, t => {
    const f = fixture(); t.after(f.cleanup);
    const live = f.read(); live.hold = true; live.autoMerge = true; Object.assign(f.state, live); f.save(); listed(f);
    const now = f.read(); Object.assign(now, knobs); Object.assign(f.state, now); f.save();
    const result = f.run('converge-sweep', ['--repo', 'Example/app']);
    assert.equal(result.status, outcome === 'refused' ? 1 : 0, result.stderr);
    assert.deepEqual(outcomes(result.stdout), [[1, outcome, reason]]);
    assert.deepEqual(f.read().mutations, mutations);
  });
}
for (const [name, verdict, outcome, reason] of [
  ['a trusted verdict', 'trusted', 'skipped', 'auto-merge already pending'],
  ['no verdict', 'none', 'disarmed', 'no trusted verdict on head'],
  ['a verdict from another account', 'foreign', 'disarmed', 'VERIFIED verdict status was posted by another account: other-bot'],
] as const) {
  test(`sweep keeps auto-merge only on a head with a trusted verdict: ${name} is ${outcome}`, t => {
    const f = fixture(); t.after(f.cleanup);
    if (verdict === 'trusted') published(f);
    const live = f.read(); live.autoMerge = true;
    if (verdict === 'foreign') live.statuses = [{ context: 'verdict', state: 'success', description: 'VERIFIED by converge', target_url: 'https://github.com/Example/app/pull/1#issuecomment-100', id: 200, creator: { id: 8, login: 'other-bot' } }];
    Object.assign(f.state, live); f.save(); listed(f);
    const result = f.run('converge-sweep', ['--repo', 'Example/app']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(outcomes(result.stdout), [[1, outcome, reason]]);
    assert.deepEqual(f.read().mutations, outcome === 'disarmed' ? disabled : []);
  });
}
test('sweep dry run reports an armed PR without a trusted verdict and makes no mutation', t => {
  const f = fixture(); t.after(f.cleanup);
  const live = f.read(); live.autoMerge = true; Object.assign(f.state, live); f.save(); listed(f);
  const result = f.run('converge-sweep', ['--repo', 'Example/app', '--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(outcomes(result.stdout), [[1, 'dry-run', 'no trusted verdict on head, would disarm auto-merge']]);
  assert.deepEqual(f.read().mutations, []);
});
