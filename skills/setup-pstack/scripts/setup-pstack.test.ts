import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { loadMatrix, renderRoleSheet } from "../../../scripts/model-matrix.ts";
import { clisOutsideFakes, isolatedEnv, isolateProcessEnv } from "../../poteto-mode/scripts/runner/isolated-env.test-helper.ts";
import {
  SetupError,
  buildPlan,
  ledgerPathFor,
  loadState,
  normalizeLane,
  parseSheet,
  sheetPathFor,
  type Plan,
} from "./setup-pstack.ts";

const matrix = loadMatrix();

let home = "";
let restoreProcessEnv: () => void = () => {};

// The test process itself holds no CLI, fake or real, and its HOME is the
// temporary one: a probe whose `env` gets lost on the way to the launcher
// inherits this and finds nothing, and a path that falls back to the home
// directory lands in the temporary one.
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pstack-setup-"));
  restoreProcessEnv = isolateProcessEnv(home);
});

afterEach(() => {
  restoreProcessEnv();
  rmSync(home, { recursive: true, force: true });
});

function putSheet(parent: string, text: string): string {
  const path = sheetPathFor(parent, home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

/** A ledger that vouches for the named families (matrix family names) on this parent. */
function putLedger(parent: string, families: readonly string[]): string {
  const path = ledgerPathFor(parent, home);
  mkdirSync(dirname(path), { recursive: true });
  const entries = families.map((name) => {
    const family = matrix.families.find((f) => f.family === name);
    assert.ok(family, `no matrix family ${name}`);
    return [
      `${family.provider}:${family.model}`,
      { family: name, descriptor: `${family.provider}:${family.model}@${family.defaultEffort}`, verifiedAt: "2026-09-24T00:00:00.000Z", evidence: "operator" },
    ];
  });
  writeFileSync(path, `${JSON.stringify({ schemaVersion: 1, families: Object.fromEntries(entries) }, null, 2)}\n`);
  return path;
}

function firstRunSheet(parent: string): string {
  return [
    "# pstack model configuration",
    "",
    "Provider-qualified per-role choices. Read the installed pstack provider-dispatch reference before dispatching a configured role. Every documented role remains present. `inherit-parent` and `auto` use the parent model natively and still count as one panel lane.",
    "",
    renderRoleSheet(matrix, parent),
    "",
  ].join("\n");
}

const RETIRED_ROWS = [
  "pre-pr reviewer: grok:grok-4.7@xhigh, codex:gpt-6-sol@xhigh",
  "pre-pr fixer: grok:grok-4.7@xhigh",
  "pre-pr certifier: grok:grok-4.7@high",
  "converge raiz: claude:claude-opus-5-5@xhigh",
  "pr owner: cursor:grok-4.7@xhigh",
  "pr verifier: cursor:grok-4.7@xhigh",
];

function lanesOf(plan: Plan, role: string): string[] {
  const row = plan.rows.find((r) => r.role === role);
  assert.ok(row, `plan has no row ${role}`);
  return [...row.lanes];
}

describe("parseSheet", () => {
  it("reads role rows and ignores the header and prose", () => {
    const rows = parseSheet(firstRunSheet("claude"), matrix);
    assert.equal(rows.length, matrix.roles.length);
    assert.deepEqual(rows[0], { role: "feature, refactoring", lanes: ["claude:claude-opus-5-5@xhigh"] });
    assert.deepEqual(
      rows.find((r) => r.role === "arena runners")?.lanes,
      ["claude:fable@max", "codex:gpt-6-astra@max", "grok:grok-4.6@xhigh", "claude:claude-opus-5-5@xhigh"]
    );
  });

  it("rejects an unknown role and a duplicate role", () => {
    assert.throws(
      () => parseSheet("# x\n\nbug-fix: grok:grok-4.6@xhigh\nmystery role: auto\n", matrix),
      (error: unknown) => error instanceof SetupError && /unknown role "mystery role"/.test((error as Error).message)
    );
    assert.throws(
      () => parseSheet("bug-fix: grok:grok-4.6@xhigh\nbug-fix: auto\n", matrix),
      (error: unknown) => error instanceof SetupError && /duplicate role "bug-fix"/.test((error as Error).message)
    );
  });

  it("drops retired Converge roles from an existing sheet", () => {
    const older = [
      "pr reviewer: cursor:grok-4.7@high",
      "pr fixer, simple: cursor:composer-2.5@high",
      "pr fixer, complex: cursor:grok-4.7@xhigh",
      "pr diagnosis pool: cursor:muse-spark-1.3@high, cursor:kimi-k3@high",
    ];
    const rows = parseSheet(`bug-fix: grok:grok-4.6@xhigh\n${[...older, ...RETIRED_ROWS].join("\n")}\n`, matrix);
    assert.deepEqual(rows, [{ role: "bug-fix", lanes: ["grok:grok-4.6@xhigh"] }]);
  });
});

describe("normalizeLane", () => {
  it("migrates rolling-alias predecessors and records the original", () => {
    assert.deepEqual(normalizeLane("claude:claude-fable-5-1@max", matrix), {
      lane: "claude:fable@max",
      migratedFrom: "claude:claude-fable-5-1@max",
    });
    assert.deepEqual(normalizeLane("claude:claude-opus-5@xhigh", matrix), {
      lane: "claude:claude-opus-5-5@xhigh",
      migratedFrom: "claude:claude-opus-5@xhigh",
    });
    assert.deepEqual(normalizeLane("claude:opus@xhigh", matrix), {
      lane: "claude:claude-opus-5-5@xhigh",
      migratedFrom: "claude:opus@xhigh",
    });
    assert.deepEqual(normalizeLane("claude:claude-opus-5-5@xhigh", matrix), {
      lane: "claude:claude-opus-5-5@xhigh",
      migratedFrom: null,
    });
    assert.deepEqual(normalizeLane("codex:gpt-5.6-sol@xhigh", matrix), {
      lane: "codex:gpt-6-sol@xhigh",
      migratedFrom: "codex:gpt-5.6-sol@xhigh",
    });
    assert.deepEqual(normalizeLane("grok:grok-4.6@xhigh", matrix), {
      lane: "grok:grok-4.6@xhigh",
      migratedFrom: null,
    });
    assert.deepEqual(normalizeLane("inherit-parent", matrix), { lane: "inherit-parent", migratedFrom: null });
  });

  it("rejects a bare slug, an unknown versioned Claude model, and a pair outside the matrix", () => {
    for (const bad of ["fable@max", "grok-4.6-fast-xhigh", "claude:claude-sonnet-4@max", "claude:gpt-6-astra@max", "grok:grok-4.6@turbo"]) {
      assert.throws(() => normalizeLane(bad, matrix), SetupError, bad);
    }
  });
});

describe("Grok 4.7 selection", () => {
  it("leaves the 4.6 lanes untouched when a role selects 4.7 and probes 4.7 only when the ledger lacks it", () => {
    putSheet("codex", firstRunSheet("codex"));
    const state = loadState({ parent: "codex", home, matrix });
    assert.deepEqual(state.efforts["grok-4-7"], { status: "outside-map", efforts: ["xhigh"], rows: [] });
    const plan = buildPlan({ parent: "codex", home, matrix, roles: { "bug-fix": ["grok:grok-4.7@xhigh"] } });
    assert.deepEqual(lanesOf(plan, "bug-fix"), ["grok:grok-4.7@xhigh"]);
    assert.deepEqual(lanesOf(plan, "swarm workers"), ["grok:grok-4.6@xhigh"]);
    assert.deepEqual(lanesOf(plan, "how explorer"), ["grok:grok-4.6@xhigh"]);
    assert.deepEqual(plan.efforts.grok, ["xhigh"]);
    assert.deepEqual(plan.efforts["grok-4-7"], ["xhigh"]);
    assert.deepEqual(
      plan.pairs.filter((p) => p.family.startsWith("grok")).map((p) => [p.pair, p.descriptor, p.route]),
      [
        ["grok@xhigh", "grok:grok-4.6@xhigh", "runner"],
        ["grok-4-7@xhigh", "grok:grok-4.7@xhigh", "runner"],
      ]
    );

    putLedger("codex", ["grok-4-7"]);
    const verified = buildPlan({ parent: "codex", home, matrix, roles: { "bug-fix": ["grok:grok-4.7@xhigh"] } });
    assert.deepEqual(lanesOf(verified, "bug-fix"), ["grok:grok-4.7@xhigh"]);
    assert.deepEqual(
      verified.pairs.filter((p) => p.family.startsWith("grok")).map((p) => p.pair),
      ["grok@xhigh"]
    );
    assert.deepEqual(verified.verified.map((v) => v.family), ["grok-4-7"]);
    assert.throws(() => normalizeLane("grok:grok-4.7@max", matrix), SetupError);
  });
});

describe("loadState", () => {
  it("reports a missing sheet as a first run with the matrix defaults proposed", () => {
    const state = loadState({ parent: "claude", home, matrix });
    assert.equal(state.exists, false);
    assert.equal(state.sheetPath, join(home, ".claude", "pstack-models.md"));
    assert.deepEqual(state.migrations, []);
    assert.deepEqual(state.efforts.grok, { status: "unassigned", efforts: ["xhigh"], rows: [] });
    assert.deepEqual(state.efforts.sol, { status: "outside-map", efforts: ["max"], rows: [] }, "no role of the Claude first-run map uses Sol");
    assert.equal("conflicts" in state, false);
    assert.equal(loadState({ parent: "codex", home, matrix }).efforts.sol.status, "unassigned");
  });

  it("reads a Codex sheet, normalizes its lanes, and derives the efforts in use per family", () => {
    putSheet(
      "codex",
      "# pstack model configuration\n\nbug-fix: grok:grok-4.6@high\nhardest tasks: codex:gpt-6-astra@max\narena runners: claude:claude-fable-5-1@max, claude:claude-opus-5@xhigh\n"
    );
    const state = loadState({ parent: "codex", home, matrix });
    assert.equal(state.exists, true);
    assert.equal(state.sheetPath, join(home, ".codex", "pstack-models.md"));
    assert.deepEqual(state.migrations, [
      { role: "arena runners", from: "claude:claude-fable-5-1@max", to: "claude:fable@max" },
      { role: "arena runners", from: "claude:claude-opus-5@xhigh", to: "claude:claude-opus-5-5@xhigh" },
    ]);
    assert.deepEqual(state.efforts.grok, {
      status: "current",
      efforts: ["high"],
      rows: [{ role: "bug-fix", lane: "grok:grok-4.6@high" }],
    });
    assert.deepEqual(state.efforts.fable, {
      status: "current",
      efforts: ["max"],
      rows: [{ role: "arena runners", lane: "claude:fable@max" }],
    });
    assert.deepEqual(state.efforts.sol, { status: "outside-map", efforts: ["max"], rows: [] });
  });

  it("reports mixed efforts as mixed, in matrix order, and a single-effort family as current", () => {
    putSheet(
      "claude",
      "bug-fix: codex:gpt-6-sol@xhigh\nhillclimb: codex:gpt-6-sol@high\nswarm workers: grok:grok-4.6@xhigh\n"
    );
    const state = loadState({ parent: "claude", home, matrix });
    assert.deepEqual(state.efforts.sol, {
      status: "mixed",
      efforts: ["high", "xhigh"],
      rows: [
        { role: "bug-fix", lane: "codex:gpt-6-sol@xhigh" },
        { role: "hillclimb", lane: "codex:gpt-6-sol@high" },
      ],
    });
    assert.deepEqual(state.efforts.grok, {
      status: "current",
      efforts: ["xhigh"],
      rows: [{ role: "swarm workers", lane: "grok:grok-4.6@xhigh" }],
    });
    assert.equal("conflicts" in state, false);
  });
});

describe("buildPlan", () => {
  it("on a first run takes the parent's role defaults, the matrix default efforts, and one probe per family in the map", () => {
    const plan = buildPlan({ parent: "claude", home, matrix });
    assert.equal(plan.sheet, firstRunSheet("claude"));
    assert.equal(plan.schemaVersion, 5);
    assert.equal(plan.ledgerPath, join(home, ".claude", "pstack-probes.json"));
    assert.deepEqual(plan.verified, []);
    assert.deepEqual(plan.efforts, {
      fable: ["max"],
      opus: ["xhigh"],
      astra: ["max"],
      grok: ["xhigh"],
    });
    assert.deepEqual(
      plan.pairs.map((p) => [p.family, p.pair, p.descriptor, p.route]),
      [
        ["fable", "fable@max", "claude:fable@max", "native"],
        ["opus", "opus@xhigh", "claude:claude-opus-5-5@xhigh", "native"],
        ["astra", "astra@max", "codex:gpt-6-astra@max", "runner"],
        ["grok", "grok@xhigh", "grok:grok-4.6@xhigh", "runner"],
      ]
    );
    const fable = plan.pairs.find((p) => p.pair === "fable@max");
    assert.deepEqual(fable?.native, { primitive: "Agent", agent: "pstack-fable-max" });
    assert.equal(plan.pairs.find((p) => p.pair === "grok@xhigh")?.native, null);
    assert.match(fable?.marker ?? "", /^PSTACK-SETUP-claude-fable-max-[0-9a-f]{8}$/);
    assert.deepEqual(plan.migrations, []);
  });

  it("on a Codex first run the frontier solo roles take Astra and the native pairs use spawn_agent", () => {
    const plan = buildPlan({ parent: "codex", home, matrix });
    assert.equal(plan.sheet, firstRunSheet("codex"));
    assert.deepEqual(lanesOf(plan, "hardest tasks"), ["codex:gpt-6-astra@max"]);
    const astra = plan.pairs.find((p) => p.family === "astra");
    assert.equal(astra?.route, "native");
    assert.deepEqual(astra?.native, { primitive: "spawn_agent", model: "gpt-6-astra", reasoning_effort: "max" });
    assert.equal(plan.pairs.find((p) => p.family === "fable")?.route, "runner");
  });

  it("rewrites every occurrence of a family when its effort changes and moves no role", () => {
    const plan = buildPlan({ parent: "claude", home, matrix, efforts: { grok: "high" } });
    assert.deepEqual(lanesOf(plan, "bug-fix"), ["claude:claude-opus-5-5@xhigh"]);
    assert.deepEqual(lanesOf(plan, "swarm workers"), ["grok:grok-4.6@high"]);
    assert.deepEqual(lanesOf(plan, "how explorer"), ["grok:grok-4.6@high"]);
    assert.deepEqual(lanesOf(plan, "arena runners"), [
      "claude:fable@max",
      "codex:gpt-6-astra@max",
      "grok:grok-4.6@high",
      "claude:claude-opus-5-5@xhigh",
    ]);
    assert.deepEqual(lanesOf(plan, "why investigators"), ["inherit-parent"]);
    assert.deepEqual(plan.efforts.grok, ["high"]);
    assert.equal(plan.pairs.find((p) => p.pair === "grok@high")?.descriptor, "grok:grok-4.6@high");
  });

  it("rejects an effort for a family outside the map, an unselectable effort, and an unknown family", () => {
    assert.throws(
      () => buildPlan({ parent: "claude", home, matrix, efforts: { "sol-6-1": "high" } }),
      (error: unknown) =>
        error instanceof SetupError &&
        (error as Error).message ===
          "sol-6-1 is outside the role map; nothing to rewrite. Write the effort in a role's descriptor (--role) or drop --effort sol-6-1"
    );
    assert.throws(
      () => buildPlan({ parent: "claude", home, matrix, efforts: { grok: "turbo" } }),
      (error: unknown) => error instanceof SetupError && /grok does not select effort turbo/.test((error as Error).message)
    );
    assert.throws(
      () => buildPlan({ parent: "claude", home, matrix, efforts: { sonnet: "high" } }),
      (error: unknown) => error instanceof SetupError && /unknown family sonnet/.test((error as Error).message)
    );
  });

  it("changes only the named roles and can bring a family into the map with its own effort", () => {
    const plan = buildPlan({
      parent: "claude",
      home,
      matrix,
      roles: {
        "swarm workers": ["codex:gpt-6.1-sol@high"],
        "why synthesizer": ["auto"],
      },
    });
    assert.deepEqual(lanesOf(plan, "swarm workers"), ["codex:gpt-6.1-sol@high"]);
    assert.deepEqual(lanesOf(plan, "why synthesizer"), ["auto"]);
    assert.deepEqual(lanesOf(plan, "bug-fix"), ["claude:claude-opus-5-5@xhigh"]);
    assert.deepEqual(plan.efforts["sol-6-1"], ["high"]);
    assert.equal(plan.pairs.find((p) => p.pair === "sol-6-1@high")?.route, "runner");
    assert.deepEqual(
      plan.pairs.map((p) => p.pair),
      ["fable@max", "opus@xhigh", "sol-6-1@high", "astra@max", "grok@xhigh"]
    );
  });

  it("rejects a role change with an unqualified slug or an unknown role", () => {
    assert.throws(
      () => buildPlan({ parent: "claude", home, matrix, roles: { "bug-fix": ["grok-4.6@xhigh"] } }),
      SetupError
    );
    assert.throws(
      () => buildPlan({ parent: "claude", home, matrix, roles: { "mystery role": ["auto"] } }),
      (error: unknown) => error instanceof SetupError && /unknown role "mystery role"/.test((error as Error).message)
    );
  });

  it("accepts a role change whose effort differs from the family's other lanes, keeps both, and probes the family once at its lowest effort", () => {
    const plan = buildPlan({
      parent: "claude",
      home,
      matrix,
      roles: {
        "bug-fix": ["codex:gpt-6-sol@xhigh"],
        hillclimb: ["codex:gpt-6-sol@high"],
      },
    });
    assert.deepEqual(lanesOf(plan, "bug-fix"), ["codex:gpt-6-sol@xhigh"]);
    assert.deepEqual(lanesOf(plan, "hillclimb"), ["codex:gpt-6-sol@high"]);
    assert.deepEqual(plan.efforts.sol, ["high", "xhigh"]);
    assert.deepEqual(
      plan.pairs.filter((p) => p.family === "sol").map((p) => [p.pair, p.descriptor, p.route]),
      [["sol@high", "codex:gpt-6-sol@high", "runner"]]
    );
  });

  it("applies --effort as a bulk rewrite, then --role overlays the named lanes", () => {
    const plan = buildPlan({
      parent: "claude",
      home,
      matrix,
      efforts: { grok: "high" },
      roles: { "bug-fix": ["grok:grok-4.6@xhigh"] },
    });
    assert.deepEqual(lanesOf(plan, "bug-fix"), ["grok:grok-4.6@xhigh"]);
    assert.deepEqual(lanesOf(plan, "how explorer"), ["grok:grok-4.6@high"]);
    assert.deepEqual(lanesOf(plan, "swarm workers"), ["grok:grok-4.6@high"]);
    assert.deepEqual(lanesOf(plan, "arena runners"), [
      "claude:fable@max",
      "codex:gpt-6-astra@max",
      "grok:grok-4.6@high",
      "claude:claude-opus-5-5@xhigh",
    ]);
    assert.deepEqual(plan.efforts.grok, ["high", "xhigh"]);
    assert.deepEqual(
      plan.pairs.filter((p) => p.family === "grok").map((p) => [p.pair, p.descriptor]),
      [["grok@high", "grok:grok-4.6@high"]]
    );
  });

  it("probes no family the ledger verified, whatever effort its lanes take, and probes a family new to this parent", () => {
    putSheet("claude", firstRunSheet("claude"));
    putLedger("claude", ["fable", "opus", "astra", "grok"]);
    const effortsOnly = buildPlan({ parent: "claude", home, matrix, efforts: { grok: "high", fable: "medium" } });
    assert.deepEqual(effortsOnly.efforts.grok, ["high"]);
    assert.deepEqual(effortsOnly.pairs, []);
    assert.deepEqual(
      effortsOnly.verified.map((v) => [v.family, `${v.provider}:${v.model}`, v.verifiedAt]),
      [
        ["fable", "claude:fable", "2026-09-24T00:00:00.000Z"],
        ["opus", "claude:claude-opus-5-5", "2026-09-24T00:00:00.000Z"],
        ["astra", "codex:gpt-6-astra", "2026-09-24T00:00:00.000Z"],
        ["grok", "grok:grok-4.6", "2026-09-24T00:00:00.000Z"],
      ]
    );

    const newFamilies = buildPlan({
      parent: "claude",
      home,
      matrix,
      roles: { "bug-fix": ["grok:grok-4.7@high"], "swarm workers": ["codex:gpt-6.1-sol@high"] },
    });
    assert.deepEqual(
      newFamilies.pairs.map((p) => [p.pair, p.descriptor, p.route]),
      [
        ["sol-6-1@high", "codex:gpt-6.1-sol@high", "runner"],
        ["grok-4-7@high", "grok:grok-4.7@high", "runner"],
      ]
    );
    assert.equal(newFamilies.verified.some((v) => v.family === "sol-6-1" || v.family === "grok-4-7"), false);
  });

  it("probes a new model of a verified family and keeps one parent's ledger from verifying the other", () => {
    putLedger("claude", ["fable", "opus", "astra", "grok"]);
    const bumped = structuredClone(matrix) as { families: Array<{ family: string; model: string }> };
    const grok = bumped.families.find((f) => f.family === "grok");
    assert.ok(grok);
    grok.model = "grok-4.8";
    const plan = buildPlan({ parent: "claude", home, matrix: bumped as unknown as typeof matrix });
    assert.deepEqual(plan.pairs.map((p) => p.descriptor), ["grok:grok-4.8@xhigh"]);

    const codex = buildPlan({ parent: "codex", home, matrix });
    assert.deepEqual(codex.verified, []);
    assert.deepEqual(
      codex.pairs.map((p) => p.pair),
      ["fable@max", "opus@xhigh", "sol@xhigh", "astra@max", "grok@xhigh"]
    );
  });

  it("treats an unreadable ledger as inconsistent state", () => {
    const path = ledgerPathFor("claude", home);
    mkdirSync(dirname(path), { recursive: true });
    for (const broken of ["not json", "[]", `{"schemaVersion":2,"families":{}}`, `{"schemaVersion":1,"families":[]}`]) {
      writeFileSync(path, broken);
      assert.throws(() => buildPlan({ parent: "claude", home, matrix }), (error: unknown) => error instanceof SetupError && /pstack-probes\.json/.test((error as Error).message), broken);
    }
    rmSync(path);
    mkdirSync(path);
    assert.throws(() => buildPlan({ parent: "claude", home, matrix }), /probe ledger .* is not a regular file/);
  });

  it("on a rerun without changes renders the existing sheet byte for byte", () => {
    const first = buildPlan({ parent: "claude", home, matrix, efforts: { grok: "high", opus: "max" } });
    putSheet("claude", first.sheet);
    const again = buildPlan({ parent: "claude", home, matrix });
    assert.equal(again.sheet, first.sheet);
    assert.deepEqual(again.efforts, first.efforts);
    assert.deepEqual(again.rows, first.rows);
  });

  it("on a rerun preserves customized lanes and materializes missing documented roles from the defaults", () => {
    putSheet("claude", "# pstack model configuration\n\nswarm workers: claude:claude-opus-5-5@xhigh, grok:grok-4.6@xhigh\n");
    const plan = buildPlan({ parent: "claude", home, matrix });
    assert.deepEqual(lanesOf(plan, "swarm workers"), ["claude:claude-opus-5-5@xhigh", "grok:grok-4.6@xhigh"]);
    assert.deepEqual(lanesOf(plan, "bug-fix"), ["claude:claude-opus-5-5@xhigh"]);
    assert.equal(plan.rows.length, matrix.roles.length);
    assert.deepEqual(plan.rows.map((r) => r.role), matrix.roles.map((r) => r.role));
  });

  it("reads a sheet that still has the six retired rows, keeps its other lanes, and renders only the current roles", () => {
    const customized = firstRunSheet("claude").replace("bug-fix: claude:claude-opus-5-5@xhigh", "bug-fix: codex:gpt-6-sol@high");
    putSheet("claude", `${customized}${RETIRED_ROWS.join("\n")}\n`);
    const state = loadState({ parent: "claude", home, matrix });
    assert.equal(state.exists, true);
    assert.deepEqual(state.rows.map((r) => r.role), matrix.roles.map((r) => r.role));
    assert.equal(state.efforts["grok-4-7"].status, "outside-map");
    const plan = buildPlan({ parent: "claude", home, matrix });
    assert.equal(plan.sheet, customized);
    assert.deepEqual(lanesOf(plan, "bug-fix"), ["codex:gpt-6-sol@high"]);
    assert.deepEqual(plan.pairs.map((p) => p.pair), ["fable@max", "opus@xhigh", "sol@high", "astra@max", "grok@xhigh"]);
  });

  it("carries the rolling-alias migrations into the plan and rewrites them in the sheet", () => {
    putSheet("claude", "hardest tasks: claude:claude-fable-5-1@max\n");
    const plan = buildPlan({ parent: "claude", home, matrix });
    assert.deepEqual(plan.migrations, [
      { role: "hardest tasks", from: "claude:claude-fable-5-1@max", to: "claude:fable@max" },
    ]);
    assert.deepEqual(lanesOf(plan, "hardest tasks"), ["claude:fable@max"]);
    assert.doesNotMatch(plan.sheet, /claude-fable-5-1/);
  });

  it("on a mixed sheet planned with no input renders the file byte for byte", () => {
    const mixed = firstRunSheet("claude").replace(
      "how explorer: grok:grok-4.6@xhigh",
      "how explorer: grok:grok-4.6@high"
    );
    assert.notEqual(mixed, firstRunSheet("claude"));
    putSheet("claude", mixed);
    const plan = buildPlan({ parent: "claude", home, matrix });
    assert.equal(plan.sheet, mixed);
    assert.deepEqual(plan.efforts.grok, ["high", "xhigh"]);
    assert.deepEqual(lanesOf(plan, "swarm workers"), ["grok:grok-4.6@xhigh"]);
    assert.deepEqual(lanesOf(plan, "how explorer"), ["grok:grok-4.6@high"]);
  });

  it("rejects an unknown parent", () => {
    assert.throws(() => buildPlan({ parent: "cursor", home, matrix }), SetupError);
    assert.equal(existsSync(join(home, ".cursor")), false);
  });
});

// --- Probe, attest, write ------------------------------------------------------

import { chmodSync, readdirSync, statSync } from "node:fs";
import {
  CLAUDE_INCLUDE_LINE,
  CODEX_BLOCK_BEGIN,
  CODEX_BLOCK_END,
  attestNative,
  integrationPathFor,
  runProbes,
  savePlan,
  verifyProbes,
  writeSheet,
} from "./setup-pstack.ts";

// A fake provider CLI: answers the runner's preflight, then echoes the
// PSTACK-SETUP marker it finds in the prompt in the shape the runner parses.
// Pipes are asynchronous on macOS, so every write goes through fs.writeSync.
const fakeCli = `#!/usr/bin/env node
import { readFileSync, writeSync } from "node:fs";
const out = (text) => writeSync(1, text + "\\n");
const err = (text) => writeSync(2, text + "\\n");
const args = process.argv.slice(2);
const name = process.argv[1].split("/").at(-1);
if (name === "claude" && args[0] === "auth") { out(JSON.stringify({ loggedIn: true })); process.exit(0); }
if (name === "codex" && args[0] === "login") { out("Logged in using ChatGPT"); process.exit(0); }
if (name === "grok" && args[0] === "models") {
  if (process.env.FAKE_GROK_UNAUTH === "1") { err("Not logged in. Run grok auth login."); process.exit(1); }
  out("You are logged in with grok.com.\\nAvailable models:\\n  * grok-4.6 (default)\\n  * grok-4.7");
  process.exit(0);
}
const modelIndex = args.indexOf("--model");
const model = modelIndex >= 0 ? args[modelIndex + 1] : "unknown";
const promptIndex = args.indexOf("--prompt-file");
const prompt = promptIndex >= 0 ? readFileSync(args[promptIndex + 1], "utf8") : readFileSync(0, "utf8");
const marker = process.env.FAKE_DROP_MARKER === "1" ? "nope" : (prompt.match(/PSTACK-SETUP-[A-Za-z0-9-]+/) ?? ["missing"])[0];
const reported = model === "fable" ? "claude-fable-9-9" : model === "claude-opus-5-5" ? "claude-opus-5-5" : model === "grok-4.6" ? "grok-4.6-build" : model;
if (name === "claude") {
  out(JSON.stringify({ result: marker, session_id: "c1", usage: { input_tokens: 10, output_tokens: 2 }, total_cost_usd: 0.01, modelUsage: { [reported]: {} } }));
} else if (name === "codex") {
  out(JSON.stringify({ type: "thread.started", thread_id: "o1" }));
  out(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: marker } }));
  out(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 20, output_tokens: 3 } }));
} else {
  out(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: marker, session_id: "g1", usage: { input_tokens: 30, output_tokens: 4 }, total_cost_usd: 0.02, modelUsage: { [reported]: {} } }));
}
`;

let bin = "";
let runDir = "";

beforeEach(() => {
  bin = join(home, "bin");
  mkdirSync(bin);
  for (const name of ["claude", "codex", "grok"]) {
    const path = join(bin, name);
    writeFileSync(path, fakeCli);
    chmodSync(path, 0o755);
  }
  runDir = join(home, "run");
});

/** The fake CLIs and this node on PATH, under the test's temporary home; nothing of the operator's PATH or HOME. */
function fakeEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return isolatedEnv(home, [bin], extra);
}

/** For a command that must launch nothing: not even the fakes are on PATH, so a lane that starts anyway finds no CLI. */
function noCliEnv(): NodeJS.ProcessEnv {
  return isolatedEnv(home);
}

describe("test isolation", () => {
  it("keeps every provider CLI and gh off the PATH of the test process, and off the PATH of a probe outside the fakes", () => {
    assert.deepEqual(clisOutsideFakes(process.env.PATH), [], "a CLI is on the PATH of the test process");
    assert.equal(process.env.PATH, join(home, ".node-bin"));
    assert.equal(process.env.HOME, home);
    assert.deepEqual(clisOutsideFakes(fakeEnv().PATH, [bin]), [], "a real CLI is on the PATH of the probes");
    assert.deepEqual(clisOutsideFakes(noCliEnv().PATH), [], "a CLI is on the PATH of a command that must launch nothing");
  });
});

/** Plan, run the external probes with the fake CLIs, and attest every native pair. */
async function planAndProbe(parent: string, input: { efforts?: Record<string, string>; roles?: Record<string, string[]> } = {}) {
  const plan = buildPlan({ parent, home, matrix, ...input });
  rmSync(runDir, { recursive: true, force: true });
  savePlan(runDir, plan);
  const summary = await runProbes(plan, { dir: runDir, env: fakeEnv() });
  assert.equal(summary.externalOk, true, JSON.stringify(summary, null, 2));
  for (const pair of plan.pairs) {
    if (pair.native) attestNative(plan, runDir, pair.pair, `The agent replied: ${pair.marker}`);
  }
  return plan;
}

describe("runProbes", () => {
  it("runs one external lane per runner pair, passes when the marker comes back, and lists the native pairs as pending", async () => {
    const plan = buildPlan({ parent: "claude", home, matrix });
    savePlan(runDir, plan);
    const summary = await runProbes(plan, { dir: runDir, env: fakeEnv() });
    assert.equal(summary.externalOk, true);
    assert.deepEqual(
      summary.external.map((r) => [r.pair, r.family, r.status]),
      [
        ["astra@max", "astra", "passed"],
        ["grok@xhigh", "grok", "passed"],
      ]
    );
    const grok = summary.external.find((r) => r.pair === "grok@xhigh");
    assert.ok(grok?.receiptPath && existsSync(grok.receiptPath));
    assert.equal(grok.promptPath, join(runDir, "probe-grok@xhigh.prompt.md"));
    assert.equal(grok.outputPath, join(runDir, "probe-grok@xhigh.output.md"));
    assert.equal(grok.receiptPath, join(runDir, "probe-grok@xhigh.receipt.json"));
    const receipt = JSON.parse(readFileSync(grok.receiptPath, "utf8"));
    assert.equal(receipt.status, "complete");
    assert.equal(receipt.effort, "xhigh");
    assert.equal(receipt.reportedModel, "grok-4.6-build");
    assert.equal(receipt.mode, "read-only");
    assert.deepEqual(
      summary.native.map((n) => [n.pair, n.family, n.attested]),
      [
        ["fable@max", "fable", false],
        ["opus@xhigh", "opus", false],
      ]
    );
    assert.deepEqual(summary.native[0].native, { primitive: "Agent", agent: "pstack-fable-max" });
    assert.equal(summary.ok, false);
  });

  it("runs one external lane for a family used at two efforts, at the lower effort", async () => {
    const plan = buildPlan({
      parent: "claude",
      home,
      matrix,
      roles: {
        "bug-fix": ["codex:gpt-6-sol@xhigh"],
        hillclimb: ["codex:gpt-6-sol@high"],
      },
    });
    savePlan(runDir, plan);
    const summary = await runProbes(plan, { dir: runDir, env: fakeEnv() });
    assert.equal(summary.externalOk, true);
    const sol = summary.external.filter((r) => r.family === "sol");
    assert.deepEqual(
      sol.map((r) => [r.pair, r.status, r.receiptPath]),
      [["sol@high", "passed", join(runDir, "probe-sol@high.receipt.json")]]
    );
    assert.equal(JSON.parse(readFileSync(sol[0].receiptPath, "utf8")).effort, "high");
  });

  it("runs nothing when every family of the plan is verified", async () => {
    putLedger("claude", ["fable", "opus", "astra", "grok"]);
    const plan = buildPlan({ parent: "claude", home, matrix, efforts: { grok: "high" } });
    savePlan(runDir, plan);
    const summary = await runProbes(plan, { dir: runDir, env: fakeEnv({ FAKE_GROK_UNAUTH: "1" }) });
    assert.deepEqual(summary, { external: [], native: [], externalOk: true, ok: true });
    assert.deepEqual(readdirSync(runDir), ["plan.json"]);
  });

  it("marks a lane failed when its CLI is unauthenticated and keeps the other results", async () => {
    const plan = buildPlan({ parent: "claude", home, matrix });
    savePlan(runDir, plan);
    const summary = await runProbes(plan, { dir: runDir, env: fakeEnv({ FAKE_GROK_UNAUTH: "1" }) });
    assert.equal(summary.externalOk, false);
    const grok = summary.external.find((r) => r.family === "grok");
    assert.equal(grok?.status, "failed");
    assert.match(grok?.detail ?? "", /unauthenticated/);
    assert.equal(summary.external.find((r) => r.family === "astra")?.status, "passed");
  });

  it("fails a lane whose receipt is complete but whose output lacks the marker", async () => {
    const plan = buildPlan({ parent: "codex", home, matrix });
    savePlan(runDir, plan);
    const summary = await runProbes(plan, { dir: runDir, env: fakeEnv({ FAKE_DROP_MARKER: "1" }) });
    assert.equal(summary.externalOk, false);
    for (const result of summary.external) {
      assert.equal(result.status, "failed");
      assert.match(result.detail, /marker/);
    }
  });
});

describe("attestNative", () => {
  it("records a native probe whose observed text carries the marker and refuses otherwise", () => {
    const plan = buildPlan({ parent: "claude", home, matrix });
    savePlan(runDir, plan);
    const fable = plan.pairs.find((p) => p.pair === "fable@max")!;
    const grok = plan.pairs.find((p) => p.pair === "grok@xhigh")!;
    assert.throws(() => attestNative(plan, runDir, "fable@max", "the agent said hello"), /marker/);
    assert.throws(
      () => attestNative(plan, runDir, "grok@xhigh", `x ${grok.marker}`),
      /grok@xhigh is not a native pair of this plan/
    );
    assert.throws(
      () => attestNative(plan, runDir, "sol@high", "x"),
      (error: unknown) =>
        error instanceof SetupError &&
        (error as Error).message ===
          `sol@high is not a pair of this plan; pairs: ${plan.pairs.map((p) => p.pair).join(", ")}`
    );
    const path = attestNative(plan, runDir, "fable@max", `Final message: ${fable.marker}.`);
    const evidence = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(evidence.pair, "fable@max");
    assert.equal(evidence.family, "fable");
    assert.equal(evidence.descriptor, "claude:fable@max");
    assert.equal(evidence.marker, fable.marker);
    assert.deepEqual(evidence.native, { primitive: "Agent", agent: "pstack-fable-max" });
    assert.equal(path, join(runDir, "native-fable@max.json"));
    assert.deepEqual(verifyProbes(plan, runDir).problems.filter((p) => p.startsWith("fable@max ")), []);
  });

  it("lists one native probe for a family used at two efforts, at the lower effort", async () => {
    const plan = buildPlan({
      parent: "claude",
      home,
      matrix,
      roles: { "hardest tasks": ["claude:fable@medium"] },
    });
    savePlan(runDir, plan);
    assert.deepEqual(plan.efforts.fable, ["medium", "max"]);
    const fable = plan.pairs.filter((p) => p.family === "fable");
    assert.deepEqual(
      fable.map((p) => [p.pair, p.native]),
      [["fable@medium", { primitive: "Agent", agent: "pstack-fable-medium" }]]
    );
    await runProbes(plan, { dir: runDir, env: fakeEnv() });
    assert.throws(() => attestNative(plan, runDir, "fable@max", "reply"), /fable@max is not a pair of this plan/);
    assert.equal(verifyProbes(plan, runDir).problems.some((p) => p.startsWith("fable@medium (claude:fable@medium):")), true);
    attestNative(plan, runDir, "fable@medium", `reply ${fable[0].marker}`);
    assert.equal(verifyProbes(plan, runDir).problems.some((p) => p.startsWith("fable@")), false);
  });
});

describe("writeSheet", () => {
  it("refuses to write while any pair lacks a passing probe and creates nothing", async () => {
    const plan = buildPlan({ parent: "claude", home, matrix });
    savePlan(runDir, plan);
    assert.throws(() => writeSheet(plan, runDir, { home }), (error: unknown) => error instanceof SetupError && /probe/.test((error as Error).message));
    assert.equal(existsSync(join(home, ".claude")), false);
    await runProbes(plan, { dir: runDir, env: fakeEnv() });
    assert.throws(() => writeSheet(plan, runDir, { home }), /fable|opus/);
    assert.equal(existsSync(join(home, ".claude")), false);
  });

  it("on a Claude first run creates the sheet, the include, and the ledger, and an unchanged rerun is byte-identical", async () => {
    const plan = await planAndProbe("claude");
    const result = writeSheet(plan, runDir, { home });
    assert.deepEqual([result.sheet, result.integration, result.ledger], ["created", "created", "created"]);
    assert.equal(readFileSync(plan.sheetPath, "utf8"), plan.sheet);
    assert.equal(readFileSync(plan.integrationPath, "utf8"), `${CLAUDE_INCLUDE_LINE}\n`);
    assert.equal(plan.integrationPath, integrationPathFor("claude", home));
    const before = [plan.sheetPath, plan.integrationPath, plan.ledgerPath].map((path) => statSync(path).mtimeMs);

    const again = await planAndProbe("claude");
    assert.equal(again.firstRun, false);
    assert.equal(again.sheet, plan.sheet);
    assert.deepEqual(again.pairs, []);
    const rerun = writeSheet(again, runDir, { home });
    assert.deepEqual([rerun.sheet, rerun.integration, rerun.ledger], ["unchanged", "unchanged", "unchanged"]);
    assert.deepEqual([plan.sheetPath, plan.integrationPath, plan.ledgerPath].map((path) => statSync(path).mtimeMs), before);
    assert.equal(readFileSync(plan.sheetPath, "utf8"), plan.sheet);
  });

  it("records each probed family in the ledger, writes an effort change without probes, and probes only a new family", async () => {
    const plan = await planAndProbe("claude");
    writeSheet(plan, runDir, { home });
    const ledger = JSON.parse(readFileSync(plan.ledgerPath, "utf8"));
    assert.equal(ledger.schemaVersion, 1);
    assert.deepEqual(Object.keys(ledger.families), ["claude:claude-opus-5-5", "claude:fable", "codex:gpt-6-astra", "grok:grok-4.6"]);
    assert.deepEqual(
      { ...ledger.families["grok:grok-4.6"], verifiedAt: "" },
      { family: "grok", descriptor: "grok:grok-4.6@xhigh", verifiedAt: "", evidence: runDir }
    );
    const ledgerText = readFileSync(plan.ledgerPath, "utf8");

    const effortDir = join(home, "effort-run");
    const effort = buildPlan({ parent: "claude", home, matrix, efforts: { grok: "high", opus: "max" } });
    assert.deepEqual(effort.pairs, []);
    savePlan(effortDir, effort);
    const written = writeSheet(effort, effortDir, { home });
    assert.deepEqual([written.sheet, written.ledger], ["updated", "unchanged"]);
    assert.equal(readFileSync(plan.ledgerPath, "utf8"), ledgerText);
    assert.match(readFileSync(plan.sheetPath, "utf8"), /^swarm workers: grok:grok-4\.6@high$/m);
    assert.match(readFileSync(plan.sheetPath, "utf8"), /^bug-fix: claude:claude-opus-5-5@max$/m);

    const solDir = join(home, "sol-run");
    const sol = buildPlan({ parent: "claude", home, matrix, roles: { "swarm workers": ["codex:gpt-6.1-sol@high"] } });
    assert.deepEqual(sol.pairs.map((p) => p.pair), ["sol-6-1@high"]);
    savePlan(solDir, sol);
    assert.throws(() => writeSheet(sol, solDir, { home }), /sol-6-1@high/);
    assert.equal(readFileSync(plan.ledgerPath, "utf8"), ledgerText);
    await runProbes(sol, { dir: solDir, env: fakeEnv() });
    const added = writeSheet(sol, solDir, { home });
    assert.deepEqual([added.sheet, added.ledger], ["updated", "updated"]);
    const after = JSON.parse(readFileSync(plan.ledgerPath, "utf8"));
    assert.deepEqual(Object.keys(after.families), [...Object.keys(ledger.families), "codex:gpt-6.1-sol"].sort());
    assert.deepEqual(after.families["grok:grok-4.6"], ledger.families["grok:grok-4.6"]);
    assert.equal(after.families["codex:gpt-6.1-sol"].descriptor, "codex:gpt-6.1-sol@high");
    assert.equal(writeSheet(sol, solDir, { home }).ledger, "unchanged");
  });

  it("on a mixed sheet creates then reports unchanged without touching mtimes", async () => {
    const plan = await planAndProbe("claude", { roles: { hillclimb: ["grok:grok-4.6@high"] } });
    assert.deepEqual(plan.efforts.grok, ["high", "xhigh"]);
    const result = writeSheet(plan, runDir, { home });
    assert.deepEqual([result.sheet, result.integration], ["created", "created"]);
    assert.equal(readFileSync(plan.sheetPath, "utf8"), plan.sheet);
    const before = [statSync(plan.sheetPath).mtimeMs, statSync(plan.integrationPath).mtimeMs];

    const again = await planAndProbe("claude");
    assert.equal(again.sheet, plan.sheet);
    const rerun = writeSheet(again, runDir, { home });
    assert.deepEqual([rerun.sheet, rerun.integration], ["unchanged", "unchanged"]);
    assert.deepEqual([statSync(plan.sheetPath).mtimeMs, statSync(plan.integrationPath).mtimeMs], before);
  });

  it("appends the include to an existing CLAUDE.md once and treats a duplicate include as inconsistent", async () => {
    const integration = integrationPathFor("claude", home);
    mkdirSync(dirname(integration), { recursive: true });
    writeFileSync(integration, "# mine\n");
    const plan = await planAndProbe("claude");
    const result = writeSheet(plan, runDir, { home });
    assert.equal(result.integration, "updated");
    assert.equal(readFileSync(integration, "utf8"), `# mine\n${CLAUDE_INCLUDE_LINE}\n`);

    writeFileSync(integration, `${CLAUDE_INCLUDE_LINE}\n# mine\n${CLAUDE_INCLUDE_LINE}\n`);
    const again = await planAndProbe("claude", { efforts: { grok: "high" } });
    assert.throws(() => writeSheet(again, runDir, { home }), /include/);
    assert.equal(readFileSync(plan.sheetPath, "utf8"), plan.sheet, "sheet untouched when the integration is inconsistent");
  });

  it("on Codex inserts one bounded block at the end of AGENTS.md and replaces the whole block on a rerun", async () => {
    const integration = integrationPathFor("codex", home);
    mkdirSync(dirname(integration), { recursive: true });
    writeFileSync(integration, "# agents\n\nKeep this.\n");
    const plan = await planAndProbe("codex");
    writeSheet(plan, runDir, { home });
    const expected = `# agents\n\nKeep this.\n${CODEX_BLOCK_BEGIN}\n${plan.sheet}${CODEX_BLOCK_END}\n`;
    assert.equal(readFileSync(integration, "utf8"), expected);

    const changed = await planAndProbe("codex", { efforts: { grok: "high" } });
    const result = writeSheet(changed, runDir, { home });
    assert.deepEqual([result.sheet, result.integration], ["updated", "updated"]);
    const text = readFileSync(integration, "utf8");
    assert.equal(text, `# agents\n\nKeep this.\n${CODEX_BLOCK_BEGIN}\n${changed.sheet}${CODEX_BLOCK_END}\n`);
    assert.equal(text.split(CODEX_BLOCK_BEGIN).length, 2);
    assert.equal(readFileSync(changed.sheetPath, "utf8"), changed.sheet);
  });

  it("reports inconsistent AGENTS.md markers and writes nothing", async () => {
    const integration = integrationPathFor("codex", home);
    mkdirSync(dirname(integration), { recursive: true });
    for (const broken of [
      `${CODEX_BLOCK_BEGIN}\nno end\n`,
      `${CODEX_BLOCK_END}\n${CODEX_BLOCK_BEGIN}\n`,
      `${CODEX_BLOCK_BEGIN}\n${CODEX_BLOCK_END}\n${CODEX_BLOCK_BEGIN}\n${CODEX_BLOCK_END}\n`,
    ]) {
      writeFileSync(integration, broken);
      const plan = await planAndProbe("codex");
      assert.throws(() => writeSheet(plan, runDir, { home }), /marker/);
      assert.equal(existsSync(plan.sheetPath), false);
      assert.equal(readFileSync(integration, "utf8"), broken);
    }
  });

  it("restores every snapshot when the integration write fails after the sheet was written", async () => {
    const plan = await planAndProbe("claude");
    writeSheet(plan, runDir, { home });
    const changed = await planAndProbe("claude", { efforts: { grok: "high" } });
    writeFileSync(changed.integrationPath, "# mine\n");
    chmodSync(changed.integrationPath, 0o444); // the integration write fails with EACCES
    assert.throws(() => writeSheet(changed, runDir, { home }), /every snapshot restored/);
    assert.equal(readFileSync(changed.sheetPath, "utf8"), plan.sheet);
    assert.equal(readFileSync(changed.integrationPath, "utf8"), "# mine\n");
  });

  it("removes a first-run sheet again when the integration write fails", async () => {
    const plan = await planAndProbe("codex");
    mkdirSync(dirname(plan.integrationPath), { recursive: true });
    writeFileSync(plan.integrationPath, "");
    chmodSync(plan.integrationPath, 0o444);
    assert.throws(() => writeSheet(plan, runDir, { home }), /every snapshot restored/);
    assert.equal(existsSync(plan.sheetPath), false);
    assert.equal(existsSync(plan.ledgerPath), false);
  });

  it("restores the sheet and the integration when the ledger write fails", async () => {
    const plan = await planAndProbe("claude");
    mkdirSync(dirname(plan.ledgerPath), { recursive: true });
    writeFileSync(plan.ledgerPath, `{"schemaVersion":1,"families":{}}\n`);
    chmodSync(plan.ledgerPath, 0o444);
    assert.throws(() => writeSheet(plan, runDir, { home }), /every snapshot restored/);
    assert.equal(existsSync(plan.sheetPath), false);
    assert.equal(existsSync(plan.integrationPath), false);
    assert.equal(readFileSync(plan.ledgerPath, "utf8"), `{"schemaVersion":1,"families":{}}\n`);
  });

  it("treats a directory where the sheet or the integration file should be as inconsistent state and writes nothing", async () => {
    const plan = await planAndProbe("claude");
    mkdirSync(plan.integrationPath, { recursive: true });
    assert.throws(() => writeSheet(plan, runDir, { home }), /not a regular file/);
    assert.equal(existsSync(plan.sheetPath), false);
  });
});

// --- Command line ---------------------------------------------------------------

import { spawnSync } from "node:child_process";

const SCRIPT = join(import.meta.dirname, "setup-pstack.ts");

/** Run the script. The environment has no default: every call says whether the fakes are in reach (fakeEnv) or nothing is (noCliEnv). */
function cli(args: string[], env: NodeJS.ProcessEnv) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("command line", () => {
  it("state prints the parent's state as JSON", () => {
    const result = cli(["state", "--parent", "claude", "--home", home], noCliEnv());
    assert.equal(result.code, 0, result.stderr);
    const state = JSON.parse(result.stdout);
    assert.equal(state.exists, false);
    assert.equal(state.sheetPath, join(home, ".claude", "pstack-models.md"));
    assert.equal(state.efforts.grok.status, "unassigned");
  });

  it("plan writes plan.json into the run directory and prints it", () => {
    const result = cli([
      "plan", "--parent", "codex", "--home", home, "--dir", runDir,
      "--effort", "grok=high", "--role", "swarm workers=auto", "--role", "why synthesizer=claude:claude-opus-5-5@xhigh",
    ], noCliEnv());
    assert.equal(result.code, 0, result.stderr);
    const { dir, ...printed } = JSON.parse(result.stdout);
    assert.equal(dir, runDir);
    const saved = JSON.parse(readFileSync(join(runDir, "plan.json"), "utf8"));
    assert.deepEqual(printed, saved);
    assert.equal(saved.parent, "codex");
    assert.equal(saved.schemaVersion, 5);
    assert.deepEqual(saved.efforts.grok, ["high"]);
    assert.deepEqual(saved.rows.find((r: { role: string }) => r.role === "swarm workers").lanes, ["auto"]);
    assert.deepEqual(saved.rows.find((r: { role: string }) => r.role === "why synthesizer").lanes, ["claude:claude-opus-5-5@xhigh"]);
    assert.match(saved.sheet, /^# pstack model configuration\n/);
  });

  it("plan chooses a fresh run directory when --dir is omitted", () => {
    const result = cli(["plan", "--parent", "claude", "--home", home], noCliEnv());
    assert.equal(result.code, 0, result.stderr);
    const printed = JSON.parse(result.stdout);
    assert.ok(typeof printed.dir === "string" && existsSync(join(printed.dir, "plan.json")), result.stdout);
    rmSync(printed.dir, { recursive: true, force: true });
  });

  it("probe runs the external lanes and exits 1 when one fails", () => {
    cli(["plan", "--parent", "claude", "--home", home, "--dir", runDir], noCliEnv());
    const ok = cli(["probe", "--dir", runDir], fakeEnv());
    assert.equal(ok.code, 0, ok.stderr);
    const summary = JSON.parse(ok.stdout);
    assert.equal(summary.externalOk, true);
    assert.equal(summary.native.length, 2);

    rmSync(runDir, { recursive: true, force: true });
    cli(["plan", "--parent", "claude", "--home", home, "--dir", runDir], noCliEnv());
    const failed = cli(["probe", "--dir", runDir], fakeEnv({ FAKE_GROK_UNAUTH: "1" }));
    assert.equal(failed.code, 1);
    assert.equal(JSON.parse(failed.stdout).externalOk, false);
  });

  it("attest records a native probe and write commits only when every probe passed", () => {
    cli(["plan", "--parent", "claude", "--home", home, "--dir", runDir], noCliEnv());
    assert.equal(cli(["probe", "--dir", runDir], fakeEnv()).code, 0);
    const plan = JSON.parse(readFileSync(join(runDir, "plan.json"), "utf8")) as Plan;

    const early = cli(["write", "--dir", runDir, "--home", home], noCliEnv());
    assert.equal(early.code, 1);
    assert.match(early.stderr, /fable/);
    assert.equal(existsSync(plan.sheetPath), false);

    for (const pair of plan.pairs.filter((p) => p.native)) {
      const bad = cli(["attest", "--dir", runDir, "--pair", pair.pair, "--observed", "no token here"], noCliEnv());
      assert.equal(bad.code, 1);
      const good = cli(["attest", "--dir", runDir, "--pair", pair.pair, "--observed", `reply ${pair.marker}`], noCliEnv());
      assert.equal(good.code, 0, good.stderr);
    }
    const written = cli(["write", "--dir", runDir, "--home", home], noCliEnv());
    assert.equal(written.code, 0, written.stderr);
    const result = JSON.parse(written.stdout);
    assert.deepEqual([result.sheet, result.integration, result.ledger], ["created", "created", "created"]);
    assert.equal(readFileSync(plan.sheetPath, "utf8"), plan.sheet);

    const again = JSON.parse(cli(["write", "--dir", runDir, "--home", home], noCliEnv()).stdout);
    assert.deepEqual([again.sheet, again.integration, again.ledger], ["unchanged", "unchanged", "unchanged"]);
  });

  it("rejects a bad subcommand, a malformed --effort, and a missing --parent with exit 64 and usage", () => {
    for (const args of [["frobnicate"], ["plan", "--parent", "claude", "--effort", "grok"], ["plan", "--home", home], ["probe", "--dir", runDir, "--repo", "acme/app", "--pr", "7"], []]) {
      const result = cli(args, noCliEnv());
      assert.equal(result.code, 64, JSON.stringify(args));
      assert.match(result.stderr, /Usage: setup-pstack/);
    }
    const help = cli(["--help"], noCliEnv());
    assert.equal(help.code, 0);
    assert.match(help.stdout, /Usage: setup-pstack/);
    assert.match(help.stdout, /--pair <family>@<effort>/);
    assert.doesNotMatch(help.stdout, /--family <family>/);
  });

  it("attest --pair records a native probe and attest --family is unknown", () => {
    cli(["plan", "--parent", "claude", "--home", home, "--dir", runDir], noCliEnv());
    const plan = JSON.parse(readFileSync(join(runDir, "plan.json"), "utf8")) as Plan;
    const fable = plan.pairs.find((p) => p.pair === "fable@max")!;
    const unknown = cli(["attest", "--dir", runDir, "--family", "fable", "--observed", `reply ${fable.marker}`], noCliEnv());
    assert.equal(unknown.code, 64, unknown.stderr);
    assert.match(unknown.stderr, /Usage: setup-pstack/);
    const good = cli(["attest", "--dir", runDir, "--pair", "fable@max", "--observed", `reply ${fable.marker}`], noCliEnv());
    assert.equal(good.code, 0, good.stderr);
    const printed = JSON.parse(good.stdout);
    assert.equal(printed.pair, "fable@max");
    assert.equal(printed.evidencePath, join(runDir, "native-fable@max.json"));
  });

  it("probe refuses a plan.json from the previous schema", () => {
    assert.equal(cli(["plan", "--parent", "claude", "--home", home, "--dir", runDir], noCliEnv()).code, 0);
    const path = join(runDir, "plan.json");
    const current = JSON.parse(readFileSync(path, "utf8")) as Plan;
    writeFileSync(path, `${JSON.stringify({ ...current, schemaVersion: 4, warnings: [] }, null, 2)}\n`);
    const result = cli(["probe", "--dir", runDir], noCliEnv());
    assert.equal(result.code, 1);
    assert.match(result.stderr, /plan/);
    assert.match(result.stderr, /run plan again with this version of the script/);
    assert.deepEqual(readdirSync(runDir), ["plan.json"], "no probe lane ran");
    assert.equal(existsSync(join(home, ".claude", "pstack-models.md")), false);
  });
});
