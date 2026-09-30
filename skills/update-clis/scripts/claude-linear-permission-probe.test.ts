import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURE_TOOL, PERMISSION_CASES, permissionCaseFailures, type ProbeObservation } from './claude-linear-permission-probe.ts';

const observed: ProbeObservation = { exitCode: 0, timedOut: false, unexpectedMcp: false, mode: 'dontAsk', session: 'native-session', attempts: 1, dispatches: 0, effects: 0, hookInvocations: 1, hookExit: 1, hookOutcome: 'error' };
test('the matrix has positive effects for allowed and effectively loaded rules and zero effects for every isolated hook fault', () => {
  assert.deepEqual(PERMISSION_CASES.map(c => [c.name, c.expectedEffects]), [['allow', 1], ['deny', 0], ['missing', 0], ['exit1', 0], ['timeout', 0], ['local-allow-loaded-exit1', 1], ['local-allow-excluded-exit1', 0], ['inline-allow-exit1-unsafe-control', 1]]);
  assert.deepEqual(permissionCaseFailures(PERMISSION_CASES[3], observed), []);
  assert.deepEqual(permissionCaseFailures(PERMISSION_CASES[5], observed), ['Expected 1 fixture dispatches and effects']);
  assert.deepEqual(permissionCaseFailures(PERMISSION_CASES[6], { ...observed, effects: 1, dispatches: 1 }), ['Expected 0 fixture dispatches and effects']);
});
test('a denial without a native attempt or fault evidence cannot pass, and a leaked remote MCP or timeout fails', () => {
  assert.deepEqual(permissionCaseFailures(PERMISSION_CASES[3], { ...observed, attempts: 0, hookExit: null }), ['Expected exactly one native fixture mutator attempt', 'Expected native hook exit 1']);
  assert.deepEqual(permissionCaseFailures(PERMISSION_CASES[3], { ...observed, unexpectedMcp: true }), ['The native CLI exposed an MCP server or tool outside the local fixture']);
  assert.deepEqual(permissionCaseFailures(PERMISSION_CASES[4], observed), ['The native hook timeout did not report cancellation']);
  assert.deepEqual(permissionCaseFailures(PERMISSION_CASES[3], { ...observed, timedOut: true }), ['The native CLI did not complete successfully']);
});
test('the local fake MCP logs real dispatches and effects, validates its nonce, and exposes only the mutator', t => {
  const dir = mkdtempSync(join(tmpdir(), 'linear-permission-mcp-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const effects = join(dir, 'effects.jsonl'), requests = join(dir, 'requests.jsonl');
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'mutate', arguments: { nonce: 'wrong' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'mutate', arguments: { nonce: 'expected' } } },
  ];
  const run = spawnSync(process.execPath, [join(import.meta.dirname, 'fixtures/linear-permission/server.mjs'), effects, requests, 'expected'], { input: input.map(v => JSON.stringify(v)).join('\n') + '\n', encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const replies = run.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(replies[1].result.tools.map((t: { name: string }) => t.name), ['mutate']);
  assert.equal(replies[2].result.isError, true); assert.equal(replies[3].result.content[0].text, '{"effect":"local-record-appended","nonce":"expected"}');
  assert.equal(readFileSync(effects, 'utf8'), '{"nonce":"expected","requestId":4}\n');
  assert.deepEqual(readFileSync(requests, 'utf8').trim().split('\n').map(line => JSON.parse(line)), input);
});
for (const [behavior, expectedExit] of [['allow', 0], ['deny', 2], ['exit1', 1]] as const) test(`the fixture hook records and returns ${behavior}`, t => {
  const dir = mkdtempSync(join(tmpdir(), 'linear-permission-hook-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'hook.jsonl');
  const input = { tool_name: FIXTURE_TOOL, tool_input: { nonce: behavior }, tool_use_id: 'native-call', permission_mode: 'dontAsk' };
  const run = spawnSync(process.execPath, [join(import.meta.dirname, 'fixtures/linear-permission/hook.mjs'), behavior, log], { input: JSON.stringify(input), encoding: 'utf8' });
  assert.equal(run.status, expectedExit); assert.equal(existsSync(log), true);
  assert.deepEqual(JSON.parse(readFileSync(log, 'utf8')), { behavior, tool: FIXTURE_TOOL, args: { nonce: behavior }, toolUseId: 'native-call', permissionMode: 'dontAsk' });
  if (behavior === 'allow') assert.deepEqual(JSON.parse(run.stdout), { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } });
  else assert.equal(run.stdout, '');
});
