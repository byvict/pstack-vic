import { object } from './contract.ts';

function version(value: unknown): number[] | null {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value)) return null;
  return value.split('.').map(Number);
}
function minorBump(before: unknown, after: unknown): boolean {
  const old = version(before), next = version(after);
  return old !== null && next !== null && old[0] === next[0] && (next[1] > old[1] || next[1] === old[1] && next[2] >= old[2]);
}
export function dependencyOnly(before: unknown, after: unknown, lock: boolean): boolean {
  const old = object(before), next = object(after);
  if (JSON.stringify(Object.keys(old).sort()) !== JSON.stringify(Object.keys(next).sort())) return false;
  let changed = false;
  for (const key of Object.keys(old)) {
    if (JSON.stringify(old[key]) === JSON.stringify(next[key])) continue;
    changed = true;
    if (['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].includes(key) && !lock) {
      const a = object(old[key]), b = object(next[key]);
      if (JSON.stringify(Object.keys(a).sort()) !== JSON.stringify(Object.keys(b).sort())) return false;
      for (const name of Object.keys(a)) {
        if (a[name] === b[name]) continue;
        if (typeof a[name] !== 'string' || typeof b[name] !== 'string' || !minorBump(a[name].replace(/^[~^]/, ''), b[name].replace(/^[~^]/, '')) || a[name].match(/^[~^]/)?.[0] !== b[name].match(/^[~^]/)?.[0]) return false;
      }
    } else if (key === 'packages' && lock) {
      const a = object(old[key]), b = object(next[key]);
      if (JSON.stringify(Object.keys(a).sort()) !== JSON.stringify(Object.keys(b).sort())) return false;
      for (const path of Object.keys(a)) {
        if (JSON.stringify(a[path]) === JSON.stringify(b[path])) continue;
        if (path === '') { if (!dependencyOnly(a[path], b[path], false)) return false; continue; }
        const x = object(a[path]), y = object(b[path]);
        if (!minorBump(x.version, y.version)) return false;
        for (const field of new Set([...Object.keys(x), ...Object.keys(y)])) {
          if (JSON.stringify(x[field]) === JSON.stringify(y[field])) continue;
          if (field === 'version') continue;
          if (field === 'integrity' && typeof y[field] === 'string' && /^sha512-[A-Za-z0-9+/]+=*$/.test(y[field])) continue;
          if (field === 'resolved' && typeof x[field] === 'string' && typeof y[field] === 'string' && x[field].startsWith('https://registry.npmjs.org/') && y[field].startsWith('https://registry.npmjs.org/')) continue;
          return false;
        }
      }
    } else return false;
  }
  return changed;
}
