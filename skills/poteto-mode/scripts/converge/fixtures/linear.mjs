#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const prompt = readFileSync(0, 'utf8');
const args = process.argv.slice(2), file = process.env.LINEAR_REMOTE;
let state = JSON.parse(readFileSync(file, 'utf8'));
const prefix = 'mcp__claude_ai_Linear__';
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
let n = 0;
const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
function use(name, input, result, error = false) {
  const id = `call-${++n}`;
  emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: prefix + name, input }] } });
  emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: error, content: [{ type: 'text', text: JSON.stringify(result) }] }] } });
}
emit({ type: 'system', subtype: 'init', session_id: `fixture-${process.pid}`, tools: state.mode === 'no-mcp' ? [] : ['ToolSearch', ...['get_issue', 'list_comments', 'get_project', 'get_document', 'save_comment', 'save_issue'].map(n => prefix + n)] });
if (state.mode === 'no-mcp' || state.mode === 'forged') {
  emit({ type: 'result', result: JSON.stringify({ outcome: 'done', calls: [{ tool: prefix + 'get_issue', args: { id: state.issue.id }, result: state.issue }] }) });
} else if (prompt.startsWith('Execute only')) {
  if (state.mode === 'crash-before-hook') process.exit(1);
  const effects = JSON.parse(prompt.split('\n')[1]);
  for (const e of effects) {
    const hook = settings.hooks.PreToolUse[0].hooks[0].command;
    const decision = spawnSync(hook, { shell: true, input: JSON.stringify({ tool_name: e.tool, tool_input: e.args }), encoding: 'utf8' });
    if (decision.status !== 0) { use(e.tool.slice(prefix.length), e.args, { denied: decision.stderr }, true); continue; }
    if (state.mode === 'ambiguous') process.exit(1);
    if (e.tool.endsWith('save_comment')) {
      if (e.args.id) { const c = state.comments.find(c => c.id === e.args.id); if (!c) throw new Error('Missing fixture comment'); c.body = e.args.body; }
      else state.comments.push({ id: `comment-${state.comments.length + 1}`, body: e.args.body });
    }
    if (e.tool.endsWith('save_issue')) state.issue.statusType = 'completed';
    state.mutations.push(e); writeFileSync(file, JSON.stringify(state));
    if (state.mode === 'crash-after-effect') process.exit(1);
    use(e.tool.slice(prefix.length), e.args, e.tool.endsWith('save_comment') ? state.comments.find(c => c.id === e.args.id) ?? state.comments.at(-1) : state.issue);
  }
  emit({ type: 'result', result: 'done' });
} else if (prompt.startsWith('Independently')) {
  if (state.assessmentDelayMs) await new Promise(resolve => setTimeout(resolve, state.assessmentDelayMs));
  emit({ type: 'result', result: JSON.stringify(state.review ?? state.assessment ?? { targets: [] }) });
} else {
  use('get_issue', { id: state.issue.id }, state.issue);
  use('list_comments', { issueId: state.issue.uuid ?? state.issue.id, limit: 250 }, { comments: state.comments, hasNextPage: state.mode === 'partial' });
  use('get_project', { query: state.issue.projectId, includeResources: true }, state.project);
  use('list_comments', { projectId: state.project.uuid ?? state.project.id, limit: 250 }, { comments: state.projectComments ?? [], hasNextPage: false });
  for (const doc of state.documents) { use('get_document', { id: doc.id }, doc); use('list_comments', { documentId: doc.id, limit: 250 }, { comments: [], hasNextPage: false }); }
  emit({ type: 'result', result: JSON.stringify(state.assessment ?? { targets: [] }) });
}
writeFileSync(process.env.LINEAR_ARGV, JSON.stringify({ args, setupTokenInherited: 'CLAUDE_CODE_OAUTH_TOKEN' in process.env }));
