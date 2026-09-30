import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseContract } from '../contract.ts';
import { fixture, head, trunk } from '../fixtures/setup.ts';
import { dossier, issueUrl } from '../fixtures/linear.ts';
import { admitLinearMerge, linearTarget, linearTargets, targetIdentity } from './linear-trust.ts';

async function admitted(change: (live: ReturnType<ReturnType<typeof fixture>['read']>) => void = () => undefined) {
  const f = fixture(), live = f.read(), d = dossier();
  Object.assign(live, { merged: true, prState: 'closed', mergeCommit: trunk, mergedAt: '2026-09-30T01:00:00Z', prCommits: [{ sha: head, commit: { message: `change\n\nPstack-Linear: ${issueUrl}` } }], commitPulls: { [trunk]: [{ number: 1, merged_at: '2026-09-30T01:00:00Z', merge_commit_sha: trunk, base: { ref: 'main' } }] }, comments: [{ id: 100, body: `<!-- converge:v1 ${d.round.id} -->\n\`\`\`json\n${JSON.stringify(d)}\n\`\`\``, user: { id: 7 }, created_at: '2026-09-30T00:00:00Z', updated_at: '2026-09-30T00:00:00Z' }], statuses: [{ id: 200, context: 'verdict', state: 'success', description: 'VERIFIED by converge', creator: { id: 7 }, target_url: 'https://github.com/Example/app/pull/1#issuecomment-100' }] });
  change(live); Object.assign(f.state, live); f.save();
  const previous = { PATH: process.env.PATH, CONVERGE_FIXTURE: process.env.CONVERGE_FIXTURE };
  Object.assign(process.env, { PATH: f.directory + ':' + process.env.PATH, CONVERGE_FIXTURE: f.statePath });
  try { return await admitLinearMerge({ repo: 'Example/app', sha: trunk, configPath: '.cursor/converge.json', config: parseContract(JSON.parse(live.blobs['.cursor/converge.json'])), files: new Map(), workflowId: 5, workflowPath: '.github/workflows/tests.yml' }, trunk); }
  finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } f.cleanup(); }
}
test('explicit immutable URLs retain workspace identity and ignore issue title slug changes', () => {
  assert.equal(targetIdentity(linearTarget(issueUrl)), targetIdentity(linearTarget('https://linear.app/example/issue/ENG-1/renamed')));
  assert.equal(linearTargets([`change\n\nPstack-Linear: ${issueUrl}\nPstack-Linear: https://linear.app/other/issue/ENG-1/test`]).length, 2);
  for (const value of ['ENG-1', 'https://linear.app/example/issue/ENG-1/test done', 'https://example.com/example/issue/ENG-1/test']) assert.throws(() => linearTarget(value));
  assert.throws(() => linearTargets([`change\n\nPstack-Linear: ${issueUrl}\n\nbody`]), /final commit trailer/);
});
test('exact merged commit, full certified head, latest trusted status and referenced VERIFIED publication admit the explicit targets', async () => {
  const result = await admitted(); assert.equal(result.kind, 'admitted');
  if (result.kind === 'admitted') assert.deepEqual(result.merge.targets, [linearTarget(issueUrl)]);
});
test('no refs and direct pushes are no-ops without a verifier or Linear launch', async () => {
  assert.equal((await admitted(l => { l.prCommits[0].commit.message = 'change'; l.statuses = []; })).kind, 'noop');
  assert.equal((await admitted(l => { l.commitPulls = {}; })).kind, 'noop');
});
for (const [name, change] of [
  ['merge mismatch', (l: ReturnType<ReturnType<typeof fixture>['read']>) => { l.mergeCommit = 'c'.repeat(40); }],
  ['head mismatch', (l: ReturnType<ReturnType<typeof fixture>['read']>) => { l.prCommits[0].sha = 'c'.repeat(40); }],
  ['base mismatch', (l: ReturnType<ReturnType<typeof fixture>['read']>) => { l.prBase = 'stack'; }],
  ['foreign status', (l: ReturnType<ReturnType<typeof fixture>['read']>) => { l.statuses[0].creator.id = 99; }],
  ['wrong publication', (l: ReturnType<ReturnType<typeof fixture>['read']>) => { l.statuses[0].target_url = 'https://github.com/Example/app/pull/1#issuecomment-999'; }],
  ['latest failed status', (l: ReturnType<ReturnType<typeof fixture>['read']>) => { l.statuses.unshift({ ...l.statuses[0], id: 201, state: 'failure' }); }],
  ['edited publication', (l: ReturnType<ReturnType<typeof fixture>['read']>) => { l.comments[0].updated_at = '2026-09-30T00:30:00Z'; }],
  ['late publication', (l: ReturnType<ReturnType<typeof fixture>['read']>) => { l.comments[0].created_at = l.comments[0].updated_at = '2026-09-30T02:00:00Z'; }],
] satisfies [string, (l: ReturnType<ReturnType<typeof fixture>['read']>) => void][]) test(`Linear admission refuses ${name}`, async () => assert.equal((await admitted(change)).kind, 'refused'));
