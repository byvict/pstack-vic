#!/usr/bin/env node
// Guard of the six autopilot playbooks. Each one is the upstream text at the
// cursor sync point of UPSTREAM.md plus the exact-string harness substitutions
// of skills/poteto-mode/references/upstream-substitutions.json, and nothing else.
//
//   node scripts/upstream-parity.ts check            regenerate in memory and diff against the local files
//   node scripts/upstream-parity.ts --write          write the generated text over the local files
//   node scripts/upstream-parity.ts check --repo <dir>   checkout to inspect (default: this plugin)
//
// A pair replaces `from` with `to` in one file. `from` occurs exactly `count`
// times in the upstream text of that file. The pairs of a file never overlap
// and apply at once, so their order in the table means nothing. An empty `to`
// deletes; a `to` that starts with its `from` inserts. A pair that matches
// nothing is a dead pair.
//
// Exit 0: every file equals its generated text. Exit 1: residue, a dead pair,
// a wrong count or an overlap. Exit 2: the tool could not run (usage, a table
// that does not parse, the pin commit missing from the clone).

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { PLUGIN_ROOT } from "./model-matrix.ts";
import { DigestError, git, readSyncPoints } from "./upstream-digest.ts";

export const TABLE_PATH = "skills/poteto-mode/references/upstream-substitutions.json";
export const FETCH_HINT = "fetch the cursor remote first: git fetch --no-tags cursor main";

export interface GuardedFile {
  /** Path in the cursor tree, read with `git show <pin>:<upstream>`. */
  readonly upstream: string;
  /** Path in this plugin. */
  readonly local: string;
}

export interface Pair {
  /** Local path of the guarded file the pair applies to. */
  readonly file: string;
  readonly from: string;
  readonly to: string;
  /** Occurrences of `from` in the upstream text of `file`. */
  readonly count: number;
}

export interface Row {
  /** Row of the substitution table of the plan (T1 to T20). */
  readonly id: string;
  readonly reason: string;
  readonly pairs: readonly Pair[];
}

export interface SubstitutionTable {
  readonly files: readonly GuardedFile[];
  readonly rows: readonly Row[];
}

export interface RowPair extends Pair {
  readonly id: string;
}

export interface Applied {
  /** The generated text, or null when a problem makes it undefined. */
  readonly text: string | null;
  readonly problems: readonly string[];
}

export interface FileReport {
  readonly file: GuardedFile;
  readonly problems: readonly string[];
  readonly generated: string | null;
  /** Unified diff from the generated text to the local file, or null when they are equal. */
  readonly residue: string | null;
}

export interface ParityReport {
  readonly pin: string;
  readonly pairs: number;
  readonly files: readonly FileReport[];
}

export class ParityError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function excerpt(text: string): string {
  const flat = text.replace(/\n/g, "\\n");
  return flat.length <= 80 ? flat : `${flat.slice(0, 77)}...`;
}

/** The table file as data. Throws on any shape the semantics do not define. */
export function parseTable(json: string): SubstitutionTable {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new ParityError(`${TABLE_PATH} is not JSON: ${(err as Error).message}`);
  }
  if (!isRecord(raw) || !Array.isArray(raw.files) || !Array.isArray(raw.rows)) {
    throw new ParityError(`${TABLE_PATH} must be { "files": [...], "rows": [...] }`);
  }
  const files: GuardedFile[] = [];
  for (const entry of raw.files) {
    if (!isRecord(entry) || typeof entry.upstream !== "string" || typeof entry.local !== "string") {
      throw new ParityError(`${TABLE_PATH}: every file needs "upstream" and "local" paths`);
    }
    if (files.some((f) => f.local === entry.local)) {
      throw new ParityError(`${TABLE_PATH}: file ${entry.local} is listed twice`);
    }
    files.push({ upstream: entry.upstream, local: entry.local });
  }
  const rows: Row[] = [];
  for (const entry of raw.rows) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !/^T\d+$/.test(entry.id)) {
      throw new ParityError(`${TABLE_PATH}: every row needs an "id" such as "T1"`);
    }
    const id = entry.id;
    if (rows.some((r) => r.id === id)) throw new ParityError(`${TABLE_PATH}: row ${id} is listed twice`);
    if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
      throw new ParityError(`${TABLE_PATH}: row ${id} needs a "reason"`);
    }
    if (!Array.isArray(entry.pairs) || entry.pairs.length === 0) {
      throw new ParityError(`${TABLE_PATH}: row ${id} has no pairs`);
    }
    const pairs: Pair[] = [];
    for (const pair of entry.pairs) {
      if (
        !isRecord(pair) ||
        typeof pair.file !== "string" ||
        typeof pair.from !== "string" ||
        typeof pair.to !== "string" ||
        typeof pair.count !== "number"
      ) {
        throw new ParityError(`${TABLE_PATH}: every pair of row ${id} needs "file", "from", "to" and "count"`);
      }
      if (!files.some((f) => f.local === pair.file)) {
        throw new ParityError(`${TABLE_PATH}: row ${id} names ${pair.file}, which is not a guarded file`);
      }
      if (pair.from === "") throw new ParityError(`${TABLE_PATH}: row ${id} has a pair with an empty "from"`);
      if (pair.from === pair.to) {
        throw new ParityError(`${TABLE_PATH}: row ${id} has a pair that changes nothing: "${excerpt(pair.from)}"`);
      }
      if (!Number.isInteger(pair.count) || pair.count < 1) {
        throw new ParityError(`${TABLE_PATH}: row ${id} has a pair whose "count" is not a positive integer`);
      }
      pairs.push({ file: pair.file, from: pair.from, to: pair.to, count: pair.count });
    }
    rows.push({ id, reason: entry.reason, pairs });
  }
  return { files, rows };
}

/** The pairs of one guarded file, each carrying the id of its row. */
export function pairsFor(table: SubstitutionTable, local: string): RowPair[] {
  return table.rows.flatMap((row) => row.pairs.filter((p) => p.file === local).map((p) => ({ ...p, id: row.id })));
}

interface Match {
  readonly start: number;
  readonly end: number;
  readonly pair: RowPair;
}

function occurrences(text: string, needle: string): number[] {
  const starts: number[] = [];
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) starts.push(at);
  return starts;
}

/**
 * Apply every pair to the upstream text at once. Every match is located in the
 * upstream text itself, never in a partly substituted one, so no pair can see
 * the output of another.
 */
export function applyPairs(upstream: string, pairs: readonly RowPair[]): Applied {
  const problems: string[] = [];
  const matches: Match[] = [];
  for (const pair of pairs) {
    const starts = occurrences(upstream, pair.from);
    if (starts.length === 0) {
      problems.push(`${pair.id} dead pair in ${pair.file}: "${excerpt(pair.from)}" does not occur in the upstream text`);
      continue;
    }
    if (starts.length !== pair.count) {
      problems.push(
        `${pair.id} wrong count in ${pair.file}: "${excerpt(pair.from)}" occurs ${starts.length} times in the upstream text, the table says ${pair.count}`,
      );
      continue;
    }
    for (const start of starts) matches.push({ start, end: start + pair.from.length, pair });
  }
  matches.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < matches.length; i++) {
    const previous = matches[i - 1] as Match;
    const current = matches[i] as Match;
    if (current.start < previous.end) {
      problems.push(
        `${previous.pair.id} and ${current.pair.id} overlap in ${current.pair.file}: "${excerpt(previous.pair.from)}" and "${excerpt(current.pair.from)}"`,
      );
    }
  }
  if (problems.length > 0) return { text: null, problems };
  let text = "";
  let cursor = 0;
  for (const match of matches) {
    text += upstream.slice(cursor, match.start) + match.pair.to;
    cursor = match.end;
  }
  return { text: text + upstream.slice(cursor), problems };
}

type Op = { readonly kind: " " | "-" | "+"; readonly line: string };

function lineOps(expected: readonly string[], actual: readonly string[]): Op[] {
  const n = expected.length;
  const m = actual.length;
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] =
        expected[i] === actual[j]
          ? (lcs[(i + 1) * width + j + 1] as number) + 1
          : Math.max(lcs[(i + 1) * width + j] as number, lcs[i * width + j + 1] as number);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && expected[i] === actual[j]) {
      ops.push({ kind: " ", line: expected[i] as string });
      i++;
      j++;
    } else if (i < n && (j === m || (lcs[(i + 1) * width + j] as number) >= (lcs[i * width + j + 1] as number))) {
      ops.push({ kind: "-", line: expected[i++] as string });
    } else {
      ops.push({ kind: "+", line: actual[j++] as string });
    }
  }
  return ops;
}

function printable(op: Op): string {
  return op.line.endsWith("\n")
    ? `${op.kind}${op.line.slice(0, -1)}`
    : `${op.kind}${op.line}\n\\ No newline at end of file`;
}

/** Unified diff of two texts by line. Empty when they are equal. */
export function unifiedDiff(
  expected: string,
  actual: string,
  expectedLabel: string,
  actualLabel: string,
  context = 3,
): string {
  if (expected === actual) return "";
  const split = (text: string): string[] => (text === "" ? [] : text.split(/(?<=\n)/));
  const ops = lineOps(split(expected), split(actual));
  const out = [`--- ${expectedLabel}`, `+++ ${actualLabel}`];
  let at = 0;
  let expectedLine = 1;
  let actualLine = 1;
  while (at < ops.length) {
    if ((ops[at] as Op).kind === " ") {
      at++;
      expectedLine++;
      actualLine++;
      continue;
    }
    const start = Math.max(0, at - context);
    let end = at;
    let lastChange = at;
    while (end < ops.length && end - lastChange <= context * 2) {
      if ((ops[end] as Op).kind !== " ") lastChange = end;
      end++;
    }
    end = Math.min(ops.length, lastChange + context + 1);
    const hunk = ops.slice(start, end);
    const lead = at - start;
    const removed = hunk.filter((op) => op.kind !== "+").length;
    const added = hunk.filter((op) => op.kind !== "-").length;
    out.push(`@@ -${expectedLine - lead},${removed} +${actualLine - lead},${added} @@`, ...hunk.map(printable));
    for (const op of ops.slice(at, end)) {
      if (op.kind !== "+") expectedLine++;
      if (op.kind !== "-") actualLine++;
    }
    at = end;
  }
  return `${out.join("\n")}\n`;
}

/** Where two texts first differ, with a short window of each: a playbook line is one long paragraph. */
export function firstDifference(expected: string, actual: string): string | null {
  if (expected === actual) return null;
  let at = 0;
  while (at < expected.length && at < actual.length && expected[at] === actual[at]) at++;
  const lineStart = at === 0 ? 0 : expected.lastIndexOf("\n", at - 1) + 1;
  const line = expected.slice(0, lineStart).split("\n").length;
  const column = at - lineStart + 1;
  const window = (text: string): string => {
    const lineEnd = text.indexOf("\n", at);
    return text.slice(Math.max(lineStart, at - 30), Math.min(lineEnd === -1 ? text.length : lineEnd, at + 50));
  };
  return `first difference at line ${line}, column ${column}\n  generated: ${window(expected)}\n  local:     ${window(actual)}`;
}

function readTable(repo: string): SubstitutionTable {
  const path = join(repo, TABLE_PATH);
  if (!existsSync(path)) throw new ParityError(`${TABLE_PATH} is missing`);
  return parseTable(readFileSync(path, "utf8"));
}

/** The cursor sync point of UPSTREAM.md, checked to be a commit of this clone. */
export function readPin(repo: string): string {
  const pin = readSyncPoints(readFileSync(join(repo, "UPSTREAM.md"), "utf8")).cursor;
  const probe = spawnSync("git", ["cat-file", "-e", `${pin}^{commit}`], { cwd: repo, stdio: "ignore" });
  if (probe.status !== 0) throw new ParityError(`${FETCH_HINT} (the pin ${pin} is not in this clone)`);
  return pin;
}

/** Generate every guarded file from the pin and the table, and compare each with its local file. */
export function buildReport(repo: string = PLUGIN_ROOT): ParityReport {
  const table = readTable(repo);
  const pin = readPin(repo);
  const files = table.files.map((file): FileReport => {
    const upstream = git(repo, "show", `${pin}:${file.upstream}`);
    const { text, problems } = applyPairs(upstream, pairsFor(table, file.local));
    if (text === null) return { file, problems, generated: null, residue: null };
    const localPath = join(repo, file.local);
    const local = existsSync(localPath) ? readFileSync(localPath, "utf8") : "";
    const diff = unifiedDiff(text, local, `generated: ${pin.slice(0, 8)}:${file.upstream} plus the table`, file.local);
    return { file, problems, generated: text, residue: diff === "" ? null : `${diff}${firstDifference(text, local)}\n` };
  });
  return { pin, pairs: table.rows.reduce((sum, row) => sum + row.pairs.length, 0), files };
}

export function problemsOf(report: ParityReport): string[] {
  return report.files.flatMap((f) => [...f.problems]);
}

export function residueOf(report: ParityReport): string[] {
  return report.files.flatMap((f) => (f.residue === null ? [] : [f.residue]));
}

/** Write the generated text over the local files. Writes nothing when a pair has a problem. */
export function writeGenerated(repo: string, report: ParityReport): string[] {
  if (problemsOf(report).length > 0) return [];
  const written: string[] = [];
  for (const { file, generated, residue } of report.files) {
    if (generated === null || residue === null) continue;
    writeFileSync(join(repo, file.local), generated);
    written.push(file.local);
  }
  return written;
}

const USAGE = "usage: upstream-parity check | --write [--repo <dir>]";

export function main(argv: readonly string[]): number {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        write: { type: "boolean", default: false },
        repo: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }
  const values = parsed.values as { write: boolean; repo?: string; help: boolean };
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const check = parsed.positionals.length === 1 && parsed.positionals[0] === "check";
  if (check === values.write || parsed.positionals.length > (check ? 1 : 0)) {
    console.error(USAGE);
    return 2;
  }
  const repo = values.repo ?? PLUGIN_ROOT;
  let report: ParityReport;
  try {
    report = buildReport(repo);
  } catch (err) {
    if (err instanceof ParityError || err instanceof DigestError) {
      console.error((err as Error).message);
      return 2;
    }
    throw err;
  }
  const problems = problemsOf(report);
  for (const problem of problems) console.error(problem);
  if (values.write) {
    if (problems.length > 0) {
      console.error("upstream-parity: nothing written, fix the table first");
      return 1;
    }
    const written = writeGenerated(repo, report);
    for (const path of written) console.log(`wrote ${path}`);
    console.log(`upstream-parity: ${written.length} of ${report.files.length} files rewritten from ${report.pin}`);
    return 0;
  }
  const residue = residueOf(report);
  for (const diff of residue) process.stdout.write(`${diff}\n`);
  if (problems.length > 0 || residue.length > 0) {
    console.error(
      `upstream-parity: ${residue.length} files with residue, ${problems.length} table problems against ${report.pin}`,
    );
    return 1;
  }
  console.log(
    `upstream-parity: ${report.files.length} files equal ${report.pin} plus the ${report.pairs} pairs of ${TABLE_PATH}`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exitCode = main(process.argv.slice(2));
}
