import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { array, object, string } from '../contract.ts';
import { exitStatus, KILL_GRACE_MS, type RaizLane } from './raiz.ts';

export const LINEAR_PREFIX = 'mcp__claude_ai_Linear__';
export interface NativeCall { id: string; tool: string; args: Record<string, unknown>; result: unknown; error: boolean; line: number; session: string }
export interface LinearTrace { calls: NativeCall[]; tools: string[]; answer: unknown; session: string }
function resultValue(value: unknown): unknown {
  const content = typeof value === 'string' ? value : array(value).filter(v => object(v).type === 'text').map(v => string(object(v).text)).join('\n');
  try { return JSON.parse(content); } catch { return content; }
}
/** Only the CLI's top-level native messages count. Assistant text and nested shell output stay data. */
export function linearTrace(stdout: string): LinearTrace {
  const calls: NativeCall[] = [];
  const pending = new Map<string, Omit<NativeCall, 'result' | 'error'>>();
  let tools: string[] = [], answer: unknown = null, session = '';
  const lines = stdout.split('\n');
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    const event = object(JSON.parse(line), 'Claude native event');
    if (event.type === 'system' && event.subtype === 'init') {
      session = string(event.session_id);
      tools = array(event.tools).map(v => string(v));
    }
    if (event.type === 'result') answer = event.structured_output ?? event.result ?? null;
    if ((event.type !== 'assistant' && event.type !== 'user') || event.parent_tool_use_id) continue;
    const message = object(event.message);
    for (const raw of array(message.content)) {
      const block = object(raw);
      if (event.type === 'assistant' && block.type === 'tool_use' && typeof block.name === 'string' && block.name.startsWith(LINEAR_PREFIX)) {
        const id = string(block.id);
        if (pending.has(id) || calls.some(c => c.id === id)) throw new Error('Duplicate native Linear call identity');
        pending.set(id, { id, tool: block.name, args: object(block.input), line: index + 1, session });
      }
      if (event.type === 'user' && block.type === 'tool_result') {
        const id = string(block.tool_use_id);
        const call = pending.get(id);
        if (!call) continue;
        calls.push({ ...call, result: resultValue(block.content), error: block.is_error === true });
        pending.delete(id);
      }
    }
  }
  for (const call of pending.values()) calls.push({ ...call, result: null, error: true });
  return { calls, tools, answer, session };
}
export interface LinearSession { trace: LinearTrace; logPath: string; exitCode: number | null; timedOut: boolean; parseError: string | null }
export interface LinearSessionInput { lane: RaizLane; checkout: string; pluginDir: string; runDirectory: string; phase: 'read' | 'write'; ledgerFile: string; prompt: string; env?: NodeJS.ProcessEnv; capMs: number }
function quote(value: string): string { return "'" + value.replace(/'/g, "'\\''") + "'"; }
export function linearSessionCommand(lane: RaizLane, options: { pluginDir: string; settings: string }): { command: string; args: string[] } {
  if (lane.provider !== 'claude') throw new Error('Linear native trace and scoped writer are unavailable for this provider');
  return { command: 'claude', args: ['-p', '--model', lane.model, '--effort', lane.effort, '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--plugin-dir', options.pluginDir, '--setting-sources', '', '--output-format', 'stream-json', '--verbose', '--include-hook-events', '--disable-slash-commands', '--tools', 'ToolSearch', '--settings', options.settings] };
}
export async function launchLinearSession(input: LinearSessionInput): Promise<LinearSession> {
  const hook = [process.execPath, join(input.pluginDir, 'skills/poteto-mode/scripts/converge/local/linear-permission.ts'), input.phase, input.ledgerFile].map(quote).join(' ');
  const settings = { hooks: { PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: hook }] }] } };
  const { command, args } = linearSessionCommand(input.lane, { pluginDir: input.pluginDir, settings: JSON.stringify(settings) });
  mkdirSync(input.runDirectory, { recursive: true, mode: 0o700 });
  const logPath = join(input.runDirectory, `${input.phase}.jsonl`);
  writeFileSync(logPath, '', { mode: 0o600 });
  writeFileSync(join(input.runDirectory, `${input.phase}-prompt.txt`), input.prompt, { mode: 0o600 });
  const env = { ...(input.env ?? process.env) };
  // A setup-token grants model access but suppresses the account's existing claude.ai connectors.
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd: input.checkout, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    let escalation: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); escalation = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS); escalation.unref(); }, input.capMs);
    child.stdout.on('data', chunk => { stdout += chunk; appendFileSync(logPath, chunk); });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.on('error', () => undefined);
    child.on('error', error => { stderr += error.message; });
    child.on('close', (code, signal) => {
      clearTimeout(timer); clearTimeout(escalation);
      writeFileSync(join(input.runDirectory, `${input.phase}.stderr`), stderr, { mode: 0o600 });
      let trace: LinearTrace, parseError: string | null = null;
      try { trace = linearTrace(stdout); }
      catch (error) { parseError = error instanceof Error ? error.message : String(error); trace = { calls: [], tools: [], answer: null, session: '' }; }
      resolve({ trace, logPath, parseError, exitCode: code === null && !signal ? null : exitStatus(code, signal), timedOut });
    });
    child.stdin.end(input.prompt);
  });
}
export function storedLinearCalls(logPaths: string[]): NativeCall[] {
  return logPaths.flatMap(path => { try { return linearTrace(readFileSync(path, 'utf8')).calls; } catch { return []; } });
}
