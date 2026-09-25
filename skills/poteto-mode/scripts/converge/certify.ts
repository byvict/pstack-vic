import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { resolve, join, dirname } from 'node:path';
import { array, boolean, digest, executionId, hash, integer, jsonHash, object, oneOf, parseReport, parseRound, relativePath, roleProviders, roles, sha, string, type Contract, type Decision, type Report, type Role, type Round } from './contract.ts';
import { branchSnapshot } from './github.ts';
import { analyze } from './reconcile.ts';
import { admitLane, type AdmittedLane } from './evidence.ts';
import { decide } from './publish.ts';
import { loadMatrix, resolveDescriptor } from '../../../../scripts/model-matrix.ts';

export interface Run { name: string; command: string; exitCode: number; startedAt: string; completedAt: string; logDigest: string; head: string | null; clean: boolean }
export interface SkippedRun { name: string; command: string; skip: string }
export interface CertificateLane { manifest: string; role: Role; provider: string; model: string; effort: string; reportedModel: string | null; receiptDigest: string }
export interface CertificateArtifact { lane: string; id: string; path: string; bytes: number; sha256: string; mediaType: string }
export interface Certificate {
  schemaVersion: 1; round: Round; authorProvider: string; runs: (Run | SkippedRun)[]; lanes: CertificateLane[]; artifacts: CertificateArtifact[];
  decision: Decision; reconcileDigest: string; evidenceDigest: string; coverage: string[]; adjustRounds: number; toolingRef: string;
}
function runName(value: unknown): string {
  const name = string(value);
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(name)) throw new Error('Unsafe run name');
  return name;
}
function parseRun(value: unknown): Run {
  const v = object(value, 'run');
  return { name: runName(v.name), command: string(v.command), exitCode: integer(v.exitCode), startedAt: string(v.startedAt), completedAt: string(v.completedAt), logDigest: digest(v.logDigest), head: v.head === null ? null : sha(v.head), clean: boolean(v.clean) };
}
function laneId(value: unknown): string {
  const id = relativePath(value);
  if (id.includes('/')) throw new Error('Invalid lane id');
  return id;
}
function adjustRounds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 6) throw new Error('Adjust rounds must be an integer from 0 to 6');
  return value;
}
export function parseCertificate(value: unknown): Certificate {
  const v = object(value, 'certificate');
  if (v.schemaVersion !== 1) throw new Error('Unknown certificate schema');
  const round = parseRound(v.round);
  if (round.execution !== 'pre-pr') throw new Error('Certificate execution must be pre-pr');
  const d = object(v.decision);
  if (d.verdict !== 'VERIFIED') throw new Error('Certificate is not VERIFIED');
  const displayResult = oneOf(d.displayResult, ['VERIFIED', 'CI-only']);
  const runs = array(v.runs).map((raw): Run | SkippedRun => {
    const r = object(raw, 'run');
    if (r.skip === undefined) return parseRun(r);
    const skip = string(r.skip);
    if (!skip || displayResult !== 'CI-only') throw new Error('A skipped run needs a CI-only certificate');
    return { name: runName(r.name), command: string(r.command), skip };
  });
  if (new Set(runs.map(r => r.name)).size !== runs.length) throw new Error('Duplicate run name');
  return { schemaVersion: 1, round, authorProvider: string(v.authorProvider), runs,
    lanes: array(v.lanes).map(raw => { const l = object(raw); return { manifest: relativePath(l.manifest), role: oneOf(l.role, roles), provider: string(l.provider), model: string(l.model), effort: string(l.effort), reportedModel: l.reportedModel === null ? null : string(l.reportedModel), receiptDigest: digest(l.receiptDigest) }; }),
    artifacts: array(v.artifacts).map(raw => {
      const a = object(raw, 'artifact');
      const bytes = integer(a.bytes);
      if (!bytes || bytes > 20_000_000) throw new Error('Artifact size outside bounds');
      return { lane: laneId(a.lane), id: relativePath(a.id), path: relativePath(a.path), bytes, sha256: digest(a.sha256), mediaType: oneOf(a.mediaType, ['image/png', 'application/json', 'text/plain']) };
    }),
    decision: { verdict: 'VERIFIED', displayResult, findings: [], reasons: [] },
    reconcileDigest: digest(v.reconcileDigest), evidenceDigest: digest(v.evidenceDigest), coverage: array(v.coverage).map(c => relativePath(c)), adjustRounds: adjustRounds(v.adjustRounds), toolingRef: parseToolingRef(v.toolingRef) };
}
function parseToolingRef(value: unknown): string {
  const ref = string(value);
  if (!/^pstack-vic@\d+\.\d+\.\d+$/.test(ref)) throw new Error('Invalid tooling ref');
  return ref;
}
/** The plugin version, not a git commit: installed plugin copies ship package.json but no .git. */
function toolingRef(): string {
  return parseToolingRef('pstack-vic@' + string(object(JSON.parse(readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8'))).version));
}
function checkoutState(cwd: string): { head: string | null; clean: boolean } {
  const head = spawnSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  const status = spawnSync('git', ['-C', cwd, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' });
  return { head: head.status === 0 && /^[a-f0-9]{40}\n$/.test(head.stdout) ? head.stdout.trim() : null, clean: status.status === 0 && status.stdout === '' };
}
/** Head and cleanliness are read before the command runs, so a suite that writes tracked files still records the checkout it started from. */
export function recordRun(directory: string, name: string, argv: string[], cwd = process.cwd()): number {
  runName(name);
  if (!argv.length) throw new Error('Run needs a command');
  const runs = join(directory, 'runs');
  mkdirSync(runs, { recursive: true, mode: 0o700 });
  const checkout = checkoutState(cwd);
  const startedAt = new Date().toISOString();
  const child = spawnSync(argv[0] as string, argv.slice(1), { cwd, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = Buffer.concat([child.stdout ?? Buffer.alloc(0), child.stderr ?? Buffer.alloc(0), child.error ? Buffer.from(child.error.message + '\n') : Buffer.alloc(0)]);
  const exitCode = child.status ?? 128;
  writeFileSync(join(runs, name + '.log'), log, { mode: 0o600 });
  const record: Run = { name, command: argv.join(' '), exitCode, startedAt, completedAt: new Date().toISOString(), logDigest: hash(log), ...checkout };
  writeFileSync(join(runs, name + '.json'), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  return exitCode;
}
export async function localReport(options: { repo: string; head: string; directory: string; configPath?: string }): Promise<Report> {
  const configPath = options.configPath ?? '.cursor/converge.json';
  const snapshot = await branchSnapshot(options.repo, options.head, configPath);
  if (!snapshot.trusted.config.prePr) throw new Error('Repository does not accept local certification');
  const report = analyze(snapshot, { id: executionId(), configPath, execution: 'pre-pr' });
  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(options.directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return report;
}
function readRuns(directory: string): Run[] {
  const runs = join(directory, 'runs');
  if (!existsSync(runs)) return [];
  return readdirSync(runs).filter(f => f.endsWith('.json')).sort().map(f => {
    const run = parseRun(JSON.parse(readFileSync(join(runs, f), 'utf8')));
    if (hash(readFileSync(join(runs, f.replace(/\.json$/, '.log')))) !== run.logDigest) throw new Error(`Run ${run.name} log changed after it was recorded`);
    return run;
  });
}
/** Assembly and publication share this policy, so a hand-edited certificate cannot publish a run list that assembly would refuse; a ci-only report lists each unrecorded contract run as skipped. */
function checkRuns(report: Report, runs: Run[], contract: Contract): (Run | SkippedRun)[] {
  if (!contract.prePr) throw new Error('Repository does not accept local certification');
  if (report.mode === 'ci-only') return [...runs, ...contract.prePr.runs.filter(c => !runs.some(r => r.name === c.name)).map(c => ({ name: c.name, command: c.command, skip: 'ci-only report' }))];
  for (const required of contract.prePr.runs) {
    const run = runs.find(r => r.name === required.name);
    if (!run) throw new Error('Required run missing: ' + required.name);
    if (run.exitCode !== 0) throw new Error(`Run ${run.name} exited ${run.exitCode}`);
    if (run.command !== required.command) throw new Error(`Run ${run.name} command differs from the contract`);
    if (run.head !== report.round.head) throw new Error(`Run ${run.name} was not recorded at the certified head`);
    if (!run.clean) throw new Error(`Run ${run.name} was recorded on a modified checkout`);
  }
  return runs;
}
function unchanged(file: string, expected: string, message: string): Buffer {
  const stat = lstatSync(file);
  const bytes = stat.isFile() && stat.size <= 20_000_000 ? readFileSync(file) : null;
  if (!bytes || hash(bytes) !== expected) throw new Error(message);
  return bytes;
}
/** Reads the lane record and artifact sizes back from the files admitLane verified, re-hashed against its digests, so AdmittedLane, whose hash is the evidenceDigest, keeps its shape. */
function laneEntries(directory: string, manifest: string, lane: AdmittedLane): { lane: CertificateLane; artifacts: CertificateArtifact[] } {
  const file = join(directory, manifest);
  const root = dirname(file);
  const m = object(JSON.parse(readFileSync(file, 'utf8')));
  const receipt = object(JSON.parse(unchanged(join(root, relativePath(m.receipt)), lane.receiptDigest, 'Lane receipt changed after admission').toString('utf8')));
  const { descriptor, family } = resolveDescriptor(loadMatrix(), string(m.descriptor));
  if (receipt.provider !== family.provider || receipt.model !== family.model || receipt.effort !== descriptor.effort) throw new Error('Lane receipt model differs from dispatch');
  const id = laneId(m.laneId);
  return {
    lane: { manifest, role: lane.role, provider: roleProviders[lane.role].provider, model: family.model, effort: descriptor.effort, reportedModel: receipt.reportedModel === null ? null : string(receipt.reportedModel), receiptDigest: lane.receiptDigest },
    artifacts: lane.artifacts.map(a => ({ lane: id, id: a.id, path: a.path, bytes: unchanged(join(root, a.path), a.digest, 'Artifact bytes changed after admission').length, sha256: a.digest, mediaType: a.mediaType })),
  };
}
/** Re-runs the branch analysis before trusting report.json, so a stale or edited report, or a trunk contract that moved, cannot certify. */
export async function assemble(options: { directory: string; authorProvider: string; output: string; adjustRounds: number }): Promise<Certificate> {
  adjustRounds(options.adjustRounds);
  if (dirname(options.output) !== options.directory) throw new Error('Certificate must be written in the run directory');
  if (!Object.hasOwn(loadMatrix().providers, options.authorProvider)) throw new Error(`Unknown author provider: ${options.authorProvider}`);
  const report = parseReport(JSON.parse(readFileSync(join(options.directory, 'report.json'), 'utf8')));
  const r = report.round;
  if (r.execution !== 'pre-pr' || r.pr !== 0) throw new Error('Report is not a local pre-pr report');
  const snapshot = await branchSnapshot(r.repo, r.head, r.configPath);
  if (jsonHash(report) !== jsonHash(analyze(snapshot, { id: r.id, configPath: r.configPath, execution: 'pre-pr' }))) throw new Error('Reconciliation report changed or is stale');
  const runs = checkRuns(report, readRuns(options.directory), snapshot.trusted.config);
  const lanesDirectory = join(options.directory, 'lanes');
  const ids = existsSync(lanesDirectory) ? readdirSync(lanesDirectory).sort().filter(id => existsSync(join(lanesDirectory, id, 'manifest.json'))) : [];
  const admitted: AdmittedLane[] = [];
  const lanes: CertificateLane[] = [];
  const artifacts: CertificateArtifact[] = [];
  for (const id of ids) {
    const manifest = relativePath(join('lanes', id, 'manifest.json'));
    const lane = await admitLane(join(options.directory, manifest), report, join(options.directory, 'evidence'), r);
    const provider = roleProviders[lane.role].provider;
    if (lane.role === 'pre-pr reviewer' && provider === options.authorProvider) throw new Error(`Reviewer lane is the same family as the author (${provider}); change the feature, refactoring row of the model sheet`);
    const entries = laneEntries(options.directory, manifest, lane);
    admitted.push(lane);
    lanes.push(entries.lane);
    artifacts.push(...entries.artifacts);
  }
  const decision = decide(report, admitted);
  if (decision.verdict !== 'VERIFIED') throw new Error(`Certificate refused: ${decision.verdict}: ${[...decision.findings.map(f => `${f.kind} ${f.rule} ${f.path ?? ''}:${f.line}`), ...decision.reasons].join('; ')}`);
  const certificate: Certificate = { schemaVersion: 1, round: r, authorProvider: options.authorProvider, runs, lanes, artifacts, decision, reconcileDigest: jsonHash(report), evidenceDigest: jsonHash(admitted), coverage: admitted.flatMap(l => l.coverage), adjustRounds: options.adjustRounds, toolingRef: toolingRef() };
  writeFileSync(options.output, JSON.stringify(certificate, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return certificate;
}
/** Re-admits a certificate against the PR report and the live contract: same head, patch, contract and policy, the run policy applied again, every run, lane and artifact re-verified from bytes, and the decision and coverage derived again, so no field of the published certificate rests on its own word. */
export async function admitCertificate(file: string, report: Report, evidenceDirectory: string, contract: Contract): Promise<{ certificate: Certificate; lanes: AdmittedLane[] }> {
  const certificate = parseCertificate(JSON.parse(readFileSync(file, 'utf8')));
  const directory = dirname(resolve(file));
  const c = certificate.round, r = report.round;
  if (c.repo !== r.repo || c.head !== r.head) throw new Error('PR head differs from certificate');
  if (c.patch_id !== r.patch_id || c.contract !== r.contract || c.verificationDigest !== r.verificationDigest || c.configPath !== r.configPath) throw new Error('Certificate patch or policy differs from the PR');
  if (r.execution !== 'pre-pr') throw new Error('Certificate publication needs a pre-pr report');
  const branch = parseReport(JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8')));
  if (jsonHash(branch) !== certificate.reconcileDigest || jsonHash(branch.round) !== jsonHash(c)) throw new Error('Certificate report differs from the recorded report');
  const recorded = certificate.runs.filter((run): run is Run => !('skip' in run));
  if (jsonHash(checkRuns(report, recorded, contract)) !== jsonHash(certificate.runs)) throw new Error('Certificate runs differ from the run policy');
  if (jsonHash(readRuns(directory)) !== jsonHash(recorded)) throw new Error('Certificate runs differ from the recorded runs');
  const admitted: AdmittedLane[] = [];
  const artifacts: CertificateArtifact[] = [];
  for (const lane of certificate.lanes) {
    const result = await admitLane(join(directory, lane.manifest), report, evidenceDirectory, c);
    const entries = laneEntries(directory, lane.manifest, result);
    if (jsonHash(entries.lane) !== jsonHash(lane)) throw new Error('Certificate lane differs from its manifest');
    if (lane.role === 'pre-pr reviewer' && lane.provider === certificate.authorProvider) throw new Error('Reviewer lane is the same family as the author');
    admitted.push(result);
    artifacts.push(...entries.artifacts);
  }
  if (jsonHash(artifacts) !== jsonHash(certificate.artifacts)) throw new Error('Certificate artifacts differ from the admitted lanes');
  if (jsonHash(admitted) !== certificate.evidenceDigest) throw new Error('Certificate evidence digest differs');
  if (jsonHash(admitted.flatMap(l => l.coverage)) !== jsonHash(certificate.coverage)) throw new Error('Certificate coverage differs from the admitted lanes');
  if (jsonHash(decide(branch, admitted)) !== jsonHash(certificate.decision)) throw new Error('Certificate decision differs from the admitted evidence');
  return { certificate, lanes: admitted };
}
export async function main(args: string[]): Promise<number> {
  try {
    const [command, ...rest] = args;
    if (command === 'run') {
      const separator = rest.indexOf('--');
      const { values } = parseArgs({ args: separator < 0 ? rest : rest.slice(0, separator), options: { directory: { type: 'string' }, name: { type: 'string' }, cwd: { type: 'string' } } });
      if (!values.directory || !values.name || separator < 0) throw new Error('Usage: converge-certify run --directory RUN --name NAME [--cwd DIR] -- <command...>');
      return recordRun(resolve(values.directory), values.name, rest.slice(separator + 1), resolve(values.cwd ?? process.cwd()));
    }
    if (command === 'report') {
      const { values } = parseArgs({ args: rest, options: { repo: { type: 'string' }, head: { type: 'string' }, directory: { type: 'string' }, config: { type: 'string' } } });
      if (!values.repo || !values.head || !values.directory) throw new Error('Usage: converge-certify report --repo owner/repo --head SHA --directory RUN [--config path]');
      process.stdout.write(JSON.stringify(await localReport({ repo: values.repo, head: values.head, directory: resolve(values.directory), configPath: values.config }), null, 2) + '\n');
      return 0;
    }
    if (command === 'assemble') {
      const { values } = parseArgs({ args: rest, options: { directory: { type: 'string' }, 'author-provider': { type: 'string' }, output: { type: 'string' }, 'adjust-rounds': { type: 'string' } } });
      const rounds = values['adjust-rounds'];
      if (!values.directory || !values['author-provider'] || !values.output || rounds === undefined) throw new Error('Usage: converge-certify assemble --directory RUN --author-provider PROVIDER --output RUN/certificate.json --adjust-rounds N');
      process.stdout.write(JSON.stringify(await assemble({ directory: resolve(values.directory), authorProvider: values['author-provider'], output: resolve(values.output), adjustRounds: /^\d+$/.test(rounds) ? Number(rounds) : NaN }), null, 2) + '\n');
      return 0;
    }
    throw new Error('Usage: converge-certify <run|report|assemble> ...');
  } catch (error) { process.stderr.write((error instanceof SyntaxError ? 'Malformed JSON input' : error instanceof Error ? error.message : 'Certification failed') + '\n'); return 1; }
}
