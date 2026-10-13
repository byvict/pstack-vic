// The host CLI calls that release.ts and pstack.ts share: running claude, codex and git, reading Claude Code's install records of the plugin, and removing a record whose project folder is gone.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const PLUGIN = 'pstack@pstack-vic';
export const MARKETPLACE = 'pstack-vic';
export const REPOSITORY = 'byvict/pstack-vic';

export function say(line: string): void { process.stdout.write(line + '\n'); }
export function attempt(binary: string, args: string[], cwd?: string, env = process.env): { status: number | null; stdout: string; failure: string } {
  const result = spawnSync(binary, args, { cwd, env, encoding: 'utf8', timeout: 300_000 });
  return { status: result.error ? null : result.status, stdout: result.stdout ?? '', failure: `${binary} ${args.join(' ')} failed: ${(result.stderr || result.error?.message || `exit ${result.status}`).trim()}` };
}
export function run(binary: string, args: string[], cwd?: string, env = process.env): string {
  const result = attempt(binary, args, cwd, env);
  if (result.status !== 0) throw new Error(result.failure);
  return result.stdout;
}
/** Whether a CLI is on PATH: spawning a missing binary fails before it runs. */
export function hasCli(binary: string): boolean {
  return !spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 60_000 }).error;
}

export type ClaudeRecord = { scope: string; projectPath?: string; version: string; enabled?: boolean };
/** Scopes whose install record belongs to one project; `claude plugin update` finds that record from the cwd. */
export const PROJECT_SCOPES = ['project', 'local'];
export const recordKey = (r: ClaudeRecord) => `${r.scope} ${r.projectPath ?? ''}`;
export const recordName = (r: ClaudeRecord) => r.projectPath ? `${r.scope} ${r.projectPath}` : r.scope;
/** One entry per install record of the plugin: user, and each project or local install. */
export function claudeRecords(): ClaudeRecord[] {
  return (JSON.parse(run('claude', ['plugin', 'list', '--json'])) as (ClaudeRecord & { id: string })[]).filter(p => p.id === PLUGIN);
}
/** The main checkout of a linked worktree, read from the worktree's `.git` file (`gitdir: <main>/.git/worktrees/<name>`); undefined for any other folder. */
export function mainCheckoutOf(path: string): string | undefined {
  try {
    const [main, name] = readFileSync(join(path, '.git'), 'utf8').trim().replace(/^gitdir: /, '').split('/.git/worktrees/');
    return name === undefined ? undefined : main;
  } catch { return undefined; }
}
/** Removes one record whose project is gone. `plugin uninstall --scope <scope>` removes the record keyed by its cwd and also clears the plugin from the settings of the repository holding that cwd, which for a folder inside a checkout is that checkout's (measured on 2.1.295). So the removal runs from a fresh repository made at the gone path, and the folders made for it are deleted afterwards. */
export function removeGoneRecord(record: ClaudeRecord, keepData: boolean): void {
  const path = record.projectPath ?? '';
  let made = path;
  while (!existsSync(dirname(made))) made = dirname(made);
  mkdirSync(made);
  try {
    mkdirSync(path, { recursive: true });
    run('git', ['init', '--quiet', path]);
    run('claude', ['plugin', 'uninstall', PLUGIN, '--scope', record.scope, ...(keepData ? ['--keep-data'] : [])], path);
  } finally {
    rmSync(made, { recursive: true, force: true });
  }
}

/** Whether a Codex config.toml holds the user's own entry for the plugin: a `[plugins."pstack@pstack-vic"]` table (spaces and a trailing comment allowed), a dotted `plugins."pstack@pstack-vic" = {…}` key, or a `"pstack@pstack-vic" = {…}` key in a `[plugins]` table. `codex plugin add` writes it and `codex plugin remove` deletes it. */
export function codexActivated(text: string): boolean {
  const quoted = `"${PLUGIN}"`;
  let table = '';
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[\s*([^\]\[]+?)\s*\]\s*(?:#.*)?$/.exec(line);
    if (header) {
      table = header[1].replace(/\s*\.\s*/g, '.');
      if (table === `plugins.${quoted}` || table.startsWith(`plugins.${quoted}.`)) return true;
      continue;
    }
    if (/^\s*\[\[/.test(line)) { table = '[array]'; continue; }
    if (table === '' && new RegExp(`^\\s*plugins\\s*\\.\\s*"${PLUGIN}"\\s*[.=]`).test(line)) return true;
    if (table === 'plugins' && new RegExp(`^\\s*"${PLUGIN}"\\s*[.=]`).test(line)) return true;
  }
  return false;
}
