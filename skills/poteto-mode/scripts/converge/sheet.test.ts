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
  assert.throws(() => checkReviewerRow(['claude:opus@xhigh'], matrix, 'codex'), /role "pre-pr reviewer" takes one or more lanes of distinct families, each one of claude:fable@low or .*; got claude:opus@xhigh/);
  assert.throws(() => checkReviewerRow(['grok:grok-4.7@max'], matrix, 'claude'), message);
  assert.throws(() => checkReviewerRow([], matrix, 'claude'), message);
});
