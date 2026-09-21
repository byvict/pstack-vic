import { relativePath } from './contract.ts';

export type TestEvidence = { kind: 'unavailable' } | { kind: 'complete'; runId: number; attempt: number; jobId: number; paths: string[] };
export function parseClinextTests(log: string, identity: { runId: number; attempt: number; jobId: number }): TestEvidence {
  const lines = log.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split('\n').flatMap(line => {
    const match = line.match(/^Server \(gates \+ suite\)\tRun tests\t\d{4}-\d\d-\d\dT[\d:.]+Z\s(.*)$/);
    return match ? [match[1] ?? ''] : [];
  });
  const headers = lines.filter(line => /^Clinext test runner\s+[—-]\s+\d+ arquivo\(s\),/.test(line));
  const footers = lines.filter(line => /^Resultado: \d+ passed, 0 failed, [\d.]+(?:ms|s) total\s*$/.test(line));
  if (headers.length !== 1 || footers.length !== 1) return { kind: 'unavailable' };
  const expected = Number(headers[0]?.match(/(\d+) arquivo/)?.[1]);
  const completed = Number(footers[0]?.match(/Resultado: (\d+)/)?.[1]);
  const paths = lines.flatMap(line => { const match = line.match(/^\s+PASS\s+([^\s]+\.test\.[cm]?js)\s+[\d.]+(?:ms|s)\s*$/); return match ? [relativePath(match[1])] : []; });
  if (!expected || expected !== completed || paths.length !== expected || new Set(paths).size !== expected) return { kind: 'unavailable' };
  return { kind: 'complete', ...identity, paths: paths.sort() };
}
