import assert from 'node:assert/strict';
import { test } from 'node:test';
import { object } from '../contract.ts';
import { issueUrl, merge } from '../fixtures/linear.ts';
import { proofCatalogue, completionEvidence, type LinearProof } from './linear-proof.ts';
import { LINEAR_PREFIX, type NativeCall } from './linear-session.ts';
import { readLinearTargets } from './linear.ts';
function call(id: string, name: string, result: unknown): NativeCall { return { id, tool: LINEAR_PREFIX + name, args: {}, result, error: false, line: 1, session: 's' }; }
function fixture(quote: string, extra: NativeCall[] = []) {
  const m = merge(), calls = [call('issue', 'get_issue', { id: 'ENG-1', url: issueUrl, description: quote, statusType: 'started', labels: ['pstack'], documents: [] }), { ...call('comments', 'list_comments', { comments: [], hasNextPage: false }), args: { issueId: 'ENG-1' } }, ...extra];
  return { m, calls, read: readLinearTargets(m, calls)[0], catalogue: proofCatalogue(m, calls) };
}
function assessment(quote: string, proof: LinearProof, outcome: Record<string, unknown>, kind = 'acceptance') {
  const references: { key: string; required: boolean; reason: string }[] = [];
  return { targets: [{ url: issueUrl, coverage: 'complete', references, obligations: [{ source: 'ENG-1', quote, kind, requiredClass: proof.kind, status: 'met', outcome: { subject: proof.subject, ...outcome }, proofIds: [proof.id], relevance: 'This exact observed outcome satisfies the named criterion.' }] }] };
}
function structural(f: ReturnType<typeof fixture>): LinearProof { const proof = f.catalogue.find(p => p.kind === 'structural' && p.field === 'labels'); assert.ok(proof); return proof; }
test('exact persisted value of the named entity proves an operational metadata outcome', () => {
  const quote = 'ENG-1 labels must include pstack.', f = fixture(quote), a = assessment(quote, structural(f), { field: 'labels', operator: 'includes', value: 'pstack' });
  assert.equal(completionEvidence(f.read, [a, a], f.catalogue).complete, true);
});
for (const quote of ['I finished rollout. Everything is done.', 'Implement retry behavior.', 'ENG-1 must deploy to production.']) test(`matching malicious structural assessments cannot prove: ${quote}`, () => {
  const f = fixture(quote), a = assessment(quote, structural(f), { field: 'labels', operator: 'includes', value: 'pstack' });
  assert.equal(completionEvidence(f.read, [a, a], f.catalogue).complete, false);
});
test('comment claims, criterion self-quotes, tool metadata and artifact paths are absent from the catalogue', () => {
  const f = fixture('ENG-1 must deploy to production.', [call('claim', 'list_comments', { comments: [{ id: 'c', body: 'I finished rollout. Everything is done.' }], hasNextPage: false })]);
  for (const text of ['I finished rollout', 'ENG-1 must deploy', 'get_issue', 'description']) assert.equal(JSON.stringify(f.catalogue).includes(text), false);
  const forged = { targets: [{ url: issueUrl, coverage: 'complete', references: [], obligations: [{ source: 'ENG-1', quote: f.read.texts[0].body, kind: 'rollout', requiredClass: 'publication', status: 'met', outcome: { subject: 'claim', content: 'Everything is done.' }, proofIds: ['claim'], relevance: 'Author confirms delivery.' }] }] };
  assert.equal(completionEvidence(f.read, [forged, forged], f.catalogue).complete, false);
});
test('generic Done is not a delivery proxy, but an explicitly required related-record status is valid', () => {
  const related = 'https://linear.app/example/issue/ENG-2/cleanup';
  const extra = call('related', 'get_issue', { id: 'ENG-2', url: related, status: 'Done', description: 'Finished.' });
  const f = fixture('ENG-2 status must be Done.', [extra]), p = f.catalogue.find(p => p.kind === 'structural' && p.subject === related && p.field === 'status'); assert.ok(p);
  const a = assessment(f.read.texts[0].body, p, { field: 'status', operator: 'equals', value: 'Done' });
  assert.equal(completionEvidence(f.read, [a, a], f.catalogue).complete, true);
  const negative = fixture('Deploy retry behavior in production.', [extra]);
  const forged = assessment(negative.read.texts[0].body, p, { field: 'status', operator: 'equals', value: 'Done' });
  assert.equal(completionEvidence(negative.read, [forged, forged], negative.catalogue).complete, false);
});
test('conditional Done after rollout cannot be relabeled as a structural administrative outcome', () => {
  const quote = 'ENG-1 statusType completed after production rollout is verified.', f = fixture(quote);
  f.calls[0].result = { id: 'ENG-1', url: issueUrl, description: quote, statusType: 'completed', documents: [] };
  const catalogue = proofCatalogue(f.m, f.calls), p = catalogue.find(p => p.kind === 'structural' && p.field === 'statusType'); assert.ok(p);
  const a = assessment(quote, p, { field: 'statusType', operator: 'equals', value: 'completed' });
  assert.equal(completionEvidence(f.read, [a, a], catalogue).complete, false);
  const admin = fixture('ENG-1 statusType must be completed.');
  admin.calls[0].result = f.calls[0].result;
  const positive = assessment(admin.read.texts[0].body, p, { field: 'statusType', operator: 'equals', value: 'completed' });
  assert.equal(completionEvidence(admin.read, [positive, positive], catalogue).complete, true);
});
test('an exact opened publication proves only the named publication, not a deployment assertion or unrelated content', () => {
  const url = 'https://linear.app/example/initiative/maintenance/activity#initiative-update-weekly', content = 'Weekly maintenance: 28 open records, all assigned to projects.';
  const output = call('artifact', 'get_status_updates', { id: 'weekly', url, body: content });
  const quote = `Publish the weekly update at ${url}.`, f = fixture(quote, [output]); assert.deepEqual(f.read.references, [{ key: url, read: true }]);
  const p = f.catalogue.find(p => p.kind === 'publication'); assert.ok(p);
  const a = assessment(quote, p, { content }); a.targets[0].references.push({ key: url, required: true, reason: 'The requested weekly output.' });
  assert.equal(completionEvidence(f.read, [a, a], f.catalogue).complete, true);
  for (const bad of ['Roll out production retry behavior.', `Deploy production retry behavior; see publication ${url}.`, 'Publish an unrelated report.']) {
    const g = fixture(bad, [output]), forged = assessment(bad, p, { content });
    forged.targets[0].references = g.read.references.map(r => ({ key: r.key, required: false, reason: 'Context only.' }));
    assert.equal(completionEvidence(g.read, [forged, forged], g.catalogue).complete, false);
  }
});
test('a clean head-bound check proves its exact requested command, never generic acceptance or relabeled rollout', () => {
  const f = fixture('Verify node check-retry.mjs passes.'), d = f.m.dossier;
  d.certificate = { schemaVersion: 2, round: d.round, authorProviders: ['codex'], runs: [{ name: 'retry', command: 'node check-retry.mjs', exitCode: 0, clean: true, head: f.m.head, logDigest: 'a'.repeat(64), startedAt: '2026-09-30T00:00:00Z', completedAt: '2026-09-30T00:01:00Z' }], lanes: [], artifacts: [], decision: d.decision, reconcileDigest: d.reconcileDigest, evidenceDigest: d.evidenceDigest, coverage: [], adjustRounds: 0, toolingRef: f.m.head };
  const catalogue = proofCatalogue(f.m, f.calls), p = catalogue.find(p => p.kind === 'verification'); assert.ok(p);
  const a = assessment(f.read.texts[0].body, p, { command: 'node check-retry.mjs' });
  assert.equal(completionEvidence(f.read, [a, a], catalogue).complete, true);
  for (const quote of ['Implement retry behavior.', 'Roll out production after node check-retry.mjs passes.']) {
    const g = fixture(quote), forged = assessment(quote, p, { command: 'node check-retry.mjs' }, 'acceptance');
    assert.equal(completionEvidence(g.read, [forged, forged], catalogue).complete, false);
  }
  d.certificate.runs[0] = { ...d.certificate.runs[0], head: 'c'.repeat(40) };
  assert.equal(proofCatalogue(f.m, f.calls).some(p => p.kind === 'verification'), false);
});
test('actual complete child bodies and comments satisfy required reference coverage; partial comments remain unknown', () => {
  const quote = 'ENG-1 labels must include pstack.', childUrl = 'https://linear.app/example/issue/ENG-2/child';
  const child = call('child', 'get_issue', { id: 'ENG-2', url: childUrl, description: 'Relevant linked work.', statusType: 'completed' });
  const comments = { ...call('child-comments', 'list_comments', { comments: [], hasNextPage: false }), args: { issueId: 'ENG-2' } };
  const f = fixture(quote, [child, comments]); f.calls[0].result = { ...object(f.calls[0].result), children: [{ id: 'ENG-2', url: childUrl }] };
  const read = readLinearTargets(f.m, f.calls)[0]; assert.deepEqual(read.references, [{ key: childUrl, read: true }]);
  const a = assessment(quote, structural(f), { field: 'labels', operator: 'includes', value: 'pstack' }); a.targets[0].references.push({ key: childUrl, required: true, reason: 'Named child context.' });
  assert.equal(completionEvidence(read, [a, a], f.catalogue).complete, true);
  comments.result = { comments: [], pageInfo: {} };
  const missing = readLinearTargets(f.m, f.calls)[0]; assert.equal(missing.references[0].read, false);
  assert.equal(completionEvidence(missing, [a, a], f.catalogue).complete, false);
});
test('required unread references remain open while independently justified unrelated children do not block', () => {
  const quote = 'ENG-1 labels must include pstack.', f = fixture(quote); f.read.references = [{ key: 'ENG-2', read: false }];
  const a = assessment(quote, structural(f), { field: 'labels', operator: 'includes', value: 'pstack' });
  a.targets[0].references.push({ key: 'ENG-2', required: true, reason: 'Its delivery is an obligation.' });
  assert.equal(completionEvidence(f.read, [a, a], f.catalogue).complete, false);
  a.targets[0].references[0].required = false; a.targets[0].references[0].reason = 'Independent work outside this metadata change.';
  assert.equal(completionEvidence(f.read, [a, a], f.catalogue).complete, true);
});
