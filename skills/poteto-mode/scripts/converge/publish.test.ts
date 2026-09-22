import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './fixtures/setup.ts';
import { hash, riskObligation, parseReport, type RiskObligation } from './contract.ts';

for (const proveBoth of [false, true]) {
  test(`two money paths require ${proveBoth ? 'two individually admitted proofs, including retained evidence' : 'more than one shared-rule proof'}`, t => {
    const f = fixture(); t.after(f.cleanup);
    f.state.files = ['billing/one.js', 'billing/two.js'].map(filename => ({ filename, status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' }));
    f.state.diff = f.state.files.map(v => `diff --git a/${v.filename} b/${v.filename}\nindex 1111111..2222222 100644\n--- a/${v.filename}\n+++ b/${v.filename}\n${v.patch}\n`).join('');
    f.save();
    const reportPath = join(f.directory, 'report.json');
    const reconciled = f.run('converge-reconcile', ['--repo', 'Example/app', '--pr', '1', '--output', reportPath]);
    assert.equal(reconciled.status, 0, reconciled.stderr);
    const report = parseReport(JSON.parse(reconciled.stdout));
    const obligations = report.hardList.map(riskObligation);
    assert.deepEqual(obligations.map(o => o.path), ['billing/one.js', 'billing/two.js']);
    const manifests: string[] = [];
    for (const [role, lane] of [['pr verifier', 'verifier'], ['pr reviewer', 'reviewer']]) {
      const directory = join(f.directory, lane);
      const prepared = f.run('prepare-lane.ts', ['--report', reportPath, '--directory', directory, '--lane', lane, '--role', role, '--descriptor', 'codex:gpt-6-astra@high']);
      assert.equal(prepared.status, 0, prepared.stderr);
      const manifestPath = join(directory, 'manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const artifacts: { id: string; path: string; bytes: number; sha256: string; mediaType: string }[] = [];
      const riskProofs: { obligation: RiskObligation; result: string; artifactIds: string[] }[] = [];
      if (lane === 'reviewer') for (const obligation of obligations.slice(0, proveBoth ? 2 : 1)) {
        const id = 'proof-' + artifacts.length;
        const path = `artifacts/converge/${report.round.id}/${lane}/${id}.json`;
        const bytes = Buffer.from(JSON.stringify({ path: obligation.path, command: 'local fixture for ' + obligation.path, result: 'safe' }));
        mkdirSync(join(directory, `artifacts/converge/${report.round.id}/${lane}`), { recursive: true });
        writeFileSync(join(directory, path), bytes);
        artifacts.push({ id, path, bytes: bytes.length, sha256: hash(bytes), mediaType: 'application/json' });
        riskProofs.push({ obligation, result: 'proved-safe', artifactIds: [id] });
      }
      const output = { schemaVersion: 1, round: report.round.id, laneId: lane, role, observedHead: report.round.head, observedContract: report.round.contract, kind: 'complete', findings: [], artifacts, coverage: [], riskProofs };
      const receipt = { schemaVersion: 1, parent: 'claude', provider: 'codex', model: 'gpt-6-astra', effort: 'high', mode: 'read-only', status: 'complete', promptPath: join(directory, 'prompt.txt'), outputPath: join(directory, 'output.json'), startedAt: new Date(manifest.createdAt).toISOString(), completedAt: new Date(manifest.createdAt + 1000).toISOString(), modelVerified: false, modelEvidence: 'pinned-argv', reportedModel: null, remote: null };
      writeFileSync(join(directory, 'receipt.json'), JSON.stringify(receipt));
      writeFileSync(join(directory, 'output.json'), JSON.stringify(output));
      manifests.push(manifestPath);
    }
    const published = f.run('publish.ts', ['--report', reportPath, '--evidence', join(f.directory, 'admitted'), ...manifests.flatMap(path => ['--lane', path])]);
    assert.equal(published.status, 0, published.stderr);
    const publication = JSON.parse(published.stdout);
    assert.equal(publication.dossier.decision.verdict, proveBoth ? 'VERIFIED' : 'INCONCLUSIVE');
    assert.deepEqual(publication.dossier.riskAdjudication, obligations.slice(0, proveBoth ? 2 : 1));
    assert.equal(f.read().statuses[0].state, proveBoth ? 'success' : 'error');
    if (proveBoth) {
      Object.assign(f.state, f.read()); f.state.head = 'e'.repeat(40); f.save();
      const rebased = f.run('converge-reconcile', ['--repo', 'Example/app', '--pr', '1', '--output', join(f.directory, 'rebased.json')]);
      assert.equal(rebased.status, 0, rebased.stderr);
      const retained = f.run('publish.ts', ['--report', join(f.directory, 'rebased.json'), '--evidence', join(f.directory, 'retained'), '--retain', publication.commentUrl]);
      assert.equal(retained.status, 0, retained.stderr);
      const dossier = JSON.parse(retained.stdout).dossier;
      assert.equal(dossier.decision.verdict, 'VERIFIED');
      assert.deepEqual(dossier.riskAdjudication, obligations);
      assert.equal(dossier.retainedFrom.round, report.round.id);
      assert.equal(dossier.round.head, f.state.head);
    }
  });
}
