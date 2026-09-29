import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { assertDefaultConfig } from './config.ts';

export const JOBS = ['sweep', 'raiz'] as const;
export type Job = typeof JOBS[number];
export interface JobOptions { pluginDir: string; configFile: string; intervalMinutes: number; logDirectory: string }
export function label(job: Job): string { return `com.pstack.converge-${job}`; }
function xml(text: string): string { return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
/** A zsh double-quoted word: only these four characters stay special inside the quotes. */
function quoted(text: string): string { return `"${text.replace(/[\\"$`]/g, '\\$&')}"`; }
/** A login shell, so nvm's node, gh and the parent CLI resolve as in Victor's terminal, and ~/.zshenv exports the parent's credential. */
export function plist(job: Job, options: JobOptions): string {
  const script = `exec node ${quoted(join(options.pluginDir, 'skills/poteto-mode/scripts/converge/converge-local'))} tick --job ${job} --config ${quoted(options.configFile)}`;
  const log = join(options.logDirectory, `pstack-converge-${job}.log`);
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">', '<plist version="1.0">', '<dict>',
    `  <key>Label</key><string>${label(job)}</string>`,
    `  <key>ProgramArguments</key><array><string>/bin/zsh</string><string>-lc</string><string>${xml(script)}</string></array>`,
    `  <key>StartInterval</key><integer>${options.intervalMinutes * 60}</integer>`,
    '  <key>RunAtLoad</key><true/>',
    `  <key>StandardOutPath</key><string>${xml(log)}</string>`,
    `  <key>StandardErrorPath</key><string>${xml(log)}</string>`,
    '</dict>', '</plist>', ''].join('\n');
}
export function plistPath(job: Job, home = homedir()): string { return join(home, 'Library', 'LaunchAgents', `${label(job)}.plist`); }
function launchctl(args: string[]): { status: number | null; output: string } {
  const result = spawnSync('launchctl', args, { encoding: 'utf8' });
  return { status: result.status, output: (result.stdout ?? '') + (result.stderr ?? '') };
}
function domain(): string { return `gui/${process.getuid ? process.getuid() : 501}`; }
/** Writes both plists and (re)loads them into the user's launchd domain, only from the default configuration; the log directory must exist for launchd to open the log. */
export function install(options: JobOptions, home = homedir()): { written: string[]; loaded: string[] } {
  assertDefaultConfig(options.configFile, home);
  const written: string[] = [];
  const loaded: string[] = [];
  mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
  mkdirSync(options.logDirectory, { recursive: true });
  for (const job of JOBS) {
    const path = plistPath(job, home);
    writeFileSync(path, plist(job, options), { mode: 0o644 });
    written.push(path);
    launchctl(['bootout', `${domain()}/${label(job)}`]);
    const result = launchctl(['bootstrap', domain(), path]);
    if (result.status !== 0) throw new Error(`launchctl bootstrap failed for ${label(job)}: ${result.output.trim()}`);
    loaded.push(label(job));
  }
  return { written, loaded };
}
export function uninstall(home = homedir()): string[] {
  const removed: string[] = [];
  for (const job of JOBS) {
    launchctl(['bootout', `${domain()}/${label(job)}`]);
    rmSync(plistPath(job, home), { force: true });
    removed.push(label(job));
  }
  return removed;
}
