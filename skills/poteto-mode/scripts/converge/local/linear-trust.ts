import { array, instant, integer, object, sha, string, type Dossier } from '../contract.ts';
import { api, comments, isPublication, pages, principal, verdictStatus, type Trusted } from '../github.ts';
import { dossierFromComment } from '../publish.ts';
import { linearTargets, type LinearTarget } from '../linear-targets.ts';

export interface LinearMerge { repo: string; pr: number; commit: string; head: string; verdictUrl: string; dossier: Dossier; targets: LinearTarget[] }
export type LinearAdmission = { kind: 'admitted'; merge: LinearMerge } | { kind: 'noop' | 'refused'; reason: string };

export async function admitLinearMerge(t: Trusted, commit: string): Promise<LinearAdmission> {
  const linked = (await pages(`repos/${t.repo}/commits/${sha(commit)}/pulls`)).map(v => object(v, 'merged pull'));
  const candidates = linked.filter(p => typeof p.merged_at === 'string' && object(p.base, 'pull base').ref === t.config.trunk && p.merge_commit_sha === commit);
  if (!candidates.length) return { kind: linked.some(p => typeof p.merged_at === 'string') ? 'refused' : 'noop', reason: 'No exact merged PR for this trunk commit' };
  if (candidates.length !== 1) return { kind: 'refused', reason: 'Ambiguous merged PR identity' };
  const pr = integer(candidates[0].number);
  const p = object(await api(`repos/${t.repo}/pulls/${pr}`), 'merged PR');
  const head = sha(object(p.head).sha);
  if (p.merged !== true || p.merge_commit_sha !== commit || object(p.base).ref !== t.config.trunk) return { kind: 'refused', reason: 'Merged PR identity moved' };
  const commits = (await pages(`repos/${t.repo}/pulls/${pr}/commits`)).map(v => object(v, 'PR commit'));
  if (commits.length !== integer(p.commits) || commits.length > 250 || commits.at(-1)?.sha !== head) return { kind: 'refused', reason: 'Full PR commits are not bound to the merged head' };
  const messages = commits.map(c => string(object(c.commit).message));
  let targets: LinearTarget[];
  try { targets = linearTargets(messages); }
  catch (error) { return { kind: 'refused', reason: error instanceof Error ? error.message : 'Malformed Pstack-Linear trailer' }; }
  if (!targets.length) return { kind: 'noop', reason: 'No Pstack-Linear trailers in the certified head' };
  const author = await principal();
  const status = await verdictStatus(t.repo, pr, head, author);
  if (status.kind !== 'trusted') return { kind: 'refused', reason: status.reason };
  const all = await comments(t.repo, pr);
  const comment = all.find(c => c.id === Number(status.commentId));
  if (!comment || !isPublication(comment, author)) return { kind: 'refused', reason: 'Referenced verdict publication is missing or untrusted' };
  const newest = all.filter(c => isPublication(c, author)).sort((a, b) => integer(b.id) - integer(a.id))[0];
  if (newest?.id !== comment.id) return { kind: 'refused', reason: 'A newer publication supersedes the referenced verdict' };
  const mergedAt = Date.parse(instant(p.merged_at, 'merge time'));
  const createdAt = instant(comment.created_at, 'publication time');
  if (Date.parse(createdAt) > mergedAt || instant(comment.updated_at, 'publication update') !== createdAt) return { kind: 'refused', reason: 'Verdict publication was late or edited' };
  const dossier = dossierFromComment(comment);
  const r = dossier.round;
  if (r.repo !== t.repo || r.pr !== pr || r.head !== head || r.configPath !== t.configPath || !['pre-pr', 'converge'].includes(r.execution) || dossier.decision.verdict !== 'VERIFIED') return { kind: 'refused', reason: 'VERIFIED dossier does not bind this repository, PR, and head' };
  return { kind: 'admitted', merge: { repo: t.repo, pr, commit, head, verdictUrl: status.url, dossier, targets } };
}
