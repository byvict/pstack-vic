import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { hash } from '../contract.ts';
export const head = 'b'.repeat(40);
export const trunk = 'a'.repeat(40);
export const base = 'c'.repeat(40);
/** Isolated from the user's git config and from an outer GIT_DIR, so a test never signs, hooks or commits into another repository. */
function git(repo: string, args: string[]): string {
  const identity = { GIT_AUTHOR_NAME: 'converge', GIT_AUTHOR_EMAIL: 'converge@example.invalid', GIT_COMMITTER_NAME: 'converge', GIT_COMMITTER_EMAIL: 'converge@example.invalid' };
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, ...identity, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined } });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}
export function commit(repo: string, message = 'change'): string {
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '--allow-empty', '-m', message]);
  return git(repo, ['rev-parse', 'HEAD']);
}
export function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'converge-test-'));
  const statePath = join(directory, 'state.json');
  const gh = join(directory, 'gh');
  writeFileSync(gh, readFileSync(new URL('./gh.mjs', import.meta.url))); chmodSync(gh, 0o700);
  const config = { repo: 'Example/app', trunk: 'main', requiredChecks: ['Run test suite', 'Secrets scan', 'verdict', 'hold'], holdLabels: ['needs-victor'], surfaces: ['client/**', 'server/routes/**'], riskClasses: { irreversible: ['migrations/**'], contained: ['server/domain/**'] }, verifySkill: 'verify/SKILL.md', featureMap: 'features/README.md', evidenceRoot: 'evidence', deployWindow: '04:00 America/Sao_Paulo', bugbot: 'never' };
  const runOverrides: Record<string, unknown> = {};
  const files: { filename: string; status: string; patch: string; previous_filename?: string }[] = [{ filename: 'docs/guide.md', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' }];
  const jobs = [
    { id: 4, name: 'Run test suite', run_id: 8, run_attempt: 1, head_sha: trunk, status: 'completed', conclusion: 'success', started_at: '2026-09-22T00:33:26Z', completed_at: '2026-09-22T00:41:50Z', check_run_url: 'https://api.github.com/repos/Example/app/check-runs/11', steps: [] },
    { id: 6, name: 'Server (gates + suite)', run_id: 8, run_attempt: 1, head_sha: head, status: 'completed', conclusion: 'success', started_at: '2026-09-22T00:33:26Z', completed_at: '2026-09-22T00:41:50Z', check_run_url: 'https://api.github.com/repos/Example/app/check-runs/6', steps: [
      { name: 'Run tests', number: 14, status: 'completed', conclusion: 'success', started_at: '2026-09-22T00:35:11Z', completed_at: '2026-09-22T00:41:31Z' },
      { name: 'Upload V8 coverage (server)', number: 15, status: 'completed', conclusion: 'success', started_at: '2026-09-22T00:41:31Z', completed_at: '2026-09-22T00:41:45Z' },
    ] },
  ];
  const state = { head, trunk, base, prBase: 'main', prState: 'open', prDraft: false, body: '## Verification\ncheck: Run test suite\n', hold: false, autoMerge: false, trunkRed: false, invalidTooling: false, requireInstallationChecks: false, failEndpoint: '', log: 'Tests completed\n',
    diff: 'diff --git a/docs/guide.md b/docs/guide.md\nindex 1111111..2222222 100644\n--- a/docs/guide.md\n+++ b/docs/guide.md\n@@ -1 +1 @@\n-old\n+new\n',
    files, jobs, runOverrides, workflowId: 5,
    blobs: { '.cursor/converge.json': JSON.stringify(config), 'verify/SKILL.md': 'Drive the app.', 'features/README.md': '| [Login](./login.md) | `client/Login.jsx` |\n', 'features/login.md': 'Use Entrar.', '.github/workflows/tests.yml': 'name: Tests\n', 'package.json': JSON.stringify({scripts:{test:'node tools/run-all-tests.js'}}), 'tools/run-all-tests.js': 'function printOneResult() {} function printRunnerFooter() {}' },
    headBlobs: {} as Record<string, string>,
    checks: [{ id: 11, name: 'Run test suite', status: 'completed', conclusion: 'success', app: { id: 15368 } }, { id: 12, name: 'Secrets scan', status: 'completed', conclusion: 'success', app: { id: 15368 } }, { id: 10, name: 'hold', status: 'completed', conclusion: 'success', app: { id: 15368 } }],
    protected: ['Run test suite', 'Secrets scan', 'verdict', 'hold'], classicProtection: true, protectionMessage: 'Branch not protected', comments: [], statuses: [], pulls: [] as Record<string, unknown>[], pushedHead: head, mutations: [] };
  writeFileSync(statePath, JSON.stringify(state));
  const scriptDirectory = fileURLToPath(new URL('../', import.meta.url));
  return {
    directory, statePath, state,
    save() { writeFileSync(statePath, JSON.stringify(state)); },
    checkout(): string {
      const repo = join(directory, 'checkout');
      mkdirSync(join(repo, 'client'), { recursive: true });
      git(repo, ['init', '-q']);
      writeFileSync(join(repo, 'client', 'Login.jsx'), 'new\n');
      state.head = state.pushedHead = commit(repo, 'head');
      writeFileSync(statePath, JSON.stringify(state));
      return repo;
    },
    read() { return JSON.parse(readFileSync(statePath, 'utf8')); },
    calls(): string[][] { return readFileSync(statePath + '.calls', 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); },
    run(script: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) { return spawnSync(process.execPath, [resolve(scriptDirectory, script), ...args], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, ...env, PATH: directory + ':' + process.env.PATH, CONVERGE_FIXTURE: statePath } }); },
    cleanup() { rmSync(directory, { recursive: true, force: true }); },
  };
}
function lane(run: string, round: Record<string, unknown>, role: 'pre-pr reviewer' | 'pre-pr certifier', steps = 0) {
  const laneId = role.replace(' ', '-');
  const root = join(run, 'lanes', laneId);
  const prefix = `artifacts/converge/${round.id}/${laneId}/`;
  mkdirSync(join(root, prefix), { recursive: true });
  const png = readFileSync(new URL('../../../../../assets/logo.png', import.meta.url));
  const action = Buffer.from('{"entry":"Entrar","result":"Dashboard"}');
  writeFileSync(join(root, prefix, 'screen.png'), png); writeFileSync(join(root, prefix, 'action.json'), action);
  const certifier = role === 'pre-pr certifier';
  const extra = Array.from({ length: steps }, (_, n) => { const bytes = Buffer.from(JSON.stringify({ step: n })); writeFileSync(join(root, prefix, `step-${n}.json`), bytes); return { id: `step-${n}`, path: prefix + `step-${n}.json`, bytes: bytes.length, sha256: hash(bytes), mediaType: 'application/json' }; });
  const artifacts = certifier ? [{ id: 'screen', path: prefix + 'screen.png', bytes: png.length, sha256: hash(png), mediaType: 'image/png' }, { id: 'action', path: prefix + 'action.json', bytes: action.length, sha256: hash(action), mediaType: 'application/json' }, ...extra] : [];
  const coverage = certifier ? [{ featureId: 'login', entryPoint: 'Entrar', result: 'driven', artifactIds: ['screen', 'action'] }] : [];
  const output = { schemaVersion: 1, round: round.id, laneId, role, observedHead: round.head, observedContract: round.contract, kind: 'complete', findings: [], artifacts, coverage, riskProofs: [] };
  const receipt = { schemaVersion: 1, parent: 'claude', provider: 'grok', model: 'grok-4.7', effort: 'xhigh', mode: 'read-only', status: 'complete', promptPath: join(root, 'prompt.txt'), outputPath: join(root, 'output.json'), startedAt: '2026-09-24T00:00:00.000Z', completedAt: '2026-09-24T00:00:02.000Z', modelVerified: true, modelEvidence: 'provider-report', reportedModel: 'grok-4.7-build', remote: null, executable: '/usr/local/bin/grok', exitCode: 0, signal: null };
  writeFileSync(join(root, 'prompt.txt'), 'read only'); writeFileSync(join(root, 'output.json'), JSON.stringify(output)); writeFileSync(join(root, 'receipt.json'), JSON.stringify(receipt));
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({ round, laneId, role, descriptor: 'grok:grok-4.7@xhigh', prompt: 'prompt.txt', promptDigest: hash('read only'), output: 'output.json', receipt: 'receipt.json', createdAt: Date.parse(receipt.startedAt) }));
}
export function certifiedPr(f: ReturnType<typeof fixture>, options: { body?: string; full?: boolean; record?: boolean; steps?: number } = {}) {
  const config = JSON.parse(f.state.blobs['.cursor/converge.json']);
  config.prePr = { runs: [{ name: 'suite', command: 'true' }], certifier: options.full === true };
  f.state.blobs['.cursor/converge.json'] = JSON.stringify(config); f.state.body = options.body ?? '## Verification\ncertificate: pre-pr\n';
  if (options.full) {
    f.state.files = [{ filename: 'client/Login.jsx', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' }];
    f.state.diff = 'diff --git a/client/Login.jsx b/client/Login.jsx\nindex 1111111..2222222 100644\n--- a/client/Login.jsx\n+++ b/client/Login.jsx\n@@ -1 +1 @@\n-old\n+new\n';
  }
  f.save();
  const checkout = f.checkout();
  const run = join(f.directory, 'run');
  if (options.record !== false) {
    const recorded = f.run('converge-certify', ['run', '--directory', run, '--name', 'suite', '--cwd', checkout, '--', 'true']);
    assert.equal(recorded.status, 0, recorded.stderr);
  }
  const local = f.run('converge-certify', ['report', '--repo', 'Example/app', '--head', f.state.head, '--directory', run]);
  assert.equal(local.status, 0, local.stderr);
  const { round, mode, lanes } = JSON.parse(local.stdout);
  assert.deepEqual([mode, lanes], options.full ? ['full', ['pre-pr reviewer', 'pre-pr certifier']] : ['ci-only', ['pre-pr reviewer']]);
  lane(run, round, 'pre-pr reviewer');
  if (options.full) lane(run, round, 'pre-pr certifier', options.steps);
  const assembled = f.run('converge-certify', ['assemble', '--directory', run, '--author-provider', 'claude', '--output', join(run, 'certificate.json'), '--adjust-rounds', '1']);
  assert.equal(assembled.status, 0, assembled.stderr);
  return run;
}
export function prReport(f: ReturnType<typeof fixture>, execution = 'pre-pr') {
  const report = join(f.directory, 'pr-report.json');
  const result = f.run('converge-reconcile', ['--repo', 'Example/app', '--pr', '1', '--output', report, '--execution', execution]);
  assert.equal(result.status, 0, result.stderr);
  return report;
}
export function publishCertificate(f: ReturnType<typeof fixture>, options: Parameters<typeof certifiedPr>[1] = {}) {
  const run = certifiedPr(f, options);
  const published = f.run('publish.ts', ['--report', prReport(f), '--certificate', join(run, 'certificate.json'), '--evidence', join(f.directory, 'evidence')]);
  assert.equal(published.status, 0, published.stderr);
}
export function moveTrunk(f: ReturnType<typeof fixture>, tip = 'd'.repeat(40)) {
  const live = f.read(); live.trunk = tip; live.jobs[0].head_sha = tip; Object.assign(f.state, live); f.save();
}
