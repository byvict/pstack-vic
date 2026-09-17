import { it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { PLUGIN_ROOT } from "./model-matrix.ts";

// The static invariants of tests/skill-collision-repro.sh run inside npm test.
// The behavioral leg (a real `claude -p` invocation) stays opt-in through
// PSTACK_BEHAVIORAL=1 on the script itself.
it("tests/skill-collision-repro.sh static invariants pass", () => {
  const result = spawnSync("bash", [join(PLUGIN_ROOT, "tests", "skill-collision-repro.sh")], {
    encoding: "utf8",
    env: { ...process.env, PSTACK_BEHAVIORAL: "0" },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.doesNotMatch(result.stdout, /^FAIL:/m, result.stdout);
});
