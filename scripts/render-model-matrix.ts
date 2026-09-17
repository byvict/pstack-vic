#!/usr/bin/env node
// Render model-matrix.json into the generated block of provider-dispatch.md.
//
//   node scripts/render-model-matrix.ts          rewrite the block in place
//   node scripts/render-model-matrix.ts --check  exit 1 if the block is stale
//
// The rest of provider-dispatch.md is hand-written prose; only the text
// between the model-matrix markers is owned by this script.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  PLUGIN_ROOT,
  loadMatrix,
  renderMatrixMarkdown,
  spliceMatrixBlock,
} from "./model-matrix.ts";

export const DISPATCH_PATH: string = join(
  PLUGIN_ROOT,
  "skills/poteto-mode/references/provider-dispatch.md"
);

export function renderDispatch(current: string): string {
  return spliceMatrixBlock(current, renderMatrixMarkdown(loadMatrix()));
}

function main(argv: readonly string[]): number {
  const check = argv.includes("--check");
  const current = readFileSync(DISPATCH_PATH, "utf8");
  const next = renderDispatch(current);
  if (next === current) {
    console.log(`provider-dispatch.md matrix block is current`);
    return 0;
  }
  if (check) {
    console.error(
      `provider-dispatch.md matrix block is stale; run: node scripts/render-model-matrix.ts`
    );
    return 1;
  }
  writeFileSync(DISPATCH_PATH, next);
  console.log(`provider-dispatch.md matrix block rewritten`);
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exitCode = main(process.argv.slice(2));
}
