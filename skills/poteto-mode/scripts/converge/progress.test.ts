import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { init, record } from './progress.ts';

test('progress records one writer, two repairs and an immutable event id', t => {
  const directory = mkdtempSync(join(tmpdir(), 'converge-progress-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const head = 'a'.repeat(40);
  const owner = { repo: 'Example/app', pr: 1, agentId: 'bc_1', runId: 'run_1', head };
  assert.equal(init(directory, owner, 0).repairs, 0);
  assert.equal(init(directory, owner, 1).ownerAgentId, 'bc_1');
  assert.throws(() => init(directory, { ...owner, agentId: 'bc_2' }, 1), /Another owner/);
  const first = { id: 'repair-1', kind: 'repair' as const, head, detail: 'fix regression' };
  assert.equal(record(directory, first, 2).repairs, 1);
  assert.equal(record(directory, first, 3).repairs, 1);
  assert.throws(() => record(directory, { ...first, detail: 'different' }, 4), /reused/);
  assert.equal(record(directory, { ...first, id: 'repair-2' }, 5).repairs, 2);
  assert.throws(() => record(directory, { ...first, id: 'repair-3' }, 6), /budget/);
  assert.throws(() => record(directory, { id: 'late', kind: 'round', head, detail: '' }, 7 * 60 * 60 * 1000), /expired/);
});
