import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectRemoteEvidence, parseRunStream, RemoteCollectionError, type CursorEndpoint } from './historical-cursor.ts';

const agentId = 'bc-agent';
const runId = 'run-exact';
const endpoint: CursorEndpoint = { baseUrl: 'https://api.cursor.com', apiKey: 'test-key', loopback: false };

function streamBytes(): Buffer {
  return Buffer.from([
    'event: status',
    `data: {"runId":"${runId}","status":"FINISHED"}`,
    '',
    'event: tool_call',
    `data: {"callId":"tool-1","name":"run_terminal_cmd","status":"running","args":{"command":"cd /workspace && git rev-parse HEAD","parsingResult":{"executableCommands":[{"name":"cd","args":[{"type":"word","value":"/workspace"}],"fullText":"cd /workspace"},{"name":"git","args":[{"type":"word","value":"rev-parse"},{"type":"word","value":"HEAD"}],"fullText":"git rev-parse HEAD"}]}}}`,
    '',
    'event: interaction_update',
    'data: {"type":"tool-call-completed","callId":"tool-1","toolCall":{"type":"shell","args":{"command":"cd /workspace && git rev-parse HEAD"},"result":{"status":"success","value":{"exitCode":0,"stdout":"abc\\n","stderr":""}}}}',
    '',
    'event: status',
    `data: {"runId":"${runId}","status":"FINISHED"}`,
  ].join('\n'));
}

test('collects the exact run-specific Cursor stream bytes with its required carrier', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'historical-cursor-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const stream = streamBytes();
  const requests: { url: string; accept: string | null }[] = [];
  const fetchMock = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    requests.push({ url, accept: headers.get('accept') });
    if (url.endsWith(`/v1/agents/${agentId}/runs/${runId}`)) {
      return new Response(JSON.stringify({ id: runId, agentId, status: 'FINISHED', result: '{}', git: { branches: [] } }));
    }
    if (url.endsWith(`/v1/agents/${agentId}/runs/${runId}/stream`)) return new Response(stream);
    if (url.endsWith(`/v1/agents/${agentId}/artifacts`)) return new Response('{"items":[]}');
    return new Response('missing', { status: 404 });
  };

  const collected = await collectRemoteEvidence({ agentId, runId, directory, endpoint, fetch: fetchMock });
  assert.deepEqual(requests.map(request => request.url), [
    `https://api.cursor.com/v1/agents/${agentId}/runs/${runId}`,
    `https://api.cursor.com/v1/agents/${agentId}/runs/${runId}/stream`,
    `https://api.cursor.com/v1/agents/${agentId}/artifacts`,
  ]);
  assert.equal(requests[1]?.accept, 'text/event-stream');
  assert.ok(collected.originalToolStream);
  assert.deepEqual(readFileSync(collected.originalToolStream.path), stream);
  const parsed = parseRunStream(stream.toString('utf8'));
  assert.deepEqual([...parsed.runIds], [runId]);
  assert.equal(parsed.terminalStatus, 'FINISHED');
  assert.equal(parsed.tools.length, 1);
  assert.equal(parsed.tools[0]?.outcome.kind, 'success');
  assert.deepEqual(parsed.tools[0]?.executables.map(command => command.name), ['cd', 'git']);
});

test('a failed stream request stays a collection failure and never fabricates an empty original', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'historical-cursor-failure-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fetchMock = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (url.endsWith(`/v1/agents/${agentId}/runs/${runId}`)) {
      return new Response(JSON.stringify({ id: runId, agentId, status: 'FINISHED', result: '{}', git: { branches: [] } }));
    }
    return new Response('stream unavailable', { status: 503 });
  };

  const failure = await collectRemoteEvidence({ agentId, runId, directory, endpoint, fetch: fetchMock })
    .then(() => null, error => error);
  assert.equal(failure instanceof RemoteCollectionError, true);
  if (failure instanceof RemoteCollectionError) {
    assert.match(failure.message, /HTTP 503/);
    assert.equal(failure.originals.length, 2);
    assert.equal(readFileSync(failure.originals[1].path, 'utf8'), 'stream unavailable');
  }
  assert.equal(readdirSync(directory).some(name => name.startsWith('run-stream-') && name.endsWith('.sse')), false);
  assert.equal(readdirSync(directory).some(name => name.startsWith('run-stream-http-503-')), true);
  assert.equal(readdirSync(directory).some(name => name.startsWith('remote-run-')), true);
});

test('retains read-file arguments and result content from the observable stream', () => {
  const raw = [
    'event: status',
    `data: {"runId":"${runId}","status":"FINISHED"}`,
    '',
    'event: interaction_update',
    'data: {"type":"tool-call-completed","callId":"read-1","toolCall":{"type":"read_file","args":{"path":"/tmp/patient-work/source.ts"},"result":{"status":"success","value":{"content":"export const value = 1;\\n"}}}}',
  ].join('\n');
  const parsed = parseRunStream(raw);
  const tool = parsed.tools[0];
  assert.equal(tool?.name, 'read_file');
  assert.deepEqual(tool?.args, { path: '/tmp/patient-work/source.ts' });
  assert.equal(tool?.outcome.kind, 'success');
  if (tool?.outcome.kind === 'success') assert.equal(tool.outcome.content, 'export const value = 1;\n');
});
