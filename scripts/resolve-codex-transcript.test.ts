import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("Codex transcript resolver and documented callers pass their filesystem contracts", () => {
  const result = spawnSync("python3", ["tests/reflect-transcript-repro.py"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Ran [1-9][0-9]* tests/);
  assert.match(result.stderr, /\nOK\n/);
});
