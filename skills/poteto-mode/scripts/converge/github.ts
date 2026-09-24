import { spawnSync, execFile } from 'node:child_process';
import { posix } from 'node:path';
import { array, integer, matches, object, parseContract, relativePath, repoName, sha, string, jsonHash, hash, testOnly, type Contract, type Check, type Feature } from './contract.ts';
import { dependencyOnly } from './dependencies.ts';
import { parseClinextTests, type TestEvidence, type ClinextProvenance, type StepWindow } from './claims.ts';

function childEnvironment(binary: string, credential: 'writer' | 'installation' = 'writer'): NodeJS.ProcessEnv {
  if (binary !== 'gh') return process.env;
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', CLICOLOR: '0' };
  delete env.FORCE_COLOR;
  delete env.CLICOLOR_FORCE;
  if (credential === 'installation') {
    delete env.GH_TOKEN;
    delete env.GITHUB_TOKEN;
  }
  return env;
}

export function command(binary: string, args: string[], input?: string): string {
  const result = spawnSync(binary, args, { input, encoding: 'utf8', env: childEnvironment(binary), maxBuffer: 24 * 1024 * 1024, timeout: 90_000 });
  if (result.error || result.status !== 0) throw new Error(`${binary} request failed`);
  return result.stdout;
}
export function commandAsync(binary: string, args: string[], credential: 'writer' | 'installation' = 'writer'): Promise<string> {
  return new Promise((resolve, reject) => execFile(binary, args, { encoding: 'utf8', env: childEnvironment(binary, credential), maxBuffer: 24 * 1024 * 1024, timeout: 90_000 }, (error, stdout) => error ? reject(new Error(`${binary} request failed`)) : resolve(stdout)));
}
export async function api(endpoint: string, body?: unknown): Promise<unknown> {
  if (body !== undefined) return JSON.parse(command('gh', ['api', endpoint, '--method', 'POST', '--input', '-'], JSON.stringify(body)));
  return JSON.parse(await commandAsync('gh', ['api', endpoint]));
}
export async function pages(endpoint: string, key?: string, credential: 'writer' | 'installation' = 'writer'): Promise<unknown[]> {
  const output = JSON.parse(await commandAsync('gh', ['api', endpoint + (endpoint.includes('?') ? '&' : '?') + 'per_page=100', '--paginate', '--slurp'], credential));
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
async function tree(repo: string, commit: string): Promise<Map<string, string>> {
  const treeKey = repo + '/' + commit;
  let tree = trees.get(treeKey);
  if (!tree) {
    const response = object(await api(`repos/${repo}/git/trees/${sha(commit)}?recursive=1`));
    if (response.truncated !== false) throw new Error('Trusted tree is truncated');
    tree = new Map(array(response.tree).map(value => { const entry = object(value); return [string(entry.path), string(entry.mode)]; }));
    trees.set(treeKey, tree);
  }
  return tree;
}
function regular(mode: string | undefined): boolean { return mode === '100644' || mode === '100755'; }
export async function blob(repo: string, commit: string, path: string): Promise<string> {
  if (!regular((await tree(repo, commit)).get(relativePath(path)))) throw new Error('Trusted path is not a regular blob');
  const v = object(await api(`repos/${repo}/contents/${relativePath(path)}?ref=${sha(commit)}`));
  if (v.type !== 'file' || v.encoding !== 'base64' || 'target' in v || integer(v.size) > 2_000_000) throw new Error('Trusted blob unavailable');
  return Buffer.from(string(v.content), 'base64').toString('utf8');
}
async function blobs(repo: string, commit: string, paths: string[], strict = true): Promise<Map<string, string>> {
  const [owner, name] = repo.split('/');
  const batches = Array.from({ length: Math.ceil(paths.length / 100) }, (_, i) => paths.slice(i * 100, i * 100 + 100));
  return new Map((await Promise.all(batches.map(async batch => {
    const query = `query($owner: String!, $name: String!${batch.map((_, i) => `, $p${i}: String!`).join('')}) { repository(owner: $owner, name: $name) { ${batch.map((_, i) => `p${i}: object(expression: $p${i}) { ... on Blob { byteSize isBinary isTruncated text } }`).join(' ')} } }`;
    const response = object(JSON.parse(await commandAsync('gh', ['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`, ...batch.flatMap((path, i) => ['-f', `p${i}=${sha(commit)}:${relativePath(path)}`])])));
    const repository = object(object(response.data).repository);
    return batch.flatMap((path, i): [string, string][] => {
      const v: Record<string, unknown> = repository[`p${i}`] === null && !strict ? {} : object(repository[`p${i}`]);
      if (v.isBinary === false && v.isTruncated === false && integer(v.byteSize) <= 2_000_000) return [[path, string(v.text)]];
      if (strict) throw new Error('Trusted blob unavailable');
      return [];
    });
  }))).flat());
}
const walkFiles = 2000;
const walkLevels = 32;
function imports(path: string, source: string, files: Map<string, string>): string[] {
  const directory = posix.dirname(path);
  const inside = (candidate: string) => candidate.startsWith('client/src/') && regular(files.get(candidate));
  const targets = new Set<string>();
  for (const [, specifier] of source.matchAll(/\b(?:from|import(?:\s*\()?|require\s*\()\s*['"](\.{1,2}\/[^'"\n]*)['"]/g)) {
    const target = posix.join(directory, specifier.replace(/[?#].*$/, '')).replace(/\/$/, '');
    const found = [target, ...['', '/index'].flatMap(suffix => ['.js', '.jsx', '.ts', '.tsx'].map(extension => target + suffix + extension))].find(inside);
    if (found) targets.add(found);
  }
  const globs = [...source.matchAll(/\bimport\.meta\.glob\s*\(\s*(\[[^\]]*\]|['"][^'"\n]*['"])/g)].flatMap(([, patterns]) => [...patterns.matchAll(/['"](\.{1,2}\/[^'"\n]*)['"]/g)].map(([, pattern]) => pattern));
  const templates = [...source.matchAll(/\bimport\s*\(\s*`(\.{1,2}\/[^`\n]*)`/g)].map(([, template]) => template.replace(/\$\{[^}]*\}/g, '*'));
  for (const pattern of [...globs, ...templates]) {
    const absolute = posix.join(directory, (pattern.match(/\*/g)?.length ?? 0) > 8 ? pattern.replace(/\*.*$/, '**') : pattern);
    for (const candidate of files.keys()) if (inside(candidate) && matches(candidate, absolute)) targets.add(candidate);
  }
  return [...targets];
}
async function reachability(contract: Trusted, pages: string[]): Promise<{ reach: Map<string, Set<string>>; sources: Map<string, string> }> {
  const files = await tree(contract.repo, contract.sha);
  const sources = new Map<string, string>();
  const graph = new Map<string, string[]>();
  let frontier = pages.filter(page => regular(files.get(page)));
  for (let level = 0; frontier.length; level++) {
    if (level >= walkLevels || graph.size + frontier.length > walkFiles) throw new Error('Feature import graph exceeds walk bound');
    for (const [path, source] of await blobs(contract.repo, contract.sha, frontier)) { sources.set(path, source); graph.set(path, imports(path, source, files)); }
    frontier = [...new Set([...graph.values()].flat())].filter(path => /\.[cm]?[jt]sx?$/.test(path) && !graph.has(path));
  }
  const reach = new Map<string, Set<string>>();
  for (const page of pages) {
    const seen = new Set([page]);
    for (const path of seen) for (const next of graph.get(path) ?? []) seen.add(next);
    for (const path of seen) reach.set(path, (reach.get(path) ?? new Set()).add(page));
  }
  return { reach, sources };
}
const sharedDirectory = /^client\/(?:src\/)?(?:components|hooks|contexts|lib|utils)\//;
async function adopt(contract: Trusted, head: string, changes: ChangedFile[], reach: Map<string, Set<string>>, sources: Map<string, string>): Promise<void> {
  const trunk = await tree(contract.repo, contract.sha);
  const live = new Set(changes.filter(f => f.status !== 'removed').map(f => f.path));
  const fresh = new Set([...live].filter(path => path.startsWith('client/src/') && !regular(trunk.get(path)) && !reach.has(path) && !testOnly(path) && !sharedDirectory.test(path)));
  if (!fresh.size) return;
  const merged = new Map(trunk);
  for (const f of changes) {
    if (f.status === 'removed') merged.delete(f.path);
    else { if (f.status === 'renamed' && f.previous) merged.delete(f.previous); merged.set(f.path, '100644'); }
  }
  const code = [...merged.keys()].filter(path => path.startsWith('client/src/') && /\.[cm]?[jt]sx?$/.test(path) && !testOnly(path));
  const unread = code.filter(path => !live.has(path) && !sources.has(path));
  if (sources.size + unread.length > walkFiles) throw new Error('Feature import graph exceeds walk bound');
  const headCode = code.filter(path => live.has(path));
  const [trunkSources, headSources] = await Promise.all([blobs(contract.repo, contract.sha, unread), blobs(contract.repo, head, headCode, false)]);
  if (headSources.size !== headCode.length) return;
  const modules = new Map([...sources, ...trunkSources, ...headSources]);
  const stems = [...fresh].map((path): [string, string] => [path.slice('client/src/'.length).replace(/(?:\/index)?\.[^/.]+$/, ''), path]);
  const importers = new Map([...fresh].map(path => [path, new Set<string>()]));
  for (const path of code) {
    const source = modules.get(path) ?? '';
    for (const target of imports(path, source, merged)) importers.get(target)?.add(path);
    for (const [, specifier] of source.matchAll(/\b(?:from|import(?:\s*\()?|require\s*\()\s*['"]([^.'"\n][^'"\n]*)['"]/g)) {
      const name = specifier.replace(/[?#].*$/, '').replace(/(?:\/index)?(?:\.[^/.]+)?\/?$/, '');
      for (const [stem, target] of stems) if (name === stem || name.endsWith('/' + stem)) importers.get(target)?.add(path);
    }
  }
  const blocked = new Set([...importers].filter(([, from]) => [...from].some(path => !reach.has(path) && !fresh.has(path))).map(([path]) => path));
  for (const path of blocked) for (const [target, from] of importers) if (from.has(path)) blocked.add(target);
  for (let grew = true; grew;) {
    grew = false;
    for (const [path, from] of importers) {
      if (blocked.has(path)) continue;
      const pages = new Set([...from].flatMap(importer => [...reach.get(importer) ?? []]));
      if (pages.size > (reach.get(path)?.size ?? 0)) { reach.set(path, pages); grew = true; }
    }
  }
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
export async function features(contract: Trusted, head: string, changes: ChangedFile[]): Promise<{ features: Feature[]; reachedPaths: string[] }> {
  const map = contract.files.get(contract.config.featureMap);
  if (map === undefined) throw new Error('Feature map missing');
  const entries: { id: string; page: string; recipe: string }[] = [];
  for (const line of map.split('\n')) {
    const link = line.match(/\[([^\]]+)\]\(([^)]+\.md)\)/);
    const page = line.match(/`([^`]+\.(?:jsx?|tsx?))`\s*\|?\s*$/);
    if (!link || !page) continue;
    const directory = posix.dirname(contract.config.featureMap);
    const recipe = relativePath(posix.join(directory, relativePath(link[2]?.replace(/^\.\//, ''))));
    if (!recipe.startsWith(directory + '/')) throw new Error('Feature recipe escapes map directory');
    const pagePath = relativePath(page[1]);
    if (entries.some(f => f.page === pagePath)) throw new Error('Duplicate feature page');
    entries.push({ id: posix.basename(recipe, '.md'), page: pagePath, recipe });
  }
  const changed = [...new Set(changes.flatMap(f => f.previous ? [f.path, f.previous] : [f.path]))];
  const walk = changed.some(path => path.startsWith('client/src/')) ? await reachability(contract, entries.map(entry => entry.page)) : null;
  if (walk) await adopt(contract, head, changes, walk.reach, walk.sources);
  const reach = walk?.reach ?? new Map<string, Set<string>>();
  const reaches = (entry: typeof entries[number], path: string) => entry.page === path || reach.get(path)?.has(entry.page) === true;
  const reachedPaths = changed.filter(path => entries.some(entry => reaches(entry, path)));
  const unreachedShared = changed.some(path => sharedDirectory.test(path) && !reachedPaths.includes(path));
  const routes = changed.some(path => /^server\/routes\//.test(path) || /^client\/(?:src\/)?(?:App|components\/(?:SidebarNew|TopBar))\.[jt]sx?$/.test(path));
  const affected = routes || unreachedShared ? entries : entries.filter(entry => changed.some(path => reaches(entry, path)));
  return { reachedPaths, features: await Promise.all(affected.map(async entry => {
    const source = await blob(contract.repo, contract.sha, entry.recipe);
    contract.files.set(entry.recipe, source);
    return { ...entry, recipeDigest: hash(source) };
  })) };
}
export interface TextSource { source: 'body' | 'comment' | 'log'; id: string; text: string }
export interface ChangedFile { path: string; previous: string | null; patch: string | null; status: string }
export interface Snapshot {
  trusted: Trusted; pull: Pull; base: string; patchId: string; diff: string; files: ChangedFile[];
  features: Feature[]; reachedPaths: string[]; checks: Check[]; sources: TextSource[]; gaps: string[]; inputDigest: string; inputFingerprint: string; verificationDigest: string; dependencyOnly: boolean; testEvidence: TestEvidence;
}
export async function principal(): Promise<number> {
  const response = object(JSON.parse(await commandAsync('gh', ['api', 'graphql', '-f', 'query=query { viewer { databaseId } }'])));
  return integer(object(object(response.data).viewer).databaseId);
}
export async function comments(repo: string, pr: number): Promise<Record<string, unknown>[]> {
  return (await Promise.all([pages(`repos/${repo}/issues/${pr}/comments`), pages(`repos/${repo}/pulls/${pr}/comments`)])).flat().map(v => object(v));
}
export function isPublication(comment: Record<string, unknown>, author: number): boolean {
  const body = typeof comment.body === 'string' ? comment.body : '';
  return integer(object(comment.user).id) === author && /^<!-- converge:v1 [a-f0-9-]{36} -->\n```json\n/.test(body);
}
export async function checks(repo: string, head: string): Promise<Check[]> {
  const all = (await pages(`repos/${repo}/commits/${head}/check-runs?filter=all`, 'check_runs', 'installation')).map(value => {
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
function stepWindow(value: Record<string, unknown>): StepWindow {
  const times = [value.started_at, value.completed_at].map(value => {
    const text = string(value);
    const milliseconds = Date.parse(text);
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(text) || !Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== text.replace('Z', '.000Z')) throw new Error('Invalid job timing');
    return milliseconds / 1000;
  });
  if (times[1] < times[0]) throw new Error('Reversed job timing');
  return { startedSecond: times[0], completedSecond: times[1] };
}
function testProvenance(run: Record<string, unknown>, jobs: Record<string, unknown>[], head: string): ClinextProvenance | null {
  const runId = integer(run.id), attempt = integer(run.run_attempt);
  if (!runId || !attempt || run.head_sha !== head || run.status !== 'completed' || run.conclusion !== 'success') return null;
  const ids = jobs.map(j => integer(j.id));
  if (ids.some(id => !id) || new Set(ids).size !== ids.length) return null;
  const servers = jobs.filter(j => j.name === 'Server (gates + suite)');
  if (servers.length !== 1) return null;
  const server = servers[0];
  if (server.run_id !== runId || server.run_attempt !== attempt || server.head_sha !== head || server.status !== 'completed' || server.conclusion !== 'success' || !string(server.check_run_url).endsWith('/' + integer(server.id))) return null;
  const jobWindow = stepWindow(server);
  const steps = array(server.steps).map(v => object(v));
  const numbers = steps.map(s => integer(s.number));
  if (numbers.some(number => !number) || new Set(numbers).size !== numbers.length || steps.filter(s => s.name === 'Run tests').length !== 1) return null;
  const executed = steps.filter(s => s.conclusion !== 'skipped').sort((a, b) => integer(a.number) - integer(b.number));
  const windows = executed.map(s => {
    if (s.status !== 'completed') throw new Error('Incomplete job step');
    const window = stepWindow(s);
    if (window.startedSecond < jobWindow.startedSecond || window.completedSecond > jobWindow.completedSecond) throw new Error('Step outside job timing');
    return window;
  });
  if (windows.some((w, i) => i > 0 && w.startedSecond < windows[i - 1].completedSecond)) return null;
  const index = executed.findIndex(s => s.name === 'Run tests');
  if (index < 0 || executed[index].conclusion !== 'success') return null;
  return { runId, attempt, jobId: integer(server.id), tests: windows[index], next: windows[index + 1] ?? null };
}
type TestSources = { kind: 'unused' | 'unavailable' } | { kind: 'ready'; provenance: ClinextProvenance; runnerSource: string; packageSource: string };
export async function snapshot(repo: string, prNumber: number, configPath: string, proof: boolean): Promise<Snapshot> {
  const [t, p] = await Promise.all([trusted(repo, configPath), pull(repo, prNumber)]);
  admitPull(p, t.config, p.head, proof);
  const runPromise = workflowRun(t, p.head);
  const runJobsPromise = runPromise.then(async run => run ? (await pages(`repos/${repo}/actions/runs/${integer(run.id)}/attempts/${integer(run.run_attempt)}/jobs`, 'jobs')).map(v => object(v)) : []);
  const runLogPromise = runPromise.then(run => run?.status === 'completed' ? commandAsync('gh', ['run', 'view', String(integer(run.id)), '--repo', repo, '--attempt', String(integer(run.run_attempt)), '--log']).catch(() => null) : null);
  const runEvidencePromise = Promise.all([runJobsPromise, runLogPromise]).then(([jobs, log]) => ({ jobs, log }));
  const runEvidenceSettlement = Promise.allSettled([runJobsPromise, runLogPromise, runEvidencePromise]);
  const prepared = await Promise.all([
    api(`repos/${repo}/compare/${t.sha}...${p.head}`), pages(`repos/${repo}/pulls/${prNumber}/files`),
    commandAsync('gh', ['pr', 'diff', String(prNumber), '--repo', repo]), principal(), comments(repo, prNumber), checks(repo, p.head), runPromise,
  ]).then(async ([comparisonValue, fileValues, diff, author, allComments, observedChecks, run]) => {
    const base = sha(object(object(comparisonValue).merge_base_commit).sha);
    const files = fileValues.map(value => { const f = object(value); return { path: relativePath(f.filename), previous: f.previous_filename === undefined ? null : relativePath(f.previous_filename), patch: f.patch === undefined ? null : string(f.patch), status: string(f.status) }; });
    if (files.length >= 3000) throw new Error('PR files truncated');
    const patch = command('git', ['patch-id', '--stable'], diff).trim().split(/\s+/)[0];
    if (!patch) throw new Error('Empty PR diff');
    const testSourcesPromise = runJobsPromise.then(async (jobs): Promise<TestSources> => {
      if (!run) return { kind: 'unused' };
      const provenance = testProvenance(run, jobs, p.head);
      const testCheck = observedChecks.find(c => c.context === 'Run test suite');
      const job = jobs.find(j => j.name === 'Run test suite' && string(j.check_run_url).endsWith(`/${testCheck?.id}`));
      const protectedPaths = new Set(['tools/run-all-tests.js', 'package.json', t.workflowPath]);
      if (!provenance || !testCheck || job?.conclusion !== 'success' || !/(?:test|artifact):/.test(p.body) || files.some(f => protectedPaths.has(f.path) || (f.previous !== null && protectedPaths.has(f.previous)))) return { kind: 'unused' };
      const reads = [blob(repo, t.sha, 'tools/run-all-tests.js'), blob(repo, t.sha, 'package.json')];
      const [runnerSource, packageSource] = await Promise.all(reads).catch(async error => {
        await Promise.allSettled(reads);
        throw error;
      });
      return { kind: 'ready', provenance, runnerSource, packageSource };
    }).catch((): TestSources => ({ kind: 'unavailable' }));
    const featurePromise = features(t, p.head, files);
    const [selection, runEvidence, testSources] = await Promise.all([featurePromise, runEvidencePromise, testSourcesPromise]).catch(async error => {
      await Promise.allSettled([featurePromise, runEvidencePromise, testSourcesPromise]);
      throw error;
    });
    return { base, files, diff, author, allComments, observedChecks, run, patch, selection, runEvidence, testSources };
  }).catch(async error => {
    await runEvidenceSettlement;
    throw error;
  });
  const { base, files, diff, author, allComments, observedChecks, run, patch, selection, runEvidence, testSources } = prepared;
  const visibleComments = allComments.filter(c => !isPublication(c, author));
  const sources: TextSource[] = [{ source: 'body', id: 'body', text: p.body }, ...visibleComments.map(c => ({ source: 'comment' as const, id: String(integer(c.id)), text: string(c.body) }))];
  const gaps: string[] = files.filter(f => f.patch === null && ![f.path, f.previous ?? f.path].every(path => /(?:^|\/)__screenshots__\/.+\.png$/.test(path))).map(() => 'Changed file has no readable patch');
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
        if (testSources.kind === 'unavailable') throw new Error('Trusted test sources unavailable');
        if (testSources.kind === 'ready') {
          const { provenance, runnerSource, packageSource } = testSources;
          if (object(object(JSON.parse(packageSource)).scripts).test === 'node tools/run-all-tests.js' && runnerSource.includes('function printOneResult(') && runnerSource.includes('function printRunnerFooter(')) {
            t.files.set('tools/run-all-tests.js', runnerSource);
            t.files.set('package.json', packageSource);
            testEvidence = parseClinextTests(log, provenance);
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
  return { trusted: t, pull: p, base, patchId: sha(patch), diff, files, features: selection.features, reachedPaths: selection.reachedPaths, checks: observedChecks, sources, gaps, inputDigest, inputFingerprint, verificationDigest, dependencyOnly: safeDependencyChange, testEvidence };
}
