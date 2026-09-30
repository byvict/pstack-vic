import { array, jsonHash, object, oneOf, string } from '../contract.ts';
import { linearTarget, targetIdentity } from '../linear-targets.ts';
import { LINEAR_PREFIX, type NativeCall } from './linear-session.ts';
import type { LinearMerge } from './linear-trust.ts';
import type { TargetRead } from './linear.ts';

type ProofClass = 'structural' | 'publication' | 'verification';
interface Origin { callId: string; session: string; line: number }
interface FieldProof { kind: 'structural'; id: string; subject: string; names: string[]; field: string; value: string | string[] | number | null; origin: Origin }
interface PublicationProof { sourceId: string; kind: 'publication'; id: string; subject: string; content: string; digest: string; origin: Origin }
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
export function linearReferenceIdentity(url: string): string { try { return targetIdentity(linearTarget(url)); } catch { return url; } }
function nativeUrl(value: string): boolean { try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'linear.app'; } catch { return false; } }
export function latestLinearReads(calls: NativeCall[]): NativeCall[] {
  const observations: { call: NativeCall; workspace: string | null; ids: string[]; addresses: string[] }[] = [];
  for (const call of calls) {
    if (!['get_issue', 'get_project', 'get_initiative', 'get_document', 'get_status_updates'].some(name => call.tool === LINEAR_PREFIX + name)) continue;
    let value: Record<string, unknown> = {};
    try { value = object(call.result); } catch {}
    const urls = [value.url, call.args.id, call.args.query].filter(v => typeof v === 'string' && nativeUrl(v));
    const workspace = urls.length ? new URL(string(urls[0])).pathname.split('/')[1] : null;
    const ids = [value.id, value.uuid].filter(v => typeof v === 'string');
    const addresses = [call.args.id, call.args.query, ...urls.map(v => linearReferenceIdentity(string(v)))].filter(v => typeof v === 'string');
    for (const url of urls) try { addresses.push(linearTarget(url).key); } catch {}
    for (let index = observations.length - 1; index >= 0; index--) {
      const previous = observations[index];
      if (previous.call.tool !== call.tool || previous.workspace && workspace && previous.workspace !== workspace) continue;
      const candidates = ids.length && previous.ids.length ? previous.ids : [...previous.ids, ...previous.addresses];
      const identities = ids.length && previous.ids.length ? ids : [...ids, ...addresses];
      if (identities.some(id => candidates.includes(id)) || addresses.some(a => a.includes(':') && previous.addresses.includes(a))) observations.splice(index, 1);
    }
    observations.push({ call, workspace, ids, addresses });
  }
  const reads = new Set(observations.map(o => o.call));
  return calls.filter(c => !observations.some(o => o.call.tool === c.tool) || reads.has(c));
}
export function proofCatalogue(merge: LinearMerge, calls: NativeCall[]): LinearProof[] {
  const records: LinearProof[] = [];
  for (const call of latestLinearReads(calls).filter(c => !c.error && c.result !== null)) {
    if (!call.tool.startsWith(LINEAR_PREFIX)) continue;
    let v: Record<string, unknown>;
    try { v = object(call.result); } catch { continue; }
    if (!bounded(v)) continue;
    if (['get_issue', 'get_project', 'get_initiative'].some(n => call.tool === LINEAR_PREFIX + n) && typeof v.url === 'string') {
      for (const field of fields) {
        const value = values(v[field]); if (value === undefined) continue;
        const fact = { kind: 'structural' as const, subject: v.url, names: [v.id, v.uuid, v.url].filter(v => typeof v === 'string'), field, value };
        records.push({ ...fact, id: jsonHash(fact), origin: origin(call) });
      }
    }
    const outputs = ['get_status_updates', 'get_document'].some(name => call.tool === LINEAR_PREFIX + name) ? [v] : [];
    for (const output of outputs) {
      const content = output.body ?? output.content;
      if (typeof output.url !== 'string' || !nativeUrl(output.url) || typeof output.id !== 'string' || typeof content !== 'string' || !content.trim()) continue;
      const fact = { kind: 'publication' as const, sourceId: output.id, subject: output.url, content, digest: jsonHash(content) };
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
export const assessmentFormat = 'Return JSON {"targets":[{"url":"explicit target URL","coverage":"complete|unknown","references":[{"key":"advertised source reference","required":true,"reason":"scope reason"}],"obligations":[{"source":"live source object ID","quote":"verbatim recorded obligation","kind":"acceptance|rollout","requiredClass":"structural|publication|verification|unknown","status":"met|unknown|unmet","outcome":{"subject":"exact entity URL or verification run name","field":"exact structural field","operator":"equals|includes","value":"required structural value","content":"required published-content excerpt","command":"required verification command"},"proofIds":["host catalogue ID"],"relevance":"how this concrete outcome meets this obligation"}]}]}. Source assertions and comment bodies are criteria/index data, not outcome evidence. A structural proof is valid only for the explicitly requested named field/value; a done state cannot stand for implemented or deployed behavior. Structural names, fields and values must be whole plain words using letters, numbers, underscores or hyphens, or whole backtick/single-quote/double-quote literals. Quoted literals are atomic; punctuation-bearing or multiword values require those delimiters in the recorded source. A publication proves only a recorded publication/content obligation naming its whole exact URL, including path, query, fragment and case, never deployment claims inside it. A plain URL must be whitespace bounded; adjacent sentence punctuation is ambiguous unless the source delimits the URL. A head-bound verification proves only a recorded check naming its whole command, including every argument, in backticks or quotes, never rollout from a generic exit code. Preserve the recorded quote; unsupported or ambiguous wording stays unknown with its specific obligation, outcome null and no proof IDs. Artifact metadata is not artifact content. Identify every advertised attachment/child/relation as required or irrelevant with a concrete scope reason; required unread sources mean unknown. List every scoped criterion: the two assessments define the obligation inventory, and host validation cannot detect a criterion that both omit. No generic relabeling of proof classes. Ambiguous scope or relevance remains unknown.';
function answerObject(answer: unknown): Record<string, unknown> { return object(typeof answer === 'string' ? JSON.parse(answer.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1')) : answer); }
interface Obligation { identity: string; met: boolean; text: string; proofIds: string[] }
const deployment = /\b(?:deploy(?:ment|ed|s)?|roll(?:out|(?:ed)? out)|ships? to prod|production|release(?:d)?|installed|implement(?:ed|ation)?|behavior|delivery|deliver(?:ed)?|after|before|when|once|unless|until|if|implantação|implantado|produção|após|quando)\b/i;
const publication = /\b(?:publish(?:ed)?|publication|posted|publica(?:ção|do|da)|publicar)\b/i;
const verification = /\b(?:verify|verification|check|test(?:s)?|pass(?:es)?|verific(?:ar|ação)|teste(?:s)?)\b/i;
function requestContext(quote: string, literals: string[]): string {
  return literals.reduce((text, value) => value ? text.split(value.toLowerCase()).join('') : text, quote.toLowerCase());
}
function recordedLiterals(text: string): { delimited: string[]; plain: string[] } {
  const delimited: string[] = [];
  const prose = text.replace(/`([^`\r\n]*)`|"([^"\r\n]*)"|'([^'\r\n]*)'/g, (_match: string, code: string | undefined, double: string | undefined, single: string | undefined) => {
    delimited.push(code ?? double ?? single ?? ''); return ' ';
  });
  return { delimited, plain: prose.split(/\s+/) };
}
function exactLiteral(text: string, value: string): boolean {
  if (!value.trim()) return false;
  const { delimited, plain } = recordedLiterals(text);
  return delimited.includes(value) || /^[\p{L}\p{N}_-]+$/u.test(value) && plain.some(token => token === value || /^[\p{L}\p{N}_-]+[.,;!?]$/u.test(token) && token.slice(0, -1) === value);
}
function literal(quote: string, value: unknown): boolean {
  return typeof value === 'string' ? exactLiteral(quote, value) : typeof value === 'number' ? exactLiteral(quote, String(value)) || value === 0 && exactLiteral(quote, 'zero') : Array.isArray(value) ? value.length > 0 && value.every(v => literal(quote, v)) : value === null && ['none', 'null'].some(v => exactLiteral(quote, v));
}
function namesEntity(quote: string, proof: FieldProof): boolean {
  const { delimited, plain } = recordedLiterals(quote);
  return [...delimited, ...plain].some(url => url.startsWith('https://') && linearReferenceIdentity(url) === linearReferenceIdentity(proof.subject)) || proof.names.some(name => !name.startsWith('https://') && exactLiteral(quote, name));
}
type Outcome = { kind: 'structural'; subject: string; field: string; operator: 'equals' | 'includes'; value: unknown } | { kind: 'publication'; subject: string; content: string } | { kind: 'verification'; subject: string; command: string };
function outcomeValue(kind: ProofClass, raw: unknown): Outcome {
  const value = object(raw), subject = string(value.subject);
  if (kind === 'structural') return { kind, subject: linearReferenceIdentity(subject), field: string(value.field), operator: oneOf(value.operator, ['equals', 'includes']), value: value.value };
  if (kind === 'publication') return { kind, subject, content: string(value.content) };
  return { kind, subject, command: string(value.command) };
}
function assess(answer: unknown, read: TargetRead, catalogue: LinearProof[]): Obligation[] | null {
  try {
    const assessment = array(answerObject(answer).targets).map(v => object(v)).find(t => targetIdentity(linearTarget(t.url)) === targetIdentity(read.target));
    if (!assessment || assessment.coverage !== 'complete') return null;
    const references = array(assessment.references ?? []).map(v => object(v));
    const referenceKey = (r: Record<string, unknown>) => linearReferenceIdentity(string(r.key));
    if (new Set(references.map(referenceKey)).size !== references.length) return null;
    const scope = read.references.map(ref => ({ key: ref.key, required: references.find(r => referenceKey(r) === linearReferenceIdentity(ref.key))?.required }));
    for (const ref of read.references) {
      const decision = references.find(r => referenceKey(r) === linearReferenceIdentity(ref.key));
      if (!decision || typeof decision.required !== 'boolean' || !string(decision.reason).trim() || decision.required && !ref.read) return null;
    }
    return array(assessment.obligations).map(raw => {
      const o = object(raw), source = string(o.source), quote = string(o.quote), kind = oneOf(o.kind, ['acceptance', 'rollout']);
      if (!quote.trim() || !read.texts.some(t => t.id === source && t.body.includes(quote))) throw new Error('Obligation has no verbatim live citation');
      let requiredClass: ProofClass, outcome: Outcome;
      try { requiredClass = oneOf(o.requiredClass, ['structural', 'publication', 'verification']); outcome = outcomeValue(requiredClass, o.outcome); }
      catch { return { identity: jsonHash({ scope, source, quote, kind, requiredClass: 'unknown' }), met: false, text: `${kind}: ${quote}`, proofIds: [] }; }
      const proofIds = array(o.proofIds).map(v => string(v)), relevance = string(o.relevance), { delimited, plain } = recordedLiterals(quote);
      const met = o.status === 'met' && !!relevance.trim() && proofIds.length > 0 && proofIds.every(id => {
        const proof = catalogue.find(p => p.id === id); if (!proof || proof.kind !== requiredClass || (proof.kind === 'structural' ? linearReferenceIdentity(proof.subject) : proof.subject) !== outcome.subject) return false;
        if (proof.kind === 'structural' && outcome.kind === 'structural') {
          const operation = outcome.operator;
          const matching = operation === 'equals' ? jsonHash(outcome.value) === jsonHash(proof.value) : Array.isArray(proof.value) && proof.value.includes(string(outcome.value));
          const requestedValues = Array.isArray(outcome.value) ? outcome.value.map(v => string(v)) : typeof outcome.value === 'string' ? [outcome.value] : [];
          return !deployment.test(requestContext(quote, [...proof.names, proof.field, ...requestedValues])) && matching && outcome.field === proof.field && exactLiteral(quote, proof.field) && literal(quote, outcome.value) && namesEntity(quote, proof);
        }
        if (proof.kind === 'publication' && outcome.kind === 'publication') return !deployment.test(requestContext(quote, [proof.subject])) && publication.test(quote) && [...delimited, ...plain].includes(proof.subject) && proof.subject !== read.target.url && !read.texts.some(t => t.id === source && t.body === proof.content) && typeof outcome.content === 'string' && outcome.content.trim().length > 0 && proof.content.includes(outcome.content) && outcome.content !== quote;
        return proof.kind === 'verification' && outcome.kind === 'verification' && kind !== 'rollout' && !deployment.test(requestContext(quote, [proof.command])) && verification.test(quote) && delimited.includes(proof.command) && outcome.command === proof.command;
      });
      const identityOutcome = outcome.kind === 'publication' ? { kind: outcome.kind, subject: outcome.subject } : outcome;
      return { identity: jsonHash({ scope, source, quote, kind, requiredClass, outcome: identityOutcome }), met, text: `${o.kind}: ${quote}`, proofIds };
    });
  } catch { return null; }
}
export function completionEvidence(read: TargetRead, answers: [unknown, unknown], catalogue: LinearProof[]): CompletionEvidence {
  const first = assess(answers[0], read, catalogue), second = assess(answers[1], read, catalogue);
  if (!first || !second) return { complete: false, remaining: ['The scope, required source coverage or outcome proof is unverified.', ...read.references.filter(r => !r.read).map(r => `Unread advertised source: ${r.key}`)], proofIds: [] };
  const a = new Map(first.map(o => [o.identity, o])), b = new Map(second.map(o => [o.identity, o]));
  if (a.size !== first.length || b.size !== second.length || a.size !== b.size || [...a.keys()].some(k => !b.has(k))) return { complete: false, remaining: ['Independent assessments disagree on the obligations, required proof class or concrete outcome.', ...new Set([...first, ...second].map(o => o.text))], proofIds: [] };
  const remaining = [...a].filter(([key, o]) => !o.met || !b.get(key)?.met).map(([, o]) => o.text);
  return { complete: a.size > 0 && !remaining.length, remaining: a.size ? remaining : ['No scoped obligations have verified outcomes.'], proofIds: [...new Set([...first, ...second].flatMap(o => o.proofIds))] };
}
