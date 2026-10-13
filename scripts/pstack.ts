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
// authorization in ~/.claude/settings.json is theirs, not the plugin's: no step here reads or touches it.
//
// Node 24, type stripping, no dependencies.

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configHomeFor, dataHomeFor, LEDGER_FILE, removeLegacyWiring, SHEET_FILE } from '../skills/setup-pstack/scripts/setup-pstack.ts';
import { attempt, claudeRecords, codexActivated, hasCli as probeCli, mainCheckoutOf, MARKETPLACE, PLUGIN, recordName, removeGoneRecord, REPOSITORY, run, say, type ClaudeRecord } from './plugin-hosts.ts';

/** A Grok Build setting the plugin needs: the root → owner → helper tree needs depth two, and a lane's test suite needs commands longer than Grok's 300 s ceiling. */
interface GrokSetting { readonly table: string; readonly key: string; readonly value: number }
export const GROK_SETTINGS: readonly GrokSetting[] = [
  { table: 'subagents', key: 'max_depth', value: 2 },
  { table: 'toolset.bash', key: 'timeout_secs', value: 3600 },
  { table: 'toolset.bash', key: 'max_timeout_secs', value: 3600 },
];

/** What install changed outside the hosts' plugin commands, kept in the plugin's data folder so uninstall can put each value back. */
interface Manifest {
  readonly schemaVersion: 1;
  readonly grok: readonly { readonly table: string; readonly key: string; readonly before: string | null; readonly value: string; readonly createdTable: boolean }[];
}

interface Paths {
  readonly home: string;
  readonly claude: string;
  readonly codex: string;
  readonly grok: string;
  readonly claudeData: string;
  readonly codexData: string;
  readonly manifest: string;
}

function paths(): Paths {
  const home = homedir();
  const claude = configHomeFor('claude', home, process.env);
  const codex = configHomeFor('codex', home, process.env);
  const claudeData = dataHomeFor('claude', home, process.env);
  return { home, claude, codex, grok: join(home, '.grok'), claudeData, codexData: dataHomeFor('codex', home, process.env), manifest: join(claudeData, 'install.json') };
}

const clis = new Map<string, boolean>();
function hasCli(binary: string): boolean {
  if (!clis.has(binary)) clis.set(binary, probeCli(binary));
  return clis.get(binary)!;
}
function readIfExists(path: string): string | null {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}
function remove(path: string): boolean {
  if (!existsSync(path) && !isLink(path)) return false;
  rmSync(path, { recursive: true, force: true });
  return true;
}
function isLink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}
function listDir(path: string): string[] {
  try { return readdirSync(path); } catch { return []; }
}

// --- TOML, line by line --------------------------------------------------------
// Only what these settings need: a table's header line and `key = value` lines at its top level. A line inside a
// multi-line value never starts with `[name]` or `name =` for the names used here.

function headerOf(line: string): string | null {
  if (/^\s*\[\[/.test(line)) return '[[array]]';
  const header = /^\s*\[\s*([^[\]]+?)\s*\]\s*(?:#.*)?$/.exec(line);
  return header ? header[1].replace(/\s*\.\s*/g, '.') : null;
}
/** The lines of a table, from its header to the next header, or null when it is absent. */
function tableRange(lines: readonly string[], table: string): [number, number] | null {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const header = headerOf(lines[i]);
    if (header === null) continue;
    if (start >= 0) return [start, i];
    if (header === table) start = i;
  }
  return start >= 0 ? [start, lines.length] : null;
}
function keyLine(lines: readonly string[], range: [number, number], key: string): { index: number; value: string } | null {
  for (let i = range[0] + 1; i < range[1]; i++) {
    const match = new RegExp(`^\\s*${key.replace(/[.]/g, '\\.')}\\s*=\\s*(.*?)\\s*(?:#.*)?$`).exec(lines[i]);
    if (match) return { index: i, value: match[1] };
  }
  return null;
}
export function tomlValue(text: string, table: string, key: string): string | null {
  const lines = text.split('\n');
  const range = tableRange(lines, table);
  return range === null ? null : keyLine(lines, range, key)?.value ?? null;
}
/** Sets one key, appending its table at the end when absent. */
export function tomlSet(text: string, table: string, key: string, value: string): { text: string; before: string | null; createdTable: boolean } {
  const lines = text.split('\n');
  const range = tableRange(lines, table);
  if (range === null) {
    const body = text === '' || text.endsWith('\n') ? text : `${text}\n`;
    return { text: `${body}${body.trim() === '' ? '' : '\n'}[${table}]\n${key} = ${value}\n`, before: null, createdTable: true };
  }
  const found = keyLine(lines, range, key);
  if (found !== null) {
    lines[found.index] = `${key} = ${value}`;
    return { text: lines.join('\n'), before: found.value, createdTable: false };
  }
  let at = range[1];
  while (at > range[0] + 1 && lines[at - 1].trim() === '') at--;
  lines.splice(at, 0, `${key} = ${value}`);
  return { text: lines.join('\n'), before: null, createdTable: false };
}
/** Removes one key, and its table when the table was created for it and is left empty, with the blank line before it. */
export function tomlUnset(text: string, table: string, key: string, dropEmptyTable: boolean): string {
  const lines = text.split('\n');
  const range = tableRange(lines, table);
  if (range === null) return text;
  const found = keyLine(lines, range, key);
  if (found === null) return text;
  lines.splice(found.index, 1);
  const after = tableRange(lines, table)!;
  const empty = lines.slice(after[0] + 1, after[1]).every(line => line.trim() === '');
  if (!dropEmptyTable || !empty) return lines.join('\n');
  cutTable(lines, after[0], after[1]);
  return lines.join('\n');
}
/** Cuts a table's lines, keeping the blank lines after it as the separator before what follows, and the blank line before it goes. */
function cutTable(lines: string[], header: number, next: number): void {
  let end = next;
  while (end > header + 1 && lines[end - 1].trim() === '') end--;
  const start = header > 0 && lines[header - 1].trim() === '' ? header - 1 : header;
  lines.splice(start, end - start);
}
/** Removes every table whose header matches, each with the blank line before it. */
export function tomlRemoveTables(text: string, matches: (header: string) => boolean): string {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const header = headerOf(lines[i]);
    if (header === null || !matches(header)) continue;
    let end = i + 1;
    while (end < lines.length && headerOf(lines[end]) === null) end++;
    cutTable(lines, i, end);
  }
  return lines.join('\n');
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

// --- What the plugin leaves on a machine --------------------------------------

/** One thing of the plugin on this machine. A versioned file in a project leaves through a PR in that repository, not through uninstall. */
interface Finding { readonly path: string; readonly what: string; readonly versioned?: boolean }

/** Folders a host knows: every project Claude Code has opened, every project Codex trusts, and the folder of every install record. A linked worktree shares its checkout's files and goes with it, so it is skipped. */
function knownFolders(p: Paths, records: readonly ClaudeRecord[]): string[] {
  const folders = new Set<string>();
  for (const file of [join(p.home, '.claude.json'), join(p.claude, '.claude.json')]) {
    try { for (const folder of Object.keys((JSON.parse(readFileSync(file, 'utf8')) as { projects?: object }).projects ?? {})) folders.add(folder); } catch { /* none */ }
  }
  for (const match of (readIfExists(join(p.codex, 'config.toml')) ?? '').matchAll(/^\s*\[\s*projects\s*\.\s*"([^"]+)"\s*\]/gm)) folders.add(match[1]);
  for (const record of records) if (record.projectPath) folders.add(record.projectPath);
  return [...folders].filter(folder => existsSync(folder) && mainCheckoutOf(folder) === undefined).sort();
}
function tracked(folder: string, file: string): boolean {
  return attempt('git', ['-C', folder, 'ls-files', '--error-unmatch', file]).status === 0;
}
function projectFindings(folder: string): Finding[] {
  const findings: Finding[] = [];
  for (const file of [join('.claude', 'settings.json'), join('.claude', 'settings.local.json')]) {
    if (namesPlugin(readIfExists(join(folder, file)))) findings.push({ path: join(folder, file), what: `turns ${PLUGIN} on or off`, versioned: tracked(folder, file) });
  }
  const codex = join('.codex', 'config.toml');
  const text = readIfExists(join(folder, codex));
  if (text !== null && codexActivated(text)) findings.push({ path: join(folder, codex), what: `turns ${PLUGIN} on or off`, versioned: tracked(folder, codex) });
  return findings;
}
/** Files the plugin and its older versions left in each config home, and the caches the hosts keep after removal. */
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
  add(join(p.claude, 'plugins', 'data', 'pstack-inline'));
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
  for (const file of [join(p.claude, 'CLAUDE.md'), join(p.codex, 'AGENTS.md'), join(p.grok, 'AGENTS.md')]) {
    const text = readIfExists(file);
    if (text !== null && text.trim() === '') found.push(file);
  }
  return found;
}
function check(p: Paths): Finding[] {
  const findings: Finding[] = [];
  const records = hasCli('claude') ? claudeRecords() : [];
  for (const record of records) findings.push({ path: record.projectPath ?? p.claude, what: `Claude Code install record (${recordName(record)})` });
  const settings = join(p.claude, 'settings.json');
  if (namesPlugin(readIfExists(settings))) findings.push({ path: settings, what: `names ${PLUGIN} or the ${MARKETPLACE} marketplace` });
  const claudeMd = readIfExists(join(p.claude, 'CLAUDE.md')) ?? '';
  if (claudeMd.includes(`/${SHEET_FILE}`)) findings.push({ path: join(p.claude, 'CLAUDE.md'), what: 'imports the model sheet' });
  for (const home of [p.codex, p.grok]) if ((readIfExists(join(home, 'AGENTS.md')) ?? '').includes('<!-- pstack:models:begin -->')) findings.push({ path: join(home, 'AGENTS.md'), what: 'holds the model sheet block' });
  const codexConfig = join(p.codex, 'config.toml');
  const codexText = readIfExists(codexConfig) ?? '';
  if (codexActivated(codexText)) findings.push({ path: codexConfig, what: `the ${PLUGIN} entry` });
  if (tableRange(codexText.split('\n'), `marketplaces.${MARKETPLACE}`) !== null) findings.push({ path: codexConfig, what: `the ${MARKETPLACE} marketplace` });
  if (codexText.split('\n').some(line => (headerOf(line) ?? '').startsWith(`hooks.state."${PLUGIN}:`))) findings.push({ path: codexConfig, what: `trust records of ${PLUGIN} hooks` });
  const manifest = readManifest(p);
  const grokText = readIfExists(join(p.grok, 'config.toml')) ?? '';
  for (const entry of manifest?.grok ?? []) {
    if (tomlValue(grokText, entry.table, entry.key) === entry.value) findings.push({ path: join(p.grok, 'config.toml'), what: `[${entry.table}] ${entry.key} = ${entry.value}, set by install` });
  }
  for (const path of leftovers(p)) findings.push({ path, what: 'belongs to the plugin or an older version of it' });
  for (const folder of knownFolders(p, records)) findings.push(...projectFindings(folder));
  if (findings.length === 0) say(`Nothing of ${PLUGIN} is left on this machine`);
  for (const f of findings) say(`- ${f.path}: ${f.what}${f.versioned ? ' (versioned: remove it in that repository)' : ''}`);
  return findings;
}

// --- Install --------------------------------------------------------------------

function readManifest(p: Paths): Manifest | null {
  const text = readIfExists(p.manifest);
  if (text === null) return null;
  const manifest = JSON.parse(text) as Manifest;
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.grok)) throw new Error(`${p.manifest} is not a schemaVersion 1 install record; fix or remove it`);
  return manifest;
}

function install(p: Paths, version: string): void {
  const claude = hasCli('claude');
  const codex = hasCli('codex');
  if (!claude && !codex) throw new Error('neither claude nor codex is on PATH; install Claude Code or Codex first');
  const tag = `v${version}`;
  const lookup = attempt('git', ['ls-remote', '--exit-code', '--tags', `https://github.com/${REPOSITORY}.git`, `refs/tags/${tag}`]);
  if (lookup.status !== 0) throw new Error(lookup.status === 2 ? `${tag} is not tagged on ${REPOSITORY}; run install from a released checkout` : lookup.failure);

  if (claude) {
    const records = claudeRecords();
    const scoped = records.filter(r => r.scope !== 'user');
    if (scoped.length > 0) throw new Error(`Claude Code has ${PLUGIN} installed per project (${scoped.map(recordName).join('; ')}); run \`node scripts/pstack.ts uninstall\` first, then install`);
    const marketplaces = JSON.parse(run('claude', ['plugin', 'marketplace', 'list', '--json'], p.home)) as { name: string }[];
    if (!marketplaces.some(m => m.name === MARKETPLACE)) run('claude', ['plugin', 'marketplace', 'add', REPOSITORY], p.home);
    const user = records.find(r => r.scope === 'user');
    if (!user) run('claude', ['plugin', 'install', PLUGIN, '--scope', 'user'], p.home);
    else if (user.enabled === false) run('claude', ['plugin', 'enable', PLUGIN, '--scope', 'user'], p.home);
    const after = claudeRecords().find(r => r.scope === 'user');
    if (!after || after.enabled === false) throw new Error(`Claude Code does not report ${PLUGIN} installed and enabled at user scope`);
    say(`Claude Code: ${PLUGIN} ${after.version} installed and enabled (user)`);
  }

  if (codex) {
    const marketplaces = (JSON.parse(run('codex', ['plugin', 'marketplace', 'list', '--json'], p.home)) as { marketplaces: { name: string }[] }).marketplaces;
    if (!marketplaces.some(m => m.name === MARKETPLACE)) run('codex', ['plugin', 'marketplace', 'add', REPOSITORY, '--ref', tag], p.home);
    const config = join(p.codex, 'config.toml');
    const text = readIfExists(config) ?? '';
    if (!codexActivated(text)) run('codex', ['plugin', 'add', PLUGIN], p.home);
    else if (tomlValue(text, `plugins."${PLUGIN}"`, 'enabled') === 'false') writeFileSync(config, tomlSet(text, `plugins."${PLUGIN}"`, 'enabled', 'true').text);
    const installed = (JSON.parse(run('codex', ['plugin', 'list', '--json'], p.home)) as { installed: { pluginId: string; version: string }[] }).installed.find(i => i.pluginId === PLUGIN);
    if (!installed) throw new Error(`Codex does not report ${PLUGIN} installed`);
    say(`Codex: ${PLUGIN} ${installed.version} installed and enabled`);
  }

  if (claude && (hasCli('grok') || existsSync(p.grok))) {
    const config = join(p.grok, 'config.toml');
    let text = readIfExists(config) ?? '';
    const changes: Manifest['grok'][number][] = [...(readManifest(p)?.grok ?? [])];
    for (const setting of GROK_SETTINGS) {
      const current = tomlValue(text, setting.table, setting.key);
      if (current !== null && Number(current) >= setting.value) continue;
      const set = tomlSet(text, setting.table, setting.key, String(setting.value));
      text = set.text;
      changes.push({ table: setting.table, key: setting.key, before: set.before, value: String(setting.value), createdTable: set.createdTable });
      say(`Grok Build: [${setting.table}] ${setting.key} = ${setting.value} (was ${set.before ?? 'unset'})`);
    }
    if (changes.length > 0) {
      mkdirSync(p.grok, { recursive: true });
      writeFileSync(config, text);
      mkdirSync(p.claudeData, { recursive: true });
      writeFileSync(p.manifest, `${JSON.stringify({ schemaVersion: 1, grok: changes } satisfies Manifest, null, 2)}\n`, { mode: 0o600 });
    }
    say('Grok Build: runs the plugin Claude Code installed');
  }
  say('Choose models per role with /setup-pstack in each parent (optional: without it every role uses its default)');
}

// --- Uninstall ------------------------------------------------------------------

/** Signs that the plugin was installed here, so a Grok value equal to the plugin's is the plugin's even without an install record (versions before 0.6.0 kept none). */
function wasInstalled(p: Paths, records: readonly ClaudeRecord[]): boolean {
  return records.length > 0 || leftovers(p).length > 0 || namesPlugin(readIfExists(join(p.claude, 'settings.json'))) || codexActivated(readIfExists(join(p.codex, 'config.toml')) ?? '');
}

function restoreGrok(p: Paths, manifest: Manifest | null, records: readonly ClaudeRecord[]): void {
  const config = join(p.grok, 'config.toml');
  let text = readIfExists(config);
  if (text === null) return;
  const entries = manifest?.grok ?? (wasInstalled(p, records)
    ? GROK_SETTINGS.map(s => ({ table: s.table, key: s.key, before: null, value: String(s.value), createdTable: true }))
    : []);
  for (const entry of [...entries].reverse()) {
    const current = tomlValue(text, entry.table, entry.key);
    if (current === null) continue;
    if (current !== entry.value) { say(`Grok Build: [${entry.table}] ${entry.key} = ${current} left as you set it`); continue; }
    text = entry.before === null ? tomlUnset(text, entry.table, entry.key, entry.createdTable) : tomlSet(text, entry.table, entry.key, entry.before).text;
    say(`Grok Build: [${entry.table}] ${entry.key} ${entry.before === null ? 'removed' : `back to ${entry.before}`}`);
  }
  if (text === readIfExists(config)) return;
  // A config.toml that held only what install wrote did not exist before it.
  if (manifest !== null && text.trim() === '') remove(config);
  else writeFileSync(config, text);
}

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

function uninstall(p: Paths): Finding[] {
  const claude = hasCli('claude');
  const records = claude ? claudeRecords() : [];
  const manifest = readManifest(p);
  restoreGrok(p, manifest, records);
  for (const parent of ['claude', 'codex', 'grok']) {
    const changed = removeLegacyWiring(parent, p.home, process.env);
    if (changed !== null) say(`${changed}: model sheet wiring removed`);
  }

  if (claude) {
    // Project and local records first, the user record last: Claude Code deletes the data folder with the last record.
    for (const record of [...records].sort((a, b) => Number(a.scope === 'user') - Number(b.scope === 'user'))) {
      uninstallClaudeRecord(record, p);
      say(`Claude Code: ${PLUGIN} (${recordName(record)}) uninstalled`);
    }
    const left = claudeRecords();
    if (left.length > 0) throw new Error(`Claude Code still has ${PLUGIN} after its removal: ${left.map(recordName).join('; ')}`);
    const marketplaces = JSON.parse(run('claude', ['plugin', 'marketplace', 'list', '--json'], p.home)) as { name: string }[];
    if (marketplaces.some(m => m.name === MARKETPLACE)) { run('claude', ['plugin', 'marketplace', 'remove', MARKETPLACE], p.home); say(`Claude Code: ${MARKETPLACE} marketplace removed`); }
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
    const config = join(p.codex, 'config.toml');
    if (codexActivated(readIfExists(config) ?? '')) { run('codex', ['plugin', 'remove', PLUGIN], p.home); say(`Codex: ${PLUGIN} removed`); }
    const marketplaces = (JSON.parse(run('codex', ['plugin', 'marketplace', 'list', '--json'], p.home)) as { marketplaces: { name: string }[] }).marketplaces;
    if (marketplaces.some(m => m.name === MARKETPLACE)) { run('codex', ['plugin', 'marketplace', 'remove', MARKETPLACE], p.home); say(`Codex: ${MARKETPLACE} marketplace removed`); }
  }
  const codexConfig = join(p.codex, 'config.toml');
  const codexText = readIfExists(codexConfig);
  if (codexText !== null) {
    const cleaned = tomlRemoveTables(codexText, header => header.startsWith(`hooks.state."${PLUGIN}:`));
    if (cleaned !== codexText) { writeFileSync(codexConfig, cleaned); say(`${codexConfig}: trust records of ${PLUGIN} hooks removed`); }
    // A config.toml the marketplace and the plugin alone made is empty once they are gone.
    if (cleaned.trim() === '') remove(codexConfig);
  }

  // The folders of the removed records get the empty objects the CLI leaves dropped too; any other folder only loses the plugin's own entry.
  const recordFolders = new Set(records.flatMap(r => r.projectPath ? [r.projectPath, mainCheckoutOf(r.projectPath) ?? r.projectPath] : []));
  for (const folder of new Set([...knownFolders(p, records), ...[...recordFolders].filter(existsSync)])) {
    const local = join(folder, '.claude', 'settings.local.json');
    const before = readIfExists(local);
    if (before === null || !(namesPlugin(before) || recordFolders.has(folder))) continue;
    const after = withoutPluginSettings(before);
    if (after !== before) { writeFileSync(local, after); say(`${local}: ${PLUGIN} removed`); }
  }
  for (const path of leftovers(p)) { remove(path); say(`${path}: deleted`); }
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
