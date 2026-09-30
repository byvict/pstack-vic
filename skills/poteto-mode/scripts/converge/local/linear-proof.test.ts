import assert from 'node:assert/strict';
import { test } from 'node:test';
import { object } from '../contract.ts';
import { issueUrl, merge } from '../fixtures/linear.ts';
import { proofCatalogue, completionEvidence, type LinearProof } from './linear-proof.ts';
import { LINEAR_PREFIX, type NativeCall } from './linear-session.ts';
import { readLinearTargets } from './linear.ts';
function call(id: string, name: string, result: unknown): NativeCall { return { id, tool: LINEAR_PREFIX + name, args: {}, result, error: false, line: 1, session: 's' }; }
function fixture(quote: string, extra: NativeCall[] = []) {
  extra = extra.flatMap(c => c.tool === LINEAR_PREFIX + 'get_status_updates' ? [{ ...c, result: { ...object(c.result), type: 'initiative' } }, { ...call(c.id + '-comments', 'list_comments', { comments: [], hasNextPage: false }), args: { statusUpdateId: object(c.result).id, statusUpdateType: 'initiative' } }] : [c]);
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
  const quote = `Publish the weekly update at \`${url}\`.`, f = fixture(quote, [output]); assert.deepEqual(f.read.references, [{ key: url, read: true }]);
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
  const f = fixture('Verify `node check-retry.mjs` passes.'), d = f.m.dossier;
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

test('only the final authoritative native values and publication content may prove the current outcome', () => {
  const quote = 'ENG-1 labels must include pstack.', f = fixture(quote), old = structural(f);
  f.calls.push(call('new-issue', 'get_issue', { id: 'ENG-1', url: issueUrl, description: quote, labels: [], statusType: 'started', documents: [] }));
  const catalogue = proofCatalogue(f.m, f.calls), a = assessment(quote, old, { field: 'labels', operator: 'includes', value: 'pstack' });
  assert.equal(completionEvidence(readLinearTargets(f.m, f.calls)[0], [a, a], catalogue).complete, false);
  const url = 'https://linear.app/example/document/weekly';
  const publications = proofCatalogue(f.m, [call('old', 'get_document', { id: 'doc', url, content: 'Old published content.' }), call('new', 'get_document', { id: 'doc', url, content: 'Corrected published content.' })]);
  const artifactUrl = 'https://linear.app/example/initiative/weekly/activity#initiative-update-weekly', publicationQuote = `Publish the weekly update at \`${artifactUrl}\`.`;
  const g = fixture(publicationQuote, [call('old-update', 'get_status_updates', { id: 'weekly', url: artifactUrl, body: 'Old published content.' })]);
  const oldPublication = g.catalogue.find(p => p.kind === 'publication'); assert.ok(oldPublication);
  g.calls.push(call('new-update', 'get_status_updates', { id: 'weekly', url: artifactUrl, type: 'initiative', body: 'Corrected published content.' }));
  const forged = assessment(publicationQuote, oldPublication, { content: 'Old published content.' }); forged.targets[0].references.push({ key: artifactUrl, required: true, reason: 'The requested publication.' });
  assert.equal(completionEvidence(readLinearTargets(g.m, g.calls)[0], [forged, forged], proofCatalogue(g.m, g.calls)).complete, false);
  assert.equal(publications.length, 1); assert.equal(publications[0].kind === 'publication' && publications[0].content, 'Corrected published content.');
  assert.deepEqual(proofCatalogue(f.m, [call('old', 'get_document', { id: 'doc', url, content: 'Old content.' }), call('partial', 'get_document', { id: 'doc', url, content: 'Partial', truncated: true })]), []);
});

test('a deployment word that is the exact required metadata value remains an administrative proof', () => {
  const quote = 'ENG-1 labels must include production.', f = fixture(quote); f.calls[0].result = { ...object(f.calls[0].result), labels: ['production'] };
  const catalogue = proofCatalogue(f.m, f.calls), p = catalogue.find(p => p.kind === 'structural' && p.field === 'labels'); assert.ok(p);
  const a = assessment(quote, p, { field: 'labels', operator: 'includes', value: 'production' });
  assert.equal(completionEvidence(f.read, [a, a], catalogue).complete, true);
});
test('required publication coverage needs its full comments and individually opened content, not a list', () => {
  const url = 'https://linear.app/example/initiative/weekly/activity#initiative-update-weekly', quote = `Publish the update at \`${url}\`.`;
  const f = fixture(quote, [call('artifact', 'get_status_updates', { id: 'weekly', url, body: 'Actual weekly output.' })]);
  const p = f.catalogue.find(p => p.kind === 'publication'); assert.ok(p); const a = assessment(quote, p, { content: 'Actual weekly output.' }); a.targets[0].references.push({ key: url, required: true, reason: 'Required output.' });
  f.calls = f.calls.filter(c => !('statusUpdateId' in c.args)); const missing = readLinearTargets(f.m, f.calls)[0];
  assert.equal(missing.references[0].read, false); assert.equal(completionEvidence(missing, [a, a], f.catalogue).complete, false);
  assert.deepEqual(proofCatalogue(f.m, [call('listing', 'get_status_updates', { updates: [{ id: 'weekly', url, body: 'Actual weekly output.' }], hasNextPage: false })]), []);
});

test('renaming an issue URL does not preserve an older field or criterion as current evidence', () => {
  const quote = 'ENG-1 labels must include pstack.', f = fixture(quote), old = structural(f);
  f.calls.push(call('renamed', 'get_issue', { id: 'ENG-1', url: issueUrl.replace('/test', '/new-title'), description: 'ENG-1 labels must include other.', labels: [], statusType: 'started', documents: [] }));
  const catalogue = proofCatalogue(f.m, f.calls), read = readLinearTargets(f.m, f.calls)[0], forged = assessment(quote, old, { field: 'labels', operator: 'includes', value: 'pstack' });
  assert.equal(read.texts.some(t => t.id === 'ENG-1' && t.body === quote), false);
  assert.equal(completionEvidence(read, [forged, forged], catalogue).complete, false);
});

test('quoted Linear mentions and slugless URLs resolve to complete native entity reads', () => {
  const relatedUrl = 'https://linear.app/example/issue/ENG-2/related', shortUrl = 'https://linear.app/example/issue/ENG-2';
  const quote = `ENG-1 labels must include pstack. Context <issue id="related" href="${shortUrl}">ENG-2</issue> and ${relatedUrl}.`;
  const f = fixture(quote, [call('related', 'get_issue', { id: 'ENG-2', url: relatedUrl, description: 'Full related issue.' }), { ...call('related-comments', 'list_comments', { comments: [], hasNextPage: false }), args: { issueId: 'ENG-2' } }]);
  assert.equal(f.read.references.length, 1); assert.equal(f.read.references[0].key, shortUrl); assert.equal(f.read.references[0].read, true);
  const a = assessment(quote, structural(f), { field: 'labels', operator: 'includes', value: 'pstack' }); a.targets[0].references.push({ key: relatedUrl, required: true, reason: 'Relevant named context.' });
  assert.equal(completionEvidence(f.read, [a, a], f.catalogue).complete, true);
});
test('actual Linear relation objects expose separately scoped blockers, related records and duplicates', () => {
  const quote = 'ENG-1 labels must include pstack.', f = fixture(quote, [call('blocker', 'get_issue', { id: 'ENG-2', url: 'https://linear.app/example/issue/ENG-2/blocker', description: 'Full blocker.' }), { ...call('blocker-comments', 'list_comments', { comments: [], hasNextPage: false }), args: { issueId: 'ENG-2' } }]);
  f.calls[0].result = { ...object(f.calls[0].result), relations: { blocks: [], blockedBy: [{ id: 'ENG-2', title: 'Blocker' }], relatedTo: [{ id: 'ENG-3', title: 'Separate work' }], duplicateOf: { id: 'ENG-4', title: 'Original' } } };
  const read = readLinearTargets(f.m, f.calls)[0];
  assert.equal(read.references.length, 3);
  const blocker = read.references.find(r => r.key.includes(':blockedBy:')); assert.ok(blocker); assert.equal(blocker.read, true);
  assert.equal(read.references.some(r => r.key.endsWith(':ENG-3')), true); assert.equal(read.references.some(r => r.key.includes(':duplicateOf:')), true);
  const a = assessment(quote, structural(f), { field: 'labels', operator: 'includes', value: 'pstack' });
  a.targets[0].references = read.references.map(r => ({ key: r.key, required: r === blocker, reason: r === blocker ? 'The blocker context is required.' : 'Independent work outside this labels obligation.' }));
  assert.equal(completionEvidence(read, [a, a], f.catalogue).complete, true);
  const missing = readLinearTargets(f.m, f.calls.filter(c => !['blocker', 'blocker-comments'].includes(c.id)))[0];
  assert.equal(completionEvidence(missing, [a, a], f.catalogue).complete, false);
});
test('entity identifiers and requested values need exact token boundaries', () => {
  const related = call('related', 'get_issue', { id: 'ENG-2', url: 'https://linear.app/example/issue/ENG-2/related', status: 'Done' }), f = fixture('ENG-20 status must be Done.', [related]);
  const p = f.catalogue.find(p => p.kind === 'structural' && p.field === 'status'); assert.ok(p);
  const forged = assessment(f.read.texts[0].body, p, { field: 'status', operator: 'equals', value: 'Done' });
  assert.equal(completionEvidence(f.read, [forged, forged], f.catalogue).complete, false);
  const g = fixture('ENG-1 labels must include pstack-vic.'), wrongValue = assessment(g.read.texts[0].body, structural(g), { field: 'labels', operator: 'includes', value: 'pstack' });
  assert.equal(completionEvidence(g.read, [wrongValue, wrongValue], g.catalogue).complete, false);
});
test('independent assessments can omit irrelevant outcome fields and choose different valid publication excerpts', () => {
  const quote = 'ENG-1 labels must include pstack.', f = fixture(quote), a = assessment(quote, structural(f), { field: 'labels', operator: 'includes', value: 'pstack' });
  const b = assessment(quote, structural(f), { field: 'labels', operator: 'includes', value: 'pstack', content: '', command: '' });
  assert.equal(completionEvidence(f.read, [a, b], f.catalogue).complete, true);
  const url = 'https://linear.app/example/initiative/weekly/activity#initiative-update-weekly', publicationQuote = `Publish the weekly update at \`${url}\`.`, g = fixture(publicationQuote, [call('output', 'get_status_updates', { id: 'weekly', url, body: 'Weekly results recorded. Maintenance owners listed.' })]);
  const p = g.catalogue.find(p => p.kind === 'publication'); assert.ok(p);
  const first = assessment(publicationQuote, p, { content: 'Weekly results recorded.' }), second = assessment(publicationQuote, p, { content: 'Maintenance owners listed.', field: '', command: '' });
  for (const answer of [first, second]) answer.targets[0].references.push({ key: url, required: true, reason: 'Required publication.' });
  assert.equal(completionEvidence(g.read, [first, second], g.catalogue).complete, true);
});
test('unsupported outcomes preserve the specific recorded obligation while remaining open', () => {
  const quote = 'Implement retry behavior.', f = fixture(quote), a = { targets: [{ url: issueUrl, coverage: 'complete', references: [], obligations: [{ source: 'ENG-1', quote, kind: 'acceptance', requiredClass: 'unknown', status: 'unknown', outcome: null, proofIds: [], relevance: '' }] }] };
  const evidence = completionEvidence(f.read, [a, a], f.catalogue); assert.equal(evidence.complete, false); assert.ok(evidence.remaining.includes(`acceptance: ${quote}`));
});
for (const suffix of ['once retry deploys.', 'after the retry ships to prod.', 'after the fix is rolled out.', 'once the release goes live.']) test(`observed conditional inflection cannot relabel Done: ${suffix}`, () => {
  const quote = `ENG-2 status must be Done ${suffix}`, f = fixture(quote, [call('related', 'get_issue', { id: 'ENG-2', url: 'https://linear.app/example/issue/ENG-2/related', status: 'Done' })]);
  const p = f.catalogue.find(p => p.kind === 'structural' && p.field === 'status'); assert.ok(p); const a = assessment(quote, p, { field: 'status', operator: 'equals', value: 'Done' });
  assert.equal(completionEvidence(f.read, [a, a], f.catalogue).complete, false);
});

test('renamed projects retire old values by native identity while preserving separate workspaces', () => {
  const quote = 'P-CLI-2 status must be Done.', oldUrl = 'https://linear.app/example/project/old-project', newUrl = 'https://linear.app/example/project/new-project';
  const old = call('old-project', 'get_project', { id: 'P-CLI-2', uuid: 'project-uuid', url: oldUrl, status: 'Done' }), f = fixture(quote, [old]);
  const p = f.catalogue.find(p => p.kind === 'structural' && p.subject === oldUrl && p.field === 'status'); assert.ok(p);
  const a = assessment(quote, p, { field: 'status', operator: 'equals', value: 'Done' });
  f.calls.push(call('renamed-project', 'get_project', { id: 'P-CLI-2', uuid: 'project-uuid', url: newUrl, status: 'In Progress' }));
  assert.equal(completionEvidence(f.read, [a, a], proofCatalogue(f.m, f.calls)).complete, false);
  f.calls.push(call('other-workspace', 'get_project', { id: 'P-CLI-2', uuid: 'another-uuid', url: oldUrl.replace('/example/', '/other/'), status: 'Done' }));
  const records = proofCatalogue(f.m, f.calls); assert.equal(records.some(p => p.kind === 'structural' && p.subject === newUrl && p.field === 'status' && p.value === 'In Progress'), true);
});
test('a failed final native read invalidates prior source coverage rather than reusing a stale parent', () => {
  const f = fixture('ENG-1 labels must include pstack.'), parent = call('parent', 'get_issue', { id: 'ENG-2', url: 'https://linear.app/example/issue/ENG-2/parent', description: 'Full parent.' });
  f.calls[0].result = { ...object(f.calls[0].result), parentId: 'ENG-2' };
  f.calls.push(parent, { ...call('parent-comments', 'list_comments', { comments: [], hasNextPage: false }), args: { issueId: 'ENG-2' } }, { ...call('failed-parent', 'get_issue', { error: 'Unavailable' }), args: { id: 'ENG-2' }, error: true });
  assert.throws(() => readLinearTargets(f.m, f.calls), /parent issue read/);
});

test('whole structural literals reject punctuation suffixes and atomic longer quoted values', () => {
  for (const value of ['pstack.vic', 'pstack/other', 'pstack:other', '`pstack extra`', '`pstack.vic`', '"pstack extra"', "'pstack/other'"]) {
    const quote = `ENG-1 labels must include ${value}.`, f = fixture(quote), a = assessment(quote, structural(f), { field: 'labels', operator: 'includes', value: 'pstack' });
    const result = completionEvidence(f.read, [a, a], f.catalogue); assert.equal(result.complete, false, value); assert.ok(result.remaining.includes(`acceptance: ${quote}`));
  }
  for (const entity of ['ENG-1.other', 'ENG-1/other', 'ENG-1:other', '`ENG-1 extra`']) {
    const quote = `${entity} labels must include pstack.`, f = fixture(quote), a = assessment(quote, structural(f), { field: 'labels', operator: 'includes', value: 'pstack' });
    assert.equal(completionEvidence(f.read, [a, a], f.catalogue).complete, false, entity);
  }
  for (const field of ['labels.extra', 'labels/other', 'labels:other', '`labels extra`']) {
    const quote = `ENG-1 ${field} must include pstack.`, f = fixture(quote), a = assessment(quote, structural(f), { field: 'labels', operator: 'includes', value: 'pstack' });
    assert.equal(completionEvidence(f.read, [a, a], f.catalogue).complete, false, field);
  }
});
test('explicit full structural literals preserve punctuation and spaces', () => {
  for (const value of ['pstack.vic', 'pstack/other', 'pstack extra']) {
    const quote = `\`ENG-1\` \`labels\` must include \`${value}\`.`, f = fixture(quote); f.calls[0].result = { ...object(f.calls[0].result), labels: [value] };
    const catalogue = proofCatalogue(f.m, f.calls), proof = catalogue.find(p => p.kind === 'structural' && p.field === 'labels'); assert.ok(proof);
    const a = assessment(quote, proof, { field: 'labels', operator: 'includes', value });
    assert.equal(completionEvidence(f.read, [a, a], catalogue).complete, true, value);
  }
});
test('a publication criterion binds the whole URL with its path, query, fragment and case', () => {
  const url = 'https://linear.app/example/initiative/weekly/activity#initiative-update-weekly';
  const output = call('output', 'get_status_updates', { id: 'weekly', url, body: 'Weekly results recorded.' });
  for (const literal of [url + '/extra', url + '?other=1', url + '#extra', url.replace('/activity#', '/activity/extra#'), url.replace('/activity#', '/activity?other=1#'), url.replace('/example/', '/EXAMPLE/'), '`' + url + '/extra`']) {
    const quote = `Publish the weekly update at ${literal}.`, f = fixture(quote, [output]), proof = f.catalogue.find(p => p.kind === 'publication'); assert.ok(proof);
    const a = assessment(quote, proof, { content: 'Weekly results recorded.' }); a.targets[0].references = f.read.references.map(r => ({ key: r.key, required: false, reason: 'The different URL cannot be proved by this opened publication.' }));
    assert.equal(completionEvidence(f.read, [a, a], f.catalogue).complete, false, literal);
  }
  for (const quote of [`Publish the weekly update at ${url}`, `Publish the weekly update at \`${url}\`.`]) {
    const f = fixture(quote, [output]), proof = f.catalogue.find(p => p.kind === 'publication'); assert.ok(proof);
    const a = assessment(quote, proof, { content: 'Weekly results recorded.' }); a.targets[0].references = f.read.references.map(r => ({ key: r.key, required: true, reason: 'The exact requested publication is fully read.' }));
    assert.equal(completionEvidence(f.read, [a, a], f.catalogue).complete, true, quote);
  }
});
test('verification commands are atomic delimited literals, including every argument', () => {
  for (const command of ['npm test:extra', 'npm test --ci', '`npm test:extra`', '`npm test --ci`', '"npm test --ci"', "'npm test:extra'", 'npm test', '`npm test`', '"npm test"', "'npm test'"]) {
    const quote = `Verify ${command} passes.`, f = fixture(quote), d = f.m.dossier;
    d.certificate = { schemaVersion: 2, round: d.round, authorProviders: ['codex'], runs: [{ name: 'tests', command: 'npm test', exitCode: 0, clean: true, head: f.m.head, logDigest: 'a'.repeat(64), startedAt: '2026-09-30T00:00:00Z', completedAt: '2026-09-30T00:01:00Z' }], lanes: [], artifacts: [], decision: d.decision, reconcileDigest: d.reconcileDigest, evidenceDigest: d.evidenceDigest, coverage: [], adjustRounds: 0, toolingRef: f.m.head };
    const catalogue = proofCatalogue(f.m, f.calls), proof = catalogue.find(p => p.kind === 'verification'); assert.ok(proof); const a = assessment(quote, proof, { command: 'npm test' });
    const expected = ['`npm test`', '"npm test"', "'npm test'"].includes(command), result = completionEvidence(f.read, [a, a], catalogue);
    assert.equal(result.complete, expected, command); if (!expected) assert.ok(result.remaining.includes(`acceptance: ${quote}`));
  }
});
for (const suffix of ['and the retry ships to prod.', 'and the fix is rolled out.', 'and the retry deploys.']) test(`a combined delivery requirement cannot relabel Done: ${suffix}`, () => {
  const quote = `ENG-2 status must be Done ${suffix}`, f = fixture(quote, [call('related', 'get_issue', { id: 'ENG-2', url: 'https://linear.app/example/issue/ENG-2/related', status: 'Done' })]);
  const proof = f.catalogue.find(p => p.kind === 'structural' && p.field === 'status'); assert.ok(proof); const a = assessment(quote, proof, { field: 'status', operator: 'equals', value: 'Done' });
  assert.equal(completionEvidence(f.read, [a, a], f.catalogue).complete, false);
});

test('a requested value cannot erase part of a separate deployment clause or every repeated occurrence', () => {
  for (const [value, clause] of [['prod', 'retry reaches production'], ['de', 'retry deploys'], ['lo', 'retry rollout is confirmed'], ['production', 'retry reaches production'], ['installed', 'installed retry is running']]) {
    for (const literal of [value, `\`${value}\``]) {
      const quote = `ENG-1 labels must include ${literal} and ${clause}.`, f = fixture(quote); f.calls[0].result = { ...object(f.calls[0].result), labels: [value] };
      const catalogue = proofCatalogue(f.m, f.calls), proof = catalogue.find(p => p.kind === 'structural' && p.field === 'labels'); assert.ok(proof); const a = assessment(quote, proof, { field: 'labels', operator: 'includes', value });
      const result = completionEvidence(f.read, [a, a], catalogue); assert.equal(result.complete, false, quote); assert.ok(result.remaining.includes(`acceptance: ${quote}`));
    }
  }
});
test('only the actual named entity supplies an identity mask; unused and overlapping aliases remain context', () => {
  for (const [alias, value, clause] of [['prod', 'pstack', 'retry reaches production'], ['de', 'pstack', 'retry deploys'], ['deployment', 'pstack', 'deployment is complete'], ['rollout', 'pstack', 'retry rollout is confirmed'], ['production', 'production', 'retry reaches production']]) {
    const quote = `ENG-1 labels must include ${value} and ${clause}.`, f = fixture(quote); f.calls[0].result = { ...object(f.calls[0].result), uuid: alias, labels: [value] };
    const catalogue = proofCatalogue(f.m, f.calls), proof = catalogue.find(p => p.kind === 'structural' && p.field === 'labels'); assert.ok(proof); const a = assessment(quote, proof, { field: 'labels', operator: 'includes', value });
    assert.equal(completionEvidence(f.read, [a, a], catalogue).complete, false, alias);
  }
});
test('an opened publication discounts its actual URL occurrence while retaining longer referenced literals', () => {
  const url = 'https://linear.app/example/initiative/weekly/production#initiative-update-weekly', output = call('output', 'get_status_updates', { id: 'weekly', url, body: 'Weekly results published.' });
  for (const extra of ['', ` and ${url}-extra`, ` and \`${url}/extra\``]) {
    const quote = `Publish the update at \`${url}\`${extra}.`, f = fixture(quote, [output]), proof = f.catalogue.find(p => p.kind === 'publication'); assert.ok(proof); const a = assessment(quote, proof, { content: 'Weekly results published.' });
    a.targets[0].references = f.read.references.map(r => ({ key: r.key, required: false, reason: 'Matching assessments claim all other URLs are irrelevant.' }));
    assert.equal(completionEvidence(f.read, [a, a], f.catalogue).complete, !extra, extra);
  }
});
test('a certified command cannot erase its prefix inside another command or an independent predicate', () => {
  for (const [command, clause] of [['install', 'installed retry is running'], ['node deploy.mjs', '`node deploy.mjs-extra` is needed']]) {
    for (const extra of ['', ` and ${clause}`]) {
      const quote = `Verify \`${command}\` passes${extra}.`, f = fixture(quote), d = f.m.dossier;
      d.certificate = { schemaVersion: 2, round: d.round, authorProviders: ['codex'], runs: [{ name: 'check', command, exitCode: 0, clean: true, head: f.m.head, logDigest: 'a'.repeat(64), startedAt: '2026-09-30T00:00:00Z', completedAt: '2026-09-30T00:01:00Z' }], lanes: [], artifacts: [], decision: d.decision, reconcileDigest: d.reconcileDigest, evidenceDigest: d.evidenceDigest, coverage: [], adjustRounds: 0, toolingRef: f.m.head };
      const catalogue = proofCatalogue(f.m, f.calls), proof = catalogue.find(p => p.kind === 'verification'); assert.ok(proof); const a = assessment(quote, proof, { command });
      assert.equal(completionEvidence(f.read, [a, a], catalogue).complete, !extra, quote);
    }
  }
});
