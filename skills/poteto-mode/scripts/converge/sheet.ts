import { parseDescriptor, routeFor, type ModelMatrix } from '../../../../scripts/model-matrix.ts';

/** The lanes of one `role: lane[, lane]` row of a model sheet, as written. Title, blank lines and prose are skipped, as /setup-pstack parses them; the label must be the whole role. */
export function sheetRow(sheetText: string, role: string): string[] {
  const prefix = `${role}: `;
  const rows = sheetText.split('\n').map(line => line.trimEnd()).filter(line => line === role + ':' || line.startsWith(prefix));
  if (rows.length !== 1) throw new Error(rows.length ? `The model sheet has more than one ${role} row` : `The model sheet has no ${role} row; run /setup-pstack`);
  const lanes = rows[0].slice(prefix.length).split(',').map(s => s.trim()).filter(Boolean);
  if (!lanes.length) throw new Error(`The model sheet's ${role} row has no lane; run /setup-pstack`);
  return lanes;
}
/** Every lane the `pre-pr reviewer` row may hold on this parent: the CLI families the runner launches from it, at every selectable effort. The runner refuses the parent's native provider, and a native subagent writes no receipt. */
export function reviewerLanes(matrix: ModelMatrix, parent: string): string[] {
  return matrix.families
    .filter(f => matrix.providers[f.provider].transport === 'cli' && routeFor(matrix, parent, f.provider) === 'runner')
    .flatMap(f => f.efforts.map(effort => `${f.provider}:${f.model}@${effort}`));
}
/** The row's rule: one or more lanes from `reviewerLanes`, in order of preference, no two of one family. Throws the message /setup-pstack shows. */
export function checkReviewerRow(lanes: readonly string[], matrix: ModelMatrix, parent: string): void {
  const allowed = reviewerLanes(matrix, parent);
  const problem = new Error(`role "pre-pr reviewer" takes one or more lanes of distinct families, each one of ${allowed.join(' or ')}; got ${lanes.join(', ')}`);
  if (!lanes.length || lanes.some(lane => !allowed.includes(lane))) throw problem;
  const providers = lanes.map(lane => parseDescriptor(lane)?.provider);
  if (new Set(providers).size !== providers.length) throw problem;
}
