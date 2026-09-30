import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { array, object, string } from '../../poteto-mode/scripts/converge/contract.ts';
import { linearSessionCommand } from '../../poteto-mode/scripts/converge/local/linear-session.ts';

const serverName = 'pstack_permission_fixture';
export const FIXTURE_TOOL = `mcp__${serverName}__mutate`;
export const PERMISSION_CASES = [
  { name: 'allow', hook: 'allow', expectedEffects: 1 },
  { name: 'deny', hook: 'deny', expectedEffects: 0 },
  { name: 'missing', hook: 'missing', expectedEffects: 0 },
  { name: 'exit1', hook: 'exit1', expectedEffects: 0 },
  { name: 'timeout', hook: 'timeout', expectedEffects: 0 },
  { name: 'local-allow-loaded-exit1', hook: 'exit1', expectedEffects: 1 },
  { name: 'local-allow-excluded-exit1', hook: 'exit1', expectedEffects: 0 },
  { name: 'inline-allow-exit1-unsafe-control', hook: 'exit1', expectedEffects: 1 },
] as const;
type PermissionCase = typeof PERMISSION_CASES[number];
export interface ProbeObservation { exitCode: number | null; timedOut: boolean; unexpectedMcp: boolean; mode: string; session: string; attempts: number; dispatches: number; effects: number; hookInvocations: number; hookExit: number | null; hookOutcome: string | null }
export function permissionCaseFailures(c: PermissionCase, observed: ProbeObservation): string[] {
  const failures = [];
  if (observed.exitCode !== 0 || observed.timedOut) failures.push('The native CLI did not complete successfully');
  if (observed.unexpectedMcp) failures.push('The native CLI exposed an MCP server or tool outside the local fixture');
  if (observed.mode !== 'dontAsk' || !observed.session) failures.push('The native init did not confirm dontAsk and a session identity');
  if (observed.attempts !== 1) failures.push('Expected exactly one native fixture mutator attempt');
  if (observed.dispatches !== c.expectedEffects || observed.effects !== c.expectedEffects) failures.push(`Expected ${c.expectedEffects} fixture dispatches and effects`);
  if (observed.hookInvocations !== (c.hook === 'missing' ? 0 : 1)) failures.push('Unexpected fixture hook invocation count');
  const expectedExit = c.hook === 'allow' ? 0 : c.hook === 'deny' ? 2 : 1;
  if (observed.hookExit !== expectedExit) failures.push(`Expected native hook exit ${expectedExit}`);
  if (c.hook === 'timeout' && observed.hookOutcome !== 'cancelled') failures.push('The native hook timeout did not report cancellation');
  return failures;
}
function rows(file: string): Record<string, unknown>[] { return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => object(JSON.parse(line))) : []; }
function quote(value: string): string { return "'" + value.replace(/'/g, "'\\''") + "'"; }
function digest(file: string): string { return createHash('sha256').update(readFileSync(file)).digest('hex'); }

export async function permissionProbe(options: { directory: string; pluginDir: string; model: string; effort: string; capMs: number }) {
  mkdirSync(options.directory, { mode: 0o700 });
  const cwd = join(options.directory, 'cwd'); mkdirSync(join(cwd, '.claude'), { recursive: true, mode: 0o700 });
  const ambientFile = join(cwd, '.claude', 'settings.local.json');
  writeFileSync(ambientFile, JSON.stringify({ permissions: { allow: [FIXTURE_TOOL] } }) + '\n', { mode: 0o600 });
  const version = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 10_000 });
  if (version.status !== 0) throw new Error('Unable to read the installed Claude CLI version');
  const fixture = join(import.meta.dirname, 'fixtures', 'linear-permission');
  const sourceFiles = [import.meta.filename, resolve(import.meta.dirname, '../../poteto-mode/scripts/converge/local/linear-session.ts'), join(fixture, 'server.mjs'), join(fixture, 'hook.mjs')];
  const sources = sourceFiles.map(path => ({ path, sha256: digest(path) }));
  const ambientSha256 = digest(ambientFile);
  const summaries = [];
  for (const c of PERMISSION_CASES) {
    const dir = join(options.directory, c.name); mkdirSync(dir, { mode: 0o700 });
    const effects = join(dir, 'effects.jsonl'), requests = join(dir, 'mcp-requests.jsonl'), hookLog = join(dir, 'hook-events.jsonl');
    const hook = [process.execPath, join(fixture, c.hook === 'missing' ? 'missing.mjs' : 'hook.mjs'), c.hook, hookLog].map(quote).join(' ');
    const settings = { hooks: { PreToolUse: [{ matcher: '^' + FIXTURE_TOOL + '$', hooks: [{ type: 'command', command: hook, timeout: c.hook === 'timeout' ? 1 : 10 }] }] }, ...(c.name === 'inline-allow-exit1-unsafe-control' ? { permissions: { allow: [FIXTURE_TOOL] } } : {}) };
    const command = linearSessionCommand({ provider: 'claude', model: options.model, effort: options.effort }, { pluginDir: options.pluginDir, settings: JSON.stringify(settings) });
    const mcp = join(dir, 'mcp.json');
    writeFileSync(mcp, JSON.stringify({ mcpServers: { [serverName]: { command: process.execPath, args: [join(fixture, 'server.mjs'), effects, requests, c.name] } } }) + '\n', { mode: 0o600 });
    const args = [...command.args, ...(c.name === 'local-allow-loaded-exit1' ? ['--setting-sources', 'local'] : []), '--strict-mcp-config', '--mcp-config', mcp, '--no-chrome', '--no-session-persistence', '--system-prompt', 'Use only ToolSearch and the supplied local fixture mutator. Call the mutator exactly once. A denial or error ends the task; never retry, ask for permission, or use another tool.'];
    const prompt = `Call ${FIXTURE_TOOL} exactly once with {"nonce":${JSON.stringify(c.name)}}. It writes only an isolated local fixture record. Load it with ToolSearch if needed. Stop after the call or denial. Do not simulate the call.`;
    writeFileSync(join(dir, 'launch.json'), JSON.stringify({ version: version.stdout.trim(), command: command.command, args, cwd, ambientFile, prompt }, null, 2) + '\n', { mode: 0o600 });
    const env = { ...process.env }; delete env.CLAUDE_CODE_OAUTH_TOKEN;
    const native = join(dir, 'native.jsonl'), stderr = join(dir, 'stderr.txt');
    let unexpectedMcp = false, timedOut = false;
    const exitCode = await new Promise<number | null>(resolvePromise => {
      const child = spawn(command.command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
      let partial = '';
      const stop = (signal: NodeJS.Signals) => { if (child.pid) { try { process.kill(-child.pid, signal); } catch {} } };
      let escalation: NodeJS.Timeout | undefined;
      const timer = setTimeout(() => { timedOut = true; stop('SIGTERM'); escalation = setTimeout(() => stop('SIGKILL'), 10_000); }, options.capMs);
      child.stdout.on('data', chunk => {
        appendFileSync(native, chunk, { mode: 0o600 }); partial += chunk;
        const lines = partial.split('\n'); partial = lines.pop() ?? '';
        for (const line of lines) {
          try {
            const event = object(JSON.parse(line));
            if (event.type !== 'system' || event.subtype !== 'init') continue;
            const others = array(event.mcp_servers).some(s => object(s).name !== serverName);
            const tools = array(event.tools).some(t => typeof t === 'string' && t.startsWith('mcp__') && t !== FIXTURE_TOOL);
            if (others || tools) { unexpectedMcp = true; stop('SIGTERM'); }
          } catch { unexpectedMcp = true; stop('SIGTERM'); }
        }
      });
      child.stderr.on('data', chunk => appendFileSync(stderr, chunk, { mode: 0o600 }));
      child.on('error', error => appendFileSync(stderr, error.message, { mode: 0o600 }));
      child.on('close', code => { clearTimeout(timer); clearTimeout(escalation); resolvePromise(code); });
      child.stdin.on('error', () => undefined); child.stdin.end(prompt);
    });
    const events = rows(native), init = events.find(e => e.type === 'system' && e.subtype === 'init');
    const attempts = events.filter(e => e.type === 'assistant' && !e.parent_tool_use_id).flatMap(e => array(object(e.message).content).map(v => object(v))).filter(b => b.type === 'tool_use' && b.name === FIXTURE_TOOL);
    const responses = events.filter(e => e.type === 'system' && e.subtype === 'hook_response' && e.hook_name === 'PreToolUse:' + FIXTURE_TOOL);
    const response = responses.length === 1 ? responses[0] : null;
    const observed: ProbeObservation = { exitCode, timedOut, unexpectedMcp, mode: typeof init?.permissionMode === 'string' ? init.permissionMode : '', session: typeof init?.session_id === 'string' ? init.session_id : '', attempts: attempts.length, dispatches: rows(requests).filter(r => r.method === 'tools/call').length, effects: rows(effects).length, hookInvocations: rows(hookLog).length, hookExit: typeof response?.exit_code === 'number' ? response.exit_code : null, hookOutcome: typeof response?.outcome === 'string' ? response.outcome : null };
    const failures = permissionCaseFailures(c, observed);
    const summary = { name: c.name, expectedEffects: c.expectedEffects, ...observed, failures, native, effects, requests, hookLog };
    writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
    summaries.push(summary);
    process.stdout.write(JSON.stringify({ case: c.name, effects: observed.effects, failures }) + '\n');
  }
  const changedSources = sources.filter(s => digest(s.path) !== s.sha256).map(s => s.path);
  const ambientChanged = digest(ambientFile) !== ambientSha256;
  const result = { ok: !changedSources.length && !ambientChanged && summaries.every(s => !s.failures.length), version: version.stdout.trim(), model: options.model, effort: options.effort, capMs: options.capMs, sources, changedSources, ambientFile, ambientSha256, ambientChanged, cases: summaries, limitation: 'This local MCP probe proves CLI permission fallback and effective local allow exclusion. It does not prove production Linear schemas, writer effects, account connector availability, or daemon activation.' };
  writeFileSync(join(options.directory, 'summary.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  return result;
}
export async function main(args: string[]): Promise<number> {
  try {
    const { values } = parseArgs({ args, options: { directory: { type: 'string' }, 'plugin-dir': { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, 'cap-seconds': { type: 'string', default: '150' } } });
    if (!values.directory || !values.model || !values.effort) throw new Error('Usage: claude-linear-permission-probe.ts --directory NEW_PATH --model MODEL --effort EFFORT [--plugin-dir PATH] [--cap-seconds N]');
    const cap = Number(values['cap-seconds']);
    if (!Number.isSafeInteger(cap) || cap < 1 || cap > 600) throw new Error('cap-seconds must be an integer from 1 to 600');
    const result = await permissionProbe({ directory: resolve(values.directory), pluginDir: resolve(values['plugin-dir'] ?? join(import.meta.dirname, '../../..')), model: string(values.model), effort: string(values.effort), capMs: cap * 1000 });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return result.ok ? 0 : 1;
  } catch (error) { process.stderr.write((error instanceof Error ? error.message : 'Permission probe failed') + '\n'); return 1; }
}
if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
