import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { array, boolean, digest, executionId, hash, integer, object, oneOf, relativePath, repoName, sha, string } from '../contract.ts';
import { originalOf, type Original } from './plant.ts';
import { admitLaunch, combineCosts, priceUsage, recordUsage, type CostResult, type CostSummary, type Usage } from './usage.ts';
import {
  listingPaths, parseRunStream, verifiedOriginalBytes,
  RemoteCollectionError, type CompletedTool, type DownloadedArtifact, type ExecutableCommand,
} from './historical-cursor.ts';
import {
  claimRun, collectLaunched, launchPrepared, opaqueAttemptId, originMatches,
  parseIntent, persistJson, prepareAttempt, recoverReceipt, validateCarrier, type HistoricalHost, type HistoricalIdentity as DispatchIdentity,
  type HistoricalIntent,
  type PreparedAttempt,
  type Role as DispatchRole,
} from './historical-dispatch.ts';

export type Role = DispatchRole;
export type HistoricalIdentity = DispatchIdentity;
export type CorpusFinding = Readonly<{ kind: string; files?: readonly string[]; evidence?: string; disposition?: string }>;
export type CorpusHit = Readonly<{ pr: number; failHead: string; findings: readonly CorpusFinding[] }>;
export type Corpus = Readonly<{ prsWithFail: readonly number[]; hits: readonly CorpusHit[]; total: number }>;
export type HistoricalRevision = Readonly<{
  recordIndex: number; pr: number; failHead: string; verifiedBase: string; apiBase: string; apiBaseIsAncestor: boolean;
}>;
export type MissReason =
  | 'failed' | 'unavailable' | 'malformed' | 'contaminated' | 'unproven-head'
  | 'unproven-inspection' | 'identity-mismatch' | 'receipt-mismatch' | 'no-artifact';
export type HistoricalResult =
  | Readonly<{ kind: 'complete'; identity: HistoricalIdentity; findings: readonly Readonly<{ path: string; line: number; description: string }>[]; proof: readonly Original[] }>
  | Readonly<{ kind: 'miss'; reason: MissReason; originals: readonly Original[] }>;

const LINE_SUFFIX = /:(\d+(-\d+)?)(,\d+(-\d+)?)*$/;
const FORBIDDEN_LABEL = /\b(?:eval|test|judge|experiment|rubric|score|compare|benchmark|candidate|arena)\b/i;
const CORPUS_SHA256 = 'aa81a742b722c8ddc0ab58d2d6f528132fb7ae906ace74c58d2ebdb5777aa7bf';
const SHA_TOKEN = /\b[a-f0-9]{40}\b/;
const ROLES: readonly Role[] = ['pr verifier', 'pr reviewer'];

export function corpusPath(): string {
  return fileURLToPath(new URL('./corpus.json', import.meta.url));
}

export function historicalRevisionsPath(): string {
  return fileURLToPath(new URL('./historical-revisions.json', import.meta.url));
}

export function loadCorpus(path = corpusPath()): Corpus {
  const bytes = readFileSync(path);
  if (hash(bytes) !== CORPUS_SHA256) throw new Error('Corpus digest does not match the preserved export');
  const v = object(JSON.parse(bytes.toString('utf8')), 'corpus');
  const hits = array(v.hits).map((item): CorpusHit => {
    const h = object(item, 'corpus hit');
    return {
      pr: integer(h.pr),
      failHead: sha(h.failHead),
      findings: array(h.findings).map(finding => {
        const f = object(finding, 'corpus finding');
        const files = f.files === undefined ? undefined : array(f.files).map(file => string(file));
        const evidence = f.evidence === undefined ? undefined : string(f.evidence);
        return { kind: string(f.kind), files, evidence, disposition: f.disposition === undefined ? undefined : string(f.disposition) };
      }),
    };
  });
  if (hits.length !== 15) throw new Error('Corpus hits must remain 15 records');
  return { prsWithFail: array(v.prsWithFail).map(n => integer(n)), hits, total: integer(v.total) };
}

export function loadHistoricalRevisions(path = historicalRevisionsPath()): HistoricalRevision[] {
  const v = object(JSON.parse(readFileSync(path, 'utf8')), 'historical revisions');
  if (v.schemaVersion !== 1) throw new Error('Unknown historical revision schema');
  if (v.historicalBody !== 'unavailable') throw new Error('Historical body must remain unavailable');
  const records = array(v.records).map((item): HistoricalRevision => {
    const r = object(item, 'historical revision');
    return {
      recordIndex: integer(r.recordIndex),
      pr: integer(r.pr),
      failHead: sha(r.failHead),
      verifiedBase: sha(r.verifiedBase),
      apiBase: sha(r.apiBase),
      apiBaseIsAncestor: boolean(r.apiBaseIsAncestor),
    };
  });
  if (records.length !== 15) throw new Error('Historical revisions must cover 15 records');
  return records;
}

export function normalizeRepoPath(raw: string): string | null {
  const trimmed = raw.trim().replaceAll('\\', '/');
  if (!trimmed || trimmed.startsWith('/') || /^[A-Za-z]:\//.test(trimmed) || trimmed.includes('://')) return null;
  const withoutLine = trimmed.replace(LINE_SUFFIX, '');
  try { return relativePath(withoutLine); }
  catch { return null; }
}

export function pathsFromEvidence(evidence: string): string[] {
  const out: string[] = [];
  for (const segment of evidence.split(';')) {
    const token = segment.trim().split(/\s+/)[0];
    if (!token) continue;
    const path = normalizeRepoPath(token);
    if (path) out.push(path);
  }
  return out;
}

export function expectedPaths(hit: CorpusHit): Set<string> {
  const paths = new Set<string>();
  for (const finding of hit.findings) {
    if (finding.files !== undefined) {
      for (const file of finding.files) {
        const path = normalizeRepoPath(file);
        if (path) paths.add(path);
      }
      continue;
    }
    if (finding.evidence) for (const path of pathsFromEvidence(finding.evidence)) {
      if (path.includes('/') && !path.startsWith('evidence/')) paths.add(path);
    }
  }
  return paths;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function findingPathsFromOutput(output: unknown): { kind: 'ok'; paths: Set<string> } | { kind: 'malformed'; reason: string } {
  if (!isRecord(output)) return { kind: 'malformed', reason: 'Output is not an object' };
  if (!Array.isArray(output.findings)) return { kind: 'malformed', reason: 'Findings array is missing' };
  const paths = new Set<string>();
  for (const item of output.findings) {
    if (!isRecord(item)) return { kind: 'malformed', reason: 'Finding is not an object' };
    if (typeof item.path !== 'string') continue;
    const path = normalizeRepoPath(item.path);
    if (path) paths.add(path);
  }
  return { kind: 'ok', paths };
}

export function scoreRecord(expected: ReadonlySet<string>, actual: HistoricalResult): boolean {
  if (actual.kind !== 'complete') return false;
  return actual.findings.some(finding => expected.has(finding.path));
}

export function rejectWorkLabel(path: string): void {
  if (FORBIDDEN_LABEL.test(path)) throw new Error('Work or evidence path exposes a benchmark label');
}

export function historicalPromptFor(identity: HistoricalIdentity, opaqueId: string): string {
  const worktree = `/tmp/patient-work/${opaqueId}`;
  const artifact = `artifacts/patient-work/${opaqueId}/checkout.json`;
  const absoluteArtifact = `/opt/cursor/${artifact}`;
  return [
    `Inspect the change between ${identity.base} and ${identity.head} in ${identity.repo} for concrete defects.`,
    `The HTTP launch context is the carrier at ${identity.carrierHead}. Record its HEAD before and after; the carrier is not the subject.`,
    'Perform each operation below as its own completed, status-bearing tool call. Do not combine operations or mask a failure with a later command:',
    '1. cd /workspace && git rev-parse HEAD',
    `2. cd /workspace && git merge-base --is-ancestor ${identity.base} ${identity.head}; echo ancestor_exit_code=$?`,
    `3. cd /workspace && git worktree add --detach ${worktree} ${identity.head}`,
    `4. git -C ${worktree} rev-parse HEAD`,
    `5. git -C ${worktree} rev-parse HEAD^{tree}`,
    `6. git -C ${worktree} diff --name-only ${identity.base} HEAD`,
    `7. cd /workspace && git worktree remove ${worktree}`,
    `8. test ! -e ${worktree}`,
    '9. cd /workspace && git rev-parse HEAD',
    `10. sha256sum ${absoluteArtifact} after writing the artifact; this must be the final executable in its successful shell call.`,
    `The initial and final carrier reads must both equal ${identity.carrierHead}; the ancestry marker must be ancestor_exit_code=0; the worktree HEAD must equal ${identity.head}. Create the worktree parent in an earlier separate call if needed. If the historical object is absent, fetch only that exact head into the local object store without writing a remote ref or FETCH_HEAD, then retry the worktree add in its own call.`,
    'Between worktree add and removal, inspect nonempty source content for every file you may report as a finding with a structured read_file/read-file/read tool call using an absolute path under the worktree. If a structured read returns only a blob reference or empty content, repeat a bounded source read. A shell listing or Git diff alone is not source inspection.',
    `After removal, write the command and result evidence to ${absoluteArtifact}, then measure its real positive byte count and lowercase SHA256. Historical pull request body is unavailable. Do not retrieve old verdict comments, other agents outputs, or unrelated local source.`,
    'Do not change source, remote refs, pull requests, labels, comments, statuses, or branches. The named role must perform its own direct tool calls; do not delegate or change models.',
    `Return exactly one JSON object. For a completed inspection use kind: "complete"; otherwise use kind: "unavailable" with empty findings. Include observedHead, observedBase, observedCarrierHead as full 40-character SHAs, worktreeRemoved as a boolean, findings as an array of objects {path, line, description}, and artifacts as an array of objects {path, bytes, sha256, mediaType}. Each finding path is a repo-relative file actually read; line is a nonnegative integer. The checkout artifact has path: "${artifact}", real bytes and SHA256, and mediaType: "application/json". Do not claim completion after any required operation fails.`,
  ].join('\n');
}

export type HistoricalDispatch = Readonly<{
  role: Role;
  descriptor: string;
  parent: string;
  cwd: string;
  carrierPr: number;
  opaqueId: string;
  promptDigest: string;
  promptPath: string;
  outputPath: string;
  receiptPath: string;
  intendedAt: string;
}>;

export type HistoricalBundle = Readonly<{
  identity: HistoricalIdentity;
  dispatch: HistoricalDispatch;
  intent: Original | null;
  originalPrompt: Original | null;
  receipt: Original | null;
  originalFinalOutput: Original | null;
  originalToolStream: Original | null;
  originalRemoteRun: Original | null;
  originalArtifactListing: Original | null;
  originalCollection: Original | null;
  collectionIdentity: Readonly<{ agentId: string; runId: string }> | null;
  downloaded: readonly DownloadedArtifact[];
  now: Date;
}>;

function originalsOf(bundle: HistoricalBundle): Original[] {
  const out: Original[] = [];
  for (const item of [
    bundle.intent, bundle.originalPrompt, bundle.receipt, bundle.originalFinalOutput, bundle.originalToolStream,
    bundle.originalRemoteRun, bundle.originalArtifactListing, bundle.originalCollection,
  ]) {
    if (item) out.push(item);
  }
  for (const artifact of bundle.downloaded) out.push(artifact.original);
  return out;
}

function miss(reason: MissReason, originals: readonly Original[]): HistoricalResult {
  return { kind: 'miss', reason, originals };
}

function shellSucceeded(tool: CompletedTool): boolean {
  return (tool.name === 'run_terminal_cmd' || tool.name === 'shell')
    && tool.outcome.kind === 'success'
    && tool.outcome.exitCode === 0
    && tool.executables.length > 0;
}

function toolText(tool: CompletedTool): string {
  return JSON.stringify({ name: tool.name, args: tool.args, result: tool.result });
}

function assignments(command: string): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  for (const line of command.split('\n')) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=([A-Za-z0-9_./-]+)$/.exec(line.trim());
    if (match?.[1] && match[2]) values.set(match[1], match[2]);
  }
  return values;
}

function resolvedArg(raw: string, tool: CompletedTool): string {
  const unquoted = raw.replace(/^(["'])(.*)\1$/, '$2');
  const variable = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(unquoted);
  return variable?.[1] ? assignments(tool.command).get(variable[1]) ?? unquoted : unquoted;
}

type GitCommand = Readonly<{ cwd: string | null; args: readonly string[] }>;

type IsolatedCommand = Readonly<{ executable: ExecutableCommand; cwd: string | null }>;

function isolatedCommand(tool: CompletedTool): IsolatedCommand | null {
  if (tool.executables.length === 1) {
    const executable = tool.executables[0];
    return executable ? { executable, cwd: null } : null;
  }
  if (tool.executables.length !== 2) return null;
  const [changeDirectory, executable] = tool.executables;
  if (!changeDirectory || !executable || changeDirectory.name !== 'cd' || changeDirectory.args.length !== 1 || !changeDirectory.args[0]) return null;
  return { executable, cwd: resolve(resolvedArg(changeDirectory.args[0], tool)) };
}

function gitCommand(tool: CompletedTool, executable: ExecutableCommand): GitCommand | null {
  if (executable.name !== 'git') return null;
  const args = executable.args.map(arg => resolvedArg(arg, tool));
  if (args[0] === '-C' && args[1]) return { cwd: resolve(args[1]), args: args.slice(2) };
  const cd = tool.executables.find(item => item.name === 'cd' && item.args.length === 1);
  return { cwd: cd?.args[0] ? resolve(resolvedArg(cd.args[0], tool)) : null, args };
}

function hasGit(tool: CompletedTool, cwd: string, wanted: readonly string[]): boolean {
  if (!shellSucceeded(tool)) return false;
  const isolated = isolatedCommand(tool);
  if (!isolated) return false;
  const git = gitCommand(tool, isolated.executable);
  return git !== null && git.cwd === resolve(cwd) && wanted.length === git.args.length
    && wanted.every((arg, index) => git.args[index] === arg);
}

function stdoutOf(tool: CompletedTool): string {
  return tool.outcome.kind === 'success' ? tool.outcome.stdout ?? '' : '';
}

function exactStdout(tool: CompletedTool, expected: string): boolean {
  return stdoutOf(tool).trim() === expected;
}

function singleShaStdout(tool: CompletedTool): string | null {
  const output = stdoutOf(tool).trim();
  return new RegExp(`^${SHA_TOKEN.source}$`).test(output) ? output : null;
}

function ancestryCommandMatches(tool: CompletedTool, identity: HistoricalIdentity): boolean {
  const normalized = tool.command.replace(/\s+/g, ' ').trim();
  const operation = `cd /workspace && git merge-base --is-ancestor ${identity.base} ${identity.head}; echo `;
  return normalized === operation + 'ancestor_exit_code=$?'
    || normalized === operation + '"ancestor_exit_code=$?"'
    || normalized === operation + "'ancestor_exit_code=$?'";
}

type CheckoutProof = Readonly<{ kind: 'ok'; tree: string; worktree: string; addIndex: number; removeIndex: number }> | Readonly<{ kind: 'unproven' }>;

function proveHistoricalCheckout(tools: readonly CompletedTool[], identity: HistoricalIdentity, opaqueId: string): CheckoutProof {
  const worktree = resolve('/tmp/patient-work', opaqueId);
  const addIndex = tools.findIndex(tool => hasGit(tool, '/workspace', ['worktree', 'add', '--detach', worktree, identity.head]));
  if (addIndex < 0) return { kind: 'unproven' };
  const removeIndex = tools.findIndex((tool, index) => index > addIndex && hasGit(tool, '/workspace', ['worktree', 'remove', worktree]));
  if (removeIndex < 0) return { kind: 'unproven' };
  const before = tools.slice(0, addIndex);
  const middle = tools.slice(addIndex + 1, removeIndex);
  const after = tools.slice(removeIndex);
  const carrierBefore = before.some(tool => hasGit(tool, '/workspace', ['rev-parse', 'HEAD']) && exactStdout(tool, identity.carrierHead));
  const carrierAfter = after.some(tool => hasGit(tool, '/workspace', ['rev-parse', 'HEAD']) && exactStdout(tool, identity.carrierHead));
  const head = middle.some(tool => hasGit(tool, worktree, ['rev-parse', 'HEAD']) && exactStdout(tool, identity.head));
  const treeTool = middle.find(tool => hasGit(tool, worktree, ['rev-parse', 'HEAD^{tree}']));
  const tree = treeTool ? singleShaStdout(treeTool) : null;
  const ancestry = tools.slice(0, removeIndex).some(tool => {
    if (!shellSucceeded(tool)) return false;
    if (tool.executables.length !== 3 || tool.executables[0]?.name !== 'cd' || tool.executables[1]?.name !== 'git') return false;
    if (!ancestryCommandMatches(tool, identity)) return false;
    const operationIndex = tool.executables.findIndex(executable => {
      const git = gitCommand(tool, executable);
      return git !== null && git.cwd === resolve('/workspace')
        && git.args.join('\0') === ['merge-base', '--is-ancestor', identity.base, identity.head].join('\0');
    });
    const marker = tool.executables.at(-1);
    return operationIndex === tool.executables.length - 2 && marker?.name === 'echo'
      && marker.args.length === 1 && resolvedArg(marker.args[0] ?? '', tool) === 'ancestor_exit_code=$?'
      && exactStdout(tool, 'ancestor_exit_code=0');
  });
  const diff = middle.some(tool => shellSucceeded(tool) && (() => {
    const isolated = isolatedCommand(tool);
    if (!isolated) return false;
    const git = gitCommand(tool, isolated.executable);
    return git !== null && git.cwd === worktree && git.args[0] === 'diff' && git.args.includes('--name-only')
      && git.args.includes(identity.base) && git.args.includes('HEAD');
  })());
  const absent = after.some(tool => {
    if (!shellSucceeded(tool)) return false;
    const isolated = isolatedCommand(tool);
    return isolated?.executable.name === 'test'
      && isolated.executable.args.join('\0') === ['!', '-e', worktree].join('\0');
  });
  if (!carrierBefore || !carrierAfter || !head || !tree || tree === identity.head || !ancestry || !diff || !absent) return { kind: 'unproven' };
  return { kind: 'ok', tree, worktree, addIndex, removeIndex };
}

function contaminated(tools: readonly CompletedTool[]): boolean {
  const text = tools.map(toolText).join('\n');
  return /corpus\.json|historical-revisions|converge-proof\/catalog|<!-- converge:v1|\bexpectedPaths\b/.test(text);
}

function sourceInspectionPaths(tools: readonly CompletedTool[], proof: Extract<CheckoutProof, { kind: 'ok' }>): Set<string> {
  const inspected = new Set<string>();
  const relevant = tools.slice(proof.addIndex + 1, proof.removeIndex);
  for (const tool of relevant) {
    if (tool.outcome.kind !== 'success') continue;
    if (['read_file', 'read-file', 'read'].includes(tool.name) && isRecord(tool.args) && typeof tool.args.path === 'string') {
      const absolute = resolve(tool.args.path);
      if (absolute.startsWith(proof.worktree + sep) && (tool.outcome.content ?? '').length > 0) {
        const path = normalizeRepoPath(absolute.slice(proof.worktree.length + 1));
        if (path) inspected.add(path);
      }
    }
  }
  return inspected;
}

function artifactProvenance(tools: readonly CompletedTool[], artifact: DownloadedArtifact): boolean {
  const remotePath = resolve('/opt/cursor', artifact.path);
  return tools.some(tool => shellSucceeded(tool) && stdoutOf(tool).includes(artifact.sha256) && tool.executables.some(executable => {
    if (executable !== tool.executables.at(-1)) return false;
    const args = executable.args.map(arg => resolve(resolvedArg(arg, tool)));
    if (executable.name === 'sha256sum') return args.includes(remotePath);
    return executable.name === 'shasum' && executable.args.includes('-a') && executable.args.includes('256') && args.includes(remotePath);
  }));
}

function parseJsonFile(original: Original | null): { kind: 'ok'; value: unknown; bytes: Buffer } | { kind: 'missing' } {
  if (!original) return { kind: 'missing' };
  const bytes = verifiedOriginalBytes(original);
  if (!bytes) return { kind: 'missing' };
  try { return { kind: 'ok', value: JSON.parse(bytes.toString('utf8')), bytes }; }
  catch { return { kind: 'ok', value: bytes.toString('utf8'), bytes }; }
}

function descriptorParts(descriptor: string): { provider: string; model: string; effort: string } | null {
  const match = /^([^:]+):([^@]+)@(.+)$/.exec(descriptor);
  return match?.[1] && match[2] && match[3] ? { provider: match[1], model: match[2], effort: match[3] } : null;
}

function receiptMatches(receipt: Record<string, unknown>, dispatch: HistoricalDispatch, prompt: Original): MissReason | null {
  if (receipt.schemaVersion !== 1) return 'receipt-mismatch';
  if (receipt.status !== 'complete') return receipt.status === 'failed' || receipt.status === 'child-failed' ? 'failed' : 'unavailable';
  if (receipt.mode !== 'read-only') return 'receipt-mismatch';
  if (receipt.parent !== dispatch.parent) return 'receipt-mismatch';
  const descriptor = descriptorParts(dispatch.descriptor);
  if (!descriptor || receipt.provider !== descriptor.provider || receipt.model !== descriptor.model || receipt.effort !== descriptor.effort) return 'receipt-mismatch';
  if (resolve(string(receipt.cwd)) !== resolve(dispatch.cwd)) return 'receipt-mismatch';
  if (resolve(string(receipt.promptPath)) !== resolve(dispatch.promptPath) || resolve(string(receipt.outputPath)) !== resolve(dispatch.outputPath)) return 'receipt-mismatch';
  if (resolve(prompt.path) !== resolve(dispatch.promptPath) || prompt.sha256 !== dispatch.promptDigest || !verifiedOriginalBytes(prompt)) return 'receipt-mismatch';
  const started = Date.parse(string(receipt.startedAt));
  const completed = Date.parse(string(receipt.completedAt));
  const intended = Date.parse(dispatch.intendedAt);
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) return 'receipt-mismatch';
  if (Number.isFinite(intended) && started < intended) return 'receipt-mismatch';
  if (receipt.remote === null || !isRecord(receipt.remote)) return 'receipt-mismatch';
  const remote = object(receipt.remote, 'receipt remote');
  if (typeof remote.agentId !== 'string' || !remote.agentId || typeof remote.runId !== 'string' || !remote.runId) return 'receipt-mismatch';
  if (receipt.sessionId !== remote.agentId) return 'receipt-mismatch';
  const heads = object(remote.heads, 'receipt heads');
  if (heads.kind !== 'observed') return 'unavailable';
  if (array(heads.changedBranches).length) return 'unavailable';
  return null;
}

function intentMatches(intent: HistoricalIntent, bundle: HistoricalBundle): boolean {
  return intent.recordIndex === bundle.identity.recordIndex
    && intent.role === bundle.dispatch.role
    && intent.descriptor === bundle.dispatch.descriptor
    && intent.parent === bundle.dispatch.parent
    && intent.repo === bundle.identity.repo
    && intent.carrierPr === bundle.dispatch.carrierPr
    && intent.carrierHead === bundle.identity.carrierHead
    && intent.head === bundle.identity.head
    && intent.base === bundle.identity.base
    && intent.opaqueId === bundle.dispatch.opaqueId
    && resolve(intent.cwd) === resolve(bundle.dispatch.cwd)
    && resolve(intent.promptPath) === resolve(bundle.dispatch.promptPath)
    && resolve(intent.outputPath) === resolve(bundle.dispatch.outputPath)
    && resolve(intent.receiptPath) === resolve(bundle.dispatch.receiptPath)
    && intent.promptDigest === bundle.dispatch.promptDigest
    && intent.createdAt === bundle.dispatch.intendedAt;
}

function exactCarrier(remote: Record<string, unknown>, repo: string, carrierPr: number): boolean {
  if (!isRecord(remote.git) || !Array.isArray(remote.git.branches)) return false;
  return remote.git.branches.some(raw => {
    if (!isRecord(raw) || typeof raw.repoUrl !== 'string' || typeof raw.prUrl !== 'string') return false;
    if (!originMatches(raw.repoUrl, repo)) return false;
    try {
      const url = new URL(raw.prUrl);
      return url.hostname.toLowerCase() === 'github.com'
        && url.pathname.toLowerCase() === `/${repo.toLowerCase()}/pull/${carrierPr}`;
    } catch { return false; }
  });
}

function sameOriginal(value: unknown, expected: Original | null): boolean {
  if (expected === null) return value === null;
  if (!isRecord(value)) return false;
  return value.path === expected.path && value.sha256 === expected.sha256;
}

function collectionMatches(bundle: HistoricalBundle, agentId: string, runId: string): boolean {
  if (!bundle.originalCollection || !bundle.collectionIdentity) return false;
  if (bundle.collectionIdentity.agentId !== agentId || bundle.collectionIdentity.runId !== runId) return false;
  const parsed = parseJsonFile(bundle.originalCollection);
  if (parsed.kind === 'missing' || !isRecord(parsed.value) || parsed.value.schemaVersion !== 1) return false;
  if (parsed.value.agentId !== agentId || parsed.value.runId !== runId) return false;
  if (parsed.value.remoteStatus !== 'FINISHED') return false;
  if (!sameOriginal(parsed.value.originalRemoteRun, bundle.originalRemoteRun)
    || !sameOriginal(parsed.value.originalToolStream, bundle.originalToolStream)
    || !sameOriginal(parsed.value.originalArtifactListing, bundle.originalArtifactListing)) return false;
  if (!Array.isArray(parsed.value.downloaded) || parsed.value.downloaded.length !== bundle.downloaded.length) return false;
  return bundle.downloaded.every(artifact => parsed.value.downloaded.some(raw => isRecord(raw)
    && raw.path === artifact.path && raw.bytes === artifact.bytes && raw.sha256 === artifact.sha256
    && sameOriginal(raw.original, artifact.original)));
}

function remoteTimeMatches(remote: Record<string, unknown>, receipt: Record<string, unknown>): boolean {
  if (typeof remote.createdAt !== 'string' || typeof remote.updatedAt !== 'string'
    || typeof receipt.startedAt !== 'string' || typeof receipt.completedAt !== 'string') return false;
  const created = Date.parse(remote.createdAt);
  const updated = Date.parse(remote.updatedAt);
  const started = Date.parse(receipt.startedAt);
  const completed = Date.parse(receipt.completedAt);
  return [created, updated, started, completed].every(Number.isFinite)
    && started <= created && created <= updated && updated <= completed;
}

export function admitHistoricalAttempt(bundle: HistoricalBundle): HistoricalResult {
  const originals = originalsOf(bundle);
  if (!bundle.intent || !bundle.originalPrompt || !bundle.receipt || !bundle.originalFinalOutput || !bundle.originalToolStream
    || !bundle.originalRemoteRun || !bundle.originalArtifactListing || !bundle.originalCollection) {
    if (!bundle.receipt) return miss('failed', originals);
    return miss('unavailable', originals);
  }
  if (!verifiedOriginalBytes(bundle.intent)) return miss('unavailable', originals);
  let intent: HistoricalIntent;
  try { intent = parseIntent(bundle.intent.path); }
  catch { return miss('receipt-mismatch', originals); }
  if (!intentMatches(intent, bundle)) return miss('receipt-mismatch', originals);
  const receiptFile = parseJsonFile(bundle.receipt);
  if (receiptFile.kind === 'missing' || !isRecord(receiptFile.value)) return miss('unavailable', originals);
  const receiptProblem = receiptMatches(receiptFile.value, bundle.dispatch, bundle.originalPrompt);
  if (receiptProblem) return miss(receiptProblem, originals);
  const remoteFile = parseJsonFile(bundle.originalRemoteRun);
  if (remoteFile.kind === 'missing' || !isRecord(remoteFile.value)) return miss('unavailable', originals);
  const remote = remoteFile.value;
  const receiptRemote = object(object(receiptFile.value).remote, 'receipt remote');
  if (string(remote.status) !== 'FINISHED') return miss('unavailable', originals);
  const runId = string(receiptRemote.runId);
  const agentId = string(receiptRemote.agentId);
  if (remote.id !== runId || remote.agentId !== agentId || !collectionMatches(bundle, agentId, runId)) return miss('receipt-mismatch', originals);
  if (!remoteTimeMatches(remote, receiptFile.value)) return miss('receipt-mismatch', originals);
  if (!exactCarrier(remote, bundle.identity.repo, bundle.dispatch.carrierPr)) return miss('identity-mismatch', originals);
  const remoteResult = typeof remote.result === 'string' ? remote.result : null;
  const outputFile = parseJsonFile(bundle.originalFinalOutput);
  if (outputFile.kind === 'missing') return miss('unavailable', originals);
  if (resolve(bundle.originalFinalOutput.path) !== resolve(bundle.dispatch.outputPath)) return miss('receipt-mismatch', originals);
  if (remoteResult === null || Buffer.from(remoteResult).toString('utf8') !== outputFile.bytes.toString('utf8')) {
    return miss('receipt-mismatch', originals);
  }
  let output: unknown;
  try { output = JSON.parse(outputFile.bytes.toString('utf8')); }
  catch { return miss('malformed', originals); }
  if (!isRecord(output) || output.kind !== 'complete') return miss('malformed', originals);
  let observedHead: string, observedBase: string, observedCarrierHead: string;
  try {
    observedHead = sha(output.observedHead);
    observedBase = sha(output.observedBase);
    observedCarrierHead = sha(output.observedCarrierHead);
  } catch {
    return miss('malformed', originals);
  }
  if (observedHead !== bundle.identity.head || observedBase !== bundle.identity.base || observedCarrierHead !== bundle.identity.carrierHead) {
    return miss('identity-mismatch', originals);
  }
  if (output.worktreeRemoved !== true) return miss('unproven-head', originals);
  const toolFile = parseJsonFile(bundle.originalToolStream);
  if (toolFile.kind === 'missing') return miss('unavailable', originals);
  const stream = parseRunStream(toolFile.bytes.toString('utf8'));
  if (stream.runIds.size !== 1 || !stream.runIds.has(runId) || stream.terminalStatus !== 'FINISHED') return miss('receipt-mismatch', originals);
  const tools = stream.tools;
  if (contaminated(tools)) return miss('contaminated', originals);
  const checkout = proveHistoricalCheckout(tools, bundle.identity, bundle.dispatch.opaqueId);
  if (checkout.kind !== 'ok') return miss('unproven-head', originals);
  if (!Array.isArray(output.artifacts) || output.artifacts.length === 0) return miss('no-artifact', originals);
  const expectedArtifact = `artifacts/patient-work/${bundle.dispatch.opaqueId}/checkout.json`;
  if (!output.artifacts.some(raw => isRecord(raw) && raw.path === expectedArtifact)) return miss('no-artifact', originals);
  if (!bundle.downloaded.length) return miss('no-artifact', originals);
  if (bundle.downloaded.some(artifact => {
    const bytes = verifiedOriginalBytes(artifact.original);
    return bytes === null || bytes.length !== artifact.bytes || hash(bytes) !== artifact.sha256;
  })) return miss('no-artifact', originals);
  let listed: Set<string>;
  try { listed = listingPaths(bundle.originalArtifactListing); }
  catch { return miss('no-artifact', originals); }
  for (const raw of output.artifacts) {
    if (!isRecord(raw)) return miss('malformed', originals);
    const path = relativePath(raw.path);
    const size = integer(raw.bytes);
    const digest = string(raw.sha256);
    if (raw.mediaType !== 'application/json') return miss('no-artifact', originals);
    if (!listed.has(path)) return miss('no-artifact', originals);
    const downloaded = bundle.downloaded.find(item => item.path === path);
    if (!downloaded) return miss('no-artifact', originals);
    if (!existsSync(downloaded.original.path)) return miss('no-artifact', originals);
    const bytes = readFileSync(downloaded.original.path);
    if (hash(bytes) !== downloaded.original.sha256 || hash(bytes) !== digest || bytes.length !== size || downloaded.bytes !== size) {
      return miss('no-artifact', originals);
    }
    if (!artifactProvenance(tools, downloaded)) return miss('unproven-head', originals);
  }
  const parsed = findingPathsFromOutput(output);
  if (parsed.kind === 'malformed') return miss('malformed', originals);
  const findings = array(output.findings).flatMap(item => {
    if (!isRecord(item) || typeof item.path !== 'string') return [];
    const path = normalizeRepoPath(item.path);
    if (!path) return [];
    const line = typeof item.line === 'number' && Number.isSafeInteger(item.line) && item.line >= 0 ? item.line : 0;
    const description = typeof item.description === 'string' ? item.description : '';
    return [{ path, line, description }];
  });
  const inspected = sourceInspectionPaths(tools, checkout);
  if (findings.some(finding => !inspected.has(finding.path))) return miss('unproven-inspection', originals);
  return { kind: 'complete', identity: bundle.identity, findings, proof: originals };
}

export type JudgeServices = HistoricalHost;

type JudgeInputs = Readonly<{
  corpus?: string;
  revisions?: string;
  pool: string;
  services?: HistoricalHost;
}>;

export type JudgeRequest = JudgeInputs & (Readonly<{
  resume: string;
}> | Readonly<{
  resume?: undefined;
  repo: string;
  workRoot: string;
  evidenceRoot: string;
  roles: Readonly<Record<Role, string>>;
  carrierHead: string;
  carrierPr: number;
  parent: 'claude' | 'codex';
}>);

export type RecallSummary = Readonly<{
  records: 15;
  roles: Readonly<Record<Role, Readonly<{ hits: number; denominator: 15; misses: readonly HistoricalResult[] }>>>;
  costs: CostSummary;
  originalEvidence: readonly Original[];
  launchedAttempts: number;
  continuation: string;
}>;

export type JudgeBoundary =
  | Readonly<{ kind: 'complete'; summary: RecallSummary }>
  | Readonly<{ kind: 'blocked'; reason: string; continuation: string; summary: RecallSummary }>;

type AttemptState =
  | Readonly<{ kind: 'intent'; recordIndex: number; role: Role; directory: string; intent: Original }>
  | Readonly<{ kind: 'unknown'; recordIndex: number; role: Role; directory: string; intent: Original; reason: string; receipt?: Original }>
  | Readonly<{ kind: 'launched'; recordIndex: number; role: Role; directory: string; intent: Original; handle: { agentId: string; runId: string }; receipt: Original }>
  | Readonly<{ kind: 'scored'; recordIndex: number; role: Role; directory: string; intent: Original; result: HistoricalResult; cost: CostResult; receipt?: Original }>;

type Envelope = Readonly<{
  schemaVersion: 2;
  runId: string;
  repo: string;
  workRoot: string;
  evidenceRoot: string;
  startedAt: string;
  parent: 'claude' | 'codex';
  carrierPr: number;
  carrierHead: string;
  roles: Readonly<Record<Role, string>>;
  corpusDigest: string;
  revisionsDigest: string;
  pool: Original;
  launchedAttempts: number;
  attempts: readonly AttemptState[];
  phase: Readonly<{ kind: 'running' }> | Readonly<{ kind: 'blocked'; reason: string }> | Readonly<{ kind: 'complete' }>;
}>;

function emptyRole(): { hits: number; misses: HistoricalResult[]; costs: CostResult[] } {
  return { hits: 0, misses: [], costs: [] };
}

function sumCosts(results: readonly CostResult[]): CostResult {
  return combineCosts(results);
}

function summaryFrom(envelope: Envelope, byRole: Record<Role, { hits: number; misses: HistoricalResult[]; costs: CostResult[] }>, originals: readonly Original[]): RecallSummary {
  const historicalRoles = sumCosts([...byRole['pr verifier'].costs, ...byRole['pr reviewer'].costs]);
  return {
    records: 15,
    roles: {
      'pr verifier': { hits: byRole['pr verifier'].hits, denominator: 15, misses: byRole['pr verifier'].misses },
      'pr reviewer': { hits: byRole['pr reviewer'].hits, denominator: 15, misses: byRole['pr reviewer'].misses },
    },
    costs: {
      perFullPass: [],
      requiredLanesOneToNine: { kind: 'unavailable', reason: 'Historical scoring is not a catalog pass', originalEvidence: originals },
      allCatalogIncludingHumanUpdate: { kind: 'unavailable', reason: 'Historical scoring is not a catalog pass', originalEvidence: originals },
      historicalRoles,
      organicEvaluation: { kind: 'unavailable', reason: 'Organic evaluation is a separate parent run', originalEvidence: [] },
    },
    originalEvidence: originals,
    launchedAttempts: envelope.launchedAttempts,
    continuation: join(envelope.evidenceRoot, envelope.runId, 'run.json'),
  };
}

function tally(envelope: Envelope, corpus: Corpus): Record<Role, { hits: number; misses: HistoricalResult[]; costs: CostResult[] }> {
  const byRole: Record<Role, { hits: number; misses: HistoricalResult[]; costs: CostResult[] }> = {
    'pr verifier': emptyRole(),
    'pr reviewer': emptyRole(),
  };
  for (const attempt of envelope.attempts) {
    if (attempt.kind !== 'scored') continue;
    const hit = corpus.hits[attempt.recordIndex];
    const expected = hit ? expectedPaths(hit) : new Set<string>();
    if (scoreRecord(expected, attempt.result)) byRole[attempt.role].hits += 1;
    else byRole[attempt.role].misses.push(attempt.result);
    byRole[attempt.role].costs.push(attempt.cost);
  }
  return byRole;
}

function scoredOriginals(attempt: Extract<AttemptState, { kind: 'scored' }>): Original[] {
  const result = attempt.result.kind === 'complete' ? attempt.result.proof : attempt.result.originals;
  const cost = attempt.cost.kind === 'known'
    ? attempt.cost.sources.flatMap(source => [source.originalReceipt, source.rawResponse])
    : attempt.cost.originalEvidence;
  return [attempt.intent, ...(attempt.receipt ? [attempt.receipt] : []), ...result, ...cost];
}

function parseOriginal(value: unknown): Original {
  const v = object(value, 'original');
  return { path: string(v.path), sha256: digest(v.sha256) };
}

function parseHistoricalResult(value: unknown): HistoricalResult {
  const v = object(value, 'historical result');
  if (string(v.kind) === 'complete') {
    return {
      kind: 'complete',
      identity: {
        recordIndex: integer(object(v.identity).recordIndex),
        repo: repoName(object(v.identity).repo),
        head: sha(object(v.identity).head),
        base: sha(object(v.identity).base),
        carrierHead: sha(object(v.identity).carrierHead),
      },
      findings: array(v.findings).map(item => {
        const f = object(item, 'finding');
        return { path: relativePath(f.path), line: integer(f.line), description: string(f.description) };
      }),
      proof: array(v.proof).map(parseOriginal),
    };
  }
  return {
    kind: 'miss',
    reason: oneOf(v.reason, ['failed', 'unavailable', 'malformed', 'contaminated', 'unproven-head', 'unproven-inspection', 'identity-mismatch', 'receipt-mismatch', 'no-artifact']),
    originals: array(v.originals).map(parseOriginal),
  };
}

function parseCost(value: unknown): CostResult {
  const v = object(value, 'cost');
  if (string(v.kind) === 'unavailable') {
    return { kind: 'unavailable', reason: string(v.reason), originalEvidence: array(v.originalEvidence ?? []).map(parseOriginal) };
  }
  const sources = array(v.sources).map(parseUsageSource);
  const combined = combineCosts(sources.map(priceUsage));
  const expected = BigInt(string(v.equivalentNanoUSD));
  if (combined.kind !== 'known' || combined.equivalentNanoUSD !== expected) throw new Error('Persisted historical cost does not match its exact-run sources');
  return combined;
}

function parseUsageSource(value: unknown): Usage {
  const v = object(value, 'usage source');
  const remote = object(v.remoteRun, 'usage remote run');
  const tokens = object(v.tokens, 'usage tokens');
  const money = object(v.apiMoney, 'usage api money');
  return {
    originalReceipt: parseOriginal(v.originalReceipt),
    remoteRun: { agentId: string(remote.agentId), runId: string(remote.runId) },
    rawResponse: parseOriginal(v.rawResponse),
    requestedAt: string(v.requestedAt),
    receivedAt: string(v.receivedAt),
    model: string(v.model),
    tokens: {
      input: BigInt(string(tokens.input)), cacheRead: BigInt(string(tokens.cacheRead)),
      cacheWrite: BigInt(string(tokens.cacheWrite)), output: BigInt(string(tokens.output)),
    },
    apiMoney: { rawCostCents: string(money.rawCostCents), chargedCents: string(money.chargedCents) },
  };
}

function parseAttemptState(value: unknown): AttemptState {
  const v = object(value, 'attempt state');
  const kind = string(v.kind);
  const recordIndex = integer(v.recordIndex);
  const role = oneOf(v.role, ['pr verifier', 'pr reviewer']);
  const directory = string(v.directory);
  const intentOriginal = parseOriginal(v.intent);
  if (kind === 'intent') return { kind, recordIndex, role, directory, intent: intentOriginal };
  if (kind === 'unknown') return {
    kind, recordIndex, role, directory, intent: intentOriginal, reason: string(v.reason),
    receipt: v.receipt === undefined ? undefined : parseOriginal(v.receipt),
  };
  if (kind === 'launched') {
    const handle = object(v.handle, 'handle');
    return {
      kind, recordIndex, role, directory, intent: intentOriginal,
      handle: { agentId: string(handle.agentId), runId: string(handle.runId) },
      receipt: parseOriginal(v.receipt),
    };
  }
  if (kind !== 'scored') throw new Error('Unknown historical attempt state');
  return {
    kind: 'scored', recordIndex, role, directory, intent: intentOriginal,
    result: parseHistoricalResult(v.result),
    cost: parseCost(v.cost),
    receipt: v.receipt === undefined ? undefined : parseOriginal(v.receipt),
  };
}

function parseEnvelope(value: unknown): Envelope {
  const v = object(value, 'historical envelope');
  if (v.schemaVersion !== 2) throw new Error('Unknown historical envelope schema');
  const roles = object(v.roles, 'roles');
  const phaseValue = object(v.phase, 'phase');
  const phaseKind = string(phaseValue.kind);
  if (!['running', 'blocked', 'complete'].includes(phaseKind)) throw new Error('Unknown historical phase');
  let phase: Envelope['phase'];
  if (phaseKind === 'blocked') phase = { kind: 'blocked', reason: string(phaseValue.reason) };
  else if (phaseKind === 'complete') phase = { kind: 'complete' };
  else phase = { kind: 'running' };
  const attempts = array(v.attempts).map(parseAttemptState);
  const attemptKeys = new Set<string>();
  for (const attempt of attempts) {
    if (attempt.recordIndex < 0 || attempt.recordIndex >= 15) throw new Error('Historical attempt record is outside the fixed corpus');
    const key = `${attempt.recordIndex}:${attempt.role}`;
    if (attemptKeys.has(key)) throw new Error('Historical envelope repeats a role and record attempt');
    attemptKeys.add(key);
  }
  return {
    schemaVersion: 2,
    runId: string(v.runId),
    repo: repoName(v.repo),
    workRoot: string(v.workRoot),
    evidenceRoot: string(v.evidenceRoot),
    startedAt: string(v.startedAt),
    parent: oneOf(v.parent, ['claude', 'codex']),
    carrierPr: integer(v.carrierPr),
    carrierHead: sha(v.carrierHead),
    roles: { 'pr verifier': string(roles['pr verifier']), 'pr reviewer': string(roles['pr reviewer']) },
    corpusDigest: string(v.corpusDigest),
    revisionsDigest: string(v.revisionsDigest),
    pool: { path: string(object(v.pool).path), sha256: string(object(v.pool).sha256) },
    launchedAttempts: integer(v.launchedAttempts),
    attempts,
    phase,
  };
}

async function priceAttempt(receiptPath: string, evidenceRoot: string, now: () => Date): Promise<CostResult> {
  try {
    const usage = await recordUsage({ receiptPath, evidenceDirectory: evidenceRoot, now });
    if ('kind' in usage) return { kind: 'unavailable', reason: usage.reason, originalEvidence: [usage.evidence] };
    return priceUsage(usage);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Usage unavailable';
    const evidence = existsSync(receiptPath) ? [originalOf(receiptPath)] : [];
    return { kind: 'unavailable', reason, originalEvidence: evidence };
  }
}

type ScoreDirectoryResult =
  | Readonly<{ kind: 'scored'; result: HistoricalResult; cost: CostResult }>
  | Readonly<{ kind: 'blocked'; reason: string; originals: readonly Original[] }>;

async function scoreDirectory(input: {
  identity: HistoricalIdentity;
  dispatch: HistoricalDispatch;
  directory: string;
  receipt: Original;
  handle: Readonly<{ agentId: string; runId: string }>;
  now: Date;
  host: HistoricalHost;
}): Promise<ScoreDirectoryResult> {
  let collected;
  try { collected = await collectLaunched({ handle: input.handle, directory: input.directory, host: input.host }); }
  catch (error) {
    return {
      kind: 'blocked',
      reason: error instanceof Error ? `Remote run collection failed: ${error.message}` : 'Remote run collection failed',
      originals: [input.receipt, ...(error instanceof RemoteCollectionError ? error.originals : [])],
    };
  }
  const collectionOriginals = [input.receipt, collected.originalRemoteRun, collected.originalCollection];
  if (['CREATING', 'RUNNING'].includes(collected.remoteStatus)) {
    return { kind: 'blocked', reason: `Remote run ${input.handle.runId} is still ${collected.remoteStatus}`, originals: collectionOriginals };
  }
  if (['ERROR', 'EXPIRED', 'CANCELLED'].includes(collected.remoteStatus)) {
    return {
      kind: 'scored',
      result: miss('failed', collectionOriginals),
      cost: await priceAttempt(input.receipt.path, join(input.directory, 'usage'), () => input.now),
    };
  }
  if (collected.remoteStatus !== 'FINISHED') {
    return { kind: 'blocked', reason: `Remote run ${input.handle.runId} has unknown status ${collected.remoteStatus}`, originals: collectionOriginals };
  }
  const outputPath = join(input.directory, 'output.json');
  const intentPath = join(input.directory, 'intent.json');
  const promptPath = join(input.directory, 'prompt.txt');
  const bundle: HistoricalBundle = {
    identity: input.identity,
    dispatch: input.dispatch,
    intent: existsSync(intentPath) ? originalOf(intentPath) : null,
    originalPrompt: existsSync(promptPath) ? originalOf(promptPath) : null,
    receipt: input.receipt,
    originalFinalOutput: existsSync(outputPath) ? originalOf(outputPath) : null,
    originalToolStream: collected.originalToolStream,
    originalRemoteRun: collected.originalRemoteRun,
    originalArtifactListing: collected.originalArtifactListing,
    originalCollection: collected.originalCollection,
    collectionIdentity: { agentId: collected.agentId, runId: collected.runId },
    downloaded: collected.downloaded,
    now: input.now,
  };
  const result = admitHistoricalAttempt(bundle);
  const cost = await priceAttempt(input.receipt.path, join(input.directory, 'usage'), () => input.now);
  return { kind: 'scored', result, cost };
}

function attemptDirectory(evidenceRoot: string, runId: string, recordIndex: number, role: Role): string {
  const lane = role === 'pr verifier' ? 'verifier' : 'reviewer';
  return join(evidenceRoot, runId, 'records', String(recordIndex), lane);
}

export async function judgeCorpus(request: JudgeRequest): Promise<JudgeBoundary> {
  const host = request.services ?? {};
  const nowFn = host.now ?? (() => new Date());
  const command = host.command;
  const corpus = loadCorpus(request.corpus);
  const revisions = loadHistoricalRevisions(request.revisions);

  let envelope: Envelope;
  let runFile: string;
  if (request.resume !== undefined) {
    runFile = resolve(request.resume);
    envelope = parseEnvelope(JSON.parse(readFileSync(runFile, 'utf8')));
    if (hash(readFileSync(request.corpus ?? corpusPath())) !== envelope.corpusDigest
      || hash(readFileSync(request.revisions ?? historicalRevisionsPath())) !== envelope.revisionsDigest) {
      throw new Error('Historical resume inputs differ from the immutable corpus or revision map');
    }
    rejectWorkLabel(envelope.workRoot);
    rejectWorkLabel(envelope.evidenceRoot);
    validateCarrier({
      repo: envelope.repo, workRoot: envelope.workRoot, carrierPr: envelope.carrierPr, carrierHead: envelope.carrierHead,
    }, command);
  } else {
    rejectWorkLabel(request.workRoot);
    rejectWorkLabel(request.evidenceRoot);
    const repo = repoName(request.repo);
    const carrierHead = sha(request.carrierHead);
    const workRoot = resolve(request.workRoot);
    const evidenceRoot = resolve(request.evidenceRoot);
    if (!request.roles['pr verifier'] || !request.roles['pr reviewer']) throw new Error('Both blind roles are required');
    validateCarrier({ repo, workRoot, carrierPr: request.carrierPr, carrierHead }, command);
    const poolDecision = admitLaunch(request.pool, nowFn());
    if (poolDecision.kind === 'denied') throw new Error(poolDecision.reason);
    const runId = executionId();
    runFile = join(evidenceRoot, runId, 'run.json');
    mkdirSync(join(evidenceRoot, runId), { recursive: true, mode: 0o700 });
    envelope = {
      schemaVersion: 2,
      runId,
      repo,
      workRoot,
      evidenceRoot,
      startedAt: nowFn().toISOString(),
      parent: request.parent,
      carrierPr: request.carrierPr,
      carrierHead,
      roles: request.roles,
      corpusDigest: hash(readFileSync(request.corpus ?? corpusPath())),
      revisionsDigest: hash(readFileSync(request.revisions ?? historicalRevisionsPath())),
      pool: originalOf(request.pool),
      launchedAttempts: 0,
      attempts: [],
      phase: { kind: 'running' },
    };
    persistJson(runFile, envelope);
  }

  const release = claimRun(runFile);
  try {
    const originals: Original[] = [originalOf(request.corpus ?? corpusPath())];
    const done = new Set(envelope.attempts.filter(item => item.kind === 'scored').map(item => `${item.recordIndex}:${item.role}`));

    for (const [recordIndex, hit] of corpus.hits.entries()) {
      const revision = revisions.find(item => item.recordIndex === recordIndex && item.failHead === hit.failHead);
      if (!revision) throw new Error(`Missing historical revision for record ${recordIndex}`);
      const identity: HistoricalIdentity = {
        recordIndex, repo: envelope.repo, head: hit.failHead, base: revision.verifiedBase, carrierHead: envelope.carrierHead,
      };
      for (const role of ROLES) {
        const key = `${recordIndex}:${role}`;
        const existing = envelope.attempts.find(item => item.recordIndex === recordIndex && item.role === role);
        const directory = existing?.directory ?? attemptDirectory(envelope.evidenceRoot, envelope.runId, recordIndex, role);
        const opaqueId = opaqueAttemptId(identity, role);
        const descriptor = envelope.roles[role];
        const spec = {
          parent: envelope.parent, role, descriptor, identity, opaqueId, directory,
          carrierPr: envelope.carrierPr, cwd: envelope.workRoot, prompt: historicalPromptFor(identity, opaqueId),
        };

        if (done.has(key)) {
          if (existing?.kind !== 'scored') {
            return blockJudge(envelope, runFile, corpus, originals, 'Historical state has conflicting attempts for one role and record');
          }
          let prepared: PreparedAttempt;
          try { prepared = prepareAttempt(spec, nowFn()); }
          catch (error) {
            const reason = error instanceof Error ? error.message : 'Historical intent changed; refusing recovery';
            return blockJudge(envelope, runFile, corpus, originals, reason);
          }
          const retained = scoredOriginals(existing);
          if (existing.intent.sha256 !== prepared.intent.sha256 || retained.some(original => !verifiedOriginalBytes(original))) {
            return blockJudge(envelope, runFile, corpus, [...originals, ...retained], 'Scored historical originals changed; refusing recovery');
          }
          continue;
        }

        let intent: Original;
        let launched: Extract<AttemptState, { kind: 'launched' }> | null = null;
        if (existing?.kind === 'launched') {
          let prepared: PreparedAttempt;
          try { prepared = prepareAttempt(spec, nowFn()); }
          catch (error) {
            const reason = error instanceof Error ? error.message : 'Historical intent changed; refusing recovery';
            return blockJudge(envelope, runFile, corpus, originals, reason);
          }
          if (existing.intent.sha256 !== prepared.intent.sha256
            || !verifiedOriginalBytes(existing.intent) || !verifiedOriginalBytes(existing.receipt)) {
            return blockJudge(envelope, runFile, corpus, originals, 'Launched attempt originals changed; refusing recovery');
          }
          intent = existing.intent;
          launched = existing;
        } else if (existing?.kind === 'intent' || existing?.kind === 'unknown' || existsSync(join(directory, 'intent.json'))) {
          let prepared: PreparedAttempt;
          try { prepared = prepareAttempt(spec, nowFn()); }
          catch (error) {
            const reason = error instanceof Error ? error.message : 'Historical intent changed; refusing recovery';
            return blockJudge(envelope, runFile, corpus, originals, reason);
          }
          intent = existing?.intent ?? prepared.intent;
          if (intent.sha256 !== prepared.intent.sha256 || !verifiedOriginalBytes(intent)) {
            return blockJudge(envelope, runFile, corpus, originals, 'Historical intent changed; refusing recovery');
          }
          const recovery = recoverReceipt(prepared.receiptPath);
          if (recovery.kind === 'unknown') {
            envelope = {
              ...envelope,
              attempts: replaceAttempt(envelope.attempts, {
                kind: 'unknown', recordIndex, role, directory, intent, reason: recovery.reason,
                receipt: recovery.receipt ?? undefined,
              }),
              phase: { kind: 'blocked', reason: recovery.reason },
            };
            persistJson(runFile, envelope);
            return blockJudge(envelope, runFile, corpus, [...originals, intent, ...(recovery.receipt ? [recovery.receipt] : [])], recovery.reason);
          }
          if (recovery.kind === 'definite-no-launch') {
            envelope = persistScored(envelope, runFile, {
              kind: 'scored', recordIndex, role, directory, intent,
              result: miss('failed', [intent, recovery.receipt]),
              cost: await priceAttempt(recovery.receipt.path, join(directory, 'usage'), nowFn),
              receipt: recovery.receipt,
            });
            done.add(key);
            continue;
          }
          launched = { kind: 'launched', recordIndex, role, directory, intent, handle: recovery.handle, receipt: recovery.receipt };
          envelope = { ...envelope, attempts: replaceAttempt(envelope.attempts, launched), phase: { kind: 'running' } };
          persistJson(runFile, envelope);
        } else {
          const pool = admitLaunch(request.pool, nowFn());
          if (pool.kind === 'denied') return blockJudge(envelope, runFile, corpus, originals, pool.reason);
          const prepared = prepareAttempt(spec, nowFn());
          intent = prepared.intent;
          envelope = {
            ...envelope,
            launchedAttempts: envelope.launchedAttempts + 1,
            attempts: replaceAttempt(envelope.attempts, { kind: 'intent', recordIndex, role, directory, intent }),
          };
          persistJson(runFile, envelope);
          try { await launchPrepared(spec, prepared, host); }
          catch { /* receipt recovery below distinguishes definite preflight failure from uncertain acceptance */ }
          const recovery = recoverReceipt(prepared.receiptPath);
          if (recovery.kind === 'unknown') {
            envelope = {
              ...envelope,
              attempts: replaceAttempt(envelope.attempts, {
                kind: 'unknown', recordIndex, role, directory, intent, reason: recovery.reason,
                receipt: recovery.receipt ?? undefined,
              }),
              phase: { kind: 'blocked', reason: recovery.reason },
            };
            persistJson(runFile, envelope);
            return blockJudge(envelope, runFile, corpus, [...originals, intent, ...(recovery.receipt ? [recovery.receipt] : [])], recovery.reason);
          }
          if (recovery.kind === 'definite-no-launch') {
            envelope = persistScored(envelope, runFile, {
              kind: 'scored', recordIndex, role, directory, intent,
              result: miss('failed', [intent, recovery.receipt]),
              cost: await priceAttempt(recovery.receipt.path, join(directory, 'usage'), nowFn),
              receipt: recovery.receipt,
            });
            done.add(key);
            continue;
          }
          launched = { kind: 'launched', recordIndex, role, directory, intent, handle: recovery.handle, receipt: recovery.receipt };
          envelope = { ...envelope, attempts: replaceAttempt(envelope.attempts, launched) };
          persistJson(runFile, envelope);
        }

        if (launched === null) throw new Error('Historical attempt recovery did not produce an owned handle');
        const scored = await scoreFromHandle(identity, envelope, role, directory, launched.handle, launched.receipt, nowFn(), host);
        if (scored.kind === 'blocked') {
          return blockJudge(envelope, runFile, corpus, [...originals, ...scored.originals], scored.reason);
        }
        envelope = persistScored(envelope, runFile, {
          kind: 'scored', recordIndex, role, directory, intent: launched.intent,
          result: scored.result, cost: scored.cost, receipt: launched.receipt,
        });
        done.add(key);
      }
    }

    envelope = { ...envelope, phase: { kind: 'complete' } };
    persistJson(runFile, envelope);
    const byRole = tally(envelope, corpus);
    const extra = envelope.attempts.flatMap(item => item.kind === 'scored' ? item.result.kind === 'complete' ? item.result.proof : item.result.originals : []);
    return { kind: 'complete', summary: summaryFrom(envelope, byRole, [...originals, ...extra]) };
  } finally {
    release();
  }
}

function replaceAttempt(attempts: readonly AttemptState[], next: AttemptState): AttemptState[] {
  return [...attempts.filter(item => !(item.recordIndex === next.recordIndex && item.role === next.role)), next];
}

function persistScored(envelope: Envelope, runFile: string, scored: Extract<AttemptState, { kind: 'scored' }>): Envelope {
  const next = { ...envelope, attempts: replaceAttempt(envelope.attempts, scored) };
  persistJson(runFile, next);
  return next;
}

function blockJudge(
  envelope: Envelope,
  runFile: string,
  corpus: Corpus,
  originals: readonly Original[],
  reason: string,
): JudgeBoundary {
  const blocked: Envelope = { ...envelope, phase: { kind: 'blocked', reason } };
  persistJson(runFile, blocked);
  const byRole = tally(blocked, corpus);
  return { kind: 'blocked', reason, continuation: runFile, summary: summaryFrom(blocked, byRole, originals) };
}

async function scoreFromHandle(
  identity: HistoricalIdentity,
  envelope: Envelope,
  role: Role,
  directory: string,
  handle: Readonly<{ agentId: string; runId: string }>,
  receipt: Original,
  now: Date,
  host: HistoricalHost,
): Promise<ScoreDirectoryResult> {
  const intent = parseIntent(join(directory, 'intent.json'));
  return scoreDirectory({
    identity,
    dispatch: {
      role, descriptor: envelope.roles[role], parent: envelope.parent, cwd: envelope.workRoot,
      carrierPr: envelope.carrierPr, opaqueId: intent.opaqueId, promptDigest: intent.promptDigest,
      promptPath: intent.promptPath, outputPath: intent.outputPath, receiptPath: intent.receiptPath, intendedAt: intent.createdAt,
    },
    directory,
    receipt,
    handle,
    now,
    host,
  });
}
