import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './fixtures/setup.ts';
import { start } from './start.ts';

function environment(t: TestContext, f: ReturnType<typeof fixture>): void {
  const before = { path: process.env.PATH, fixture: process.env.CONVERGE_FIXTURE, key: process.env.CURSOR_API_KEY };
  process.env.PATH = f.directory + ':' + before.path;
  process.env.CONVERGE_FIXTURE = f.statePath;
  process.env.CURSOR_API_KEY = 'test-key';
  t.after(() => {
    if (before.path === undefined) delete process.env.PATH; else process.env.PATH = before.path;
    if (before.fixture === undefined) delete process.env.CONVERGE_FIXTURE; else process.env.CONVERGE_FIXTURE = before.fixture;
    if (before.key === undefined) delete process.env.CURSOR_API_KEY; else process.env.CURSOR_API_KEY = before.key;
  });
}

const inventory = { items: [{ id: 'grok-4.7', parameters: [{ id: 'reasoning_effort' }, { id: 'fast' }], variants: [
  { params: [{ id: 'reasoning_effort', value: 'high' }, { id: 'fast', value: 'true' }], isDefault: true },
  { params: [{ id: 'reasoning_effort', value: 'high' }, { id: 'fast', value: 'false' }] },
  { params: [{ id: 'reasoning_effort', value: 'xhigh' }, { id: 'fast', value: 'false' }] },
] }] };

test('ready PR handoff persists intent before launch and returns the same receipt on retry', async t => {
  const f = fixture(); t.after(f.cleanup); environment(t, f);
  const directory = join(f.directory, 'owner');
  let launches = 0;
  t.mock.method(globalThis, 'fetch', async (url: string | URL, init?: RequestInit) => {
    if (String(url).endsWith('/v1/models')) return Response.json(inventory);
    launches++;
    assert.equal(existsSync(join(directory, 'intent.json')), true);
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.model, { id: 'grok-4.7', params: [{ id: 'reasoning_effort', value: 'high' }, { id: 'fast', value: 'false' }] });
    assert.equal(body.envVars.PSTACK_AGENT_TOKEN, 'test-key');
    assert.equal(body.autoCreatePR, false);
    return Response.json({ agent: { id: 'bc_test', url: 'https://cursor.com/agents/bc_test' }, run: { id: 'run_test' } });
  });
  const options = { repo: 'Example/app', pr: 1, toolingRef: 'd'.repeat(40), stateDirectory: directory, effort: 'high' as const };
  const first = await start(options);
  assert.equal(first.agentId, 'bc_test');
  assert.equal(first.modelSelection.includes('requested effort high'), true);
  assert.equal(readFileSync(join(directory, 'launch.json'), 'utf8').includes('test-key'), false);
  assert.deepEqual(await start(options), first);
  assert.equal(launches, 1);
});

test('uncertain launch cannot create a second owner', async t => {
  const f = fixture(); t.after(f.cleanup); environment(t, f);
  const directory = join(f.directory, 'unknown');
  let launches = 0;
  t.mock.method(globalThis, 'fetch', async (url: string | URL) => {
    if (String(url).endsWith('/v1/models')) return Response.json(inventory);
    if (String(url).includes('/v1/agents?')) return Response.json({ items: [] });
    launches++;
    throw new Error('connection lost after request');
  });
  const options = { repo: 'Example/app', pr: 1, toolingRef: 'd'.repeat(40), stateDirectory: directory, effort: 'high' as const };
  await assert.rejects(start(options), /connection lost/);
  await assert.rejects(start(options), /Launch outcome unknown/);
  assert.equal(launches, 1);
});

test('lost launch response recovers the one matching Cursor agent', async t => {
  const f = fixture(); t.after(f.cleanup); environment(t, f);
  const directory = join(f.directory, 'recover');
  let posts = 0;
  t.mock.method(globalThis, 'fetch', async (url: string | URL) => {
    if (String(url).endsWith('/v1/models')) return Response.json(inventory);
    if (String(url).includes('/v1/agents?')) return Response.json({ items: [{ id: 'bc_recovered', latestRunId: 'run_recovered', url: 'https://cursor.com/agents/bc_recovered', name: `converge Example/app#1 ${f.state.head.slice(0, 8)}`, createdAt: new Date().toISOString() }] });
    posts++;
    throw new Error('connection lost after request');
  });
  const options = { repo: 'Example/app', pr: 1, toolingRef: 'd'.repeat(40), stateDirectory: directory, effort: 'high' as const };
  await assert.rejects(start(options), /connection lost/);
  const recovered = await start(options);
  assert.equal(recovered.agentId, 'bc_recovered');
  assert.equal(recovered.runId, 'run_recovered');
  assert.equal(posts, 1);
});
