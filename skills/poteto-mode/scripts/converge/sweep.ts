import { parseArgs } from 'node:util';
import { array, integer, object, repoName, sha, string } from './contract.ts';
import { pages, principal, trusted, verdictStatus } from './github.ts';
import { arm, disarm } from './arm.ts';

export interface Swept { pr: number; head: string; outcome: 'armed' | 'disarmed' | 'dry-run' | 'skipped' | 'refused'; reason: string }
export async function sweep(options: { repo: string; configPath?: string; dryRun: boolean }): Promise<{ swept: Swept[] }> {
  const repo = repoName(options.repo);
  const t = await trusted(repo, options.configPath ?? '.cursor/converge.json');
  const author = await principal();
  const open = (await pages(`repos/${repo}/pulls?state=open&base=${encodeURIComponent(t.config.trunk)}`)).map(v => object(v));
  const swept: Swept[] = [];
  for (const p of open.sort((a, b) => integer(a.number) - integer(b.number))) {
    const pr = integer(p.number);
    const head = sha(object(p.head).sha);
    const skip = (reason: string) => swept.push({ pr, head, outcome: 'skipped', reason });
    if (string(object(p.base).ref) !== t.config.trunk) { skip('base is not trunk'); continue; }
    const held = array(p.labels).some(l => t.config.holdLabels.includes(string(object(l).name)));
    try {
      if (held && p.auto_merge !== null) {
        if (options.dryRun) swept.push({ pr, head, outcome: 'dry-run', reason: 'hold label, would disarm auto-merge' });
        else { await disarm(repo, pr); swept.push({ pr, head, outcome: 'disarmed', reason: 'hold label' }); }
        continue;
      }
      if (held) { skip('hold label'); continue; }
      if (p.draft === true) { skip('draft'); continue; }
      if (p.auto_merge !== null) { skip('auto-merge already pending'); continue; }
      const verdict = await verdictStatus(repo, pr, head, author);
      if (verdict.kind === 'none') { skip('no trusted verdict on head'); continue; }
      if (verdict.kind === 'foreign') { swept.push({ pr, head, outcome: 'refused', reason: verdict.refusal }); continue; }
      const result = await arm({ repo, pr, head, verdict: 'VERIFIED', dryRun: options.dryRun, configPath: options.configPath, pending: true });
      swept.push({ pr, head, outcome: result.kind, reason: '' });
    } catch (error) { swept.push({ pr, head, outcome: 'refused', reason: error instanceof Error ? error.message : 'Arm failed' }); }
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
