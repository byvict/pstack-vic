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
import { applyPairs } from "./upstream-parity.ts";

// check-plan.mjs pins the wording of the plan template: the `/goal` that holds
// the objective, the box that reads the playbooks from the installed plugin
// (upstream pins the same box through its `git show origin/main:` reads; the
// tick prompt also says "from the installed plugin", so the marker is the box's
// own wording), the 30-minute tick, the status message, and the Verify, live
// line on the `swarm workers` role. The template lives in a playbook that scripts/upstream-parity.ts
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

  it("rejects a generated safety substitution with an incoherent plan sentence", () => {
    const plan = template();
    const anchor = "Record the repository, PR, node ID";
    const generated = applyPairs(plan, [{ id: "T21", file: PLAYBOOK, from: anchor, to: "Record identity: repository, PR, node ID", count: 1 }]);
    assert.deepEqual(generated.problems, []);
    assert.notEqual(generated.text, null);
    const run = check("incoherent-safety.md", generated.text ?? "");
    assert.equal(run.status, 1);
    assert.ok(run.problems.some((problem) => /colon/i.test(problem)), run.problems.join("\n"));
  });

  const LANES = "Ten lanes on the configured `swarm workers` role at the PR head";
  const cases: readonly { wording: string; without: string; problem: string }[] = [
    { wording: "/goal", without: "goal", problem: 'Program checklist lacks "/goal"' },
    {
      wording: "Read these from the installed plugin",
      without: "Read these from the plugin",
      problem: 'Program checklist lacks "Read these from the installed plugin"',
    },
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

  it("fails a plan that drops the read list but keeps the tick prompt", () => {
    const lines = template().split("\n");
    const box = lines.findIndex((line) => line.startsWith("- [ ] Read these from the installed plugin"));
    assert.ok(box !== -1, "the template has no read-list box");
    let end = box + 1;
    while (lines[end].startsWith("  - [ ] ")) end++;
    assert.ok(end - box > 1, "the read-list box has no child boxes");
    const plan = [...lines.slice(0, box), ...lines.slice(end)].join("\n");
    assert.ok(plan.includes("from the installed plugin and the armed /goal"), "the tick prompt is no longer verbatim");
    const run = check("without-reads.md", plan);
    assert.deepEqual(run.problems, ['Program checklist lacks "Read these from the installed plugin"']);
    assert.equal(run.status, 1);
  });
});
