import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { resolve, join, dirname } from 'node:path';
import { array, digest, executionId, hash, integer, jsonHash, object, oneOf, parseReport, parseRound, relativePath, roleProviders, roles, sha, string, type Contract, type Decision, type Report, type Role, type Round } from './contract.ts';
import { branchSnapshot } from './github.ts';
import { analyze } from './reconcile.ts';
import { admitLane, type AdmittedLane } from './evidence.ts';
import { decide } from './publish.ts';
import { loadMatrix } from '../../../../scripts/model-matrix.ts';

export interface Run { name: string; command: string; exitCode: number; startedAt: string; completedAt: string; logDigest: string }
export interface Certificate {
  schemaVersion: 1; round: Round; authorProvider: string; runs: Run[];
  lanes: { manifest: string; role: Role; provider: string; receiptDigest: string }[];
  decision: Decision; reconcileDigest: string; evidenceDigest: string; coverage: string[]; toolingRef: string;
}
function runName(value: unknown): string {
  const name = string(value);
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(name)) throw new Error('Unsafe run name');
  return name;
}
function parseRun(value: unknown): Run {
  const v = object(value, 'run');
  return { name: runName(v.name), command: string(v.command), exitCode: integer(v.exitCode), startedAt: string(v.startedAt), completedAt: string(v.completedAt), logDigest: digest(v.logDigest) };
}
export function parseCertificate(value: unknown): Certificate {
  const v = object(value, 'certificate');
  if (v.schemaVersion !== 1) throw new Error('Unknown certificate schema');
  const round = parseRound(v.round);
  if (round.execution !== 'pre-pr') throw new Error('Certificate execution must be pre-pr');
  const d = object(v.decision);
  if (d.verdict !== 'VERIFIED') throw new Error('Certificate is not VERIFIED');
  return { schemaVersion: 1, round, authorProvider: string(v.authorProvider), runs: array(v.runs).map(parseRun),
    lanes: array(v.lanes).map(raw => { const l = object(raw); return { manifest: relativePath(l.manifest), role: oneOf(l.role, roles), provider: string(l.provider), receiptDigest: digest(l.receiptDigest) }; }),
    decision: { verdict: 'VERIFIED', displayResult: oneOf(d.displayResult, ['VERIFIED', 'CI-only']), findings: [], reasons: [] },
    reconcileDigest: digest(v.reconcileDigest), evidenceDigest: digest(v.evidenceDigest), coverage: array(v.coverage).map(c => relativePath(c)), toolingRef: sha(v.toolingRef) };
}
function toolingRef(): string {
  const result = spawnSync('git', ['-C', import.meta.dirname, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Tooling commit unavailable: run converge-certify from a pstack-vic git checkout');
  return sha(result.stdout.trim());
}
export function recordRun(directory: string, name: string, argv: string[]): number {
  runName(name);
  if (!argv.length) throw new Error('Run needs a command');
  const runs = join(directory, 'runs');
  mkdirSync(runs, { recursive: true, mode: 0o700 });
  const startedAt = new Date().toISOString();
  const child = spawnSync(argv[0] as string, argv.slice(1), { cwd: process.cwd(), encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = Buffer.concat([child.stdout ?? Buffer.alloc(0), child.stderr ?? Buffer.alloc(0), child.error ? Buffer.from(child.error.message + '\n') : Buffer.alloc(0)]);
  const exitCode = child.status ?? 128;
  writeFileSync(join(runs, name + '.log'), log, { mode: 0o600 });
  const record: Run = { name, command: argv.join(' '), exitCode, startedAt, completedAt: new Date().toISOString(), logDigest: hash(log) };
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
function checkRuns(report: Report, runs: Run[], contract: Contract): void {
  if (!contract.prePr) throw new Error('Repository does not accept local certification');
  if (report.mode === 'ci-only') return;
  for (const required of contract.prePr.runs) {
    const run = runs.find(r => r.name === required.name);
    if (!run) throw new Error('Required run missing: ' + required.name);
    if (run.exitCode !== 0) throw new Error(`Run ${run.name} exited ${run.exitCode}`);
  }
}
/** Re-runs the branch analysis before trusting report.json, so a stale or edited report, or a trunk contract that moved, cannot certify. */
export async function assemble(options: { directory: string; authorProvider: string; output: string }): Promise<Certificate> {
  if (dirname(options.output) !== options.directory) throw new Error('Certificate must be written in the run directory');
  if (!Object.hasOwn(loadMatrix().providers, options.authorProvider)) throw new Error(`Unknown author provider: ${options.authorProvider}`);
  const report = parseReport(JSON.parse(readFileSync(join(options.directory, 'report.json'), 'utf8')));
  const r = report.round;
  if (r.execution !== 'pre-pr' || r.pr !== 0) throw new Error('Report is not a local pre-pr report');
  const snapshot = await branchSnapshot(r.repo, r.head, r.configPath);
  if (jsonHash(report) !== jsonHash(analyze(snapshot, { id: r.id, configPath: r.configPath, execution: 'pre-pr' }))) throw new Error('Reconciliation report changed or is stale');
  const runs = readRuns(options.directory);
  checkRuns(report, runs, snapshot.trusted.config);
  const lanesDirectory = join(options.directory, 'lanes');
  const ids = existsSync(lanesDirectory) ? readdirSync(lanesDirectory).sort().filter(id => existsSync(join(lanesDirectory, id, 'manifest.json'))) : [];
  const admitted: AdmittedLane[] = [];
  const lanes: Certificate['lanes'] = [];
  for (const id of ids) {
    const manifest = relativePath(join('lanes', id, 'manifest.json'));
    const lane = await admitLane(join(options.directory, manifest), report, join(options.directory, 'evidence'), r);
    const provider = roleProviders[lane.role].provider;
    if (lane.role === 'pre-pr reviewer' && provider === options.authorProvider) throw new Error(`Reviewer lane is the same family as the author (${provider}); change the feature, refactoring row of the model sheet`);
    admitted.push(lane);
    lanes.push({ manifest, role: lane.role, provider, receiptDigest: lane.receiptDigest });
  }
  const decision = decide(report, admitted);
  if (decision.verdict !== 'VERIFIED') throw new Error(`Certificate refused: ${decision.verdict}: ${[...decision.findings.map(f => `${f.kind} ${f.rule} ${f.path ?? ''}:${f.line}`), ...decision.reasons].join('; ')}`);
  const certificate: Certificate = { schemaVersion: 1, round: r, authorProvider: options.authorProvider, runs, lanes, decision, reconcileDigest: jsonHash(report), evidenceDigest: jsonHash(admitted), coverage: admitted.flatMap(l => l.coverage), toolingRef: toolingRef() };
  writeFileSync(options.output, JSON.stringify(certificate, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return certificate;
}
/** Re-admits a certificate against the PR report: same head, patch, contract and policy; every lane and run re-verified from bytes. */
export async function admitCertificate(file: string, report: Report, evidenceDirectory: string): Promise<AdmittedLane[]> {
  const certificate = parseCertificate(JSON.parse(readFileSync(file, 'utf8')));
  const directory = dirname(resolve(file));
  const c = certificate.round, r = report.round;
  if (c.repo !== r.repo || c.head !== r.head) throw new Error('PR head differs from certificate');
  if (c.patch_id !== r.patch_id || c.contract !== r.contract || c.verificationDigest !== r.verificationDigest || c.configPath !== r.configPath) throw new Error('Certificate patch or policy differs from the PR');
  if (r.execution !== 'pre-pr') throw new Error('Certificate publication needs a pre-pr report');
  const runs = readRuns(directory);
  if (jsonHash(runs) !== jsonHash(certificate.runs)) throw new Error('Certificate runs differ from the recorded runs');
  const admitted: AdmittedLane[] = [];
  for (const lane of certificate.lanes) {
    const result = await admitLane(join(directory, lane.manifest), report, evidenceDirectory, c);
    if (result.role !== lane.role || result.receiptDigest !== lane.receiptDigest || lane.provider !== roleProviders[result.role].provider) throw new Error('Certificate lane differs from its manifest');
    if (lane.role === 'pre-pr reviewer' && lane.provider === certificate.authorProvider) throw new Error('Reviewer lane is the same family as the author');
    admitted.push(result);
  }
  if (jsonHash(admitted) !== certificate.evidenceDigest) throw new Error('Certificate evidence digest differs');
  return admitted;
}
export async function main(args: string[]): Promise<number> {
  try {
    const [command, ...rest] = args;
    if (command === 'run') {
      const separator = rest.indexOf('--');
      const { values } = parseArgs({ args: separator < 0 ? rest : rest.slice(0, separator), options: { directory: { type: 'string' }, name: { type: 'string' } } });
      if (!values.directory || !values.name || separator < 0) throw new Error('Usage: converge-certify run --directory RUN --name NAME -- <command...>');
      return recordRun(resolve(values.directory), values.name, rest.slice(separator + 1));
    }
    if (command === 'report') {
      const { values } = parseArgs({ args: rest, options: { repo: { type: 'string' }, head: { type: 'string' }, directory: { type: 'string' }, config: { type: 'string' } } });
      if (!values.repo || !values.head || !values.directory) throw new Error('Usage: converge-certify report --repo owner/repo --head SHA --directory RUN [--config path]');
      process.stdout.write(JSON.stringify(await localReport({ repo: values.repo, head: values.head, directory: resolve(values.directory), configPath: values.config }), null, 2) + '\n');
      return 0;
    }
    if (command === 'assemble') {
      const { values } = parseArgs({ args: rest, options: { directory: { type: 'string' }, 'author-provider': { type: 'string' }, output: { type: 'string' } } });
      if (!values.directory || !values['author-provider'] || !values.output) throw new Error('Usage: converge-certify assemble --directory RUN --author-provider PROVIDER --output RUN/certificate.json');
      process.stdout.write(JSON.stringify(await assemble({ directory: resolve(values.directory), authorProvider: values['author-provider'], output: resolve(values.output) }), null, 2) + '\n');
      return 0;
    }
    throw new Error('Usage: converge-certify <run|report|assemble> ...');
  } catch (error) { process.stderr.write((error instanceof SyntaxError ? 'Malformed JSON input' : error instanceof Error ? error.message : 'Certification failed') + '\n'); return 1; }
}
