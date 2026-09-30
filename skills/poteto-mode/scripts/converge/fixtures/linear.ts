import type { Dossier } from '../contract.ts';
import { head, trunk } from './setup.ts';
import type { LinearMerge } from '../local/linear-trust.ts';
import { linearTarget } from '../linear-targets.ts';

export const issueUrl = 'https://linear.app/example/issue/ENG-1/test';
export function dossier(): Dossier {
  return { schemaVersion: 1, round: { id: '11111111-1111-4111-8111-111111111111', repo: 'Example/app', pr: 1, head, contract: trunk, base: trunk, patch_id: head, verificationDigest: 'd'.repeat(64), inputDigest: 'e'.repeat(64), configPath: '.cursor/converge.json', execution: 'converge' }, decision: { verdict: 'VERIFIED', displayResult: 'VERIFIED', findings: [], reasons: [] }, evidenceDigest: 'f'.repeat(64), reconcileDigest: 'a'.repeat(64), coverage: [], riskAdjudication: [], artifactIds: [], inputFingerprint: 'b'.repeat(64), retainedFrom: null, certificate: null };
}
export function merge(): LinearMerge { return { repo: 'Example/app', pr: 1, commit: trunk, head, verdictUrl: 'https://github.com/Example/app/pull/1#issuecomment-100', dossier: dossier(), targets: [linearTarget(issueUrl)] }; }
