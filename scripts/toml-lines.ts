// Line-level TOML edits for the few settings pstack.ts writes and removes in a host's config.toml. The file is
// never re-serialized: a line is replaced, inserted or cut, and every other byte stays, comments and line endings
// included. A setting written in a form these functions do not edit (a dotted key, an inline table, a key the
// file defines twice) is reported as `unsupported`, so the caller leaves it alone instead of guessing.

/** The lines of a file, each without its line ending, and the ending the file uses. */
export interface Lines { lines: string[]; readonly eol: '\n' | '\r\n'; finalEol: boolean }

export function splitLines(text: string): Lines {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const finalEol = text.endsWith('\n');
  const body = finalEol ? text.slice(0, text.endsWith('\r\n') ? -2 : -1) : text;
  return { lines: text === '' ? [] : body.split(/\r?\n/), eol, finalEol };
}
export function joinLines({ lines, eol, finalEol }: Lines): string {
  return lines.length === 0 ? '' : lines.join(eol) + (finalEol ? eol : '');
}

// --- Keys --------------------------------------------------------------------------

/** Reads a dotted key at `from`: bare parts, "basic" and 'literal' quoted parts. Returns the decoded parts and where the key ends, or null when no key starts there. */
function readKey(line: string, from: number): { parts: string[]; end: number } | null {
  const parts: string[] = [];
  let i = from;
  for (;;) {
    while (line[i] === ' ' || line[i] === '\t') i++;
    if (line[i] === '"') {
      let value = '';
      i++;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === '\\') {
          const next = line[i + 1];
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next ?? '';
          i += 2;
        } else value += line[i++];
      }
      if (line[i] !== '"') return null;
      i++;
      parts.push(value);
    } else if (line[i] === "'") {
      const close = line.indexOf("'", i + 1);
      if (close < 0) return null;
      parts.push(line.slice(i + 1, close));
      i = close + 1;
    } else {
      const bare = /^[A-Za-z0-9_-]+/.exec(line.slice(i));
      if (!bare) return null;
      parts.push(bare[0]);
      i += bare[0].length;
    }
    while (line[i] === ' ' || line[i] === '\t') i++;
    if (line[i] !== '.') return { parts, end: i };
    i++;
  }
}
/** One key path as text, each part quoted when it is not a bare key, so `plugins."pstack@pstack-vic"` reads the same however the file spells it. */
export function keyPath(parts: readonly string[]): string {
  return parts.map(part => /^[A-Za-z0-9_-]+$/.test(part) ? part : JSON.stringify(part)).join('.');
}
function restIsComment(line: string, from: number): boolean {
  const rest = line.slice(from).trim();
  return rest === '' || rest.startsWith('#');
}

interface Header { readonly path: string; readonly array: boolean }
function parseHeader(line: string): Header | null {
  let i = 0;
  while (line[i] === ' ' || line[i] === '\t') i++;
  if (line[i] !== '[') return null;
  const array = line[i + 1] === '[';
  const key = readKey(line, i + (array ? 2 : 1));
  if (key === null) return null;
  let end = key.end;
  if (line[end] !== ']' || (array && line[end + 1] !== ']')) return null;
  end += array ? 2 : 1;
  return restIsComment(line, end) ? { path: keyPath(key.parts), array } : null;
}

// --- What each line is ------------------------------------------------------------

/** A line's role: a table header, a `key = value` assignment that starts at depth zero, or anything else (blank, comment, the inside of a multi-line value). */
export type Role =
  | { readonly kind: 'header'; readonly path: string; readonly array: boolean }
  | { readonly kind: 'assignment'; readonly table: string; readonly key: readonly string[]; readonly valueStart: number }
  | { readonly kind: 'other' };

/** Advances the multi-line state through a value: brackets and braces outside strings, and multi-line strings. */
function scanValue(line: string, from: number, state: { depth: number; multiline: '"""' | "'''" | null }): void {
  let i = from;
  while (i < line.length) {
    if (state.multiline !== null) {
      const close = line.indexOf(state.multiline, i);
      if (close < 0) return;
      i = close + 3;
      state.multiline = null;
      continue;
    }
    const c = line[i];
    if (c === '#') return;
    if (line.startsWith('"""', i) || line.startsWith("'''", i)) { state.multiline = line.slice(i, i + 3) as '"""' | "'''"; i += 3; continue; }
    if (c === '"') { i++; while (i < line.length && line[i] !== '"') i += line[i] === '\\' ? 2 : 1; i++; continue; }
    if (c === "'") { const close = line.indexOf("'", i + 1); i = close < 0 ? line.length : close + 1; continue; }
    if (c === '[' || c === '{') state.depth++;
    if (c === ']' || c === '}') state.depth = Math.max(0, state.depth - 1);
    i++;
  }
}
export function roles(lines: readonly string[]): Role[] {
  const out: Role[] = [];
  const state = { depth: 0, multiline: null as '"""' | "'''" | null };
  let table = '';
  for (const line of lines) {
    if (state.depth === 0 && state.multiline === null) {
      const header = parseHeader(line);
      if (header !== null) { table = header.array ? `[[${header.path}]]` : header.path; out.push({ kind: 'header', ...header }); continue; }
      const key = readKey(line, 0);
      if (key !== null && line[key.end] === '=') {
        out.push({ kind: 'assignment', table, key: key.parts, valueStart: key.end + 1 });
        scanValue(line, key.end + 1, state);
        continue;
      }
      out.push({ kind: 'other' });
      continue;
    }
    out.push({ kind: 'other' });
    scanValue(line, 0, state);
  }
  return out;
}

// --- One setting ------------------------------------------------------------------

/** The value text of an assignment line, without a trailing comment. */
export function valueOf(line: string, valueStart: number): string {
  let i = valueStart;
  // The comment starts at the first # outside a string.
  while (i < line.length) {
    const c = line[i];
    if (c === '#') break;
    if (c === '"') { i++; while (i < line.length && line[i] !== '"') i += line[i] === '\\' ? 2 : 1; i++; continue; }
    if (c === "'") { const close = line.indexOf("'", i + 1); i = close < 0 ? line.length : close + 1; continue; }
    i++;
  }
  return line.slice(valueStart, i).trim();
}

export type Located =
  /** The table has a plain `key = value` line for the setting (index), or the table exists without it (header). */
  | { readonly kind: 'found'; readonly index: number; readonly value: string }
  | { readonly kind: 'absent'; readonly header: number | null }
  | { readonly kind: 'unsupported'; readonly reason: string };

/** Finds `key` in `[table]`. Any other spelling of the same setting, or of the table, is `unsupported`. */
export function locate(lines: readonly string[], table: string, key: string): Located {
  const all = roles(lines);
  const target = `${table}.${key}`;
  let header: number | null = null;
  let found: { index: number; value: string } | null = null;
  for (let i = 0; i < all.length; i++) {
    const role = all[i];
    if (role.kind === 'header') {
      if (role.path === table && !role.array) {
        if (header !== null) return { kind: 'unsupported', reason: `[${table}] appears twice` };
        header = i;
      }
      continue;
    }
    if (role.kind !== 'assignment') continue;
    const full = [role.table, keyPath(role.key)].filter(Boolean).join('.');
    if (role.table === table && role.key.length === 1 && role.key[0] === key) {
      if (found !== null) return { kind: 'unsupported', reason: `${key} appears twice in [${table}]` };
      found = { index: i, value: valueOf(lines[i], role.valueStart) };
    } else if (full === target || full === table || target.startsWith(`${full}.`) || full.startsWith(`${target}.`)) {
      return { kind: 'unsupported', reason: `${target} is written as ${full} = …` };
    }
  }
  return found !== null ? { kind: 'found', ...found } : { kind: 'absent', header };
}

/** The lines of the table that starts at `header`: up to the next header. */
export function tableEnd(lines: readonly string[], header: number): number {
  const all = roles(lines);
  for (let i = header + 1; i < all.length; i++) if (all[i].kind === 'header') return i;
  return lines.length;
}
function isBlankOrComment(line: string): boolean {
  const t = line.trim();
  return t === '' || t.startsWith('#');
}
/** Cuts a table: its header and body. Blank and comment lines right before the next header stay with it, and the blank line before the table goes. */
export function cutTable(lines: string[], header: number): void {
  let end = tableEnd(lines, header);
  if (end < lines.length) while (end > header + 1 && isBlankOrComment(lines[end - 1])) end--;
  else while (end > header + 1 && lines[end - 1].trim() === '') end--;
  const start = header > 0 && lines[header - 1].trim() === '' ? header - 1 : header;
  lines.splice(start, end - start);
}
/** Whether the table at `header` holds nothing but blank lines and comments. */
export function tableIsEmpty(lines: readonly string[], header: number): boolean {
  return lines.slice(header + 1, tableEnd(lines, header)).every(isBlankOrComment);
}
/** Removes every table whose header path matches, each with the blank line before it. */
export function removeTables(text: string, matches: (path: string) => boolean): string {
  const split = splitLines(text);
  for (;;) {
    const index = roles(split.lines).findIndex(role => role.kind === 'header' && !role.array && matches(role.path));
    if (index < 0) break;
    cutTable(split.lines, index);
  }
  return joinLines(split);
}
