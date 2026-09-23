import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { main, printBoundary } from './cli.ts';

function poolFile(directory: string, extra: Record<string, unknown> = {}): string {
  const pool = join(directory, 'pool.json');
  writeFileSync(pool, JSON.stringify({
    at: new Date().toISOString(), cursorModelsUsedPercent: 2, otherModelsUsedPercent: 2,
    grokBotWeeklyUsedPercent: 1, onDemandUsedUSD: 0, stopThresholdPercent: 80, ...extra,
  }));
  return pool;
}

function gitWorkRoot(directory: string): { root: string; head: string } {
  const root = join(directory, 'patient-work');
  mkdirSync(root, { recursive: true });
  const git = (args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 'owner@example.com']);
  git(['config', 'user.name', 'owner']);
  writeFileSync(join(root, 'README'), 'carrier\n');
  git(['add', 'README']);
  git(['commit', '-qm', 'carrier']);
  git(['remote', 'add', 'origin', 'https://github.com/Clinextapp/clinext.git']);
  const head = git(['rev-parse', 'HEAD']).stdout.trim();
  return { root, head };
}

function fakeGh(directory: string, head: string): string {
  const bin = join(directory, 'bin');
  mkdirSync(bin, { recursive: true });
  const gh = join(bin, 'gh');
  writeFileSync(gh, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'pr' && args[1] === 'view') {
  process.stdout.write(JSON.stringify({
    number: 2890, state: 'OPEN', isDraft: false, headRefOid: ${JSON.stringify(head)},
    headRefName: 'converge-proof/session-test', labels: [{ name: 'needs-victor' }],
  }));
  process.exit(0);
}
process.stderr.write('unexpected gh ' + args.join(' '));
process.exit(1);
`);
  chmodSync(gh, 0o755);
  return bin;
}

test('CLI refuses benchmark-shaped work roots and missing descriptors', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'clinic-ops-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const pool = poolFile(directory);
  const rejected = await main([
    'run', '--repo', 'Clinextapp/clinext', '--work-root', join(directory, 'eval-work'),
    '--evidence', join(directory, 'records'), '--pool-observation', pool,
    '--repository-epoch', join(directory, 'epoch.json'), '--parent', 'codex',
    '--verifier', 'cursor:composer-2.5@high', '--reviewer', 'cursor:grok-4.7@high',
  ]);
  assert.equal(rejected, 1);
  const missing = await main(['run', '--repo', 'Clinextapp/clinext', '--work-root', join(directory, 'work'), '--evidence', join(directory, 'records'), '--pool-observation', pool, '--repository-epoch', join(directory, 'epoch.json'), '--parent', 'codex']);
  assert.equal(missing, 1);
});

test('run CLI exit gate consumes the typed completePass summary field', t => {
  t.mock.method(process.stdout, 'write', () => true);
  const zero = { kind: 'known' as const, equivalentNanoUSD: 0n, sources: [] };
  const costs = {
    perFullPass: [{ passId: 'one', cost: zero }], requiredLanesOneToNine: zero,
    allCatalogIncludingHumanUpdate: zero, historicalRoles: zero, organicEvaluation: zero,
  };
  const base = {
    entries: [{ id: 'one', expected: 'VERIFIED', observed: 'VERIFIED', ok: true, completePass: true }],
    costs, wallMilliseconds: 1, resources: 'all-owned-resources-closed' as const,
    targetedCase: null, selectedPass: true,
  };
  assert.equal(printBoundary({ kind: 'complete', summary: { ...base, completePass: true } }), 0);
  const costly = { ...costs, perFullPass: [{ passId: 'one', cost: { ...zero, equivalentNanoUSD: 814_303_000n } }] };
  assert.equal(printBoundary({ kind: 'complete', summary: { ...base, costs: costly, completePass: true } }), 0);
  assert.equal(printBoundary({ kind: 'complete', summary: { ...base, completePass: false } }), 1);
  assert.equal(printBoundary({ kind: 'complete', summary: { ...base, targetedCase: 'one', completePass: false } }), 0);
});

test('launcher prints usage on an unknown command', () => {
  const launcher = join(import.meta.dirname, '../converge-proof');
  const result = spawnSync(process.execPath, [launcher], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage: converge-proof run\|judge/);
});

test('judge CLI requires carrier PR and parent and no longer demands an injected runner', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'clinic-ops-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const pool = poolFile(directory);
  const usage = await main([
    'judge', '--repo', 'Clinextapp/clinext', '--work-root', join(directory, 'patient-work'),
    '--evidence', join(directory, 'records'), '--pool-observation', pool,
    '--carrier-head', 'a'.repeat(40), '--verifier', 'cursor:composer-2.5@high', '--reviewer', 'cursor:grok-4.7@high',
  ]);
  assert.equal(usage, 1);
});

test('judge CLI validates the held carrier and records failed launches as misses without aborting the 15-record denominator', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'clinic-ops-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { root, head } = gitWorkRoot(directory);
  const bin = fakeGh(directory, head);
  const pool = poolFile(directory);
  const evidence = join(directory, 'records');
  mkdirSync(evidence, { recursive: true });
  const previousKey = process.env.CURSOR_API_KEY;
  delete process.env.CURSOR_API_KEY;
  t.after(() => {
    if (previousKey === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = previousKey;
  });
  const previousPath = process.env.PATH;
  process.env.PATH = bin + ':' + previousPath;
  t.after(() => { process.env.PATH = previousPath; });
  const chunks: string[] = [];
  t.mock.method(process.stdout, 'write', (chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  });
  const code = await main([
    'judge', '--repo', 'Clinextapp/clinext', '--work-root', root, '--evidence', evidence,
    '--pool-observation', pool, '--carrier-pr', '2890', '--carrier-head', head,
    '--parent', 'codex', '--verifier', 'cursor:composer-2.5@high', '--reviewer', 'cursor:grok-4.7@high',
  ]);
  assert.equal(code, 1);
  const printed = chunks.join('');
  assert.match(printed, /pr verifier recall 0\/15/);
  assert.match(printed, /pr reviewer recall 0\/15/);
  assert.equal(printed.includes('injected runner'), false);
  const wrong = await main([
    'judge', '--repo', 'Clinextapp/clinext', '--work-root', root, '--evidence', join(directory, 'records-wrong'),
    '--pool-observation', pool, '--carrier-pr', '2890', '--carrier-head', 'b'.repeat(40),
    '--parent', 'codex', '--verifier', 'cursor:composer-2.5@high', '--reviewer', 'cursor:grok-4.7@high',
  ]);
  assert.equal(wrong, 1);
});
