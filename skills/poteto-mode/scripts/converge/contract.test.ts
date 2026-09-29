import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseContract, parseRound } from './contract.ts';

const base = { repo: 'Example/app', trunk: 'main', requiredChecks: ['test', 'verdict'], holdLabels: ['needs-victor'], surfaces: [], riskClasses: { irreversible: [], contained: [] }, deployWindow: '04:00 America/Sao_Paulo', bugbot: 'never' };
const round = { id: '12345678-1234-1234-1234-123456789abc', repo: 'Example/app', head: 'b'.repeat(40), contract: 'a'.repeat(40), base: 'c'.repeat(40), patch_id: 'd'.repeat(40), verificationDigest: '1'.repeat(64), inputDigest: '2'.repeat(64), configPath: '.cursor/converge.json' };

test('a contract without app fields parses with null verification and default Tests names', () => {
  const c = parseContract({ ...base, verifySkill: null, featureMap: null, evidenceRoot: null });
  assert.equal(c.featureMap, null); assert.equal(c.prePr, null);
  assert.deepEqual(c.tests, { workflow: 'Tests', job: 'Run test suite' });
});
test('a prePr block names runs and whether the app is driven', () => {
  const c = parseContract({ ...base, verifySkill: null, featureMap: null, evidenceRoot: null, prePr: { runs: [{ name: 'suite', command: 'npm test' }], certifier: false }, tests: { workflow: 'CI', job: 'test' } });
  assert.deepEqual(c.prePr, { runs: [{ name: 'suite', command: 'npm test' }], certifier: false, light: null });
  assert.equal(c.tests.workflow, 'CI');
});
const withLight = (light: unknown) => parseContract({ ...base, verifySkill: null, featureMap: null, evidenceRoot: null, prePr: { runs: [{ name: 'suite', command: 'npm test' }], certifier: false, light } });
test('a light class lists path patterns and a narrow reviewer by default', () => {
  assert.deepEqual(withLight({ paths: ['docs/**', '**/*.test.ts', 'package.json'] }).prePr?.light, { paths: ['docs/**', '**/*.test.ts', 'package.json'], reviewer: 'narrow' });
});
test('a light class may name no reviewer', () => {
  assert.equal(withLight({ paths: ['docs/**'], reviewer: 'none' }).prePr?.light?.reviewer, 'none');
});
test('a light class with no paths leaves only a dependency-only change light', () => {
  assert.deepEqual(withLight({ paths: [] }).prePr?.light, { paths: [], reviewer: 'narrow' });
});
test('light paths are validated as surfaces are', () => {
  for (const pattern of ['', '/docs/**', '../docs/**', 'docs//x.md', 'docs/?.md']) assert.throws(() => withLight({ paths: [pattern] }), /Unsafe relative path/, JSON.stringify(pattern));
  assert.throws(() => withLight({ reviewer: 'narrow' }), /Invalid array/);
});
test('a light reviewer outside narrow and none is refused', () => {
  assert.throws(() => withLight({ paths: [], reviewer: 'full' }), /Invalid enum value/);
});
test('a light class outside the prePr block is refused', () => {
  assert.throws(() => parseContract({ ...base, verifySkill: null, featureMap: null, evidenceRoot: null, light: { paths: [] } }), /A light class belongs in the prePr block/);
  assert.throws(() => parseContract({ ...base, verifySkill: null, featureMap: null, evidenceRoot: null, prePr: null, light: { paths: [] } }), /A light class belongs in the prePr block/);
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
const bare = { ...base, verifySkill: null, featureMap: null, evidenceRoot: null };
test('a postMerge block names runs with the prePr grammar and waits for trunk Tests unless it says none', () => {
  assert.equal(parseContract(bare).postMerge, null);
  assert.deepEqual(parseContract({ ...bare, postMerge: { runs: [{ name: 'release', command: 'npm run after-merge' }] } }).postMerge, { runs: [{ name: 'release', command: 'npm run after-merge' }], after: 'tests' });
  assert.equal(parseContract({ ...bare, postMerge: { runs: [], after: 'none' } }).postMerge?.after, 'none');
});
test('a postMerge block refuses what prePr refuses, and an after other than tests or none', () => {
  const postMerge = (block: unknown) => parseContract({ ...bare, postMerge: block });
  assert.throws(() => postMerge({ runs: [{ name: '../x', command: 'npm test' }] }), /Unsafe run name/);
  assert.throws(() => postMerge({ runs: [{ name: 'release', command: 'npm test; rm -rf x' }] }), /Unsafe run command/);
  assert.throws(() => postMerge({ runs: [{ name: 'a', command: 'x' }, { name: 'a', command: 'y' }] }), /Duplicate run name/);
  assert.throws(() => postMerge({ runs: [], after: 'merge' }), /Invalid enum value/);
  assert.throws(() => postMerge({ after: 'tests' }), /Invalid array/);
});
