import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { leaseFile, readLease, releaseLease, takeLease, LEASE_TTL_HOURS } from './lease.ts';

const now = Date.parse('2026-09-28T12:00:00Z');
function state(t: { after(fn: () => void): void }): string { const d = mkdtempSync(join(tmpdir(), 'lease-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; }

test('a lease names the branch file safely and expires after its ttl', t => {
  const file = leaseFile(state(t), 'Example/app', 'feature/x y');
  assert.match(file, /leases\/Example-app-feature_x_y\.json$/);
  const lease = takeLease(file, { by: 'interactive', ttlHours: LEASE_TTL_HOURS, pid: null, now });
  assert.equal(lease.expiresAt, new Date(now + 3 * 3_600_000).toISOString());
  assert.deepEqual(readLease(file, now + 1), lease);
  assert.equal(readLease(file, now + 3 * 3_600_000), null);
});
test('another holder is refused while the lease is valid, and takes over once it expired or its pid died', t => {
  const file = leaseFile(state(t), 'Example/app', 'change');
  takeLease(file, { by: 'interactive', ttlHours: 3, pid: null, now });
  assert.throws(() => takeLease(file, { by: 'daemon:1', ttlHours: 3, pid: 1, now: now + 60_000 }), /Branch is leased by interactive until 2026-09-28T15:00:00\.000Z/);
  const renewed = takeLease(file, { by: 'interactive', ttlHours: 3, pid: null, now: now + 60_000 });
  assert.equal(renewed.startedAt, new Date(now).toISOString());
  assert.equal(readLease(file, now + 4 * 3_600_000), null);
  takeLease(file, { by: 'daemon:99999999', ttlHours: 3, pid: 99999999, now: now + 4 * 3_600_000 });
  assert.equal(readLease(file, now + 4 * 3_600_000 + 1), null, 'a dead pid invalidates the lease');
  const mine = takeLease(file, { by: `daemon:${process.pid}`, ttlHours: 3, pid: process.pid, now });
  assert.equal(readLease(file, now + 1)?.by, mine.by);
  releaseLease(file);
  assert.equal(readLease(file, now), null);
});
