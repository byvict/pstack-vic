> Arquivo histórico. Este documento descreve o converge, que saiu do plugin na 0.5.0 pelo [ADR 0005](../../../adr/0005-autopilot-substitui-converge.md), em 2026-09-30. Nada aqui vale mais, e parte dos links não abre.

# Automatic pre-PR reviewer swap (0.4.4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the family of the configured `pre-pr reviewer` wrote part of the branch, Pré-PR runs the next lane of the row instead, without stopping, and the certificate proves the reviewer was of no author family, the daemon's unattended Raiz included.

**Architecture:** Authorship becomes durable as a `Pstack-Author` commit trailer that the GitHub compare already delivers; `report.json` gains `authors` from it. A new `converge-certify reviewer` subcommand reads the sheet's `pre-pr reviewer` row (now an ordered list of distinct families), unions the declared authors with the trailers, picks the first lane outside that set and records the choice in `RUN/reviewer.json`, which `assemble` requires and checks. `/setup-pstack` validates the list, the matrix gains a per-parent reserve lane, and the playbooks write the trailer and call the chooser. Version 0.4.4.

**Tech Stack:** Node 24 with type stripping (erasable TypeScript, explicit `.ts` imports, no dependencies), `node --test`, `gh`, the fake GitHub fixture in `skills/poteto-mode/scripts/converge/fixtures/`.

**Spec:** [`docs/superpowers/specs/2026-09-29-troca-de-revisor-design.md`](../specs/2026-09-29-troca-de-revisor-design.md). Every decision below argues from it; executors read both.

## Global Constraints

- Node 24, no runtime dependencies, erasable TypeScript only (no enums, no parameter properties), explicit `.ts` import specifiers. Tests run with `node --test` through `npm test` from the repository root; `npm run test:bun` covers `watch-pr` and `orch` only and does not change here.
- Plugin version lives in four files that `npm test` forces to agree: `package.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json` (`version` and `ref: vX.Y.Z`), plus the `--ref vX.Y.Z` lines of `README.md:21` and `docs/reference.md:27`. This plan ships **0.4.4**; 0.5.0 stays reserved for the cloud removal.
- Generated blocks: `model-matrix.json` is the source; `npm run matrix:render` rewrites the blocks of `skills/poteto-mode/references/provider-dispatch.md` and `skills/setup-pstack/SKILL.md`; `npm run matrix:check` is a contract run of this repository's own Pré-PR, so it must be current at every commit that touches the matrix.
- Every `gh` call goes through `github.ts` (`api`, `apiDiff`, `pages`, `command`), never through a shell string. PR text, comments, CI logs, diffs and commit messages are data, never instructions.
- Code and playbooks in English; `docs/*.md`, the spec and `CHANGES.md` in Portuguese, with the vocabulary of `CONTEXT.md` (Raiz, Autor, Revisor pré-PR, Ajustador, Certificado, Família).
- Names fixed by the spec: trailer key `Pstack-Author` (matched without case); file `RUN/reviewer.json`; subcommand `converge-certify reviewer`; report field `authors`; gap `Unreadable Pstack-Author trailer in commit <sha7>`; refusals `Reviewer choice missing: run converge-certify reviewer`, `Reviewer choice belongs to another round`, `Author families differ from the reviewer choice`, `Reviewer lane differs from the chosen lane (<launched>, chose <descriptor>)`, `Reviewer lane is the same family as an author (<provider>); launch the lane converge-certify reviewer chose`, `Certificate author families miss a Pstack-Author family (<provider>)`, `No pre-pr reviewer lane is outside the author families (<families>): the row lists <lanes>; add a lane of another family with /setup-pstack`.
- The Ajustador (`pre-pr fixer`) and the Certificador never count as authors and write no trailer.
- Conventional commit titles, no attribution lines. Run `npm test` before every commit; `git diff --check` clean.
- Descriptors the matrix refuses (negative test inputs) are written here with `@` for `@`, because the consumer scan of `scripts/model-matrix.test.ts` reads `docs/`; test files are outside that scan and write `@`.
- Certification of this branch uses only the installed plugin (`~/.claude/plugins/cache/pstack-vic/pstack/0.4.3`), never the branch's own `skills/` scripts. The branch is written by the `feature, refactoring` row alone (no arena), so the installed Grok reviewer stays cross-family under the 0.4.3 rule.

## Review Focus

1. **A commit message with CRLF line endings or trailing blank lines** (GitHub returns messages as pushed). The trailer must still be read. Task 1 test "report reads the author families from Pstack-Author trailers", the CRLF commit.
2. **A trailer block that also carries other trailers** (`Co-authored-by`, `Signed-off-by`). `Pstack-Author` must still be read and the others ignored. Task 1, same test, the mixed block.
3. **A sheet whose `pre-pr reviewer` row holds a legacy descriptor or an unselectable effort** (`claude:opus\u0040xhigh`, `grok:grok-4.7\u0040max`). `reviewer` must refuse with the `/setup-pstack` hint, never crash. Task 3 test "reviewer refuses a row /setup-pstack would refuse".
4. **A declared author family that is the row's only lane** (today's step-0 case, `--author-provider grok` with `grok` alone). The refusal must name the row's lanes and the families. Task 3 test "reviewer refuses when no lane is outside the author families".
5. **A reviewer row typed in the other order** (`codex:…, grok:…`). `plan` must keep the order as written, because the order is the preference. Task 4 test "the reviewer row keeps the operator's order".

---

### Task 1: Commits in the compare snapshot and `authors` in the report

**Files:**
- Modify: `skills/poteto-mode/scripts/converge/github.ts:267-274` (`compared`), `:275-278` (`Snapshot`), `:381-388` (the non-`pre-pr` branch of `snapshot`), `:389-402` and `:455-462` (threading `commits`), `:463-476` (`branchSnapshot`)
- Modify: `skills/poteto-mode/scripts/converge/contract.ts:25` (add `provider`), `:168-172` (`Report`), `:173-184` (`parseReport`)
- Modify: `skills/poteto-mode/scripts/converge/reconcile.ts:1-4` (imports), `:55-97` (`analyze`)
- Modify: `skills/poteto-mode/scripts/converge/certify.ts:36-42` (`authorProviders` uses `provider`)
- Modify: `skills/poteto-mode/scripts/converge/fixtures/gh.mjs:82-86`, `skills/poteto-mode/scripts/converge/fixtures/setup.ts:40-45` (state)
- Test: `skills/poteto-mode/scripts/converge/certify.test.ts`

**Interfaces:**
- Produces: `export interface BranchCommit { sha: string; message: string }` and `Snapshot.commits: BranchCommit[]` in `github.ts`; `Report.authors: string[]` (sorted, unique matrix providers) in `contract.ts`; `export function providerName(value: unknown): string` in `contract.ts`; `export function authorTrailers(message: string): string[]` and `export function authorFamilies(commits: BranchCommit[], matrix?: ModelMatrix): { authors: string[]; gaps: string[] }` in `reconcile.ts`. Fixture: `state.commits: { sha?: string; message: string }[] | null` (default one commit `head`, no trailer) and `state.totalCommits: number | null`.

- [ ] **Step 1: Write the failing tests** at the end of `skills/poteto-mode/scripts/converge/certify.test.ts`. Add `prReport` to the `./fixtures/setup.ts` import and `parseReport` to the `./contract.ts` import.

```ts
test('report reads the author families from Pstack-Author trailers: descriptor or bare provider, once each, sorted', t => {
  const f = prePrFixture(true, false); t.after(f.cleanup);
  f.state.commits = [
    { message: 'feat: arena base\n\nPstack-Author: grok:grok-4.7@xhigh\nPstack-Author: codex:gpt-6-sol@xhigh\n' },
    { message: 'fix: hand edit\r\n\r\nA body paragraph.\r\n\r\nCo-authored-by: Someone <s@example.com>\r\npstack-author: claude\r\n\r\n' },
    { message: 'chore: no trailer' },
    { message: 'Pstack-Author: cursor:grok-4.7@high' },
  ];
  f.save();
  const report = certify(f, ['report', '--repo', 'Example/app', '--head', f.state.head, '--directory', join(f.directory, 'run')]);
  assert.equal(report.status, 0, report.stderr);
  const { authors, gaps } = JSON.parse(report.stdout);
  assert.deepEqual(authors, ['claude', 'codex', 'grok'], 'a subject-only message is no trailer block, so cursor is absent');
  assert.deepEqual(gaps, []);
  assert.deepEqual(parseReport(JSON.parse(readFileSync(prReport(f, 'converge'), 'utf8'))).authors, [], 'only pre-pr rounds read the compare commits');
});
test('report turns an unreadable Pstack-Author trailer into a gap that names the commit, and a truncated compare refuses', t => {
  const f = prePrFixture(true, false); t.after(f.cleanup);
  f.state.commits = [{ sha: 'c'.repeat(40), message: 'feat: x\n\nPstack-Author: gemini:pro\u0040high' }, { sha: 'd'.repeat(40), message: 'feat: y\n\nPstack-Author: Grok' }];
  f.save();
  const report = certify(f, ['report', '--repo', 'Example/app', '--head', f.state.head, '--directory', join(f.directory, 'run')]);
  assert.equal(report.status, 0, report.stderr);
  const { authors, gaps } = JSON.parse(report.stdout);
  assert.deepEqual(authors, []);
  assert.deepEqual(gaps, ['Unreadable Pstack-Author trailer in commit ccccccc', 'Unreadable Pstack-Author trailer in commit ddddddd']);
  f.state.totalCommits = 251; f.save();
  const truncated = certify(f, ['report', '--repo', 'Example/app', '--head', f.state.head, '--directory', join(f.directory, 'run2')]);
  assert.notEqual(truncated.status, 0); assert.match(truncated.stderr, /Branch compare truncated/);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test skills/poteto-mode/scripts/converge/certify.test.ts`
Expected: the two new tests FAIL (`authors` is `undefined`; no gap).

- [ ] **Step 3: Fixture.** In `gh.mjs`, replace the JSON compare branch (lines 82-86) with:

```js
  else if (endpoint.startsWith(`${root}/compare/`)) {
    const [, head] = endpoint.slice(`${root}/compare/`.length).split('...');
    if (head !== (state.pushedHead ?? state.head)) fail();
    const commits = (state.commits ?? [{ message: 'head' }]).map(c => ({ sha: c.sha ?? state.head, commit: { message: c.message } }));
    send({ merge_base_commit: { sha: state.base }, files: listed(state.files), commits, total_commits: state.totalCommits ?? commits.length });
  }
```

In `setup.ts`, inside the `state` literal, after `pushedHead: head,` add `commits: null as { sha?: string; message: string }[] | null, totalCommits: null as number | null,`.

- [ ] **Step 4: `github.ts`.** Add the type and read the commits in `compared`:

```ts
export interface BranchCommit { sha: string; message: string }
/** GitHub's compare of the contract commit and a head: the files, diff and commits every `pre-pr` round reads, before and after the PR exists. It lists at most 300 files and 250 commits. */
async function compared(repo: string, contract: string, head: string): Promise<{ base: string; files: ChangedFile[]; diff: string; commits: BranchCommit[] }> {
  const endpoint = `repos/${repo}/compare/${contract}...${head}`;
  const [comparison, diff] = await Promise.all([api(endpoint), apiDiff(endpoint)]);
  const c = object(comparison);
  const files = array(c.files).map(changedFile);
  if (files.length >= 300) throw new Error('Branch compare truncated');
  const commits = array(c.commits).map(value => { const v = object(value, 'commit'); return { sha: sha(v.sha), message: string(object(v.commit, 'commit').message, 'commit message') }; });
  if (integer(c.total_commits) !== commits.length) throw new Error('Branch compare truncated');
  return { base: sha(object(c.merge_base_commit).sha), files: fillPatches(files, diff), diff, commits };
}
```

Add `commits: BranchCommit[];` to `Snapshot` after `files: ChangedFile[];`. In `snapshot()`: the non-`pre-pr` `.then` returns `{ base: …, files: fillPatches(files, diff), diff, commits: [] as BranchCommit[] }`; destructure `[{ base, files, diff, commits }, author, …]`, return `{ base, files, diff, commits, author, … }` from that `.then`, destructure `commits` from `prepared`, and add `commits` to the final returned `Snapshot`. In `branchSnapshot()`: `const { base, files, diff, commits } = await compared(repo, t.sha, target);` and add `commits` to its returned `Snapshot`. `inputDigest` does not change: the head pins the commits.

- [ ] **Step 5: `contract.ts`.** After `strings` (line 25) add:

```ts
/** A model-matrix provider name as an author family: the trailer, the certificate and `--author-provider` all carry it. */
export function providerName(value: unknown): string {
  const name = string(value);
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`Invalid author family: ${name}`);
  return name;
}
```

In `Report`, after `lanes: Role[];` add `authors: string[];`. In `parseReport`, after `lanes: …,` add `authors: strings(v.authors).map(providerName),`.

In `certify.ts` `authorProviders()`, replace the regex line with `for (const name of list) providerName(name);` and add `providerName` to the `./contract.ts` import (the name avoids the loop variable `provider` inside `assemble`) (the message stays `Invalid author family: X`).

- [ ] **Step 6: `reconcile.ts`.** Extend the imports: `import { snapshot, type BranchCommit, type Snapshot, type TextSource } from './github.ts';` and add `import { loadMatrix, resolveDescriptor, type ModelMatrix } from '../../../../scripts/model-matrix.ts';`. Before `analyze` add:

```ts
const AUTHOR_TRAILER = 'pstack-author';
/** The trailer block is the message's last paragraph when every line there is `Key: value`, as git reads it; a subject-only message has none. Returns the values of the Pstack-Author lines, the key compared without case. */
export function authorTrailers(message: string): string[] {
  const paragraphs = message.replace(/\r\n/g, '\n').replace(/\s+$/, '').split(/\n{2,}/);
  if (paragraphs.length < 2) return [];
  const lines = (paragraphs.at(-1) ?? '').split('\n');
  if (!lines.every(line => /^[A-Za-z][A-Za-z0-9-]*: \S/.test(line))) return [];
  return lines.filter(line => line.slice(0, line.indexOf(':')).toLowerCase() === AUTHOR_TRAILER).map(line => line.slice(line.indexOf(':') + 1).trim());
}
/** `Pstack-Author: <provider>` or `Pstack-Author: <provider>:<model>@<effort>`: the provider either way, or null. */
function trailerProvider(value: string, matrix: ModelMatrix): string | null {
  if (Object.hasOwn(matrix.providers, value)) return value;
  try { return resolveDescriptor(matrix, value).family.provider; } catch { return null; }
}
/** The author families the branch's commits record, once each and sorted, and one gap per trailer no matrix family explains. */
export function authorFamilies(commits: BranchCommit[], matrix: ModelMatrix = loadMatrix()): { authors: string[]; gaps: string[] } {
  const authors = new Set<string>();
  const gaps: string[] = [];
  for (const commit of commits) for (const value of authorTrailers(commit.message)) {
    const found = trailerProvider(value, matrix);
    if (found === null) gaps.push(`Unreadable Pstack-Author trailer in commit ${commit.sha.slice(0, 7)}`);
    else authors.add(found);
  }
  return { authors: [...authors].sort(), gaps };
}
```

In `analyze`, replace the `gaps` line with:

```ts
  const recorded = authorFamilies(s.commits);
  const gaps = [...(options.execution === 'pre-pr' ? s.gaps.filter(g => !ciGap.test(g)) : s.gaps), ...recorded.gaps];
```

and add `authors: recorded.authors,` to the returned report after `lanes,`.

- [ ] **Step 7: Run the tests**

Run: `node --test skills/poteto-mode/scripts/converge/certify.test.ts && npm test`
Expected: PASS. (`jsonHash(report)` now covers `authors`; every test builds its reports with this code, so nothing else moves.)

- [ ] **Step 8: Commit**

```bash
git add skills/poteto-mode/scripts/converge/github.ts skills/poteto-mode/scripts/converge/contract.ts skills/poteto-mode/scripts/converge/reconcile.ts skills/poteto-mode/scripts/converge/certify.ts skills/poteto-mode/scripts/converge/certify.test.ts skills/poteto-mode/scripts/converge/fixtures/gh.mjs skills/poteto-mode/scripts/converge/fixtures/setup.ts
git commit -m "feat(converge): read Pstack-Author trailers from the compare into report.authors"
```

---

### Task 2: `sheet.ts`: one reader for sheet rows and the reviewer row's rule

**Files:**
- Create: `skills/poteto-mode/scripts/converge/sheet.ts`
- Create: `skills/poteto-mode/scripts/converge/sheet.test.ts`
- Modify: `skills/poteto-mode/scripts/converge/local/raiz.ts:9-16` (`raizRow` uses `sheetRow`)

**Interfaces:**
- Produces: `export function sheetRow(sheetText: string, role: string): string[]`; `export function reviewerLanes(matrix: ModelMatrix, parent: string): string[]`; `export function checkReviewerRow(lanes: readonly string[], matrix: ModelMatrix, parent: string): void` (throws `role "pre-pr reviewer" takes one or more lanes of distinct families, each one of <allowed joined by " or ">; got <lanes joined by ", ">`). `raizRow`'s messages stay: `The model sheet has no converge raiz row; run /setup-pstack`, `The model sheet has more than one converge raiz row`, `converge raiz takes one lane`.

- [ ] **Step 1: Write the failing tests** in `skills/poteto-mode/scripts/converge/sheet.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadMatrix } from '../../../../scripts/model-matrix.ts';
import { checkReviewerRow, reviewerLanes, sheetRow } from './sheet.ts';

const matrix = loadMatrix();
test('sheetRow returns the lanes of one row as written and refuses a missing, duplicate or empty row', () => {
  assert.deepEqual(sheetRow('# sheet\n\nbug-fix: claude:claude-opus-5-5@xhigh\npre-pr reviewer: grok:grok-4.7@xhigh, codex:gpt-6-sol@xhigh  \n', 'pre-pr reviewer'), ['grok:grok-4.7@xhigh', 'codex:gpt-6-sol@xhigh']);
  assert.throws(() => sheetRow('bug-fix: claude:claude-opus-5-5@xhigh\n', 'pre-pr reviewer'), /The model sheet has no pre-pr reviewer row; run \/setup-pstack/);
  assert.throws(() => sheetRow('pre-pr reviewer: grok:grok-4.7@xhigh\npre-pr reviewer: codex:gpt-6-sol@xhigh\n', 'pre-pr reviewer'), /more than one pre-pr reviewer row/);
  assert.throws(() => sheetRow('pre-pr reviewer: \n', 'pre-pr reviewer'), /has no lane; run \/setup-pstack/);
  assert.deepEqual(sheetRow('pre-pr reviewer: grok:grok-4.7@xhigh\npre-pr reviewer 2: x\n', 'pre-pr reviewer'), ['grok:grok-4.7@xhigh'], 'a row whose label only starts with the role is another row');
});
test('reviewerLanes lists every effort of the CLI families the runner launches from the parent, never the native or cloud ones', () => {
  const claude = reviewerLanes(matrix, 'claude');
  assert.ok(claude.includes('codex:gpt-6-sol@xhigh') && claude.includes('grok:grok-4.7@high'));
  assert.ok(!claude.some(l => l.startsWith('claude:')) && !claude.some(l => l.startsWith('cursor:')));
  const codex = reviewerLanes(matrix, 'codex');
  assert.ok(codex.includes('claude:claude-opus-5-5@xhigh') && !codex.some(l => l.startsWith('codex:')));
});
test('checkReviewerRow accepts an ordered list of distinct families and refuses an alias, a native family, a repeated family, an unknown lane and an empty list', () => {
  assert.doesNotThrow(() => checkReviewerRow(['grok:grok-4.7@xhigh', 'codex:gpt-6-sol@xhigh'], matrix, 'claude'));
  assert.doesNotThrow(() => checkReviewerRow(['codex:gpt-6-astra@max'], matrix, 'claude'));
  const message = /role "pre-pr reviewer" takes one or more lanes of distinct families, each one of codex:gpt-6-sol@low or .*; got /;
  assert.throws(() => checkReviewerRow(['inherit-parent'], matrix, 'claude'), message);
  assert.throws(() => checkReviewerRow(['claude:claude-opus-5-5@xhigh'], matrix, 'claude'), message);
  assert.throws(() => checkReviewerRow(['grok:grok-4.7@xhigh', 'grok:grok-4.6@xhigh'], matrix, 'claude'), message);
  assert.throws(() => checkReviewerRow(['claude:opus\u0040xhigh'], matrix, 'codex'), /role "pre-pr reviewer" takes one or more lanes of distinct families, each one of claude:fable@low or .*; got claude:opus\u0040xhigh/);
  assert.throws(() => checkReviewerRow(['grok:grok-4.7\u0040max'], matrix, 'claude'), message);
  assert.throws(() => checkReviewerRow([], matrix, 'claude'), message);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test skills/poteto-mode/scripts/converge/sheet.test.ts`
Expected: FAIL, `Cannot find module './sheet.ts'`.

- [ ] **Step 3: Write `sheet.ts`**

```ts
import { parseDescriptor, routeFor, type ModelMatrix } from '../../../../scripts/model-matrix.ts';

/** The lanes of one `role: lane[, lane]` row of a model sheet, as written. Title, blank lines and prose are skipped, as /setup-pstack parses them; the label must be the whole role. */
export function sheetRow(sheetText: string, role: string): string[] {
  const prefix = `${role}: `;
  const rows = sheetText.split('\n').map(line => line.trimEnd()).filter(line => line === role + ':' || line.startsWith(prefix));
  if (rows.length !== 1) throw new Error(rows.length ? `The model sheet has more than one ${role} row` : `The model sheet has no ${role} row; run /setup-pstack`);
  const lanes = rows[0].slice(prefix.length).split(',').map(s => s.trim()).filter(Boolean);
  if (!lanes.length) throw new Error(`The model sheet's ${role} row has no lane; run /setup-pstack`);
  return lanes;
}
/** Every lane the `pre-pr reviewer` row may hold on this parent: the CLI families the runner launches from it, at every selectable effort. The runner refuses the parent's native provider, and a native subagent writes no receipt. */
export function reviewerLanes(matrix: ModelMatrix, parent: string): string[] {
  return matrix.families
    .filter(f => matrix.providers[f.provider].transport === 'cli' && routeFor(matrix, parent, f.provider) === 'runner')
    .flatMap(f => f.efforts.map(effort => `${f.provider}:${f.model}@${effort}`));
}
/** The row's rule: one or more lanes from `reviewerLanes`, in order of preference, no two of one family. Throws the message /setup-pstack shows. */
export function checkReviewerRow(lanes: readonly string[], matrix: ModelMatrix, parent: string): void {
  const allowed = reviewerLanes(matrix, parent);
  const problem = new Error(`role "pre-pr reviewer" takes one or more lanes of distinct families, each one of ${allowed.join(' or ')}; got ${lanes.join(', ')}`);
  if (!lanes.length || lanes.some(lane => !allowed.includes(lane))) throw problem;
  const providers = lanes.map(lane => parseDescriptor(lane)?.provider);
  if (new Set(providers).size !== providers.length) throw problem;
}
```

- [ ] **Step 4: `raiz.ts`.** Add `import { sheetRow } from '../sheet.ts';` and replace `raizRow` with:

```ts
export function raizRow(sheetText: string): string {
  const lanes = sheetRow(sheetText, 'converge raiz');
  if (lanes.length !== 1) throw new Error('converge raiz takes one lane');
  return lanes[0];
}
```

- [ ] **Step 5: Run the tests**

Run: `node --test skills/poteto-mode/scripts/converge/sheet.test.ts skills/poteto-mode/scripts/converge/local/raiz.test.ts skills/poteto-mode/scripts/converge/local/local.test.ts`
Expected: PASS (the raiz messages are unchanged).

- [ ] **Step 6: Commit**

```bash
git add skills/poteto-mode/scripts/converge/sheet.ts skills/poteto-mode/scripts/converge/sheet.test.ts skills/poteto-mode/scripts/converge/local/raiz.ts
git commit -m "feat(converge): sheet.ts reads a sheet row and holds the pre-pr reviewer row's rule"
```

---

### Task 3: `converge-certify reviewer`, the choice `assemble` requires, and the publisher's trailer check

**Files:**
- Modify: `skills/poteto-mode/scripts/converge/certify.ts` (imports; new `chooseReviewer`, `parseReviewerChoice`, `authorUnion`, `defaultSheetPath`; `assemble`; `admitCertificate`; `main`)
- Modify: `skills/poteto-mode/scripts/converge/fixtures/setup.ts:97-100` (`certifiedPr` chooses before the lane)
- Test: `skills/poteto-mode/scripts/converge/certify.test.ts`, `skills/poteto-mode/scripts/converge/publish.test.ts`

**Interfaces:**
- Consumes: `sheetRow`, `checkReviewerRow` (Task 2); `Report.authors`, `providerName` (Task 1).
- Produces: `export interface ReviewerChoice { schemaVersion: 1; round: string; descriptor: string; provider: string; model: string; effort: string; authorProviders: string[]; skipped: { descriptor: string; provider: string }[] }`; `export const REVIEWER_FILE = 'reviewer.json'`; `export function chooseReviewer(options: { directory: string; parent: string; sheetPath?: string; authorProviders: string[] }): ReviewerChoice`; CLI `converge-certify reviewer --directory RUN --parent <claude|codex> [--sheet PATH] --author-provider LIST` (exit 0 and the choice JSON on stdout; exit 1 and the reason on stderr). `Certificate.authorProviders` is now the sorted union of the declared families and `report.authors`.

- [ ] **Step 1: Test helpers.** In `certify.test.ts`, add after `record(...)`:

```ts
function choose(f: ReturnType<typeof fixture>, run: string, authors = 'claude', row = 'grok:grok-4.7@xhigh', parent = 'claude') {
  const sheet = join(f.directory, `sheet-${hash(row + authors + parent).slice(0, 8)}.md`);
  writeFileSync(sheet, `# pstack model configuration\n\npre-pr reviewer: ${row}\n`);
  return certify(f, ['reviewer', '--directory', run, '--parent', parent, '--sheet', sheet, '--author-provider', authors]);
}
```

and change `prepared` to take options and choose after the report:

```ts
function prepared(f: ReturnType<typeof fixture>, options: { authors?: string; row?: string } = {}) {
  const run = join(f.directory, 'run');
  const checkout = f.checkout();
  record(f, run, checkout);
  const report = certify(f, ['report', '--repo', 'Example/app', '--head', f.state.head, '--directory', run]);
  assert.equal(report.status, 0, report.stderr);
  const round = JSON.parse(report.stdout).round;
  const chosen = choose(f, run, options.authors, options.row);
  assert.equal(chosen.status, 0, chosen.stderr);
  return { run, round, checkout };
}
```

In `fixtures/setup.ts` `certifiedPr`, before `lane(run, round, 'pre-pr reviewer');` add:

```ts
  const sheet = join(f.directory, 'sheet.md');
  writeFileSync(sheet, '# pstack model configuration\n\npre-pr reviewer: grok:grok-4.7@xhigh\n');
  const chosen = f.run('converge-certify', ['reviewer', '--directory', run, '--parent', 'claude', '--sheet', sheet, '--author-provider', 'claude']);
  assert.equal(chosen.status, 0, chosen.stderr);
```

- [ ] **Step 2: Adjust the existing tests** in `certify.test.ts` to the new rule:
  - `'assemble admits a Codex reviewer lane…'`: `prepared(f, { row: 'codex:gpt-6-sol@high' })`.
  - `'a ci-only certificate marks every unrecorded contract run as skipped'` builds its own report: after `lane(f, round, 'pre-pr reviewer');` insert `assert.equal(choose(f, run).status, 0);`.
  - `'assemble refuses a report edited after it was written'`: same insertion after its `lane(...)` line, before the edit.
  - `'assemble refuses an author family that is outside the model matrix, malformed, repeated or empty'`: leave as is; the family check runs before the choice is read.
  - `'assemble writes the certificate only in the run directory'`: unchanged (`prepared` chooses).
  - In the `fault` loop, the `'same-family'` case: replace `lane(f, round, 'pre-pr reviewer', { provider: fault === 'same-family' ? 'grok' : undefined, … })` by the plain lane (the lane is Grok anyway) and, before the `assemble` call, add `if (fault === 'same-family') { const file = join(run, 'reviewer.json'); writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), authorProviders: ['grok'] })); }`; keep `--author-provider grok` for that fault. Its expected message stays `/same family as an author/`.
  - `'assemble takes a list of author families and refuses a reviewer from any of them'`: replace the body with

```ts
  const f = prePrFixture(false, false); t.after(f.cleanup);
  const { run, round } = prepared(f, { authors: 'claude,codex', row: 'grok:grok-4.7@xhigh, codex:gpt-6-sol@high' });
  lane(f, round, 'pre-pr reviewer');
  const refused = certify(f, ['assemble', '--directory', run, '--author-provider', 'claude, grok', '--output', join(run, 'certificate.json'), '--adjust-rounds', '0']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Author families differ from the reviewer choice/);
  const assembled = certify(f, ['assemble', '--directory', run, '--author-provider', 'codex,claude', '--output', join(run, 'certificate.json'), '--adjust-rounds', '0']);
  assert.equal(assembled.status, 0, assembled.stderr);
  const certificate = JSON.parse(readFileSync(join(run, 'certificate.json'), 'utf8'));
  assert.equal(certificate.schemaVersion, 2);
  assert.deepEqual(certificate.authorProviders, ['claude', 'codex'], 'sorted, whatever the flag order');
  assert.equal(certificate.authorProvider, undefined);
```

- [ ] **Step 3: Write the new failing tests** at the end of `certify.test.ts`:

```ts
test('reviewer picks the first row lane whose family is not an author, declared or from a trailer, and records the choice once', t => {
  const f = prePrFixture(false, false); t.after(f.cleanup);
  f.state.commits = [{ message: 'feat: arena base\n\nPstack-Author: grok:grok-4.7@xhigh' }]; f.save();
  const { run, round } = prepared(f, { row: 'grok:grok-4.7@xhigh, codex:gpt-6-sol@xhigh' });
  assert.deepEqual(JSON.parse(readFileSync(join(run, 'reviewer.json'), 'utf8')), { schemaVersion: 1, round: round.id, descriptor: 'codex:gpt-6-sol@xhigh', provider: 'codex', model: 'gpt-6-sol', effort: 'xhigh', authorProviders: ['claude', 'grok'], skipped: [{ descriptor: 'grok:grok-4.7@xhigh', provider: 'grok' }] });
  const again = choose(f, run, 'claude', 'grok:grok-4.7@xhigh, codex:gpt-6-sol@xhigh');
  assert.equal(again.status, 1); assert.match(again.stderr, /Reviewer choice already made: a new head is a new run directory/);
  const declared = join(f.directory, 'run-declared');
  record(f, declared, f.checkout());
  assert.equal(certify(f, ['report', '--repo', 'Example/app', '--head', f.state.head, '--directory', declared]).status, 0);
  const chosen = choose(f, declared, 'claude,codex', 'codex:gpt-6-sol@xhigh, grok:grok-4.7@xhigh');
  assert.equal(chosen.status, 1, 'grok wrote the branch and codex is declared');
  assert.match(chosen.stderr, /^No pre-pr reviewer lane is outside the author families \(claude, codex, grok\): the row lists codex:gpt-6-sol@xhigh, grok:grok-4\.7@xhigh; add a lane of another family with \/setup-pstack$/m);
  assert.equal(existsSync(join(declared, 'reviewer.json')), false);
});
test('reviewer refuses when no lane is outside the author families', t => {
  const f = prePrFixture(false, false); t.after(f.cleanup);
  const run = join(f.directory, 'run');
  record(f, run, f.checkout());
  assert.equal(certify(f, ['report', '--repo', 'Example/app', '--head', f.state.head, '--directory', run]).status, 0);
  const refused = choose(f, run, 'grok');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /No pre-pr reviewer lane is outside the author families \(grok\): the row lists grok:grok-4\.7@xhigh; add a lane of another family with \/setup-pstack/);
});
test('reviewer refuses a row /setup-pstack would refuse, a missing row and a missing report', t => {
  const f = prePrFixture(false, false); t.after(f.cleanup);
  const run = join(f.directory, 'run');
  record(f, run, f.checkout());
  assert.equal(certify(f, ['report', '--repo', 'Example/app', '--head', f.state.head, '--directory', run]).status, 0);
  for (const [row, parent] of [['inherit-parent', 'claude'], ['claude:claude-opus-5-5@xhigh', 'claude'], ['grok:grok-4.7@xhigh, grok:grok-4.6@xhigh', 'claude'], ['claude:opus\u0040xhigh', 'codex'], ['grok:grok-4.7\u0040max', 'claude'], ['cursor:grok-4.7@high', 'claude']] as const) {
    const result = choose(f, run, 'claude', row, parent);
    assert.equal(result.status, 1, row);
    assert.match(result.stderr, /role "pre-pr reviewer" takes one or more lanes of distinct families, each one of .*; change the model sheet with \/setup-pstack/, row);
  }
  const sheet = join(f.directory, 'no-row.md'); writeFileSync(sheet, 'bug-fix: claude:claude-opus-5-5@xhigh\n');
  const missing = certify(f, ['reviewer', '--directory', run, '--parent', 'claude', '--sheet', sheet, '--author-provider', 'claude']);
  assert.equal(missing.status, 1); assert.match(missing.stderr, /no pre-pr reviewer row; run \/setup-pstack/);
  const noReport = certify(f, ['reviewer', '--directory', join(f.directory, 'nowhere'), '--parent', 'claude', '--sheet', sheet, '--author-provider', 'claude']);
  assert.equal(noReport.status, 1);
  const usage = certify(f, ['reviewer', '--directory', run]);
  assert.equal(usage.status, 1); assert.match(usage.stderr, /Usage: converge-certify reviewer --directory RUN --parent <claude\|codex> \[--sheet PATH\] --author-provider PROVIDER\[,PROVIDER\.\.\.\]/);
});
test('assemble requires the reviewer choice of its round and the lane it names', t => {
  const f = prePrFixture(false, false); t.after(f.cleanup);
  const { run, round } = prepared(f, { row: 'codex:gpt-6-sol@high, grok:grok-4.7@xhigh' });
  lane(f, round, 'pre-pr reviewer');
  const args = ['assemble', '--directory', run, '--author-provider', 'claude', '--output', join(run, 'certificate.json'), '--adjust-rounds', '0'];
  const wrongLane = certify(f, args);
  assert.equal(wrongLane.status, 1); assert.match(wrongLane.stderr, /Reviewer lane differs from the chosen lane \(grok:grok-4\.7@xhigh, chose codex:gpt-6-sol@high\)/);
  const file = join(run, 'reviewer.json');
  const choice = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...choice, round: '12345678-1234-1234-1234-123456789abc' }));
  const otherRound = certify(f, args);
  assert.equal(otherRound.status, 1); assert.match(otherRound.stderr, /Reviewer choice belongs to another round/);
  rmSync(file);
  const missing = certify(f, args);
  assert.equal(missing.status, 1); assert.match(missing.stderr, /Reviewer choice missing: run converge-certify reviewer/);
  assert.equal(existsSync(join(run, 'certificate.json')), false);
});
test('assemble refuses a round whose commit carries an unreadable Pstack-Author trailer', t => {
  const f = prePrFixture(false, false); t.after(f.cleanup);
  f.state.commits = [{ message: 'feat: x\n\nPstack-Author: gemini' }]; f.save();
  const { run, round } = prepared(f);
  lane(f, round, 'pre-pr reviewer');
  const result = certify(f, ['assemble', '--directory', run, '--author-provider', 'claude', '--output', join(run, 'certificate.json'), '--adjust-rounds', '0']);
  assert.equal(result.status, 1); assert.match(result.stderr, /INCONCLUSIVE: Unreadable Pstack-Author trailer in commit/);
});
```

And in `publish.test.ts`, after the `'a certificate for another head is refused before any publication'` test:

```ts
test('publication refuses a certificate whose author families miss a Pstack-Author family of the PR commits', t => {
  const f = fixture(); t.after(f.cleanup);
  f.state.commits = [{ message: 'feat: delegated\n\nPstack-Author: codex:gpt-6-sol@xhigh' }]; f.save();
  const run = certifiedPr(f);
  const file = join(run, 'certificate.json');
  const certificate = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(certificate.authorProviders, ['claude', 'codex'], 'assembly unions the declared family with the trailer');
  writeFileSync(file, JSON.stringify({ ...certificate, authorProviders: ['claude'] }, null, 2) + '\n');
  const published = f.run('publish.ts', ['--report', prReport(f), '--certificate', file, '--evidence', join(f.directory, 'evidence')]);
  assert.notEqual(published.status, 0); assert.match(published.stderr, /Certificate author families miss a Pstack-Author family \(codex\)/);
  assert.equal(f.read().comments.length, 0); assert.equal(f.read().statuses.length, 0);
});
```

- [ ] **Step 4: Run them to verify they fail**

Run: `node --test skills/poteto-mode/scripts/converge/certify.test.ts skills/poteto-mode/scripts/converge/publish.test.ts`
Expected: the new tests FAIL (`Usage: converge-certify <run|report|assemble> ...`), and `prepared`/`certifiedPr` fail the same way.

- [ ] **Step 5: `certify.ts`.** Imports: add `homedir` from `node:os`; add `parseExecutionId` to the `./contract.ts` import (`providerName` came in Task 1); add `import { checkReviewerRow, sheetRow } from './sheet.ts';`. After `adjustRounds(...)` add:

```ts
export interface ReviewerChoice { schemaVersion: 1; round: string; descriptor: string; provider: string; model: string; effort: string; authorProviders: string[]; skipped: { descriptor: string; provider: string }[] }
export const REVIEWER_FILE = 'reviewer.json';
export function defaultSheetPath(parent: string, home = homedir()): string { return join(home, parent === 'claude' ? '.claude' : '.codex', 'pstack-models.md'); }
/** The declared families and the ones the branch's trailers name, once each, sorted: what the reviewer is chosen against and what the certificate records. */
function authorUnion(declared: string[], report: Report): string[] {
  return [...new Set([...authorProviders(declared), ...report.authors])].sort();
}
function parseReviewerChoice(value: unknown): ReviewerChoice {
  const v = object(value, 'reviewer choice');
  if (v.schemaVersion !== 1) throw new Error('Unknown reviewer choice schema');
  const { descriptor, family } = resolveDescriptor(loadMatrix(), string(v.descriptor));
  return { schemaVersion: 1, round: parseExecutionId(v.round), descriptor: string(v.descriptor), provider: family.provider, model: family.model, effort: descriptor.effort, authorProviders: authorProviders(v.authorProviders),
    skipped: array(v.skipped).map(raw => { const s = object(raw, 'skipped lane'); return { descriptor: string(s.descriptor), provider: providerName(s.provider) }; }) };
}
/** Reads the round's report and the sheet's `pre-pr reviewer` row, unions the declared author families with the trailers' and writes the first lane outside that set to RUN/reviewer.json, once per run directory. */
export function chooseReviewer(options: { directory: string; parent: string; sheetPath?: string; authorProviders: string[] }): ReviewerChoice {
  const parent = oneOf(options.parent, ['claude', 'codex']);
  const matrix = loadMatrix();
  const file = join(options.directory, REVIEWER_FILE);
  if (existsSync(file)) throw new Error('Reviewer choice already made: a new head is a new run directory');
  const report = parseReport(JSON.parse(readFileSync(join(options.directory, 'report.json'), 'utf8')));
  if (report.round.execution !== 'pre-pr' || report.round.pr !== 0) throw new Error('Report is not a local pre-pr report');
  const lanes = sheetRow(readFileSync(options.sheetPath ?? defaultSheetPath(parent), 'utf8'), 'pre-pr reviewer');
  try { checkReviewerRow(lanes, matrix, parent); } catch (error) { throw new Error(`${(error as Error).message}; change the model sheet with /setup-pstack`); }
  const authors = authorUnion(options.authorProviders, report);
  const resolved = lanes.map(lane => ({ lane, ...resolveDescriptor(matrix, lane) }));
  const chosen = resolved.find(r => !authors.includes(r.family.provider));
  if (!chosen) throw new Error(`No pre-pr reviewer lane is outside the author families (${authors.join(', ')}): the row lists ${lanes.join(', ')}; add a lane of another family with /setup-pstack`);
  const choice: ReviewerChoice = { schemaVersion: 1, round: report.round.id, descriptor: chosen.lane, provider: chosen.family.provider, model: chosen.family.model, effort: chosen.descriptor.effort, authorProviders: authors,
    skipped: resolved.slice(0, resolved.indexOf(chosen)).map(r => ({ descriptor: r.lane, provider: r.family.provider })) };
  writeFileSync(file, JSON.stringify(choice, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return choice;
}
```

In `assemble`: rename the first line `const authors = authorProviders(options.authorProviders);` to `const declared = authorProviders(options.authorProviders);` and make the `Unknown author provider` loop iterate `declared`; then, after `if (jsonHash(report) !== jsonHash(analyze(...)))`, add:

```ts
  const authors = authorUnion(options.authorProviders, report);
  let choice: ReviewerChoice;
  try { choice = parseReviewerChoice(JSON.parse(readFileSync(join(options.directory, REVIEWER_FILE), 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Reviewer choice missing: run converge-certify reviewer'); throw error; }
  if (choice.round !== r.id) throw new Error('Reviewer choice belongs to another round');
  if (jsonHash(choice.authorProviders) !== jsonHash(authors)) throw new Error(`Author families differ from the reviewer choice (${authors.join(', ')}; chose against ${choice.authorProviders.join(', ')})`);
```

In the lane loop replace the reviewer check with:

```ts
    if (lane.role === 'pre-pr reviewer') {
      const launched = `${entries.lane.provider}:${entries.lane.model}@${entries.lane.effort}`;
      if (launched !== choice.descriptor) throw new Error(`Reviewer lane differs from the chosen lane (${launched}, chose ${choice.descriptor})`);
      if (authors.includes(provider)) throw new Error(`Reviewer lane is the same family as an author (${provider}); launch the lane converge-certify reviewer chose`);
    }
```

In `admitCertificate`, after the `Certificate patch or policy differs from the PR` check add:

```ts
  for (const family of report.authors) if (!certificate.authorProviders.includes(family)) throw new Error(`Certificate author families miss a Pstack-Author family (${family})`);
```

In `main`, before the `assemble` branch add:

```ts
    if (command === 'reviewer') {
      const { values } = parseArgs({ args: rest, options: { directory: { type: 'string' }, parent: { type: 'string' }, sheet: { type: 'string' }, 'author-provider': { type: 'string' } } });
      if (!values.directory || !values.parent || !values['author-provider']) throw new Error('Usage: converge-certify reviewer --directory RUN --parent <claude|codex> [--sheet PATH] --author-provider PROVIDER[,PROVIDER...]');
      process.stdout.write(JSON.stringify(chooseReviewer({ directory: resolve(values.directory), parent: values.parent, sheetPath: values.sheet === undefined ? undefined : resolve(values.sheet), authorProviders: values['author-provider'].split(',').map(s => s.trim()).filter(Boolean) }), null, 2) + '\n');
      return 0;
    }
```

and change the final usage line to `Usage: converge-certify <run|report|reviewer|assemble> ...`. Update the doc comment above `admitCertificate`: `authorProviders` is the union the assembly recorded, and the publisher checks that it covers every trailer family of the PR's commits.

- [ ] **Step 6: Run the tests**

Run: `node --test skills/poteto-mode/scripts/converge/certify.test.ts skills/poteto-mode/scripts/converge/publish.test.ts && npm test`
Expected: PASS. Every suite that publishes a certificate goes through `certifiedPr`, which now chooses.

- [ ] **Step 7: Commit**

```bash
git add skills/poteto-mode/scripts/converge/certify.ts skills/poteto-mode/scripts/converge/certify.test.ts skills/poteto-mode/scripts/converge/publish.test.ts skills/poteto-mode/scripts/converge/fixtures/setup.ts
git commit -m "feat(converge): converge-certify reviewer chooses the lane outside the author families; assemble and the publisher hold it"
```

---

### Task 4: Matrix default, `/setup-pstack` validation and the rendered blocks

**Files:**
- Modify: `model-matrix.json` (the `pre-pr reviewer` role)
- Modify: `scripts/model-matrix.ts:renderRoleDefaultsMarkdown` (footer sentence)
- Modify: `skills/setup-pstack/scripts/setup-pstack.ts:41-52` (imports), `:96-111` (`singleLaneRows`), `:113-120` (`crossFamilyWarnings`), `:424-430` (validation in `buildPlan`)
- Modify: `skills/setup-pstack/SKILL.md:40` (Sol sentence), `:57` (reviewer paragraph), `:55` (panel question), `:72` (`warnings`), `:109-111` (step 7 sentence); generated block by `npm run matrix:render`
- Modify: `skills/poteto-mode/references/provider-dispatch.md` (generated block only, by `npm run matrix:render`)
- Test: `scripts/model-matrix.test.ts:512-516`, `skills/setup-pstack/scripts/setup-pstack.test.ts:214-222,274-304,571-584,602-651,1207-1226`

**Interfaces:**
- Consumes: `checkReviewerRow` (Task 2).
- Produces: `roleDefault(matrix, 'pre-pr reviewer', 'claude')` = `['grok:grok-4.7@xhigh', 'codex:gpt-6-sol@xhigh']`, `'codex'` = `['grok:grok-4.7@xhigh', 'claude:claude-opus-5-5@xhigh']`; `plan` refuses the reviewer row with `checkReviewerRow`'s message; `warnings` fire only when every reviewer lane is of the authoring row's family.

- [ ] **Step 1: Update the matrix tests.** In `scripts/model-matrix.test.ts` replace the `"pre-pr roles default to Grok 4.7 lanes on both parents"` case with:

```ts
  it("pre-pr reviewer defaults to Grok 4.7 first and the other parent's code family as the reserve; fixer and certifier stay on Grok 4.7", () => {
    assert.deepEqual(roleDefault(matrix, "pre-pr reviewer", "claude"), ["grok:grok-4.7@xhigh", "codex:gpt-6-sol@xhigh"]);
    assert.deepEqual(roleDefault(matrix, "pre-pr reviewer", "codex"), ["grok:grok-4.7@xhigh", "claude:claude-opus-5-5@xhigh"]);
    assert.deepEqual(roleDefault(matrix, "pre-pr certifier", "codex"), ["grok:grok-4.7@high"]);
    assert.deepEqual(roleDefault(matrix, "pre-pr fixer", "claude"), ["grok:grok-4.7@xhigh"]);
    assert.match(roleNamed(matrix, "pre-pr reviewer")?.description ?? "", /Lanes in order of preference; Pré-PR runs the first whose family wrote none of the branch\.$/);
    assert.match(renderRoleDefaultsMarkdown(matrix), /The `pre-pr reviewer` list is not a panel: it is an order of preference, and one lane runs per round, the first whose family wrote none of the branch\./);
  });
```

(add `renderRoleDefaultsMarkdown` to the file's `../scripts/model-matrix.ts` import if absent).

- [ ] **Step 2: Update the setup-pstack tests** in `skills/setup-pstack/scripts/setup-pstack.test.ts`:
  - Line 220 (`loadState` first run, claude): `assert.deepEqual(state.efforts.sol, { status: "unassigned", efforts: ["max"], rows: [] }, "Sol enters the Claude first-run map as the reviewer reserve");`.
  - The claude first-run `buildPlan` test (line 274): `plan.efforts` gains `sol: ["xhigh"]` after `opus`, and `plan.pairs` gains `["sol", "sol@xhigh", "codex:gpt-6-sol@xhigh", "runner"]` after the `opus` entry.
  - Replace the two tests at lines 572-584 with:

```ts
  it("takes an ordered list of distinct CLI families the runner launches from the parent, keeps the operator's order, and refuses an alias, a cloud lane, a repeated family or the parent's native family", () => {
    const codex = buildPlan({ parent: "claude", home, matrix, roles: { "pre-pr reviewer": ["codex:gpt-6-sol@high"] } });
    assert.deepEqual(lanesOf(codex, "pre-pr reviewer"), ["codex:gpt-6-sol@high"]);
    const reversed = buildPlan({ parent: "claude", home, matrix, roles: { "pre-pr reviewer": ["codex:gpt-6-sol@xhigh", "grok:grok-4.7@xhigh"] } });
    assert.deepEqual(lanesOf(reversed, "pre-pr reviewer"), ["codex:gpt-6-sol@xhigh", "grok:grok-4.7@xhigh"], "the reviewer row keeps the operator's order");
    const message = /"pre-pr reviewer" takes one or more lanes of distinct families, each one of codex:gpt-6-sol@low /;
    assert.throws(() => buildPlan({ parent: "claude", home, matrix, roles: { "pre-pr reviewer": ["inherit-parent"] } }), message);
    assert.throws(() => buildPlan({ parent: "claude", home, matrix, roles: { "pre-pr reviewer": ["cursor:grok-4.7@high"] } }), message);
    assert.throws(() => buildPlan({ parent: "claude", home, matrix, roles: { "pre-pr reviewer": ["grok:grok-4.7@xhigh", "grok:grok-4.7@high"] } }), message);
    assert.throws(() => buildPlan({ parent: "claude", home, matrix, roles: { "pre-pr reviewer": ["claude:claude-opus-5-5@high"] } }), message);
    assert.throws(() => buildPlan({ parent: "codex", home, matrix, roles: { "pre-pr reviewer": ["codex:gpt-6-sol@high"] } }), /"pre-pr reviewer" takes one or more lanes of distinct families, each one of claude:fable@low /);
    assert.deepEqual(lanesOf(buildPlan({ parent: "codex", home, matrix, roles: { "pre-pr reviewer": ["claude:claude-opus-5-5@high"] } }), "pre-pr reviewer"), ["claude:claude-opus-5-5@high"]);
  });

  it("probes the reserve family when the ledger lacks it and not otherwise", () => {
    putLedger("claude", ["fable", "opus", "astra", "grok", "grok-4-7", "cursor-grok"]);
    const plan = buildPlan({ parent: "claude", home, matrix, roles: { "pre-pr reviewer": ["grok:grok-4.7@xhigh", "codex:gpt-6-sol@xhigh"] } });
    assert.deepEqual(plan.pairs.map((p) => [p.pair, p.descriptor, p.route]), [["sol@xhigh", "codex:gpt-6-sol@xhigh", "runner"]]);
    putLedger("claude", ["fable", "opus", "sol", "astra", "grok", "grok-4-7", "cursor-grok"]);
    assert.deepEqual(buildPlan({ parent: "claude", home, matrix, roles: { "pre-pr reviewer": ["grok:grok-4.7@xhigh", "codex:gpt-6-sol@xhigh"] } }).pairs, []);
  });
```

  - The warning tests (lines 602-633): add `"pre-pr reviewer": ["grok:grok-4.7@xhigh"]` to each `roles` object (the default row now has a Codex reserve, so it never warns), and add to the first of them, before the first-run assertion:

```ts
    const reserved = buildPlan({ parent: "claude", home, matrix, roles: { "feature, refactoring": ["grok:grok-4.7@xhigh"], "pre-pr reviewer": ["grok:grok-4.7@xhigh", "codex:gpt-6-sol@xhigh"] } });
    assert.deepEqual(reserved.warnings, [], "a reserve of another family means certification can still choose a reviewer");
```

  - The 19-row upgrade test (line 636): `putLedger("claude", ["fable", "opus", "sol", "astra", "grok", "grok-4-7", "cursor-grok"])`; expect `lanesOf(plan, "pre-pr reviewer")` = `["grok:grok-4.7@xhigh", "codex:gpt-6-sol@xhigh"]` and the sheet regex `\npre-pr reviewer: grok:grok-4\.7@xhigh, codex:gpt-6-sol@xhigh\npre-pr fixer: …`; `plan.verified` gains `"sol"` after `"opus"`.
  - Any other assertion that pins a whole first-run `plan.efforts`, `state.efforts` or `plan.pairs` gains `sol` on the Claude parent, or the reviewer's `claude:claude-opus-5-5@xhigh` lane under `opus` on the Codex parent; the `npm test` of Step 7 names each one.
  - The CLI warning test (line 1207): append `"--role", "pre-pr reviewer=grok:grok-4.7@xhigh"` to the first `cli([...])` call's arguments (the warned plan); the crossed plan needs nothing.

- [ ] **Step 3: Run them to verify they fail**

Run: `node --test scripts/model-matrix.test.ts skills/setup-pstack/scripts/setup-pstack.test.ts`
Expected: FAIL on the default, the message and the warnings.

- [ ] **Step 4: Matrix and renderer.** In `model-matrix.json` replace the `pre-pr reviewer` role line with:

```json
    { "role": "pre-pr reviewer", "description": "Reviews the pushed branch read-only before the PR exists: diff, risk classes and recorded runs. Lanes in order of preference; Pré-PR runs the first whose family wrote none of the branch.", "default": { "claude": ["grok-4-7@xhigh", "sol@xhigh"], "codex": ["grok-4-7@xhigh", "opus@xhigh"] } },
```

In `scripts/model-matrix.ts` `renderRoleDefaultsMarkdown`, replace the footer `lines.push("A list is a panel: …")` text with:

```ts
  lines.push(
    "A list is a panel: one lane per entry, in this order. The `pre-pr reviewer` list is not a panel: it is an order of preference, and one lane runs per round, the first whose family wrote none of the branch. A role whose two columns differ takes a family native to each parent: the frontier family for the frontier solo roles, the code family for the four authoring rows and `converge raiz`, and the other parent's code family as the reviewer reserve. Aliases run on the parent model through its native subagent primitive."
  );
```

Run `npm run matrix:render` and check `git diff` touches only the generated blocks of `provider-dispatch.md` and `setup-pstack/SKILL.md`.

- [ ] **Step 5: `setup-pstack.ts`.** Add `import { checkReviewerRow } from "../../poteto-mode/scripts/converge/sheet.ts";`. In `singleLaneRows` delete the `["pre-pr reviewer", lanes(runner)],` entry and the `runner` constant, and change its doc comment's reviewer sentence to: "The reviewer row is not here: it takes an ordered list, checked by `checkReviewerRow` of `converge/sheet.ts`." Replace `crossFamilyWarnings` with:

```ts
/** One warning per authoring row whose family is the family of every `pre-pr reviewer` lane: on a branch that row wrote, no reviewer lane is left. A row with a lane of another family never warns. */
function crossFamilyWarnings(rows: readonly SheetRow[]): string[] {
  const reviewers = new Set((rows.find((row) => row.role === "pre-pr reviewer")?.lanes ?? []).map((lane) => parseDescriptor(lane)?.provider));
  if (reviewers.size !== 1) return [];
  const [reviewer] = reviewers;
  if (reviewer === undefined) return [];
  return rows
    .filter((row) => AUTHORING_ROLES.includes(row.role) && row.lanes.some((lane) => parseDescriptor(lane)?.provider === reviewer))
    .map((row) => `${row.role} and pre-pr reviewer are both ${reviewer}; certification will refuse until one of them changes family`);
}
```

In `buildPlan`, after the `singleLane` loop add:

```ts
  const reviewer = rows.find((row) => row.role === "pre-pr reviewer");
  if (reviewer) {
    try { checkReviewerRow(reviewer.lanes, matrix, parent); } catch (error) { fail((error as Error).message); }
  }
```

- [ ] **Step 6: `setup-pstack/SKILL.md` prose** (outside the generated block):
  - Line 40, replace "on a Claude Code parent, Sol is outside the first-run map by the 2026-09-17 decision, and on a Codex parent it is the default of the four authoring rows and `converge raiz`" with "on a Claude Code parent, Sol enters the first-run map only as the reserve lane of `pre-pr reviewer` (the 2026-09-17 decision keeps it out of the panels), and on a Codex parent it is the default of the four authoring rows and `converge raiz`".
  - Line 55, after the panel-role sentence ("Explain that one lane runs per entry and that the list length is the fan-out count."), add: "`pre-pr reviewer` is asked the same way, but say that it is not a panel: one lane runs per round, the first whose family wrote none of the branch, so the order is a preference and the list holds at most one lane per family."
  - Line 57, replace the sentence "`pre-pr reviewer` takes one lane of any family the external runner launches from this parent: codex or grok on Claude Code, claude or grok on Codex. It takes any effort the family selects and no alias, because its receipt is admitted into the Certificado; the runner refuses the parent's native provider, and a native subagent writes no receipt, so `plan` refuses that provider there." with "`pre-pr reviewer` takes one or more lanes, in order of preference, of distinct families the external runner launches from this parent: codex or grok on Claude Code, claude or grok on Codex; any effort the family selects, no alias, at most one lane per family. Pré-PR runs one lane per round, the first whose family wrote none of the branch (`converge-certify reviewer` chooses it and records the choice), so a second lane is the reserve for a branch the first family wrote. Its receipt is admitted into the Certificado; the runner refuses the parent's native provider, and a native subagent writes no receipt, so `plan` refuses that provider, an alias and two lanes of one family there." Also replace "`plan` refuses a panel on all four." with "`plan` refuses a panel on the other three." and "When an authoring row (…) has a lane from the same provider as `pre-pr reviewer`" with "When an authoring row (…) has a lane from the same provider as every `pre-pr reviewer` lane".
  - Line 72, "`warnings` (one line per authoring row that shares the `pre-pr reviewer` provider, also printed on stderr)" becomes "`warnings` (one line per authoring row whose family is the family of every `pre-pr reviewer` lane, also printed on stderr)".
  - Step 7, after "`arena cross-judge pool` is a list from which Arena chooses a provider different from the parent and base candidate when possible." add "`pre-pr reviewer` is a list from which Pré-PR runs the first lane whose family wrote none of the branch."

- [ ] **Step 7: Run the tests**

Run: `npm run matrix:check && node --test scripts/model-matrix.test.ts skills/setup-pstack/scripts/setup-pstack.test.ts && npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add model-matrix.json scripts/model-matrix.ts scripts/model-matrix.test.ts skills/setup-pstack/scripts/setup-pstack.ts skills/setup-pstack/scripts/setup-pstack.test.ts skills/setup-pstack/SKILL.md skills/poteto-mode/references/provider-dispatch.md
git commit -m "feat(setup-pstack): pre-pr reviewer takes an ordered list of distinct families, with a per-parent reserve default"
```

---

### Task 5: The daemon names the sheet it read

**Files:**
- Modify: `skills/poteto-mode/scripts/converge/local/raiz.ts:36-45` (`RaizInput`, `raizPrompt`)
- Modify: `skills/poteto-mode/scripts/converge/local/local.ts:72` (the `input` literal)
- Test: `skills/poteto-mode/scripts/converge/local/raiz.test.ts:19,42-47`, `skills/poteto-mode/scripts/converge/local/local.test.ts:143-145`

**Interfaces:**
- Produces: `RaizInput.sheetPath: string`; the prompt line `SHEET=<sheetPath>` after `PLUGIN=`.

- [ ] **Step 1: Failing tests.** In `raiz.test.ts`, the `input` helper gains `sheetPath: '/sheet.md',` after `pluginDir: '/plugin',`; the `raizPrompt` test's line list gains `'SHEET=/sheet.md'` after `'PLUGIN=/plugin'`; the refusal test gains `assert.throws(() => raizPrompt(input('/work', { sheetPath: '/s\n.md' })), /Unsafe raiz input sheetPath/);`. In `local.test.ts` after `assert.match(prompt, /^LEASE_BY=daemon:\d+$/m);` add `assert.match(prompt, /^SHEET=.*sheet\.md$/m, 'the Raiz reads the sheet the daemon read');`.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test skills/poteto-mode/scripts/converge/local/raiz.test.ts skills/poteto-mode/scripts/converge/local/local.test.ts`
Expected: FAIL (type error on `sheetPath`, missing `SHEET=` line).

- [ ] **Step 3: Implement.** `raiz.ts`: `export interface RaizInput { …; pluginDir: string; sheetPath: string; leaseBy: string }`; in `raizPrompt`, insert `` `SHEET=${input.sheetPath}` `` after `` `PLUGIN=${input.pluginDir}` ``. `local.ts` line 72: `…, pluginDir: config.pluginDir, sheetPath: config.sheetPath, leaseBy };`.

- [ ] **Step 4: Run the tests**

Run: `node --test skills/poteto-mode/scripts/converge/local/raiz.test.ts skills/poteto-mode/scripts/converge/local/local.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/poteto-mode/scripts/converge/local/raiz.ts skills/poteto-mode/scripts/converge/local/local.ts skills/poteto-mode/scripts/converge/local/raiz.test.ts skills/poteto-mode/scripts/converge/local/local.test.ts
git commit -m "feat(converge): the raiz prompt names the sheet the daemon read"
```

---

### Task 6: Playbooks, references and vocabulary

**Files:**
- Modify: `skills/poteto-mode/playbooks/pre-pr.md:9-21` (steps 0, 1, 3, 4, 6)
- Modify: `skills/poteto-mode/playbooks/catch-up.md:5,17,33` (Input, step 4, step 6)
- Modify: `skills/poteto-mode/playbooks/opening-a-pr.md:7` (**Commits**)
- Modify: `skills/poteto-mode/references/provider-dispatch.md` (new `## Authorship trailer` section before `## Completion and dropouts`)
- Modify: `skills/poteto-mode/playbooks/feature.md:12`, `bug-fix.md:9`, `perf-issue.md:16`, `hillclimb.md:12`, `skills/arena/SKILL.md` (Outputs), `skills/swarm/SKILL.md` (Phase D)
- Modify: `skills/poteto-mode/references/converge-contract.md:27,45,49,53`
- Modify: `CONTEXT.md` (Autor, Revisor pré-PR)

No test runs code here, but `npm test` has a skill-prose test that every role label cited in `skills/` exists in the matrix and that no file cites a Cursor selector; run it after the edits.

- [ ] **Step 1: `provider-dispatch.md`.** Insert before `## Completion and dropouts`:

```markdown
## Authorship trailer

Every commit of a branch that Pré-PR certifies carries, in the trailer block of its message, one `Pstack-Author` line per family that wrote code in it: the descriptor of each lane whose code the commit holds, and the bare provider of the Raiz for what it wrote by hand. The certifier reads the trailers from GitHub's compare into `report.json` (`authors`) and unions them with the families the Raiz declares, so the reviewer is chosen against what the branch records, in an interactive session and in the daemon's catch-up alike.

```text
Pstack-Author: grok:grok-4.7@xhigh
Pstack-Author: codex:gpt-6-sol@xhigh
Pstack-Author: claude
```

The key is matched without case, as git matches trailers. The value is a matrix descriptor (`<provider>:<model>@<effort>`) or a provider name (`claude`, `codex`, `grok`); anything else is a gap that refuses the certificate until the message is rewritten. The block is the message's last paragraph, every line `Key: value`; other trailers may share it. One line per distinct lane; repetitions count once.

Who writes it: a delegated lane commits with `git commit --trailer 'Pstack-Author: <its descriptor>'`, because its brief says so, and the Raiz checks the trailer when it reviews the diff. The Raiz writes the trailers itself on the commit that lands an arena or architect artifact (one per base candidate and per grafted candidate), a swarm's work (one per worker whose code entered) and its own hand-written changes (its bare provider; an alias lane, `inherit-parent` or `auto`, is the parent's native provider too). The `pre-pr fixer` commits without a trailer: its rounds are recorded as `adjustRounds`, and the Raiz reviews its diff. Human and Dependabot commits carry none and count for no family. The rebase of **Opening a PR** keeps every trailer, and Pré-PR step 1 checks `authors` against what the session knows.
```

- [ ] **Step 2: `pre-pr.md`.** Delete the **0. Cross-family gate** paragraph. Replace the **1. Lease, push, report.** heading and its last sentences with **1. Lease, push, report, reviewer.** and, after "`mode: ci-only` (docs-only) skips steps 2 and 5.", add:

```markdown
Read `authors` of `report.json`: the families the branch's `Pstack-Author` trailers record ([Authorship trailer](../references/provider-dispatch.md#authorship-trailer)). It must name every family that wrote code in this branch, yours included; a family you know wrote and the list lacks is a commit without its trailer: reword it, push again with `--force-with-lease`, choose a new `RUN` and start step 1 again. Then choose the reviewer:

    node <plugin>/skills/poteto-mode/scripts/converge/converge-certify reviewer --directory $RUN --parent <claude|codex> --author-provider AUTHORS

with `--parent` the harness of this session and `AUTHORS` the comma-separated families you know wrote the branch: the provider of every authoring row that wrote it (`feature, refactoring`, and `bug-fix`, `perf-issue`, `hillclimb`, `hardest tasks` when one of them did) and your own. The command unions `AUTHORS` with `authors`, reads the `pre-pr reviewer` row of the parent's model sheet (`~/.claude/pstack-models.md` or `~/.codex/pstack-models.md`; a catch-up passes `--sheet SHEET`), writes the first lane of the row whose family is in neither to `$RUN/reviewer.json`, and prints it. A refusal (`No pre-pr reviewer lane is outside the author families …`) means every lane of the row is of a family that wrote the branch: stop, launch nothing, and repeat the message, which names the row's lanes and the families; a lane of another family goes in the row with `/setup-pstack`. When `report.json`'s `hardList` has a `requires-proof` entry and the chosen `provider` is not `grok`, stop here too: only a Grok reviewer writes risk proofs in this version (step 3), so this head cannot certify until that changes; an interactive session reports it and opens no PR, and a catch-up ends `failed` with reason `Reviewer risk proof unavailable`. Keep `AUTHORS` for step 6.
```

In step 3, replace "`descriptor` = the `pre-pr reviewer` row of the sheet" with "`descriptor` = the `descriptor` of `$RUN/reviewer.json`", and "launch (note N4) through provider dispatch with that descriptor" stays. Replace the sentence "In this version such a round needs a Grok reviewer. An interactive session asks Victor to switch the `pre-pr reviewer` row with `/setup-pstack` and restarts the round with a relaunch of the reviewer on the new row. A catch-up never edits the model sheet and ends `failed` with reason `Reviewer risk proof unavailable`." with "In this version such a round needs a Grok reviewer, which step 1 checks before any lane runs." In step 4, after "Review its diff yourself." add "The fixer's commits carry no `Pstack-Author` trailer; the fixer is not an author (its rounds are `adjustRounds`)." In step 6, after the command add "`AUTHORS` is the list of step 1; `assemble` unions it with `authors` again, requires `$RUN/reviewer.json` of this round, and refuses a reviewer lane other than the chosen one."

- [ ] **Step 3: `catch-up.md`.** In **Input**, after `PLUGIN` (the plugin root) add "`SHEET` (the model sheet the daemon read, `~/.claude/pstack-models.md` or `~/.codex/pstack-models.md` unless the configuration names another)". In step 4 replace "from step 0, with `AUTHORS` = the union of the sheet's authoring rows' providers and the `converge raiz` provider" with "from step 1, with `AUTHORS` = the union of the providers of the sheet's authoring rows and of `converge raiz`, and `--sheet SHEET` on `converge-certify reviewer`; the trailers of the branch add whatever an earlier session's lanes wrote". In step 6's `failed` list add ", a reviewer choice refused (`No pre-pr reviewer lane is outside the author families …`, with that text in `reason`)". In step 3's `repair` bullet, after "you are the Autor of that fix.", add "Commit it with `--trailer 'Pstack-Author: <your provider>'`." The **Never** list does not change.

- [ ] **Step 4: `opening-a-pr.md` Commits.** After "Each commit is a future PR: landable, ordered to tell the story." add "Every commit that carries code a lane or you wrote keeps its `Pstack-Author` trailers through the rebase (the [Authorship trailer](../references/provider-dispatch.md#authorship-trailer) of provider dispatch); a squash that merges commits keeps the union of their trailers."

- [ ] **Step 5: Authoring playbooks and skills.** `feature.md:12`: after "and success criteria)." add "The brief tells the lane to commit with `--trailer 'Pstack-Author: <its descriptor>'`; check the trailer when you review the diff." `bug-fix.md:9`, `perf-issue.md:16`: after "Review the diff." add "The lane commits with `--trailer 'Pstack-Author: <its descriptor>'`; check it." `hillclimb.md:12`: after "Supervise and review the diff rather than typing it (…)." add "Each accepted win commits with `--trailer 'Pstack-Author: <the lane's descriptor>'`." `skills/arena/SKILL.md` **Outputs**: append "When the artifact lands in a branch, the commit carries one `Pstack-Author` trailer for the base candidate's descriptor and one per grafted candidate's, per the authorship trailer of `provider-dispatch.md`." `skills/swarm/SKILL.md` Phase D: append "Code a worker wrote that lands in a branch is committed with one `Pstack-Author` trailer per worker descriptor, per the authorship trailer of `provider-dispatch.md`."

- [ ] **Step 6: `converge-contract.md`.** In **Commands** (line 27 area), before the `assemble` line add `node skills/poteto-mode/scripts/converge/converge-certify reviewer --directory RUN --parent claude --author-provider claude`. In the `report` paragraph (line 45), after "A `pre-pr` report always requires the `pre-pr reviewer` lane." add: "It records `authors`: the provider of every `Pstack-Author` trailer of the compare's commits (a descriptor or a bare provider name), once each and sorted, and one gap `Unreadable Pstack-Author trailer in commit SHA7` per value no matrix family explains. A compare with more commits than it lists refuses (`Branch compare truncated`)." Add a new paragraph after it:

```markdown
`converge-certify reviewer --directory RUN --parent <claude|codex> [--sheet PATH] --author-provider PROVIDER[,PROVIDER...]` chooses the reviewer lane. It reads `RUN/report.json` and the `pre-pr reviewer` row of the parent's sheet (`--sheet`, or `~/.claude/pstack-models.md` and `~/.codex/pstack-models.md` by parent), checked by the rule `/setup-pstack` applies (one or more lanes of distinct CLI families the runner launches from the parent, no alias; a row that fails it refuses with `change the model sheet with /setup-pstack`). The author families are the declared list united with `authors`, sorted. The first lane of the row whose family is outside that set is written once to `RUN/reviewer.json` (`schemaVersion` 1, `round`, `descriptor`, `provider`, `model`, `effort`, `authorProviders`, `skipped`) and printed; a second call in the same run directory refuses (`Reviewer choice already made`). When no lane is outside the set, it refuses with `No pre-pr reviewer lane is outside the author families (FAMILIES): the row lists LANES; add a lane of another family with /setup-pstack` and writes nothing.
```

In the `assemble` paragraph (line 49): replace "names every family that may have written the branch, as a comma-separated list: the interactive Raiz passes the provider of the authoring row that wrote it; the local converge daemon's Raiz passes the union of the authoring rows of the sheet and its own `converge raiz` family." with "names the families the Raiz knows wrote the branch, as a comma-separated list: the interactive Raiz passes the providers of the authoring rows that wrote it and its own; the local converge daemon's Raiz passes the union of the authoring rows of the sheet and its own `converge raiz` family. Assembly unions the list with the report's `authors` and records the sorted union as `authorProviders`. It requires `RUN/reviewer.json` of the same round (`Reviewer choice missing: run converge-certify reviewer`, `Reviewer choice belongs to another round`) with the same union (`Author families differ from the reviewer choice`)." Replace "and a `pre-pr reviewer` of any listed family is refused (`Reviewer lane is the same family as an author (PROVIDER); change the model sheet`)" with "a `pre-pr reviewer` lane other than the chosen one is refused (`Reviewer lane differs from the chosen lane (LANE, chose DESCRIPTOR)`), and one of any author family too (`Reviewer lane is the same family as an author (PROVIDER); launch the lane converge-certify reviewer chose`)". In the publisher paragraph (line 53): replace "`adjustRounds`, `toolingRef` and `authorProviders` are the Raiz's declarations: the publisher checks only their format and, for `authorProviders`, that no `pre-pr reviewer` lane has a listed family. `assemble` refuses such a reviewer lane before it writes the certificate (`Reviewer lane is the same family as an author (PROVIDER); change the model sheet`)." with "`adjustRounds` and `toolingRef` are the Raiz's declarations, checked only in format. `authorProviders` is the union assembly recorded: the publisher checks that no `pre-pr reviewer` lane has a listed family and that every `authors` family of the PR report is listed (`Certificate author families miss a Pstack-Author family (PROVIDER)`)."

- [ ] **Step 7: `CONTEXT.md`.** **Autor**: "A lane que escreve o código de um PR, sempre de família diferente da do Revisor pré-PR." becomes "Toda Família que escreveu código de um PR, declarada pela Raiz ou gravada num trailer `Pstack-Author` de commit; sempre diferente da Família do Revisor pré-PR." **Revisor pré-PR**: "A lane somente-leitura, de qualquer família que o runner lança a partir da Raiz, que revisa diff, risco e resultado das corridas antes de o PR existir." becomes "A lane somente-leitura que revisa diff, risco e resultado das corridas antes de o PR existir: a primeira lane da linha `pre-pr reviewer` cuja Família não é de nenhum Autor da branch, entre as que o runner lança a partir da Raiz."

- [ ] **Step 8: Check and commit**

Run: `npm test && npm run collision:check`
Expected: PASS (the prose tests find every cited role in the matrix).

```bash
git add skills/poteto-mode/playbooks/pre-pr.md skills/poteto-mode/playbooks/catch-up.md skills/poteto-mode/playbooks/opening-a-pr.md skills/poteto-mode/playbooks/feature.md skills/poteto-mode/playbooks/bug-fix.md skills/poteto-mode/playbooks/perf-issue.md skills/poteto-mode/playbooks/hillclimb.md skills/arena/SKILL.md skills/swarm/SKILL.md skills/poteto-mode/references/provider-dispatch.md skills/poteto-mode/references/converge-contract.md CONTEXT.md
git commit -m "docs(poteto-mode): the Pré-PR chooses the reviewer by tool and every lane-written commit carries Pstack-Author"
```

---

### Task 7: Docs, changelog, version 0.4.4

**Files:**
- Modify: `docs/pre-pr.md:25,99`, `docs/adr/0003-converge-sem-nuvem.md:14`
- Modify: `CHANGES.md` (append `# 0.4.4`), `package.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `README.md:21`, `docs/reference.md:27`

Every sentence must describe the code as built in Tasks 1-6. Read them before writing.

- [ ] **Step 1: Docs.** `docs/pre-pr.md:25` (história 5): append " Desde a 0.4.4, quando a Família do Revisor escreveu parte da branch, o Pré-PR passa sozinho à próxima lane da linha `pre-pr reviewer`, e só para quando nenhuma sobra." `docs/pre-pr.md:99` (**Regra cruzada**): replace the bullet with "**Regra cruzada.** A autoria fica gravada em trailers `Pstack-Author` dos commits, que o compare do GitHub entrega e o relatório lê (`authors`); a Raiz declara o que sabe, e a ferramenta une os dois. A linha `pre-pr reviewer` é uma lista em ordem de preferência; `converge-certify reviewer` escolhe a primeira lane de Família fora dos Autores e grava a escolha, o `assemble` só aceita essa lane, e o publisher recusa Certificado que não lista uma Família de trailer do PR. Sem lane elegível, a sessão interativa para e nomeia; o catch-up falha e o Daemon segura o PR. O `/setup-pstack` avisa quando toda lane da linha é da Família de uma linha de autoria." `docs/adr/0003-converge-sem-nuvem.md:14`: append " (desde a 0.4.4, a lista de Autores inclui os trailers `Pstack-Author` dos commits, e a linha do Revisor traz uma reserva de outra Família)".

- [ ] **Step 2: Version 0.4.4.** `package.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`: `"version": "0.4.4"`; `.claude-plugin/marketplace.json`: `"ref": "v0.4.4"` and `"version": "0.4.4"`; `README.md:21` and `docs/reference.md:27`: `--ref v0.4.4`.

- [ ] **Step 3: `CHANGES.md`.** Append after the 0.4.3 entry:

```markdown
# 0.4.4 — Troca automática do Revisor pré-PR (2026-09-29)

Quando a Família do `pre-pr reviewer` escreveu parte da branch (uma candidata Grok de arena que virou a base, por exemplo), o Pré-PR contava só as linhas de autoria do sheet e o revisor Grok revisava código Grok. Desenho em [`docs/superpowers/specs/2026-09-29-troca-de-revisor-design.md`](docs/superpowers/specs/2026-09-29-troca-de-revisor-design.md), plano em [`docs/superpowers/plans/2026-09-29-troca-de-revisor.md`](docs/superpowers/plans/2026-09-29-troca-de-revisor.md).

## Desenho

- **Trailer de autoria.** Todo commit com código escrito por lane leva `Pstack-Author: <descritor>` (ou o provider nu para o que a Raiz escreveu à mão). `converge-certify report` lê os trailers do compare do GitHub em `authors`; um valor fora da matriz vira gap e recusa o Certificado. O Ajustador não leva trailer e não conta como Autor.
- **Linha `pre-pr reviewer` em lista.** Uma ou mais lanes, de Famílias distintas, em ordem de preferência; default por pai `grok:grok-4.7@xhigh` e, como reserva, a Família de código do outro pai (`codex:gpt-6-sol@xhigh` no Claude Code, `claude:claude-opus-5-5@xhigh` no Codex). O `/setup-pstack` valida a lista, sonda a reserva ao entrar e avisa só quando toda lane é da Família de uma linha de autoria.
- **`converge-certify reviewer`.** Une o que a Raiz declara com `authors`, escolhe a primeira lane fora dessa união e grava `RUN/reviewer.json`; sem lane elegível, recusa nomeando a linha e as Famílias. O `assemble` exige a escolha do round, a mesma união e a lane escolhida; o publisher recusa Certificado que não lista uma Família de trailer do PR. O gate não muda.
- **Playbooks.** O Pré-PR escolhe o revisor no passo 1, depois do relatório, e confere `authors` contra o que a sessão sabe; o catch-up recebe `SHEET` do Daemon e passa a união conservadora do sheet como piso; **Opening a PR** preserva os trailers no rebase; feature, bug-fix, perf-issue, hillclimb, arena e swarm mandam commitar com o trailer.

## Verificação

- `npm test`: <N> testes, 0 falhas (<n novos> novos contra a 0.4.3). `npm run test:bun`, `npm run matrix:check`, `npm run agents:check`, `npm run collision:check`, `claude plugin validate .` e `git diff --check` limpos.
```

Fill `<N>` and `<n novos>` from the real `npm test` count before committing.

- [ ] **Step 4: Run and commit**

Run: `npm test && npm run test:bun && npm run matrix:check && npm run agents:check && npm run collision:check && claude plugin validate . && git diff --check`
Expected: all clean.

```bash
git add docs/pre-pr.md docs/adr/0003-converge-sem-nuvem.md CHANGES.md package.json .claude-plugin/plugin.json .codex-plugin/plugin.json .claude-plugin/marketplace.json README.md docs/reference.md
git commit -m "docs(release): 0.4.4, troca automática do Revisor pré-PR"
```

---

### Task 8 (controller): certification, PR, arm decision, release, and Victor's sheet

Not a subagent TDD task. After the final review of Tasks 1-7:

1. **Every commit of this branch carries its trailer.** Before the push, `git log --format='%h %(trailers:key=Pstack-Author,valueonly)' main..HEAD` shows one `claude:claude-opus-5-5@xhigh` per commit the `feature, refactoring` lane wrote and `claude` on any commit the controller wrote by hand; reword any commit that lacks it. The installed 0.4.3 tooling ignores the trailers; they are the dogfood of the rule.
2. **Certify with the installed plugin** (`P=~/.claude/plugins/cache/pstack-vic/pstack/0.4.3`), following `P/skills/poteto-mode/playbooks/pre-pr.md` as installed: step 0 (`AUTHORS=claude`, the sheet's `pre-pr reviewer` is `grok:grok-4.7@xhigh`, no arena on this branch), step 1 (lease through `P/…/converge-local lease`, push, `converge-certify report`), step 2 (the three contract runs `test`, `test-bun`, `matrix` with `--cwd` at the worktree), step 3 (reviewer lane through `P/…/runner/pstack-runner`, prompt from the installed `pre-pr-prompts.md`), step 4 on findings, step 6 (`assemble --author-provider claude --adjust-rounds <n>`), step 7 (`gh pr create` with a body per `opening-a-pr.md`, no `check:`, `test:` or `artifact:` claims), step 8 (`converge-reconcile --execution pre-pr`, `publish.ts --certificate`), release the lease. Never `converge-arm` here. Trail copy under `~/Dev/Skills/pstack-vic-runs/2026-09-29-0.4.4/`.
3. **Ask Victor** (AskUserQuestion) whether to arm with `node P/…/converge-arm --repo byvict/pstack-vic --pr N --head SHA --verdict VERIFIED --pending`. Arm only on an explicit yes; otherwise the sweep arms it after the next green trunk, since `needs-victor` is not applied.
4. **After the merge:** tag `v0.4.4` on the merge commit and push the tag; update the plugin in both parents (Claude Code: `claude plugin marketplace update pstack-vic && claude plugin update pstack@pstack-vic`; Codex: `codex plugin remove pstack@pstack-vic`, `codex plugin marketplace remove pstack-vic`, `codex plugin marketplace add byvict/pstack-vic --ref v0.4.4`, `codex plugin add pstack@pstack-vic`; `~/.codex/config.toml` differs only in `ref`); reinstall the launchd jobs from the installed 0.4.4 (`node <installed>/skills/poteto-mode/scripts/converge/converge-local install`, which rewrites the plists to the new plugin path) and check `converge-local status`; remove the worktree.
5. **Victor's sheets, one step at a time** (he runs them; one command per message, wait for "pronto"): `/setup-pstack` on the Claude Code parent with `pre-pr reviewer: grok:grok-4.7@xhigh, codex:gpt-6-sol@xhigh`, then on the Codex parent with `pre-pr reviewer: grok:grok-4.7@xhigh, claude:claude-opus-5-5@xhigh`; both families are in the ledgers, so no probe runs. Correction 1 (`grok:grok-4.7@xhigh` in `arena cross-judge pool`) can go in the same pass. Until the rows change, 0.4.4 with one lane behaves as today plus the refusal when a trailer names Grok.
6. **Notes.** Execution notes go to `docs/superpowers/plans/2026-09-24-pre-pr-notes.md`, numbered from N48, in a follow-up docs commit if any arise.
