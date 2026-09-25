import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, publishCertificate } from './fixtures/setup.ts';
import { sheetEfforts, start } from './start.ts';
import { verdictGate } from './gate.ts';
import { trusted } from './github.ts';

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
    assert.match(body.prompt.text, /GH_TOKEN from the Cursor runtime secret PSTACK_GITHUB_TOKEN/);
    assert.match(body.prompt.text, /git -c credential\.helper= -c credential\.helper='!gh auth git-credential' push/);
    assert.equal(body.autoCreatePR, false);
    return Response.json({ agent: { id: 'bc_test', url: 'https://cursor.com/agents/bc_test' }, run: { id: 'run_test' } });
  });
  const options = { repo: 'Example/app', pr: 1, toolingRef: 'd'.repeat(40), stateDirectory: directory, effort: 'high' as const };
  const first = await start(options);
  assert.equal(first.kind, 'launched');
  assert.equal(first.agentId, 'bc_test');
  assert.equal(first.modelSelection.includes('requested effort high'), true);
  assert.equal(readFileSync(join(directory, 'launch.json'), 'utf8').includes('test-key'), false);
  assert.equal('kind' in JSON.parse(readFileSync(join(directory, 'launch.json'), 'utf8')), false);
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

test('missing tooling commit refuses launch before writing intent', async t => {
  const f = fixture(); t.after(f.cleanup); environment(t, f);
  f.state.invalidTooling = true; f.save();
  const directory = join(f.directory, 'missing-tooling');
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; return Response.json({}); });
  await assert.rejects(start({ repo: 'Example/app', pr: 1, toolingRef: 'd'.repeat(40), stateDirectory: directory, effort: 'high' }), /gh request failed/);
  assert.equal(existsSync(join(directory, 'intent.json')), false);
  assert.equal(requests, 0);
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
  assert.equal(recovered.kind, 'launched');
  assert.equal(recovered.agentId, 'bc_recovered');
  assert.equal(recovered.runId, 'run_recovered');
  assert.equal(posts, 1);
});

test('sheet efforts are floors for the owner and the verifier', () => {
  const sheet = 'feature, refactoring: grok:grok-4.7@xhigh\npr owner: cursor:grok-4.7@xhigh\npr verifier: cursor:grok-4.7@high\n';
  assert.deepEqual(sheetEfforts(sheet), { owner: 'xhigh', verifier: 'high' });
  assert.deepEqual(sheetEfforts('# pstack model configuration\n'), { owner: 'high', verifier: 'high' });
  assert.deepEqual(sheetEfforts('pr owner: inherit-parent\npr verifier: auto\n'), { owner: 'high', verifier: 'high' });
  assert.throws(() => sheetEfforts('pr verifier: cursor:composer-2.5@high\n'), /pr verifier.*must be cursor:grok-4\.7@high, cursor:grok-4\.7@xhigh/);
  assert.throws(() => sheetEfforts('pr owner: cursor:grok-4.7@medium\n'), /pr owner/);
});

test('sheet floors raise the owner launch and bind the verifier effort', async t => {
  const f = fixture(); t.after(f.cleanup); environment(t, f);
  const directory = join(f.directory, 'sheet');
  const sheetPath = join(f.directory, 'pstack-models.md');
  writeFileSync(sheetPath, 'pr owner: cursor:grok-4.7@xhigh\npr verifier: cursor:grok-4.7@xhigh\n');
  let prompt = '';
  t.mock.method(globalThis, 'fetch', async (url: string | URL, init?: RequestInit) => {
    if (String(url).endsWith('/v1/models')) return Response.json(inventory);
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.model.params, [{ id: 'reasoning_effort', value: 'xhigh' }, { id: 'fast', value: 'false' }]);
    prompt = body.prompt.text;
    return Response.json({ agent: { id: 'bc_sheet', url: 'https://cursor.com/agents/bc_sheet' }, run: { id: 'run_sheet' } });
  });
  const receipt = await start({ repo: 'Example/app', pr: 1, toolingRef: 'd'.repeat(40), stateDirectory: directory, effort: 'high', sheetPath });
  assert.equal(receipt.kind, 'launched');
  assert.equal(receipt.effort, 'xhigh');
  assert.equal(receipt.verifierEffort, 'xhigh');
  assert.match(prompt, /descriptor cursor:grok-4\.7@xhigh and launch it with pstack-runner .*? --effort xhigh --mode read-only/);
  assert.doesNotMatch(prompt, /for a simple change/);
  assert.deepEqual(await start({ repo: 'Example/app', pr: 1, toolingRef: 'd'.repeat(40), stateDirectory: directory, sheetPath }), receipt);
  writeFileSync(sheetPath, 'pr owner: cursor:grok-4.7@xhigh\npr verifier: cursor:grok-4.7@high\n');
  await assert.rejects(start({ repo: 'Example/app', pr: 1, toolingRef: 'd'.repeat(40), stateDirectory: directory, sheetPath }), /Existing launch receipt is invalid or differs/);
});

test('explicit effort raises a high sheet floor and an invalid sheet refuses before intent', async t => {
  const f = fixture(); t.after(f.cleanup); environment(t, f);
  const sheetPath = join(f.directory, 'pstack-models.md');
  writeFileSync(sheetPath, 'pr owner: cursor:grok-4.7@high\npr verifier: cursor:grok-4.7@high\n');
  let prompt = '';
  t.mock.method(globalThis, 'fetch', async (url: string | URL, init?: RequestInit) => {
    if (String(url).endsWith('/v1/models')) return Response.json(inventory);
    prompt = JSON.parse(String(init?.body)).prompt.text;
    return Response.json({ agent: { id: 'bc_raise', url: 'https://cursor.com/agents/bc_raise' }, run: { id: 'run_raise' } });
  });
  const raised = await start({ repo: 'Example/app', pr: 1, toolingRef: 'd'.repeat(40), stateDirectory: join(f.directory, 'raise'), effort: 'xhigh', sheetPath });
  assert.equal(raised.kind, 'launched');
  assert.equal(raised.effort, 'xhigh');
  assert.equal(raised.verifierEffort, 'high');
  assert.match(prompt, /cursor:grok-4\.7@high for a simple change or cursor:grok-4\.7@xhigh for a complex change/);
  writeFileSync(sheetPath, 'pr owner: cursor:composer-2.5@high\n');
  const refused = join(f.directory, 'refused');
  await assert.rejects(start({ repo: 'Example/app', pr: 1, toolingRef: 'd'.repeat(40), stateDirectory: refused, sheetPath }), /pr owner/);
  assert.equal(existsSync(join(refused, 'intent.json')), false);
});

test('a certified head returns without launching an owner', async t => {
  const f = fixture(); t.after(f.cleanup); environment(t, f); publishCertificate(f);
  let launches = 0;
  t.mock.method(globalThis, 'fetch', async () => { launches++; return Response.json({}); });
  const result = await start({ repo: 'Example/app', pr: 1, toolingRef: 'a'.repeat(40), stateDirectory: join(f.directory, 'owner'), sheetPath: join(f.directory, 'missing-sheet.md') });
  assert.deepEqual(result, { schemaVersion: 1, kind: 'certified', repo: 'Example/app', pr: 1, head: f.state.head, verdictUrl: 'https://github.com/Example/app/pull/1#issuecomment-100' });
  assert.equal(launches, 0); assert.equal(existsSync(join(f.directory, 'owner', 'intent.json')), false);
});

for (const [name, status, reason] of [
  ['NOT VERIFIED', { state: 'failure', description: 'NOT VERIFIED by converge', creator: { id: 7 } }, 'Latest verdict status is not trusted VERIFIED'],
  ['from another account', { state: 'success', description: 'VERIFIED by converge', creator: { id: 8 } }, 'VERIFIED verdict status was posted by another account: 8'],
  ['linked to another PR', { state: 'success', description: 'VERIFIED by converge', creator: { id: 7 }, target_url: 'https://github.com/Example/app/pull/2#issuecomment-100' }, 'Verdict status does not link to this PR'],
  ['without a link', { state: 'success', description: 'VERIFIED by converge', creator: { id: 7 }, target_url: undefined }, 'Verdict status does not link to this PR'],
  ['with no comment behind it', { state: 'success', description: 'VERIFIED by converge', creator: { id: 7 } }, 'Verdict comment is missing from this PR'],
] as const) {
  test(`a head whose verdict is ${name} still launches an owner`, async t => {
    const f = fixture(); t.after(f.cleanup); environment(t, f);
    const live = f.read();
    live.statuses = [{ context: 'verdict', target_url: 'https://github.com/Example/app/pull/1#issuecomment-100', id: 200, ...status }];
    Object.assign(f.state, live); f.save();
    let launches = 0;
    t.mock.method(globalThis, 'fetch', async (url: string | URL) => {
      if (String(url).endsWith('/v1/models')) return Response.json(inventory);
      launches++;
      return Response.json({ agent: { id: 'bc_owner', url: 'https://cursor.com/agents/bc_owner' }, run: { id: 'run_owner' } });
    });
    assert.deepEqual(await verdictGate(await trusted('Example/app', '.cursor/converge.json'), 1, f.state.head, 7), { kind: 'refused', reason });
    const receipt = await start({ repo: 'Example/app', pr: 1, toolingRef: 'd'.repeat(40), stateDirectory: join(f.directory, 'owner'), effort: 'high' });
    assert.equal(receipt.kind, 'launched');
    assert.equal(launches, 1); assert.equal(receipt.agentId, 'bc_owner');
  });
}

test('a certified head that moves before the exit refuses and launches nothing', async t => {
  const f = fixture(); t.after(f.cleanup); environment(t, f); publishCertificate(f);
  const live = f.read();
  live.after = { endpoint: 'pulls/1', reads: 4, set: { head: 'e'.repeat(40) } };
  Object.assign(f.state, live); f.save();
  let launches = 0;
  t.mock.method(globalThis, 'fetch', async () => { launches++; return Response.json({}); });
  await assert.rejects(start({ repo: 'Example/app', pr: 1, toolingRef: 'a'.repeat(40), stateDirectory: join(f.directory, 'owner') }), /^Error: PR head moved$/);
  assert.equal(launches, 0); assert.equal(existsSync(join(f.directory, 'owner', 'intent.json')), false);
});

test('a trusted status whose dossier names another head still launches an owner', async t => {
  const f = fixture(); t.after(f.cleanup); environment(t, f); publishCertificate(f);
  const live = f.read(); live.head = 'e'.repeat(40); live.statuses.unshift({ ...live.statuses[0], id: 201, sha: live.head }); Object.assign(f.state, live); f.save();
  let launches = 0;
  t.mock.method(globalThis, 'fetch', async (url: string | URL) => {
    if (String(url).endsWith('/v1/models')) return Response.json(inventory);
    launches++;
    return Response.json({ agent: { id: 'bc_owner', url: 'https://cursor.com/agents/bc_owner' }, run: { id: 'run_owner' } });
  });
  const receipt = await start({ repo: 'Example/app', pr: 1, toolingRef: 'd'.repeat(40), stateDirectory: join(f.directory, 'owner'), effort: 'high' });
  assert.equal(receipt.kind, 'launched'); assert.equal(launches, 1);
});

test('a verdict that a newer publication supersedes still launches an owner', async t => {
  const f = fixture(); t.after(f.cleanup); environment(t, f); publishCertificate(f);
  const live = f.read(); live.comments.push({ id: 101, body: '<!-- converge:v1 00000000-0000-4000-8000-000000000000 -->\n```json\n{}\n```\n', user: { id: 7 }, html_url: 'https://github.com/Example/app/pull/1#issuecomment-101', updated_at: '2026-09-22T00:00:00Z' }); Object.assign(f.state, live); f.save();
  let launches = 0;
  t.mock.method(globalThis, 'fetch', async (url: string | URL) => {
    if (String(url).endsWith('/v1/models')) return Response.json(inventory);
    launches++;
    return Response.json({ agent: { id: 'bc_owner', url: 'https://cursor.com/agents/bc_owner' }, run: { id: 'run_owner' } });
  });
  const receipt = await start({ repo: 'Example/app', pr: 1, toolingRef: 'd'.repeat(40), stateDirectory: join(f.directory, 'owner'), effort: 'high' });
  assert.equal(receipt.kind, 'launched'); assert.equal(launches, 1);
});

test('a failed GitHub read in the verdict gate fails start.ts instead of launching', async t => {
  const f = fixture(); t.after(f.cleanup); environment(t, f); publishCertificate(f);
  const live = f.read(); live.failEndpoint = 'issues/1/comments'; Object.assign(f.state, live); f.save();
  let launches = 0;
  t.mock.method(globalThis, 'fetch', async () => { launches++; return Response.json({}); });
  await assert.rejects(start({ repo: 'Example/app', pr: 1, toolingRef: 'd'.repeat(40), stateDirectory: join(f.directory, 'owner') }), /^Error: gh request failed$/);
  assert.equal(launches, 0); assert.equal(existsSync(join(f.directory, 'owner', 'intent.json')), false);
});

test('a head move after the gate refuses leaves no launch intent, and a retry launches', async t => {
  const f = fixture(); t.after(f.cleanup); environment(t, f);
  const live = f.read(); live.after = { endpoint: 'pulls/1', reads: 1, set: { head: 'e'.repeat(40) } }; Object.assign(f.state, live); f.save();
  let launches = 0;
  t.mock.method(globalThis, 'fetch', async (url: string | URL) => {
    if (String(url).endsWith('/v1/models')) return Response.json(inventory);
    launches++;
    return Response.json({ agent: { id: 'bc_owner', url: 'https://cursor.com/agents/bc_owner' }, run: { id: 'run_owner' } });
  });
  const options = { repo: 'Example/app', pr: 1, toolingRef: 'd'.repeat(40), stateDirectory: join(f.directory, 'owner'), effort: 'high' as const };
  await assert.rejects(start(options), /^Error: PR head moved$/);
  assert.equal(existsSync(join(f.directory, 'owner', 'intent.json')), false);
  const retry = await start(options);
  assert.equal(retry.kind, 'launched'); assert.equal(launches, 1);
});
