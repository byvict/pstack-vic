import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { merge, issueUrl } from '../fixtures/linear.ts';
import { object } from '../contract.ts';
import { writeJsonFile } from './ledger.ts';
import { claimLinearEffect, planLinear, readLinearTargets, reconcileLinear, reconcileLinearEffects, type LinearCheckpoint } from './linear.ts';
import { LINEAR_PREFIX, linearTrace, launchLinearSession, type NativeCall } from './linear-session.ts';
import { proofCatalogue } from './linear-proof.ts';
import { linearTarget } from '../linear-targets.ts';

const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const lane = { provider: 'claude', model: 'fable', effort: 'max' };
function setup(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'linear-test-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const remote = join(dir, 'remote.json'), ledger = join(dir, 'ledger.json'), m = merge();
  const state = { mode: 'normal', issue: { id: 'ENG-1', uuid: 'issue-uuid', url: issueUrl, description: 'The command must pass its tests. Roll out in production after verification.', statusType: 'started', documents: [], projectId: 'project-1' }, project: { id: 'P-ENG-1', uuid: 'project-1', description: 'An old initiative plan, not completion scope.', resources: [{ id: 'doc-1', title: 'Plan', url: 'https://linear.app/example/document/plan-doc-1' }] }, documents: [{ id: 'doc-1', content: 'Acceptance: retain retry behavior.' }], comments: [] as { id: string; body: string }[], mutations: [] as unknown[] };
  writeJsonFile(remote, state);
  const cli = join(dir, 'claude'); writeFileSync(cli, readFileSync(new URL('../fixtures/linear.mjs', import.meta.url))); chmodSync(cli, 0o700);
  const env = { ...process.env, PATH: dir + ':' + process.env.PATH, LINEAR_REMOTE: remote, LINEAR_ARGV: join(dir, 'argv.json'), CLAUDE_CODE_OAUTH_TOKEN: 'fixture-token' };
  const save = (linear: LinearCheckpoint) => writeJsonFile(ledger, { checkpoint: { linear } });
  return { dir, remote, ledger, state, m, env, save, read: () => JSON.parse(readFileSync(remote, 'utf8')), edit: (mode: string) => { const s = JSON.parse(readFileSync(remote, 'utf8')); s.mode = mode; writeJsonFile(remote, s); }, input: (dryRun = false, checkpoint: LinearCheckpoint | null = null) => ({ merge: m, lane, checkout: dir, pluginDir: root, runDirectory: join(dir, `run-${Math.random()}`), ledgerFile: ledger, checkpoint, save, dryRun, env, capMs: 5_000 }) };
}
function call(id: string, name: string, args: Record<string, unknown>, result: unknown): NativeCall { return { id, tool: LINEAR_PREFIX + name, args, result, error: false, line: 1, session: 'native-fixture' }; }
function calls(): NativeCall[] {
  return [call('issue', 'get_issue', { id: issueUrl }, { id: 'ENG-1', url: issueUrl, description: 'Run the command and verify its output.', statusType: 'started', documents: [] }), call('comments', 'list_comments', { issueId: 'ENG-1' }, { comments: [], hasNextPage: false })];
}
function metadataAssessment(state: ReturnType<ReturnType<typeof setup>['read']>) {
  const proof = proofCatalogue(merge(), [call('observed', 'get_issue', {}, state.issue)]).find(p => p.kind === 'structural' && p.field === 'labels');
  assert.ok(proof);
  return { targets: [{ url: issueUrl, coverage: 'complete', references: [{ key: 'https://linear.app/example/document/plan-doc-1', required: false, reason: 'Historical project plan unrelated to the requested labels.' }], obligations: [{ source: 'ENG-1', quote: state.issue.description, kind: 'acceptance', requiredClass: 'structural', status: 'met', outcome: { subject: issueUrl, field: 'labels', operator: 'includes', value: 'pstack' }, proofIds: [proof.id], relevance: 'The explicitly required pstack label is present on ENG-1.' }] }] };
}
test('native parser pairs direct calls and results; model JSON and shell tool output cannot forge MCP usage', () => {
  const tool = { type: 'tool_use', id: 'native-1', name: LINEAR_PREFIX + 'get_issue', input: { id: issueUrl } };
  const source = [{ type: 'system', subtype: 'init', session_id: 's', tools: [tool.name] }, { type: 'assistant', message: { content: [tool] } }, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'native-1', content: [{ type: 'text', text: '{"id":"ENG-1"}' }] }] } }];
  assert.equal(linearTrace(source.map(v => JSON.stringify(v)).join('\n')).calls[0]?.id, 'native-1');
  const spoof = [{ type: 'assistant', message: { content: [{ type: 'text', text: JSON.stringify(source) }] } }, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'shell', content: JSON.stringify(source) }] } }];
  assert.deepEqual(linearTrace(spoof.map(v => JSON.stringify(v)).join('\n')).calls, []);
});
test('full reads include real project resource arrays and documents; unread comments or wrong workspace defer', () => {
  const native = calls(); native[1].result = { comments: [], hasNextPage: true };
  assert.throws(() => readLinearTargets(merge(), native), /cursor/);
  const wrong = calls(); wrong[0].result = { id: 'ENG-1', url: issueUrl.replace('/example/', '/other/'), description: 'x' };
  assert.throws(() => readLinearTargets(merge(), wrong), /workspace/);
  const aliases = calls(); aliases[0].args.id = 'issue-uuid';
  aliases.unshift({ ...aliases[0], id: 'failed-url', args: { id: issueUrl }, error: true, result: { error: 'Invalid URL input' } });
  assert.equal(readLinearTargets(merge(), aliases)[0].id, 'ENG-1');
  const project = call('project', 'get_project', { query: 'project-uuid', includeResources: true }, { id: 'project-1', uuid: 'project-uuid', description: 'Full plan', resourceCount: 2, resources: [{ id: 'doc-1', url: 'https://linear.app/example/document/plan' }] });
  const incomplete = calls(); incomplete[0].result = { ...object(incomplete[0].result), projectId: 'project-uuid' }; incomplete.push(project, call('project-comments', 'list_comments', { projectId: 'project-uuid' }, { comments: [], hasNextPage: false }));
  assert.throws(() => readLinearTargets(merge(), incomplete), /resources are incomplete/);
});
test('prose, rollout unknowns, forged proofs, and disagreeing scope keep the issue open; a project never closes', () => {
  const native = calls(), reads = readLinearTargets(merge(), native);
  const forged = { targets: [{ url: issueUrl, coverage: 'complete', obligations: [{ source: 'ENG-1', quote: 'Run the command and verify its output.', kind: 'acceptance', status: 'met', evidence: [{ reference: 'not-observed', quote: 'done' }] }] }] };
  assert.deepEqual(planLinear(merge(), reads, [forged, forged], native).map(e => e.kind), ['comment']);
  const unmet = structuredClone(forged); unmet.targets[0].obligations[0].status = 'unknown';
  assert.deepEqual(planLinear(merge(), reads, [forged, unmet], native).map(e => e.kind), ['comment']);
  const mismatched = { targets: [{ url: issueUrl, coverage: 'complete', obligations: [] }] };
  assert.deepEqual(planLinear(merge(), reads, [forged, mismatched], native).map(e => e.kind), ['comment']);
  const projectUrl = 'https://linear.app/example/project/a-plan', m = { ...merge(), targets: [linearTarget(projectUrl)] };
  const projectCalls = [call('project', 'get_project', { query: 'a-plan', includeResources: true }, { id: 'P-1', url: projectUrl, description: 'Full project', resources: [], resourceCount: 0 }), call('comments', 'list_comments', { projectId: 'P-1' }, { comments: [], hasNextPage: false })];
  assert.deepEqual(planLinear(m, readLinearTargets(m, projectCalls), [null, null], projectCalls).map(e => e.kind), ['comment']);
});
test('a dry run produces exact planned calls, native read logs, and zero writes or persisted intents', async t => {
  const f = setup(t), result = await reconcileLinear(f.input(true));
  assert.equal(result.kind, 'dry-run'); assert.equal(result.effects[0]?.tool, LINEAR_PREFIX + 'save_comment');
  assert.ok(result.logs.length); assert.deepEqual(f.read().mutations, []); assert.equal(existsSync(f.ledger), false);
  const argv = JSON.parse(readFileSync(join(f.dir, 'argv.json'), 'utf8'));
  assert.equal(argv.setupTokenInherited, false); assert.equal(argv.args[argv.args.indexOf('--permission-mode') + 1], 'dontAsk'); assert.equal(argv.args[argv.args.indexOf('--setting-sources') + 1], ''); assert.ok(argv.args.includes('--include-hook-events'));
});
for (const mode of ['no-mcp', 'forged', 'partial']) test(`${mode} returns deferred without mutations`, async t => {
  const f = setup(t); f.edit(mode); const result = await reconcileLinear(f.input());
  assert.equal(result.kind, 'deferred'); assert.deepEqual(f.read().mutations, []);
});
test('unsupported provider and unsupported native format are explicit deferrals', async t => {
  const f = setup(t); const result = await reconcileLinear({ ...f.input(), lane: { ...lane, provider: 'codex' } });
  assert.equal(result.kind, 'deferred'); assert.match(result.reason, /unavailable/);
  writeFileSync(join(f.dir, 'claude'), '#!/bin/sh\ncat >/dev/null\necho unsupported\n');
  const raw = await launchLinearSession({ ...f.input(), phase: 'read', prompt: 'read' }); assert.ok(raw.parseError);
});
test('planned intent is saved before dispatch, actual native readback confirms a comment, and retry creates no duplicate', async t => {
  const f = setup(t), result = await reconcileLinear(f.input());
  assert.equal(result.kind, 'done', result.reason); assert.equal(f.read().mutations.length, 1);
  const checkpoint = JSON.parse(readFileSync(f.ledger, 'utf8')).checkpoint.linear;
  assert.equal(checkpoint.effects[0].status.kind, 'confirmed');
  const retry = await reconcileLinear(f.input(false, checkpoint)); assert.equal(retry.kind, 'done'); assert.equal(f.read().comments.length, 1);
});
for (const mode of ['crash-before-hook', 'crash-after-effect', 'ambiguous']) test(`retry after ${mode} reconciles state without blind creates`, async t => {
  const f = setup(t); f.edit(mode); const first = await reconcileLinear(f.input());
  assert.equal(first.kind, mode === 'crash-after-effect' ? 'done' : 'deferred');
  const checkpoint = JSON.parse(readFileSync(f.ledger, 'utf8')).checkpoint.linear;
  f.edit('normal'); const retried = await reconcileLinear(f.input(false, checkpoint));
  assert.equal(retried.kind, mode === 'ambiguous' ? 'deferred' : 'done', retried.reason);
  assert.equal(f.read().comments.length, mode === 'ambiguous' ? 0 : 1);
});
test('concurrent same-effect permission processes grant exactly one write, and unknown tools or altered targets stay denied', async t => {
  const f = setup(t), read = readLinearTargets(merge(), calls()), effects = planLinear(merge(), read, [null, null], calls());
  f.save({ repo: f.m.repo, commit: f.m.commit, head: f.m.head, effects, logPaths: [] });
  const e = effects[0];
  const run = () => new Promise<number | null>(resolve => {
    const child = spawn(process.execPath, [join(root, 'skills/poteto-mode/scripts/converge/local/linear-permission.ts'), 'write', f.ledger], { stdio: ['pipe', 'ignore', 'ignore'] }); child.on('close', resolve); child.stdin.end(JSON.stringify({ tool_name: e.tool, tool_input: e.args }));
  });
  assert.deepEqual((await Promise.all([run(), run()])).sort(), [0, 2]);
  assert.throws(() => claimLinearEffect(f.ledger, e.tool, { ...e.args, issueId: 'ENG-2' }, 'write'), /unplanned/);
  assert.throws(() => claimLinearEffect(f.ledger, 'Bash', {}, 'read'), /native Linear reads/);
});
test('a retry never reissues a sent completion after live acceptance or rollout scope changes', async t => {
  const f = setup(t), s = f.read(); s.issue.description = 'ENG-1 labels must include pstack.'; s.issue.labels = ['pstack'];
  s.assessment = metadataAssessment(s); writeJsonFile(f.remote, s);
  const original = await reconcileLinear(f.input(true)); assert.deepEqual(original.effects.map(e => e.kind), ['comment', 'complete']);
  const completion = original.effects[1]; completion.status = { kind: 'sent' };
  const checkpoint: LinearCheckpoint = { repo: f.m.repo, commit: f.m.commit, head: f.m.head, effects: original.effects, logPaths: original.logs }; f.save(checkpoint);
  s.issue.description += ' Roll out the new release.'; s.assessment.targets[0].obligations.push({ source: 'ENG-1', quote: 'Roll out the new release.', kind: 'rollout', requiredClass: 'structural', status: 'unknown', outcome: { subject: issueUrl, field: 'labels', operator: 'includes', value: 'pstack' }, proofIds: [], relevance: 'Delivery has not been observed.' }); writeJsonFile(f.remote, s);
  const retry = await reconcileLinear(f.input(false, checkpoint)); assert.equal(retry.kind, 'done', retry.reason);
  assert.deepEqual(retry.effects.map(e => [e.kind, e.status.kind]), [['comment', 'confirmed'], ['complete', 'withheld']]); assert.equal(f.read().issue.statusType, 'started');
  assert.equal(f.read().mutations.length, 1); assert.match(f.read().comments[0].body, /Completion is unproved/);
});
test('independent cited proof for every recorded obligation permits a native completion with readback', async t => {
  const f = setup(t), s = f.read(); s.issue.description = 'ENG-1 labels must include pstack.'; s.issue.labels = ['pstack'];
  s.assessment = metadataAssessment(s); writeJsonFile(f.remote, s);
  const result = await reconcileLinear(f.input()); assert.equal(result.kind, 'done', result.reason);
  assert.equal(f.read().issue.statusType, 'completed'); assert.equal(f.read().mutations.length, 2); assert.ok(result.effects.every(e => e.status.kind === 'confirmed'));
});
test('late scoped proof adds completion and updates the existing comment without another create', async t => {
  const f = setup(t), s = f.read(); s.issue.description = 'ENG-1 labels must include pstack.'; s.issue.labels = ['pstack'];
  s.assessment = metadataAssessment(s); s.assessment.targets[0].obligations[0].status = 'unknown'; writeJsonFile(f.remote, s);
  const first = await reconcileLinear(f.input()); assert.equal(first.kind, 'done'); assert.deepEqual(first.effects.map(e => e.kind), ['comment']);
  const checkpoint = JSON.parse(readFileSync(f.ledger, 'utf8')).checkpoint.linear, live = f.read();
  live.assessment = metadataAssessment(live); writeJsonFile(f.remote, live);
  const retry = await reconcileLinear(f.input(false, checkpoint)); assert.equal(retry.kind, 'done', retry.reason);
  assert.deepEqual(retry.effects.map(e => e.kind), ['comment', 'complete']); assert.equal(f.read().comments.length, 1); assert.equal(f.read().issue.statusType, 'completed'); assert.ok(!f.read().comments[0].body.includes('Completion is unproved')); assert.equal(f.read().mutations.filter((e: {args: Record<string, unknown>}) => e.args.id && 'body' in e.args).length, 1);
});
test('a reopened issue requires current proof again, and a deleted confirmed comment defers without another create', async t => {
  const f = setup(t), s = f.read(); s.issue.description = 'ENG-1 labels must include pstack.'; s.issue.labels = ['pstack'];
  s.assessment = metadataAssessment(s); writeJsonFile(f.remote, s);
  assert.equal((await reconcileLinear(f.input())).kind, 'done');
  let checkpoint = JSON.parse(readFileSync(f.ledger, 'utf8')).checkpoint.linear, live = f.read(); live.issue.statusType = 'started'; live.assessment.targets[0].coverage = 'unknown'; writeJsonFile(f.remote, live);
  const reopened = await reconcileLinear(f.input(false, checkpoint)); assert.equal(reopened.kind, 'done'); assert.equal(reopened.effects[1].status.kind, 'withheld'); assert.equal(f.read().issue.statusType, 'started'); assert.equal(f.read().mutations.length, 3);
  checkpoint = JSON.parse(readFileSync(f.ledger, 'utf8')).checkpoint.linear; live = f.read(); live.comments = []; writeJsonFile(f.remote, live);
  const deleted = await reconcileLinear(f.input(false, checkpoint)); assert.equal(deleted.kind, 'deferred'); assert.equal(deleted.effects[0].status.kind, 'sent'); assert.equal(f.read().comments.length, 0); assert.equal(f.read().mutations.length, 3);
});
test('denied native writes cannot be cited as successful dispatch when readback proves an existing comment', () => {
  const native = calls(), reads = readLinearTargets(merge(), native), effects = planLinear(merge(), reads, [null, null], native);
  reads[0].comments.push({ id: 'remote-comment', body: String(effects[0].args.body), callId: 'readback-comments' });
  reconcileLinearEffects(effects, reads, [{ ...call('denied', 'save_comment', effects[0].args, { denied: true }), error: true }]);
  assert.deepEqual(effects[0].status, { kind: 'confirmed', via: 'existing', callId: 'readback-comments', readbackCallId: 'readback-comments', remoteId: 'remote-comment' });
});

test('a unique remote marker survives ledger loss and changed call IDs without another create', async t => {
  const f = setup(t); assert.equal((await reconcileLinear(f.input())).kind, 'done');
  const original = f.read().comments[0].body; rmSync(f.ledger);
  const retry = await reconcileLinear(f.input()); assert.equal(retry.kind, 'done', retry.reason);
  assert.equal(f.read().comments.length, 1); assert.equal(f.read().mutations.length, 1); assert.equal(f.read().comments[0].body, original);
  assert.equal(retry.effects[0].status.kind === 'confirmed' && retry.effects[0].status.via, 'existing');
});
test('an edited unique marker plans an exact update; duplicate markers refuse without effects', async t => {
  const f = setup(t); assert.equal((await reconcileLinear(f.input())).kind, 'done');
  const s = f.read(); s.comments[0].body += '\nExternal edit'; writeJsonFile(f.remote, s);
  const checkpoint = JSON.parse(readFileSync(f.ledger, 'utf8')).checkpoint.linear;
  const updated = await reconcileLinear(f.input(false, checkpoint)); assert.equal(updated.kind, 'done', updated.reason);
  assert.equal(f.read().comments.length, 1); assert.equal(f.read().mutations.length, 2); assert.deepEqual(Object.keys(f.read().mutations[1].args).sort(), ['body', 'id']);
  const duplicate = f.read(); duplicate.comments.push({ ...duplicate.comments[0], id: 'duplicate' }); writeJsonFile(f.remote, duplicate);
  const refused = await reconcileLinear(f.input()); assert.equal(refused.kind, 'refused'); assert.match(refused.reason, /Duplicate Linear marker/); assert.equal(f.read().mutations.length, 2);
});
test('crash after a comment update is confirmed by readback and never creates a duplicate', async t => {
  const f = setup(t); assert.equal((await reconcileLinear(f.input())).kind, 'done');
  const s = f.read(); s.issue.description += ' New criterion pending.'; s.mode = 'crash-after-effect'; writeJsonFile(f.remote, s);
  const checkpoint = JSON.parse(readFileSync(f.ledger, 'utf8')).checkpoint.linear;
  const updated = await reconcileLinear(f.input(false, checkpoint)); assert.equal(updated.kind, 'done', updated.reason);
  f.edit('normal'); const next = JSON.parse(readFileSync(f.ledger, 'utf8')).checkpoint.linear;
  assert.equal((await reconcileLinear(f.input(false, next))).kind, 'done'); assert.equal(f.read().comments.length, 1); assert.equal(f.read().mutations.length, 2);
});
test('all native phases share one reconciliation cap and exhausted assessment budget cannot write', async t => {
  const f = setup(t), s = f.read(); s.assessmentDelayMs = 200; writeJsonFile(f.remote, s);
  const start = Date.now(), result = await reconcileLinear({ ...f.input(), capMs: 400 });
  assert.equal(result.kind, 'deferred'); assert.match(result.reason, /time cap|timeout/); assert.ok(Date.now() - start < 1500); assert.deepEqual(f.read().mutations, []);
});
test('manual apply needs a reviewed artifact, preserves it, and rejects changed sources or expanded effects', async t => {
  const f = setup(t), planPath = join(f.dir, 'reviewed.json');
  const missing = await reconcileLinear({ ...f.input(), manual: true }); assert.equal(missing.kind, 'refused'); assert.deepEqual(f.read().mutations, []);
  const dry = await reconcileLinear({ ...f.input(true), manual: true, planPath }); assert.equal(dry.kind, 'dry-run');
  const original = readFileSync(planPath, 'utf8');
  const changed = f.read(); changed.issue.description += ' Another obligation.'; writeJsonFile(f.remote, changed);
  const refused = await reconcileLinear({ ...f.input(), manual: true, planPath }); assert.equal(refused.kind, 'refused'); assert.match(refused.reason, /sources changed/); assert.equal(readFileSync(planPath, 'utf8'), original); assert.deepEqual(f.read().mutations, []);
  const restored = f.read(); restored.issue.description = f.state.issue.description; restored.issue.labels = ['pstack']; restored.issue.description = 'ENG-1 labels must include pstack.'; restored.assessment = metadataAssessment(restored); restored.assessment.targets[0].obligations[0].status = 'unknown'; writeJsonFile(f.remote, restored);
  assert.equal((await reconcileLinear({ ...f.input(true), manual: true, planPath })).kind, 'dry-run');
  const reviewed = readFileSync(planPath, 'utf8'), eligible = f.read(); eligible.assessment = metadataAssessment(eligible); writeJsonFile(f.remote, eligible);
  const expansion = await reconcileLinear({ ...f.input(), manual: true, planPath }); assert.equal(expansion.kind, 'refused'); assert.match(expansion.reason, /effects changed/); assert.equal(readFileSync(planPath, 'utf8'), reviewed); assert.deepEqual(f.read().mutations, []);
});
test('unchanged reviewed native plan applies exactly and dry run does not mutate a supplied checkpoint', async t => {
  const f = setup(t), planPath = join(f.dir, 'reviewed.json');
  const checkpoint: LinearCheckpoint = { repo: f.m.repo, commit: f.m.commit, head: f.m.head, effects: [], logPaths: [] }, before = structuredClone(checkpoint);
  assert.equal((await reconcileLinear({ ...f.input(true, checkpoint), manual: true, planPath })).kind, 'dry-run'); assert.deepEqual(checkpoint, before);
  const original = readFileSync(planPath, 'utf8'); const applied = await reconcileLinear({ ...f.input(), manual: true, planPath });
  assert.equal(applied.kind, 'done', applied.reason); assert.equal(f.read().mutations.length, 1); assert.equal(readFileSync(planPath, 'utf8'), original);
});
