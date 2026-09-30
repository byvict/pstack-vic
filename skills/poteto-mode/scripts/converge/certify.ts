import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { array, boolean, digest, executionId, hash, integer, jsonHash, object, oneOf, parseExecutionId, parseReport, parseRound, providerName, relativePath, roles, sha, string, strings, type Contract, type Decision, type Report, type Role, type Round } from './contract.ts';
import { branchSnapshot } from './github.ts';
import { analyze } from './reconcile.ts';
import { admitLane, type AdmittedLane } from './evidence.ts';
import { decide } from './publish.ts';
import { LEASE_TTL_HOURS } from './local/lease.ts';
import { checkReviewerRow, sheetRow } from './sheet.ts';
import { loadMatrix, resolveDescriptor, type ModelMatrix } from '../../../../scripts/model-matrix.ts';

export interface Run { name: string; command: string; exitCode: number; startedAt: string; completedAt: string; logDigest: string; head: string | null; clean: boolean }
export interface SkippedRun { name: string; command: string; skip: string }
export interface CertificateLane { manifest: string; role: Role; provider: string; model: string; effort: string; reportedModel: string | null; receiptDigest: string }
export interface CertificateArtifact { lane: string; id: string; path: string; bytes: number; sha256: string; mediaType: string }
export interface Certificate {
  schemaVersion: 2; round: Round; authorProviders: string[]; runs: (Run | SkippedRun)[]; lanes: CertificateLane[]; artifacts: CertificateArtifact[];
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
function authorProviders(value: unknown): string[] {
  const list = strings(value);
  if (!list.length) throw new Error('Certificate needs at least one author family');
  for (const name of list) providerName(name);
  if (new Set(list).size !== list.length) throw new Error('Duplicate author family');
  return list;
}
function adjustRounds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 6) throw new Error('Adjust rounds must be an integer from 0 to 6');
  return value;
}
export interface ReviewerChoice { schemaVersion: 1; round: string; descriptor: string; provider: string; model: string; effort: string; authorProviders: string[]; skipped: { descriptor: string; provider: string }[] }
export const REVIEWER_FILE = 'reviewer.json';
export function defaultSheetPath(parent: string, home = homedir()): string { return join(home, parent === 'claude' ? '.claude' : '.codex', 'pstack-models.md'); }
/** The declared families and the ones the branch's trailers name, once each, sorted: what the reviewer is chosen against and what the certificate records. */
function authorUnion(declared: string[], report: Report): string[] {
  return [...new Set([...authorProviders(declared), ...report.authors])].sort();
}
/** A declared family outside the matrix is a typo, refused before a lane is chosen or anything is written. */
function knownAuthors(declared: string[], matrix: ModelMatrix): void {
  for (const provider of declared) if (!Object.hasOwn(matrix.providers, provider)) throw new Error(`Unknown author provider: ${provider}`);
}
/** A missing sheet names its path and the command that writes it, not a bare ENOENT. */
function readSheet(path: string): string {
  try { return readFileSync(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`No model sheet at ${path}; run /setup-pstack`); throw error; }
}
function parseReviewerChoice(value: unknown): ReviewerChoice {
  const v = object(value, 'reviewer choice');
  if (v.schemaVersion !== 1) throw new Error('Unknown reviewer choice schema');
  const { descriptor, family } = resolveDescriptor(loadMatrix(), string(v.descriptor));
  return { schemaVersion: 1, round: parseExecutionId(v.round), descriptor: string(v.descriptor), provider: family.provider, model: family.model, effort: descriptor.effort, authorProviders: authorProviders(v.authorProviders),
    skipped: array(v.skipped).map(raw => { const s = object(raw, 'skipped lane'); return { descriptor: string(s.descriptor), provider: providerName(s.provider) }; }) };
}
/** Reads the round's report and the sheet's `pre-pr reviewer` row, unions the declared author families with the trailers' and writes the first lane outside that set to RUN/reviewer.json, once per run directory. A report whose lanes lack the reviewer (a light class with `reviewer: none`) takes no choice. */
export function chooseReviewer(options: { directory: string; parent: string; sheetPath?: string; authorProviders: string[] }): ReviewerChoice {
  if (options.parent !== 'claude' && options.parent !== 'codex') throw new Error(`Unknown parent ${JSON.stringify(options.parent)}: --parent takes claude or codex, the harness of this session`);
  const parent = options.parent;
  const matrix = loadMatrix();
  knownAuthors(authorProviders(options.authorProviders), matrix);
  const file = join(options.directory, REVIEWER_FILE);
  if (existsSync(file)) throw new Error('Reviewer choice already made: a new head is a new run directory');
  const report = parseReport(JSON.parse(readFileSync(join(options.directory, 'report.json'), 'utf8')));
  if (report.round.execution !== 'pre-pr' || report.round.pr !== 0) throw new Error('Report is not a local pre-pr report');
  if (!report.lanes.includes('pre-pr reviewer')) throw new Error('Report requires no pre-pr reviewer lane: skip the reviewer choice');
  const lanes = sheetRow(readSheet(options.sheetPath ?? defaultSheetPath(parent)), 'pre-pr reviewer');
  try { checkReviewerRow(lanes, matrix, parent); } catch (error) { throw new Error(`${(error as Error).message}; change the model sheet with /setup-pstack`); }
  const authors = authorUnion(options.authorProviders, report);
  const resolved = lanes.map(lane => ({ lane, ...resolveDescriptor(matrix, lane) }));
  const chosen = resolved.find(r => !authors.includes(r.family.provider));
  if (!chosen) throw new Error(`No pre-pr reviewer lane is outside the author families (${authors.join(', ')}): the row lists ${lanes.join(', ')}; add a lane of another family with /setup-pstack`);
  const choice: ReviewerChoice = { schemaVersion: 1, round: report.round.id, descriptor: chosen.lane, provider: chosen.family.provider, model: chosen.family.model, effort: chosen.descriptor.effort, authorProviders: authors,
    skipped: resolved.slice(0, resolved.indexOf(chosen)).map(r => ({ descriptor: r.lane, provider: r.family.provider })) };
  writeFileSync(file, JSON.stringify(choice, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return choice;
}
export function parseCertificate(value: unknown): Certificate {
  const v = object(value, 'certificate');
  if (v.schemaVersion !== 2) throw new Error('Unknown certificate schema');
  const authors = authorProviders(v.authorProviders);
  const round = parseRound(v.round);
  if (round.execution !== 'pre-pr') throw new Error('Certificate execution must be pre-pr');
  const d = object(v.decision);
  if (d.verdict !== 'VERIFIED') throw new Error('Certificate is not VERIFIED');
  const displayResult = oneOf(d.displayResult, ['VERIFIED', 'Light', 'CI-only']);
  const runs = array(v.runs).map((raw): Run | SkippedRun => {
    const r = object(raw, 'run');
    if (r.skip === undefined) return parseRun(r);
    const skip = string(r.skip);
    if (!skip || displayResult !== 'CI-only') throw new Error('A skipped run needs a CI-only certificate');
    return { name: runName(r.name), command: string(r.command), skip };
  });
  if (new Set(runs.map(r => r.name)).size !== runs.length) throw new Error('Duplicate run name');
  const lanes = array(v.lanes).map((raw): CertificateLane => { const l = object(raw); return { manifest: relativePath(l.manifest), role: oneOf(l.role, roles), provider: string(l.provider), model: string(l.model), effort: string(l.effort), reportedModel: l.reportedModel === null ? null : string(l.reportedModel), receiptDigest: digest(l.receiptDigest) }; });
  for (const lane of lanes) if (lane.role === 'pre-pr reviewer' && authors.includes(lane.provider)) throw new Error('Reviewer lane is the same family as an author');
  return { schemaVersion: 2, round, authorProviders: authors, runs, lanes,
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
/** Untracked files count, because a new file nobody added passes the suite locally and is missing from the pushed head; ignored files do not. */
function checkoutState(cwd: string): { head: string | null; clean: boolean } {
  const head = spawnSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  const status = spawnSync('git', ['-C', cwd, 'status', '--porcelain', '--untracked-files=normal'], { encoding: 'utf8' });
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
async function writeReport(options: { repo: string; head: string; directory: string; configPath?: string }): Promise<{ report: Report; contract: Contract }> {
  const configPath = options.configPath ?? '.cursor/converge.json';
  const snapshot = await branchSnapshot(options.repo, options.head, configPath);
  if (!snapshot.trusted.config.prePr) throw new Error('Repository does not accept local certification');
  const report = analyze(snapshot, { id: executionId(), configPath, execution: 'pre-pr' });
  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(options.directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { report, contract: snapshot.trusted.config };
}
export async function localReport(options: { repo: string; head: string; directory: string; configPath?: string }): Promise<Report> {
  return (await writeReport(options)).report;
}
function readRuns(directory: string): Run[] {
  const runs = join(directory, 'runs');
  if (!existsSync(runs)) return [];
  return readdirSync(runs).filter(f => f.endsWith('.json')).sort().map(f => {
    const run = parseRun(JSON.parse(readFileSync(join(runs, f), 'utf8')));
    if (f !== run.name + '.json') throw new Error('Run record file name differs from its name');
    if (hash(readFileSync(join(runs, run.name + '.log'))) !== run.logDigest) throw new Error(`Run ${run.name} log changed after it was recorded`);
    return run;
  });
}
/** Assembly and publication share this policy, so a hand-edited certificate cannot publish a run list that assembly would refuse. Every recorded run must pass in every mode, because the certificate lists it; only a ci-only report may leave a contract run unrecorded, and lists it as skipped. */
function checkRuns(report: Report, runs: Run[], contract: Contract): (Run | SkippedRun)[] {
  if (!contract.prePr) throw new Error('Repository does not accept local certification');
  const listed = contract.prePr.runs;
  for (const run of runs) {
    const required = listed.find(c => c.name === run.name);
    if (!required) throw new Error(`Run ${run.name} is not in the contract`);
    if (run.exitCode !== 0) throw new Error(`Run ${run.name} exited ${run.exitCode}`);
    if (run.command !== required.command) throw new Error(`Run ${run.name} command differs from the contract`);
    if (run.head !== report.round.head) throw new Error(`Run ${run.name} was not recorded at the certified head`);
    if (!run.clean) throw new Error(`Run ${run.name} was recorded on a modified checkout`);
  }
  const unrecorded = listed.filter(c => !runs.some(r => r.name === c.name));
  const missing = unrecorded[0];
  if (report.mode !== 'ci-only' && missing) throw new Error('Required run missing: ' + missing.name);
  return [...runs, ...unrecorded.map(c => ({ name: c.name, command: c.command, skip: 'ci-only report' }))];
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
    lane: { manifest, role: lane.role, provider: family.provider, model: family.model, effort: descriptor.effort, reportedModel: receipt.reportedModel === null ? null : string(receipt.reportedModel), receiptDigest: lane.receiptDigest },
    artifacts: lane.artifacts.map(a => ({ lane: id, id: a.id, path: a.path, bytes: unchanged(join(root, a.path), a.digest, 'Artifact bytes changed after admission').length, sha256: a.digest, mediaType: a.mediaType })),
  };
}
/** The round's reviewer choice, made against the same author families: required only when the report requires the reviewer lane. A round without one checks no reviewer lane here, because `decide` refuses any reviewer lane there as unexpected. */
function reviewerChoice(directory: string, round: string, authors: string[]): ReviewerChoice {
  let choice: ReviewerChoice;
  try { choice = parseReviewerChoice(JSON.parse(readFileSync(join(directory, REVIEWER_FILE), 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Reviewer choice missing: run converge-certify reviewer'); throw error; }
  if (choice.round !== round) throw new Error('Reviewer choice belongs to another round');
  if (jsonHash(choice.authorProviders) !== jsonHash(authors)) throw new Error(`Author families differ from the reviewer choice (${authors.join(', ')}; chose against ${choice.authorProviders.join(', ')})`);
  return choice;
}
/** Re-runs the branch analysis before trusting report.json, so a stale or edited report, or a trunk contract that moved, cannot certify. */
export async function assemble(options: { directory: string; authorProviders: string[]; output: string; adjustRounds: number }): Promise<Certificate> {
  adjustRounds(options.adjustRounds);
  const declared = authorProviders(options.authorProviders);
  if (dirname(options.output) !== options.directory) throw new Error('Certificate must be written in the run directory');
  knownAuthors(declared, loadMatrix());
  const report = parseReport(JSON.parse(readFileSync(join(options.directory, 'report.json'), 'utf8')));
  const r = report.round;
  if (r.execution !== 'pre-pr' || r.pr !== 0) throw new Error('Report is not a local pre-pr report');
  const snapshot = await branchSnapshot(r.repo, r.head, r.configPath);
  if (jsonHash(report) !== jsonHash(analyze(snapshot, { id: r.id, configPath: r.configPath, execution: 'pre-pr' }))) throw new Error('Reconciliation report changed or is stale');
  const authors = authorUnion(options.authorProviders, report);
  const choice = report.lanes.includes('pre-pr reviewer') ? reviewerChoice(options.directory, r.id, authors) : null;
  const runs = checkRuns(report, readRuns(options.directory), snapshot.trusted.config);
  const lanesDirectory = join(options.directory, 'lanes');
  const ids = existsSync(lanesDirectory) ? readdirSync(lanesDirectory).sort().filter(id => existsSync(join(lanesDirectory, id, 'manifest.json'))) : [];
  const admitted: AdmittedLane[] = [];
  const lanes: CertificateLane[] = [];
  const artifacts: CertificateArtifact[] = [];
  for (const id of ids) {
    const manifest = relativePath(join('lanes', id, 'manifest.json'));
    const lane = await admitLane(join(options.directory, manifest), report, join(options.directory, 'evidence'), r);
    const entries = laneEntries(options.directory, manifest, lane);
    const provider = entries.lane.provider;
    if (lane.role === 'pre-pr reviewer' && choice) {
      const launched = `${entries.lane.provider}:${entries.lane.model}@${entries.lane.effort}`;
      if (launched !== choice.descriptor) throw new Error(`Reviewer lane differs from the chosen lane (${launched}, chose ${choice.descriptor})`);
      if (authors.includes(provider)) throw new Error(`Reviewer lane is the same family as an author (${provider}); launch the lane converge-certify reviewer chose`);
    }
    admitted.push(lane);
    lanes.push(entries.lane);
    artifacts.push(...entries.artifacts);
  }
  const decision = decide(report, admitted);
  if (decision.verdict !== 'VERIFIED') throw new Error(`Certificate refused: ${decision.verdict}: ${[...decision.findings.map(f => `${f.kind} ${f.rule} ${f.path ?? ''}:${f.line}`), ...decision.reasons].join('; ')}`);
  const certificate: Certificate = { schemaVersion: 2, round: r, authorProviders: authors, runs, lanes, artifacts, decision, reconcileDigest: jsonHash(report), evidenceDigest: jsonHash(admitted), coverage: admitted.flatMap(l => l.coverage), adjustRounds: options.adjustRounds, toolingRef: toolingRef() };
  writeFileSync(options.output, JSON.stringify(certificate, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return certificate;
}
/** Re-derives every derived field against the PR report and the live contract (head, patch and policy, the run policy, each run, lane and artifact from bytes, the digests, coverage and decision), so a hand-edited certificate cannot publish what its evidence does not yield. adjustRounds and toolingRef are the Raiz's declarations, checked only in format. authorProviders is the union the assembly recorded: parseCertificate checks that no reviewer lane has one of its families, and admission that it covers every Pstack-Author family of the PR's commits. */
export async function admitCertificate(file: string, report: Report, evidenceDirectory: string, contract: Contract): Promise<{ certificate: Certificate; lanes: AdmittedLane[] }> {
  const certificate = parseCertificate(JSON.parse(readFileSync(file, 'utf8')));
  const directory = dirname(resolve(file));
  const c = certificate.round, r = report.round;
  if (c.repo !== r.repo || c.head !== r.head) throw new Error('PR head differs from certificate');
  if (c.patch_id !== r.patch_id || c.contract !== r.contract || c.verificationDigest !== r.verificationDigest || c.configPath !== r.configPath) throw new Error('Certificate patch or policy differs from the PR');
  for (const family of report.authors) if (!certificate.authorProviders.includes(family)) throw new Error(`Certificate author families miss a Pstack-Author family (${family})`);
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
    if (lane.role === 'pre-pr reviewer' && certificate.authorProviders.includes(lane.provider)) throw new Error('Reviewer lane is the same family as an author');
    admitted.push(result);
    artifacts.push(...entries.artifacts);
  }
  if (jsonHash(artifacts) !== jsonHash(certificate.artifacts)) throw new Error('Certificate artifacts differ from the admitted lanes');
  if (jsonHash(admitted) !== certificate.evidenceDigest) throw new Error('Certificate evidence digest differs');
  if (jsonHash(admitted.flatMap(l => l.coverage)) !== jsonHash(certificate.coverage)) throw new Error('Certificate coverage differs from the admitted lanes');
  if (jsonHash(decide(branch, admitted)) !== jsonHash(certificate.decision)) throw new Error('Certificate decision differs from the admitted evidence');
  return { certificate, lanes: admitted };
}
export type CertifyStep = 'report' | 'runs' | 'reviewer' | 'certifier' | 'assemble';
export type Certified = { certificate: Certificate } | { refused: { step: CertifyStep; reason: string } };
export interface CertifyOptions {
  repo: string; head: string; directory: string; worktree: string; parent: 'claude' | 'codex'; sheet: string;
  authorProviders: string[]; adjustRounds: number; certifierWorktree: string | null; lease: { by: string; pid: number | null; branch: string } | null; configPath?: string;
}
const RUNNER = fileURLToPath(new URL('../runner/pstack-runner', import.meta.url));
const SELF = fileURLToPath(new URL('./converge-certify', import.meta.url));
const LOCAL = fileURLToPath(new URL('./converge-local', import.meta.url));
const PROMPTS = fileURLToPath(new URL('../../references/pre-pr-prompts.md', import.meta.url));
const LANE_TIMEOUT_SECONDS = 1800;
class Refused extends Error {
  readonly step: CertifyStep;
  constructor(step: CertifyStep, reason: string) { super(reason); this.step = step; }
}
async function step<T>(name: CertifyStep, work: () => T | Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) { throw error instanceof Refused ? error : new Refused(name, error instanceof Error ? error.message : String(error)); }
}
function atHead(cwd: string, head: string, what: string): void {
  const state = checkoutState(cwd);
  if (state.head !== head) throw new Error(`${what} is not at the head`);
  if (!state.clean) throw new Error(`${what} has changes`);
}
interface LanePlan { role: Role; id: string; descriptor: string; provider: string; model: string; effort: string; mode: 'read-only' | 'unsandboxed'; cwd: string; block: string; values: Record<string, string> }
function lanePrompt(block: string, values: Record<string, string>): string {
  const template = readFileSync(PROMPTS, 'utf8').split(/^## /m).find(chunk => chunk.startsWith(block + '\n'))?.match(/^```text\n([\s\S]*?)\n```$/m)?.[1];
  if (template === undefined) throw new Error(`No ${block} block in pre-pr-prompts.md`);
  return template.replace(/\{\{([a-zA-Z]+)\}\}/g, (_, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`No value for {{${key}}} in the ${block} block`);
    return value;
  });
}
function planLane(role: Role, report: Report, contract: Contract, options: CertifyOptions): LanePlan {
  const r = report.round;
  const round = { repo: r.repo, head: r.head, roundId: r.id, contract: r.contract };
  if (role === 'pre-pr reviewer') {
    const choice = chooseReviewer({ directory: options.directory, parent: options.parent, sheetPath: options.sheet, authorProviders: options.authorProviders });
    if (choice.provider !== 'grok' && report.hardList.some(f => f.severity === 'requires-proof')) throw new Error(`Reviewer risk proof unavailable: the hard list asks for a risk proof, and only a Grok reviewer writes one in this version (chose ${choice.descriptor})`);
    return { role, id: 'pre-pr-reviewer', descriptor: choice.descriptor, provider: choice.provider, model: choice.model, effort: choice.effort, mode: 'read-only', cwd: options.worktree, block: report.mode === 'full' ? 'Reviewer' : 'Reviewer (light)',
      values: { ...round, reportPath: join(options.directory, 'report.json'), runsDirectory: join(options.directory, 'runs'), worktree: options.worktree, irreversible: JSON.stringify(contract.riskClasses.irreversible), contained: JSON.stringify(contract.riskClasses.contained) } };
  }
  if (role !== 'pre-pr certifier') throw new Error(`Role ${role} does not belong to a pre-pr round`);
  const row = sheetRow(readSheet(options.sheet), role);
  if (row.length !== 1) throw new Error('pre-pr certifier takes one lane');
  const descriptor = row[0] ?? '';
  const matrix = loadMatrix();
  if (matrix.aliases.includes(descriptor)) throw new Error(`The ${role} row cannot be an alias (${descriptor}); a pre-PR lane runs through pstack-runner`);
  const { descriptor: parsed, family } = resolveDescriptor(matrix, descriptor);
  const worktree = options.certifierWorktree;
  if (worktree === null) throw new Error('The report asks for the pre-pr certifier; pass --certifier-worktree');
  atHead(worktree, r.head, 'Certifier worktree');
  return { role, id: 'pre-pr-certifier', descriptor, provider: family.provider, model: family.model, effort: parsed.effort, mode: 'unsandboxed', cwd: worktree, block: 'Certifier',
    values: { ...round, worktree, verifySkill: join(worktree, contract.verifySkill ?? ''), features: report.touchedFeatures.map(f => `${f.id}, ${f.page}, ${f.recipe}`).join('\n') } };
}
function renewLease(options: CertifyOptions): void {
  if (!options.lease) return;
  const { by, pid, branch } = options.lease;
  const renewed = spawnSync(process.execPath, [LOCAL, 'lease', '--repo', options.repo, '--branch', branch, '--by', by, ...(pid === null ? [] : ['--pid', String(pid)]), '--ttl', String(LEASE_TTL_HOURS)], { encoding: 'utf8' });
  if (renewed.status !== 0) throw new Error(renewed.stderr.trim() || 'Lease renewal failed');
}
function laneStatus(directory: string, lane: LanePlan, head: string): string {
  let receipt: Record<string, unknown>;
  try { receipt = object(JSON.parse(readFileSync(join(directory, 'receipt.json'), 'utf8'))); }
  catch { return 'missing'; }
  const status = typeof receipt.status === 'string' ? receipt.status : 'invalid';
  if (status !== 'complete' || lane.role !== 'pre-pr certifier') return status;
  return leftAtHeadAndClean(receipt.checkout, head) ? status : 'complete with a moved or changed worktree';
}
function leftAtHeadAndClean(value: unknown, head: string): boolean {
  const checkout = value && typeof value === 'object' ? object(value) : {};
  return checkout.headBefore === head && checkout.headAfter === head && Array.isArray(checkout.statusAfter) && checkout.statusAfter.length === 0;
}
class RoundProcesses {
  stopped = false;
  private readonly processes = new Map<ChildProcess, { killOnStop: boolean; closed: Promise<number> }>();
  start(args: string[], killOnStop: boolean, log: string | null = null): Promise<number> {
    if (this.stopped) throw new Error('The round was stopped');
    const fd = log === null ? null : openSync(log, 'a', 0o600);
    const child = spawn(process.execPath, args, { stdio: ['ignore', fd ?? 'ignore', fd ?? 'ignore'] });
    if (fd !== null) closeSync(fd);
    const closed = new Promise<number>(done => {
      child.on('error', () => done(128));
      child.on('close', code => done(code ?? 128));
    }).finally(() => this.processes.delete(child));
    this.processes.set(child, { killOnStop, closed });
    return closed;
  }
  async stop(): Promise<void> {
    this.stopped = true;
    for (const [child, { killOnStop }] of this.processes) if (killOnStop) child.kill('SIGTERM');
    await Promise.all([...this.processes.values()].map(p => p.closed));
  }
}
function restoreCertifierWorktree(cwd: string, directory: string, head: string): void {
  const git = (args: string[]): string => {
    const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (result.status !== 0) throw new Error((result.stderr || result.error?.message || `git ${args[0]} failed`).trim());
    return result.stdout;
  };
  writeFileSync(join(directory, 'worktree-status.txt'), git(['status', '--porcelain', '--untracked-files=all']), { mode: 0o600 });
  writeFileSync(join(directory, 'worktree.diff'), git(['diff', 'HEAD']), { mode: 0o600 });
  git(['checkout', '-f', '--detach', head]);
  git(['reset', '--hard', head]);
  git(['clean', '-fd']);
}
async function launchLane(flight: RoundProcesses, runner: string, lane: LanePlan, report: Report, options: CertifyOptions): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    if (flight.stopped) throw new Error('The round was stopped');
    if (lane.role === 'pre-pr certifier') atHead(lane.cwd, report.round.head, 'Certifier worktree');
    renewLease(options);
    const directory = join(options.directory, 'lanes', lane.id);
    const artifactPrefix = join(directory, 'artifacts', 'converge', report.round.id, lane.id) + '/';
    mkdirSync(artifactPrefix, { recursive: true, mode: 0o700 });
    const prompt = lanePrompt(lane.block, { ...lane.values, laneDirectory: directory, artifactPrefix });
    writeFileSync(join(directory, 'prompt.txt'), prompt, { flag: 'wx', mode: 0o600 });
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ schemaVersion: 1, round: report.round, laneId: lane.id, role: lane.role, descriptor: lane.descriptor, prompt: 'prompt.txt', promptDigest: hash(prompt), output: 'output.json', receipt: 'receipt.json', createdAt: Date.now() }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await flight.start([runner, '--parent', options.parent, '--provider', lane.provider, '--model', lane.model, '--effort', lane.effort, '--mode', lane.mode, '--prompt', join(directory, 'prompt.txt'), '--cwd', lane.cwd, '--output', join(directory, 'output.json'), '--receipt', join(directory, 'receipt.json'), '--timeout', String(LANE_TIMEOUT_SECONDS)], true, join(directory, 'runner.log'));
    const status = laneStatus(directory, lane, report.round.head);
    if (status === 'complete') return;
    if (flight.stopped) throw new Error('The round was stopped');
    if (attempt === 2) throw new Error(`Lane ${lane.id} receipt is ${status} after its relaunch`);
    mkdirSync(join(options.directory, 'attempts'), { recursive: true, mode: 0o700 });
    const kept = join(options.directory, 'attempts', `${lane.id}-${attempt}`);
    renameSync(directory, kept);
    if (lane.role === 'pre-pr certifier') restoreCertifierWorktree(lane.cwd, kept, report.round.head);
    rmSync(join(options.directory, 'evidence'), { recursive: true, force: true });
  }
}
function laneStep(role: Role): CertifyStep { return role === 'pre-pr certifier' ? 'certifier' : 'reviewer'; }
export async function certifyHead(options: CertifyOptions, runner = RUNNER): Promise<Certified> {
  adjustRounds(options.adjustRounds);
  const declared = authorProviders(options.authorProviders);
  knownAuthors(declared, loadMatrix());
  const flight = new RoundProcesses();
  try {
    const { report, contract } = await step('report', async () => {
      const written = await writeReport(options);
      if (written.report.unmappedSurfaces.length) throw new Error('Changed user surface lacks a trusted feature recipe: ' + written.report.unmappedSurfaces.join(', '));
      if (written.report.gaps.length) throw new Error('The report has gaps: ' + written.report.gaps.join('; '));
      return written;
    });
    const lanes = await Promise.all(report.lanes.map(role => step(laneStep(role), () => planLane(role, report, contract, options))));
    const runs = report.mode === 'ci-only' ? [] : contract.prePr?.runs ?? [];
    const certifier = lanes.find(lane => lane.role === 'pre-pr certifier');
    const reviewer = lanes.find(lane => lane.role === 'pre-pr reviewer');
    if (runs.length || reviewer) await step(runs.length ? 'runs' : 'reviewer', () => atHead(options.worktree, report.round.head, 'Worktree'));
    await Promise.all([
      certifier && step('certifier', () => launchLane(flight, runner, certifier, report, options)),
      (async () => {
        await step('runs', async () => {
          const codes = await Promise.all(runs.map(run => flight.start([SELF, 'run', '--directory', options.directory, '--name', run.name, '--cwd', options.worktree, '--', ...run.command.split(' ')], false)));
          const failed = runs.findIndex((_, n) => codes[n] !== 0);
          if (failed >= 0) throw new Error(`Run ${runs[failed]?.name} exited ${codes[failed]}`);
        });
        if (reviewer) await step('reviewer', () => launchLane(flight, runner, reviewer, report, options));
      })(),
    ]);
    return { certificate: await step('assemble', () => assemble({ directory: options.directory, authorProviders: declared, output: join(options.directory, 'certificate.json'), adjustRounds: options.adjustRounds })) };
  } catch (error) {
    await flight.stop();
    if (error instanceof Refused) return { refused: { step: error.step, reason: error.message } };
    throw error;
  }
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
    if (command === 'reviewer') {
      const { values } = parseArgs({ args: rest, options: { directory: { type: 'string' }, parent: { type: 'string' }, sheet: { type: 'string' }, 'author-provider': { type: 'string' } } });
      if (!values.directory || !values.parent || !values['author-provider']) throw new Error('Usage: converge-certify reviewer --directory RUN --parent <claude|codex> [--sheet PATH] --author-provider PROVIDER[,PROVIDER...]');
      process.stdout.write(JSON.stringify(chooseReviewer({ directory: resolve(values.directory), parent: values.parent, sheetPath: values.sheet === undefined ? undefined : resolve(values.sheet), authorProviders: values['author-provider'].split(',').map(s => s.trim()).filter(Boolean) }), null, 2) + '\n');
      return 0;
    }
    if (command === 'assemble') {
      const { values } = parseArgs({ args: rest, options: { directory: { type: 'string' }, 'author-provider': { type: 'string' }, output: { type: 'string' }, 'adjust-rounds': { type: 'string' } } });
      const rounds = values['adjust-rounds'];
      if (!values.directory || !values['author-provider'] || !values.output || rounds === undefined) throw new Error('Usage: converge-certify assemble --directory RUN --author-provider PROVIDER[,PROVIDER...] --output RUN/certificate.json --adjust-rounds N');
      process.stdout.write(JSON.stringify(await assemble({ directory: resolve(values.directory), authorProviders: values['author-provider'].split(',').map(s => s.trim()).filter(Boolean), output: resolve(values.output), adjustRounds: /^\d+$/.test(rounds) ? Number(rounds) : NaN }), null, 2) + '\n');
      return 0;
    }
    if (command === 'certify') {
      const { values } = parseArgs({ args: rest, options: { repo: { type: 'string' }, head: { type: 'string' }, directory: { type: 'string' }, worktree: { type: 'string' }, parent: { type: 'string' }, sheet: { type: 'string' }, 'author-provider': { type: 'string' }, 'adjust-rounds': { type: 'string' }, 'certifier-worktree': { type: 'string' }, 'lease-by': { type: 'string' }, 'lease-pid': { type: 'string' }, branch: { type: 'string' }, config: { type: 'string' } } });
      const { parent, 'lease-by': by, 'lease-pid': pid } = values;
      const rounds = values['adjust-rounds'];
      if (!values.repo || !values.head || !values.directory || !values.worktree || (parent !== 'claude' && parent !== 'codex') || !values['author-provider'] || rounds === undefined || (by !== undefined && !values.branch) || (pid !== undefined && (by === undefined || !/^\d+$/.test(pid)))) throw new Error('Usage: converge-certify certify --repo owner/repo --head SHA --directory RUN --worktree W --parent claude|codex [--sheet PATH] --author-provider PROVIDER[,PROVIDER...] --adjust-rounds N [--certifier-worktree RUN/certify] [--lease-by NAME [--lease-pid N] --branch B] [--config path]');
      const result = await certifyHead({ repo: values.repo, head: values.head, directory: resolve(values.directory), worktree: resolve(values.worktree), parent,
        sheet: resolve(values.sheet ?? defaultSheetPath(parent)), authorProviders: values['author-provider'].split(',').map(s => s.trim()).filter(Boolean),
        adjustRounds: /^\d+$/.test(rounds) ? Number(rounds) : NaN, certifierWorktree: values['certifier-worktree'] === undefined ? null : resolve(values['certifier-worktree']),
        lease: by === undefined ? null : { by, pid: pid === undefined ? null : Number(pid), branch: values.branch ?? '' }, configPath: values.config });
      process.stdout.write(JSON.stringify('certificate' in result ? result.certificate : result, null, 2) + '\n');
      return 'certificate' in result ? 0 : 1;
    }
    throw new Error('Usage: converge-certify <run|report|reviewer|assemble|certify> ...');
  } catch (error) { process.stderr.write((error instanceof SyntaxError ? 'Malformed JSON input' : error instanceof Error ? error.message : 'Certification failed') + '\n'); return 1; }
}
