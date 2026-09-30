import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { object, relativePath, repoName, sha } from './contract.ts';
import { api, branchCommits } from './github.ts';
import { linearTargets, type LinearTarget } from './linear-targets.ts';

function overrides(body: string): Set<string> {
  const keys = new Set<string>();
  const text = body.replace(/\r\n/g, '\n').replace(/<!--[\s\S]*?(?:-->|$)/g, '').replace(/<(pre|code)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '');
  let fence: { marker: string; length: number } | null = null;
  let quote = false, inline = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) { quote = false; continue; }
    if (/^ {0,3}>/.test(line)) quote = true;
    if (quote) continue;
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (delimiter && delimiter[1][0] === fence.marker && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = null;
      continue;
    }
    if (delimiter) { fence = { marker: delimiter[1][0], length: delimiter[1].length }; continue; }
    if (!inline) {
      const directive = /^(?:ignore|skip)[ \t]+([A-Z][A-Z0-9]*-\d+)[ \t]*$/i.exec(line);
      if (directive) keys.add(directive[1].toUpperCase());
    }
    for (const ticks of line.matchAll(/`+/g)) {
      if (!inline) inline = ticks[0].length;
      else if (inline === ticks[0].length) inline = 0;
    }
  }
  return keys;
}
function missing(options: { body: string; targets: LinearTarget[] }): string[] {
  const present = overrides(options.body);
  return [...new Set(options.targets.filter(t => t.kind === 'issue').map(t => t.key))].filter(key => !present.has(key));
}
export function requireLinearPrBody(options: { body: string; targets: LinearTarget[] }): void {
  const keys = missing(options);
  if (keys.length) throw new Error('PR body requires a plain Ignore or skip directive for each Linear issue target: ' + keys.join(', '));
}
export function prepareLinearPrBody(options: { body: string; targets: LinearTarget[] }): string {
  const keys = missing(options);
  if (!keys.length) return options.body;
  const body = [options.body.trimEnd(), '', ...keys.map(key => `Ignore ${key}`), ''].join('\n');
  requireLinearPrBody({ body, targets: options.targets });
  return body;
}
export async function main(args: string[]): Promise<number> {
  try {
    const { values } = parseArgs({ args, options: { repo: { type: 'string' }, head: { type: 'string' }, 'body-file': { type: 'string' }, check: { type: 'boolean', default: false } } });
    if (!values.repo || !values.head || !values['body-file']) throw new Error('Usage: converge-pr-body --repo owner/repo --head SHA --body-file PATH [--check]');
    const repo = repoName(values.repo), head = sha(values.head), file = values['body-file'];
    const trunk = relativePath(object(await api(`repos/${repo}`)).default_branch);
    const base = sha(object(await api(`repos/${repo}/commits/${encodeURIComponent(trunk)}`)).sha);
    const targets = linearTargets((await branchCommits(repo, base, head)).map(c => c.message));
    const before = readFileSync(file, 'utf8');
    const body = values.check ? before : prepareLinearPrBody({ body: before, targets });
    requireLinearPrBody({ body, targets });
    if (body !== before) writeFileSync(file, body);
    process.stdout.write(JSON.stringify({ repo, head, bodyFile: file, issueKeys: [...new Set(targets.filter(t => t.kind === 'issue').map(t => t.key))], changed: body !== before }) + '\n');
    return 0;
  } catch (error) { process.stderr.write((error instanceof Error ? error.message : 'PR body preparation failed') + '\n'); return 1; }
}
