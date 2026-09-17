// Typed loader for model-matrix.json, the single source of truth for pstack-vic
// model families and parent routes. Every consumer (runner, setup-pstack, agents
// generator, provider-dispatch renderer, tests) reads the matrix through here.
//
// Runs on Node 24 with type stripping: erasable TypeScript only, no enums, no
// parameter properties, explicit `.ts` import specifiers.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PLUGIN_ROOT: string = join(
  dirname(fileURLToPath(import.meta.url)),
  ".."
);
export const MATRIX_PATH: string = join(PLUGIN_ROOT, "model-matrix.json");

export type Route = "native" | "runner";

export interface ParentSpec {
  readonly name: string;
  readonly nativePrimitive: string;
}

export interface ProviderSpec {
  readonly cli: string;
  readonly nativeIn: string | null;
}

export interface Family {
  readonly family: string;
  readonly provider: string;
  readonly model: string;
  readonly efforts: readonly string[];
  readonly defaultEffort: string;
  readonly agentStem: string | null;
  readonly cursorSlug: string | null;
  readonly reportedModel: string | null;
}

export interface ModelMatrix {
  readonly schemaVersion: 1;
  readonly notes: readonly string[];
  readonly efforts: readonly string[];
  readonly aliases: readonly string[];
  readonly parents: Readonly<Record<string, ParentSpec>>;
  readonly providers: Readonly<Record<string, ProviderSpec>>;
  readonly routes: Readonly<Record<string, Readonly<Record<string, Route>>>>;
  readonly families: readonly Family[];
}

export interface Descriptor {
  readonly provider: string;
  readonly model: string;
  readonly effort: string;
}

export class MatrixError extends Error {}

const NAME_RE = /^[a-z][a-z0-9-]*$/;
const MODEL_RE = /^[a-z0-9][a-z0-9.-]*$/;
const DESCRIPTOR_RE = /^([a-z][a-z0-9-]*):([a-z0-9][a-z0-9.-]*)@([a-z]+)$/;

function fail(message: string): never {
  throw new MatrixError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    fail(`${where} must be a list of strings`);
  }
  return value as string[];
}

function nullableString(value: unknown, where: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") fail(`${where} must be a string or null`);
  return value;
}

function uniqueNames(values: readonly string[], where: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (!NAME_RE.test(value)) fail(`${where}: bad name ${JSON.stringify(value)}`);
    if (seen.has(value)) fail(`${where}: duplicate ${value}`);
    seen.add(value);
  }
}

/** Validate raw JSON into a ModelMatrix, or throw MatrixError naming the defect. */
export function validateMatrix(raw: unknown): ModelMatrix {
  if (!isRecord(raw)) fail("matrix must be an object");
  if (raw.schemaVersion !== 1) fail("schemaVersion must be 1");

  const notes = stringList(raw.notes ?? [], "notes");
  const efforts = stringList(raw.efforts, "efforts");
  if (efforts.length === 0) fail("efforts must not be empty");
  uniqueNames(efforts, "efforts");
  const aliases = stringList(raw.aliases, "aliases");
  uniqueNames(aliases, "aliases");

  if (!isRecord(raw.parents)) fail("parents must be an object");
  const parentNames = Object.keys(raw.parents);
  if (parentNames.length === 0) fail("parents must not be empty");
  uniqueNames(parentNames, "parents");
  const parents: Record<string, ParentSpec> = {};
  for (const [name, spec] of Object.entries(raw.parents)) {
    if (!isRecord(spec)) fail(`parents.${name} must be an object`);
    if (typeof spec.name !== "string" || spec.name.length === 0) {
      fail(`parents.${name}.name must be a non-empty string`);
    }
    if (typeof spec.nativePrimitive !== "string" || spec.nativePrimitive.length === 0) {
      fail(`parents.${name}.nativePrimitive must be a non-empty string`);
    }
    parents[name] = { name: spec.name, nativePrimitive: spec.nativePrimitive };
  }

  if (!isRecord(raw.providers)) fail("providers must be an object");
  const providerNames = Object.keys(raw.providers);
  if (providerNames.length === 0) fail("providers must not be empty");
  uniqueNames(providerNames, "providers");
  const providers: Record<string, ProviderSpec> = {};
  for (const [name, spec] of Object.entries(raw.providers)) {
    if (!isRecord(spec)) fail(`providers.${name} must be an object`);
    if (typeof spec.cli !== "string" || spec.cli.length === 0) {
      fail(`providers.${name}.cli must be a non-empty string`);
    }
    const nativeIn = nullableString(spec.nativeIn, `providers.${name}.nativeIn`);
    if (nativeIn !== null && !(nativeIn in parents)) {
      fail(`providers.${name}.nativeIn names unknown parent ${nativeIn}`);
    }
    providers[name] = { cli: spec.cli, nativeIn };
  }
  for (const parent of parentNames) {
    const owners = providerNames.filter((p) => providers[p].nativeIn === parent);
    if (owners.length !== 1) {
      fail(`parent ${parent} must be native to exactly one provider, got ${owners.length}`);
    }
  }

  if (!isRecord(raw.routes)) fail("routes must be an object");
  const routeParents = Object.keys(raw.routes).sort();
  if (routeParents.join(",") !== [...parentNames].sort().join(",")) {
    fail(`routes must have one row per parent (${parentNames.join(", ")})`);
  }
  const routes: Record<string, Record<string, Route>> = {};
  for (const [parent, row] of Object.entries(raw.routes)) {
    if (!isRecord(row)) fail(`routes.${parent} must be an object`);
    const cols = Object.keys(row).sort();
    if (cols.join(",") !== [...providerNames].sort().join(",")) {
      fail(`routes.${parent} must have one cell per provider (${providerNames.join(", ")})`);
    }
    const out: Record<string, Route> = {};
    for (const [provider, route] of Object.entries(row)) {
      if (route !== "native" && route !== "runner") {
        fail(`routes.${parent}.${provider} must be "native" or "runner"`);
      }
      const expected: Route = providers[provider].nativeIn === parent ? "native" : "runner";
      if (route !== expected) {
        fail(`routes.${parent}.${provider} is ${route}, but providers.${provider}.nativeIn says ${expected}`);
      }
      out[provider] = route;
    }
    routes[parent] = out;
  }

  if (!Array.isArray(raw.families) || raw.families.length === 0) {
    fail("families must be a non-empty list");
  }
  const families: Family[] = raw.families.map((entry, index) => {
    const where = `families[${index}]`;
    if (!isRecord(entry)) fail(`${where} must be an object`);
    if (typeof entry.family !== "string" || !NAME_RE.test(entry.family)) {
      fail(`${where}.family must match ${NAME_RE}`);
    }
    const family = entry.family;
    if (typeof entry.provider !== "string" || !(entry.provider in providers)) {
      fail(`${family}: provider must be one of ${providerNames.join(", ")}`);
    }
    if (typeof entry.model !== "string" || !MODEL_RE.test(entry.model)) {
      fail(`${family}: model must match ${MODEL_RE}`);
    }
    const familyEfforts = stringList(entry.efforts, `${family}.efforts`);
    if (familyEfforts.length === 0) fail(`${family}: efforts must not be empty`);
    for (const effort of familyEfforts) {
      if (!efforts.includes(effort)) fail(`${family}: effort ${effort} is outside the universe`);
    }
    const ordered = efforts.filter((e) => familyEfforts.includes(e));
    if (ordered.join(",") !== familyEfforts.join(",")) {
      fail(`${family}: efforts must be listed in universe order without duplicates`);
    }
    if (typeof entry.defaultEffort !== "string" || !familyEfforts.includes(entry.defaultEffort)) {
      fail(`${family}: defaultEffort must be one of its selectable efforts`);
    }
    const agentStem = nullableString(entry.agentStem, `${family}.agentStem`);
    if (agentStem !== null && !NAME_RE.test(agentStem)) {
      fail(`${family}: agentStem must match ${NAME_RE}`);
    }
    const isClaude = providers[entry.provider].nativeIn === "claude";
    if (isClaude !== (agentStem !== null)) {
      fail(`${family}: agentStem must be present iff the provider is native in Claude Code`);
    }
    const cursorSlug = nullableString(entry.cursorSlug, `${family}.cursorSlug`);
    if (cursorSlug !== null && !cursorSlug.includes("{effort}")) {
      fail(`${family}: cursorSlug must contain {effort}`);
    }
    const reportedModel = nullableString(entry.reportedModel, `${family}.reportedModel`);
    if (reportedModel !== null) {
      try {
        new RegExp(reportedModel);
      } catch {
        fail(`${family}: reportedModel is not a valid regex`);
      }
    }
    return {
      family,
      provider: entry.provider,
      model: entry.model,
      efforts: familyEfforts,
      defaultEffort: entry.defaultEffort,
      agentStem,
      cursorSlug,
      reportedModel,
    };
  });
  uniqueNames(families.map((f) => f.family), "families");
  const pairs = new Set<string>();
  for (const f of families) {
    const key = `${f.provider}:${f.model}`;
    if (pairs.has(key)) fail(`two families share provider:model ${key}`);
    pairs.add(key);
  }
  const stems = new Set<string>();
  for (const f of families) {
    if (f.agentStem === null) continue;
    if (stems.has(f.agentStem)) fail(`two families share agentStem ${f.agentStem}`);
    stems.add(f.agentStem);
  }

  return {
    schemaVersion: 1,
    notes,
    efforts,
    aliases,
    parents,
    providers,
    routes,
    families,
  };
}

/** Read and validate the matrix at `path` (defaults to the plugin's model-matrix.json). */
export function loadMatrix(path: string = MATRIX_PATH): ModelMatrix {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`cannot read ${path}: ${(error as Error).message}`);
  }
  return validateMatrix(raw);
}

/** Parse `<provider>:<model>@<effort>` without consulting the matrix. */
export function parseDescriptor(text: string): Descriptor | null {
  const match = DESCRIPTOR_RE.exec(text);
  if (!match) return null;
  return { provider: match[1], model: match[2], effort: match[3] };
}

export function formatDescriptor(d: Descriptor): string {
  return `${d.provider}:${d.model}@${d.effort}`;
}

/** The family whose (provider, model) matches the descriptor, or null. */
export function familyFor(
  matrix: ModelMatrix,
  d: Pick<Descriptor, "provider" | "model">
): Family | null {
  return (
    matrix.families.find(
      (f) => f.provider === d.provider && f.model === d.model
    ) ?? null
  );
}

export function familyNamed(matrix: ModelMatrix, name: string): Family | null {
  return matrix.families.find((f) => f.family === name) ?? null;
}

/**
 * Resolve a descriptor against the matrix. Returns the family when the pair is
 * known and the effort is selectable for it; otherwise throws MatrixError
 * naming the reason. Aliases are not descriptors and are rejected here.
 */
export function resolveDescriptor(matrix: ModelMatrix, text: string): {
  readonly descriptor: Descriptor;
  readonly family: Family;
} {
  const descriptor = parseDescriptor(text);
  if (!descriptor) fail(`not a descriptor: ${JSON.stringify(text)}`);
  const family = familyFor(matrix, descriptor);
  if (!family) {
    fail(`no matrix family for ${descriptor.provider}:${descriptor.model}`);
  }
  if (!family.efforts.includes(descriptor.effort)) {
    fail(
      `${family.family} does not select effort ${descriptor.effort} (allowed: ${family.efforts.join(" ")})`
    );
  }
  return { descriptor, family };
}

/** Default descriptor of a family: provider:model@defaultEffort. */
export function defaultDescriptor(f: Family): string {
  return formatDescriptor({
    provider: f.provider,
    model: f.model,
    effort: f.defaultEffort,
  });
}

/** Route a provider takes when `parent` is the top-level harness. */
export function routeFor(
  matrix: ModelMatrix,
  parent: string,
  provider: string
): Route {
  const row = matrix.routes[parent];
  if (!row) fail(`unknown parent ${parent}`);
  const route = row[provider];
  if (!route) fail(`unknown provider ${provider}`);
  return route;
}

/** Parent in which a family runs natively, or null when it is always external. */
export function nativeParentOf(matrix: ModelMatrix, f: Family): string | null {
  return matrix.providers[f.provider].nativeIn;
}

/** Claude-native agent name for a family and effort, or null when the family has no stem. */
export function agentName(f: Family, effort: string): string | null {
  if (f.agentStem === null) return null;
  return `pstack-${f.agentStem}-${effort}`;
}

/** Every Claude-native agent name the matrix declares. */
export function declaredAgentNames(matrix: ModelMatrix): string[] {
  const names: string[] = [];
  for (const f of matrix.families) {
    for (const effort of f.efforts) {
      const name = agentName(f, effort);
      if (name !== null) names.push(name);
    }
  }
  return names;
}

/**
 * Map a Cursor pstack selector (for example `grok-4.6-fast-xhigh`) to the
 * family and effort it stands for, or null when no family claims it.
 */
export function fromCursorSlug(
  matrix: ModelMatrix,
  slug: string
): { readonly family: Family; readonly effort: string } | null {
  for (const f of matrix.families) {
    if (f.cursorSlug === null) continue;
    const [before, after] = f.cursorSlug.split("{effort}");
    if (!slug.startsWith(before) || !slug.endsWith(after)) continue;
    const effort = slug.slice(before.length, slug.length - after.length);
    if (matrix.efforts.includes(effort)) return { family: f, effort };
  }
  return null;
}

/** Regex that matches any Cursor selector of any family, for scanning prose. */
export function cursorSlugPattern(matrix: ModelMatrix): RegExp {
  const alternatives = matrix.families
    .filter((f) => f.cursorSlug !== null)
    .map((f) => {
      const [before, after] = (f.cursorSlug as string).split("{effort}");
      const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return `${escape(before)}(?:${matrix.efforts.join("|")})${escape(after)}`;
    });
  return new RegExp(`\\b(?:${alternatives.join("|")})\\b`, "g");
}

/** Does a provider-reported model prove the requested family was served? */
export function reportedModelMatches(f: Family, reported: string): boolean {
  if (f.reportedModel === null) return false;
  return new RegExp(f.reportedModel).test(reported);
}

// --- Rendering -----------------------------------------------------------

export const MATRIX_BEGIN = "<!-- model-matrix:begin -->";
export const MATRIX_END = "<!-- model-matrix:end -->";

function cell(value: string | null): string {
  return value === null ? "-" : `\`${value}\``;
}

/**
 * Markdown rendered from the matrix for provider-dispatch.md. Everything
 * between MATRIX_BEGIN and MATRIX_END in that file is replaced by this text.
 */
export function renderMatrixMarkdown(matrix: ModelMatrix): string {
  const lines: string[] = [];
  lines.push(MATRIX_BEGIN);
  lines.push("");
  lines.push(
    "| Family | Provider | Model | Default effort | Selectable efforts | Native in | Claude-native agent stem | Replaces (Cursor 0.15.2) |"
  );
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const f of matrix.families) {
    lines.push(
      `| ${f.family} | ${f.provider} | ${cell(f.model)} | ${f.defaultEffort} | ${f.efforts.join(" ")} | ${nativeParentOf(matrix, f) ?? "-"} | ${cell(f.agentStem)} | ${cell(f.cursorSlug)} |`
    );
  }
  lines.push("");
  lines.push(
    `The allowed effort universe is exactly ${matrix.efforts.map((e) => `\`${e}\``).join(", ")}. First-run requested efforts are the Default effort cell of each row. A Claude-native agent stem of \`-\` means the family has no Claude-native agent. Otherwise the shipped agent name is \`pstack-<stem>-<effort>\`. Aliases ${matrix.aliases.map((a) => `\`${a}\``).join(" and ")} are not families and carry no effort.`
  );
  lines.push("");
  lines.push("### Route table");
  lines.push("");
  const providerNames = Object.keys(matrix.providers);
  lines.push(
    `| Parent | ${providerNames.map((p) => `\`${p}:*\``).join(" | ")} |`
  );
  lines.push(`|---|${providerNames.map(() => "---").join("|")}|`);
  for (const [parent, spec] of Object.entries(matrix.parents)) {
    const cells = providerNames.map((p) =>
      matrix.routes[parent][p] === "native"
        ? `native \`${spec.nativePrimitive}\``
        : "external runner"
    );
    lines.push(`| ${spec.name} | ${cells.join(" | ")} |`);
  }
  lines.push("");
  lines.push(MATRIX_END);
  return lines.join("\n");
}

/** Replace the generated block inside a markdown document. Throws when markers are missing or duplicated. */
export function spliceMatrixBlock(document: string, block: string): string {
  const begins = document.split(MATRIX_BEGIN).length - 1;
  const ends = document.split(MATRIX_END).length - 1;
  if (begins !== 1 || ends !== 1) {
    fail(
      `document must contain exactly one ${MATRIX_BEGIN} and one ${MATRIX_END} (found ${begins} and ${ends})`
    );
  }
  const start = document.indexOf(MATRIX_BEGIN);
  const end = document.indexOf(MATRIX_END) + MATRIX_END.length;
  if (end < start) fail("matrix end marker precedes begin marker");
  return document.slice(0, start) + block + document.slice(end);
}
