import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./release.ts', import.meta.url));
const commit = 'c'.repeat(40);
const other = 'd'.repeat(40);
/** One fake for git, claude and codex, dispatched on its own file name. It answers from FAKE_ROOT/state.json and appends each call to FAKE_ROOT/calls.jsonl. A call the release has no business making, such as `git tag` or `git push`, fails. The fake claude keeps one install record per scope and project, and `plugin update --scope` moves only the record of that scope whose project is the cwd (any cwd for user), as the real CLI does. From a linked worktree (a `.git` file) the project is the main checkout, as Claude Code 2.1.295 resolves it. */
const fake = `#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
const root = process.env.FAKE_ROOT;
const file = join(root, 'state.json');
const state = JSON.parse(readFileSync(file, 'utf8'));
const name = basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(join(root, 'calls.jsonl'), JSON.stringify([name, ...args]) + '\\n');
appendFileSync(join(root, 'contexts.jsonl'), JSON.stringify({ name, args, cwd: process.cwd(), configHome: process.env.CODEX_HOME || join(process.env.HOME, '.codex') }) + '\\n');
const out = text => process.stdout.write(text);
const save = () => writeFileSync(file, JSON.stringify(state));
const is = (...words) => args.length === words.length && words.every((word, i) => args[i] === word);
const fail = text => { process.stderr.write(text + '\\n'); process.exit(1); };
const policyFile = join(process.env.CODEX_HOME || join(process.env.HOME, '.codex'), 'config.toml');
const changePolicy = enabled => {
  const text = existsSync(policyFile) ? readFileSync(policyFile, 'utf8') : '';
  let skipping = false;
  const newline = String.fromCharCode(10);
  const kept = text.split(newline).filter(line => {
    if (line.startsWith('[')) skipping = line.startsWith('[plugins."pstack@pstack-vic"]') || line.startsWith('[plugins."pstack@pstack-vic".');
    return !skipping;
  }).join(newline);
  mkdirSync(process.env.CODEX_HOME || join(process.env.HOME, '.codex'), { recursive: true });
  writeFileSync(policyFile, kept + (enabled ? newline + '[plugins."pstack@pstack-vic"]' + newline + 'enabled = true' + newline : ''));
};
if ((state.failing ?? []).some(prefix => [name, ...args].join(' ').startsWith(prefix))) fail('fake ' + name + ': unable to access remote');
if (name === 'git') {
  if (is('fetch', 'origin')) {}
  else if (is('rev-parse', 'HEAD')) out(state.head + '\\n');
  else if (is('rev-parse', 'origin/main')) out(state.tip + '\\n');
  else if (args.length === 5 && is('ls-remote', '--exit-code', '--tags', 'origin', args[4]) && args[4].startsWith('refs/tags/')) { const tag = args[4].slice('refs/tags/'.length); if (!state.remoteTags[tag]) process.exit(2); out(state.remoteTags[tag] + '\\t' + args[4] + '\\n'); }
  else fail('fake git: ' + args.join(' '));
} else if (name === 'claude') {
  if (is('plugin', 'list', '--json')) out(JSON.stringify([{ id: 'other@elsewhere', version: '9.9.9', scope: 'user' }, ...state.claude.records.map(({ lands, ...record }) => ({ id: 'pstack@pstack-vic', ...record }))]));
  else if (is('plugin', 'marketplace', 'update', 'pstack-vic')) { state.claude.fetched = true; save(); }
  else if (is('plugin', 'update', 'pstack@pstack-vic', '--scope', args[4] ?? '')) {
    const dotGit = join(process.cwd(), '.git');
    const project = existsSync(dotGit) && statSync(dotGit).isFile() ? readFileSync(dotGit, 'utf8').trim().replace('gitdir: ', '').split('/.git/worktrees/')[0] : process.cwd();
    const record = state.claude.records.find(r => r.scope === args[4] && (r.scope === 'user' || r.projectPath === project));
    if (!record) fail('plugin-not-installed');
    state.claude.updates.push([args[4], process.cwd()]);
    if (state.claude.fetched) record.version = record.lands ?? state.claude.latest;
    save();
  }
  else fail('fake claude: ' + args.join(' '));
} else if (name === 'codex') {
  if (is('plugin', 'list', '--json')) out(JSON.stringify({ installed: state.codex.version ? [{ pluginId: 'pstack@pstack-vic', version: state.codex.version }] : [], available: [] }));
  else if (is('plugin', 'marketplace', 'list', '--json')) out(JSON.stringify({ marketplaces: state.codex.ref ? [{ name: 'pstack-vic', root: state.codex.root }] : [] }));
  else if (is('plugin', 'remove', 'pstack@pstack-vic')) { if (!state.codex.version) fail('not installed'); changePolicy(false); state.codex.version = null; save(); }
  else if (is('plugin', 'marketplace', 'remove', 'pstack-vic')) { if (!state.codex.ref) fail('no such marketplace'); state.codex.ref = null; rmSync(state.codex.root, { recursive: true, force: true }); save(); }
  else if (args.length === 6 && args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add' && args[3] === 'byvict/pstack-vic' && args[4] === '--ref') { state.codex.ref = args[5]; mkdirSync(state.codex.root, { recursive: true }); save(); }
  else if (is('plugin', 'add', 'pstack@pstack-vic')) { if (!state.codex.ref) fail('no marketplace'); changePolicy(true); state.codex.version = state.codex.lands ?? state.codex.ref.slice(1); save(); if (state.codex.killReleaseAfterAdd) process.kill(process.ppid, 'SIGKILL'); }
  else fail('fake codex: ' + args.join(' '));
} else fail('fake: ' + name);
`;
const original = 'ref = "v0.4.7"\n';
const checks = [['git', 'fetch', 'origin'], ['git', 'rev-parse', 'HEAD'], ['git', 'rev-parse', 'origin/main'], ['git', 'ls-remote', '--exit-code', '--tags', 'origin', 'refs/tags/v0.4.8']];
const claudeUpdate = [['claude', 'plugin', 'marketplace', 'update', 'pstack-vic'], ['claude', 'plugin', 'update', 'pstack@pstack-vic', '--scope', 'user']];
const codexAdds = [['codex', 'plugin', 'marketplace', 'add', 'byvict/pstack-vic', '--ref', 'v0.4.8'], ['codex', 'plugin', 'add', 'pstack@pstack-vic']];
const codexQuartet = [['codex', 'plugin', 'remove', 'pstack@pstack-vic'], ['codex', 'plugin', 'marketplace', 'remove', 'pstack-vic'], ...codexAdds];
const wayBack = (backup: string) => `The Codex swap did not finish. Run this script again to finish it; previous Codex configuration: ${backup}\n`;
/** The merge commit of 0.4.8 checked out at the trunk tip, v0.4.8 on origin, both parents on 0.4.7 with one Claude Code record at user scope. The child's PATH holds only the fakes and a link to this node, and its HOME is a temporary directory, so no real CLI and no real ~/.claude or ~/.codex is in reach. `project(name)` makes a directory a project record can point at. */
function setup(t: { after: (fn: () => void) => void }, change: (state: Record<string, any>, project: (name: string) => string) => void = () => {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pstack-release-'))); t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = (name: string) => { const path = join(root, 'projects', name); mkdirSync(path, { recursive: true }); return path; };
  const bin = join(root, 'bin'); mkdirSync(bin);
  for (const name of ['git', 'claude', 'codex']) { writeFileSync(join(bin, name), fake); chmodSync(join(bin, name), 0o755); }
  symlinkSync(process.execPath, join(bin, 'node'));
  const home = join(root, 'home'); mkdirSync(join(home, '.codex'), { recursive: true }); writeFileSync(join(home, '.codex', 'config.toml'), original);
  const work = join(root, 'work'); mkdirSync(work); writeFileSync(join(work, 'package.json'), JSON.stringify({ version: '0.4.8' }));
  const state: Record<string, any> = { head: commit, tip: commit, remoteTags: { 'v0.4.8': commit }, claude: { records: [{ scope: 'user', version: '0.4.7' }], latest: '0.4.8', updates: [] }, codex: { version: '0.4.7', ref: 'v0.4.7' } };
  change(state, project);
  state.codex.root = join(home, '.codex', '.tmp', 'marketplaces', 'pstack-vic');
  if (state.codex.ref) mkdirSync(state.codex.root, { recursive: true });
  const write = (next: Record<string, any>) => writeFileSync(join(root, 'state.json'), JSON.stringify(next));
  write(state);
  const calls = (): string[][] => existsSync(join(root, 'calls.jsonl')) ? readFileSync(join(root, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const read = () => JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
  return {
    root, config: join(home, '.codex', 'config.toml'), backup: join(home, '.codex', 'config.toml.pre-0.4.8'),
    run: () => spawnSync(process.execPath, [script], { cwd: work, encoding: 'utf8', env: { PATH: bin, HOME: home, FAKE_ROOT: root } }),
    calls, state: read, write,
    git: () => calls().filter(call => call[0] === 'git'),
    parentCalls: () => calls().filter(call => call[0] !== 'git'),
    /** The calls that change a parent. */
    moves: () => calls().filter(call => call[0] !== 'git' && !call.includes('--json')),
  };
}

test('with the checkout at the trunk tip and the tag on origin, a release moves both parents to the version', t => {
  const s = setup(t);
  const result = s.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'v0.4.8 is on origin\nClaude Code on pstack@pstack-vic 0.4.8 (user)\nCodex on pstack@pstack-vic 0.4.8\n');
  assert.deepEqual(s.calls().slice(0, checks.length), checks, 'the checks run before any parent is read');
  assert.deepEqual(s.git(), checks, 'the release never tags or pushes; CI does');
  assert.deepEqual(s.moves(), [...claudeUpdate, ...codexQuartet]);
  assert.equal(readFileSync(s.backup, 'utf8'), original);
  assert.deepEqual([s.state().claude.records[0].version, s.state().codex.version, s.state().codex.ref], ['0.4.8', '0.4.8', 'v0.4.8']);
});
test('run again once both parents are on the version, it changes nothing', t => {
  const s = setup(t, state => { state.claude.records[0].version = '0.4.8'; state.codex = { version: '0.4.8', ref: 'v0.4.8' }; });
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
    assert.deepEqual(s.parentCalls(), []);
  }
});
test('a Claude Code update that lands on another version exits 1 and leaves Codex alone', t => {
  const s = setup(t, state => { state.claude.latest = '0.4.9'; });
  const result = s.run();
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'Claude Code reports pstack@pstack-vic 0.4.9 (user), not 0.4.8\n');
  assert.deepEqual(s.parentCalls().filter(call => call[0] === 'codex'), []);
  assert.equal(existsSync(s.backup), false);
});
test('a Claude Code command that fails exits 1 and leaves Codex alone', t => {
  const s = setup(t, state => { state.failing = ['claude plugin update']; });
  const result = s.run();
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'claude plugin update pstack@pstack-vic --scope user failed: fake claude: unable to access remote\n');
  assert.deepEqual(s.parentCalls().filter(call => call[0] === 'codex'), []);
});
test('every Claude Code record moves with its own scope, a project or local one from its project, and one whose project is gone is skipped and named', t => {
  let clinext = '', vic = '', local = '';
  const s = setup(t, (state, project) => {
    clinext = project('clinext'); vic = project('pstack-vic'); local = project('scratch');
    state.claude.records = [{ scope: 'project', projectPath: clinext, version: '0.4.7' }, { scope: 'user', version: '0.4.7' }, { scope: 'project', projectPath: join(clinext, '..', 'removed-worktree'), version: '0.4.7' }, { scope: 'project', projectPath: vic, version: '0.4.7' }, { scope: 'local', projectPath: local, version: '0.4.7' }];
  });
  const gone = join(s.root, 'projects', 'removed-worktree');
  const result = s.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, ['v0.4.8 is on origin', `Claude Code pstack@pstack-vic (project ${gone}) skipped: the project no longer exists`, `Claude Code on pstack@pstack-vic 0.4.8 (project ${clinext})`, 'Claude Code on pstack@pstack-vic 0.4.8 (user)', `Claude Code on pstack@pstack-vic 0.4.8 (project ${vic})`, `Claude Code on pstack@pstack-vic 0.4.8 (local ${local})`, 'Codex on pstack@pstack-vic 0.4.8', ''].join('\n'));
  assert.deepEqual(s.moves().filter(call => call[0] === 'claude').map(call => call.slice(1).join(' ')), ['plugin marketplace update pstack-vic', 'plugin update pstack@pstack-vic --scope project', 'plugin update pstack@pstack-vic --scope user', 'plugin update pstack@pstack-vic --scope project', 'plugin update pstack@pstack-vic --scope local'], 'one marketplace refresh, then one update per live record');
  assert.deepEqual(s.state().claude.updates.filter(([scope]: string[]) => scope !== 'user'), [['project', clinext], ['project', vic], ['local', local]], 'each project or local update runs from its project');
  assert.deepEqual(s.state().claude.records.map((r: { version: string }) => r.version), ['0.4.8', '0.4.8', '0.4.7', '0.4.8', '0.4.8'], 'the skipped record is left as it was');
});
test('a local record of a linked worktree that is behind is skipped and named, because from there the CLI updates the main checkout, and Codex still moves', t => {
  let vic = '', behind = '', current = '';
  const s = setup(t, (state, project) => {
    vic = project('pstack-vic');
    const linked = (name: string) => { const path = project(name); mkdirSync(join(vic, '.git', 'worktrees', name), { recursive: true }); writeFileSync(join(path, '.git'), `gitdir: ${join(vic, '.git', 'worktrees', name)}\n`); return path; };
    behind = linked('behind'); current = linked('current');
    state.claude.records = [{ scope: 'local', projectPath: vic, version: '0.4.7' }, { scope: 'local', projectPath: behind, version: '0.4.7' }, { scope: 'local', projectPath: current, version: '0.4.8' }];
  });
  const result = s.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, ['v0.4.8 is on origin', `Claude Code pstack@pstack-vic (local ${behind}) skipped: from a linked worktree, \`claude plugin update --scope local\` updates the main checkout's local record, so this one stays on 0.4.7`, `Claude Code on pstack@pstack-vic 0.4.8 (local ${vic})`, `Claude Code on pstack@pstack-vic 0.4.8 (local ${current})`, 'Codex on pstack@pstack-vic 0.4.8', ''].join('\n'));
  assert.deepEqual(s.state().claude.updates, [['local', vic]], 'no update runs from a linked worktree');
  assert.deepEqual(s.state().claude.records.map((r: { version: string }) => r.version), ['0.4.8', '0.4.7', '0.4.8']);
});
test('only the Claude Code records behind the version are updated, and every record is read back', t => {
  let clinext = '';
  const s = setup(t, (state, project) => { clinext = project('clinext'); state.claude.records = [{ scope: 'user', version: '0.4.8' }, { scope: 'project', projectPath: clinext, version: '0.4.7' }]; });
  const result = s.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(s.moves().filter(call => call[0] === 'claude'), [['claude', 'plugin', 'marketplace', 'update', 'pstack-vic'], ['claude', 'plugin', 'update', 'pstack@pstack-vic', '--scope', 'project']]);
  assert.deepEqual(s.state().claude.updates, [['project', clinext]]);
  assert.match(result.stdout, /Claude Code on pstack@pstack-vic 0\.4\.8 \(user\)\n/);
});
test('a project record that lands on another version names that record, exits 1 and leaves Codex alone', t => {
  let vic = '';
  const s = setup(t, (state, project) => { vic = project('pstack-vic'); state.claude.records.push({ scope: 'project', projectPath: vic, version: '0.4.7', lands: '0.4.7' }); });
  const result = s.run();
  assert.equal(result.status, 1);
  assert.equal(result.stderr, `Claude Code reports pstack@pstack-vic 0.4.7 (project ${vic}), not 0.4.8\n`);
  assert.deepEqual(s.parentCalls().filter(call => call[0] === 'codex'), []);
});
test('without a live Claude Code record, the release says the plugin is not installed and leaves Codex alone', t => {
  for (const records of [[], [{ scope: 'project', projectPath: '/nonexistent/pstack-release-project', version: '0.4.7' }]]) {
    const s = setup(t, state => { state.claude.records = records; });
    const result = s.run();
    assert.equal(result.status, 1);
    assert.equal(result.stderr, 'Claude Code reports pstack@pstack-vic not installed\n');
    assert.deepEqual(s.moves(), []);
  }
});
test('a Claude Code record in a scope the release does not update stops it before anything moves', t => {
  const s = setup(t, state => { state.claude.records.push({ scope: 'managed', version: '0.4.7' }); });
  const result = s.run();
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'Claude Code has pstack@pstack-vic in managed, a scope this release does not update\n');
  assert.deepEqual(s.moves(), []);
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
  assert.equal(failed.stderr, `codex plugin marketplace add byvict/pstack-vic --ref v0.4.8 failed: fake codex: unable to access remote\n${wayBack(s.backup)}`);
  assert.deepEqual([s.state().claude.records[0].version, s.state().codex.version, s.state().codex.ref], ['0.4.8', null, null], 'Claude Code moved; Codex is left without the plugin and its marketplace');
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
  assert.equal(result.stderr, `Codex reports pstack@pstack-vic 0.4.9, not 0.4.8\n${wayBack(s.backup)}`);
});
test('without a config.toml there is no backup to go back to, and the failure says only to run again', t => {
  const s = setup(t, state => { state.failing = ['codex plugin add']; });
  rmSync(s.config);
  const result = s.run();
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'codex plugin add pstack@pstack-vic failed: fake codex: unable to access remote\nThe Codex swap did not finish. Run this script again to finish it\n');
  assert.equal(existsSync(s.backup), false);
});

test('a Codex cache update preserves disabled user activation and plugin tool policy', t => {
  const s = setup(t);
  const policy = '[plugins."pstack@pstack-vic"]\nenabled = false\n\n[plugins."pstack@pstack-vic".mcp_servers.example]\nenabled = false\n';
  writeFileSync(s.config, '[features]\nmulti_agent = true\n\n' + policy + '\n[plugins."other@elsewhere"]\nenabled = true\n');
  const result = s.run();
  assert.equal(result.status, 0, result.stderr);
  const after = readFileSync(s.config, 'utf8');
  assert.ok(after.includes(policy));
  assert.ok(after.includes('[features]\nmulti_agent = true'));
  assert.ok(after.includes('[plugins."other@elsewhere"]\nenabled = true'));
  assert.equal(s.state().codex.version, '0.4.8');
});
test('a Codex user installation remains enabled after the cache update', t => {
  const s = setup(t);
  const policy = '[plugins."pstack@pstack-vic"]\nenabled = true\n';
  writeFileSync(s.config, policy);
  assert.equal(s.run().status, 0);
  assert.ok(readFileSync(s.config, 'utf8').includes(policy));
});
test('a project-only Codex installation stays disabled for the user after failure and retry', t => {
  const s = setup(t, state => { state.failing = ['codex plugin add']; });
  const policy = '[plugins."pstack@pstack-vic"]\nenabled = false\n';
  writeFileSync(s.config, policy);
  assert.equal(s.run().status, 1);
  assert.ok(readFileSync(s.config, 'utf8').includes(policy));
  s.write({ ...s.state(), failing: [] });
  assert.equal(s.run().status, 0);
  assert.ok(readFileSync(s.config, 'utf8').includes(policy));
  assert.equal(readFileSync(s.backup, 'utf8'), policy);
});
test('a missing Codex user policy remains absent after installing the shared cache', t => {
  const s = setup(t);
  assert.equal(s.run().status, 0);
  assert.equal(readFileSync(s.config, 'utf8'), original);
});

test('Codex cache commands use a disposable config home and marketplace commands use the user home', t => {
  const s = setup(t);
  assert.equal(s.run().status, 0);
  const contexts = readFileSync(join(s.root, 'contexts.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  for (const c of contexts.filter(c => c.name === 'codex')) {
    if (c.args[1] === 'marketplace') assert.equal(c.configHome, join(s.root, 'home', '.codex'));
    else {
      assert.notEqual(c.configHome, join(s.root, 'home', '.codex'));
      assert.equal(c.cwd, c.configHome);
      assert.equal(existsSync(c.configHome), false, 'temporary installer is removed');
    }
  }
});

test('valid commented, spaced and inline TOML policies survive success and remote failure byte for byte', t => {
  const policies = [
    '[plugins."pstack@pstack-vic"] # keep user activation\nenabled = true\n',
    '  [ plugins . "pstack@pstack-vic" ]\nenabled = false\n',
    'plugins."pstack@pstack-vic" = { enabled = false }\n',
  ];
  for (const policy of policies) {
    for (const failing of [[], ['codex plugin remove'], ['codex plugin marketplace add']]) {
      const s = setup(t, state => { state.failing = failing; });
      writeFileSync(s.config, policy);
      assert.equal(s.run().status, failing.length ? 1 : 0);
      assert.equal(readFileSync(s.config, 'utf8'), policy);
    }
  }
});

test('an abrupt stop after native install cannot enable the user, and retry completes as a no-op', t => {
  const s = setup(t, state => { state.codex.killReleaseAfterAdd = true; });
  const policy = '[plugins."pstack@pstack-vic"] # projects only\nenabled = false\n';
  writeFileSync(s.config, policy);
  const interrupted = s.run();
  assert.equal(interrupted.signal, 'SIGKILL');
  assert.equal(readFileSync(s.config, 'utf8'), policy);
  assert.equal(s.state().codex.version, '0.4.8');
  const before = s.moves().length;
  assert.equal(s.run().status, 0);
  assert.equal(s.moves().length, before);
  assert.equal(readFileSync(s.config, 'utf8'), policy);
  const contexts = readFileSync(join(s.root, 'contexts.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  for (const c of contexts.filter(c => c.name === 'codex' && c.args[1] !== 'marketplace')) rmSync(c.configHome, { recursive: true, force: true });
});
