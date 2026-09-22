import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { type Role } from '../contract.ts';
import { judgeCorpus, rejectWorkLabel as rejectJudgeLabel } from './judge-check.ts';
import { parseEnvelope, parseTurnClosure, renderSuite, runProof, type ProofServices, type RunBoundary, type SuiteSummary, type TurnClosure } from './run.ts';
import { formatUsd } from './usage.ts';

function fail(message: string): never {
  throw new Error(message);
}

function rolesFrom(values: { verifier?: string; reviewer?: string }): Record<Role, string> {
  if (!values.verifier || !values.reviewer) fail('Usage requires --verifier and --reviewer descriptors resolved by the parent');
  return { 'pr verifier': values.verifier, 'pr reviewer': values.reviewer };
}

export function printBoundary(boundary: RunBoundary): number {
  if (boundary.kind === 'end-turn') {
    process.stdout.write(JSON.stringify({ kind: 'end-turn', continuation: boundary.continuation, publication: boundary.publication, exitCode: 20 }, null, 2) + '\n');
    return 20;
  }
  if (boundary.kind === 'blocked') {
    process.stderr.write(boundary.reason + '\n');
    process.stdout.write(JSON.stringify({ kind: 'blocked', continuation: boundary.continuation, reason: boundary.reason, retainedEvidence: boundary.retainedEvidence }, null, 2) + '\n');
    return 1;
  }
  const summary: SuiteSummary = boundary.summary;
  process.stdout.write(renderSuite(summary));
  const failed = !summary.completePass || summary.entries.some(entry => !entry.ok || !entry.completePass) || summary.resources !== 'all-owned-resources-closed'
    || summary.costs.perFullPass.some(pass => pass.cost.kind === 'unavailable' || (pass.cost.kind === 'known' && pass.cost.equivalentNanoUSD >= 500_000_000n));
  return failed ? 1 : 0;
}

function closureForResume(runFile: string, afterTurn?: string): TurnClosure | undefined {
  const envelope = parseEnvelope(JSON.parse(readFileSync(runFile, 'utf8')));
  if (!afterTurn) return undefined;
  if (envelope.phase.kind !== 'awaiting-turn-close') fail('Turn closure cannot authorize a newly attempted publication');
  const raw = JSON.parse(readFileSync(afterTurn, 'utf8'));
  return parseTurnClosure(raw, { ownerId: envelope.ownerId, boundaryId: envelope.phase.publication.boundaryId, publicationDigest: envelope.phase.publication.digest });
}

async function runMain(args: string[], services?: ProofServices): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      repo: { type: 'string' },
      'work-root': { type: 'string' },
      evidence: { type: 'string' },
      'pool-observation': { type: 'string' },
      verifier: { type: 'string' },
      reviewer: { type: 'string' },
      resume: { type: 'string' },
      'after-turn': { type: 'string' },
      catalog: { type: 'string' },
      'owner-id': { type: 'string' },
      parent: { type: 'string' },
      'repository-epoch': { type: 'string' },
    },
  });
  if (!values['pool-observation']) fail('Usage: converge-proof run --pool-observation <file> ...');
  if (values.resume) {
    const boundary = await runProof({
      kind: 'resume',
      runFile: values.resume,
      pool: values['pool-observation'],
      turnClosure: closureForResume(values.resume, values['after-turn']),
      services,
    });
    return printBoundary(boundary);
  }
  if (!values.repo || !values['work-root'] || !values.evidence || !values.parent || !values['repository-epoch']) fail('Usage: converge-proof run --repo owner/name --work-root dir --evidence dir --pool-observation file --repository-epoch file --parent claude|codex --verifier desc --reviewer desc');
  if (values.parent !== 'claude' && values.parent !== 'codex') fail('Usage requires --parent claude|codex');
  const boundary = await runProof({
    kind: 'start',
    repo: values.repo,
    workRoot: values['work-root'],
    evidenceRoot: values.evidence,
    parent: values.parent,
    repositoryEpoch: values['repository-epoch'],
    roles: rolesFrom(values),
    pool: values['pool-observation'],
    ownerId: values['owner-id'],
    catalog: values.catalog,
    services,
  });
  return printBoundary(boundary);
}

function printRecall(boundary: Awaited<ReturnType<typeof judgeCorpus>>): number {
  if (boundary.kind === 'blocked') {
    process.stderr.write(boundary.reason + '\n');
    process.stdout.write(JSON.stringify({
      kind: 'blocked', continuation: boundary.continuation, reason: boundary.reason,
      launchedAttempts: boundary.summary.launchedAttempts,
    }, null, 2) + '\n');
    return 1;
  }
  const summary = boundary.summary;
  const verifier = summary.roles['pr verifier'];
  const reviewer = summary.roles['pr reviewer'];
  const cost = summary.costs.historicalRoles;
  process.stdout.write(`pr verifier recall ${verifier.hits}/${verifier.denominator}\n`);
  process.stdout.write(`pr reviewer recall ${reviewer.hits}/${reviewer.denominator}\n`);
  process.stdout.write(cost.kind === 'known' ? `historical-roles: ${formatUsd(cost.equivalentNanoUSD)} USD\n` : `historical-roles: unavailable (${cost.reason})\n`);
  const pass = verifier.hits >= 10 && reviewer.hits >= 12 && cost.kind === 'known';
  return pass ? 0 : 1;
}

async function judgeMain(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      repo: { type: 'string' },
      corpus: { type: 'string' },
      revisions: { type: 'string' },
      'work-root': { type: 'string' },
      evidence: { type: 'string' },
      'pool-observation': { type: 'string' },
      verifier: { type: 'string' },
      reviewer: { type: 'string' },
      'carrier-head': { type: 'string' },
      'carrier-pr': { type: 'string' },
      parent: { type: 'string' },
      resume: { type: 'string' },
    },
  });
  if (!values['pool-observation']) fail('Usage: converge-proof judge --pool-observation <file> ...');
  if (values.resume) {
    return printRecall(await judgeCorpus({
      resume: values.resume,
      pool: values['pool-observation'],
      corpus: values.corpus,
      revisions: values.revisions,
    }));
  }
  if (!values.repo || !values['work-root'] || !values.evidence || !values['carrier-head'] || !values['carrier-pr'] || !values.parent) {
    fail('Usage: converge-proof judge --repo owner/name --work-root dir --evidence dir --pool-observation file --carrier-pr n --carrier-head sha --parent claude|codex --verifier desc --reviewer desc');
  }
  if (values.parent !== 'claude' && values.parent !== 'codex') fail('Usage requires --parent claude|codex');
  const carrierPr = Number(values['carrier-pr']);
  if (!Number.isSafeInteger(carrierPr) || carrierPr <= 0) fail('--carrier-pr must be a positive integer');
  rejectJudgeLabel(values['work-root']);
  rejectJudgeLabel(values.evidence);
  return printRecall(await judgeCorpus({
    repo: values.repo,
    corpus: values.corpus,
    revisions: values.revisions,
    workRoot: values['work-root'],
    evidenceRoot: values.evidence,
    roles: rolesFrom(values),
    pool: values['pool-observation'],
    carrierHead: values['carrier-head'],
    carrierPr,
    parent: values.parent,
  }));
}

export async function main(args: string[], services?: ProofServices): Promise<number> {
  try {
    const command = args[0];
    if (command === 'run') return await runMain(args.slice(1), services);
    if (command === 'judge') return await judgeMain(args.slice(1));
    process.stderr.write('Usage: converge-proof run|judge ...\n');
    return 1;
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : 'Proof command failed') + '\n');
    return 1;
  }
}
