import { array, instant, integer, object, oneOf, string } from './contract.ts';
import { api, checkRuns, statuses, type Trusted } from './github.ts';

export const unfinished = ['queued', 'in_progress', 'waiting', 'requested', 'pending'];
/** GitHub counts a required check whose latest run concluded `neutral` or `skipped` as passing (a job an `if` skipped still merges), so the arm and the daemon count them the same way. */
export const passing = ['success', 'neutral', 'skipped'];
export interface RequiredCheck { context: string; appId: number | null }
export interface ProtectedObservation { source: 'check' | 'status'; context: string; id: number; head: string; appId: number | null; state: string; completedAt: string | null }
/** GitHub requires both a check and a legacy status when they share a required name. Legacy status creator ids do not identify an app, so only a matching check can satisfy an app binding. */
export async function protectedObservations(repo: string, head: string): Promise<ProtectedObservation[]> {
  const [runs, legacy] = await Promise.all([checkRuns(repo, head), statuses(repo, head)]);
  const latest = new Map<string, ProtectedObservation>();
  for (const c of runs.sort((a, b) => b.id - a.id)) {
    const key = `check:${c.context}:${c.appId}`;
    if (c.head === head && !latest.has(key)) latest.set(key, { ...c, source: 'check' });
  }
  for (const s of legacy) {
    const context = string(s.context), key = `status:${context}`;
    if (latest.has(key)) continue;
    const state = oneOf(s.state, ['success', 'pending', 'failure', 'error']);
    const at = s.updated_at ?? s.created_at;
    latest.set(key, { source: 'status', context, id: integer(s.id), head, appId: null, state, completedAt: state === 'pending' || at === undefined || at === null ? null : instant(at, 'status completion time') });
  }
  return [...latest.values()];
}
export function protectedResult(required: RequiredCheck, observed: ProtectedObservation[]): { found: boolean; observations: ProtectedObservation[] } {
  const observations = observed.filter(c => c.context === required.context && (c.source === 'status' || required.appId === null || c.appId === required.appId));
  return { found: observations.some(c => required.appId === null || c.source === 'check'), observations };
}
async function classicChecks(t: Trusted): Promise<RequiredCheck[]> {
  const protection = object(object(await api(`repos/${t.repo}/branches/${encodeURIComponent(t.config.trunk)}`)).protection);
  const statusChecks = object(protection.required_status_checks, 'required status checks');
  const required = array(statusChecks.checks).map(v => { const c = object(v); return { context: string(c.context), appId: c.app_id === null || c.app_id === -1 ? null : integer(c.app_id) }; });
  for (const context of array(statusChecks.contexts).map(v => string(v))) if (!required.some(c => c.context === context)) required.push({ context, appId: null });
  return required;
}
/** Effective protection: classic protection plus branch rules; every contract context must be there. */
export async function requiredChecks(t: Trusted): Promise<RequiredCheck[]> {
  const required = await classicChecks(t);
  const rules = array(await api(`repos/${t.repo}/rules/branches/${encodeURIComponent(t.config.trunk)}`)).map(v => object(v));
  for (const rule of rules) if (rule.type === 'required_status_checks') {
    for (const v of array(object(rule.parameters).required_status_checks)) {
      const c = object(v);
      required.push({ context: string(c.context), appId: c.integration_id === null || c.integration_id === undefined ? null : integer(c.integration_id) });
    }
  }
  for (const context of t.config.requiredChecks) if (!required.some(c => c.context === context)) throw new Error('Branch protection missing required context: ' + context);
  return required;
}
