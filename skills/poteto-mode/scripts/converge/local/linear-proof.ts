import { array, jsonHash, object, oneOf, string } from '../contract.ts';
import { linearTarget, targetIdentity } from '../linear-targets.ts';
import { LINEAR_PREFIX, type NativeCall } from './linear-session.ts';
import type { LinearMerge } from './linear-trust.ts';
import type { TargetRead } from './linear.ts';

type ProofClass = 'structural' | 'publication' | 'verification';
interface Origin { callId: string; session: string; line: number }
interface FieldProof { kind: 'structural'; id: string; subject: string; names: string[]; field: string; value: string | string[] | number | null; origin: Origin }
interface PublicationProof { kind: 'publication'; id: string; subject: string; content: string; digest: string; origin: Origin }
interface VerificationProof { kind: 'verification'; id: string; subject: string; command: string; head: string; logDigest: string; publication: string }
export type LinearProof = FieldProof | PublicationProof | VerificationProof;
export interface CompletionEvidence { complete: boolean; remaining: string[]; proofIds: string[] }
const fields = ['assigneeId', 'assignee', 'projectId', 'project', 'parentId', 'teamId', 'initiativeId', 'initiative', 'labels', 'initiatives', 'status', 'statusType'] as const;
function origin(call: NativeCall): Origin { return { callId: call.id, session: call.session, line: call.line }; }
function values(raw: unknown): string | string[] | number | null | undefined {
  if (raw === null || typeof raw === 'string' || typeof raw === 'number') return raw;
  if (Array.isArray(raw)) return raw.map(v => typeof v === 'string' ? v : string(object(v).name ?? object(v).id));
  return undefined;
}
function bounded(v: Record<string, unknown>): boolean { return v.truncated !== true && v.isTruncated !== true && v.hasNextPage !== true && !(v.pageInfo && object(v.pageInfo).hasNextPage === true); }
export function proofCatalogue(merge: LinearMerge, calls: NativeCall[]): LinearProof[] {
  const records: LinearProof[] = [];
  for (const call of calls.filter(c => !c.error && c.result !== null)) {
    if (!call.tool.startsWith(LINEAR_PREFIX)) continue;
    let v: Record<string, unknown>;
    try { v = object(call.result); } catch { continue; }
    if (!bounded(v)) continue;
    if (['get_issue', 'get_project', 'get_initiative'].some(n => call.tool === LINEAR_PREFIX + n) && typeof v.url === 'string') {
      for (const field of fields) {
        const value = values(v[field]); if (value === undefined) continue;
        const fact = { kind: 'structural' as const, subject: v.url, names: [v.id, v.uuid, v.title, v.name, v.url].filter(v => typeof v === 'string'), field, value };
        records.push({ ...fact, id: jsonHash(fact), origin: origin(call) });
      }
    }
    const outputs = call.tool === LINEAR_PREFIX + 'get_status_updates' ? v.updates === undefined ? [v] : array(v.updates).map(raw => object(raw)) : call.tool === LINEAR_PREFIX + 'get_document' ? [v] : [];
    for (const output of outputs) {
      const content = output.body ?? output.content;
      if (!bounded(output) || typeof output.url !== 'string' || typeof output.id !== 'string' || typeof content !== 'string' || !content.trim()) continue;
      const fact = { kind: 'publication' as const, subject: output.url, content, digest: jsonHash(content) };
      records.push({ ...fact, id: jsonHash(fact), origin: origin(call) });
    }
  }
  for (const run of merge.dossier.certificate?.runs ?? []) {
    if (!('exitCode' in run) || run.exitCode !== 0 || !run.clean || run.head !== merge.head || !run.logDigest || /^(?:true|echo\b)/.test(run.command) || /release|after-merge/.test(run.name + ' ' + run.command)) continue;
    const fact = { kind: 'verification' as const, subject: run.name, command: run.command, head: run.head, logDigest: run.logDigest, publication: merge.verdictUrl };
    records.push({ ...fact, id: jsonHash(fact) });
  }
  return [...new Map(records.map(r => [r.id, r])).values()];
}
export const assessmentFormat = 'Return JSON {"targets":[{"url":"explicit target URL","coverage":"complete|unknown","references":[{"key":"advertised source reference","required":true,"reason":"scope reason"}],"obligations":[{"source":"live source object ID","quote":"verbatim recorded obligation","kind":"acceptance|rollout","requiredClass":"structural|publication|verification","status":"met|unknown|unmet","outcome":{"subject":"exact entity URL or verification run name","field":"exact structural field","operator":"equals|includes","value":"required structural value","content":"required published-content excerpt","command":"required verification command"},"proofIds":["host catalogue ID"],"relevance":"how this concrete outcome meets this obligation"}]}]}. Source assertions and comment bodies are criteria/index data, not outcome evidence. A structural proof is valid only for the explicitly requested named field/value; a done state cannot stand for implemented or deployed behavior. A publication proves only a recorded publication/content obligation naming its exact URL, never deployment claims inside it. A structural obligation must literally name the field, entity and required value; unsupported natural-language equivalents remain unknown. A head-bound verification proves only a recorded check naming its exact command, never rollout from a generic exit code. Artifact metadata is not artifact content. Identify every advertised attachment/child/relation as required or irrelevant with a concrete scope reason; required unread sources mean unknown. No generic relabeling of proof classes. Ambiguous scope or relevance remains unknown.';
function answerObject(answer: unknown): Record<string, unknown> { return object(typeof answer === 'string' ? JSON.parse(answer.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1')) : answer); }
interface Obligation { identity: string; met: boolean; text: string; proofIds: string[] }
const deployment = /\b(?:deploy(?:ment|ed)?|roll(?:out| out)|production|released|installed|implantação|implantado|produção)\b/i;
const publication = /\b(?:publish(?:ed)?|publication|posted|publica(?:ção|do|da)|publicar)\b/i;
const verification = /\b(?:verify|verification|check|test(?:s)?|pass(?:es)?|verific(?:ar|ação)|teste(?:s)?)\b/i;
function literal(quote: string, value: unknown): boolean {
  const q = quote.toLocaleLowerCase();
  return typeof value === 'string' ? !!value.trim() && q.includes(value.toLocaleLowerCase()) : typeof value === 'number' ? q.includes(String(value)) || value === 0 && /\bzero\b/i.test(quote) : Array.isArray(value) ? value.length > 0 && value.every(v => literal(quote, v)) : value === null && /\b(?:none|null|no |without)\b/i.test(quote);
}
function assess(answer: unknown, read: TargetRead, catalogue: LinearProof[]): Obligation[] | null {
  try {
    const assessment = array(answerObject(answer).targets).map(v => object(v)).find(t => targetIdentity(linearTarget(t.url)) === targetIdentity(read.target));
    if (!assessment || assessment.coverage !== 'complete') return null;
    const references = array(assessment.references ?? []).map(v => object(v));
    if (new Set(references.map(r => r.key)).size !== references.length) return null;
    const scope = read.references.map(ref => ({ key: ref.key, required: references.find(r => r.key === ref.key)?.required }));
    for (const ref of read.references) {
      const decision = references.find(r => r.key === ref.key);
      if (!decision || typeof decision.required !== 'boolean' || !string(decision.reason).trim() || decision.required && !ref.read) return null;
    }
    return array(assessment.obligations).map(raw => {
      const o = object(raw), source = string(o.source), quote = string(o.quote), requiredClass: ProofClass = oneOf(o.requiredClass, ['structural', 'publication', 'verification']), outcome = object(o.outcome);
      if (!quote.trim() || !read.texts.some(t => t.id === source && t.body.includes(quote))) throw new Error('Obligation has no verbatim live citation');
      const proofIds = array(o.proofIds).map(v => string(v)), relevance = string(o.relevance);
      const met = o.status === 'met' && !!relevance.trim() && proofIds.length > 0 && proofIds.every(id => {
        const proof = catalogue.find(p => p.id === id); if (!proof || proof.kind !== requiredClass || proof.subject !== outcome.subject) return false;
        if (proof.kind === 'structural') {
          const operation = oneOf(outcome.operator, ['equals', 'includes']);
          const matching = operation === 'equals' ? jsonHash(outcome.value) === jsonHash(proof.value) : Array.isArray(proof.value) && proof.value.includes(string(outcome.value));
          return !deployment.test(quote) && matching && outcome.field === proof.field && quote.toLowerCase().includes(proof.field.toLowerCase()) && literal(quote, outcome.value) && proof.names.some(name => quote.includes(name));
        }
        if (proof.kind === 'publication') return !deployment.test(quote) && publication.test(quote) && quote.includes(proof.subject) && proof.subject !== read.target.url && !read.texts.some(t => t.id === source && t.body === proof.content) && typeof outcome.content === 'string' && outcome.content.trim().length > 0 && proof.content.includes(outcome.content) && outcome.content !== quote;
        return o.kind !== 'rollout' && !deployment.test(quote) && verification.test(quote) && quote.includes(proof.command) && outcome.command === proof.command;
      });
      return { identity: jsonHash({ scope, source, quote, kind: oneOf(o.kind, ['acceptance', 'rollout']), requiredClass, outcome }), met, text: `${o.kind}: ${quote}`, proofIds };
    });
  } catch { return null; }
}
export function completionEvidence(read: TargetRead, answers: [unknown, unknown], catalogue: LinearProof[]): CompletionEvidence {
  const first = assess(answers[0], read, catalogue), second = assess(answers[1], read, catalogue);
  if (!first || !second) return { complete: false, remaining: ['The scope, required source coverage or outcome proof is unverified.', ...read.references.filter(r => !r.read).map(r => `Unread advertised source: ${r.key}`)], proofIds: [] };
  const a = new Map(first.map(o => [o.identity, o])), b = new Map(second.map(o => [o.identity, o]));
  if (a.size !== first.length || b.size !== second.length || a.size !== b.size || [...a.keys()].some(k => !b.has(k))) return { complete: false, remaining: ['Independent assessments disagree on the obligations, required proof class or concrete outcome.'], proofIds: [] };
  const remaining = [...a].filter(([key, o]) => !o.met || !b.get(key)?.met).map(([, o]) => o.text);
  return { complete: a.size > 0 && !remaining.length, remaining: a.size ? remaining : ['No scoped obligations have verified outcomes.'], proofIds: [...new Set([...first, ...second].flatMap(o => o.proofIds))] };
}
