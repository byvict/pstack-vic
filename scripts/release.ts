// pstack-vic's release on the operator's Mac: moves Claude Code and Codex to the version CI tagged. Run it in the main checkout after `git pull --ff-only`. Every step reads what is already done before it acts, so a second run is safe.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PLUGIN = 'pstack@pstack-vic';
const MARKETPLACE = 'pstack-vic';
/** `git ls-remote --exit-code` when no ref matches. */
const NO_MATCHING_REF = 2;

function say(line: string): void { process.stdout.write(line + '\n'); }
function attempt(binary: string, args: string[], cwd?: string): { status: number | null; stdout: string; failure: string } {
  const result = spawnSync(binary, args, { cwd, encoding: 'utf8', timeout: 300_000 });
  return { status: result.error ? null : result.status, stdout: result.stdout ?? '', failure: `${binary} ${args.join(' ')} failed: ${(result.stderr || result.error?.message || `exit ${result.status}`).trim()}` };
}
function run(binary: string, args: string[], cwd?: string): string {
  const result = attempt(binary, args, cwd);
  if (result.status !== 0) throw new Error(result.failure);
  return result.stdout;
}
/** The marketplaces install the commit that carries the tag, so the release waits for the checkout to be the trunk tip and for CI to have tagged the version. */
function requireTaggedTrunk(version: string): void {
  run('git', ['fetch', 'origin']);
  const head = run('git', ['rev-parse', 'HEAD']).trim();
  const trunk = run('git', ['rev-parse', 'origin/main']).trim();
  if (head !== trunk) throw new Error(`HEAD ${head} is not origin/main ${trunk}; run \`git pull --ff-only\` in the main checkout and run again`);
  const name = `v${version}`;
  const tag = attempt('git', ['ls-remote', '--exit-code', '--tags', 'origin', `refs/tags/${name}`]);
  if (tag.status === NO_MATCHING_REF) throw new Error(`CI has not tagged ${name} yet; check \`gh run list -R byvict/pstack-vic --branch main --limit 1\``);
  if (tag.status !== 0) throw new Error(tag.failure);
  say(`${name} is on origin`);
}
type ClaudeRecord = { scope: string; projectPath?: string; version: string };
/** Scopes whose install record belongs to one project; `claude plugin update` finds that record from the cwd. */
const PROJECT_SCOPES = ['project', 'local'];
const recordKey = (r: ClaudeRecord) => `${r.scope} ${r.projectPath ?? ''}`;
const recordName = (r: ClaudeRecord) => r.projectPath ? `${r.scope} ${r.projectPath}` : r.scope;
/** One entry per install record of the plugin: user, and each project or local install. */
function claudeRecords(): ClaudeRecord[] {
  return (JSON.parse(run('claude', ['plugin', 'list', '--json'])) as (ClaudeRecord & { id: string })[]).filter(p => p.id === PLUGIN);
}
/** Moves every Claude Code install record of the plugin, each with its own scope and, for a project or local record, from its project. A record whose project is gone is skipped and named. */
function updateClaude(version: string): void {
  const live: ClaudeRecord[] = [];
  for (const record of claudeRecords()) {
    if (!['user', ...PROJECT_SCOPES].includes(record.scope)) throw new Error(`Claude Code has ${PLUGIN} in ${recordName(record)}, a scope this release does not update`);
    if (PROJECT_SCOPES.includes(record.scope) && !existsSync(record.projectPath ?? '')) say(`Claude Code ${PLUGIN} (${recordName(record)}) skipped: the project no longer exists`);
    else live.push(record);
  }
  if (live.length === 0) throw new Error(`Claude Code reports ${PLUGIN} not installed`);
  const behind = live.filter(r => r.version !== version);
  if (behind.length > 0) {
    run('claude', ['plugin', 'marketplace', 'update', MARKETPLACE]);
    for (const record of behind) run('claude', ['plugin', 'update', PLUGIN, '--scope', record.scope], PROJECT_SCOPES.includes(record.scope) ? record.projectPath : undefined);
  }
  const after = new Map(claudeRecords().map(r => [recordKey(r), r.version]));
  for (const record of live) {
    const installed = after.get(recordKey(record));
    if (installed !== version) throw new Error(`Claude Code reports ${PLUGIN} ${installed ?? 'not installed'} (${recordName(record)}), not ${version}`);
    say(`Claude Code on ${PLUGIN} ${version} (${recordName(record)})`);
  }
}
function codexVersion(): string | null {
  return (JSON.parse(run('codex', ['plugin', 'list', '--json'])) as { installed: { pluginId: string; version: string }[] }).installed.find(p => p.pluginId === PLUGIN)?.version ?? null;
}
function codexMarketplace(): boolean {
  return (JSON.parse(run('codex', ['plugin', 'marketplace', 'list', '--json'])) as { marketplaces: { name: string }[] }).marketplaces.some(m => m.name === MARKETPLACE);
}
/** Codex pins its marketplace to a tag, so a version moves by remove, remove, add at the tag, add. A step an interrupted run already undid is skipped, and the first backup of config.toml is kept. */
function updateCodex(version: string, home: string): void {
  const before = codexVersion();
  if (before === version) { say(`Codex on ${PLUGIN} ${version}`); return; }
  const config = join(home, '.codex', 'config.toml');
  const backup = `${config}.pre-${version}`;
  if (existsSync(config) && !existsSync(backup)) copyFileSync(config, backup);
  try {
    if (before !== null) run('codex', ['plugin', 'remove', PLUGIN]);
    if (codexMarketplace()) run('codex', ['plugin', 'marketplace', 'remove', MARKETPLACE]);
    run('codex', ['plugin', 'marketplace', 'add', 'byvict/pstack-vic', '--ref', `v${version}`]);
    run('codex', ['plugin', 'add', PLUGIN]);
    const installed = codexVersion();
    if (installed !== version) throw new Error(`Codex reports ${PLUGIN} ${installed ?? 'not installed'}, not ${version}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const wayBack = existsSync(backup) ? `, or go back to the previous Codex setup with:\ncp ~/.codex/config.toml.pre-${version} ~/.codex/config.toml && codex plugin add ${PLUGIN}` : '';
    throw new Error(`${message}\nThe Codex swap did not finish. Run this script again to finish it${wayBack}`);
  }
  say(`Codex on ${PLUGIN} ${version}`);
}
function main(): void {
  const version = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;
  requireTaggedTrunk(version);
  updateClaude(version);
  updateCodex(version, homedir());
}
try { main(); }
catch (error) { process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n'); process.exitCode = 1; }
