import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

export interface Notice { title: string; subtitle: string; body: string }
export const NOTIFY_TIMEOUT_MS = 10_000;
type NotifyFailure = string;
export function appleScriptString(text: string): string { return `"${text.replace(/[\\"]/g, '\\$&')}"`; }
export function notify(notice: Notice, options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): NotifyFailure | null {
  const q = appleScriptString;
  const script = `display notification ${q(notice.body)} with title ${q(notice.title)} subtitle ${q(notice.subtitle)} sound name "Basso"`;
  const ms = options.timeoutMs ?? NOTIFY_TIMEOUT_MS;
  let result: SpawnSyncReturns<string>;
  try { result = spawnSync('osascript', ['-e', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: ms, killSignal: 'SIGKILL', env: options.env ?? process.env }); }
  catch (error) { return `osascript did not start: ${error instanceof Error ? error.message : String(error)}`; }
  if (result.error) return (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? `osascript did not finish within ${ms / 1000} s` : `osascript did not start: ${result.error.message}`;
  if (result.signal) return `osascript ended by ${result.signal}`;
  if (result.status !== 0) return `osascript exited ${result.status}${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}`;
  return null;
}
