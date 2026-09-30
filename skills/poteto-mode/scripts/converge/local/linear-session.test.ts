import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchLinearSession, linearSessionCommand } from './linear-session.ts';

test('the native Linear command preserves its descriptor and plugin and fixes permission and transcript flags explicitly', () => {
  const command = linearSessionCommand({ provider: 'claude', model: 'claude-opus-5-5', effort: 'xhigh' }, { pluginDir: '/tmp/plugin with spaces', settings: '{"hooks":{}}' });
  assert.deepEqual(command, { command: 'claude', args: ['-p', '--model', 'claude-opus-5-5', '--effort', 'xhigh', '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--plugin-dir', '/tmp/plugin with spaces', '--setting-sources', '', '--output-format', 'stream-json', '--verbose', '--include-hook-events', '--disable-slash-commands', '--tools', 'ToolSearch', '--settings', '{"hooks":{}}'] });
  assert.throws(() => linearSessionCommand({ provider: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh' }, { pluginDir: '/tmp/plugin', settings: '{}' }), /unavailable for this provider/);
});
test('launch uses the canonical command, sends the prompt on stdin, and removes only the setup token from its environment', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'linear-session-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const binary = join(dir, 'claude'), capture = join(dir, 'capture.json'), run = join(dir, 'run');
  const events = [
    { type: 'system', subtype: 'init', session_id: 'native-session', tools: ['ToolSearch'] },
    { type: 'result', structured_output: { outcome: 'fixture-complete' } },
  ];
  writeFileSync(binary, '#!/usr/bin/env node\n' + `const fs = require('node:fs'); fs.writeFileSync(process.env.PSTACK_SESSION_CAPTURE, JSON.stringify({ args: process.argv.slice(2), prompt: fs.readFileSync(0, 'utf8'), setupToken: Object.hasOwn(process.env, 'CLAUDE_CODE_OAUTH_TOKEN'), retained: process.env.PSTACK_SESSION_RETAINED, apiKeyPresent: Object.hasOwn(process.env, 'ANTHROPIC_API_KEY') })); process.stdout.write(${JSON.stringify(events.map(e => JSON.stringify(e)).join('\n') + '\n')});\n`); chmodSync(binary, 0o700);
  const env = { ...process.env, PATH: dir + ':' + process.env.PATH, CLAUDE_CODE_OAUTH_TOKEN: 'fixture-setup-token', ANTHROPIC_API_KEY: 'fixture-kept-key', PSTACK_SESSION_CAPTURE: capture, PSTACK_SESSION_RETAINED: 'kept' };
  const input = { lane: { provider: 'claude', model: 'fable', effort: 'max' }, checkout: dir, pluginDir: "/tmp/plugin's directory", runDirectory: run, phase: 'write', ledgerFile: join(dir, 'ledger.json'), prompt: 'Read the immutable target.', capMs: 5_000, env } as const;
  const result = await launchLinearSession(input);
  assert.equal(result.exitCode, 0); assert.equal(result.timedOut, false); assert.equal(result.parseError, null);
  assert.equal(result.trace.session, 'native-session'); assert.deepEqual(result.trace.answer, { outcome: 'fixture-complete' });
  const captured = JSON.parse(readFileSync(capture, 'utf8'));
  assert.deepEqual({ prompt: captured.prompt, setupToken: captured.setupToken, retained: captured.retained, apiKeyPresent: captured.apiKeyPresent }, { prompt: input.prompt, setupToken: false, retained: 'kept', apiKeyPresent: true });
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'fixture-setup-token');
  const settings = JSON.parse(captured.args.at(-1));
  assert.deepEqual(Object.keys(settings), ['hooks']);
  assert.equal(settings.hooks.PreToolUse[0].matcher, '.*');
  assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /plugin'\\''s directory\/skills\/poteto-mode\/scripts\/converge\/local\/linear-permission.ts/);
  assert.ok(settings.hooks.PreToolUse[0].hooks[0].command.endsWith(`'write' '${input.ledgerFile}'`));
  assert.deepEqual(captured.args, linearSessionCommand(input.lane, { pluginDir: input.pluginDir, settings: JSON.stringify(settings) }).args);
  assert.equal(readFileSync(join(run, 'write-prompt.txt'), 'utf8'), input.prompt);
});
