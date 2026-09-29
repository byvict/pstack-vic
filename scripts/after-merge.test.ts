import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./after-merge.ts', import.meta.url));
const commit = 'c'.repeat(40);
const other = 'd'.repeat(40);
const labels = ['com.pstack.converge-sweep', 'com.pstack.converge-raiz', 'com.pstack.converge-watch'];
/** One fake for git, claude, codex, launchctl and the new version's converge-local, dispatched on its own file name. It answers from FAKE_ROOT/state.json and appends each call to FAKE_ROOT/calls.jsonl; the real binaries never run. */
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
const tagOf = ref => ref.slice('refs/tags/'.length).replace('^{commit}', '');
if (name === 'git') {
  if (is('rev-parse', 'HEAD')) out(state.head + '\\n');
  else if (args[0] === 'ls-remote' && args[1] === '--tags') { const tag = tagOf(args[3]); if (state.remoteTags[tag]) out(state.remoteTags[tag] + '\\trefs/tags/' + tag + '\\n'); }
  else if (is('ls-remote', 'origin', 'refs/heads/main')) out(state.tip + '\\trefs/heads/main\\n');
  else if (args[0] === 'rev-parse' && args[1] === '-q' && args[2] === '--verify') { const tag = tagOf(args[3]); if (!state.localTags[tag]) process.exit(1); out(state.localTags[tag] + '\\n'); }
  else if (args[0] === 'tag' && args.length === 3) { state.localTags[args[1]] = args[2]; save(); }
  else if (args[0] === 'push' && args[1] === 'origin' && args.length === 3 && args[2].startsWith('refs/tags/')) { state.remoteTags[tagOf(args[2])] = state.localTags[tagOf(args[2])]; save(); }
  else fail('fake git: ' + args.join(' '));
} else if (name === 'claude') {
  if (is('plugin', 'list', '--json')) out(JSON.stringify(state.claude.version ? [{ id: 'pstack@pstack-vic', version: state.claude.version, installPath: state.claude.installPath }] : []));
  else if (is('plugin', 'marketplace', 'update', 'pstack-vic')) { state.claude.fetched = true; save(); }
  else if (is('plugin', 'update', 'pstack@pstack-vic')) { if (state.claude.fetched) Object.assign(state.claude, state.claude.latest); save(); }
  else fail('fake claude: ' + args.join(' '));
} else if (name === 'codex') {
  if (is('plugin', 'list', '--json')) out(JSON.stringify({ installed: state.codex.version ? [{ pluginId: 'pstack@pstack-vic', version: state.codex.version }] : [], available: [] }));
  else if (is('plugin', 'marketplace', 'list', '--json')) out(JSON.stringify({ marketplaces: state.codex.ref ? [{ name: 'pstack-vic' }] : [] }));
  else if (is('plugin', 'remove', 'pstack@pstack-vic')) { if (!state.codex.version) fail('not installed'); state.codex.version = null; save(); }
  else if (is('plugin', 'marketplace', 'remove', 'pstack-vic')) { if (!state.codex.ref) fail('no such marketplace'); state.codex.ref = null; save(); }
  else if (args.length === 6 && args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add' && args[3] === 'byvict/pstack-vic' && args[4] === '--ref') { state.codex.ref = args[5]; save(); }
  else if (is('plugin', 'add', 'pstack@pstack-vic')) { if (!state.codex.ref) fail('no marketplace'); state.codex.version = state.codex.ref.slice(1); save(); }
  else fail('fake codex: ' + args.join(' '));
} else if (name === 'launchctl') {
  const job = args[0] === 'list' ? state.jobs[args[1]] : undefined;
  if (!job) { process.stderr.write('Could not find service "' + args[1] + '" in domain for port\\n'); process.exit(113); }
  out('{\\n\\t"Label" = "' + args[1] + '";\\n' + (job.pid ? '\\t"PID" = ' + job.pid + ';\\n' : '') + '\\t"ProgramArguments" = (\\n\\t\\t"/bin/zsh";\\n\\t\\t"-c";\\n\\t\\t"exec "/n/node" "' + job.script + '" tick --job x --config "/c.json"";\\n\\t);\\n};\\n');
} else if (name === 'converge-local') writeFileSync(join(root, 'installed.json'), JSON.stringify(args));
else fail('fake: ' + name);
`;
/** A merge commit of 0.4.8 at the trunk tip, with v0.4.8 on no remote, both parents on 0.4.7, the three jobs loaded from the 0.4.7 cache and idle. */
function setup(t: { after: (fn: () => void) => void }, change: (state: Record<string, any>, paths: { newScript: string }) => void = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'after-merge-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'); mkdirSync(bin);
  for (const name of ['git', 'claude', 'codex', 'launchctl']) { writeFileSync(join(bin, name), fake); chmodSync(join(bin, name), 0o755); }
  const cache = (version: string) => join(root, 'cache', version);
  const scriptOf = (version: string) => join(cache(version), 'skills/poteto-mode/scripts/converge/converge-local');
  mkdirSync(dirname(scriptOf('0.4.8')), { recursive: true }); writeFileSync(scriptOf('0.4.8'), fake);
  const home = join(root, 'home'); mkdirSync(join(home, '.codex'), { recursive: true }); writeFileSync(join(home, '.codex', 'config.toml'), 'ref = "v0.4.7"\n');
  const work = join(root, 'work'); mkdirSync(work); writeFileSync(join(work, 'package.json'), JSON.stringify({ version: '0.4.8' }));
  const state: Record<string, any> = { head: commit, tip: commit, remoteTags: {}, localTags: {}, claude: { version: '0.4.7', installPath: cache('0.4.7'), latest: { version: '0.4.8', installPath: cache('0.4.8') } }, codex: { version: '0.4.7', ref: 'v0.4.7' }, jobs: Object.fromEntries(labels.map(l => [l, { pid: null, script: scriptOf('0.4.7') }])) };
  change(state, { newScript: scriptOf('0.4.8') });
  writeFileSync(join(root, 'state.json'), JSON.stringify(state));
  return {
    root, home,
    run: () => spawnSync(process.execPath, [script], { cwd: work, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home, FAKE_ROOT: root } }),
    calls: (): string[][] => existsSync(join(root, 'calls.jsonl')) ? readFileSync(join(root, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [],
    state: () => JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')),
  };
}
/** The detached install's argv, once the fake converge-local wrote it. */
async function installed(root: string): Promise<string[] | null> {
  for (let i = 0; i < 100; i++) {
    if (existsSync(join(root, 'installed.json'))) return JSON.parse(readFileSync(join(root, 'installed.json'), 'utf8'));
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return null;
}
const writes = (calls: string[][]) => calls.filter(call => !call.includes('--json') && !['ls-remote', 'list'].includes(String(call[1])) && !(call[0] === 'git' && call[1] === 'rev-parse'));

test('at the trunk tip a release tags the commit, pushes only that tag, moves both parents to the version and starts the reinstall detached, then defers', async t => {
  const s = setup(t);
  const result = s.run();
  assert.equal(result.status, 75, result.stderr);
  assert.deepEqual(writes(s.calls()), [
    ['git', 'tag', 'v0.4.8', commit], ['git', 'push', 'origin', 'refs/tags/v0.4.8'],
    ['claude', 'plugin', 'marketplace', 'update', 'pstack-vic'], ['claude', 'plugin', 'update', 'pstack@pstack-vic'],
    ['codex', 'plugin', 'remove', 'pstack@pstack-vic'], ['codex', 'plugin', 'marketplace', 'remove', 'pstack-vic'], ['codex', 'plugin', 'marketplace', 'add', 'byvict/pstack-vic', '--ref', 'v0.4.8'], ['codex', 'plugin', 'add', 'pstack@pstack-vic'],
  ]);
  assert.equal(readFileSync(join(s.home, '.codex', 'config.toml.pre-0.4.8'), 'utf8'), 'ref = "v0.4.7"\n');
  assert.deepEqual([s.state().remoteTags['v0.4.8'], s.state().claude.version, s.state().codex.version], [commit, '0.4.8', '0.4.8']);
  assert.deepEqual(await installed(s.root), ['install', '--when-idle']);
  assert.equal(existsSync(join(s.home, 'Library', 'Logs', 'pstack-after-merge.log')), true);
});
test('run again once everything is in place, it writes nothing and ends the release with 0', async t => {
  const s = setup(t, (state, { newScript }) => { state.remoteTags = { 'v0.4.8': commit }; Object.assign(state.claude, state.claude.latest); state.codex = { version: '0.4.8', ref: 'v0.4.8' }; for (const job of Object.values(state.jobs) as { script: string }[]) job.script = newScript; });
  const result = s.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(writes(s.calls()), []);
  assert.equal(await installed(s.root).then(() => existsSync(join(s.root, 'installed.json'))), false);
});
test('a commit behind the trunk tip only gets its tag; the tip\'s own run moves the parents', t => {
  const s = setup(t, state => { state.tip = other; });
  const result = s.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(s.calls().filter(call => call[0] !== 'git'), []);
  assert.equal(s.state().remoteTags['v0.4.8'], commit);
});
test('a running Raiz defers the reinstall without starting it, after the parents moved', async t => {
  const s = setup(t, state => { state.jobs['com.pstack.converge-raiz'].pid = 4242; });
  const result = s.run();
  assert.equal(result.status, 75, result.stderr);
  assert.match(result.stdout, /a Raiz is running/);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(existsSync(join(s.root, 'installed.json')), false);
  assert.deepEqual([s.state().claude.version, s.state().codex.version], ['0.4.8', '0.4.8']);
});
test('without a loaded daemon there is nothing to reinstall', t => {
  const s = setup(t, state => { state.jobs = {}; });
  const result = s.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no converge daemon is loaded/);
});
test('a Codex swap interrupted after the marketplace removal resumes with the two adds and keeps the first backup', t => {
  const s = setup(t, state => { state.codex = { version: null, ref: null }; });
  writeFileSync(join(s.home, '.codex', 'config.toml.pre-0.4.8'), 'first\n');
  assert.equal(s.run().status, 75);
  assert.deepEqual(writes(s.calls()).filter(call => call[0] === 'codex'), [['codex', 'plugin', 'marketplace', 'add', 'byvict/pstack-vic', '--ref', 'v0.4.8'], ['codex', 'plugin', 'add', 'pstack@pstack-vic']]);
  assert.equal(readFileSync(join(s.home, '.codex', 'config.toml.pre-0.4.8'), 'utf8'), 'first\n');
});
test('a local tag on another commit refuses before any push', t => {
  const s = setup(t, state => { state.localTags = { 'v0.4.8': other }; });
  const result = s.run();
  assert.equal(result.status, 1);
  assert.equal(result.stderr, `local tag v0.4.8 points at ${other}, not ${commit}\n`);
  assert.deepEqual(s.calls().filter(call => call[1] === 'push'), []);
});
test('a plugin update that lands on another version fails', t => {
  const s = setup(t, state => { state.claude.latest.version = '0.4.9'; });
  const result = s.run();
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'Claude Code reports pstack@pstack-vic 0.4.9, not 0.4.8\n');
});
