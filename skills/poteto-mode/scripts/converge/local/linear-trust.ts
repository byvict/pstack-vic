import { array, instant, integer, object, sha, string, type Dossier } from '../contract.ts';
import { api, comments, isPublication, pages, principal, verdictStatus, type Trusted } from '../github.ts';
import { dossierFromComment } from '../publish.ts';

export interface LinearTarget { kind: 'issue' | 'project'; url: string; workspace: string; key: string }
export interface LinearMerge { repo: string; pr: number; commit: string; head: string; verdictUrl: string; dossier: Dossier; targets: LinearTarget[] }
export type LinearAdmission = { kind: 'admitted'; merge: LinearMerge } | { kind: 'noop' | 'refused'; reason: string };

export function linearTarget(value: unknown): LinearTarget {
  const literal = string(value, 'Linear URL');
  if (/\s/.test(literal)) throw new Error('Expected a full Linear URL without whitespace');
  const url = new URL(literal);
  if (url.protocol !== 'https:' || url.hostname !== 'linear.app' || url.port || url.username || url.password || url.search || url.hash) throw new Error('Expected a full Linear issue or project URL');
  const issue = /^\/([^/]+)\/issue\/([A-Z][A-Z0-9]*-\d+)(?:\/[^/]+)?\/?$/.exec(url.pathname);
  const project = /^\/([^/]+)\/project\/([^/]+)(?:\/overview)?\/?$/.exec(url.pathname);
  if (issue) return { kind: 'issue', url: url.href.replace(/\/$/, ''), workspace: issue[1], key: issue[2] };
  if (project) return { kind: 'project', url: url.href.replace(/\/overview\/?$/, '').replace(/\/$/, ''), workspace: project[1], key: project[2] };
  throw new Error('Expected a full Linear issue or project URL');
}
export function targetIdentity(target: LinearTarget): string { return `${target.workspace}:${target.kind}:${target.key}`; }

/** Refs live in the immutable trailer paragraph of commits, never the editable PR text. */
export function linearTargets(messages: string[]): LinearTarget[] {
  const targets = new Map<string, LinearTarget>();
  for (const message of messages) {
    const paragraphs = message.replace(/\r\n/g, '\n').trimEnd().split(/\n{2,}/);
    const last = paragraphs.length > 1 ? (paragraphs.at(-1) ?? '').split('\n') : [];
    const block = last.every(line => /^[A-Za-z][A-Za-z0-9-]*: \S/.test(line)) ? last : [];
    const outside = (block.length ? paragraphs.slice(0, -1) : paragraphs).flatMap(part => part.split('\n'));
    if (outside.some(line => /^pstack-linear\s*:/i.test(line))) throw new Error('Pstack-Linear must be in the final commit trailer paragraph');
    for (const line of block.filter(line => /^pstack-linear:/i.test(line))) {
      const target = linearTarget(line.slice(line.indexOf(':') + 1).trim());
      targets.set(targetIdentity(target), target);
    }
  }
  return [...targets.values()];
}

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
  const targets = linearTargets(commits.map(c => string(object(c.commit).message)));
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
