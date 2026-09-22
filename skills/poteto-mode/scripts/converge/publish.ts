import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { array, digest, integer, jsonHash, object, oneOf, parseFinding, parseReport, parseRound, parseObligation, riskObligation, sameObligation, string, strings, sha, parseExecutionId, type Decision, type Dossier, type Finding, type Report } from './contract.ts';
import { admitPull, api, comments, isPublication, pages, principal, pull, snapshot } from './github.ts';
import { analyze } from './reconcile.ts';
import { admitLane, type AdmittedLane } from './evidence.ts';

function decide(report: Report, lanes: AdmittedLane[], admissionFailures = 0): Decision {
  const findings = [...report.findings, ...lanes.flatMap(l => l.findings.filter(f => f.severity === 'blocking'))];
  const reasons = [...report.gaps, ...lanes.flatMap(l => l.gaps)];
  if (admissionFailures) reasons.push('Independent lane evidence failed admission');
  if (lanes.some(l => l.findings.some(f => f.severity === 'requires-proof'))) reasons.push('Independent reviewer requires further proof');
  for (const role of report.lanes) if (lanes.filter(l => l.role === role).length !== 1) reasons.push('Required independent lane unavailable');
  if (lanes.some(l => !report.lanes.includes(l.role))) reasons.push('Unexpected independent lane');
  const verifier = lanes.find(l => l.role === 'pr verifier');
  for (const feature of report.touchedFeatures) if (!verifier?.coverage.includes(feature.id)) reasons.push('Required live feature coverage unavailable');
  if (report.unmappedSurfaces.length) reasons.push('Changed user surface lacks a trusted feature recipe');
  for (const hit of report.hardList.filter(f => f.severity === 'requires-proof')) if (!lanes.find(l => l.role === 'pr reviewer')?.risks.some(proof => sameObligation(proof, riskObligation(hit)))) reasons.push('Reviewer did not prove required risk safe');
  for (const claim of report.claims) {
    if (claim.resolution === 'supported') continue;
    if (claim.kind === 'feature' && verifier?.coverage.includes(claim.name)) continue;
    if (claim.resolution === 'missing') findings.push({ kind: 'false-claim', source: 'body', path: null, line: claim.line, rule: 'claimed-evidence-absent', severity: 'blocking' });
    else reasons.push('Verification claim lacks independently attributable evidence');
  }
  const firstFinding = findings[0];
  if (firstFinding) return { verdict: 'NOT VERIFIED', displayResult: 'NOT VERIFIED', findings: [firstFinding, ...findings.slice(1)], reasons };
  const firstReason = reasons[0];
  if (firstReason) return { verdict: 'INCONCLUSIVE', displayResult: 'INCONCLUSIVE', findings: [], reasons: [firstReason, ...reasons.slice(1)] };
  return { verdict: 'VERIFIED', displayResult: report.mode === 'ci-only' ? 'CI-only' : 'VERIFIED', findings: [], reasons: [] };
}
export function parseDossier(value: unknown): Dossier {
  const v = object(value);
  if (v.schemaVersion !== 1) throw new Error('Unknown verdict schema');
  const d = object(v.decision);
  const verdict = oneOf(d.verdict, ['VERIFIED', 'NOT VERIFIED', 'INCONCLUSIVE']);
  const findings = array(d.findings).map(parseFinding);
  const reasons = strings(d.reasons);
  let decision: Decision;
  if (verdict === 'VERIFIED') {
    if (findings.length || reasons.length) throw new Error('Contradictory successful verdict');
    decision = { verdict, displayResult: oneOf(d.displayResult, ['VERIFIED', 'CI-only']), findings: [], reasons: [] };
  } else if (verdict === 'NOT VERIFIED') {
    const first = findings[0];
    if (!first || d.displayResult !== verdict) throw new Error('Failure without findings');
    decision = { verdict, displayResult: verdict, findings: [first, ...findings.slice(1)], reasons };
  } else {
    const first = reasons[0];
    if (!first || d.displayResult !== verdict) throw new Error('Inconclusive without reasons');
    decision = { verdict, displayResult: verdict, findings, reasons: [first, ...reasons.slice(1)] };
  }
  return { schemaVersion: 1, round: parseRound(v.round), decision, evidenceDigest: digest(v.evidenceDigest), reconcileDigest: digest(v.reconcileDigest), coverage: strings(v.coverage), riskAdjudication: array(v.riskAdjudication).map(parseObligation), artifactIds: strings(v.artifactIds), inputFingerprint: digest(v.inputFingerprint), retainedFrom: v.retainedFrom === null ? null : { round: parseExecutionId(object(v.retainedFrom).round), head: sha(object(v.retainedFrom).head), commentUrl: string(object(v.retainedFrom).commentUrl) } };
}
export function dossierFromComment(value: unknown): Dossier {
  const c = object(value);
  const match = string(c.body).match(/^<!-- converge:v1 ([a-f0-9-]{36}) -->\n```json\n([\s\S]+)\n```\n?$/);
  if (!match) throw new Error('Invalid converge verdict comment');
  const dossier = parseDossier(JSON.parse(match[2] ?? ''));
  if (dossier.round.id !== match[1]) throw new Error('Verdict marker identity mismatch');
  return dossier;
}
export async function statuses(repo: string, head: string): Promise<Record<string, unknown>[]> {
  return (await pages(`repos/${repo}/commits/${head}/statuses`)).map(v => object(v)).sort((a, b) => integer(b.id) - integer(a.id));
}
export async function publishVerdict(options: { reportFile: string; laneFiles: string[]; evidenceDirectory: string; retainCommentUrl?: string }): Promise<{ dossier: Dossier; commentUrl: string; statusId: number; mustEndTurn: true }> {
  const report = parseReport(JSON.parse(readFileSync(options.reportFile, 'utf8')));
  const r = report.round;
  const current = await snapshot(r.repo, r.pr, r.configPath, r.execution === 'verdict-only');
  const reconstructed = analyze(current, { id: r.id, configPath: r.configPath, execution: r.execution });
  if (jsonHash(report) !== jsonHash(reconstructed)) throw new Error('Reconciliation report changed or is stale');
  const admitted: AdmittedLane[] = [];
  const admissionFailures: { position: number; outcome: 'rejected' }[] = [];
  let retainedFrom: Dossier['retainedFrom'] = null;
  if (options.retainCommentUrl) {
    if (options.laneFiles.length) throw new Error('Retained evidence cannot mix with fresh lanes');
    const prefix = `https://github.com/${r.repo}/pull/${r.pr}#issuecomment-`;
    if (!options.retainCommentUrl.startsWith(prefix) || !/^\d+$/.test(options.retainCommentUrl.slice(prefix.length))) throw new Error('Invalid retained verdict URL');
    const comment = object(await api(`repos/${r.repo}/issues/comments/${options.retainCommentUrl.slice(prefix.length)}`));
    const author = await principal();
    if (integer(object(comment.user).id) !== author) throw new Error('Retained verdict author is untrusted');
    const old = dossierFromComment(comment);
    if (old.round.repo !== r.repo || old.round.pr !== r.pr || old.round.patch_id !== r.patch_id || old.round.verificationDigest !== r.verificationDigest || old.round.execution !== r.execution || old.decision.verdict !== 'VERIFIED') throw new Error('Retained code evidence does not match this patch and policy');
    const oldStatus = (await statuses(r.repo, old.round.head)).find(s => s.context === 'verdict');
    if (!oldStatus || oldStatus.target_url !== options.retainCommentUrl || integer(object(oldStatus.creator).id) !== author || oldStatus.description !== 'VERIFIED by converge' || oldStatus.state !== (r.execution === 'converge' ? 'success' : 'error')) throw new Error('Retained verdict status is not authoritative');
    retainedFrom = { round: old.round.id, head: old.round.head, commentUrl: options.retainCommentUrl };
    for (const role of report.lanes) admitted.push({ role, coverage: role === 'pr verifier' ? old.coverage : [], risks: role === 'pr reviewer' ? old.riskAdjudication : [], findings: [], gaps: [], artifacts: old.artifactIds.map(id => ({ id, path: options.retainCommentUrl ?? '', digest: old.evidenceDigest, mediaType: 'retained' })), receiptDigest: old.evidenceDigest });
  }
  for (const [position, file] of options.laneFiles.entries()) {
    try { admitted.push(await admitLane(file, report, options.evidenceDirectory)); }
    catch { admissionFailures.push({ position, outcome: 'rejected' }); }
  }
  const refreshed = await snapshot(r.repo, r.pr, r.configPath, r.execution === 'verdict-only');
  if (refreshed.inputDigest !== r.inputDigest) throw new Error('Inputs changed during evidence admission');
  const dossier: Dossier = { schemaVersion: 1, round: r, decision: decide(report, admitted, admissionFailures.length), reconcileDigest: jsonHash(report), evidenceDigest: jsonHash({ admitted, admissionFailures }), coverage: admitted.flatMap(l => l.coverage), riskAdjudication: admitted.filter(l => l.role === 'pr reviewer').flatMap(l => l.risks), artifactIds: admitted.flatMap(l => l.artifacts.map(a => a.id)), inputFingerprint: report.inputFingerprint, retainedFrom };
  const author = await principal();
  const body = `<!-- converge:v1 ${r.id} -->\n\`\`\`json\n${JSON.stringify(dossier, null, 2)}\n\`\`\`\n`;
  const existing = (await comments(r.repo, r.pr)).filter(c => isPublication(c, author) && string(c.body).startsWith(`<!-- converge:v1 ${r.id} -->`));
  if (existing.some(c => c.body !== body)) throw new Error('Divergent verdict already published for this round');
  admitPull(await pull(r.repo, r.pr), current.trusted.config, r.head, r.execution === 'verdict-only');
  const comment = existing[0] ?? object(await api(`repos/${r.repo}/issues/${r.pr}/comments`, { body }));
  const commentUrl = string(comment.html_url);
  if (!new RegExp(`^https://github\\.com/${r.repo}/pull/${r.pr}#issuecomment-[0-9]+$`, 'i').test(commentUrl)) throw new Error('Unexpected verdict comment URL');
  const state = r.execution === 'verdict-only' ? 'error' : dossier.decision.verdict === 'VERIFIED' ? 'success' : dossier.decision.verdict === 'NOT VERIFIED' ? 'failure' : 'error';
  const description = `${dossier.decision.verdict} by converge`;
  const prior = (await statuses(r.repo, r.head)).filter(s => s.context === 'verdict' && s.target_url === commentUrl && integer(object(s.creator).id) === author);
  if (prior.some(s => s.state !== state || s.description !== description)) throw new Error('Divergent status already published for this round');
  const status = prior[0] ?? object(await api(`repos/${r.repo}/statuses/${r.head}`, { context: 'verdict', state, description, target_url: commentUrl }));
  const commentRead = object(await api(`repos/${r.repo}/issues/comments/${integer(comment.id)}`));
  if (commentRead.body !== body || integer(object(commentRead.user).id) !== author || !(await statuses(r.repo, r.head)).some(s => s.id === status.id && s.state === state && s.target_url === commentUrl && integer(object(s.creator).id) === author)) throw new Error('Publication read-back failed; recover before any other action');
  return { dossier, commentUrl, statusId: integer(status.id), mustEndTurn: true };
}
async function main(args: string[]): Promise<number> {
  try {
    const { values } = parseArgs({ args, options: { report: { type: 'string' }, lane: { type: 'string', multiple: true }, evidence: { type: 'string' }, retain: { type: 'string' } } });
    if (!values.report || !values.evidence) throw new Error('Usage: publish.ts --report report.json --evidence directory [--lane manifest.json]');
    process.stdout.write(JSON.stringify(await publishVerdict({ reportFile: values.report, laneFiles: values.lane ?? [], evidenceDirectory: values.evidence, retainCommentUrl: values.retain }), null, 2) + '\n');
    return 0;
  } catch (error) { process.stderr.write((error instanceof SyntaxError ? 'Malformed JSON input' : error instanceof Error ? error.message : 'Publication failed') + '\n'); return 1; }
}
if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
