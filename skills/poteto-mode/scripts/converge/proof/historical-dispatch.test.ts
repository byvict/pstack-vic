import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { prepareAttempt, recoverReceipt, type DispatchSpec } from './historical-dispatch.ts';

const sha = 'a'.repeat(40);

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('receipt recovery distinguishes definite preflight failure from partial remote identity', t => {
  const directory = mkdtempSync(join(tmpdir(), 'historical-receipt-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const receipt = join(directory, 'receipt.json');
  writeFileSync(receipt, JSON.stringify({ status: 'unavailable-cli', remote: { agentId: null, runId: null } }));
  assert.equal(recoverReceipt(receipt).kind, 'definite-no-launch');

  writeFileSync(receipt, JSON.stringify({ status: 'child-failed', remote: { agentId: null, runId: null } }));
  assert.equal(recoverReceipt(receipt).kind, 'unknown');

  writeFileSync(receipt, JSON.stringify({
    status: 'child-failed', argv: ['POST', '/v1/agents', 'composer-2.5', 'high'],
    remote: { agentId: null, runId: null },
    error: { message: 'the launch request failed', evidence: 'HTTP 429: {"error":{"code":"rate_limit_exceeded","message":"GitHub rate limited"}}' },
  }));
  assert.equal(recoverReceipt(receipt).kind, 'definite-no-launch');

  writeFileSync(receipt, JSON.stringify({
    status: 'child-failed', argv: ['POST', '/v1/agents'],
    remote: { agentId: null, runId: null },
    error: { message: 'the launch request did not answer', evidence: 'HTTP 429: {"error":{"code":"rate_limit_exceeded"}}' },
  }));
  assert.equal(recoverReceipt(receipt).kind, 'unknown');

  writeFileSync(receipt, JSON.stringify({ status: 'failed', remote: { agentId: 'accepted-agent', runId: null } }));
  const partial = recoverReceipt(receipt);
  assert.equal(partial.kind, 'unknown');
  if (partial.kind === 'unknown') {
    assert.match(partial.reason, /incomplete remote identity/);
    assert.ok(partial.receipt);
    assert.equal(existsSync(partial.receipt.path), true);
  }

  writeFileSync(receipt, '{');
  const malformed = recoverReceipt(receipt);
  assert.equal(malformed.kind, 'unknown');
  if (malformed.kind === 'unknown') assert.match(malformed.reason, /partial or malformed/);
});

test('attempt intent and prompt bindings remain immutable across recovery', t => {
  const directory = mkdtempSync(join(tmpdir(), 'historical-intent-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const spec: DispatchSpec = {
    parent: 'codex',
    role: 'pr verifier',
    descriptor: 'cursor:composer-2.5@high',
    identity: { recordIndex: 0, repo: 'owner/repo', head: sha, base: 'b'.repeat(40), carrierHead: 'c'.repeat(40) },
    opaqueId: 'attempt-id', directory, carrierPr: 12, cwd: '/workspace', prompt: 'inspect exact revision',
  };
  const first = prepareAttempt(spec, new Date('2026-09-22T00:00:00.000Z'));
  const resumed = prepareAttempt(spec, new Date('2026-09-23T00:00:00.000Z'));
  assert.equal(resumed.intent.sha256, first.intent.sha256);
  assert.equal(resumed.createdAt, first.createdAt);
  assert.throws(
    () => prepareAttempt({ ...spec, prompt: 'different request' }, new Date('2026-09-23T00:00:00.000Z')),
    /prompt changed/,
  );
});

test('two stale-lock contenders cannot remove the winner lock after both observed the dead owner', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'historical-lock-race-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runFile = join(directory, 'run.json');
  writeFileSync(runFile, '{}');
  const lock = runFile + '.lock';
  mkdirSync(lock);
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: 999_999_999, token: 'dead-owner' }));
  const worker = join(import.meta.dirname, 'fixtures', 'historical', 'claim-contender.mjs');
  const children = ['a', 'b'].map(name => spawn(process.execPath, [worker, runFile, name], { stdio: 'pipe' }));
  t.after(() => children.forEach(child => child.kill()));
  await waitFor(() => ['a', 'b'].every(name => existsSync(join(directory, `ready-${name}`))), 'contenders did not both observe the dead owner');
  writeFileSync(join(directory, 'go'), 'go\n');
  await waitFor(() => ['a', 'b'].every(name => existsSync(join(directory, `result-${name}`))), 'contenders did not resolve the lock race');
  const results = ['a', 'b'].map(name => readFileSync(join(directory, `result-${name}`), 'utf8').trim());
  assert.deepEqual(results.map(result => result.startsWith('acquired')).sort(), [false, true]);
  assert.equal(existsSync(join(lock, 'owner.json')), true);
  assert.equal(existsSync(`${lock}.stale-dead-owner`), true);
  writeFileSync(join(directory, 'release'), 'release\n');
  await waitFor(() => children.every(child => child.exitCode !== null), 'contenders did not exit after release');
  assert.deepEqual(children.map(child => child.exitCode), [0, 0]);
  assert.equal(existsSync(lock), false);
});
