#!/usr/bin/env node
// Installs and uninstalls pstack-vic on the operator's machine, leaving nothing behind.
//
//   node scripts/pstack.ts install    the plugin in Claude Code (user scope) and Codex, and the Grok Build settings it needs
//   node scripts/pstack.ts uninstall  everything install wrote and everything older versions left, then `check`
//   node scripts/pstack.ts check      what of the plugin is still on this machine; exit 1 when anything is
//
// Neither Claude Code nor Codex runs anything of a plugin when it is installed or removed, no plugin can carry a
// Grok Build setting, and both hosts leave files behind on removal (measured on Claude Code 2.1.296 and Codex
// 0.162.1). So these steps live here. Grok Build runs the plugin Claude Code installs, so it has no install of
// its own. To switch the plugin off for a while, use each host's own switch (`claude plugin disable`, `codex
// plugin remove`): the model choices stay in the data folder until uninstall. The operator's standing
// authorization is theirs, not the plugin's: uninstall rewrites ~/.claude/settings.json only to drop the plugin's
// own entries, and keeps every other key, that one included.
//
// Node 24, type stripping, no dependencies.

import { accessSync, constants, existsSync, lstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configHomeFor, dataHomeFor, LEDGER_FILE, legacyWiringOf, removeLegacyWiring, SHEET_FILE } from '../skills/setup-pstack/scripts/setup-pstack.ts';
import { attempt, claudeRecords, codexActivated, hasCli as probeCli, mainCheckoutOf, MARKETPLACE, PLUGIN, recordName, removeGoneRecord, REPOSITORY, run, say, type ClaudeRecord } from './plugin-hosts.ts';
import { cutTable, joinLines, keyPath, locate, removeTables, roles, splitLines, tableEnd, tableIsEmpty, valueOf, type Lines } from './toml-lines.ts';

/** A Grok Build setting the plugin needs: the root → owner → helper tree needs depth two, and a lane's test suite needs commands longer than Grok's 300 s ceiling. */
interface GrokSetting { readonly table: string; readonly key: string; readonly value: number }
export const GROK_SETTINGS: readonly GrokSetting[] = [
  { table: 'subagents', key: 'max_depth', value: 2 },
  { table: 'toolset.bash', key: 'timeout_secs', value: 3600 },
  { table: 'toolset.bash', key: 'max_timeout_secs', value: 3600 },
];
/** The comment install puts beside each Grok line it writes. It records the line it replaced, so uninstall puts that line back byte for byte even after a host deleted the plugin's data folder, and `check` never mistakes a value the operator set for the plugin's. */
export const GROK_MARK = '# pstack-vic:';

interface Paths {
  readonly home: string;
  readonly claude: string;
  readonly codex: string;
  readonly grok: string;
  readonly claudeData: string;
  readonly codexData: string;
}

function paths(): Paths {
  const home = homedir();
  return {
    home,
    claude: configHomeFor('claude', home, process.env),
    codex: configHomeFor('codex', home, process.env),
    grok: join(home, '.grok'),
    claudeData: dataHomeFor('claude', home, process.env),
    codexData: dataHomeFor('codex', home, process.env),
  };
}

const clis = new Map<string, boolean>();
function hasCli(binary: string): boolean {
  if (!clis.has(binary)) clis.set(binary, probeCli(binary));
  return clis.get(binary)!;
}
function readIfExists(path: string): string | null {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}
function isLink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}
/** Deletes a file or folder; a symbolic link goes as a link, never its target. */
function remove(path: string): void {
  if (existsSync(path) || isLink(path)) rmSync(path, { recursive: true, force: true });
}
function listDir(path: string): string[] {
  try { return readdirSync(path); } catch { return []; }
}
function tracked(folder: string, file: string): boolean {
  return attempt('git', ['-C', folder, 'ls-files', '--error-unmatch', file]).status === 0;
}

// --- Grok Build settings -----------------------------------------------------------

type GrokOutcome = { readonly kind: 'set'; readonly before: string | null } | { readonly kind: 'kept' } | { readonly kind: 'unsupported'; readonly reason: string };

/** Sets one setting to at least the plugin's value, marking the line with the line it replaced. A value that already allows it stays as it is. */
export function grokSet(split: Lines, setting: GrokSetting): GrokOutcome {
  const found = locate(split.lines, setting.table, setting.key);
  if (found.kind === 'unsupported') return found;
  if (found.kind === 'found') {
    if (Number(found.value) >= setting.value) return { kind: 'kept' };
    const before = split.lines[found.index];
    split.lines[found.index] = `${setting.key} = ${setting.value} ${GROK_MARK} was ${JSON.stringify(before)}`;
    return { kind: 'set', before: found.value };
  }
  const line = `${setting.key} = ${setting.value} ${GROK_MARK} was unset`;
  if (found.header === null) {
    if (split.lines.length > 0 && split.lines.at(-1)!.trim() !== '') split.lines.push('');
    split.lines.push(`[${setting.table}] ${GROK_MARK} added`, line);
    split.finalEol = true;
  } else {
    let at = tableEnd(split.lines, found.header);
    while (at > found.header + 1 && split.lines[at - 1].trim() === '') at--;
    split.lines.splice(at, 0, line);
  }
  return { kind: 'set', before: null };
}

const KEY_MARK = new RegExp(`\\s*${GROK_MARK} was (unset|".*")$`);
const TABLE_MARK = new RegExp(`\\s*${GROK_MARK} added$`);

/** The lines install marked, and the tables it added. */
export function grokMarks(split: Lines): { keys: { index: number; table: string; key: string; value: string; before: string | null }[]; tables: number[] } {
  const keys: { index: number; table: string; key: string; value: string; before: string | null }[] = [];
  const tables: number[] = [];
  const all = roles(split.lines);
  for (let i = 0; i < all.length; i++) {
    const role = all[i];
    const line = split.lines[i];
    if (role.kind === 'header' && TABLE_MARK.test(line)) tables.push(i);
    if (role.kind !== 'assignment') continue;
    const mark = KEY_MARK.exec(line);
    if (!mark) continue;
    keys.push({ index: i, table: role.table, key: keyPath(role.key), value: valueOf(line.slice(0, mark.index), role.valueStart), before: mark[1] === 'unset' ? null : JSON.parse(mark[1]) as string });
  }
  return { keys, tables };
}

/** Puts back every line install marked. A marked value the operator changed stays, without the mark; a table install added goes once nothing but its marks was in it. */
export function grokRestore(split: Lines): string[] {
  const said: string[] = [];
  const { keys } = grokMarks(split);
  for (const entry of [...keys].reverse()) {
    const setting = GROK_SETTINGS.find(s => s.table === entry.table && s.key === entry.key);
    const line = split.lines[entry.index];
    if (setting === undefined || entry.value !== String(setting.value)) {
      split.lines[entry.index] = line.replace(KEY_MARK, '');
      said.push(`Grok Build: [${entry.table}] ${entry.key} = ${entry.value} left as you set it`);
    } else if (entry.before === null) {
      split.lines.splice(entry.index, 1);
      said.push(`Grok Build: [${entry.table}] ${entry.key} removed`);
    } else {
      split.lines[entry.index] = entry.before;
      said.push(`Grok Build: [${entry.table}] ${entry.key} put back as it was`);
    }
  }
  for (const index of [...grokMarks(split).tables].reverse()) {
    if (tableIsEmpty(split.lines, index)) cutTable(split.lines, index);
    else split.lines[index] = split.lines[index].replace(TABLE_MARK, '');
  }
  return said.reverse();
}

/** Versions before 0.6.0 wrote these settings without a mark. Only on a machine the plugin was on, a value equal to the plugin's is taken as the plugin's, and its table goes when nothing else is left in it. */
function grokRestoreUnmarked(split: Lines): string[] {
  const said: string[] = [];
  for (const setting of [...GROK_SETTINGS].reverse()) {
    const found = locate(split.lines, setting.table, setting.key);
    if (found.kind !== 'found' || found.value !== String(setting.value)) continue;
    split.lines.splice(found.index, 1);
    said.push(`Grok Build: [${setting.table}] ${setting.key} = ${setting.value} removed (an earlier version set it)`);
    const header = locate(split.lines, setting.table, setting.key);
    if (header.kind === 'absent' && header.header !== null && tableIsEmpty(split.lines, header.header)) cutTable(split.lines, header.header);
  }
  return said.reverse();
}

// --- JSON settings -------------------------------------------------------------

/** Drops `pstack@pstack-vic` from enabledPlugins and `pstack-vic` from extraKnownMarketplaces, and either object once empty: the hosts leave both empty objects behind. */
export function withoutPluginSettings(text: string): string {
  const settings = JSON.parse(text) as Record<string, unknown>;
  let changed = false;
  for (const [field, name] of [['enabledPlugins', PLUGIN], ['extraKnownMarketplaces', MARKETPLACE]] as const) {
    const value = settings[field];
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const entries = value as Record<string, unknown>;
    if (Object.hasOwn(entries, name)) { delete entries[name]; changed = true; }
    if (Object.keys(entries).length === 0) { delete settings[field]; changed = true; }
  }
  return changed ? `${JSON.stringify(settings, null, 2)}${text.endsWith('\n') ? '\n' : ''}` : text;
}
function namesPlugin(text: string | null): boolean {
  if (text === null) return false;
  try {
    const settings = JSON.parse(text) as { enabledPlugins?: Record<string, unknown>; extraKnownMarketplaces?: Record<string, unknown> };
    return Object.hasOwn(settings.enabledPlugins ?? {}, PLUGIN) || Object.hasOwn(settings.extraKnownMarketplaces ?? {}, MARKETPLACE);
  } catch { return false; }
}

// --- What a host holds ------------------------------------------------------------

/** Claude Code's install records of the plugin, from the CLI, else from its own file when the CLI is not on PATH. */
function claudeHeld(p: Paths): { records: ClaudeRecord[]; marketplace: boolean } {
  if (hasCli('claude')) {
    const marketplaces = JSON.parse(run('claude', ['plugin', 'marketplace', 'list', '--json'], p.home)) as { name: string }[];
    return { records: claudeRecords(), marketplace: marketplaces.some(m => m.name === MARKETPLACE) };
  }
  let records: ClaudeRecord[] = [];
  try { records = ((JSON.parse(readFileSync(join(p.claude, 'plugins', 'installed_plugins.json'), 'utf8')) as { plugins?: Record<string, ClaudeRecord[]> }).plugins?.[PLUGIN] ?? []); } catch { /* none */ }
  let marketplace = false;
  try { marketplace = Object.hasOwn(JSON.parse(readFileSync(join(p.claude, 'plugins', 'known_marketplaces.json'), 'utf8')) as object, MARKETPLACE); } catch { /* none */ }
  return { records, marketplace };
}
function codexHeld(p: Paths): { activated: boolean; marketplace: boolean } {
  const lines = splitLines(readIfExists(join(p.codex, 'config.toml')) ?? '').lines;
  return {
    activated: codexActivated(lines.join('\n')),
    marketplace: roles(lines).some(role => role.kind === 'header' && role.path === `marketplaces.${MARKETPLACE}`),
  };
}

// --- What the plugin leaves on a machine --------------------------------------

/** One thing of the plugin on this machine. A versioned file in a project leaves through a PR in that repository, not through uninstall. */
interface Finding { readonly path: string; readonly what: string; readonly versioned?: boolean }

/** Folders a host knows: every project Claude Code has opened, every project Codex trusts, and the folder of every install record. */
function knownFolders(p: Paths, records: readonly ClaudeRecord[]): string[] {
  const folders = new Set<string>();
  for (const file of [join(p.home, '.claude.json'), join(p.claude, '.claude.json')]) {
    try { for (const folder of Object.keys((JSON.parse(readFileSync(file, 'utf8')) as { projects?: object }).projects ?? {})) folders.add(folder); } catch { /* none */ }
  }
  for (const role of roles(splitLines(readIfExists(join(p.codex, 'config.toml')) ?? '').lines)) {
    const project = role.kind === 'header' ? /^projects\."(.+)"$/.exec(role.path) : null;
    if (project) folders.add(JSON.parse(`"${project[1]}"`) as string);
  }
  for (const record of records) if (record.projectPath) folders.add(record.projectPath);
  return [...folders].filter(folder => existsSync(folder)).sort();
}
/** The project files that name the plugin. A linked worktree's committed files are its branch's, so only its untracked local settings count. */
const PROJECT_FILES = [join('.claude', 'settings.json'), join('.claude', 'settings.local.json'), join('.codex', 'config.toml'), join('.codex', SHEET_FILE), join('.codex', LEDGER_FILE)];
function projectFindings(folder: string): Finding[] {
  const linked = mainCheckoutOf(folder) !== undefined;
  const findings: Finding[] = [];
  for (const file of PROJECT_FILES) {
    if (linked && file !== join('.claude', 'settings.local.json')) continue;
    const text = readIfExists(join(folder, file));
    if (text === null) continue;
    const names = file.endsWith('.json') && file.startsWith('.claude') ? namesPlugin(text) : file.endsWith('config.toml') ? codexActivated(text) : true;
    if (names) findings.push({ path: join(folder, file), what: file.startsWith(join('.codex', 'pstack-')) ? 'a model sheet or ledger the plugin wrote for this project' : `turns ${PLUGIN} on or off`, versioned: tracked(folder, file) });
  }
  return findings;
}
/** Files and folders that belong to the plugin or to an older version of it, outside any project. */
function leftovers(p: Paths): string[] {
  const found: string[] = [];
  const add = (path: string) => { if (existsSync(path) || isLink(path)) found.push(path); };
  for (const home of [p.claude, p.codex, p.grok]) {
    add(join(home, SHEET_FILE));
    add(join(home, LEDGER_FILE));
    for (const name of listDir(home)) if (name.startsWith(`${LEDGER_FILE}.pre-`)) found.push(join(home, name));
  }
  for (const name of listDir(p.codex)) if (/^config\.toml\.pre-\d+\.\d+\.\d+$/.test(name)) found.push(join(p.codex, name));
  for (const name of listDir(p.grok)) if (name.startsWith('config.toml.pre-pstack-')) found.push(join(p.grok, name));
  add(join(p.claude, 'plugins', 'cache', MARKETPLACE));
  add(join(p.claude, 'plugins', 'marketplaces', MARKETPLACE));
  add(p.claudeData);
  add(join(p.codex, 'plugins', 'cache', MARKETPLACE));
  add(p.codexData);
  add(join(p.codex, '.tmp', 'marketplaces', MARKETPLACE));
  for (const name of listDir(join(p.grok, 'marketplace-cache'))) {
    const clone = join(p.grok, 'marketplace-cache', name);
    if (!(readIfExists(join(clone, '.git', 'config')) ?? '').includes(REPOSITORY)) continue;
    found.push(clone);
    add(`${clone}.lock`);
  }
  add(join(p.home, 'Library', 'Caches', 'pstack-vic'));
  return found;
}
/** Signs that the plugin is or was installed here. Only with them is an unmarked Grok value equal to the plugin's taken as the plugin's. */
function wasInstalled(p: Paths, records: readonly ClaudeRecord[]): boolean {
  const codex = codexHeld(p);
  return records.length > 0 || codex.activated || codex.marketplace || leftovers(p).some(path => path !== join(p.home, 'Library', 'Caches', 'pstack-vic'))
    || namesPlugin(readIfExists(join(p.claude, 'settings.json')));
}

function check(p: Paths): Finding[] {
  const findings: Finding[] = [];
  const claude = claudeHeld(p);
  for (const record of claude.records) findings.push({ path: record.projectPath ?? p.claude, what: `Claude Code install record (${recordName(record)})` });
  if (claude.marketplace) findings.push({ path: p.claude, what: `Claude Code knows the ${MARKETPLACE} marketplace` });
  const settings = join(p.claude, 'settings.json');
  if (namesPlugin(readIfExists(settings))) findings.push({ path: settings, what: `names ${PLUGIN} or the ${MARKETPLACE} marketplace` });
  for (const parent of ['claude', 'codex', 'grok']) {
    try {
      const wired = legacyWiringOf(parent, p.home, process.env);
      if (wired !== null) findings.push({ path: wired, what: 'loads the model sheet the way versions before 0.5.32 wired it' });
    } catch (error) {
      findings.push({ path: parent, what: `holds a model sheet import this command cannot read (${(error as Error).message})` });
    }
  }
  const codexConfig = join(p.codex, 'config.toml');
  const codex = codexHeld(p);
  if (codex.activated) findings.push({ path: codexConfig, what: `the ${PLUGIN} entry` });
  if (codex.marketplace) findings.push({ path: codexConfig, what: `the ${MARKETPLACE} marketplace` });
  if (roles(splitLines(readIfExists(codexConfig) ?? '').lines).some(role => role.kind === 'header' && role.path.startsWith(`hooks.state."${PLUGIN}:`))) findings.push({ path: codexConfig, what: `trust records of ${PLUGIN} hooks` });
  const grok = splitLines(readIfExists(join(p.grok, 'config.toml')) ?? '');
  const marks = grokMarks(grok);
  for (const entry of marks.keys) findings.push({ path: join(p.grok, 'config.toml'), what: `[${entry.table}] ${entry.key} = ${entry.value}, set by install` });
  if (marks.keys.length === 0 && marks.tables.length === 0 && wasInstalled(p, claude.records)) {
    for (const setting of GROK_SETTINGS) {
      const found = locate(grok.lines, setting.table, setting.key);
      if (found.kind === 'found' && found.value === String(setting.value)) findings.push({ path: join(p.grok, 'config.toml'), what: `[${setting.table}] ${setting.key} = ${setting.value}, set by an earlier version` });
    }
  }
  for (const path of leftovers(p)) findings.push({ path, what: 'belongs to the plugin or an older version of it' });
  for (const folder of knownFolders(p, claude.records)) findings.push(...projectFindings(folder));
  if (findings.length === 0) say(`Nothing of ${PLUGIN} is left on this machine`);
  for (const f of findings) say(`- ${f.path}: ${f.what}${f.versioned ? ' (versioned: remove it in that repository)' : ''}`);
  return findings;
}

// --- Install --------------------------------------------------------------------

function install(p: Paths, version: string): void {
  const claude = hasCli('claude');
  const codex = hasCli('codex');
  if (!claude && !codex) throw new Error('neither claude nor codex is on PATH; install Claude Code or Codex first');
  const tag = `v${version}`;
  const lookup = attempt('git', ['ls-remote', '--exit-code', '--tags', `https://github.com/${REPOSITORY}.git`, `refs/tags/${tag}`]);
  if (lookup.status !== 0) throw new Error(lookup.status === 2 ? `${tag} is not tagged on ${REPOSITORY}; run install from a released checkout` : lookup.failure);
  const grokConfig = join(p.grok, 'config.toml');
  const grok = claude && (hasCli('grok') || existsSync(p.grok)) ? splitLines(readIfExists(grokConfig) ?? '') : null;
  const grokOutcomes = grok === null ? [] : GROK_SETTINGS.map(setting => ({ setting, outcome: grokSet(grok, setting) }));

  if (claude) {
    const held = claudeHeld(p);
    const scoped = held.records.filter(r => r.scope !== 'user');
    if (scoped.length > 0) throw new Error(`Claude Code has ${PLUGIN} installed per project (${scoped.map(recordName).join('; ')}); run \`node scripts/pstack.ts uninstall\` first, then install`);
    if (held.marketplace) run('claude', ['plugin', 'marketplace', 'update', MARKETPLACE], p.home);
    else run('claude', ['plugin', 'marketplace', 'add', REPOSITORY], p.home);
    const user = held.records.find(r => r.scope === 'user');
    if (!user) run('claude', ['plugin', 'install', PLUGIN, '--scope', 'user'], p.home);
    else {
      if (user.version !== version) run('claude', ['plugin', 'update', PLUGIN, '--scope', 'user'], p.home);
      if (user.enabled === false) run('claude', ['plugin', 'enable', PLUGIN, '--scope', 'user'], p.home);
    }
    const after = claudeRecords().find(r => r.scope === 'user');
    if (!after || after.enabled === false) throw new Error(`Claude Code does not report ${PLUGIN} installed and enabled at user scope`);
    if (after.version !== version) throw new Error(`Claude Code installed ${PLUGIN} ${after.version}, not ${version}: this checkout is not the latest release; run \`git pull --ff-only\` and install again`);
    say(`Claude Code: ${PLUGIN} ${after.version} installed and enabled (user)`);
  }

  if (codex) {
    const config = join(p.codex, 'config.toml');
    const lines = splitLines(readIfExists(config) ?? '').lines;
    const ref = locate(lines, `marketplaces.${MARKETPLACE}`, 'ref');
    const held = codexHeld(p);
    // A marketplace pinned to another tag is swapped, and an installed plugin of another version goes first, while its marketplace is still there.
    const stalePin = held.marketplace && (ref.kind !== 'found' || ref.value !== JSON.stringify(tag));
    const installedVersion = () => (JSON.parse(run('codex', ['plugin', 'list', '--json'], p.home)) as { installed: { pluginId: string; version: string }[] }).installed.find(i => i.pluginId === PLUGIN)?.version;
    if (held.activated && (stalePin || installedVersion() !== version)) run('codex', ['plugin', 'remove', PLUGIN], p.home);
    if (stalePin) run('codex', ['plugin', 'marketplace', 'remove', MARKETPLACE], p.home);
    if (!codexHeld(p).marketplace) run('codex', ['plugin', 'marketplace', 'add', REPOSITORY, '--ref', tag], p.home);
    if (!codexHeld(p).activated) run('codex', ['plugin', 'add', PLUGIN], p.home);
    const text = readIfExists(config) ?? '';
    const enabled = locate(splitLines(text).lines, `plugins."${PLUGIN}"`, 'enabled');
    if (enabled.kind === 'found' && enabled.value === 'false') {
      const split = splitLines(text);
      split.lines[enabled.index] = 'enabled = true';
      writeFileSync(config, joinLines(split));
    }
    const installed = installedVersion();
    if (installed !== version) throw new Error(`Codex reports ${PLUGIN} ${installed ?? 'not installed'}, not ${version}`);
    say(`Codex: ${PLUGIN} ${installed} installed and enabled`);
  }

  if (grok !== null) {
    for (const { setting, outcome } of grokOutcomes) {
      if (outcome.kind === 'set') say(`Grok Build: [${setting.table}] ${setting.key} = ${setting.value} (was ${outcome.before ?? 'unset'})`);
      if (outcome.kind === 'unsupported') say(`Grok Build: [${setting.table}] ${setting.key} left alone, set it to ${setting.value} or more by hand: ${outcome.reason}`);
    }
    if (grokOutcomes.some(o => o.outcome.kind === 'set')) writeFileSync(grokConfig, joinLines(grok));
    say('Grok Build: runs the plugin Claude Code installed');
  }
  say('Choose models per role with /setup-pstack in each parent (optional: without it every role uses its default)');
}

// --- Uninstall ------------------------------------------------------------------

/** Removes one Claude Code record from its own folder. A project record's removal rewrites the folder's versioned .claude/settings.json (it reorders it, or creates it), so a file that did not name the plugin is put back byte for byte. */
function uninstallClaudeRecord(record: ClaudeRecord, p: Paths): void {
  if (record.scope === 'user') { run('claude', ['plugin', 'uninstall', PLUGIN, '--scope', 'user'], p.home); return; }
  const folder = record.projectPath ?? '';
  if (!existsSync(folder)) { removeGoneRecord(record, false); return; }
  const settings = join(folder, '.claude', 'settings.json');
  const before = readIfExists(settings);
  run('claude', ['plugin', 'uninstall', PLUGIN, '--scope', record.scope], folder);
  if (record.scope !== 'project') return;
  if (namesPlugin(before)) say(`${settings}: the line that turned ${PLUGIN} on is gone; commit that change in its repository`);
  else if (before === null) remove(settings);
  else writeFileSync(settings, before);
}

/** Everything that would stop uninstall halfway is checked before anything changes. */
function preflight(p: Paths, records: readonly ClaudeRecord[], claudeMarketplace: boolean): void {
  if (!hasCli('claude') && (records.length > 0 || claudeMarketplace)) throw new Error(`Claude Code still has ${PLUGIN} or its marketplace, and claude is not on PATH; put the claude CLI on PATH and run uninstall again`);
  const codex = codexHeld(p);
  if (!hasCli('codex') && (codex.activated || codex.marketplace)) throw new Error(`Codex still has ${PLUGIN} or its marketplace, and codex is not on PATH; put the codex CLI on PATH and run uninstall again`);
  for (const record of records) {
    if (!record.projectPath || existsSync(record.projectPath)) continue;
    let parent = dirname(record.projectPath);
    while (!existsSync(parent)) parent = dirname(parent);
    try { accessSync(parent, constants.W_OK | constants.X_OK); }
    catch { throw new Error(`Claude Code has ${PLUGIN} (${recordName(record)}), whose folder is gone, and ${parent} is not writable, so the record cannot be removed from a fresh repository there; mount or unlock it and run uninstall again`); }
  }
  for (const parent of ['claude', 'codex', 'grok']) legacyWiringOf(parent, p.home, process.env);
}

function uninstall(p: Paths): Finding[] {
  const claude = claudeHeld(p);
  const records = claude.records;
  preflight(p, records, claude.marketplace);
  const installedHere = wasInstalled(p, records);
  const folders = knownFolders(p, records);

  for (const parent of ['claude', 'codex', 'grok']) {
    const changed = removeLegacyWiring(parent, p.home, process.env);
    if (changed !== null) say(`${changed}: model sheet wiring removed`);
  }
  const grokConfig = join(p.grok, 'config.toml');
  const grokText = readIfExists(grokConfig);
  if (grokText !== null) {
    const grok = splitLines(grokText);
    const marked = grokMarks(grok);
    const said = marked.keys.length > 0 || marked.tables.length > 0 ? grokRestore(grok) : installedHere ? grokRestoreUnmarked(grok) : [];
    for (const line of said) say(line);
    const after = joinLines(grok);
    if (after !== grokText) {
      // A config.toml that held only what install wrote did not exist before it.
      if (after.trim() === '') remove(grokConfig);
      else writeFileSync(grokConfig, after);
    }
  }

  if (hasCli('claude')) {
    // Project and local records first, the user record last: Claude Code deletes the data folder with the last record.
    for (const record of [...records].sort((a, b) => Number(a.scope === 'user') - Number(b.scope === 'user'))) {
      uninstallClaudeRecord(record, p);
      say(`Claude Code: ${PLUGIN} (${recordName(record)}) uninstalled`);
    }
    const left = claudeRecords();
    if (left.length > 0) throw new Error(`Claude Code still has ${PLUGIN} after its removal: ${left.map(recordName).join('; ')}`);
    if (claude.marketplace) { run('claude', ['plugin', 'marketplace', 'remove', MARKETPLACE], p.home); say(`Claude Code: ${MARKETPLACE} marketplace removed`); }
  }
  const settings = join(p.claude, 'settings.json');
  const text = readIfExists(settings);
  if (text !== null && withoutPluginSettings(text) !== text) {
    const cleaned = withoutPluginSettings(text);
    // A settings.json the marketplace and the plugin alone made holds nothing else.
    if (cleaned.trim() === '{}') remove(settings);
    else writeFileSync(settings, cleaned);
  }

  if (hasCli('codex')) {
    if (codexHeld(p).activated) { run('codex', ['plugin', 'remove', PLUGIN], p.home); say(`Codex: ${PLUGIN} removed`); }
    if (codexHeld(p).marketplace) { run('codex', ['plugin', 'marketplace', 'remove', MARKETPLACE], p.home); say(`Codex: ${MARKETPLACE} marketplace removed`); }
  }
  const codexConfig = join(p.codex, 'config.toml');
  const codexText = readIfExists(codexConfig);
  if (codexText !== null) {
    const cleaned = removeTables(codexText, path => path.startsWith(`hooks.state."${PLUGIN}:`));
    if (cleaned !== codexText) say(`${codexConfig}: trust records of ${PLUGIN} hooks removed`);
    // A config.toml the marketplace and the plugin alone made is empty once they are gone.
    if (cleaned.trim() === '') remove(codexConfig);
    else if (cleaned !== codexText) writeFileSync(codexConfig, cleaned);
  }

  // Untracked project files lose the plugin here; a versioned one is named by check, for a PR in its repository.
  const recordFolders = new Set(records.flatMap(r => r.projectPath ? [r.projectPath, mainCheckoutOf(r.projectPath) ?? r.projectPath] : []));
  for (const folder of new Set([...folders, ...[...recordFolders].filter(existsSync)])) {
    const linked = mainCheckoutOf(folder) !== undefined;
    for (const file of PROJECT_FILES) {
      if (linked && file !== join('.claude', 'settings.local.json')) continue;
      const path = join(folder, file);
      const before = readIfExists(path);
      if (before === null) continue;
      let after: string | null = before;
      if (file.startsWith(join('.codex', 'pstack-'))) after = null;
      else if (file.endsWith('config.toml')) after = codexActivated(before) ? removeTables(before, path => path === `plugins."${PLUGIN}"` || path.startsWith(`plugins."${PLUGIN}".`)) : before;
      // The folders of the removed records also lose the empty objects the CLI leaves.
      else if (namesPlugin(before) || recordFolders.has(folder)) after = withoutPluginSettings(before);
      if (after === before || tracked(folder, file)) continue;
      if (after === null || after.trim() === '' || (file === join('.claude', 'settings.json') && after.trim() === '{}')) remove(path);
      else writeFileSync(path, after);
      say(`${path}: ${PLUGIN} removed`);
    }
  }

  for (const path of leftovers(p)) { remove(path); say(`${path}: deleted`); }
  // The instruction files the old wiring alone filled, now empty, go too, on a machine the plugin was on.
  if (installedHere) {
    for (const file of [join(p.claude, 'CLAUDE.md'), join(p.codex, 'AGENTS.md'), join(p.grok, 'AGENTS.md')]) {
      if (readIfExists(file) === '') { remove(file); say(`${file}: deleted (empty)`); }
    }
  }
  // Codex makes these folders for the plugin's data, cache and marketplace clone and leaves them empty, innermost first.
  for (const folder of [join(p.codex, 'plugins', 'data'), join(p.codex, 'plugins', 'cache'), join(p.codex, 'plugins'), join(p.codex, '.tmp', 'marketplaces', '.staging'), join(p.codex, '.tmp', 'marketplaces'), join(p.codex, '.tmp')]) {
    if (existsSync(folder) && listDir(folder).length === 0) remove(folder);
  }
  return check(p);
}

// --- Command line ---------------------------------------------------------------

function main(argv: readonly string[]): number {
  const [command, ...rest] = argv;
  if (rest.length > 0 || !['install', 'uninstall', 'check'].includes(command ?? '')) {
    process.stderr.write('Usage: node scripts/pstack.ts <install|uninstall|check>\n');
    return 64;
  }
  const p = paths();
  if (command === 'install') {
    const version = (JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')) as { version: string }).version;
    install(p, version);
    return 0;
  }
  const findings = command === 'uninstall' ? uninstall(p) : check(p);
  return findings.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n'); process.exitCode = 1; }
}
