import { string } from './contract.ts';

export interface LinearTarget { kind: 'issue' | 'project'; url: string; workspace: string; key: string }

export function linearTarget(value: unknown): LinearTarget {
  const literal = string(value, 'Linear URL');
  if (/\s/.test(literal)) throw new Error('Expected a full Linear URL without whitespace');
  const url = new URL(literal);
  if (url.protocol !== 'https:' || url.hostname !== 'linear.app' || url.port || url.username || url.password || url.search || url.hash) throw new Error('Expected a full Linear issue or project URL');
  const issue = /^\/([^/]+)\/issue\/([A-Z][A-Z0-9]*-\d+)(?:\/[^/]+)?\/?$/.exec(url.pathname);
  const project = /^\/([^/]+)\/project\/([^/]+)(?:\/overview)?\/?$/.exec(url.pathname);
  if (issue) return { kind: 'issue', url: url.href.replace(/\/$/, ''), workspace: issue[1], key: issue[2] };
  if (project) return { kind: 'project', url: url.href.replace(/\/overview\/?$/, '').replace(/\/$/, ''), workspace: project[1], key: project[2] };
  throw new Error('Expected a full Linear issue or project URL');
}
export function targetIdentity(target: LinearTarget): string { return `${target.workspace}:${target.kind}:${target.key}`; }

/** Refs live in the immutable trailer paragraph of commits, never the editable PR text. */
export function linearTargets(messages: string[]): LinearTarget[] {
  const targets = new Map<string, LinearTarget>();
  for (const message of messages) {
    const paragraphs = message.replace(/\r\n/g, '\n').trimEnd().split(/\n{2,}/);
    const last = paragraphs.length > 1 ? (paragraphs.at(-1) ?? '').split('\n') : [];
    const block = last.every(line => /^[A-Za-z][A-Za-z0-9-]*: \S/.test(line)) ? last : [];
    const outside = (block.length ? paragraphs.slice(0, -1) : paragraphs).flatMap(part => part.split('\n'));
    if (outside.some(line => /^\s*pstack-linear(?=\s|:|=|$)/i.test(line))) throw new Error('Pstack-Linear must be a full URL in the final commit trailer paragraph');
    for (const line of block.filter(line => /^pstack-linear:/i.test(line))) {
      const target = linearTarget(line.slice(line.indexOf(':') + 1).trim());
      targets.set(targetIdentity(target), target);
    }
  }
  return [...targets.values()];
}
