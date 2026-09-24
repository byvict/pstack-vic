import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { admitLane } from './evidence.ts';
import { hash, type Report } from './contract.ts';

const head = 'b'.repeat(40), contract = 'a'.repeat(40), id = '12345678-1234-1234-1234-123456789abc';
function input() {
  const directory = mkdtempSync(join(tmpdir(), 'converge-admission-'));
  const report: Report = { schemaVersion: 1, round: { id, repo: 'Example/app', pr: 1, head, contract, base: 'c'.repeat(40), patch_id: 'd'.repeat(40), inputDigest: '1'.repeat(64), verificationDigest: '2'.repeat(64), configPath: '.cursor/converge.json', execution: 'verdict-only' }, mode: 'full', touchedFeatures: [], unmappedSurfaces: [], claims: [], hardList: [], injection: [], findings: [], checks: [], lanes: ['pr verifier'], gaps: [], inputFingerprint: '3'.repeat(64) };
  const prefix = `artifacts/converge/${id}/verifier/`;
  const png = readFileSync(new URL('../../../../assets/logo.png', import.meta.url));
  const action = Buffer.from('{"entry":"Entrar","action":"submit form","result":"Dashboard"}');
  const output = { schemaVersion: 1, round: id, laneId: 'verifier', role: 'pr verifier', observedHead: head, observedContract: contract, kind: 'complete', findings: [], artifacts: [{ id: 'screen', path: prefix + 'screen.png', bytes: png.length, sha256: hash(png), mediaType: 'image/png' }, { id: 'action', path: prefix + 'action.json', bytes: action.length, sha256: hash(action), mediaType: 'application/json' }], coverage: [{ featureId: 'login', entryPoint: 'Entrar', result: 'driven', artifactIds: ['screen', 'action'] }], riskProofs: [] };
  const receipt = { schemaVersion: 1, parent: 'codex', provider: 'cursor', model: 'grok-4.7', effort: 'high', mode: 'read-only', status: 'complete', promptPath: join(directory, 'prompt.txt'), outputPath: join(directory, 'output.json'), startedAt: '2026-09-21T00:00:00.000Z', completedAt: '2026-09-21T00:00:02.000Z', modelVerified: false, modelEvidence: 'pinned-argv', reportedModel: null, remote: { agentId: 'bc-fixture', runId: 'run-fixture', heads: { kind: 'observed', changedBranches: [] } } };
  const manifest = { round: report.round, laneId: 'verifier', role: 'pr verifier', descriptor: 'cursor:grok-4.7@high', prompt: 'prompt.txt', promptDigest: hash('read only'), output: 'output.json', receipt: 'receipt.json', createdAt: Date.parse(receipt.startedAt) };
  const save = () => { writeFileSync(join(directory, 'prompt.txt'), 'read only'); writeFileSync(join(directory, 'output.json'), JSON.stringify(output)); writeFileSync(join(directory, 'receipt.json'), JSON.stringify(receipt)); writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest)); };
  save();
  return { directory, report, output, receipt, save, png, action, prefix, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}
function mockRemote(t: TestContext, i: ReturnType<typeof input>): void {
  const oldKey = process.env.CURSOR_API_KEY; process.env.CURSOR_API_KEY = 'test-key';
  t.after(() => { if (oldKey === undefined) delete process.env.CURSOR_API_KEY; else process.env.CURSOR_API_KEY = oldKey; });
  t.mock.method(globalThis, 'fetch', async (url: string | URL) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/runs/run-fixture')) return Response.json({ runId: 'run-fixture' });
    if (u.pathname.endsWith('/artifacts')) return Response.json({ items: i.output.artifacts.map(a => ({ path: a.path })) });
    if (u.pathname.endsWith('/download')) return Response.json({ url: 'https://agent-stores.s3.us-east-1.amazonaws.com/' + (u.searchParams.get('path')?.endsWith('.png') ? 'screen.png' : 'action.json') });
    return new Response(u.pathname.endsWith('.png') ? i.png : i.action);
  });
}
test('Cursor pinned-argv receipt contract admits downloaded bytes without forwarding credentials', async t => {
  const i = input(); t.after(i.cleanup);
  const oldKey = process.env.CURSOR_API_KEY; process.env.CURSOR_API_KEY = 'test-key';
  t.after(() => { if (oldKey === undefined) delete process.env.CURSOR_API_KEY; else process.env.CURSOR_API_KEY = oldKey; });
  const calls: { url: string; headers: Headers; redirect: RequestRedirect | undefined }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers), redirect: init?.redirect });
    const u = new URL(url);
    if (u.hostname === 'api.cursor.com' && u.pathname.endsWith('/runs/run-fixture')) return Response.json({ runId: 'run-fixture' });
    if (u.pathname.endsWith('/artifacts')) return Response.json({ items: i.output.artifacts.map(a => ({ path: a.path })) });
    if (u.pathname.endsWith('/download')) return Response.json({ url: 'https://agent-stores.s3.us-east-1.amazonaws.com/' + (u.searchParams.get('path')?.endsWith('.png') ? 'screen.png' : 'action.json') });
    return new Response(u.pathname.endsWith('.png') ? i.png : i.action);
  });
  const result = await admitLane(join(i.directory, 'manifest.json'), i.report, join(i.directory, 'admitted'));
  assert.deepEqual(result.coverage, ['login']); assert.equal(result.artifacts.length, 2);
  assert.ok(calls.filter(c => c.url.startsWith('https://api.cursor.com/')).every(c => c.headers.has('Authorization')));
  assert.ok(calls.filter(c => !c.url.startsWith('https://api.cursor.com/')).every(c => !c.headers.has('Authorization') && c.redirect === 'error'));
});
test('malformed receipt timestamps fail before any remote call', async t => {
  const i = input(); t.after(i.cleanup); i.receipt.startedAt = 'not-a-date'; i.save();
  await assert.rejects(admitLane(join(i.directory, 'manifest.json'), i.report, join(i.directory, 'admitted')), /predates dispatch/);
});
test('a text artifact alone cannot prove a live drive', async t => {
  const i = input(); t.after(i.cleanup);
  i.output.artifacts = i.output.artifacts.filter(a => a.id === 'action'); i.output.coverage[0].artifactIds = ['action']; i.save();
  mockRemote(t, i);
  const result = await admitLane(join(i.directory, 'manifest.json'), i.report, join(i.directory, 'admitted'));
  assert.deepEqual(result.coverage, []); assert.deepEqual(result.gaps, ['Live user path was not driven with evidence']);
});
for (const fault of ['stale-length', 'invented-obligation']) {
  test(`admission retains refusal for ${fault}`, async t => {
    const i = input(); t.after(i.cleanup);
    const output = { ...i.output, riskProofs: fault === 'invented-obligation' ? [{ obligation: { source: 'diff', path: 'client/Login.jsx', line: 156, rule: 'login-user-path-unchanged' }, result: 'proved-safe', artifactIds: ['action'] }] : [] };
    if (fault === 'stale-length') output.artifacts[1].bytes -= 1;
    writeFileSync(join(i.directory, 'output.json'), JSON.stringify(output));
    mockRemote(t, i);
    await assert.rejects(admitLane(join(i.directory, 'manifest.json'), i.report, join(i.directory, 'admitted')), fault === 'stale-length' ? /Artifact exceeds size limit|Artifact bytes differ/ : /does not identify a requested obligation/);
  });
}
function localInput(role: 'pre-pr reviewer' | 'pre-pr certifier') {
  const i = input();
  const round = { ...i.report.round, pr: 0, execution: 'pre-pr' as const };
  const manifest = { round, laneId: role.replace(' ', '-'), role, descriptor: 'grok:grok-4.7@xhigh', prompt: 'prompt.txt', promptDigest: hash('read only'), output: 'output.json', receipt: 'receipt.json', createdAt: Date.parse(i.receipt.startedAt) };
  const receipt = { ...i.receipt, parent: 'claude', provider: 'grok', model: 'grok-4.7', effort: 'xhigh', modelVerified: true, modelEvidence: 'provider-report', reportedModel: 'grok-4.7-build', remote: null, executable: '/usr/local/bin/grok', exitCode: 0, signal: null };
  const prefix = `artifacts/converge/${round.id}/${manifest.laneId}/`;
  const output = { ...i.output, laneId: manifest.laneId, role, artifacts: i.output.artifacts.map(a => ({ ...a, path: prefix + a.path.split('/').at(-1) })) };
  mkdirSync(join(i.directory, prefix), { recursive: true });
  writeFileSync(join(i.directory, prefix, 'screen.png'), i.png); writeFileSync(join(i.directory, prefix, 'action.json'), i.action);
  writeFileSync(join(i.directory, 'output.json'), JSON.stringify(output)); writeFileSync(join(i.directory, 'receipt.json'), JSON.stringify(receipt)); writeFileSync(join(i.directory, 'manifest.json'), JSON.stringify(manifest));
  return { ...i, round, receipt, save: () => { writeFileSync(join(i.directory, 'receipt.json'), JSON.stringify(receipt)); } };
}
test('a local grok certifier lane admits artifacts from disk against the local round', async t => {
  const i = localInput('pre-pr certifier'); t.after(i.cleanup);
  const report = { ...i.report, round: i.round, lanes: ['pre-pr reviewer', 'pre-pr certifier'] as const };
  const result = await admitLane(join(i.directory, 'manifest.json'), report as never, join(i.directory, 'admitted'), i.round);
  assert.deepEqual(result.coverage, ['login']); assert.equal(result.role, 'pre-pr certifier');
});
test('a pre-pr role refuses a Cursor receipt and a pr verifier refuses a grok one', async t => {
  const i = localInput('pre-pr reviewer'); t.after(i.cleanup);
  i.receipt.provider = 'cursor'; i.save();
  await assert.rejects(admitLane(join(i.directory, 'manifest.json'), { ...i.report, round: i.round } as never, join(i.directory, 'admitted'), i.round), /Lane receipt model differs from dispatch|requires grok/);
  const v = input(); t.after(v.cleanup);
  const manifest = JSON.parse(readFileSync(join(v.directory, 'manifest.json'), 'utf8'));
  writeFileSync(join(v.directory, 'manifest.json'), JSON.stringify({ ...manifest, descriptor: 'grok:grok-4.7@xhigh' }));
  await assert.rejects(admitLane(join(v.directory, 'manifest.json'), v.report, join(v.directory, 'admitted')), /Role pr verifier requires cursor/);
});
