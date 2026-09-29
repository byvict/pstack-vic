import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
/** A lease is valid until it expires and, when it names a pid, while that process exists. */
export function readLease(file: string, now = Date.now()): Lease | null {
  if (!existsSync(file)) return null;
  const v = object(JSON.parse(readFileSync(file, 'utf8')), 'lease');
  const lease: Lease = { by: string(v.by), startedAt: string(v.startedAt), expiresAt: string(v.expiresAt), pid: v.pid === null ? null : integer(v.pid) };
  if (!(Date.parse(lease.expiresAt) > now)) return null;
  if (lease.pid !== null && !alive(lease.pid)) return null;
  return lease;
}
export function takeLease(file: string, options: { by: string; ttlHours: number; pid: number | null; now?: number }): Lease {
  const now = options.now ?? Date.now();
  const current = readLease(file, now);
  if (current && current.by !== options.by) throw new Error(`Branch is leased by ${current.by} until ${current.expiresAt}`);
  const lease: Lease = { by: options.by, startedAt: current?.startedAt ?? new Date(now).toISOString(), expiresAt: new Date(now + options.ttlHours * 3_600_000).toISOString(), pid: options.pid };
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(lease, null, 2) + '\n', { mode: 0o600 });
  return lease;
}
export function releaseLease(file: string): void { rmSync(file, { force: true }); }
