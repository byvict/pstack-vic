import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash } from '../contract.ts';
import {
  admitLaunch, combineCosts, formatUsd, fullPassUnderLimit, parseUsageResponse, priceUsage, recordUsage, USAGE_HOST,
  type Usage,
} from './usage.ts';

const composerResponse = {
  totalUsage: { inputTokens: 57200, outputTokens: 4625, cacheWriteTokens: 0, cacheReadTokens: 544640, totalTokens: 606465 },
  cost: { rawCostCents: 14.90905, chargedCents: 14.90905 },
  runs: [{
    id: 'run-9ac637a5-1e96-41b7-9e80-1531e540bf29',
    usageUuid: '9c077f95-8f11-5745-aa6c-5fb05181d942',
    usage: { inputTokens: 57200, outputTokens: 4625, cacheWriteTokens: 0, cacheReadTokens: 544640, totalTokens: 606465 },
    cost: { rawCostCents: 14.90905, chargedCents: 14.90905 },
  }],
};
const grokResponse = {
  totalUsage: { inputTokens: 73123, outputTokens: 9511, cacheWriteTokens: 0, cacheReadTokens: 545280, totalTokens: 627914 },
  cost: { rawCostCents: 47.5952, chargedCents: 47.5952 },
  runs: [{
    id: 'run-589ffe55-6cc8-4b4b-ad17-51182040b6bc',
    usage: { inputTokens: 73123, outputTokens: 9511, cacheWriteTokens: 0, cacheReadTokens: 545280, totalTokens: 627914 },
    cost: { rawCostCents: 47.5952, chargedCents: 47.5952 },
  }],
};

function usage(model: string, tokens: Usage['tokens'], runId: string): Usage {
  return {
    originalReceipt: { path: 'receipt.json', sha256: '1'.repeat(64) },
    remoteRun: { agentId: 'bc-x', runId },
    rawResponse: { path: 'usage.json', sha256: '2'.repeat(64) },
    requestedAt: '2026-09-22T04:53:20.000Z', receivedAt: '2026-09-22T04:53:21.000Z',
    model, tokens, apiMoney: { rawCostCents: '0', chargedCents: '0' },
  };
}

test('prices Composer and Grok calibrations in nano-USD and refuses nonzero cache-write', () => {
  const composer = parseUsageResponse(composerResponse, 'run-9ac637a5-1e96-41b7-9e80-1531e540bf29');
  const priced = priceUsage(usage('composer-2.5', composer.tokens, 'run-9ac637a5-1e96-41b7-9e80-1531e540bf29'));
  assert.equal(priced.kind, 'known');
  if (priced.kind === 'known') {
    assert.equal(priced.equivalentNanoUSD, 149090500n);
    assert.equal(formatUsd(priced.equivalentNanoUSD), '0.1490905');
  }
  const grok = parseUsageResponse(grokResponse, 'run-589ffe55-6cc8-4b4b-ad17-51182040b6bc');
  const grokPriced = priceUsage(usage('grok-4.6', grok.tokens, 'run-589ffe55-6cc8-4b4b-ad17-51182040b6bc'));
  assert.equal(grokPriced.kind, 'known');
  if (grokPriced.kind === 'known') {
    assert.equal(grokPriced.equivalentNanoUSD, 475952000n);
    assert.equal(fullPassUnderLimit(grokPriced), true);
  }
  const grok47Priced = priceUsage(usage('grok-4.7', grok.tokens, 'run-grok-4-7'));
  assert.equal(grok47Priced.kind, 'known');
  if (grok47Priced.kind === 'known') assert.equal(grok47Priced.equivalentNanoUSD, 475952000n);
  const cacheWrite = priceUsage(usage('composer-2.5', { input: 1n, cacheRead: 0n, cacheWrite: 8n, output: 1n }, 'run-cache'));
  assert.equal(cacheWrite.kind, 'unavailable');
  assert.equal(fullPassUnderLimit({ kind: 'unavailable', reason: 'missing', originalEvidence: [] }), false);
  assert.throws(() => parseUsageResponse(composerResponse, 'run-other'), /Exact run usage is missing/);
});

test('deduplicates only the identical remote run and keeps failed attempts', () => {
  const a = priceUsage(usage('composer-2.5', { input: 1000n, cacheRead: 0n, cacheWrite: 0n, output: 0n }, 'run-1'));
  const b = priceUsage(usage('composer-2.5', { input: 1000n, cacheRead: 0n, cacheWrite: 0n, output: 0n }, 'run-1'));
  const c = priceUsage(usage('composer-2.5', { input: 2000n, cacheRead: 0n, cacheWrite: 0n, output: 0n }, 'run-2'));
  const sum = combineCosts([a, b, c]);
  assert.equal(sum.kind, 'known');
  if (sum.kind === 'known') assert.equal(sum.equivalentNanoUSD, 1500000n);
});

test('pool observations expire at 30 minutes and stop at 80 percent', t => {
  const directory = mkdtempSync(join(tmpdir(), 'proof-pool-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'pool.json');
  writeFileSync(path, JSON.stringify({
    at: '2026-09-22T04:50:02.703Z', cursorModelsUsedPercent: 2, otherModelsUsedPercent: 2,
    grokBotWeeklyUsedPercent: 1, onDemandUsedUSD: 0, stopThresholdPercent: 80,
  }));
  const ok = admitLaunch(path, new Date('2026-09-22T05:10:00.000Z'));
  assert.equal(ok.kind, 'permit');
  const expired = admitLaunch(path, new Date('2026-09-22T05:21:00.000Z'));
  assert.equal(expired.kind, 'denied');
  writeFileSync(path, JSON.stringify({
    at: '2026-09-22T04:50:02.703Z', cursorModelsUsedPercent: 80, otherModelsUsedPercent: 2,
    grokBotWeeklyUsedPercent: 1, onDemandUsedUSD: 0, stopThresholdPercent: 80,
  }));
  const stopped = admitLaunch(path, new Date('2026-09-22T05:10:00.000Z'));
  assert.equal(stopped.kind, 'denied');
  writeFileSync(path, JSON.stringify({
    at: '2026-09-22T05:11:00.000Z', cursorModelsUsedPercent: 2, otherModelsUsedPercent: 2,
    grokBotWeeklyUsedPercent: 1, onDemandUsedUSD: 0, stopThresholdPercent: 80,
  }));
  const future = admitLaunch(path, new Date('2026-09-22T05:10:00.000Z'));
  assert.equal(future.kind, 'denied');
  if (future.kind === 'denied') assert.match(future.reason, /future/);
  writeFileSync(path, JSON.stringify({
    at: '2026-09-22T05:00:00.000Z', cursorModelsUsedPercent: 101, otherModelsUsedPercent: 2,
    grokBotWeeklyUsedPercent: 1, onDemandUsedUSD: 0, stopThresholdPercent: 80,
  }));
  assert.equal(admitLaunch(path, new Date('2026-09-22T05:10:00.000Z')).kind, 'denied');
  writeFileSync(path, JSON.stringify({
    at: '2026-09-22T05:00:00.000Z', cursorModelsUsedPercent: 2, otherModelsUsedPercent: 2,
    grokBotWeeklyUsedPercent: 1, onDemandUsedUSD: 0, stopThresholdPercent: 90,
  }));
  assert.equal(admitLaunch(path, new Date('2026-09-22T05:10:00.000Z')).kind, 'denied');
});

test('recordUsage keeps the original receipt bytes and binds the exact run', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'proof-usage-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const receiptPath = join(directory, 'receipt.json');
  const receipt = { schemaVersion: 1, model: 'composer-2.5', usage: null, costUsd: null, remote: { agentId: 'bc-1a66a9e9-c900-4e73-bc9c-97d617793624', runId: 'run-9ac637a5-1e96-41b7-9e80-1531e540bf29' } };
  writeFileSync(receiptPath, JSON.stringify(receipt));
  const before = readFileSync(receiptPath);
  const recorded = await recordUsage({
    receiptPath, evidenceDirectory: join(directory, 'usage'),
    now: () => new Date('2026-09-22T04:53:20.000Z'),
    fetchUsage: async url => {
      assert.equal(url, `${USAGE_HOST}/v1/agents/bc-1a66a9e9-c900-4e73-bc9c-97d617793624/usage?runId=run-9ac637a5-1e96-41b7-9e80-1531e540bf29`);
      return composerResponse;
    },
  });
  assert.equal('kind' in recorded, false);
  if (!('kind' in recorded)) {
    assert.equal(recorded.tokens.input, 57200n);
    assert.equal(recorded.originalReceipt.sha256, hash(before));
  }
  assert.deepEqual(readFileSync(receiptPath), before);
  const reused = await recordUsage({
    receiptPath, evidenceDirectory: join(directory, 'usage'),
    fetchUsage: async () => { throw new Error('immutable supplement should be reused'); },
  });
  assert.equal('kind' in reused, false);
});

test('recordUsage treats a missing remote as unavailable and retains malformed response bytes', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'proof-usage-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const localReceipt = join(directory, 'local.json');
  writeFileSync(localReceipt, JSON.stringify({ schemaVersion: 1, model: 'composer-2.5' }));
  const local = await recordUsage({ receiptPath: localReceipt, evidenceDirectory: join(directory, 'usage') });
  assert.equal('kind' in local && local.kind, 'unavailable');

  const failedLaunchReceipt = join(directory, 'failed-launch.json');
  writeFileSync(failedLaunchReceipt, JSON.stringify({
    schemaVersion: 1, model: 'composer-2.5',
    remote: { agentId: null, runId: null, agentUrl: null, heads: { kind: 'not-taken' } },
  }));
  const failedLaunch = await recordUsage({ receiptPath: failedLaunchReceipt, evidenceDirectory: join(directory, 'usage') });
  assert.equal('kind' in failedLaunch && failedLaunch.kind, 'unavailable');

  const remoteReceipt = join(directory, 'remote.json');
  writeFileSync(remoteReceipt, JSON.stringify({ schemaVersion: 1, model: 'composer-2.5', remote: { agentId: 'agent-1', runId: 'run-malformed' } }));
  const malformed = await recordUsage({
    receiptPath: remoteReceipt, evidenceDirectory: join(directory, 'usage'),
    now: () => new Date('2026-09-22T05:00:00.000Z'), fetchUsage: async () => ({ runs: 'bad' }),
  });
  assert.equal('kind' in malformed && malformed.kind, 'unavailable');
  if ('kind' in malformed) {
    assert.equal(malformed.evidence.path.endsWith('run-malformed.usage.json'), true);
    const retained = JSON.parse(readFileSync(malformed.evidence.path, 'utf8'));
    assert.equal(Buffer.from(retained.rawBodyBase64, 'base64').toString('utf8'), '{"runs":"bad"}');
  }
  const recovered = await recordUsage({
    receiptPath: remoteReceipt, evidenceDirectory: join(directory, 'usage'),
    fetchUsage: async () => { throw new Error('must not refetch immutable malformed bytes'); },
  });
  assert.equal('kind' in recovered && recovered.kind, 'unavailable');
});

test('default usage fetch preserves malformed and HTTP-error response bytes before parsing', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'proof-usage-http-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.CURSOR_API_KEY;
  process.env.CURSOR_API_KEY = 'private-test-key';
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.CURSOR_API_KEY; else process.env.CURSOR_API_KEY = previousKey;
  });
  let body = '{malformed-json';
  let status = 200;
  globalThis.fetch = async () => new Response(body, { status });

  const malformedReceipt = join(directory, 'malformed-receipt.json');
  writeFileSync(malformedReceipt, JSON.stringify({ schemaVersion: 1, model: 'composer-2.5', remote: { agentId: 'agent-1', runId: 'run-raw-malformed' } }));
  const malformed = await recordUsage({ receiptPath: malformedReceipt, evidenceDirectory: join(directory, 'malformed') });
  assert.equal('kind' in malformed && malformed.kind, 'unavailable');
  if ('kind' in malformed) {
    const retained = JSON.parse(readFileSync(malformed.evidence.path, 'utf8'));
    assert.equal(Buffer.from(retained.rawBodyBase64, 'base64').toString('utf8'), body);
    assert.equal(JSON.stringify(retained).includes('private-test-key'), false);
  }

  body = 'upstream unavailable\n';
  status = 503;
  const failedReceipt = join(directory, 'failed-receipt.json');
  writeFileSync(failedReceipt, JSON.stringify({ schemaVersion: 1, model: 'composer-2.5', remote: { agentId: 'agent-1', runId: 'run-http-failed' } }));
  const failed = await recordUsage({ receiptPath: failedReceipt, evidenceDirectory: join(directory, 'failed') });
  assert.equal('kind' in failed && failed.kind, 'unavailable');
  if ('kind' in failed) {
    const retained = JSON.parse(readFileSync(failed.evidence.path, 'utf8'));
    assert.equal(retained.httpStatus, 503);
    assert.equal(Buffer.from(retained.rawBodyBase64, 'base64').toString('utf8'), body);
  }
});
