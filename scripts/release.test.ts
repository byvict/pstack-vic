import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./release.ts', import.meta.url));
const commit = 'c'.repeat(40);
const other = 'd'.repeat(40);
/** One fake for git, claude and codex, dispatched on its own file name. It answers from FAKE_ROOT/state.json and appends each call to FAKE_ROOT/calls.jsonl. A call the release has no business making, such as `git tag` or `git push`, fails. */
const fake = `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
const root = process.env.FAKE_ROOT;
const file = join(root, 'state.json');
const state = JSON.parse(readFileSync(file, 'utf8'));
const name = basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(join(root, 'calls.jsonl'), JSON.stringify([name, ...args]) + '\\n');
const out = text => process.stdout.write(text);
const save = () => writeFileSync(file, JSON.stringify(state));
const is = (...words) => args.length === words.length && words.every((word, i) => args[i] === word);
const fail = text => { process.stderr.write(text + '\\n'); process.exit(1); };
if ((state.failing ?? []).some(prefix => [name, ...args].join(' ').startsWith(prefix))) fail('fake ' + name + ': unable to access remote');
if (name === 'git') {
  if (is('fetch', 'origin')) {}
  else if (is('rev-parse', 'HEAD')) out(state.head + '\\n');
  else if (is('rev-parse', 'origin/main')) out(state.tip + '\\n');
  else if (args.length === 5 && is('ls-remote', '--exit-code', '--tags', 'origin', args[4]) && args[4].startsWith('refs/tags/')) { const tag = args[4].slice('refs/tags/'.length); if (!state.remoteTags[tag]) process.exit(2); out(state.remoteTags[tag] + '\\t' + args[4] + '\\n'); }
  else fail('fake git: ' + args.join(' '));
} else if (name === 'claude') {
  if (is('plugin', 'list', '--json')) out(JSON.stringify(state.claude.version ? [{ id: 'pstack@pstack-vic', version: state.claude.version }] : []));
  else if (is('plugin', 'marketplace', 'update', 'pstack-vic')) { state.claude.fetched = true; save(); }
  else if (is('plugin', 'update', 'pstack@pstack-vic')) { if (state.claude.fetched) state.claude.version = state.claude.latest; save(); }
  else fail('fake claude: ' + args.join(' '));
} else if (name === 'codex') {
  if (is('plugin', 'list', '--json')) out(JSON.stringify({ installed: state.codex.version ? [{ pluginId: 'pstack@pstack-vic', version: state.codex.version }] : [], available: [] }));
  else if (is('plugin', 'marketplace', 'list', '--json')) out(JSON.stringify({ marketplaces: state.codex.ref ? [{ name: 'pstack-vic' }] : [] }));
  else if (is('plugin', 'remove', 'pstack@pstack-vic')) { if (!state.codex.version) fail('not installed'); state.codex.version = null; save(); }
  else if (is('plugin', 'marketplace', 'remove', 'pstack-vic')) { if (!state.codex.ref) fail('no such marketplace'); state.codex.ref = null; save(); }
  else if (args.length === 6 && args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add' && args[3] === 'byvict/pstack-vic' && args[4] === '--ref') { state.codex.ref = args[5]; save(); }
  else if (is('plugin', 'add', 'pstack@pstack-vic')) { if (!state.codex.ref) fail('no marketplace'); state.codex.version = state.codex.lands ?? state.codex.ref.slice(1); save(); }
  else fail('fake codex: ' + args.join(' '));
} else fail('fake: ' + name);
`;
const original = 'ref = "v0.4.7"\n';
const checks = [['git', 'fetch', 'origin'], ['git', 'rev-parse', 'HEAD'], ['git', 'rev-parse', 'origin/main'], ['git', 'ls-remote', '--exit-code', '--tags', 'origin', 'refs/tags/v0.4.8']];
const claudeUpdate = [['claude', 'plugin', 'marketplace', 'update', 'pstack-vic'], ['claude', 'plugin', 'update', 'pstack@pstack-vic']];
const codexAdds = [['codex', 'plugin', 'marketplace', 'add', 'byvict/pstack-vic', '--ref', 'v0.4.8'], ['codex', 'plugin', 'add', 'pstack@pstack-vic']];
const codexQuartet = [['codex', 'plugin', 'remove', 'pstack@pstack-vic'], ['codex', 'plugin', 'marketplace', 'remove', 'pstack-vic'], ...codexAdds];
const wayBack = 'The Codex swap did not finish. Run this script again to finish it, or go back to the previous Codex setup with:\ncp ~/.codex/config.toml.pre-0.4.8 ~/.codex/config.toml && codex plugin add pstack@pstack-vic\n';
/** The merge commit of 0.4.8 checked out at the trunk tip, v0.4.8 on origin, both parents on 0.4.7. The child's PATH holds only the fakes and a link to this node, and its HOME is a temporary directory, so no real CLI and no real ~/.claude or ~/.codex is in reach. */
function setup(t: { after: (fn: () => void) => void }, change: (state: Record<string, any>) => void = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'pstack-release-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'); mkdirSync(bin);
  for (const name of ['git', 'claude', 'codex']) { writeFileSync(join(bin, name), fake); chmodSync(join(bin, name), 0o755); }
  symlinkSync(process.execPath, join(bin, 'node'));
  const home = join(root, 'home'); mkdirSync(join(home, '.codex'), { recursive: true }); writeFileSync(join(home, '.codex', 'config.toml'), original);
  const work = join(root, 'work'); mkdirSync(work); writeFileSync(join(work, 'package.json'), JSON.stringify({ version: '0.4.8' }));
  const state: Record<string, any> = { head: commit, tip: commit, remoteTags: { 'v0.4.8': commit }, claude: { version: '0.4.7', latest: '0.4.8' }, codex: { version: '0.4.7', ref: 'v0.4.7' } };
  change(state);
  const write = (next: Record<string, any>) => writeFileSync(join(root, 'state.json'), JSON.stringify(next));
  write(state);
  const calls = (): string[][] => existsSync(join(root, 'calls.jsonl')) ? readFileSync(join(root, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const read = () => JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
  return {
    config: join(home, '.codex', 'config.toml'), backup: join(home, '.codex', 'config.toml.pre-0.4.8'),
    run: () => spawnSync(process.execPath, [script], { cwd: work, encoding: 'utf8', env: { PATH: bin, HOME: home, FAKE_ROOT: root } }),
    calls, state: read, write,
    git: () => calls().filter(call => call[0] === 'git'),
    /** Every call to a parent's CLI, reads included. */
    parents: () => calls().filter(call => call[0] !== 'git'),
    /** The calls that change a parent. */
    moves: () => calls().filter(call => call[0] !== 'git' && !call.includes('--json')),
  };
}

test('with the checkout at the trunk tip and the tag on origin, a release moves both parents to the version', t => {
  const s = setup(t);
  const result = s.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'v0.4.8 is on origin\nClaude Code on pstack@pstack-vic 0.4.8\nCodex on pstack@pstack-vic 0.4.8\n');
  assert.deepEqual(s.calls().slice(0, checks.length), checks, 'the checks run before any parent is read');
  assert.deepEqual(s.git(), checks, 'the release never tags or pushes; CI does');
  assert.deepEqual(s.moves(), [...claudeUpdate, ...codexQuartet]);
  assert.equal(readFileSync(s.backup, 'utf8'), original);
  assert.deepEqual([s.state().claude.version, s.state().codex.version, s.state().codex.ref], ['0.4.8', '0.4.8', 'v0.4.8']);
});
test('run again once both parents are on the version, it changes nothing', t => {
  const s = setup(t, state => { state.claude.version = '0.4.8'; state.codex = { version: '0.4.8', ref: 'v0.4.8' }; });
  const result = s.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(s.moves(), []);
  assert.equal(existsSync(s.backup), false);
});
test('a checkout that is not the trunk tip refuses before the tag is looked up or a parent is touched', t => {
  const s = setup(t, state => { state.tip = other; });
  const result = s.run();
  assert.equal(result.status, 1);
  assert.equal(result.stderr, `HEAD ${commit} is not origin/main ${other}; run \`git pull --ff-only\` in the main checkout and run again\n`);
  assert.deepEqual(s.calls(), checks.slice(0, 3));
});
test('a version CI has not tagged yet refuses and touches nothing', t => {
  const s = setup(t, state => { state.remoteTags = { 'v0.4.7': other }; });
  const result = s.run();
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'CI has not tagged v0.4.8 yet; check `gh run list -R byvict/pstack-vic --branch main --limit 1`\n');
  assert.deepEqual(s.calls(), checks);
  assert.equal(existsSync(s.backup), false);
});
test('a fetch or a tag lookup that fails reports that failure, not a missing tag, and touches nothing', t => {
  for (const [failing, command] of [['git fetch', 'git fetch origin'], ['git ls-remote', 'git ls-remote --exit-code --tags origin refs/tags/v0.4.8']]) {
    const s = setup(t, state => { state.failing = [failing]; });
    const result = s.run();
    assert.equal(result.status, 1);
    assert.equal(result.stderr, `${command} failed: fake git: unable to access remote\n`);
    assert.deepEqual(s.parents(), []);
  }
});
test('a Claude Code update that lands on another version exits 1 and leaves Codex alone', t => {
  const s = setup(t, state => { state.claude.latest = '0.4.9'; });
  const result = s.run();
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'Claude Code reports pstack@pstack-vic 0.4.9, not 0.4.8\n');
  assert.deepEqual(s.parents().filter(call => call[0] === 'codex'), []);
  assert.equal(existsSync(s.backup), false);
});
test('a Claude Code command that fails exits 1 and leaves Codex alone', t => {
  const s = setup(t, state => { state.failing = ['claude plugin update']; });
  const result = s.run();
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'claude plugin update pstack@pstack-vic failed: fake claude: unable to access remote\n');
  assert.deepEqual(s.parents().filter(call => call[0] === 'codex'), []);
});
test('a Codex swap interrupted after the marketplace removal resumes with the two adds and keeps the first backup', t => {
  const s = setup(t, state => { state.codex = { version: null, ref: null }; });
  writeFileSync(s.backup, 'first\n');
  const result = s.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(s.moves().filter(call => call[0] === 'codex'), codexAdds);
  assert.equal(readFileSync(s.backup, 'utf8'), 'first\n');
});
test('a Codex swap that fails halfway exits 1 with the way back, and the next run finishes it', t => {
  const s = setup(t, state => { state.failing = ['codex plugin marketplace add']; });
  const failed = s.run();
  assert.equal(failed.status, 1);
  assert.equal(failed.stderr, `codex plugin marketplace add byvict/pstack-vic --ref v0.4.8 failed: fake codex: unable to access remote\n${wayBack}`);
  assert.deepEqual([s.state().claude.version, s.state().codex.version, s.state().codex.ref], ['0.4.8', null, null], 'Claude Code moved; Codex is left without the plugin and its marketplace');
  assert.equal(readFileSync(s.backup, 'utf8'), original);
  writeFileSync(s.config, 'half swapped\n');
  s.write({ ...s.state(), failing: [] });
  const before = s.moves().length;
  const result = s.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(s.moves().slice(before), codexAdds, 'the rerun skips what is done: no Claude Code update, no second removal');
  assert.equal(readFileSync(s.backup, 'utf8'), original, 'the first backup is the one to go back to');
  assert.equal(s.state().codex.version, '0.4.8');
});
test('a Codex swap that lands on another version exits 1 with the way back', t => {
  const s = setup(t, state => { state.codex.lands = '0.4.9'; });
  const result = s.run();
  assert.equal(result.status, 1);
  assert.equal(result.stderr, `Codex reports pstack@pstack-vic 0.4.9, not 0.4.8\n${wayBack}`);
});
test('without a config.toml there is no backup to go back to, and the failure says only to run again', t => {
  const s = setup(t, state => { state.failing = ['codex plugin add']; });
  rmSync(s.config);
  const result = s.run();
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'codex plugin add pstack@pstack-vic failed: fake codex: unable to access remote\nThe Codex swap did not finish. Run this script again to finish it\n');
  assert.equal(existsSync(s.backup), false);
});
