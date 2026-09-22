import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { analyze } from '../reconcile.ts';
import { hash } from '../contract.ts';
import type { Snapshot } from '../github.ts';
import {
  applyEdits, catalogPath, closeOwnedCase, expectedDisplay, loadCatalog, organicCatalogPrompt,
  organicInspectPrompt, originalOf, plantCase, type CatalogCase, type Command,
} from './plant.ts';

const head = 'b'.repeat(40);
const trunk = 'a'.repeat(40);
const secret = 'ghp_1234567890abcdefghijklmnopqrstuvwxyz';
const contract = {
  repo: 'Clinextapp/clinext', trunk: 'main',
  requiredChecks: ['Run test suite', 'Secrets scan', 'verdict'], holdLabels: ['needs-victor'],
  surfaces: ['client/**', 'server/routes/**'],
  riskClasses: { irreversible: ['server/engine/connectors/**'], contained: ['server/engine/**', 'server/domain/**'] },
  verifySkill: '.cursor/skills/verify-clinext/SKILL.md',
  featureMap: '.cursor/skills/verify-clinext/features/README.md',
  evidenceRoot: '.cursor/skills/verify-clinext/evidence',
  deployWindow: '04:00 America/Sao_Paulo', bugbot: 'never' as const,
};

function tree() {
  const directory = mkdtempSync(join(tmpdir(), 'proof-plant-'));
  return { directory, cleanup() { rmSync(directory, { recursive: true, force: true }); } };
}

function seed(root: string, entry: CatalogCase) {
  for (const edit of entry.natural.edits) {
    if (edit.before === '') continue;
    const full = join(root, edit.path);
    mkdirSync(dirname(full), { recursive: true });
    const existing = readFileSync(full, { encoding: 'utf8', flag: 'a+' });
    writeFileSync(full, existing ? `${existing}\n${edit.before}\n` : `prefix\n${edit.before}\nsuffix\n`);
  }
}

function patch(path: string, before: string, after: string) {
  if (before === '') {
    const lines = after.split('\n');
    return { path, previous: null, status: 'added', patch: `@@ -0,0 +1,${Math.max(lines.length, 1)} @@\n` + lines.map(line => '+' + line).join('\n') };
  }
  const oldLines = before.split('\n');
  const newLines = after.split('\n');
  return {
    path, previous: null, status: 'modified',
    patch: `@@ -1,${oldLines.length} +1,${newLines.length} @@\n` + oldLines.map(line => '-' + line).join('\n') + '\n' + newLines.map(line => '+' + line).join('\n'),
  };
}

function snapshotFor(entry: CatalogCase, extra: Partial<Snapshot> = {}): Snapshot {
  const files = extra.files ?? entry.natural.edits.map(edit => patch(edit.path, edit.before, edit.after));
  const login = files.some(file => file.path === 'client/src/pages/LoginPage.jsx');
  const dash = files.some(file => file.path === 'client/src/pages/DashboardPage.jsx');
  const features = [
    ...(login ? [{ id: 'login', page: 'client/src/pages/LoginPage.jsx', recipe: '.cursor/skills/verify-clinext/features/login.md', recipeDigest: '0'.repeat(64) }] : []),
    ...(dash ? [{ id: 'dashboard', page: 'client/src/pages/DashboardPage.jsx', recipe: '.cursor/skills/verify-clinext/features/dashboard.md', recipeDigest: '0'.repeat(64) }] : []),
  ];
  return {
    trusted: { repo: 'Clinextapp/clinext', sha: trunk, config: contract, files: new Map(), workflowId: 1, workflowPath: '.github/workflows/tests.yml' },
    pull: {
      number: 1, head, base: 'main', branch: `converge-proof/${entry.privateId}`, state: 'open', draft: false,
      body: extra.pull?.body ?? entry.natural.body, labels: ['needs-victor'], authorId: 1, authorLogin: 'human', authorType: 'User', autoMerge: false,
    },
    base: trunk, patchId: 'd'.repeat(40), diff: '', files, features,
    checks: [{ context: 'Run test suite', id: 1, head, appId: 15368, state: 'success', runId: 8, attempt: 1 }],
    sources: [{ source: 'body', id: 'body', text: extra.pull?.body ?? entry.natural.body }],
    gaps: [], inputDigest: '1'.repeat(64), inputFingerprint: '3'.repeat(64), verificationDigest: '2'.repeat(64),
    dependencyOnly: extra.dependencyOnly ?? false,
    testEvidence: extra.testEvidence ?? { kind: 'unavailable' },
    ...extra, files, features,
  };
}

const catalog = loadCatalog();
test('catalog has ten parent-only entries and hides expected labels from natural inputs', () => {
  assert.equal(catalog.length, 10);
  assert.deepEqual(catalog.map(e => e.privateId), [
    'login-pitch', 'dashboard-row', 'audit-gate-note', 'ready-check', 'session-cleanup',
    'logger-note', 'login-spacing', 'brief-note', 'product-note', 'anthropic-sdk',
  ]);
  const leaked = /NOT VERIFIED|false-claim|data-loss|CI-only|benchmark|corpus/;
  for (const entry of catalog) {
    assert.equal(leaked.test(entry.natural.title), false, entry.privateId);
    assert.equal(leaked.test(entry.natural.body) && entry.privateId !== 'brief-note', false, entry.privateId);
    assert.equal(entry.natural.body.includes(secret), false);
    assert.match(organicCatalogPrompt(entry), /verdict-only/);
    assert.equal(organicCatalogPrompt(entry).includes(JSON.stringify(entry.expected)), false);
  }
});

test('catalog verification sections use only claims the reconciler can attribute', () => {
  for (const entry of catalog) {
    const report = analyze(snapshotFor(entry), {
      id: '12345678-1234-1234-1234-123456789abc',
      configPath: '.cursor/converge.json',
      execution: 'verdict-only',
    });
    assert.equal(
      report.claims.some(claim => claim.kind === 'unsupported'),
      false,
      entry.privateId,
    );
  }
});

for (const entry of catalog) {
  test(`applies ${entry.privateId} to a fixture tree and fails on trunk drift`, t => {
    const f = tree(); t.after(f.cleanup);
    seed(f.directory, entry);
    applyEdits(f.directory, entry.natural.edits);
    for (const edit of entry.natural.edits) {
      const text = readFileSync(join(f.directory, edit.path), 'utf8');
      assert.equal(text.includes(edit.after), true, edit.path);
      if (edit.before && !edit.after.includes(edit.before)) assert.equal(text.includes(edit.before), false, edit.path);
    }
    const drifted = tree(); t.after(drifted.cleanup);
    seed(drifted.directory, entry);
    const first = entry.natural.edits[0];
    if (first && first.before) {
      writeFileSync(join(drifted.directory, first.path), 'wrong\n');
      assert.throws(() => applyEdits(drifted.directory, entry.natural.edits), /Failed precondition/);
    }
  });
}

test('ready-check survives the real generated-doc pre-push contract', t => {
  const f = tree(); t.after(f.cleanup);
  const work = join(f.directory, 'work');
  const remote = join(f.directory, 'origin.git');
  mkdirSync(work);
  const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--bare', remote);
  git('init', '-b', 'main', work);
  git('-C', work, 'config', 'user.email', 'local@example.invalid');
  git('-C', work, 'config', 'user.name', 'Local fixture');
  mkdirSync(join(work, 'docs', 'gerado'), { recursive: true });
  writeFileSync(join(work, 'docs', 'gerado', 'STRUCTURE.md'), '│   │   ├── r2-backup-freshness.test.js\n│   │   ├── repair-roubo-ancora.test.js\n');
  git('-C', work, 'add', '.');
  git('-C', work, 'commit', '-m', 'base');
  git('-C', work, 'remote', 'add', 'origin', remote);
  git('-C', work, 'push', '-u', 'origin', 'main');
  git('-C', work, 'checkout', '-b', 'converge-proof/ready-check');

  const entry = catalog.find(candidate => candidate.privateId === 'ready-check');
  assert.ok(entry);
  applyEdits(work, entry.natural.edits);
  git('-C', work, 'add', '--', ...entry.natural.edits.map(edit => edit.path));
  git('-C', work, 'commit', '-m', entry.natural.title);
  const hook = join(work, '.git', 'hooks', 'pre-push');
  writeFileSync(hook, `#!/bin/sh
# clinext-pre-push-v1
set -e
cd "$(git rev-parse --show-toplevel)"
if [ -f tools/tests/ready-check.test.js ]; then
  printf '│   │   ├── r2-backup-freshness.test.js\\n│   │   ├── ready-check.test.js\\n│   │   ├── repair-roubo-ancora.test.js\\n' > docs/gerado/STRUCTURE.md
fi
git diff --exit-code HEAD --
`, { mode: 0o755 });

  git('-C', work, 'push', '-u', 'origin', 'converge-proof/ready-check');
  assert.equal(git('-C', work, 'status', '--porcelain'), '');
});

test('deterministic C detectors fire for delete, secret, injection, documentary, docs, false-claim and human bump', () => {
  const byId = Object.fromEntries(catalog.map(e => [e.privateId, e]));
  const deleted = analyze(snapshotFor(byId['session-cleanup']), { id: '12345678-1234-1234-1234-123456789abc', configPath: '.cursor/converge.json', execution: 'verdict-only' });
  assert.equal(deleted.hardList.some(f => f.kind === 'data-loss' && f.rule === 'unbounded-delete'), true);
  assert.equal(deleted.findings.some(f => f.kind === 'data-loss'), true);

  const secretHit = analyze(snapshotFor(byId['logger-note']), { id: '12345678-1234-1234-1234-123456789abc', configPath: '.cursor/converge.json', execution: 'verdict-only' });
  assert.equal(secretHit.hardList.some(f => f.kind === 'secret'), true);
  assert.equal(JSON.stringify(secretHit).includes(secret), false);

  const injected = analyze(snapshotFor(byId['brief-note']), { id: '12345678-1234-1234-1234-123456789abc', configPath: '.cursor/converge.json', execution: 'verdict-only' });
  assert.equal(injected.injection.some(f => f.kind === 'injection'), true);

  const missing = analyze(snapshotFor(byId['login-spacing']), { id: '12345678-1234-1234-1234-123456789abc', configPath: '.cursor/converge.json', execution: 'verdict-only' });
  assert.equal(missing.findings.some(f => f.kind === 'documentary' && f.path === '.cursor/skills/verify-clinext/features/login.md'), true);

  const docs = analyze(snapshotFor(byId['product-note']), { id: '12345678-1234-1234-1234-123456789abc', configPath: '.cursor/converge.json', execution: 'verdict-only' });
  assert.equal(docs.mode, 'ci-only');
  assert.deepEqual(docs.lanes, []);

  const claim = analyze(snapshotFor(byId['audit-gate-note'], {
    testEvidence: { kind: 'complete', runId: 8, attempt: 1, jobId: 6, paths: ['tools/tests/present.test.js'] },
  }), { id: '12345678-1234-1234-1234-123456789abc', configPath: '.cursor/converge.json', execution: 'verdict-only' });
  assert.equal(claim.claims[0].artifactFound, false);
  assert.equal(claim.claims[0].resolution, 'missing');

  const human = analyze(snapshotFor(byId['anthropic-sdk']), { id: '12345678-1234-1234-1234-123456789abc', configPath: '.cursor/converge.json', execution: 'verdict-only' });
  assert.equal(human.mode, 'full');
  assert.equal(human.lanes.includes('pr verifier'), true);

  const clean = analyze(snapshotFor(byId['login-pitch']), { id: '12345678-1234-1234-1234-123456789abc', configPath: '.cursor/converge.json', execution: 'verdict-only' });
  assert.equal(clean.findings.some(f => f.kind === 'documentary'), false);
  assert.equal(clean.touchedFeatures[0].id, 'login');
  assert.equal(clean.mode, 'full');

  const regression = analyze(snapshotFor(byId['dashboard-row']), { id: '12345678-1234-1234-1234-123456789abc', configPath: '.cursor/converge.json', execution: 'verdict-only' });
  assert.equal(regression.findings.some(f => f.kind === 'documentary'), false);
  assert.equal(expectedDisplay(byId['dashboard-row'].expected), 'NOT VERIFIED');
});

test('plantCase reserves the ref, records identities and never impersonates Dependabot', async t => {
  const f = tree(); t.after(f.cleanup);
  const work = join(f.directory, 'work');
  mkdirSync(work);
  const entry = catalog[0];
  seed(work, entry);
  const hookPath = join(f.directory, 'pre-push');
  writeFileSync(hookPath, '# clinext-pre-push-v1\nnpm run preflight\n');
  const calls: string[][] = [];
  let pushed = false;
  let branch = '';
  let staged = false;
  let committed = false;
  const ownedPaths = [...new Set(entry.natural.edits.map(edit => edit.path))];
  const baseContents = Object.fromEntries(ownedPaths.map(path => [path, readFileSync(join(work, path), 'utf8')]));
  const command: Command = (binary, args) => {
    calls.push([binary, ...args]);
    if (binary === 'git' && args.includes('ls-remote')) return pushed ? `${head}\trefs/heads/converge-proof/login-pitch\n` : '';
    if (binary === 'git' && args.includes('--show-toplevel')) return work + '\n';
    if (binary === 'git' && args.includes('get-url')) return 'https://github.com/Clinextapp/clinext.git\n';
    if (binary === 'git' && args.includes('--git-path')) return hookPath + '\n';
    if (binary === 'git' && args[2] === 'checkout' && args.includes('-b')) { branch = String(args.at(-1)); return ''; }
    if (binary === 'git' && args[2] === 'branch' && args.includes('--show-current')) return branch + '\n';
    if (binary === 'git' && args[2] === 'branch') return '';
    if (binary === 'git' && args[2] === 'status') {
      if (committed) return '';
      const changed = entry.natural.edits.some(edit => readFileSync(join(work, edit.path), 'utf8').includes(edit.after));
      return changed ? ownedPaths.map(path => `${staged ? 'M ' : ' M'} ${path}`).join('\n') + '\n' : '';
    }
    if (binary === 'git' && args[2] === 'diff' && args.includes('--cached')) return staged ? ownedPaths.join('\n') + '\n' : '';
    if (binary === 'git' && args[2] === 'diff-tree') return ownedPaths.join('\n') + '\n';
    if (binary === 'git' && args[2] === 'ls-tree') return String(args.at(-1)) + '\n';
    if (binary === 'git' && args[2] === 'add') { staged = true; return ''; }
    if (binary === 'git' && args[2] === 'commit') { committed = true; staged = false; return ''; }
    if (binary === 'git' && args[2] === 'show') {
      const revision = String(args.at(-1));
      if (revision.includes(':')) return baseContents[revision.slice(revision.indexOf(':') + 1)] ?? '';
      return entry.natural.title + '\n';
    }
    if (binary === 'git' && args.includes('rev-parse')) {
      const revision = String(args.at(-1));
      return (revision === 'HEAD' ? (committed ? head : trunk) : trunk) + '\n';
    }
    if (binary === 'git' && args.includes('push')) { pushed = true; return ''; }
    if (binary === 'gh' && args[0] === 'pr' && args[1] === 'list') return '[]';
    if (binary === 'gh' && args[0] === 'pr' && args[1] === 'create') return 'https://github.com/Clinextapp/clinext/pull/91\n';
    if (binary === 'gh' && args[0] === 'pr' && args[1] === 'view') {
      return JSON.stringify({ number: 91, headRefOid: head, headRefName: 'converge-proof/login-pitch', url: 'https://github.com/Clinextapp/clinext/pull/91' });
    }
    return '';
  };
  const epochPath = join(f.directory, 'epoch.json');
  writeFileSync(epochPath, JSON.stringify({ schemaVersion: 1, epochId: 'epoch-1', ownerId: 'owner-1', repo: 'Clinextapp/clinext', workRoot: work, origin: 'https://github.com/Clinextapp/clinext.git', acquiredAt: '2026-09-22T04:59:00.000Z', expiresAt: '2026-09-22T05:30:00.000Z', state: 'frozen' }));
  const repositoryEpoch = { path: epochPath, sha256: hash(readFileSync(epochPath)) };
  const selectedCatalog = { path: catalogPath(), sha256: hash(readFileSync(catalogPath())) };
  const owned = await plantCase({ repo: 'Clinextapp/clinext', workRoot: work, evidenceRoot: join(f.directory, 'evidence'), entry, catalog: selectedCatalog, ownerId: 'owner-1', repositoryEpoch, command, now: () => '2026-09-22T05:00:00.000Z' });
  assert.equal(owned.pr, 91);
  assert.equal(owned.ref, 'converge-proof/login-pitch');
  assert.equal(owned.head, head);
  assert.equal(calls.some(call => call.includes('needs-victor')), true);
  assert.equal(calls.some(call => call.join(' ').includes('dependabot')), false);
  assert.equal(calls.some(call => call.includes('-B') || call.includes('-A')), false);
  assert.equal(calls.some(call => call.includes('--body-file') && call.includes('--label')), true);
  assert.equal(readFileSync(join(work, 'client/src/pages/LoginPage.jsx'), 'utf8').includes('a operação'), true);
});

test('plant recovery refuses a wrong branch and unrelated staged paths before commit', async t => {
  for (const scenario of ['wrong-branch', 'staged-unrelated'] as const) {
    const f = tree(); t.after(f.cleanup);
    const fixtureRoot = realpathSync(f.directory);
    const work = join(fixtureRoot, 'work');
    const remote = join(fixtureRoot, 'origin.git');
    const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '--bare', remote);
    git('init', '-b', 'main', work);
    git('-C', work, 'config', 'user.email', 'local@example.invalid');
    git('-C', work, 'config', 'user.name', 'Local fixture');
    writeFileSync(join(work, 'page.md'), 'before\n');
    writeFileSync(join(work, 'unrelated.md'), 'original\n');
    git('-C', work, 'add', '.');
    git('-C', work, 'commit', '-m', 'base');
    git('-C', work, 'remote', 'add', 'origin', remote);
    git('-C', work, 'push', '-u', 'origin', 'main');
    writeFileSync(join(work, '.git', 'hooks', 'pre-push'), '#!/bin/sh\n# clinext-pre-push-v1\n# npm run preflight\nexit 0\n', { mode: 0o755 });
    const entry: CatalogCase = {
      privateId: 'fixture', natural: { title: 'Fixture change', body: 'body', edits: [{ path: 'page.md', before: 'before', after: 'after' }] },
      expected: { kind: 'docs', display: 'CI-only', requiredRoles: [] },
    };
    const epochPath = join(fixtureRoot, 'epoch.json');
    writeFileSync(epochPath, JSON.stringify({ schemaVersion: 1, epochId: 'epoch-1', ownerId: 'owner-1', repo: 'Clinextapp/clinext', workRoot: work, origin: remote, acquiredAt: '2026-09-22T04:59:00.000Z', expiresAt: '2026-09-22T05:30:00.000Z', state: 'frozen' }));
    const catalogFile = join(fixtureRoot, 'catalog.json'); writeFileSync(catalogFile, '{}');
    const command: Command = (binary, args) => {
      if (binary === 'git') return git(...args) + '\n';
      throw new Error(`Unexpected command ${binary}`);
    };
    const request = {
      repo: 'Clinextapp/clinext', workRoot: work, evidenceRoot: join(fixtureRoot, 'evidence'), entry,
      catalog: originalOf(catalogFile), ownerId: 'owner-1', repositoryEpoch: originalOf(epochPath), command,
      now: () => '2026-09-22T05:00:00.000Z',
    };
    let interrupted = false;
    await assert.rejects(() => plantCase({ ...request, onIntent(original) {
      const state = JSON.parse(readFileSync(original.path, 'utf8'));
      const stop = scenario === 'wrong-branch' ? state.state === 'branch-created' : state.state === 'edits-applied';
      if (stop && !interrupted) { interrupted = true; throw new Error('simulated process death'); }
    } }), /simulated process death/);
    if (scenario === 'wrong-branch') git('-C', work, 'checkout', '-b', 'unrelated-branch');
    else {
      writeFileSync(join(work, 'unrelated.md'), 'unrelated staged change\n');
      git('-C', work, 'add', 'unrelated.md');
    }
    await assert.rejects(() => plantCase(request), scenario === 'wrong-branch' ? /owned plant branch/ : /[Pp]re-staged|Staged paths|unrelated changes/);
    assert.equal(git('-C', work, 'show', '-s', '--format=%s', 'HEAD'), 'base');
    assert.equal(readFileSync(join(work, 'page.md'), 'utf8'), scenario === 'wrong-branch' ? 'before\n' : 'after\n');
    if (scenario === 'staged-unrelated') assert.match(git('-C', work, 'diff', '--cached', '--name-only'), /unrelated\.md/);
  }
});

test('closeOwnedCase uses ordinary deletion, blocks head drift and never force-pushes', async t => {
  const f = tree(); t.after(f.cleanup);
  const work = join(f.directory, 'work'); mkdirSync(work);
  const hookPath = join(f.directory, 'pre-push'); writeFileSync(hookPath, '# clinext-pre-push-v1\nnpm run preflight\n');
  const epochPath = join(f.directory, 'epoch.json');
  writeFileSync(epochPath, JSON.stringify({ schemaVersion: 1, epochId: 'epoch-1', ownerId: 'owner-1', repo: 'Clinextapp/clinext', workRoot: work, origin: 'https://github.com/Clinextapp/clinext.git', acquiredAt: '2026-09-22T04:59:00.000Z', expiresAt: '2026-09-22T05:30:00.000Z', state: 'frozen' }));
  const intentPath = join(f.directory, 'intent.json');
  writeFileSync(intentPath, JSON.stringify({ schemaVersion: 1, ownerId: 'owner-1', privateId: 'login-pitch', repo: 'Clinextapp/clinext', ref: 'converge-proof/login-pitch', workRoot: work, origin: 'https://github.com/Clinextapp/clinext.git', title: 'title', createdAt: '2026-09-22T05:00:00.000Z', catalogDigest: '0'.repeat(64), repositoryEpoch: { path: epochPath, sha256: hash(readFileSync(epochPath)) }, state: 'pr-created', trunk, expectedHead: head, pr: 91 }));
  const ownedPath = join(f.directory, 'owned.json');
  const owned = {
    repo: 'Clinextapp/clinext', pr: 91, ref: 'converge-proof/login-pitch', head, trunk,
    ownerId: 'owner-1', privateId: 'login-pitch', workRoot: work, origin: 'https://github.com/Clinextapp/clinext.git',
    repositoryEpoch: { path: epochPath, sha256: hash(readFileSync(epochPath)) },
    creationIntent: { path: intentPath, sha256: hash(readFileSync(intentPath)) },
    createdResource: { path: ownedPath, sha256: '' },
  };
  writeFileSync(ownedPath, JSON.stringify({ schemaVersion: 1, repo: owned.repo, pr: owned.pr, ref: owned.ref, head: owned.head, trunk: owned.trunk, ownerId: owned.ownerId, privateId: owned.privateId, workRoot: work, origin: owned.origin, repositoryEpoch: owned.repositoryEpoch, url: 'https://github.com/Clinextapp/clinext/pull/91' }));
  owned.createdResource.sha256 = hash(readFileSync(ownedPath));
  const calls: string[][] = [];
  let closed = false;
  const command: Command = (binary, args) => {
    calls.push([binary, ...args]);
    if (binary === 'git' && args.includes('--show-toplevel')) return work + '\n';
    if (binary === 'git' && args.includes('get-url')) return owned.origin + '\n';
    if (binary === 'git' && args.includes('--git-path')) return hookPath + '\n';
    if (binary === 'gh' && args[1] === 'close') { closed = true; return ''; }
    if (binary === 'gh' && args[1] === 'view') {
      return JSON.stringify({ number: 91, state: closed ? 'CLOSED' : 'OPEN', headRefOid: head, headRefName: owned.ref, labels: [{ name: 'needs-victor' }], autoMergeRequest: null });
    }
    return '';
  };
  let seen = 0;
  const result = await closeOwnedCase({
    owned, evidenceRoot: f.directory, command,
    drainReaders: async () => 'drained',
    observeHead: async () => { seen += 1; return seen < 4 ? head : null; },
    now: () => '2026-09-22T05:00:00.000Z',
  });
  assert.equal(result.kind, 'closed-and-deleted');
  if (result.kind === 'closed-and-deleted') assert.equal(result.lease, 'none');
  assert.deepEqual(calls.find(call => call[0] === 'git' && call.includes('--delete')), ['git', '-C', work, 'push', 'origin', '--delete', owned.ref]);
  assert.equal(calls.some(call => call.join(' ').includes('--force')), false);

  const retried = await closeOwnedCase({
    owned, evidenceRoot: f.directory, command,
    drainReaders: async () => 'drained', observeHead: async () => null,
    now: () => '2026-09-22T05:00:00.000Z',
  });
  assert.equal(retried.kind, 'closed-and-deleted');
  if (retried.kind !== 'blocked' && result.kind !== 'blocked') assert.deepEqual(retried.absence, result.absence);

  const drifted = await closeOwnedCase({
    owned, evidenceRoot: join(f.directory, 'drift'), command,
    drainReaders: async () => 'drained',
    observeHead: async () => 'c'.repeat(40),
    now: () => '2026-09-22T05:00:00.000Z',
  });
  assert.equal(drifted.kind, 'blocked');
});

test('historical inspect prompt stays organic and names carrier separately from the revision', () => {
  const prompt = organicInspectPrompt({
    repo: 'Clinextapp/clinext', head, base: trunk, carrierHead: 'c'.repeat(40), opaqueId: '0941fe3b-e5cd',
  });
  assert.match(prompt, /observedCarrierHead/);
  assert.equal(/\b(?:eval|judge|benchmark|corpus)\b/i.test(prompt), false);
  assert.equal(prompt.includes('/tmp/patient-work/0941fe3b-e5cd'), true);
  assert.equal(readFileSync(catalogPath(), 'utf8').includes('"schemaVersion": 1'), true);
});
