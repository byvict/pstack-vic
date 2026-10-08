import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMatrix } from "../../../scripts/model-matrix.ts";
import { buildPlan, loadState, pickLane, writeSheet, CODEX_BLOCK_BEGIN, CODEX_BLOCK_END } from "./setup-pstack.ts";

let root: string;
let home: string;
const matrix = loadMatrix();
const script = fileURLToPath(new URL("./setup-pstack.ts", import.meta.url));
const role = "trail reviewer pool";
const rowA = "grok:grok-4.7@high, codex:gpt-6.1-sol@max, claude:claude-opus-5-5@xhigh";
const rowB = "claude:fable@max, grok:grok-4.6@xhigh";
const sheet = (row: string) => `${role}: ${row}\n`;
const block = (row: string) => `${CODEX_BLOCK_BEGIN}\n${sheet(row)}${CODEX_BLOCK_END}\n`;

function put(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

function project(name: string, row?: string): string {
  const directory = join(root, name);
  mkdirSync(join(directory, ".git"), { recursive: true });
  put(join(directory, "AGENTS.md"), row === undefined ? "Repository instructions\n" : block(row));
  if (row !== undefined) put(join(directory, ".codex/pstack-models.md"), sheet(row));
  return directory;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pstack-project-source-")));
  home = join(root, "home");
  mkdirSync(home);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("Codex project model sources", () => {
  it("selects different descriptors in two projects through the public CLI without changing any configuration", () => {
    const global = put(join(home, ".codex/pstack-models.md"), sheet(rowB));
    const config = put(join(home, ".codex/config.toml"), 'model = "personal-model"\n');
    const a = project("a", rowA);
    const b = project("b", rowB);
    const files = [global, config, ...[a, b].flatMap((p) => [join(p, "AGENTS.md"), join(p, ".codex/pstack-models.md")])];
    const before = files.map((path) => readFileSync(path));
    for (const [cwd, descriptor, provider, model, effort] of [
      [a, "grok:grok-4.7@high", "grok", "grok-4.7", "high"],
      [b, "claude:fable@max", "claude", "fable", "max"],
    ]) {
      const result = spawnSync(process.execPath, [script, "pick", "--parent", "codex", "--home", home, "--role", role], {
        cwd, env: { ...process.env, CODEX_HOME: "" }, encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      const pick = JSON.parse(result.stdout);
      assert.deepEqual(pick.chosen, { descriptor, provider, model, effort, route: "runner" });
      assert.deepEqual(pick.configurationSource, { kind: "sheet", path: join(cwd, ".codex/pstack-models.md") });
      assert.equal(pick.integrationPath, join(cwd, "AGENTS.md"));
      assert.deepEqual(pick.executors, ["codex"]);
    }
    assert.deepEqual(files.map((path) => readFileSync(path)), before);
  });

  it("uses the nearest project source, then CODEX_HOME, then defaults; missing rows use matrix defaults", () => {
    const cwd = project("a", rowA);
    const nested = join(cwd, "packages/api");
    mkdirSync(nested, { recursive: true });
    const customHome = join(root, "custom profile");
    const global = put(join(customHome, "pstack-models.md"), sheet(rowB));
    const env = { CODEX_HOME: customHome };
    assert.equal(pickLane({ parent: "codex", home, cwd: nested, env, role }).chosen?.descriptor, "grok:grok-4.7@high");
    put(join(nested, "AGENTS.override.md"), block(rowB));
    assert.equal(pickLane({ parent: "codex", home, cwd: nested, env, role }).chosen?.descriptor, "claude:fable@max");
    rmSync(join(nested, "AGENTS.override.md"));
    rmSync(join(cwd, ".codex"), { recursive: true });
    put(join(cwd, "AGENTS.md"), "Repository instructions\n");
    assert.equal(pickLane({ parent: "codex", home, cwd: nested, env, role }).configurationSource.kind, "sheet");
    assert.equal(pickLane({ parent: "codex", home, cwd: nested, env, role }).sheetPath, global);
    put(join(cwd, ".codex/pstack-models.md"), "bug-fix: codex:gpt-6.1-sol@high\n");
    assert.equal(pickLane({ parent: "codex", home, cwd, env, role }).source, "default");
    assert.equal(pickLane({ parent: "codex", home, cwd, env, role }).chosen?.descriptor, "claude:claude-opus-5-5@xhigh");
    rmSync(join(cwd, ".codex"), { recursive: true });
    rmSync(global);
    assert.equal(pickLane({ parent: "codex", home, cwd, env, role }).configurationSource.kind, "first-run");
  });

  it("honors instruction overrides and an explicitly supplied runtime chain", () => {
    const cwd = project("a");
    put(join(cwd, "AGENTS.md"), block(rowA));
    const override = put(join(cwd, "AGENTS.override.md"), block(rowB));
    assert.equal(pickLane({ parent: "codex", home, cwd, role }).chosen?.descriptor, "claude:fable@max");
    const alternate = put(join(cwd, "TEAM.md"), block(rowA));
    assert.equal(pickLane({ parent: "codex", home, cwd, instructionSources: [alternate], role }).chosen?.descriptor, "grok:grok-4.7@high");
    const global = put(join(home, ".codex/AGENTS.override.md"), block(rowB));
    assert.equal(pickLane({ parent: "codex", home, cwd, instructionSources: [global], role }).integrationPath, global);
    assert.throws(() => loadState({ parent: "codex", home, cwd, instructionSources: [join(cwd, "missing.md")] }), /does not exist/);
    assert.equal(readFileSync(override, "utf8"), block(rowB));
  });

  it("an empty project override hides AGENTS.md, while an empty global override falls through", () => {
    const cwd = project("a");
    put(join(cwd, "AGENTS.md"), block(rowA));
    put(join(cwd, "AGENTS.override.md"), "");
    const global = put(join(home, ".codex/AGENTS.md"), block(rowB));
    put(join(home, ".codex/AGENTS.override.md"), "");
    const pick = pickLane({ parent: "codex", home, cwd, role });
    assert.equal(pick.chosen?.descriptor, "claude:fable@max");
    assert.deepEqual(pick.configurationSource, { kind: "block", path: global });
  });

  it("an explicit source-less chain does not recover or rewrite excluded global configuration", () => {
    const cwd = project("a");
    const global = put(join(home, ".codex/pstack-models.md"), sheet(rowA));
    const plain = put(join(cwd, "TEAM.md"), "Repository instructions\n");
    const pick = pickLane({ parent: "codex", home, cwd, instructionSources: [plain], role });
    assert.equal(pick.source, "default");
    assert.deepEqual(pick.configurationSource, { kind: "first-run" });
    assert.equal(pick.chosen?.descriptor, "claude:claude-opus-5-5@xhigh");
    assert.equal(buildPlan({ parent: "codex", home, cwd, instructionSources: [plain] }).integrationPath, plain);
    const empty = buildPlan({ parent: "codex", home, cwd, instructionSources: [] });
    assert.throws(() => writeSheet(empty, join(root, "run"), { home }), /without a loaded instruction source/);
    assert.equal(readFileSync(global, "utf8"), sheet(rowA));
    const result = spawnSync(process.execPath, [script, "pick", "--parent", "codex", "--home", home, "--role", role, "--no-instruction-sources"], {
      cwd, env: { ...process.env, CODEX_HOME: "" }, encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).source, "default");
  });

  it("does not inspect malformed excluded broader instruction files", () => {
    const cwd = project("a", rowA);
    mkdirSync(join(home, ".codex/AGENTS.md"), { recursive: true });
    assert.equal(pickLane({ parent: "codex", home, cwd, role }).chosen?.descriptor, "grok:grok-4.7@high");
    assert.equal(pickLane({ parent: "codex", home, cwd, instructionSources: [join(cwd, "AGENTS.md")], role }).chosen?.descriptor, "grok:grok-4.7@high");
  });

  it("refuses a conflicting mirror or a missing explicit reference instead of falling back", () => {
    const cwd = project("a", rowA);
    put(join(cwd, "AGENTS.md"), block(rowB));
    assert.throws(() => pickLane({ parent: "codex", home, cwd, role }), /assign different lanes/);
    put(join(cwd, "AGENTS.md"), "pstack-models: .codex/missing.md\n");
    assert.throws(() => pickLane({ parent: "codex", home, cwd, role }), /references missing model sheet/);
  });

  it("keeps project aliases, per-lane efforts and Arena exclusions while ignoring reference examples", () => {
    const cwd = project("a");
    put(join(cwd, "AGENTS.md"), "```text\npstack-models: missing.md\n```\n" + block("inherit-parent, codex:gpt-6.1-sol@max, grok:grok-4.7@high, claude:fable@max"));
    const pick = pickLane({ parent: "codex", home, cwd, role, executors: ["grok", "claude"] });
    assert.equal(pick.chosen?.descriptor, "grok:grok-4.7@high");
    assert.deepEqual(pick.eligible.map((lane) => lane.effort), ["high", "max"]);
    assert.equal(pick.skipped.length, 2);
    assert.equal(pick.skipped[0].lane, "inherit-parent");
    put(join(cwd, "AGENTS.md"), `${CODEX_BLOCK_BEGIN}\narena cross-judge pool: grok:grok-4.7@high, claude:fable@max\n${CODEX_BLOCK_END}\n`);
    const arena = pickLane({ parent: "codex", home, cwd, role: "arena cross-judge pool", executors: ["grok"] });
    assert.equal(arena.chosen?.descriptor, "claude:fable@max");
    assert.deepEqual(arena.executors, ["codex", "grok"]);
  });

  it("uses each real Git worktree's files and shares a relocated source only through an explicit instruction reference", () => {
    const main = join(root, "repository");
    mkdirSync(main);
    const git = (args: string[]) => execFileSync("git", args, { cwd: main, encoding: "utf8", stdio: "pipe" });
    git(["init", "--quiet"]);
    put(join(main, "AGENTS.md"), "Repository instructions\n");
    git(["add", "AGENTS.md"]);
    git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "fixture"]);
    const worktree = join(root, "worktree");
    git(["worktree", "add", "--detach", worktree]);
    const source = put(join(main, ".codex/pstack-models.md"), sheet(rowA));
    assert.equal(pickLane({ parent: "codex", home, cwd: worktree, role }).source, "default");
    put(join(worktree, "AGENTS.md"), `pstack-models: <${source}>\n`);
    assert.equal(pickLane({ parent: "codex", home, cwd: worktree, role }).sheetPath, source);
    put(join(worktree, "AGENTS.md"), block(rowB));
    assert.equal(pickLane({ parent: "codex", home, cwd: worktree, role }).chosen?.descriptor, "claude:fable@max");
  });

  it("plans and writes back to the same project source, preserving choices and personal files", () => {
    const cwd = project("a", rowA);
    const personal = put(join(home, ".codex/pstack-models.md"), sheet(rowB));
    const state = loadState({ parent: "codex", home, cwd });
    const families = Object.fromEntries(matrix.families.map((family) => [
      `${family.provider}:${family.model}`,
      { family: family.family, descriptor: `${family.provider}:${family.model}@${family.defaultEffort}`, verifiedAt: "2026-10-08T00:00:00Z", evidence: "operator" },
    ]));
    put(state.ledgerPath, JSON.stringify({ schemaVersion: 1, families }));
    const plan = buildPlan({ parent: "codex", home, cwd });
    assert.deepEqual(plan.rows.find((row) => row.role === role)?.lanes, rowA.split(", "));
    assert.equal(plan.sheetPath, state.sheetPath);
    assert.equal(plan.ledgerPath, state.ledgerPath);
    assert.equal(plan.pairs.length, 0);
    const dir = join(root, "run");
    mkdirSync(dir);
    writeSheet(plan, dir, { home });
    assert.equal(readFileSync(personal, "utf8"), sheet(rowB));
    assert.equal(pickLane({ parent: "codex", home, cwd, role }).chosen?.descriptor, "grok:grok-4.7@high");
    assert.equal(writeSheet(plan, dir, { home }).sheet, "unchanged");
    assert.throws(() => writeSheet(plan, dir, { home, cwd: project("other", rowB) }), /was made for/);
  });
});
