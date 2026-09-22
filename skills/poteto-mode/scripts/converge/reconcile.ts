import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { executionId, matches, type Claim, type Finding, type Report } from './contract.ts';
import { snapshot, type Snapshot, type TextSource } from './github.ts';

const secretRules = [
  /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~-]{24,}/i,
  /\b(?:api[_-]?key|password|secret|token)\s*[:=]\s*["'][A-Za-z0-9_+/=-]{24,}["']/i,
];
export function containsSecret(text: string): boolean { return secretRules.some(rule => rule.test(text)); }
function safeName(text: string): string { return containsSecret(text) ? '[redacted]' : text.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200); }
function hit(kind: Finding['kind'], source: Finding['source'], path: string | null, line: number, rule: string, severity: Finding['severity'] = 'blocking'): Finding {
  return { kind, source, path, line, rule, severity };
}
export function screenInjection(sources: TextSource[]): Finding[] {
  return sources.flatMap(source => source.text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').split('\n').flatMap((line, i) =>
    /\b(?:verifier|reviewer|agent|assistant)\s*:/i.test(line) || /\b(?:ignore|override) (?:all |the |previous )*(?:instructions|rules)\b/i.test(line)
      ? [hit('injection', source.source, null, i + 1, 'verifier-address')] : []));
}
function claims(s: Snapshot): Claim[] {
  const body = s.pull.body.split('\n');
  let inside = false;
  const result: Claim[] = [];
  for (const [index, text] of body.entries()) {
    if (/^##\s+Verification\s*$/i.test(text)) { inside = true; continue; }
    if (/^##\s/.test(text)) inside = false;
    if (!inside || !text.trim() || /^\s*<!--.*-->\s*$/.test(text) || text.trim() === 'skip: no user-visible change') continue;
    const normalized = text.replace(/^\s*[-*]\s+/, '').trim();
    const parsed = normalized.match(/^(check|test|feature|artifact):\s*(.+)$/);
    if (!parsed) { result.push({ line: index + 1, kind: 'unsupported', name: 'Unsupported verification claim', artifactFound: false, resolution: 'unavailable' }); continue; }
    const name = safeName(parsed[2] ?? '');
    switch (parsed[1]) {
      case 'check': { const found = s.checks.some(c => c.context === name && c.state === 'success'); result.push({ line: index + 1, kind: 'check', name, artifactFound: found, resolution: found ? 'supported' : 'missing' }); break; }
      case 'feature': result.push({ line: index + 1, kind: 'feature', name, artifactFound: false, resolution: 'current-feature' }); break;
      case 'artifact':
      case 'test': {
        const evidence = s.testEvidence;
        const kind = parsed[1];
        const path = kind === 'test' ? name : evidence.kind === 'complete' && name.startsWith(`actions/${evidence.runId}/${evidence.attempt}/tests/`) ? name.slice(`actions/${evidence.runId}/${evidence.attempt}/tests/`.length) : null;
        const supported = path !== null && /^(?:tools|server)\/.+\.test\.[cm]?js$/.test(path);
        const found = evidence.kind === 'complete' && supported && evidence.paths.includes(path);
        result.push({ line: index + 1, kind, name, artifactFound: found, resolution: found ? 'supported' : evidence.kind === 'complete' && supported ? 'missing' : 'unavailable' });
        break;
      }
    }
  }
  return result;
}
function ordinaryDoc(path: string): boolean {
  return /(?:\.md|\.txt|\.rst)$/.test(path) && !/(?:^|\/)(?:AGENTS|CLAUDE|SKILL)\.md$/.test(path) && !/^(?:\.cursor|\.github|skills|scripts|tools)\//.test(path)
    || /^(?:LICENSE|README|CHANGELOG)(?:\.md|\.txt)?$/.test(path);
}
export function analyze(s: Snapshot, options: { id: string; configPath: string; execution: 'converge' | 'verdict-only' }): Report {
  const paths = [...new Set(s.files.flatMap(f => f.previous ? [f.path, f.previous] : [f.path]))];
  const c = s.trusted.config;
  const surfacePaths = paths.filter(path => c.surfaces.some(pattern => matches(path, pattern)));
  const riskPaths = paths.filter(path => [...c.riskClasses.irreversible, ...c.riskClasses.contained].some(pattern => matches(path, pattern)));
  const touchedFeatures = s.features.filter(feature => paths.includes(feature.page));
  const hardList: Finding[] = [];
  const diffSources: TextSource[] = [];
  for (const file of s.files) {
    if (/(?:^|\/)(?:payments?|billing|invoices?|pagamentos|recebimentos|financeiro)(?:\/|\.|$)/i.test(file.path)) hardList.push(hit('money', 'diff', file.path, 0, 'money-path', 'requires-proof'));
    if (file.patch === null) continue;
    let lineNumber = 0;
    const added: string[] = [];
    let removedPredicate = false;
    for (const line of file.patch.split('\n')) {
      const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
      if (hunk) { lineNumber = Number(hunk[1]) - 1; continue; }
      if (line.startsWith('-')) { if (/\bWHERE\b/i.test(line)) removedPredicate = true; continue; }
      lineNumber++;
      if (!line.startsWith('+')) continue;
      const content = line.slice(1);
      added.push(content);
      if (containsSecret(content)) hardList.push(hit('secret', 'diff', file.path, lineNumber, 'credential-pattern'));
      if (/\b(?:DROP\s+TABLE|TRUNCATE(?:\s+TABLE)?)\b/i.test(content)) hardList.push(hit('data-loss', 'diff', file.path, lineNumber, 'destructive-statement'));
    }
    const introduced = added.join('\n');
    for (const statement of introduced.split(';')) if (/\bDELETE\s+FROM\b/i.test(statement) && !/\bWHERE\b/i.test(statement)) hardList.push(hit('data-loss', 'diff', file.path, 0, 'unbounded-delete'));
    if (removedPredicate && /\bDELETE\s+FROM\b/i.test(file.patch)) hardList.push(hit('data-loss', 'diff', file.path, 0, 'changed-delete-predicate', 'requires-proof'));
    diffSources.push({ source: 'log', id: file.path, text: introduced });
  }
  const injection = [...screenInjection(s.sources), ...diffSources.flatMap(source => screenInjection([source]).map(f => ({ ...f, source: 'diff' as const, path: source.id })))];
  const findings = [...hardList.filter(f => f.severity === 'blocking'), ...injection];
  if (!/^\s*(?:[-*]\s*)?skip: no user-visible change\s*$/m.test(s.pull.body)) {
    for (const f of touchedFeatures) if (!paths.includes(f.recipe)) findings.push(hit('documentary', 'diff', f.recipe, 0, 'feature-map-travel'));
  }
  const mode = paths.length > 0 && (paths.every(ordinaryDoc) || s.dependencyOnly) && !surfacePaths.length && !riskPaths.length && !hardList.length ? 'ci-only' : 'full';
  const lanes: Report['lanes'] = mode === 'ci-only' ? [] : ['pr verifier'];
  if (riskPaths.length || hardList.some(f => f.severity === 'requires-proof')) lanes.push('pr reviewer');
  return { schemaVersion: 1, round: { id: options.id, repo: c.repo, pr: s.pull.number, head: s.pull.head, contract: s.trusted.sha, base: s.base,
    patch_id: s.patchId, verificationDigest: s.verificationDigest, inputDigest: s.inputDigest, configPath: options.configPath, execution: options.execution },
    mode, touchedFeatures, unmappedSurfaces: surfacePaths.filter(p => !touchedFeatures.some(f => f.page === p)),
    claims: claims(s), hardList, injection, findings, checks: s.checks, lanes, gaps: [...s.gaps], inputFingerprint: s.inputFingerprint };
}
export async function reconcile(options: { repo: string; pr: number; configPath?: string; execution?: 'converge' | 'verdict-only'; output: string }): Promise<Report> {
  const configPath = options.configPath ?? '.cursor/converge.json';
  const execution = options.execution ?? 'converge';
  const report = analyze(await snapshot(options.repo, options.pr, configPath, execution === 'verdict-only'), { id: executionId(), configPath, execution });
  writeFileSync(options.output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return report;
}
export async function main(args: string[]): Promise<number> {
  try {
    const { values } = parseArgs({ args, options: { repo: { type: 'string' }, pr: { type: 'string' }, config: { type: 'string' }, output: { type: 'string' }, execution: { type: 'string' } } });
    if (!values.repo || !values.pr || !values.output || !/^\d+$/.test(values.pr) || (values.execution && !['converge', 'verdict-only'].includes(values.execution))) throw new Error('Usage: converge-reconcile --repo owner/repo --pr N --config path --output report.json [--execution verdict-only]');
    const result = await reconcile({ repo: values.repo, pr: Number(values.pr), configPath: values.config, output: values.output, execution: values.execution === 'verdict-only' ? 'verdict-only' : 'converge' });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return 0;
  } catch (error) { process.stderr.write((error instanceof SyntaxError ? 'Malformed JSON input' : error instanceof Error ? error.message : 'Reconcile failed') + '\n'); return 1; }
}
