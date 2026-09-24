import { readFileSync, writeFileSync, mkdirSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, dirname, sep } from 'node:path';
import { array, digest, hash, integer, jsonHash, object, oneOf, parseFinding, parseRound, parseObligation, riskObligation, roleProviders, roles, sameObligation, relativePath, sha, string, strings, type Finding, type Report, type Role, type RiskObligation, type Round } from './contract.ts';
import { containsSecret } from './reconcile.ts';
import { loadMatrix, resolveDescriptor, reportedModelMatches } from '../../../../scripts/model-matrix.ts';

export interface AdmittedLane {
  role: Role; coverage: string[]; risks: RiskObligation[]; findings: Finding[]; gaps: string[];
  artifacts: { id: string; path: string; digest: string; mediaType: string }[]; receiptDigest: string;
}
function readOwned(path: string, root: string): Buffer {
  const full = resolve(root, relativePath(path));
  const real = realpathSync(full);
  if (!real.startsWith(realpathSync(root) + sep) || !lstatSync(full).isFile() || lstatSync(full).size > 20_000_000) throw new Error('Unsafe evidence file');
  return readFileSync(full);
}
async function cursor(path: string): Promise<unknown> {
  const key = process.env.CURSOR_API_KEY;
  if (!key) throw new Error('Cursor credential unavailable');
  const response = await fetch('https://api.cursor.com/v1/' + path, { headers: { Authorization: 'Basic ' + Buffer.from(key + ':').toString('base64') }, redirect: 'error', signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error('Cursor artifact API unavailable');
  return response.json();
}
async function boundedBytes(response: Response, maximum: number): Promise<Buffer> {
  if (!response.ok || !response.body) throw new Error('Artifact download unavailable');
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > maximum) { await response.body.cancel().catch(() => undefined); throw new Error('Artifact exceeds size limit'); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function media(bytes: Buffer, type: string): void {
  if (type === 'image/png') {
    if (!bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new Error('Artifact is not a PNG');
  } else if (type === 'application/json' || type === 'text/plain') {
    const text = bytes.toString('utf8');
    if (containsSecret(text)) throw new Error('Artifact contains secret-shaped content');
    if (type === 'application/json') JSON.parse(text);
  } else throw new Error('Unsupported artifact media');
}
export async function admitLane(manifestFile: string, report: Report, evidenceDirectory: string, round: Round = report.round): Promise<AdmittedLane> {
  const manifest = object(JSON.parse(readFileSync(manifestFile, 'utf8')));
  const root = dirname(resolve(manifestFile));
  if (jsonHash(parseRound(manifest.round)) !== jsonHash(round)) throw new Error('Lane manifest belongs to another round');
  const laneId = relativePath(manifest.laneId);
  if (laneId.includes('/')) throw new Error('Invalid lane id');
  const role = oneOf(manifest.role, roles);
  const promptPath = relativePath(manifest.prompt);
  if (hash(readOwned(promptPath, root)) !== digest(manifest.promptDigest)) throw new Error('Lane prompt changed');
  const receiptBytes = readOwned(relativePath(manifest.receipt), root);
  const receipt = object(JSON.parse(receiptBytes.toString('utf8')));
  const expected = resolveDescriptor(loadMatrix(), string(manifest.descriptor));
  const allowed = roleProviders[role];
  if (expected.family.provider !== allowed.provider || expected.family.model !== allowed.model || !allowed.efforts.includes(expected.descriptor.effort)) throw new Error(`Role ${role} requires ${allowed.provider} ${allowed.model} at ${allowed.efforts.join(' or ')}`);
  if (receipt.schemaVersion !== 1 || receipt.status !== 'complete' || receipt.mode !== 'read-only' || !((receipt.modelEvidence === 'provider-report' && receipt.modelVerified === true && reportedModelMatches(expected.family, string(receipt.reportedModel))) || (receipt.modelEvidence === 'pinned-argv' && receipt.modelVerified === false && receipt.reportedModel === null && expected.family.reportedModel === null))) throw new Error('Lane receipt does not prove independent completion');
  if (receipt.provider !== expected.family.provider || receipt.model !== expected.family.model || receipt.effort !== expected.descriptor.effort) throw new Error('Lane receipt model differs from dispatch');
  const outputPath = relativePath(manifest.output);
  if (resolve(string(receipt.promptPath)) !== resolve(root, promptPath) || resolve(string(receipt.outputPath)) !== resolve(root, outputPath)) throw new Error('Lane receipt paths differ from dispatch');
  const startedAt = Date.parse(string(receipt.startedAt));
  const completedAt = Date.parse(string(receipt.completedAt));
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || startedAt < integer(manifest.createdAt) || completedAt < startedAt) throw new Error('Lane receipt predates dispatch');
  const outputBytes = readOwned(outputPath, root);
  if (containsSecret(outputBytes.toString('utf8'))) throw new Error('Lane output contains secret-shaped content');
  const output = object(JSON.parse(outputBytes.toString('utf8')));
  if (output.schemaVersion !== 1 || output.round !== round.id || output.laneId !== laneId || output.role !== role || sha(output.observedHead) !== round.head || sha(output.observedContract) !== round.contract) throw new Error('Lane output identity mismatch');
  if (output.kind === 'unavailable') return { role, coverage: [], risks: [], findings: [], gaps: ['Independent lane unavailable'], artifacts: [], receiptDigest: hash(receiptBytes) };
  if (output.kind !== 'complete') throw new Error('Invalid lane completion');
  const remote = receipt.remote === null ? null : object(receipt.remote);
  if ((loadMatrix().providers[expected.family.provider]?.transport === 'http') !== (remote !== null)) throw new Error('Receipt transport differs from dispatch');
  let agentId = '';
  let runId = '';
  let listed: Record<string, unknown>[] = [];
  if (remote) {
    const heads = object(remote.heads);
    if (heads.kind !== 'observed' || array(heads.changedBranches).length !== 0) throw new Error('Read-only lane changed remote heads or lacks observation');
    agentId = string(remote.agentId); runId = string(remote.runId);
    if (!/^[A-Za-z0-9_-]+$/.test(agentId) || !/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error('Invalid Cursor run identity');
    const run = object(await cursor(`agents/${agentId}/runs/${runId}`));
    if (run.runId !== undefined && run.runId !== runId) throw new Error('Cursor run identity mismatch');
    listed = array(object(await cursor(`agents/${agentId}/artifacts`)).items).map(v => object(v));
  }
  const artifacts: AdmittedLane['artifacts'] = [];
  const prefix = `artifacts/converge/${round.id}/${laneId}/`;
  mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
  for (const raw of array(output.artifacts)) {
    const a = object(raw);
    const path = relativePath(a.path);
    const id = relativePath(a.id);
    if (artifacts.some(a => a.id === id) || !path.startsWith(prefix)) throw new Error('Artifact outside dispatched lane');
    const size = integer(a.bytes);
    if (!size || size > 20_000_000) throw new Error('Artifact size outside bounds');
    const expectedDigest = digest(a.sha256);
    let bytes: Buffer;
    if (remote) {
      if (!listed.some(item => item.path === path)) throw new Error('Claimed artifact absent from Cursor');
      const download = object(await cursor(`agents/${agentId}/artifacts/download?path=${encodeURIComponent(path)}`));
      const url = new URL(string(download.url));
      if (url.protocol !== 'https:' || url.username || url.password || !/(?:^|\.)amazonaws\.com$/.test(url.hostname)) throw new Error('Untrusted artifact download URL');
      bytes = await boundedBytes(await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60_000) }), size);
    } else bytes = readOwned(path, root);
    if (bytes.length !== size || hash(bytes) !== expectedDigest) throw new Error('Artifact bytes differ from lane report');
    media(bytes, string(a.mediaType));
    const destination = resolve(realpathSync(evidenceDirectory), laneId + '-' + hash(id));
    if (!destination.startsWith(realpathSync(evidenceDirectory) + sep)) throw new Error('Artifact destination escapes evidence directory');
    try { writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (!lstatSync(destination).isFile() || hash(readFileSync(destination)) !== expectedDigest) throw error; }
    artifacts.push({ id, path, digest: expectedDigest, mediaType: string(a.mediaType) });
  }
  function admitted(ids: unknown): boolean { const names = strings(ids); return names.length > 0 && names.every(id => artifacts.some(a => a.id === id)); }
  const coverage: string[] = [];
  const gaps: string[] = [];
  for (const value of array(output.coverage)) {
    const c = object(value);
    if (c.result === 'driven' && admitted(c.artifactIds) && strings(c.artifactIds).some(id => artifacts.some(a => a.id === id && a.mediaType === 'image/png')) && strings(c.artifactIds).some(id => artifacts.some(a => a.id === id && ['text/plain', 'application/json'].includes(a.mediaType))) && string(c.entryPoint).length > 0) coverage.push(relativePath(c.featureId));
    else gaps.push('Live user path was not driven with evidence');
  }
  const risks: RiskObligation[] = [];
  const findings = array(output.findings).map(parseFinding);
  for (const value of array(output.riskProofs)) {
    const risk = object(value);
    const obligation = parseObligation(risk.obligation);
    const original = report.hardList.find(f => f.severity === 'requires-proof' && sameObligation(riskObligation(f), obligation));
    if (!original) throw new Error('Reviewer proof does not identify a requested obligation');
    if (risk.result === 'proved-safe' && admitted(risk.artifactIds)) risks.push(obligation);
    else if (risk.result === 'defect' && admitted(risk.artifactIds)) findings.push({ ...original, severity: 'blocking' });
    else gaps.push('Reviewer risk proof unavailable');
  }
  return { role, coverage, risks, findings, gaps, artifacts, receiptDigest: hash(receiptBytes) };
}
