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
  for (const utility of ["basename", "sed", "uname", "dirname", "rm", "mkdir", "cat", "grep", "cut", "tr", "sort", "head", "wc", "sh", "xargs", "expr", "touch", "cp", "mv", "awk", "rmdir", "cmp", "mktemp", "date", "jq", "true"]) {
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
  const stateFile = join(path, ".git", "fixture.json");
  const fixture = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : null;
  return spawnSync("/bin/sh", ["-c", text], { cwd: path, env: {
    ...env, TMPDIR: scratch, op_host: "github.com", op_owner: "fixture", op_name: "intended", op_remote: "origin",
    op_pr: "12", op_pr_node_id: "PR_fixture", op_base_ref: "main", op_base_sha: fixture?.base ?? "0".repeat(40),
    op_push_receipt: join(path, ".git", "push.receipt"),
    op_diff_inputs: join(scratch, "diff-inputs"),
    ...(existsSync(ssh) ? { GIT_SSH_COMMAND: ssh, GIT_SSH_VARIANT: "ssh" } : {}),
    ...(fixture ? { FIXTURE_STATE: stateFile, PATH: `${join(path, ".git", "fixture-bin")}:${env.PATH}`, ...(fixture.url.startsWith("https:") ? { GIT_EXEC_PATH: join(path, ".git", "fixture-bin") } : {}) } : {}),
    ...values,
  }, encoding: "utf8" });
}

function transport(path: string, remote: string, url = fixtureUrl): void {
  git(path, "config", "remote.origin.url", url);
  git(path, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
  const ssh = join(path, ".git", "fixture-ssh");
  writeFileSync(ssh, `#!${process.execPath}\nconst {spawnSync}=require("node:child_process");\nconst args=process.argv.slice(2);\nif(!args.includes("git@github.com"))process.exit(63);\nconst m=/^(git-upload-pack|git-receive-pack) '\\/?fixture\\/intended(?:\\.git)?'$/i.exec(args.at(-1));\nif(!m)process.exit(64);\nconst r=spawnSync(m[1],[${JSON.stringify(remote)}],{stdio:"inherit"});\nprocess.exit(r.status??65);\n`);
  chmodSync(ssh, 0o755);
  const bin = join(path, ".git", "fixture-bin"); mkdirSync(bin);
  writeFileSync(join(path, ".git", "fixture.json"), JSON.stringify({ remote, url, base: git(remote, "rev-parse", "HEAD"), draft: false }));
  const gh = `#!${process.execPath}
const fs=require("node:fs"),{spawnSync}=require("node:child_process");
const a=process.argv.slice(2), p=process.env.FIXTURE_STATE, s=JSON.parse(fs.readFileSync(p,"utf8"));
const field=k=>a.find(x=>x.startsWith(k+"="))?.slice(k.length+1);
const option=k=>a[a.indexOf(k)+1];
fs.appendFileSync(p+".calls",JSON.stringify({args:a,host:process.env.GH_HOST})+"\\n");
if(process.env.FORGE_MODE==="fail")process.exit(73);
if(process.env.FORGE_MODE==="missing"){process.stdout.write("\\n");process.exit(0);}
const oid=ref=>{const r=spawnSync("git",["--git-dir",process.env.FORGE_REMOTE||s.remote,"rev-parse","--verify",ref],{encoding:"utf8"});if(r.status)process.exit(74);return r.stdout.trim();};
if(a[0]==="pr"){
 if(option("--repo")!=="fixture/intended"||process.env.GH_HOST!=="github.com")process.exit(75);
 if(a[1]==="create"){s.branch=option("--head");s.baseRef=option("--base");s.base=oid("refs/heads/"+s.baseRef);s.draft=false;process.stdout.write("https://github.com/fixture/intended/pull/12\\n");}
 else if(a[1]==="edit"){s.baseRef=option("--base");s.base=oid("refs/heads/"+s.baseRef);}
 else if(a[1]==="ready")s.draft=false;
 else if(a[1]==="view"){process.stdout.write((s.body||"literal body")+"\\n");process.exit(0);}
 else if(a[1]==="merge"){
  if(option("--match-head-commit")!==oid("refs/heads/"+(s.branch||process.env.op_branch)))process.exit(79);
  s.mergedBody=fs.readFileSync(option("--body-file"),"utf8");
  if(process.env.MERGE_OUTCOME==="queue")s.queue=true;
  else if(process.env.MERGE_OUTCOME==="auto")s.auto=true;
  else if(process.env.MERGE_OUTCOME!=="noop")s.state="MERGED";
 }
 else process.exit(76);
 fs.writeFileSync(p,JSON.stringify(s));process.exit(0);
}
if(a.includes("--method")){process.stdout.write("{}\\n");process.exit(0);}
if(field("query")?.startsWith("mutation")){
 if(field("id")!=="PR_fixture")process.exit(80);
 if(process.env.WITHDRAW_OUTCOME==="merged")s.state="MERGED";
 if(field("query").includes("dequeuePullRequest"))s.queue=false;
 if(field("query").includes("disablePullRequestAutoMerge"))s.auto=false;
 fs.writeFileSync(p,JSON.stringify(s));process.stdout.write("{}\\n");process.exit(0);
}
if(field("owner").toLowerCase()!=="fixture"||field("name").toLowerCase()!=="intended"||process.env.GH_HOST!=="github.com")process.exit(77);
const ref=field("ref"), branch=s.branch||process.env.op_branch;
const head=process.env.FORGE_MODE==="mismatch"?"0".repeat(40):oid(ref||"refs/heads/"+branch);
const pr={id:"PR_fixture",number:12,state:s.state||"OPEN",isDraft:s.draft,headRepository:{nameWithOwner:"fixture/intended"},headRefName:branch,headRefOid:head,baseRefName:s.baseRef||"main",baseRefOid:s.base,autoMergeRequest:s.auto?{enabledAt:"2026-01-01T00:00:00Z"}:null,mergeQueueEntry:s.queue?{id:"QUEUE_fixture"}:null,mergedAt:s.state==="MERGED"?"2026-01-01T00:00:00Z":null,mergeCommit:s.state==="MERGED"?{oid:head}:null,...s.fields};
for(const key of s.omit||[])delete pr[key];
const response={data:{repository:{nameWithOwner:s.repo||"fixture/intended",pullRequest:pr,ref:{name:ref?.replace("refs/heads/",""),prefix:"refs/heads/",target:{oid:head,__typename:"Commit"}}}}};
const filter=option("--jq");
if(!a.includes("--jq")){process.stdout.write(JSON.stringify(response));process.exit(0);}
const parsed=spawnSync("jq",["-r",filter],{input:JSON.stringify(response),encoding:"utf8"});
process.stdout.write(parsed.stdout);process.stderr.write(parsed.stderr);process.exit(parsed.status??78);
`;
  writeFileSync(join(bin, "gh"), gh); chmodSync(join(bin, "gh"), 0o755);
  const https = `#!${process.execPath}
const fs=require("node:fs"),{spawnSync}=require("node:child_process");
if(!/^https:\\/\\/github.com\\/fixture\\/intended(?:\\.git)?$/i.test(process.argv.at(-1)))process.exit(63);
function line(){let s="",b=Buffer.alloc(1);while(fs.readSync(0,b,0,1,null)){s+=b.toString();if(s.endsWith("\\n"))return s.trim();}return s;}
if(line()!=="capabilities")process.exit(64);fs.writeSync(1,"connect\\n\\n");
const m=/^connect git-(upload-pack|receive-pack)$/.exec(line());if(!m)process.exit(65);
fs.writeSync(1,"\\n");const r=spawnSync("git",[m[1],${JSON.stringify(remote)}],{stdio:"inherit"});process.exit(r.status??66);
`;
  writeFileSync(join(bin, "git-remote-https"), https); chmodSync(join(bin, "git-remote-https"), 0o755);
}

function exactPatch(path: string, base: string, head: string): string {
  const result = recipe(path, command(': "${op_patch_base:?}"'), { op_patch_base: git(path, "--no-replace-objects", "rev-parse", `${base}^{commit}`), op_patch_head: git(path, "--no-replace-objects", "rev-parse", `${head}^{commit}`) });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function patchId(path: string, patch: string): string {
  return execFileSync("git", ["patch-id", "--stable"], { cwd: path, env, input: patch, encoding: "utf8" }).split(" ")[0];
}

function output(path: string): string {
  return execFileSync(process.execPath, ["app.mjs"], { cwd: path, env, encoding: "utf8" });
}

function forgeFixture() {
  const path = repo();
  const head = commit(path, "file", "original\n");
  const remote = join(path, ".git", "remote.git");
  git(path, "clone", "-q", "--bare", path, remote);
  transport(path, remote);
  const stateFile = join(path, ".git", "fixture.json");
  const values = { op_branch: "main", op_published_head: head, op_body_file: join(path, ".git", "body"), op_queue_authorized: "false" };
  return { path, head, stateFile, values };
}

function changeForge(stateFile: string, values: Record<string, unknown>) {
  writeFileSync(stateFile, JSON.stringify({ ...JSON.parse(readFileSync(stateFile, "utf8")), ...values }));
}

function forgeCalls(stateFile: string): { args: string[]; host: string }[] {
  return existsSync(stateFile + ".calls") ? readFileSync(stateFile + ".calls", "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}

describe("fix4 complete boundaries", () => {
  it("refuses a shallow boundary that hides a raw merge parent", () => {
    const path = repo(); const base = commit(path, "base", "base\n");
    git(path, "switch", "-c", "side"); commit(path, "side", "side\n");
    git(path, "switch", "-c", "owned", base); commit(path, "own", "own\n");
    git(path, "merge", "--no-ff", "--no-commit", "side"); const merged = commit(path, "resolution", "merge-only\n");
    git(path, "switch", "main"); const newBase = commit(path, "advance", "advance\n"); git(path, "switch", "owned");
    writeFileSync(join(path, ".git", "shallow"), merged + "\n");
    assert.equal(git(path, "rev-parse", "--is-shallow-repository"), "true");
    const refs = git(path, "for-each-ref", "--format=%(refname) %(objectname)");
    const result = recipe(path, command('git rebase "'), { op_branch: "owned", op_new_base: newBase });
    assert.notEqual(result.status, 0);
    assert.equal(git(path, "for-each-ref", "--format=%(refname) %(objectname)"), refs);
    assert.equal(readFileSync(join(path, "resolution"), "utf8"), "merge-only\n");
  });

  for (const graft of [false, true]) it(`refuses unrelated raw ancestry with graft=${graft} at range and restack`, () => {
    const path = repo(); const root = commit(path, "base", "base\n");
    git(path, "switch", "-c", "parent"); const parent = commit(path, "parent", "parent\n");
    git(path, "switch", "-c", "child", root); const child = commit(path, "own", "own\n");
    if (graft) writeFileSync(join(path, ".git", "info", "grafts"), `${child} ${parent}\n`);
    const before = git(path, "for-each-ref", "--format=%(refname) %(objectname)");
    for (const prefix of ["git log --oneline ", "git rebase --onto "]) {
      const result = recipe(path, command(prefix), { op_branch: "child", op_old_parent_tip: parent, op_old_child_tip: child, op_new_base: root });
      assert.notEqual(result.status, 0, `${prefix}: unrelated raw parent must refuse`);
      assert.equal(git(path, "for-each-ref", "--format=%(refname) %(objectname)"), before);
      assert.equal(git(path, "status", "--porcelain"), "");
    }
  });

  for (const graft of [false, true]) for (const child of [false, true]) it(`preserves raw merge-only content in ${child ? "child" : "bottom"} rebase with graft=${graft}`, () => {
    const path = repo(); const base = commit(path, "base", "base\n");
    git(path, "switch", "-c", "side"); const side = commit(path, "side", "side\n");
    git(path, "switch", "-c", "owned", base); const first = commit(path, "own", "own\n");
    git(path, "merge", "--no-ff", "--no-commit", "side");
    const merged = commit(path, "resolution", "merge-only content\n");
    git(path, "switch", "main"); const nextBase = commit(path, "advance", "advance\n"); git(path, "switch", "owned");
    assert.match(git(path, "cat-file", "-p", merged), new RegExp(`parent ${first}\\nparent ${side}`));
    if (graft) writeFileSync(join(path, ".git", "info", "grafts"), `${merged} ${base}\n`);
    const refs = git(path, "for-each-ref", "--format=%(refname) %(objectname)");
    const result = recipe(path, command(child ? "git rebase --onto " : 'git rebase "'), { op_branch: "owned", op_old_parent_tip: base, op_old_child_tip: merged, op_new_base: nextBase });
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.equal(git(path, "for-each-ref", "--format=%(refname) %(objectname)"), refs);
    assert.equal(readFileSync(join(path, "resolution"), "utf8"), "merge-only content\n");
  });

  for (const linked of [false, true]) it(`refuses restack outside the actual child checkout with linked=${linked}`, () => {
    const path = repo(); const base = commit(path, "base", "base\n");
    git(path, "switch", "-c", "child"); const child = commit(path, "own", "own\n");
    git(path, "switch", "main"); const nextBase = commit(path, "trunk", "trunk\n");
    const owner = join(scratch, `owner-${linked}`);
    if (linked) git(path, "worktree", "add", owner, "child");
    const refs = git(path, "for-each-ref", "--format=%(refname) %(objectname)");
    const result = recipe(path, command("git rebase --onto "), { op_branch: "child", op_old_parent_tip: base, op_old_child_tip: child, op_new_base: nextBase });
    assert.notEqual(result.status, 0);
    assert.equal(git(path, "for-each-ref", "--format=%(refname) %(objectname)"), refs);
    assert.equal(git(path, "symbolic-ref", "HEAD"), "refs/heads/main");
    assert.equal(git(path, "status", "--porcelain"), "");
    if (linked) {
      assert.equal(git(owner, "status", "--porcelain"), "");
      const legitimate = recipe(owner, command("git rebase --onto "), { op_branch: "child", op_old_parent_tip: base, op_old_child_tip: child, op_new_base: nextBase });
      assert.equal(legitimate.status, 0, legitimate.stderr);
      assert.equal(git(owner, "status", "--porcelain"), "");
      assert.equal(readFileSync(join(owner, "trunk"), "utf8"), "trunk\n");
      assert.equal(git(path, "symbolic-ref", "HEAD"), "refs/heads/main");
    }
  });

  it("reports actual failed post-read tuples, times, status and operation", () => {
    const f = forgeFixture();
    commit(f.path, "file", "published change\n");
    const result = recipe(f.path, command('git push "'), { ...f.values, op_remote_head: f.head, FORGE_MODE: "mismatch" });
    assert.notEqual(result.status, 0);
    for (const field of ["expected=", "observed=", "started=", "ended=", "status=", "operation=publish"]) assert.ok(result.stderr.includes(field), field);
    assert.ok(result.stderr.includes("0".repeat(40)));
  });

  for (const bad of [{ fields: { id: "PR_wrong" } }, { fields: { headRefOid: "0".repeat(40) } }, { fields: { baseRefName: "wrong" } }, { queue: true }, { auto: true }]) it(`refuses merge before writes for ${JSON.stringify(bad)}`, () => {
    const f = forgeFixture(); changeForge(f.stateFile, bad);
    const result = recipe(f.path, command('GH_HOST="${op_host:?}" gh pr merge '), f.values);
    assert.notEqual(result.status, 0);
    assert.equal(forgeCalls(f.stateFile).filter((c) => c.args[0] === "pr").length, 0);
  });

  for (const outcome of ["merged", "queue", "auto", "noop"]) it(`observes actual ${outcome} after merge submission and preserves literal body`, () => {
    const f = forgeFixture(); const body = 'Literal $(not-code) and `data`  \nSecond line\n'; changeForge(f.stateFile, { body });
    const result = recipe(f.path, command('GH_HOST="${op_host:?}" gh pr merge '), { ...f.values, op_queue_authorized: outcome === "queue" ? "true" : "false", MERGE_OUTCOME: outcome });
    assert.equal(result.status === 0, outcome === "merged" || outcome === "queue", result.stderr);
    const state = JSON.parse(readFileSync(f.stateFile, "utf8")); assert.equal(state.mergedBody, body + "\n");
    assert.equal(Boolean(state.auto), false, "unexpected auto request must be withdrawn");
    if (outcome === "queue") assert.equal(state.queue, true);
    assert.ok(forgeCalls(f.stateFile).filter((c) => c.args.includes("graphql")).length >= 2);
  });

  for (const mode of ["queue", "auto", "both", "absent", "winning-merge"]) it(`withdraws only observed ${mode} and reads both states back`, () => {
    const f = forgeFixture(); changeForge(f.stateFile, { queue: ["queue", "both", "winning-merge"].includes(mode), auto: ["auto", "both"].includes(mode) });
    const block = blocks.filter((b) => b.includes('dequeuePullRequest') || b.includes('disablePullRequestAutoMerge')).filter((b) => !b.includes('gh pr merge ')).join("\n");
    const result = recipe(f.path, block, { ...f.values, WITHDRAW_OUTCOME: mode === "winning-merge" ? "merged" : "normal" });
    assert.equal(result.status === 0, mode !== "winning-merge", result.stderr);
    const state = JSON.parse(readFileSync(f.stateFile, "utf8")); assert.equal(Boolean(state.queue), false); assert.equal(Boolean(state.auto), false);
    const calls = forgeCalls(f.stateFile); assert.ok(calls.filter((c) => c.args.some((a) => a.startsWith('query=query'))).length >= 2);
    assert.equal(calls.filter((c) => c.args.some((a) => a.includes('query=mutation'))).length, mode === "both" ? 2 : mode === "absent" ? 0 : 1);
  });

  for (const values of [{ op_host: "elsewhere.invalid" }, { op_pr_node_id: "PR_other" }, { op_pr: "--admin" }, { op_pr: "00" }]) it(`refuses withdrawal identity ${JSON.stringify(values)}`, () => {
    const f = forgeFixture(); changeForge(f.stateFile, { queue: true, auto: true });
    const block = blocks.filter((b) => b.includes('dequeuePullRequest') || b.includes('disablePullRequestAutoMerge')).filter((b) => !b.includes('gh pr merge ')).join("\n");
    const result = recipe(f.path, block, { ...f.values, ...values }); assert.notEqual(result.status, 0);
    assert.equal(forgeCalls(f.stateFile).filter((c) => c.args.some((a) => a.includes('query=mutation'))).length, 0);
  });

  it("routes cloud-default creation and reviewer replies through complete guards", () => {
    const opening = readFileSync(join(PLUGIN_ROOT, "skills/poteto-mode/playbooks/opening-a-pr.md"), "utf8");
    assert.doesNotMatch(opening, /set `draft: false` on every PR creation call/);
    assert.ok(blocks.some((b) => b.includes('/replies') && b.includes('set -eu')));
    assert.ok(blocks.some((b) => b.includes("op_reviewed_rewritten_head")), "changed-contribution recovery must have a guarded completion");
  });

  for (const conflict of [false, true]) it(`completes reviewed changed restack with conflict=${conflict}`, () => {
    const path = repo(); const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const base = commit(path, "file", lines); git(path, "switch", "-c", "child");
    const child = commit(path, "file", lines.replace("line 19", "child")); git(path, "switch", "main");
    const moved = commit(path, "file", lines.replace(conflict ? "line 19" : "line 0", "base drift")); git(path, "switch", "child");
    const values = { op_branch: "child", op_old_parent_tip: base, op_old_child_tip: child, op_new_base: moved };
    const strict = recipe(path, command("git rebase --onto "), values); assert.notEqual(strict.status, 0);
    assert.equal(git(path, "rev-parse", "refs/heads/child"), child);
    if (conflict) {
      writeFileSync(join(path, "file"), lines.replace("line 19", "resolved child and base")); git(path, "add", "file");
      const continued = recipe(path, "GIT_EDITOR=true GIT_NO_REPLACE_OBJECTS=1 GIT_GRAFT_FILE=/dev/null git rebase --continue", {});
      assert.equal(continued.status, 0, continued.stderr);
    }
    const rewritten = git(path, "rev-parse", "HEAD");
    assert.equal(readFileSync(join(path, "file"), "utf8"), conflict ? lines.replace("line 19", "resolved child and base") : lines.replace("line 0", "base drift").replace("line 19", "child"));
    const reviewFile = join(path, ".git", "review"); writeFileSync(reviewFile, "");
    const recovery = blocks.find((b) => b.includes("op_reviewed_rewritten_head")); assert.ok(recovery);
    const inputs = { ...values, op_child_git_dir: git(path, "rev-parse", "--absolute-git-dir"), op_reviewed_rewritten_head: rewritten, op_restack_review_file: reviewFile };
    const prepared = recipe(path, recovery, inputs); assert.notEqual(prepared.status, 0);
    assert.equal(git(path, "rev-parse", "refs/heads/child"), child);
    assert.equal(git(path, "rev-parse", "HEAD"), rewritten);
    assert.notEqual(spawnSync("git", ["symbolic-ref", "HEAD"], { cwd: path, env }).status, 0);
    const approved = prepared.stderr.match(/^expected=(reviewed-changed-contribution.+)$/m)?.[1]; assert.ok(approved);
    writeFileSync(reviewFile, approved + "\n");
    const complete = recipe(path, recovery, inputs); assert.equal(complete.status, 0, complete.stderr);
    assert.equal(git(path, "rev-parse", "refs/heads/child"), rewritten); assert.equal(git(path, "status", "--porcelain"), "");
    assert.equal(git(path, "symbolic-ref", "HEAD"), "refs/heads/child");
  });

  it("binds effective attributes and driver settings while retaining same-size raw blob changes", () => {
    const path = repo(); const base = commit(path, "file", "old\n"); const first = commit(path, "file", "one\n"); const second = commit(path, "file", "two\n");
    const plain = exactPatch(path, base, first); const plainInputs = readFileSync(join(scratch, "diff-inputs"));
    writeFileSync(join(path, ".git", "info", "attributes"), "file -diff\n");
    const binary = exactPatch(path, base, first); const binaryInputs = readFileSync(join(scratch, "diff-inputs"));
    assert.notDeepEqual(plainInputs, binaryInputs); assert.notEqual(plain, binary);
    assert.match(binary, /GIT binary patch/); assert.notEqual(binary, exactPatch(path, base, second));
    git(path, "config", "diff.fixture.binary", "true");
    exactPatch(path, base, first); assert.match(readFileSync(join(scratch, "diff-inputs"), "utf8"), /diff.fixture.binary/);
  });

  it("uses identical real jq parsers and rejects incomplete or incorrectly typed records", () => {
    const filters = [...shipping.matchAll(/--jq '(.*?)'/g)].map((m) => m[1]).filter((s) => s.includes("$r.pullRequest"));
    assert.ok(filters.length >= 7); assert.equal(new Set(filters).size, 1);
    const f = forgeFixture();
    for (const invalid of [{ omit: ["mergeQueueEntry"] }, { omit: ["autoMergeRequest"] }, { fields: { isDraft: "false" } }, { fields: { number: "12" } }, { fields: { headRepository: null } }, { fields: { mergeQueueEntry: {} } }, { fields: { autoMergeRequest: {} } }, { fields: { state: "ALIEN" } }]) {
      changeForge(f.stateFile, { fields: {}, omit: [], ...invalid });
      const result = recipe(f.path, command("op_remote_head=$(git ls-remote"), { ...f.values, op_local_pre_head: f.head });
      assert.notEqual(result.status, 0, JSON.stringify(invalid)); assert.match(result.stderr, /observed=INVALID/);
    }
    changeForge(f.stateFile, { fields: {}, omit: [] });
    assert.equal(recipe(f.path, command("op_remote_head=$(git ls-remote"), { ...f.values, op_local_pre_head: f.head }).status, 0);
  });

  for (const values of [{ op_host: "other.invalid" }, { op_owner: "../other" }, { op_name: "../other" }, { op_pr: "0" }, { op_comment_id: "00" }, { op_comment_id: "--admin" }, {}]) it(`guards selected reviewer reply ${JSON.stringify(values)}`, () => {
    const f = forgeFixture(); const payload = join(f.path, ".git", "reply.json"); writeFileSync(payload, JSON.stringify({ body: "literal $(data)" }));
    const block = blocks.find((b) => b.includes('/replies')); assert.ok(block);
    const result = recipe(f.path, block, { ...f.values, op_comment_id: "43", op_payload_file: payload, ...values });
    const valid = Object.keys(values).length === 0;
    assert.equal(result.status === 0, valid, result.stderr); assert.equal(forgeCalls(f.stateFile).length, valid ? 1 : 0);
  });

  for (const prefix of ["op_remote_head=$(git ls-remote", 'git push "', 'if _push_output=$(git push --porcelain', 'op_created_url=$(', 'GH_HOST="${op_host:?}" gh pr edit ', 'if test "$_draft" = true;', '_operation=reconcile', '_operation=withdraw', 'GH_HOST="${op_host:?}" gh pr merge ']) it(`retains mismatch evidence at ${prefix}`, () => {
    const f = forgeFixture();
    if (prefix.startsWith('if _push_output')) git(f.path, "switch", "-c", "new");
    writeFileSync(f.values.op_body_file, "literal\n");
    const result = recipe(f.path, command(prefix), { ...f.values, op_branch: prefix.startsWith('if _push_output') ? "new" : "main", op_local_pre_head: f.head, op_remote_head: f.head, op_target_base: "main", op_target_base_sha: f.head, op_title: "Title", FORGE_MODE: "mismatch" });
    assert.notEqual(result.status, 0);
    for (const field of ["expected=", "observed=", "started=", "ended=", "status=", "operation="]) assert.ok(result.stderr.includes(field), `${prefix}: ${field}`);
    assert.ok(result.stderr.includes("0".repeat(40)));
  });

  it("observes both pending modes in the read-only reconciliation block", () => {
    const f = forgeFixture(); changeForge(f.stateFile, { auto: true, queue: true });
    const result = recipe(f.path, command('_operation=reconcile'), f.values);
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /OPEN\ttrue\ttrue/);
    assert.equal(forgeCalls(f.stateFile).length, 1);
  });
});

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
    git(path, "checkout", "child");
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
    const remote = join(path, ".git", "remote.git");
    git(path, "clone", "-q", "--bare", path, remote);
    transport(path, remote);
    git(path, "checkout", "-q", "main");
    git(path, "merge", "--squash", "parent");
    git(path, "commit", "-qm", "squash");
    const values = { op_new_base: git(path, "rev-parse", "HEAD"), op_old_parent_tip: oldParent, op_old_child_tip: oldChild, op_branch: "child" };
    git(path, "checkout", "child");
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
    const remote = join(path, ".git", "remote.git");
    git(path, "clone", "-q", "--bare", path, remote);
    transport(path, remote);
    git(path, "fetch", "-q", "origin");
    const writer = join(scratch, "fetch-writer");
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

  it("binds literal-body merge commands to the explicit host and repository", () => {
    const f = forgeFixture(); const body = 'Review body\nLiteral $(not-a-command) and `also data`\nTrailing spaces stay literal  \n';
    changeForge(f.stateFile, { body });
    const merge = command('GH_HOST="${op_host:?}" gh pr merge ');
    const result = recipe(f.path, merge, { ...f.values, GH_HOST: "wrong.invalid", op_repo: "wrong.invalid/elsewhere/other" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(f.values.op_body_file, "utf8"), body + "\n");
    const calls = forgeCalls(f.stateFile);
    assert.ok(calls.every((c) => c.host === "github.com"));
    const submit = calls.find((c) => c.args[1] === "merge"); assert.ok(submit);
    assert.equal(submit.args[submit.args.indexOf("--repo") + 1], "fixture/intended");
    assert.ok(submit.args.includes(f.head)); assert.ok(submit.args.includes(f.values.op_body_file));
    writeFileSync(f.stateFile + ".calls", "");
    assert.notEqual(recipe(f.path, merge, { ...f.values, op_pr: "--admin" }).status, 0);
    assert.deepEqual(forgeCalls(f.stateFile), []);
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
    assert.match(readFileSync(join(directory, "babysit.md"), "utf8"), /complete Guarded operations Reply block/);
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
    const first = recipe(path, command("if _push_output=$(git push --porcelain "), { op_branch: "main" });
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
      for (const prefix of ['printf \'%s\\n\' "${op_fetch_url', "op_remote_head=$(git ls-remote", "git fetch ", 'git push "', "if _push_output=$(git push --porcelain "]) {
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
    const initial = command("if _push_output=$(git push --porcelain ");
    const values = { op_branch: "new-branch" };
    assert.equal(recipe(path, initial, values).status, 0);
    assert.equal(git(remote, "for-each-ref", "--format=%(refname)", "refs/tags"), "");
    assert.notEqual(recipe(path, initial, values).status, 0, "an existing same-tip ref is not an owned creation");
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
    const newBase = git(path, "rev-parse", "HEAD");
    git(path, "checkout", "child");
    const result = recipe(path, command("git rebase --onto "), { op_new_base: newBase, op_old_parent_tip: base, op_old_child_tip: child, op_branch: "child" });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /Original child commits: 1/);
    assert.match(result.stdout, /Rewritten child commits: 0/);
    assert.equal(git(path, "rev-parse", "refs/heads/child"), child, "refused restack must preserve the owned ref");
  });

  it("reads actual contribution objects despite replacement refs", () => {
    const path = repo();
    const base = commit(path, "app.mjs", 'console.log("base");\n');
    const good = commit(path, "app.mjs", 'console.log("good");\n');
    const previous = exactPatch(path, base, good);
    git(path, "checkout", "-qb", "bad", base);
    const bad = commit(path, "app.mjs", 'console.log("bad");\n');
    const actual = exactPatch(path, base, bad);
    git(path, "replace", bad, good);
    assert.equal(execFileSync(process.execPath, ["app.mjs"], { cwd: path, encoding: "utf8" }), "bad\n");
    assert.notEqual(exactPatch(path, base, bad), previous);
    assert.equal(exactPatch(path, base, bad), actual);
  });

  for (const branch of ["--exec=", "--no-verify", "-leading", "@{-1}"]) it(`refuses literal restack branch ${branch} without changing any ref or running an option`, () => {
    const path = repo();
    const base = commit(path, "base", "base\n");
    git(path, "checkout", "-qb", "child");
    const child = commit(path, "child", "contribution\n");
    git(path, "checkout", "main");
    const newBase = commit(path, "advance", "advance\n");
    git(path, "checkout", "-qb", "decoy", child);
    commit(path, "decoy", "decoy\n");
    const marker = join(path, ".git", "marker");
    const script = join(path, "marker-script");
    writeFileSync(script, `#!/bin/sh\nprintf marker > '${marker}'\n`); chmodSync(script, 0o755);
    const hookMarker = join(path, ".git", "hook-marker");
    if (branch === "--no-verify") {
      const hook = join(path, ".git", "hooks", "pre-rebase");
      writeFileSync(hook, `#!/bin/sh\nprintf hook > '${hookMarker}'\nexit 1\n`); chmodSync(hook, 0o755);
    }
    const name = branch === "--exec=" ? branch + script : branch;
    if (branch !== "@{-1}") git(path, "update-ref", `refs/heads/${name}`, child);
    const beforeRefs = git(path, "for-each-ref", "--format=%(refname) %(objectname)");
    const result = recipe(path, command("git rebase --onto "), { op_branch: name, op_old_parent_tip: base, op_old_child_tip: child, op_new_base: newBase });
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(marker), false);
    assert.equal(git(path, "for-each-ref", "--format=%(refname) %(objectname)"), beforeRefs);
  });

  it("does not trust a Git transport result when the canonical forge read fails", () => {
    const path = repo();
    const old = commit(path, "file", "old\n");
    const remote = join(path, "remote.git"); git(path, "clone", "-q", "--bare", path, remote); transport(path, remote);
    const bin = join(path, ".git", "failed-gh"); mkdirSync(bin);
    writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 73\n"); chmodSync(join(bin, "gh"), 0o755);
    const capture = recipe(path, command("op_remote_head=$(git ls-remote"), { op_branch: "main", op_local_pre_head: old, PATH: `${bin}:${env.PATH}` });
    assert.notEqual(capture.status, 0, "capture must require a complete actual canonical forge response");
    commit(path, "file", "new\n");
    const pushed = recipe(path, command('git push "'), { op_branch: "main", op_remote_head: old, PATH: `${bin}:${env.PATH}` });
    assert.notEqual(pushed.status, 0, "a successful write without a forge readback must stop progression");
    assert.equal(git(remote, "rev-parse", "main"), git(path, "rev-parse", "HEAD"), "postcondition failure does not undo an actual write");
  });

  for (const mode of ["hook", "conflict", "merge"]) it(`preserves all branch tips on refused ${mode} restack`, () => {
    const path = repo();
    const base = commit(path, "shared", "base\n");
    git(path, "checkout", "-qb", "child");
    const child = commit(path, mode === "conflict" ? "shared" : "own", "child\n");
    git(path, "checkout", "main");
    const newBase = commit(path, mode === "conflict" ? "shared" : "advance", "new base\n");
    let oldChild = child;
    if (mode === "merge") {
      git(path, "checkout", "child");
      git(path, "merge", "--no-ff", "-m", "resolution", "main");
      oldChild = git(path, "rev-parse", "HEAD");
    }
    const marker = join(path, ".git", "hook-ran");
    if (mode === "hook") {
      const hook = join(path, ".git", "hooks", "pre-rebase");
      writeFileSync(hook, `#!/bin/sh\nprintf yes > '${marker}'\nexit 1\n`); chmodSync(hook, 0o755);
    }
    git(path, "checkout", "child");
    const beforeRefs = git(path, "for-each-ref", "--format=%(refname) %(objectname)");
    const result = recipe(path, command("git rebase --onto "), { op_branch: "child", op_old_parent_tip: base, op_old_child_tip: oldChild, op_new_base: newBase });
    assert.notEqual(result.status, 0);
    assert.equal(git(path, "for-each-ref", "--format=%(refname) %(objectname)"), beforeRefs);
    if (mode === "hook") assert.equal(existsSync(marker), true, "the real hook must run");
  });

  for (const child of [false, true]) it(`ignores replacements while replaying the ${child ? "child" : "independent"} raw contribution`, () => {
    const path = repo();
    const base = commit(path, "base", "base\n");
    git(path, "checkout", "-qb", "owned");
    const oldChild = commit(path, "own", "raw contribution\n");
    git(path, "checkout", "main");
    const newBase = commit(path, "advance", "new base\n");
    git(path, "checkout", "owned");
    git(path, "replace", oldChild, base);
    const result = recipe(path, command(child ? "git rebase --onto " : 'git rebase "'), { op_branch: "owned", op_old_parent_tip: base, op_old_child_tip: oldChild, op_new_base: newBase });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(git(path, "--no-replace-objects", "show", "refs/heads/owned:own"), "raw contribution");
    assert.equal(git(path, "--no-replace-objects", "rev-list", "--count", `${newBase}..refs/heads/owned`), "1");
  });

  it("rejects an option-shaped PR number before a later publication writes", () => {
    const path = repo(); const old = commit(path, "file", "old\n");
    const remote = join(path, ".git", "remote.git"); git(path, "clone", "-q", "--bare", path, remote); transport(path, remote);
    commit(path, "file", "new\n");
    const result = recipe(path, command('git push "'), { op_branch: "main", op_remote_head: old, op_pr: "--admin" });
    assert.notEqual(result.status, 0);
    assert.equal(git(remote, "rev-parse", "refs/heads/main"), old);
    assert.equal(existsSync(join(path, ".git", "fixture.json.calls")), false);
  });

  it("selects the exact remote ref rather than a matching tail", () => {
    const path = repo();
    const old = commit(path, "file", "old\n");
    const remote = join(path, "remote.git"); git(path, "clone", "-q", "--bare", path, remote); transport(path, remote);
    git(path, "checkout", "-qb", "z");
    git(remote, "update-ref", "refs/heads/a/refs/heads/z", old);
    const result = recipe(path, command("op_remote_head=$(git ls-remote"), { op_branch: "z", op_local_pre_head: old });
    assert.notEqual(result.status, 0, "a suffix lookalike does not establish the absent exact ref");
  });

  it("accepts the full owned symbolic ref even when a tag shares its short name", () => {
    const path = repo();
    const old = commit(path, "file", "old\n");
    const remote = join(path, "remote.git"); git(path, "clone", "-q", "--bare", path, remote); transport(path, remote);
    git(path, "tag", "main");
    const capture = recipe(path, command("op_remote_head=$(git ls-remote"), { op_branch: "main", op_local_pre_head: old });
    assert.equal(capture.status, 0, capture.stderr);
    assert.equal(capture.stdout.trim(), old);
  });

  it("uses one identical transport boundary in all five operations", () => {
    const guards = blocks.filter((b) => b.includes("git remote get-url")).map((b) => b.slice(b.indexOf('test "${op_host'), b.indexOf("\ndone") + 5));
    assert.equal(guards.length, 5);
    assert.equal(new Set(guards).size, 1);
  });

  it("requires literal full object IDs for exact contribution evidence", () => {
    const path = repo(); const base = commit(path, "file", "old\n"); commit(path, "file", "new\n");
    const result = recipe(path, command(': "${op_patch_base:?}"'), { op_patch_base: base, op_patch_head: "HEAD" });
    assert.notEqual(result.status, 0);
  });

  for (const failure of ["patch", "concurrent-ref"]) it(`keeps the owned restack ref safe on ${failure} refusal`, () => {
    const path = repo(); const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const base = commit(path, "file", lines); git(path, "checkout", "-qb", "child");
    const child = commit(path, "file", lines.replace("line 19", "child")); git(path, "checkout", "main");
    const newBase = failure === "patch" ? commit(path, "file", lines.replace("line 0", "base drift")) : commit(path, "advance", "advance\n");
    if (failure === "concurrent-ref") {
      const hook = join(path, ".git", "hooks", "post-rewrite");
      writeFileSync(hook, `#!/bin/sh\ngit update-ref refs/heads/child ${base} ${child}\n`); chmodSync(hook, 0o755);
    }
    git(path, "checkout", "child");
    const result = recipe(path, command("git rebase --onto "), { op_branch: "child", op_old_parent_tip: base, op_old_child_tip: child, op_new_base: newBase });
    assert.notEqual(result.status, 0);
    assert.equal(git(path, "rev-parse", "refs/heads/child"), failure === "patch" ? child : base);
    assert.equal(git(path, "rev-parse", "refs/heads/main"), newBase);
    assert.match(result.stdout, /Rewritten child commits: 1/);
    const directory = result.stdout.match(/Contribution receipts: (.+)/)?.[1]; assert.ok(directory);
    assert.ok(existsSync(join(directory, "original.patch"))); assert.ok(existsSync(join(directory, "rewritten.patch")));
    if (failure === "patch") assert.notEqual(readFileSync(join(directory, "original.patch"), "utf8"), readFileSync(join(directory, "rewritten.patch"), "utf8"));
    assert.notEqual(spawnSync("git", ["symbolic-ref", "HEAD"], { cwd: path, env }).status, 0, "failed detached work remains available");
  });

  for (const baseUrl of ["https://github.com/Fixture/Intended", "git@github.com:fixture/intended", "ssh://git@github.com/fixture/intended"]) for (const suffix of ["", ".git"]) it(`runs all five transport operations through ${baseUrl}${suffix}`, () => {
    const path = repo();
    const old = commit(path, "file", "old\n");
    const remote = join(path, ".git", "remote.git"); git(path, "clone", "-q", "--bare", path, remote);
    transport(path, remote, baseUrl + suffix);
    const resolved = recipe(path, command('printf \'%s\\n\' "${op_fetch_url'), {});
    assert.equal(resolved.status, 0, resolved.stderr);
    assert.equal(resolved.stdout, `${baseUrl}${suffix}\n${baseUrl}${suffix}\n`);
    const captured = recipe(path, command("op_remote_head=$(git ls-remote"), { op_branch: "main", op_local_pre_head: old });
    assert.equal(captured.status, 0, captured.stderr); assert.equal(captured.stdout.trim(), old);
    const fetched = recipe(path, command("git fetch "), { op_selected_ref: "main", op_selected_sha: old });
    assert.equal(fetched.status, 0, fetched.stderr); assert.equal(fetched.stdout.trim(), old);
    const next = commit(path, "file", "next\n");
    const later = recipe(path, command('git push "'), { op_branch: "main", op_remote_head: captured.stdout.trim() });
    assert.equal(later.status, 0, later.stderr); assert.equal(git(remote, "rev-parse", "refs/heads/main"), next);
    git(path, "checkout", "-qb", "new"); const firstHead = commit(path, "own", "own\n");
    const first = recipe(path, command("if _push_output=$(git push --porcelain "), { op_branch: "new" });
    assert.equal(first.status, 0, first.stderr); assert.equal(git(remote, "rev-parse", "refs/heads/new"), firstHead);
    assert.match(readFileSync(join(path, ".git", "push.receipt"), "utf8"), /\*\trefs\/heads\/new:refs\/heads\/new\t/);
  });

  for (const first of [false, true]) for (const mode of ["fail", "missing", "mismatch"]) it(`stops ${first ? "creation" : "later publication"} after ${mode} canonical readback without claiming an undo`, () => {
    const path = repo(); const old = commit(path, "file", "old\n");
    const remote = join(path, ".git", "remote.git"); git(path, "clone", "-q", "--bare", path, remote); transport(path, remote);
    if (first) git(path, "checkout", "-qb", "new");
    const next = commit(path, "file", "next\n");
    const branch = first ? "new" : "main";
    const result = recipe(path, command(first ? "if _push_output=$(git push --porcelain " : 'git push "'), { op_branch: branch, op_remote_head: old, FORGE_MODE: mode });
    assert.notEqual(result.status, 0);
    assert.equal(git(remote, "rev-parse", `refs/heads/${branch}`), next);
  });

  it("rejects capture from a transport pointing at a distinct canonical repository head", () => {
    const path = repo(); const old = commit(path, "file", "old\n");
    const actual = join(path, ".git", "actual.git"), canonical = join(path, ".git", "canonical.git");
    git(path, "clone", "-q", "--bare", path, actual); transport(path, actual);
    const next = commit(path, "file", "canonical\n"); git(path, "clone", "-q", "--bare", path, canonical);
    git(path, "checkout", "-qb", "old", old); git(actual, "update-ref", "refs/heads/old", old); git(canonical, "update-ref", "refs/heads/old", next);
    const result = recipe(path, command("op_remote_head=$(git ls-remote"), { op_branch: "old", op_local_pre_head: old, FORGE_REMOTE: canonical });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /Canonical PR identity mismatch/);
    assert.equal(git(actual, "rev-parse", "refs/heads/old"), old); assert.equal(git(canonical, "rev-parse", "refs/heads/old"), next);
  });

  for (const verb of ["create", "edit", "ready"]) it(`routes actual guarded gh ${verb} argv and readbacks through the derived repository`, () => {
    const path = repo(); const head = commit(path, "file", "head\n");
    const remote = join(path, ".git", "remote.git"); git(path, "clone", "-q", "--bare", path, remote); transport(path, remote);
    git(remote, "update-ref", "refs/heads/target", head);
    const stateFile = join(path, ".git", "fixture.json");
    if (verb === "ready") { const state = JSON.parse(readFileSync(stateFile, "utf8")); state.draft = true; writeFileSync(stateFile, JSON.stringify(state)); }
    const body = join(path, ".git", "body"); writeFileSync(body, "literal body\n");
    const block = blocks.find((b) => b.includes(`gh pr ${verb} `)); assert.ok(block);
    const values = { op_branch: "main", op_published_head: head, op_target_base: "target", op_target_base_sha: head, op_title: "Literal title", op_body_file: body, op_repo: "wrong.invalid/other/repo", GH_REPO: "wrong.invalid/other/repo", GH_HOST: "wrong.invalid" };
    const result = recipe(path, block, values); assert.equal(result.status, 0, result.stderr);
    const calls = readFileSync(stateFile + ".calls", "utf8").trim().split("\n").map((s) => JSON.parse(s));
    const mutations = calls.filter((c) => c.args[0] === "pr"); assert.equal(mutations.length, 1);
    const args = mutations[0].args; assert.equal(args[args.indexOf("--repo") + 1], "fixture/intended");
    assert.ok(calls.every((c) => c.host === "github.com")); assert.equal(calls.filter((c) => c.args[0] === "api").length, 2);
    const after = JSON.parse(readFileSync(stateFile, "utf8")); assert.equal(after.draft, false);
    if (verb === "edit") assert.equal(after.baseRef, "target");
    writeFileSync(stateFile + ".calls", "");
    const refused = recipe(path, block, { ...values, FORGE_MODE: "mismatch" }); assert.notEqual(refused.status, 0);
    assert.ok(readFileSync(stateFile + ".calls", "utf8").trim().split("\n").map((s) => JSON.parse(s)).every((c) => c.args[0] === "api"));
  });

  it("ships complete guarded create, retarget and ready mutations", () => {
    for (const verb of ["create", "edit", "ready"]) assert.ok(blocks.some((b) => b.includes(`gh pr ${verb} `)), verb);
  });

  it("states the bounded capture recovery, Git floor and trusted transport inputs", () => {
    assert.match(shipping, /Git 2\.38/);
    assert.match(shipping, /missed capture stops publication/);
    assert.match(shipping, /SSH host authentication, TLS, custom transport programs and enabled hooks remain trusted/);
    for (const block of blocks.filter((b) => /git (rebase|merge-base|rev-parse|rev-list)|core.quotePath|FETCH_HEAD/.test(b))) assert.match(block, /export GIT_NO_REPLACE_OBJECTS=1 GIT_GRAFT_FILE=\/dev\/null/);
    const stack = readFileSync(join(PLUGIN_ROOT, "skills/poteto-mode/playbooks/autopilot-stack.md"), "utf8");
    assert.match(stack.split("\n").find((s) => s.startsWith("1. ")) ?? "", /First publication/);
    assert.match(stack.split("\n").find((s) => s.startsWith("7. ")) ?? "", /later-wave/);
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
      assert.match(text, /Compare the watcher's owner, repository and PR number/);
      assert.match(text, /after each wake.*Guarded identity query.*compare head, base, queue and auto-merge/);
    }
  });

  it("routes supported Shipping and preserves the operator's separate manual path", () => {
    const router = readFileSync(join(PLUGIN_ROOT, "skills/poteto-mode/SKILL.md"), "utf8").split("\n").find((line) => line.startsWith("- **Shipping."));
    assert.doesNotMatch(router ?? "", /Origin when/);
    assert.match(readFileSync(join(PLUGIN_ROOT, "docs/reference.md"), "utf8"), /Sua revisão e seu clique não dependem de um Veredito/);
  });
});
