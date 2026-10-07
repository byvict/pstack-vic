import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedFiles, classify, source, type Registry } from "./core.ts";
import { Journal } from "./io.ts";
import { artifactManifest, verify } from "./verify.ts";
import { assertInnerEvents, innerProbeScript } from "./recipes.ts";

const registry: Registry = { runtime: { runner: ["runner/**"], instructions: ["skills/**"] }, nonRuntime: ["CHANGES.md", "skills/example/README.md"] };

test("runtime Markdown takes precedence; renaming it into docs cannot evade ownership", () => {
  assert.deepEqual(classify([{ filename: "CHANGES.md" }], registry), { paths: ["CHANGES.md"], areas: [], noRuntime: true });
  assert.equal(classify([{ filename: "skills/example/README.md" }], registry).noRuntime, false);
  const change = changedFiles("R100\0runner/entry.ts\0CHANGES.md\0");
  assert.deepEqual(classify(change, registry).areas, ["runner"]);
  assert.throws(() => classify([{ filename: "surprise.ts" }], registry), /Unmapped/);
  assert.throws(() => changedFiles("R100\0old\0"), /Truncated/);
});

test("source proof binds commit, untracked inputs and contents; dirty source cannot claim a commit", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pstack-verifier-source-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = join(root, "repo"), output = join(root, "proof");
  mkdirSync(repository); mkdirSync(output);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repository, encoding: "utf8" });
  git("init", "-q");
  writeFileSync(join(repository, "CHANGES.md"), "first");
  mkdirSync(join(repository, "scripts/verify"), { recursive: true });
  writeFileSync(join(repository, "scripts/verify/registry.json"), JSON.stringify(registry));
  git("add", "."); git("-c", "user.name=Verifier", "-c", "user.email=verifier@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  const journal = new Journal(output);
  const clean = await source(journal, repository, "HEAD", "HEAD", false);
  writeFileSync(join(repository, "untracked.md"), "new");
  await assert.rejects(source(journal, repository, "HEAD", "HEAD", false), /dirty/);
  const dirty = await source(journal, repository, "HEAD", "HEAD", true);
  assert.equal(dirty.kind, "working-tree");
  assert.notEqual(clean.digest, dirty.digest);
  assert.ok(dirty.changed.some((file) => file.filename === "untracked.md"));
  rmSync(join(repository, "untracked.md"));
  const run = await verify({ repository, output: join(root, "complete"), base: "HEAD", head: "HEAD", workingTree: false, features: [], routes: [] });
  assert.equal(run.status, "complete");
  assert.equal(JSON.parse(readFileSync(run.path, "utf8")).source.digest, clean.digest);
  assert.ok(JSON.parse(readFileSync(run.path, "utf8")).artifacts.some((file: { path: string }) => file.path.endsWith("command.json")));
  writeFileSync(join(repository, "unknown.ts"), "new");
  const failed = await verify({ repository, output: join(root, "failed"), base: "HEAD", head: "HEAD", workingTree: true, features: [], routes: [] });
  assert.equal(failed.status, "failed");
  assert.match(JSON.parse(readFileSync(failed.path, "utf8")).error, /Unmapped/);
  rmSync(join(repository, "unknown.ts"));
  writeFileSync(join(repository, "scripts/verify/mutates.test.ts"), "import { test } from 'node:test'; import { writeFileSync } from 'node:fs'; test('mutation', () => writeFileSync('CHANGES.md', 'changed during exercise'));");
  git("add", "."); git("-c", "user.name=Verifier", "-c", "user.email=verifier@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "mutating fixture");
  const drifted = await verify({ repository, output: join(root, "drifted"), base: "HEAD", head: "HEAD", workingTree: true, features: ["verifier-contracts"], routes: [] });
  assert.equal(drifted.status, "failed");
  assert.match(JSON.parse(readFileSync(drifted.path, "utf8")).error, /Source changed/);
});

test("the inner probe proves real elapsed work and records prohibited extra invocations", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pstack-inner-method-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = join(root, "probe.cjs");
  writeFileSync(script, innerProbeScript(30));
  execFileSync(process.execPath, [script]);
  const events = () => readFileSync(join(root, "probe-events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(assertInnerEvents(events(), 30) >= 30);
  assert.throws(() => execFileSync(process.execPath, [script], { stdio: "pipe" }));
  assert.throws(() => assertInnerEvents(events(), 30), /exactly once/);
  assert.throws(() => assertInnerEvents([{ kind: "invoked", at: 0 }, { kind: "started", at: 0 }], 30), /did not survive/);
});

test("artifact hashes include empty streams and refuse links outside the evidence root", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pstack-artifacts-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "stderr"), "");
  assert.equal(artifactManifest(root)[0].sha256, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  symlinkSync(import.meta.filename, join(root, "external"));
  assert.throws(() => artifactManifest(root), /not links/);
});
