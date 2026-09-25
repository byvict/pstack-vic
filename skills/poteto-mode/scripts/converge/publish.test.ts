import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decide } from './publish.ts';
import { hash, parseReport, riskObligation } from './contract.ts';
import { fixture } from './fixtures/setup.ts';

for (const proveBoth of [false, true]) {
  test(`one independent verifier ${proveBoth ? 'proves both money paths' : 'cannot clear a second money path with one proof'}`, t => {
    const f = fixture(); t.after(f.cleanup);
    f.state.files = ['billing/one.js', 'billing/two.js'].map(filename => ({ filename, status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' }));
    f.state.diff = f.state.files.map(v => `diff --git a/${v.filename} b/${v.filename}\nindex 1111111..2222222 100644\n--- a/${v.filename}\n+++ b/${v.filename}\n${v.patch}\n`).join('');
    f.save();
    const result = f.run('converge-reconcile', ['--repo', 'Example/app', '--pr', '1', '--output', f.directory + '/report.json']);
    assert.equal(result.status, 0, result.stderr);
    const report = parseReport(JSON.parse(result.stdout));
    const obligations = report.hardList.map(riskObligation);
    assert.deepEqual(obligations.map(o => o.path), ['billing/one.js', 'billing/two.js']);
    assert.deepEqual(report.lanes, ['pr verifier']);
    const decision = decide(report, [{ role: 'pr verifier', coverage: [], risks: obligations.slice(0, proveBoth ? 2 : 1), findings: [], gaps: [], artifacts: [], receiptDigest: 'a'.repeat(64) }]);
    assert.equal(decision.verdict, proveBoth ? 'VERIFIED' : 'INCONCLUSIVE');
  });
}
function lane(run: string, round: Record<string, unknown>, role: 'pre-pr reviewer' | 'pre-pr certifier') {
  const laneId = role.replace(' ', '-');
  const root = join(run, 'lanes', laneId);
  const prefix = `artifacts/converge/${round.id}/${laneId}/`;
  mkdirSync(join(root, prefix), { recursive: true });
  const png = readFileSync(new URL('../../../../assets/logo.png', import.meta.url));
  const action = Buffer.from('{"entry":"Entrar","result":"Dashboard"}');
  writeFileSync(join(root, prefix, 'screen.png'), png); writeFileSync(join(root, prefix, 'action.json'), action);
  const certifier = role === 'pre-pr certifier';
  const artifacts = certifier ? [{ id: 'screen', path: prefix + 'screen.png', bytes: png.length, sha256: hash(png), mediaType: 'image/png' }, { id: 'action', path: prefix + 'action.json', bytes: action.length, sha256: hash(action), mediaType: 'application/json' }] : [];
  const coverage = certifier ? [{ featureId: 'login', entryPoint: 'Entrar', result: 'driven', artifactIds: ['screen', 'action'] }] : [];
  const output = { schemaVersion: 1, round: round.id, laneId, role, observedHead: round.head, observedContract: round.contract, kind: 'complete', findings: [], artifacts, coverage, riskProofs: [] };
  const receipt = { schemaVersion: 1, parent: 'claude', provider: 'grok', model: 'grok-4.7', effort: 'xhigh', mode: 'read-only', status: 'complete', promptPath: join(root, 'prompt.txt'), outputPath: join(root, 'output.json'), startedAt: '2026-09-24T00:00:00.000Z', completedAt: '2026-09-24T00:00:02.000Z', modelVerified: true, modelEvidence: 'provider-report', reportedModel: 'grok-4.7-build', remote: null, executable: '/usr/local/bin/grok', exitCode: 0, signal: null };
  writeFileSync(join(root, 'prompt.txt'), 'read only'); writeFileSync(join(root, 'output.json'), JSON.stringify(output)); writeFileSync(join(root, 'receipt.json'), JSON.stringify(receipt));
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({ round, laneId, role, descriptor: 'grok:grok-4.7@xhigh', prompt: 'prompt.txt', promptDigest: hash('read only'), output: 'output.json', receipt: 'receipt.json', createdAt: Date.parse(receipt.startedAt) }));
}
function certifiedPr(f: ReturnType<typeof fixture>, options: { body?: string; full?: boolean } = {}) {
  const config = JSON.parse(f.state.blobs['.cursor/converge.json']);
  config.prePr = { runs: [{ name: 'suite', command: 'true' }], certifier: options.full === true };
  f.state.blobs['.cursor/converge.json'] = JSON.stringify(config); f.state.body = options.body ?? '## Verification\ncertificate: pre-pr\n';
  if (options.full) {
    f.state.files = [{ filename: 'client/Login.jsx', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' }];
    f.state.diff = 'diff --git a/client/Login.jsx b/client/Login.jsx\nindex 1111111..2222222 100644\n--- a/client/Login.jsx\n+++ b/client/Login.jsx\n@@ -1 +1 @@\n-old\n+new\n';
  }
  f.save();
  const checkout = f.checkout();
  const run = join(f.directory, 'run');
  const recorded = f.run('converge-certify', ['run', '--directory', run, '--name', 'suite', '--cwd', checkout, '--', 'true']);
  assert.equal(recorded.status, 0, recorded.stderr);
  const local = f.run('converge-certify', ['report', '--repo', 'Example/app', '--head', f.state.head, '--directory', run]);
  assert.equal(local.status, 0, local.stderr);
  const { round, mode, lanes } = JSON.parse(local.stdout);
  assert.deepEqual([mode, lanes], options.full ? ['full', ['pre-pr reviewer', 'pre-pr certifier']] : ['ci-only', ['pre-pr reviewer']]);
  lane(run, round, 'pre-pr reviewer');
  if (options.full) lane(run, round, 'pre-pr certifier');
  const assembled = f.run('converge-certify', ['assemble', '--directory', run, '--author-provider', 'claude', '--output', join(run, 'certificate.json')]);
  assert.equal(assembled.status, 0, assembled.stderr);
  return run;
}
function prReport(f: ReturnType<typeof fixture>, execution = 'pre-pr') {
  const report = join(f.directory, 'pr-report.json');
  const result = f.run('converge-reconcile', ['--repo', 'Example/app', '--pr', '1', '--output', report, '--execution', execution]);
  assert.equal(result.status, 0, result.stderr);
  return report;
}
test('a certificate publishes a VERIFIED pre-pr verdict on the PR head and the arm accepts it', t => {
  const f = fixture(); t.after(f.cleanup);
  const run = certifiedPr(f);
  const report = prReport(f);
  const args = ['--report', report, '--certificate', join(run, 'certificate.json'), '--evidence', join(f.directory, 'evidence')];
  const published = f.run('publish.ts', args);
  assert.equal(published.status, 0, published.stderr);
  assert.equal(JSON.parse(published.stdout).dossier.round.execution, 'pre-pr');
  assert.equal(f.read().statuses[0].state, 'success'); assert.equal(f.read().statuses[0].description, 'VERIFIED by converge');
  const retry = f.run('publish.ts', args);
  assert.equal(retry.status, 0, retry.stderr); assert.equal(JSON.parse(retry.stdout).statusId, JSON.parse(published.stdout).statusId);
  assert.equal(f.read().comments.length, 1); assert.equal(f.read().statuses.length, 1);
  const armed = f.run('converge-arm', ['--repo', 'Example/app', '--pr', '1', '--head', f.state.head, '--verdict', 'VERIFIED', '--dry-run']);
  assert.equal(armed.status, 0, armed.stderr);
});
test('a full-mode certificate publishes the driven login coverage as a VERIFIED pre-pr verdict the arm accepts', t => {
  const f = fixture(); t.after(f.cleanup);
  const run = certifiedPr(f, { full: true, body: '## Verification\nfeature: login\n' });
  const report = prReport(f);
  const published = f.run('publish.ts', ['--report', report, '--certificate', join(run, 'certificate.json'), '--evidence', join(f.directory, 'evidence')]);
  assert.equal(published.status, 0, published.stderr);
  const { dossier } = JSON.parse(published.stdout);
  assert.equal(dossier.round.execution, 'pre-pr'); assert.equal(dossier.decision.displayResult, 'VERIFIED'); assert.deepEqual(dossier.coverage, ['login']);
  assert.equal(f.read().statuses[0].state, 'success'); assert.equal(f.read().statuses[0].description, 'VERIFIED by converge');
  const armed = f.run('converge-arm', ['--repo', 'Example/app', '--pr', '1', '--head', f.state.head, '--verdict', 'VERIFIED', '--dry-run']);
  assert.equal(armed.status, 0, armed.stderr);
});
for (const full of [false, true]) {
  test(`a ${full ? 'full-mode' : 'ci-only'} certificate publishes VERIFIED while the PR CI is still pending`, t => {
    const f = fixture(); t.after(f.cleanup);
    const run = certifiedPr(f, { full });
    f.state.checks = []; f.state.runOverrides = { status: 'in_progress', conclusion: null }; f.save();
    const report = prReport(f);
    assert.deepEqual(JSON.parse(readFileSync(report, 'utf8')).checks, []);
    const published = f.run('publish.ts', ['--report', report, '--certificate', join(run, 'certificate.json'), '--evidence', join(f.directory, 'evidence')]);
    assert.equal(published.status, 0, published.stderr);
    assert.equal(f.read().statuses[0].state, 'success'); assert.equal(f.read().statuses[0].description, 'VERIFIED by converge');
  });
}
test('a certificate for another head is refused before any publication', t => {
  const f = fixture(); t.after(f.cleanup);
  const run = certifiedPr(f);
  const live = f.read(); live.head = 'e'.repeat(40); live.pushedHead = live.head; Object.assign(f.state, live); f.save();
  const report = prReport(f);
  const published = f.run('publish.ts', ['--report', report, '--certificate', join(run, 'certificate.json'), '--evidence', join(f.directory, 'evidence')]);
  assert.notEqual(published.status, 0); assert.match(published.stderr, /PR head differs from certificate/);
  assert.deepEqual(f.read().statuses, []); assert.deepEqual(f.read().comments, []);
});
for (const fault of ['lane-without-certificate', 'retain-without-certificate', 'lane-with-certificate', 'converge-report', 'ci-claim', 'edited-log'] as const) {
  test(`certificate publication refuses ${fault} before any write`, t => {
    const f = fixture(); t.after(f.cleanup);
    const run = certifiedPr(f, fault === 'ci-claim' ? { body: f.state.body } : {});
    if (fault === 'edited-log') writeFileSync(join(run, 'runs', 'suite.log'), 'tampered');
    const report = prReport(f, fault === 'converge-report' ? 'converge' : 'pre-pr');
    const lane = ['--lane', join(run, 'lanes', 'pre-pr-reviewer', 'manifest.json')];
    const certificate = ['--certificate', join(run, 'certificate.json')];
    const extra = { 'lane-without-certificate': lane, 'retain-without-certificate': ['--retain', 'https://github.com/Example/app/pull/1#issuecomment-100'], 'lane-with-certificate': [...lane, ...certificate], 'converge-report': certificate, 'ci-claim': certificate, 'edited-log': certificate }[fault];
    const published = f.run('publish.ts', ['--report', report, '--evidence', join(f.directory, 'evidence'), ...extra]);
    assert.notEqual(published.status, 0);
    assert.match(published.stderr, { 'lane-without-certificate': /A pre-pr report publishes only through a certificate/, 'retain-without-certificate': /A pre-pr report publishes only through a certificate/, 'lane-with-certificate': /A certificate cannot mix with lanes or retained evidence/, 'converge-report': /Certificate publication needs a pre-pr report/, 'ci-claim': /A certified PR body cannot carry check, test or artifact claims/, 'edited-log': /Run suite log changed after it was recorded/ }[fault]);
    assert.deepEqual(f.read().statuses, []); assert.deepEqual(f.read().comments, []);
  });
}
