import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { leaseFile, readLease, releaseLease, takeLease, LEASE_TTL_HOURS } from './lease.ts';

const now = Date.parse('2026-09-28T12:00:00Z');
function state(t: { after(fn: () => void): void }): string { const d = mkdtempSync(join(tmpdir(), 'lease-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; }

test('a lease names the branch file safely and expires after its ttl', t => {
  const file = leaseFile(state(t), 'Example/app', 'feature/x y');
  assert.match(file, /leases\/Example-app-feature_x_y\.json$/);
  const lease = takeLease(file, { by: 'interactive', ttlHours: LEASE_TTL_HOURS, pid: null, now });
  assert.equal(lease.expiresAt, new Date(now + 3 * 3_600_000).toISOString());
  assert.deepEqual(readLease(file, now + 1), lease);
  assert.deepEqual(readdirSync(dirname(file)), [basename(file)], 'the write leaves no temporary file behind');
  assert.equal(readLease(file, now + 3 * 3_600_000), null);
});
test('another holder is refused while the lease is valid, and takes over once it expired or its pid died', t => {
  const file = leaseFile(state(t), 'Example/app', 'change');
  takeLease(file, { by: 'interactive', ttlHours: 3, pid: null, now });
  assert.throws(() => takeLease(file, { by: 'daemon:1', ttlHours: 3, pid: 1, now: now + 60_000 }), /Branch is leased by interactive until 2026-09-28T15:00:00\.000Z/);
  const renewed = takeLease(file, { by: 'interactive', ttlHours: 3, pid: null, now: now + 60_000 });
  assert.equal(renewed.startedAt, new Date(now).toISOString());
  assert.equal(renewed.expiresAt, new Date(now + 60_000 + 3 * 3_600_000).toISOString(), 'renewal moves the expiry forward');
  assert.equal(readLease(file, now + 4 * 3_600_000), null);
  takeLease(file, { by: 'daemon:99999999', ttlHours: 3, pid: 99999999, now: now + 4 * 3_600_000 });
  assert.equal(readLease(file, now + 4 * 3_600_000 + 1), null, 'a dead pid invalidates the lease');
  const mine = takeLease(file, { by: `daemon:${process.pid}`, ttlHours: 3, pid: process.pid, now });
  assert.equal(readLease(file, now + 1)?.by, mine.by);
  releaseLease(file, mine.by, now);
  assert.equal(readLease(file, now), null);
});
test('only the holder releases a valid lease; an absent or expired lease releases for anyone', t => {
  const file = leaseFile(state(t), 'Example/app', 'change');
  releaseLease(file, 'anyone', now);
  takeLease(file, { by: 'daemon:1', ttlHours: 3, pid: null, now });
  assert.throws(() => releaseLease(file, 'interactive', now + 1), /Branch is leased by daemon:1 until 2026-09-28T15:00:00\.000Z/);
  assert.equal(existsSync(file), true, 'a refused release keeps the file');
  releaseLease(file, 'daemon:1', now + 1);
  assert.equal(existsSync(file), false);
  takeLease(file, { by: 'daemon:1', ttlHours: 3, pid: null, now });
  releaseLease(file, 'interactive', now + 3 * 3_600_000);
  assert.equal(existsSync(file), false, 'an expired lease releases for another holder');
});
test('a take refuses a pid that is not a positive integer or a ttl that is not positive, before writing', t => {
  const file = leaseFile(state(t), 'Example/app', 'change');
  for (const pid of [0, -1, 1.5]) assert.throws(() => takeLease(file, { by: 'daemon', ttlHours: 3, pid, now }), /Invalid lease pid/);
  for (const ttlHours of [-1, 0, Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => takeLease(file, { by: 'daemon', ttlHours, pid: null, now }), /Invalid lease ttl/);
  assert.equal(existsSync(dirname(file)), false, 'nothing was written');
});
test('a corrupt lease file throws an error that names the file', t => {
  const file = leaseFile(state(t), 'Example/app', 'change');
  mkdirSync(dirname(file), { recursive: true });
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const body of ['{', '[]', JSON.stringify({ by: 'daemon', startedAt: 'soon', expiresAt: '2026-09-28T15:00:00.000Z', pid: null }), JSON.stringify({ by: 'daemon', startedAt: '2026-09-28T12:00:00.000Z', expiresAt: '2026-09-28T15:00:00.000Z', pid: 0 })]) {
    writeFileSync(file, body);
    assert.throws(() => readLease(file, now), new RegExp(`^Error: Invalid lease file ${escaped}: `));
    assert.throws(() => takeLease(file, { by: 'daemon', ttlHours: 3, pid: null, now }), new RegExp(`Invalid lease file ${escaped}`));
  }
});
