import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clisOutsideFakes, isolatedEnv, isolateProcessEnv } from "../skills/poteto-mode/scripts/runner/isolated-env.test-helper.ts";
import { PLUGIN_ROOT } from "./model-matrix.ts";

const shipping = readFileSync(join(PLUGIN_ROOT, "skills/poteto-mode/playbooks/shipping.md"), "utf8");
let scratch: string;
let env: NodeJS.ProcessEnv;
let restoreProcessEnv: () => void;

before(() => {
  const realGit = execFileSync("/usr/bin/which", ["git"], { encoding: "utf8" }).trim();
  scratch = mkdtempSync(join(tmpdir(), "pstack-landing-"));
  const bin = join(scratch, "bin");
  const home = join(scratch, "home");
  mkdirSync(bin);
  mkdirSync(home);
  symlinkSync(realGit, join(bin, "git"));
  restoreProcessEnv = isolateProcessEnv(home, [bin]);
  env = isolatedEnv(home, [bin], {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_TERMINAL_PROMPT: "0",
  });
});

after(() => {
  restoreProcessEnv();
  rmSync(scratch, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function repo(): string {
  const path = mkdtempSync(join(scratch, "repo-"));
  git(path, "init", "-q", "-b", "main");
  return path;
}

function commit(path: string, file: string, text: string): string {
  writeFileSync(join(path, file), text);
  git(path, "add", file);
  git(path, "commit", "-qm", file);
  return git(path, "rev-parse", "HEAD");
}

function command(prefix: string): string {
  const commands = [...shipping.matchAll(/```sh\n([\s\S]*?)\n```/g)]
    .flatMap((block) => block[1].split("\n")).filter((line) => line.startsWith(prefix));
  assert.equal(commands.length, 1, `one generated command for ${prefix}`);
  return commands[0];
}

function recipe(path: string, text: string, values: Record<string, string>) {
  return spawnSync("/bin/sh", ["-c", text], { cwd: path, env: { ...env, ...values }, encoding: "utf8" });
}

function exactPatch(path: string, base: string, head: string): string {
  const result = recipe(path, command("git -c core.quotePath=true diff "), { op_base_sha: base, op_head_sha: head });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function patchId(path: string, patch: string): string {
  return execFileSync("git", ["patch-id", "--stable"], { cwd: path, env, input: patch, encoding: "utf8" }).split(" ")[0];
}

function output(path: string): string {
  return execFileSync(process.execPath, ["app.mjs"], { cwd: path, env, encoding: "utf8" });
}

describe("generated Shipping recipes on disposable Git repositories", () => {
  it("keeps live provider CLIs and gh out of every command environment", () => {
    assert.deepEqual(clisOutsideFakes(env.PATH), []);
  });

  it("refuses a stale captured lease even after fetch; implicit lease is the negative control", () => {
    const first = repo();
    const captured = commit(first, "file", "first\n");
    const remote = join(scratch, "remote.git");
    git(first, "clone", "-q", "--bare", first, remote);
    git(first, "remote", "add", "origin", remote);
    git(first, "fetch", "-q", "origin");
    const second = join(scratch, "second");
    git(first, "clone", "-q", remote, second);
    const concurrent = commit(second, "file", "second writer\n");
    git(second, "push", "-q", "origin", "HEAD:refs/heads/main");
    git(first, "fetch", "-q", "origin");
    assert.equal(git(first, "rev-parse", "origin/main"), concurrent);
    commit(first, "file", "rewritten\n");
    const result = recipe(first, command("git push "), {
      op_push_url: remote, op_branch: "main", op_remote_head: captured,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /stale info/);
    assert.equal(git(first, "ls-remote", remote, "refs/heads/main").split("\t")[0], concurrent);
    git(first, "push", "-q", "origin", "HEAD:refs/heads/main", "--force-with-lease");
    assert.equal(git(first, "ls-remote", remote, "refs/heads/main").split("\t")[0], git(first, "rev-parse", "HEAD"));
  });

  it("restacks only the child range after a parent squash", () => {
    const path = repo();
    commit(path, "base", "base\n");
    git(path, "checkout", "-qb", "parent");
    commit(path, "parent", "parent 1\n");
    const oldParent = commit(path, "parent", "parent 2\n");
    git(path, "checkout", "-qb", "child");
    const oldChild = commit(path, "child", "child contribution\n");
    const values = { op_old_parent_tip: oldParent, op_old_child_tip: oldChild, op_child_branch: "child", op_new_base: "main" };
    assert.equal(recipe(path, command("git merge-base --is-ancestor "), values).status, 0);
    const originalRange = recipe(path, command("git log --oneline "), values);
    assert.equal(originalRange.status, 0);
    assert.equal(originalRange.stdout.trim().split("\n").length, 1);
    const contribution = exactPatch(path, oldParent, oldChild);
    git(path, "checkout", "-q", "main");
    git(path, "merge", "--squash", "parent");
    git(path, "commit", "-qm", "squash parent");
    const result = recipe(path, command("git rebase --onto "), values);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(git(path, "rev-list", "--count", "main..child"), "1");
    assert.equal(exactPatch(path, "main", "child"), contribution);
    assert.equal(readFileSync(join(path, "parent"), "utf8"), "parent 2\n");
    assert.equal(readFileSync(join(path, "child"), "utf8"), "child contribution\n");
  });

  it("distinguishes executable whitespace that stable patch-id erases", () => {
    const path = repo();
    const base = commit(path, "app.mjs", 'console.log("start");\n');
    const spaced = commit(path, "app.mjs", 'console.log("a b");\n');
    const spacedPatch = exactPatch(path, base, spaced);
    assert.equal(output(path), "a b\n");
    git(path, "checkout", "-qb", "compact", base);
    const compact = commit(path, "app.mjs", 'console.log("ab");\n');
    const compactPatch = exactPatch(path, base, compact);
    assert.equal(output(path), "ab\n");
    assert.equal(patchId(path, spacedPatch), patchId(path, compactPatch));
    assert.notEqual(spacedPatch, compactPatch);
  });

  it("reruns a lane when equal patch bytes have a changed base dependency", () => {
    const path = repo();
    commit(path, "factor.mjs", "export default 2;\n");
    const base = commit(path, "app.mjs", 'import factor from "./factor.mjs";\nconsole.log(factor);\n');
    git(path, "checkout", "-qb", "feature");
    const head = commit(path, "app.mjs", 'import factor from "./factor.mjs";\nconsole.log(3 * factor);\n');
    const before = exactPatch(path, base, head);
    assert.equal(output(path), "6\n");
    git(path, "checkout", "-q", "main");
    const movedBase = commit(path, "factor.mjs", "export default 4;\n");
    git(path, "checkout", "-q", "feature");
    git(path, "rebase", "main");
    const after = exactPatch(path, movedBase, "HEAD");
    assert.equal(before, after);
    assert.equal(patchId(path, before), patchId(path, after));
    assert.equal(output(path), "12\n");
  });
});
