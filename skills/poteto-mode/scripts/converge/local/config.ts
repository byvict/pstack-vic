import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { array, object, oneOf, repoName, string } from '../contract.ts';
import { PLUGIN_ROOT } from '../../../../../scripts/model-matrix.ts';

export interface RepoConfig { repo: string; checkout: string }
export interface LocalConfig { file: string; parent: 'claude' | 'codex'; repos: RepoConfig[]; intervalMinutes: number; pluginDir: string; stateDirectory: string; sheetPath: string; logDirectory: string }
export function defaultConfigFile(home = homedir()): string { return join(home, '.config', 'pstack', 'converge-local.json'); }
/** launchd starts the daemon in `/`, so a relative path (or `~`, which JSON never expands) would name a different place there than in a terminal. */
function absolutePath(value: unknown, key: string): string {
  const path = string(value, key);
  if (!isAbsolute(path)) throw new Error(`${key} must be an absolute path: ${path}`);
  return resolve(path);
}
function optionalPath(value: unknown, key: string, fallback: string): string { return value === undefined || value === null ? fallback : absolutePath(value, key); }
/** `sheetPath`, `stateDirectory`, `logDirectory` and `pluginDir` default from the home and the plugin root; the tests set them explicitly. */
export function loadConfig(file: string, home = homedir()): LocalConfig {
  if (!existsSync(file)) throw new Error(`No configuration at ${file}; write it as docs/reference.md describes`);
  const v = object(JSON.parse(readFileSync(file, 'utf8')), 'configuration');
  const parent = oneOf(v.parent, ['claude', 'codex']);
  const repos = array(v.repos).map(raw => {
    const r = object(raw, 'repo');
    const repo = repoName(r.repo);
    const checkout = absolutePath(r.checkout, 'checkout');
    if (!existsSync(join(checkout, '.git'))) throw new Error(`Checkout ${checkout} is not a git repository`);
    return { repo, checkout };
  });
  if (!repos.length) throw new Error('Configuration lists no repository');
  const interval = v.intervalMinutes === undefined ? 10 : v.intervalMinutes;
  if (typeof interval !== 'number' || !Number.isInteger(interval) || interval < 1 || interval > 60) throw new Error('intervalMinutes must be an integer from 1 to 60');
  return { file, parent, repos, intervalMinutes: interval,
    pluginDir: optionalPath(v.pluginDir, 'pluginDir', PLUGIN_ROOT),
    stateDirectory: optionalPath(v.stateDirectory, 'stateDirectory', join(home, 'Library', 'Application Support', 'pstack', 'converge-local')),
    sheetPath: optionalPath(v.sheetPath, 'sheetPath', join(home, parent === 'claude' ? '.claude' : '.codex', 'pstack-models.md')),
    logDirectory: optionalPath(v.logDirectory, 'logDirectory', join(home, 'Library', 'Logs')) };
}
