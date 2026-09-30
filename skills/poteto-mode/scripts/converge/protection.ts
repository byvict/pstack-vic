import { array, integer, object, string } from './contract.ts';
import { api, type Trusted } from './github.ts';

export const unfinished = ['queued', 'in_progress', 'waiting', 'requested', 'pending'];
/** GitHub counts a required check whose latest run concluded `neutral` or `skipped` as passing (a job an `if` skipped still merges), so the arm and the daemon count them the same way. */
export const passing = ['success', 'neutral', 'skipped'];
export interface RequiredCheck { context: string; appId: number | null }
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
