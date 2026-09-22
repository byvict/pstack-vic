import { spawnSync, execFile } from 'node:child_process';
import { posix } from 'node:path';
import { array, integer, object, parseContract, relativePath, repoName, sha, string, jsonHash, hash, type Contract, type Check, type Feature } from './contract.ts';
import { dependencyOnly } from './dependencies.ts';
import { parseClinextTests, type TestEvidence } from './claims.ts';

export function command(binary: string, args: string[], input?: string): string {
  const result = spawnSync(binary, args, { input, encoding: 'utf8', maxBuffer: 24 * 1024 * 1024, timeout: 90_000 });
  if (result.error || result.status !== 0) throw new Error(`${binary} request failed`);
  return result.stdout;
}
export function commandAsync(binary: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile(binary, args, { encoding: 'utf8', maxBuffer: 24 * 1024 * 1024, timeout: 90_000 }, (error, stdout) => error ? reject(new Error(`${binary} request failed`)) : resolve(stdout)));
}
export async function api(endpoint: string, body?: unknown): Promise<unknown> {
  if (body !== undefined) return JSON.parse(command('gh', ['api', endpoint, '--method', 'POST', '--input', '-'], JSON.stringify(body)));
  return JSON.parse(await commandAsync('gh', ['api', endpoint]));
}
export async function pages(endpoint: string, key?: string): Promise<unknown[]> {
  const output = JSON.parse(await commandAsync('gh', ['api', endpoint + (endpoint.includes('?') ? '&' : '?') + 'per_page=100', '--paginate', '--slurp']));
  return array(output).flatMap(page => key ? array(object(page)[key]) : array(page));
}
export interface Pull {
  number: number; head: string; base: string; branch: string; state: string; draft: boolean;
  body: string; labels: string[]; authorId: number; authorLogin: string; authorType: string; autoMerge: boolean;
}
export async function pull(repo: string, pr: number): Promise<Pull> {
  const p = object(await api(`repos/${repo}/pulls/${pr}`));
  const user = object(p.user);
  if (typeof p.draft !== 'boolean') throw new Error('PR draft state unavailable');
  return { number: integer(p.number), head: sha(object(p.head).sha), base: string(object(p.base).ref), branch: string(object(p.head).ref),
    state: string(p.state), draft: p.draft, body: p.body === null ? '' : string(p.body),
    labels: array(p.labels).map(l => string(object(l).name)), authorId: integer(user.id), authorLogin: string(user.login), authorType: string(user.type), autoMerge: p.auto_merge !== null };
}
export function admitPull(pr: Pull, contract: Contract, head: string, proof = false): void {
  if (pr.state !== 'open' || pr.draft) throw new Error('PR must be open and ready');
  if (pr.head !== head) throw new Error('PR head moved');
  if (pr.base !== contract.trunk) throw new Error('PR base differs from trunk');
  if (!proof && pr.labels.some(label => contract.holdLabels.includes(label))) throw new Error('Hold label refuses converge');
}
export interface Trusted { repo: string; sha: string; config: Contract; files: Map<string, string>; workflowId: number; workflowPath: string }
const trees = new Map<string, Map<string, string>>();
export async function blob(repo: string, commit: string, path: string): Promise<string> {
  const treeKey = repo + '/' + commit;
  let tree = trees.get(treeKey);
  if (!tree) {
    const response = object(await api(`repos/${repo}/git/trees/${sha(commit)}?recursive=1`));
    if (response.truncated !== false) throw new Error('Trusted tree is truncated');
    tree = new Map(array(response.tree).map(value => { const entry = object(value); return [string(entry.path), string(entry.mode)]; }));
    trees.set(treeKey, tree);
  }
  if (!['100644', '100755'].includes(tree.get(relativePath(path)) ?? '')) throw new Error('Trusted path is not a regular blob');
  const v = object(await api(`repos/${repo}/contents/${relativePath(path)}?ref=${sha(commit)}`));
  if (v.type !== 'file' || v.encoding !== 'base64' || 'target' in v || integer(v.size) > 2_000_000) throw new Error('Trusted blob unavailable');
  return Buffer.from(string(v.content), 'base64').toString('utf8');
}
export async function trusted(repo: string, configPath: string): Promise<Trusted> {
  repoName(repo);
  const [repositoryValue, workflowValues] = await Promise.all([api(`repos/${repo}`), pages(`repos/${repo}/actions/workflows`, 'workflows')]);
  const repository = object(repositoryValue);
  const trunk = relativePath(repository.default_branch);
  const commit = sha(object(await api(`repos/${repo}/commits/${encodeURIComponent(trunk)}`)).sha);
  const source = await blob(repo, commit, configPath);
  const config = parseContract(JSON.parse(source));
  if (config.repo.toLowerCase() !== repo.toLowerCase() || config.trunk !== trunk) throw new Error('Trunk contract does not match repository');
  const workflows = workflowValues.map(v => object(v)).filter(w => w.name === 'Tests' && w.state === 'active');
  if (workflows.length !== 1) throw new Error('Trusted Tests workflow unavailable');
  const workflow = workflows[0];
  if (!workflow) throw new Error('Trusted Tests workflow unavailable');
  const workflowPath = relativePath(workflow.path);
  const files = new Map([[configPath, source]]);
  await Promise.all([...new Set([config.verifySkill, config.featureMap, workflowPath])].map(async path => files.set(path, await blob(repo, commit, path))));
  return { repo, sha: commit, config, files, workflowId: integer(workflow.id), workflowPath };
}
export async function features(contract: Trusted, changedPaths: Set<string>): Promise<Feature[]> {
  const map = contract.files.get(contract.config.featureMap);
  if (map === undefined) throw new Error('Feature map missing');
  const result: Feature[] = [];
  for (const line of map.split('\n')) {
    const link = line.match(/\[([^\]]+)\]\(([^)]+\.md)\)/);
    const page = line.match(/`([^`]+\.(?:jsx?|tsx?))`\s*\|?\s*$/);
    if (!link || !page) continue;
    const directory = posix.dirname(contract.config.featureMap);
    const recipe = relativePath(posix.join(directory, relativePath(link[2]?.replace(/^\.\//, ''))));
    if (!recipe.startsWith(directory + '/')) throw new Error('Feature recipe escapes map directory');
    const pagePath = relativePath(page[1]);
    if (!changedPaths.has(pagePath)) continue;
    if (result.some(f => f.page === pagePath)) throw new Error('Duplicate feature page');
    const source = await blob(contract.repo, contract.sha, recipe);
    contract.files.set(recipe, source);
    result.push({ id: posix.basename(recipe, '.md'), page: pagePath, recipe, recipeDigest: hash(source) });
  }
  return result;
}
export interface TextSource { source: 'body' | 'comment' | 'log'; id: string; text: string }
export interface ChangedFile { path: string; previous: string | null; patch: string | null; status: string }
export interface Snapshot {
  trusted: Trusted; pull: Pull; base: string; patchId: string; diff: string; files: ChangedFile[];
  features: Feature[]; checks: Check[]; sources: TextSource[]; gaps: string[]; inputDigest: string; inputFingerprint: string; verificationDigest: string; dependencyOnly: boolean; testEvidence: TestEvidence;
}
export async function principal(): Promise<number> { return integer(object(await api('user')).id); }
export async function comments(repo: string, pr: number): Promise<Record<string, unknown>[]> {
  return (await Promise.all([pages(`repos/${repo}/issues/${pr}/comments`), pages(`repos/${repo}/pulls/${pr}/comments`)])).flat().map(v => object(v));
}
export function isPublication(comment: Record<string, unknown>, author: number): boolean {
  const body = typeof comment.body === 'string' ? comment.body : '';
  return integer(object(comment.user).id) === author && /^<!-- converge:v1 [a-f0-9-]{36} -->\n```json\n/.test(body);
}
export async function checks(repo: string, head: string): Promise<Check[]> {
  const all = (await pages(`repos/${repo}/commits/${head}/check-runs?filter=all`, 'check_runs')).map(value => {
    const c = object(value);
    return { context: string(c.name), id: integer(c.id), head: sha(c.head_sha), appId: integer(object(c.app).id), state: c.status === 'completed' ? string(c.conclusion) : string(c.status), runId: null, attempt: null };
  });
  const latest = new Map<string, Check>();
  for (const c of all.sort((a, b) => b.id - a.id)) if (c.head === head && !latest.has(c.context)) latest.set(c.context, c);
  return [...latest.values()].sort((a, b) => a.context.localeCompare(b.context));
}
export async function workflowRun(t: Trusted, head: string, event?: 'push'): Promise<Record<string, unknown> | null> {
  const suffix = event ? `&event=${event}&branch=${encodeURIComponent(t.config.trunk)}` : '';
  const runs = (await pages(`repos/${t.repo}/actions/workflows/${t.workflowId}/runs?head_sha=${head}${suffix}`, 'workflow_runs'))
    .map(v => object(v)).filter(r => r.head_sha === head && r.workflow_id === t.workflowId && (!event || (r.event === event && r.head_branch === t.config.trunk)))
    .sort((a, b) => integer(b.id) - integer(a.id) || integer(b.run_attempt) - integer(a.run_attempt));
  return runs[0] ?? null;
}
export async function snapshot(repo: string, prNumber: number, configPath: string, proof: boolean): Promise<Snapshot> {
  const [t, p] = await Promise.all([trusted(repo, configPath), pull(repo, prNumber)]);
  admitPull(p, t.config, p.head, proof);
  const runPromise = workflowRun(t, p.head);
  const runEvidencePromise = runPromise.then(async run => {
    if (!run) return { jobs: [], log: null };
    const runId = integer(run.id);
    const attempt = integer(run.run_attempt);
    const [logResult, jobValues] = await Promise.all([
      run.status === 'completed' ? commandAsync('gh', ['run', 'view', String(runId), '--repo', repo, '--attempt', String(attempt), '--log']).then(text => ({ text }), () => ({ text: null })) : Promise.resolve({ text: null }),
      pages(`repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs`, 'jobs'),
    ]);
    return { jobs: jobValues.map(v => object(v)), log: logResult.text };
  });
  const runEvidenceSettlement = runEvidencePromise.then(() => undefined, () => undefined);
  const prepared = await Promise.all([
    api(`repos/${repo}/compare/${t.sha}...${p.head}`), pages(`repos/${repo}/pulls/${prNumber}/files`),
    commandAsync('gh', ['pr', 'diff', String(prNumber), '--repo', repo]), principal(), comments(repo, prNumber), checks(repo, p.head), runPromise,
  ]).then(async ([comparisonValue, fileValues, diff, author, allComments, observedChecks, run]) => {
    const base = sha(object(object(comparisonValue).merge_base_commit).sha);
    const files = fileValues.map(value => { const f = object(value); return { path: relativePath(f.filename), previous: f.previous_filename === undefined ? null : relativePath(f.previous_filename), patch: f.patch === undefined ? null : string(f.patch), status: string(f.status) }; });
    if (files.length >= 3000) throw new Error('PR files truncated');
    const patch = command('git', ['patch-id', '--stable'], diff).trim().split(/\s+/)[0];
    if (!patch) throw new Error('Empty PR diff');
    const [featureList, runEvidence] = await Promise.all([features(t, new Set(files.flatMap(f => f.previous ? [f.path, f.previous] : [f.path]))), runEvidencePromise]);
    return { base, files, diff, author, allComments, observedChecks, run, patch, featureList, runEvidence };
  }).catch(async error => {
    await runEvidenceSettlement;
    throw error;
  });
  const { base, files, diff, author, allComments, observedChecks, run, patch, featureList, runEvidence } = prepared;
  const visibleComments = allComments.filter(c => !isPublication(c, author));
  const sources: TextSource[] = [{ source: 'body', id: 'body', text: p.body }, ...visibleComments.map(c => ({ source: 'comment' as const, id: String(integer(c.id)), text: string(c.body) }))];
  const gaps: string[] = files.filter(f => f.patch === null).map(() => 'Changed file has no readable patch');
  let testEvidence: TestEvidence = { kind: 'unavailable' };
  if (!run) gaps.push('Exact-head Tests workflow unavailable');
  else {
    const runId = integer(run.id);
    const attempt = integer(run.run_attempt);
    const { jobs, log } = runEvidence;
    const testCheck = observedChecks.find(c => c.context === 'Run test suite');
    const job = jobs.find(j => j.name === 'Run test suite' && string(j.check_run_url).endsWith(`/${testCheck?.id}`));
    if (!testCheck || !job || run.status !== 'completed' || run.conclusion !== 'success' || job.conclusion !== 'success') gaps.push('Exact-head Tests workflow is not successful');
    else { testCheck.runId = runId; testCheck.attempt = attempt; }
    if (run.status === 'completed') {
      try {
        if (log === null) throw new Error('Tests logs unavailable');
        sources.push({ source: 'log', id: `${runId}/${attempt}`, text: log });
        const server = jobs.find(j => j.name === 'Server (gates + suite)' && j.conclusion === 'success' && j.head_sha === p.head && array(j.steps).some(s => object(s).name === 'Run tests' && object(s).conclusion === 'success'));
        if (server && /(?:test|artifact):/.test(p.body) && !files.some(f => ['tools/run-all-tests.js', 'package.json', t.workflowPath].includes(f.path))) {
          const [runnerSource, packageSource] = await Promise.all([blob(repo, t.sha, 'tools/run-all-tests.js'), blob(repo, t.sha, 'package.json')]);
          if (object(object(JSON.parse(packageSource)).scripts).test === 'node tools/run-all-tests.js' && runnerSource.includes('function printOneResult(') && runnerSource.includes('function printRunnerFooter(')) {
            t.files.set('tools/run-all-tests.js', runnerSource);
            t.files.set('package.json', packageSource);
            testEvidence = parseClinextTests(log, { runId, attempt, jobId: integer(server.id) });
          }
        }
      }
      catch { gaps.push('Tests logs unavailable'); }
    } else gaps.push('Tests logs unavailable');
  }
  for (const name of t.config.requiredChecks.filter(c => c !== 'verdict')) if (!observedChecks.some(c => c.context === name && c.state === 'success')) gaps.push('Required check is not successful: ' + name);
  let safeDependencyChange = false;
  if (p.authorId === 49699333 && p.authorLogin === 'dependabot[bot]' && p.authorType === 'Bot' && files.length > 0 && files.every(f => ['package.json', 'package-lock.json'].includes(f.path) && f.previous === null && f.status === 'modified')) {
    try { safeDependencyChange = (await Promise.all(files.map(async f => { const [before, after] = await Promise.all([blob(repo, base, f.path), blob(repo, p.head, f.path)]); return dependencyOnly(JSON.parse(before), JSON.parse(after), f.path === 'package-lock.json'); }))).every(Boolean); }
    catch { safeDependencyChange = false; }
  }
  const inputFingerprint = jsonHash({ body: p.body, comments: visibleComments.map(c => [c.id, c.body, c.updated_at]) });
  const verificationDigest = jsonHash([...t.files].sort(([a], [b]) => a.localeCompare(b)));
  const inputDigest = jsonHash({ head: p.head, base, contract: t.sha, files, diff, sources, checks: observedChecks, gaps, inputFingerprint, verificationDigest, testEvidence });
  const [final, finalCommit] = await Promise.all([pull(repo, prNumber), api(`repos/${repo}/commits/${encodeURIComponent(t.config.trunk)}`)]);
  admitPull(final, t.config, p.head, proof);
  if (final.body !== p.body || jsonHash(final.labels) !== jsonHash(p.labels) || sha(object(finalCommit).sha) !== t.sha) throw new Error('Snapshot changed during reconciliation');
  return { trusted: t, pull: p, base, patchId: sha(patch), diff, files, features: featureList, checks: observedChecks, sources, gaps, inputDigest, inputFingerprint, verificationDigest, dependencyOnly: safeDependencyChange, testEvidence };
}
