import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { array, object, repoName, sha, string } from '../contract.ts';
import { conditional } from '../github.ts';
import type { LocalConfig } from './config.ts';
import { WAKEABLE, type Wakeable } from './launchd.ts';
import { nudge } from './wake.ts';

/** What the last complete watch tick of one repository read: the ETag of each resource, and the trunk name and open PR heads from the PR list, which a 304 does not repeat. */
export interface WatchState { schemaVersion: 1; repo: string; trunk: string | null; heads: string[]; etags: Record<string, string> }
export interface Watched { repo: string; reads: number; changed: string[]; failure: string | null }
/** `woken` names the jobs the tick woke, or, under `--dry-run`, would wake. */
export interface WatchReport { job: 'watch'; repos: Watched[]; woken: Wakeable[] }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
export function watchFile(stateDirectory: string, repo: string): string { return join(stateDirectory, 'watch', `${repoName(repo).replace('/', '-')}.json`); }
function parseWatch(value: unknown): WatchState {
  const v = object(value, 'watch state');
  if (v.schemaVersion !== 1) throw new Error('Unknown watch schema');
  return { schemaVersion: 1, repo: repoName(v.repo), trunk: v.trunk === null ? null : string(v.trunk, 'trunk'), heads: array(v.heads).map(sha), etags: Object.fromEntries(Object.entries(object(v.etags, 'etags')).map(([endpoint, etag]) => [endpoint, string(etag, 'etag')])) };
}
function readWatch(file: string): WatchState | null {
  try { return parseWatch(JSON.parse(readFileSync(file, 'utf8'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Invalid watch file ${file}: ${message(error)}`);
  }
}
function writeWatch(file: string, state: WatchState): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
}
const PULLS = 'pulls?state=open&per_page=100';
const checkRuns = (ref: string) => `commits/${encodeURIComponent(ref)}/check-runs?filter=all&per_page=100`;
interface Read { path: string; etag: string; seen: 'first' | 'unchanged' | 'changed'; body: string }
interface Pass { watched: Watched; wake: Wakeable[]; next: WatchState | null }
/** One repository. The open PR list moves on a PR opened, closed or reopened, a head push, a label, a draft flip, and whatever else the list shows (a comment moves `updated_at`, a push to any branch moves the repository's `pushed_at`): both jobs care. The trunk tip's check runs move when trunk moves or one of its checks changes: the sweep arms only on a green trunk. An open head's check runs move when a check on it starts or ends: the raiz job certifies an uncertified head once its tests check completed, and repairs a certified one whose required check failed. The trunk name comes from the PR list, or, before any PR listed it, from one read of the repository, and is kept when the list empties: the trunk check runs are read every minute, so the sweep wakes within a minute of trunk's push CI finishing after a merge, which the post-merge pass waits for. A repository without an open PR costs two reads. A resource read without a stored ETag, the first time or for a new head, is stored, not counted as a change. A failed read fails the whole repository: nothing is stored or woken for it, so the next tick reads the same change again. */
async function pass(stateDirectory: string, repo: string): Promise<Pass> {
  const watched: Watched = { repo, reads: 0, changed: [], failure: null };
  const failures: string[] = [];
  let previous: WatchState | null = null;
  // A file that does not parse is reported, and the repository reads everything afresh, as on its first tick, so the next write repairs it.
  try { previous = readWatch(watchFile(stateDirectory, repo)); } catch (error) { failures.push(message(error)); }
  async function read(path: string): Promise<Read> {
    watched.reads++;
    const stored = previous?.etags[`repos/${repo}/${path}`] ?? null;
    try {
      const answer = await conditional(`repos/${repo}/${path}`, stored);
      return answer.modified ? { path, etag: answer.etag, seen: stored === null ? 'first' : 'changed', body: answer.body } : { path, etag: answer.etag, seen: 'unchanged', body: '' };
    } catch (error) { throw new Error(`${path}: ${message(error)}`); }
  }
  /** The trunk name when no PR has listed it yet: one read of the repository, stored from then on. */
  async function defaultBranch(): Promise<string> {
    watched.reads++;
    try {
      const answer = await conditional(`repos/${repo}`, null);
      if (!answer.modified) throw new Error('answered 304 without an ETag sent');
      return string(object(JSON.parse(answer.body), 'repository').default_branch, 'default branch');
    } catch (error) { throw new Error(`repository: ${message(error)}`); }
  }
  /** In parallel; once all have settled, the first failure in path order fails the pass. */
  async function readAll(paths: string[]): Promise<Read[]> {
    const reads: Read[] = [];
    for (const result of await Promise.allSettled(paths.map(read))) {
      if (result.status === 'rejected') throw result.reason;
      reads.push(result.value);
    }
    return reads;
  }
  try {
    const pulls = await read(PULLS);
    let trunk = previous?.trunk ?? null;
    let heads = previous?.heads ?? [];
    if (pulls.seen !== 'unchanged') {
      const listed = array(JSON.parse(pulls.body)).map(value => object(value, 'pull'));
      heads = [...new Set(listed.map(p => sha(object(p.head, 'pull head').sha)))];
      const first = listed[0];
      if (first) trunk = string(object(object(first.base, 'pull base').repo, 'base repository').default_branch, 'default branch');
    }
    if (trunk === null) trunk = await defaultBranch();
    const checks = await readAll([checkRuns(trunk), ...heads.map(checkRuns)]);
    const all = [pulls, ...checks];
    watched.changed = all.filter(r => r.seen === 'changed').map(r => `repos/${repo}/${r.path}`);
    const changed = (r: Read) => r.seen === 'changed';
    const sweep = changed(pulls) || checks.slice(0, 1).some(changed);
    const raiz = changed(pulls) || checks.slice(1).some(changed);
    watched.failure = failures.length ? failures.join('; ') : null;
    return { watched, wake: WAKEABLE.filter(job => job === 'sweep' ? sweep : raiz), next: { schemaVersion: 1, repo, trunk, heads, etags: Object.fromEntries(all.map(r => [`repos/${repo}/${r.path}`, r.etag])) } };
  } catch (error) {
    failures.push(message(error));
    watched.failure = failures.join('; ');
    return { watched, wake: [], next: null };
  }
}
/** One pass of the watch job: conditional GETs only, never a model and never a write to GitHub. A wake is a signal: the woken job reads GitHub itself. The wakes land before the ETags are stored, so a failure between the two repeats a wake rather than losing one. */
export async function tickWatch(config: LocalConfig, options: { dryRun: boolean }): Promise<WatchReport> {
  const passes = await Promise.all(config.repos.map(repo => pass(config.stateDirectory, repo.repo)));
  const woken = WAKEABLE.filter(job => passes.some(p => p.wake.includes(job)));
  if (options.dryRun) return { job: 'watch', repos: passes.map(p => p.watched), woken };
  if (woken.length) nudge(config.stateDirectory, woken);
  for (const p of passes) {
    if (!p.next) continue;
    try { writeWatch(watchFile(config.stateDirectory, p.watched.repo), p.next); }
    catch (error) { p.watched.failure = [p.watched.failure, message(error)].filter(Boolean).join('; '); }
  }
  return { job: 'watch', repos: passes.map(p => p.watched), woken };
}
/** The watch tick's errors: one line per repository that failed. */
export function watchErrors(report: WatchReport): string[] {
  return report.repos.flatMap(r => r.failure ? [`${r.repo}: ${r.failure}`] : []);
}
