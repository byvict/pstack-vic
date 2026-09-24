#!/usr/bin/env node
// Mechanical half of /update-clis (pstack-vic 0.1.9). The skill's prose owns
// the judgment: which note entries change a contract of the plugin, whether a
// CLI updates, holds, or rolls back, and what goes to Linear. This script owns
// everything that must be exact and prints JSON; it decides nothing.
//
//   update-clis.ts start   [--home <dir>]
//   update-clis.ts check   [--cli <name>] [--home <dir>] [--applications <dir>]
//   update-clis.ts notes   --cli <name> --from <A> --to <B> [--dir <run dir>]
//   update-clis.ts install --cli <name> --version <V> --dir <run dir> [--home <dir>]
//   update-clis.ts probe   --cli <name> --dir <run dir> [--home <dir>] [--timeout <s>] [--plugin-root <dir>]
//   update-clis.ts finish  --dir <run dir> [--keep-copies] [--home <dir>]
//
// Exit codes: 0 ok, 1 an install did not verify or a probe lane failed,
// 2 a source did not answer, 3 another execution holds the lock, 64 usage.
//
// Node 24, type stripping, no dependencies: erasable TypeScript only.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  accessSync,
  appendFileSync,
  chmodSync,
  closeSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import {
  familyFor,
  loadMatrix,
  parseDescriptor,
  PLUGIN_ROOT,
  roleDefault,
  routeFor,
  type Family,
  type ModelMatrix,
} from "../../../scripts/model-matrix.ts";
import { runProbeLane } from "../../poteto-mode/scripts/runner/probe-lane.ts";
import { loadState } from "../../setup-pstack/scripts/setup-pstack.ts";

export const CLIS = ["codex", "grok", "claude"] as const;
export type Cli = (typeof CLIS)[number];

export function isCli(value: string): value is Cli {
  return (CLIS as readonly string[]).includes(value);
}

/**
 * The probe lanes of each CLI. read and write run every pair the two sheets
 * route through the runner; seatbelt repeats write under `codex sandbox` for
 * the CLIs a Codex parent launches; sandbox and manifest run no model.
 */
export const PROBE_LANES = {
  codex: ["read", "write", "sandbox"],
  grok: ["read", "write", "seatbelt"],
  claude: ["read", "write", "seatbelt", "manifest"],
} as const satisfies Record<Cli, readonly string[]>;

/**
 * `codex sandbox` flags that reproduce the seatbelt of a Codex parent
 * configured as docs/reference.md says: workspace-write, network on, and
 * ~/.grok writable. The command runs from the lane directory, which becomes
 * the writable workspace (`-C` needs `--permission-profile` on codex 0.155.1).
 */
const SEATBELT_FLAGS = (home: string): string[] => [
  "-c", 'sandbox_mode="workspace-write"',
  "-c", "sandbox_workspace_write.network_access=true",
  "-c", `sandbox_workspace_write.writable_roots=[${JSON.stringify(join(home, ".grok"))}]`,
];

// --- Versions ------------------------------------------------------------------

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

function versionParts(version: string): [number, number, number] {
  const match = SEMVER.exec(version);
  if (!match) throw new NotesError(`${JSON.stringify(version)} is not a release version (X.Y.Z)`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersions(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

/** The notes interval is open on the left (the installed version) and closed on the right (the target). */
function inRange(version: string, from: string, to: string): boolean {
  return compareVersions(version, from) > 0 && compareVersions(version, to) <= 0;
}

// --- Notes -----------------------------------------------------------------------

export class NotesError extends Error {}

export interface NoteEntry {
  readonly text: string;
  /** Section (codex) or category (grok) the entry came from; the claude CHANGELOG has none. */
  readonly category?: string;
  /** Present only when the source flags the entry as a breaking change. */
  readonly breaking?: true;
}

export interface VersionNotes {
  readonly version: string;
  /** Release date when the source gives one (codex); null otherwise. */
  readonly date: string | null;
  readonly entries: readonly NoteEntry[];
}

export interface Notes {
  readonly cli: Cli;
  readonly from: string;
  readonly to: string;
  readonly source: string;
  /** Versions of (from, to], oldest first. */
  readonly versions: readonly VersionNotes[];
  /** Versions inside the interval whose notes do not exist at the source (grok only; its CDN has no index). */
  readonly missing: readonly string[];
}

/** Bullet lines (`- text`) of a markdown block; an indented line continues the previous bullet. */
function bullets(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (line.startsWith("- ")) out.push(line.slice(2).trim());
    else if (/^\s+\S/.test(line) && out.length > 0) out[out.length - 1] = `${out[out.length - 1]} ${line.trim()}`;
  }
  return out;
}

/** One entry per `## X.Y.Z` section of Claude Code's CHANGELOG.md, in file order (newest first). */
export function parseClaudeChangelog(text: string): VersionNotes[] {
  const versions: VersionNotes[] = [];
  for (const chunk of text.split(/^## /m).slice(1)) {
    const [heading, ...body] = chunk.split("\n");
    const version = heading.trim();
    if (!SEMVER.test(version)) continue;
    versions.push({ version, date: null, entries: bullets(body).map((text) => ({ text })) });
  }
  return versions;
}

/** A codex release body: `## <Section>` headings over bullets; a section named "Breaking…" flags its entries. */
export function parseCodexReleaseBody(body: string): NoteEntry[] {
  const entries: NoteEntry[] = [];
  for (const chunk of body.split(/^## /m).slice(1)) {
    const [heading, ...lines] = chunk.split("\n");
    const category = heading.trim();
    const breaking = /breaking/i.test(category);
    for (const text of bullets(lines)) entries.push(breaking ? { text, category, breaking: true } : { text, category });
  }
  return entries;
}

export interface CodexRelease {
  readonly version: string;
  readonly tag: string;
  readonly date: string;
}

/** `gh release list --json tagName,publishedAt` output → the CLI's own releases (`rust-vX.Y.Z`), oldest first. */
export function codexStableVersions(listJson: string): CodexRelease[] {
  const list = JSON.parse(listJson) as Array<{ tagName?: unknown; publishedAt?: unknown }>;
  const releases: CodexRelease[] = [];
  for (const item of list) {
    const tag = typeof item.tagName === "string" ? item.tagName : "";
    const match = /^rust-v(\d+\.\d+\.\d+)$/.exec(tag);
    if (!match) continue;
    releases.push({ version: match[1], tag, date: typeof item.publishedAt === "string" ? item.publishedAt : "" });
  }
  return releases.sort((a, b) => compareVersions(a.version, b.version));
}

/** One `<version>.external.json` of the grok CDN: `[{ category, description, breaking_change }]`. */
export function parseGrokChangelog(json: string): NoteEntry[] {
  const list = JSON.parse(json) as Array<{ category?: unknown; description?: unknown; breaking_change?: unknown }>;
  if (!Array.isArray(list)) throw new NotesError("grok changelog is not a JSON list");
  return list.flatMap((item) => {
    if (typeof item.description !== "string") return [];
    const category = typeof item.category === "string" ? item.category : undefined;
    const entry: NoteEntry = category === undefined ? { text: item.description.trim() } : { text: item.description.trim(), category };
    return [item.breaking_change === true ? { ...entry, breaking: true as const } : entry];
  });
}

const CLAUDE_CHANGELOG_URL = "https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md";
const GROK_CHANGELOGS_URL = "https://x.ai/cli/changelogs";
const CODEX_REPO = "openai/codex";

type Fetcher = (url: string) => Promise<{ readonly status: number; text(): Promise<string> }>;

export interface NotesContext {
  /** PATH (for gh) and the loopback-only source overrides the tests use. */
  readonly env?: NodeJS.ProcessEnv;
  readonly fetch?: Fetcher;
}

/** A source override is honored only on loopback, so a stray variable cannot redirect a real run. */
function sourceUrl(env: NodeJS.ProcessEnv, variable: string, fallback: string): string {
  const override = env[variable];
  if (override === undefined || override === "") return fallback;
  try {
    const host = new URL(override).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "[::1]" ? override.replace(/\/$/, "") : fallback;
  } catch {
    return fallback;
  }
}

async function fetchText(fetcher: Fetcher, url: string): Promise<string | null> {
  let response: Awaited<ReturnType<Fetcher>>;
  try {
    response = await fetcher(url);
  } catch (error) {
    throw new NotesError(`could not fetch ${url}: ${(error as Error).message}`);
  }
  if (response.status === 404) return null;
  if (response.status < 200 || response.status >= 300) throw new NotesError(`could not fetch ${url}: HTTP ${response.status}`);
  return response.text();
}

function run(command: string, args: readonly string[], env: NodeJS.ProcessEnv, timeout = 0, cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile(command, [...args], { env, timeout, cwd, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : 127;
      done({ code, stdout, stderr: stderr || (error?.message ?? "") });
    });
  });
}

async function gh(args: readonly string[], env: NodeJS.ProcessEnv): Promise<string> {
  const result = await run("gh", args, env);
  if (result.code !== 0) throw new NotesError(`gh ${args.slice(0, 2).join(" ")} failed: ${result.stderr.trim().slice(0, 500)}`);
  return result.stdout;
}

/** Candidate grok versions of (from, to]: patch by patch, each release line walked until the CDN says 404. */
async function grokNotes(fetcher: Fetcher, base: string, from: string, to: string): Promise<{ versions: VersionNotes[]; missing: string[] }> {
  const [fromMajor, fromMinor, fromPatch] = versionParts(from);
  const [toMajor, toMinor, toPatch] = versionParts(to);
  const versions: VersionNotes[] = [];
  const missing: string[] = [];
  const read = async (version: string): Promise<boolean> => {
    const body = await fetchText(fetcher, `${base}/${version}.external.json`);
    if (body === null) return false;
    versions.push({ version, date: null, entries: parseGrokChangelog(body) });
    return true;
  };
  if (fromMajor === toMajor && fromMinor === toMinor) {
    for (let patch = fromPatch + 1; patch <= toPatch; patch += 1) {
      const version = `${toMajor}.${toMinor}.${patch}`;
      if (!(await read(version))) missing.push(version);
    }
  } else {
    // Across release lines there is no index: finish the old line until its
    // first 404, then walk the target line from .0; a gap there is recorded.
    for (let patch = fromPatch + 1; await read(`${fromMajor}.${fromMinor}.${patch}`); patch += 1);
    for (let patch = 0; patch <= toPatch; patch += 1) {
      const version = `${toMajor}.${toMinor}.${patch}`;
      if (!(await read(version))) missing.push(version);
    }
  }
  if (!versions.some((v) => v.version === to)) throw new NotesError(`no notes for grok ${to} at ${base}`);
  return { versions, missing: missing.filter((version) => version !== to) };
}

/**
 * The grok CDN repeats entries in later versions; each text stays once, under
 * the oldest version that has it, and stays breaking when any repeat says so.
 */
function firstOccurrences(versions: readonly VersionNotes[]): VersionNotes[] {
  const breaking = new Set(versions.flatMap((version) => version.entries.filter((entry) => entry.breaking).map((entry) => entry.text)));
  const seen = new Set<string>();
  return versions.map((version) => ({
    ...version,
    entries: version.entries.flatMap((entry) => {
      if (seen.has(entry.text)) return [];
      seen.add(entry.text);
      return [breaking.has(entry.text) ? { ...entry, breaking: true as const } : entry];
    }),
  }));
}

/** Download and normalize the notes of every release in (from, to], oldest first, each entry once. */
export async function fetchNotes(cli: Cli, from: string, to: string, context: NotesContext = {}): Promise<Notes> {
  const notes = await rawNotes(cli, from, to, context);
  return { ...notes, versions: firstOccurrences(notes.versions) };
}

async function rawNotes(cli: Cli, from: string, to: string, context: NotesContext): Promise<Notes> {
  const env = context.env ?? process.env;
  const fetcher: Fetcher = context.fetch ?? ((url) => fetch(url));
  if (compareVersions(from, to) >= 0) throw new NotesError(`--from ${from} is not older than --to ${to}`);
  switch (cli) {
    case "claude": {
      const source = sourceUrl(env, "PSTACK_UPDATE_CLIS_CLAUDE_CHANGELOG_URL", CLAUDE_CHANGELOG_URL);
      const text = await fetchText(fetcher, source);
      if (text === null) throw new NotesError(`could not fetch ${source}: HTTP 404`);
      const versions = parseClaudeChangelog(text)
        .filter((v) => inRange(v.version, from, to))
        .sort((a, b) => compareVersions(a.version, b.version));
      if (!versions.some((v) => v.version === to)) throw new NotesError(`no notes for claude ${to} in ${source}`);
      return { cli, from, to, source, versions, missing: [] };
    }
    case "codex": {
      const listArgs = ["release", "list", "-R", CODEX_REPO, "--exclude-pre-releases", "--limit", "100", "--json", "tagName,publishedAt"];
      const releases = codexStableVersions(await gh(listArgs, env)).filter((r) => inRange(r.version, from, to));
      if (!releases.some((r) => r.version === to)) throw new NotesError(`no notes for codex ${to}: no stable release rust-v${to} on ${CODEX_REPO}`);
      const versions: VersionNotes[] = [];
      for (const release of releases) {
        const view = JSON.parse(await gh(["release", "view", release.tag, "-R", CODEX_REPO, "--json", "tagName,publishedAt,body"], env)) as { body?: unknown };
        versions.push({ version: release.version, date: release.date, entries: parseCodexReleaseBody(typeof view.body === "string" ? view.body : "") });
      }
      return { cli, from, to, source: `gh release view -R ${CODEX_REPO}`, versions, missing: [] };
    }
    case "grok": {
      const base = sourceUrl(env, "PSTACK_UPDATE_CLIS_GROK_CHANGELOGS_URL", GROK_CHANGELOGS_URL);
      const { versions, missing } = await grokNotes(fetcher, base, from, to);
      return { cli, from, to, source: `${base}/<version>.external.json`, versions, missing };
    }
  }
}

// --- Machine and check -------------------------------------------------------------

/** Where the CLIs live: `home` holds nvm, ~/.grok, ~/.claude and the app and cache folders; `env.PATH` is what the parents resolve. */
export interface Machine {
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
  readonly applications: string;
}

export function defaultMachine(overrides: Partial<Machine> = {}): Machine {
  return { home: homedir(), env: process.env, applications: "/Applications", ...overrides };
}

const NPM_PACKAGES = { claude: "@anthropic-ai/claude-code", codex: "@openai/codex" } as const;

export type Installer =
  | { readonly kind: "npm"; readonly package: string; readonly prefix: string }
  | { readonly kind: "grok"; readonly binary: string }
  | { readonly kind: "unknown" };

export interface Copy {
  readonly path: string;
  readonly realpath: string;
  readonly version: string | null;
  readonly installer: Installer;
}

export interface AppCopy {
  readonly app: string;
  readonly path: string;
  readonly version: string | null;
}

export interface RunningProcess {
  readonly pid: number;
  readonly command: string;
}

export type CliStatus = "current" | "update-available" | "unverified" | "not-installed";

export interface CliCheck {
  readonly cli: Cli;
  readonly status: CliStatus;
  /** The copy both parents resolve: the first executable on PATH. */
  readonly resolved: Copy | null;
  /** Every other installed copy (other nvm Nodes, other PATH entries); reported, never touched. */
  readonly duplicates: readonly Copy[];
  readonly channel: string | null;
  readonly latest: string | null;
  /** Processes running a file of the resolved install; the apps' own binaries live elsewhere and never count. */
  readonly inUse: readonly RunningProcess[] | null;
  readonly apps: readonly AppCopy[];
  readonly error: string | null;
}

export interface CheckReport {
  readonly checkedAt: string;
  readonly clis: readonly CliCheck[];
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function installerOf(cli: Cli, realpath: string, home: string): Installer {
  if (cli === "grok") {
    const grokHome = existsSync(join(home, ".grok")) ? realpathSync(join(home, ".grok")) : join(home, ".grok");
    return realpath.startsWith(grokHome + sep) ? { kind: "grok", binary: realpath } : { kind: "unknown" };
  }
  const pkg = NPM_PACKAGES[cli];
  const at = realpath.indexOf(`${sep}lib${sep}node_modules${sep}${pkg}${sep}`);
  return at < 0 ? { kind: "unknown" } : { kind: "npm", package: pkg, prefix: realpath.slice(0, at) };
}

async function versionOf(path: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const result = await run(path, ["--version"], env, 30_000);
  if (result.code !== 0) return null;
  return /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(result.stdout)?.[1] ?? null;
}

/** Installed copies, the resolved one first: PATH in order, then every nvm Node, then grok's own bin. One entry per real file. */
async function copiesOf(cli: Cli, machine: Machine): Promise<{ resolved: Copy | null; duplicates: Copy[] }> {
  const onPath = (machine.env.PATH ?? "").split(delimiter).filter((dir) => dir.length > 0).map((dir) => join(dir, cli));
  const nvm = join(machine.home, ".nvm", "versions", "node");
  const others = existsSync(nvm) ? readdirSync(nvm).sort().map((node) => join(nvm, node, "bin", cli)) : [];
  if (cli === "grok") others.push(join(machine.home, ".grok", "bin", "grok"));
  const seen = new Set<string>();
  const copies: Array<Copy & { readonly fromPath: boolean }> = [];
  for (const [index, path] of [...onPath, ...others].entries()) {
    if (!isExecutableFile(path)) continue;
    const real = realpathSync(path);
    if (seen.has(real)) continue;
    seen.add(real);
    copies.push({ path, realpath: real, version: await versionOf(path, machine.env), installer: installerOf(cli, real, machine.home), fromPath: index < onPath.length });
  }
  const strip = ({ fromPath: _, ...copy }: Copy & { readonly fromPath: boolean }): Copy => copy;
  const first = copies[0];
  if (first === undefined || !first.fromPath) return { resolved: null, duplicates: copies.map(strip) };
  return { resolved: strip(first), duplicates: copies.slice(1).map(strip) };
}

function npmEnv(prefix: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, PATH: `${join(prefix, "bin")}${delimiter}${env.PATH ?? ""}` };
}

function claudeChannel(home: string): string {
  const path = join(home, ".claude", "settings.json");
  if (!existsSync(path)) return "latest";
  const settings = JSON.parse(readFileSync(path, "utf8")) as { autoUpdatesChannel?: unknown };
  return typeof settings.autoUpdatesChannel === "string" ? settings.autoUpdatesChannel : "latest";
}

async function latestOf(cli: Cli, copy: Copy, machine: Machine): Promise<{ channel: string; latest: string }> {
  if (copy.installer.kind === "npm") {
    const channel = cli === "claude" ? claudeChannel(machine.home) : "latest";
    const npm = join(copy.installer.prefix, "bin", "npm");
    const command = `npm view ${copy.installer.package} dist-tags`;
    const result = await run(npm, ["view", copy.installer.package, "dist-tags", "--json"], npmEnv(copy.installer.prefix, machine.env), 60_000);
    if (result.code !== 0) throw new Error(`${command} failed: ${result.stderr.trim().slice(0, 300)}`);
    const latest = (JSON.parse(result.stdout) as Record<string, unknown>)[channel];
    if (typeof latest !== "string") throw new Error(`${command} has no ${JSON.stringify(channel)} tag`);
    return { channel, latest };
  }
  if (copy.installer.kind === "grok") {
    const result = await run(copy.path, ["update", "--check", "--json"], machine.env, 60_000);
    const report = result.code === 0 ? (JSON.parse(result.stdout) as { latestVersion?: unknown; channel?: unknown; error?: unknown }) : null;
    if (report === null || typeof report.latestVersion !== "string") {
      throw new Error(`grok update --check --json failed: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
    }
    return { channel: typeof report.channel === "string" ? report.channel : "stable", latest: report.latestVersion };
  }
  throw new Error(`${copy.realpath} is neither an npm global install nor grok's own download; update it by hand`);
}

function executablesUnder(root: string, limit = 2_000): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= limit) return;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && (statSync(path).mode & 0o111) !== 0) out.push(path);
    }
  };
  walk(root);
  return out;
}

/** Processes that hold one of these files open, the way an executable is held while it runs (lsof). */
async function processesHolding(files: readonly string[], env: NodeJS.ProcessEnv): Promise<RunningProcess[]> {
  if (files.length === 0) return [];
  const lsof = isExecutableFile("/usr/sbin/lsof") ? "/usr/sbin/lsof" : "lsof";
  const result = await run(lsof, ["-t", "--", ...files], env, 30_000);
  // lsof exits 1 whenever one listed file is not open, even after finding the others.
  if (result.code > 1) throw new Error(`lsof failed: ${result.stderr.trim().slice(0, 300)}`);
  const pids = [...new Set(result.stdout.split("\n").map((line) => Number(line.trim())).filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid))];
  if (pids.length === 0) return [];
  const ps = await run("ps", ["-o", "pid=,args=", "-p", pids.join(",")], env, 30_000);
  const commands = new Map(ps.stdout.split("\n").map((line) => /^\s*(\d+)\s+(.*)$/.exec(line)).flatMap((m) => (m ? [[Number(m[1]), m[2]] as const] : [])));
  return pids.sort((a, b) => a - b).map((pid) => ({ pid, command: commands.get(pid) ?? "" }));
}

function installFiles(copy: Copy): string[] {
  const installer = copy.installer;
  if (installer.kind === "npm") return executablesUnder(join(installer.prefix, "lib", "node_modules", installer.package));
  if (installer.kind === "grok") return [installer.binary];
  return [copy.realpath];
}

async function appCopies(cli: Cli, machine: Machine): Promise<AppCopy[]> {
  if (cli === "claude") {
    const root = join(machine.home, "Library", "Application Support", "Claude", "claude-code");
    if (!existsSync(root)) return [];
    return readdirSync(root)
      .filter((name) => SEMVER.test(name))
      .sort(compareVersions)
      .map((version) => ({ app: "Claude", version, path: join(root, version, "claude.app", "Contents", "MacOS", "claude") }));
  }
  if (cli === "codex") {
    const path = join(machine.applications, "ChatGPT.app", "Contents", "Resources", "codex");
    return isExecutableFile(path) ? [{ app: "ChatGPT", path, version: await versionOf(path, machine.env) }] : [];
  }
  return [];
}

export async function checkCli(cli: Cli, machine: Machine): Promise<CliCheck> {
  const { resolved, duplicates } = await copiesOf(cli, machine);
  const apps = await appCopies(cli, machine);
  if (resolved === null) {
    return { cli, status: "not-installed", resolved, duplicates, channel: null, latest: null, inUse: [], apps, error: `no ${cli} on PATH` };
  }
  let inUse: RunningProcess[] | null = null;
  const errors: string[] = [];
  try {
    inUse = await processesHolding(installFiles(resolved), machine.env);
  } catch (error) {
    errors.push((error as Error).message);
  }
  let channel: string | null = null;
  let latest: string | null = null;
  try {
    ({ channel, latest } = await latestOf(cli, resolved, machine));
  } catch (error) {
    errors.push((error as Error).message);
  }
  const comparable = resolved.version !== null && latest !== null && SEMVER.test(resolved.version) && SEMVER.test(latest);
  if (resolved.version === null) errors.push(`${resolved.path} --version did not report a version`);
  else if (latest !== null && !comparable) errors.push(`cannot compare ${resolved.version} with ${latest}`);
  const status: CliStatus = !comparable
    ? "unverified"
    : compareVersions(latest as string, resolved.version as string) > 0 ? "update-available" : "current";
  return { cli, status, resolved, duplicates, channel, latest, inUse, apps, error: errors.length === 0 ? null : errors.join("; ") };
}

export async function check(clis: readonly Cli[], machine: Machine): Promise<CheckReport> {
  const checked: CliCheck[] = [];
  for (const cli of clis) checked.push(await checkCli(cli, machine));
  return { checkedAt: new Date().toISOString(), clis: checked };
}

// --- Run directory and lock -----------------------------------------------------------

export class RunLockError extends Error {}

const LOCK_FILE = "lock";
const STALE_LOCK_MS = 12 * 3_600_000;
const KEEP_RUNS = 10;
const COPY_PREFIX = "grok-backup-";

export function cacheRoot(home: string): string {
  return join(home, "Library", "Caches", "pstack-vic", "update-clis");
}

interface LockRecord {
  readonly dir: string;
  readonly startedAt: string;
}

function readLock(path: string): LockRecord | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as LockRecord;
  } catch {
    return { dir: "(unreadable lock)", startedAt: statSync(path).mtime.toISOString() };
  }
}

export interface StartedRun {
  readonly dir: string;
  readonly lock: string;
  /** A lock older than 12 hours that this run took over; null when the lock was free. */
  readonly staleLock: LockRecord | null;
}

/**
 * Open an execution: a fresh run directory under the cache and the lock that
 * says it is the only one. Every run of the skill calls this first and
 * `finishRun` last; install and probe refuse any directory that does not hold
 * the lock.
 */
export function startRun(home: string, now: Date = new Date()): StartedRun {
  const cache = cacheRoot(home);
  mkdirSync(cache, { recursive: true });
  const lock = join(cache, LOCK_FILE);
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
  let dir = join(cache, stamp);
  for (let suffix = 2; existsSync(dir); suffix += 1) dir = join(cache, `${stamp}-${suffix}`);
  const record = `${JSON.stringify({ dir, startedAt: now.toISOString() })}\n`;
  let staleLock: LockRecord | null = null;
  try {
    const fd = openSync(lock, "wx", 0o600);
    writeFileSync(fd, record);
    closeSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const held = readLock(lock);
    const age = held === null ? Infinity : now.getTime() - Date.parse(held.startedAt);
    if (!(age > STALE_LOCK_MS)) {
      throw new RunLockError(`update-clis is already running (já em execução): ${lock} held by ${held?.dir} since ${held?.startedAt}`);
    }
    staleLock = held;
    writeFileSync(lock, record, { mode: 0o600 });
  }
  mkdirSync(dir);
  return { dir, lock, staleLock };
}

function requireLock(home: string, dir: string): void {
  const lock = join(cacheRoot(home), LOCK_FILE);
  const held = readLock(lock);
  if (held === null || resolve(held.dir) !== resolve(dir)) {
    throw new RunLockError(`${dir} does not hold the update-clis lock (${lock} ${held === null ? "is free" : `is held by ${held.dir}`}); run start first`);
  }
}

export interface FinishedRun {
  readonly removedCopies: readonly string[];
  readonly pruned: readonly string[];
  readonly lockReleased: boolean;
}

/**
 * Close an execution: delete its grok copies (unless a failed rollback left
 * them as the way back), keep the ten most recent run directories, release the lock.
 */
export function finishRun(home: string, dir: string, options: { readonly keepCopies?: boolean } = {}): FinishedRun {
  const cache = cacheRoot(home);
  const removedCopies = existsSync(dir) && options.keepCopies !== true
    ? readdirSync(dir).filter((name) => name.startsWith(COPY_PREFIX)).sort().map((name) => join(dir, name))
    : [];
  for (const path of removedCopies) rmSync(path, { force: true });
  const runs = readdirSync(cache, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const keep = new Set([...runs.slice(-KEEP_RUNS), basename(dir)]);
  const pruned = runs.filter((name) => !keep.has(name)).map((name) => join(cache, name));
  for (const path of pruned) rmSync(path, { recursive: true, force: true });
  const lock = join(cache, LOCK_FILE);
  const held = readLock(lock);
  const lockReleased = held !== null && resolve(held.dir) === resolve(dir);
  if (lockReleased) unlinkSync(lock);
  return { removedCopies, pruned, lockReleased };
}

// --- Install ------------------------------------------------------------------------

export interface InstallResult {
  readonly cli: Cli;
  readonly from: string | null;
  readonly to: string;
  /** What `--version` reports after the attempt. */
  readonly version: string | null;
  readonly ok: boolean;
  readonly method: "npm" | "grok update" | "restored-copy" | "none";
  readonly detail: string;
  readonly log: string;
}

interface GrokCopy {
  readonly version: string;
  readonly binary: string;
  readonly mode: number;
}

function grokCopyPath(dir: string, version: string): string {
  return join(dir, `${COPY_PREFIX}${version}`);
}

/** Keep the current grok binary in the run directory before anything replaces it; one copy per version. */
function keepGrokCopy(dir: string, version: string, binary: string): void {
  const path = grokCopyPath(dir, version);
  if (existsSync(path)) return;
  copyFileSync(binary, path, fsConstants.COPYFILE_FICLONE);
  const record: GrokCopy = { version, binary, mode: statSync(binary).mode & 0o777 };
  writeFileSync(`${path}.json`, `${JSON.stringify(record, null, 2)}\n`);
}

function restoreGrokCopy(dir: string, version: string): string | null {
  const path = grokCopyPath(dir, version);
  if (!existsSync(path) || !existsSync(`${path}.json`)) return null;
  const record = JSON.parse(readFileSync(`${path}.json`, "utf8")) as GrokCopy;
  copyFileSync(path, record.binary);
  chmodSync(record.binary, record.mode);
  return path;
}

/**
 * Install one exact version into the copy the parents resolve, and read the
 * version back. The same call rolls back: npm takes any published version, and
 * grok falls back to the binary copy this run kept when `grok update` fails or
 * lands on another version.
 */
export async function install(cli: Cli, version: string, dir: string, machine: Machine): Promise<InstallResult> {
  requireLock(machine.home, dir);
  const { resolved } = await copiesOf(cli, machine);
  const log = join(dir, `install-${cli}-${version}.log`);
  writeFileSync(log, "");
  const logged = (command: string, result: { code: number; stdout: string; stderr: string }): void => {
    appendFileSync(log, `$ ${command}\n${result.stdout}${result.stderr}\n[exit ${result.code}]\n`);
  };
  const base = { cli, to: version, log };
  if (resolved === null) return { ...base, from: null, version: null, ok: false, method: "none", detail: `no ${cli} on PATH` };
  const from = resolved.version;
  const readBack = async (): Promise<string | null> => versionOf(resolved.path, machine.env);
  const mismatch = (after: string | null): string => `${cli} --version reports ${after ?? "nothing"}, expected ${version}`;
  const installer = resolved.installer;
  if (installer.kind === "npm") {
    const spec = `${installer.package}@${version}`;
    const result = await run(join(installer.prefix, "bin", "npm"), ["install", "-g", spec], npmEnv(installer.prefix, machine.env), 600_000);
    logged(`npm install -g ${spec}`, result);
    const after = await readBack();
    const ok = result.code === 0 && after === version;
    const detail = result.code !== 0 ? `npm install -g ${spec} failed (exit ${result.code})` : ok ? `npm install -g ${spec} with ${installer.prefix}` : mismatch(after);
    return { ...base, from, version: after, ok, method: "npm", detail };
  }
  if (installer.kind === "grok") {
    if (from !== null) keepGrokCopy(dir, from, installer.binary);
    const result = await run(resolved.path, ["update", "--version", version], machine.env, 600_000);
    logged(`grok update --version ${version}`, result);
    const after = await readBack();
    if (result.code === 0 && after === version) return { ...base, from, version: after, ok: true, method: "grok update", detail: `grok update --version ${version}` };
    const why = result.code !== 0 ? `grok update --version ${version} failed (exit ${result.code})` : mismatch(after);
    const restored = restoreGrokCopy(dir, version);
    if (restored === null) return { ...base, from, version: after, ok: false, method: "grok update", detail: `${why}; no copy of grok ${version} in ${dir} to restore` };
    const back = await readBack();
    const ok = back === version;
    return { ...base, from, version: back, ok, method: "restored-copy", detail: `${why}; restored ${restored}${ok ? "" : `, but ${mismatch(back)}`}` };
  }
  return { ...base, from, version: from, ok: false, method: "none", detail: `${resolved.realpath} is neither an npm global install nor grok's own download; update it by hand` };
}

// --- Probe ------------------------------------------------------------------------

export interface ProbePair {
  readonly family: string;
  readonly effort: string;
  /** `<family>@<effort>`, the id the lanes and their directories carry. */
  readonly pair: string;
  readonly provider: string;
  readonly model: string;
  /** The parents whose sheet (or matrix defaults, without a sheet) route this pair through the runner. */
  readonly parents: readonly string[];
}

/**
 * The pairs a CLI's probe runs: every lane of the two sheets that reaches this
 * CLI through the runner in that parent (claude from the Codex sheet, codex from
 * the Claude sheet, grok from both), once per family@effort, in matrix order. A
 * parent without a sheet contributes its matrix defaults.
 */
export function probePairs(cli: Cli, home: string, matrix: ModelMatrix = loadMatrix()): ProbePair[] {
  const pairs = new Map<string, { family: Family; effort: string; parents: string[] }>();
  for (const parent of Object.keys(matrix.parents)) {
    const state = loadState({ parent, home, matrix });
    const rows = state.exists ? state.rows : matrix.roles.map((role) => ({ lanes: roleDefault(matrix, role.role, parent) }));
    for (const lane of rows.flatMap((row) => row.lanes)) {
      const descriptor = parseDescriptor(lane);
      const family = descriptor === null ? null : familyFor(matrix, descriptor);
      if (descriptor === null || family === null) continue;
      if (matrix.providers[family.provider]?.cli !== cli || routeFor(matrix, parent, family.provider) !== "runner") continue;
      const key = `${family.family}@${descriptor.effort}`;
      const entry = pairs.get(key) ?? { family, effort: descriptor.effort, parents: [] };
      if (!entry.parents.includes(parent)) entry.parents.push(parent);
      pairs.set(key, entry);
    }
  }
  const order = (entry: { family: Family; effort: string }): number =>
    matrix.families.indexOf(entry.family) * matrix.efforts.length + matrix.efforts.indexOf(entry.effort);
  return [...pairs.values()]
    .sort((a, b) => order(a) - order(b))
    .map(({ family, effort, parents }) => ({ family: family.family, effort, pair: `${family.family}@${effort}`, provider: family.provider, model: family.model, parents }));
}

export type ProbeLaneName = (typeof PROBE_LANES)[Cli][number];

export interface ProbeLaneResult {
  readonly lane: ProbeLaneName;
  readonly pair: string | null;
  readonly status: "passed" | "failed";
  readonly detail: string;
  readonly dir: string;
  /** seatbelt lanes: the file writes the seatbelt denied while the lane ran (`codex sandbox --log-denials`). */
  readonly denials?: readonly string[];
}

export interface ProbeSummary {
  readonly cli: Cli;
  readonly version: string;
  readonly dir: string;
  readonly pairs: readonly string[];
  readonly startedAt: string;
  readonly completedAt: string;
  readonly ok: boolean;
  readonly lanes: readonly ProbeLaneResult[];
}

export interface ProbeOptions {
  readonly timeoutSeconds: number;
  /** The plugin whose manifests the manifest lane validates: the one this script belongs to. */
  readonly pluginRoot: string;
}

function laneDirectory(dir: string, name: string): string {
  const path = join(dir, name);
  mkdirSync(join(path, "work"), { recursive: true });
  return path;
}

/** File writes the seatbelt denied, minus device noise every process makes (/dev/dtracehelper, /dev/tty). */
function writeFileDenials(transcript: string): string[] {
  const at = transcript.lastIndexOf("=== Sandbox denials ===");
  if (at < 0) return [];
  return transcript
    .slice(at)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /\bfile-write[a-z-]* /.test(line) && !/ \/dev\//.test(line));
}

async function modelLane(
  lane: "read" | "write" | "seatbelt",
  cli: Cli,
  pair: ProbePair,
  dir: string,
  machine: Machine,
  codex: Copy | null,
  timeoutSeconds: number
): Promise<ProbeLaneResult> {
  const laneDir = laneDirectory(dir, `${lane}-${pair.pair}`);
  const base = { lane, pair: pair.pair, dir: laneDir };
  if (lane === "seatbelt" && codex === null) return { ...base, status: "failed", detail: "no codex on PATH to run the seatbelt with" };
  const transcriptPath = join(laneDir, "transcript.log");
  const verdict = await runProbeLane({
    // A Codex parent launches claude, and grok under its seatbelt; a Claude parent launches codex and grok.
    parent: lane === "seatbelt" || cli === "claude" ? "codex" : "claude",
    simulatedParent: true,
    provider: pair.provider,
    model: pair.model,
    effort: pair.effort,
    marker: `PSTACK-UPDATE-${cli}-${lane}-${pair.family}-${pair.effort}-${randomBytes(4).toString("hex")}`,
    mode: lane === "read" ? "read-only" : "isolated-write",
    cwd: join(laneDir, "work"),
    promptPath: join(laneDir, "prompt.md"),
    outputPath: join(laneDir, "output.md"),
    receiptPath: join(laneDir, "receipt.json"),
    transcriptPath,
    env: machine.env,
    timeoutSeconds,
    ...(lane === "seatbelt" && codex !== null
      ? {
          wrap: { command: codex.path, args: ["sandbox", "--log-denials", ...SEATBELT_FLAGS(machine.home), "--"], cwd: laneDir },
          ...(cli === "grok" ? { requireArgv: ["--sandbox", "none"] } : {}),
        }
      : {}),
  });
  const result: ProbeLaneResult = { ...base, status: verdict.passed ? "passed" : "failed", detail: verdict.detail };
  return lane === "seatbelt" ? { ...result, denials: writeFileDenials(existsSync(transcriptPath) ? readFileSync(transcriptPath, "utf8") : "") } : result;
}

// Run under the seatbelt, from the lane directory: report the marker, then try
// the lane directory, ~/.grok (a writable root) and a file next to the lane
// directory (outside every writable root).
const SANDBOX_SCRIPT = [
  'printf "CODEX_SANDBOX=%s\\n" "${CODEX_SANDBOX:-}"',
  'if printf ok > lane-write.txt 2>/dev/null; then echo lane-write=ok; else echo lane-write=denied; fi',
  'if [ -z "$1" ]; then echo grok-write=skipped; elif printf ok > "$1" 2>/dev/null; then echo grok-write=ok; rm -f "$1"; else echo grok-write=denied; fi',
  'if printf ok > "$2" 2>/dev/null; then echo outside-write=ok; rm -f "$2"; else echo outside-write=denied; fi',
].join("\n");

async function sandboxLane(dir: string, machine: Machine, codex: Copy | null, timeoutSeconds: number): Promise<ProbeLaneResult> {
  const laneDir = laneDirectory(dir, "sandbox");
  const base = { lane: "sandbox" as const, pair: null, dir: laneDir };
  if (codex === null) return { ...base, status: "failed", detail: "no codex on PATH" };
  const token = randomBytes(4).toString("hex");
  const grokHome = join(machine.home, ".grok");
  const grokFile = existsSync(grokHome) ? join(grokHome, `.pstack-update-clis-${token}`) : "";
  const outside = join(dir, `sandbox-outside-${token}.txt`);
  const args = ["sandbox", ...SEATBELT_FLAGS(machine.home), "--", "/bin/sh", "-c", SANDBOX_SCRIPT, "sh", grokFile, outside];
  const result = await run(codex.path, args, machine.env, timeoutSeconds * 1_000, laneDir);
  writeFileSync(join(laneDir, "transcript.log"), `$ codex ${args.join(" ")}\n${result.stdout}${result.stderr}[exit ${result.code}]\n`);
  for (const path of [grokFile, outside]) if (path !== "") rmSync(path, { force: true });
  const seen = Object.fromEntries(result.stdout.split("\n").flatMap((line) => {
    const eq = line.indexOf("=");
    return eq > 0 ? [[line.slice(0, eq), line.slice(eq + 1)]] : [];
  }));
  const problems: string[] = [];
  if (result.code !== 0) problems.push(`codex sandbox exited ${result.code}: ${result.stderr.trim().slice(0, 300)}`);
  if (!seen.CODEX_SANDBOX) problems.push("CODEX_SANDBOX was not exported");
  if (seen["lane-write"] !== "ok") problems.push("the lane directory was not writable");
  if (seen["grok-write"] === "denied") problems.push("~/.grok was not writable although it is a writable root");
  if (seen["outside-write"] !== "denied") problems.push(`a write outside the workspace went through (${outside})`);
  if (problems.length > 0) return { ...base, status: "failed", detail: problems.join("; ") };
  const grok = seen["grok-write"] === "ok" ? "~/.grok write accepted" : "no ~/.grok to try";
  return { ...base, status: "passed", detail: `CODEX_SANDBOX=${seen.CODEX_SANDBOX}, lane write accepted, ${grok}, write outside the workspace denied` };
}

async function manifestLane(dir: string, machine: Machine, pluginRoot: string, timeoutSeconds: number): Promise<ProbeLaneResult> {
  const laneDir = laneDirectory(dir, "manifest");
  const base = { lane: "manifest" as const, pair: null, dir: laneDir };
  const args = ["--test", "--test-reporter=tap", "scripts/manifests.test.ts"];
  const result = await run(process.execPath, args, machine.env, timeoutSeconds * 1_000, pluginRoot);
  writeFileSync(join(laneDir, "transcript.log"), `$ (cd ${pluginRoot} && node ${args.join(" ")})\n${result.stdout}${result.stderr}[exit ${result.code}]\n`);
  const line = result.stdout.split("\n").find((text) => /^\s*(not )?ok \d+ - .*claude plugin validate/.test(text));
  if (line === undefined) return { ...base, status: "failed", detail: `the claude plugin validate test did not run (exit ${result.code})` };
  if (/# SKIP/i.test(line)) return { ...base, status: "failed", detail: `the claude plugin validate test was skipped: ${line.trim()}` };
  if (result.code !== 0) return { ...base, status: "failed", detail: `node --test scripts/manifests.test.ts exited ${result.code}: ${line.trim()}` };
  return { ...base, status: "passed", detail: `manifests.test.ts passed in ${pluginRoot}, claude plugin validate ran` };
}

/**
 * Run the CLI's probe lanes one after the other against the version installed
 * now, under `<run dir>/probe-<cli>-<version>/`. The same call is the counter
 * probe after a rollback: the version, and so the directory, differs.
 */
export async function probe(cli: Cli, runDir: string, machine: Machine, options: ProbeOptions): Promise<ProbeSummary> {
  requireLock(machine.home, runDir);
  const startedAt = new Date().toISOString();
  const { resolved } = await copiesOf(cli, machine);
  if (resolved === null) throw new Error(`no ${cli} on PATH`);
  const version = resolved.version ?? "unknown";
  const dir = join(runDir, `probe-${cli}-${version}`);
  if (existsSync(dir)) throw new Error(`${dir} already exists: ${cli} ${version} was probed in this run`);
  mkdirSync(dir);
  const pairs = probePairs(cli, machine.home);
  const codex = cli === "codex" ? resolved : (await copiesOf("codex", machine)).resolved;
  const lanes: ProbeLaneResult[] = [];
  for (const pair of pairs) {
    for (const lane of PROBE_LANES[cli]) {
      if (lane === "read" || lane === "write" || lane === "seatbelt") lanes.push(await modelLane(lane, cli, pair, dir, machine, codex, options.timeoutSeconds));
    }
  }
  if (cli === "codex") lanes.push(await sandboxLane(dir, machine, codex, options.timeoutSeconds));
  if (cli === "claude") lanes.push(await manifestLane(dir, machine, options.pluginRoot, options.timeoutSeconds));
  const summary: ProbeSummary = {
    cli,
    version,
    dir,
    pairs: pairs.map((pair) => pair.pair),
    startedAt,
    completedAt: new Date().toISOString(),
    ok: lanes.every((lane) => lane.status === "passed"),
    lanes,
  };
  writeFileSync(join(dir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

// --- Command line ------------------------------------------------------------------

const USAGE = `Usage: update-clis <start|check|notes|install|probe|finish> [options]

  start   [--home <dir>]
          Open an execution: a run directory under ~/Library/Caches/pstack-vic/update-clis
          and the lock that keeps a second execution out (a lock older than 12 hours is taken over).
  check   [--cli <${CLIS.join("|")}>] [--home <dir>] [--applications <dir>]
          Per CLI: the copy the parents resolve and its version, the latest of its channel,
          duplicates, processes running it, and the versions the desktop apps carry.
  notes   --cli <name> --from <A> --to <B> [--dir <run dir>]
          Download and normalize the release notes of (A, B], oldest first, each entry once.
          With --dir, also writes notes-<cli>-<A>-<B>.json there.
  install --cli <name> --version <V> --dir <run dir> [--home <dir>]
          Install exactly V into the resolved copy and read the version back; also the way back.
          grok: the current binary is copied into the run directory first and restored when
          grok update fails. Needs the run's lock.
  probe   --cli <name> --dir <run dir> [--home <dir>] [--timeout <seconds, default 600>] [--plugin-root <dir>]
          Run the CLI's probe lanes, one after the other, against the installed version:
          read and write for every pair the two sheets route to it through the runner,
          seatbelt (grok, claude) under codex sandbox, sandbox (codex) and manifest (claude)
          without a model. Writes probe-<cli>-<version>/summary.json. Needs the run's lock.
  finish  --dir <run dir> [--keep-copies] [--home <dir>]
          Delete the run's grok copies (--keep-copies leaves them when a rollback failed),
          keep the ten most recent runs, release the lock.

Exit codes: 0 ok, 1 an install did not verify or a probe lane failed,
2 a source did not answer, 3 another execution holds the lock, 64 usage.
`;

interface Io {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
}

class CliUsageError extends Error {}

function usage(message: string): never {
  throw new CliUsageError(message);
}

export async function main(argv: readonly string[], io: Io = {
  stdout: (v) => process.stdout.write(v),
  stderr: (v) => process.stderr.write(v),
}): Promise<number> {
  try {
    let parsed: ReturnType<typeof parseArgs>;
    try {
      parsed = parseArgs({
        args: [...argv],
        allowPositionals: true,
        strict: true,
        options: {
          cli: { type: "string" },
          from: { type: "string" },
          to: { type: "string" },
          dir: { type: "string" },
          version: { type: "string" },
          home: { type: "string" },
          applications: { type: "string" },
          timeout: { type: "string" },
          "plugin-root": { type: "string" },
          "keep-copies": { type: "boolean", default: false },
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
    const text = (name: string): string | undefined => {
      const value = parsed.values[name];
      return typeof value === "string" ? value : undefined;
    };
    const required = (name: string): string => text(name) ?? usage(`--${name} is required`);
    const requireCli = (): Cli => {
      const value = required("cli");
      if (!isCli(value)) usage(`--cli must be one of: ${CLIS.join(", ")}`);
      return value;
    };
    const emit = (value: unknown): void => io.stdout(`${JSON.stringify(value, null, 2)}\n`);
    const machine = defaultMachine({
      ...(text("home") === undefined ? {} : { home: resolve(text("home") as string) }),
      ...(text("applications") === undefined ? {} : { applications: resolve(text("applications") as string) }),
    });
    const requireDir = (): string => resolve(required("dir"));

    switch (command) {
      case "start": {
        emit(startRun(machine.home));
        return 0;
      }
      case "check": {
        const only = text("cli");
        if (only !== undefined && !isCli(only)) usage(`--cli must be one of: ${CLIS.join(", ")}`);
        emit(await check(only === undefined ? CLIS : [only], machine));
        return 0;
      }
      case "install": {
        const cli = requireCli();
        const version = required("version");
        if (!SEMVER.test(version)) usage(`--version must be a release version X.Y.Z, got ${JSON.stringify(version)}`);
        const result = await install(cli, version, requireDir(), machine);
        emit(result);
        return result.ok ? 0 : 1;
      }
      case "probe": {
        const cli = requireCli();
        const timeout = Number(text("timeout") ?? "600");
        if (!Number.isFinite(timeout) || timeout <= 0) usage("--timeout must be a number of seconds greater than zero");
        const pluginRoot = resolve(text("plugin-root") ?? PLUGIN_ROOT);
        const summary = await probe(cli, requireDir(), machine, { timeoutSeconds: timeout, pluginRoot });
        emit(summary);
        return summary.ok ? 0 : 1;
      }
      case "finish": {
        emit(finishRun(machine.home, requireDir(), { keepCopies: parsed.values["keep-copies"] === true }));
        return 0;
      }
      case "notes": {
        const cli = requireCli();
        const from = required("from");
        const to = required("to");
        for (const [flag, version] of [["--from", from], ["--to", to]] as const) {
          if (!SEMVER.test(version)) usage(`${flag} must be a release version X.Y.Z, got ${JSON.stringify(version)}`);
        }
        const notes = await fetchNotes(cli, from, to);
        const dir = text("dir");
        if (dir !== undefined) writeFileSync(join(dir, `notes-${cli}-${from}-${to}.json`), `${JSON.stringify(notes, null, 2)}\n`);
        emit(notes);
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
    return error instanceof NotesError ? 2 : error instanceof RunLockError ? 3 : 1;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exitCode = await main(process.argv.slice(2));
}
