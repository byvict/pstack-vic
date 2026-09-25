import { integer, jsonHash, object, type Dossier } from './contract.ts';
import { comments, isPublication, pull, RequestError, snapshot, verdictStatus, type Trusted } from './github.ts';
import { decide, dossierFromComment, retainedLanes } from './publish.ts';
import { analyze } from './reconcile.ts';

export type Gate = { kind: 'certified'; dossier: Dossier; url: string; fingerprint: string; rederived: string | null } | { kind: 'refused'; reason: string };
/** A pre-pr certificate is assembled at one trunk tip, and its publication decided over the PR text of that moment; its lanes never read PR text. So the gate re-derives it every time: the certificate authorizes merge only while the same patch under the same policy re-derives VERIFIED from its retained coverage, over the current text, at the tip the caller read. That binds the trunk tip at gate time, not the tip the merge lands on. */
async function rederivePrePr(t: Trusted, pr: number, dossier: Dossier, url: string, fingerprint: string): Promise<void> {
  const r = dossier.round;
  const current = await snapshot(t.repo, pr, r.configPath, 'pre-pr');
  if (current.trusted.sha !== t.sha) throw new Error('Trunk moved during re-derivation');
  if (current.inputFingerprint !== fingerprint) throw new Error('PR text changed during re-derivation');
  const report = analyze(current, { id: r.id, configPath: r.configPath, execution: 'pre-pr' });
  if (report.round.head !== r.head || report.round.patch_id !== r.patch_id || report.round.verificationDigest !== r.verificationDigest) throw new Error('Certificate patch or policy differs at trunk tip ' + t.sha);
  const decision = decide(report, retainedLanes(report.lanes, dossier, url));
  if (decision.verdict !== 'VERIFIED') throw new Error(`Certificate is no longer VERIFIED at trunk tip ${t.sha}: ${decision.verdict}`);
}
async function certify(t: Trusted, pr: number, head: string, author: number): Promise<Gate> {
  const status = await verdictStatus(t.repo, pr, head, author);
  if (status.kind !== 'trusted') throw new Error(status.reason);
  const all = await comments(t.repo, pr);
  const comment = all.find(c => c.id === Number(status.commentId));
  if (!comment) throw new Error('Verdict comment is missing from this PR');
  if (integer(object(comment.user).id) !== author) throw new Error('Verdict comment author is untrusted');
  const dossier = dossierFromComment(comment);
  const r = dossier.round;
  if (r.repo !== t.repo || r.pr !== pr || r.head !== head || !['converge', 'pre-pr'].includes(r.execution) || dossier.decision.verdict !== 'VERIFIED' || (r.execution === 'converge' && r.contract !== t.sha)) throw new Error('Verdict identity or execution does not authorize merge');
  if (r.configPath !== t.configPath) throw new Error('Verdict was reconciled against another contract path');
  const newest = all.filter(c => isPublication(c, author)).sort((a, b) => integer(b.id) - integer(a.id))[0];
  if (!newest || newest.id !== comment.id) throw new Error('A newer converge round supersedes this verdict');
  const live = await pull(t.repo, pr);
  const fingerprint = jsonHash({ body: live.body, comments: all.filter(c => !isPublication(c, author)).map(c => [c.id, c.body, c.updated_at]) });
  if (r.execution === 'converge') {
    if (fingerprint !== dossier.inputFingerprint) throw new Error('PR text changed after verification');
    return { kind: 'certified', dossier, url: status.url, fingerprint, rederived: null };
  }
  await rederivePrePr(t, pr, dossier, status.url, fingerprint);
  const rederived = 'Re-derived the pre-pr verdict' + (r.contract === t.sha ? '' : ` from contract ${r.contract}`) + ` at trunk tip ${t.sha}` + (fingerprint === dossier.inputFingerprint ? '' : ' over changed PR text');
  return { kind: 'certified', dossier, url: status.url, fingerprint, rederived };
}
/** The one decision the arm, the sweep and start.ts share about a PR head: whether its published verdict authorizes merge now. A status alone never does. A refusal is a result; a failed GitHub read is not a verdict, so it throws. */
export async function verdictGate(t: Trusted, pr: number, head: string, author: number): Promise<Gate> {
  try { return await certify(t, pr, head, author); }
  catch (error) {
    if (error instanceof RequestError || !(error instanceof Error)) throw error;
    return { kind: 'refused', reason: error.message };
  }
}
