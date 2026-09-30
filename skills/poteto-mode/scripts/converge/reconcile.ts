import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { executionId, executions, matches, testOnly, type Claim, type Execution, type Finding, type Report } from './contract.ts';
import { snapshot, type BranchCommit, type Snapshot, type TextSource } from './github.ts';
import { loadMatrix, parseDescriptor, type ModelMatrix } from '../../../../scripts/model-matrix.ts';

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
    /^\s*(?:[-*]>\s*)?(?:verifier|reviewer|agent|assistant)\s*:\s*(?:ignore|override|run|execute|change|skip|publish|approve|merge)\b/i.test(line) || /\b(?:ignore|override) (?:all |the |previous )*(?:instructions|rules)\b/i.test(line)
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
    if (!parsed) continue;
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
const AUTHOR_TRAILER = 'pstack-author';
/** One entry per Pstack-Author line of the message, the key compared without case: its value when the trailer block holds the line, null anywhere else, so a misplaced or malformed line fails closed instead of vanishing. The trailer block is the message's last paragraph when every line there is `Key: value`, as git reads it; a subject-only message has none. Linear in the message, which a commit author controls. */
export function authorTrailers(message: string): (string | null)[] {
  const paragraphs = message.replace(/\r\n/g, '\n').trimEnd().split(/\n{2,}/);
  const last = paragraphs.length > 1 ? (paragraphs.at(-1) ?? '').split('\n') : [];
  const block = last.every(line => /^[A-Za-z][A-Za-z0-9-]*: \S/.test(line)) ? last : [];
  const outside = (block.length ? paragraphs.slice(0, -1) : paragraphs).flatMap(paragraph => paragraph.split('\n'));
  return [
    ...block.filter(line => line.slice(0, line.indexOf(':')).toLowerCase() === AUTHOR_TRAILER).map(line => line.slice(line.indexOf(':') + 1).trim()),
    ...outside.filter(line => /^pstack-author\s*:/i.test(line)).map(() => null),
  ];
}
/** `Pstack-Author: <provider>` or `Pstack-Author: <provider>:<model>@<effort>` with a matrix provider: that provider, or null. The long form needs only the descriptor's grammar, not a family the matrix still lists, because trailers outlive the models and efforts the matrix retires. */
function trailerProvider(value: string, matrix: ModelMatrix): string | null {
  const provider = parseDescriptor(value)?.provider ?? value;
  return Object.hasOwn(matrix.providers, provider) ? provider : null;
}
/** The author families the branch's commits record, once each and sorted, and one gap per Pstack-Author line that names no matrix provider or sits outside its message's trailer block. */
export function authorFamilies(commits: BranchCommit[], matrix: ModelMatrix = loadMatrix()): { authors: string[]; gaps: string[] } {
  const authors = new Set<string>();
  const gaps: string[] = [];
  for (const commit of commits) for (const value of authorTrailers(commit.message)) {
    const found = value === null ? null : trailerProvider(value, matrix);
    if (found === null) gaps.push(`Unreadable Pstack-Author trailer in commit ${commit.sha.slice(0, 7)}`);
    else authors.add(found);
  }
  return { authors: [...authors].sort(), gaps };
}
export function analyze(s: Snapshot, options: { id: string; configPath: string; execution: Execution }): Report {
  const paths = [...new Set(s.files.flatMap(f => f.previous ? [f.path, f.previous] : [f.path]))];
  const c = s.trusted.config;
  const surfacePaths = paths.filter(path => c.surfaces.some(pattern => matches(path, pattern)));
  const riskPaths = paths.filter(path => [...c.riskClasses.irreversible, ...c.riskClasses.contained].some(pattern => matches(path, pattern)));
  const touchedFeatures = s.features;
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
  const prePr = options.execution === 'pre-pr';
  const light = prePr ? c.prePr?.light : null;
  const eligible = paths.length > 0 && !surfacePaths.length && !riskPaths.length && !hardList.length;
  const ciOnly = eligible && (paths.every(ordinaryDoc) || !prePr && s.dependencyOnly);
  const lightClass = eligible && !!light && (paths.every(path => light.paths.some(pattern => matches(path, pattern))) || s.dependencyOnly);
  const mode: Report['mode'] = ciOnly ? 'ci-only' : lightClass ? 'light' : 'full';
  const lanes: Report['lanes'] = prePr
    ? mode === 'full' ? (c.prePr?.certifier ? ['pre-pr reviewer', 'pre-pr certifier'] : ['pre-pr reviewer']) : mode === 'light' && light?.reviewer === 'none' ? [] : ['pre-pr reviewer']
    : mode === 'ci-only' ? [] : ['pr verifier'];
  const ciGap = /Tests workflow|Required check is not successful|Tests logs/;
  const recorded = authorFamilies(s.commits);
  const gaps = [...(prePr ? s.gaps.filter(g => !ciGap.test(g)) : s.gaps), ...recorded.gaps];
  return { schemaVersion: 1, round: { id: options.id, repo: c.repo, pr: s.pull.number, head: s.pull.head, contract: s.trusted.sha, base: s.base,
    patch_id: s.patchId, verificationDigest: s.verificationDigest, inputDigest: s.inputDigest, configPath: options.configPath, execution: options.execution },
    mode, touchedFeatures, unmappedSurfaces: surfacePaths.filter(p => !s.reachedPaths.includes(p) && !testOnly(p) && !(touchedFeatures.length && (/^client\/(?:src\/)?(?:components|hooks|contexts|lib|utils)\//.test(p) || /^server\/routes\//.test(p) || /^client\/(?:src\/)?App\.[jt]sx?$/.test(p)))),
    claims: claims(s), hardList, injection, findings, checks: s.checks, lanes, authors: recorded.authors, gaps, inputFingerprint: s.inputFingerprint };
}
export async function reconcile(options: { repo: string; pr: number; configPath?: string; execution?: Execution; output: string }): Promise<Report> {
  const configPath = options.configPath ?? '.cursor/converge.json';
  const execution = options.execution ?? 'converge';
  const report = analyze(await snapshot(options.repo, options.pr, configPath, execution), { id: executionId(), configPath, execution });
  writeFileSync(options.output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return report;
}
export async function main(args: string[]): Promise<number> {
  try {
    const { values } = parseArgs({ args, options: { repo: { type: 'string' }, pr: { type: 'string' }, config: { type: 'string' }, output: { type: 'string' }, execution: { type: 'string' } } });
    const execution = executions.find(value => value === (values.execution ?? 'converge'));
    if (!values.repo || !values.pr || !values.output || !/^\d+$/.test(values.pr) || !execution) throw new Error('Usage: converge-reconcile --repo owner/repo --pr N --config path --output report.json [--execution verdict-only|pre-pr]');
    const result = await reconcile({ repo: values.repo, pr: Number(values.pr), configPath: values.config, output: values.output, execution });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return 0;
  } catch (error) { process.stderr.write((error instanceof SyntaxError ? 'Malformed JSON input' : error instanceof Error ? error.message : 'Reconcile failed') + '\n'); return 1; }
}
