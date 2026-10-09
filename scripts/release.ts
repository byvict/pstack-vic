// pstack-vic's release on the operator's Mac: moves Claude Code and Codex to the version CI tagged, then removes the Claude Code records whose project is gone. Run it in the main checkout after `git pull --ff-only`. Every step reads what is already done before it acts, so a second run is safe.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const PLUGIN = 'pstack@pstack-vic';
const MARKETPLACE = 'pstack-vic';
/** `git ls-remote --exit-code` when no ref matches. */
const NO_MATCHING_REF = 2;

function say(line: string): void { process.stdout.write(line + '\n'); }
function attempt(binary: string, args: string[], cwd?: string, env = process.env): { status: number | null; stdout: string; failure: string } {
  const result = spawnSync(binary, args, { cwd, env, encoding: 'utf8', timeout: 300_000 });
  return { status: result.error ? null : result.status, stdout: result.stdout ?? '', failure: `${binary} ${args.join(' ')} failed: ${(result.stderr || result.error?.message || `exit ${result.status}`).trim()}` };
}
function run(binary: string, args: string[], cwd?: string, env = process.env): string {
  const result = attempt(binary, args, cwd, env);
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
/** The main checkout of a linked worktree, read from the worktree's `.git` file (`gitdir: <main>/.git/worktrees/<name>`); undefined for any other folder. */
function mainCheckoutOf(path: string): string | undefined {
  try {
    const [main, name] = readFileSync(join(path, '.git'), 'utf8').trim().replace(/^gitdir: /, '').split('/.git/worktrees/');
    return name === undefined ? undefined : main;
  } catch { return undefined; }
}
/** Moves every Claude Code install record of the plugin, each with its own scope and, for a project or local record, from its project, and returns the records whose project is gone, for `removeGone`. A behind local record of a linked worktree is named and left when its main checkout has a record of its own: a session in the worktree loads the main checkout's local record, then its project record, and the worktree's own only without both (measured on Claude Code 2.1.293 and 2.1.295), and from the worktree `plugin update --scope local` moves the main checkout's local record. */
function updateClaude(version: string): ClaudeRecord[] {
  const records = claudeRecords();
  const live: ClaudeRecord[] = [];
  const gone: ClaudeRecord[] = [];
  for (const record of records) {
    if (!['user', ...PROJECT_SCOPES].includes(record.scope)) throw new Error(`Claude Code has ${PLUGIN} in ${recordName(record)}, a scope this release does not update`);
    const main = record.scope === 'local' ? mainCheckoutOf(record.projectPath ?? '') : undefined;
    if (PROJECT_SCOPES.includes(record.scope) && !existsSync(record.projectPath ?? '')) gone.push(record);
    else if (record.version !== version && main !== undefined && records.some(r => PROJECT_SCOPES.includes(r.scope) && r.projectPath === main)) say(`Claude Code ${PLUGIN} (${recordName(record)}) stays on ${record.version}: a session in this linked worktree loads the main checkout's record`);
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
  return gone;
}
/** Removes the records whose project is gone. `plugin uninstall --scope <scope>` removes the record keyed by its cwd and also clears the plugin from the settings of the repository holding that cwd, which for a folder inside a checkout is that checkout's (measured on 2.1.295). So each removal runs from a fresh repository made at the gone path, and the folders made for it are deleted afterwards. */
function removeGone(gone: ClaudeRecord[]): void {
  for (const record of gone) {
    const path = record.projectPath ?? '';
    let made = path;
    while (!existsSync(dirname(made))) made = dirname(made);
    mkdirSync(made);
    try {
      mkdirSync(path, { recursive: true });
      run('git', ['init', '--quiet', path]);
      run('claude', ['plugin', 'uninstall', PLUGIN, '--scope', record.scope, '--keep-data'], path);
    } finally {
      rmSync(made, { recursive: true, force: true });
    }
    say(`Claude Code ${PLUGIN} (${recordName(record)}) removed: the project no longer exists`);
  }
  if (gone.length === 0) return;
  const left = new Set(claudeRecords().map(recordKey));
  for (const record of gone) if (left.has(recordKey(record))) throw new Error(`Claude Code still has ${PLUGIN} (${recordName(record)}) after its removal`);
}
function codexVersion(cwd: string, env: NodeJS.ProcessEnv): string | null {
  return (JSON.parse(run('codex', ['plugin', 'list', '--json'], cwd, env)) as { installed: { pluginId: string; version: string }[] }).installed.find(p => p.pluginId === PLUGIN)?.version ?? null;
}
function codexMarketplace(home: string): { root: string } | undefined {
  return (JSON.parse(run('codex', ['plugin', 'marketplace', 'list', '--json'], home)) as { marketplaces: { name: string; root: string }[] }).marketplaces.find(m => m.name === MARKETPLACE);
}
/** Install against the shared cache from a disposable config home. Only marketplace commands may write the real config, so plugin remove/add never delete or enable user activation, even if this process is killed. */
function updateCodex(version: string, home: string): void {
  const configHome = process.env.CODEX_HOME || join(home, '.codex');
  const config = join(configHome, 'config.toml');
  const backup = `${config}.pre-${version}`;
  const installer = realpathSync(mkdtempSync(join(tmpdir(), 'pstack-codex-release-')));
  const env = { ...process.env, CODEX_HOME: installer };
  const cache = join(configHome, 'plugins');
  mkdirSync(cache, { recursive: true });
  symlinkSync(cache, join(installer, 'plugins'), 'dir');
  const selectSource = (root: string) => writeFileSync(join(installer, 'config.toml'), `[marketplaces.${MARKETPLACE}]\nsource_type = "local"\nsource = ${JSON.stringify(root)}\n\n[plugins."${PLUGIN}"]\nenabled = true\n`);
  try {
    const marketplace = codexMarketplace(home);
    const root = marketplace?.root ?? join(configHome, '.tmp', 'marketplaces', MARKETPLACE);
    selectSource(root);
    const before = existsSync(root) ? codexVersion(installer, env) : null;
    if (before === version) { say(`Codex on ${PLUGIN} ${version}`); return; }
    if (existsSync(config) && !existsSync(backup)) copyFileSync(config, backup);
    if (before !== null) run('codex', ['plugin', 'remove', PLUGIN], installer, env);
    if (marketplace || existsSync(root)) run('codex', ['plugin', 'marketplace', 'remove', MARKETPLACE], home);
    run('codex', ['plugin', 'marketplace', 'add', 'byvict/pstack-vic', '--ref', `v${version}`], home);
    const after = codexMarketplace(home);
    if (!after) throw new Error(`Codex reports marketplace ${MARKETPLACE} not registered`);
    selectSource(after.root);
    run('codex', ['plugin', 'add', PLUGIN], installer, env);
    const installed = codexVersion(installer, env);
    if (installed !== version) throw new Error(`Codex reports ${PLUGIN} ${installed ?? 'not installed'}, not ${version}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const wayBack = existsSync(backup) ? `; previous Codex configuration: ${backup}` : '';
    throw new Error(`${message}\nThe Codex swap did not finish. Run this script again to finish it${wayBack}`);
  } finally {
    rmSync(installer, { recursive: true, force: true });
  }
  say(`Codex on ${PLUGIN} ${version}`);
}
function main(): void {
  const version = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;
  requireTaggedTrunk(version);
  const gone = updateClaude(version);
  updateCodex(version, homedir());
  removeGone(gone);
}
try { main(); }
catch (error) { process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n'); process.exitCode = 1; }
