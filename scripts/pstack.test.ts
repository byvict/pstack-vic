import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GROK_SETTINGS, grokRestore, grokSet, withoutPluginSettings } from './pstack.ts';
import { joinLines, locate, removeTables, splitLines } from './toml-lines.ts';

const script = fileURLToPath(new URL('./pstack.ts', import.meta.url));
const version = (JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version: string }).version;

/** One fake for claude, codex, grok and git, dispatched on its own file name. Each keeps its state in FAKE_ROOT/state.json and writes the files the real CLI writes, with the leftovers measured on Claude Code 2.1.296 and Codex 0.162.1: Claude Code leaves the plugin's version folder in its cache and empty `enabledPlugins` and `extraKnownMarketplaces` objects in settings.json, and deletes the data folder with the last record; a project uninstall reorders the folder's .claude/settings.json, or creates it; Codex leaves an empty `plugins/cache/pstack-vic` folder and deletes no plugin data. */
const fake = `#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
const root = process.env.FAKE_ROOT;
const home = process.env.HOME;
const file = join(root, 'state.json');
const state = JSON.parse(readFileSync(file, 'utf8'));
const name = basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(join(root, 'calls.jsonl'), JSON.stringify([name, ...args, '@' + process.cwd()]) + '\\n');
const out = text => process.stdout.write(text);
const save = () => writeFileSync(file, JSON.stringify(state));
const is = (...words) => args.length === words.length && words.every((word, i) => word === '*' || args[i] === word);
const fail = text => { process.stderr.write(text + '\\n'); process.exit(1); };
const nl = String.fromCharCode(10);
const json = path => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
const writeJson = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2) + nl); };
const claudeSettings = join(home, '.claude', 'settings.json');
const codexConfig = join(home, '.codex', 'config.toml');
const toml = () => existsSync(codexConfig) ? readFileSync(codexConfig, 'utf8') : '';
const dropTable = (text, header) => { let skip = false; return text.split(nl).filter(line => { if (line.startsWith('[')) skip = line === header; return !skip; }).join(nl); };
if (args[0] === '--version') { out(name + ' 1.0' + nl); process.exit(0); }
if ((state.failing ?? []).some(prefix => [name, ...args].join(' ').startsWith(prefix))) fail('fake ' + name + ': failed');
if (name === 'git') {
  if (is('ls-remote', '--exit-code', '--tags', 'https://github.com/byvict/pstack-vic.git', '*')) { if (!state.tags.includes(args[4].slice('refs/tags/'.length))) process.exit(2); out('c'.repeat(40) + '\\t' + args[4] + nl); }
  else if (is('-C', '*', 'ls-files', '--error-unmatch', '*')) process.exit((state.tracked ?? []).includes(join(args[1], args[4])) ? 0 : 1);
  else if (is('init', '--quiet', '*')) mkdirSync(join(args[2], '.git'), { recursive: true });
  else fail('fake git: ' + args.join(' '));
} else if (name === 'claude') {
  const records = state.claude.records;
  if (is('plugin', 'list', '--json')) out(JSON.stringify([{ id: 'other@elsewhere', version: '1', scope: 'user', enabled: true }, ...records.map(r => ({ id: 'pstack@pstack-vic', ...r }))]));
  else if (is('plugin', 'marketplace', 'list', '--json')) out(JSON.stringify(state.claude.marketplaces.map(name => ({ name }))));
  else if (is('plugin', 'marketplace', 'add', 'byvict/pstack-vic')) {
    state.claude.marketplaces.push('pstack-vic');
    const settings = json(claudeSettings); settings.extraKnownMarketplaces = { ...settings.extraKnownMarketplaces, 'pstack-vic': { source: { source: 'github', repo: 'byvict/pstack-vic' } } }; writeJson(claudeSettings, settings);
    mkdirSync(join(home, '.claude', 'plugins', 'marketplaces', 'pstack-vic'), { recursive: true }); writeFileSync(join(home, '.claude', 'plugins', 'marketplaces', 'pstack-vic', 'README.md'), 'clone' + nl);
    save();
  }
  else if (is('plugin', 'install', 'pstack@pstack-vic', '--scope', 'user')) {
    if (!state.claude.marketplaces.includes('pstack-vic')) fail('marketplace not found');
    records.push({ scope: 'user', version: state.latest, enabled: true });
    const settings = json(claudeSettings); settings.enabledPlugins = { ...settings.enabledPlugins, 'pstack@pstack-vic': true }; writeJson(claudeSettings, settings);
    const cache = join(home, '.claude', 'plugins', 'cache', 'pstack-vic', 'pstack', state.latest); mkdirSync(cache, { recursive: true }); writeFileSync(join(cache, 'plugin.json'), '{}' + nl);
    save();
  }
  else if (is('plugin', 'marketplace', 'update', 'pstack-vic')) { state.claude.refreshed = true; save(); }
  else if (is('plugin', 'update', 'pstack@pstack-vic', '--scope', 'user')) { records.find(r => r.scope === 'user').version = state.latest; save(); }
  else if (is('plugin', 'enable', 'pstack@pstack-vic', '--scope', 'user')) {
    records.find(r => r.scope === 'user').enabled = true;
    const settings = json(claudeSettings); settings.enabledPlugins['pstack@pstack-vic'] = true; writeJson(claudeSettings, settings);
    save();
  }
  else if (args[0] === 'plugin' && args[1] === 'uninstall' && args[2] === 'pstack@pstack-vic' && args[3] === '--scope') {
    const scope = args[4];
    const index = records.findIndex(r => r.scope === scope && (scope === 'user' || r.projectPath === process.cwd()));
    if (index < 0) fail('plugin-not-installed');
    records.splice(index, 1);
    if (scope === 'user') { const settings = json(claudeSettings); delete settings.enabledPlugins['pstack@pstack-vic']; writeJson(claudeSettings, settings); }
    if (scope === 'project') {
      const path = join(process.cwd(), '.claude', 'settings.json');
      const settings = json(path); if (settings.enabledPlugins) delete settings.enabledPlugins['pstack@pstack-vic'];
      writeJson(path, Object.fromEntries(Object.entries(settings).sort(([a], [b]) => b.localeCompare(a))));
    }
    if (scope === 'local') {
      let repository = process.cwd();
      while (!existsSync(join(repository, '.git')) && dirname(repository) !== repository) repository = dirname(repository);
      const path = join(repository, '.claude', 'settings.local.json');
      if (existsSync(path)) { const settings = json(path); if (settings.enabledPlugins) delete settings.enabledPlugins['pstack@pstack-vic']; writeJson(path, settings); }
    }
    if (records.length === 0 && !args.includes('--keep-data')) rmSync(join(home, '.claude', 'plugins', 'data', 'pstack-pstack-vic'), { recursive: true, force: true });
    save();
  }
  else if (is('plugin', 'marketplace', 'remove', 'pstack-vic')) {
    state.claude.marketplaces = state.claude.marketplaces.filter(m => m !== 'pstack-vic');
    const settings = json(claudeSettings); delete settings.extraKnownMarketplaces['pstack-vic']; writeJson(claudeSettings, settings);
    rmSync(join(home, '.claude', 'plugins', 'marketplaces', 'pstack-vic'), { recursive: true, force: true });
    save();
  }
  else fail('fake claude: ' + args.join(' '));
} else if (name === 'codex') {
  const activated = toml().split(nl).includes('[plugins."pstack@pstack-vic"]');
  if (is('plugin', 'marketplace', 'list', '--json')) out(JSON.stringify({ marketplaces: toml().split(nl).includes('[marketplaces.pstack-vic]') ? [{ name: 'pstack-vic', root: join(home, '.codex', '.tmp', 'marketplaces', 'pstack-vic') }] : [] }));
  else if (is('plugin', 'list', '--json')) out(JSON.stringify({ installed: activated ? [{ pluginId: 'pstack@pstack-vic', version: state.codexVersion ?? state.latest }] : [], available: [] }));
  else if (is('plugin', 'marketplace', 'add', 'byvict/pstack-vic', '--ref', '*')) {
    mkdirSync(dirname(codexConfig), { recursive: true });
    writeFileSync(codexConfig, toml() + nl + '[marketplaces.pstack-vic]' + nl + 'source_type = "git"' + nl + 'source = "https://github.com/byvict/pstack-vic.git"' + nl + 'ref = "' + args[5] + '"' + nl);
    const clone = join(home, '.codex', '.tmp', 'marketplaces', 'pstack-vic'); mkdirSync(clone, { recursive: true }); writeFileSync(join(clone, 'README.md'), 'clone' + nl);
  }
  else if (is('plugin', 'add', 'pstack@pstack-vic')) {
    state.codexVersion = state.latest; save();
    writeFileSync(codexConfig, toml() + nl + '[plugins."pstack@pstack-vic"]' + nl + 'enabled = true' + nl);
    const cache = join(home, '.codex', 'plugins', 'cache', 'pstack-vic', 'pstack', state.latest); mkdirSync(cache, { recursive: true }); writeFileSync(join(cache, 'plugin.json'), '{}' + nl);
  }
  else if (is('plugin', 'remove', 'pstack@pstack-vic')) {
    if (!activated) fail('not installed');
    writeFileSync(codexConfig, dropTable(toml(), '[plugins."pstack@pstack-vic"]'));
    rmSync(join(home, '.codex', 'plugins', 'cache', 'pstack-vic', 'pstack'), { recursive: true, force: true });
  }
  else if (is('plugin', 'marketplace', 'remove', 'pstack-vic')) {
    writeFileSync(codexConfig, dropTable(toml(), '[marketplaces.pstack-vic]'));
    rmSync(join(home, '.codex', '.tmp', 'marketplaces', 'pstack-vic'), { recursive: true, force: true });
  }
  else fail('fake codex: ' + args.join(' '));
} else fail('fake: ' + name);
`;

/** The operator's own files before any install: other plugins in Claude Code, their own Codex and Grok settings, and the standing authorization, which is theirs. */
const userSettings = `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] }, enabledPlugins: { 'other@elsewhere': true }, autoMode: { allow: ['$defaults', 'pstack standing authorization v3: mine'] } }, null, 2)}\n`;
const codexOwn = 'model = "gpt-5"\n\n[features]\nmulti_agent = true\n\n[plugins."other@elsewhere"]\nenabled = true\n';
const grokOwn = '[ui]\nyolo = false\n\n[skills]\ndisabled = [\n    "orca-cli",\n]\npaths = []\n';

function setup(t: { after: (fn: () => void) => void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pstack-cli-'))); t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'); mkdirSync(bin);
  for (const name of ['git', 'claude', 'codex', 'grok']) { writeFileSync(join(bin, name), fake); chmodSync(join(bin, name), 0o755); }
  symlinkSync(process.execPath, join(bin, 'node'));
  const home = join(root, 'home');
  const put = (path: string, text: string) => { mkdirSync(dirname(join(home, path)), { recursive: true }); writeFileSync(join(home, path), text); };
  put('.claude/settings.json', userSettings);
  put('.claude/plugins/cache/elsewhere/other/1/plugin.json', '{}\n');
  mkdirSync(join(home, '.claude', 'plugins', 'data'), { recursive: true });
  put('.codex/config.toml', codexOwn);
  put('.codex/plugins/cache/openai-bundled/browser/1/plugin.json', '{}\n');
  put('.codex/.tmp/plugins/other.json', '{}\n');
  put('.claude/plugins/marketplaces/claude-plugins-official/README.md', 'clone\n');
  put('.grok/config.toml', grokOwn);
  put('.grok/marketplace-cache/aaaa/.git/config', '[remote "origin"]\n\turl = https://github.com/xai-org/plugin-marketplace.git\n');
  const state = { latest: version, tags: [`v${version}`], tracked: [] as string[], claude: { records: [] as Record<string, unknown>[], marketplaces: ['claude-plugins-official'] } };
  const write = (next: object) => writeFileSync(join(root, 'state.json'), JSON.stringify(next));
  write(state);
  const read = () => JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
  return {
    root, home, put, write, state: read,
    run: (...args: string[]) => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', env: { PATH: bin, HOME: home, FAKE_ROOT: root } }),
    calls: (): string[][] => existsSync(join(root, 'calls.jsonl')) ? readFileSync(join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [],
    /** Every file and folder under the home, with each file's bytes. */
    tree: () => {
      const entries: Record<string, string> = {};
      const walk = (dir: string) => { for (const name of readdirSync(dir)) { const path = join(dir, name); const rel = relative(home, path); if (statSync(path).isDirectory()) { entries[rel + '/'] = ''; walk(path); } else entries[rel] = readFileSync(path, 'utf8'); } };
      walk(home);
      return entries;
    },
  };
}

test('install puts the plugin in Claude Code at user scope and in Codex, and the Grok Build settings it needs', t => {
  const s = setup(t);
  const result = s.run('install');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, [
    `Claude Code: pstack@pstack-vic ${version} installed and enabled (user)`,
    `Codex: pstack@pstack-vic ${version} installed and enabled`,
    'Grok Build: [subagents] max_depth = 2 (was unset)',
    'Grok Build: [toolset.bash] timeout_secs = 3600 (was unset)',
    'Grok Build: [toolset.bash] max_timeout_secs = 3600 (was unset)',
    'Grok Build: runs the plugin Claude Code installed',
    'Choose models per role with /setup-pstack in each parent (optional: without it every role uses its default)',
    '',
  ].join('\n'));
  assert.deepEqual(s.state().claude.records, [{ scope: 'user', version, enabled: true }]);
  assert.equal(readFileSync(join(s.home, '.grok', 'config.toml'), 'utf8'), `${grokOwn}\n[subagents] # pstack-vic: added\nmax_depth = 2 # pstack-vic: was unset\n\n[toolset.bash] # pstack-vic: added\ntimeout_secs = 3600 # pstack-vic: was unset\nmax_timeout_secs = 3600 # pstack-vic: was unset\n`, 'each line install writes carries what it replaced');
  assert.match(readFileSync(join(s.home, '.codex', 'config.toml'), 'utf8'), /\[plugins\."pstack@pstack-vic"\]\nenabled = true\n/);
  assert.ok(s.calls().some(call => call.slice(0, 7).join(' ') === `codex plugin marketplace add byvict/pstack-vic --ref v${version}`), 'Codex pins the marketplace to the tag of this version');
  assert.deepEqual(s.calls().filter(call => call[0] !== 'git' && !call.includes('--json') && call[1] !== '--version').every(call => call.at(-1) === `@${s.home}`), true, 'every host command runs from the home folder, outside any project');
  const second = s.run('install');
  assert.equal(second.status, 0, second.stderr);
  assert.doesNotMatch(second.stdout, /Grok Build: \[/, 'a second install changes nothing');
});

test('uninstall after install, setup and use leaves the home byte for byte as it was before install', t => {
  const s = setup(t);
  const before = s.tree();
  assert.equal(s.run('install').status, 0);
  // What using the plugin adds: /setup-pstack's sheets and ledgers in each data folder, a Codex hook trust record, Claude Code's empty data folder of an inline run.
  for (const parent of ['.claude/plugins/data/pstack-pstack-vic', '.claude/plugins/data/pstack-pstack-vic/grok', '.codex/plugins/data/pstack-pstack-vic']) {
    s.put(`${parent}/pstack-models.md`, '# sheet\n');
    s.put(`${parent}/pstack-probes.json`, '{"schemaVersion":1,"families":{}}\n');
  }
  writeFileSync(join(s.home, '.codex', 'config.toml'), `${readFileSync(join(s.home, '.codex', 'config.toml'), 'utf8')}\n[hooks.state."pstack@pstack-vic:hooks/hooks.json:pre_tool_use:0:0"]\ntrusted_hash = "sha256:00"\n`);
  s.put('.grok/marketplace-cache/bbbb/.git/config', '[remote "origin"]\n\turl = https://github.com/byvict/pstack-vic.git\n');
  s.put('.grok/marketplace-cache/bbbb.lock', '');
  const result = s.run('uninstall');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /\nNothing of pstack@pstack-vic is left on this machine\n$/);
  assert.deepEqual(s.tree(), before);
  assert.equal(s.run('check').status, 0);
});

test('a Grok setting the operator changed after install is left as they set it', t => {
  const s = setup(t);
  assert.equal(s.run('install').status, 0);
  const config = join(s.home, '.grok', 'config.toml');
  writeFileSync(config, readFileSync(config, 'utf8').replace('max_depth = 2', 'max_depth = 4'));
  const result = s.run('uninstall');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Grok Build: \[subagents\] max_depth = 4 left as you set it\n/);
  assert.equal(readFileSync(config, 'utf8'), `${grokOwn}\n[subagents]\nmax_depth = 4\n`);
});

test('install leaves a Grok setting that already allows what the plugin needs alone, and uninstall leaves it too', t => {
  const s = setup(t);
  const own = `${grokOwn}\n[subagents]\nmax_depth = 3\n`;
  writeFileSync(join(s.home, '.grok', 'config.toml'), own);
  assert.equal(s.run('install').status, 0);
  assert.equal(s.run('uninstall').status, 0);
  assert.equal(readFileSync(join(s.home, '.grok', 'config.toml'), 'utf8'), own);
});

test('uninstall clears a machine an older version set up per project, and names the versioned lines left for each repository', t => {
  const s = setup(t);
  const dev = join(s.root, 'dev');
  const clinext = join(dev, 'clinext'); const vic = join(dev, 'pstack-vic'); const lab = join(dev, 'pstack-lab');
  const worktree = join(vic, '.claude', 'worktrees', 'old'); const goneTree = join(vic, '.claude', 'worktrees', 'gone');
  for (const folder of [clinext, vic, lab]) mkdirSync(join(folder, '.git'), { recursive: true });
  mkdirSync(worktree, { recursive: true }); mkdirSync(join(vic, '.git', 'worktrees', 'old'), { recursive: true });
  writeFileSync(join(worktree, '.git'), `gitdir: ${join(vic, '.git', 'worktrees', 'old')}\n`);
  const versioned = `${JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' }, enabledPlugins: { 'pstack@pstack-vic': true } }, null, 2)}\n`;
  writeFileSync(join(s.root, 'clinext-settings.json'), versioned);
  mkdirSync(join(clinext, '.claude'), { recursive: true }); writeFileSync(join(clinext, '.claude', 'settings.json'), versioned);
  writeFileSync(join(clinext, '.claude', 'settings.local.json'), `${JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, enabledPlugins: { 'pstack@pstack-vic': false } }, null, 2)}\n`);
  mkdirSync(join(clinext, '.codex'), { recursive: true }); writeFileSync(join(clinext, '.codex', 'config.toml'), 'approval_policy = "never"\n\n[plugins."pstack@pstack-vic"]\nenabled = true\n');
  const vicSettings = '{\n  "permissions": {}\n}\n';
  mkdirSync(join(vic, '.claude'), { recursive: true }); writeFileSync(join(vic, '.claude', 'settings.json'), vicSettings);
  writeFileSync(join(vic, '.claude', 'settings.local.json'), `${JSON.stringify({ enabledPlugins: { 'pstack@pstack-vic': false } }, null, 2)}\n`);
  mkdirSync(join(lab, '.claude'), { recursive: true }); writeFileSync(join(lab, '.claude', 'settings.local.json'), `${JSON.stringify({ enabledPlugins: { 'pstack@pstack-vic': false } }, null, 2)}\n`);
  s.put('.claude.json', JSON.stringify({ projects: { [clinext]: {}, [vic]: {}, [lab]: {}, [worktree]: {}, [join(dev, 'gone')]: {} } }));
  const state = s.state();
  state.tracked = [join(clinext, '.claude', 'settings.json'), join(clinext, '.codex', 'config.toml'), join(vic, '.claude', 'settings.json')];
  state.claude.marketplaces.push('pstack-vic');
  state.claude.records = [
    { scope: 'project', projectPath: clinext, version: '0.5.32', enabled: false },
    { scope: 'project', projectPath: vic, version: '0.5.32', enabled: false },
    { scope: 'local', projectPath: vic, version: '0.5.32', enabled: false },
    { scope: 'local', projectPath: lab, version: '0.5.32', enabled: false },
    { scope: 'local', projectPath: worktree, version: '0.5.30', enabled: false },
    { scope: 'local', projectPath: goneTree, version: '0.5.26', enabled: false },
  ];
  s.write(state);
  // What versions before 0.6.0 left in each config home, and what the hosts and the release kept.
  for (const home of ['.claude', '.codex', '.grok']) { s.put(`${home}/pstack-models.md`, '# sheet\n'); s.put(`${home}/pstack-probes.json`, '{}\n'); }
  s.put('.claude/pstack-probes.json.pre-5.4', '{}\n');
  s.put('.claude/CLAUDE.md', '');
  s.put('.codex/AGENTS.md', '# mine\n\n<!-- pstack:models:begin -->\nold block\n<!-- pstack:models:end -->\n');
  s.put('.grok/AGENTS.md', '');
  s.put('.codex/config.toml.pre-0.5.31', 'old\n');
  s.put('.grok/config.toml.pre-pstack-grok-root-2026-10-05T18-32-19-512Z', grokOwn);
  s.put('.claude/plugins/cache/pstack-vic/pstack/0.5.26/plugin.json', '{}\n');
  s.put('.claude/plugins/data/pstack-inline/x', '');
  s.put('Library/Caches/pstack-vic/update-clis/run/log', 'x\n');
  writeFileSync(join(s.home, '.grok', 'config.toml'), `${grokOwn}\n[subagents]\nmax_depth = 2\n\n[toolset.bash]\ntimeout_secs = 3600\nmax_timeout_secs = 3600\n`);
  writeFileSync(join(s.home, '.claude', 'settings.json'), `${JSON.stringify({ ...JSON.parse(userSettings), extraKnownMarketplaces: { 'pstack-vic': { source: { source: 'github', repo: 'byvict/pstack-vic' } } } }, null, 2)}\n`);
  writeFileSync(join(s.home, '.codex', 'config.toml'), `${codexOwn}\n[marketplaces.pstack-vic]\nsource_type = "git"\nsource = "https://github.com/byvict/pstack-vic.git"\nref = "v0.5.32"\n`);

  const result = s.run('uninstall');
  assert.equal(result.status, 1, 'the versioned lines are left for their repositories');
  assert.equal(s.state().claude.records.length, 0);
  assert.deepEqual(s.calls().filter(call => call[0] === 'claude' && call[2] === 'uninstall').map(call => [call[5], call.at(-1)]), [
    ['project', `@${clinext}`], ['project', `@${vic}`], ['local', `@${vic}`], ['local', `@${lab}`], ['local', `@${worktree}`], ['local', `@${goneTree}`],
  ], 'each record from its own folder; the gone one from a fresh repository at its path');
  assert.equal(existsSync(goneTree), false, 'the folder made for the gone record is deleted');
  assert.equal(readFileSync(join(vic, '.claude', 'settings.json'), 'utf8'), vicSettings, 'a versioned file that never named the plugin is put back byte for byte');
  assert.deepEqual(JSON.parse(readFileSync(join(clinext, '.claude', 'settings.local.json'), 'utf8')), { permissions: { allow: ['Bash(ls)'] } });
  assert.deepEqual(JSON.parse(readFileSync(join(lab, '.claude', 'settings.local.json'), 'utf8')), {});
  assert.equal(readFileSync(join(s.home, '.grok', 'config.toml'), 'utf8'), grokOwn, 'without an install record, the values the plugin sets are the plugin\'s');
  assert.equal(readFileSync(join(s.home, '.codex', 'AGENTS.md'), 'utf8'), '# mine\n\n');
  assert.equal(existsSync(join(s.home, '.claude', 'plugins', 'data', 'pstack-inline', 'x')), true, 'an inline run\'s data folder may belong to any plugin named pstack, so it stays');
  assert.equal(readFileSync(join(s.home, '.claude', 'settings.json'), 'utf8'), userSettings, 'the standing authorization and the other plugins stay');
  assert.equal(readFileSync(join(s.home, '.codex', 'config.toml'), 'utf8'), codexOwn);
  for (const gone of ['.claude/pstack-models.md', '.codex/pstack-probes.json', '.grok/pstack-models.md', '.claude/pstack-probes.json.pre-5.4', '.claude/CLAUDE.md', '.grok/AGENTS.md', '.codex/config.toml.pre-0.5.31', '.grok/config.toml.pre-pstack-grok-root-2026-10-05T18-32-19-512Z', '.claude/plugins/cache/pstack-vic', '.claude/plugins/marketplaces/pstack-vic', 'Library/Caches/pstack-vic']) {
    assert.equal(existsSync(join(s.home, gone)), false, gone);
  }
  assert.match(result.stdout, new RegExp(`${join(clinext, '.claude', 'settings.json').replace(/[.]/g, '\\.')}: the line that turned pstack@pstack-vic on is gone; commit that change in its repository\n`), 'Claude Code removed the versioned line from the working tree only');
  assert.equal(result.stdout.split('\n').filter(line => line.startsWith('- ')).join('\n'),
    `- ${join(clinext, '.codex', 'config.toml')}: turns pstack@pstack-vic on or off (versioned: remove it in that repository)`,
    'no host command removes a versioned Codex activation, so check names it');
  writeFileSync(join(clinext, '.claude', 'settings.json'), '{\n  "permissions": {}\n}\n');
  writeFileSync(join(clinext, '.codex', 'config.toml'), 'approval_policy = "never"\n');
  const after = s.run('check');
  assert.equal(after.status, 0, after.stdout);
  assert.equal(after.stdout, 'Nothing of pstack@pstack-vic is left on this machine\n');
});

test('install refuses while Claude Code still has the plugin per project, before touching anything', t => {
  const s = setup(t);
  const state = s.state();
  state.claude.records = [{ scope: 'project', projectPath: join(s.root, 'clinext'), version: '0.5.32', enabled: false }];
  s.write(state);
  const before = s.tree();
  const result = s.run('install');
  assert.equal(result.status, 1);
  assert.equal(result.stderr, `Claude Code has pstack@pstack-vic installed per project (project ${join(s.root, 'clinext')}); run \`node scripts/pstack.ts uninstall\` first, then install\n`);
  assert.deepEqual(s.tree(), before);
});

test('install refuses a version that is not tagged, before touching anything', t => {
  const s = setup(t);
  s.write({ ...s.state(), tags: [] });
  const before = s.tree();
  const result = s.run('install');
  assert.equal(result.status, 1);
  assert.equal(result.stderr, `v${version} is not tagged on byvict/pstack-vic; run install from a released checkout\n`);
  assert.deepEqual(s.tree(), before);
});

test('check on a machine that never had the plugin finds nothing', t => {
  const s = setup(t);
  const result = s.run('check');
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.stdout, 'Nothing of pstack@pstack-vic is left on this machine\n');
});

test('an unknown command prints the usage and exits 64', t => {
  const s = setup(t);
  const result = s.run('remove');
  assert.equal(result.status, 64);
  assert.equal(result.stderr, 'Usage: node scripts/pstack.ts <install|uninstall|check>\n');
});

test('the Grok edits put a file back byte for byte, comments and line endings included, and leave a value the operator changed', () => {
  const own = '# top\r\n[ui]\r\nyolo = false # keep\r\n\r\n[toolset.bash]\r\ntimeout_secs = 600 # mine\r\nallow = [\r\n  ["a", "b"],\r\n]\r\n\r\n[[marketplace.sources]]\r\nname = "x"\r\n';
  const split = splitLines(own);
  const outcomes = GROK_SETTINGS.map(setting => grokSet(split, setting).kind);
  assert.deepEqual(outcomes, ['set', 'set', 'set']);
  const installed = joinLines(split);
  assert.equal(installed, '# top\r\n[ui]\r\nyolo = false # keep\r\n\r\n[toolset.bash]\r\ntimeout_secs = 3600 # pstack-vic: was "timeout_secs = 600 # mine"\r\nallow = [\r\n  ["a", "b"],\r\n]\r\nmax_timeout_secs = 3600 # pstack-vic: was unset\r\n\r\n[[marketplace.sources]]\r\nname = "x"\r\n\r\n[subagents] # pstack-vic: added\r\nmax_depth = 2 # pstack-vic: was unset\r\n', 'a line inside a multi-line array is never read as a table');
  const back = splitLines(installed);
  grokRestore(back);
  assert.equal(joinLines(back), own);
  const changed = splitLines(installed.replace('max_depth = 2', 'max_depth = 5'));
  assert.deepEqual(grokRestore(changed), ['Grok Build: [toolset.bash] timeout_secs put back as it was', 'Grok Build: [toolset.bash] max_timeout_secs removed', 'Grok Build: [subagents] max_depth = 5 left as you set it']);
  assert.match(joinLines(changed), /\r\n\r\n\[subagents\]\r\nmax_depth = 5\r\n$/);
});

test('a Grok setting written as a dotted key, an inline table or twice is left alone', () => {
  for (const text of ['subagents.max_depth = 1\n', '[toolset]\nbash = { timeout_secs = 10 }\n', 'toolset = { bash = { timeout_secs = 10 } }\n', '[subagents]\nmax_depth = 1\n\n[subagents]\nx = 1\n']) {
    const split = splitLines(text);
    const outcomes = GROK_SETTINGS.map(setting => grokSet(split, setting));
    assert.ok(outcomes.some(outcome => outcome.kind === 'unsupported'), text);
    for (const [i, outcome] of outcomes.entries()) if (outcome.kind === 'unsupported') assert.equal(locate(splitLines(text).lines, GROK_SETTINGS[i].table, GROK_SETTINGS[i].key).kind, 'unsupported');
  }
  const quoted = splitLines('[subagents]\n"max_depth" = 1\n');
  assert.deepEqual(grokSet(quoted, GROK_SETTINGS[0]), { kind: 'set', before: '1' });
  assert.equal(joinLines(quoted), '[subagents]\nmax_depth = 2 # pstack-vic: was "\\"max_depth\\" = 1"\n');
});

test('removing a Codex table keeps a following table whose quoted header holds brackets, and the comment that leads it', () => {
  const codex = 'a = 1\n\n[hooks.state."pstack@pstack-vic:hooks/hooks.json:pre_tool_use:0:0"]\ntrusted_hash = "x"\n\n# my projects\n[projects."/Users/v/Dev/[x]"]\ntrust_level = "trusted"\n';
  assert.equal(removeTables(codex, path => path.startsWith('hooks.state."pstack@pstack-vic:')), 'a = 1\n\n# my projects\n[projects."/Users/v/Dev/[x]"]\ntrust_level = "trusted"\n');
});

test('the settings edit drops only the plugin, its marketplace and the empty objects the hosts leave', () => {
  const settings = { enabledPlugins: { 'pstack@pstack-vic': false, 'other@elsewhere': true }, extraKnownMarketplaces: { 'pstack-vic': {} }, theme: 'dark' };
  assert.deepEqual(JSON.parse(withoutPluginSettings(JSON.stringify(settings))), { enabledPlugins: { 'other@elsewhere': true }, theme: 'dark' });
  const untouched = '{"theme":"dark"}';
  assert.equal(withoutPluginSettings(untouched), untouched);
});

test('on a machine that never had the plugin, uninstall leaves the operator\'s own Grok values and empty instruction files alone', t => {
  const s = setup(t);
  const own = `${grokOwn}\n[subagents]\nmax_depth = 2\n`;
  writeFileSync(join(s.home, '.grok', 'config.toml'), own);
  s.put('.grok/AGENTS.md', '');
  s.put('.claude/CLAUDE.md', 'Old setups kept a file called /pstack-models.md next to this one.\n');
  const before = s.tree();
  const result = s.run('uninstall');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout, 'Nothing of pstack@pstack-vic is left on this machine\n', 'prose that names the sheet is not the old wiring');
  assert.deepEqual(s.tree(), before);
});

test('a value install replaced comes back even after the host deleted the plugin\'s data folder', t => {
  const s = setup(t);
  writeFileSync(join(s.home, '.grok', 'config.toml'), `${grokOwn}\n[toolset.bash]\ntimeout_secs = 600 # mine\n`);
  const before = s.tree();
  assert.equal(s.run('install').status, 0);
  rmSync(join(s.home, '.claude', 'plugins', 'data', 'pstack-pstack-vic'), { recursive: true, force: true });
  const result = s.run('uninstall');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Grok Build: \[toolset\.bash\] timeout_secs put back as it was\n/);
  assert.deepEqual(s.tree(), before);
});

test('uninstall refuses, changing nothing, while a host still has the plugin and its CLI is not on PATH', t => {
  const s = setup(t);
  assert.equal(s.run('install').status, 0);
  s.put('.claude/plugins/installed_plugins.json', JSON.stringify({ version: 2, plugins: { 'pstack@pstack-vic': [{ scope: 'user', version }] } }));
  rmSync(join(s.root, 'bin', 'claude'));
  const before = s.tree();
  const result = s.run('uninstall');
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'Claude Code still has pstack@pstack-vic or its marketplace, and claude is not on PATH; put the claude CLI on PATH and run uninstall again\n');
  assert.deepEqual(s.tree(), before);
  const check = s.run('check');
  assert.equal(check.status, 1);
  assert.match(check.stdout, /Claude Code install record \(user\)/, 'check reads the records from Claude Code\'s own file without the CLI');
});

test('uninstall refuses, changing nothing, when a gone record sits under a folder it cannot write', t => {
  const s = setup(t);
  const locked = join(s.root, 'locked'); mkdirSync(locked);
  const state = s.state();
  state.claude.records = [{ scope: 'local', projectPath: join(locked, 'gone', 'worktree'), version: '0.5.30', enabled: false }];
  s.write(state);
  writeFileSync(join(s.home, '.grok', 'config.toml'), `${grokOwn}\n[subagents]\nmax_depth = 2\n`);
  chmodSync(locked, 0o555);
  try {
    const before = s.tree();
    const result = s.run('uninstall');
    assert.equal(result.status, 1);
    assert.equal(result.stderr, `Claude Code has pstack@pstack-vic (local ${join(locked, 'gone', 'worktree')}), whose folder is gone, and ${locked} is not writable, so the record cannot be removed from a fresh repository there; mount or unlock it and run uninstall again\n`);
    assert.deepEqual(s.tree(), before);
  } finally {
    chmodSync(locked, 0o755);
  }
});

test('install moves a stale Codex marketplace and plugin, and a stale Claude Code record, to this version', t => {
  const s = setup(t);
  const state = s.state();
  state.claude.marketplaces.push('pstack-vic');
  state.claude.records = [{ scope: 'user', version: '0.5.30', enabled: false }];
  state.codexVersion = '0.5.30';
  s.write(state);
  writeFileSync(join(s.home, '.codex', 'config.toml'), `${codexOwn}\n[marketplaces.pstack-vic]\nsource_type = "git"\nsource = "https://github.com/byvict/pstack-vic.git"\nref = "v0.5.30"\n\n[plugins."pstack@pstack-vic"]\nenabled = false\n`);
  const result = s.run('install');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const moves = s.calls().filter(call => call[0] !== 'git' && !call.includes('--json') && call[1] !== '--version').map(call => call.slice(0, -1).join(' '));
  assert.deepEqual(moves, [
    'claude plugin marketplace update pstack-vic', 'claude plugin update pstack@pstack-vic --scope user', 'claude plugin enable pstack@pstack-vic --scope user',
    'codex plugin remove pstack@pstack-vic', 'codex plugin marketplace remove pstack-vic', `codex plugin marketplace add byvict/pstack-vic --ref v${version}`, 'codex plugin add pstack@pstack-vic',
  ]);
  assert.match(result.stdout, new RegExp(`Claude Code: pstack@pstack-vic ${version.replace(/[.]/g, '\\.')} installed and enabled \\(user\\)\\nCodex: pstack@pstack-vic ${version.replace(/[.]/g, '\\.')} installed and enabled\\n`));
});

test('uninstall clears untracked project files, including a linked worktree\'s local settings, and names the versioned ones', t => {
  const s = setup(t);
  const project = join(s.root, 'dev', 'app'); mkdirSync(join(project, '.git'), { recursive: true });
  const worktree = join(project, '.claude', 'worktrees', 'w'); mkdirSync(worktree, { recursive: true }); mkdirSync(join(project, '.git', 'worktrees', 'w'), { recursive: true });
  writeFileSync(join(worktree, '.git'), `gitdir: ${join(project, '.git', 'worktrees', 'w')}\n`);
  mkdirSync(join(worktree, '.claude'), { recursive: true });
  writeFileSync(join(worktree, '.claude', 'settings.local.json'), `${JSON.stringify({ permissions: { allow: [] }, enabledPlugins: { 'pstack@pstack-vic': true } }, null, 2)}\n`);
  mkdirSync(join(project, '.codex'), { recursive: true });
  writeFileSync(join(project, '.codex', 'config.toml'), 'approval_policy = "never"\n\n[plugins."pstack@pstack-vic"]\nenabled = true\n\n[plugins."pstack@pstack-vic".mcp_servers.x]\nenabled = false\n');
  writeFileSync(join(project, '.codex', 'pstack-models.md'), '# sheet\n');
  mkdirSync(join(project, '.claude'), { recursive: true });
  writeFileSync(join(project, '.claude', 'settings.json'), `${JSON.stringify({ enabledPlugins: { 'pstack@pstack-vic': true } }, null, 2)}\n`);
  s.put('.claude.json', JSON.stringify({ projects: { [project]: {}, [worktree]: {} } }));
  s.write({ ...s.state(), tracked: [join(project, '.claude', 'settings.json')] });
  const result = s.run('uninstall');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(worktree, '.claude', 'settings.local.json'), 'utf8')), { permissions: { allow: [] } });
  assert.equal(readFileSync(join(project, '.codex', 'config.toml'), 'utf8'), 'approval_policy = "never"\n');
  assert.equal(existsSync(join(project, '.codex', 'pstack-models.md')), false);
  assert.equal(result.stdout.split('\n').filter(line => line.startsWith('- ')).join('\n'), `- ${join(project, '.claude', 'settings.json')}: turns pstack@pstack-vic on or off (versioned: remove it in that repository)`);
});
