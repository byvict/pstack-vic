#!/usr/bin/env node
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
const file = process.env.CONVERGE_FIXTURE;
const state = JSON.parse(readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
appendFileSync(file + '.calls', JSON.stringify(args) + '\n');
function send(value) { process.stdout.write(JSON.stringify(args.includes('--slurp') ? [value] : value)); }
function save() { writeFileSync(file, JSON.stringify(state)); }
function fail() { process.exit(1); }
const repo = 'Example/app';
const root = `repos/${repo}`;
if (args[0] === 'pr' && args[1] === 'diff') process.stdout.write(state.diff);
else if (args[0] === 'run') process.stdout.write(state.log ?? 'Tests completed\n');
else if (args[0] === 'pr' && args[1] === 'merge') { state.mutations.push(args); save(); process.stdout.write('{}'); }
else if (args[0] === 'api') {
  const raw = args[1];
  const endpoint = raw.split('?')[0];
  const query = new URLSearchParams(raw.split('?')[1] ?? '');
  if (state.failEndpoint && endpoint.includes(state.failEndpoint)) fail();
  if (args.includes('POST')) {
    const body = JSON.parse(readFileSync(0, 'utf8'));
    if (endpoint === `${root}/issues/1/comments`) {
      const id = 100 + state.comments.length;
      const comment = { id, body: body.body, user: { id: 7 }, html_url: `https://github.com/${repo}/pull/1#issuecomment-${id}`, updated_at: '2026-09-21T00:00:00Z' };
      state.comments.push(comment); save(); send(comment);
    } else if (endpoint === `${root}/statuses/${state.head}`) {
      const status = { ...body, id: 200 + state.statuses.length, creator: { id: 7 } };
      state.statuses.unshift(status); save(); send(status);
    } else fail();
  } else if (endpoint === 'user') send({ id: 7 });
  else if (endpoint === root) send({ default_branch: 'main' });
  else if (endpoint === `${root}/pulls/1`) send({ number: 1, head: { sha: state.head, ref: 'change' }, base: { ref: 'main' }, state: 'open', draft: false, body: state.body, labels: state.hold ? [{ name: 'needs-victor' }] : [], user: { id: 10, login: 'author', type: 'User' }, auto_merge: state.autoMerge ? {} : null });
  else if (endpoint === `${root}/commits/main`) send({ sha: state.trunk });
  else if (endpoint.startsWith(`${root}/git/trees/`)) send({ truncated: false, tree: Object.keys(state.blobs).map(path => ({ path, mode: '100644' })) });
  else if (endpoint.startsWith(`${root}/contents/`)) {
    const path = endpoint.slice(`${root}/contents/`.length);
    const content = state.blobs[path];
    if (content === undefined) fail();
    send({ type: 'file', encoding: 'base64', size: Buffer.byteLength(content), content: Buffer.from(content).toString('base64') });
  } else if (endpoint.startsWith(`${root}/compare/`)) send({ merge_base_commit: { sha: state.base } });
  else if (endpoint === `${root}/pulls/1/files`) send(state.files);
  else if (endpoint === `${root}/actions/workflows`) send({ workflows: [{ id: 5, name: 'Tests', path: '.github/workflows/tests.yml', state: 'active' }] });
  else if (endpoint.includes('/check-runs')) send({ check_runs: state.checks.map(c => ({ ...c, head_sha: state.head })) });
  else if (endpoint === `${root}/actions/workflows/5/runs`) send({ workflow_runs: [{ id: 8, workflow_id: 5, head_sha: query.get('head_sha'), event: query.get('event') ?? 'pull_request', head_branch: 'main', run_attempt: 1, status: 'completed', conclusion: state.trunkRed && query.get('event') === 'push' ? 'failure' : 'success' }] });
  else if (endpoint === `${root}/actions/runs/8/attempts/1/jobs`) send({ jobs: [{ id: 4, name: 'Run test suite', head_sha: state.trunk, conclusion: 'success', check_run_url: `https://api.github.com/repos/${repo}/check-runs/11` }, { id: 6, name: 'Server (gates + suite)', head_sha: state.head, conclusion: 'success', steps: [{name:'Run tests', conclusion:'success'}] }] });
  else if (endpoint === `${root}/issues/1/comments`) send(state.comments);
  else if (endpoint === `${root}/pulls/1/comments`) send([]);
  else if (endpoint.startsWith(`${root}/issues/comments/`)) send(state.comments.find(c => c.id === Number(endpoint.split('/').at(-1))) ?? {});
  else if (endpoint.endsWith('/statuses')) send(state.statuses);
  else if (endpoint === `${root}/branches/main/protection`) send({ required_status_checks: { contexts: state.protected, checks: state.protected.map(context => ({ context, app_id: context === 'verdict' ? null : 15368 })) } });
  else if (endpoint === `${root}/rules/branches/main`) send([]);
  else fail();
} else fail();
