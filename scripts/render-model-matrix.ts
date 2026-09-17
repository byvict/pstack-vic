#!/usr/bin/env node
// Render model-matrix.json into the generated blocks of the prose that cites it.
//
//   node scripts/render-model-matrix.ts          rewrite every block in place
//   node scripts/render-model-matrix.ts --check  exit 1 if any block is stale
//
// provider-dispatch.md owns the model-matrix block (families and route table)
// and the role-defaults block (one default per role and parent). setup-pstack's
// SKILL.md owns the role-sheet block (the first-run sheet per parent). The rest
// of both files is hand-written prose; only the text between markers is owned
// by this script.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  PLUGIN_ROOT,
  ROLES_BEGIN,
  ROLES_END,
  SHEET_BEGIN,
  SHEET_END,
  loadMatrix,
  renderMatrixMarkdown,
  renderRoleDefaultsMarkdown,
  renderRoleSheetsMarkdown,
  spliceBlock,
  spliceMatrixBlock,
  type ModelMatrix,
} from "./model-matrix.ts";

export const DISPATCH_PATH: string = join(
  PLUGIN_ROOT,
  "skills/poteto-mode/references/provider-dispatch.md"
);
export const SETUP_PATH: string = join(PLUGIN_ROOT, "skills/setup-pstack/SKILL.md");

export function renderDispatch(current: string, matrix: ModelMatrix = loadMatrix()): string {
  const withMatrix = spliceMatrixBlock(current, renderMatrixMarkdown(matrix));
  return spliceBlock(withMatrix, renderRoleDefaultsMarkdown(matrix), ROLES_BEGIN, ROLES_END);
}

export function renderSetup(current: string, matrix: ModelMatrix = loadMatrix()): string {
  return spliceBlock(current, renderRoleSheetsMarkdown(matrix), SHEET_BEGIN, SHEET_END);
}

export const RENDERED_DOCUMENTS: ReadonlyArray<{
  readonly path: string;
  readonly label: string;
  readonly render: (current: string, matrix: ModelMatrix) => string;
}> = [
  { path: DISPATCH_PATH, label: "provider-dispatch.md", render: renderDispatch },
  { path: SETUP_PATH, label: "setup-pstack/SKILL.md", render: renderSetup },
];

function main(argv: readonly string[]): number {
  const check = argv.includes("--check");
  const matrix = loadMatrix();
  let stale = 0;
  for (const doc of RENDERED_DOCUMENTS) {
    const current = readFileSync(doc.path, "utf8");
    const next = doc.render(current, matrix);
    if (next === current) {
      console.log(`${doc.label} generated blocks are current`);
      continue;
    }
    if (check) {
      console.error(`${doc.label} generated blocks are stale; run: node scripts/render-model-matrix.ts`);
      stale += 1;
      continue;
    }
    writeFileSync(doc.path, next);
    console.log(`${doc.label} generated blocks rewritten`);
  }
  return stale > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exitCode = main(process.argv.slice(2));
}
