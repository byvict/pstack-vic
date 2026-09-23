import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, isAbsolute, resolve } from "node:path";
import { PLUGIN_ROOT } from "./model-matrix.ts";

// Fase 7: the plugin is the repository root. Four manifests describe it (Claude
// plugin and marketplace, Codex plugin and marketplace). They must agree on name
// and version, point at files that exist, and pass Claude Code's own strict
// validator when the CLI is on PATH. Installation is by tag: the Claude
// marketplace entry pins `v<version>` and the tag must match the version everywhere.

const PLUGIN_NAME = "pstack";
const MARKETPLACE_NAME = "pstack-vic";

const readJson = (rel: string) => JSON.parse(readFileSync(join(PLUGIN_ROOT, rel), "utf8"));

const claudePlugin = readJson(".claude-plugin/plugin.json");
const claudeMarketplace = readJson(".claude-plugin/marketplace.json");
const codexPlugin = readJson(".codex-plugin/plugin.json");
const codexMarketplace = readJson(".agents/plugins/marketplace.json");
const pkg = readJson("package.json");

const version: string = claudePlugin.version;

function pluginRelative(path: string, field: string): string {
  assert.ok(typeof path === "string" && path.length > 0, `${field} is missing`);
  assert.ok(!isAbsolute(path), `${field} must be plugin-relative: ${path}`);
  const rel = path.replace(/^\.\//, "");
  assert.ok(!rel.split("/").includes(".."), `${field} escapes the plugin root: ${path}`);
  return rel;
}

function claudeCli(): string | null {
  const probe = spawnSync("claude", ["--version"], { encoding: "utf8" });
  return probe.status === 0 ? "claude" : null;
}

describe("plugin manifests", () => {
  it("share one plugin name and one version, and the Claude marketplace pins that version's tag", () => {
    assert.match(version, /^\d+\.\d+\.\d+$/);
    assert.equal(claudePlugin.name, PLUGIN_NAME);
    assert.equal(codexPlugin.name, PLUGIN_NAME);
    assert.equal(codexPlugin.version, version);
    assert.equal(pkg.version, version);

    assert.equal(claudeMarketplace.name, MARKETPLACE_NAME);
    assert.equal(codexMarketplace.name, MARKETPLACE_NAME);
    const claudeEntries = claudeMarketplace.plugins.filter((p: { name: string }) => p.name === PLUGIN_NAME);
    const codexEntries = codexMarketplace.plugins.filter((p: { name: string }) => p.name === PLUGIN_NAME);
    assert.equal(claudeEntries.length, 1, "Claude marketplace lists the plugin once");
    assert.equal(codexEntries.length, 1, "Codex marketplace lists the plugin once");
    assert.equal(claudeEntries[0].version, version);
    assert.deepEqual(claudeEntries[0].source, {
      source: "github",
      repo: claudePlugin.repository.replace(/^https:\/\/github\.com\//, ""),
      ref: `v${version}`,
    });
    assert.deepEqual(codexEntries[0].source, { source: "local", path: "./" });
  });

  it("documents the Codex install with the current tag in README.md and docs/reference.md", () => {
    // Fase 9: the 0.1.1 release left `--ref v0.1.0` in README.md; the docs name
    // the tag by hand, so they must follow the version like the manifests do.
    for (const rel of ["README.md", "docs/reference.md"]) {
      const refs = readFileSync(join(PLUGIN_ROOT, rel), "utf8").match(/--ref v\d+\.\d+\.\d+/g) ?? [];
      assert.ok(refs.length > 0, `${rel} shows the tagged Codex install`);
      for (const ref of refs) assert.equal(ref, `--ref v${version}`, `${rel} names the current tag`);
    }
  });

  it("keep the same homepage and repository across the Claude and Codex manifests", () => {
    assert.match(claudePlugin.repository, /^https:\/\/github\.com\/[^/]+\/[^/]+$/);
    assert.equal(claudePlugin.homepage, claudePlugin.repository);
    assert.equal(codexPlugin.homepage, claudePlugin.homepage);
    assert.equal(codexPlugin.repository, claudePlugin.repository);
    assert.equal(codexPlugin.interface.websiteURL, claudePlugin.homepage);
    assert.equal(claudeMarketplace.plugins[0].homepage, claudePlugin.homepage);
  });

  it("keep the Claude manifest to the fields Claude Code knows (skills and agents load from their default paths)", () => {
    const allowed = new Set(["name", "displayName", "version", "description", "author", "homepage", "repository", "license", "keywords"]);
    assert.deepEqual(Object.keys(claudePlugin).filter((k) => !allowed.has(k)), []);
    for (const dir of ["skills", "agents"]) assert.ok(statSync(join(PLUGIN_ROOT, dir)).isDirectory(), `${dir}/ exists`);
  });

  it("point the Codex manifest at the shared skills tree and a regular logo file", () => {
    const skills = pluginRelative(codexPlugin.skills, "skills");
    assert.ok(statSync(join(PLUGIN_ROOT, skills)).isDirectory(), "skills path is a directory");
    assert.equal(resolve(PLUGIN_ROOT, skills), resolve(PLUGIN_ROOT, "skills"));
    const logo = pluginRelative(codexPlugin.interface.logo, "interface.logo");
    const stat = lstatSync(join(PLUGIN_ROOT, logo));
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), "interface.logo names a regular file");
  });

  it("no longer carry the Cursor manifest", () => {
    assert.equal(existsSync(join(PLUGIN_ROOT, ".cursor-plugin")), false);
  });

  it("pass `claude plugin validate --strict` for the marketplace and the plugin", (t) => {
    const cli = claudeCli();
    if (!cli) return t.skip("claude CLI not on PATH");
    for (const target of [".", ".claude-plugin/plugin.json"]) {
      const run = spawnSync(cli, ["plugin", "validate", "--strict", "--json", join(PLUGIN_ROOT, target)], {
        encoding: "utf8",
        env: { ...process.env, CLAUDECODE: undefined },
      });
      assert.equal(run.status, 0, `${target}: ${run.stdout}${run.stderr}`);
      const report = JSON.parse(run.stdout);
      assert.equal(report.success, true, JSON.stringify(report.manifest, null, 2));
    }
  });
});

// poteto-mode is a mode the user turns on, as in the Cursor original
// (`disable-model-invocation: true`, `mode: true`). The open-pstack SessionStart
// hook turned it into a standing mandate for every non-trivial task, and a bug
// fix in Fin Dash (2026-09-23) entered poteto-mode and dispatched a subagent
// without being asked. Neither parent may enter it on its own.
describe("poteto-mode entry", () => {
  const frontmatter = (rel: string) => {
    const match = readFileSync(join(PLUGIN_ROOT, rel), "utf8").match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(match, `${rel} has frontmatter`);
    return match[1].split("\n");
  };

  it("ships no hooks, so nothing injects a poteto-mode mandate at session start", () => {
    assert.equal(existsSync(join(PLUGIN_ROOT, "hooks")), false);
  });

  it("is user-invoked only in Claude Code", () => {
    assert.ok(frontmatter("skills/poteto-mode/SKILL.md").includes("disable-model-invocation: true"));
  });

  it("is explicit-only in Codex", () => {
    const policy = readFileSync(join(PLUGIN_ROOT, "skills/poteto-mode/agents/openai.yaml"), "utf8");
    assert.match(policy, /^policy:\n  allow_implicit_invocation: false$/m);
  });
});
