import { appendFileSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { parseArgs } from 'node:util';
import { array, boolean, instant, integer, jsonHash, object, oneOf, relativePath, repoName, sha, string } from './contract.ts';
import { admitPull, api, checks, commandAsync, pages, pull, trusted, type Trusted } from './github.ts';
import { verdictGate, type Gate } from './gate.ts';
import { requiredChecks, unfinished } from './protection.ts';

export interface QueueCandidate { repo: string; baseSha: string; headSha: string; baseRef: string; headRef: string }
export interface MergeGroup extends QueueCandidate { members: { pr: number; head: string }[] }
const states = ['QUEUED', 'AWAITING_CHECKS', 'MERGEABLE', 'UNMERGEABLE', 'LOCKED'] as const;
export interface QueueEntry { id: string; position: number; state: typeof states[number]; base: string | null; head: string | null; pr: number; prHead: string }
export interface QueueSnapshot { trunk: string; candidateHead: string; entries: QueueEntry[] }
export type QueueState =
  | { kind: 'disabled' | 'eligible' }
  | { kind: 'queued'; pullId: string; state: typeof states[number]; head: string | null }
  | { kind: 'removed'; at: string; reason: string; head: string | null };

function commit(value: unknown): string | null { return value === null ? null : sha(object(value).oid); }
function ref(value: unknown): string {
  const result = string(value);
  if (!result.startsWith('refs/heads/')) throw new Error('Expected a branch ref');
  relativePath(result.slice('refs/heads/'.length));
  return result;
}
function prNumber(value: unknown): number {
  const result = integer(value);
  if (!result) throw new Error('Expected a PR number');
  return result;
}
export function parseCandidate(event: unknown, expected: { repo: string; head: string; ref: string }): QueueCandidate {
  const e = object(event, 'merge_group event');
  if (e.action !== 'checks_requested') throw new Error('Expected merge_group checks_requested');
  const m = object(e.merge_group, 'merge group');
  const candidate = { repo: repoName(object(e.repository).full_name), baseSha: sha(m.base_sha), headSha: sha(m.head_sha), baseRef: ref(m.base_ref), headRef: ref(m.head_ref) };
  if (candidate.repo.toLowerCase() !== repoName(expected.repo).toLowerCase() || candidate.headSha !== sha(expected.head) || candidate.headRef !== ref(expected.ref)) throw new Error('Event differs from the workflow candidate');
  return candidate;
}
async function graphql(repo: string, query: string, fields: string[]): Promise<Record<string, unknown>> {
  const [owner, name] = repoName(repo).split('/');
  const response = object(JSON.parse(await commandAsync('gh', ['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`, ...fields])));
  if (response.errors !== undefined) throw new Error('Merge queue GraphQL read failed');
  return object(object(response.data).repository, 'queue repository');
}
export async function queueSnapshot(candidate: QueueCandidate): Promise<QueueSnapshot> {
  const query = `query($owner: String!, $name: String!, $branch: String!, $base: String!, $head: String!) {
    repository(owner: $owner, name: $name) {
      base: ref(qualifiedName: $base) { target { oid } }
      head: ref(qualifiedName: $head) { target { oid } }
      mergeQueue(branch: $branch) { entries(first: 100) { pageInfo { hasNextPage } nodes {
        id position state baseCommit { oid } headCommit { oid } pullRequest { number headRefOid }
      } } }
    }
  }`;
  const repository = await graphql(candidate.repo, query, ['-f', `branch=${candidate.baseRef.slice('refs/heads/'.length)}`, '-f', `base=${candidate.baseRef}`, '-f', `head=${candidate.headRef}`]);
  const connection = object(object(repository.mergeQueue, 'live merge queue').entries);
  if (boolean(object(connection.pageInfo).hasNextPage)) throw new Error('Merge queue membership is truncated');
  return { trunk: sha(object(object(repository.base).target).oid), candidateHead: sha(object(object(repository.head, 'live candidate ref').target).oid), entries: array(connection.nodes).map(value => {
    const e = object(value, 'queue entry');
    const p = object(e.pullRequest);
    return { id: string(e.id), position: prNumber(e.position), state: oneOf(e.state, states), base: commit(e.baseCommit), head: commit(e.headCommit), pr: prNumber(p.number), prHead: sha(p.headRefOid) };
  }) };
}
/** The event base is the final entry's immediate predecessor, not necessarily trunk. Only the live queue's contiguous prefix proves which PRs the candidate combines. A predecessor already merged at its synthetic SHA becomes the new root. */
export function mergeGroup(candidate: QueueCandidate, snapshot: QueueSnapshot): MergeGroup {
  if (snapshot.candidateHead !== candidate.headSha) throw new Error('Merge group ref moved');
  const sorted = [...snapshot.entries].sort((a, b) => a.position - b.position);
  if (new Set(sorted.map(e => e.position)).size !== sorted.length || new Set(sorted.map(e => e.pr)).size !== sorted.length) throw new Error('Ambiguous merge queue membership');
  const tail = sorted.find(e => e.head === candidate.headSha);
  if (!tail || tail.base !== candidate.baseSha) throw new Error('Event candidate is absent from the live merge queue');
  const members: MergeGroup['members'] = [];
  let base = snapshot.trunk;
  for (const entry of sorted.filter(e => e.position <= tail.position)) {
    if (entry.position !== members.length + 1 || entry.base !== base || entry.head === null || ['UNMERGEABLE', 'LOCKED'].includes(entry.state)) throw new Error('Merge queue prefix is incomplete or changed');
    members.push({ pr: entry.pr, head: entry.prHead });
    base = entry.head;
  }
  return { ...candidate, baseSha: snapshot.trunk, members };
}
export async function queueState(repo: string, pr: number): Promise<QueueState> {
  const query = `query($owner: String!, $name: String!, $pr: Int!) {
    repository(owner: $owner, name: $name) { pullRequest(number: $pr) {
      id isMergeQueueEnabled mergeQueueEntry { state headCommit { oid } }
      timelineItems(last: 1, itemTypes: [ADDED_TO_MERGE_QUEUE_EVENT, REMOVED_FROM_MERGE_QUEUE_EVENT]) { nodes {
        __typename ... on AddedToMergeQueueEvent { createdAt }
        ... on RemovedFromMergeQueueEvent { createdAt reason beforeCommit { oid } }
      } }
    } }
  }`;
  const p = object((await graphql(repo, query, ['-F', `pr=${prNumber(pr)}`])).pullRequest);
  if (!boolean(p.isMergeQueueEnabled)) return { kind: 'disabled' };
  if (p.mergeQueueEntry !== null) {
    const e = object(p.mergeQueueEntry);
    return { kind: 'queued', pullId: string(p.id), state: oneOf(e.state, states), head: commit(e.headCommit) };
  }
  const latest = array(object(p.timelineItems).nodes).at(-1);
  if (latest !== undefined && object(latest).__typename === 'RemovedFromMergeQueueEvent') {
    const e = object(latest);
    return { kind: 'removed', at: instant(e.createdAt), reason: e.reason === null ? 'unknown' : string(e.reason), head: commit(e.beforeCommit) };
  }
  return { kind: 'eligible' };
}
export function queueRetry(state: QueueState, gate: Extract<Gate, { kind: 'certified' }>): string | null {
  return state.kind === 'removed' && Date.parse(gate.publishedAt) <= Date.parse(state.at) ? `Merge queue removed candidate ${state.head ?? 'unavailable'} at ${state.at}: ${state.reason}; a new certificate is required` : null;
}
export async function dequeue(repo: string, pr: number): Promise<boolean> {
  const current = await queueState(repo, pr);
  if (current.kind !== 'queued') return false;
  await commandAsync('gh', ['api', 'graphql', '-f', 'query=mutation($pr: ID!) { dequeuePullRequest(input: {id: $pr}) { clientMutationId } }', '-f', `pr=${current.pullId}`]);
  if ((await queueState(repo, pr)).kind === 'queued') throw new Error('Merge queue dequeue outcome unknown');
  return true;
}
function policyPath(t: Trusted, path: string): boolean {
  return t.files.has(path) || [t.config.verifySkill, t.config.featureMap].some(file => file !== null && path.startsWith(posix.dirname(file) + '/'));
}
async function groupPolicy(t: Trusted, group: MergeGroup): Promise<void> {
  if (group.members.length < 2) return;
  const comparison = object(await api(`repos/${group.repo}/compare/${group.baseSha}...${group.headSha}`));
  const files = array(comparison.files).map(value => object(value));
  if (files.length >= 300) throw new Error('Merge group compare is truncated');
  if (files.some(f => policyPath(t, relativePath(f.filename)) || (f.previous_filename !== undefined && policyPath(t, relativePath(f.previous_filename))))) throw new Error('Merge group changes certificate policy; merge the policy PR first, then certify against the new trunk');
}
export async function validateGroup(candidate: QueueCandidate, options: { publisher: number; configPath: string; mode: 'candidate' | 'verdict' | 'hold' }): Promise<MergeGroup> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const t = await trusted(candidate.repo, options.configPath);
    if (candidate.baseRef !== `refs/heads/${t.config.trunk}`) throw new Error('Merge group base is not the trusted trunk');
    const group = mergeGroup(candidate, await queueSnapshot(candidate));
    if (group.baseSha !== t.sha) continue;
    let failure: unknown;
    try {
      if (options.mode !== 'candidate') {
        for (const member of group.members) {
          admitPull(await pull(group.repo, member.pr), t.config, member.head);
          if (options.mode === 'verdict') {
            const gate = await verdictGate(t, member.pr, member.head, options.publisher);
            if (gate.kind === 'refused') throw new Error(`PR #${member.pr}: ${gate.reason}`);
            if (gate.dossier.round.execution !== 'pre-pr' || gate.dossier.certificate === null) throw new Error(`PR #${member.pr} lacks a pre-pr certificate`);
          }
        }
        if (options.mode === 'verdict') await groupPolicy(t, group);
      }
    } catch (error) { failure = error; }
    const current = mergeGroup(candidate, await queueSnapshot(candidate));
    if (jsonHash(current) !== jsonHash(group) || (await trusted(candidate.repo, options.configPath)).sha !== t.sha) continue;
    if (failure !== undefined) throw failure;
    if (options.mode !== 'candidate') for (const member of current.members) admitPull(await pull(group.repo, member.pr), t.config, member.head);
    return current;
  }
  throw new Error('Merge queue membership or trunk changed during validation');
}
/** Group verdict and hold finish after all other protected checks on this synthetic head. Individual certificates never stand in for the combined suite. The workflow's timeout and GitHub's queue lifetime bound the wait. */
export async function waitForGroupChecks(candidate: QueueCandidate, configPath: string): Promise<void> {
  let t = await trusted(candidate.repo, configPath);
  let required = (await requiredChecks(t)).filter(c => c.context !== 'verdict' && c.context !== 'hold');
  for (;;) {
    mergeGroup(candidate, await queueSnapshot(candidate));
    const observed = await checks(candidate.repo, candidate.headSha);
    const waiting: string[] = [];
    for (const c of required) {
      const check = observed.find(o => o.head === candidate.headSha && o.context === c.context && (c.appId === null || o.appId === c.appId));
      if (!check || unfinished.includes(check.state)) waiting.push(c.context);
      else if (check.state !== 'success') throw new Error('Combined protected check failed or skipped: ' + c.context);
    }
    if (!waiting.length) {
      t = await trusted(candidate.repo, configPath);
      const current = (await requiredChecks(t)).filter(c => c.context !== 'verdict' && c.context !== 'hold');
      if (jsonHash(current) === jsonHash(required)) return;
      required = current;
      continue;
    }
    process.stdout.write('Waiting for combined checks: ' + waiting.join(', ') + '\n');
    await new Promise(resolve => setTimeout(resolve, 15_000));
  }
}
export async function invalidate(repo: string, pr: number, options: { publisher: number; configPath: string }): Promise<{ dequeued: boolean; reason: string }> {
  if ((await queueState(repo, pr)).kind !== 'queued') return { dequeued: false, reason: 'PR is not queued' };
  let reason: string;
  try {
    const t = await trusted(repo, options.configPath);
    const p = await pull(repo, pr);
    admitPull(p, t.config, p.head);
    const gate = await verdictGate(t, pr, p.head, options.publisher);
    if (gate.kind === 'certified') return { dequeued: false, reason: 'Live certificate and holds still authorize this PR' };
    reason = gate.reason;
  } catch (error) { reason = error instanceof Error ? error.message : 'Live authorization unavailable'; }
  return { dequeued: await dequeue(repo, pr), reason };
}
async function eventPrs(repo: string, event: unknown): Promise<number[]> {
  const e = object(event, 'invalidation event');
  if (e.workflow_run !== undefined) {
    if (e.action !== 'completed') throw new Error('Expected a completed review signal');
    const id = prNumber(object(e.workflow_run).id);
    const run = object(await api(`repos/${repo}/actions/runs/${id}`));
    if (integer(run.id) !== id || run.status !== 'completed' || !['pull_request_review', 'pull_request_review_comment'].includes(string(run.event))) throw new Error('Workflow run is not a completed review signal');
    let prs = array(run.pull_requests);
    if (!prs.length) prs = await pages(`repos/${repo}/commits/${sha(run.head_sha)}/pulls`);
    if (!prs.length) throw new Error('Review signal has no GitHub PR associations');
    return [...new Set(prs.map(p => prNumber(object(p).number)))];
  }
  if (e.pull_request !== undefined) return [prNumber(object(e.pull_request).number)];
  const issue = e.issue === undefined ? null : object(e.issue);
  return issue?.pull_request === undefined ? [] : [prNumber(issue.number)];
}
export async function main(args: string[]): Promise<number> {
  try {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { repo: { type: 'string' }, event: { type: 'string' }, pr: { type: 'string' }, head: { type: 'string' }, ref: { type: 'string' }, publisher: { type: 'string' }, config: { type: 'string', default: '.cursor/converge.json' }, output: { type: 'string' }, wait: { type: 'boolean', default: false } } });
    const mode = oneOf(positionals[0], ['candidate', 'verdict', 'hold', 'invalidate', 'dequeue']);
    if (positionals.length !== 1 || !values.repo) throw new Error('Usage: converge-queue candidate|verdict|hold|invalidate|dequeue --repo owner/repo');
    const repo = repoName(values.repo);
    if (mode === 'dequeue') {
      if (!values.pr || !/^\d+$/.test(values.pr)) throw new Error('Dequeue requires --pr N');
      process.stdout.write(JSON.stringify({ dequeued: await dequeue(repo, prNumber(Number(values.pr))) }) + '\n');
      return 0;
    }
    if (!values.event || !values.publisher || !/^\d+$/.test(values.publisher)) throw new Error('Validation requires --event path --publisher ID');
    const options = { publisher: prNumber(Number(values.publisher)), configPath: relativePath(values.config) };
    const event: unknown = JSON.parse(readFileSync(values.event, 'utf8'));
    if (repoName(object(object(event).repository).full_name).toLowerCase() !== repo.toLowerCase()) throw new Error('Event repository differs from workflow');
    if (mode === 'invalidate') {
      const invalidated = [];
      for (const pr of await eventPrs(repo, event)) invalidated.push({ pr, ...await invalidate(repo, pr, options) });
      process.stdout.write(JSON.stringify({ invalidated }) + '\n');
    } else {
      if (!values.head || !values.ref) throw new Error('Merge group requires the exact workflow head and ref');
      const candidate = parseCandidate(event, { repo, head: values.head, ref: values.ref });
      if (values.wait && mode !== 'candidate') await waitForGroupChecks(candidate, options.configPath);
      const group = await validateGroup(candidate, { ...options, mode });
      if (values.output) appendFileSync(values.output, `base-sha=${group.baseSha}\nhead-sha=${group.headSha}\nmembers=${JSON.stringify(group.members)}\n`);
      process.stdout.write(JSON.stringify(group, null, 2) + '\n');
    }
    return 0;
  } catch (error) { process.stderr.write((error instanceof SyntaxError ? 'Malformed JSON input' : error instanceof Error ? error.message : 'Merge queue validation failed') + '\n'); return 1; }
}
