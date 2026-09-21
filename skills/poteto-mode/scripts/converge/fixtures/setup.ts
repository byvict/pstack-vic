import { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
export const head = 'b'.repeat(40);
export const trunk = 'a'.repeat(40);
export const base = 'c'.repeat(40);
export function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'converge-test-'));
  const statePath = join(directory, 'state.json');
  const gh = join(directory, 'gh');
  writeFileSync(gh, readFileSync(new URL('./gh.mjs', import.meta.url))); chmodSync(gh, 0o700);
  const config = { repo: 'Example/app', trunk: 'main', requiredChecks: ['Run test suite', 'Secrets scan', 'verdict'], holdLabels: ['needs-victor'], surfaces: ['client/**', 'server/routes/**'], riskClasses: { irreversible: ['migrations/**'], contained: ['server/domain/**'] }, verifySkill: 'verify/SKILL.md', featureMap: 'features/README.md', evidenceRoot: 'evidence', deployWindow: '04:00 America/Sao_Paulo', bugbot: 'never' };
  const state = { head, trunk, base, body: '## Verification\ncheck: Run test suite\n', hold: false, autoMerge: false, trunkRed: false, failEndpoint: '', log: 'Tests completed\n',
    diff: 'diff --git a/docs/guide.md b/docs/guide.md\nindex 1111111..2222222 100644\n--- a/docs/guide.md\n+++ b/docs/guide.md\n@@ -1 +1 @@\n-old\n+new\n',
    files: [{ filename: 'docs/guide.md', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' }],
    blobs: { '.cursor/converge.json': JSON.stringify(config), 'verify/SKILL.md': 'Drive the app.', 'features/README.md': '| [Login](./login.md) | `client/Login.jsx` |\n', 'features/login.md': 'Use Entrar.', '.github/workflows/tests.yml': 'name: Tests\n', 'package.json': JSON.stringify({scripts:{test:'node tools/run-all-tests.js'}}), 'tools/run-all-tests.js': 'function printOneResult() {} function printRunnerFooter() {}' },
    checks: [{ id: 11, name: 'Run test suite', status: 'completed', conclusion: 'success', app: { id: 15368 } }, { id: 12, name: 'Secrets scan', status: 'completed', conclusion: 'success', app: { id: 15368 } }],
    protected: ['Run test suite', 'Secrets scan', 'verdict'], comments: [], statuses: [], mutations: [] };
  writeFileSync(statePath, JSON.stringify(state));
  const scriptDirectory = fileURLToPath(new URL('../', import.meta.url));
  return {
    directory, statePath, state,
    save() { writeFileSync(statePath, JSON.stringify(state)); },
    read() { return JSON.parse(readFileSync(statePath, 'utf8')); },
    calls(): string[][] { return readFileSync(statePath + '.calls', 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); },
    run(script: string, args: string[] = []) { return spawnSync(process.execPath, [resolve(scriptDirectory, script), ...args], { encoding: 'utf8', env: { ...process.env, PATH: directory + ':' + process.env.PATH, CONVERGE_FIXTURE: statePath } }); },
    cleanup() { rmSync(directory, { recursive: true, force: true }); },
  };
}
