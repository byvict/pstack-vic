import { parseArgs } from 'node:util';
import { integer, object, repoName, sha } from './contract.ts';
import { pages, principal, pull, RequestError, trusted, verdictStatus, type Trusted } from './github.ts';
import { verdictGate, type Gate } from './gate.ts';
import { arm, disarm } from './arm.ts';

export interface Swept { pr: number; head: string; outcome: 'armed' | 'disarmed' | 'dry-run' | 'skipped' | 'refused'; reason: string }
const disarmed = { 'would disarm': 'would disarm auto-merge', disarmed: 'auto-merge disarmed', 'already off': 'auto-merge already off', closed: 'PR merged or closed before disarm', 'still armed': 'auto-merge still pending after disarm' } as const;
async function observedDisarm(repo: string, pr: number, dryRun: boolean): Promise<keyof typeof disarmed> {
  if (dryRun) return 'would disarm';
  let ran = false;
  try { ran = await disarm(repo, pr); }
  catch (error) { if (!(error instanceof RequestError)) throw error; }
  const after = await pull(repo, pr);
  if (after.state !== 'open') return 'closed';
  if (after.autoMerge) return 'still armed';
  return ran ? 'disarmed' : 'already off';
}
async function judge(t: Trusted, pr: number, author: number, options: { configPath?: string; dryRun: boolean }): Promise<Swept> {
  const p = await pull(t.repo, pr);
  const head = p.head;
  const result = (outcome: Swept['outcome'], reason: string): Swept => ({ pr, head, outcome, reason });
  if (p.state !== 'open') return result('skipped', 'PR is no longer open');
  if (p.base !== t.config.trunk) return result('skipped', 'base is not trunk');
  const held = p.labels.some(label => t.config.holdLabels.includes(label));
  if (held && p.autoMerge) {
    const done = await observedDisarm(t.repo, pr, options.dryRun);
    const outcome = ({ 'would disarm': 'dry-run', disarmed: 'disarmed', 'already off': 'skipped', closed: 'refused', 'still armed': 'refused' } as const)[done];
    return result(outcome, done === 'disarmed' ? 'hold label' : 'hold label, ' + disarmed[done]);
  }
  if (held) return result('skipped', 'hold label');
  if (p.autoMerge) {
    const gate = await verdictGate(t, pr, head, author).catch((error: unknown): Gate => ({ kind: 'refused', reason: error instanceof Error ? error.message : 'Verdict gate failed' }));
    if (gate.kind === 'certified') return result('skipped', 'auto-merge already pending');
    return result('refused', gate.reason + ', ' + disarmed[await observedDisarm(t.repo, pr, options.dryRun)]);
  }
  if (p.draft) return result('skipped', 'draft');
  const verdict = await verdictStatus(t.repo, pr, head, author);
  if (verdict.kind === 'none') return result('skipped', 'no trusted verdict on head');
  if (verdict.kind === 'foreign') return result('refused', verdict.reason);
  const armed = await arm({ repo: t.repo, pr, head, verdict: 'VERIFIED', dryRun: options.dryRun, configPath: options.configPath, pending: true });
  return result(armed.kind, armed.rederived ?? '');
}
export async function sweep(options: { repo: string; configPath?: string; dryRun: boolean }): Promise<{ swept: Swept[] }> {
  const t = await trusted(repoName(options.repo), options.configPath ?? '.cursor/converge.json');
  const author = await principal();
  const open = (await pages(`repos/${t.repo}/pulls?state=open&base=${encodeURIComponent(t.config.trunk)}`)).map(v => object(v));
  const swept: Swept[] = [];
  for (const listed of open.sort((a, b) => integer(a.number) - integer(b.number))) {
    const pr = integer(listed.number);
    try { swept.push(await judge(t, pr, author, options)); }
    catch (error) { swept.push({ pr, head: sha(object(listed.head).sha), outcome: 'refused', reason: error instanceof Error ? error.message : 'Sweep failed' }); }
  }
  return { swept };
}
export async function main(args: string[]): Promise<number> {
  try {
    const { values } = parseArgs({ args, options: { repo: { type: 'string' }, config: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } } });
    if (!values.repo) throw new Error('Usage: converge-sweep --repo owner/repo [--config path] [--dry-run]');
    const result = await sweep({ repo: values.repo, configPath: values.config, dryRun: values['dry-run'] });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return result.swept.some(s => s.outcome === 'refused') ? 1 : 0;
  } catch (error) { process.stderr.write((error instanceof Error ? error.message : 'Sweep failed') + '\n'); return 1; }
}
