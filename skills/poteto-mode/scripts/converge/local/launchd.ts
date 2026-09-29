import { spawnSync } from 'node:child_process';
import { accessSync, constants, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { assertDefaultConfig } from './config.ts';
import { readLease, releaseLease, takeLease } from './lease.ts';
import { raizLane } from './raiz.ts';
import { wakeDirectory } from './wake.ts';

export const JOBS = ['sweep', 'raiz', 'watch'] as const;
export type Job = typeof JOBS[number];
/** The jobs a wake starts. The watch job rings them on its own interval, so nothing ever waits on it. */
export const WAKEABLE = ['sweep', 'raiz'] as const;
export type Wakeable = typeof WAKEABLE[number];
/** The watch job's interval, whatever `intervalMinutes` says: its reads are conditional, and GitHub counts no 304 against the rate limit. */
export const WATCH_SECONDS = 60;
/** `path` and `nodePath` are the install process's `PATH` and `process.execPath`, passed in so the plist stays a pure function of its options. */
export interface JobOptions { pluginDir: string; configFile: string; intervalMinutes: number; logDirectory: string; stateDirectory: string; path: string; nodePath: string }
export interface InstallOptions extends JobOptions { parent: 'claude' | 'codex'; sheetPath: string }
export function label(job: Job): string { return `com.pstack.converge-${job}`; }
function xml(text: string): string { return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
/** A zsh double-quoted word: only these four characters stay special inside the quotes. */
function quoted(text: string): string { return `"${text.replace(/[\\"$`]/g, '\\$&')}"`; }
/** launchd starts a job with a bare system PATH, and a non-interactive zsh never reads ~/.zshrc, where nvm puts node and claude. So the job carries the install shell's PATH and runs the absolute node. `zsh -c` still reads ~/.zshenv, which exports the parent's credential, and, not being a login shell, skips /etc/zprofile, whose path_helper would move the system directories ahead of the recorded PATH. Besides the interval, `QueueDirectories` starts a wakeable job whenever its wake directory holds a file: `WatchPaths` may miss a modification and `launchctl kickstart` is a no-op on a running job, while a file that lands during a run starts the job once more after it exits. The watch job has no wake directory and runs every `WATCH_SECONDS`. */
export function plist(job: Job, options: JobOptions): string {
  const script = `exec ${quoted(options.nodePath)} ${quoted(join(options.pluginDir, 'skills/poteto-mode/scripts/converge/converge-local'))} tick --job ${job} --config ${quoted(options.configFile)}`;
  const log = join(options.logDirectory, `pstack-converge-${job}.log`);
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">', '<plist version="1.0">', '<dict>',
    `  <key>Label</key><string>${label(job)}</string>`,
    `  <key>ProgramArguments</key><array><string>/bin/zsh</string><string>-c</string><string>${xml(script)}</string></array>`,
    `  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(options.path)}</string></dict>`,
    `  <key>StartInterval</key><integer>${job === 'watch' ? WATCH_SECONDS : options.intervalMinutes * 60}</integer>`,
    ...(job === 'watch' ? [] : [`  <key>QueueDirectories</key><array><string>${xml(wakeDirectory(options.stateDirectory, job))}</string></array>`]),
    '  <key>RunAtLoad</key><true/>',
    `  <key>StandardOutPath</key><string>${xml(log)}</string>`,
    `  <key>StandardErrorPath</key><string>${xml(log)}</string>`,
    '</dict>', '</plist>', ''].join('\n');
}
function executable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch { return false; }
}
/** The names that no absolute directory of `path` holds as an executable file. A relative entry would resolve against launchd's `/`, so it does not count. */
export function missingCommands(path: string, names: string[]): string[] {
  const directories = path.split(delimiter).filter(directory => isAbsolute(directory));
  return names.filter(name => !directories.some(directory => executable(join(directory, name))));
}
export function plistPath(job: Job, home = homedir()): string { return join(home, 'Library', 'LaunchAgents', `${label(job)}.plist`); }
/** The raiz job exits 1 on every tick without a valid `converge raiz` row in the parent's sheet. `sheet` is the sheet's text, or the error reading it threw. */
export function assertRaizRow(sheetPath: string, sheet: string | Error, parent: 'claude' | 'codex'): void {
  try {
    if (sheet instanceof Error) throw sheet;
    raizLane(sheet, parent);
  } catch (error) { throw new Error(`install needs a valid converge raiz row in ${sheetPath} (${(error as Error).message}); run /setup-pstack, then install again`); }
}
function readSheet(file: string): string | Error {
  try { return readFileSync(file, 'utf8'); }
  catch (error) { return error as Error; }
}
export type Launchctl = (args: string[]) => { status: number | null; output: string };
export function launchctl(args: string[]): { status: number | null; output: string } {
  const result = spawnSync('launchctl', args, { encoding: 'utf8' });
  return { status: result.status, output: (result.stdout ?? '') + (result.stderr ?? '') };
}
function domain(): string { return `gui/${process.getuid ? process.getuid() : 501}`; }
/** Writes the three plists and (re)loads them into the user's launchd domain, only from the default configuration, only when gh and the parent CLI are on the PATH the jobs get, and only with a valid `converge raiz` row in the parent's sheet; the log directory must exist for launchd to open the log. `run` replaces launchctl in tests. */
/** What `install` checks before it writes anything, apart so `install --when-idle` checks it before it waits. */
export function assertInstallable(options: InstallOptions, home = homedir()): void {
  assertDefaultConfig(options.configFile, home);
  const missing = missingCommands(options.path, ['gh', options.parent]);
  if (missing.length) throw new Error(`install needs gh and ${options.parent} on the PATH it gives launchd; missing: ${missing.join(', ')}. Run install from a shell where they resolve`);
  assertRaizRow(options.sheetPath, readSheet(options.sheetPath), options.parent);
}
export function install(options: InstallOptions, home = homedir(), run: Launchctl = launchctl): { written: string[]; loaded: string[] } {
  assertInstallable(options, home);
  const written: string[] = [];
  const loaded: string[] = [];
  mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
  mkdirSync(options.logDirectory, { recursive: true });
  // launchd watches the wake directory from the bootstrap on, so it must exist before the job loads.
  for (const job of WAKEABLE) mkdirSync(wakeDirectory(options.stateDirectory, job), { recursive: true, mode: 0o700 });
  for (const job of JOBS) {
    const path = plistPath(job, home);
    writeFileSync(path, plist(job, options), { mode: 0o644 });
    written.push(path);
    run(['bootout', `${domain()}/${label(job)}`]);
    const result = run(['bootstrap', domain(), path]);
    if (result.status !== 0) throw new Error(`launchctl bootstrap failed for ${label(job)}: ${result.output.trim()}`);
    loaded.push(label(job));
  }
  return { written, loaded };
}
/** How long `install --when-idle` waits for the sweep and raiz jobs: a Raiz attempt is capped at two hours. */
export const WHEN_IDLE_HOURS = 3;
const WHEN_IDLE_POLL_MS = 2_000;
/** `launchctl list LABEL` prints `"PID" = N;` only while the job's process runs, and fails for a job that is not loaded. */
export function jobRunning(job: Job, run: Launchctl = launchctl): boolean {
  const result = run(['list', label(job)]);
  return result.status === 0 && /"PID" = \d+;/.test(result.output);
}
/** `install` once neither the sweep nor the raiz job runs, so the bootout kills no tick and no Raiz: it checks install's preconditions, holds `<stateDirectory>/leases/install.json` against a second waiting installer, and polls every two seconds for at most WHEN_IDLE_HOURS. A tick that starts between the last poll and the bootout still dies with it. */
export async function installWhenIdle(options: InstallOptions, home = homedir(), run: Launchctl = launchctl, wait: { capMs?: number; pollMs?: number } = {}): Promise<{ written: string[]; loaded: string[] }> {
  assertInstallable(options, home);
  const lease = join(options.stateDirectory, 'leases', 'install.json');
  const by = `install:${process.pid}`;
  const holder = readLease(lease);
  if (holder && holder.by !== by) throw new Error(`another install --when-idle is waiting: ${holder.by} until ${holder.expiresAt}`);
  takeLease(lease, { by, ttlHours: WHEN_IDLE_HOURS + 1, pid: process.pid });
  try {
    const deadline = Date.now() + (wait.capMs ?? WHEN_IDLE_HOURS * 3_600_000);
    for (let busy = WAKEABLE.filter(job => jobRunning(job, run)); busy.length; busy = WAKEABLE.filter(job => jobRunning(job, run))) {
      if (Date.now() >= deadline) throw new Error(`install --when-idle gave up: ${busy.map(label).join(', ')} still running at the end of the wait`);
      await new Promise(resolve => setTimeout(resolve, wait.pollMs ?? WHEN_IDLE_POLL_MS));
    }
    return install(options, home, run);
  } finally { releaseLease(lease, by); }
}
export function uninstall(home = homedir(), run: Launchctl = launchctl): string[] {
  const removed: string[] = [];
  for (const job of JOBS) {
    run(['bootout', `${domain()}/${label(job)}`]);
    rmSync(plistPath(job, home), { force: true });
    removed.push(label(job));
  }
  return removed;
}
