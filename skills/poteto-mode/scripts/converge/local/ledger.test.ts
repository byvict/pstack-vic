import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { currentLedger, deferredBackoffUntil, exhausted, launchBackoffUntil, ledgerFile, markHeld, readLedger, withAttempt, withLaunchFailure, writeLedger, DEFERRED_BACKOFF_MINUTES, HEAD_WINDOW_HOURS, LAUNCH_FAILURE_BACKOFF_MINUTES, MAX_DEFERRED_ATTEMPTS, MAX_FAILED_ATTEMPTS, MAX_LAUNCH_FAILURES, type Attempt } from './ledger.ts';

const head = 'b'.repeat(40), other = 'c'.repeat(40);
const t0 = Date.parse('2026-09-28T12:00:00Z');
const attempt = (n: number, outcome: Attempt['outcome'], at = t0): Omit<Attempt, 'n'> => ({ kind: 'repair', startedAt: new Date(at).toISOString(), endedAt: new Date(at + 60_000).toISOString(), outcome, reason: outcome, runDirectory: `/tmp/run-${n}` });
function state(t: { after(fn: () => void): void }): string { const d = mkdtempSync(join(tmpdir(), 'ledger-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; }

test('a ledger starts fresh on a new head or after the hold label is removed', () => {
  const fresh = currentLedger(null, 'Example/app', 1, head, false);
  assert.deepEqual(fresh, { schemaVersion: 1, repo: 'Example/app', pr: 1, head, firstAttemptAt: null, heldAt: null, attempts: [], launchFailures: [] });
  const one = withAttempt(fresh, attempt(1, 'failed'));
  assert.equal(one.firstAttemptAt, attempt(1, 'failed').startedAt);
  assert.equal(withAttempt(fresh, { ...attempt(1, 'failed'), n: 9 } as Omit<Attempt, 'n'>).attempts[0]?.n, 1, 'the ledger numbers its attempts');
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
  assert.equal(exhausted(ledger, t0 + 180_000), `${MAX_FAILED_ATTEMPTS} failed attempts on head ${head}`);
  let slow = withAttempt(currentLedger(null, 'Example/app', 1, head, false), attempt(1, 'deferred'));
  assert.equal(exhausted(slow, t0 + 5 * 3_600_000), null);
  assert.equal(exhausted(slow, t0 + 6 * 3_600_000), `${HEAD_WINDOW_HOURS} hours since the first attempt on head ${head}`);
  slow = withAttempt(slow, attempt(2, 'certified', t0 + 3_600_000));
  assert.equal(exhausted(slow, t0 + 7 * 3_600_000), null, 'a certified attempt closes the window');
});
test('three deferred attempts exhaust a head, even after a certified one', () => {
  let ledger = withAttempt(currentLedger(null, 'Example/app', 1, head, false), attempt(1, 'certified'));
  for (let n = 2; n <= MAX_DEFERRED_ATTEMPTS; n++) ledger = withAttempt(ledger, attempt(n, 'deferred', t0 + n * 60_000));
  assert.equal(exhausted(ledger, t0 + 3_600_000), null, 'two deferred attempts do not');
  ledger = withAttempt(ledger, attempt(4, 'deferred', t0 + 5 * 60_000));
  assert.equal(MAX_DEFERRED_ATTEMPTS, 3);
  assert.equal(exhausted(ledger, t0 + 3_600_000), `${MAX_DEFERRED_ATTEMPTS} deferred attempts on head ${head}`);
});
test('a deferred latest attempt holds the next launch back until the backoff after its end', () => {
  const fresh = currentLedger(null, 'Example/app', 1, head, false);
  assert.equal(deferredBackoffUntil(fresh, t0), null, 'no attempt, no backoff');
  const deferred = withAttempt(fresh, attempt(1, 'deferred'));
  const ended = t0 + 60_000;
  assert.equal(DEFERRED_BACKOFF_MINUTES, 30);
  assert.equal(deferredBackoffUntil(deferred, ended), new Date(ended + 30 * 60_000).toISOString());
  assert.equal(deferredBackoffUntil(deferred, ended + 30 * 60_000 - 1), new Date(ended + 30 * 60_000).toISOString());
  assert.equal(deferredBackoffUntil(deferred, ended + 30 * 60_000), null, 'the backoff ends at its end');
  assert.equal(deferredBackoffUntil(withAttempt(deferred, attempt(2, 'failed', t0 + 120_000)), ended), null, 'only the latest attempt counts');
});
test('the ledger round-trips through its file, held or not, and leaves no temporary file', t => {
  const file = ledgerFile(state(t), 'Example/app', 7);
  assert.match(file, /ledger\/Example-app\/7\.json$/);
  assert.equal(readLedger(file), null);
  const ledger = withAttempt(currentLedger(null, 'Example/app', 7, head, false), attempt(1, 'failed'));
  writeLedger(file, ledger);
  assert.deepEqual(readLedger(file), ledger);
  const held = markHeld(ledger, t0 + 120_000);
  writeLedger(file, held);
  assert.deepEqual(readLedger(file), held);
  assert.deepEqual(readdirSync(dirname(file)), ['7.json']);
});
test('a corrupt or invalid ledger file throws an error that names the file', t => {
  const file = ledgerFile(state(t), 'Example/app', 7);
  mkdirSync(dirname(file), { recursive: true });
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const valid = withAttempt(currentLedger(null, 'Example/app', 7, head, false), attempt(1, 'failed'));
  const first = valid.attempts[0];
  const cases: Array<[string, RegExp]> = [
    ['{"schemaVersion":1,"re', /JSON/],
    ['[]', /Invalid ledger$/],
    [JSON.stringify({ ...valid, schemaVersion: 2 }), /Unknown ledger schema$/],
    [JSON.stringify({ ...valid, firstAttemptAt: 'not-a-date' }), /Invalid ledger first attempt$/],
    [JSON.stringify({ ...valid, heldAt: 'soon' }), /Invalid ledger hold$/],
    [JSON.stringify({ ...valid, attempts: [{ ...first, startedAt: 'later' }] }), /Invalid attempt start$/],
    [JSON.stringify({ ...valid, attempts: [{ ...first, endedAt: '' }] }), /Invalid attempt end$/],
  ];
  for (const [body, cause] of cases) {
    writeFileSync(file, body);
    assert.throws(() => readLedger(file), (error: Error) => new RegExp(`^Invalid ledger file ${escaped}: `).test(error.message) && cause.test(error.message), body);
  }
});
test('three launch failures on a head hold the next launch back for an hour; a recorded attempt or a new head clears them', () => {
  let ledger = currentLedger(null, 'Example/app', 1, head, false);
  assert.equal(launchBackoffUntil(ledger, t0), null, 'no failure, no backoff');
  for (let n = 1; n < MAX_LAUNCH_FAILURES; n++) ledger = withLaunchFailure(ledger, { at: new Date(t0 + n * 60_000).toISOString(), reason: 'no outcome: raiz exited 1' });
  assert.equal(launchBackoffUntil(ledger, t0 + 3 * 60_000), null, 'two failures do not');
  const at = t0 + MAX_LAUNCH_FAILURES * 60_000;
  ledger = withLaunchFailure(ledger, { at: new Date(at).toISOString(), reason: 'no outcome: raiz did not start' });
  assert.equal(MAX_LAUNCH_FAILURES, 3); assert.equal(LAUNCH_FAILURE_BACKOFF_MINUTES, 60);
  assert.equal(ledger.firstAttemptAt, null, 'a launch failure never opens the head window');
  const until = new Date(at + 60 * 60_000).toISOString();
  assert.equal(launchBackoffUntil(ledger, at), until);
  assert.equal(launchBackoffUntil(ledger, at + 60 * 60_000 - 1), until);
  assert.equal(launchBackoffUntil(ledger, at + 60 * 60_000), null, 'the backoff ends at its end');
  const again = withLaunchFailure(ledger, { at: new Date(at + 61 * 60_000).toISOString(), reason: 'no outcome: raiz exited 1' });
  assert.equal(launchBackoffUntil(again, at + 62 * 60_000), new Date(at + 121 * 60_000).toISOString(), 'a fourth failure after the backoff starts another one');
  const recovered = withAttempt(again, attempt(1, 'certified', at + 62 * 60_000));
  assert.deepEqual(recovered.launchFailures, []);
  assert.equal(recovered.attempts.length, 1);
  assert.deepEqual(currentLedger(again, 'Example/app', 1, other, false).launchFailures, [], 'a new head starts clean');
});
test('a ledger file without launchFailures reads as none, and a failure with a bad time is refused', t => {
  const file = ledgerFile(state(t), 'Example/app', 7);
  mkdirSync(dirname(file), { recursive: true });
  const valid = withAttempt(currentLedger(null, 'Example/app', 7, head, false), attempt(1, 'failed'));
  const { launchFailures, ...written } = valid;
  writeFileSync(file, JSON.stringify(written));
  assert.deepEqual(readLedger(file), valid, 'a 0.4.0 ledger reads as one with no launch failure');
  const failed = withLaunchFailure(valid, { at: new Date(t0).toISOString(), reason: 'no outcome: raiz exited 1' });
  writeLedger(file, failed);
  assert.deepEqual(readLedger(file), failed);
  writeFileSync(file, JSON.stringify({ ...failed, launchFailures: [{ at: 'soon', reason: '' }] }));
  assert.throws(() => readLedger(file), /Invalid launch failure time$/);
});
