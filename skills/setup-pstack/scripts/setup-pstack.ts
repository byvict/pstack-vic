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

export class SetupError extends Error {}

function fail(message: string): never {
  throw new SetupError(message);
}

// --- Paths -----------------------------------------------------------------

/** The variables a caller hands in. Only the command line passes process.env; `{}` means none is set. */
export type ConfigEnv = Readonly<Record<string, string | undefined>>;

interface Target {
  /** The config home under `home` when no variable redirects it. */
  readonly dir: string;
  /** The variable the harness reads its config home from; Grok documents none. */
  readonly variable: string | null;
  readonly integration: string;
  /** How the sheet reaches the parent: a CLAUDE.md `@` import, or a bounded block mirrored into AGENTS.md. */
  readonly kind: "import" | "block";
}

const TARGETS: Readonly<Record<string, Target>> = {
  claude: { dir: ".claude", variable: "CLAUDE_CONFIG_DIR", integration: "CLAUDE.md", kind: "import" },
  codex: { dir: ".codex", variable: "CODEX_HOME", integration: "AGENTS.md", kind: "block" },
  grok: { dir: ".grok", variable: null, integration: "AGENTS.md", kind: "block" },
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

/**
 * The directory the parent harness reads its user files from: a non-empty
 * CLAUDE_CONFIG_DIR (Claude) or CODEX_HOME (Codex), else `<home>/.claude`,
 * `<home>/.codex`, `<home>/.grok`. A value that is not absolute (relative,
 * a literal `~`, blank) is refused: the harness resolved it against a working
 * directory this script cannot see.
 */
export function configHomeFor(parent: string, home: string = homedir(), env: ConfigEnv = {}): string {
  const target = targetFor(parent);
  const value = target.variable === null ? undefined : env[target.variable];
  if (value === undefined || value === "") return resolve(home, target.dir);
  if (!isAbsolute(value)) fail(`${target.variable} must be an absolute path or empty; got ${JSON.stringify(value)}`);
  return resolve(value);
}

/** Every file one parent's setup reads or writes, resolved once from (parent, home, env). */
interface Location {
  readonly parent: string;
  /** What `~` in an import means, and the base of the default config homes. */
  readonly home: string;
  readonly configHome: string;
  readonly sheetPath: string;
  readonly integrationPath: string;
  readonly ledgerPath: string;
  readonly kind: Target["kind"];
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
    kind: target.kind,
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

// --- The sheet in the parent integration -----------------------------------------

/** One `@` import whose target's basename is pstack-models.md; [start, end) spans `@` and the path. */
interface SheetImport {
  readonly line: number;
  readonly start: number;
  readonly end: number;
  /** The path as Claude Code reads it, `\ ` unescaped. */
  readonly target: string;
}

const FENCE_RE = /^\s*(`{3,}|~{3,})/;
const CODE_SPAN_RE = /(?<!`)(`+)(?!`)(.*?[^`])\1(?!`)/g;
const IMPORT_RE = /(^|\s)@((?:\\ |\S)+)/g;

/**
 * The imports of a file named pstack-models.md, by Claude Code's documented
 * rule: `@` at the start of a line or after whitespace (a list item counts), a
 * path that ends at the first unescaped space, and nothing inside a fenced
 * block, a code span, or quotes.
 */
function findSheetImports(text: string): SheetImport[] {
  const found: SheetImport[] = [];
  let fence: string | null = null;
  let offset = 0;
  text.split("\n").forEach((line, index) => {
    const run = FENCE_RE.exec(line)?.[1] ?? null;
    if (fence !== null) {
      if (run !== null && run[0] === fence[0] && run.length >= fence.length && line.trim() === run) fence = null;
    } else if (run !== null) {
      fence = run;
    } else {
      const masked = line.replace(CODE_SPAN_RE, (span) => "x".repeat(span.length));
      for (const match of masked.matchAll(IMPORT_RE)) {
        const path = match[2];
        const target = path.replaceAll("\\ ", " ");
        if (/^["']/.test(path) || basename(target) !== SHEET_FILE) continue;
        const start = offset + match.index + match[1].length;
        found.push({ line: index + 1, start, end: start + 1 + path.length, target });
      }
    }
    offset += line.length + 1;
  });
  return found;
}

function tooManyImports(path: string, imports: readonly SheetImport[]): never {
  fail(`inconsistent state: ${path} imports ${SHEET_FILE} ${imports.length} times (lines ${imports.map((i) => i.line).join(", ")}); keep exactly one import`);
}

/** `~/…` against the home, an absolute path as written, anything else against the importing file's directory. */
function importTarget(path: string, where: Location): string {
  if (path === "~" || path.startsWith("~/")) return resolve(where.home, path.slice(2));
  return resolve(dirname(where.integrationPath), path);
}

/** The import `write` renders: the legacy line in the default home, a sibling import in a redirected one. */
function includeLineFor(where: Location): string {
  return where.configHome === resolve(where.home, TARGETS.claude.dir) ? CLAUDE_INCLUDE_LINE : CLAUDE_RELATIVE_INCLUDE_LINE;
}

interface Block {
  readonly start: number;
  /** Just past the end marker. */
  readonly end: number;
  /** The mirrored sheet bytes between the markers. */
  readonly sheet: string;
}

/** The one pstack:models block, or null when the file has no markers; a missing, repeated or reversed marker stops. */
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

/** Where the rows of a state came from. */
export type SheetSource =
  | { readonly kind: "sheet"; readonly path: string }
  /** Claude: the sheet the config home's CLAUDE.md imports from elsewhere, such as a copied profile's `~/.claude`. */
  | { readonly kind: "import"; readonly path: string }
  /** Codex or Grok, sheet missing: the block mirrored into this AGENTS.md. */
  | { readonly kind: "block"; readonly path: string }
  | { readonly kind: "first-run" };

export interface State {
  readonly parent: string;
  readonly configHome: string;
  /** Where `write` puts the sheet, whatever the source. */
  readonly sheetPath: string;
  readonly integrationPath: string;
  /** The file at sheetPath exists, which is the case exactly when the source is that sheet. */
  readonly exists: boolean;
  readonly source: SheetSource;
  /** The target of CLAUDE.md's sheet import when no file is there; otherwise null. */
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

/** parseSheet, with the file it read named in any error. */
function parseFrom(text: string, path: string, matrix: ModelMatrix): SheetRow[] {
  try {
    return parseSheet(text, matrix);
  } catch (error) {
    if (error instanceof SetupError) fail(`${path}: ${error.message}`);
    throw error;
  }
}

/** Roles whose lanes differ between two raw parses: row order and prose ignored, lane order kept. */
function differingRoles(a: readonly SheetRow[], b: readonly SheetRow[]): string[] {
  const lanes = (rows: readonly SheetRow[]) => new Map(rows.map((r) => [r.role, r.lanes.join(", ")]));
  const left = lanes(a);
  const right = lanes(b);
  return [...new Set([...left.keys(), ...right.keys()])].filter((role) => left.get(role) !== right.get(role));
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

/**
 * Pick the configuration to load before anything is normalized (open-pstack
 * #120): the config home's sheet, and the CLAUDE.md import target or the
 * AGENTS.md block. One survives: use it. Two agree: use the sheet. Two differ:
 * stop, naming both, without merging them. None: null, the first-run map.
 */
function selectSource(where: Location, matrix: ModelMatrix): { readonly loaded: Loaded | null; readonly missingImport: string | null } {
  const sheet = snapshotOf(where.sheetPath, "sheet");
  const integration = snapshotOf(where.integrationPath, "integration file") ?? "";
  const found: Loaded[] = sheet === null ? [] : [{ source: { kind: "sheet", path: where.sheetPath }, text: sheet }];
  let missingImport: string | null = null;
  if (where.kind === "import") {
    const imports = findSheetImports(integration);
    if (imports.length > 1) tooManyImports(where.integrationPath, imports);
    if (imports.length === 1) {
      const target = importTarget(imports[0].target, where);
      const text = target === where.sheetPath ? sheet : snapshotOf(target, "imported sheet");
      if (text === null) missingImport = target;
      else if (target !== where.sheetPath) found.push({ source: { kind: "import", path: target }, text });
    }
  } else {
    const block = findBlock(integration, where.integrationPath);
    if (block !== null) found.push({ source: { kind: "block", path: where.integrationPath }, text: block.sheet });
  }
  const [first, second] = found;
  if (first === undefined) return { loaded: null, missingImport };
  if (second !== undefined) {
    const roles = differingRoles(
      parseFrom(first.text, describeSource(first.source, where), matrix),
      parseFrom(second.text, describeSource(second.source, where), matrix)
    );
    if (roles.length > 0) {
      const keep = second.source.kind === "block"
        ? "delete the sheet to recover the block, or remove the block to keep the sheet"
        : `delete the sheet to carry the imported one over, or change the import to ${CLAUDE_RELATIVE_INCLUDE_LINE} to keep the sheet`;
      fail(`inconsistent state: ${describeSource(first.source, where)} and ${describeSource(second.source, where)} assign different lanes to ${roles.join(", ")}; ${keep}`);
    }
  }
  return { loaded: first, missingImport };
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
  /** The variables that move a config home. Omitted: none is set, so the defaults under `home` apply. */
  readonly env?: ConfigEnv;
  readonly matrix?: ModelMatrix;
}

/** Select the parent's configuration, normalize it, and derive the efforts in use per family. */
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

/**
 * The parent integration text after this sheet is wired in; throws on
 * inconsistent state. Claude: zero sheet imports appends one, one is replaced
 * in place (only its `@path`), more stop. Codex and Grok: the block is
 * appended, or replaced whole.
 */
function renderIntegration(where: Location, current: string | null, sheet: string): string {
  const text = current ?? "";
  const separator = text.length === 0 || text.endsWith("\n") ? "" : "\n";
  if (where.kind === "import") {
    const imports = findSheetImports(text);
    if (imports.length > 1) tooManyImports(where.integrationPath, imports);
    const include = includeLineFor(where);
    if (imports.length === 0) return `${text}${separator}${include}\n`;
    return `${text.slice(0, imports[0].start)}${include}${text.slice(imports[0].end)}`;
  }
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

/**
 * Commit the plan: check that it was made for the config home this write
 * resolves, verify its probes, render the integration and the ledger, compare
 * with the current bytes, and only then write sheet, integration, and ledger,
 * read each back, and restore every snapshot on any failure. The ledger gains
 * one entry per family this plan probed. An unchanged rerun touches nothing.
 */
export function writeSheet(plan: Plan, dir: string, options: { readonly home?: string; readonly env?: ConfigEnv } = {}): WriteResult {
  const where = locate(plan.parent, options.home ?? homedir(), options.env ?? {});
  const { sheetPath, integrationPath, ledgerPath } = where;
  if (plan.sheetPath !== sheetPath || plan.integrationPath !== integrationPath || plan.ledgerPath !== ledgerPath) {
    const variable = targetFor(plan.parent).variable;
    fail(`${join(dir, PLAN_FILE)} was made for the config home ${dirname(plan.sheetPath)}, but this write resolves ${where.configHome}; run write with the --home${variable === null ? "" : ` and ${variable}`} that plan used, or run plan again`);
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

The sheet, the ledger and the integration live in the parent's config home: a non-empty
CLAUDE_CONFIG_DIR (claude) or CODEX_HOME (codex), else <home>/.claude, <home>/.codex, <home>/.grok.

Exit codes: 0 ok, 1 a probe failed, the write was refused, or no lane is eligible, 64 usage.
`;

interface Io {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
  /** The default Io is the real process and carries process.env; an Io without env sets no variable. */
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
