import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillPatches, type ChangedFile } from './github.ts';

const diff = [
  'diff --git a/docs/guide.md b/docs/guide.md', 'index 1111111..2222222 100644', '--- a/docs/guide.md', '+++ b/docs/guide.md', '@@ -1 +1 @@', '-old', '+new',
  'diff --git a/docs/big.md b/docs/big.md', 'index 3333333..4444444 100644', '--- a/docs/big.md', '+++ b/docs/big.md',
  '@@ -1,3 +1,3 @@', ' one', '-two', '+deux', ' three', '@@ -40,2 +40,3 @@ section', ' forty', '+inserted', ' forty-one', '\\ No newline at end of file',
  'diff --git a/assets/logo.png b/assets/logo.png', 'index 5555555..6666666 100644', 'Binary files a/assets/logo.png and b/assets/logo.png differ',
  'diff --git a/docs/old.md b/docs/new.md', 'similarity index 90%', 'rename from docs/old.md', 'rename to docs/new.md', 'index 7777777..8888888 100644', '--- a/docs/old.md', '+++ b/docs/new.md', '@@ -1 +1 @@', '-before', '+after',
  'diff --git a/docs/moved.md b/docs/kept.md', 'similarity index 100%', 'rename from docs/moved.md', 'rename to docs/kept.md',
].join('\n') + '\n';
const file = (path: string, patch: string | null, status = 'modified', previous: string | null = null): ChangedFile => ({ path, previous, patch, status });

test('fillPatches gives a patchless file its hunks from the full diff and leaves every other file as it was', () => {
  const files = [
    file('docs/guide.md', 'kept'), file('docs/big.md', null), file('assets/logo.png', null),
    file('docs/new.md', null, 'renamed', 'docs/old.md'), file('docs/kept.md', null, 'renamed', 'docs/moved.md'), file('docs/absent.md', null, 'added'),
  ];
  assert.deepEqual(fillPatches(files, diff), [
    file('docs/guide.md', 'kept'),
    file('docs/big.md', '@@ -1,3 +1,3 @@\n one\n-two\n+deux\n three\n@@ -40,2 +40,3 @@ section\n forty\n+inserted\n forty-one\n\\ No newline at end of file'),
    file('assets/logo.png', null),
    file('docs/new.md', '@@ -1 +1 @@\n-before\n+after', 'renamed', 'docs/old.md'),
    file('docs/kept.md', null, 'renamed', 'docs/moved.md'),
    file('docs/absent.md', null, 'added'),
  ]);
  assert.equal(files[1]?.patch, null, 'the input list is not mutated');
});
test('fillPatches matches the whole section header, so a renamed section is found only through its previous path', () => {
  assert.deepEqual(fillPatches([file('docs/new.md', null, 'added'), file('docs/big', null)], diff), [file('docs/new.md', null, 'added'), file('docs/big', null)]);
});
