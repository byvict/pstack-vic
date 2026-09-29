import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentLedger, exhausted, ledgerFile, markHeld, readLedger, withAttempt, writeLedger, type Attempt } from './ledger.ts';

const head = 'b'.repeat(40), other = 'c'.repeat(40);
const t0 = Date.parse('2026-09-28T12:00:00Z');
const attempt = (n: number, outcome: Attempt['outcome'], at = t0): Omit<Attempt, 'n'> => ({ kind: 'repair', startedAt: new Date(at).toISOString(), endedAt: new Date(at + 60_000).toISOString(), outcome, reason: outcome, runDirectory: `/tmp/run-${n}` });

test('a ledger starts fresh on a new head or after the hold label is removed', () => {
  const fresh = currentLedger(null, 'Example/app', 1, head, false);
  assert.deepEqual(fresh, { schemaVersion: 1, repo: 'Example/app', pr: 1, head, firstAttemptAt: null, heldAt: null, attempts: [] });
  const one = withAttempt(fresh, attempt(1, 'failed'));
  assert.equal(one.firstAttemptAt, attempt(1, 'failed').startedAt);
  assert.equal(currentLedger(one, 'Example/app', 1, head, false), one);
  assert.deepEqual(currentLedger(one, 'Example/app', 1, other, false).attempts, []);
  const held = markHeld(one, t0 + 120_000);
  assert.equal(currentLedger(held, 'Example/app', 1, head, true), held, 'label still on: nothing changes');
  assert.deepEqual(currentLedger(held, 'Example/app', 1, head, false).attempts, [], 'label removed: fresh start');
});
test('two failed attempts or six hours exhaust a head; deferred attempts do not count', () => {
  let ledger = currentLedger(null, 'Example/app', 1, head, false);
  ledger = withAttempt(ledger, attempt(1, 'deferred'));
  ledger = withAttempt(ledger, attempt(2, 'failed', t0 + 60_000));
  assert.equal(exhausted(ledger, t0 + 120_000), null);
  ledger = withAttempt(ledger, attempt(3, 'failed', t0 + 120_000));
  assert.equal(exhausted(ledger, t0 + 180_000), `two failed attempts on head ${head}`);
  let slow = withAttempt(currentLedger(null, 'Example/app', 1, head, false), attempt(1, 'deferred'));
  assert.equal(exhausted(slow, t0 + 5 * 3_600_000), null);
  assert.equal(exhausted(slow, t0 + 6 * 3_600_000), `six hours since the first attempt on head ${head}`);
  slow = withAttempt(slow, attempt(2, 'certified', t0 + 3_600_000));
  assert.equal(exhausted(slow, t0 + 7 * 3_600_000), null, 'a certified attempt closes the window');
});
test('the ledger round-trips through its file', t => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = ledgerFile(dir, 'Example/app', 7);
  assert.match(file, /ledger\/Example-app\/7\.json$/);
  assert.equal(readLedger(file), null);
  const ledger = withAttempt(currentLedger(null, 'Example/app', 7, head, false), attempt(1, 'failed'));
  writeLedger(file, ledger);
  assert.deepEqual(readLedger(file), ledger);
});
