import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decide, dossierFromComment } from './publish.ts';
import { parseReport, riskObligation } from './contract.ts';
import { certifiedPr, fixture, prReport } from './fixtures/setup.ts';

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
test('a ci-only certificate publishes its skipped run and the arm accepts it', t => {
  const f = fixture(); t.after(f.cleanup);
  const run = certifiedPr(f, { record: false });
  const skipped = [{ name: 'suite', command: 'true', skip: 'ci-only report' }];
  assert.deepEqual(JSON.parse(readFileSync(join(run, 'certificate.json'), 'utf8')).runs, skipped);
  const published = f.run('publish.ts', ['--report', prReport(f), '--certificate', join(run, 'certificate.json'), '--evidence', join(f.directory, 'evidence')]);
  assert.equal(published.status, 0, published.stderr);
  assert.deepEqual((commentDossier(f.read().comments[0]).certificate as { runs: unknown }).runs, skipped);
  assert.equal(f.read().statuses[0].description, 'VERIFIED by converge');
  const armed = f.run('converge-arm', ['--repo', 'Example/app', '--pr', '1', '--head', f.state.head, '--verdict', 'VERIFIED', '--dry-run']);
  assert.equal(armed.status, 0, armed.stderr);
});
test('a verdict comment over GitHub\'s size limit is refused before any write', t => {
  const f = fixture(); t.after(f.cleanup);
  const run = certifiedPr(f, { full: true, body: '## Verification\nfeature: login\n', steps: 200 });
  const published = f.run('publish.ts', ['--report', prReport(f), '--certificate', join(run, 'certificate.json'), '--evidence', join(f.directory, 'evidence')]);
  assert.notEqual(published.status, 0);
  const size = Number(published.stderr.match(/^Verdict comment exceeds GitHub's 65536-character limit \((\d+)\)$/m)?.[1]);
  assert.ok(size > 65_536, published.stderr);
  assert.deepEqual(f.read().statuses, []); assert.deepEqual(f.read().comments, []);
});
function commentDossier(comment: { body: string }): Record<string, unknown> {
  const match = comment.body.match(/^<!-- converge:v1 [a-f0-9-]{36} -->\n```json\n([\s\S]+)\n```\n$/);
  assert.ok(match);
  return JSON.parse(match[1] ?? '');
}
function asComment(dossier: Record<string, unknown>) {
  return { body: `<!-- converge:v1 ${(dossier.round as { id: string }).id} -->\n\`\`\`json\n${JSON.stringify(dossier, null, 2)}\n\`\`\`\n` };
}
test('the published comment carries the certificate and stays byte-identical on retry', t => {
  const f = fixture(); t.after(f.cleanup);
  const run = certifiedPr(f, { full: true, body: '## Verification\nfeature: login\n' });
  const report = prReport(f);
  const args = ['--report', report, '--certificate', join(run, 'certificate.json'), '--evidence', join(f.directory, 'evidence')];
  const published = f.run('publish.ts', args);
  assert.equal(published.status, 0, published.stderr);
  const certificate = JSON.parse(readFileSync(join(run, 'certificate.json'), 'utf8'));
  const dossier = commentDossier(f.read().comments[0]);
  assert.deepEqual(dossier.certificate, certificate); assert.deepEqual(JSON.parse(published.stdout).dossier.certificate, certificate);
  assert.deepEqual([certificate.runs.length, certificate.lanes.length, certificate.artifacts.length, certificate.adjustRounds, certificate.authorProvider], [1, 2, 2, 1, 'claude']);
  assert.match(certificate.toolingRef, /^pstack-vic@\d+\.\d+\.\d+$/);
  const body = f.read().comments[0].body;
  const retry = f.run('publish.ts', args);
  assert.equal(retry.status, 0, retry.stderr); assert.equal(f.read().comments.length, 1); assert.equal(f.read().comments[0].body, body);
  assert.throws(() => dossierFromComment(asComment({ ...dossier, certificate: undefined })), /A certificate belongs exactly to a pre-pr verdict/);
  assert.throws(() => dossierFromComment(asComment({ ...dossier, round: { ...(dossier.round as object), execution: 'converge' } })), /A certificate belongs exactly to a pre-pr verdict/);
  assert.throws(() => dossierFromComment(asComment({ ...dossier, certificate: { ...certificate, coverage: ['login', 'billing'] } })), /Certificate differs from the verdict round/);
});
test('a converge publication carries a null certificate and a dossier without the key still parses', t => {
  const f = fixture(); t.after(f.cleanup);
  const report = join(f.directory, 'report.json');
  const reconciled = f.run('converge-reconcile', ['--repo', 'Example/app', '--pr', '1', '--output', report]);
  assert.equal(reconciled.status, 0, reconciled.stderr);
  const published = f.run('publish.ts', ['--report', report, '--evidence', join(f.directory, 'evidence')]);
  assert.equal(published.status, 0, published.stderr);
  const dossier = commentDossier(f.read().comments[0]);
  assert.equal(dossier.certificate, null); assert.equal(Object.keys(dossier).at(-1), 'certificate');
  const old = { ...dossier };
  delete old.certificate;
  const parsed = dossierFromComment(asComment(old));
  assert.equal(parsed.certificate, null); assert.deepEqual(parsed, dossierFromComment(f.read().comments[0]));
});
for (const fault of ['no-runs', 'skipped-run', 'lane-effort', 'artifact-bytes', 'coverage', 'display-result', 'report'] as const) {
  test(`a full-mode certificate edited with ${fault} is refused at publication before any write`, t => {
    const f = fixture(); t.after(f.cleanup);
    const run = certifiedPr(f, { full: true });
    const file = join(run, 'certificate.json');
    const certificate = JSON.parse(readFileSync(file, 'utf8'));
    const edit = { 'no-runs': { runs: [] }, 'skipped-run': { runs: [{ name: 'suite', command: 'true', skip: 'ci-only report' }] }, 'lane-effort': { lanes: [{ ...certificate.lanes[0], effort: 'high' }, certificate.lanes[1]] }, 'artifact-bytes': { artifacts: [{ ...certificate.artifacts[0], bytes: certificate.artifacts[0].bytes + 1 }, certificate.artifacts[1]] }, coverage: { coverage: ['login', 'billing'] }, 'display-result': { decision: { ...certificate.decision, displayResult: 'CI-only' } }, report: {} }[fault];
    writeFileSync(file, JSON.stringify({ ...certificate, ...edit }));
    if (fault === 'report') writeFileSync(join(run, 'report.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(run, 'report.json'), 'utf8')), unmappedSurfaces: ['client/Other.jsx'] }));
    const published = f.run('publish.ts', ['--report', prReport(f), '--certificate', file, '--evidence', join(f.directory, 'evidence')]);
    assert.notEqual(published.status, 0);
    assert.match(published.stderr, { 'no-runs': /Required run missing: suite/, 'skipped-run': /A skipped run needs a CI-only certificate/, 'lane-effort': /Certificate lane differs from its manifest/, 'artifact-bytes': /Certificate artifacts differ from the admitted lanes/, coverage: /Certificate coverage differs from the admitted lanes/, 'display-result': /Certificate decision differs from the admitted evidence/, report: /Certificate report differs from the recorded report/ }[fault]);
    assert.deepEqual(f.read().statuses, []); assert.deepEqual(f.read().comments, []);
  });
}
test('a pre-pr PR report reads no CI, so publication succeeds after the PR checks move on', t => {
  const f = fixture(); t.after(f.cleanup);
  const run = certifiedPr(f);
  f.state.checks = f.state.checks.map(c => ({ ...c, status: 'queued' })); f.state.runOverrides = { status: 'in_progress', conclusion: null }; f.save();
  const report = prReport(f);
  f.state.checks = f.state.checks.map(c => ({ ...c, status: 'completed' })); f.state.runOverrides = { status: 'completed', conclusion: 'success' }; f.save();
  const published = f.run('publish.ts', ['--report', report, '--certificate', join(run, 'certificate.json'), '--evidence', join(f.directory, 'evidence')]);
  assert.equal(published.status, 0, published.stderr);
  assert.equal(f.read().statuses[0].state, 'success');
  assert.deepEqual(f.calls().filter(call => call[0] === 'run' || /\/check-runs|\/actions\/(?:workflows\/\d+\/runs|runs\/)/.test(call[1] ?? '')), []);
});
