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
//   setup-pstack.ts state  --parent <claude|codex> [--home <dir>]
//   setup-pstack.ts plan   --parent <p> [--home <dir>] [--dir <run dir>]
//                          [--effort <family>=<effort>]... [--role "<label>=<lane>, <lane>"]...
//   setup-pstack.ts probe  --dir <run dir> [--timeout <seconds>] [--repo <owner/name> --pr <number>]
//   setup-pstack.ts attest --dir <run dir> --pair <family>@<effort> --observed <text>
//   setup-pstack.ts write  --dir <run dir> [--home <dir>]
//
// Node 24, type stripping, no dependencies: erasable TypeScript only.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  agentName,
  familyFor,
  familyNamed,
  loadMatrix,
  parseDescriptor,
  renderSheetDocument,
  roleDefault,
  routeFor,
  type Family,
  type ModelMatrix,
  type Route,
} from "../../../scripts/model-matrix.ts";
import { roleProviders, type Role } from "../../poteto-mode/scripts/converge/contract.ts";
import { judgeLane, probePrompt, runProbeLane } from "../../poteto-mode/scripts/runner/probe-lane.ts";
import type { RepoTarget } from "../../poteto-mode/scripts/runner/types.ts";

export class SetupError extends Error {}

function fail(message: string): never {
  throw new SetupError(message);
}

// --- Paths -----------------------------------------------------------------

/** Per-parent home-relative locations of the sheet and the parent integration file. */
const TARGETS: Readonly<Record<string, { readonly dir: string; readonly integration: string }>> = {
  claude: { dir: ".claude", integration: "CLAUDE.md" },
  codex: { dir: ".codex", integration: "AGENTS.md" },
};

export const SHEET_FILE = "pstack-models.md";
export const LEDGER_FILE = "pstack-probes.json";
export const CLAUDE_INCLUDE_LINE = "@~/.claude/pstack-models.md";
export const CODEX_BLOCK_BEGIN = "<!-- pstack:models:begin -->";
export const CODEX_BLOCK_END = "<!-- pstack:models:end -->";

function targetFor(parent: string): { readonly dir: string; readonly integration: string } {
  const target = TARGETS[parent];
  if (!target) fail(`unknown parent ${JSON.stringify(parent)}; expected one of ${Object.keys(TARGETS).join(", ")}`);
  return target;
}

export function sheetPathFor(parent: string, home: string = homedir()): string {
  return join(home, targetFor(parent).dir, SHEET_FILE);
}

export function integrationPathFor(parent: string, home: string = homedir()): string {
  const target = targetFor(parent);
  return join(home, target.dir, target.integration);
}

export function ledgerPathFor(parent: string, home: string = homedir()): string {
  return join(home, targetFor(parent).dir, LEDGER_FILE);
}

// --- Sheet parsing -----------------------------------------------------------

export interface SheetRow {
  readonly role: string;
  readonly lanes: readonly string[];
}

const ROW_RE = /^([a-z][a-z0-9 ,-]*): (.+)$/;
const RETIRED_CONVERGE_ROLES = new Set(['pr reviewer', 'pr fixer, simple', 'pr fixer, complex', 'pr diagnosis pool']);
const AUTHORING_ROLES = ["feature, refactoring", "bug-fix", "perf-issue", "hillclimb", "hardest tasks"];

export function singleLaneRows(matrix: ModelMatrix): ReadonlyMap<string, readonly string[]> {
  const admitted = (role: Role): string[] => {
    const { provider, model, efforts } = roleProviders[role];
    return efforts.map((effort) => `${provider}:${model}@${effort}`);
  };
  const converge = [...admitted("pr verifier"), ...matrix.aliases];
  return new Map([
    ["pr owner", converge],
    ["pr verifier", converge],
    ["pre-pr reviewer", admitted("pre-pr reviewer")],
    ["pre-pr fixer", admitted("pre-pr reviewer")],
    ["pre-pr certifier", admitted("pre-pr certifier")],
  ]);
}

function crossFamilyWarnings(rows: readonly SheetRow[]): string[] {
  const reviewer = parseDescriptor(rows.find((row) => row.role === "pre-pr reviewer")?.lanes[0] ?? "")?.provider;
  if (reviewer === undefined) return [];
  return rows
    .filter((row) => AUTHORING_ROLES.includes(row.role) && row.lanes.some((lane) => parseDescriptor(lane)?.provider === reviewer))
    .map((row) => `${row.role} and pre-pr reviewer are both ${reviewer}; certification will refuse until one of them changes family`);
}

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

export interface State {
  readonly parent: string;
  readonly sheetPath: string;
  readonly integrationPath: string;
  readonly exists: boolean;
  /** Normalized rows in sheet order (first run: empty). */
  readonly rows: readonly SheetRow[];
  readonly migrations: readonly Migration[];
  /** One entry per matrix family, in matrix order. */
  readonly efforts: Readonly<Record<string, EffortState>>;
}

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
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
  readonly matrix?: ModelMatrix;
}

/** Read the parent's sheet (if any), normalize it, and derive the efforts in use per family. */
export function loadState(input: StateInput): State {
  const matrix = input.matrix ?? loadMatrix();
  const home = input.home ?? homedir();
  const parent = input.parent;
  if (!(parent in matrix.parents)) fail(`unknown parent ${JSON.stringify(parent)}; expected one of ${Object.keys(matrix.parents).join(", ")}`);
  const sheetPath = sheetPathFor(parent, home);
  const integrationPath = integrationPathFor(parent, home);
  const text = readIfExists(sheetPath);
  if (text === null) {
    const defaults = matrix.roles.map((r) => ({ role: r.role, lanes: roleDefault(matrix, r.role, parent) }));
    const efforts = familyEfforts(defaults, matrix);
    for (const family of matrix.families) {
      const state = efforts[family.family];
      if (state.status === "current" || state.status === "mixed") {
        efforts[family.family] = { status: "unassigned", efforts: [family.defaultEffort], rows: [] };
      }
    }
    return { parent, sheetPath, integrationPath, exists: false, rows: [], migrations: [], efforts };
  }
  const { rows, migrations } = normalizeRows(parseSheet(text, matrix), matrix);
  const efforts = familyEfforts(rows, matrix);
  return { parent, sheetPath, integrationPath, exists: true, rows, migrations, efforts };
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
  readonly native: NativeAgentProbe | NativeSpawnProbe | null;
  /** The unique token the probe must echo back. */
  readonly marker: string;
}

export interface VerifiedFamily {
  readonly family: string;
  readonly provider: string;
  readonly model: string;
  readonly verifiedAt: string;
}

export interface Plan {
  readonly schemaVersion: 4;
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
  /** Families in the final map that this parent verified before; not probed again, whatever effort their lanes take. */
  readonly verified: readonly VerifiedFamily[];
  readonly migrations: readonly Migration[];
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
  if (primitive === "Agent") {
    const agent = agentName(family, effort);
    if (agent === null) fail(`${family.family} is native in ${parent} but has no agent stem`);
    return { primitive: "Agent", agent };
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
  const state = loadState({ parent: input.parent, home, matrix });
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

  const singleLane = singleLaneRows(matrix);
  for (const row of rows) {
    const allowed = singleLane.get(row.role);
    if (allowed !== undefined && (row.lanes.length !== 1 || !allowed.includes(row.lanes[0]))) {
      fail(`role ${JSON.stringify(row.role)} takes one lane, ${allowed.join(" or ")}; got ${row.lanes.join(", ")}`);
    }
  }

  const sheet = renderSheetDocument(rows.map((r) => `${r.role}: ${r.lanes.join(", ")}`).join("\n"));
  const ledgerPath = ledgerPathFor(parent, home);
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
    schemaVersion: 4,
    parent,
    createdAt: new Date().toISOString(),
    sheetPath: state.sheetPath,
    integrationPath: state.integrationPath,
    ledgerPath,
    firstRun: !state.exists,
    efforts,
    rows,
    sheet,
    pairs,
    verified,
    migrations: state.migrations,
    warnings: crossFamilyWarnings(rows),
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
  if (raw.schemaVersion !== 4) {
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
  readonly native: NativeAgentProbe | NativeSpawnProbe;
  readonly marker: string;
  readonly prompt: string;
  readonly evidencePath: string;
  readonly attested: boolean;
}

export interface ProbeSummary {
  readonly external: readonly ExternalProbeResult[];
  readonly native: readonly NativeProbeStatus[];
  /** Every runner pair passed. */
  readonly externalOk: boolean;
  /** Every runner pair passed and every native pair is attested. */
  readonly ok: boolean;
}

export interface ProbeOptions {
  readonly dir: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutSeconds?: number | null;
  /** Required when any runner pair uses http transport, rejected otherwise. Not written to the plan. */
  readonly target?: RepoTarget;
}

function transportOf(matrix: ModelMatrix, provider: string): "cli" | "http" {
  return matrix.providers[provider]?.transport ?? "cli";
}

function probeTargetProblem(plan: Plan, target: RepoTarget | undefined, matrix: ModelMatrix): string | null {
  if (target !== undefined) {
    const segments = `${target.owner}/${target.name}`.split("/");
    if (segments.length !== 2 || segments.some((segment) => segment.trim().length === 0)) {
      return "--repo must be owner/name";
    }
    if (!Number.isSafeInteger(target.pullNumber) || target.pullNumber <= 0) {
      return "--pr must be a positive integer";
    }
  }
  const http: string[] = [];
  for (const pair of plan.pairs) {
    if (pair.route !== "runner" || transportOf(matrix, pair.provider) !== "http") continue;
    if (!http.includes(pair.provider)) http.push(pair.provider);
  }
  if (http.length > 0 && target === undefined) {
    return `--repo and --pr are required for ${http.join(", ")} (http transport)`;
  }
  if (http.length === 0 && target !== undefined) {
    const accepted = Object.keys(matrix.providers).filter((provider) => transportOf(matrix, provider) === "http");
    return `--repo and --pr are only accepted for: ${accepted.join(", ")}`;
  }
  return null;
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

async function runLane(pair: ProbePair, plan: Plan, options: ProbeOptions, matrix: ModelMatrix): Promise<ExternalProbeResult> {
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
    target: transportOf(matrix, pair.provider) === "http" ? options.target : undefined,
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
  native: NativeAgentProbe | NativeSpawnProbe
): NativeProbeStatus {
  const evidencePath = nativeEvidencePath(dir, pair.pair);
  return {
    family: pair.family,
    pair: pair.pair,
    descriptor: pair.descriptor,
    native,
    marker: pair.marker,
    prompt: probePrompt(pair.marker).trimEnd(),
    evidencePath,
    attested: verifyNative(plan, dir, pair) === null,
  };
}

/**
 * Run every runner-route pair of the plan through the external runner, all at
 * once, each with its own prompt, output, and receipt under `dir`. Native
 * pairs are not run here (the parent's primitive is the skill's job); they are
 * listed with the prompt to send and whether `attest` has recorded them.
 * Target presence is checked before mkdir, artifact writes, or spawn.
 */
export async function runProbes(plan: Plan, options: ProbeOptions): Promise<ProbeSummary> {
  const matrix = loadMatrix();
  const problem = probeTargetProblem(plan, options.target, matrix);
  if (problem !== null) fail(problem);
  mkdirSync(options.dir, { recursive: true });
  const runnerPairs = plan.pairs.filter((p) => p.route === "runner");
  for (const pair of runnerPairs) {
    const paths = probePaths(options.dir, pair.pair);
    for (const path of [paths.output, paths.receipt]) {
      if (existsSync(path)) fail(`${path} already exists; use a fresh run directory or remove the previous probe artifacts`);
    }
  }
  const external = await Promise.all(runnerPairs.map((pair) => runLane(pair, plan, options, matrix)));
  const native = plan.pairs.flatMap((p) => (p.native === null ? [] : [nativeStatus(plan, options.dir, p, p.native)]));
  const externalOk = external.every((r) => r.status === "passed");
  return { external, native, externalOk, ok: externalOk && native.every((n) => n.attested) };
}

interface NativeEvidence {
  readonly pair: string;
  readonly family: string;
  readonly descriptor: string;
  readonly native: NativeAgentProbe | NativeSpawnProbe;
  readonly marker: string;
  readonly observed: string;
  readonly attestedAt: string;
}

/**
 * Record the outcome of a native one-turn probe the skill ran through the
 * parent's primitive. The observed reply must carry the pair's marker.
 */
export function attestNative(plan: Plan, dir: string, pairId: string, observed: string): string {
  const ids = plan.pairs.map((p) => p.pair).join(", ");
  const pair = plan.pairs.find((p) => p.pair === pairId);
  if (!pair) fail(`${pairId} is not a pair of this plan; pairs: ${ids}`);
  if (pair.native === null) fail(`${pairId} is not a native pair of this plan; it runs through the runner`);
  if (!observed.includes(pair.marker)) {
    fail(`observed reply for ${pairId} lacks the marker ${pair.marker}; the native probe did not pass`);
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
  return null;
}

/** Every probe the plan requires (the families new to this parent) must have passed under `dir` before anything is written. */
export function verifyProbes(plan: Plan, dir: string): { readonly ok: boolean; readonly problems: readonly string[] } {
  const problems: string[] = [];
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

/** The parent integration text after this sheet is wired in; throws on inconsistent state. */
export function renderIntegration(parent: string, current: string | null, sheet: string): string {
  if (parent === "claude") {
    const text = current ?? "";
    const count = text.split("\n").filter((line) => line.trim() === CLAUDE_INCLUDE_LINE).length;
    if (count > 1) fail(`${CLAUDE_INCLUDE_LINE} appears ${count} times in CLAUDE.md; keep exactly one include`);
    if (count === 1) return text;
    return `${text}${text.length === 0 || text.endsWith("\n") ? "" : "\n"}${CLAUDE_INCLUDE_LINE}\n`;
  }
  if (parent === "codex") {
    const text = current ?? "";
    const block = `${CODEX_BLOCK_BEGIN}\n${sheet}${CODEX_BLOCK_END}\n`;
    const begins = text.split(CODEX_BLOCK_BEGIN).length - 1;
    const ends = text.split(CODEX_BLOCK_END).length - 1;
    if (begins === 0 && ends === 0) {
      return `${text}${text.length === 0 || text.endsWith("\n") ? "" : "\n"}${block}`;
    }
    if (begins !== 1 || ends !== 1) {
      fail(`AGENTS.md has ${begins} begin and ${ends} end markers; expected exactly one pstack:models block`);
    }
    const start = text.indexOf(CODEX_BLOCK_BEGIN);
    const stop = text.indexOf(CODEX_BLOCK_END);
    if (stop < start) fail("AGENTS.md pstack:models markers are reversed");
    const afterEnd = stop + CODEX_BLOCK_END.length;
    const rest = text.slice(afterEnd).replace(/^\n/, "");
    return `${text.slice(0, start)}${block}${rest}`;
  }
  fail(`no integration shape for parent ${parent}`);
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
 * Commit the plan: verify its probes, render the integration and the ledger,
 * compare with the current bytes, and only then write sheet, integration, and
 * ledger, read each back, and restore every snapshot on any failure. The ledger
 * gains one entry per family this plan probed. An unchanged rerun touches nothing.
 */
export function writeSheet(plan: Plan, dir: string, options: { readonly home?: string } = {}): WriteResult {
  const home = options.home ?? homedir();
  const sheetPath = sheetPathFor(plan.parent, home);
  const integrationPath = integrationPathFor(plan.parent, home);
  const ledgerPath = ledgerPathFor(plan.parent, home);

  const probes = verifyProbes(plan, dir);
  if (!probes.ok) {
    fail(`refusing to write: ${probes.problems.length} probe(s) not passed\n${probes.problems.map((p) => `  ${p}`).join("\n")}`);
  }

  const sheetBefore = snapshotOf(sheetPath, "sheet");
  const integrationBefore = snapshotOf(integrationPath, "integration file");
  const ledgerBefore = snapshotOf(ledgerPath, "probe ledger");
  const integrationAfter = renderIntegration(plan.parent, integrationBefore, plan.sheet);
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

const USAGE = `Usage: setup-pstack <state|plan|probe|attest|write> [options]

  state  --parent <${Object.keys(TARGETS).join("|")}> [--home <dir>]
         Read the parent's sheet, normalize rolling aliases, derive per-lane efforts grouped by family.
  plan   --parent <p> [--home <dir>] [--dir <run dir>]
         [--effort <family>=<effort>]... [--role "<label>=<lane>[, <lane>]"]...
         Render the new sheet in memory and save plan.json (creates a run dir when --dir is omitted).
         --effort rewrites every lane of that family; --role overlays after, each lane keeping its effort.
  probe  --dir <run dir> [--timeout <seconds>] [--repo <owner/name> --pr <number>]
         Run the plan's external probes (families new to this parent) through the runner;
         list native probes to attest. A plan whose families are all verified has none.
         --repo and --pr are required when a runner pair uses http transport and refused otherwise.
  attest --dir <run dir> --pair <family>@<effort> --observed <reply text>
         Record a native one-turn probe whose reply carries the pair's marker.
  write  --dir <run dir> [--home <dir>]
         Verify the plan's probes, then write the sheet, the parent integration, and the probe
         ledger (byte-identical rerun writes nothing).

Exit codes: 0 ok, 1 a probe failed or the write was refused, 64 usage.
`;

interface Io {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
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

function parseProbeTarget(repo: string | undefined, pr: string | undefined): RepoTarget | undefined {
  if (repo === undefined && pr === undefined) return undefined;
  if (repo === undefined) usage("--repo is required with --pr");
  if (pr === undefined) usage("--pr is required with --repo");
  const segments = repo.split("/");
  if (segments.length !== 2 || segments.some((segment) => segment.trim().length === 0)) {
    usage("--repo must be owner/name");
  }
  const pullNumber = /^[0-9]+$/.test(pr) ? Number(pr) : Number.NaN;
  if (!Number.isSafeInteger(pullNumber) || pullNumber <= 0) {
    usage("--pr must be a positive integer");
  }
  return { owner: segments[0], name: segments[1], pullNumber };
}

export async function main(argv: readonly string[], io: Io = {
  stdout: (v) => process.stdout.write(v),
  stderr: (v) => process.stderr.write(v),
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
          observed: { type: "string" },
          timeout: { type: "string" },
          repo: { type: "string" },
          pr: { type: "string" },
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
    const repo = typeof parsed.values.repo === "string" ? parsed.values.repo : undefined;
    const pr = typeof parsed.values.pr === "string" ? parsed.values.pr : undefined;
    if (command !== "probe" && (repo !== undefined || pr !== undefined)) {
      usage("--repo and --pr are only accepted on probe");
    }
    const home = typeof parsed.values.home === "string" ? parsed.values.home : homedir();
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
    const warn = (plan: Plan): void => {
      for (const warning of plan.warnings) io.stderr(`warning: ${warning}\n`);
    };

    switch (command) {
      case "state": {
        emit(loadState({ parent: requireParent(), home }));
        return 0;
      }
      case "plan": {
        const plan = buildPlan({
          parent: requireParent(),
          home,
          efforts: parseAssignments(parsed.values.effort as string[] | undefined, "--effort"),
          roles: parseRoleChanges(parsed.values.role as string[] | undefined),
        });
        const dir = typeof parsed.values.dir === "string" ? parsed.values.dir : mkdtempSync(join(tmpdir(), "pstack-setup-"));
        savePlan(dir, plan);
        emit({ dir, ...plan });
        warn(plan);
        return 0;
      }
      case "probe": {
        const dir = requireDir();
        const timeoutValue = parsed.values.timeout;
        const timeoutSeconds = typeof timeoutValue === "string" ? Number(timeoutValue) : null;
        if (timeoutSeconds !== null && (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)) {
          usage("--timeout must be a number greater than zero");
        }
        const target = parseProbeTarget(repo, pr);
        const plan = loadPlan(dir);
        const problem = probeTargetProblem(plan, target, loadMatrix());
        if (problem !== null) usage(problem);
        const summary = await runProbes(plan, { dir, timeoutSeconds, target });
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
        const path = attestNative(plan, dir, pair, observed);
        emit({ pair, evidencePath: path, remaining: verifyProbes(plan, dir).problems });
        return 0;
      }
      case "write": {
        const dir = requireDir();
        const plan = loadPlan(dir);
        warn(plan);
        emit(writeSheet(plan, dir, { home }));
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
