import { parseArgs } from 'node:util';
import { integer, object, repoName, sha } from './contract.ts';
import { pages, principal, pull, trusted, verdictStatus, type Trusted } from './github.ts';
import { arm, disarm } from './arm.ts';

export interface Swept { pr: number; head: string; outcome: 'armed' | 'disarmed' | 'dry-run' | 'skipped' | 'refused'; reason: string }
async function unarm(repo: string, pr: number, head: string, cause: string, dryRun: boolean): Promise<Swept> {
  if (dryRun) return { pr, head, outcome: 'dry-run', reason: cause + ', would disarm auto-merge' };
  const ran = await disarm(repo, pr);
  const after = await pull(repo, pr);
  if (after.state !== 'open') return { pr, head, outcome: 'refused', reason: cause + ', PR merged or closed before disarm' };
  if (after.autoMerge) return { pr, head, outcome: 'refused', reason: cause + ', auto-merge still pending after disarm' };
  return ran ? { pr, head, outcome: 'disarmed', reason: cause } : { pr, head, outcome: 'skipped', reason: cause + ', auto-merge already off' };
}
async function judge(t: Trusted, pr: number, author: number, options: { configPath?: string; dryRun: boolean }): Promise<Swept> {
  const p = await pull(t.repo, pr);
  const head = p.head;
  const result = (outcome: Swept['outcome'], reason: string): Swept => ({ pr, head, outcome, reason });
  if (p.state !== 'open') return result('skipped', 'PR is no longer open');
  if (p.base !== t.config.trunk) return result('skipped', 'base is not trunk');
  const held = p.labels.some(label => t.config.holdLabels.includes(label));
  if (held && p.autoMerge) return unarm(t.repo, pr, head, 'hold label', options.dryRun);
  if (held) return result('skipped', 'hold label');
  if (p.draft) return result('skipped', 'draft');
  const verdict = await verdictStatus(t.repo, pr, head, author);
  if (p.autoMerge) return verdict.kind === 'trusted' ? result('skipped', 'auto-merge already pending') : unarm(t.repo, pr, head, verdict.kind === 'foreign' ? verdict.reason : 'no trusted verdict on head', options.dryRun);
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
