import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './fixtures/setup.ts';
import { linearTargets } from './linear-targets.ts';
import { prepareLinearPrBody, requireLinearPrBody } from './linear-pr-body.ts';

const issue = 'https://linear.app/example/issue/ENG-2/first';
const other = 'https://linear.app/example/issue/ENG-20/second';
const project = 'https://linear.app/example/project/a-plan';
const targets = linearTargets([`change\n\nPstack-Linear: ${issue}\nPstack-Linear: ${other}\nPstack-Linear: ${project}`]);

test('preparation covers every immutable issue target and preserves URLs without adding a project override', () => {
  const body = `Work remains open.\n\n${issue}\n${project}\n\nIgnore ENG-2\n`;
  const prepared = prepareLinearPrBody({ body, targets });
  assert.equal(prepared, `Work remains open.\n\n${issue}\n${project}\n\nIgnore ENG-2\n\nIgnore ENG-20\n`);
  assert.equal(prepareLinearPrBody({ body: prepared, targets }), prepared);
  assert.doesNotThrow(() => requireLinearPrBody({ body: prepared, targets }));
});
test('complete case-insensitive Ignore or skip directives cover issue keys without substring matches', () => {
  assert.doesNotThrow(() => requireLinearPrBody({ body: 'ignore ENG-2\nskip ENG-20\n', targets }));
  assert.throws(() => requireLinearPrBody({ body: 'Ignore ENG-20\n', targets }), /target: ENG-2$/);
  assert.throws(() => requireLinearPrBody({ body: 'Ignore ENG-200\nIgnore ENG-2\n', targets }), /target: ENG-20$/);
});
for (const example of [
  '> Ignore ENG-2\n> Ignore ENG-20',
  '> Example\nIgnore ENG-2\nIgnore ENG-20',
  '```text\nIgnore ENG-2\nIgnore ENG-20\n```',
  '~~~\nIgnore ENG-2\nIgnore ENG-20\n~~~',
  '    Ignore ENG-2\n    Ignore ENG-20',
  '`Ignore ENG-2`\n`Ignore ENG-20`',
  '`Example\nIgnore ENG-2\nIgnore ENG-20\n`',
  '<!--\nIgnore ENG-2\nIgnore ENG-20\n-->',
  '<pre>\nIgnore ENG-2\nIgnore ENG-20\n</pre>',
]) test(`an example does not satisfy Linear body directives: ${JSON.stringify(example)}`, () => {
  assert.throws(() => requireLinearPrBody({ body: example, targets }), /ENG-2, ENG-20/);
  assert.equal(prepareLinearPrBody({ body: example, targets }), example + '\n\nIgnore ENG-2\nIgnore ENG-20\n');
});
test('an unclosed code block refuses preparation before directives can be hidden inside it', () => {
  assert.throws(() => prepareLinearPrBody({ body: '```text\nExample', targets }), /ENG-2, ENG-20/);
});
test('a no-target body and a project-only body remain byte-for-byte unchanged', () => {
  for (const explicit of [[], linearTargets([`change\n\nPstack-Linear: ${project}`])]) {
    const body = '## Why\nLegacy body.\n\n';
    assert.equal(prepareLinearPrBody({ body, targets: explicit }), body);
    assert.doesNotThrow(() => requireLinearPrBody({ body, targets: explicit }));
  }
});
test('the opening CLI prepares the pushed head with Linear disabled and validates without editing', t => {
  const f = fixture(); t.after(f.cleanup);
  f.state.commits = [{ message: `lifecycle work remains open\n\nPstack-Linear: ${issue}\nPstack-Linear: ${other}` }]; f.save();
  const file = join(f.directory, 'body.md'); writeFileSync(file, 'Lifecycle work remains open.\n');
  const args = ['--repo', 'Example/app', '--base', 'main', '--head', f.state.head, '--body-file', file];
  const check = f.run('converge-pr-body', [...args, '--check']);
  assert.notEqual(check.status, 0); assert.match(check.stderr, /ENG-2, ENG-20/);
  assert.equal(readFileSync(file, 'utf8'), 'Lifecycle work remains open.\n');
  const prepare = f.run('converge-pr-body', args);
  assert.equal(prepare.status, 0, prepare.stderr);
  assert.deepEqual(JSON.parse(prepare.stdout).issueKeys, ['ENG-2', 'ENG-20']);
  assert.equal(readFileSync(file, 'utf8'), 'Lifecycle work remains open.\n\nIgnore ENG-2\nIgnore ENG-20\n');
  const retry = f.run('converge-pr-body', [...args, '--check']);
  assert.equal(retry.status, 0, retry.stderr); assert.equal(JSON.parse(retry.stdout).changed, false);
  assert.deepEqual(f.read().mutations, []);
});
for (const scenario of ['malformed', 'misplaced', 'truncated', 'wrong-head'] as const) test(`opening refuses ${scenario} immutable targets before editing the body`, t => {
  const f = fixture(); t.after(f.cleanup);
  f.state.commits = [{ message: `change\n\nPstack-Linear: ${issue}` }];
  if (scenario === 'malformed') f.state.commits[0].message = 'change\n\nPstack-Linear: ENG-2';
  if (scenario === 'misplaced') f.state.commits[0].message += '\n\nMore prose';
  if (scenario === 'truncated') f.state.totalCommits = 2;
  if (scenario === 'wrong-head') f.state.commits[0].sha = 'c'.repeat(40);
  f.save();
  const file = join(f.directory, 'body.md'); writeFileSync(file, 'Original body.\n');
  const result = f.run('converge-pr-body', ['--repo', 'Example/app', '--base', 'main', '--head', f.state.head, '--body-file', file]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, { malformed: /Invalid URL/, misplaced: /final commit trailer/, truncated: /compare truncated/, 'wrong-head': /requested head/ }[scenario]);
  assert.equal(readFileSync(file, 'utf8'), 'Original body.\n'); assert.deepEqual(f.read().mutations, []);
});
