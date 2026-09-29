import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { integer, object, repoName, string } from '../contract.ts';

export const LEASE_TTL_HOURS = 3;
export interface Lease { by: string; startedAt: string; expiresAt: string; pid: number | null }
export function leaseFile(stateDirectory: string, repo: string, branch: string): string {
  return join(stateDirectory, 'leases', `${repoName(repo).replace('/', '-')}-${branch.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
}
export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}
function pid(value: unknown): number {
  const result = integer(value, 'lease pid');
  if (result === 0) throw new Error('Invalid lease pid');
  return result;
}
function instant(value: unknown, label: string): string {
  const result = string(value, label);
  if (Number.isNaN(Date.parse(result))) throw new Error(`Invalid ${label}`);
  return result;
}
/** A lease is valid until it expires and, when it names a pid, while that process exists. */
export function readLease(file: string, now = Date.now()): Lease | null {
  let lease: Lease;
  try {
    const v = object(JSON.parse(readFileSync(file, 'utf8')), 'lease');
    lease = { by: string(v.by, 'lease holder'), startedAt: instant(v.startedAt, 'lease start'), expiresAt: instant(v.expiresAt, 'lease expiry'), pid: v.pid === null ? null : pid(v.pid) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Invalid lease file ${file}: ${(error as Error).message}`);
  }
  if (!(Date.parse(lease.expiresAt) > now)) return null;
  if (lease.pid !== null && !alive(lease.pid)) return null;
  return lease;
}
function unlessHeldByOther(file: string, by: string, now: number): Lease | null {
  const current = readLease(file, now);
  if (current && current.by !== by) throw new Error(`Branch is leased by ${current.by} until ${current.expiresAt}`);
  return current;
}
export function takeLease(file: string, options: { by: string; ttlHours: number; pid: number | null; now?: number }): Lease {
  const now = options.now ?? Date.now();
  if (options.pid !== null) pid(options.pid);
  if (!(Number.isFinite(options.ttlHours) && options.ttlHours > 0)) throw new Error('Invalid lease ttl');
  const current = unlessHeldByOther(file, options.by, now);
  const lease: Lease = { by: options.by, startedAt: current?.startedAt ?? new Date(now).toISOString(), expiresAt: new Date(now + options.ttlHours * 3_600_000).toISOString(), pid: options.pid };
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(lease, null, 2) + '\n', { mode: 0o600 });
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
  return lease;
}
/** Removes the lease unless another holder's lease is still valid. */
export function releaseLease(file: string, by: string, now = Date.now()): void {
  unlessHeldByOther(file, by, now);
  rmSync(file, { force: true });
}
