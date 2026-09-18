#!/usr/bin/env node
// Weekly digest of the two upstreams tracked in UPSTREAM.md.
//
//   node scripts/upstream-digest.ts                       fetch both remotes, print the markdown digest
//   node scripts/upstream-digest.ts --no-fetch            use the refs already in the clone
//   node scripts/upstream-digest.ts --json                print the digest as JSON instead of markdown
//   node scripts/upstream-digest.ts --since cursor=<sha>  start the cursor range at <sha> instead of the sync point
//   node scripts/upstream-digest.ts --since open=<sha>    same for open-pstack
//   node scripts/upstream-digest.ts --repo <dir>          checkout to inspect (default: this plugin)
//
// The sync points come from the "Ponto de sync atual" table in UPSTREAM.md:
// that file is the single source of truth and only advances when every commit
// of the interval has a verdict. The digest lists one row per upstream commit
// with an empty verdict column (aplica / não aplica / adaptar); the decision is
// Victor's, per commit, and applying is a normal session with a PR.
//
// cursor: commits that touched `pstack/` in cursor/plugins (the split lineage
// of this repo); paths map `pstack/X` -> `X`. open: every commit of
// ericlitman/open-pstack; paths map `plugins/pstack/X` -> `X` and anything
// outside that directory is marked as distribution-only. Paths that fase 5
// already excluded from the port come with the verdict "não aplica" filled in.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { PLUGIN_ROOT } from "./model-matrix.ts";

export type UpstreamName = "cursor" | "open";

export interface UpstreamSpec {
  readonly name: UpstreamName;
  /** Remote-tracking ref the digest reads. */
  readonly ref: string;
  /** Remote registered in the clone, fetched before reading `ref`. */
  readonly remote: string;
  /** Prefix of the plugin inside the upstream tree, with trailing slash. */
  readonly prefix: string;
  /** Restrict the log to the plugin path (cursor) or take every commit (open). */
  readonly logPath: string | null;
  /** Manifest at the tip whose `version` names the upstream release. */
  readonly versionFile: string;
  readonly title: string;
}

export const UPSTREAMS: readonly UpstreamSpec[] = [
  {
    name: "cursor",
    ref: "cursor/main",
    remote: "cursor",
    prefix: "pstack/",
    logPath: "pstack",
    versionFile: "pstack/.cursor-plugin/plugin.json",
    title: "cursor (`pstack/` em cursor/plugins, fonte de merge)",
  },
  {
    name: "open",
    ref: "open/main",
    remote: "open",
    prefix: "plugins/pstack/",
    logPath: null,
    versionFile: "plugins/pstack/.claude-plugin/plugin.json",
    title: "open (ericlitman/open-pstack, só leitura, entra por cópia auditada)",
  },
];

/**
 * Paths the port deliberately does not carry (CHANGES.md, fase 5). A commit
 * that only touches these gets its verdict filled in as "não aplica".
 */
export const EXCLUDED_PATHS: readonly string[] = [
  "automations/benny/",
  "docs/guide/",
  "skills/make-bot-ui/",
  "README.md",
  ".cursor-plugin/",
];

export const NAO_APLICA = "não aplica";

export type FileStatus = "A" | "M" | "D" | "T";

export interface DigestFile {
  readonly upstreamPath: string;
  /** Path inside this plugin, or null when the file lives outside the plugin tree. */
  readonly localPath: string | null;
  readonly status: FileStatus;
  /** Path excluded from the port on purpose (fase 5). */
  readonly excluded: boolean;
  /** Mapped path that does not exist in the checkout (and upstream did not delete it). */
  readonly missingLocally: boolean;
}

export interface DigestCommit {
  readonly sha: string;
  readonly date: string;
  readonly subject: string;
  readonly files: readonly DigestFile[];
  /** Pre-filled verdict, or empty for Victor to decide. */
  readonly verdict: string;
}

export interface UpstreamDigest {
  readonly name: UpstreamName;
  readonly ref: string;
  readonly since: string;
  readonly sinceSource: "UPSTREAM.md" | "--since";
  readonly tip: string;
  readonly tipDate: string;
  readonly version: string | null;
  readonly commits: readonly DigestCommit[];
}

export interface Digest {
  readonly date: string;
  readonly repo: string;
  readonly upstreams: readonly UpstreamDigest[];
}

export interface DigestOptions {
  readonly repo?: string;
  readonly since?: Partial<Record<UpstreamName, string>>;
  readonly date?: string;
}

export class DigestError extends Error {}

export function git(repo: string, ...args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim() ?? "";
    throw new DigestError(`git ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`);
  }
}

/** Sync points from the "Ponto de sync atual" table of UPSTREAM.md. */
export function readSyncPoints(upstreamMd: string): Record<UpstreamName, string> {
  const row = /^\| Commit \| `([0-9a-f]{40})` \| `([0-9a-f]{40})` \|$/m.exec(upstreamMd);
  if (!row) {
    throw new DigestError(
      "UPSTREAM.md must contain the row `| Commit | `<cursor sha>` | `<open sha>` |` with two full commit hashes",
    );
  }
  return { cursor: row[1] as string, open: row[2] as string };
}

/** `--since name=sha` values, validated against the known upstream names. */
export function parseSince(values: readonly string[]): Partial<Record<UpstreamName, string>> {
  const out: Partial<Record<UpstreamName, string>> = {};
  for (const value of values) {
    const m = /^(cursor|open)=([0-9a-fA-F]{7,40})$/.exec(value);
    if (!m) throw new DigestError(`--since expects cursor=<sha> or open=<sha>, got: ${value}`);
    out[m[1] as UpstreamName] = (m[2] as string).toLowerCase();
  }
  return out;
}

export function mapPath(spec: UpstreamSpec, upstreamPath: string): string | null {
  return upstreamPath.startsWith(spec.prefix) ? upstreamPath.slice(spec.prefix.length) : null;
}

export function isExcluded(localPath: string): boolean {
  return EXCLUDED_PATHS.some((p) => (p.endsWith("/") ? localPath.startsWith(p) : localPath === p));
}

function filesOf(repo: string, spec: UpstreamSpec, sha: string): DigestFile[] {
  const args = ["show", "--format=", "--name-status", "--no-renames", sha];
  if (spec.logPath !== null) args.push("--", spec.logPath);
  const files: DigestFile[] = [];
  for (const line of git(repo, ...args).split("\n")) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    const status = line.slice(0, 1) as FileStatus;
    const upstreamPath = line.slice(tab + 1);
    const localPath = mapPath(spec, upstreamPath);
    const excluded = localPath !== null && isExcluded(localPath);
    const missingLocally =
      localPath !== null && !excluded && status !== "D" && !existsSync(join(repo, localPath));
    files.push({ upstreamPath, localPath, status, excluded, missingLocally });
  }
  return files;
}

function verdictFor(files: readonly DigestFile[]): string {
  const inPlugin = files.filter((f) => f.localPath !== null);
  return inPlugin.length > 0 && inPlugin.every((f) => f.excluded) ? NAO_APLICA : "";
}

function commitsOf(repo: string, spec: UpstreamSpec, since: string): DigestCommit[] {
  const args = ["log", "--reverse", "--format=%H%x09%cs%x09%s", `${since}..${spec.ref}`];
  if (spec.logPath !== null) args.push("--", spec.logPath);
  const commits: DigestCommit[] = [];
  for (const line of git(repo, ...args).split("\n")) {
    if (!line) continue;
    const [sha, date, subject] = line.split("\t", 3) as [string, string, string];
    const files = filesOf(repo, spec, sha);
    commits.push({ sha, date, subject, files, verdict: verdictFor(files) });
  }
  return commits;
}

function versionAt(repo: string, spec: UpstreamSpec): string | null {
  try {
    const parsed = JSON.parse(git(repo, "show", `${spec.ref}:${spec.versionFile}`)) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

export function fetchUpstreams(repo: string): void {
  for (const spec of UPSTREAMS) git(repo, "fetch", "--quiet", spec.remote, "main");
}

export function buildDigest(options: DigestOptions = {}): Digest {
  const repo = options.repo ?? PLUGIN_ROOT;
  const syncPoints = readSyncPoints(readFileSync(join(repo, "UPSTREAM.md"), "utf8"));
  const upstreams = UPSTREAMS.map((spec): UpstreamDigest => {
    const override = options.since?.[spec.name];
    const since = git(repo, "rev-parse", "--verify", `${override ?? syncPoints[spec.name]}^{commit}`).trim();
    const tip = git(repo, "rev-parse", "--verify", `${spec.ref}^{commit}`).trim();
    const tipDate = git(repo, "log", "-1", "--format=%cs", tip).trim();
    return {
      name: spec.name,
      ref: spec.ref,
      since,
      sinceSource: override === undefined ? "UPSTREAM.md" : "--since",
      tip,
      tipDate,
      version: versionAt(repo, spec),
      commits: commitsOf(repo, spec, since),
    };
  });
  return { date: options.date ?? new Date().toISOString().slice(0, 10), repo, upstreams };
}

export function hasNews(digest: Digest): boolean {
  return digest.upstreams.some((u) => u.commits.length > 0);
}

const short = (sha: string): string => sha.slice(0, 7);

function describeFile(f: DigestFile): string {
  if (f.localPath === null) return `${f.upstreamPath} (fora do plugin)`;
  const notes: string[] = [];
  if (f.status === "A") notes.push("novo");
  if (f.status === "D") notes.push("removido");
  if (f.excluded) notes.push("excluído na fase 5");
  if (f.missingLocally) notes.push("ausente aqui");
  return notes.length ? `${f.localPath} (${notes.join(", ")})` : f.localPath;
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

export function renderMarkdown(digest: Digest): string {
  const out: string[] = [`# Upstream digest — ${digest.date}`, ""];
  out.push(
    "Uma linha por commit novo em cada upstream desde o ponto de sync de `UPSTREAM.md`. Veredito por commit: `aplica` / `não aplica` / `adaptar`. O ponto de sync só avança quando todos os commits do intervalo têm veredito.",
    "",
  );
  for (const u of digest.upstreams) {
    const spec = UPSTREAMS.find((s) => s.name === u.name) as UpstreamSpec;
    out.push(`## ${spec.title}`, "");
    out.push("| | |", "| --- | --- |");
    out.push(`| Intervalo | \`${u.since}..${u.ref}\`${u.sinceSource === "--since" ? " (início por `--since`)" : ""} |`);
    out.push(`| Tip | \`${short(u.tip)}\` (${u.tipDate}) |`);
    out.push(`| Versão no tip | ${u.version === null ? "n/a" : `\`${u.version}\``} |`);
    out.push(`| Commits novos | ${u.commits.length} |`, "");
    if (u.commits.length === 0) {
      out.push("Sem novidades.", "");
      continue;
    }
    out.push("| Commit | Data | Assunto | Arquivos | Veredito |", "| --- | --- | --- | --- | --- |");
    for (const c of u.commits) {
      const files = c.files.map(describeFile).map((s) => `\`${s}\``).join(", ");
      out.push(
        `| \`${short(c.sha)}\` | ${c.date} | ${cell(c.subject)} | ${c.files.length}: ${cell(files)} | ${c.verdict} |`,
      );
    }
    out.push("");
  }
  out.push(
    "Como aplicar: commits do `cursor` entram por merge da linha do split; commits do `open` entram por cópia auditada, arquivo a arquivo, com linha em `NOTICE.md`. Ver `UPSTREAM.md`, seção *Incorporar uma mudança*.",
    "",
  );
  return out.join("\n");
}

export function main(argv: readonly string[]): number {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowNegative: true,
      options: {
        fetch: { type: "boolean", default: true },
        json: { type: "boolean", default: false },
        since: { type: "string", multiple: true, default: [] },
        repo: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }
  const values = parsed.values as {
    fetch: boolean;
    json: boolean;
    since: string[];
    repo?: string;
    help: boolean;
  };
  if (values.help) {
    console.log(
      "usage: upstream-digest [--no-fetch] [--json] [--since cursor=<sha>] [--since open=<sha>] [--repo <dir>]",
    );
    return 0;
  }
  try {
    const repo = values.repo ?? PLUGIN_ROOT;
    if (values.fetch) fetchUpstreams(repo);
    const digest = buildDigest({ repo, since: parseSince(values.since) });
    process.stdout.write(values.json ? `${JSON.stringify(digest, null, 2)}\n` : renderMarkdown(digest));
    return 0;
  } catch (err) {
    if (err instanceof DigestError) {
      console.error(err.message);
      return 2;
    }
    throw err;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exitCode = main(process.argv.slice(2));
}
