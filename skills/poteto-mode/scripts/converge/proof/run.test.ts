import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { executionId, hash, jsonHash, type Dossier, type Report } from '../contract.ts';
import { loadCatalog, type CatalogCase, type OwnedCase } from './plant.ts';
import { assertCatalogEntry, defaultServices, mechanismHolds, parseTurnClosure, renderSuite, runProof, type Attempt, type ProofServices, type Publication } from './run.ts';
import { priceUsage, type CostResult } from './usage.ts';

const head = 'b'.repeat(40);
const trunk = 'a'.repeat(40);
const digest64 = (n: string) => n.repeat(64);
const catalog = loadCatalog();

function reportFor(entry: CatalogCase, pr: number): Report {
  const round = {
    id: '12345678-1234-1234-1234-123456789abc', repo: 'Clinextapp/clinext', pr, head, contract: trunk,
    base: trunk, patch_id: 'd'.repeat(40), verificationDigest: digest64('2'), inputDigest: digest64('1'),
    configPath: '.cursor/converge.json', execution: 'verdict-only' as const,
  };
  const empty = { schemaVersion: 1 as const, round, unmappedSurfaces: [], claims: [], hardList: [], injection: [], findings: [], checks: [], gaps: [], inputFingerprint: digest64('3') };
  if (entry.expected.kind === 'docs') return { ...empty, mode: 'ci-only', touchedFeatures: [], lanes: [] };
  if (entry.expected.kind === 'clean-ui') {
    return {
      ...empty, mode: 'full', lanes: ['pr verifier'],
      touchedFeatures: [{ id: 'login', page: entry.expected.page, recipe: '.cursor/skills/verify-clinext/features/login.md', recipeDigest: digest64('4') }],
    };
  }
  if (entry.expected.kind === 'human-update') return { ...empty, mode: 'full', touchedFeatures: [], lanes: ['pr verifier'] };
  if (entry.expected.kind === 'missing-test') {
    return {
      ...empty, mode: 'full', touchedFeatures: [], lanes: ['pr verifier'],
      claims: [{ line: 8, kind: 'test', name: entry.expected.testPath, artifactFound: false, resolution: 'missing' }],
    };
  }
  if (entry.expected.kind === 'secret') {
    const finding = { kind: 'secret' as const, source: 'diff' as const, path: entry.expected.path, line: 1, rule: 'credential-pattern', severity: 'blocking' as const };
    return { ...empty, mode: 'full', touchedFeatures: [], lanes: ['pr verifier'], hardList: [finding], findings: [finding] };
  }
  if (entry.expected.kind === 'defect' && entry.expected.finding === 'data-loss') {
    const finding = { kind: 'data-loss' as const, source: 'diff' as const, path: entry.expected.path, line: 0, rule: 'unbounded-delete', severity: 'blocking' as const };
    return { ...empty, mode: 'full', touchedFeatures: [], lanes: ['pr verifier'], hardList: [finding], findings: [finding] };
  }
  if (entry.expected.kind === 'defect' && entry.expected.finding === 'documentary') {
    const finding = { kind: 'documentary' as const, source: 'diff' as const, path: entry.expected.path, line: 0, rule: 'feature-map-travel', severity: 'blocking' as const };
    return { ...empty, mode: 'full', touchedFeatures: [{ id: 'login', page: 'client/src/pages/LoginPage.jsx', recipe: entry.expected.path, recipeDigest: digest64('4') }], lanes: ['pr verifier'], findings: [finding] };
  }
  if (entry.expected.kind === 'defect' && entry.expected.finding === 'injection') {
    const finding = { kind: 'injection' as const, source: 'body' as const, path: null, line: 9, rule: 'verifier-address', severity: 'blocking' as const };
    return { ...empty, mode: 'full', touchedFeatures: [], lanes: ['pr verifier'], injection: [finding], findings: [finding] };
  }
  const finding = { kind: entry.expected.kind === 'defect' ? entry.expected.finding : 'regression', source: 'lane' as const, path: entry.expected.kind === 'defect' ? entry.expected.path : 'client/src/pages/DashboardPage.jsx', line: 1, rule: 'cannot-fail', severity: 'blocking' as const };
  return { ...empty, mode: 'full', touchedFeatures: [], lanes: ['pr verifier'], findings: [finding] };
}

function dossierFor(report: Report): Dossier {
  if (report.findings[0]) {
    return { schemaVersion: 1, round: report.round, decision: { verdict: 'NOT VERIFIED', displayResult: 'NOT VERIFIED', findings: [report.findings[0], ...report.findings.slice(1)], reasons: [] }, evidenceDigest: digest64('5'), reconcileDigest: jsonHash(report), coverage: [], riskAdjudication: [], artifactIds: [], inputFingerprint: report.inputFingerprint, retainedFrom: null };
  }
  if (report.claims.some(c => c.resolution === 'missing')) {
    const finding = { kind: 'false-claim' as const, source: 'body' as const, path: null, line: report.claims[0]?.line ?? 1, rule: 'claimed-evidence-absent', severity: 'blocking' as const };
    return { schemaVersion: 1, round: report.round, decision: { verdict: 'NOT VERIFIED', displayResult: 'NOT VERIFIED', findings: [finding], reasons: [] }, evidenceDigest: digest64('5'), reconcileDigest: jsonHash(report), coverage: [], riskAdjudication: [], artifactIds: [], inputFingerprint: report.inputFingerprint, retainedFrom: null };
  }
  return {
    schemaVersion: 1, round: report.round,
    decision: { verdict: 'VERIFIED', displayResult: report.mode === 'ci-only' ? 'CI-only' : 'VERIFIED', findings: [], reasons: [] },
    evidenceDigest: digest64('5'), reconcileDigest: jsonHash(report),
    coverage: report.touchedFeatures.map(f => f.id), riskAdjudication: [], artifactIds: [], inputFingerprint: report.inputFingerprint, retainedFrom: null,
  };
}

function attempt(role: Attempt['role'], directory: string): Attempt {
  const receipt = join(directory, 'receipt.json');
  const output = join(directory, 'output.json');
  writeFileSync(receipt, JSON.stringify({ schemaVersion: 1, status: 'complete', completedAt: '2026-09-22T05:00:01.000Z', model: 'composer-2.5', usage: null, remote: { agentId: 'bc-fixture', runId: 'run-' + executionId() } }));
  writeFileSync(output, '{}');
  return {
    id: executionId(), role, manifest: join(directory, 'manifest.json'),
    receipt: { path: receipt, sha256: hash(readFileSync(receipt)) },
    output: { path: output, sha256: hash(readFileSync(output)) },
    result: 'complete', evidence: [],
  };
}

function poolFile(directory: string) {
  const path = join(directory, 'pool.json');
  writeFileSync(path, JSON.stringify({
    at: '2026-09-22T04:50:02.703Z', cursorModelsUsedPercent: 2, otherModelsUsedPercent: 2,
    grokBotWeeklyUsedPercent: 1, onDemandUsedUSD: 0, stopThresholdPercent: 80,
  }));
  return path;
}

function cheapCost(): CostResult {
  return priceUsage({
    originalReceipt: { path: 'r', sha256: digest64('1') }, remoteRun: { agentId: 'bc-fixture', runId: 'run-1' },
    rawResponse: { path: 'u', sha256: digest64('2') }, requestedAt: 't', receivedAt: 't', model: 'composer-2.5',
    tokens: { input: 1000n, cacheRead: 0n, cacheWrite: 0n, output: 0n }, apiMoney: { rawCostCents: '0', chargedCents: '0' },
  });
}

function harness(t: { after: (fn: () => void) => void }, now: () => Date = () => new Date('2026-09-22T05:00:00.000Z')) {
  const directory = mkdtempSync(join(tmpdir(), 'clinic-ops-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const workRoot = join(directory, 'work');
  const evidenceRoot = join(directory, 'records');
  mkdirSync(workRoot, { recursive: true });
  mkdirSync(evidenceRoot, { recursive: true });
  const epochPath = join(directory, 'repository-epoch.json');
  writeFileSync(epochPath, JSON.stringify({ schemaVersion: 1, epochId: 'epoch-1', ownerId: 'owner-1', repo: 'Clinextapp/clinext', workRoot, origin: 'https://github.com/Clinextapp/clinext.git', acquiredAt: '2026-09-22T04:59:00.000Z', expiresAt: '2026-09-22T05:30:00.000Z', state: 'frozen' }));
  const repositoryEpoch = { path: epochPath, sha256: hash(readFileSync(epochPath)) };
  for (const entry of catalog) {
    for (const edit of entry.natural.edits) {
      if (!edit.before) continue;
      const full = join(workRoot, edit.path);
      mkdirSync(dirname(full), { recursive: true });
      if (!readExisting(full)) writeFileSync(full, `prefix\n${edit.before}\nsuffix\n`);
    }
  }
  let pr = 90;
  let laneRuns = 0;
  const events: string[] = [];
  const lifecycleCommandOverrides: string[] = [];
  let selectedRef = '';
  const refs = new Map<string, string | null>();
  const reports = new Map<number, Report>();
  let failPublish = false;
  const services: ProofServices = {
    now,
    command(file, args) {
      assert.equal(file, 'git');
      if (args[2] === 'status') return '';
      if (args[2] === 'checkout') {
        const ref = args[3];
        assert.ok(ref);
        selectedRef = ref;
        events.push(`checkout:${ref.replace('converge-proof/', '')}`);
        return '';
      }
      if (args[2] === 'branch') return selectedRef;
      if (args[2] === 'rev-parse') return head;
      throw new Error(`unexpected command: ${file} ${args.join(' ')}`);
    },
    alignDependencies() {
      events.push(`deps:${events.at(-1)?.replace('checkout:', '')}`);
    },
    async plant({ entry, ownerId, evidenceRoot: root, onIntent, command }) {
      if (command) lifecycleCommandOverrides.push(`plant:${entry.privateId}`);
      events.push(`plant:${entry.privateId}`);
      pr += 1;
      const ref = `converge-proof/${entry.privateId}`;
      refs.set(ref, head);
      const ownedPath = join(root, 'owned', `${entry.privateId}.json`);
      mkdirSync(dirname(ownedPath), { recursive: true });
      const owned: OwnedCase = {
        repo: 'Clinextapp/clinext', pr, ref, head, trunk, ownerId, privateId: entry.privateId,
        workRoot, origin: 'https://github.com/Clinextapp/clinext.git', repositoryEpoch,
        creationIntent: { path: join(root, 'intents', `${entry.privateId}.json`), sha256: digest64('a') },
        createdResource: { path: ownedPath, sha256: digest64('b') },
      };
      mkdirSync(dirname(owned.creationIntent.path), { recursive: true });
      writeFileSync(owned.creationIntent.path, JSON.stringify(owned));
      writeFileSync(ownedPath, JSON.stringify(owned));
      onIntent?.(owned.creationIntent);
      return owned;
    },
    async close({ owned, command }) {
      if (command) lifecycleCommandOverrides.push(`close:${owned.privateId}`);
      refs.set(owned.ref, null);
      const absence = { path: join(evidenceRoot, 'cleanup', owned.privateId + '.json'), sha256: digest64('c') };
      mkdirSync(dirname(absence.path), { recursive: true });
      writeFileSync(absence.path, '{"lease":"none"}\n');
      return { kind: 'closed-and-deleted', pr: owned.pr, ref: owned.ref, absence, lease: 'none' };
    },
    async reconcile({ pr: number, output }) {
      const entry = catalog[number - 91];
      if (!entry) throw new Error('unknown plant');
      const report = reportFor(entry, number);
      reports.set(number, report);
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
      return report;
    },
    async prepareLane({ directory, role, laneId }) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'prompt.txt'), 'read only');
      const manifest = join(directory, 'manifest.json');
      writeFileSync(manifest, JSON.stringify({ role, laneId }));
      return manifest;
    },
    async runLane({ manifestPath, role, evidenceRoot: dir }) {
      laneRuns += 1;
      return attempt(role, dir);
    },
    async publish({ reportFile }) {
      if (failPublish) { failPublish = false; throw new Error('publication crashed after comment; token=topsecret'); }
      const report = JSON.parse(readFileSync(reportFile, 'utf8')) as Report;
      const dossier = dossierFor(report);
      return { dossier, commentUrl: `https://github.com/Clinextapp/clinext/pull/${report.round.pr}#issuecomment-1`, statusId: 77, mustEndTurn: true as const };
    },
    async waitChecks(owned) { events.push(`wait:${owned.privateId}`); },
    async drainReaders() { return 'drained'; },
    async observeHead(owned) { return refs.get(owned.ref) ?? null; },
    async recordUsage({ receiptPath, evidenceDirectory }) {
      mkdirSync(evidenceDirectory, { recursive: true });
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
      const priced = cheapCost();
      if (priced.kind !== 'known' || !priced.sources[0]) throw new Error('expected known');
      return { ...priced.sources[0], originalReceipt: { path: receiptPath, sha256: hash(readFileSync(receiptPath)) }, remoteRun: { agentId: 'bc-fixture', runId: receipt.remote.runId } };
    },
  };
  return { directory, workRoot, evidenceRoot, pool: poolFile(directory), epochPath, services, events, lifecycleCommandOverrides, laneRuns: () => laneRuns, setFailPublish() { failPublish = true; } };
}

function readExisting(path: string) {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolveWait => setTimeout(resolveWait, 10));
  }
}

test('stale lock takeover cannot remove a newer live owner', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'clinic-ops-lock-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runFile = join(directory, 'run.json');
  const lock = runFile + '.lock';
  const coordination = join(directory, 'coordination');
  mkdirSync(lock);
  mkdirSync(coordination);
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ schemaVersion: 1, pid: 99999999, token: 'stale-token', acquiredAt: '2026-09-22T00:00:00.000Z' }));
  const source = `
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [moduleUrl, runFile, coordination, id, mode] = process.argv.slice(1);
const { claimRun } = await import(moduleUrl);
const pause = path => { while (!existsSync(path)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); };
const mark = name => writeFileSync(join(coordination, name + '-' + id), '');
try {
  const hooks = mode === 'stale' ? {
    afterStaleRead() { mark('ready'); pause(join(coordination, 'go')); },
    afterStaleRename() { mark('vacancy'); pause(join(coordination, 'allow')); },
    afterStaleRenameFailure() { mark('failed-rename'); pause(join(coordination, 'allow')); },
  } : {};
  const release = claimRun(runFile, hooks);
  mark('acquired');
  pause(join(coordination, 'release-' + id));
  release();
} catch (error) {
  writeFileSync(join(coordination, 'rejected-' + id), error instanceof Error ? error.message : String(error));
}
`;
  const children: ReturnType<typeof spawn>[] = [];
  const start = (id: string, mode: string) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, new URL('./run.ts', import.meta.url).href, runFile, coordination, id, mode], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    return child;
  };
  t.after(() => children.forEach(child => child.kill('SIGKILL')));
  const first = start('A', 'stale');
  const second = start('B', 'stale');
  await waitFor(() => existsSync(join(coordination, 'ready-A')) && existsSync(join(coordination, 'ready-B')), 'both stale readers');
  writeFileSync(join(coordination, 'go'), '');
  await waitFor(() => readdirSync(coordination).some(name => name.startsWith('vacancy-'))
    && readdirSync(coordination).some(name => name.startsWith('failed-rename-')), 'serialized stale rename');
  const third = start('C', 'fresh');
  await waitFor(() => existsSync(join(coordination, 'acquired-C')), 'third contender acquisition during vacancy');
  assert.equal(existsSync(join(coordination, 'acquired-A')), false);
  assert.equal(existsSync(join(coordination, 'acquired-B')), false);
  writeFileSync(join(coordination, 'allow'), '');
  await waitFor(() => existsSync(join(coordination, 'rejected-A')) && existsSync(join(coordination, 'rejected-B')), 'delayed contenders rejecting live owner');
  writeFileSync(join(coordination, 'release-C'), '');
  const exits = [first, second, third].map(child => new Promise<number | null>((resolveExit, rejectExit) => {
    if (child.exitCode !== null) { resolveExit(child.exitCode); return; }
    child.once('error', rejectExit);
    child.once('exit', resolveExit);
  }));
  assert.deepEqual(await Promise.all(exits), [0, 0, 0]);
  assert.equal(existsSync(lock + '.stale-stale-token'), true);
});

function closureFor(publication: Publication, ownerId: string, runId: string, directory: string) {
  const evidencePath = join(directory, 'host-' + publication.digest + '.json');
  const completedAt = '2026-09-22T05:01:00.000Z';
  const evidence = JSON.stringify({ kind: 'host-observed-terminal', nativeHandle: 'retained-owner', publicationDigest: publication.digest, ownerId, boundaryId: publication.boundaryId, completedTurn: runId, completedAt });
  writeFileSync(evidencePath, evidence);
  return {
    kind: 'host-observed-terminal' as const, ownerId, boundaryId: publication.boundaryId, publicationDigest: publication.digest, completedTurn: runId, nativeHandle: 'retained-owner', completedAt,
    hostCompletionEvidence: { path: evidencePath, sha256: hash(evidence) },
  };
}

test('assertCatalogEntry covers all ten mechanisms including secret absence and data-loss hard-list', () => {
  for (const entry of catalog) {
    const report = reportFor(entry, 1);
    const dossier = dossierFor(report);
    const attempts: Attempt[] = report.lanes.map(role => ({
      id: '1', role, manifest: 'm', receipt: { path: 'r', sha256: digest64('1') }, output: { path: 'o', sha256: digest64('2') }, result: 'complete', evidence: [],
    }));
    const commentBody = JSON.stringify(dossier);
    assert.equal(commentBody.includes('ghp_1234567890abcdefghijklmnopqrstuvwxyz'), false);
    const result = assertCatalogEntry(entry, { report, dossier, commentBody, attempts });
    assert.equal(result.ok, true, entry.privateId + ' ' + result.reason);
    assert.equal(result.completePass, true, entry.privateId);
  }
});

test('a matching negative mechanism stays complete when an established defect also has unresolved proof reasons', () => {
  const entry = catalog.find(candidate => candidate.expected.kind === 'secret');
  assert.ok(entry);
  const report = reportFor(entry, 1);
  const published = dossierFor(report);
  const dossier: Dossier = {
    ...published,
    decision: {
      ...published.decision,
      reasons: ['Required live feature coverage unavailable'],
    },
  };
  const attempts: Attempt[] = report.lanes.map(role => ({
    id: '1', role, manifest: 'm', receipt: { path: 'r', sha256: digest64('1') }, output: { path: 'o', sha256: digest64('2') }, result: 'complete', evidence: [],
  }));
  const observed = { report, dossier, commentBody: JSON.stringify(dossier), attempts };

  assert.deepEqual(mechanismHolds(entry, observed), {
    ok: true,
    complete: true,
    reason: undefined,
  });
  assert.deepEqual(assertCatalogEntry(entry, observed), {
    expected: 'NOT VERIFIED',
    observed: 'NOT VERIFIED',
    ok: true,
    completePass: true,
    reason: undefined,
  });
});

test('default lane service executes the persisted descriptor through the shared runner', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'clinic-ops-default-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  const executable = join(bin, 'grok');
  writeFileSync(executable, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'models') {
  process.stdout.write('You are logged in with grok.com.\\nAvailable models:\\n  * grok-4.6 (default)\\n');
} else {
  process.stdout.write(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'progress'}]}}) + '\\n');
  process.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'GROK_OK',session_id:'g1',usage:{input_tokens:30,output_tokens:4,total_tokens:34},total_cost_usd:0.02,modelUsage:{'grok-4.6':{}}}) + '\\n');
}
`);
  chmodSync(executable, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = bin + ':' + previousPath;
  t.after(() => { process.env.PATH = previousPath; });
  writeFileSync(join(directory, 'prompt.txt'), 'read only');
  const manifestPath = join(directory, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify({ descriptor: 'grok:grok-4.6@xhigh', prompt: 'prompt.txt', output: 'output.json', receipt: 'receipt.json' }));
  const result = await defaultServices().runLane({
    launchId: 'launch-1', manifestPath, repo: 'Clinextapp/clinext', pr: 1,
    role: 'pr reviewer', evidenceRoot: directory, parent: 'codex', workRoot: directory,
  });
  assert.equal(result.result, 'complete');
  assert.equal(result.output?.path, join(directory, 'output.json'));
  assert.equal(readFileSync(join(directory, 'output.json'), 'utf8'), 'GROK_OK');
  const original = { path: result.receipt.path, sha256: result.receipt.sha256 };
  const owned: OwnedCase = {
    repo: 'Clinextapp/clinext', pr: 1, ref: 'converge-proof/one', head, trunk, ownerId: 'owner-1', privateId: 'one',
    workRoot: directory, origin: 'https://github.com/Clinextapp/clinext.git', repositoryEpoch: original, creationIntent: original, createdResource: original,
  };
  assert.equal(await defaultServices().drainReaders(owned, [result]), 'drained');
  const activeReceipt = join(directory, 'active-receipt.json');
  writeFileSync(activeReceipt, JSON.stringify({ schemaVersion: 1, status: 'running', completedAt: null }));
  assert.equal(await defaultServices().drainReaders(owned, [{
    ...result, receipt: { path: activeReceipt, sha256: hash(readFileSync(activeReceipt)) },
  }]), 'active');
});

test('default reader drain requires and preserves exact remote terminal observation', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'clinic-ops-drain-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const receiptPath = join(directory, 'receipt.json');
  const receipt = {
    schemaVersion: 1, status: 'child-failed', completedAt: '2026-09-22T06:44:35.873Z', provider: 'cursor',
    preflight: { status: 'passed' }, remote: { agentId: 'bc-unresolved', runId: 'run-unresolved' },
  };
  writeFileSync(receiptPath, JSON.stringify(receipt));
  const attemptRecord: Attempt = {
    id: 'unresolved', role: 'pr verifier', manifest: join(directory, 'manifest.json'),
    receipt: { path: receiptPath, sha256: hash(readFileSync(receiptPath)) }, output: null, result: 'failed', evidence: [],
  };
  const original = attemptRecord.receipt;
  const owned: OwnedCase = {
    repo: 'Clinextapp/clinext', pr: 1, ref: 'converge-proof/one', head, trunk, ownerId: 'owner-1', privateId: 'one',
    workRoot: directory, origin: 'https://github.com/Clinextapp/clinext.git', repositoryEpoch: original,
    creationIntent: original, createdResource: { path: join(directory, 'owned.json'), sha256: original.sha256 },
  };
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.CURSOR_API_KEY;
  const previousBase = process.env.PSTACK_CURSOR_BASE_URL;
  process.env.CURSOR_API_KEY = 'test-reader-key';
  process.env.PSTACK_CURSOR_BASE_URL = 'http://127.0.0.1:43123';
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.CURSOR_API_KEY; else process.env.CURSOR_API_KEY = previousKey;
    if (previousBase === undefined) delete process.env.PSTACK_CURSOR_BASE_URL; else process.env.PSTACK_CURSOR_BASE_URL = previousBase;
  });
  let answer: 'throw' | 'running' | 'malformed' | 'wrong-run' | 'wrong-agent' | 'missing-identity' | 'terminal' = 'throw';
  let requests = 0;
  globalThis.fetch = async input => {
    requests += 1;
    assert.equal(String(input), 'http://127.0.0.1:43123/v1/agents/bc-unresolved/runs/run-unresolved');
    if (answer === 'throw') throw new Error('Remote observation unavailable');
    if (answer === 'malformed') return new Response('{not json', { status: 200 });
    if (answer === 'missing-identity') return new Response(JSON.stringify({ status: 'FINISHED' }), { status: 200 });
    return new Response(JSON.stringify({
      id: answer === 'wrong-run' ? 'run-other' : 'run-unresolved',
      agentId: answer === 'wrong-agent' ? 'bc-other' : 'bc-unresolved',
      status: answer === 'terminal' ? 'FINISHED' : answer === 'running' ? 'RUNNING' : 'FINISHED',
    }), { status: 200 });
  };
  assert.equal(await defaultServices().drainReaders(owned, [attemptRecord]), 'active');
  answer = 'running';
  assert.equal(await defaultServices().drainReaders(owned, [attemptRecord]), 'active');
  answer = 'malformed';
  assert.equal(await defaultServices().drainReaders(owned, [attemptRecord]), 'active');
  answer = 'wrong-run';
  assert.equal(await defaultServices().drainReaders(owned, [attemptRecord]), 'active');
  answer = 'wrong-agent';
  assert.equal(await defaultServices().drainReaders(owned, [attemptRecord]), 'active');
  answer = 'missing-identity';
  assert.equal(await defaultServices().drainReaders(owned, [attemptRecord]), 'active');
  answer = 'terminal';
  assert.equal(await defaultServices().drainReaders(owned, [attemptRecord]), 'drained');
  assert.equal(requests, 7);
  const observations = readdirSync(join(directory, 'reader-observations')).sort();
  assert.equal(observations.length, 7);
  const evidence = observations.map(name => readFileSync(join(directory, 'reader-observations', name), 'utf8')).join('\n');
  assert.match(evidence, /bc-unresolved/);
  assert.match(evidence, /run-unresolved/);
  assert.equal(evidence.includes('test-reader-key'), false);
  const rawBodies = observations.map(name => {
    const retained = JSON.parse(readFileSync(join(directory, 'reader-observations', name), 'utf8'));
    return Buffer.from(retained.rawBodyBase64, 'base64').toString('utf8');
  });
  assert.equal(rawBodies.includes('{"id":"run-unresolved","agentId":"bc-unresolved","status":"FINISHED"}'), true);

  const cursorWithoutRemote = (preflight: 'passed' | 'failed'): Attempt => {
    const bytes = JSON.stringify({
      schemaVersion: 1, status: 'child-failed', completedAt: '2026-09-22T06:44:35.873Z', provider: 'cursor',
      preflight: { status: preflight }, remote: null,
    });
    writeFileSync(receiptPath, bytes);
    return { ...attemptRecord, receipt: { path: receiptPath, sha256: hash(bytes) } };
  };
  assert.equal(await defaultServices().drainReaders(owned, [cursorWithoutRemote('passed')]), 'active');
  assert.equal(await defaultServices().drainReaders(owned, [cursorWithoutRemote('failed')]), 'drained');
});

test('runProof stops at publication and resumes only with a host-observed closure', async t => {
  const h = harness(t);
  const started = await runProof({
    kind: 'start', repo: 'Clinextapp/clinext', workRoot: h.workRoot, evidenceRoot: h.evidenceRoot,
    parent: 'claude', repositoryEpoch: h.epochPath,
    roles: { 'pr verifier': 'cursor:composer-2.5@high', 'pr reviewer': 'cursor:grok-4.7@high' },
    pool: h.pool, ownerId: 'owner-1', services: h.services,
  });
  assert.equal(started.kind, 'end-turn');
  if (started.kind !== 'end-turn') return;
  assert.equal(started.exitCode, 20);
  assert.notEqual(started.publication, 'uncertain');
  const blocked = await runProof({ kind: 'resume', runFile: started.continuation, pool: h.pool, services: h.services });
  assert.equal(blocked.kind, 'blocked');
  if (started.publication === 'uncertain') return;
  const closed = closureFor(started.publication, 'owner-1', JSON.parse(readFileSync(started.continuation, 'utf8')).runId, h.directory);
  const resumed = await runProof({ kind: 'resume', runFile: started.continuation, pool: h.pool, turnClosure: closed, services: h.services });
  assert.equal(resumed.kind, 'end-turn');
});

test('runProof plants every catalog case before awaiting the first exact-head CI', async t => {
  const h = harness(t);
  const boundary = await runProof({
    kind: 'start', repo: 'Clinextapp/clinext', workRoot: h.workRoot, evidenceRoot: h.evidenceRoot,
    parent: 'claude', repositoryEpoch: h.epochPath,
    roles: { 'pr verifier': 'cursor:composer-2.5@high', 'pr reviewer': 'cursor:grok-4.7@high' },
    pool: h.pool, ownerId: 'owner-1', services: h.services,
  });

  assert.equal(boundary.kind, 'end-turn');
  assert.deepEqual(h.events.slice(0, 13), [
    ...catalog.map(entry => `plant:${entry.privateId}`),
    'checkout:login-pitch',
    'deps:login-pitch',
    'wait:login-pitch',
  ]);
  assert.deepEqual(h.lifecycleCommandOverrides, []);
});

test('resume recovers publication-uncertain without a closure and refuses to reuse a closure for a new publication', async t => {
  const h = harness(t);
  h.setFailPublish();
  const started = await runProof({
    kind: 'start', repo: 'Clinextapp/clinext', workRoot: h.workRoot, evidenceRoot: h.evidenceRoot,
    parent: 'claude', repositoryEpoch: h.epochPath,
    roles: { 'pr verifier': 'cursor:composer-2.5@high', 'pr reviewer': 'cursor:grok-4.7@high' },
    pool: h.pool, ownerId: 'owner-1', services: h.services,
  });
  assert.equal(started.kind, 'end-turn');
  if (started.kind !== 'end-turn') return;
  assert.equal(started.publication, 'uncertain');
  const uncertainEnvelope = JSON.parse(readFileSync(started.continuation, 'utf8'));
  assert.equal(uncertainEnvelope.phase.failures.length, 1);
  const failureText = readFileSync(uncertainEnvelope.phase.failures[0].path, 'utf8');
  assert.match(failureText, /publication crashed after comment/);
  assert.equal(failureText.includes('topsecret'), false);
  assert.match(failureText, /\[redacted\]/);
  const originalInputs = uncertainEnvelope.phase.originalInputs;
  const boundaries = uncertainEnvelope.phase.boundaries;
  const recovered = await runProof({ kind: 'resume', runFile: started.continuation, pool: h.pool, services: h.services });
  assert.equal(recovered.kind, 'end-turn');
  if (recovered.kind !== 'end-turn' || recovered.publication === 'uncertain') return;
  const stale = closureFor(recovered.publication, 'owner-1', JSON.parse(readFileSync(recovered.continuation, 'utf8')).runId, h.directory);
  const envelope = JSON.parse(readFileSync(recovered.continuation, 'utf8'));
  envelope.phase.kind = 'publication-uncertain';
  envelope.phase.originalInputs = originalInputs;
  envelope.phase.boundaries = boundaries;
  writeFileSync(recovered.continuation, JSON.stringify(envelope));
  const reused = await runProof({ kind: 'resume', runFile: recovered.continuation, pool: h.pool, turnClosure: stale, services: h.services });
  assert.equal(reused.kind, 'blocked');
});

test('an unknown persisted launch blocks without relaunching or discarding history', async t => {
  const h = harness(t);
  const started = await runProof({
    kind: 'start', repo: 'Clinextapp/clinext', workRoot: h.workRoot, evidenceRoot: h.evidenceRoot,
    parent: 'claude', repositoryEpoch: h.epochPath,
    roles: { 'pr verifier': 'cursor:composer-2.5@high', 'pr reviewer': 'cursor:grok-4.7@high' },
    pool: h.pool, ownerId: 'owner-1', services: h.services,
  });
  assert.equal(started.kind, 'end-turn');
  if (started.kind !== 'end-turn') return;
  const envelope = JSON.parse(readFileSync(started.continuation, 'utf8'));
  const phase = envelope.phase;
  const launch = envelope.launches[0];
  writeFileSync(launch.manifestPath, JSON.stringify({ receipt: 'missing-receipt.json', output: 'output.json' }));
  launch.manifest = { path: launch.manifestPath, sha256: hash(readFileSync(launch.manifestPath)) };
  launch.state = 'launching';
  launch.attempt = null;
  envelope.originalAttempts = [];
  envelope.phase = { kind: 'collecting', owned: phase.owned, report: phase.report, attempts: [], selectedRoles: phase.selectedRoles };
  writeFileSync(started.continuation, JSON.stringify(envelope));
  const before = h.laneRuns();
  const resumed = await runProof({ kind: 'resume', runFile: started.continuation, pool: h.pool, services: h.services });
  assert.equal(resumed.kind, 'blocked');
  if (resumed.kind === 'blocked') assert.match(resumed.reason, /unknown remote work/);
  assert.equal(h.laneRuns(), before);
  const retained = JSON.parse(readFileSync(started.continuation, 'utf8'));
  assert.equal(retained.launches[0].state, 'launching');
});

test('an expired pool still permits cleanup before suspending the next launch', async t => {
  const h = harness(t);
  const started = await runProof({
    kind: 'start', repo: 'Clinextapp/clinext', workRoot: h.workRoot, evidenceRoot: h.evidenceRoot,
    parent: 'claude', repositoryEpoch: h.epochPath,
    roles: { 'pr verifier': 'cursor:composer-2.5@high', 'pr reviewer': 'cursor:grok-4.7@high' },
    pool: h.pool, ownerId: 'owner-1', services: h.services,
  });
  assert.equal(started.kind, 'end-turn');
  if (started.kind !== 'end-turn' || started.publication === 'uncertain') return;
  writeFileSync(h.pool, JSON.stringify({
    at: '2026-09-22T04:00:00.000Z', cursorModelsUsedPercent: 2, otherModelsUsedPercent: 2,
    grokBotWeeklyUsedPercent: 1, onDemandUsedUSD: 0, stopThresholdPercent: 80,
  }));
  const runId = JSON.parse(readFileSync(started.continuation, 'utf8')).runId;
  const resumed = await runProof({ kind: 'resume', runFile: started.continuation, pool: h.pool, turnClosure: closureFor(started.publication, 'owner-1', runId, h.directory), services: h.services });
  assert.equal(resumed.kind, 'blocked');
  if (resumed.kind === 'blocked') assert.match(resumed.reason, /expired/);
  const envelope = JSON.parse(readFileSync(started.continuation, 'utf8'));
  assert.equal(envelope.completed.length, 1);
  assert.equal(envelope.phase.kind, 'preparing');
  assert.equal(envelope.completed[0].cleanup.kind, 'closed-and-deleted');
});

test('a complete suite under 90 minutes prints ten result lines after every publication turn has closed', async t => {
  let clock = new Date('2026-09-22T05:00:00.000Z');
  const h = harness(t, () => clock);
  let boundary = await runProof({
    kind: 'start', repo: 'Clinextapp/clinext', workRoot: h.workRoot, evidenceRoot: h.evidenceRoot,
    parent: 'claude', repositoryEpoch: h.epochPath,
    roles: { 'pr verifier': 'cursor:composer-2.5@high', 'pr reviewer': 'cursor:grok-4.7@high' },
    pool: h.pool, ownerId: 'owner-1', services: h.services,
  });
  for (let i = 0; i < 10; i++) {
    assert.equal(boundary.kind, 'end-turn', 'turn ' + i);
    if (boundary.kind !== 'end-turn' || boundary.publication === 'uncertain') throw new Error('expected recorded publication');
    const runId = JSON.parse(readFileSync(boundary.continuation, 'utf8')).runId;
    const closed = closureFor(boundary.publication, 'owner-1', runId, h.directory);
    if (i === 9) clock = new Date('2026-09-22T06:29:00.000Z');
    boundary = await runProof({ kind: 'resume', runFile: boundary.continuation, pool: h.pool, turnClosure: closed, services: h.services });
  }
  assert.equal(boundary.kind, 'complete');
  if (boundary.kind !== 'complete') return;
  const text = renderSuite(boundary.summary);
  for (const entry of catalog) assert.match(text, new RegExp(`entry ${entry.privateId}: expected .+ got .+ ok`));
  assert.equal(boundary.summary.entries.length, 10);
  assert.equal(boundary.summary.entries.every(e => e.ok), true);
  assert.equal(boundary.summary.wallMilliseconds, 89 * 60 * 1000);
  assert.equal(boundary.summary.completePass, true);
  assert.equal(boundary.summary.resources, 'all-owned-resources-closed');
  assert.deepEqual(h.lifecycleCommandOverrides, []);
  assert.match(text, /required-lanes-1-9:/);
  assert.match(text, /catalog-including-human-update:/);
});

test('a complete suite over 90 minutes remains a failed performance gate', async t => {
  let clock = new Date('2026-09-22T05:00:00.000Z');
  const h = harness(t, () => clock);
  let boundary = await runProof({
    kind: 'start', repo: 'Clinextapp/clinext', workRoot: h.workRoot, evidenceRoot: h.evidenceRoot,
    parent: 'claude', repositoryEpoch: h.epochPath,
    roles: { 'pr verifier': 'cursor:composer-2.5@high', 'pr reviewer': 'cursor:grok-4.7@high' },
    pool: h.pool, ownerId: 'owner-1', services: h.services,
  });
  for (let i = 0; i < 10; i++) {
    assert.equal(boundary.kind, 'end-turn', 'turn ' + i);
    if (boundary.kind !== 'end-turn' || boundary.publication === 'uncertain') throw new Error('expected recorded publication');
    const runId = JSON.parse(readFileSync(boundary.continuation, 'utf8')).runId;
    const closed = closureFor(boundary.publication, 'owner-1', runId, h.directory);
    if (i === 9) clock = new Date('2026-09-22T06:31:00.000Z');
    boundary = await runProof({ kind: 'resume', runFile: boundary.continuation, pool: h.pool, turnClosure: closed, services: h.services });
  }

  assert.equal(boundary.kind, 'blocked');
  if (boundary.kind === 'blocked') assert.equal(boundary.reason, 'Suite exceeded 90 minutes including cleanup');
});

test('parseTurnClosure rejects process restart and self-declaration', t => {
  const directory = mkdtempSync(join(tmpdir(), 'clinic-ops-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const evidencePath = join(directory, 'host.json');
  const evidence = '{"nativeHandle":"retained"}';
  writeFileSync(evidencePath, evidence);
  const digest = hash(evidence);
  assert.throws(() => parseTurnClosure({
    kind: 'host-observed-terminal', ownerId: 'o', boundaryId: 'b', publicationDigest: digest64('1'), completedTurn: 'r', nativeHandle: 'retained',
    completedAt: '2026-09-22T05:00:00.000Z', processId: 12, hostCompletionEvidence: { path: evidencePath, sha256: digest },
  }, { ownerId: 'o', boundaryId: 'b', publicationDigest: digest64('1') }), /self-declaration|Process restart/);
});
