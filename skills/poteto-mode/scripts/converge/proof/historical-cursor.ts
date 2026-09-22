import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { array, hash, integer, object, relativePath, string } from '../contract.ts';
import { originalOf, type Original } from './plant.ts';

export const CURSOR_HOST = 'https://api.cursor.com';
export const CURSOR_ENV = {
  apiKey: 'CURSOR_API_KEY',
  baseUrl: 'PSTACK_CURSOR_BASE_URL',
};

const LOOPBACK = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);
const DOWNLOAD_LIMIT = 20_000_000;

export type ExecutableCommand = Readonly<{
  name: string;
  args: readonly string[];
  fullText: string;
}>;

export type ToolOutcome =
  | Readonly<{ kind: 'success'; exitCode: number | null; stdout: string | null; stderr: string | null; content: string | null }>
  | Readonly<{ kind: 'failed' }>;

export type CompletedTool = Readonly<{
  callId: string;
  name: string;
  command: string;
  args: unknown;
  result: unknown;
  executables: readonly ExecutableCommand[];
  outcome: ToolOutcome;
}>;

export type ParsedRunStream = Readonly<{
  runIds: ReadonlySet<string>;
  terminalStatus: string | null;
  tools: readonly CompletedTool[];
}>;

export type CursorEndpoint = Readonly<{
  baseUrl: string;
  apiKey: string | null;
  loopback: boolean;
}>;

export type DownloadedArtifact = Readonly<{
  path: string;
  bytes: number;
  sha256: string;
  original: Original;
}>;

export type CollectedRemote = Readonly<{
  originalRemoteRun: Original;
  originalToolStream: Original | null;
  originalArtifactListing: Original | null;
  originalCollection: Original;
  remoteStatus: string;
  remoteResult: string | null;
  agentId: string;
  runId: string;
  prUrl: string | null;
  repoUrl: string | null;
  downloaded: readonly DownloadedArtifact[];
}>;

export class RemoteCollectionError extends Error {
  readonly originals: readonly Original[];
  constructor(message: string, originals: readonly Original[]) {
    super(message);
    this.name = 'RemoteCollectionError';
    this.originals = originals;
  }
}

class CursorHttpError extends Error {
  readonly status: number;
  readonly bytes: Buffer;
  constructor(status: number, bytes: Buffer) {
    super(`Cursor API returned HTTP ${status}`);
    this.name = 'CursorHttpError';
    this.status = status;
    this.bytes = bytes;
  }
}

type StreamEntry = Readonly<{ event: string | null; data: unknown }>;
type ToolFragment = Readonly<{
  callId: string;
  name: string;
  status: string | null;
  args: unknown;
  result: unknown;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function loopbackOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return LOOPBACK.has(url.hostname) ? url.origin : null;
  } catch {
    return null;
  }
}

export function resolveCursorEndpoint(env: NodeJS.ProcessEnv = process.env): CursorEndpoint {
  const override = loopbackOrigin(env[CURSOR_ENV.baseUrl]);
  return {
    baseUrl: override ?? CURSOR_HOST,
    apiKey: env[CURSOR_ENV.apiKey]?.trim() || null,
    loopback: override !== null,
  };
}

function authorization(apiKey: string): string {
  return 'Basic ' + Buffer.from(apiKey + ':').toString('base64');
}

async function boundedBytes(response: Response, maximum: number): Promise<Buffer> {
  if (!response.ok || !response.body) throw new Error('Artifact download unavailable');
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of response.body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buf.length;
    if (length > maximum) {
      await response.body.cancel().catch(() => undefined);
      throw new Error('Artifact exceeds size limit');
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function writeExclusive(path: string, bytes: string | Buffer): Original {
  mkdirSync(resolve(path, '..'), { recursive: true, mode: 0o700 });
  const data = typeof bytes === 'string' ? Buffer.from(bytes) : bytes;
  try {
    writeFileSync(path, data, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (!isRecord(error) || error.code !== 'EEXIST') throw error;
    const existing = readFileSync(path);
    if (hash(existing) !== hash(data)) throw new Error('Original evidence conflict at ' + path);
    return originalOf(path, existing);
  }
  return originalOf(path, data);
}

function writeSnapshot(directory: string, label: string, extension: string, bytes: string | Buffer): Original {
  const data = typeof bytes === 'string' ? Buffer.from(bytes) : bytes;
  return writeExclusive(join(directory, `${label}-${hash(data)}.${extension}`), data);
}

export function verifiedOriginalBytes(original: Original): Buffer | null {
  try {
    const bytes = readFileSync(original.path);
    return hash(bytes) === original.sha256 ? bytes : null;
  } catch {
    return null;
  }
}

function entriesFrom(raw: unknown): StreamEntry[] {
  if (typeof raw === 'string') return entriesFromText(raw);
  if (Array.isArray(raw)) return raw.flatMap(value => entriesFrom(value));
  if (!isRecord(raw)) return [];
  const entries: StreamEntry[] = [{ event: typeof raw.event === 'string' ? raw.event : null, data: raw.data ?? raw }];
  for (const key of ['tools', 'items', 'messages', 'events']) {
    if (Array.isArray(raw[key])) entries.push(...raw[key].flatMap(value => entriesFrom(value)));
  }
  return entries;
}

function entriesFromText(text: string): StreamEntry[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { return entriesFrom(JSON.parse(trimmed)); }
    catch { /* continue as SSE */ }
  }
  const entries: StreamEntry[] = [];
  for (const block of text.split(/\r?\n\r?\n+/)) {
    const event = block.split(/\r?\n/).find(line => line.startsWith('event:'))?.slice(6).trim() ?? null;
    const dataLines = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart());
    if (!dataLines.length) continue;
    try { entries.push({ event, data: JSON.parse(dataLines.join('\n')) }); }
    catch { entries.push({ event, data: dataLines.join('\n') }); }
  }
  return entries;
}

function fragmentFrom(entry: StreamEntry): ToolFragment | null {
  if (!isRecord(entry.data)) return null;
  const value = entry.data;
  if (entry.event === 'interaction_update' && typeof value.type === 'string' && value.type.startsWith('tool-call-')) {
    if (!isRecord(value.toolCall)) return null;
    const call = value.toolCall;
    const callId = typeof value.callId === 'string' ? value.callId : '';
    if (!callId) return null;
    return {
      callId,
      name: typeof call.name === 'string' ? call.name : typeof call.type === 'string' ? call.type : '',
      status: value.type === 'tool-call-completed' ? 'completed' : value.type === 'tool-call-started' ? 'running' : null,
      args: call.args,
      result: call.result,
    };
  }
  const nested = isRecord(value.tool_call) ? value.tool_call : isRecord(value.toolCall) ? value.toolCall : value;
  const callId = typeof nested.callId === 'string' ? nested.callId
    : typeof nested.call_id === 'string' ? nested.call_id
      : typeof value.callId === 'string' ? value.callId
        : typeof value.id === 'string' ? value.id
          : '';
  const name = typeof nested.name === 'string' ? nested.name : typeof value.name === 'string' ? value.name : '';
  const args = nested.args ?? value.args;
  const command = typeof nested.command === 'string' ? nested.command : typeof value.command === 'string' ? value.command : null;
  if (!callId || (!name && command === null)) return null;
  return {
    callId,
    name: name || 'run_terminal_cmd',
    status: typeof value.status === 'string' ? value.status : typeof nested.status === 'string' ? nested.status : null,
    args: args ?? (command === null ? undefined : { command }),
    result: nested.result ?? value.result,
  };
}

function commandFrom(args: unknown, result: unknown): string {
  if (isRecord(args) && typeof args.command === 'string') return args.command;
  if (isRecord(result) && isRecord(result.success) && typeof result.success.command === 'string') return result.success.command;
  if (isRecord(result) && isRecord(result.value) && typeof result.value.command === 'string') return result.value.command;
  return '';
}

function executableCommands(args: unknown): ExecutableCommand[] {
  if (!isRecord(args) || !isRecord(args.parsingResult) || !Array.isArray(args.parsingResult.executableCommands)) return [];
  const out: ExecutableCommand[] = [];
  for (const item of args.parsingResult.executableCommands) {
    if (!isRecord(item) || typeof item.name !== 'string' || !Array.isArray(item.args) || typeof item.fullText !== 'string') return [];
    const commandArgs: string[] = [];
    for (const arg of item.args) {
      if (!isRecord(arg) || typeof arg.value !== 'string') return [];
      commandArgs.push(arg.value);
    }
    out.push({ name: item.name, args: commandArgs, fullText: item.fullText });
  }
  return out;
}

function textField(value: Record<string, unknown>, key: string): string | null {
  return typeof value[key] === 'string' ? value[key] : null;
}

function mergeOutcome(statuses: readonly (string | null)[], results: readonly unknown[]): ToolOutcome {
  if (statuses.some(status => status === 'failed' || status === 'error')) return { kind: 'failed' };
  let sawSuccess = false;
  let exitCode: number | null = null;
  let stdout: string | null = null;
  let stderr: string | null = null;
  let content: string | null = null;
  for (const result of results) {
    if (!isRecord(result)) continue;
    if (result.success === false || isRecord(result.error) || result.status === 'error' || result.status === 'failed') continue;
    const success = isRecord(result.success) ? result.success
      : result.status === 'success' && isRecord(result.value) ? result.value
        : null;
    if (!success) continue;
    sawSuccess = true;
    if (typeof success.exitCode === 'number' && Number.isSafeInteger(success.exitCode)) exitCode = success.exitCode;
    stdout = textField(success, 'stdout') ?? textField(success, 'interleavedOutput') ?? stdout;
    stderr = textField(success, 'stderr') ?? stderr;
    content = textField(success, 'content') ?? stdout ?? content;
  }
  return sawSuccess ? { kind: 'success', exitCode, stdout, stderr, content } : { kind: 'failed' };
}

export function parseCompletedTools(raw: unknown): CompletedTool[] {
  const fragments = entriesFrom(raw).map(fragmentFrom).filter((value): value is ToolFragment => value !== null);
  const byCall = new Map<string, ToolFragment[]>();
  for (const fragment of fragments) byCall.set(fragment.callId, [...(byCall.get(fragment.callId) ?? []), fragment]);
  const tools: CompletedTool[] = [];
  for (const [callId, calls] of byCall) {
    const completed = calls.some(call => call.status === 'completed' || call.result !== undefined);
    if (!completed) continue;
    const withStructuredArgs = calls.findLast(call => isRecord(call.args) && isRecord(call.args.parsingResult));
    const withArgs = withStructuredArgs ?? calls.findLast(call => call.args !== undefined);
    const named = calls.find(call => call.name && call.name !== 'shell') ?? calls.find(call => call.name);
    const results = calls.map(call => call.result).filter(value => value !== undefined);
    const args = withArgs?.args;
    const result = results.at(-1);
    tools.push({
      callId,
      name: named?.name || 'unknown',
      command: commandFrom(args, result),
      args,
      result,
      executables: executableCommands(args),
      outcome: mergeOutcome(calls.map(call => call.status), results),
    });
  }
  return tools;
}

export function parseRunStream(raw: unknown): ParsedRunStream {
  const entries = entriesFrom(raw);
  const runIds = new Set<string>();
  let terminalStatus: string | null = null;
  for (const entry of entries) {
    if (!isRecord(entry.data)) continue;
    if (typeof entry.data.runId === 'string') runIds.add(entry.data.runId);
    if ((entry.event === 'status' || entry.event === 'result' || entry.event === null) && typeof entry.data.status === 'string') {
      if (['FINISHED', 'ERROR', 'EXPIRED', 'CANCELLED'].includes(entry.data.status)) terminalStatus = entry.data.status;
    }
  }
  return { runIds, terminalStatus, tools: parseCompletedTools(raw) };
}

function acceptDownloadUrl(url: URL, loopback: boolean): boolean {
  if (url.username || url.password) return false;
  if (loopback && (url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK.has(url.hostname)) return true;
  return url.protocol === 'https:' && /(?:^|\.)amazonaws\.com$/.test(url.hostname);
}

export async function cursorGet(endpoint: CursorEndpoint, path: string, fetchImpl: typeof fetch, accept = 'application/json'): Promise<{ bytes: Buffer; text: string; json: unknown }> {
  if (!endpoint.apiKey) throw new Error('Cursor credential unavailable');
  const response = await fetchImpl(`${endpoint.baseUrl}/v1/${path}`, {
    headers: { Authorization: authorization(endpoint.apiKey), accept },
    redirect: 'error',
    signal: AbortSignal.timeout(60_000),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  const text = bytes.toString('utf8');
  if (!response.ok) throw new CursorHttpError(response.status, bytes);
  let json: unknown = text;
  try { json = JSON.parse(text); }
  catch { json = text; }
  return { bytes, text, json };
}

function collectionFailure(directory: string, label: string, error: unknown, originals: readonly Original[]): never {
  const retained = [...originals];
  if (error instanceof CursorHttpError) retained.push(writeSnapshot(directory, `${label}-http-${error.status}`, 'bin', error.bytes));
  const message = error instanceof Error ? error.message : 'Cursor API unavailable';
  throw new RemoteCollectionError(message, retained);
}

export async function collectRemoteEvidence(input: {
  agentId: string;
  runId: string;
  directory: string;
  endpoint?: CursorEndpoint;
  fetch?: typeof fetch;
}): Promise<CollectedRemote> {
  const endpoint = input.endpoint ?? resolveCursorEndpoint();
  const fetchImpl = input.fetch ?? fetch;
  const agentId = string(input.agentId);
  const runId = string(input.runId);
  if (!/^[A-Za-z0-9_-]+$/.test(agentId) || !/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error('Invalid Cursor run identity');
  const directory = resolve(input.directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });

  let run: Awaited<ReturnType<typeof cursorGet>>;
  try { run = await cursorGet(endpoint, `agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`, fetchImpl); }
  catch (error) { collectionFailure(directory, 'remote-run', error, []); }
  const originalRemoteRun = writeSnapshot(directory, 'remote-run', 'json', run.bytes);
  const runBody = object(run.json, 'remote run');
  if (runBody.id !== runId || runBody.agentId !== agentId) {
    throw new RemoteCollectionError('Cursor run response identity mismatch', [originalRemoteRun]);
  }
  const remoteStatus = string(runBody.status);
  const remoteResult = typeof runBody.result === 'string' && runBody.result.length > 0 ? runBody.result : null;
  const git = isRecord(runBody.git) ? runBody.git : null;
  const branch = git && Array.isArray(git.branches) && isRecord(git.branches[0]) ? git.branches[0] : null;
  const prUrl = branch && typeof branch.prUrl === 'string' ? branch.prUrl : null;
  const repoUrl = branch && typeof branch.repoUrl === 'string' ? branch.repoUrl : null;

  let originalToolStream: Original | null = null;
  let originalArtifactListing: Original | null = null;
  const downloaded: DownloadedArtifact[] = [];
  if (remoteStatus === 'FINISHED') {
    let stream: Awaited<ReturnType<typeof cursorGet>>;
    try {
      stream = await cursorGet(
        endpoint,
        `agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/stream`,
        fetchImpl,
        'text/event-stream',
      );
    } catch (error) { collectionFailure(directory, 'run-stream', error, [originalRemoteRun]); }
    originalToolStream = writeSnapshot(directory, 'run-stream', 'sse', stream.bytes);

    let listing: Awaited<ReturnType<typeof cursorGet>>;
    try { listing = await cursorGet(endpoint, `agents/${encodeURIComponent(agentId)}/artifacts`, fetchImpl); }
    catch (error) { collectionFailure(directory, 'artifacts', error, [originalRemoteRun, originalToolStream]); }
    originalArtifactListing = writeSnapshot(directory, 'artifacts', 'json', listing.bytes);
    const listed = array(object(listing.json, 'artifact listing').items).map(item => object(item, 'artifact item'));
    const downloadsDir = join(directory, 'downloads');
    mkdirSync(downloadsDir, { recursive: true, mode: 0o700 });
    for (const item of listed) {
      const path = relativePath(item.path);
      const listedBytes = integer(item.sizeBytes ?? item.bytes ?? 0);
      if (listedBytes > DOWNLOAD_LIMIT) throw new Error('Listed artifact exceeds size limit');
      const descriptor = object((await cursorGet(endpoint, `agents/${encodeURIComponent(agentId)}/artifacts/download?path=${encodeURIComponent(path)}`, fetchImpl)).json, 'artifact download');
      const url = new URL(string(descriptor.url));
      if (!acceptDownloadUrl(url, endpoint.loopback)) throw new Error('Untrusted artifact download URL');
      const bytes = await boundedBytes(await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(60_000) }), listedBytes || DOWNLOAD_LIMIT);
      if (listedBytes && bytes.length !== listedBytes) throw new Error('Downloaded artifact size differs from listing');
      const original = writeSnapshot(downloadsDir, hash(path), 'bin', bytes);
      downloaded.push({ path, bytes: bytes.length, sha256: hash(bytes), original });
    }
  }

  const collectionBytes = JSON.stringify({
    schemaVersion: 1,
    agentId,
    runId,
    remoteStatus,
    originalRemoteRun,
    originalToolStream,
    originalArtifactListing,
    downloaded,
  }, null, 2) + '\n';
  const originalCollection = writeSnapshot(directory, 'collection', 'json', collectionBytes);
  return {
    originalRemoteRun,
    originalToolStream,
    originalArtifactListing,
    originalCollection,
    remoteStatus,
    remoteResult,
    agentId,
    runId,
    prUrl,
    repoUrl,
    downloaded,
  };
}

export function listingPaths(listing: Original): Set<string> {
  const bytes = verifiedOriginalBytes(listing);
  if (!bytes) throw new Error('Artifact listing digest mismatch');
  const v = object(JSON.parse(bytes.toString('utf8')), 'artifact listing');
  return new Set(array(v.items).map(item => relativePath(object(item, 'artifact item').path)));
}
