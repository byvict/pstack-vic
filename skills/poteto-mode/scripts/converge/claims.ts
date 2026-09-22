import { relativePath } from './contract.ts';

export type TestEvidence = { kind: 'unavailable' } | { kind: 'complete'; runId: number; attempt: number; jobId: number; paths: string[] };
export interface StepWindow { startedSecond: number; completedSecond: number }
export interface ClinextProvenance { runId: number; attempt: number; jobId: number; tests: StepWindow; next: StepWindow | null }
interface LogRecord { label: string; second: number; order: string; text: string; timed: boolean }
type Census = { kind: 'before' } | { kind: 'reading'; expected: number; paths: Set<string> } | { kind: 'finished'; paths: Set<string> };
const censusLike = (text: string) => /^\s*(?:Clinext test runner|PASS\b|FAIL\b|Resultado:)/.test(text);
const inWindow = (record: LogRecord, window: StepWindow) => record.second >= window.startedSecond && record.second <= window.completedSecond;

export function parseClinextTests(log: string, provenance: ClinextProvenance): TestEvidence {
  const unavailable: TestEvidence = { kind: 'unavailable' };
  const records: LogRecord[] = [];
  let leftJob = false;
  for (const line of log.replace(/(?:\x1b|\^\[)\[[0-?]*[ -/]*[@-~]/g, '').split('\n')) {
    if (!line.startsWith('Server (gates + suite)\t')) {
      if (records.length && line.trim()) leftJob = true;
      continue;
    }
    if (leftJob) return unavailable;
    const previous = records.at(-1);
    const match = line.match(/^Server \(gates \+ suite\)\t([^\t]+)\t\uFEFF?(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z (.*)$/);
    if (!match) {
      const continuation = line.match(/^Server \(gates \+ suite\)\t([^\t]+)\t(.*)$/);
      if (!previous || !continuation || censusLike(continuation[2]) || /##\[|^\d{4}-/.test(continuation[2])) return unavailable;
      records.push({ ...previous, label: continuation[1], text: continuation[2], timed: false });
      continue;
    }
    const second = Date.parse(match[2] + 'Z') / 1000;
    if (!Number.isFinite(second) || new Date(second * 1000).toISOString().slice(0, 19) !== match[2]) return unavailable;
    const record = { label: match[1], second, order: match[2] + '.' + (match[3] ?? '').padEnd(9, '0'), text: match[4], timed: true };
    if (previous && previous.order > record.order) return unavailable;
    records.push(record);
  }
  const headers = records.filter(r => /^\s*Clinext test runner/.test(r.text));
  if (headers.length !== 1) return unavailable;
  const header = headers[0];
  if (!inWindow(header, provenance.tests)) return unavailable;
  let selected: LogRecord[];
  if (header.label === 'UNKNOWN STEP') {
    const starts = records.flatMap((r, i) => r.text === '##[group]Run npm test' ? [i] : []);
    if (starts.length !== 1 || !provenance.next) return unavailable;
    const start = starts[0];
    const end = records.findIndex((r, i) => i > start && r.text.startsWith('##[group]Run '));
    if (end < 0 || !['UNKNOWN STEP', 'Run tests'].includes(records[start].label) || records[end].label === 'Run tests' || records[start].second !== provenance.tests.startedSecond || records[end].second !== provenance.next.startedSecond || !inWindow(records[end], provenance.next)) return unavailable;
    selected = records.slice(start + 1, end);
    if (!selected.includes(header) || !selected.some(r => censusLike(r.text) && r.second > provenance.tests.startedSecond && r.second < provenance.tests.completedSecond)) return unavailable;
    if (selected.some(r => !r.timed || !['UNKNOWN STEP', 'Run tests'].includes(r.label) || !inWindow(r, provenance.tests))) return unavailable;
    const preamble = selected.slice(0, selected.indexOf(header)).map(r => r.text);
    const command = preamble.indexOf('npm test');
    const shell = preamble.findIndex(line => line.startsWith('shell: '));
    const endGroup = preamble.indexOf('##[endgroup]');
    const runner = preamble.indexOf('> node tools/run-all-tests.js');
    if (command < 0 || shell <= command || endGroup <= shell || runner <= endGroup) return unavailable;
  } else if (header.label === 'Run tests') {
    selected = records.filter(r => r.label === 'Run tests');
    if (selected.some(r => !r.timed || !inWindow(r, provenance.tests))) return unavailable;
    if (records.slice(records.indexOf(selected[0]), records.indexOf(selected[selected.length - 1]) + 1).some(r => r.label !== 'Run tests')) return unavailable;
    const frames = selected.filter(r => r.text.startsWith('##[group]Run '));
    if (frames.length > 1 || frames.some(r => r.text !== '##[group]Run npm test')) return unavailable;
  } else return unavailable;
  if (records.some(r => censusLike(r.text) && !selected.includes(r))) return unavailable;
  let census: Census = { kind: 'before' };
  for (const record of selected) {
    const text = record.text;
    if (!censusLike(text)) {
      if (census.kind === 'reading' && text.trim() && !/^\d+ sensível\(is\) a timing rodam numa fase final sem concorrência$/.test(text)) return unavailable;
      if (census.kind !== 'before' && text.startsWith('##[group]Run ')) return unavailable;
      continue;
    }
    const headerMatch = text.match(/^Clinext test runner\s+[—-]\s+(\d+) arquivo\(s\),/);
    if (headerMatch) {
      const expected = Number(headerMatch[1]);
      if (census.kind !== 'before' || !Number.isSafeInteger(expected) || expected <= 0) return unavailable;
      census = { kind: 'reading', expected, paths: new Set() };
      continue;
    }
    if (census.kind !== 'reading') return unavailable;
    const pass = text.match(/^\s+PASS\s+([^\s]+\.test\.[cm]?js)\s+\d+(?:\.\d+)?(?:ms|s)\s*$/);
    if (pass) {
      let path: string;
      try { path = relativePath(pass[1]); } catch { return unavailable; }
      if (census.paths.has(path) || census.paths.size >= census.expected) return unavailable;
      census.paths.add(path);
      continue;
    }
    const footer = text.match(/^Resultado: (\d+) passed, 0 failed, \d+(?:\.\d+)?(?:ms|s) total\s*$/);
    if (!footer || Number(footer[1]) !== census.expected || census.paths.size !== census.expected) return unavailable;
    census = { kind: 'finished', paths: census.paths };
  }
  return census.kind === 'finished' ? { kind: 'complete', runId: provenance.runId, attempt: provenance.attempt, jobId: provenance.jobId, paths: [...census.paths].sort() } : unavailable;
}
