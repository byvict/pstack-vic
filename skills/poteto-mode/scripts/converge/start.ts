import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { object, repoName, roleProviders, sha, string } from './contract.ts';
import { admitPull, api, principal, pull, trusted } from './github.ts';
import { verdictGate } from './gate.ts';
import { selectCursorModel } from '../runner/http-lane.ts';
import { formatDescriptor, loadMatrix, parseDescriptor, type ModelMatrix } from '../../../../scripts/model-matrix.ts';

type Effort = 'high' | 'xhigh';
interface LaunchReceipt {
  schemaVersion: 1; repo: string; pr: number; head: string; toolingRef: string;
  model: 'grok-4.7'; effort: Effort; verifierEffort: Effort; modelSelection: string;
  agentId: string; runId: string; agentUrl: string;
}
export interface CertifiedHead { schemaVersion: 1; kind: 'certified'; repo: string; pr: number; head: string; verdictUrl: string }

/** The lanes the pr owner and pr verifier rows accept, the same ones setup-pstack writes: the Cloud verifier's pinned lanes, or an alias that sets no floor. */
export function sheetLanes(matrix: ModelMatrix): string[] {
  const { provider, model, efforts } = roleProviders['pr verifier'];
  return [...efforts.map(effort => formatDescriptor({ provider, model, effort })), ...matrix.aliases];
}

export function sheetEfforts(text: string): { owner: Effort; verifier: Effort } {
  const matrix = loadMatrix();
  const lanes = sheetLanes(matrix);
  const floor = (role: string): Effort => {
    const line = text.split('\n').map(l => l.trim()).find(l => l.startsWith(role + ':'));
    if (line === undefined) return 'high';
    const lane = line.slice(role.length + 1).trim();
    if (!lanes.includes(lane)) throw new Error(`Sheet row ${role}: ${lane} must be ${lanes.slice(0, -1).join(', ')} or ${lanes[lanes.length - 1]}`);
    if (matrix.aliases.includes(lane)) return 'high';
    const effort = parseDescriptor(lane)?.effort;
    if (effort !== 'high' && effort !== 'xhigh') throw new Error(`Sheet row ${role}: start.ts launches only high or xhigh, not ${lane}`);
    return effort;
  };
  return { owner: floor('pr owner'), verifier: floor('pr verifier') };
}

function readSheet(path: string | undefined): { owner: Effort; verifier: Effort } {
  if (path === undefined) return { owner: 'high', verifier: 'high' };
  try { return sheetEfforts(readFileSync(path, 'utf8')); }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { owner: 'high', verifier: 'high' }; throw error; }
}

async function cursor(path: string, key: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`https://api.cursor.com${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Basic ${Buffer.from(key + ':').toString('base64')}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Cursor ${path} returned HTTP ${response.status}`);
  return response.json();
}

async function recover(directory: string, key: string, expected: { repo: string; pr: number; toolingRef: string; effort: Effort; verifierEffort: Effort }): Promise<LaunchReceipt> {
  const intent = object(JSON.parse(readFileSync(resolve(directory, 'intent.json'), 'utf8')));
  const head = sha(intent.head);
  if (intent.repo !== expected.repo || intent.pr !== expected.pr || intent.toolingRef !== expected.toolingRef || intent.effort !== expected.effort || (intent.verifierEffort ?? 'high') !== expected.verifierEffort) throw new Error('Existing launch intent belongs to different inputs');
  const createdAt = Date.parse(string(intent.createdAt));
  if (!Number.isFinite(createdAt)) throw new Error('Invalid launch intent time');
  const name = `converge ${expected.repo}#${expected.pr} ${head.slice(0, 8)}`;
  const matches: Record<string, unknown>[] = [];
  let next: string | null = '/v1/agents?limit=100';
  for (let page = 0; next !== null && page < 10; page++) {
    const listing = object(await cursor(next, key));
    const items = listing.items;
    if (!Array.isArray(items)) throw new Error('Cursor agent listing unavailable');
    for (const value of items) {
      const agent = object(value);
      if (agent.name === name && Date.parse(string(agent.createdAt)) >= createdAt - 60_000) matches.push(agent);
    }
    next = typeof listing.nextCursor === 'string' && listing.nextCursor ? `/v1/agents?limit=100&cursor=${encodeURIComponent(listing.nextCursor)}` : null;
  }
  if (matches.length !== 1) throw new Error(`Launch outcome unknown: found ${matches.length} matching Cursor agents; do not relaunch`);
  const agent = object(matches[0]);
  const receipt = parseReceipt({ schemaVersion: 1, repo: expected.repo, pr: expected.pr, head, toolingRef: expected.toolingRef, model: 'grok-4.7', effort: expected.effort, verifierEffort: expected.verifierEffort,
    modelSelection: string(intent.modelSelection), agentId: agent.id, runId: agent.latestRunId, agentUrl: agent.url });
  writeFileSync(resolve(directory, 'launch.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return receipt;
}

function ownerPrompt(options: { repo: string; pr: number; head: string; toolingRef: string; effort: Effort; verifierEffort: Effort }): string {
  const { repo, pr, head, toolingRef, effort, verifierEffort } = options;
  const verifierLane = verifierEffort === 'xhigh'
    ? `Prepare its one 'pr verifier' lane with descriptor cursor:grok-4.7@xhigh and launch it with pstack-runner --parent codex --provider cursor --model grok-4.7 --effort xhigh --mode read-only --repo ${repo} --pr ${pr}. The pstack model sheet sets xhigh as the verifier floor; never run it at high.`
    : `Prepare its one 'pr verifier' lane with descriptor cursor:grok-4.7@high for a simple change or cursor:grok-4.7@xhigh for a complex change. Launch that lane with pstack-runner --parent codex --provider cursor --model grok-4.7 --effort high or xhigh --mode read-only --repo ${repo} --pr ${pr}.`;
  return `You are the Converge v1 PR owner for ${repo}#${pr}, initial head ${head}. Run the whole cycle in this Cloud Agent session. Your requested model is Grok 4.7 ${effort}. Use only Cursor Cloud Agents with Grok 4.7 high for simple tasks and xhigh for complex work. The independent verifier must be a distinct read-only Cursor Cloud Agent. Never verify your own correction.

First confirm the PR still points at ${head} and has no hold label. Use the Node 24 binary installed under /home/ubuntu/.nvm/versions/node/v24*/bin/node, not /exec-daemon/node. Clone https://github.com/byvict/pstack-vic.git into /tmp/converge-tooling, check out exact commit ${toolingRef}, and read docs/converge-v1.md plus skills/poteto-mode/references/converge-contract.md and skills/poteto-mode/playbooks/converge.md. Set CURSOR_API_KEY in your shell from PSTACK_AGENT_TOKEN. Set and export GH_TOKEN from the Cursor runtime secret PSTACK_GITHUB_TOKEN in every shell that calls gh, the converge tooling, or git. Never print either secret or interpolate its value into a tmux command, shell argument, script, log, or Git configuration. Background jobs must inherit the exported environment; scripts may reference variable names, not literal values. Confirm GET /v1/models succeeds and gh api graphql -f query='{ viewer { login } }' identifies the authorized user before starting verification. If the GitHub secret is missing or denied, apply needs-victor with the failed operation and stop. The local launcher already confirmed this initial agent id and run id; do not launch another owner.

Work in an exclusive /tmp/converge-${pr} directory. Run progress.ts init with your Cursor metadata agent/run ids, repo, PR and head. Run progress.ts record with a unique id, kind, head and detail before each round, verifier launch, verdict, repair, arm, merge and trunk result. The script enforces two code repair attempts and six hours. Preserve state.json and copy it under /opt/cursor/artifacts/converge/owner-${pr}/ after each transition. One owner writes the PR branch. An uncertain verifier launch or repair push must be recovered by its recorded id before retrying. Waiting for CI or recovering environment does not spend a repair attempt. If you cannot advance, post the cause and evidence to the PR and add needs-victor. Never treat missing evidence as approval.

For each current head, run converge-reconcile from the pinned tooling. ${verifierLane} Use the prompt, output and receipt paths from the manifest. Run publish.ts with the report, manifest and evidence directory. Read its machine verdict and exact-head status. Do not end your run after publication.

If NOT VERIFIED, inspect the findings and fix the branch yourself. Confirm the live head before push. The sandbox's default git credential may be read-only: set origin to https://github.com/${repo}.git and push with GH_TOKEN exported using git -c credential.helper= -c credential.helper='!gh auth git-credential' push origin HEAD:<PR-branch>. Never place a token in a remote URL or command argument. Record the attempt, push, wait for relevant CI, then run a fresh reconciliation and a fresh independent verifier. If INCONCLUSIVE, recover the named missing condition and repeat verification without counting a code repair. Do not reuse a verdict for a changed patch. For a complex repair discovered while this owner is high, launch a replacement Grok 4.7 xhigh owner with a durable handoff and end only after its launch is confirmed; never perform complex work at high.

If VERIFIED, run converge-arm with the exact current head. It checks the latest trunk Tests, effective branch protection, required checks including verdict, the authenticated current-head verdict, and hold labels. If it refuses, resolve the stated condition or apply needs-victor with evidence. Monitor auto-merge and disarm on a new hold, invalid verdict, changed head, or timeout. After merge, identify and watch the resulting main Tests run. Report the PR URL, all Cursor run URLs, requested model and effort, evidence, fix, verdict URL, merged commit, and main Tests result in a PR comment. Never assert the served model from a request receipt alone. Do not change production data or invent a production change for this workflow.`;
}

export async function start(options: { repo: string; pr: number; toolingRef: string; stateDirectory?: string; effort?: Effort; sheetPath?: string; configPath?: string }): Promise<(LaunchReceipt & { kind: 'launched' }) | CertifiedHead> {
  const repo = repoName(options.repo);
  const toolingRef = sha(options.toolingRef);
  const floors = readSheet(options.sheetPath);
  const effort: Effort = options.effort === 'xhigh' || floors.owner === 'xhigh' ? 'xhigh' : 'high';
  const verifierEffort = floors.verifier;
  const directory = resolve(options.stateDirectory ?? resolve(homedir(), '.codex/converge', `${repo.replace('/', '-')}-${options.pr}`));
  const receiptPath = resolve(directory, 'launch.json');
  try {
    const existing = parseReceipt(JSON.parse(readFileSync(receiptPath, 'utf8')));
    if (existing.repo !== repo || existing.pr !== options.pr || existing.toolingRef !== toolingRef || existing.effort !== effort || existing.verifierEffort !== verifierEffort) throw new Error('Existing launch belongs to different inputs');
    return { kind: 'launched', ...existing };
  } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw new Error('Existing launch receipt is invalid or differs; inspect before retry'); }
  if (existsSync(resolve(directory, 'intent.json'))) {
    const key = process.env.CURSOR_API_KEY;
    if (!key) throw new Error('CURSOR_API_KEY is unavailable for launch recovery');
    return { kind: 'launched', ...(await recover(directory, key, { repo, pr: options.pr, toolingRef, effort, verifierEffort })) };
  }
  const toolingCommit = object(await api(`repos/byvict/pstack-vic/commits/${toolingRef}`));
  if (sha(toolingCommit.sha) !== toolingRef) throw new Error('Tooling commit does not match requested ref');
  const t = await trusted(repo, options.configPath ?? '.cursor/converge.json');
  const initial = await pull(repo, options.pr);
  admitPull(initial, t.config, initial.head);
  const verdict = await verdictGate(t, options.pr, initial.head, await principal());
  if (verdict.kind === 'certified') {
    admitPull(await pull(repo, options.pr), t.config, initial.head);
    return { schemaVersion: 1, kind: 'certified', repo, pr: options.pr, head: initial.head, verdictUrl: verdict.url };
  }
  const key = process.env.CURSOR_API_KEY;
  if (!key) throw new Error('CURSOR_API_KEY is unavailable locally');
  const selected = selectCursorModel(await cursor('/v1/models', key), 'grok-4.7', effort);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const prompt = ownerPrompt({ repo, pr: options.pr, head: initial.head, toolingRef, effort, verifierEffort });
  const intent = { schemaVersion: 1, repo, pr: options.pr, head: initial.head, toolingRef, model: 'grok-4.7', effort, verifierEffort, modelSelection: selected.evidence, prompt, createdAt: new Date().toISOString() };
  admitPull(await pull(repo, options.pr), t.config, initial.head);
  writeFileSync(resolve(directory, 'intent.json'), JSON.stringify(intent, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const response = object(await cursor('/v1/agents', key, {
    name: `converge ${repo}#${options.pr} ${initial.head.slice(0, 8)}`,
    repos: [{ url: `https://github.com/${repo}`, prUrl: `https://github.com/${repo}/pull/${options.pr}` }],
    workOnCurrentBranch: true, autoCreatePR: false,
    model: { id: 'grok-4.7', params: selected.params },
    envVars: { PSTACK_AGENT_TOKEN: key },
    prompt: { text: prompt },
  }));
  const agent = object(response.agent);
  const run = object(response.run);
  const receipt = parseReceipt({ schemaVersion: 1, repo, pr: options.pr, head: initial.head, toolingRef, model: 'grok-4.7', effort, verifierEffort, modelSelection: selected.evidence,
    agentId: agent.id, runId: run.id, agentUrl: agent.url });
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { kind: 'launched', ...receipt };
}

function parseReceipt(value: unknown): LaunchReceipt {
  const v = object(value);
  const agentId = string(v.agentId); const runId = string(v.runId); const agentUrl = string(v.agentUrl);
  if (v.schemaVersion !== 1 || v.model !== 'grok-4.7' || (v.effort !== 'high' && v.effort !== 'xhigh') || !/^[A-Za-z0-9_-]+$/.test(agentId) || !/^[A-Za-z0-9_-]+$/.test(runId) || agentUrl !== `https://cursor.com/agents/${agentId}`) throw new Error('Invalid launch receipt');
  const verifierEffort = v.verifierEffort ?? 'high';
  if (verifierEffort !== 'high' && verifierEffort !== 'xhigh') throw new Error('Invalid launch receipt');
  const pr = Number(v.pr);
  if (!Number.isSafeInteger(pr) || pr < 1) throw new Error('Invalid launch PR');
  return { schemaVersion: 1, repo: repoName(v.repo), pr, head: sha(v.head), toolingRef: sha(v.toolingRef), model: 'grok-4.7', effort: v.effort, verifierEffort, modelSelection: string(v.modelSelection), agentId, runId, agentUrl };
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({ options: { repo: { type: 'string' }, pr: { type: 'string' }, 'tooling-ref': { type: 'string' }, parent: { type: 'string' }, state: { type: 'string' }, effort: { type: 'string' }, config: { type: 'string' } } });
    if (!values.repo || !values.pr || !/^\d+$/.test(values.pr) || !values['tooling-ref'] || !['claude', 'codex'].includes(values.parent ?? '') || (values.effort !== undefined && !['high', 'xhigh'].includes(values.effort))) throw new Error('Usage: start.ts --repo owner/repo --pr N --tooling-ref SHA --parent claude|codex [--effort high|xhigh] [--state directory]');
    process.stdout.write(JSON.stringify(await start({ repo: values.repo, pr: Number(values.pr), toolingRef: values['tooling-ref'], stateDirectory: values.state, effort: values.effort === 'xhigh' ? 'xhigh' : values.effort === 'high' ? 'high' : undefined, sheetPath: resolve(homedir(), `.${values.parent}`, 'pstack-models.md'), configPath: values.config }), null, 2) + '\n');
  } catch (error) { process.stderr.write((error instanceof Error ? error.message : 'Launch failed') + '\n'); process.exitCode = 1; }
}
