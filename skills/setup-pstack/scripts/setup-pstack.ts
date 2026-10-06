#!/usr/bin/env node
// Deterministic half of /setup-pstack (pstack-vic, fase 6). The skill's prose
// owns the conversation (which parent, requested efforts, named role changes,
// confirmation) and the native one-turn probes; this script owns everything
// that must be exact: reading and normalizing the current sheet, rendering the
// new one from model-matrix.json, running the external probes through the
// runner, refusing to write while any probe is missing, and the snapshot /
// write / read-back / restore of the sheet, the parent integration, and the
// probe ledger. Effort belongs to the lane, not the family: two lanes of one
// family may differ. The probe unit is the family (provider and model): the
// parent's ledger records every family it has verified, and only a family
// missing from it (a new provider or a new model) is probed, once, at its
// lowest effort in the map. Effort and role changes need no probe. A rerun
// without changes is byte-identical by construction: the render is a pure
// function of (matrix, loaded sheet, requested efforts, role changes), and
// `write` compares before touching anything.
//
//   setup-pstack.ts state  --parent <claude|codex|grok> [--home <dir>]
//   setup-pstack.ts plan   --parent <p> [--home <dir>] [--dir <run dir>]
//                          [--effort <family>=<effort>]... [--role "<label>=<lane>, <lane>"]...
//   setup-pstack.ts probe  --dir <run dir> [--timeout <seconds>]
//   setup-pstack.ts attest --dir <run dir> --pair <family>@<effort> --observed <text>
//   setup-pstack.ts write  --dir <run dir> [--home <dir>]
//   setup-pstack.ts pick   --parent <p> --role "<pool role>" [--executor <provider>]... [--home <dir>]
//
// `pick` is the one subcommand a skill calls at dispatch time: it applies the
// Cross-family selection rule of provider-dispatch.md to a pool row, so the
// session whose work is under review does not choose its own reviewer.
//
// Node 24, type stripping, no dependencies: erasable TypeScript only.

import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  agentName,
  crossFamilyRowProblem,
  familyFor,
  familyNamed,
  loadMatrix,
  nativeProviderOf,
  ownerAgentName,
  parseDescriptor,
  pickCrossFamily,
  renderSheetDocument,
  roleDefault,
  roleNamed,
  routeFor,
  type CrossFamilyPick,
  type Family,
  type ModelMatrix,
  type Route,
} from "../../../scripts/model-matrix.ts";
import { judgeLane, probePrompt, runProbeLane } from "../../poteto-mode/scripts/runner/probe-lane.ts";
import * as marked from "./marked-rules.ts";

export class SetupError extends Error {}

function fail(message: string): never {
  throw new SetupError(message);
}

// --- Paths -----------------------------------------------------------------

export type ConfigEnv = Readonly<Record<string, string | undefined>>;

interface HomeVariable {
  readonly name: string;
  readonly emptyRefusal: string | null;
}

interface Target {
  readonly defaultDir: string;
  readonly variable: HomeVariable | null;
  readonly integration: string;
  readonly wiring: "import" | "block";
}

const TARGETS: Readonly<Record<string, Target>> = {
  claude: {
    defaultDir: ".claude",
    variable: { name: "CLAUDE_CONFIG_DIR", emptyRefusal: "Claude Code 2.1.289 then reads settings.json and CLAUDE.md from the directory it starts in, not from ~/.claude" },
    integration: "CLAUDE.md",
    wiring: "import",
  },
  codex: { defaultDir: ".codex", variable: { name: "CODEX_HOME", emptyRefusal: null }, integration: "AGENTS.md", wiring: "block" },
  grok: { defaultDir: ".grok", variable: null, integration: "AGENTS.md", wiring: "block" },
};

export const SHEET_FILE = "pstack-models.md";
export const LEDGER_FILE = "pstack-probes.json";
export const CLAUDE_INCLUDE_LINE = "@~/.claude/pstack-models.md";
const CLAUDE_RELATIVE_INCLUDE_LINE = `@./${SHEET_FILE}`;
export const CODEX_BLOCK_BEGIN = "<!-- pstack:models:begin -->";
export const CODEX_BLOCK_END = "<!-- pstack:models:end -->";

function targetFor(parent: string): Target {
  const target = TARGETS[parent];
  if (!target) fail(`unknown parent ${JSON.stringify(parent)}; expected one of ${Object.keys(TARGETS).join(", ")}`);
  return target;
}

export function configHomeFor(parent: string, home: string = homedir(), env: ConfigEnv = {}): string {
  const { defaultDir, variable } = targetFor(parent);
  const value = variable === null ? undefined : env[variable.name];
  if (variable === null || value === undefined || (value === "" && variable.emptyRefusal === null)) return resolve(home, defaultDir);
  if (value === "") fail(`${variable.name} is empty; ${variable.emptyRefusal}, so unset it or set it to an absolute path`);
  if (!isAbsolute(value)) fail(`${variable.name} must be an absolute path${variable.emptyRefusal === null ? " or empty" : ""}; got ${JSON.stringify(value)}`);
  return resolve(value);
}

interface Location {
  readonly parent: string;
  readonly home: string;
  readonly configHome: string;
  readonly sheetPath: string;
  readonly integrationPath: string;
  readonly ledgerPath: string;
  readonly wiring: Target["wiring"];
}

function locate(parent: string, home: string, env: ConfigEnv): Location {
  const target = targetFor(parent);
  const configHome = configHomeFor(parent, home, env);
  return {
    parent,
    home,
    configHome,
    sheetPath: join(configHome, SHEET_FILE),
    integrationPath: join(configHome, target.integration),
    ledgerPath: join(configHome, LEDGER_FILE),
    wiring: target.wiring,
  };
}

export function sheetPathFor(parent: string, home: string = homedir(), env: ConfigEnv = {}): string {
  return locate(parent, home, env).sheetPath;
}

export function integrationPathFor(parent: string, home: string = homedir(), env: ConfigEnv = {}): string {
  return locate(parent, home, env).integrationPath;
}

export function ledgerPathFor(parent: string, home: string = homedir(), env: ConfigEnv = {}): string {
  return locate(parent, home, env).ledgerPath;
}

// Claude Code 2.1.289 strips front matter, lexes CLAUDE.md with marked 16 (gfm
// off), and takes `@path` from text tokens and from what an HTML comment block
// leaves.

interface SheetImport {
  readonly line: number;
  readonly start: number;
  readonly end: number;
  readonly target: string;
}

interface UnsureImport {
  readonly line: number;
  readonly reason: string;
}

interface ImportScan {
  readonly imports: readonly SheetImport[];
  readonly unsure: readonly UnsureImport[];
}

type Verdict =
  | { readonly kind: "loaded"; readonly target: string; readonly run: string }
  | { readonly kind: "skipped" }
  | { readonly kind: "unsure"; readonly reason: string };

const SKIPPED: Verdict = { kind: "skipped" };

function unsure(reason: string): Verdict {
  return { kind: "unsure", reason };
}

const MARKUP = "markup touches it";
const INLINE = "an HTML tag, a link or a backslash comes before it in its paragraph";
const MIXED = "inline code and emphasis both come before it in its paragraph";
const CONTAINER = "it is in or after a list or quote that this script does not read";
const MERGED = "an indented line or a link definition continues its paragraph";
const SPLIT = "an HTML comment splits it";
const WORD = "another @ comes before it in the same word";

const FRONT_MATTER_RE = /^---\s*\n([\s\S]*?)---\s*\n?/;
const IMPORT_RE = /(?:^|\s)@((?:[^\s\\]|\\ )+)/g;
const PATH_RUN_RE = /^(?:[^\s\\]|\\ )*/;
const RUN_BEFORE_RE = /@(?:[^\s\\]|\\ )*$/;
const PATH_MARKUP_RE = /[`*_<[]/;
const TOKEN_ENDS = new Set(["*", "_", "`", ">", ")", "]"]);
const QUOTE_PREFIX_RE = /^ {0,3}>[ \t]?/;
const BULLET_LINE_RE = /^( {0,3}(?:[*+-]|\d{1,9}[.)]) {1,4})\S/;
const BLOCK_START_RE = /^(?:`{3,}|~{3,}|[#<>[]|(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)|(?:=+|-+)[ \t]*$)/;
const POISON_RE = /^[ \t]*(?:`{3,}|~{3,}|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--|\?|![A-Za-z]|!\[CDATA\[))/i;

function pathRun(text: string, from: number): string {
  return PATH_RUN_RE.exec(text.slice(from))?.[0] ?? "";
}

function sheetTarget(run: string): string | null {
  const path = run.split("#")[0].replaceAll("\\ ", " ");
  const accepted = path.startsWith("./") || path.startsWith("~/") || (path.startsWith("/") && path !== "/")
    || (!path.startsWith("@") && !/^[#%^&*()]+/.test(path) && /^[a-zA-Z0-9._-]/.test(path));
  return accepted && basename(path) === SHEET_FILE ? path : null;
}

function wordVerdict(text: string, at: number, tokenStart: boolean): Verdict {
  if (RUN_BEFORE_RE.test(text.slice(0, at))) return unsure(WORD);
  const run = pathRun(text, at + 1);
  const before = text[at - 1] ?? "";
  if (tokenStart || before === "" || /\s/.test(before)) {
    if (PATH_MARKUP_RE.test(run.split("#")[0])) return unsure(MARKUP);
    const target = sheetTarget(run);
    return target === null ? SKIPPED : { kind: "loaded", target, run };
  }
  return TOKEN_ENDS.has(before) || text[at - 2] === "\\" ? unsure(MARKUP) : SKIPPED;
}

function closingRun(text: string, from: number, length: number): number {
  for (let k = from + 1; k < text.length; k += 1) {
    if (text[k] !== "`" || text[k - 1] === "`") continue;
    let end = k;
    while (text[end] === "`") end += 1;
    if (end - k === length) return k;
    k = end;
  }
  return -1;
}

function inlineVerdict(text: string, at: number): Verdict {
  let emphasis = false;
  let spans = false;
  let tokenStart = false;
  for (let j = 0; j < at;) {
    tokenStart = false;
    const c = text[j];
    if (c === "\\" || c === "[" || (c === "<" && !text.startsWith("<!--", j))) return unsure(INLINE);
    if (c === "*" || c === "_") {
      if (spans) return unsure(MIXED);
      emphasis = true;
    }
    let end = -1;
    if (c === "`") {
      let open = 0;
      while (text[j + open] === "`") open += 1;
      const close = closingRun(text, j + open, open);
      if (close < 0) {
        j += open;
        continue;
      }
      end = close + open;
    } else if (c === "<") {
      const close = text.indexOf("-->", j + 2);
      if (close < 0) return unsure(INLINE);
      end = close + 3;
    } else {
      j += 1;
      continue;
    }
    if (emphasis) return unsure(MIXED);
    spans = true;
    if (at < end) return SKIPPED;
    j = end;
    tokenStart = true;
  }
  return wordVerdict(text, at, tokenStart);
}

/** An `@` in a plain list item, whose text Claude Code also scans raw, code spans and all. */
function listVerdict(line: string, at: number, contentStart: number): Verdict {
  const content = line.slice(contentStart);
  const i = at - contentStart;
  if (RUN_BEFORE_RE.test(content.slice(0, i))) return unsure(WORD);
  const run = pathRun(content, i + 1);
  const before = content[i - 1] ?? "";
  if (before === "" || /\s/.test(before)) {
    const target = sheetTarget(run);
    if (target !== null) return { kind: "loaded", target, run };
    return PATH_MARKUP_RE.test(run.split("#")[0]) ? unsure(MARKUP) : SKIPPED;
  }
  return TOKEN_ENDS.has(before) || content[i - 2] === "\\" ? unsure(MARKUP) : SKIPPED;
}

function plainStart(text: string): boolean {
  return text.length > 0 && !BLOCK_START_RE.test(text) && !marked.hr.test(text);
}

interface Line {
  readonly start: number;
  readonly text: string;
}

function lineAt(text: string, start: number): Line {
  const end = text.indexOf("\n", start);
  return { start, text: text.slice(start, end < 0 ? text.length : end) };
}

function nextLine(text: string, line: Line): number {
  return line.start + line.text.length + 1;
}

function isBlank(line: Line): boolean {
  return /^[ \t]*$/.test(line.text);
}

function afterContainers(text: string, from: number): number {
  let previousBlank = false;
  for (let line = lineAt(text, from); line.start < text.length; line = lineAt(text, nextLine(text, line))) {
    if (previousBlank && !isBlank(line) && !/^[ \t]/.test(line.text)) return line.start;
    if (POISON_RE.test(line.text)) return text.length;
    previousBlank = isBlank(line);
  }
  return text.length;
}

class ImportReader {
  readonly verdicts = new Map<number, Verdict>();
  readonly text: string;
  readonly mentions: readonly number[];

  constructor(text: string, mentions: readonly number[]) {
    this.text = text;
    this.mentions = mentions;
  }

  mark(from: number, to: number, verdict: (at: number) => Verdict): void {
    for (const at of this.mentions) {
      if (at >= from && at < to && !this.verdicts.has(at)) this.verdicts.set(at, verdict(at));
    }
  }

  inline(start: number, text: string): void {
    this.mark(start, start + text.length, (at) => inlineVerdict(text, at - start));
  }

  html(start: number, raw: string): void {
    if (raw.trimStart().startsWith("<!--") && raw.includes("-->")) {
      const kept: number[] = [];
      let rest = "";
      let last = 0;
      for (const comment of raw.matchAll(/<!--[\s\S]*?-->/g)) {
        for (let k = last; k < comment.index; k += 1) kept.push(start + k);
        rest += raw.slice(last, comment.index);
        last = comment.index + comment[0].length;
      }
      for (let k = last; k < raw.length; k += 1) kept.push(start + k);
      rest += raw.slice(last);
      for (const match of rest.matchAll(IMPORT_RE)) {
        const run = match[1];
        const target = sheetTarget(run);
        if (target === null) continue;
        const at = match.index + match[0].length - run.length - 1;
        this.verdicts.set(kept[at], kept[at + run.length] - kept[at] === run.length ? { kind: "loaded", target, run } : unsure(SPLIT));
      }
    }
  }

  readContainer(start: number): number {
    const quote = marked.blockquoteStart.test(this.text.slice(start));
    const lines: Line[] = [];
    for (let line = lineAt(this.text, start); line.start < this.text.length && !isBlank(line); line = lineAt(this.text, nextLine(this.text, line))) {
      lines.push(line);
    }
    const contentStarts: number[] = [];
    for (const [index, line] of lines.entries()) {
      const contentStart = quote ? quoteContent(line.text) : listContent(line.text, index === 0);
      if (contentStart === null) return this.opaque(start);
      contentStarts.push(contentStart);
    }
    const last = lines[lines.length - 1];
    const end = last.start + last.text.length;
    if (quote) {
      const parts = lines.map((line, index) => ({ start: line.start + contentStarts[index], text: line.text.slice(contentStarts[index]) }));
      const inner = parts.map((part) => part.text).join("\n");
      const offsets: number[] = [];
      let offset = 0;
      for (const part of parts) {
        offsets.push(offset);
        offset += part.text.length + 1;
      }
      parts.forEach((part, index) => this.mark(part.start, part.start + part.text.length, (at) => inlineVerdict(inner, offsets[index] + at - part.start)));
      return end;
    }
    lines.forEach((line, index) => this.mark(line.start, line.start + line.text.length, (at) => listVerdict(line.text, at - line.start, contentStarts[index])));
    let next = lineAt(this.text, end + 1);
    while (next.start < this.text.length && isBlank(next)) next = lineAt(this.text, nextLine(this.text, next));
    return next.start >= this.text.length || !/^[ \t]/.test(next.text) ? end : this.opaque(next.start);
  }

  opaque(start: number): number {
    const resume = afterContainers(this.text, start);
    this.mark(start, resume, () => unsure(CONTAINER));
    return resume;
  }

  read(start: number): void {
    const text = this.text;
    let pos = start;
    let paragraph = false;
    while (pos < text.length) {
      const rest = text.slice(pos);
      let match: RegExpExecArray | null;
      if ((match = marked.newline.exec(rest)) !== null && match[0].length > 0) {
        if (match[0].length > 1) paragraph = false;
      } else if ((match = marked.code.exec(rest)) !== null) {
        this.mark(pos, pos + match[0].length, () => (paragraph ? unsure(MERGED) : SKIPPED));
      } else if ((match = marked.fences.exec(rest)) !== null) {
        paragraph = false;
      } else if ((match = marked.heading.exec(rest)) !== null) {
        const raw = match[2];
        let heading = raw.trim();
        if (heading.endsWith("#")) {
          const trimmed = heading.replace(/#+$/, "");
          if (!trimmed || trimmed.endsWith(" ")) heading = trimmed.trim();
        }
        this.inline(pos + match[0].indexOf(match[1]) + match[1].length + raw.length - raw.trimStart().length, heading);
        paragraph = false;
      } else if ((match = marked.hr.exec(rest)) !== null) {
        paragraph = false;
      } else if (marked.blockquoteStart.test(rest) || marked.list.test(rest)) {
        pos = this.readContainer(pos);
        paragraph = false;
        continue;
      } else if ((match = marked.html.exec(rest)) !== null) {
        this.html(pos, match[0]);
        paragraph = false;
      } else if ((match = marked.def.exec(rest)) !== null) {
        this.mark(pos, pos + match[0].length, () => (paragraph ? unsure(MERGED) : SKIPPED));
      } else if ((match = marked.lheading.exec(rest)) !== null) {
        this.inline(pos, match[1]);
        paragraph = false;
      } else if ((match = marked.paragraph.exec(rest)) !== null) {
        this.inline(pos, match[1]);
        paragraph = true;
      } else {
        break;
      }
      this.mark(pos, pos + match[0].length, () => SKIPPED);
      pos += match[0].length;
    }
    this.mark(pos, text.length, () => unsure(CONTAINER));
  }
}

function quoteContent(line: string): number | null {
  const prefix = QUOTE_PREFIX_RE.exec(line)?.[0].length ?? 0;
  const inner = line.slice(prefix);
  return /^ {0,3}\S/.test(inner) && plainStart(inner.trimStart()) ? prefix : null;
}

function listContent(line: string, first: boolean): number | null {
  const bullet = BULLET_LINE_RE.exec(line)?.[1].length;
  const start = bullet ?? (first || !/^ {0,3}\S/.test(line) ? null : line.length - line.trimStart().length);
  return start !== null && plainStart(line.slice(start)) ? start : null;
}

function lineOf(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length;
}

function normalizeBreaks(raw: string, body: number): { readonly text: string; readonly rawOffset: (at: number) => number } {
  const pairs: number[] = [];
  const text = raw.slice(0, body) + raw.slice(body).replace(/\r\n?/g, (pair, at: number) => {
    if (pair.length === 2) pairs.push(body + at - pairs.length);
    return "\n";
  });
  return { text, rawOffset: (at) => at + pairs.filter((pair) => pair < at).length };
}

function bodyStart(raw: string): { readonly lexed: number; readonly top: number } {
  const bom = raw.charCodeAt(0) === 0xfeff ? 1 : 0;
  const frontMatter = raw.indexOf("---", bom + 3) < 0 ? null : FRONT_MATTER_RE.exec(raw.slice(bom));
  return frontMatter === null ? { lexed: 0, top: bom } : { lexed: bom + frontMatter[0].length, top: bom + frontMatter[0].length };
}

function scanSheetImports(raw: string): ImportScan {
  const body = bodyStart(raw).lexed;
  const { text, rawOffset } = normalizeBreaks(raw, body);
  const mentions: number[] = [];
  for (let at = text.indexOf("@", body); at >= 0; at = text.indexOf("@", at + 1)) {
    if (pathRun(text, at + 1).includes(SHEET_FILE)) mentions.push(at);
  }
  const reader = new ImportReader(text, mentions);
  reader.read(body);
  const imports: SheetImport[] = [];
  const unsureImports: UnsureImport[] = [];
  for (const [at, verdict] of [...reader.verdicts].sort(([a], [b]) => a - b)) {
    const start = rawOffset(at);
    if (verdict.kind === "loaded") imports.push({ line: lineOf(text, at), start, end: start + 1 + verdict.run.length, target: verdict.target });
    if (verdict.kind === "unsure") unsureImports.push({ line: lineOf(text, at), reason: verdict.reason });
  }
  return { imports, unsure: unsureImports };
}

function tooManyImports(path: string, imports: readonly SheetImport[]): never {
  fail(`inconsistent state: ${path} imports ${SHEET_FILE} ${imports.length} times (lines ${imports.map((i) => i.line).join(", ")}); keep exactly one import`);
}

function importTarget(path: string, where: Location): string {
  if (path.startsWith("~/")) return resolve(where.home, path.slice(2));
  return resolve(dirname(where.integrationPath), path);
}

function includeLineFor(where: Location): string {
  return where.configHome === resolve(where.home, TARGETS.claude.defaultDir) ? CLAUDE_INCLUDE_LINE : CLAUDE_RELATIVE_INCLUDE_LINE;
}

function placeImport(where: Location, text: string): { readonly current: SheetImport | null; readonly rendered: string } {
  const path = where.integrationPath;
  const scan = scanSheetImports(text);
  if (scan.unsure.length > 0) {
    fail(`inconsistent state: ${path} line ${scan.unsure[0].line} mentions an import of ${SHEET_FILE} that this script cannot read the way Claude Code does (${scan.unsure[0].reason}); move the import to the top of the file as a line of its own, or remove the mention`);
  }
  if (scan.imports.length > 1) tooManyImports(path, scan.imports);
  const current = scan.imports[0] ?? null;
  const include = includeLineFor(where);
  const separator = text.length === 0 || text.endsWith("\n") ? "" : "\n";
  const { top } = bodyStart(text);
  const layouts = current === null
    ? [`${text}${separator}${include}\n`, `${text}${separator}\n${include}\n`, `${text.slice(0, top)}${include}\n\n${text.slice(top)}`]
    : [`${text.slice(0, current.start)}${include}${text.slice(current.end)}`];
  let detail = "a code block, an HTML block or a comment hides it";
  for (const rendered of layouts) {
    const after = scanSheetImports(rendered);
    if (after.unsure.length === 0 && after.imports.length === 1 && importTarget(after.imports[0].target, where) === where.sheetPath) return { current, rendered };
    if (after.unsure.length > 0) detail = after.unsure[0].reason;
  }
  fail(`inconsistent state: Claude Code would not load ${include} written into ${path} (${detail}); put the import where Claude Code loads it yourself, then run setup again`);
}

interface Block {
  readonly start: number;
  readonly end: number;
  readonly sheet: string;
}

function findBlock(text: string, path: string): Block | null {
  const begins = text.split(CODEX_BLOCK_BEGIN).length - 1;
  const ends = text.split(CODEX_BLOCK_END).length - 1;
  if (begins === 0 && ends === 0) return null;
  if (begins !== 1 || ends !== 1) {
    fail(`${path} has ${begins} begin and ${ends} end markers; expected exactly one pstack:models block`);
  }
  const start = text.indexOf(CODEX_BLOCK_BEGIN);
  const stop = text.indexOf(CODEX_BLOCK_END);
  if (stop < start) fail(`${path} pstack:models markers are reversed`);
  return { start, end: stop + CODEX_BLOCK_END.length, sheet: text.slice(start + CODEX_BLOCK_BEGIN.length, stop).replace(/^\n/, "") };
}

// --- Sheet parsing -----------------------------------------------------------

export interface SheetRow {
  readonly role: string;
  readonly lanes: readonly string[];
}

const ROW_RE = /^([a-z][a-z0-9 ,-]*): (.+)$/;
const RETIRED_CONVERGE_ROLES = new Set([
  "pr reviewer",
  "pr fixer, simple",
  "pr fixer, complex",
  "pr diagnosis pool",
  "pre-pr reviewer",
  "pre-pr fixer",
  "pre-pr certifier",
  "converge raiz",
  "pr owner",
  "pr verifier",
]);

/**
 * The role rows of a sheet: `label: lane[, lane]`. Title, blank lines, and
 * prose are skipped. Lanes are returned as written (see normalizeLane).
 */
export function parseSheet(text: string, matrix: ModelMatrix): SheetRow[] {
  const known = new Set(matrix.roles.map((r) => r.role));
  const rows: SheetRow[] = [];
  const seen = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (line.length === 0 || line.startsWith("#")) continue;
    const match = ROW_RE.exec(line);
    if (!match) continue;
    const [, role, value] = match;
    if (!known.has(role)) {
      if (RETIRED_CONVERGE_ROLES.has(role)) continue;
      fail(`unknown role ${JSON.stringify(role)} in sheet line ${JSON.stringify(line)}`);
    }
    if (seen.has(role)) fail(`duplicate role ${JSON.stringify(role)} in sheet`);
    seen.add(role);
    const lanes = value.split(",").map((v) => v.trim()).filter((v) => v.length > 0);
    if (lanes.length === 0) fail(`role ${JSON.stringify(role)} has no lanes`);
    rows.push({ role, lanes });
  }
  return rows;
}

// --- Lane normalization ------------------------------------------------------

export interface NormalizedLane {
  readonly lane: string;
  readonly migratedFrom: string | null;
}

const ROLLING_ALIAS_RE = /^claude-(fable|opus)-[0-9]+(-[0-9]+)*$/;

/**
 * Validate one lane against the matrix. Aliases pass through. A descriptor
 * whose Claude model is an old revision (`claude-fable-5-1`,
 * `claude-opus-5`) is migrated to the configured family model and the
 * original recorded. Anything else that is not `<provider>:<model>@<effort>`
 * for a matrix family with a selectable effort is inconsistent state.
 */
export function normalizeLane(text: string, matrix: ModelMatrix): NormalizedLane {
  if (matrix.aliases.includes(text)) return { lane: text, migratedFrom: null };
  const descriptor = parseDescriptor(text);
  if (!descriptor) {
    fail(`${JSON.stringify(text)} is neither an alias (${matrix.aliases.join(", ")}) nor <provider>:<model>@<effort>`);
  }
  let model = descriptor.model;
  let migratedFrom: string | null = null;
  const exact = familyFor(matrix, descriptor);
  if (exact === null && descriptor.provider === "claude") {
    const rolling = ROLLING_ALIAS_RE.exec(model);
    if (rolling) {
      model = rolling[1] === "opus"
        ? familyNamed(matrix, "opus")?.model ?? model
        : rolling[1];
      migratedFrom = text;
    } else if (model === "opus") {
      model = familyNamed(matrix, "opus")?.model ?? model;
      migratedFrom = text;
    }
  }
  if (exact === null && descriptor.provider === "codex" && model === "gpt-5.6-sol") {
    model = familyNamed(matrix, "sol")?.model ?? model;
    migratedFrom = text;
  }
  const family = familyFor(matrix, { provider: descriptor.provider, model });
  if (!family) fail(`${JSON.stringify(text)}: no matrix family for ${descriptor.provider}:${model}`);
  if (!family.efforts.includes(descriptor.effort)) {
    fail(`${JSON.stringify(text)}: ${family.family} does not select effort ${descriptor.effort} (allowed: ${family.efforts.join(" ")})`);
  }
  return { lane: `${family.provider}:${family.model}@${descriptor.effort}`, migratedFrom };
}

function laneFamily(lane: string, matrix: ModelMatrix): Family | null {
  const descriptor = parseDescriptor(lane);
  return descriptor ? familyFor(matrix, descriptor) : null;
}

// --- State -----------------------------------------------------------------

export type EffortStatus = "current" | "mixed" | "unassigned" | "outside-map";

export interface EffortState {
  readonly status: EffortStatus;
  /** Distinct efforts in use, in matrix effort order (low → max). The matrix default when unassigned or outside-map. */
  readonly efforts: readonly string[];
  /** Every lane of the family in the map, in sheet order. Empty when unassigned or outside-map. */
  readonly rows: ReadonlyArray<{ readonly role: string; readonly lane: string }>;
}

export interface Migration {
  readonly role: string;
  readonly from: string;
  readonly to: string;
}

export type SheetSource =
  | { readonly kind: "sheet"; readonly path: string }
  | { readonly kind: "import"; readonly path: string }
  | { readonly kind: "block"; readonly path: string }
  | { readonly kind: "first-run" };

export interface State {
  readonly parent: string;
  readonly configHome: string;
  readonly sheetPath: string;
  readonly integrationPath: string;
  readonly exists: boolean;
  readonly source: SheetSource;
  readonly missingImport: string | null;
  /** Normalized rows in sheet order (first run: empty). */
  readonly rows: readonly SheetRow[];
  readonly migrations: readonly Migration[];
  /** One entry per matrix family, in matrix order. */
  readonly efforts: Readonly<Record<string, EffortState>>;
}

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function parseFrom(text: string, path: string, matrix: ModelMatrix): SheetRow[] {
  try {
    return parseSheet(text, matrix);
  } catch (error) {
    if (error instanceof SetupError) fail(`${path}: ${error.message}`);
    throw error;
  }
}

function laneDifferences(sheet: readonly SheetRow[], other: readonly SheetRow[], label: string): string[] {
  const lanes = (rows: readonly SheetRow[]) => new Map(rows.map((r) => [r.role, r.lanes.join(", ")]));
  const left = lanes(sheet);
  const right = lanes(other);
  return [...new Set([...left.keys(), ...right.keys()])]
    .filter((role) => left.get(role) !== right.get(role))
    .map((role) => `${role} (sheet: ${left.get(role) ?? "no row"}; ${label}: ${right.get(role) ?? "no row"})`);
}

type LoadedSource = Exclude<SheetSource, { kind: "first-run" }>;

interface Loaded {
  readonly source: LoadedSource;
  readonly text: string;
}

function describeSource(source: LoadedSource, where: Location): string {
  if (source.kind === "import") return `${source.path} (imported by ${where.integrationPath})`;
  if (source.kind === "block") return `the pstack:models block of ${source.path}`;
  return source.path;
}

function selectSource(where: Location, matrix: ModelMatrix): { readonly loaded: Loaded | null; readonly missingImport: string | null } {
  if (existsSync(where.configHome) && !statSync(where.configHome).isDirectory()) {
    const variable = targetFor(where.parent).variable;
    fail(`inconsistent state: the config home ${where.configHome} is a file, not a directory; move it aside${variable === null ? "" : ` or point ${variable.name} at a directory`}`);
  }
  const sheetText = snapshotOf(where.sheetPath, "sheet");
  const integration = snapshotOf(where.integrationPath, "integration file") ?? "";
  const sheet: Loaded | null = sheetText === null ? null : { source: { kind: "sheet", path: where.sheetPath }, text: sheetText };
  let other: Loaded | null = null;
  let missingImport: string | null = null;
  if (where.wiring === "import") {
    const { current } = placeImport(where, integration);
    if (current !== null) {
      const target = importTarget(current.target, where);
      const text = target === where.sheetPath ? sheetText : snapshotOf(target, "imported sheet");
      if (text === null) missingImport = target;
      else if (target !== where.sheetPath) other = { source: { kind: "import", path: target }, text };
    }
  } else {
    const block = findBlock(integration, where.integrationPath);
    if (block !== null) other = { source: { kind: "block", path: where.integrationPath }, text: block.sheet };
  }
  if (sheet !== null && other !== null) {
    const differences = laneDifferences(
      parseFrom(sheet.text, describeSource(sheet.source, where), matrix),
      parseFrom(other.text, describeSource(other.source, where), matrix),
      other.source.kind
    );
    if (differences.length > 0) {
      const keep = other.source.kind === "block"
        ? "delete the sheet to recover the block, or remove the block to keep the sheet"
        : `delete the sheet to carry the imported one over, or change the import to ${CLAUDE_RELATIVE_INCLUDE_LINE} to keep the sheet`;
      fail(`inconsistent state: ${describeSource(sheet.source, where)} and ${describeSource(other.source, where)} assign different lanes to ${differences.join(", ")}; ${keep}`);
    }
  }
  return { loaded: sheet ?? other, missingImport };
}

/** Normalize every lane of every row, collecting migrations. */
function normalizeRows(
  rows: readonly SheetRow[],
  matrix: ModelMatrix
): { rows: SheetRow[]; migrations: Migration[] } {
  const migrations: Migration[] = [];
  const normalized = rows.map((row) => ({
    role: row.role,
    lanes: row.lanes.map((lane) => {
      const result = normalizeLane(lane, matrix);
      if (result.migratedFrom !== null) {
        migrations.push({ role: row.role, from: result.migratedFrom, to: result.lane });
      }
      return result.lane;
    }),
  }));
  return { rows: normalized, migrations };
}

/**
 * Efforts in use per family from a complete, normalized role map. A family
 * absent from the map is `outside-map` (its default effort is only a proposal);
 * a family present with one effort is `current`; two or more is `mixed`.
 */
function familyEfforts(rows: readonly SheetRow[], matrix: ModelMatrix): Record<string, EffortState> {
  const efforts: Record<string, EffortState> = {};
  for (const family of matrix.families) {
    const occurrences: Array<{ role: string; lane: string }> = [];
    for (const row of rows) {
      for (const lane of row.lanes) {
        if (laneFamily(lane, matrix)?.family === family.family) occurrences.push({ role: row.role, lane });
      }
    }
    const distinct = new Set(occurrences.map((o) => parseDescriptor(o.lane)?.effort ?? ""));
    if (occurrences.length === 0) {
      efforts[family.family] = { status: "outside-map", efforts: [family.defaultEffort], rows: [] };
    } else {
      const ordered = matrix.efforts.filter((effort) => distinct.has(effort));
      efforts[family.family] = {
        status: ordered.length === 1 ? "current" : "mixed",
        efforts: ordered,
        rows: occurrences,
      };
    }
  }
  return efforts;
}

export interface StateInput {
  readonly parent: string;
  readonly home?: string;
  readonly env?: ConfigEnv;
  readonly matrix?: ModelMatrix;
}

export function loadState(input: StateInput): State {
  const matrix = input.matrix ?? loadMatrix();
  const parent = input.parent;
  if (!(parent in matrix.parents)) fail(`unknown parent ${JSON.stringify(parent)}; expected one of ${Object.keys(matrix.parents).join(", ")}`);
  const where = locate(parent, input.home ?? homedir(), input.env ?? {});
  const { loaded, missingImport } = selectSource(where, matrix);
  const located = {
    parent,
    configHome: where.configHome,
    sheetPath: where.sheetPath,
    integrationPath: where.integrationPath,
    exists: loaded?.source.kind === "sheet",
    source: loaded?.source ?? { kind: "first-run" as const },
    missingImport,
  };
  if (loaded === null) {
    const defaults = matrix.roles.map((r) => ({ role: r.role, lanes: roleDefault(matrix, r.role, parent) }));
    const efforts = familyEfforts(defaults, matrix);
    for (const family of matrix.families) {
      const state = efforts[family.family];
      if (state.status === "current" || state.status === "mixed") {
        efforts[family.family] = { status: "unassigned", efforts: [family.defaultEffort], rows: [] };
      }
    }
    return { ...located, rows: [], migrations: [], efforts };
  }
  const { rows, migrations } = normalizeRows(parseFrom(loaded.text, describeSource(loaded.source, where), matrix), matrix);
  return { ...located, rows, migrations, efforts: familyEfforts(rows, matrix) };
}

// --- Probe ledger ------------------------------------------------------------

/** How this parent verified one family: the probe that passed, or `operator` when the operator vouched for it. */
export interface LedgerEntry {
  readonly family: string;
  readonly descriptor: string;
  readonly verifiedAt: string;
  readonly evidence: string;
}

export interface Ledger {
  readonly schemaVersion: 1;
  /** Keyed by `<provider>:<model>`: a new provider or model is a new key; effort is not part of it. */
  readonly families: Readonly<Record<string, LedgerEntry>>;
}

function familyKey(family: { readonly provider: string; readonly model: string }): string {
  return `${family.provider}:${family.model}`;
}

/** An absent ledger verifies nothing; one that does not parse is inconsistent state. */
function parseLedger(text: string | null, path: string): Ledger {
  if (text === null) return { schemaVersion: 1, families: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    fail(`${path} is not JSON (${(error as Error).message}); fix or remove it before planning`);
  }
  const ledger = raw as Partial<Ledger> | null;
  if (ledger?.schemaVersion !== 1 || typeof ledger.families !== "object" || ledger.families === null || Array.isArray(ledger.families)) {
    fail(`${path} is not a schemaVersion 1 probe ledger; fix or remove it before planning`);
  }
  return ledger as Ledger;
}

/**
 * The ledger text after this plan's probes passed: one new entry per probed
 * family it lacked, keys sorted. The same text back when nothing is new, so
 * writing one plan twice leaves the ledger byte-identical.
 */
function recordProbes(text: string | null, path: string, plan: Plan, dir: string): string | null {
  const ledger = parseLedger(text, path);
  const fresh = plan.pairs.filter((pair) => !Object.hasOwn(ledger.families, familyKey(pair)));
  if (fresh.length === 0) return text;
  const verifiedAt = new Date().toISOString();
  const families: Record<string, LedgerEntry> = { ...ledger.families };
  for (const pair of fresh) {
    families[familyKey(pair)] = { family: pair.family, descriptor: pair.descriptor, verifiedAt, evidence: resolve(dir) };
  }
  const sorted = Object.fromEntries(Object.entries(families).sort(([a], [b]) => a.localeCompare(b)));
  return `${JSON.stringify({ schemaVersion: 1, families: sorted }, null, 2)}\n`;
}

// --- Plan ------------------------------------------------------------------

export interface NativeAgentProbe {
  readonly primitive: "Agent";
  readonly agent: string;
}

export interface NativeSpawnProbe {
  readonly primitive: "spawn_agent";
  readonly model: string;
  readonly reasoning_effort: string;
}

export interface NativeGrokProbe {
  readonly primitive: "spawn_subagent";
  readonly agent: string;
  readonly ownerAgent: string;
}

export type NativeProbe = NativeAgentProbe | NativeSpawnProbe | NativeGrokProbe;

export interface ProbePair {
  readonly family: string;
  readonly effort: string;
  /** `<family>@<effort>`, the operator-facing id of the pair (attest --pair, file names). */
  readonly pair: string;
  readonly provider: string;
  readonly model: string;
  readonly descriptor: string;
  readonly route: Route;
  /** How the parent probes this pair natively, or null when it goes through the runner. */
  readonly native: NativeProbe | null;
  /** The unique token the probe must echo back. */
  readonly marker: string;
}

export interface VerifiedFamily {
  readonly family: string;
  readonly provider: string;
  readonly model: string;
  readonly verifiedAt: string;
}

export interface OwnerProbe {
  readonly primitive: "spawn_subagent";
  readonly agent: "poteto-agent";
  readonly marker: string;
}

export const OWNER_PROBE_ID = "owner-nesting";

export interface Plan {
  readonly schemaVersion: 7;
  readonly parent: string;
  readonly createdAt: string;
  readonly sheetPath: string;
  readonly integrationPath: string;
  readonly ledgerPath: string;
  readonly firstRun: boolean;
  /** Distinct efforts per family present in the final map, families in matrix order, efforts in matrix order. Families outside the map are absent. */
  readonly efforts: Readonly<Record<string, readonly string[]>>;
  readonly rows: readonly SheetRow[];
  readonly sheet: string;
  /** One probe per family in the final map that this parent's ledger lacks, at the family's lowest effort in use, families in matrix order. */
  readonly pairs: readonly ProbePair[];
  /** Fresh Grok lifecycle capability, independent of the family ledger. */
  readonly ownerProbe: OwnerProbe | null;
  /** Families in the final map that this parent verified before; not probed again, whatever effort their lanes take. */
  readonly verified: readonly VerifiedFamily[];
  readonly migrations: readonly Migration[];
  /** Rows that are valid but can leave a run without a lane; show each to the operator before the write. */
  readonly warnings: readonly string[];
}

export interface PlanInput extends StateInput {
  /** Bulk rewrite: every lane of that family in the base rows takes this effort. */
  readonly efforts?: Readonly<Record<string, string>>;
  /** Named role changes (role label → lanes as written by the operator). Applied after the bulk rewrite. */
  readonly roles?: Readonly<Record<string, readonly string[]>>;
}

function nativeProbeFor(matrix: ModelMatrix, parent: string, family: Family, effort: string): ProbePair["native"] {
  if (routeFor(matrix, parent, family.provider) !== "native") return null;
  const primitive = matrix.parents[parent].nativePrimitive;
  if (primitive === "Agent" || primitive === "spawn_subagent") {
    const agent = agentName(family, effort);
    if (agent === null) fail(`${family.family} is native in ${parent} but has no agent stem`);
    if (primitive === "Agent") return { primitive, agent };
    const ownerAgent = ownerAgentName(family, effort);
    if (ownerAgent === null) fail(`${family.family} has no native owner agent`);
    return { primitive, agent, ownerAgent };
  }
  if (primitive === "spawn_agent") {
    return { primitive: "spawn_agent", model: family.model, reasoning_effort: effort };
  }
  fail(`no native probe shape for primitive ${primitive}`);
}

/**
 * Build the in-memory render for one parent: the role map (defaults on a first
 * run, the normalized loaded sheet on a rerun, missing documented roles filled
 * from the defaults), then --effort as a bulk rewrite of every lane of that
 * family, then the named role changes (each lane keeps the effort as written).
 * A family of the final map needs a probe only when the parent's ledger lacks
 * it. Nothing is written.
 */
export function buildPlan(input: PlanInput): Plan {
  const matrix = input.matrix ?? loadMatrix();
  const home = input.home ?? homedir();
  const env = input.env ?? {};
  const state = loadState({ parent: input.parent, home, env, matrix });
  const parent = state.parent;

  // 1. Role map: loaded rows overlay the complete documented role list.
  const loaded = new Map(state.rows.map((r) => [r.role, r.lanes] as const));
  let rows: SheetRow[] = matrix.roles.map((r) => ({
    role: r.role,
    lanes: [...(loaded.get(r.role) ?? roleDefault(matrix, r.role, parent))],
  }));

  // 2. --effort rewrites every lane of that family in the base rows. A family
  //    with no lane here is outside-map even if a later --role would add one.
  const requested = input.efforts ?? {};
  const derived = familyEfforts(rows, matrix);
  for (const [name, effort] of Object.entries(requested)) {
    const family = familyNamed(matrix, name);
    if (!family) fail(`unknown family ${name}`);
    if (!family.efforts.includes(effort)) {
      fail(`${name} does not select effort ${effort} (allowed: ${family.efforts.join(" ")})`);
    }
    if (derived[name].status === "outside-map") {
      fail(`${name} is outside the role map; nothing to rewrite. Write the effort in a role's descriptor (--role) or drop --effort ${name}`);
    }
  }
  rows = rows.map((row) => ({
    role: row.role,
    lanes: row.lanes.map((lane) => {
      const family = laneFamily(lane, matrix);
      if (!family || !(family.family in requested)) return lane;
      return `${family.provider}:${family.model}@${requested[family.family]}`;
    }),
  }));

  // 3. Named role changes overlay after the bulk rewrite; each lane keeps the
  //    effort as written (no migration here: the operator types current descriptors).
  const roleChanges = input.roles ?? {};
  for (const [role, lanes] of Object.entries(roleChanges)) {
    if (!matrix.roles.some((r) => r.role === role)) fail(`unknown role ${JSON.stringify(role)}`);
    if (lanes.length === 0) fail(`role ${JSON.stringify(role)} needs at least one lane`);
    const normalized = lanes.map((lane) => {
      const result = normalizeLane(lane, matrix);
      if (result.migratedFrom !== null) fail(`${JSON.stringify(lane)}: write the configured model, not a legacy descriptor`);
      return result.lane;
    });
    rows = rows.map((r) => (r.role === role ? { role, lanes: normalized } : r));
  }

  // 4. A cross-family pool must be able to yield a lane under this parent.
  const warnings: string[] = [];
  for (const row of rows) {
    if (roleNamed(matrix, row.role)?.selection !== "cross-family") continue;
    const problem = crossFamilyRowProblem(matrix, parent, row.role, row.lanes);
    if (problem !== null) fail(problem);
    const native = nativeProviderOf(matrix, parent);
    const others = [...new Set(row.lanes.map((lane) => parseDescriptor(lane)?.provider))].filter((p) => p !== native);
    if (others.length === 1) {
      warnings.push(`role ${JSON.stringify(row.role)} names one provider besides ${native} (${others[0]}): a run in which a ${others[0]} lane wrote has no eligible lane`);
    }
  }

  const sheet = renderSheetDocument(rows.map((r) => `${r.role}: ${r.lanes.join(", ")}`).join("\n"));
  const ledgerPath = ledgerPathFor(parent, home, env);
  const ledger = parseLedger(snapshotOf(ledgerPath, "probe ledger"), ledgerPath);
  const finalEfforts = familyEfforts(rows, matrix);
  const efforts: Record<string, readonly string[]> = {};
  const pairs: ProbePair[] = [];
  const verified: VerifiedFamily[] = [];
  for (const family of matrix.families) {
    const used = finalEfforts[family.family];
    if (used.status === "outside-map") continue;
    efforts[family.family] = used.efforts;
    const key = familyKey(family);
    if (Object.hasOwn(ledger.families, key)) {
      verified.push({ family: family.family, provider: family.provider, model: family.model, verifiedAt: ledger.families[key].verifiedAt });
      continue;
    }
    const effort = used.efforts[0];
    pairs.push({
      family: family.family,
      effort,
      pair: `${family.family}@${effort}`,
      provider: family.provider,
      model: family.model,
      descriptor: `${family.provider}:${family.model}@${effort}`,
      route: routeFor(matrix, parent, family.provider),
      native: nativeProbeFor(matrix, parent, family, effort),
      marker: `PSTACK-SETUP-${parent}-${family.family}-${effort}-${randomBytes(4).toString("hex")}`,
    });
  }

  return {
    schemaVersion: 7,
    parent,
    createdAt: new Date().toISOString(),
    sheetPath: state.sheetPath,
    integrationPath: state.integrationPath,
    ledgerPath,
    firstRun: state.source.kind === "first-run",
    efforts,
    rows,
    sheet,
    pairs,
    ownerProbe: parent === "grok" ? {
      primitive: "spawn_subagent", agent: "poteto-agent",
      marker: `PSTACK-OWNER-${randomBytes(8).toString("hex")}`,
    } : null,
    verified,
    migrations: state.migrations,
    warnings,
  };
}

// --- Pool pick ---------------------------------------------------------------

export interface PickInput extends StateInput {
  readonly role: string;
  /** Providers of the write lanes whose output is part of the result, besides the parent's own. */
  readonly executors?: readonly string[];
}

export interface PickResult extends CrossFamilyPick {
  readonly parent: string;
  readonly role: string;
  /** Where the row came from: the parent's sheet, or the role-table default when the sheet has no such row. */
  readonly source: "sheet" | "default";
  readonly lanes: readonly string[];
}

/**
 * Apply the cross-family selection rule to one list role of the parent's
 * sheet. A hand-edited alias in the row is skipped, never dispatched.
 */
export function pickLane(input: PickInput): PickResult {
  const matrix = input.matrix ?? loadMatrix();
  const state = loadState({ parent: input.parent, home: input.home, env: input.env, matrix });
  const role = roleNamed(matrix, input.role);
  if (!role) fail(`unknown role ${JSON.stringify(input.role)}`);
  const row = state.rows.find((r) => r.role === role.role);
  const lanes = row?.lanes ?? roleDefault(matrix, role.role, state.parent);
  return {
    parent: state.parent,
    role: role.role,
    source: row ? "sheet" : "default",
    lanes,
    ...pickCrossFamily(matrix, state.parent, lanes, input.executors ?? []),
  };
}

// --- Run directory ------------------------------------------------------------

export const PLAN_FILE = "plan.json";

export function savePlan(dir: string, plan: Plan): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, PLAN_FILE);
  writeFileSync(path, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
  return path;
}

export function loadPlan(dir: string): Plan {
  const path = join(dir, PLAN_FILE);
  if (!existsSync(path)) fail(`no ${PLAN_FILE} in ${dir}; run plan first`);
  const raw = JSON.parse(readFileSync(path, "utf8")) as Plan;
  if (raw.schemaVersion !== 7) {
    fail(`${path}: unsupported schemaVersion ${JSON.stringify(raw.schemaVersion)}; run plan again with this version of the script`);
  }
  return raw;
}

// --- Probes ----------------------------------------------------------------

export interface ExternalProbeResult {
  readonly family: string;
  readonly pair: string;
  readonly descriptor: string;
  readonly status: "passed" | "failed";
  readonly promptPath: string;
  readonly outputPath: string;
  readonly receiptPath: string;
  readonly detail: string;
}

export interface NativeProbeStatus {
  readonly family: string;
  readonly pair: string;
  readonly descriptor: string;
  readonly native: NativeProbe;
  readonly marker: string;
  readonly prompt: string;
  readonly evidencePath: string;
  readonly attested: boolean;
}

export interface ProbeSummary {
  readonly external: readonly ExternalProbeResult[];
  readonly native: readonly NativeProbeStatus[];
  readonly owner: (OwnerProbe & { readonly prompt: string; readonly evidencePath: string; readonly attested: boolean }) | null;
  /** Every runner pair passed. */
  readonly externalOk: boolean;
  /** Every runner pair passed and every native pair is attested. */
  readonly ok: boolean;
}

export interface ProbeOptions {
  readonly dir: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutSeconds?: number | null;
}

function probePaths(dir: string, pair: string): { prompt: string; output: string; receipt: string } {
  return {
    prompt: join(dir, `probe-${pair}.prompt.md`),
    output: join(dir, `probe-${pair}.output.md`),
    receipt: join(dir, `probe-${pair}.receipt.json`),
  };
}

function nativeEvidencePath(dir: string, pair: string): string {
  return join(dir, `native-${pair}.json`);
}

function probeLabel(pair: ProbePair): string {
  return `${pair.pair} (${pair.descriptor})`;
}

async function runLane(pair: ProbePair, plan: Plan, options: ProbeOptions): Promise<ExternalProbeResult> {
  const paths = probePaths(options.dir, pair.pair);
  const verdict = await runProbeLane({
    parent: plan.parent,
    provider: pair.provider,
    model: pair.model,
    effort: pair.effort,
    marker: pair.marker,
    cwd: options.dir,
    promptPath: paths.prompt,
    outputPath: paths.output,
    receiptPath: paths.receipt,
    env: options.env ?? process.env,
    timeoutSeconds: options.timeoutSeconds,
  });
  return {
    family: pair.family,
    pair: pair.pair,
    descriptor: pair.descriptor,
    status: verdict.passed ? "passed" : "failed",
    promptPath: paths.prompt,
    outputPath: paths.output,
    receiptPath: paths.receipt,
    detail: verdict.detail,
  };
}

function nativeStatus(
  plan: Plan,
  dir: string,
  pair: ProbePair,
  native: NativeProbe
): NativeProbeStatus {
  const evidencePath = nativeEvidencePath(dir, pair.pair);
  return {
    family: pair.family,
    pair: pair.pair,
    descriptor: pair.descriptor,
    native,
    marker: pair.marker,
    prompt: native.primitive === "spawn_subagent"
      ? `This is a read-only setup capability probe, not an autopilot program. Spawn exactly one ${native.agent} helper with the following prompt, drain it, then return its exact reply and child ID. Do not implement, run other workflows, or spawn other children.\n\n${probePrompt([pair.marker, plan.ownerProbe?.marker].filter(Boolean).join(" ")).trimEnd()}`
      : probePrompt(pair.marker).trimEnd(),
    evidencePath,
    attested: verifyNative(plan, dir, pair) === null,
  };
}

/**
 * Run every runner-route pair of the plan through the external runner, all at
 * once, each with its own prompt, output, and receipt under `dir`. Native
 * pairs are not run here (the parent's primitive is the skill's job); they are
 * listed with the prompt to send and whether `attest` has recorded them.
 */
export async function runProbes(plan: Plan, options: ProbeOptions): Promise<ProbeSummary> {
  mkdirSync(options.dir, { recursive: true });
  const runnerPairs = plan.pairs.filter((p) => p.route === "runner");
  for (const pair of runnerPairs) {
    const paths = probePaths(options.dir, pair.pair);
    for (const path of [paths.output, paths.receipt, `${paths.receipt}.stdout`, `${paths.receipt}.stderr`]) {
      try {
        lstatSync(path);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
        throw error;
      }
      fail(`${path} already exists; use a fresh run directory or remove the previous probe artifacts`);
    }
  }
  const external = await Promise.all(runnerPairs.map((pair) => runLane(pair, plan, options)));
  const native = plan.pairs.flatMap((p) => (p.native === null ? [] : [nativeStatus(plan, options.dir, p, p.native)]));
  const owner = plan.ownerProbe === null ? null : {
    ...plan.ownerProbe,
    prompt: `Execute only this read-only setup capability probe. Spawn exactly one poteto-agent helper with this prompt: ${probePrompt(plan.ownerProbe.marker).trimEnd()} Drain it and return its exact reply and child ID. Invoke no other workflows and change no files.`,
    evidencePath: nativeEvidencePath(options.dir, OWNER_PROBE_ID),
    attested: verifyOwner(plan, options.dir) === null,
  };
  const externalOk = external.every((r) => r.status === "passed");
  return { external, native, owner, externalOk, ok: externalOk && native.every((n) => n.attested) && (owner === null || owner.attested) };
}

interface NativeEvidence {
  readonly pair: string;
  readonly family: string;
  readonly descriptor: string;
  readonly native: NativeProbe;
  readonly marker: string;
  readonly observed: string;
  readonly chain?: NativeChain;
  readonly attestedAt: string;
}

export interface NativeChain {
  readonly ownerId: string;
  readonly childId: string;
}

function nativeChainProblem(chain: NativeChain | undefined): string | null {
  if (typeof chain?.ownerId !== "string" || !chain.ownerId.trim() ||
      typeof chain.childId !== "string" || !chain.childId.trim() || chain.ownerId === chain.childId) {
    return "Grok requires observed, distinct --owner-id and --child-id from an owner → helper probe; set [subagents] max_depth = 2 and restart the root before probing";
  }
  return null;
}

/** Record a native family or owner capability probe observed by this parent. */
export function attestNative(plan: Plan, dir: string, pairId: string, observed: string, chain?: NativeChain): string {
  if (pairId === OWNER_PROBE_ID) {
    if (plan.ownerProbe === null) fail("owner-nesting is only required on Grok");
    const problem = nativeChainProblem(chain);
    if (problem !== null) fail(problem);
    if (!observed.includes(plan.ownerProbe.marker)) fail("owner reply lacks this plan's fresh capability marker");
    mkdirSync(dir, { recursive: true });
    const path = nativeEvidencePath(dir, OWNER_PROBE_ID);
    writeFileSync(path, `${JSON.stringify({ marker: plan.ownerProbe.marker, observed, chain, attestedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
    return path;
  }
  const ids = plan.pairs.map((p) => p.pair).join(", ");
  const pair = plan.pairs.find((p) => p.pair === pairId);
  if (!pair) fail(`${pairId} is not a pair of this plan; pairs: ${ids}`);
  if (pair.native === null) fail(`${pairId} is not a native pair of this plan; it runs through the runner`);
  if (!observed.includes(pair.marker)) {
    fail(`observed reply for ${pairId} lacks the marker ${pair.marker}; the native probe did not pass`);
  }
  if (pair.native.primitive === "spawn_subagent") {
    const problem = nativeChainProblem(chain);
    if (problem !== null) fail(problem);
  } else if (chain !== undefined) {
    fail("owner/child IDs are only accepted for Grok native probes");
  }
  mkdirSync(dir, { recursive: true });
  const path = nativeEvidencePath(dir, pair.pair);
  const evidence: NativeEvidence = {
    pair: pair.pair,
    family: pair.family,
    descriptor: pair.descriptor,
    native: pair.native,
    marker: pair.marker,
    observed: observed.slice(0, 4_000),
    ...(chain === undefined ? {} : { chain }),
    attestedAt: new Date().toISOString(),
  };
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  return path;
}

function verifyNative(plan: Plan, dir: string, pair: ProbePair): string | null {
  const path = nativeEvidencePath(dir, pair.pair);
  const label = probeLabel(pair);
  if (!existsSync(path)) return `${label}: native probe not attested (${path} missing)`;
  let evidence: NativeEvidence;
  try {
    evidence = JSON.parse(readFileSync(path, "utf8")) as NativeEvidence;
  } catch (error) {
    return `${label}: native evidence is not JSON: ${(error as Error).message}`;
  }
  if (evidence.pair !== pair.pair || evidence.descriptor !== pair.descriptor || evidence.marker !== pair.marker) {
    return `${label}: native evidence is for ${evidence.pair} / ${evidence.descriptor} / ${evidence.marker}, plan asks ${pair.pair} / ${pair.descriptor} / ${pair.marker}`;
  }
  if (typeof evidence.observed !== "string" || !evidence.observed.includes(pair.marker)) {
    return `${label}: native evidence lacks the marker`;
  }
  if (pair.native?.primitive === "spawn_subagent") {
    const problem = nativeChainProblem(evidence.chain);
    if (problem !== null) return `${label}: ${problem}`;
  }
  return null;
}

function verifyOwner(plan: Plan, dir: string): string | null {
  if (plan.parent !== "grok") return null;
  if (!plan.ownerProbe?.marker) return "owner-nesting: missing capability probe; run plan again";
  const path = nativeEvidencePath(dir, OWNER_PROBE_ID);
  if (!existsSync(path)) return "owner-nesting: current root capability not attested";
  let evidence: { marker?: string; observed?: string; chain?: NativeChain };
  try { evidence = JSON.parse(readFileSync(path, "utf8")); }
  catch { return "owner-nesting: evidence is not JSON"; }
  if (evidence?.marker !== plan.ownerProbe.marker || typeof evidence.observed !== "string" || !evidence.observed.includes(plan.ownerProbe.marker)) {
    return "owner-nesting: evidence lacks this plan's fresh capability marker";
  }
  return nativeChainProblem(evidence.chain);
}

/** Every probe the plan requires (the families new to this parent) must have passed under `dir` before anything is written. */
export function verifyProbes(plan: Plan, dir: string): { readonly ok: boolean; readonly problems: readonly string[] } {
  const problems: string[] = [];
  const ownerProblem = verifyOwner(plan, dir);
  if (ownerProblem !== null) problems.push(ownerProblem);
  for (const pair of plan.pairs) {
    if (pair.route === "runner") {
      const paths = probePaths(dir, pair.pair);
      const verdict = judgeLane(pair, paths.receipt, paths.output);
      if (!verdict.passed) problems.push(`${probeLabel(pair)}: external probe ${verdict.detail}`);
    } else {
      const problem = verifyNative(plan, dir, pair);
      if (problem !== null) problems.push(problem);
    }
  }
  return { ok: problems.length === 0, problems };
}

// --- Write -----------------------------------------------------------------

function renderIntegration(where: Location, current: string | null, sheet: string): string {
  const text = current ?? "";
  if (where.wiring === "import") return placeImport(where, text).rendered;
  const separator = text.length === 0 || text.endsWith("\n") ? "" : "\n";
  const block = `${CODEX_BLOCK_BEGIN}\n${sheet}${CODEX_BLOCK_END}\n`;
  const found = findBlock(text, where.integrationPath);
  if (found === null) return `${text}${separator}${block}`;
  return `${text.slice(0, found.start)}${block}${text.slice(found.end).replace(/^\n/, "")}`;
}

export type WriteOutcome = "created" | "updated" | "unchanged";

export interface WriteResult {
  readonly sheetPath: string;
  readonly integrationPath: string;
  readonly ledgerPath: string;
  readonly sheet: WriteOutcome;
  readonly integration: WriteOutcome;
  readonly ledger: WriteOutcome;
}

/** Put a target back to its snapshot; a target whose bytes did not change is left alone. */
function restore(path: string, snapshot: string | null): void {
  const current = readIfExists(path);
  if (current === snapshot) return;
  if (snapshot === null) {
    unlinkSync(path);
  } else {
    writeFileSync(path, snapshot);
  }
}

/** Current bytes of a target, null when absent; a non-file at the path is inconsistent state. */
function snapshotOf(path: string, label: string): string | null {
  if (!existsSync(path)) return null;
  if (!statSync(path).isFile()) fail(`${label} ${path} exists but is not a regular file; resolve it before writing`);
  return readFileSync(path, "utf8");
}

export function writeSheet(plan: Plan, dir: string, options: { readonly home?: string; readonly env?: ConfigEnv } = {}): WriteResult {
  const where = locate(plan.parent, options.home ?? homedir(), options.env ?? {});
  const { sheetPath, integrationPath, ledgerPath } = where;
  if (plan.sheetPath !== sheetPath || plan.integrationPath !== integrationPath || plan.ledgerPath !== ledgerPath) {
    const variable = targetFor(plan.parent).variable;
    fail(`${join(dir, PLAN_FILE)} was made for the config home ${dirname(plan.sheetPath)}, but this write resolves ${where.configHome}; run write with the --home${variable === null ? "" : ` and ${variable.name}`} that plan used, or run plan again`);
  }

  const probes = verifyProbes(plan, dir);
  if (!probes.ok) {
    fail(`refusing to write: ${probes.problems.length} probe(s) not passed\n${probes.problems.map((p) => `  ${p}`).join("\n")}`);
  }

  const sheetBefore = snapshotOf(sheetPath, "sheet");
  const integrationBefore = snapshotOf(integrationPath, "integration file");
  const ledgerBefore = snapshotOf(ledgerPath, "probe ledger");
  const integrationAfter = renderIntegration(where, integrationBefore, plan.sheet);
  const ledgerAfter = recordProbes(ledgerBefore, ledgerPath, plan, dir);

  const targets = [
    { path: sheetPath, before: sheetBefore, after: plan.sheet },
    { path: integrationPath, before: integrationBefore, after: integrationAfter },
    { path: ledgerPath, before: ledgerBefore, after: ledgerAfter },
  ];
  const outcome = (before: string | null, after: string | null): WriteOutcome =>
    before === after ? "unchanged" : before === null ? "created" : "updated";
  const result: WriteResult = {
    sheetPath,
    integrationPath,
    ledgerPath,
    sheet: outcome(sheetBefore, plan.sheet),
    integration: outcome(integrationBefore, integrationAfter),
    ledger: outcome(ledgerBefore, ledgerAfter),
  };

  try {
    for (const { path, before, after } of targets) {
      if (after === null || after === before) continue;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, after, { mode: 0o600 });
    }
    for (const { path, after } of targets) {
      if (after !== null && readFileSync(path, "utf8") !== after) throw new Error(`${path} read back differs from the render`);
    }
  } catch (error) {
    const failures: string[] = [];
    for (const { path, before } of targets) {
      try {
        restore(path, before);
      } catch (restoreError) {
        failures.push(`${path}: ${(restoreError as Error).message}`);
      }
    }
    const tail = failures.length === 0 ? "every snapshot restored" : `snapshot restore failed for ${failures.join("; ")}`;
    fail(`write failed (${(error as Error).message}); ${tail}`);
  }
  return result;
}

// --- Command line ---------------------------------------------------------------

const USAGE = `Usage: setup-pstack <state|plan|probe|attest|write|pick> [options]

  state  --parent <${Object.keys(TARGETS).join("|")}> [--home <dir>]
         Read the parent's sheet, normalize rolling aliases, derive per-lane efforts grouped by family.
  plan   --parent <p> [--home <dir>] [--dir <run dir>]
         [--effort <family>=<effort>]... [--role "<label>=<lane>[, <lane>]"]...
         Render the new sheet in memory and save plan.json (creates a run dir when --dir is omitted).
         --effort rewrites every lane of that family; --role overlays after, each lane keeping its effort.
  probe  --dir <run dir> [--timeout <seconds>]
         Run the plan's external probes (families new to this parent) through the runner;
         list native probes to attest. A plan whose families are all verified has none.
  attest --dir <run dir> --pair <family>@<effort> --observed <reply text>
         Record a native one-turn probe whose reply carries the pair's marker.
         Grok also requires --owner-id <id> --child-id <id> from its nested probe.
         --pair owner-nesting attests the fresh Grok capability, even with no new families.
  write  --dir <run dir> [--home <dir>]
         Verify the plan's probes, then write the sheet, the parent integration, and the probe
         ledger (byte-identical rerun writes nothing).
  pick   --parent <p> --role "<pool role>" [--executor <provider>]... [--home <dir>]
         From the role's row, list the lanes whose provider wrote none of the work, in the
         operator's order. The parent's own provider always counts as a writer; name every
         other provider that wrote with --executor. Exit 1 when no lane is eligible.

The sheet, the ledger and the integration live in the parent's config home: CLAUDE_CONFIG_DIR
(claude) or CODEX_HOME (codex), an absolute path, else <home>/.claude, <home>/.codex, <home>/.grok.
An empty CODEX_HOME counts as unset. An empty CLAUDE_CONFIG_DIR stops state, plan, write and
pick for the claude parent.

Exit codes: 0 ok, 1 a probe failed, the write was refused, or no lane is eligible, 64 usage.
`;

interface Io {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
  readonly env?: ConfigEnv;
}

class CliUsageError extends Error {}

function usage(message: string): never {
  throw new CliUsageError(message);
}

function parseAssignments(values: readonly string[] | undefined, flag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const value of values ?? []) {
    const eq = value.indexOf("=");
    if (eq <= 0 || eq === value.length - 1) usage(`${flag} expects <name>=<value>, got ${JSON.stringify(value)}`);
    out[value.slice(0, eq).trim()] = value.slice(eq + 1).trim();
  }
  return out;
}

function parseRoleChanges(values: readonly string[] | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [role, lanes] of Object.entries(parseAssignments(values, "--role"))) {
    out[role] = lanes.split(",").map((l) => l.trim()).filter((l) => l.length > 0);
  }
  return out;
}

export async function main(argv: readonly string[], io: Io = {
  stdout: (v) => process.stdout.write(v),
  stderr: (v) => process.stderr.write(v),
  env: process.env,
}): Promise<number> {
  try {
    const { parseArgs } = await import("node:util");
    let parsed: ReturnType<typeof parseArgs>;
    try {
      parsed = parseArgs({
        args: [...argv],
        allowPositionals: true,
        strict: true,
        options: {
          parent: { type: "string" },
          home: { type: "string" },
          dir: { type: "string" },
          effort: { type: "string", multiple: true },
          role: { type: "string", multiple: true },
          pair: { type: "string" },
          executor: { type: "string", multiple: true },
          observed: { type: "string" },
          "owner-id": { type: "string" },
          "child-id": { type: "string" },
          timeout: { type: "string" },
          help: { type: "boolean", short: "h", default: false },
        },
      });
    } catch (error) {
      usage(error instanceof Error ? error.message : String(error));
    }
    if (parsed.values.help) {
      io.stdout(USAGE);
      return 0;
    }
    const [command, ...rest] = parsed.positionals;
    if (rest.length > 0) usage(`unexpected arguments: ${rest.join(" ")}`);
    const home = typeof parsed.values.home === "string" ? parsed.values.home : homedir();
    const env = io.env ?? {};
    const requireParent = (): string => {
      const parent = parsed.values.parent;
      if (typeof parent !== "string") usage("--parent is required");
      return parent;
    };
    const requireDir = (): string => {
      const dir = parsed.values.dir;
      if (typeof dir !== "string") usage("--dir is required");
      return dir;
    };
    const emit = (value: unknown): void => io.stdout(`${JSON.stringify(value, null, 2)}\n`);

    switch (command) {
      case "state": {
        emit(loadState({ parent: requireParent(), home, env }));
        return 0;
      }
      case "plan": {
        const plan = buildPlan({
          parent: requireParent(),
          home,
          env,
          efforts: parseAssignments(parsed.values.effort as string[] | undefined, "--effort"),
          roles: parseRoleChanges(parsed.values.role as string[] | undefined),
        });
        const dir = typeof parsed.values.dir === "string" ? parsed.values.dir : mkdtempSync(join(tmpdir(), "pstack-setup-"));
        savePlan(dir, plan);
        emit({ dir, ...plan });
        return 0;
      }
      case "probe": {
        const dir = requireDir();
        const timeoutValue = parsed.values.timeout;
        const timeoutSeconds = typeof timeoutValue === "string" ? Number(timeoutValue) : null;
        if (timeoutSeconds !== null && (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)) {
          usage("--timeout must be a number greater than zero");
        }
        const plan = loadPlan(dir);
        const summary = await runProbes(plan, { dir, timeoutSeconds });
        emit(summary);
        return summary.externalOk ? 0 : 1;
      }
      case "attest": {
        const dir = requireDir();
        const pair = parsed.values.pair;
        const observed = parsed.values.observed;
        if (typeof pair !== "string") usage("--pair is required");
        if (typeof observed !== "string") usage("--observed is required");
        const plan = loadPlan(dir);
        const ownerId = parsed.values["owner-id"];
        const childId = parsed.values["child-id"];
        if ((ownerId === undefined) !== (childId === undefined)) usage("--owner-id and --child-id must be supplied together");
        const chain = typeof ownerId === "string" && typeof childId === "string" ? { ownerId, childId } : undefined;
        const path = attestNative(plan, dir, pair, observed, chain);
        emit({ pair, evidencePath: path, remaining: verifyProbes(plan, dir).problems });
        return 0;
      }
      case "write": {
        const dir = requireDir();
        const plan = loadPlan(dir);
        emit(writeSheet(plan, dir, { home, env }));
        return 0;
      }
      case "pick": {
        const role = parsed.values.role as string[] | undefined;
        if (role?.length !== 1) usage("--role is required once: the label of the pool role");
        const executors = ((parsed.values.executor as string[] | undefined) ?? [])
          .flatMap((value) => value.split(","))
          .map((value) => value.trim())
          .filter((value) => value.length > 0);
        const result = pickLane({ parent: requireParent(), home, env, role: role[0], executors });
        emit(result);
        return result.chosen === null ? 1 : 0;
      }
      case undefined:
        usage("a subcommand is required");
      // falls through
      default:
        usage(`unknown subcommand ${JSON.stringify(command)}`);
    }
  } catch (error) {
    if (error instanceof CliUsageError) {
      io.stderr(`error: ${error.message}\n${USAGE}`);
      return 64;
    }
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`error: ${message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exitCode = await main(process.argv.slice(2));
}
