import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './fixtures/setup.ts';
import { parseReport } from './contract.ts';

test('reviewer prompt keeps risk inputs and omits unrelated UI verification manuals', t => {
  const f = fixture(); t.after(f.cleanup);
  f.state.files = [{ filename: 'billing/charge.js', status: 'modified', patch: '@@ -1 +1 @@\n-charge(100)\n+charge(200)' }];
  f.state.diff = 'diff --git a/billing/charge.js b/billing/charge.js\nindex 1111111..2222222 100644\n--- a/billing/charge.js\n+++ b/billing/charge.js\n@@ -1 +1 @@\n-charge(100)\n+charge(200)\n';
  f.save();

  const reportPath = join(f.directory, 'report.json');
  const reconciled = f.run('converge-reconcile', ['--repo', 'Example/app', '--pr', '1', '--output', reportPath]);
  assert.equal(reconciled.status, 0, reconciled.stderr);
  const report = parseReport(JSON.parse(reconciled.stdout));
  assert.ok(report.lanes.includes('pr reviewer'));

  const directory = join(f.directory, 'reviewer');
  const prepared = f.run('prepare-lane.ts', ['--report', reportPath, '--directory', directory, '--lane', 'reviewer', '--role', 'pr reviewer', '--descriptor', 'codex:gpt-6-astra@high']);
  assert.equal(prepared.status, 0, prepared.stderr);
  const prompt = readFileSync(join(directory, 'prompt.txt'), 'utf8');
  assert.match(prompt, /Start from the diff and the exact hard-list obligations/);
  assert.match(prompt, /Trusted material at .*:\.cursor\/converge\.json/);
  assert.match(prompt, /Trusted material at .*:\.github\/workflows\/tests\.yml/);
  assert.doesNotMatch(prompt, /Trusted material at .*:verify\/SKILL\.md/);
  assert.doesNotMatch(prompt, /Trusted material at .*:features\/README\.md/);
  assert.doesNotMatch(prompt, /Clinext verification map/);

  const verifierDirectory = join(f.directory, 'verifier');
  const verifier = f.run('prepare-lane.ts', ['--report', reportPath, '--directory', verifierDirectory, '--lane', 'verifier', '--role', 'pr verifier', '--descriptor', 'codex:gpt-6-astra@high']);
  assert.equal(verifier.status, 0, verifier.stderr);
  const verifierPrompt = readFileSync(join(verifierDirectory, 'prompt.txt'), 'utf8');
  assert.match(verifierPrompt, /Trusted material at .*:verify\/SKILL\.md/);
  assert.match(verifierPrompt, /Trusted material at .*:features\/README\.md/);
});
