import { mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { integer, object, oneOf, repoName, sha, string } from './contract.ts';

const kinds = ['round', 'verifier', 'verdict', 'repair', 'armed', 'merged', 'trunk-green', 'held'] as const;
type Kind = typeof kinds[number];
interface Event { id: string; kind: Kind; head: string; at: string; detail: string }
interface State {
  schemaVersion: 1; repo: string; pr: number; ownerAgentId: string; ownerRunId: string;
  startedAt: string; deadlineAt: string; currentHead: string; repairs: number; events: Event[];
}

function path(directory: string): string { return resolve(directory, 'state.json'); }
function parseState(value: unknown): State {
  const v = object(value, 'progress state');
  const events = v.events;
  if (v.schemaVersion !== 1 || !Array.isArray(events)) throw new Error('Invalid progress state');
  return { schemaVersion: 1, repo: repoName(v.repo), pr: integer(v.pr), ownerAgentId: string(v.ownerAgentId), ownerRunId: string(v.ownerRunId),
    startedAt: string(v.startedAt), deadlineAt: string(v.deadlineAt), currentHead: sha(v.currentHead), repairs: integer(v.repairs),
    events: events.map(value => {
      const e = object(value, 'progress event');
      return { id: string(e.id), kind: oneOf(e.kind, kinds), head: sha(e.head), at: string(e.at), detail: string(e.detail) };
    }) };
}
export function init(directory: string, input: { repo: string; pr: number; agentId: string; runId: string; head: string }, now = Date.now()): State {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const state: State = { schemaVersion: 1, repo: repoName(input.repo), pr: input.pr, ownerAgentId: input.agentId, ownerRunId: input.runId,
    startedAt: new Date(now).toISOString(), deadlineAt: new Date(now + 6 * 60 * 60 * 1000).toISOString(), currentHead: sha(input.head), repairs: 0, events: [] };
  if (!Number.isSafeInteger(input.pr) || input.pr < 1 || !/^[A-Za-z0-9_-]+$/.test(input.agentId) || !/^[A-Za-z0-9_-]+$/.test(input.runId)) throw new Error('Invalid owner identity');
  try { writeFileSync(path(directory), JSON.stringify(state, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); return state; }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    const existing = parseState(JSON.parse(readFileSync(path(directory), 'utf8')));
    if (existing.repo !== state.repo || existing.pr !== state.pr || existing.ownerAgentId !== state.ownerAgentId || existing.ownerRunId !== state.ownerRunId) throw new Error('Another owner holds this progress file');
    return existing;
  }
}
export function record(directory: string, event: Omit<Event, 'at'>, now = Date.now()): State {
  const lock = resolve(directory, '.lock');
  mkdirSync(lock);
  try {
    const state = parseState(JSON.parse(readFileSync(path(directory), 'utf8')));
    const existing = state.events.find(item => item.id === event.id);
    if (existing) {
      if (existing.kind !== event.kind || existing.head !== event.head || existing.detail !== event.detail) throw new Error('Progress event id was reused with different content');
      return state;
    }
    if (now > Date.parse(state.deadlineAt) || state.events.some(item => item.kind === 'held' || item.kind === 'trunk-green')) throw new Error('Converge progress is closed or expired');
    if (event.kind === 'repair' && state.repairs >= 2) throw new Error('Code repair budget exhausted');
    if (event.kind === 'repair' && event.head !== state.currentHead) throw new Error('Repair must name the current pre-push head');
    if (event.kind === 'round' && event.head !== state.currentHead) state.currentHead = sha(event.head);
    else if (event.kind !== 'round' && event.head !== state.currentHead) throw new Error('Progress event head differs from current round');
    state.events.push({ ...event, at: new Date(now).toISOString() });
    if (event.kind === 'repair') state.repairs++;
    const temporary = resolve(directory, `state-${process.pid}.json`);
    writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path(directory));
    return state;
  } finally { rmdirSync(lock); }
}

if (import.meta.main) {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: { dir: { type: 'string' }, repo: { type: 'string' }, pr: { type: 'string' }, agent: { type: 'string' }, run: { type: 'string' }, head: { type: 'string' }, id: { type: 'string' }, kind: { type: 'string' }, detail: { type: 'string' } } });
    if (!values.dir) throw new Error('Progress requires --dir');
    const command = positionals[0];
    const result = command === 'init' && values.repo && values.pr && values.agent && values.run && values.head
      ? init(values.dir, { repo: values.repo, pr: Number(values.pr), agentId: values.agent, runId: values.run, head: values.head })
      : command === 'record' && values.id && values.kind && values.head
        ? record(values.dir, { id: values.id, kind: oneOf(values.kind, kinds), head: values.head, detail: values.detail ?? '' })
        : (() => { throw new Error('Usage: progress.ts init|record --dir DIRECTORY with owner or event fields'); })();
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (error) { process.stderr.write((error instanceof Error ? error.message : 'Progress failed') + '\n'); process.exitCode = 1; }
}
