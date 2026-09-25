import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commit, fixture } from './fixtures/setup.ts';
import { hash } from './contract.ts';
import { parseCertificate } from './certify.ts';

function prePrFixture(certifier = true, surface = true) {
  const f = fixture();
  const config = JSON.parse(f.state.blobs['.cursor/converge.json']);
  config.prePr = { runs: [{ name: 'suite', command: 'echo ok' }], certifier };
  f.state.blobs['.cursor/converge.json'] = JSON.stringify(config);
  if (surface) {
    f.state.files = [{ filename: 'client/Login.jsx', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' }];
    f.state.diff = 'diff --git a/client/Login.jsx b/client/Login.jsx\nindex 1111111..2222222 100644\n--- a/client/Login.jsx\n+++ b/client/Login.jsx\n@@ -1 +1 @@\n-old\n+new\n';
  }
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
function record(f: ReturnType<typeof fixture>, run: string, checkout: string, argv = ['echo', 'ok']) {
  const recorded = certify(f, ['run', '--directory', run, '--name', 'suite', '--cwd', checkout, '--', ...argv]);
  assert.equal(recorded.status, 0, recorded.stderr);
}
function prepared(f: ReturnType<typeof fixture>) {
  const run = join(f.directory, 'run');
  const checkout = f.checkout();
  record(f, run, checkout);
  const report = certify(f, ['report', '--repo', 'Example/app', '--head', f.state.head, '--directory', run]);
  assert.equal(report.status, 0, report.stderr);
  const round = JSON.parse(report.stdout).round;
  return { run, round, checkout };
}
test('run records command, exit code and log digest and propagates the exit code', t => {
  const f = prePrFixture(); t.after(f.cleanup);
  const run = join(f.directory, 'run');
  const failed = certify(f, ['run', '--directory', run, '--name', 'suite', '--cwd', f.directory, '--', 'sh', '-c', 'echo boom; exit 3']);
  assert.equal(failed.status, 3);
  const record = JSON.parse(readFileSync(join(run, 'runs', 'suite.json'), 'utf8'));
  assert.equal(record.exitCode, 3); assert.equal(record.logDigest, hash(readFileSync(join(run, 'runs', 'suite.log'))));
  assert.equal(record.command, 'sh -c echo boom; exit 3'); assert.equal(record.head, null); assert.equal(record.clean, false);
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
  const result = certify(f, ['assemble', '--directory', run, '--author-provider', 'claude', '--output', join(run, 'certificate.json'), '--adjust-rounds', '2']);
  assert.equal(result.status, 0, result.stderr);
  const certificate = JSON.parse(result.stdout);
  assert.equal(certificate.decision.verdict, 'VERIFIED'); assert.deepEqual(certificate.coverage, ['login']); assert.equal(certificate.authorProvider, 'claude');
  assert.equal(certificate.toolingRef, 'pstack-vic@' + JSON.parse(readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')).version);
  assert.deepEqual([certificate.runs[0].command, certificate.runs[0].head, certificate.runs[0].clean], ['echo ok', f.state.head, true]);
  assert.equal(certificate.adjustRounds, 2);
  assert.deepEqual(certificate.lanes, [['pre-pr-certifier', 'pre-pr certifier'], ['pre-pr-reviewer', 'pre-pr reviewer']].map(([id, role]) => ({ manifest: `lanes/${id}/manifest.json`, role, provider: 'grok', model: 'grok-4.7', effort: 'xhigh', reportedModel: 'grok-4.7-build', receiptDigest: hash(readFileSync(join(run, 'lanes', id, 'receipt.json'))) })));
  const prefix = `artifacts/converge/${round.id}/pre-pr-certifier/`;
  const png = readFileSync(new URL('../../../../assets/logo.png', import.meta.url));
  const action = Buffer.from('{"entry":"Entrar","result":"Dashboard"}');
  assert.deepEqual(certificate.artifacts, [
    { lane: 'pre-pr-certifier', id: 'screen', path: prefix + 'screen.png', bytes: png.length, sha256: hash(png), mediaType: 'image/png' },
    { lane: 'pre-pr-certifier', id: 'action', path: prefix + 'action.json', bytes: action.length, sha256: hash(action), mediaType: 'application/json' },
  ]);
  assert.deepEqual(parseCertificate(certificate), certificate);
  const skipped = { name: 'suite', command: 'echo ok', skip: 'ci-only report' };
  for (const [edit, message] of [
    [{ runs: [skipped] }, /A skipped run needs a CI-only certificate/], [{ runs: [certificate.runs[0], certificate.runs[0]] }, /Duplicate run name/],
    [{ adjustRounds: 7 }, /Adjust rounds must be an integer from 0 to 6/], [{ adjustRounds: 1.5 }, /Adjust rounds must be an integer from 0 to 6/],
    [{ artifacts: [{ ...certificate.artifacts[0], bytes: 0 }] }, /Artifact size outside bounds/], [{ artifacts: [{ ...certificate.artifacts[0], mediaType: 'text/html' }] }, /Invalid enum value/],
    [{ artifacts: [{ ...certificate.artifacts[0], lane: 'lanes/x' }] }, /Invalid lane id/], [{ lanes: [{ ...certificate.lanes[0], reportedModel: 5 }] }, /Invalid string/],
    [{ lanes: [{ ...certificate.lanes[0], effort: undefined }] }, /Invalid string/],
  ] as const) assert.throws(() => parseCertificate({ ...certificate, ...edit }), message);
});
test('a ci-only certificate marks every unrecorded contract run as skipped', t => {
  const f = prePrFixture(true, false); t.after(f.cleanup);
  const run = join(f.directory, 'run');
  const report = certify(f, ['report', '--repo', 'Example/app', '--head', f.state.head, '--directory', run]);
  assert.equal(report.status, 0, report.stderr);
  const { round, mode } = JSON.parse(report.stdout);
  assert.equal(mode, 'ci-only');
  lane(f, round, 'pre-pr reviewer');
  const result = certify(f, ['assemble', '--directory', run, '--author-provider', 'claude', '--output', join(run, 'certificate.json'), '--adjust-rounds', '0']);
  assert.equal(result.status, 0, result.stderr);
  const certificate = JSON.parse(result.stdout);
  assert.equal(certificate.decision.displayResult, 'CI-only');
  assert.deepEqual(certificate.runs, [{ name: 'suite', command: 'echo ok', skip: 'ci-only report' }]);
  assert.deepEqual(certificate.artifacts, []); assert.equal(certificate.adjustRounds, 0);
  assert.deepEqual(parseCertificate(certificate), certificate);
});
test('assemble refuses a missing or out-of-range adjust round count', t => {
  const f = prePrFixture(); t.after(f.cleanup);
  const { run, round } = prepared(f);
  lane(f, round, 'pre-pr reviewer'); lane(f, round, 'pre-pr certifier');
  const base = ['assemble', '--directory', run, '--author-provider', 'claude', '--output', join(run, 'certificate.json')];
  const missing = certify(f, base);
  assert.notEqual(missing.status, 0); assert.match(missing.stderr, /Usage: converge-certify assemble .*--adjust-rounds N/);
  for (const value of ['7', '1.5', 'x', '']) {
    const result = certify(f, [...base, '--adjust-rounds', value]);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /Adjust rounds must be an integer from 0 to 6/);
  }
  assert.equal(existsSync(join(run, 'certificate.json')), false);
});
for (const fault of ['same-family', 'failed-run', 'edited-log', 'missing-run', 'open-finding', 'unmapped-surface', 'missing-certifier', 'other-command', 'moved-head', 'modified-checkout'] as const) {
  test(`assemble refuses ${fault}`, t => {
    const f = prePrFixture(); t.after(f.cleanup);
    if (fault === 'unmapped-surface') { f.state.files = [{ filename: 'client/src/pages/New.jsx', status: 'added', patch: '@@ -0,0 +1 @@\n+new' }]; f.save(); }
    const { run, round, checkout } = prepared(f);
    lane(f, round, 'pre-pr reviewer', { provider: fault === 'same-family' ? 'grok' : undefined, findings: fault === 'open-finding' ? [{ kind: 'regression', source: 'lane', path: 'client/Login.jsx', line: 1, rule: 'lost-submit', severity: 'blocking' }] : [] });
    if (fault !== 'missing-certifier') lane(f, round, 'pre-pr certifier');
    if (fault === 'failed-run') writeFileSync(join(run, 'runs', 'suite.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(run, 'runs', 'suite.json'), 'utf8')), exitCode: 1 }));
    if (fault === 'edited-log') writeFileSync(join(run, 'runs', 'suite.log'), 'tampered');
    if (fault === 'missing-run') writeFileSync(join(run, 'runs', 'suite.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(run, 'runs', 'suite.json'), 'utf8')), name: 'other' }));
    if (fault === 'moved-head') commit(checkout, 'moved');
    if (fault === 'modified-checkout') writeFileSync(join(checkout, 'client', 'Login.jsx'), 'edited\n');
    if (fault === 'other-command' || fault === 'moved-head' || fault === 'modified-checkout') record(f, run, checkout, fault === 'other-command' ? ['echo', 'other'] : undefined);
    const result = certify(f, ['assemble', '--directory', run, '--author-provider', fault === 'same-family' ? 'grok' : 'claude', '--output', join(run, 'certificate.json'), '--adjust-rounds', '0']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, { 'same-family': /same family as the author/, 'failed-run': /Run suite exited 1/, 'edited-log': /Run suite log changed/, 'missing-run': /Required run missing: suite/, 'open-finding': /NOT VERIFIED/, 'unmapped-surface': /lacks a trusted feature recipe/, 'missing-certifier': /Required independent lane unavailable/, 'other-command': /Run suite command differs from the contract/, 'moved-head': /Run suite was not recorded at the certified head/, 'modified-checkout': /Run suite was recorded on a modified checkout/ }[fault]);
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
  const result = certify(f, ['assemble', '--directory', run, '--author-provider', 'claude', '--output', join(run, 'certificate.json'), '--adjust-rounds', '0']);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Reconciliation report changed or is stale/);
});
test('assemble refuses an author provider outside the model matrix', t => {
  const f = prePrFixture(); t.after(f.cleanup);
  const run = join(f.directory, 'run');
  const result = certify(f, ['assemble', '--directory', run, '--author-provider', 'Grok', '--output', join(run, 'certificate.json'), '--adjust-rounds', '0']);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Unknown author provider: Grok/);
});
test('assemble writes the certificate only in the run directory', t => {
  const f = prePrFixture(); t.after(f.cleanup);
  const { run, round } = prepared(f);
  lane(f, round, 'pre-pr reviewer'); lane(f, round, 'pre-pr certifier');
  const result = certify(f, ['assemble', '--directory', run, '--author-provider', 'claude', '--output', join(f.directory, 'certificate.json'), '--adjust-rounds', '0']);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Certificate must be written in the run directory/);
});
