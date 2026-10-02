import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clisOutsideFakes, isolatedEnv, isolateProcessEnv } from "../skills/poteto-mode/scripts/runner/isolated-env.test-helper.ts";
import { PLUGIN_ROOT } from "./model-matrix.ts";

const shipping = readFileSync(join(PLUGIN_ROOT, "skills/poteto-mode/playbooks/shipping.md"), "utf8");
const blocks = [...shipping.matchAll(/```sh\n([\s\S]*?)\n```/g)].map((block) => block[1]);
const fixtureUrl = "git@github.com:fixture/intended.git";
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
  for (const utility of ["basename", "sed", "uname", "dirname", "rm", "mkdir", "cat", "grep", "cut", "tr", "sort", "head", "wc", "sh", "xargs", "expr", "touch", "cp", "mv", "awk", "rmdir"]) {
    const executable = execFileSync("/usr/bin/which", [utility], { encoding: "utf8" }).trim();
    symlinkSync(executable, join(bin, utility));
  }
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
  const ssh = join(cwd, ".git", "fixture-ssh");
  return execFileSync("git", args, { cwd, env: { ...env, ...(existsSync(ssh) ? { GIT_SSH_COMMAND: ssh, GIT_SSH_VARIANT: "ssh" } : {}) }, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
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
  const commands = blocks.filter((block) => block.split("\n").some((line) => line.startsWith(prefix)));
  assert.equal(commands.length, 1, `one generated command for ${prefix}`);
  return commands[0];
}

function recipe(path: string, text: string, values: Record<string, string>) {
  const ssh = join(path, ".git", "fixture-ssh");
  return spawnSync("/bin/sh", ["-c", text], { cwd: path, env: { ...env, op_host: "github.com", op_owner: "fixture", op_name: "intended", op_remote: "origin", ...(existsSync(ssh) ? { GIT_SSH_COMMAND: ssh, GIT_SSH_VARIANT: "ssh" } : {}), ...values }, encoding: "utf8" });
}

function transport(path: string, remote: string): void {
  git(path, "config", "remote.origin.url", fixtureUrl);
  git(path, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
  const ssh = join(path, ".git", "fixture-ssh");
  writeFileSync(ssh, `#!${process.execPath}\nconst {spawnSync}=require("node:child_process");\nconst args=process.argv.slice(2);\nif(!args.includes("git@github.com"))process.exit(63);\nconst m=/^(git-upload-pack|git-receive-pack) 'fixture\\/intended\\.git'$/.exec(args.at(-1));\nif(!m)process.exit(64);\nconst r=spawnSync(m[1],[${JSON.stringify(remote)}],{stdio:"inherit"});\nprocess.exit(r.status??65);\n`);
  chmodSync(ssh, 0o755);
}

function exactPatch(path: string, base: string, head: string): string {
  const result = recipe(path, command("git -c core.quotePath=true "), { op_patch_base: base, op_patch_head: head });
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
    transport(first, remote);
    git(first, "fetch", "-q", "origin");
    const second = join(scratch, "second");
    git(first, "clone", "-q", remote, second);
    const concurrent = commit(second, "file", "second writer\n");
    git(second, "push", "-q", "origin", "HEAD:refs/heads/main");
    git(first, "fetch", "-q", "origin");
    assert.equal(git(first, "rev-parse", "origin/main"), concurrent);
    commit(first, "file", "rewritten\n");
    const result = recipe(first, command('git push "'), {
      op_branch: "main", op_remote_head: captured,
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
      const result = recipe(path, command('git push "'), { op_branch: "main", op_remote_head: captured });
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
    transport(path, remote);
    git(path, "checkout", "-q", "main");
    git(path, "merge", "--squash", "parent");
    git(path, "commit", "-qm", "squash");
    const values = { op_new_base: git(path, "rev-parse", "HEAD"), op_old_parent_tip: oldParent, op_old_child_tip: oldChild, op_branch: "child" };
    const restack = recipe(path, command("git rebase --onto "), values);
    assert.equal(restack.status, 0, restack.stderr);
    const badPush = recipe(path, command('git push "'), { op_branch: "parent", op_remote_head: oldParent });
    assert.notEqual(badPush.status, 0);
    assert.equal(git(remote, "rev-parse", "parent"), oldParent);
    assert.equal(git(remote, "rev-parse", "child"), oldChild);
  });

  it("rebases onto the fetched SHA while a named remote tracking ref stays stale", () => {
    const path = repo();
    const old = commit(path, "base", "old\n");
    const remote = join(path, "remote.git");
    git(path, "clone", "-q", "--bare", path, remote);
    transport(path, remote);
    git(path, "fetch", "-q", "origin");
    const writer = join(path, "writer");
    git(path, "clone", "-q", remote, writer);
    const current = commit(writer, "base", "current\n");
    git(writer, "push", "-q", "origin", "HEAD:refs/heads/main");
    git(path, "checkout", "-qb", "feature");
    commit(path, "feature", "feature\n");
    const values = { op_selected_ref: "main", op_selected_sha: current, op_branch: "feature" };
    const fetched = recipe(path, command("git fetch "), values);
    assert.equal(fetched.status, 0, fetched.stderr);
    assert.equal(fetched.stdout.trim(), current);
    assert.equal(git(path, "rev-parse", "origin/main"), old);
    const rebased = recipe(path, command("git rebase \""), { op_new_base: fetched.stdout.trim(), op_branch: "feature" });
    assert.equal(rebased.status, 0, rebased.stderr);
    assert.equal(git(path, "rev-parse", "HEAD^"), current);
    const mismatch = recipe(path, command("git fetch "), { ...values, op_selected_sha: old });
    assert.notEqual(mismatch.status, 0);
  });

  it("rejects every missing or empty command input before an inert transport runs", () => {
    const bin = join(scratch, "inert");
    mkdirSync(bin);
    const log = join(scratch, "inert-invocations");
    const stub = '#!/usr/bin/env node\nrequire("node:fs").appendFileSync(process.env.CALL_LOG, JSON.stringify(process.argv.slice(2))+"\\n");\n';
    for (const tool of ["gh", "git"]) { writeFileSync(join(bin, tool), stub); chmodSync(join(bin, tool), 0o755); }
    const failures: string[] = [];
    for (const block of blocks) {
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
    const body = 'Review body\nLiteral $(not-a-command) and `also data`\nTrailing spaces stay literal  \n';
    const file = join(scratch, "pr-body.md");
    writeFileSync(join(bin, "gh"), '#!/usr/bin/env node\nconst fs=require("node:fs");const a=process.argv.slice(2);fs.appendFileSync(process.env.CALL_LOG,JSON.stringify({args:a,host:process.env.GH_HOST})+"\\n");if(a.includes("view"))process.stdout.write(process.env.PR_BODY+"\\n");\n');
    chmodSync(join(bin, "gh"), 0o755);
    const merge = blocks.find((block) => block.includes("--match-head-commit"));
    assert.ok(merge);
    const result = spawnSync("/bin/sh", ["-c", merge], { cwd: scratch, env: { ...env, PATH: `${bin}:${env.PATH}`, CALL_LOG: log, PR_BODY: body, GH_HOST: "wrong.invalid", op_host: "github.com", op_owner: "fixture", op_name: "project", op_repo: "wrong.invalid/elsewhere/other", op_pr: "12", op_published_head: "a".repeat(40), op_body_file: file }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(file, "utf8"), body + "\n");
    assert.match(shipping, /Only final LF normalization/);
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

  for (const redirect of ["url", "pushurl"]) it(`refuses an included URL-named remote ${redirect} before capture, fetch or push`, () => {
    const path = repo();
    const old = commit(path, "file", "old\n");
    const intended = join(path, "intended.git"), wrong = join(path, "wrong.git");
    git(path, "clone", "-q", "--bare", path, intended);
    git(path, "clone", "-q", "--bare", path, wrong);
    transport(path, intended);
    const included = join(path, ".git", "included-config");
    git(path, "config", "--file", included, `remote.${fixtureUrl}.${redirect}`, wrong);
    git(path, "config", "include.path", included);
    const resolved = recipe(path, command('printf \'%s\\n\' "${op_fetch_url'), {});
    const capture = recipe(path, command("op_remote_head=$(git ls-remote"), { op_branch: "main", op_local_pre_head: old });
    const fetched = recipe(path, command("git fetch "), { op_selected_ref: "main", op_selected_sha: old });
    commit(path, "file", "new\n");
    const pushed = recipe(path, command('git push "'), { op_branch: "main", op_remote_head: old });
    const first = recipe(path, command("git push --no-follow-tags "), { op_branch: "main" });
    assert.ok([resolved, capture, fetched, pushed, first].every((r) => r.status !== 0 && /URL rewriting is unsupported/.test(r.stderr)), "all complete transport blocks must refuse the redirect");
    assert.equal(git(intended, "rev-parse", "main"), old);
    assert.equal(git(wrong, "rev-parse", "main"), old);
  });

  it("rejects unsupported URLs and multiple destinations before a transport can run", () => {
    const path = repo();
    const old = commit(path, "file", "old\n");
    const remote = join(path, "intended.git");
    git(path, "clone", "-q", "--bare", path, remote);
    transport(path, remote);
    const failures: string[] = [];
    for (const url of [remote, "https://github.com/other/intended.git", "https://github.com/fixture/fork.git", "https://user:password@github.com/fixture/intended.git", "https://elsewhere.invalid/fixture/intended.git", "ssh://git@github.com:22/fixture/intended.git"]) {
      git(path, "config", "remote.origin.url", url);
      for (const prefix of ['printf \'%s\\n\' "${op_fetch_url', "op_remote_head=$(git ls-remote", "git fetch ", 'git push "', "git push --no-follow-tags "]) {
        const result = recipe(path, command(prefix), { op_branch: "main", op_local_pre_head: old, op_remote_head: old, op_selected_ref: "main", op_selected_sha: old, GIT_ALLOW_PROTOCOL: "file" });
        if (result.status === 0 || !/Unsupported Git transport identity/.test(result.stderr)) failures.push(`${prefix}: ${url}`);
      }
    }
    git(path, "config", "remote.origin.url", fixtureUrl);
    git(path, "config", "--add", "remote.origin.url", fixtureUrl);
    const multiple = recipe(path, command('git push "'), { op_branch: "main", op_remote_head: old, GIT_ALLOW_PROTOCOL: "file" });
    if (!/Unsupported Git transport identity/.test(multiple.stderr)) failures.push("multiple URLs");
    assert.deepEqual(failures, []);
    assert.equal(git(remote, "rev-parse", "main"), old);
  });

  it("resolves supported GitHub URL forms against the recorded repository without transport", () => {
    const path = repo();
    commit(path, "file", "old\n");
    const resolve = command('printf \'%s\\n\' "${op_fetch_url');
    for (const base of ["https://github.com/Fixture/Intended", "git@github.com:fixture/intended", "ssh://git@github.com/fixture/intended"]) for (const suffix of ["", ".git"]) {
      const url = base + suffix;
      git(path, "config", "remote.origin.url", url);
      const result = recipe(path, resolve, {});
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, `${url}\n${url}\n`);
    }
  });

  it("captures a real remote head, publishes only its branch, and refuses invalid capture states", () => {
    const path = repo();
    const old = commit(path, "file", "old\n");
    const remote = join(path, "intended.git");
    git(path, "clone", "-q", "--bare", path, remote);
    transport(path, remote);
    const capture = () => recipe(path, command("op_remote_head=$(git ls-remote"), { op_branch: "main", op_local_pre_head: old });
    const captured = capture();
    assert.equal(captured.status, 0, captured.stderr);
    assert.equal(captured.stdout.trim(), old);
    git(path, "config", "push.followTags", "true");
    const next = commit(path, "file", "new\n");
    git(path, "tag", "-am", "unowned", "v-unowned");
    assert.notEqual(capture().status, 0, "wrong local pre-wave tip");
    const pushed = recipe(path, command('git push "'), { op_branch: "main", op_remote_head: captured.stdout.trim() });
    assert.equal(pushed.status, 0, pushed.stderr);
    assert.equal(git(remote, "for-each-ref", "--format=%(refname) %(objectname)"), `refs/heads/main ${next}`);
    git(path, "checkout", "-qb", "wrong", old);
    assert.notEqual(capture().status, 0, "wrong branch");
    git(path, "checkout", "--detach", old);
    assert.notEqual(capture().status, 0, "detached HEAD");
    git(path, "checkout", "main");
    git(remote, "update-ref", "refs/heads/main", old);
    assert.notEqual(recipe(path, command("op_remote_head=$(git ls-remote"), { op_branch: "main", op_local_pre_head: next }).status, 0, "moved remote");
    git(path, "checkout", "-qb", "absent");
    assert.notEqual(recipe(path, command("op_remote_head=$(git ls-remote"), { op_branch: "absent", op_local_pre_head: next }).status, 0, "absent remote branch");
  });

  it("does not push an unowned submodule remote with on-demand recursion enabled", () => {
    const path = repo(), seed = repo();
    const subOld = commit(seed, "data", "old\n");
    const subRemote = join(seed, "sub.git");
    git(seed, "clone", "-q", "--bare", seed, subRemote);
    git(path, "-c", "protocol.file.allow=always", "submodule", "add", subRemote, "sub");
    git(path, "commit", "-qm", "submodule base");
    const old = git(path, "rev-parse", "HEAD");
    const remote = join(path, "intended.git");
    git(path, "clone", "-q", "--bare", path, remote);
    transport(path, remote);
    commit(join(path, "sub"), "data", "unpublished\n");
    git(path, "commit", "-qam", "submodule update");
    git(path, "config", "push.recurseSubmodules", "on-demand");
    const result = recipe(path, command('git push "'), { op_branch: "main", op_remote_head: old });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(git(remote, "rev-parse", "main"), git(path, "rev-parse", "HEAD"));
    assert.equal(git(subRemote, "rev-parse", "main"), subOld);
  });

  for (const child of [false, true]) it(`keeps unowned local refs fixed during ${child ? "child" : "independent"} rebase`, () => {
    const path = repo();
    const base = commit(path, "base", "base\n");
    git(path, "checkout", "-qb", "owned");
    const other = commit(path, "child", "first\n");
    git(path, "branch", "unowned");
    const oldChild = commit(path, "child", "first\nsecond\n");
    git(path, "checkout", "main");
    const newBase = commit(path, "advance", "advanced\n");
    git(path, "checkout", "owned");
    git(path, "config", "rebase.updateRefs", "true");
    const result = recipe(path, command(child ? "git rebase --onto " : 'git rebase "'), { op_branch: "owned", op_new_base: newBase, op_old_parent_tip: base, op_old_child_tip: oldChild });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(git(path, "rev-parse", "unowned"), other);
    assert.equal(git(path, "rev-list", "--count", `${newBase}..owned`), "2");
  });

  it("refuses an empty child range before changing its branch or files", () => {
    const path = repo();
    const base = commit(path, "base", "base\n");
    git(path, "checkout", "-qb", "child");
    const child = commit(path, "child", "must survive\n");
    const result = recipe(path, command("git rebase --onto "), { op_new_base: base, op_old_parent_tip: child, op_old_child_tip: child, op_branch: "child" });
    assert.notEqual(result.status, 0);
    assert.equal(git(path, "rev-parse", "child"), child);
    assert.equal(readFileSync(join(path, "child"), "utf8"), "must survive\n");
  });

  it("publishes a first branch only while the remote ref is absent", () => {
    const path = repo();
    commit(path, "base", "base\n");
    const remote = join(path, "intended.git");
    git(path, "clone", "-q", "--bare", path, remote);
    transport(path, remote);
    git(path, "checkout", "-qb", "new-branch");
    const first = commit(path, "own", "first\n");
    git(path, "config", "push.followTags", "true");
    git(path, "tag", "-am", "must stay local", "v-initial-unowned");
    const initial = command("git push --no-follow-tags ");
    const values = { op_branch: "new-branch" };
    assert.equal(recipe(path, initial, values).status, 0);
    assert.equal(git(remote, "for-each-ref", "--format=%(refname)", "refs/tags"), "");
    commit(path, "own", "second\n");
    assert.notEqual(recipe(path, initial, values).status, 0);
    assert.equal(git(remote, "rev-parse", "new-branch"), first);
  });

  it("stops after restack drops a child commit already present in the new base", () => {
    const path = repo();
    const base = commit(path, "base", "base\n");
    git(path, "checkout", "-qb", "child");
    const child = commit(path, "child", "contribution\n");
    git(path, "checkout", "main");
    commit(path, "advance", "base changed\n");
    git(path, "cherry-pick", child);
    const result = recipe(path, command("git rebase --onto "), { op_new_base: git(path, "rev-parse", "HEAD"), op_old_parent_tip: base, op_old_child_tip: child, op_branch: "child" });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /Original child commits: 1/);
    assert.match(result.stdout, /Rewritten child commits: 0/);
  });

  it("records that touched-file base drift changes strict patch bytes", () => {
    const path = repo();
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n")+"\n";
    const base = commit(path, "shared", lines);
    git(path, "checkout", "-qb", "feature");
    const child = commit(path, "shared", lines.replace("line 19", "contribution"));
    const original = exactPatch(path, base, child);
    git(path, "checkout", "main");
    const moved = commit(path, "shared", lines.replace("line 0", "base drift"));
    git(path, "checkout", "feature"); git(path, "rebase", "main");
    assert.notEqual(exactPatch(path, moved, "HEAD"), original);
    assert.match(shipping, /Touched-file base content is part of this exact identity/);
  });

  it("binds both watcher call sites to host, repository and explicit PR", () => {
    for (const name of ["shipping", "babysit"]) {
      const text = readFileSync(join(PLUGIN_ROOT, `skills/poteto-mode/playbooks/${name}.md`), "utf8");
      assert.match(text, /GH_HOST=.*scripts\/watch-pr\/watch-pr --owner .* --repo .* --pr /);
      assert.match(text, /Compare the returned PR and head/);
    }
  });

  it("routes supported Shipping and preserves the operator's separate manual path", () => {
    const router = readFileSync(join(PLUGIN_ROOT, "skills/poteto-mode/SKILL.md"), "utf8").split("\n").find((line) => line.startsWith("- **Shipping."));
    assert.doesNotMatch(router ?? "", /Origin when/);
    assert.match(readFileSync(join(PLUGIN_ROOT, "docs/reference.md"), "utf8"), /Sua revisão e seu clique não dependem de um Veredito/);
  });
});
