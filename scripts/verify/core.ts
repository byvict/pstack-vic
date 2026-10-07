// Classification precedence and rename handling adapted from open-pstack's verifier.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { Journal } from "./io.ts";

export interface ChangedFile { filename: string; previous_filename?: string }
export interface Registry { runtime: Record<string, string[]>; nonRuntime: string[] }
export interface Selection { paths: string[]; areas: string[]; noRuntime: boolean }

// Only exact paths and terminal /** are supported, as in upstream.
export function matches(path: string, pattern: string): boolean {
  return pattern.endsWith("/**") ? path.startsWith(pattern.slice(0, -2)) : path === pattern;
}

export function classify(files: ChangedFile[], registry: Registry): Selection {
  const paths = [...new Set(files.flatMap((file) => [file.filename, ...(file.previous_filename ? [file.previous_filename] : [])]))].sort();
  const areas = new Set<string>();
  for (const path of paths) {
    if (!path || path.startsWith("/") || path.split("/").includes("..")) throw new Error(`Unsafe path: ${path}`);
    let covered = false;
    for (const [area, patterns] of Object.entries(registry.runtime)) {
      if (patterns.some((pattern) => matches(path, pattern))) { covered = true; areas.add(area); }
    }
    if (!covered && !registry.nonRuntime.some((pattern) => matches(path, pattern))) throw new Error(`Unmapped path: ${path}`);
  }
  return { paths, areas: [...areas].sort(), noRuntime: areas.size === 0 };
}

export function changedFiles(output: string): ChangedFile[] {
  const fields = output.split("\0");
  if (fields.pop() !== "") throw new Error("Truncated git name-status output");
  const result: ChangedFile[] = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    const first = fields[index++];
    if (!first || !/^[ACDMRTUXB][0-9]*$/.test(status)) throw new Error("Invalid git name-status output");
    if (/^[RC]/.test(status)) {
      const next = fields[index++];
      if (!next) throw new Error("Truncated git rename");
      result.push({ filename: next, previous_filename: first });
    } else result.push({ filename: first });
  }
  return result;
}

export function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }

export interface Source {
  base: string;
  head: string;
  kind: "exact-commit" | "working-tree";
  digest: string;
  files: { path: string; mode: number; hash: string }[];
  changed: ChangedFile[];
}

/** Includes tracked and untracked non-ignored inputs; executable bits and symlinks
 * are hashed without following links. A working tree proof never claims a SHA alone.
 */
export async function source(journal: Journal, repository: string, baseRef: string, headRef: string, workingTree: boolean): Promise<Source> {
  const git = (...args: string[]) => journal.text(["git", ...args], { cwd: repository, label: "source" });
  const base = (await git("rev-parse", "--verify", `${baseRef}^{commit}`)).trim();
  const head = (await git("rev-parse", "--verify", `${headRef}^{commit}`)).trim();
  const actual = (await git("rev-parse", "HEAD")).trim();
  if (head !== actual || !/^[a-f0-9]{40}$/.test(base) || !/^[a-f0-9]{40}$/.test(head)) throw new Error("Candidate must be the checked-out HEAD; base and head must resolve to commits");
  const dirty = await git("status", "--porcelain=v1", "-z", "--untracked-files=all");
  if (dirty && !workingTree) throw new Error("Candidate is dirty; commit it or label this exploratory proof with --working-tree");
  const changed = changedFiles(await git("diff", "--name-status", "-z", "--find-renames", base, head, "--"));
  if (workingTree) changed.push(...changedFiles(await git("diff", "--name-status", "-z", "--find-renames", head, "--")));
  const untracked = (await git("ls-files", "--others", "--exclude-standard", "-z")).split("\0").filter(Boolean);
  if (workingTree) changed.push(...untracked.map((filename) => ({ filename })));
  // The index may hide edits (assume-unchanged/skip-worktree), and core.filemode
  // may hide executable-bit changes. Compare the actual bytes to HEAD's tree.
  const tree = new Map<string, { mode: number; hash: string }>();
  for (const entry of (await git("ls-tree", "-rz", "--full-tree", head)).split("\0").filter(Boolean)) {
    const match = /^([0-7]+) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(entry);
    if (!match) throw new Error(`Unsupported candidate tree entry: ${entry}`);
    tree.set(match[3], { mode: parseInt(match[1], 8), hash: match[2] });
  }
  const paths = [...new Set((await git("ls-files", "--cached", "--others", "--exclude-standard", "-z")).split("\0").filter(Boolean))].sort();
  const files: Source["files"] = [];
  for (const path of paths) {
    const file = join(repository, path);
    let stat;
    try { stat = lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`Unsupported source entry: ${path}`);
    const bytes = stat.isSymbolicLink() ? Buffer.from(readlinkSync(file)) : readFileSync(file);
    const mode = stat.isSymbolicLink() ? 0o120000 : (stat.mode & 0o111) ? 0o100755 : 0o100644;
    const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    const expected = tree.get(path);
    if (!expected || expected.mode !== mode || expected.hash !== blob) {
      if (!workingTree) throw new Error(`Candidate bytes or mode differ from HEAD: ${path}; use --working-tree for an exploratory proof`);
      changed.push({ filename: path });
    }
    tree.delete(path);
    files.push({ path, mode, hash: sha256(bytes) });
  }
  if (tree.size && !workingTree) throw new Error(`Candidate entries missing from HEAD: ${[...tree.keys()].join(", ")}`);
  if (workingTree) changed.push(...[...tree.keys()].map((filename) => ({ filename })));
  return { base, head, kind: workingTree ? "working-tree" : "exact-commit", files, digest: sha256(JSON.stringify(files)), changed };
}
