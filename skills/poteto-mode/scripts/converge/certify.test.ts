import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './fixtures/setup.ts';
import { hash } from './contract.ts';

function prePrFixture(certifier = true) {
  const f = fixture();
  const config = JSON.parse(f.state.blobs['.cursor/converge.json']);
  config.prePr = { runs: [{ name: 'suite', command: 'true' }], certifier };
  f.state.blobs['.cursor/converge.json'] = JSON.stringify(config);
  f.state.files = [{ filename: 'client/Login.jsx', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' }];
  f.state.diff = 'diff --git a/client/Login.jsx b/client/Login.jsx\nindex 1111111..2222222 100644\n--- a/client/Login.jsx\n+++ b/client/Login.jsx\n@@ -1 +1 @@\n-old\n+new\n';
  f.save();
  return f;
}
function certify(f: ReturnType<typeof fixture>, args: string[]) { return f.run('converge-certify', args); }
function lane(f: ReturnType<typeof fixture>, round: Record<string, unknown>, role: 'pre-pr reviewer' | 'pre-pr certifier', options: { provider?: string; findings?: unknown[]; coverage?: boolean } = {}) {
  const laneId = role.replace(' ', '-');
  const root = join(f.directory, 'run', 'lanes', laneId);
  const prefix = `artifacts/converge/${round.id}/${laneId}/`;
  mkdirSync(join(root, prefix), { recursive: true });
  const png = readFileSync(new URL('../../../../assets/logo.png', import.meta.url));
  const action = Buffer.from('{"entry":"Entrar","result":"Dashboard"}');
  writeFileSync(join(root, prefix, 'screen.png'), png); writeFileSync(join(root, prefix, 'action.json'), action);
  const artifacts = role === 'pre-pr certifier' ? [{ id: 'screen', path: prefix + 'screen.png', bytes: png.length, sha256: hash(png), mediaType: 'image/png' }, { id: 'action', path: prefix + 'action.json', bytes: action.length, sha256: hash(action), mediaType: 'application/json' }] : [];
  const coverage = role === 'pre-pr certifier' && options.coverage !== false ? [{ featureId: 'login', entryPoint: 'Entrar', result: 'driven', artifactIds: ['screen', 'action'] }] : [];
  const output = { schemaVersion: 1, round: round.id, laneId, role, observedHead: round.head, observedContract: round.contract, kind: 'complete', findings: options.findings ?? [], artifacts, coverage, riskProofs: [] };
  const receipt = { schemaVersion: 1, parent: 'claude', provider: options.provider ?? 'grok', model: 'grok-4.7', effort: 'xhigh', mode: 'read-only', status: 'complete', promptPath: join(root, 'prompt.txt'), outputPath: join(root, 'output.json'), startedAt: '2026-09-24T00:00:00.000Z', completedAt: '2026-09-24T00:00:02.000Z', modelVerified: true, modelEvidence: 'provider-report', reportedModel: 'grok-4.7-build', remote: null, executable: '/usr/local/bin/grok', exitCode: 0, signal: null };
  const manifest = { round, laneId, role, descriptor: `${options.provider ?? 'grok'}:grok-4.7@xhigh`, prompt: 'prompt.txt', promptDigest: hash('read only'), output: 'output.json', receipt: 'receipt.json', createdAt: Date.parse(receipt.startedAt) };
  writeFileSync(join(root, 'prompt.txt'), 'read only'); writeFileSync(join(root, 'output.json'), JSON.stringify(output)); writeFileSync(join(root, 'receipt.json'), JSON.stringify(receipt)); writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest));
}
function prepared(f: ReturnType<typeof fixture>) {
  const run = join(f.directory, 'run');
  const recorded = certify(f, ['run', '--directory', run, '--name', 'suite', '--', 'sh', '-c', 'echo ok']);
  assert.equal(recorded.status, 0, recorded.stderr);
  const report = certify(f, ['report', '--repo', 'Example/app', '--head', f.state.head, '--directory', run]);
  assert.equal(report.status, 0, report.stderr);
  const round = JSON.parse(report.stdout).round;
  return { run, round };
}
test('run records command, exit code and log digest and propagates the exit code', t => {
  const f = prePrFixture(); t.after(f.cleanup);
  const run = join(f.directory, 'run');
  const failed = certify(f, ['run', '--directory', run, '--name', 'suite', '--', 'sh', '-c', 'echo boom; exit 3']);
  assert.equal(failed.status, 3);
  const record = JSON.parse(readFileSync(join(run, 'runs', 'suite.json'), 'utf8'));
  assert.equal(record.exitCode, 3); assert.equal(record.logDigest, hash(readFileSync(join(run, 'runs', 'suite.log'))));
});
test('report binds the pushed head with pr 0 and names the required lanes', t => {
  const f = prePrFixture(); t.after(f.cleanup);
  const { round } = prepared(f);
  assert.equal(round.pr, 0); assert.equal(round.execution, 'pre-pr'); assert.equal(round.head, f.state.head);
});
test('assemble writes a VERIFIED certificate from clean runs and admitted lanes', t => {
  const f = prePrFixture(); t.after(f.cleanup);
  const { run, round } = prepared(f);
  lane(f, round, 'pre-pr reviewer'); lane(f, round, 'pre-pr certifier');
  const result = certify(f, ['assemble', '--directory', run, '--author-provider', 'claude', '--output', join(run, 'certificate.json')]);
  assert.equal(result.status, 0, result.stderr);
  const certificate = JSON.parse(result.stdout);
  assert.equal(certificate.decision.verdict, 'VERIFIED'); assert.deepEqual(certificate.coverage, ['login']); assert.equal(certificate.authorProvider, 'claude');
});
for (const fault of ['same-family', 'failed-run', 'edited-log', 'missing-run', 'open-finding', 'unmapped-surface', 'missing-certifier'] as const) {
  test(`assemble refuses ${fault}`, t => {
    const f = prePrFixture(); t.after(f.cleanup);
    if (fault === 'unmapped-surface') { f.state.files = [{ filename: 'client/src/pages/New.jsx', status: 'added', patch: '@@ -0,0 +1 @@\n+new' }]; f.save(); }
    const { run, round } = prepared(f);
    lane(f, round, 'pre-pr reviewer', { provider: fault === 'same-family' ? 'grok' : undefined, findings: fault === 'open-finding' ? [{ kind: 'regression', source: 'lane', path: 'client/Login.jsx', line: 1, rule: 'lost-submit', severity: 'blocking' }] : [] });
    if (fault !== 'missing-certifier') lane(f, round, 'pre-pr certifier');
    if (fault === 'failed-run') writeFileSync(join(run, 'runs', 'suite.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(run, 'runs', 'suite.json'), 'utf8')), exitCode: 1 }));
    if (fault === 'edited-log') writeFileSync(join(run, 'runs', 'suite.log'), 'tampered');
    if (fault === 'missing-run') writeFileSync(join(run, 'runs', 'suite.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(run, 'runs', 'suite.json'), 'utf8')), name: 'other' }));
    const result = certify(f, ['assemble', '--directory', run, '--author-provider', fault === 'same-family' ? 'grok' : 'claude', '--output', join(run, 'certificate.json')]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, { 'same-family': /same family as the author/, 'failed-run': /Run suite exited 1/, 'edited-log': /Run suite log changed/, 'missing-run': /Required run missing: suite/, 'open-finding': /NOT VERIFIED/, 'unmapped-surface': /lacks a trusted feature recipe/, 'missing-certifier': /Required independent lane unavailable/ }[fault]);
  });
}
test('report refuses a repository that does not accept local certification', t => {
  const f = prePrFixture(); t.after(f.cleanup);
  f.state.blobs['.cursor/converge.json'] = JSON.stringify({ ...JSON.parse(f.state.blobs['.cursor/converge.json']), prePr: null }); f.save();
  const result = certify(f, ['report', '--repo', 'Example/app', '--head', f.state.head, '--directory', join(f.directory, 'run')]);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /does not accept local certification/);
});
test('assemble refuses a report edited after it was written', t => {
  const f = prePrFixture(); t.after(f.cleanup);
  const { run, round } = prepared(f);
  lane(f, round, 'pre-pr reviewer');
  const file = join(run, 'report.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), lanes: ['pre-pr reviewer'], touchedFeatures: [] }));
  const result = certify(f, ['assemble', '--directory', run, '--author-provider', 'claude', '--output', join(run, 'certificate.json')]);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Reconciliation report changed or is stale/);
});
test('assemble refuses an author provider outside the model matrix', t => {
  const f = prePrFixture(); t.after(f.cleanup);
  const run = join(f.directory, 'run');
  const result = certify(f, ['assemble', '--directory', run, '--author-provider', 'Grok', '--output', join(run, 'certificate.json')]);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Unknown author provider: Grok/);
});
test('assemble writes the certificate only in the run directory', t => {
  const f = prePrFixture(); t.after(f.cleanup);
  const { run, round } = prepared(f);
  lane(f, round, 'pre-pr reviewer'); lane(f, round, 'pre-pr certifier');
  const result = certify(f, ['assemble', '--directory', run, '--author-provider', 'claude', '--output', join(f.directory, 'certificate.json')]);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Certificate must be written in the run directory/);
});
