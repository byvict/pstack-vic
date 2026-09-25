import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseContract, parseRound, roleProviders } from './contract.ts';

const base = { repo: 'Example/app', trunk: 'main', requiredChecks: ['test', 'verdict'], holdLabels: ['needs-victor'], surfaces: [], riskClasses: { irreversible: [], contained: [] }, deployWindow: '04:00 America/Sao_Paulo', bugbot: 'never' };
const round = { id: '12345678-1234-1234-1234-123456789abc', repo: 'Example/app', head: 'b'.repeat(40), contract: 'a'.repeat(40), base: 'c'.repeat(40), patch_id: 'd'.repeat(40), verificationDigest: '1'.repeat(64), inputDigest: '2'.repeat(64), configPath: '.cursor/converge.json' };

test('a contract without app fields parses with null verification and default Tests names', () => {
  const c = parseContract({ ...base, verifySkill: null, featureMap: null, evidenceRoot: null });
  assert.equal(c.featureMap, null); assert.equal(c.prePr, null);
  assert.deepEqual(c.tests, { workflow: 'Tests', job: 'Run test suite' });
});
test('a prePr block names runs and whether the app is driven', () => {
  const c = parseContract({ ...base, verifySkill: null, featureMap: null, evidenceRoot: null, prePr: { runs: [{ name: 'suite', command: 'npm test' }], certifier: false }, tests: { workflow: 'CI', job: 'test' } });
  assert.deepEqual(c.prePr, { runs: [{ name: 'suite', command: 'npm test' }], certifier: false });
  assert.equal(c.tests.workflow, 'CI');
});
test('a prePr run name is a safe file stem', () => {
  assert.throws(() => parseContract({ ...base, verifySkill: null, featureMap: null, evidenceRoot: null, prePr: { runs: [{ name: '../x', command: 'npm test' }], certifier: false } }), /Unsafe run name/);
});
test('a prePr run command is argv joined by single spaces', () => {
  const prePr = (command: string) => parseContract({ ...base, verifySkill: null, featureMap: null, evidenceRoot: null, prePr: { runs: [{ name: 'suite', command }], certifier: false } });
  for (const command of ['npm test', 'npm run test:bun', 'npm run matrix:check', 'node --test --flag=value a/b.ts']) assert.equal(prePr(command).prePr?.runs[0]?.command, command);
  for (const command of ['', ' npm test', 'npm test ', 'npm  test', ...[..."'\"`$|&;<>(){}*?[]~#!\\", '\t', '\n', '\x00', '\x7f'].map(c => `npm test${c}x`)]) assert.throws(() => prePr(command), /Unsafe run command/, JSON.stringify(command));
});
test('round pr 0 is valid only for pre-pr', () => {
  assert.equal(parseRound({ ...round, pr: 0, execution: 'pre-pr' }).pr, 0);
  assert.throws(() => parseRound({ ...round, pr: 0, execution: 'converge' }), /Invalid PR/);
});
test('pre-pr roles are Grok 4.7 lanes and the verifier stays Cursor', () => {
  assert.equal(roleProviders['pre-pr reviewer'].provider, 'grok');
  assert.equal(roleProviders['pre-pr certifier'].model, 'grok-4.7');
  assert.equal(roleProviders['pr verifier'].provider, 'cursor');
});
