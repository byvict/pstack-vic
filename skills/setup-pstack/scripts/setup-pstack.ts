#!/usr/bin/env node
// Deterministic half of /setup-pstack (pstack-vic, fase 6). The skill's prose
// owns the conversation (which parent, requested efforts, named role changes,
// confirmation) and the native one-turn probes; this script owns everything
// that must be exact: reading and normalizing the current sheet, rendering the
// new one from model-matrix.json, running the external probes through the
// runner, refusing to write while any probe is missing, and the snapshot /
// write / read-back / restore of the sheet and the probe ledger. The sheet is
// plugin data and lives in the plugin's data folder, which the host deletes
// when the plugin is uninstalled (`dataHomeFor`): no instruction file loads it,
// so disabling the plugin disables it. Versions before 0.6.0 kept the sheet and
// the ledger in the parent's config home, and versions before 0.5.32 also wired
// the sheet into CLAUDE.md or AGENTS.md; `write` and `unwire` move those files
// into the data folder and remove that wiring. Effort belongs to the lane, not the family: two lanes of one
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
//                          [--swarm-fallback <native-descriptor|off>]
//   setup-pstack.ts probe  --dir <run dir> [--timeout <seconds>]
//   setup-pstack.ts attest --dir <run dir> --pair <family>@<effort> --observed <text>
//   setup-pstack.ts write  --dir <run dir> [--home <dir>]
//   setup-pstack.ts pick   --parent <p> --role "<pool role>" [--executor <provider>]... [--home <dir>]
//   setup-pstack.ts roles  --parent <p> [--home <dir>]
//   setup-pstack.ts unwire --parent <p> [--home <dir>]
//
// `roles` and `pick` are the subcommands a skill calls at dispatch time.
// `roles` resolves every role to its lanes. `pick` applies the Cross-family
// selection rule of provider-dispatch.md to a pool row, so the session whose
// work is under review does not choose its own reviewer.
//
// Node 24, type stripping, no dependencies: erasable TypeScript only.

import { randomBytes } from "node:crypto";
import { accessSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
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
  /** The instruction file where versions before 0.5.32 wired the sheet. Setup only reads and removes that wiring now. */
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
/** The folder name Claude Code gives `pstack@pstack-vic` under `plugins/data/` (`${CLAUDE_PLUGIN_DATA}`); Codex gets the same name under its own `plugins/data/`. */
export const PLUGIN_DATA_DIR = "pstack-pstack-vic";
/** The wiring versions before 0.5.32 wrote: this import in CLAUDE.md, or the block between the markers in AGENTS.md. */
export const CLAUDE_INCLUDE_LINE = "@~/.claude/pstack-models.md";
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

/**
 * The plugin's data folder for a parent: the folder the host deletes with the
 * plugin. Claude Code deletes `<config home>/plugins/data/pstack-pstack-vic`
 * when the last install record goes (measured on 2.1.296). Grok Build runs the
 * plugin Claude Code installed, so its data sits in a `grok` folder inside
 * Claude Code's. Codex keeps plugin data under its own `plugins/data/` and does
 * not delete it on `plugin remove` (measured on 0.162.1), so
 * `scripts/pstack.ts uninstall` deletes it.
 */
export function dataHomeFor(parent: string, home: string = homedir(), env: ConfigEnv = {}): string {
  targetFor(parent);
  if (parent === "codex") return join(configHomeFor("codex", home, env), "plugins", "data", PLUGIN_DATA_DIR);
  const claude = join(configHomeFor("claude", home, env), "plugins", "data", PLUGIN_DATA_DIR);
  return parent === "grok" ? join(claude, "grok") : claude;
}

interface Location {
  readonly parent: string;
  readonly home: string;
  readonly configHome: string;
  readonly sheetPath: string;
  readonly integrationPath: string;
  readonly ledgerPath: string;
  /** Where versions before 0.6.0 kept the global sheet and ledger: the config home. Null for a Codex project source. */
  readonly legacySheetPath: string | null;
  readonly legacyLedgerPath: string | null;
  readonly wiring: Target["wiring"];
  readonly readSource?: boolean;
}

interface SourceContext {
  readonly cwd?: string;
  /** Complete loaded instruction chain, global first. Overrides default discovery. */
  readonly instructionSources?: readonly string[];
}

function instructionFile(directory: string, skipEmpty = false): string | null {
  for (const name of ["AGENTS.override.md", "AGENTS.md"]) {
    const path = join(directory, name);
    const text = snapshotOf(path, "instruction file");
    if (text !== null && (!skipEmpty || text.trim() !== "")) return path;
  }
  return null;
}

function projectDirectories(cwd: string): string[] {
  const directories = [resolve(cwd)];
  let directory = directories[0];
  while (!existsSync(join(directory, ".git"))) {
    const parent = dirname(directory);
    if (parent === directory) return [directories[0]];
    directory = parent;
    directories.push(directory);
  }
  return directories.reverse();
}

/** Explicit pstack reference, not a Codex @ import or an arbitrary prose mention. */
function referencedSheet(text: string, path: string, home: string): string | null {
  let fence: string | null = null;
  const prose = text.replace(FRONT_MATTER_RE, "").split("\n").filter((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker !== undefined) {
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      return false;
    }
    return fence === null;
  }).join("\n");
  const references = [...prose.matchAll(/^pstack-models: (?:<([^>\n]+)>|([^\n]+))[ \t]*$/gm)];
  if (references.length > 1) fail(`${path} has multiple pstack-models references; expected one`);
  const reference = references[0];
  if (!reference) return null;
  const target = (reference[1] ?? reference[2]).trim();
  if (target === "") fail(`${path} has an empty pstack-models reference`);
  if (target.startsWith("~/")) return resolve(home, target.slice(2));
  return resolve(dirname(path), target);
}

function locate(parent: string, home: string, env: ConfigEnv, context: SourceContext = {}): Location {
  const target = targetFor(parent);
  const configHome = configHomeFor(parent, home, env);
  const data = dataHomeFor(parent, home, env);
  const global: Location = {
    parent,
    home,
    configHome,
    sheetPath: join(data, SHEET_FILE),
    integrationPath: join(configHome, target.integration),
    ledgerPath: join(data, LEDGER_FILE),
    legacySheetPath: join(configHome, SHEET_FILE),
    legacyLedgerPath: join(configHome, LEDGER_FILE),
    wiring: target.wiring,
  };
  if (parent !== "codex") {
    if (context.instructionSources !== undefined) fail("instructionSources is only supported for the codex parent");
    return global;
  }

  const project = (integrationPath: string, sheetPath: string): Location =>
    ({ ...global, sheetPath, integrationPath, ledgerPath: join(dirname(sheetPath), LEDGER_FILE), legacySheetPath: null, legacyLedgerPath: null });
  const directories = projectDirectories(context.cwd ?? process.cwd());
  // Local standalone sheets retain setup's recovery contract. An explicit chain
  // restricts recovery to its directories, including custom runtime filenames.
  const candidates = context.instructionSources === undefined
    ? [...new Set([configHome, ...directories])].map((directory) => ({ directory, path: undefined }))
    : context.instructionSources.map((source) => {
      const path = resolve(source);
      return { directory: dirname(path), path };
    });
  for (const candidate of [...candidates].reverse()) {
    const { directory } = candidate;
    const isGlobal = directory === configHome;
    const path = candidate.path === undefined ? instructionFile(directory, isGlobal) : candidate.path;
    const integrationPath = path ?? join(directory, "AGENTS.md");
    const integration = snapshotOf(integrationPath, "instruction file");
    if (path !== null && integration === null) fail(`loaded instruction source ${path} does not exist`);
    const reference = referencedSheet(integration ?? "", integrationPath, home);
    const block = findBlock(integration ?? "", integrationPath);
    if (reference !== null && !existsSync(reference)) fail(`${integrationPath} references missing model sheet ${reference}`);
    if (reference !== null) return project(integrationPath, reference);
    // The folder whose .codex is the config home (the user's home) holds the global sheet, not a project one.
    if (isGlobal || join(directory, ".codex") === configHome) {
      if (block !== null || (isGlobal && (existsSync(global.sheetPath) || existsSync(global.legacySheetPath ?? "")))) return { ...global, integrationPath };
      continue;
    }
    const sheetPath = join(directory, ".codex", SHEET_FILE);
    if (block !== null || existsSync(sheetPath)) return project(integrationPath, sheetPath);
  }
  if (context.instructionSources !== undefined) {
    const last = context.instructionSources.at(-1);
    if (last === undefined) return { ...global, readSource: false };
    const integrationPath = resolve(last);
    const directory = dirname(integrationPath);
    if (directory === configHome || join(directory, ".codex") === configHome) return { ...global, integrationPath };
    return project(integrationPath, join(directory, ".codex", SHEET_FILE));
  }
  // First-run global setup still uses the instruction file Codex would load.
  return { ...global, integrationPath: instructionFile(configHome, true) ?? global.integrationPath };
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

function pathTarget(run: string): string | null {
  const path = run.split("#")[0].replaceAll("\\ ", " ");
  const accepted = path.startsWith("./") || path.startsWith("~/") || (path.startsWith("/") && path !== "/")
    || (!path.startsWith("@") && !/^[#%^&*()]+/.test(path) && /^[a-zA-Z0-9._-]/.test(path));
  return accepted ? path : null;
}

function wordVerdict(text: string, at: number, tokenStart: boolean): Verdict {
  if (RUN_BEFORE_RE.test(text.slice(0, at))) return unsure(WORD);
  const run = pathRun(text, at + 1);
  const before = text[at - 1] ?? "";
  if (tokenStart || before === "" || /\s/.test(before)) {
    if (PATH_MARKUP_RE.test(run.split("#")[0])) return unsure(MARKUP);
    const target = pathTarget(run);
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
    const target = pathTarget(run);
    if (target !== null && (basename(target) === SHEET_FILE || !PATH_MARKUP_RE.test(target))) return { kind: "loaded", target, run };
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
    let tokenEnd = from;
    for (const at of this.mentions) {
      if (at < from || at >= to || this.verdicts.has(at)) continue;
      const result = at < tokenEnd ? SKIPPED : verdict(at);
      this.verdicts.set(at, result);
      if (result.kind === "loaded" && !PATH_MARKUP_RE.test(result.target)) tokenEnd = at + 1 + result.run.length;
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
        const target = pathTarget(run);
        if (target === null || basename(target) !== SHEET_FILE) continue;
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
    if (verdict.kind === "loaded" && basename(verdict.target) === SHEET_FILE) imports.push({ line: lineOf(text, at), start, end: start + 1 + verdict.run.length, target: verdict.target });
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

/** The one sheet import Claude Code loads from this CLAUDE.md, or null; anything less certain stops. */
function currentImport(path: string, text: string): SheetImport | null {
  const scan = scanSheetImports(text);
  if (scan.unsure.length > 0) {
    fail(`inconsistent state: ${path} line ${scan.unsure[0].line} mentions an import of ${SHEET_FILE} that this script cannot read the way Claude Code does (${scan.unsure[0].reason}); remove the mention`);
  }
  if (scan.imports.length > 1) tooManyImports(path, scan.imports);
  return scan.imports[0] ?? null;
}

const LINE_BREAK_RE = /\r\n|\n|\r/g;
const EMPTY_LINE_RE = /^[ \t]*(?:(?:[-*+>]|\d{1,9}[.)])[ \t]*)?$/;
const INDENTED_LINE_RE = /^(?: {4}|\t)[ \t]*\S/;
const PARAGRAPH_BREAK_RE = /^(?:[ \t]*| {0,3}#{1,6}(?:[ \t].*)?)$/;

/**
 * Remove the import that earlier versions wrote and keep every other byte. The
 * import's line goes whole when nothing but a list or quote marker would stay on
 * it. When that line opens a paragraph and the next line is indented, removing
 * it would turn the next line into a code block, which Claude Code reads
 * differently, so that removal stops instead.
 */
function withoutImport(path: string, text: string, current: SheetImport): string {
  const { top } = bodyStart(text);
  const lineStart = Math.max(text.lastIndexOf("\n", current.start - 1) + 1, text.lastIndexOf("\r", current.start - 1) + 1, top);
  LINE_BREAK_RE.lastIndex = current.end;
  const lineBreak = LINE_BREAK_RE.exec(text);
  const lineEnd = lineBreak === null ? text.length : lineBreak.index;
  const rest = text.slice(lineStart, current.start) + text.slice(current.end, lineEnd);
  if (!EMPTY_LINE_RE.test(rest)) return text.slice(0, current.start) + text.slice(current.end);
  const after = text.slice(lineBreak === null ? text.length : lineBreak.index + lineBreak[0].length);
  const previous = text.slice(top, lineStart).replace(/(?:\r\n|\n|\r)$/, "").split(/\r\n|\n|\r/).at(-1) ?? "";
  if (PARAGRAPH_BREAK_RE.test(previous) && INDENTED_LINE_RE.test(after)) {
    fail(`inconsistent state: removing the import on line ${current.line} of ${path} would turn the indented line after it into a code block; remove the import by hand`);
  }
  return text.slice(0, lineStart) + after;
}

/** The instruction file without the sheet wiring that versions before 0.5.32 wrote into it. */
function unwireIntegration(where: Location, text: string): string {
  if (where.wiring === "import") {
    const current = currentImport(where.integrationPath, text);
    return current === null ? text : withoutImport(where.integrationPath, text, current);
  }
  const found = findBlock(text, where.integrationPath);
  if (found === null) return text;
  return `${text.slice(0, found.start)}${text.slice(found.end).replace(/^\r?\n/, "")}`;
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
  return { start, end: stop + CODEX_BLOCK_END.length, sheet: text.slice(start + CODEX_BLOCK_BEGIN.length, stop).replace(/^\r?\n/, "") };
}

// --- Sheet parsing -----------------------------------------------------------

export interface SheetRow {
  readonly role: string;
  readonly lanes: readonly string[];
}

const SWARM_FALLBACK = "swarm fallback";
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
 * The role rows and optional swarm fallback: `label: lane[, lane]`. Title, blank lines, and
 * prose are skipped. Lanes are returned as written (see normalizeLane).
 */
export function parseSheet(text: string, matrix: ModelMatrix): SheetRow[] {
  const known = new Set([...matrix.roles.map((r) => r.role), SWARM_FALLBACK]);
  const rows: SheetRow[] = [];
  const seen = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (line.length === 0 || line.startsWith("#")) continue;
    const match = ROW_RE.exec(line);
    if (!match && line.startsWith(`${SWARM_FALLBACK}:`)) {
      fail(`${SWARM_FALLBACK} needs exactly one provider-qualified descriptor; remove the row to disable it`);
    }
    if (!match) continue;
    const [, role, value] = match;
    if (!known.has(role)) {
      if (RETIRED_CONVERGE_ROLES.has(role)) continue;
      fail(`unknown role ${JSON.stringify(role)} in sheet line ${JSON.stringify(line)}`);
    }
    if (seen.has(role)) fail(`duplicate role ${JSON.stringify(role)} in sheet`);
    seen.add(role);
    const lanes = value.split(",").map((v) => v.trim()).filter((v) => v.length > 0);
    if (role === SWARM_FALLBACK && (lanes.length !== 1 || value.includes(","))) {
      fail(`${SWARM_FALLBACK} needs exactly one provider-qualified descriptor`);
    }
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

function validateSwarmFallback(rows: readonly SheetRow[], matrix: ModelMatrix, parent: string): void {
  const row = rows.find((r) => r.role === SWARM_FALLBACK);
  if (row === undefined) return;
  const [lane] = row.lanes;
  const descriptor = lane === undefined ? null : parseDescriptor(lane);
  if (row.lanes.length !== 1 || descriptor === null) {
    fail(`${SWARM_FALLBACK} needs exactly one provider-qualified descriptor; aliases are not allowed`);
  }
  const native = nativeProviderOf(matrix, parent);
  if (descriptor.provider !== native) {
    fail(`${SWARM_FALLBACK} must use ${native}, the native provider of ${parent}; got ${descriptor.provider}`);
  }
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
  /** The sheet a version before 0.6.0 kept in the config home; `write` and `unwire` move it into the data folder. */
  | { readonly kind: "legacy"; readonly path: string }
  | { readonly kind: "import"; readonly path: string }
  | { readonly kind: "block"; readonly path: string }
  | { readonly kind: "first-run" };

export interface State {
  readonly parent: string;
  readonly configHome: string;
  readonly sheetPath: string;
  readonly integrationPath: string;
  readonly ledgerPath: string;
  readonly exists: boolean;
  readonly source: SheetSource;
  readonly missingImport: string | null;
  /** The instruction file that still carries wiring from a version before 0.5.32; `write` and `unwire` remove it. */
  readonly legacyWiring: string | null;
  /** Files a version before 0.6.0 left in the config home (sheet, ledger); `write` and `unwire` move them into the data folder. */
  readonly legacyFiles: readonly string[];
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

interface Selected {
  readonly loaded: Loaded | null;
  readonly missingImport: string | null;
  /** The instruction file still carries wiring from a version before 0.5.32. */
  readonly wired: boolean;
}

function selectSource(where: Location, matrix: ModelMatrix): Selected {
  if (where.readSource === false) return { loaded: null, missingImport: null, wired: false };
  if (existsSync(where.configHome) && !statSync(where.configHome).isDirectory()) {
    const variable = targetFor(where.parent).variable;
    fail(`inconsistent state: the config home ${where.configHome} is a file, not a directory; move it aside${variable === null ? "" : ` or point ${variable.name} at a directory`}`);
  }
  const sheetText = snapshotOf(where.sheetPath, "sheet");
  // Once the data folder holds the sheet, a leftover legacy file is not read: `write` and `unwire` delete it.
  const legacyText = sheetText === null && where.legacySheetPath !== null ? snapshotOf(where.legacySheetPath, "sheet") : null;
  const integration = snapshotOf(where.integrationPath, "integration file") ?? "";
  const sheet: Loaded | null = sheetText !== null
    ? { source: { kind: "sheet", path: where.sheetPath }, text: sheetText }
    : legacyText !== null && where.legacySheetPath !== null ? { source: { kind: "legacy", path: where.legacySheetPath }, text: legacyText } : null;
  let other: Loaded | null = null;
  let missingImport: string | null = null;
  let wired = false;
  if (where.wiring === "import") {
    const current = currentImport(where.integrationPath, integration);
    if (current !== null) {
      wired = true;
      withoutImport(where.integrationPath, integration, current);
      const target = importTarget(current.target, where);
      const text = target === sheet?.source.path ? sheet.text : snapshotOf(target, "imported sheet");
      if (text === null) missingImport = target;
      else if (target !== sheet?.source.path) other = { source: { kind: "import", path: target }, text };
    }
  } else {
    const block = findBlock(integration, where.integrationPath);
    if (block !== null) {
      wired = true;
      other = { source: { kind: "block", path: where.integrationPath }, text: block.sheet };
    }
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
        : "delete the sheet to carry the imported one over, or remove the import to keep the sheet";
      fail(`inconsistent state: ${describeSource(sheet.source, where)} and ${describeSource(other.source, where)} assign different lanes to ${differences.join(", ")}; ${keep}`);
    }
  }
  return { loaded: sheet ?? other, missingImport, wired };
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

export interface StateInput extends SourceContext {
  readonly parent: string;
  readonly home?: string;
  readonly env?: ConfigEnv;
  readonly matrix?: ModelMatrix;
}

function legacyFiles(where: Location): string[] {
  return [where.legacySheetPath, where.legacyLedgerPath].filter((path): path is string => path !== null && snapshotOf(path, "legacy file") !== null);
}

/** The ledger as the data folder holds it, else as a version before 0.6.0 left it in the config home. */
function ledgerSnapshot(where: Pick<Location, "ledgerPath" | "legacyLedgerPath">): { readonly path: string; readonly text: string | null } {
  const text = snapshotOf(where.ledgerPath, "probe ledger");
  if (text !== null || where.legacyLedgerPath === null) return { path: where.ledgerPath, text };
  return { path: where.legacyLedgerPath, text: snapshotOf(where.legacyLedgerPath, "probe ledger") };
}

export function loadState(input: StateInput): State {
  const matrix = input.matrix ?? loadMatrix();
  const parent = input.parent;
  if (!(parent in matrix.parents)) fail(`unknown parent ${JSON.stringify(parent)}; expected one of ${Object.keys(matrix.parents).join(", ")}`);
  const where = locate(parent, input.home ?? homedir(), input.env ?? {}, input);
  const { loaded, missingImport, wired } = selectSource(where, matrix);
  const located = {
    parent,
    configHome: where.configHome,
    sheetPath: where.sheetPath,
    integrationPath: where.integrationPath,
    ledgerPath: where.ledgerPath,
    exists: loaded?.source.kind === "sheet",
    source: loaded?.source ?? { kind: "first-run" as const },
    missingImport,
    legacyWiring: wired ? where.integrationPath : null,
    legacyFiles: legacyFiles(where),
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
  validateSwarmFallback(rows, matrix, parent);
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
  readonly sourceContext?: SourceContext;
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
  /** Omitted preserves the optional row; null removes it; a descriptor enables it. */
  readonly swarmFallback?: string | null;
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

function externalNetworkWarning(parent: string, env: ConfigEnv, selected: Readonly<Record<string, EffortState>>, matrix: ModelMatrix): string | null {
  if (parent !== "codex" || env.CODEX_SANDBOX_NETWORK_DISABLED !== "1") return null;
  const external = matrix.families.filter((family) => selected[family.family].status !== "outside-map"
    && routeFor(matrix, parent, family.provider) === "runner");
  if (external.length === 0) return null;
  const names = external.map((family) => `${family.family[0].toUpperCase()}${family.family.slice(1)} (${family.provider}:${family.model})`);
  return `Codex parent sandbox has network disabled (CODEX_SANDBOX_NETWORK_DISABLED=1); cannot probe external families: ${names.join(", ")}; restart the parent with the needed permission or move affected roles to allowed native families; see provider-dispatch.md#host-and-parent-prerequisites`;
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
  const state = loadState({ ...input, home, env, matrix });
  const parent = state.parent;

  // 1. Role map: loaded rows overlay the complete documented role list.
  const loaded = new Map(state.rows.map((r) => [r.role, r.lanes] as const));
  let rows: SheetRow[] = matrix.roles.map((r) => ({
    role: r.role,
    lanes: [...(loaded.get(r.role) ?? roleDefault(matrix, r.role, parent))],
  }));
  const fallback = state.rows.find((r) => r.role === SWARM_FALLBACK);
  if (fallback !== undefined) rows.push(fallback);

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

  if (input.swarmFallback !== undefined) {
    rows = rows.filter((r) => r.role !== SWARM_FALLBACK);
    if (input.swarmFallback !== null) {
      const result = normalizeLane(input.swarmFallback, matrix);
      if (result.migratedFrom !== null) fail(`${JSON.stringify(input.swarmFallback)}: write the configured model, not a legacy descriptor`);
      rows.push({ role: SWARM_FALLBACK, lanes: [result.lane] });
    }
  }
  validateSwarmFallback(rows, matrix, parent);

  // 4. A cross-family pool must be able to yield a lane under this parent.
  const warnings: string[] = [];
  for (const row of rows) {
    if (roleNamed(matrix, row.role)?.selection !== "cross-family") continue;
    const problem = crossFamilyRowProblem(matrix, parent, row.role, row.lanes);
    if (problem !== null) fail(problem);
    if (row.role === "trail reviewer pool") continue;
    const native = nativeProviderOf(matrix, parent);
    const others = [...new Set(row.lanes.map((lane) => parseDescriptor(lane)?.provider))].filter((p) => p !== native);
    if (others.length === 1) {
      warnings.push(`role ${JSON.stringify(row.role)} names one provider besides ${native} (${others[0]}): a run in which a ${others[0]} lane wrote has no eligible lane`);
    }
  }

  const sheet = renderSheetDocument(rows.map((r) => `${r.role}: ${r.lanes.join(", ")}`).join("\n"));
  const ledgerPath = state.ledgerPath;
  const stored = ledgerSnapshot(locate(parent, home, env, input));
  const ledger = parseLedger(stored.text, stored.path);
  const finalEfforts = familyEfforts(rows, matrix);
  const networkWarning = externalNetworkWarning(parent, env, finalEfforts, matrix);
  if (networkWarning !== null) warnings.push(networkWarning);
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
    sourceContext: { cwd: resolve(input.cwd ?? process.cwd()), instructionSources: input.instructionSources?.map((path) => resolve(path)) },
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
  /** Additional author providers to exclude for Arena; trail review excludes only the root. */
  readonly executors?: readonly string[];
}

export interface PickResult extends CrossFamilyPick {
  readonly parent: string;
  readonly role: string;
  /** Where the row came from: the parent's sheet, or the role-table default when the sheet has no such row. */
  readonly source: "sheet" | "default";
  readonly configurationSource: SheetSource;
  readonly sheetPath: string;
  readonly integrationPath: string;
  readonly lanes: readonly string[];
}

/**
 * Apply the cross-family selection rule to one list role of the parent's
 * sheet. A hand-edited alias in the row is skipped, never dispatched.
 */
export function pickLane(input: PickInput): PickResult {
  const matrix = input.matrix ?? loadMatrix();
  const state = loadState({ ...input, matrix });
  const role = roleNamed(matrix, input.role);
  if (!role) fail(`unknown role ${JSON.stringify(input.role)}`);
  const row = state.rows.find((r) => r.role === role.role);
  const lanes = row?.lanes ?? roleDefault(matrix, role.role, state.parent);
  // Validate supplied authors even for trail review, whose criterion is only the root family.
  const authorsPick = pickCrossFamily(matrix, state.parent, lanes, input.executors ?? []);
  const selection = role.role === "trail reviewer pool"
    ? pickCrossFamily(matrix, state.parent, lanes, [])
    : authorsPick;
  return {
    parent: state.parent,
    role: role.role,
    source: row ? "sheet" : "default",
    configurationSource: state.source,
    sheetPath: state.sheetPath,
    integrationPath: state.integrationPath,
    lanes,
    ...selection,
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

type ResolvedProbeOptions = ProbeOptions & { readonly env: ConfigEnv };

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

async function runLane(pair: ProbePair, plan: Plan, options: ResolvedProbeOptions): Promise<ExternalProbeResult> {
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
    env: options.env,
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
  const env = options.env ?? process.env;
  const matrix = loadMatrix();
  const networkWarning = externalNetworkWarning(plan.parent, env, familyEfforts(plan.rows, matrix), matrix);
  if (networkWarning !== null) fail(networkWarning);
  const resolvedOptions: ResolvedProbeOptions = { dir: options.dir, timeoutSeconds: options.timeoutSeconds, env };
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
  const external = await Promise.all(runnerPairs.map((pair) => runLane(pair, plan, resolvedOptions)));
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

export type WriteOutcome = "created" | "updated" | "unchanged";

export interface WriteResult {
  readonly sheetPath: string;
  readonly integrationPath: string;
  readonly ledgerPath: string;
  readonly sheet: WriteOutcome;
  readonly integration: WriteOutcome;
  readonly ledger: WriteOutcome;
  /** Files a version before 0.6.0 kept in the config home, deleted once their content sits in the data folder. */
  readonly removedLegacy: readonly string[];
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
  try {
    const info = statIfExists(path);
    if (info === null) return null;
    if (!info.isFile()) fail(`${label} ${path} exists but is not a regular file; resolve it before writing`);
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof SetupError) throw error;
    fail(`${label} ${path} could not be read (${error instanceof Error ? error.message : String(error)})`);
  }
}

function statIfExists(path: string): Stats | null {
  let entry: Stats;
  try {
    entry = lstatSync(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  return entry.isSymbolicLink() ? statSync(path) : entry;
}

interface WriteTarget {
  readonly label: "sheet" | "parent integration" | "probe ledger" | "legacy sheet" | "legacy probe ledger";
  readonly path: string;
  readonly before: string | null;
  /** Null deletes the file. */
  readonly after: string | null;
}

/** Only a target whose bytes change needs to be writable; the others are never touched. Deleting a file needs its folder writable, not the file. */
function assertSetupTargetsWritable(targets: readonly WriteTarget[]): void {
  for (const target of targets) {
    if (target.before === target.after) continue;
    let checked = target.path;
    try {
      if (target.after === null) {
        checked = dirname(target.path);
        accessSync(checked, fsConstants.W_OK | fsConstants.X_OK);
        continue;
      }
      const current = statIfExists(checked);
      if (current !== null) {
        if (!current.isFile()) throw new Error("not a regular file");
        accessSync(checked, fsConstants.W_OK);
        continue;
      }
      checked = dirname(checked);
      let ancestor = statIfExists(checked);
      while (ancestor === null) {
        const parent = dirname(checked);
        if (parent === checked) throw new Error("no existing parent directory");
        checked = parent;
        ancestor = statIfExists(checked);
      }
      if (!ancestor.isDirectory()) throw new Error("not a directory");
      accessSync(checked, fsConstants.W_OK | fsConstants.X_OK);
    } catch (error) {
      fail(`${target.label} ${target.path} is not writable (checked ${checked}: ${error instanceof Error ? error.message : String(error)})`);
    }
  }
}

export function writeSheet(plan: Plan, dir: string, options: { readonly home?: string; readonly env?: ConfigEnv } & SourceContext = {}): WriteResult {
  const where = locate(plan.parent, options.home ?? homedir(), options.env ?? {}, {
    cwd: options.cwd ?? plan.sourceContext?.cwd,
    instructionSources: options.instructionSources ?? plan.sourceContext?.instructionSources,
  });
  if (where.readSource === false) fail("refusing to write without a loaded instruction source; identify the setup destination and run plan again");
  const { sheetPath, integrationPath, ledgerPath } = where;
  if (plan.sheetPath !== sheetPath || plan.integrationPath !== integrationPath || plan.ledgerPath !== ledgerPath) {
    const variable = targetFor(plan.parent).variable;
    if (plan.parent !== "codex") {
      fail(`${join(dir, PLAN_FILE)} was made for the config home ${dirname(plan.integrationPath)}, but this write resolves ${where.configHome}; run write with the --home${variable === null ? "" : ` and ${variable.name}`} that plan used, or run plan again`);
    }
    fail(`${join(dir, PLAN_FILE)} was made for the config home/source ${plan.sheetPath} and ${plan.integrationPath}, but this write resolves ${sheetPath} and ${integrationPath}; run write with the --home${variable === null ? "" : ` and ${variable.name}`} and source context that plan used, or run plan again`);
  }

  const probes = verifyProbes(plan, dir);
  if (!probes.ok) {
    fail(`refusing to write: ${probes.problems.length} probe(s) not passed\n${probes.problems.map((p) => `  ${p}`).join("\n")}`);
  }

  const sheetBefore = snapshotOf(sheetPath, "sheet");
  const integrationBefore = snapshotOf(integrationPath, "integration file");
  const ledgerBefore = snapshotOf(ledgerPath, "probe ledger");
  const stored = ledgerSnapshot(where);
  const integrationAfter = integrationBefore === null ? null : unwireIntegration(where, integrationBefore);
  const ledgerAfter = recordProbes(stored.text, stored.path, plan, dir);

  const legacy = legacyTargets(where);
  const targets: readonly WriteTarget[] = [
    { label: "sheet", path: sheetPath, before: sheetBefore, after: plan.sheet },
    { label: "parent integration", path: integrationPath, before: integrationBefore, after: integrationAfter },
    { label: "probe ledger", path: ledgerPath, before: ledgerBefore, after: ledgerAfter },
    ...legacy,
  ];
  commitTargets(targets);
  return {
    sheetPath,
    integrationPath,
    ledgerPath,
    sheet: outcome(sheetBefore, plan.sheet),
    integration: outcome(integrationBefore, integrationAfter),
    ledger: outcome(ledgerBefore, ledgerAfter),
    removedLegacy: legacy.map((target) => target.path),
  };
}

/** Deletion targets for the files a version before 0.6.0 kept in the config home, once their content sits in the data folder. */
function legacyTargets(where: Location): WriteTarget[] {
  const targets: WriteTarget[] = [];
  for (const [label, path] of [["legacy sheet", where.legacySheetPath], ["legacy probe ledger", where.legacyLedgerPath]] as const) {
    if (path === null) continue;
    const before = snapshotOf(path, label);
    if (before !== null) targets.push({ label, path, before, after: null });
  }
  return targets;
}

function outcome(before: string | null, after: string | null): WriteOutcome {
  return before === after ? "unchanged" : before === null ? "created" : "updated";
}

/** Admit every target, write or delete what changed, read it back, and restore every snapshot on any failure. */
function commitTargets(targets: readonly WriteTarget[]): void {
  assertSetupTargetsWritable(targets);
  try {
    for (const { path, before, after } of targets) {
      if (after === before) continue;
      if (after === null) {
        unlinkSync(path);
        continue;
      }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, after, { mode: 0o600 });
    }
    for (const { path, after } of targets) {
      if (after === null ? existsSync(path) : readFileSync(path, "utf8") !== after) throw new Error(`${path} read back differs from the render`);
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
}

export interface UnwireResult {
  readonly sheetPath: string;
  readonly integrationPath: string;
  readonly ledgerPath: string;
  readonly sheet: WriteOutcome;
  readonly integration: WriteOutcome;
  readonly ledger: WriteOutcome;
  /** The target of a removed import that no longer existed: no sheet came from it. */
  readonly missingImport: string | null;
  /** Files a version before 0.6.0 kept in the config home, deleted once their content sits in the data folder. */
  readonly removedLegacy: readonly string[];
}

/**
 * Move what older versions left outside the data folder, keeping the sheet's
 * lanes: the wiring a version before 0.5.32 wrote, and the sheet and ledger a
 * version before 0.6.0 kept in the config home. A sheet that lived only in the
 * wiring or in the config home is first written to the sheet path byte for
 * byte, so nothing changes but where the bytes sit. No model changes, so no
 * probe.
 */
export function unwireSheet(input: StateInput): UnwireResult {
  const matrix = input.matrix ?? loadMatrix();
  loadState({ ...input, matrix });
  const where = locate(input.parent, input.home ?? homedir(), input.env ?? {}, input);
  if (where.readSource === false) fail("refusing to unwire without a loaded instruction source; pass the instruction chain the runtime loaded");
  const { loaded, missingImport } = selectSource(where, matrix);
  const sheetBefore = snapshotOf(where.sheetPath, "sheet");
  const integrationBefore = snapshotOf(where.integrationPath, "integration file");
  const ledgerBefore = snapshotOf(where.ledgerPath, "probe ledger");
  const sheetAfter = sheetBefore ?? loaded?.text ?? null;
  const integrationAfter = integrationBefore === null ? null : unwireIntegration(where, integrationBefore);
  const ledgerAfter = ledgerSnapshot(where).text;
  const legacy = legacyTargets(where);
  commitTargets([
    { label: "sheet", path: where.sheetPath, before: sheetBefore, after: sheetAfter },
    { label: "parent integration", path: where.integrationPath, before: integrationBefore, after: integrationAfter },
    { label: "probe ledger", path: where.ledgerPath, before: ledgerBefore, after: ledgerAfter },
    ...legacy,
  ]);
  return {
    sheetPath: where.sheetPath,
    integrationPath: where.integrationPath,
    ledgerPath: where.ledgerPath,
    sheet: outcome(sheetBefore, sheetAfter),
    integration: outcome(integrationBefore, integrationAfter),
    ledger: outcome(ledgerBefore, ledgerAfter),
    missingImport,
    removedLegacy: legacy.map((target) => target.path),
  };
}

/**
 * For an uninstall: remove the sheet wiring a version before 0.5.32 wrote into
 * the parent's global instruction file, without carrying the sheet anywhere,
 * since the data folder goes with the plugin. Returns the file it changed, or
 * null when there was nothing to remove.
 */
export function removeLegacyWiring(parent: string, home: string = homedir(), env: ConfigEnv = {}): string | null {
  const where = locate(parent, home, env, parent === "codex" ? { cwd: home } : {});
  const before = snapshotOf(where.integrationPath, "integration file");
  if (before === null) return null;
  const after = unwireIntegration(where, before);
  if (after === before) return null;
  commitTargets([{ label: "parent integration", path: where.integrationPath, before, after }]);
  return where.integrationPath;
}

export interface ResolvedRole {
  readonly role: string;
  readonly lanes: readonly string[];
  /** The parent's sheet, or the role-table default when the sheet has no such row. */
  readonly source: "sheet" | "default";
}

export interface RolesResult {
  readonly parent: string;
  readonly configurationSource: SheetSource;
  readonly sheetPath: string;
  readonly legacyWiring: string | null;
  /** Every role in matrix order, then the swarm fallback when the sheet enables it. */
  readonly roles: readonly ResolvedRole[];
}

/** Resolve every role of the parent to its lanes: the dispatch-time read of the sheet. */
export function resolveRoles(input: StateInput): RolesResult {
  const matrix = input.matrix ?? loadMatrix();
  const state = loadState({ ...input, matrix });
  const roles: ResolvedRole[] = matrix.roles.map(({ role }) => {
    const row = state.rows.find((r) => r.role === role);
    return row === undefined
      ? { role, lanes: roleDefault(matrix, role, state.parent), source: "default" }
      : { role, lanes: row.lanes, source: "sheet" };
  });
  const fallback = state.rows.find((r) => r.role === SWARM_FALLBACK);
  if (fallback !== undefined) roles.push({ role: SWARM_FALLBACK, lanes: fallback.lanes, source: "sheet" });
  return {
    parent: state.parent,
    configurationSource: state.source,
    sheetPath: state.sheetPath,
    legacyWiring: state.legacyWiring,
    roles,
  };
}

// --- Command line ---------------------------------------------------------------

const USAGE = `Usage: setup-pstack <state|plan|probe|attest|write|pick|roles|unwire> [options]

  state  --parent <${Object.keys(TARGETS).join("|")}> [--home <dir>]
         Read the parent's sheet, normalize rolling aliases, derive per-lane efforts grouped by family.
  plan   --parent <p> [--home <dir>] [--dir <run dir>]
         [--effort <family>=<effort>]... [--role "<label>=<lane>[, <lane>]"]...
         [--swarm-fallback <native-descriptor|off>]
         Render the new sheet in memory and save plan.json (creates a run dir when --dir is omitted).
         --effort rewrites every lane of that family; --role overlays after, each lane keeping its effort.
         --swarm-fallback enables one native-provider substitute, or removes it with off.
         Omission preserves the setting; first-run sheets have no fallback. It is not a panel role.
  probe  --dir <run dir> [--timeout <seconds>]
         Run the plan's external probes (families new to this parent) through the runner;
         list native probes to attest. A plan whose families are all verified has none.
  attest --dir <run dir> --pair <family>@<effort> --observed <reply text>
         Record a native one-turn probe whose reply carries the pair's marker.
         Grok also requires --owner-id <id> --child-id <id> from its nested probe.
         --pair owner-nesting attests the fresh Grok capability, even with no new families.
  write  --dir <run dir> [--home <dir>]
         Verify the plan's probes, then write the sheet and the probe ledger in the plugin's
         data folder, remove the sheet wiring an earlier version left in CLAUDE.md or AGENTS.md,
         and delete the sheet and ledger it left in the config home (byte-identical rerun
         writes nothing).
  pick   --parent <p> --role "<pool role>" [--executor <provider>]... [--home <dir>]
         Pick in the operator's order. Trail review excludes only the root's provider;
         --executor is validated but does not exclude coauthors from that role. Arena also
         excludes the providers named with --executor. Exit 1 means no eligible lane;
         it does not waive the trail review.
  roles  --parent <p> [--home <dir>]
         Resolve every role to its lanes: the sheet's row, else the role-table default.
         Run it before dispatching configured roles; no instruction file loads the sheet.
  unwire --parent <p> [--home <dir>]
         Remove the sheet wiring a version before 0.5.32 wrote into CLAUDE.md or AGENTS.md,
         and move the sheet and ledger a version before 0.6.0 kept in the config home into the
         plugin's data folder, keeping every lane.

Codex state, plan, pick, roles, unwire and write accept --cwd <project directory> (default: current directory)
and repeated --instruction-source <file> in the runtime's global-to-local loaded order.
Use --no-instruction-sources for an empty observed chain (defaults; setup cannot write).
For custom instruction discovery, pass that exact chain instead of guessing. The nearest
Codex project sheet/block/reference wins, then the global source, then role-table defaults.
An absent row in the selected source uses its role-table default, not a broader sheet.
The result identifies the source and destinations. A plan retains its source context for write.

The global sheet and ledger live in the plugin's data folder, which the host deletes with
the plugin: <claude config home>/plugins/data/pstack-pstack-vic (claude), its grok folder
(grok), and <codex config home>/plugins/data/pstack-pstack-vic (codex). The config home is
CLAUDE_CONFIG_DIR (claude) or CODEX_HOME (codex), an absolute path, else <home>/.claude or
<home>/.codex. An empty CODEX_HOME counts as unset. An empty CLAUDE_CONFIG_DIR stops every
subcommand for the claude and grok parents.

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
          cwd: { type: "string" },
          "instruction-source": { type: "string", multiple: true },
          "no-instruction-sources": { type: "boolean", default: false },
          dir: { type: "string" },
          effort: { type: "string", multiple: true },
          role: { type: "string", multiple: true },
          "swarm-fallback": { type: "string" },
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
    const swarmFallback = parsed.values["swarm-fallback"];
    if (swarmFallback !== undefined && command !== "plan") usage("--swarm-fallback is only valid with plan");
    if (swarmFallback !== undefined && typeof swarmFallback !== "string") usage("--swarm-fallback expects a native descriptor or off");
    const home = typeof parsed.values.home === "string" ? parsed.values.home : homedir();
    const env = io.env ?? {};
    if (parsed.values["no-instruction-sources"] && parsed.values["instruction-source"] !== undefined) usage("--no-instruction-sources cannot be combined with --instruction-source");
    const context: SourceContext = {
      cwd: typeof parsed.values.cwd === "string" ? parsed.values.cwd : undefined,
      instructionSources: parsed.values["no-instruction-sources"] ? [] : parsed.values["instruction-source"] as string[] | undefined,
    };
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
        emit(loadState({ parent: requireParent(), home, env, ...context }));
        return 0;
      }
      case "plan": {
        const plan = buildPlan({
          parent: requireParent(),
          home,
          env,
          ...context,
          efforts: parseAssignments(parsed.values.effort as string[] | undefined, "--effort"),
          roles: parseRoleChanges(parsed.values.role as string[] | undefined),
          swarmFallback: swarmFallback === "off" ? null : swarmFallback,
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
        const summary = await runProbes(plan, { dir, timeoutSeconds, env });
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
        emit(writeSheet(plan, dir, { home, env, ...context }));
        return 0;
      }
      case "pick": {
        const role = parsed.values.role as string[] | undefined;
        if (role?.length !== 1) usage("--role is required once: the label of the pool role");
        const executors = ((parsed.values.executor as string[] | undefined) ?? [])
          .flatMap((value) => value.split(","))
          .map((value) => value.trim())
          .filter((value) => value.length > 0);
        const result = pickLane({ parent: requireParent(), home, env, ...context, role: role[0], executors });
        emit(result);
        return result.chosen === null ? 1 : 0;
      }
      case "roles": {
        emit(resolveRoles({ parent: requireParent(), home, env, ...context }));
        return 0;
      }
      case "unwire": {
        emit(unwireSheet({ parent: requireParent(), home, env, ...context }));
        return 0;
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
