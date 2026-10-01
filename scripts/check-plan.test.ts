import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clisOutsideFakes,
  isolateProcessEnv,
  isolatedEnv,
} from "../skills/poteto-mode/scripts/runner/isolated-env.test-helper.ts";
import { PLUGIN_ROOT } from "./model-matrix.ts";

// check-plan.mjs pins the wording of the plan template: the `/goal` that holds
// the objective, the reads from the installed plugin, the 30-minute tick, the
// status message, and the Verify, live line on the `swarm workers` role. The template lives in a playbook that scripts/upstream-parity.ts
// regenerates from the substitution table, so a pair that changes one of
// those wordings must change the checker in the same commit.
const CHECK_PLAN = join(PLUGIN_ROOT, "skills", "poteto-mode", "scripts", "check-plan.mjs");
const PLAYBOOK = join(PLUGIN_ROOT, "skills", "poteto-mode", "playbooks", "multi-phase-plan.md");

let scratch = "";
let home = "";
let restoreProcessEnv: () => void = () => {};

before(() => {
  scratch = mkdtempSync(join(tmpdir(), "pstack-check-plan-"));
  home = join(scratch, "home");
  mkdirSync(home);
  restoreProcessEnv = isolateProcessEnv(home);
});

after(() => {
  restoreProcessEnv();
  rmSync(scratch, { recursive: true, force: true });
});

function template(): string {
  const lines = readFileSync(PLAYBOOK, "utf8").split("\n");
  const open = lines.indexOf("````markdown");
  const close = lines.indexOf("````", open + 1);
  assert.ok(open !== -1 && close !== -1, "multi-phase-plan.md has no ````markdown plan template");
  return `${lines.slice(open + 1, close).join("\n")}\n`;
}

function check(name: string, plan: string): { status: number | null; stdout: string; problems: string[] } {
  const file = join(scratch, name);
  writeFileSync(file, plan);
  const run = spawnSync(process.execPath, [CHECK_PLAN, file], { env: isolatedEnv(home), encoding: "utf8" });
  const problems = run.stderr
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.slice(line.indexOf(": ") + 2));
  return { status: run.status, stdout: run.stdout, problems };
}

describe("check-plan: the plan template of multi-phase-plan.md", () => {
  it("runs with no provider CLI and no gh in reach", () => {
    assert.deepEqual(clisOutsideFakes(process.env.PATH), []);
  });

  it("passes the checker as the playbook ships it", () => {
    const run = check("template.md", template());
    assert.deepEqual(run.problems, []);
    assert.match(run.stdout, /\n1 PR sections, 0 problems\n$/);
    assert.equal(run.status, 0);
  });

  const LANES = "Ten lanes on the configured `swarm workers` role at the PR head";
  const cases: readonly { wording: string; without: string; problem: string }[] = [
    { wording: "/goal", without: "goal", problem: 'Program checklist lacks "/goal"' },
    { wording: "the installed plugin", without: "the plugin", problem: 'Program checklist lacks "the installed plugin"' },
    { wording: "30-minute", without: "half-hour", problem: 'Program checklist lacks "/30[- ]minute/"' },
    { wording: "status message", without: "note", problem: 'Program checklist lacks "status message"' },
    {
      wording: LANES,
      without: "Ten lanes at the PR head",
      problem: `<Task as a verb phrase> (<PR id>): Verify, live lacks "${LANES}"`,
    },
  ];

  for (const { wording, without, problem } of cases) {
    it(`fails a plan that loses "${wording}"`, () => {
      const plan = template();
      assert.ok(plan.includes(wording), `the template no longer says "${wording}"`);
      const run = check("without.md", plan.replaceAll(wording, without));
      assert.deepEqual(run.problems, [problem]);
      assert.equal(run.status, 1);
    });
  }
});
