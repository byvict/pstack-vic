import { array, digest, integer, jsonHash, object, repoName, sha, string } from '../contract.ts';
import type { LinearEffect } from './linear.ts';
import type { LinearMerge } from './linear-trust.ts';

type PlanValue = null | boolean | number | string | PlanValue[] | { [key: string]: PlanValue };
export type LinearPlanInput = { merge: Pick<LinearMerge, 'repo' | 'pr' | 'head' | 'commit'>; sourceDigest: string; effects: Pick<LinearEffect, 'key' | 'tool' | 'args'>[] };
export interface LinearPlan extends LinearPlanInput { schemaVersion: 1; digest: string }

function fields(value: unknown, expected: string, label: string): Record<string, unknown> {
  const result = object(value, label);
  if (Object.keys(result).sort().join(',') !== expected) throw new Error(`Invalid ${label} fields`);
  return result;
}
function jsonValue(value: unknown): PlanValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return array(value).map(jsonValue);
  if (value && typeof value === 'object') return jsonObject(value);
  throw new Error('Invalid Linear plan JSON value');
}
function jsonObject(value: unknown): { [key: string]: PlanValue } {
  const entries = object(value, 'Linear plan effect arguments');
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Invalid Linear plan JSON value');
  return Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, jsonValue(entry)]));
}
function planContents(value: unknown): LinearPlanInput & { schemaVersion: 1 } {
  const v = object(value, 'Linear plan'), merge = fields(v.merge, 'commit,head,pr,repo', 'Linear plan merge');
  const pr = integer(merge.pr, 'Linear plan PR');
  if (!pr) throw new Error('Invalid Linear plan PR');
  const effects = array(v.effects).map(raw => {
    const e = fields(raw, 'args,key,tool', 'Linear plan effect');
    const key = string(e.key, 'Linear plan effect key'), tool = string(e.tool, 'Linear plan effect tool');
    if (!key.trim() || !tool.trim()) throw new Error('Invalid Linear plan effect identity');
    const args = jsonObject(e.args);
    return { key, tool, args };
  }).sort((a, b) => a.key.localeCompare(b.key));
  if (new Set(effects.map(e => e.key)).size !== effects.length) throw new Error('Duplicate Linear plan effect key');
  return { schemaVersion: 1, merge: { repo: repoName(merge.repo), pr, head: sha(merge.head), commit: sha(merge.commit) }, sourceDigest: digest(v.sourceDigest), effects };
}
export function createLinearPlan(input: LinearPlanInput): LinearPlan {
  const plan = planContents(input);
  return { ...plan, digest: jsonHash(plan) };
}
export function parseLinearPlan(value: unknown): LinearPlan {
  const v = fields(value, 'digest,effects,merge,schemaVersion,sourceDigest', 'Linear plan');
  if (v.schemaVersion !== 1) throw new Error('Unknown Linear plan schema');
  const plan = planContents(v), claimed = digest(v.digest);
  if (claimed !== jsonHash(plan)) throw new Error('Linear plan digest does not match its contents');
  return { ...plan, digest: claimed };
}
export function assertLinearPlan(reviewed: LinearPlan, current: LinearPlan): void {
  if (jsonHash(reviewed.merge) !== jsonHash(current.merge)) throw new Error('Linear merge changed; generate and review a new plan');
  if (reviewed.sourceDigest !== current.sourceDigest) throw new Error('Linear sources changed; generate and review a new plan');
  if (jsonHash(reviewed.effects) !== jsonHash(current.effects)) throw new Error('Linear effects changed; generate and review a new plan');
}
