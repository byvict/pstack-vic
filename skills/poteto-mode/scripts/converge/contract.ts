import { createHash, randomUUID } from 'node:crypto';

export function object(value: unknown, label = 'object'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return Object.fromEntries(Object.entries(value));
}
export function string(value: unknown, label = 'string'): string {
  if (typeof value !== 'string') throw new Error(`Invalid ${label}`);
  return value;
}
export function integer(value: unknown, label = 'integer'): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${label}`);
  return value;
}
export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Invalid array');
  return value;
}
export function strings(value: unknown): string[] { return array(value).map(v => string(v)); }
export function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('Invalid boolean');
  return value;
}
export function oneOf<const T extends readonly string[]>(value: unknown, options: T): T[number] {
  const found = options.find(option => option === value);
  if (found === undefined) throw new Error('Invalid enum value');
  return found;
}
export function sha(value: unknown): string {
  const result = string(value);
  if (!/^[a-f0-9]{40}$/.test(result)) throw new Error('Expected full commit SHA');
  return result;
}
export function digest(value: unknown): string {
  const result = string(value);
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error('Invalid digest');
  return result;
}
export function repoName(value: unknown): string {
  const result = string(value);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(result)) throw new Error('Invalid repository');
  return result;
}
export function relativePath(value: unknown): string {
  const result = string(value);
  if (!result || result.startsWith('/') || /[\\%:?#\x00-\x1f\x7f]/.test(result) || result.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Unsafe relative path');
  return result;
}
export function hash(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)]));
  return value;
}
export function jsonHash(value: unknown): string { return hash(JSON.stringify(canonical(value))); }
export function executionId(): string { return randomUUID(); }
export function parseExecutionId(value: unknown): string {
  const result = string(value);
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(result)) throw new Error('Invalid execution id');
  return result;
}
export type Execution = 'converge' | 'verdict-only';
export type Role = 'pr verifier';
export interface Contract {
  repo: string; trunk: string; requiredChecks: string[]; holdLabels: string[];
  surfaces: string[]; riskClasses: { irreversible: string[]; contained: string[] };
  verifySkill: string; featureMap: string; evidenceRoot: string; deployWindow: string; bugbot: 'never';
}
export function parseContract(value: unknown): Contract {
  const v = object(value, 'contract');
  const risk = object(v.riskClasses);
  const result: Contract = {
    repo: repoName(v.repo), trunk: relativePath(v.trunk), requiredChecks: strings(v.requiredChecks), holdLabels: strings(v.holdLabels),
    surfaces: strings(v.surfaces), riskClasses: { irreversible: strings(risk.irreversible), contained: strings(risk.contained) },
    verifySkill: relativePath(v.verifySkill), featureMap: relativePath(v.featureMap), evidenceRoot: relativePath(v.evidenceRoot),
    deployWindow: string(v.deployWindow), bugbot: oneOf(v.bugbot, ['never']),
  };
  if (!result.requiredChecks.includes('verdict') || !result.holdLabels.length || !/^\d\d:\d\d [A-Za-z_]+\/[A-Za-z_]+$/.test(result.deployWindow)) throw new Error('Incomplete converge contract');
  for (const pattern of [...result.surfaces, ...riskPatterns(result)]) relativePath(pattern);
  return result;
}
export function riskPatterns(contract: Contract): string[] { return [...contract.riskClasses.irreversible, ...contract.riskClasses.contained]; }
export function matches(path: string, pattern: string): boolean {
  let expression = '^';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*' && pattern[i + 1] === '*') {
      i++;
      if (pattern[i + 1] === '/') { i++; expression += '(?:.*/)?'; } else expression += '.*';
    } else if (char === '*') expression += '[^/]*';
    else expression += char?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(expression + '$').test(path);
}
export function testOnly(path: string): boolean {
  return /(?:^|\/)(?:__tests__|__fixtures__|__mocks__)\//.test(path) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path);
}
export interface Round {
  id: string; repo: string; pr: number; head: string; contract: string; base: string; patch_id: string;
  verificationDigest: string; inputDigest: string; configPath: string; execution: Execution;
}
export function parseRound(value: unknown): Round {
  const v = object(value, 'round');
  const pr = integer(v.pr);
  if (!pr) throw new Error('Invalid PR');
  return { id: parseExecutionId(v.id), repo: repoName(v.repo), pr, head: sha(v.head), contract: sha(v.contract), base: sha(v.base),
    patch_id: sha(v.patch_id), verificationDigest: digest(v.verificationDigest), inputDigest: digest(v.inputDigest),
    configPath: relativePath(v.configPath), execution: oneOf(v.execution, ['converge', 'verdict-only']) };
}
export const findingKinds = ['regression', 'test-behavior', 'documentary', 'injection', 'data-loss', 'secret', 'money', 'false-claim'] as const;
export interface Finding {
  kind: typeof findingKinds[number]; source: 'diff' | 'body' | 'comment' | 'log' | 'lane';
  path: string | null; line: number; rule: string; severity: 'blocking' | 'requires-proof';
}
export function parseFinding(value: unknown): Finding {
  const v = object(value, 'finding');
  return { kind: oneOf(v.kind, findingKinds), ...parseObligation(v), severity: oneOf(v.severity, ['blocking', 'requires-proof']) };
}
export type RiskObligation = Pick<Finding, 'source' | 'path' | 'line' | 'rule'>;
export function riskObligation(finding: Finding): RiskObligation {
  return { source: finding.source, path: finding.path, line: finding.line, rule: finding.rule };
}
export function parseObligation(value: unknown): RiskObligation {
  const v = object(value, 'risk obligation');
  const rule = string(v.rule);
  if (!/^[a-z][a-z0-9-]{0,79}$/.test(rule)) throw new Error('Unsafe finding rule');
  return { source: oneOf(v.source, ['diff', 'body', 'comment', 'log', 'lane']), path: v.path === null ? null : relativePath(v.path), line: integer(v.line), rule };
}
export function sameObligation(left: RiskObligation, right: RiskObligation): boolean {
  return left.source === right.source && left.path === right.path && left.line === right.line && left.rule === right.rule;
}
export interface Feature { id: string; page: string; recipe: string; recipeDigest: string }
export interface Claim {
  line: number; kind: 'check' | 'test' | 'feature' | 'artifact' | 'unsupported'; name: string;
  artifactFound: boolean; resolution: 'supported' | 'missing' | 'unavailable' | 'current-feature';
}
export interface Check { context: string; id: number; head: string; appId: number; state: string; runId: number | null; attempt: number | null }
export interface Report {
  schemaVersion: 1; round: Round; mode: 'full' | 'ci-only'; touchedFeatures: Feature[]; unmappedSurfaces: string[];
  claims: Claim[]; hardList: Finding[]; injection: Finding[]; findings: Finding[]; checks: Check[];
  lanes: Role[]; gaps: string[]; inputFingerprint: string;
}
export function parseReport(value: unknown): Report {
  const v = object(value, 'report');
  if (v.schemaVersion !== 1) throw new Error('Unsupported report schema');
  return { schemaVersion: 1, round: parseRound(v.round), mode: oneOf(v.mode, ['full', 'ci-only']),
    touchedFeatures: array(v.touchedFeatures).map(value => { const f = object(value); return { id: relativePath(f.id), page: relativePath(f.page), recipe: relativePath(f.recipe), recipeDigest: digest(f.recipeDigest) }; }),
    unmappedSurfaces: strings(v.unmappedSurfaces).map(relativePath),
    claims: array(v.claims).map(value => { const c = object(value); return { line: integer(c.line), kind: oneOf(c.kind, ['check', 'test', 'feature', 'artifact', 'unsupported']), name: string(c.name), artifactFound: boolean(c.artifactFound), resolution: oneOf(c.resolution, ['supported', 'missing', 'unavailable', 'current-feature']) }; }),
    hardList: array(v.hardList).map(parseFinding), injection: array(v.injection).map(parseFinding), findings: array(v.findings).map(parseFinding),
    checks: array(v.checks).map(value => { const c = object(value); return { context: string(c.context), id: integer(c.id), head: sha(c.head), appId: integer(c.appId), state: string(c.state), runId: c.runId === null ? null : integer(c.runId), attempt: c.attempt === null ? null : integer(c.attempt) }; }),
    lanes: array(v.lanes).map(v => oneOf(v, ['pr verifier'])), gaps: strings(v.gaps), inputFingerprint: digest(v.inputFingerprint) };
}
export type Decision =
  | { verdict: 'VERIFIED'; displayResult: 'VERIFIED' | 'CI-only'; findings: []; reasons: [] }
  | { verdict: 'NOT VERIFIED'; displayResult: 'NOT VERIFIED'; findings: [Finding, ...Finding[]]; reasons: string[] }
  | { verdict: 'INCONCLUSIVE'; displayResult: 'INCONCLUSIVE'; findings: Finding[]; reasons: [string, ...string[]] };
export interface Dossier {
  schemaVersion: 1; round: Round; decision: Decision; evidenceDigest: string; reconcileDigest: string;
  coverage: string[]; riskAdjudication: RiskObligation[]; artifactIds: string[]; inputFingerprint: string; retainedFrom: { round: string; head: string; commentUrl: string } | null;
}
