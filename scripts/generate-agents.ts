#!/usr/bin/env node
// Generate the Claude-native lane agents (agents/pstack-<stem>-<effort>.md)
// from model-matrix.json.
//
//   node scripts/generate-agents.ts          write every declared agent, delete orphans
//   node scripts/generate-agents.ts --check  exit 1 if any agent is missing, orphan or stale
//
// The generator owns every agents/pstack-*.md file: one per (family with an
// agentStem) x (selectable effort). Hand-written agents (poteto-agent.md,
// comment-sicko.md) never match that prefix and are left alone. Codex needs no
// file: its parent passes `model` and `reasoning_effort` to `spawn_agent`.
//
// The agent text is the open-pstack 1.4.1 lane template (MIT, see NOTICE.md),
// so a regenerated file is byte-identical to the file open-pstack ships.

import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  PLUGIN_ROOT,
  agentName,
  loadMatrix,
  type Family,
  type ModelMatrix,
} from "./model-matrix.ts";

export const AGENTS_DIR: string = join(PLUGIN_ROOT, "agents");
export const AGENT_PREFIX = "pstack-";

export interface AgentDiff {
  /** Declared by the matrix, no file on disk. */
  readonly missing: string[];
  /** File on disk with the pstack- prefix, not declared by the matrix. */
  readonly orphan: string[];
  /** Declared and present, but the text differs from the rendered one. */
  readonly stale: string[];
}

function laneTitle(f: Family): string {
  const stem = f.agentStem as string;
  return stem.charAt(0).toUpperCase() + stem.slice(1);
}

/** Text of one lane agent. Throws when the family has no Claude-native stem. */
export function renderAgent(f: Family, effort: string): string {
  const name = agentName(f, effort);
  if (name === null) throw new Error(`${f.family} has no Claude-native agent stem`);
  if (!f.efforts.includes(effort)) {
    throw new Error(`${f.family} does not select effort ${effort}`);
  }
  return [
    "---",
    `name: ${name}`,
    `description: Native Claude lane for pstack roles configured as ${f.provider}:${f.model}@${effort}.`,
    `model: ${f.model}`,
    `effort: ${effort}`,
    "background: true",
    "disallowedTools: Agent, Task",
    "---",
    "",
    `# pstack ${laneTitle(f)} lane`,
    "",
    "Execute only the task and path scope the parent assigns. Read the grounding artifacts by path. Do not choose another model, spawn another agent, or start a pstack workflow. If the assignment is read-only, do not modify files. Return the requested artifact or verdict plus a concise rationale.",
    "",
  ].join("\n");
}

/** Every agent the matrix declares, name -> file text, in matrix order. */
export function expectedAgents(matrix: ModelMatrix): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of matrix.families) {
    if (f.agentStem === null) continue;
    for (const effort of f.efforts) {
      out.set(agentName(f, effort) as string, renderAgent(f, effort));
    }
  }
  return out;
}

/** Names of the pstack-*.md files present in `dir`, sorted. */
export function shippedAgents(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.startsWith(AGENT_PREFIX) && n.endsWith(".md"))
    .map((n) => n.slice(0, -3))
    .sort();
}

export function diffAgents(matrix: ModelMatrix, dir: string): AgentDiff {
  const expected = expectedAgents(matrix);
  const shipped = shippedAgents(dir);
  const missing: string[] = [];
  const orphan: string[] = [];
  const stale: string[] = [];
  for (const name of shipped) {
    if (!expected.has(name)) {
      orphan.push(name);
      continue;
    }
    if (readFileSync(join(dir, `${name}.md`), "utf8") !== expected.get(name)) stale.push(name);
  }
  for (const name of expected.keys()) {
    if (!shipped.includes(name)) missing.push(name);
  }
  return { missing, orphan, stale };
}

export function isClean(diff: AgentDiff): boolean {
  return diff.missing.length === 0 && diff.orphan.length === 0 && diff.stale.length === 0;
}

/** Write every declared agent and delete orphans. Returns the diff that was applied. */
export function generateAgents(matrix: ModelMatrix, dir: string): AgentDiff {
  const diff = diffAgents(matrix, dir);
  for (const name of [...diff.missing, ...diff.stale]) {
    writeFileSync(join(dir, `${name}.md`), expectedAgents(matrix).get(name) as string);
  }
  for (const name of diff.orphan) unlinkSync(join(dir, `${name}.md`));
  return diff;
}

function describe(diff: AgentDiff): string {
  const parts: string[] = [];
  if (diff.missing.length) parts.push(`missing: ${diff.missing.join(", ")}`);
  if (diff.orphan.length) parts.push(`orphan: ${diff.orphan.join(", ")}`);
  if (diff.stale.length) parts.push(`stale: ${diff.stale.join(", ")}`);
  return parts.join("; ");
}

function main(argv: readonly string[]): number {
  const check = argv.includes("--check");
  const matrix = loadMatrix();
  const before = diffAgents(matrix, AGENTS_DIR);
  if (isClean(before)) {
    console.log(`agents/ is current (${expectedAgents(matrix).size} pstack-* agents)`);
    return 0;
  }
  if (check) {
    console.error(`agents/ is out of date (${describe(before)}); run: node scripts/generate-agents.ts`);
    return 1;
  }
  generateAgents(matrix, AGENTS_DIR);
  console.log(`agents/ regenerated (${describe(before)})`);
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exitCode = main(process.argv.slice(2));
}
