import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from './publish.ts';
import { parseReport, riskObligation } from './contract.ts';
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
