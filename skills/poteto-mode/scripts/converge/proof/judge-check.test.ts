import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash } from '../contract.ts';
import { originalOf, type Original } from './plant.ts';
import {
  admitHistoricalAttempt, expectedPaths, findingPathsFromOutput, historicalPromptFor, judgeCorpus,
  corpusPath, historicalRevisionsPath, loadCorpus, loadHistoricalRevisions, normalizeRepoPath, pathsFromEvidence, rejectWorkLabel, scoreRecord,
  type HistoricalBundle, type HistoricalDispatch, type HistoricalIdentity, type JudgeRequest, type Role,
} from './judge-check.ts';
import type { Command } from '../github.ts';
import { opaqueAttemptId } from './historical-dispatch.ts';

const carrier = '6097ed64059953c30cb767528a9cf21205a7fbc2';
const head = 'df0bd38f529dbc47063cd4a506637e78fd337781';
const base = 'ca168b6e2119cba31a0f8fcbeac8c8b34bf4eaea';
const FIXTURES = fileURLToPath(new URL('./fixtures/historical/', import.meta.url));

function identity(): HistoricalIdentity {
  return { recordIndex: 0, repo: 'Clinextapp/clinext', head, base, carrierHead: carrier };
}

function dispatchFor(cwd: string, intendedAt = '2026-09-22T05:04:00.000Z'): HistoricalDispatch {
  const promptPath = join(cwd, 'prompt.txt');
  const outputPath = join(cwd, 'output.json');
  const receiptPath = join(cwd, 'receipt.json');
  return {
    role: 'pr verifier',
    descriptor: 'cursor:composer-2.5@high',
    parent: 'codex',
    cwd,
    carrierPr: 2890,
    opaqueId: '0941fe3b-e5cd',
    promptDigest: hash('inspect'),
    promptPath,
    outputPath,
    receiptPath,
    intendedAt,
  };
}

function writeOriginal(path: string, bytes: string | Buffer): Original {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, bytes);
  return originalOf(path, bytes);
}

function receiptText(cwd: string, promptPath: string, outputPath: string, status = 'complete'): string {
  const raw = JSON.parse(readFileSync(join(FIXTURES, 'receipt-original.json'), 'utf8'));
  raw.cwd = cwd;
  raw.promptPath = promptPath;
  raw.outputPath = outputPath;
  raw.status = status;
  raw.parent = 'codex';
  raw.model = 'composer-2.5';
  raw.effort = 'high';
  raw.mode = 'read-only';
  raw.startedAt = '2026-09-22T05:04:09.555Z';
  raw.completedAt = '2026-09-22T05:05:47.373Z';
  return JSON.stringify(raw);
}

function remoteWithResult(result: string): string {
  const raw = JSON.parse(readFileSync(join(FIXTURES, 'remote-run.json'), 'utf8'));
  raw.result = result;
  return JSON.stringify(raw);
}

function bundle(directory: string, opts: {
  outputName: string;
  tools?: string | Buffer;
  remote?: string;
  listing?: string | Buffer;
  checkout?: boolean;
  receipt?: string;
  downloaded?: boolean;
  inspected?: boolean;
}): HistoricalBundle {
  const output = readFileSync(join(FIXTURES, opts.outputName));
  const toolsValue = opts.tools === undefined
    ? JSON.parse(readFileSync(join(FIXTURES, 'tools-positive.json'), 'utf8'))
    : typeof opts.tools === 'string' || Buffer.isBuffer(opts.tools)
      ? JSON.parse(opts.tools.toString())
      : opts.tools;
  if (opts.inspected !== false && typeof toolsValue === 'object' && toolsValue !== null && 'tools' in toolsValue && Array.isArray(toolsValue.tools)) {
    const inspection = JSON.parse(readFileSync(join(FIXTURES, 'source-inspection.json'), 'utf8'));
    const remove = toolsValue.tools.findIndex((item: { callId?: string }) => item.callId === 'worktree-remove');
    toolsValue.tools.splice(remove, 0, inspection);
  }
  const tools = JSON.stringify(toolsValue);
  const listing = opts.listing ?? readFileSync(join(FIXTURES, 'artifact-list.json'));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const promptPath = join(directory, 'prompt.txt');
  const outputPath = join(directory, 'output.json');
  const receiptPath = join(directory, 'receipt.json');
  const originalPrompt = writeOriginal(promptPath, 'inspect');
  const dispatch = dispatchFor(directory);
  const intent = writeOriginal(join(directory, 'intent.json'), JSON.stringify({
    schemaVersion: 1,
    recordIndex: 0,
    role: dispatch.role,
    descriptor: dispatch.descriptor,
    parent: dispatch.parent,
    repo: 'Clinextapp/clinext',
    carrierPr: dispatch.carrierPr,
    carrierHead: carrier,
    head,
    base,
    opaqueId: dispatch.opaqueId,
    cwd: directory,
    promptPath,
    outputPath,
    receiptPath,
    promptDigest: originalPrompt.sha256,
    createdAt: dispatch.intendedAt,
  }));
  const originalFinalOutput = writeOriginal(outputPath, output);
  const receipt = writeOriginal(receiptPath, opts.receipt ?? receiptText(directory, promptPath, outputPath));
  const originalToolStream = writeOriginal(join(directory, 'tools.json'), tools);
  const originalRemoteRun = writeOriginal(join(directory, 'remote-run.json'), opts.remote ?? remoteWithResult(output.toString('utf8')));
  const originalArtifactListing = writeOriginal(join(directory, 'artifacts.json'), listing);
  const downloaded: HistoricalBundle['downloaded'][number][] = [];
  if (opts.downloaded !== false && opts.checkout !== false) {
    const checkout = readFileSync(join(FIXTURES, 'checkout.json'));
    downloaded.push({
      path: 'artifacts/patient-work/0941fe3b-e5cd/checkout.json',
      bytes: checkout.length,
      sha256: hash(checkout),
      original: writeOriginal(join(directory, 'downloads', 'checkout.json'), checkout),
    });
  }
  const originalCollection = writeOriginal(join(directory, 'collection.json'), JSON.stringify({
    schemaVersion: 1,
    agentId: 'bc-3f4221be-c5c5-40b1-93d0-857993e9412f',
    runId: 'run-84dda53d-0381-47e3-9044-102cdfafba99',
    remoteStatus: 'FINISHED',
    originalRemoteRun,
    originalToolStream,
    originalArtifactListing,
    downloaded,
  }));
  return {
    identity: identity(),
    dispatch,
    intent,
    originalPrompt,
    receipt,
    originalFinalOutput,
    originalToolStream,
    originalRemoteRun,
    originalArtifactListing,
    originalCollection,
    collectionIdentity: {
      agentId: 'bc-3f4221be-c5c5-40b1-93d0-857993e9412f',
      runId: 'run-84dda53d-0381-47e3-9044-102cdfafba99',
    },
    downloaded,
    now: new Date('2026-09-22T05:06:00.000Z'),
  };
}

function mutateRemote(
  directory: string,
  current: HistoricalBundle,
  mutate: (remote: Record<string, unknown>) => void,
): HistoricalBundle {
  assert.ok(current.originalRemoteRun);
  assert.ok(current.originalCollection);
  const remote = JSON.parse(readFileSync(current.originalRemoteRun.path, 'utf8'));
  mutate(remote);
  const originalRemoteRun = writeOriginal(join(directory, 'remote-mutated.json'), JSON.stringify(remote));
  const collection = JSON.parse(readFileSync(current.originalCollection.path, 'utf8'));
  collection.originalRemoteRun = originalRemoteRun;
  const originalCollection = writeOriginal(join(directory, 'collection-mutated.json'), JSON.stringify(collection));
  return { ...current, originalRemoteRun, originalCollection };
}

function insertBeforeRemoval(tools: Record<string, unknown>, tool: Record<string, unknown>): void {
  assert.ok(Array.isArray(tools.tools));
  const remove = tools.tools.findIndex((item: { callId?: string }) => item.callId === 'worktree-remove');
  assert.notEqual(remove, -1);
  tools.tools.splice(remove, 0, tool);
}

function shellTool(callId: string, command: string, executables: readonly Record<string, unknown>[], stdout: string): Record<string, unknown> {
  return {
    callId, name: 'run_terminal_cmd', status: 'completed',
    args: { command, parsingResult: { executableCommands: executables } },
    result: { success: { exitCode: 0, stdout } },
  };
}

function executable(name: string, args: readonly string[], fullText: string): Record<string, unknown> {
  return { name, args: args.map(value => ({ value })), fullText };
}

test('historical fixture provenance matches the committed sanitized bytes', () => {
  const provenance = JSON.parse(readFileSync(join(FIXTURES, 'provenance.json'), 'utf8'));
  for (const [name, metadata] of Object.entries(provenance.files)) {
    assert.equal(typeof metadata, 'object');
    assert.ok(metadata);
    const bytes = readFileSync(join(FIXTURES, name));
    assert.equal(hash(bytes), metadata.sha256, name);
    assert.equal(bytes.length, metadata.bytes, name);
  }
});

test('corpus remains 15 hits with prsWithFail unused as the denominator', () => {
  const corpus = loadCorpus();
  assert.equal(corpus.hits.length, 15);
  assert.equal(corpus.prsWithFail.length, 15);
  assert.equal(corpus.total, 22);
  const revisions = loadHistoricalRevisions();
  assert.equal(revisions.length, 15);
  assert.equal(revisions[1]?.apiBaseIsAncestor, false);
  assert.equal(revisions[1]?.verifiedBase, '6c7c5ea49bf16a069488c204b8cce4175448ab00');
  assert.equal(revisions[2]?.verifiedBase, '6c7c5ea49bf16a069488c204b8cce4175448ab00');
});

test('normalizes explicit files, the real line-suffix evidence shape, and rejects host artifacts', () => {
  assert.deepEqual(
    pathsFromEvidence('server/domain/InMemoryJobRunner.js:155-163,251-260; server/domain/financial/FinancialJobStore.js:156-161'),
    ['server/domain/InMemoryJobRunner.js', 'server/domain/financial/FinancialJobStore.js'],
  );
  assert.equal(normalizeRepoPath('/Users/victorbaccega/.factory/local-verifier/x.json'), null);
  assert.equal(normalizeRepoPath('../secret.env'), null);
  const corpus = loadCorpus();
  const first = expectedPaths(corpus.hits[0]);
  assert.equal(first.has('client/src/pages/pacientes/hooks/usePacientesList.js'), true);
  assert.equal(first.has('tools/tests/factory-setup.test.js'), true);
  const second = expectedPaths(corpus.hits[1]);
  assert.equal(second.has('server/domain/InMemoryJobRunner.js'), true);
  assert.equal(second.has('server/domain/financial/FinancialJobStore.js'), true);
  const duplicatePr = corpus.hits.filter(hit => hit.pr === 2830);
  assert.equal(duplicatePr.length, 2);
  assert.notEqual(duplicatePr[0]?.failHead, duplicatePr[1]?.failHead);
  for (const [recordIndex, artifactPaths] of new Map([
    [7, ['reproduction.json', '2842-comments.json']],
    [8, ['evidence/mcp-save_project_label-schema.json']],
    [9, ['evidence/reproduce.cjs', 'evidence/retry-probe.cjs']],
    [10, ['evidence/partial-cache-probe.cjs']],
  ])) {
    const expected = expectedPaths(corpus.hits[recordIndex]);
    for (const artifact of artifactPaths) assert.equal(expected.has(artifact), false);
  }
  assert.equal(expectedPaths(corpus.hits[7]).has('tools/learnings/precheck.js'), true);
});

test('scores path intersection, ignores narrative filenames, and counts malformed output as a miss', () => {
  const expected = new Set(['server/domain/InMemoryJobRunner.js', 'tools/trail/pr-events.js']);
  const hit = scoreRecord(expected, {
    kind: 'complete', identity: identity(),
    findings: [{ path: 'server/domain/InMemoryJobRunner.js', line: 155, description: 'overwrite' }],
    proof: [],
  });
  assert.equal(hit, true);
  const narrative = findingPathsFromOutput({
    kind: 'complete', findings: [{ path: null, line: 0, description: 'see server/domain/InMemoryJobRunner.js in passing' }],
  });
  assert.equal(narrative.kind, 'ok');
  if (narrative.kind === 'ok') assert.equal(narrative.paths.size, 0);
  const malformed = findingPathsFromOutput('not json');
  assert.equal(malformed.kind, 'malformed');
  assert.equal(scoreRecord(expected, { kind: 'miss', reason: 'malformed', originals: [] }), false);
});

test('rejects the actual transport final-envelope carrier mismatch and keeps originals', t => {
  const directory = mkdtempSync(join(tmpdir(), 'proof-admit-mismatch-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const rejected = admitHistoricalAttempt(bundle(directory, { outputName: 'output-mismatch.json' }));
  assert.equal(rejected.kind, 'miss');
  if (rejected.kind === 'miss') {
    assert.equal(rejected.reason, 'identity-mismatch');
    assert.equal(rejected.originals.some(item => item.path.endsWith('output.json')), true);
  }
});

test('transport-only checkout metadata cannot earn a source finding', t => {
  const directory = mkdtempSync(join(tmpdir(), 'proof-admit-ok-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const admitted = admitHistoricalAttempt(bundle(directory, { outputName: 'output-consistent.json', inspected: false }));
  assert.equal(admitted.kind, 'miss');
  if (admitted.kind === 'miss') assert.equal(admitted.reason, 'unproven-inspection');
});

test('admits a consistent envelope only after reading the finding source inside the pinned worktree', t => {
  const directory = mkdtempSync(join(tmpdir(), 'proof-admit-inspected-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const admitted = admitHistoricalAttempt(bundle(directory, { outputName: 'output-consistent.json' }));
  assert.equal(admitted.kind, 'complete');
  if (admitted.kind === 'complete') {
    assert.equal(admitted.identity.carrierHead, carrier);
    assert.equal(admitted.findings.some(item => item.path === 'client/src/pages/pacientes/hooks/usePacientesList.js'), true);
    assert.equal(admitted.proof.some(item => item.sha256 === hash(readFileSync(join(FIXTURES, 'checkout.json')))), true);
  }
});

test('a shell Git diff cannot replace a structured source read', t => {
  const directory = mkdtempSync(join(tmpdir(), 'proof-admit-full-diff-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const tools = JSON.parse(readFileSync(join(FIXTURES, 'tools-positive.json'), 'utf8'));
  const worktree = '/tmp/patient-work/0941fe3b-e5cd';
  insertBeforeRemoval(tools, shellTool(
    'source-diff',
    `git -C ${worktree} diff ${base} HEAD`,
    [executable('git', ['-C', worktree, 'diff', base, 'HEAD'], `git -C ${worktree} diff ${base} HEAD`)],
    [
      'diff --git a/client/src/pages/pacientes/hooks/usePacientesList.js b/client/src/pages/pacientes/hooks/usePacientesList.js',
      '--- a/client/src/pages/pacientes/hooks/usePacientesList.js',
      '+++ b/client/src/pages/pacientes/hooks/usePacientesList.js',
      '@@ -1 +1 @@',
      '-export function oldValue() {}',
      '+export function usePacientesList() {}',
      '',
    ].join('\n'),
  ));
  const admitted = admitHistoricalAttempt(bundle(directory, {
    outputName: 'output-consistent.json', tools: JSON.stringify(tools), inspected: false,
  }));
  assert.equal(admitted.kind, 'miss');
  if (admitted.kind === 'miss') assert.equal(admitted.reason, 'unproven-inspection');
});

test('filename, count, empty, and unrelated shell output cannot prove source inspection', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'proof-admit-superficial-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = '/tmp/patient-work/0941fe3b-e5cd/client/src/pages/pacientes/hooks/usePacientesList.js';
  const cases = [
    {
      name: 'rg-files', command: `rg --files ${source}`, stdout: source + '\n',
      executables: [executable('rg', ['--files', source], `rg --files ${source}`)],
    },
    {
      name: 'rg-list', command: `rg -l export ${source}`, stdout: source + '\n',
      executables: [executable('rg', ['-l', 'export', source], `rg -l export ${source}`)],
    },
    {
      name: 'rg-count', command: `rg -c export ${source}`, stdout: '1\n',
      executables: [executable('rg', ['-c', 'export', source], `rg -c export ${source}`)],
    },
    {
      name: 'rg-combined-list', command: `rg -il export ${source}`, stdout: source + '\n',
      executables: [executable('rg', ['-il', 'export', source], `rg -il export ${source}`)],
    },
    {
      name: 'sed-empty', command: `sed -n '0p' ${source}`, stdout: '',
      executables: [executable('sed', ['-n', '0p', source], `sed -n '0p' ${source}`)],
    },
    {
      name: 'sed-line-numbers', command: `sed -n '=' ${source}`, stdout: '1\n',
      executables: [executable('sed', ['-n', '=', source], `sed -n '=' ${source}`)],
    },
    {
      name: 'sed-delete-content', command: `sed '=;d' ${source}`, stdout: '1\n',
      executables: [executable('sed', ['=;d', source], `sed '=;d' ${source}`)],
    },
    {
      name: 'sed-unrelated-print', command: `sed -n -e '=' -e '999999p' ${source}`, stdout: '1\n',
      executables: [executable('sed', ['-n', '-e', '=', '-e', '999999p', source], `sed -n -e '=' -e '999999p' ${source}`)],
    },
    {
      name: 'rg-replaced-output', command: `rg -o --replace unrelated export ${source}`, stdout: 'unrelated\n',
      executables: [executable('rg', ['-o', '--replace', 'unrelated', 'export', source], `rg -o --replace unrelated export ${source}`)],
    },
    {
      name: 'preceding-output', command: `printf unrelated; sed -n '0p' ${source}`, stdout: 'unrelated',
      executables: [
        executable('printf', ['unrelated'], 'printf unrelated'),
        executable('sed', ['-n', '0p', source], `sed -n '0p' ${source}`),
      ],
    },
  ];
  for (const item of cases) {
    await t.test(item.name, () => {
      const tools = JSON.parse(readFileSync(join(FIXTURES, 'tools-positive.json'), 'utf8'));
      insertBeforeRemoval(tools, shellTool(item.name, item.command, item.executables, item.stdout));
      const admitted = admitHistoricalAttempt(bundle(join(directory, item.name), {
        outputName: 'output-consistent.json', tools: JSON.stringify(tools), inspected: false,
      }));
      assert.equal(admitted.kind, 'miss');
      if (admitted.kind === 'miss') assert.equal(admitted.reason, 'unproven-inspection');
    });
  }
});

test('compound or wrong-cwd commands cannot prove a historical Git head', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'proof-admit-git-shape-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  await t.test('mixed stdout cannot mask the wrong worktree head', () => {
    const tools = JSON.parse(readFileSync(join(FIXTURES, 'tools-positive.json'), 'utf8'));
    const headTool = tools.tools.find((item: { callId?: string }) => item.callId === 'worktree-head');
    headTool.args = {
      command: `printf '${head}\\n'; git -C /tmp/patient-work/0941fe3b-e5cd rev-parse HEAD`,
      parsingResult: { executableCommands: [
        executable('printf', [`${head}\\n`], `printf '${head}\\n'`),
        executable('git', ['-C', '/tmp/patient-work/0941fe3b-e5cd', 'rev-parse', 'HEAD'], 'git -C /tmp/patient-work/0941fe3b-e5cd rev-parse HEAD'),
      ] },
    };
    headTool.result = { success: { exitCode: 0, stdout: `${head}\n${'e'.repeat(40)}\n` } };
    const admitted = admitHistoricalAttempt(bundle(join(directory, 'mixed'), { outputName: 'output-consistent.json', tools: JSON.stringify(tools) }));
    assert.equal(admitted.kind, 'miss');
    if (admitted.kind === 'miss') assert.equal(admitted.reason, 'unproven-head');
  });
  await t.test('a prior unrelated cd cannot lend the expected cwd to Git', () => {
    const tools = JSON.parse(readFileSync(join(FIXTURES, 'tools-positive.json'), 'utf8'));
    const before = tools.tools.find((item: { callId?: string }) => item.callId === 'carrier-before');
    before.args = {
      command: 'cd /workspace; cd /unrelated; git rev-parse HEAD',
      parsingResult: { executableCommands: [
        executable('cd', ['/workspace'], 'cd /workspace'),
        executable('cd', ['/unrelated'], 'cd /unrelated'),
        executable('git', ['rev-parse', 'HEAD'], 'git rev-parse HEAD'),
      ] },
    };
    const admitted = admitHistoricalAttempt(bundle(join(directory, 'cwd'), { outputName: 'output-consistent.json', tools: JSON.stringify(tools) }));
    assert.equal(admitted.kind, 'miss');
    if (admitted.kind === 'miss') assert.equal(admitted.reason, 'unproven-head');
  });
});

test('accepts the provider ancestry marker with its literal quote characters', t => {
  const directory = mkdtempSync(join(tmpdir(), 'proof-admit-quoted-ancestry-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const tools = JSON.parse(readFileSync(join(FIXTURES, 'tools-positive.json'), 'utf8'));
  const ancestry = tools.tools.find((item: { callId?: string }) => item.callId === 'ancestry');
  ancestry.args.parsingResult.executableCommands.at(-1).args[0].value = '"ancestor_exit_code=$?"';
  const admitted = admitHistoricalAttempt(bundle(directory, { outputName: 'output-consistent.json', tools: JSON.stringify(tools) }));
  assert.equal(admitted.kind, 'complete');
});

test('a negated ancestry command cannot turn a failed Git check into proof', t => {
  const directory = mkdtempSync(join(tmpdir(), 'proof-admit-negated-ancestry-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const tools = JSON.parse(readFileSync(join(FIXTURES, 'tools-positive.json'), 'utf8'));
  const ancestry = tools.tools.find((item: { callId?: string }) => item.callId === 'ancestry');
  ancestry.args.command = `cd /workspace && ! git merge-base --is-ancestor ${base} ${head}; echo ancestor_exit_code=$?`;
  ancestry.result = { success: { exitCode: 0, stdout: 'ancestor_exit_code=0\n' } };
  const admitted = admitHistoricalAttempt(bundle(directory, { outputName: 'output-consistent.json', tools: JSON.stringify(tools) }));
  assert.equal(admitted.kind, 'miss');
  if (admitted.kind === 'miss') assert.equal(admitted.reason, 'unproven-head');
});

test('rejects echo-only hashes, missing artifacts, receipt/result mismatch, and nonexistent originals', t => {
  const directory = mkdtempSync(join(tmpdir(), 'proof-admit-neg-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const echo = JSON.parse(readFileSync(join(FIXTURES, 'tools-positive.json'), 'utf8'));
  for (const tool of echo.tools) {
    tool.args = {
      command: `printf '${head}\\n${base}\\n${carrier}\\nancestor_exit_code=0\\n' # git worktree add --detach /tmp/patient-work/0941fe3b-e5cd ${head}; git worktree remove /tmp/patient-work/0941fe3b-e5cd`,
      parsingResult: { executableCommands: [{ name: 'printf', args: [{ value: `${head}\\n${base}\\n${carrier}\\nancestor_exit_code=0\\n` }], fullText: 'printf' }] },
    };
    tool.result = { success: { exitCode: 0, stdout: `${head}\n${base}\n${carrier}\nancestor_exit_code=0\n` } };
  }
  const echoed = admitHistoricalAttempt(bundle(join(directory, 'echo'), { outputName: 'output-consistent.json', tools: JSON.stringify(echo) }));
  assert.equal(echoed.kind, 'miss');
  if (echoed.kind === 'miss') assert.equal(echoed.reason, 'unproven-head');

  const none = admitHistoricalAttempt(bundle(join(directory, 'none'), { outputName: 'output-consistent.json', downloaded: false }));
  assert.equal(none.kind, 'miss');
  if (none.kind === 'miss') assert.equal(none.reason, 'no-artifact');

  const output = readFileSync(join(FIXTURES, 'output-consistent.json'), 'utf8');
  const mismatch = admitHistoricalAttempt(bundle(join(directory, 'bytes'), {
    outputName: 'output-consistent.json',
    remote: remoteWithResult(output.replace('6097ed64059953c30cb767528a9cf21205a7fbc2', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')),
  }));
  assert.equal(mismatch.kind, 'miss');
  if (mismatch.kind === 'miss') assert.equal(mismatch.reason, 'receipt-mismatch');

  const missing = admitHistoricalAttempt({
    identity: identity(),
    dispatch: dispatchFor(directory),
    intent: null,
    originalPrompt: null,
    receipt: { path: join(directory, 'never-created.json'), sha256: '0'.repeat(64) },
    originalFinalOutput: { path: join(directory, 'never-created.json'), sha256: '0'.repeat(64) },
    originalToolStream: { path: join(directory, 'never-created.json'), sha256: '0'.repeat(64) },
    originalRemoteRun: { path: join(directory, 'never-created.json'), sha256: '0'.repeat(64) },
    originalArtifactListing: { path: join(directory, 'never-created.json'), sha256: '0'.repeat(64) },
    originalCollection: null,
    collectionIdentity: null,
    downloaded: [],
    now: new Date('2026-09-22T05:06:00.000Z'),
  });
  assert.equal(missing.kind, 'miss');
});

test('contaminated tool traces that retrieve parent answer material are misses', t => {
  const directory = mkdtempSync(join(tmpdir(), 'proof-admit-contam-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const tools = JSON.parse(readFileSync(join(FIXTURES, 'tools-positive.json'), 'utf8'));
  tools.tools.push({
    callId: 'leak', name: 'read_file', status: 'completed',
    args: { path: '/private/answers/proof/corpus.json' },
    result: { success: { content: '{"hits":[]}' } },
  });
  const rejected = admitHistoricalAttempt(bundle(directory, { outputName: 'output-consistent.json', tools: JSON.stringify(tools) }));
  assert.equal(rejected.kind, 'miss');
  if (rejected.kind === 'miss') assert.equal(rejected.reason, 'contaminated');
});

test('exit-42 command results cannot prove a checkout even when every command string is correct', t => {
  const directory = mkdtempSync(join(tmpdir(), 'proof-admit-failed-cmd-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const tools = JSON.parse(readFileSync(join(FIXTURES, 'tools-positive.json'), 'utf8'));
  for (const tool of tools.tools) tool.result = { success: { exitCode: 42, stdout: 'failed\n' } };
  const rejected = admitHistoricalAttempt(bundle(directory, { outputName: 'output-consistent.json', tools: JSON.stringify(tools) }));
  assert.equal(rejected.kind, 'miss');
  if (rejected.kind === 'miss') assert.equal(rejected.reason, 'unproven-head');
});

test('wrong tool and listing digests and post-capture byte mutations never contribute evidence', t => {
  const directory = mkdtempSync(join(tmpdir(), 'proof-admit-originals-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const wrongTool = bundle(join(directory, 'tool-digest'), { outputName: 'output-consistent.json' });
  assert.ok(wrongTool.originalToolStream);
  assert.equal(admitHistoricalAttempt({
    ...wrongTool,
    originalToolStream: { ...wrongTool.originalToolStream, sha256: '0'.repeat(64) },
  }).kind, 'miss');

  const wrongListing = bundle(join(directory, 'listing-digest'), { outputName: 'output-consistent.json' });
  assert.ok(wrongListing.originalArtifactListing);
  assert.equal(admitHistoricalAttempt({
    ...wrongListing,
    originalArtifactListing: { ...wrongListing.originalArtifactListing, sha256: '0'.repeat(64) },
  }).kind, 'miss');

  const changed = bundle(join(directory, 'changed-bytes'), { outputName: 'output-consistent.json' });
  assert.ok(changed.originalToolStream);
  writeFileSync(changed.originalToolStream.path, '\n', { flag: 'a' });
  const rejected = admitHistoricalAttempt(changed);
  assert.equal(rejected.kind, 'miss');
  if (rejected.kind === 'miss') assert.equal(rejected.reason, 'unavailable');
});

test('binds intent, route, repository, remote agent and run to the exact attempt', t => {
  const directory = mkdtempSync(join(tmpdir(), 'proof-admit-bindings-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const routed = bundle(join(directory, 'route'), { outputName: 'output-consistent.json' });
  assert.ok(routed.receipt);
  const receipt = JSON.parse(readFileSync(routed.receipt.path, 'utf8'));
  receipt.provider = 'claude';
  receipt.effort = 'low';
  receipt.promptPath = join(directory, 'unrelated-prompt.txt');
  const routedResult = admitHistoricalAttempt({ ...routed, receipt: writeOriginal(join(directory, 'route', 'receipt-mutated.json'), JSON.stringify(receipt)) });
  assert.equal(routedResult.kind, 'miss');
  if (routedResult.kind === 'miss') assert.equal(routedResult.reason, 'receipt-mismatch');

  const intended = bundle(join(directory, 'intent'), { outputName: 'output-consistent.json' });
  assert.ok(intended.intent);
  const intent = JSON.parse(readFileSync(intended.intent.path, 'utf8'));
  intent.role = 'pr reviewer';
  const intentResult = admitHistoricalAttempt({ ...intended, intent: writeOriginal(join(directory, 'intent', 'intent-mutated.json'), JSON.stringify(intent)) });
  assert.equal(intentResult.kind, 'miss');
  if (intentResult.kind === 'miss') assert.equal(intentResult.reason, 'receipt-mismatch');

  const wrongRepoBase = bundle(join(directory, 'repo'), { outputName: 'output-consistent.json' });
  const wrongRepo = mutateRemote(join(directory, 'repo'), wrongRepoBase, remote => {
    remote.git = { branches: [{ repoUrl: 'https://github.com/unrelated/repo.git', prUrl: 'https://github.com/unrelated/repo/pull/2890' }] };
  });
  const repoResult = admitHistoricalAttempt(wrongRepo);
  assert.equal(repoResult.kind, 'miss');
  if (repoResult.kind === 'miss') assert.equal(repoResult.reason, 'identity-mismatch');

  const wrongRunBase = bundle(join(directory, 'run'), { outputName: 'output-consistent.json' });
  const wrongRun = mutateRemote(join(directory, 'run'), wrongRunBase, remote => { remote.id = 'other-run'; });
  const runResult = admitHistoricalAttempt(wrongRun);
  assert.equal(runResult.kind, 'miss');
  if (runResult.kind === 'miss') assert.equal(runResult.reason, 'receipt-mismatch');

  const absentBase = bundle(join(directory, 'absent'), { outputName: 'output-consistent.json' });
  assert.ok(absentBase.receipt);
  const absent = JSON.parse(readFileSync(absentBase.receipt.path, 'utf8'));
  delete absent.remote.agentId;
  delete absent.remote.runId;
  const absentResult = admitHistoricalAttempt({ ...absentBase, receipt: writeOriginal(join(directory, 'absent', 'receipt-mutated.json'), JSON.stringify(absent)) });
  assert.equal(absentResult.kind, 'miss');
  if (absentResult.kind === 'miss') assert.equal(absentResult.reason, 'receipt-mismatch');
});

function fakeCarrierCommand(workHead: string, repo: string): Command {
  return (binary, args) => {
    if (binary === 'git' && args.includes('rev-parse') && args.includes('HEAD')) return workHead + '\n';
    if (binary === 'git' && args.includes('get-url')) return `https://github.com/${repo}.git\n`;
    if (binary === 'gh') {
      return JSON.stringify({
        number: 2890, state: 'OPEN', isDraft: false, headRefOid: workHead,
        headRefName: 'converge-proof/session-test', labels: [{ name: 'needs-victor' }],
      });
    }
    throw new Error(`${binary} ${args.join(' ')}`);
  };
}

function writeFailedReceipt(receiptPath: string, outputPath: string): never {
  writeFileSync(receiptPath, JSON.stringify({
    schemaVersion: 1, parent: 'codex', provider: 'cursor', model: 'composer-2.5', effort: 'high',
    mode: 'read-only', cwd: dirname(receiptPath), promptPath: join(dirname(receiptPath), 'prompt.txt'),
    outputPath, status: 'unavailable-cli', startedAt: '2026-09-22T05:04:09.555Z',
    completedAt: '2026-09-22T05:04:10.000Z', remote: null, usage: null, costUsd: null,
  }));
  throw new Error('unavailable-cli');
}

function writePartialReceipt(receiptPath: string): never {
  writeFileSync(receiptPath, JSON.stringify({ status: 'failed', remote: { agentId: 'accepted-agent', runId: null } }));
  throw new Error('runner transport ended after remote acceptance');
}

test('judgeCorpus default path scores 15-per-role without aborting failed launches or exposing corpus to the prompt', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'clinic-ops-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const pool = join(directory, 'pool.json');
  writeFileSync(pool, JSON.stringify({
    at: '2026-09-22T04:50:02.703Z', cursorModelsUsedPercent: 2, otherModelsUsedPercent: 2,
    grokBotWeeklyUsedPercent: 1, onDemandUsedUSD: 0, stopThresholdPercent: 80,
  }));
  let prompts = 0;
  const boundary = await judgeCorpus({
    repo: 'Clinextapp/clinext', workRoot: join(directory, 'patient-work'), evidenceRoot: join(directory, 'records'),
    roles: { 'pr verifier': 'cursor:composer-2.5@high', 'pr reviewer': 'cursor:grok-4.7@high' },
    pool, carrierHead: carrier, carrierPr: 2890, parent: 'codex',
    services: {
      now: () => new Date('2026-09-22T04:51:00.000Z'),
      command: fakeCarrierCommand(carrier, 'Clinextapp/clinext'),
      async runLane(options) {
        prompts += 1;
        const prompt = readFileSync(options.promptPath, 'utf8');
        assert.equal(prompt.includes('corpus'), false);
        assert.equal(/\b(?:eval|benchmark)\b/i.test(prompt), false);
        writeFailedReceipt(options.receiptPath, options.outputPath);
      },
    },
  });
  assert.equal(boundary.kind, 'complete');
  if (boundary.kind === 'complete') {
    assert.equal(prompts, 30);
    assert.equal(boundary.summary.records, 15);
    assert.equal(boundary.summary.launchedAttempts, 30);
    assert.equal(boundary.summary.roles['pr verifier'].denominator, 15);
    assert.equal(boundary.summary.roles['pr reviewer'].denominator, 15);
    assert.equal(boundary.summary.roles['pr verifier'].hits, 0);
    assert.equal(boundary.summary.roles['pr reviewer'].hits, 0);
    assert.equal(boundary.summary.roles['pr verifier'].misses.length, 15);
  }
});

test('an ambiguous accepted launch blocks recovery and is never launched twice', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'clinic-ops-unknown-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const pool = join(directory, 'pool.json');
  writeFileSync(pool, JSON.stringify({
    at: '2026-09-22T04:50:02.703Z', cursorModelsUsedPercent: 2, otherModelsUsedPercent: 2,
    grokBotWeeklyUsedPercent: 1, onDemandUsedUSD: 0, stopThresholdPercent: 80,
  }));
  let launches = 0;
  const request: JudgeRequest = {
    repo: 'Clinextapp/clinext', workRoot: join(directory, 'patient-work'), evidenceRoot: join(directory, 'records'),
    roles: { 'pr verifier': 'cursor:composer-2.5@high', 'pr reviewer': 'cursor:grok-4.7@high' },
    pool, carrierHead: carrier, carrierPr: 2890, parent: 'codex',
    services: {
      now: () => new Date('2026-09-22T04:51:00.000Z'),
      command: fakeCarrierCommand(carrier, 'Clinextapp/clinext'),
      async runLane(options) {
        launches += 1;
        writePartialReceipt(options.receiptPath);
      },
    },
  };
  const first = await judgeCorpus(request);
  assert.equal(first.kind, 'blocked');
  if (first.kind !== 'blocked') return;
  assert.match(first.reason, /incomplete remote identity/);
  assert.equal(first.summary.launchedAttempts, 1);
  assert.equal(first.summary.roles['pr verifier'].denominator, 15);
  const saved = JSON.parse(readFileSync(first.continuation, 'utf8'));
  assert.equal(saved.attempts[0]?.kind, 'unknown');
  assert.equal(saved.attempts[0]?.receipt?.path.includes('receipt-originals'), true);

  const resumed = await judgeCorpus({ ...request, resume: first.continuation });
  assert.equal(resumed.kind, 'blocked');
  assert.equal(launches, 1);
});

test('a running exact remote handle remains drain-owned and blocks any later launch', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'clinic-ops-running-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const pool = join(directory, 'pool.json');
  writeFileSync(pool, JSON.stringify({
    at: '2026-09-22T04:50:02.703Z', cursorModelsUsedPercent: 2, otherModelsUsedPercent: 2,
    grokBotWeeklyUsedPercent: 1, onDemandUsedUSD: 0, stopThresholdPercent: 80,
  }));
  let launches = 0;
  let collections = 0;
  const request: JudgeRequest = {
    repo: 'Clinextapp/clinext', workRoot: join(directory, 'patient-work'), evidenceRoot: join(directory, 'records'),
    roles: { 'pr verifier': 'cursor:composer-2.5@high', 'pr reviewer': 'cursor:grok-4.7@high' },
    pool, carrierHead: carrier, carrierPr: 2890, parent: 'codex',
    services: {
      now: () => new Date('2026-09-22T04:51:00.000Z'),
      command: fakeCarrierCommand(carrier, 'Clinextapp/clinext'),
      endpoint: { baseUrl: 'https://api.cursor.com', apiKey: 'key', loopback: false },
      async runLane(options) {
        launches += 1;
        writeFileSync(options.receiptPath, JSON.stringify({ status: 'complete', remote: { agentId: 'agent-one', runId: 'run-one' } }));
        throw new Error('caller lost the runner result after receipt persistence');
      },
      async fetch() {
        collections += 1;
        return new Response(JSON.stringify({ id: 'run-one', agentId: 'agent-one', status: 'RUNNING', git: { branches: [] } }));
      },
    },
  };
  const first = await judgeCorpus(request);
  assert.equal(first.kind, 'blocked');
  if (first.kind !== 'blocked') return;
  assert.match(first.reason, /still RUNNING/);
  const resumed = await judgeCorpus({ ...request, resume: first.continuation });
  assert.equal(resumed.kind, 'blocked');
  assert.equal(launches, 1);
  assert.equal(collections, 2);
});

test('resume preserves exact-run cost sources and deduplicates only identical remote runs', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'clinic-ops-cost-resume-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const pool = join(directory, 'pool.json');
  writeFileSync(pool, JSON.stringify({
    at: '2026-09-22T04:50:02.703Z', cursorModelsUsedPercent: 2, otherModelsUsedPercent: 2,
    grokBotWeeklyUsedPercent: 1, onDemandUsedUSD: 0, stopThresholdPercent: 80,
  }));
  const evidenceRoot = join(directory, 'records');
  const runId = 'historical-resume';
  const runDirectory = join(evidenceRoot, runId);
  mkdirSync(runDirectory, { recursive: true });
  const evidence = originalOf(pool);
  const usage = (remoteRun: string) => ({
    originalReceipt: evidence,
    remoteRun: { agentId: 'agent-exact', runId: remoteRun },
    rawResponse: evidence,
    requestedAt: '2026-09-22T04:51:00.000Z',
    receivedAt: '2026-09-22T04:51:01.000Z',
    model: 'composer-2.5',
    tokens: { input: '1', cacheRead: '0', cacheWrite: '0', output: '0' },
    apiMoney: { rawCostCents: '0', chargedCents: '0' },
  });
  const scoredRoles: Role[] = ['pr verifier', 'pr reviewer'];
  const attempts: unknown[] = [];
  const corpus = loadCorpus();
  const revisions = loadHistoricalRevisions();
  for (const [recordIndex, hit] of corpus.hits.entries()) {
    const revision = revisions.find(item => item.recordIndex === recordIndex && item.failHead === hit.failHead);
    assert.ok(revision);
    const historicalIdentity = {
      recordIndex, repo: 'Clinextapp/clinext', head: hit.failHead, base: revision.verifiedBase, carrierHead: carrier,
    };
    for (const role of scoredRoles) {
      const attemptDirectory = join(runDirectory, 'records', String(recordIndex), role === 'pr verifier' ? 'verifier' : 'reviewer');
      const promptPath = join(attemptDirectory, 'prompt.txt');
      const outputPath = join(attemptDirectory, 'output.json');
      const receiptPath = join(attemptDirectory, 'receipt.json');
      const opaqueId = opaqueAttemptId(historicalIdentity, role);
      const prompt = writeOriginal(promptPath, historicalPromptFor(historicalIdentity, opaqueId));
      const intent = writeOriginal(join(attemptDirectory, 'intent.json'), JSON.stringify({
        schemaVersion: 1, recordIndex, role, descriptor: 'cursor:composer-2.5@high', parent: 'codex',
        repo: 'Clinextapp/clinext', carrierPr: 2890, carrierHead: carrier, head: hit.failHead,
        base: revision.verifiedBase, opaqueId, cwd: join(directory, 'patient-work'), promptPath, outputPath,
        receiptPath, promptDigest: prompt.sha256, createdAt: '2026-09-22T04:51:00.000Z',
      }));
      attempts.push({
        kind: 'scored', recordIndex, role, directory: attemptDirectory, intent,
        result: { kind: 'miss', reason: 'failed', originals: [] },
        cost: { kind: 'known', equivalentNanoUSD: '500', sources: [usage(role === 'pr verifier' ? 'same-run' : 'distinct-run')] },
      });
    }
  }
  const runFile = join(runDirectory, 'run.json');
  writeFileSync(runFile, JSON.stringify({
    schemaVersion: 2, runId, repo: 'Clinextapp/clinext', workRoot: join(directory, 'patient-work'), evidenceRoot,
    startedAt: '2026-09-22T04:51:00.000Z', parent: 'codex', carrierPr: 2890, carrierHead: carrier,
    roles: { 'pr verifier': 'cursor:composer-2.5@high', 'pr reviewer': 'cursor:composer-2.5@high' },
    corpusDigest: hash(readFileSync(corpusPath())), revisionsDigest: hash(readFileSync(historicalRevisionsPath())),
    pool: evidence, launchedAttempts: 30, attempts, phase: { kind: 'complete' },
  }));
  const resumed = await judgeCorpus({
    resume: runFile, repo: 'ignored/repo', workRoot: directory, evidenceRoot: directory,
    roles: { 'pr verifier': 'ignored', 'pr reviewer': 'ignored' }, pool,
    carrierHead: '0'.repeat(40), carrierPr: 1, parent: 'codex',
    services: { command: fakeCarrierCommand(carrier, 'Clinextapp/clinext') },
  });
  assert.equal(resumed.kind, 'complete');
  if (resumed.kind === 'complete') {
    const cost = resumed.summary.costs.historicalRoles;
    assert.equal(cost.kind, 'known');
    if (cost.kind === 'known') {
      assert.equal(cost.equivalentNanoUSD, 1_000n);
      assert.deepEqual(cost.sources.map(source => source.remoteRun.runId), ['same-run', 'distinct-run']);
    }
  }
  const persisted = JSON.parse(readFileSync(runFile, 'utf8'));
  const firstIntent = JSON.parse(readFileSync(persisted.attempts[0].intent.path, 'utf8'));
  writeFileSync(firstIntent.promptPath, 'changed after scoring');
  const changed = await judgeCorpus({
    resume: runFile, pool, services: { command: fakeCarrierCommand(carrier, 'Clinextapp/clinext') },
  });
  assert.equal(changed.kind, 'blocked');
  if (changed.kind === 'blocked') assert.match(changed.reason, /prompt changed/);
});

test('pool expiry before a later launch stops without resetting the 15-record denominator', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'clinic-ops-pool-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const pool = join(directory, 'pool.json');
  writeFileSync(pool, JSON.stringify({
    at: '2026-09-22T04:50:02.703Z', cursorModelsUsedPercent: 2, otherModelsUsedPercent: 2,
    grokBotWeeklyUsedPercent: 1, onDemandUsedUSD: 0, stopThresholdPercent: 80,
  }));
  let launches = 0;
  let nowMs = Date.parse('2026-09-22T04:51:00.000Z');
  const boundary = await judgeCorpus({
    repo: 'Clinextapp/clinext', workRoot: join(directory, 'patient-work'), evidenceRoot: join(directory, 'records'),
    roles: { 'pr verifier': 'cursor:composer-2.5@high', 'pr reviewer': 'cursor:grok-4.7@high' },
    pool, carrierHead: carrier, carrierPr: 2890, parent: 'codex',
    services: {
      now: () => new Date(nowMs),
      command: fakeCarrierCommand(carrier, 'Clinextapp/clinext'),
      async runLane(options) {
        launches += 1;
        nowMs = Date.parse('2026-09-22T05:21:00.000Z');
        writeFailedReceipt(options.receiptPath, options.outputPath);
      },
    },
  });
  assert.equal(boundary.kind, 'blocked');
  if (boundary.kind === 'blocked') {
    assert.equal(launches, 1);
    assert.equal(boundary.summary.records, 15);
    assert.equal(boundary.summary.launchedAttempts, 1);
    assert.equal(boundary.summary.roles['pr verifier'].denominator, 15);
  }
});

test('work roots that look like benchmarks are refused', () => {
  assert.throws(() => rejectWorkLabel('/tmp/eval-work/u3'), /benchmark label/);
  rejectWorkLabel('/tmp/patient-work/u3');
});

test('historical prompt stays organic', () => {
  const prompt = historicalPromptFor(identity(), '0941fe3b-e5cd');
  assert.equal(prompt.includes('corpus'), false);
  assert.equal(/\b(?:eval|benchmark|judge)\b/i.test(prompt), false);
  assert.match(prompt, /structured read_file\/read-file\/read tool call/i);
  assert.match(prompt, /every file you may report as a finding/i);
  assert.ok(prompt.includes(`git merge-base --is-ancestor ${base} ${head}; echo ancestor_exit_code=$?`));
  assert.ok(prompt.includes(`git -C /tmp/patient-work/0941fe3b-e5cd diff --name-only ${base} HEAD`));
  assert.ok(prompt.includes('git -C /tmp/patient-work/0941fe3b-e5cd rev-parse HEAD^{tree}'));
  assert.ok(prompt.includes('test ! -e /tmp/patient-work/0941fe3b-e5cd'));
  assert.ok(prompt.includes('sha256sum /opt/cursor/artifacts/patient-work/0941fe3b-e5cd/checkout.json'));
  assert.ok(prompt.includes('kind: "complete"'));
  assert.ok(prompt.includes('findings as an array of objects {path, line, description}'));
  assert.ok(prompt.includes('artifacts as an array of objects {path, bytes, sha256, mediaType}'));
  assert.ok(prompt.includes('mediaType: "application/json"'));
});
