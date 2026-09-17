import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PLUGIN_ROOT } from "./model-matrix.ts";

// docs/reference.md lists exactly the installed skills: one row per
// skills/<name>/SKILL.md, flow skills under "## Skills" and principle leaves
// under "## Princípios". A skill added or removed without touching the
// reference fails here.
const REFERENCE_PATH = join(PLUGIN_ROOT, "docs", "reference.md");
const SKILLS_DIR = join(PLUGIN_ROOT, "skills");

function frontmatterName(path: string): string {
  const text = readFileSync(path, "utf8");
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(match, `${path}: no frontmatter`);
  const name = match[1].match(/^name:[ \t]*(.+)$/m);
  assert.ok(name, `${path}: no name in frontmatter`);
  return name[1].trim();
}

function installedSkills(): Map<string, string> {
  const out = new Map<string, string>();
  for (const dir of readdirSync(SKILLS_DIR).sort()) {
    const skill = join(SKILLS_DIR, dir, "SKILL.md");
    if (existsSync(skill)) out.set(dir, frontmatterName(skill));
  }
  return out;
}

function sections(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const chunk of text.split(/^## /m).slice(1)) {
    const newline = chunk.indexOf("\n");
    out.set(chunk.slice(0, newline).trim(), chunk.slice(newline + 1));
  }
  return out;
}

function listedNames(section: string): string[] {
  return [...section.matchAll(/^\| `([a-z0-9-]+)` \|/gm)].map((m) => m[1]);
}

describe("docs/reference.md", () => {
  const reference = readFileSync(REFERENCE_PATH, "utf8");
  const bySection = sections(reference);
  const flow = listedNames(bySection.get("Skills") ?? "");
  const principles = listedNames(bySection.get("Princípios") ?? "");
  const installed = installedSkills();

  it("has a Skills and a Princípios section with rows", () => {
    assert.ok(flow.length > 0, "no rows under ## Skills");
    assert.ok(principles.length > 0, "no rows under ## Princípios");
  });

  it("names each skill directory by its frontmatter name", () => {
    const mismatched = [...installed].filter(([dir, name]) => dir !== name);
    assert.deepEqual(mismatched, []);
  });

  it("lists exactly the installed skills, once each", () => {
    const listed = [...flow, ...principles];
    assert.deepEqual(listed.length, new Set(listed).size, "duplicate rows");
    assert.deepEqual(listed.sort(), [...installed.keys()].sort());
  });

  it("keeps principle leaves under Princípios and flow skills under Skills", () => {
    assert.deepEqual(flow.filter((n) => n.startsWith("principle-")), []);
    assert.deepEqual(principles.filter((n) => !n.startsWith("principle-")), []);
  });
});
