#!/usr/bin/env node
import { readFileSync, writeFileSync, appendFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
const file = process.env.CONVERGE_FIXTURE;
const state = JSON.parse(readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
appendFileSync(file + '.calls', JSON.stringify(args) + '\n');
/** With `-i`, gh prints the status line and the headers before the body. GitHub's ETag is derived from the body, and a request whose `If-None-Match` names it answers 304 without a body, on which gh exits 1. */
function send(value) {
  const color = (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') || (process.env.CLICOLOR_FORCE && process.env.CLICOLOR_FORCE !== '0');
  const text = JSON.stringify(args.includes('--slurp') ? [value] : value);
  if (args.includes('-i')) {
    const etag = `W/"${createHash('sha256').update(text).digest('hex')}"`;
    const sent = args.find((arg, i) => args[i - 1] === '-H' && arg.startsWith('If-None-Match: '));
    if (sent === `If-None-Match: ${etag}`) { process.stdout.write(`HTTP/2.0 304 Not Modified\nEtag: ${etag}\n\n`); process.exit(1); }
    process.stdout.write(`HTTP/2.0 200 OK\nContent-Type: application/json; charset=utf-8\n${state.omitEtag ? '' : `Etag: ${etag}\n`}\n${text}`);
    return;
  }
  process.stdout.write(color ? '\x1b[32m' + text + '\x1b[0m' : text);
}
function save() { const next = `${file}.${process.pid}`; writeFileSync(next, JSON.stringify(state)); renameSync(next, file); }
function later(endpoint) { const after = state.after; if (!after || after.endpoint !== endpoint) return; if (after.reads-- <= 0) Object.assign(state, after.set); save(); }
function fail() { process.exit(1); }
/** GitHub's compare and PR file list omit the `patch` of a large file while the diff keeps its hunks; `state.omitPatch` names those files. */
function listed(files) { return files.map(f => (state.omitPatch ?? []).includes(f.filename) ? { ...f, patch: undefined } : f); }
const repo = 'Example/app';
const root = `repos/${repo}`;
if (args[0] === 'pr' && args[1] === 'diff') process.stdout.write(state.prDiff ?? state.diff);
else if (args[0] === 'run') process.stdout.write(state.log ?? 'Tests completed\n');
else if (args[0] === 'pr' && args[1] === 'merge') {
  if (args.includes('--disable-auto') && state.failDisarm === true) fail();
  if (args.includes('--auto') && state.failMerge === true) fail();
  // Someone closes the PR without a merge while the command runs.
  if (args.includes('--auto') && state.failMerge === 'closed') { state.prState = 'closed'; save(); fail(); }
  state.mutations.push(args);
  // gh merges at once a PR whose merge state is one of these, and enables auto-merge on any other.
  if (args.includes('--auto')) { if (['clean', 'unstable', 'has_hooks'].includes(state.mergeState)) { state.prState = 'closed'; state.merged = true; } else state.autoMerge = true; }
  if (args.includes('--disable-auto') && !state.stickyAutoMerge) state.autoMerge = false;
  save();
  if (args.includes('--disable-auto') && state.failDisarm === 'after') fail();
  if (args.includes('--auto') && state.failMerge === 'after') fail();
  process.stdout.write('{}');
}
else if (args[0] === 'api') {
  const raw = args[1];
  const endpoint = raw.split('?')[0];
  const query = new URLSearchParams(raw.split('?')[1] ?? '');
  if (state.failEndpoint && endpoint.includes(state.failEndpoint)) fail();
  // A write that fails while the read of the same endpoint answers: the daemon reads a PR's comments before it posts the hold comment.
  if (state.failPost && args.includes('POST') && endpoint.includes(state.failPost)) fail();
  if (args.includes('POST')) {
    const body = JSON.parse(readFileSync(0, 'utf8'));
    if (endpoint === `${root}/issues/1/comments`) {
      const id = 100 + state.comments.length;
      const comment = { id, body: body.body, user: { id: 7, login: 'converge' }, html_url: `https://github.com/${repo}/pull/1#issuecomment-${id}`, created_at: state.publicationTime ?? '2026-09-21T00:00:00Z', updated_at: state.publicationTime ?? '2026-09-21T00:00:00Z' };
      state.comments.push(comment); save(); send(comment);
    } else if (endpoint === `${root}/statuses/${state.head}`) {
      const status = { ...body, id: 200 + state.statuses.length, creator: { id: 7 }, sha: state.head };
      state.statuses.unshift(status); save(); send(status);
    } else if (/^repos\/Example\/app\/issues\/\d+\/comments$/.test(endpoint)) {
      const posted = { pr: Number(endpoint.split('/')[4]), body: body.body };
      (state.posted ??= []).push(posted); save(); send({ id: 900 + state.posted.length, ...posted });
    } else if (endpoint === `${root}/issues/1/labels`) {
      state.mutations.push(['labels', ...body.labels]);
      if (body.labels.includes('needs-victor')) state.hold = true;
      save(); send(body.labels.map(name => ({ name })));
    } else fail();
  } else if (endpoint === 'graphql') {
    const fields = Object.fromEntries(args.flatMap((arg, i) => ['-f', '-F'].includes(args[i - 1]) ? [arg.split(/=(.*)/s).slice(0, 2)] : []));
    if (fields.query.includes('dequeuePullRequest')) {
      const head = state.queueEntry?.headCommit ?? null;
      state.queueEntry = null; state.queueEvent = { __typename: 'RemovedFromMergeQueueEvent', createdAt: state.removalTime ?? '2026-09-30T00:00:00Z', reason: 'manual', beforeCommit: head };
      state.mutations.push(['dequeue', fields.pr]); save(); send({ data: { dequeuePullRequest: { clientMutationId: null } } });
    }
    else if (fields.query.includes('mergeQueue(branch:')) {
      later('queue');
      send({ data: { repository: { base: { target: { oid: state.trunk } }, head: { target: { oid: state.queueHead } }, mergeQueue: { entries: { pageInfo: { hasNextPage: state.queueTruncated ?? false }, nodes: state.queueEntries ?? [] } } } } });
    }
    else if (fields.query.includes('isMergeQueueEnabled')) send({ data: { repository: { pullRequest: { id: 'PR_1', isMergeQueueEnabled: state.queueEnabled ?? false, mergeQueueEntry: state.queueEntry ?? null, timelineItems: { nodes: state.queueEvent ? [state.queueEvent] : [] } } } } });
    else if (!fields.query.includes('repository(')) send({ data: { viewer: { databaseId: state.viewerId ?? 7, login: 'converge' } } });
    else send({ data: { repository: Object.fromEntries(Object.entries(fields).filter(([key]) => /^p\d+$/.test(key)).map(([key, expression]) => {
      const text = expression.startsWith(state.trunk + ':') ? state.blobs[expression.slice(41)] : expression.startsWith(state.head + ':') ? state.headBlobs[expression.slice(41)] : undefined;
      return [key, text === undefined ? null : { byteSize: Buffer.byteLength(text), isBinary: false, isTruncated: false, text }];
    })) } });
  }
  else if (endpoint.startsWith('repos/byvict/pstack-vic/commits/')) {
    if (state.invalidTooling) fail();
    send({ sha: endpoint.slice('repos/byvict/pstack-vic/commits/'.length) });
  }
  else if (endpoint === root) send({ default_branch: 'main' });
  else if (endpoint === `${root}/pulls/1`) {
    later('pulls/1');
    send({ number: 1, head: { sha: state.head, ref: 'change', repo: { full_name: repo } }, base: { ref: state.prBase }, state: state.prState, draft: state.prDraft, body: state.body, labels: state.hold ? [{ name: 'needs-victor' }] : [], user: state.prUser ?? { id: 10, login: 'author', type: 'User' }, auto_merge: state.autoMerge ? {} : null, created_at: state.createdAt ?? '2026-09-21T00:00:00Z', ...(state.omitMergeable ? {} : { mergeable: state.mergeable === undefined ? true : state.mergeable }), ...(state.mergeState === undefined ? {} : { mergeable_state: state.mergeState }), ...(state.merged === undefined ? {} : { merged: state.merged }) });
  }
  else if (/^repos\/Example\/app\/pulls\/\d+$/.test(endpoint) && state.pulls.some(p => p.number === Number(endpoint.split('/').at(-1)))) send(state.pulls.find(p => p.number === Number(endpoint.split('/').at(-1))));
  else if (endpoint === `${root}/commits/main`) { later('commits/main'); send({ sha: state.trunk }); }
  else if (endpoint.startsWith(`${root}/git/trees/`)) send({ truncated: false, tree: Object.keys(state.blobs).map(path => ({ path, mode: '100644' })) });
  else if (endpoint.startsWith(`${root}/contents/`)) {
    const path = endpoint.slice(`${root}/contents/`.length);
    const content = query.get('ref') === state.head && path in state.headBlobs ? state.headBlobs[path] : state.blobs[path];
    if (content === undefined) fail();
    send({ type: 'file', encoding: 'base64', size: Buffer.byteLength(content), content: Buffer.from(content).toString('base64') });
  }
  // `state.trunkHistory` is the trunk's history, oldest first, as `{ sha, parents }`: a compare of a trunk commit with the tip lists the commits after it up to the tip, oldest first, at most `state.compareLimit` of them.
  else if (endpoint.startsWith(`${root}/compare/`) && state.trunkHistory && endpoint.endsWith(`...${state.trunk}`)) {
    const [from] = endpoint.slice(`${root}/compare/`.length).split('...');
    const index = state.trunkHistory.findIndex(c => c.sha === from);
    if (index < 0) send({ status: 'diverged', total_commits: 1, commits: [] });
    else {
      const after = state.trunkHistory.slice(index + 1, state.trunkHistory.findIndex(c => c.sha === state.trunk) + 1);
      send({ status: after.length ? 'ahead' : 'identical', total_commits: after.length, commits: after.slice(0, state.compareLimit ?? 100).map(c => ({ sha: c.sha, parents: c.parents.map(sha => ({ sha })) })) });
    }
  }
  else if (endpoint.startsWith(`${root}/compare/`) && args.some(a => a.includes('application/vnd.github.diff'))) {
    const [, head] = endpoint.slice(`${root}/compare/`.length).split('...');
    if (head !== (state.pushedHead ?? state.head) && !(state.memberHeads ?? []).includes(head)) fail();
    process.stdout.write(state.diff);
  }
  else if (endpoint.startsWith(`${root}/compare/`)) {
    const [, head] = endpoint.slice(`${root}/compare/`.length).split('...');
    if (head === state.queueHead) { send({ files: state.groupFiles ?? state.files }); process.exit(0); }
    if (head !== (state.pushedHead ?? state.head) && !(state.memberHeads ?? []).includes(head)) fail();
    const commits = (state.commits ?? [{ message: 'head' }]).map(c => ({ sha: c.sha ?? state.head, commit: { message: c.message } }));
    send({ merge_base_commit: { sha: state.base }, files: listed(state.files), commits, total_commits: state.totalCommits ?? commits.length });
  }
  else if (endpoint === `${root}/pulls` && (query.get('base') === 'main' || query.get('state') === 'open')) send(state.pulls ?? []);
  else if (endpoint === `${root}/pulls/1/files`) send(listed(state.prFiles ?? state.files));
  else if (endpoint === `${root}/actions/workflows`) send({ workflows: [{ id: state.workflowId, name: 'Tests', path: '.github/workflows/tests.yml', state: 'active' }] });
  else if (endpoint === `${root}/actions/runs/99`) send(state.reviewSignal);
  else if (/^repos\/Example\/app\/commits\/[a-f0-9]{40}\/pulls$/.test(endpoint)) send(state.commitPulls?.[endpoint.split('/')[4]] ?? []);
  else if (endpoint.includes('/check-runs')) {
    if (state.requireInstallationChecks && process.env.GITHUB_ACTIONS !== 'true' && (process.env.GH_TOKEN || process.env.GITHUB_TOKEN)) fail();
    // `state.refChecks` gives one commit, named by sha or branch as the endpoint names it, its own check runs.
    const ref = endpoint.split('/')[4];
    send({ check_runs: (state.refChecks?.[ref] ?? state.checks).map(c => ({ ...c, head_sha: c.head_sha ?? (ref === state.queueHead ? ref : state.head) })) });
  }
  // `state.pushRuns` gives each trunk commit its own push run (`{ status, conclusion, jobConclusion? }`), none for a commit it lacks; its jobs answer under run id 1000 + the commit's position.
  else if (endpoint === `${root}/actions/workflows/${state.workflowId}/runs` && query.get('event') === 'push' && state.pushRuns) {
    const commit = query.get('head_sha');
    const run = state.pushRuns[commit];
    send({ workflow_runs: run ? [{ id: 1000 + Object.keys(state.pushRuns).indexOf(commit), workflow_id: state.workflowId, head_sha: commit, event: 'push', head_branch: 'main', run_attempt: 1, status: run.status, conclusion: run.conclusion }] : [] });
  }
  else if (/^repos\/Example\/app\/actions\/runs\/1\d{3}\/attempts\/1\/jobs$/.test(endpoint) && state.pushRuns) {
    const commit = Object.keys(state.pushRuns)[Number(endpoint.split('/')[5]) - 1000];
    const run = state.pushRuns[commit];
    send({ jobs: [{ name: 'Run test suite', head_sha: commit, status: run.status, conclusion: run.jobConclusion ?? run.conclusion }] });
  }
  else if (endpoint === `${root}/actions/workflows/${state.workflowId}/runs`) send({ workflow_runs: [{ id: 8, workflow_id: state.workflowId, head_sha: query.get('head_sha'), event: query.get('event') ?? 'pull_request', head_branch: 'main', run_attempt: 1, status: 'completed', conclusion: state.trunkRed && query.get('event') === 'push' ? 'failure' : 'success', ...(query.get('event') === 'push' ? {} : state.runOverrides) }] });
  else if (endpoint === `${root}/actions/runs/${state.runOverrides.id ?? 8}/attempts/${state.runOverrides.run_attempt ?? 1}/jobs`) send({ jobs: state.jobs });
  else if (/^repos\/Example\/app\/issues\/\d+\/comments$/.test(endpoint)) send(endpoint === `${root}/issues/1/comments` ? state.comments : state.memberComments?.[endpoint.split('/')[4]] ?? []);
  else if (/^repos\/Example\/app\/pulls\/\d+\/comments$/.test(endpoint)) send(endpoint === `${root}/pulls/1/comments` ? state.reviewComments ?? [] : []);
  else if (/^repos\/Example\/app\/pulls\/\d+\/reviews$/.test(endpoint)) send(endpoint === `${root}/pulls/1/reviews` ? state.reviews ?? [] : []);
  else if (endpoint.startsWith(`${root}/issues/comments/`)) { const found = state.comments.find(c => c.id === Number(endpoint.split('/').at(-1))); if (!found) fail(); send(found); }
  else if (endpoint.endsWith('/statuses')) send(state.statuses.filter(s => (s.sha ?? state.head) === endpoint.split('/')[4]));
  else if (endpoint === `${root}/branches/main`) {
    if (state.protectionMessage !== 'Branch not protected') fail();
    const checks = state.classicProtection === false ? [] : state.protected;
    send({ protected: state.classicProtection !== false, protection: { required_status_checks: { contexts: checks, checks: checks.map(context => ({ context, app_id: context === 'verdict' || (state.statusContexts ?? []).includes(context) ? null : 15368 })) } } });
  }
  else if (endpoint === `${root}/rules/branches/main`) send(state.classicProtection === false ? [{ type: 'required_status_checks', parameters: { strict_required_status_checks_policy: false, do_not_enforce_on_create: false, required_status_checks: state.protected.map(context => context === 'verdict' || (state.statusContexts ?? []).includes(context) ? { context } : { context, integration_id: 15368 }) }, ruleset_source_type: 'Repository', ruleset_source: repo, ruleset_id: 1 }] : []);
  else fail();
} else fail();
