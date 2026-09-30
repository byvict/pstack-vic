import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jsonHash } from '../contract.ts';
import { merge } from '../fixtures/linear.ts';
import { assertLinearPlan, createLinearPlan, parseLinearPlan, type LinearPlanInput } from './linear-plan.ts';

function input(): LinearPlanInput {
  const m = merge();
  return { merge: { repo: m.repo, pr: m.pr, head: m.head, commit: m.commit }, sourceDigest: jsonHash({ issue: 'full source', comments: [] }), effects: [{ key: 'comment', tool: 'mcp__claude_ai_Linear__save_comment', args: { issueId: 'ENG-1', body: 'The observed criteria remain open.' } }] };
}
test('a reviewed concrete plan round-trips with a digest of its canonical contents', () => {
  const plan = createLinearPlan(input());
  assert.deepEqual(parseLinearPlan(JSON.parse(JSON.stringify(plan))), plan);
  assert.doesNotThrow(() => assertLinearPlan(plan, createLinearPlan(input())));
  const { digest, ...contents } = plan;
  assert.equal(digest, jsonHash(contents));
});
test('object and effect ordering do not change the canonical plan', () => {
  const original = input();
  original.effects.push({ key: 'complete', tool: 'mcp__claude_ai_Linear__save_issue', args: { id: 'ENG-1', state: 'completed' } });
  original.effects[0].args.context = { z: [false, null, 2], a: { y: 1, b: 'proof' } };
  const reordered = input();
  reordered.effects = [{ ...original.effects[1], args: { state: 'completed', id: 'ENG-1' } }, { ...original.effects[0], args: { body: 'The observed criteria remain open.', context: { a: { b: 'proof', y: 1 }, z: [false, null, 2] }, issueId: 'ENG-1' } }];
  assert.equal(JSON.stringify(createLinearPlan(original)), JSON.stringify(createLinearPlan(reordered)));
});
test('changed merge identity, fresh sources, or concrete effects require a new reviewed plan', () => {
  const reviewed = createLinearPlan(input());
  for (const identity of [{ repo: 'Other/app' }, { pr: 2 }, { head: 'c'.repeat(40) }, { commit: 'd'.repeat(40) }]) {
    const changed = input(); changed.merge = { ...changed.merge, ...identity };
    assert.throws(() => assertLinearPlan(reviewed, createLinearPlan(changed)), /merge changed.*new plan/);
  }
  const changedSource = input(); changedSource.sourceDigest = jsonHash({ issue: 'changed source', comments: [] });
  assert.throws(() => assertLinearPlan(reviewed, createLinearPlan(changedSource)), /sources changed.*new plan/);
  for (const effect of [{ key: 'other', tool: reviewed.effects[0].tool, args: reviewed.effects[0].args }, { ...reviewed.effects[0], tool: 'mcp__claude_ai_Linear__save_issue' }, { ...reviewed.effects[0], args: { issueId: 'ENG-2', body: 'The observed criteria remain open.' } }, { ...reviewed.effects[0], args: { issueId: 'ENG-1', body: 'New content.' } }]) {
    const changed = input(); changed.effects = [effect];
    assert.throws(() => assertLinearPlan(reviewed, createLinearPlan(changed)), /effects changed.*new plan/);
  }
  const completed = input(); completed.effects.push({ key: 'complete', tool: 'mcp__claude_ai_Linear__save_issue', args: { id: 'ENG-1', state: 'completed' } });
  assert.throws(() => assertLinearPlan(reviewed, createLinearPlan(completed)), /effects changed.*new plan/);
  const empty = input(); empty.effects = [];
  assert.throws(() => assertLinearPlan(reviewed, createLinearPlan(empty)), /effects changed.*new plan/);
});
test('an untrusted plan cannot retain its old digest after edits or choose an arbitrary digest', () => {
  const plan = createLinearPlan(input());
  const edited = structuredClone(plan); edited.effects[0].args.body = 'Complete this issue instead.';
  assert.throws(() => parseLinearPlan(edited), /digest does not match/);
  assert.throws(() => parseLinearPlan({ ...plan, digest: 'f'.repeat(64) }), /digest does not match/);
  const changed = input(); changed.effects[0].args.body = 'Fresh effect.';
  const forged = { ...createLinearPlan(changed), digest: plan.digest };
  assert.throws(() => assertLinearPlan(plan, forged), /effects changed.*new plan/);
});
test('malformed plans, ambiguous keys, and values JSON cannot represent are rejected at the boundary', () => {
  const plan = createLinearPlan(input());
  for (const malformed of [null, [], {}, { ...plan, schemaVersion: 2 }, { ...plan, extra: true }, { ...plan, digest: 'short' }, { ...plan, sourceDigest: 'short' }, { ...plan, merge: { ...plan.merge, pr: 0 } }, { ...plan, merge: { ...plan.merge, head: 'short' } }, { ...plan, merge: { ...plan.merge, repo: 'app' } }, { ...plan, effects: null }, { ...plan, effects: [{ ...plan.effects[0], args: [] }] }, { ...plan, effects: [{ ...plan.effects[0], key: '' }] }, { ...plan, effects: [{ ...plan.effects[0], tool: 1 }] }, { ...plan, effects: [{ ...plan.effects[0], extra: 'ignored' }] }, { ...plan, effects: [plan.effects[0], plan.effects[0]] }]) assert.throws(() => parseLinearPlan(malformed));
  for (const unsupported of [undefined, NaN, Infinity, 1n, () => undefined, new Date(), new Map()]) {
    const changed = input(); changed.effects[0].args.body = unsupported;
    assert.throws(() => createLinearPlan(changed), /JSON value/);
  }
});
