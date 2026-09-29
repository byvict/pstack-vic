// pstack-vic's release after a merge, run by the converge daemon's sweep on each new trunk commit (`postMerge` in .cursor/converge.json) in a detached worktree of that commit. Every step reads what is already done before it acts, so a second run is safe.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** sysexits' EX_TEMPFAIL: the daemon runs this commit again on its next tick. */
const TEMPFAIL = 75;
const PLUGIN = 'pstack@pstack-vic';
const MARKETPLACE = 'pstack-vic';
const SWEEP = 'com.pstack.converge-sweep';
const RAIZ = 'com.pstack.converge-raiz';
const JOBS = [SWEEP, RAIZ, 'com.pstack.converge-watch'];

function say(line: string): void { process.stdout.write(line + '\n'); }
function run(binary: string, args: string[]): string {
  const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 300_000 });
  if (result.error || result.status !== 0) throw new Error(`${binary} ${args.join(' ')} failed: ${(result.stderr || result.error?.message || `exit ${result.status}`).trim()}`);
  return result.stdout;
}
/** Tags the commit `v<version>` and pushes only that tag, unless origin has it already; a local tag on another commit refuses. */
function tag(version: string, commit: string): void {
  const name = `v${version}`;
  if (run('git', ['ls-remote', '--tags', 'origin', `refs/tags/${name}`]).trim()) { say(`${name} is already on origin`); return; }
  const local = spawnSync('git', ['rev-parse', '-q', '--verify', `refs/tags/${name}^{commit}`], { encoding: 'utf8' });
  if (local.status === 0 && local.stdout.trim() !== commit) throw new Error(`local tag ${name} points at ${local.stdout.trim()}, not ${commit}`);
  if (local.status !== 0) run('git', ['tag', name, commit]);
  run('git', ['push', 'origin', `refs/tags/${name}`]);
  say(`pushed ${name} at ${commit}`);
}
interface ClaudePlugin { id: string; version: string; installPath: string }
function claudePlugin(): ClaudePlugin | undefined { return (JSON.parse(run('claude', ['plugin', 'list', '--json'])) as ClaudePlugin[]).find(p => p.id === PLUGIN); }
/** Returns the version's install path, which holds the converge-local the jobs move to. */
function updateClaude(version: string): string {
  let plugin = claudePlugin();
  if (plugin?.version !== version) {
    run('claude', ['plugin', 'marketplace', 'update', MARKETPLACE]);
    run('claude', ['plugin', 'update', PLUGIN]);
    plugin = claudePlugin();
  }
  if (plugin?.version !== version) throw new Error(`Claude Code reports ${PLUGIN} ${plugin?.version ?? 'not installed'}, not ${version}`);
  say(`Claude Code on ${PLUGIN} ${version}`);
  return plugin.installPath;
}
function codexVersion(): string | null {
  return (JSON.parse(run('codex', ['plugin', 'list', '--json'])) as { installed: { pluginId: string; version: string }[] }).installed.find(p => p.pluginId === PLUGIN)?.version ?? null;
}
function codexMarketplace(): boolean {
  return (JSON.parse(run('codex', ['plugin', 'marketplace', 'list', '--json'])) as { marketplaces: { name: string }[] }).marketplaces.some(m => m.name === MARKETPLACE);
}
/** Codex pins its marketplace to a tag, so a version moves by remove, remove, add at the tag, add. A step an interrupted run already undid is skipped, and the first backup of config.toml is kept. */
function updateCodex(version: string, home: string): void {
  if (codexVersion() !== version) {
    const config = join(home, '.codex', 'config.toml');
    const backup = `${config}.pre-${version}`;
    if (existsSync(config) && !existsSync(backup)) copyFileSync(config, backup);
    if (codexVersion() !== null) run('codex', ['plugin', 'remove', PLUGIN]);
    if (codexMarketplace()) run('codex', ['plugin', 'marketplace', 'remove', MARKETPLACE]);
    run('codex', ['plugin', 'marketplace', 'add', 'byvict/pstack-vic', '--ref', `v${version}`]);
    run('codex', ['plugin', 'add', PLUGIN]);
  }
  const installed = codexVersion();
  if (installed !== version) throw new Error(`Codex reports ${PLUGIN} ${installed ?? 'not installed'}, not ${version}`);
  say(`Codex on ${PLUGIN} ${version}`);
}
function job(label: string): { loaded: boolean; running: boolean; listing: string } {
  const result = spawnSync('launchctl', ['list', label], { encoding: 'utf8' });
  return { loaded: result.status === 0, running: result.status === 0 && /"PID" = \d+;/.test(result.stdout), listing: result.stdout ?? '' };
}
/** The reinstall boots out the sweep job that runs this script, so it runs detached, through `install --when-idle`, and this run defers; the next run finds the three jobs loaded from the version and ends the release. */
function reinstall(installPath: string, home: string): number {
  if (!job(SWEEP).loaded) { say('no converge daemon is loaded; nothing to reinstall'); return 0; }
  const script = join(installPath, 'skills/poteto-mode/scripts/converge/converge-local');
  if (JOBS.every(label => job(label).listing.includes(`"${script}"`))) { say(`the converge daemon runs ${script}`); return 0; }
  if (job(RAIZ).running) { say('a Raiz is running; the reinstall waits for a later tick'); return TEMPFAIL; }
  const directory = join(home, 'Library', 'Logs');
  mkdirSync(directory, { recursive: true });
  const logFile = join(directory, 'pstack-after-merge.log');
  const log = openSync(logFile, 'a');
  try { spawn(process.execPath, [script, 'install', '--when-idle'], { detached: true, stdio: ['ignore', log, log] }).unref(); }
  finally { closeSync(log); }
  say(`started ${script} install --when-idle (log ${logFile}); the next run confirms the jobs`);
  return TEMPFAIL;
}
function main(): number {
  const version = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;
  const commit = run('git', ['rev-parse', 'HEAD']).trim();
  tag(version, commit);
  const tip = run('git', ['ls-remote', 'origin', 'refs/heads/main']).split(/\s/)[0];
  if (tip !== commit) { say(`${commit} is not the trunk tip ${tip}; the tip's own run moves the plugin`); return 0; }
  const installPath = updateClaude(version);
  updateCodex(version, homedir());
  return reinstall(installPath, homedir());
}
try { process.exitCode = main(); }
catch (error) { process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n'); process.exitCode = 1; }
