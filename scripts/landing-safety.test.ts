import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
    .map((block) => block[1]).filter((block) => block.split("\n").some((line) => line.startsWith(prefix)));
  assert.equal(commands.length, 1, `one generated command for ${prefix}`);
  return commands[0];
}

function recipe(path: string, text: string, values: Record<string, string>) {
  return spawnSync("/bin/sh", ["-c", text], { cwd: path, env: { ...env, ...values }, encoding: "utf8" });
}

function exactPatch(path: string, base: string, head: string): string {
  const result = recipe(path, command("git -c core.quotePath=true "), { op_base_sha: base, op_head_sha: head });
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
    const values = { op_old_parent_tip: oldParent, op_old_child_tip: oldChild, op_branch: "child", op_new_base: "" };
    const originalRange = recipe(path, command("git log --oneline "), values);
    assert.equal(originalRange.status, 0);
    assert.equal(originalRange.stdout.trim().split("\n").length, 1);
    const contribution = exactPatch(path, oldParent, oldChild);
    git(path, "checkout", "-q", "main");
    git(path, "merge", "--squash", "parent");
    git(path, "commit", "-qm", "squash parent");
    values.op_new_base = git(path, "rev-parse", "HEAD");
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

  it("shows changed output from a base dependency despite equal patch bytes", () => {
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

  for (const rewrite of ["insteadOf", "pushInsteadOf"]) {
    it(`refuses ${rewrite} transport redirection before changing either destination`, () => {
      const path = repo();
      const captured = commit(path, "file", "before\n");
      const intended = join(path, "intended.git");
      const wrong = join(path, "wrong.git");
      git(path, "clone", "-q", "--bare", path, intended);
      git(path, "clone", "-q", "--bare", path, wrong);
      const raw = "https://github.com/fixture/intended";
      const resolved = `${raw}.git`;
      git(path, "remote", "add", "origin", raw);
      git(path, "config", `url.${resolved}.insteadOf`, raw);
      git(path, "config", `url.${wrong}.${rewrite}`, resolved);
      assert.equal(git(path, "remote", "get-url", "origin"), resolved);
      commit(path, "file", "after\n");
      const result = recipe(path, command("git push "), { op_push_url: resolved, op_branch: "main", op_remote_head: captured });
      assert.notEqual(result.status, 0, "redirected publication must refuse");
      assert.match(result.stderr, /URL rewriting is unsupported/);
      assert.equal(git(intended, "rev-parse", "main"), captured);
      assert.equal(git(wrong, "rev-parse", "main"), captured);
    });
  }

  it("captures outside-directory changes despite relative, context, color and submodule settings", () => {
    const path = repo();
    mkdirSync(join(path, "inside"));
    commit(path, "inside/keep", "unchanged\n");
    const base = commit(path, "outside", "before\n");
    const first = commit(path, "outside", "after one\n");
    const second = commit(path, "outside", "after two\n");
    const expected = exactPatch(path, base, first);
    for (const [key, value] of [["diff.relative", "true"], ["diff.context", "0"], ["diff.algorithm", "histogram"], ["diff.indentHeuristic", "true"], ["color.ui", "always"], ["diff.ignoreSubmodules", "all"], ["diff.submodule", "log"]]) git(path, "config", key, value);
    const captured = exactPatch(join(path, "inside"), base, first);
    assert.equal(captured, expected);
    assert.notEqual(captured, exactPatch(join(path, "inside"), base, second));
    git(path, "update-index", "--add", "--cacheinfo", `160000,${base},module`);
    git(path, "commit", "-qm", "submodule base");
    const subBase = git(path, "rev-parse", "HEAD");
    git(path, "update-index", "--cacheinfo", `160000,${first},module`);
    git(path, "commit", "-qm", "submodule head");
    assert.match(exactPatch(join(path, "inside"), subBase, "HEAD"), /Subproject commit/);
  });

  it("refuses a parent destination after the child restack", () => {
    const path = repo();
    commit(path, "base", "base\n");
    git(path, "checkout", "-qb", "parent");
    const oldParent = commit(path, "parent-file", "parent\n");
    git(path, "checkout", "-qb", "child");
    const oldChild = commit(path, "child-file", "child\n");
    const remote = join(path, "remote.git");
    git(path, "clone", "-q", "--bare", path, remote);
    git(path, "checkout", "-q", "main");
    git(path, "merge", "--squash", "parent");
    git(path, "commit", "-qm", "squash");
    const values = { op_new_base: git(path, "rev-parse", "HEAD"), op_old_parent_tip: oldParent, op_old_child_tip: oldChild, op_branch: "child" };
    const restack = recipe(path, command("git rebase --onto "), values);
    assert.equal(restack.status, 0, restack.stderr);
    const badPush = recipe(path, command("git push "), { op_push_url: remote, op_branch: "parent", op_remote_head: oldParent });
    assert.notEqual(badPush.status, 0);
    assert.equal(git(remote, "rev-parse", "parent"), oldParent);
    assert.equal(git(remote, "rev-parse", "child"), oldChild);
  });

  it("rebases onto the fetched SHA while a named remote tracking ref stays stale", () => {
    const path = repo();
    const old = commit(path, "base", "old\n");
    const remote = join(path, "remote.git");
    git(path, "clone", "-q", "--bare", path, remote);
    git(path, "remote", "add", "origin", remote);
    git(path, "fetch", "-q", "origin");
    const writer = join(path, "writer");
    git(path, "clone", "-q", remote, writer);
    const current = commit(writer, "base", "current\n");
    git(writer, "push", "-q", "origin", "HEAD:refs/heads/main");
    git(path, "checkout", "-qb", "feature");
    commit(path, "feature", "feature\n");
    const values = { op_fetch_url: remote, op_base_ref: "main", op_base_sha: current, op_branch: "feature" };
    const fetched = recipe(path, command("git fetch "), values);
    assert.equal(fetched.status, 0, fetched.stderr);
    assert.equal(fetched.stdout.trim(), current);
    assert.equal(git(path, "rev-parse", "origin/main"), old);
    const rebased = recipe(path, command("git rebase \""), { op_new_base: fetched.stdout.trim(), op_branch: "feature" });
    assert.equal(rebased.status, 0, rebased.stderr);
    assert.equal(git(path, "rev-parse", "HEAD^"), current);
    const mismatch = recipe(path, command("git fetch "), { ...values, op_base_sha: old });
    assert.notEqual(mismatch.status, 0);
  });

  it("rejects every missing or empty command input before an inert transport runs", () => {
    const bin = join(scratch, "inert");
    mkdirSync(bin);
    const log = join(scratch, "inert-invocations");
    const stub = '#!/usr/bin/env node\nrequire("node:fs").appendFileSync(process.env.CALL_LOG, JSON.stringify(process.argv.slice(2))+"\\n");\n';
    for (const tool of ["gh", "git"]) { writeFileSync(join(bin, tool), stub); chmodSync(join(bin, tool), 0o755); }
    const failures: string[] = [];
    for (const [, block] of shipping.matchAll(/```sh\n([\s\S]*?)\n```/g)) {
      const assigned = [...block.matchAll(/^\s*(op_\w+)=/gm)].map((m) => m[1]);
      const names = [...new Set([...block.matchAll(/\$\{?(op_\w+)/g)].map((m) => m[1]))].filter((name) => !assigned.includes(name));
      const values = Object.fromEntries(names.map((name) => [name, "fixture"]));
      for (const name of names) for (const empty of [false, true]) {
        rmSync(log, { force: true });
        const inputs = { ...values };
        if (empty) inputs[name] = ""; else delete inputs[name];
        const run = spawnSync("/bin/sh", ["-c", block], { cwd: scratch, env: { ...env, ...inputs, PATH: `${bin}:${env.PATH}`, CALL_LOG: log }, encoding: "utf8" });
        if (run.status === 0 || existsSync(log)) failures.push(`${name} ${empty ? "empty" : "missing"}: transport reached in ${block.split("\n").at(-1)}`);
      }
    }
    assert.deepEqual(failures, []);
  });

  it("refuses a changed child tip before rebase", () => {
    const path = repo();
    const parent = commit(path, "base", "base\n");
    git(path, "checkout", "-qb", "child");
    const oldChild = commit(path, "child-file", "first\n");
    const changed = commit(path, "child-file", "second\n");
    const result = recipe(path, command("git rebase --onto "), { op_new_base: parent, op_old_parent_tip: parent, op_old_child_tip: oldChild, op_branch: "child" });
    assert.notEqual(result.status, 0);
    assert.equal(git(path, "rev-parse", "child"), changed);
  });

  it("preserves selected PR body as file data and binds each gh invocation to its host", () => {
    const bin = join(scratch, "body-gh");
    mkdirSync(bin);
    const log = join(scratch, "body-calls");
    const body = 'Review body\nLiteral $(not-a-command) and `also data`\n';
    const file = join(scratch, "pr-body.md");
    writeFileSync(join(bin, "gh"), '#!/usr/bin/env node\nconst fs=require("node:fs");const a=process.argv.slice(2);fs.appendFileSync(process.env.CALL_LOG,JSON.stringify({args:a,host:process.env.GH_HOST})+"\\n");if(a.includes("view"))process.stdout.write(process.env.PR_BODY);\n');
    chmodSync(join(bin, "gh"), 0o755);
    const merge = [...shipping.matchAll(/```sh\n([\s\S]*?)\n```/g)].map((m) => m[1]).find((block) => block.includes("--match-head-commit"));
    assert.ok(merge);
    const result = spawnSync("/bin/sh", ["-c", merge], { cwd: scratch, env: { ...env, PATH: `${bin}:${env.PATH}`, CALL_LOG: log, PR_BODY: body, GH_HOST: "wrong.invalid", op_host: "github.com", op_repo: "fixture/project", op_pr: "12", op_published_head: "a".repeat(40), op_body_file: file }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(file, "utf8"), body);
    const calls = readFileSync(log, "utf8").trim().split("\n").map((s) => JSON.parse(s));
    assert.equal(calls.length, 2);
    for (const call of calls) { assert.equal(call.host, "github.com"); assert.ok(call.args.includes("fixture/project")); assert.ok(call.args.includes("12")); }
    assert.ok(calls[1].args.includes("--body-file"));
    assert.ok(calls[1].args.includes(file));
    assert.ok(calls[1].args.includes("a".repeat(40)));
  });

  it("pins the generated entry, evidence, withdrawal, contribution and hold contracts", () => {
    const directory = join(PLUGIN_ROOT, "skills/poteto-mode/playbooks");
    for (const name of ["shipping", "opening-a-pr", "autopilot-full", "autopilot-stack", "babysit", "multi-phase-plan"]) {
      const text = readFileSync(join(directory, `${name}.md`), "utf8");
      assert.match(text.split("\n").slice(0, 7).join("\n"), /Before the first PR operation, read the Guarded operations section/);
    }
    assert.match(shipping, /Stable patch-id is a diagnostic, never permission to reuse evidence/);
    assert.match(shipping, /A changed patch, changed relevant input, or uncertain impact requires a rerun/);
    assert.match(shipping, /Live lanes without reproducible build output rerun/);
    assert.match(shipping, /old parent tip to the old child tip/);
    assert.match(shipping, /same canonical patch command/);
    assert.match(shipping, /disablePullRequestAutoMerge/);
    assert.doesNotMatch(shipping, /gh pr merge[^\n]*--disable-auto/);
    assert.ok(shipping.indexOf("#### Guarded operations") > shipping.indexOf("9. **Stop at the ceiling"));
    for (const name of ["autopilot-full", "multi-phase-plan"]) {
      const text = readFileSync(join(directory, `${name}.md`), "utf8");
      const hold = text.split("\n").find((line) => line.includes("zero-writes order"));
      assert.match(hold ?? "", /Report any pending request so an authorized actor/);
    }
    assert.match(shipping, /merge-when-ready.*watch until current requirements pass/i);
    assert.doesNotMatch(readFileSync(join(directory, "opening-a-pr.md"), "utf8"), /git fetch && git reset/);
    assert.match(readFileSync(join(directory, "babysit.md"), "utf8"), /gh api --hostname/);
  });

  const artifactContracts = [
    ["GraphQL auto-merge withdrawal", /disablePullRequestAutoMerge/],
    ["old child patch capture", /same canonical patch command/],
    ["wait before expected-head submission", /merge-when-ready.*watch until current requirements pass/i],
  ] as const;
  for (const [name, pattern] of artifactContracts) it(`ships ${name}`, () => assert.match(shipping, pattern));
  for (const name of ["autopilot-full", "multi-phase-plan"]) it(`surfaces accepted work on ${name} hold`, () => {
    const text = readFileSync(join(PLUGIN_ROOT, `skills/poteto-mode/playbooks/${name}.md`), "utf8");
    assert.match(text.split("\n").find((line) => line.includes("zero-writes order")) ?? "", /Report any pending request so an authorized actor/);
  });
  it("routes supported Shipping and preserves the operator's separate manual path", () => {
    const router = readFileSync(join(PLUGIN_ROOT, "skills/poteto-mode/SKILL.md"), "utf8").split("\n").find((line) => line.startsWith("- **Shipping."));
    assert.doesNotMatch(router ?? "", /Origin when/);
    assert.match(readFileSync(join(PLUGIN_ROOT, "docs/reference.md"), "utf8"), /Sua revisão e seu clique não dependem de um Veredito/);
  });
});
