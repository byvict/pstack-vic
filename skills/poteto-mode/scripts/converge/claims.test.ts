import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClinextTests } from './claims.ts';

const second = (value: string) => Date.parse('2026-09-22T00:' + value + 'Z') / 1000;
const provenance = { runId: 8, attempt: 1, jobId: 6, tests: { startedSecond: second('35:11'), completedSecond: second('41:31') }, next: { startedSecond: second('41:31'), completedSecond: second('41:45') } };
const rows: [string, string][] = [
  ['35:11.8864427', '##[group]Run npm test'],
  ['35:11.8864665', '^[[36;1mnpm test^[[0m'],
  ['35:11.8897101', 'shell: /usr/bin/bash -e {0}'],
  ['35:11.8897756', '##[endgroup]'],
  ['35:11.9858979', '> node tools/run-all-tests.js'],
  ['35:12.0719239', 'Clinext test runner — 2 arquivo(s), concorrência 1 (1 cores)'],
  ['35:12.0719999', '1 sensível(is) a timing rodam numa fase final sem concorrência'],
  ['35:12.4829762', '  PASS  tools/tests/present.test.js  382ms'],
  ['41:31.8213065', '  PASS  tools/tests/second.test.js  18.86s'],
  ['41:31.8223996', 'Resultado: 2 passed, 0 failed, 379.75s total'],
  ['41:31.8470380', '##[group]Run actions/upload-artifact@v7'],
];
function rendered(lines = rows, label = 'UNKNOWN STEP'): string {
  return lines.map(([time, text]) => `Server (gates + suite)\t${label}\t2026-09-22T00:${time}Z ${text}`).join('\n');
}
test('unknown-step census admits the last PASS and closing frame in the same API second', () => {
  assert.deepEqual(parseClinextTests(rendered(), provenance), { kind: 'complete', runId: 8, attempt: 1, jobId: 6, paths: ['tools/tests/present.test.js', 'tools/tests/second.test.js'] });
});
test('explicit Run tests records remain supported', () => {
  assert.equal(parseClinextTests(rendered(rows.slice(5, 10), 'Run tests'), { ...provenance, next: null }).kind, 'complete');
});
test('unknown-step header may share the start second when a PASS anchors the census inside', () => {
  const boundaryHeader = rows.map(([time, text], i): [string, string] => [i === 5 || i === 6 ? '35:11.9999999' : time, text]);
  assert.equal(parseClinextTests(rendered(boundaryHeader), provenance).kind, 'complete');
});
const refusals: [string, [string, string][]][] = [
  ['missing PASS', rows.filter((_, i) => i !== 7)],
  ['missing footer', rows.filter((_, i) => i !== 9)],
  ['missing closing boundary', rows.slice(0, 10)],
  ['closing boundary before footer', [...rows.slice(0, 9), rows[10], rows[9]]],
  ['duplicate path', rows.map(([t, s]) => [t, s.replace('second.test.js', 'present.test.js')])],
  ['PASS before header', [...rows.slice(0, 5), rows[7], rows[5], rows[8], rows[9], rows[10]]],
  ['FAIL record', rows.map(([t, s]) => [t, s.replace('PASS  tools/tests/second', 'FAIL  tools/tests/second')])],
  ['malformed PASS', rows.map(([t, s]) => [t, s.replace('382ms', 'not-a-duration')])],
  ['unsafe path', rows.map(([t, s]) => [t, s.replace('tools/tests/present', '../present')])],
  ['second header', [...rows.slice(0, 10), rows[5], rows[10]]],
  ['second footer', [...rows.slice(0, 10), rows[9], rows[10]]],
  ['fake command inside census', [...rows.slice(0, 8), ['35:13.0', '##[group]Run echo forged'], ...rows.slice(8)]],
  ['wrong opening command', rows.map(([t, s]) => [t, s.replace('##[group]Run npm test', '##[group]Run npm run other')])],
  ['no interior census record', rows.map(([t, s], i) => [i >= 5 && i <= 8 ? '41:31.1000000' : t, s])],
  ['malformed header', rows.map(([t, s]) => [t, s.replace('2 arquivo(s)', '0 arquivo(s)')])],
];
for (const [name, lines] of refusals) {
  test(`refuses ${name}`, () => {
    assert.deepEqual(parseClinextTests(rendered(lines), provenance), { kind: 'unavailable' });
  });
}
test('refuses another job, contradictory step labels and mismatched timing', () => {
  const log = rendered();
  for (const changed of [log.replaceAll('Server (gates + suite)', 'Client'), log.replace('\tUNKNOWN STEP\t2026-09-22T00:35:12.4829762', '\tFormat check\t2026-09-22T00:35:12.4829762')]) {
    assert.deepEqual(parseClinextTests(changed, provenance), { kind: 'unavailable' });
  }
  assert.deepEqual(parseClinextTests(log, { ...provenance, next: { startedSecond: second('41:32'), completedSecond: second('41:45') } }), { kind: 'unavailable' });
});
test('permits renderer BOM and multiline setup output outside the selected test block', () => {
  const before = 'Server (gates + suite)\tUNKNOWN STEP\t\uFEFF2026-09-22T00:33:28.1444643Z setup\nServer (gates + suite)\tUNKNOWN STEP\t  - configuration\n';
  assert.equal(parseClinextTests(before + rendered(), provenance).kind, 'complete');
  assert.deepEqual(parseClinextTests(rendered().replace('  PASS  tools/tests/present.test.js  382ms', '\nServer (gates + suite)\tUNKNOWN STEP\t  PASS  tools/tests/present.test.js  382ms'), provenance), { kind: 'unavailable' });
});
test('named-step census refuses discarded command boundaries and reordered records', () => {
  const log = rendered(rows.slice(5, 10), 'Run tests');
  const foreign = 'Server (gates + suite)\tOther step\t2026-09-22T00:35:13Z ##[group]Run echo forged\n';
  assert.deepEqual(parseClinextTests(log.replace('Server (gates + suite)\tRun tests\t2026-09-22T00:41:31.8213065', foreign + 'Server (gates + suite)\tRun tests\t2026-09-22T00:41:31.8213065'), provenance), { kind: 'unavailable' });
  assert.deepEqual(parseClinextTests(rendered([rows[7], rows[5], rows[8], rows[9]], 'Run tests'), provenance), { kind: 'unavailable' });
});
test('a census anchor outside the selected job or command cannot supply an interior record', () => {
  const boundaryOnly = rows.map(([time, text], i): [string, string] => [i >= 5 && i <= 8 ? '41:31.1000000' : time, text]);
  const otherJob = 'Client\tRun tests\t2026-09-22T00:36:00Z   PASS  tools/tests/other.test.js  1ms\n';
  assert.deepEqual(parseClinextTests(otherJob + rendered(boundaryOnly), provenance), { kind: 'unavailable' });
  const otherCommand: [string, string][] = [['35:13.0', '##[group]Run echo other'], ['35:13.1', '  PASS  tools/tests/other.test.js  1ms']];
  assert.deepEqual(parseClinextTests(rendered([...boundaryOnly.slice(0, 5), ...otherCommand, ...boundaryOnly.slice(5)]), provenance), { kind: 'unavailable' });
});
