import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { array, hash, integer, object, oneOf, relativePath, repoName, sha, string } from '../contract.ts';

export type Command = (binary: string, args: string[], input?: string) => string;
export type Original = Readonly<{ path: string; sha256: string }>;
export type Edit = Readonly<{ path: string; before: string; after: string }>;
export type NaturalChange = Readonly<{ title: string; body: string; edits: readonly Edit[] }>;
export type Expectation =
  | Readonly<{ kind: 'clean-ui'; page: string; feature: string }>
  | Readonly<{ kind: 'defect'; verdict: 'NOT VERIFIED'; finding: 'regression' | 'test-behavior' | 'data-loss' | 'documentary' | 'injection'; path: string }>
  | Readonly<{ kind: 'missing-test'; testPath: string }>
  | Readonly<{ kind: 'secret'; syntheticValue: string; path: string }>
  | Readonly<{ kind: 'docs'; display: 'CI-only'; requiredRoles: readonly [] }>
  | Readonly<{ kind: 'human-update'; authorKind: 'human'; mode: 'full' }>;
export type CatalogCase = Readonly<{ privateId: string; natural: NaturalChange; expected: Expectation }>;
export type OwnedCase = Readonly<{
  repo: string; pr: number; ref: string; head: string; trunk: string;
  ownerId: string; privateId: string; workRoot: string; origin: string;
  repositoryEpoch: Original; creationIntent: Original; createdResource: Original;
}>;
export type RepositoryEpoch = Readonly<{
  schemaVersion: 1; epochId: string; ownerId: string; repo: string; workRoot: string; origin: string;
  acquiredAt: string; expiresAt: string; state: 'frozen';
}>;
export type CleanupResult =
  | Readonly<{ kind: 'closed-and-deleted'; pr: number; ref: string; absence: Original; lease: 'none' }>
  | Readonly<{ kind: 'already-absent'; pr: number; ref: string; absence: Original; lease: 'none' }>
  | Readonly<{ kind: 'blocked'; reason: string; retained: readonly Original[] }>;

function lifecycleCommand(binary: string, args: string[], input?: string): string {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  if (binary === 'gh') {
    environment.NO_COLOR = '1';
    environment.CLICOLOR = '0';
    delete environment.FORCE_COLOR;
    delete environment.CLICOLOR_FORCE;
  }
  const result = spawnSync(binary, args, { input, encoding: 'utf8', env: environment, maxBuffer: 24 * 1024 * 1024, timeout: 30 * 60 * 1000 });
  if (!result.error && result.status === 0) return result.stdout;
  if (binary === 'gh') throw new Error('GitHub command failed during the recorded lifecycle mutation');
  const evidence = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim().slice(-4_000);
  throw new Error(`${binary} command failed${evidence ? `:\n${evidence}` : ''}`);
}

export function alignDependencies(workRoot: string, command: Command = lifecycleCommand): void {
  const args = ['--prefix', resolve(workRoot), 'run'];
  try {
    command('npm', [...args, 'deps:check']);
    return;
  } catch { /* a failed check is the signal to synchronize */ }
  command('npm', [...args, 'deps:sync']);
  command('npm', [...args, 'deps:check']);
}

export function originalOf(path: string, bytes?: string | Uint8Array): Original {
  const data = bytes ?? readFileSync(path);
  return { path, sha256: hash(typeof data === 'string' ? data : data) };
}

export function catalogPath(): string {
  return fileURLToPath(new URL('./catalog.json', import.meta.url));
}

function parseEdit(value: unknown): Edit {
  const v = object(value, 'edit');
  return { path: relativePath(v.path), before: string(v.before), after: string(v.after) };
}

function parseExpectation(value: unknown): Expectation {
  const v = object(value, 'expectation');
  const kind = oneOf(v.kind, ['clean-ui', 'defect', 'missing-test', 'secret', 'docs', 'human-update']);
  if (kind === 'clean-ui') return { kind, page: relativePath(v.page), feature: string(v.feature) };
  if (kind === 'defect') {
    return {
      kind,
      verdict: oneOf(v.verdict, ['NOT VERIFIED']),
      finding: oneOf(v.finding, ['regression', 'test-behavior', 'data-loss', 'documentary', 'injection']),
      path: v.path === 'body' ? 'body' : relativePath(v.path),
    };
  }
  if (kind === 'missing-test') return { kind, testPath: relativePath(v.testPath) };
  if (kind === 'secret') return { kind, syntheticValue: string(v.syntheticValue), path: relativePath(v.path) };
  if (kind === 'docs') {
    const roles = array(v.requiredRoles);
    if (roles.length) throw new Error('Docs expectation must select no roles');
    return { kind, display: oneOf(v.display, ['CI-only']), requiredRoles: [] };
  }
  if (oneOf(v.authorKind, ['human']) !== 'human' || oneOf(v.mode, ['full']) !== 'full') throw new Error('Human update must stay human and full');
  return { kind: 'human-update', authorKind: 'human', mode: 'full' };
}

export function parseCatalog(value: unknown): CatalogCase[] {
  const v = object(value, 'catalog');
  if (v.schemaVersion !== 1) throw new Error('Unknown catalog schema');
  const entries = array(v.entries).map((entry): CatalogCase => {
    const e = object(entry, 'catalog entry');
    const privateId = string(e.privateId);
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(privateId)) throw new Error('Invalid catalog id');
    const natural = object(e.natural, 'natural change');
    const edits = array(natural.edits).map(parseEdit);
    if (!edits.length) throw new Error('Catalog entry has no edits');
    return { privateId, natural: { title: string(natural.title), body: string(natural.body), edits }, expected: parseExpectation(e.expected) };
  });
  if (entries.length !== 10) throw new Error('Catalog must contain ten entries');
  const ids = entries.map(e => e.privateId);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate catalog id');
  return entries;
}

export function loadCatalog(path = catalogPath()): CatalogCase[] {
  return parseCatalog(JSON.parse(readFileSync(path, 'utf8')));
}

export function expectedDisplay(expected: Expectation): string {
  if (expected.kind === 'clean-ui' || expected.kind === 'human-update') return 'VERIFIED';
  if (expected.kind === 'docs') return 'CI-only';
  return 'NOT VERIFIED';
}

export function applyEdits(root: string, edits: readonly Edit[]): void {
  const base = resolve(root);
  for (const edit of edits) {
    const full = resolve(base, relativePath(edit.path));
    if (full !== base && !full.startsWith(base + sep)) throw new Error('Edit escapes work root');
    if (edit.before === '') {
      if (existsSync(full)) throw new Error(`Failed precondition: ${edit.path} already exists`);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, edit.after);
      continue;
    }
    if (!existsSync(full)) throw new Error(`Failed precondition: ${edit.path} is missing`);
    const text = readFileSync(full, 'utf8');
    const parts = text.split(edit.before);
    if (parts.length === 1) throw new Error(`Failed precondition: ${edit.path} does not contain the exact before text`);
    if (parts.length !== 2) throw new Error(`Failed precondition: ${edit.path} before text is not unique`);
    writeFileSync(full, parts[0] + edit.after + parts[1]);
  }
}

function writeExclusive(path: string, value: unknown): Original {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const text = JSON.stringify(value, null, 2) + '\n';
  writeFileSync(path, text, { flag: 'wx', mode: 0o600 });
  return originalOf(path, text);
}

function writeAtomic(path: string, value: unknown): Original {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const text = JSON.stringify(value, null, 2) + '\n';
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const descriptor = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(descriptor, text);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
  return originalOf(path, text);
}

function writeImmutable(path: string, value: unknown): Original {
  const text = JSON.stringify(value, null, 2) + '\n';
  if (existsSync(path)) {
    if (readFileSync(path, 'utf8') !== text) throw new Error(`Immutable evidence conflict at ${path}`);
    return originalOf(path, text);
  }
  return writeExclusive(path, value);
}

function parseEpoch(original: Original, expected: { repo: string; workRoot: string; ownerId: string }, now: string): RepositoryEpoch {
  if (hash(readFileSync(original.path)) !== original.sha256) throw new Error('Repository epoch digest mismatch');
  const value = object(JSON.parse(readFileSync(original.path, 'utf8')), 'repository epoch');
  const epoch: RepositoryEpoch = {
    schemaVersion: 1,
    epochId: string(value.epochId), ownerId: string(value.ownerId), repo: repoName(value.repo),
    workRoot: resolve(string(value.workRoot)), origin: string(value.origin),
    acquiredAt: string(value.acquiredAt), expiresAt: string(value.expiresAt), state: oneOf(value.state, ['frozen']),
  };
  if (value.schemaVersion !== 1 || epoch.repo !== expected.repo || epoch.workRoot !== resolve(expected.workRoot) || epoch.ownerId !== expected.ownerId) {
    throw new Error('Repository epoch does not bind this owner, repository and work root');
  }
  const current = Date.parse(now);
  const acquired = Date.parse(epoch.acquiredAt);
  const expires = Date.parse(epoch.expiresAt);
  if (!Number.isFinite(current) || !Number.isFinite(acquired) || !Number.isFinite(expires) || acquired > current || current >= expires) {
    throw new Error('Repository epoch is not current');
  }
  return epoch;
}

function verifyWorkRoot(command: Command, workRoot: string, epoch: RepositoryEpoch): void {
  const top = resolve(command('git', ['-C', workRoot, 'rev-parse', '--show-toplevel']).trim());
  if (top !== workRoot) throw new Error('Work root is not the isolated repository root');
  const origin = command('git', ['-C', workRoot, 'remote', 'get-url', 'origin']).trim();
  if (origin !== epoch.origin) throw new Error('Work root origin does not match the repository epoch');
  const hookOutput = command('git', ['-C', workRoot, 'rev-parse', '--git-path', 'hooks/pre-push']).trim();
  const hookPath = resolve(workRoot, hookOutput);
  const hook = existsSync(hookPath) ? readFileSync(hookPath, 'utf8') : '';
  if (!hook.includes('clinext-pre-push-v1') || !hook.includes('npm run preflight')) {
    throw new Error('Clinext pre-push protection is not installed in the isolated work root');
  }
}

function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function lines(value: string): string[] {
  return value.split('\n').map(line => line.trim()).filter(Boolean);
}

function statusPaths(value: string): string[] {
  return value.split('\n').filter(Boolean).map(line => {
    if (line.length < 4 || line.slice(3).includes(' -> ')) throw new Error('Work root has an unsupported changed-path shape');
    return relativePath(line.slice(3));
  });
}

function exactPaths(actual: readonly string[], expected: readonly string[], message: string): void {
  const got = [...new Set(actual)].sort();
  const want = [...new Set(expected)].sort();
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(message);
}

function assertCatalogContents(command: Command, workRoot: string, revision: string, edits: readonly Edit[]): void {
  const paths = [...new Set(edits.map(edit => edit.path))];
  for (const path of paths) {
    const listed = lines(command('git', ['-C', workRoot, 'ls-tree', '--name-only', revision, '--', path]));
    let expected: string | null;
    if (listed.length === 0) expected = null;
    else {
      exactPaths(listed, [path], 'Recorded base contains an ambiguous catalog path');
      expected = command('git', ['-C', workRoot, 'show', `${revision}:${path}`]);
    }
    for (const edit of edits.filter(candidate => candidate.path === path)) {
      if (edit.before === '') {
        if (expected !== null) throw new Error(`Catalog expected ${path} to be absent at the recorded base`);
        expected = edit.after;
      } else {
        if (expected === null) throw new Error(`Catalog expected ${path} to exist at the recorded base`);
        const parts = expected.split(edit.before);
        if (parts.length !== 2) throw new Error(`Catalog base text for ${path} is not exact and unique`);
        expected = parts[0] + edit.after + parts[1];
      }
    }
    const current = existsSync(resolve(workRoot, path)) ? readFileSync(resolve(workRoot, path), 'utf8') : null;
    if (current !== expected) throw new Error(`Work root content for ${path} is not the exact catalog result`);
  }
}

function assertBaseCheckout(command: Command, workRoot: string, state: { ref: string; trunk?: string }, edits: readonly Edit[], requireAllEdits: boolean, stagedOwned = false): void {
  if (command('git', ['-C', workRoot, 'branch', '--show-current']).trim() !== state.ref) throw new Error('Work root is not on the owned plant branch');
  if (sha(command('git', ['-C', workRoot, 'rev-parse', 'HEAD']).trim()) !== sha(state.trunk)) throw new Error('Owned plant branch moved away from its recorded base');
  const staged = lines(command('git', ['-C', workRoot, 'diff', '--cached', '--name-only']));
  if (staged.length && !stagedOwned) throw new Error('Work root has pre-staged changes; refusing to include them');
  const changed = statusPaths(command('git', ['-C', workRoot, 'status', '--porcelain=v1', '--untracked-files=all']));
  const ownedPaths = edits.map(edit => edit.path);
  if (changed.some(path => !ownedPaths.includes(path))) throw new Error('Work root contains unrelated changes; refusing to alter them');
  if (requireAllEdits) {
    exactPaths(changed, ownedPaths, 'Work root does not contain exactly the owned catalog edits');
    assertCatalogContents(command, workRoot, sha(state.trunk), edits);
  }
  if (staged.length) exactPaths(staged, ownedPaths, 'Pre-staged paths do not exactly match the catalog change');
}

function assertCommittedCheckout(command: Command, workRoot: string, state: { ref: string; trunk?: string; expectedHead?: string; title: string }, edits: readonly Edit[]): void {
  if (command('git', ['-C', workRoot, 'branch', '--show-current']).trim() !== state.ref) throw new Error('Work root is not on the owned plant branch');
  if (sha(command('git', ['-C', workRoot, 'rev-parse', 'HEAD']).trim()) !== sha(state.expectedHead)) throw new Error('Local checkout moved after the owned commit');
  if (sha(command('git', ['-C', workRoot, 'rev-parse', 'HEAD^']).trim()) !== sha(state.trunk)) throw new Error('Owned commit no longer has the recorded base');
  if (command('git', ['-C', workRoot, 'show', '-s', '--format=%s', 'HEAD']).trim() !== state.title) throw new Error('Owned commit subject changed');
  exactPaths(lines(command('git', ['-C', workRoot, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'])), edits.map(edit => edit.path), 'Owned commit contains paths outside the catalog change');
  assertCatalogContents(command, workRoot, sha(state.trunk), edits);
  if (command('git', ['-C', workRoot, 'status', '--porcelain=v1', '--untracked-files=all']).trim()) throw new Error('Work root changed after the owned commit');
}

export type PlantRequest = Readonly<{
  repo: string;
  workRoot: string;
  evidenceRoot: string;
  entry: CatalogCase;
  catalog: Original;
  ownerId: string;
  repositoryEpoch: Original;
  onIntent?: (intent: Original) => void;
  command?: Command;
  now?: () => string;
}>;

export async function plantCase(request: PlantRequest): Promise<OwnedCase> {
  const command = request.command ?? lifecycleCommand;
  const repo = repoName(request.repo);
  const ref = `converge-proof/${request.entry.privateId}`;
  const workRoot = resolve(request.workRoot);
  const evidenceRoot = resolve(request.evidenceRoot);
  const now = request.now ?? (() => new Date().toISOString());
  const changesDependencies = request.entry.natural.edits.some(edit => edit.path === 'package.json' || edit.path === 'package-lock.json');
  const epoch = parseEpoch(request.repositoryEpoch, { repo, workRoot, ownerId: request.ownerId }, now());
  verifyWorkRoot(command, workRoot, epoch);
  const intentPath = join(evidenceRoot, 'intents', `${request.entry.privateId}.json`);
  type IntentState = 'reserved' | 'branch-created' | 'edits-applied' | 'committed' | 'push-uncertain' | 'pushed' | 'pr-create-uncertain' | 'pr-created';
  type Intent = { schemaVersion: 1; ownerId: string; privateId: string; repo: string; ref: string; workRoot: string; origin: string; title: string; createdAt: string; catalogDigest: string; repositoryEpoch: Original; state: IntentState; trunk?: string; editIndex?: number; expectedHead?: string; pr?: number };
  let state: Intent = existsSync(intentPath)
    ? object(JSON.parse(readFileSync(intentPath, 'utf8')), 'plant intent') as unknown as Intent
    : { schemaVersion: 1, ownerId: request.ownerId, privateId: request.entry.privateId, repo, ref, workRoot, origin: epoch.origin, title: request.entry.natural.title, createdAt: now(), catalogDigest: request.catalog.sha256, repositoryEpoch: request.repositoryEpoch, state: 'reserved' };
  if (state.schemaVersion !== 1 || state.ownerId !== request.ownerId || state.privateId !== request.entry.privateId || state.repo !== repo || state.ref !== ref
    || resolve(state.workRoot) !== workRoot || state.origin !== epoch.origin || state.title !== request.entry.natural.title || state.catalogDigest !== request.catalog.sha256
    || JSON.stringify(state.repositoryEpoch) !== JSON.stringify(request.repositoryEpoch)) {
    throw new Error('Existing plant intent conflicts with this request');
  }
  const save = (next: Intent): Original => {
    state = next;
    const original = writeAtomic(intentPath, next);
    request.onIntent?.(original);
    return original;
  };
  let intent = save(state);
  if (state.state === 'reserved') {
    if (command('git', ['-C', workRoot, 'status', '--porcelain']).trim()) throw new Error('Work root must be clean before planting');
    const remote = command('git', ['-C', workRoot, 'ls-remote', '--heads', 'origin', ref]).trim();
    if (remote) throw new Error(`Ref ${ref} already exists without matching ownership`);
    command('git', ['-C', workRoot, 'fetch', 'origin']);
    const trunk = sha(command('git', ['-C', workRoot, 'rev-parse', 'origin/main']).trim());
    const local = command('git', ['-C', workRoot, 'branch', '--list', ref]).trim();
    if (local) {
      const current = command('git', ['-C', workRoot, 'branch', '--show-current']).trim();
      const localHead = sha(command('git', ['-C', workRoot, 'rev-parse', 'HEAD']).trim());
      if (current !== ref || localHead !== trunk) throw new Error(`Local ref ${ref} exists without recoverable ownership`);
    } else {
      command('git', ['-C', workRoot, 'checkout', '--detach', 'origin/main']);
      command('git', ['-C', workRoot, 'checkout', '-b', ref]);
    }
    intent = save({ ...state, state: 'branch-created', trunk, editIndex: 0 });
  }
  if (state.state === 'branch-created') {
    assertBaseCheckout(command, workRoot, state, request.entry.natural.edits, false);
    let editIndex = state.editIndex ?? 0;
    for (; editIndex < request.entry.natural.edits.length; editIndex += 1) {
      const edit = request.entry.natural.edits[editIndex];
      if (!edit) throw new Error('Catalog edit index is invalid');
      const full = resolve(workRoot, edit.path);
      const current = existsSync(full) ? readFileSync(full, 'utf8') : null;
      const alreadyApplied = edit.before === '' ? current === edit.after : current !== null && current.includes(edit.after) && !current.includes(edit.before);
      if (!alreadyApplied) applyEdits(workRoot, [edit]);
      intent = save({ ...state, state: 'branch-created', editIndex: editIndex + 1 });
    }
    intent = save({ ...state, state: 'edits-applied' });
  }
  if (state.state === 'edits-applied') {
    if (changesDependencies) alignDependencies(workRoot, command);
    const currentHead = sha(command('git', ['-C', workRoot, 'rev-parse', 'HEAD']).trim());
    if (currentHead !== sha(state.trunk)) {
      assertCommittedCheckout(command, workRoot, { ...state, expectedHead: currentHead }, request.entry.natural.edits);
      intent = save({ ...state, state: 'committed', expectedHead: currentHead });
    } else {
      assertBaseCheckout(command, workRoot, state, request.entry.natural.edits, true, true);
      command('git', ['-C', workRoot, 'add', '--', ...request.entry.natural.edits.map(edit => edit.path)]);
      exactPaths(lines(command('git', ['-C', workRoot, 'diff', '--cached', '--name-only'])), request.entry.natural.edits.map(edit => edit.path), 'Staged paths do not exactly match the catalog change');
      command('git', ['-C', workRoot, 'commit', '-m', request.entry.natural.title]);
      const expectedHead = sha(command('git', ['-C', workRoot, 'rev-parse', 'HEAD']).trim());
      intent = save({ ...state, state: 'committed', expectedHead });
    }
  }
  if (state.state === 'committed' || state.state === 'push-uncertain') {
    if (changesDependencies) alignDependencies(workRoot, command);
    const expectedHead = sha(state.expectedHead);
    assertCommittedCheckout(command, workRoot, state, request.entry.natural.edits);
    const observed = command('git', ['-C', workRoot, 'ls-remote', '--heads', 'origin', ref]).trim().split(/\s+/)[0] ?? '';
    if (observed && observed !== expectedHead) throw new Error('Remote ref exists at an unowned head');
    if (!observed) {
      intent = save({ ...state, state: 'push-uncertain' });
      command('git', ['-C', workRoot, 'push', '-u', 'origin', ref]);
      const pushed = command('git', ['-C', workRoot, 'ls-remote', '--heads', 'origin', ref]).trim().split(/\s+/)[0] ?? '';
      if (pushed !== expectedHead) throw new Error('Push result could not be bound to the expected head');
    }
    intent = save({ ...state, state: 'pushed' });
  }
  const bodyPath = join(evidenceRoot, 'bodies', `${request.entry.privateId}.md`);
  let pr = state.pr;
  if (state.state === 'pushed' || state.state === 'pr-create-uncertain') {
    assertCommittedCheckout(command, workRoot, state, request.entry.natural.edits);
    mkdirSync(dirname(bodyPath), { recursive: true, mode: 0o700 });
    if (existsSync(bodyPath) && readFileSync(bodyPath, 'utf8') !== request.entry.natural.body + '\n') throw new Error('PR body evidence conflicts with the catalog');
    if (!existsSync(bodyPath)) writeFileSync(bodyPath, request.entry.natural.body + '\n', { flag: 'wx', mode: 0o600 });
    command('node', [join(workRoot, 'tools', 'pr-body.js'), bodyPath]);
    if (!request.entry.natural.edits.every(edit => edit.path.toLowerCase().endsWith('.md'))) {
      command('npm', ['--prefix', workRoot, 'run', 'crap']);
    }
    const guardedCommand = ['gh', 'pr', 'create', '--repo', repo, '--base', 'main', '--head', ref, '--title', request.entry.natural.title, '--body-file', bodyPath, '--label', 'needs-victor']
      .map(shellLiteral).join(' ');
    command('node', [join(workRoot, 'tools', 'guard-pr-create.js')], JSON.stringify({ cwd: workRoot, tool_input: { command: guardedCommand } }));
    const existing = array(JSON.parse(command('gh', ['pr', 'list', '--repo', repo, '--head', ref, '--state', 'all', '--json', 'number,state,headRefOid,headRefName,url'])))
      .map(value => object(value, 'pull request'));
    const open = existing.filter(candidate => oneOf(candidate.state, ['OPEN', 'CLOSED', 'MERGED']) === 'OPEN');
    if (open.length > 1) throw new Error('Multiple open pull requests exist for the owned ref');
    if (open.length === 1) {
      const recovered = open[0];
      if (string(recovered.headRefName) !== ref || sha(recovered.headRefOid) !== state.expectedHead) throw new Error('Open pull request does not match the owned head');
      pr = integer(recovered.number);
    } else {
      if (state.state === 'pr-create-uncertain' && existing.some(candidate =>
        string(candidate.headRefName) === ref && sha(candidate.headRefOid) === state.expectedHead)) {
        throw new Error('Created pull request is no longer open');
      }
      intent = save({ ...state, state: 'pr-create-uncertain' });
      const created = command('gh', [
        'pr', 'create', '--repo', repo, '--base', 'main', '--head', ref,
        '--title', request.entry.natural.title, '--body-file', bodyPath, '--label', 'needs-victor',
      ]).trim();
      const match = created.match(/\/pull\/(\d+)/);
      if (!match?.[1]) throw new Error('PR create did not return a pull URL');
      pr = Number(match[1]);
    }
    intent = save({ ...state, state: 'pr-created', pr });
  }
  if (!pr) throw new Error('Plant intent has no pull request identity');
  const view = object(JSON.parse(command('gh', ['pr', 'view', String(pr), '--repo', repo, '--json', 'number,state,headRefOid,headRefName,url'])));
  const head = sha(view.headRefOid);
  if (integer(view.number) !== pr || oneOf(view.state, ['OPEN', 'CLOSED', 'MERGED']) !== 'OPEN'
    || string(view.headRefName) !== ref || head !== state.expectedHead) throw new Error('Created PR identity mismatch');
  const trunk = sha(state.trunk);
  const createdResource = writeImmutable(join(evidenceRoot, 'owned', `${request.entry.privateId}.json`), {
    schemaVersion: 1, repo, pr, ref, head, trunk, ownerId: request.ownerId, privateId: request.entry.privateId,
    workRoot, origin: epoch.origin, repositoryEpoch: request.repositoryEpoch, url: string(view.url),
  });
  return { repo, pr, ref, head, trunk, ownerId: request.ownerId, privateId: request.entry.privateId, workRoot, origin: epoch.origin, repositoryEpoch: request.repositoryEpoch, creationIntent: intent, createdResource };
}

export type CloseRequest = Readonly<{
  owned: OwnedCase;
  evidenceRoot: string;
  command?: Command;
  drainReaders: () => Promise<'drained' | 'active'>;
  observeHead: (ref: string) => Promise<string | null>;
  now?: () => string;
}>;

function labelsOf(value: unknown): string[] {
  return array(value).map(item => {
    if (typeof item === 'string') return item;
    return string(object(item).name);
  });
}

function writeAbsence(evidenceRoot: string, owned: OwnedCase, state: 'closed-and-deleted' | 'already-absent'): { state: 'closed-and-deleted' | 'already-absent'; original: Original } {
  const path = join(resolve(evidenceRoot), 'cleanup', `${owned.privateId}.json`);
  if (existsSync(path)) {
    const recorded = object(JSON.parse(readFileSync(path, 'utf8')), 'cleanup evidence');
    const recordedState = oneOf(recorded.state, ['closed-and-deleted', 'already-absent']);
    if (recorded.schemaVersion !== 1 || repoName(recorded.repo) !== owned.repo || integer(recorded.pr) !== owned.pr
      || relativePath(recorded.ref) !== owned.ref || sha(recorded.head) !== owned.head || recorded.lease !== 'none'
      || string(recorded.deletion) !== `git -C ${owned.workRoot} push origin --delete`) {
      throw new Error(`Immutable evidence conflict at ${path}`);
    }
    return { state: recordedState, original: originalOf(path) };
  }
  const original = writeImmutable(path, {
    schemaVersion: 1,
    repo: owned.repo,
    pr: owned.pr,
    ref: owned.ref,
    head: owned.head,
    state,
    lease: 'none',
    deletion: `git -C ${owned.workRoot} push origin --delete`,
  });
  return { state, original };
}

export async function closeOwnedCase(request: CloseRequest): Promise<CleanupResult> {
  const command = request.command ?? lifecycleCommand;
  const owned = request.owned;
  let epoch: RepositoryEpoch;
  try {
    if (hash(readFileSync(owned.creationIntent.path)) !== owned.creationIntent.sha256) throw new Error('Creation intent digest mismatch');
    if (hash(readFileSync(owned.createdResource.path)) !== owned.createdResource.sha256) throw new Error('Created resource digest mismatch');
    const intent = object(JSON.parse(readFileSync(owned.creationIntent.path, 'utf8')), 'creation intent');
    if (intent.schemaVersion !== 1 || string(intent.ownerId) !== owned.ownerId || string(intent.privateId) !== owned.privateId
      || repoName(intent.repo) !== owned.repo || relativePath(intent.ref) !== owned.ref || resolve(string(intent.workRoot)) !== resolve(owned.workRoot)
      || string(intent.origin) !== owned.origin || oneOf(intent.state, ['pr-created']) !== 'pr-created'
      || sha(intent.expectedHead) !== owned.head || integer(intent.pr) !== owned.pr) {
      throw new Error('Creation intent does not match the cleanup target');
    }
    const recorded = object(JSON.parse(readFileSync(owned.createdResource.path, 'utf8')), 'created resource');
    if (repoName(recorded.repo) !== owned.repo || integer(recorded.pr) !== owned.pr || relativePath(recorded.ref) !== owned.ref
      || sha(recorded.head) !== owned.head || string(recorded.ownerId) !== owned.ownerId || resolve(string(recorded.workRoot)) !== resolve(owned.workRoot)
      || string(recorded.origin) !== owned.origin || string(recorded.privateId) !== owned.privateId) {
      throw new Error('Created resource record does not match the cleanup target');
    }
    epoch = parseEpoch(owned.repositoryEpoch, { repo: owned.repo, workRoot: owned.workRoot, ownerId: owned.ownerId }, (request.now ?? (() => new Date().toISOString()))());
    if (epoch.origin !== owned.origin) throw new Error('Recorded origin does not match the repository epoch');
    const top = resolve(command('git', ['-C', owned.workRoot, 'rev-parse', '--show-toplevel']).trim());
    const origin = command('git', ['-C', owned.workRoot, 'remote', 'get-url', 'origin']).trim();
    if (top !== resolve(owned.workRoot) || origin !== owned.origin) throw new Error('Cleanup checkout identity mismatch');
  } catch (error) {
    return { kind: 'blocked', reason: error instanceof Error ? error.message : 'Repository epoch validation failed', retained: [owned.createdResource, owned.repositoryEpoch] };
  }
  let view: Record<string, unknown>;
  try {
    view = object(JSON.parse(command('gh', ['pr', 'view', String(owned.pr), '--repo', owned.repo, '--json', 'number,state,headRefOid,headRefName,labels,autoMergeRequest'])));
  } catch {
    return { kind: 'blocked', reason: 'Owned PR identity is unavailable; ref absence cannot prove PR closure', retained: [owned.createdResource] };
  }
  if (integer(view.number) !== owned.pr || string(view.headRefName) !== owned.ref) {
    return { kind: 'blocked', reason: 'Owned PR identity does not match the recorded ref', retained: [owned.createdResource] };
  }
  const state = oneOf(view.state, ['OPEN', 'CLOSED', 'MERGED']);
  if (state === 'MERGED') return { kind: 'blocked', reason: 'Owned pull request was merged; refusing cleanup', retained: [owned.createdResource] };
  const remoteHead = sha(view.headRefOid);
  const current = await request.observeHead(owned.ref);
  if (remoteHead !== owned.head || (current !== null && current !== owned.head)) {
    return { kind: 'blocked', reason: 'Owned branch head moved; refusing deletion', retained: [owned.createdResource] };
  }
  if (!labelsOf(view.labels).includes('needs-victor')) {
    return { kind: 'blocked', reason: 'Hold label is missing; refusing cleanup', retained: [owned.createdResource] };
  }
  if (view.autoMergeRequest !== null && view.autoMergeRequest !== undefined) {
    return { kind: 'blocked', reason: 'Auto-merge is armed; refusing cleanup', retained: [owned.createdResource] };
  }
  if (await request.drainReaders() !== 'drained') {
    return { kind: 'blocked', reason: 'Remote readers are not drained', retained: [owned.createdResource] };
  }
  if (state === 'CLOSED' && current === null) {
    const absence = writeAbsence(request.evidenceRoot, owned, 'already-absent');
    return { kind: absence.state, pr: owned.pr, ref: owned.ref, absence: absence.original, lease: 'none' };
  }
  const beforeDelete = await request.observeHead(owned.ref);
  if (beforeDelete !== owned.head) {
    return { kind: 'blocked', reason: 'Remote head changed during the exclusive write epoch', retained: [owned.createdResource] };
  }
  if (state === 'OPEN') {
    command('gh', ['pr', 'close', String(owned.pr), '--repo', owned.repo]);
    const closed = object(JSON.parse(command('gh', ['pr', 'view', String(owned.pr), '--repo', owned.repo, '--json', 'number,state,headRefOid,headRefName,labels,autoMergeRequest'])));
    if (integer(closed.number) !== owned.pr || oneOf(closed.state, ['OPEN', 'CLOSED', 'MERGED']) !== 'CLOSED'
      || string(closed.headRefName) !== owned.ref || sha(closed.headRefOid) !== owned.head) {
      return { kind: 'blocked', reason: 'Pull request did not read back as the same CLOSED resource', retained: [owned.createdResource] };
    }
  }
  const afterClose = await request.observeHead(owned.ref);
  if (afterClose !== null && afterClose !== owned.head) {
    return { kind: 'blocked', reason: 'Remote head moved after close; refusing deletion', retained: [owned.createdResource] };
  }
  if (afterClose !== null) command('git', ['-C', owned.workRoot, 'push', 'origin', '--delete', owned.ref]);
  const absent = await request.observeHead(owned.ref);
  if (absent !== null) return { kind: 'blocked', reason: 'Branch still present after ordinary deletion', retained: [owned.createdResource] };
  const absence = writeAbsence(request.evidenceRoot, owned, 'closed-and-deleted');
  return { kind: absence.state, pr: owned.pr, ref: owned.ref, absence: absence.original, lease: 'none' };
}

export function organicInspectPrompt(input: Readonly<{ repo: string; head: string; base: string; carrierHead: string; opaqueId: string }>): string {
  return [
    `Inspect the change between ${input.base} and ${input.head} in ${input.repo}.`,
    `Create a disposable detached worktree under /tmp/patient-work/${input.opaqueId}.`,
    `Verify git rev-parse HEAD, that ${input.base} is an ancestor of HEAD, the HEAD tree, and the diff digest of ${input.base}..HEAD with real Git commands. Inspect that worktree.`,
    `The HTTP launch context is the current carrier at ${input.carrierHead}. Do not treat the carrier workspace as the subject. Do not change remote refs.`,
    'Historical pull request body is unavailable. Do not retrieve old verdict comments.',
    'Return JSON only with kind, observedHead, observedBase, observedCarrierHead, findings, and artifacts.',
    'observedCarrierHead is the carrier checkout HEAD. observedHead is the historical worktree HEAD. They are different fields.',
  ].join('\n');
}

export function organicCatalogPrompt(entry: CatalogCase): string {
  return [
    `Inspect pull request ${entry.natural.title} while it remains held.`,
    'Authorize the existing verdict-only proof operation and preserve the hold. Do not arm, merge, or remove labels.',
    entry.natural.body,
  ].join('\n\n');
}
