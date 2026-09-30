#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const args = Object.fromEntries(process.argv.slice(2).flatMap((arg, i, all) => arg.startsWith('--') ? [[arg.slice(2), all[i + 1]]] : []));
const plan = JSON.parse(readFileSync(process.env.FAKE_RUNNER, 'utf8'));
const lane = dirname(resolve(args.prompt));
const manifest = JSON.parse(readFileSync(join(lane, 'manifest.json'), 'utf8'));
const run = dirname(dirname(lane));
const attempt = existsSync(join(run, 'attempts')) ? readdirSync(join(run, 'attempts')).filter(name => name.startsWith(manifest.laneId + '-')).length : 0;
const status = plan.statuses?.[manifest.laneId]?.[attempt] ?? 'complete';
const startedAt = new Date().toISOString();
const lease = plan.lease && existsSync(plan.lease) ? JSON.parse(readFileSync(plan.lease, 'utf8')) : null;
appendFileSync(plan.log, JSON.stringify({ lane: manifest.laneId, event: 'start', at: Date.now(), argv: process.argv.slice(2), leaseExpiresAt: lease?.expiresAt ?? null, leaseBy: lease?.by ?? null }) + '\n');
await new Promise(done => setTimeout(done, plan.delays?.[manifest.laneId] ?? 0));
if (plan.dirty?.[manifest.laneId]?.includes(attempt)) writeFileSync(join(args.cwd, 'left-behind.txt'), 'left behind\n');
const git = (...command) => spawnSync('git', ['-C', args.cwd, ...command], { encoding: 'utf8' }).stdout;
const round = manifest.round;
const certifier = manifest.role === 'pre-pr certifier';
const artifacts = [];
const coverage = [];
if (certifier && status === 'complete') {
  const prefix = `artifacts/converge/${round.id}/${manifest.laneId}/`;
  mkdirSync(join(lane, prefix), { recursive: true });
  const write = (id, name, bytes, mediaType) => { writeFileSync(join(lane, prefix, name), bytes); artifacts.push({ id, path: prefix + name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), mediaType }); };
  write('screen', 'screen.png', readFileSync(new URL('../../../../../assets/logo.png', import.meta.url)), 'image/png');
  const report = JSON.parse(readFileSync(join(run, 'report.json'), 'utf8'));
  for (const feature of report.touchedFeatures) {
    write(feature.id, `${feature.id}.json`, Buffer.from(JSON.stringify({ entry: 'Entrar', feature: feature.id })), 'application/json');
    coverage.push({ featureId: feature.id, entryPoint: 'Entrar', result: 'driven', artifactIds: ['screen', feature.id] });
  }
}
if (status === 'complete') writeFileSync(resolve(args.output), JSON.stringify({ schemaVersion: 1, round: round.id, laneId: manifest.laneId, role: manifest.role, observedHead: round.head, observedContract: round.contract, kind: 'complete', findings: plan.findings?.[manifest.laneId] ?? [], artifacts, coverage, riskProofs: [] }));
const checkout = args.mode === 'unsandboxed' ? { headBefore: git('rev-parse', 'HEAD').trim(), headAfter: git('rev-parse', 'HEAD').trim(), statusAfter: git('status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean) } : null;
writeFileSync(resolve(args.receipt), JSON.stringify({ schemaVersion: 1, status, parent: args.parent, provider: args.provider, model: args.model, effort: args.effort, mode: args.mode, cwd: args.cwd, checkout, promptPath: resolve(args.prompt), outputPath: resolve(args.output), startedAt, completedAt: new Date().toISOString(), modelVerified: true, modelEvidence: 'provider-report', reportedModel: `${args.model}-build`, remote: null, exitCode: status === 'complete' ? 0 : 1, signal: null }));
appendFileSync(plan.log, JSON.stringify({ lane: manifest.laneId, event: 'end', at: Date.now(), status }) + '\n');
process.exitCode = status === 'complete' ? 0 : 1;
