import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  pickLane,
  sheetPathFor,
  type ConfigEnv,
  type Plan,
  type State,
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
    assert.deepEqual(
      state.efforts["grok-4-7"],
      { status: "current", efforts: ["xhigh"], rows: [{ role: "trail reviewer pool", lane: "grok:grok-4.7@xhigh" }] },
      "on a first run only the trail reviewer pool names 4.7"
    );
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
  it("plans a Grok root with pinned native definitions and external Claude and Codex lanes", () => {
    const plan = buildPlan({ parent: "grok", home, matrix });
    assert.equal(plan.sheetPath, join(home, ".grok", "pstack-models.md"));
    assert.equal(plan.integrationPath, join(home, ".grok", "AGENTS.md"));
    assert.deepEqual(lanesOf(plan, "feature, refactoring"), ["grok:grok-4.7@xhigh"]);
    assert.deepEqual(lanesOf(plan, "how explainer"), ["grok:grok-4.7@xhigh"]);
    assert.deepEqual(plan.pairs.filter((p) => p.provider === "grok").map((p) => p.native), [
      { primitive: "spawn_subagent", agent: "pstack-grok-xhigh", ownerAgent: "pstack-owner-grok-xhigh" },
      { primitive: "spawn_subagent", agent: "pstack-grok-4-7-xhigh", ownerAgent: "pstack-owner-grok-4-7-xhigh" },
    ]);
    assert.ok(plan.pairs.filter((p) => p.provider !== "grok").every((p) => p.route === "runner" && p.native === null));
  });
  it("on a first run takes the parent's role defaults, the matrix default efforts, and one probe per family in the map", () => {
    const plan = buildPlan({ parent: "claude", home, matrix });
    assert.equal(plan.sheet, firstRunSheet("claude"));
    assert.equal(plan.schemaVersion, 7);
    assert.equal(plan.ledgerPath, join(home, ".claude", "pstack-probes.json"));
    assert.deepEqual(plan.verified, []);
    assert.deepEqual(plan.efforts, {
      fable: ["max"],
      opus: ["xhigh"],
      "sol-6-1": ["xhigh"],
      astra: ["max"],
      grok: ["xhigh"],
      "grok-4-7": ["xhigh"],
    });
    assert.deepEqual(
      plan.pairs.map((p) => [p.family, p.pair, p.descriptor, p.route]),
      [
        ["fable", "fable@max", "claude:fable@max", "native"],
        ["opus", "opus@xhigh", "claude:claude-opus-5-5@xhigh", "native"],
        ["sol-6-1", "sol-6-1@xhigh", "codex:gpt-6.1-sol@xhigh", "runner"],
        ["astra", "astra@max", "codex:gpt-6-astra@max", "runner"],
        ["grok", "grok@xhigh", "grok:grok-4.6@xhigh", "runner"],
        ["grok-4-7", "grok-4-7@xhigh", "grok:grok-4.7@xhigh", "runner"],
      ]
    );
    assert.deepEqual(plan.warnings, []);
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
      () => buildPlan({ parent: "claude", home, matrix, efforts: { sol: "high" } }),
      (error: unknown) =>
        error instanceof SetupError &&
        (error as Error).message ===
          "sol is outside the role map; nothing to rewrite. Write the effort in a role's descriptor (--role) or drop --effort sol"
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
        "swarm workers": ["codex:gpt-6-sol@high"],
        "why synthesizer": ["auto"],
      },
    });
    assert.deepEqual(lanesOf(plan, "swarm workers"), ["codex:gpt-6-sol@high"]);
    assert.deepEqual(lanesOf(plan, "why synthesizer"), ["auto"]);
    assert.deepEqual(lanesOf(plan, "bug-fix"), ["claude:claude-opus-5-5@xhigh"]);
    assert.deepEqual(plan.efforts.sol, ["high"]);
    assert.equal(plan.pairs.find((p) => p.pair === "sol@high")?.route, "runner");
    assert.deepEqual(
      plan.pairs.map((p) => p.pair),
      ["fable@max", "opus@xhigh", "sol@high", "sol-6-1@xhigh", "astra@max", "grok@xhigh", "grok-4-7@xhigh"]
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
    putLedger("claude", ["fable", "opus", "sol-6-1", "astra", "grok", "grok-4-7"]);
    const effortsOnly = buildPlan({ parent: "claude", home, matrix, efforts: { grok: "high", fable: "medium" } });
    assert.deepEqual(effortsOnly.efforts.grok, ["high"]);
    assert.deepEqual(effortsOnly.pairs, []);
    assert.deepEqual(
      effortsOnly.verified.map((v) => [v.family, `${v.provider}:${v.model}`, v.verifiedAt]),
      [
        ["fable", "claude:fable", "2026-09-24T00:00:00.000Z"],
        ["opus", "claude:claude-opus-5-5", "2026-09-24T00:00:00.000Z"],
        ["sol-6-1", "codex:gpt-6.1-sol", "2026-09-24T00:00:00.000Z"],
        ["astra", "codex:gpt-6-astra", "2026-09-24T00:00:00.000Z"],
        ["grok", "grok:grok-4.6", "2026-09-24T00:00:00.000Z"],
        ["grok-4-7", "grok:grok-4.7", "2026-09-24T00:00:00.000Z"],
      ]
    );

    const newFamilies = buildPlan({
      parent: "claude",
      home,
      matrix,
      roles: { "bug-fix": ["grok:grok-4.7@high"], "swarm workers": ["codex:gpt-6-sol@high"] },
    });
    assert.deepEqual(newFamilies.efforts["grok-4-7"], ["high", "xhigh"]);
    assert.deepEqual(
      newFamilies.pairs.map((p) => [p.pair, p.descriptor, p.route]),
      [["sol@high", "codex:gpt-6-sol@high", "runner"]],
      "sol is new to this parent; grok-4-7 is verified, so a new effort of it needs no probe"
    );
    assert.equal(newFamilies.verified.some((v) => v.family === "sol"), false);
  });

  it("probes a new model of a verified family and keeps one parent's ledger from verifying the other", () => {
    putLedger("claude", ["fable", "opus", "sol-6-1", "astra", "grok", "grok-4-7"]);
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
      ["fable@max", "opus@xhigh", "sol@xhigh", "sol-6-1@xhigh", "astra@max", "grok@xhigh", "grok-4-7@xhigh"]
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
    assert.deepEqual(
      state.efforts["grok-4-7"].rows,
      [{ role: "trail reviewer pool", lane: "grok:grok-4.7@xhigh" }],
      "the retired rows' grok-4.7 lanes are not part of the map"
    );
    assert.deepEqual(state.efforts.sol.rows, [{ role: "bug-fix", lane: "codex:gpt-6-sol@high" }]);
    const plan = buildPlan({ parent: "claude", home, matrix });
    assert.equal(plan.sheet, customized);
    assert.deepEqual(lanesOf(plan, "bug-fix"), ["codex:gpt-6-sol@high"]);
    assert.deepEqual(
      plan.pairs.map((p) => p.pair),
      ["fable@max", "opus@xhigh", "sol@high", "sol-6-1@xhigh", "astra@max", "grok@xhigh", "grok-4-7@xhigh"]
    );
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

  it("refuses a trail reviewer pool that can never yield a lane: an alias, or only the parent's own provider", () => {
    assert.throws(
      () => buildPlan({ parent: "claude", home, matrix, roles: { "trail reviewer pool": ["codex:gpt-6.1-sol@xhigh", "inherit-parent"] } }),
      (error: unknown) =>
        error instanceof SetupError &&
        (error as Error).message ===
          'role "trail reviewer pool" takes provider-qualified lanes only: inherit-parent runs on the parent model, which never reviews its own work'
    );
    assert.throws(
      () => buildPlan({ parent: "codex", home, matrix, roles: { "trail reviewer pool": ["codex:gpt-6.1-sol@xhigh", "codex:gpt-6-astra@max"] } }),
      (error: unknown) =>
        error instanceof SetupError &&
        (error as Error).message ===
          'role "trail reviewer pool" needs at least one lane from a provider other than codex, the parent\'s own; got codex:gpt-6.1-sol@xhigh, codex:gpt-6-astra@max'
    );
    const sameRowOnClaude = buildPlan({ parent: "claude", home, matrix, roles: { "trail reviewer pool": ["codex:gpt-6.1-sol@xhigh", "codex:gpt-6-astra@max"] } });
    assert.deepEqual(lanesOf(sameRowOnClaude, "trail reviewer pool"), ["codex:gpt-6.1-sol@xhigh", "codex:gpt-6-astra@max"]);
    assert.doesNotThrow(() => buildPlan({ parent: "claude", home, matrix, roles: { "arena cross-judge pool": ["inherit-parent"] } }));
  });

  it("refuses to plan over a hand-edited sheet whose trail reviewer pool holds an alias", () => {
    putSheet("claude", "trail reviewer pool: auto, grok:grok-4.7@xhigh\n");
    assert.throws(() => buildPlan({ parent: "claude", home, matrix }), /auto runs on the parent model/);
    const fixed = buildPlan({ parent: "claude", home, matrix, roles: { "trail reviewer pool": ["grok:grok-4.7@xhigh", "codex:gpt-6.1-sol@high"] } });
    assert.deepEqual(lanesOf(fixed, "trail reviewer pool"), ["grok:grok-4.7@xhigh", "codex:gpt-6.1-sol@high"]);
    assert.deepEqual(fixed.warnings, []);
  });

  it("warns when the trail reviewer pool names one provider besides the parent's", () => {
    const plan = buildPlan({ parent: "claude", home, matrix, roles: { "trail reviewer pool": ["claude:claude-opus-5-5@xhigh", "grok:grok-4.7@xhigh"] } });
    assert.deepEqual(plan.warnings, [
      'role "trail reviewer pool" names one provider besides claude (grok): a run in which a grok lane wrote has no eligible lane',
    ]);
    assert.deepEqual(buildPlan({ parent: "codex", home, matrix }).warnings, []);
  });

  it("on a rerun adds the trail reviewer pool to a sheet written before the role existed, at the end, changing no other line", () => {
    const older = firstRunSheet("codex").replace(/^trail reviewer pool: .*\n/m, "");
    assert.doesNotMatch(older, /trail reviewer pool/);
    putSheet("codex", older);
    const plan = buildPlan({ parent: "codex", home, matrix });
    assert.equal(plan.sheet, `${older}trail reviewer pool: claude:claude-opus-5-5@xhigh, codex:gpt-6.1-sol@xhigh, grok:grok-4.7@xhigh\n`);
  });
});

describe("pickLane", () => {
  it("excludes a Grok root and its implementation providers from the reviewer pool", () => {
    const result = pickLane({ parent: "grok", home, matrix, role: "trail reviewer pool", executors: ["claude"] });
    assert.deepEqual(result.executors, ["grok", "claude"]);
    assert.equal(result.chosen?.descriptor, "codex:gpt-6.1-sol@xhigh");
    assert.equal(result.chosen?.route, "runner");
    assert.deepEqual(result.eligible.map((lane) => lane.provider), ["codex"]);
  });
  const pick = (parent: string, executors: string[] = []) => pickLane({ parent, home, matrix, role: "trail reviewer pool", executors });

  it("without the row in the sheet uses the role-table default and says so", () => {
    putSheet("claude", "bug-fix: claude:claude-opus-5-5@xhigh\n");
    const fromDefault = pick("claude");
    assert.equal(fromDefault.source, "default");
    assert.deepEqual(fromDefault.lanes, ["claude:claude-opus-5-5@xhigh", "codex:gpt-6.1-sol@xhigh", "grok:grok-4.7@xhigh"]);
    assert.equal(fromDefault.chosen?.descriptor, "codex:gpt-6.1-sol@xhigh");
    assert.equal(pick("codex").source, "default", "no sheet at all");
    assert.equal(pick("codex").chosen?.descriptor, "claude:claude-opus-5-5@xhigh");
  });

  it("reads the operator's row in its order, with each lane's effort as written", () => {
    putSheet("claude", "trail reviewer pool: grok:grok-4.7@high, codex:gpt-6.1-sol@xhigh, claude:claude-opus-5-5@xhigh\n");
    const result = pick("claude");
    assert.equal(result.source, "sheet");
    assert.deepEqual(result.eligible.map((l) => l.descriptor), ["grok:grok-4.7@high", "codex:gpt-6.1-sol@xhigh"]);
    assert.deepEqual(result.chosen, { descriptor: "grok:grok-4.7@high", provider: "grok", model: "grok-4.7", effort: "high", route: "runner" });
    assert.equal(pick("claude", ["grok"]).chosen?.descriptor, "codex:gpt-6.1-sol@xhigh");
  });

  it("normalizes a legacy descriptor before it compares providers", () => {
    putSheet("codex", "trail reviewer pool: codex:gpt-5.6-sol@xhigh, claude:claude-opus-5@xhigh\n");
    const result = pick("codex");
    assert.deepEqual(result.lanes, ["codex:gpt-6-sol@xhigh", "claude:claude-opus-5-5@xhigh"]);
    assert.equal(result.chosen?.descriptor, "claude:claude-opus-5-5@xhigh");
    assert.deepEqual(result.skipped, [{ lane: "codex:gpt-6-sol@xhigh", reason: "same family: codex wrote part of the work" }]);
  });

  it("skips a hand-edited alias instead of dispatching it, and yields no lane when nothing else is left", () => {
    putSheet("claude", "trail reviewer pool: inherit-parent, claude:fable@max\n");
    const result = pick("claude");
    assert.equal(result.chosen, null);
    assert.deepEqual(result.skipped, [
      { lane: "inherit-parent", reason: "alias: runs on the parent model" },
      { lane: "claude:fable@max", reason: "same family: claude wrote part of the work" },
    ]);
  });

  it("serves the arena pool with the same rule, and refuses an unknown role, executor, or an effort the family lacks", () => {
    const arena = pickLane({ parent: "claude", home, matrix, role: "arena cross-judge pool", executors: ["codex"] });
    assert.equal(arena.chosen?.descriptor, "grok:grok-4.6@xhigh");
    assert.throws(() => pickLane({ parent: "claude", home, matrix, role: "trail reviewers" }), /unknown role "trail reviewers"/);
    assert.throws(() => pick("claude", ["cursor"]), /unknown provider "cursor"/);
    putSheet("claude", "trail reviewer pool: grok:grok-4.7@max\n");
    assert.throws(() => pick("claude"), /grok-4-7 does not select effort max/);
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
import { appendFileSync, readFileSync, writeSync } from "node:fs";
if (process.env.FAKE_INVOCATION_LOG) appendFileSync(process.env.FAKE_INVOCATION_LOG, process.argv.slice(1).join(" ") + "\\n");
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
async function planAndProbe(parent: string, input: { efforts?: Record<string, string>; roles?: Record<string, string[]>; env?: ConfigEnv } = {}) {
  const plan = buildPlan({ parent, home, matrix, ...input });
  rmSync(runDir, { recursive: true, force: true });
  savePlan(runDir, plan);
  const summary = await runProbes(plan, { dir: runDir, env: fakeEnv() });
  assert.equal(summary.externalOk, true, JSON.stringify(summary, null, 2));
  for (const pair of plan.pairs) {
    if (pair.native) attestNative(plan, runDir, pair.pair, `The agent replied: ${pair.marker}`,
      pair.native.primitive === "spawn_subagent" ? { ownerId: `owner-${pair.pair}`, childId: `helper-${pair.pair}` } : undefined);
  }
  if (plan.ownerProbe) attestNative(plan, runDir, "owner-nesting", plan.ownerProbe.marker, { ownerId: "owner", childId: "helper" });
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
        ["sol-6-1@xhigh", "sol-6-1", "passed"],
        ["astra@max", "astra", "passed"],
        ["grok@xhigh", "grok", "passed"],
        ["grok-4-7@xhigh", "grok-4-7", "passed"],
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
    putLedger("claude", ["fable", "opus", "sol-6-1", "astra", "grok", "grok-4-7"]);
    const plan = buildPlan({ parent: "claude", home, matrix, efforts: { grok: "high" } });
    savePlan(runDir, plan);
    const summary = await runProbes(plan, { dir: runDir, env: fakeEnv({ FAKE_GROK_UNAUTH: "1" }) });
    assert.deepEqual(summary, { external: [], native: [], owner: null, externalOk: true, ok: true });
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

  for (const stream of ["stdout", "stderr"]) {
    it(`refuses a leftover ${stream} sidecar before running any lane`, async () => {
      const plan = buildPlan({ parent: "claude", home, matrix });
      savePlan(runDir, plan);
      const leftover = join(runDir, `probe-grok@xhigh.receipt.json.${stream}`);
      writeFileSync(leftover, "previous run");
      await assert.rejects(runProbes(plan, { dir: runDir, env: fakeEnv() }), {
        message: `${leftover} already exists; use a fresh run directory or remove the previous probe artifacts`,
      });
      assert.deepEqual(readdirSync(runDir).sort(), ["plan.json", `probe-grok@xhigh.receipt.json.${stream}`]);
    });

    it(`refuses a dangling ${stream} sidecar before invoking any provider`, async () => {
      const plan = buildPlan({ parent: "claude", home, matrix });
      assert.ok(plan.pairs.filter((pair) => pair.route === "runner").length >= 2);
      savePlan(runDir, plan);
      const leftover = join(runDir, `probe-grok@xhigh.receipt.json.${stream}`);
      const target = join(home, "missing-stream");
      const invocations = join(home, "provider-invocations.log");
      symlinkSync(target, leftover);
      await assert.rejects(runProbes(plan, { dir: runDir, env: fakeEnv({ FAKE_INVOCATION_LOG: invocations }) }), {
        message: `${leftover} already exists; use a fresh run directory or remove the previous probe artifacts`,
      });
      assert.equal(existsSync(invocations), false);
      assert.equal(lstatSync(leftover).isSymbolicLink(), true);
      assert.equal(readlinkSync(leftover), target);
      assert.deepEqual(readdirSync(runDir).sort(), ["plan.json", `probe-grok@xhigh.receipt.json.${stream}`]);
    });
  }
});

describe("attestNative", () => {
  it("refuses a Grok write until owner → helper evidence exists and rejects a single handle", async () => {
    const plan = buildPlan({ parent: "grok", home, matrix });
    const summary = await runProbes(plan, { dir: runDir, env: fakeEnv() });
    assert.ok(summary.native.every((p) => p.prompt.includes("Spawn exactly one")));
    for (const pair of plan.pairs.filter((p) => p.native !== null)) {
      assert.throws(() => attestNative(plan, runDir, pair.pair, pair.marker), /owner → helper/);
      assert.throws(() => attestNative(plan, runDir, pair.pair, pair.marker, { ownerId: "same", childId: "same" }), /distinct/);
      const path = attestNative(plan, runDir, pair.pair, pair.marker, { ownerId: "owner", childId: "helper" });
      const evidence = JSON.parse(readFileSync(path, "utf8"));
      delete evidence.chain;
      writeFileSync(path, JSON.stringify(evidence));
    }
    assert.throws(() => writeSheet(plan, runDir, { home }), /owner → helper/);
    assert.equal(existsSync(plan.sheetPath), false);
    for (const pair of plan.pairs.filter((p) => p.native !== null)) {
      attestNative(plan, runDir, pair.pair, pair.marker, { ownerId: "owner", childId: "helper" });
    }
    assert.ok(plan.ownerProbe);
    assert.throws(() => writeSheet(plan, runDir, { home }), /current root capability not attested/);
    attestNative(plan, runDir, "owner-nesting", plan.ownerProbe.marker, { ownerId: "owner", childId: "helper" });
    assert.equal(writeSheet(plan, runDir, { home }).sheet, "created");
  });
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
  it("writes a Grok sheet only after its native and external probes, preserving global rules on reruns", async () => {
    const plan = await planAndProbe("grok");
    const integration = integrationPathFor("grok", home);
    mkdirSync(dirname(integration), { recursive: true });
    writeFileSync(integration, "Keep these global Grok rules.\n");
    const result = writeSheet(plan, runDir, { home });
    assert.equal(result.sheet, "created");
    assert.equal(readFileSync(integration, "utf8"), `Keep these global Grok rules.\n${CODEX_BLOCK_BEGIN}\n${plan.sheet}${CODEX_BLOCK_END}\n`);
    assert.equal(existsSync(sheetPathFor("claude", home)), false);
    assert.equal(existsSync(ledgerPathFor("codex", home)), false);
    const again = buildPlan({ parent: "grok", home, matrix });
    assert.equal(again.pairs.length, 0);
    assert.ok(again.ownerProbe);
    assert.throws(() => writeSheet(again, runDir, { home }), /fresh capability marker/);
    assert.throws(() => attestNative(again, runDir, "owner-nesting", again.ownerProbe!.marker), /owner → helper/);
    attestNative(again, runDir, "owner-nesting", again.ownerProbe.marker, { ownerId: "new-owner", childId: "new-helper" });
    const rerun = writeSheet(again, runDir, { home });
    assert.equal(rerun.sheet, "unchanged");
    assert.equal(rerun.integration, "unchanged");
    assert.equal(rerun.ledger, "unchanged");
  });
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
    assert.deepEqual(
      Object.keys(ledger.families),
      ["claude:claude-opus-5-5", "claude:fable", "codex:gpt-6-astra", "codex:gpt-6.1-sol", "grok:grok-4.6", "grok:grok-4.7"]
    );
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
    const sol = buildPlan({ parent: "claude", home, matrix, roles: { "swarm workers": ["codex:gpt-6-sol@high"] } });
    assert.deepEqual(sol.pairs.map((p) => p.pair), ["sol@high"]);
    savePlan(solDir, sol);
    assert.throws(() => writeSheet(sol, solDir, { home }), /sol@high/);
    assert.equal(readFileSync(plan.ledgerPath, "utf8"), ledgerText);
    await runProbes(sol, { dir: solDir, env: fakeEnv() });
    const added = writeSheet(sol, solDir, { home });
    assert.deepEqual([added.sheet, added.ledger], ["updated", "updated"]);
    const after = JSON.parse(readFileSync(plan.ledgerPath, "utf8"));
    assert.deepEqual(Object.keys(after.families), [...Object.keys(ledger.families), "codex:gpt-6-sol"].sort());
    assert.deepEqual(after.families["grok:grok-4.6"], ledger.families["grok:grok-4.6"]);
    assert.equal(after.families["codex:gpt-6-sol"].descriptor, "codex:gpt-6-sol@high");
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

    const again = await planAndProbe("claude", { efforts: { grok: "high" } });
    const duplicated = `${CLAUDE_INCLUDE_LINE}\n# mine\n- @./pstack-models.md\n`;
    writeFileSync(integration, duplicated);
    const stop = { message: `inconsistent state: ${integration} imports pstack-models.md 2 times (lines 1, 3); keep exactly one import` };
    assert.throws(() => writeSheet(again, runDir, { home }), stop);
    assert.throws(() => loadState({ parent: "claude", home, matrix }), stop);
    assert.equal(readFileSync(plan.sheetPath, "utf8"), plan.sheet, "sheet untouched when the integration is inconsistent");
    assert.equal(readFileSync(integration, "utf8"), duplicated);
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

  it("reports inconsistent AGENTS.md markers in state and in write, and writes nothing", async () => {
    const plan = await planAndProbe("codex");
    const integration = plan.integrationPath;
    mkdirSync(dirname(integration), { recursive: true });
    for (const [broken, problem] of [
      [`${CODEX_BLOCK_BEGIN}\nno end\n`, "has 1 begin and 0 end markers; expected exactly one pstack:models block"],
      [`${CODEX_BLOCK_END}\n${CODEX_BLOCK_BEGIN}\n`, "pstack:models markers are reversed"],
      [`${CODEX_BLOCK_BEGIN}\n${CODEX_BLOCK_END}\n${CODEX_BLOCK_BEGIN}\n${CODEX_BLOCK_END}\n`, "has 2 begin and 2 end markers; expected exactly one pstack:models block"],
    ]) {
      writeFileSync(integration, broken);
      const stop = { message: `${integration} ${problem}` };
      assert.throws(() => loadState({ parent: "codex", home, matrix }), stop);
      assert.throws(() => writeSheet(plan, runDir, { home }), stop);
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

import { configHomeFor } from "./setup-pstack.ts";

function sheetWithHighHillclimb(): string {
  return firstRunSheet("claude").replace("hillclimb: claude:claude-opus-5-5@xhigh", "hillclimb: claude:claude-opus-5-5@high");
}

function put(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

describe("configHomeFor", () => {
  it("takes CLAUDE_CONFIG_DIR or a non-empty CODEX_HOME, treats an empty CODEX_HOME as unset, and keeps Grok under the home", () => {
    const cfg = join(home, "claude # config");
    const codex = join(home, "codex home");
    assert.equal(configHomeFor("claude", home, { CLAUDE_CONFIG_DIR: cfg }), cfg);
    assert.equal(configHomeFor("claude", home, {}), join(home, ".claude"));
    assert.equal(configHomeFor("codex", home, { CODEX_HOME: codex }), codex);
    assert.equal(configHomeFor("codex", home, { CODEX_HOME: "", CLAUDE_CONFIG_DIR: cfg }), join(home, ".codex"));
    assert.equal(configHomeFor("grok", home, { CLAUDE_CONFIG_DIR: cfg, CODEX_HOME: codex }), join(home, ".grok"));
    assert.equal(sheetPathFor("claude", home, { CLAUDE_CONFIG_DIR: cfg }), join(cfg, "pstack-models.md"));
    assert.equal(integrationPathFor("codex", home, { CODEX_HOME: codex }), join(codex, "AGENTS.md"));
    assert.equal(ledgerPathFor("claude", home, { CLAUDE_CONFIG_DIR: cfg }), join(cfg, "pstack-probes.json"));
  });

  it("refuses a variable that is not an absolute path", () => {
    for (const value of ["relative/dir", "~/.claude-work", "   "]) {
      assert.throws(() => configHomeFor("claude", home, { CLAUDE_CONFIG_DIR: value }), { message: `CLAUDE_CONFIG_DIR must be an absolute path; got ${JSON.stringify(value)}` });
    }
    assert.throws(() => loadState({ parent: "codex", home, matrix, env: { CODEX_HOME: "codex" } }), { message: 'CODEX_HOME must be an absolute path or empty; got "codex"' });
  });

  it("refuses an empty CLAUDE_CONFIG_DIR, which Claude Code reads as the directory it starts in", () => {
    const empty = "CLAUDE_CONFIG_DIR is empty; Claude Code 2.1.289 then reads settings.json and CLAUDE.md from the directory it starts in, not from ~/.claude, so unset it or set it to an absolute path";
    const env = { CLAUDE_CONFIG_DIR: "" };
    assert.throws(() => configHomeFor("claude", home, env), { message: empty });
    assert.throws(() => loadState({ parent: "claude", home, matrix, env }), { message: empty });
    assert.throws(() => buildPlan({ parent: "claude", home, matrix, env }), { message: empty });
    assert.equal(configHomeFor("codex", home, { CLAUDE_CONFIG_DIR: "", CODEX_HOME: "" }), join(home, ".codex"));
  });

  it("reads no variable of the test process: only an env the caller passes moves a path", () => {
    const previous = { claude: process.env.CLAUDE_CONFIG_DIR, codex: process.env.CODEX_HOME };
    process.env.CLAUDE_CONFIG_DIR = join(home, "decoy-claude");
    process.env.CODEX_HOME = join(home, "decoy-codex");
    try {
      assert.equal(loadState({ parent: "claude", home, matrix }).sheetPath, join(home, ".claude", "pstack-models.md"));
      assert.equal(buildPlan({ parent: "codex", home, matrix }).sheetPath, join(home, ".codex", "pstack-models.md"));
    } finally {
      for (const [key, value] of [["CLAUDE_CONFIG_DIR", previous.claude], ["CODEX_HOME", previous.codex]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe("writeSheet in a redirected config home", () => {
  it("writes the Claude sheet, the ledger and a sibling import under CLAUDE_CONFIG_DIR, and nothing under <home>/.claude", async () => {
    const cfg = join(home, "claude # config");
    const env = { CLAUDE_CONFIG_DIR: cfg };
    const plan = await planAndProbe("claude", { env });
    assert.equal(plan.sheetPath, join(cfg, "pstack-models.md"));
    const result = writeSheet(plan, runDir, { home, env });
    assert.deepEqual([result.sheet, result.integration, result.ledger], ["created", "created", "created"]);
    assert.equal(readFileSync(join(cfg, "pstack-models.md"), "utf8"), plan.sheet);
    assert.equal(readFileSync(join(cfg, "CLAUDE.md"), "utf8"), "@./pstack-models.md\n");
    assert.ok(existsSync(join(cfg, "pstack-probes.json")));
    assert.equal(existsSync(join(home, ".claude")), false);

    const bytes = ["pstack-models.md", "CLAUDE.md", "pstack-probes.json"].map((file) => readFileSync(join(cfg, file), "utf8"));
    const again = await planAndProbe("claude", { env });
    assert.deepEqual(again.pairs, []);
    const rerun = writeSheet(again, runDir, { home, env });
    assert.deepEqual([rerun.sheet, rerun.integration, rerun.ledger], ["unchanged", "unchanged", "unchanged"]);
    assert.deepEqual(["pstack-models.md", "CLAUDE.md", "pstack-probes.json"].map((file) => readFileSync(join(cfg, file), "utf8")), bytes);
  });

  it("writes the Codex sheet, the ledger and the AGENTS.md block under CODEX_HOME", async () => {
    const codex = join(home, "codex home");
    const env = { CODEX_HOME: codex };
    const plan = await planAndProbe("codex", { env });
    writeSheet(plan, runDir, { home, env });
    assert.equal(readFileSync(join(codex, "pstack-models.md"), "utf8"), plan.sheet);
    assert.equal(readFileSync(join(codex, "AGENTS.md"), "utf8"), `${CODEX_BLOCK_BEGIN}\n${plan.sheet}${CODEX_BLOCK_END}\n`);
    assert.ok(existsSync(join(codex, "pstack-probes.json")));
    assert.equal(existsSync(join(home, ".codex")), false);
  });

  it("refuses to write with an empty CLAUDE_CONFIG_DIR and leaves the default home alone", async () => {
    const plan = await planAndProbe("claude");
    assert.throws(() => writeSheet(plan, runDir, { home, env: { CLAUDE_CONFIG_DIR: "" } }), { message: /^CLAUDE_CONFIG_DIR is empty; / });
    assert.equal(existsSync(join(home, ".claude")), false);
  });

  it("keeps the legacy include when CLAUDE_CONFIG_DIR names the default home", async () => {
    const env = { CLAUDE_CONFIG_DIR: join(home, ".claude") };
    const plan = await planAndProbe("claude", { env });
    writeSheet(plan, runDir, { home, env });
    assert.equal(readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8"), "@~/.claude/pstack-models.md\n");
    const unset = await planAndProbe("claude");
    assert.equal(writeSheet(unset, runDir, { home }).integration, "unchanged");
  });

  it("refuses a write whose config home differs from the plan's, before checking probes or writing", async () => {
    const cfg = join(home, "cfg");
    const plan = await planAndProbe("claude", { env: { CLAUDE_CONFIG_DIR: cfg } });
    assert.throws(
      () => writeSheet(plan, runDir, { home }),
      { message: `${join(runDir, "plan.json")} was made for the config home ${cfg}, but this write resolves ${join(home, ".claude")}; run write with the --home and CLAUDE_CONFIG_DIR that plan used, or run plan again` }
    );
    assert.equal(existsSync(cfg), false);
    assert.equal(existsSync(join(home, ".claude")), false);
  });
});

describe("the Claude sheet import", () => {
  for (const [lineEnd, label] of [["\n", "LF"], ["\r\n", "CRLF"]]) {
    for (const prefix of ["", "- models: ", "> "]) {
      it(`carries and replaces a plain import with a literal @ in its directory, ${label} and ${JSON.stringify(prefix)}`, async () => {
        const cfg = join(home, "cfg");
        const env = { CLAUDE_CONFIG_DIR: cfg };
        const imported = put(join(cfg, "at@literal", "pstack-models.md"), sheetWithHighHillclimb());
        const other = put(join(cfg, "other.md"), "Other instructions.\n");
        const before = `# mine${lineEnd}${prefix}@./at@literal/pstack-models.md${lineEnd}${lineEnd}@./other.md${lineEnd}`;
        const integration = put(join(cfg, "CLAUDE.md"), before);
        const state = loadState({ parent: "claude", home, env, matrix });
        assert.deepEqual(state.source, { kind: "import", path: imported });
        assert.deepEqual(state.rows.find((row) => row.role === "hillclimb")?.lanes, ["claude:claude-opus-5-5@high"]);

        const plan = await planAndProbe("claude", { env });
        writeSheet(plan, runDir, { home, env });
        assert.equal(readFileSync(integration, "utf8"), `# mine${lineEnd}${prefix}@./pstack-models.md${lineEnd}${lineEnd}@./other.md${lineEnd}`);
        assert.equal(readFileSync(join(cfg, "pstack-models.md"), "utf8"), sheetWithHighHillclimb());
        assert.equal(readFileSync(imported, "utf8"), sheetWithHighHillclimb());
        assert.equal(readFileSync(other, "utf8"), "Other instructions.\n");
      });
    }

    it(`excludes the distinct @pstack-models.md basename and preserves its import with ${label}`, async () => {
      const cfg = join(home, "cfg");
      const env = { CLAUDE_CONFIG_DIR: cfg };
      const unrelated = put(join(cfg, "@pstack-models.md"), sheetWithHighHillclimb());
      const before = `@./@pstack-models.md${lineEnd}`;
      const integration = put(join(cfg, "CLAUDE.md"), before);
      const state = loadState({ parent: "claude", home, env, matrix });
      assert.deepEqual(state.source, { kind: "first-run" });
      assert.equal(state.missingImport, null);
      assert.deepEqual(state.rows.find((row) => row.role === "hillclimb")?.lanes, ["claude:claude-opus-5-5@xhigh"]);

      const plan = await planAndProbe("claude", { env });
      writeSheet(plan, runDir, { home, env });
      assert.equal(readFileSync(integration, "utf8"), `${before}@./pstack-models.md\n`);
      assert.equal(readFileSync(join(cfg, "pstack-models.md"), "utf8"), firstRunSheet("claude"));
      assert.equal(readFileSync(unrelated, "utf8"), sheetWithHighHillclimb());
    });

    it(`still refuses two genuine imports when a target contains a literal @ with ${label}`, () => {
      const cfg = join(home, "cfg");
      const env = { CLAUDE_CONFIG_DIR: cfg };
      put(join(cfg, "at@literal", "pstack-models.md"), sheetWithHighHillclimb());
      const before = `@./at@literal/pstack-models.md${lineEnd}@./pstack-models.md${lineEnd}`;
      const integration = put(join(cfg, "CLAUDE.md"), before);
      const message = `inconsistent state: ${integration} imports pstack-models.md 2 times (lines 1, 2); keep exactly one import`;
      assert.throws(() => loadState({ parent: "claude", home, env, matrix }), { message });
      assert.throws(() => buildPlan({ parent: "claude", home, env, matrix }), { message });
      assert.equal(readFileSync(integration, "utf8"), before);
      assert.equal(existsSync(join(cfg, "pstack-models.md")), false);
    });

    it(`still refuses uncertain Markdown around a target containing a literal @ with ${label}`, () => {
      const cfg = join(home, "cfg");
      const env = { CLAUDE_CONFIG_DIR: cfg };
      put(join(cfg, "at@literal", "pstack-models.md"), sheetWithHighHillclimb());
      const before = `[@./at@literal/pstack-models.md](other.md)${lineEnd}`;
      const integration = put(join(cfg, "CLAUDE.md"), before);
      assert.throws(() => loadState({ parent: "claude", home, env, matrix }), /an HTML tag, a link or a backslash comes before it/);
      assert.throws(() => buildPlan({ parent: "claude", home, env, matrix }), /an HTML tag, a link or a backslash comes before it/);
      assert.equal(readFileSync(integration, "utf8"), before);
      assert.equal(existsSync(join(cfg, "pstack-models.md")), false);
    });

    it(`keeps a skipped comment marker separate from the live import after it with ${label}`, async () => {
      const cfg = join(home, "cfg");
      const env = { CLAUDE_CONFIG_DIR: cfg };
      const imported = put(join(cfg, "elsewhere", "pstack-models.md"), sheetWithHighHillclimb());
      const before = `<!--@noise-->@./elsewhere/pstack-models.md${lineEnd}`;
      const integration = put(join(cfg, "CLAUDE.md"), before);
      assert.deepEqual(loadState({ parent: "claude", home, env, matrix }).source, { kind: "import", path: imported });
      const plan = await planAndProbe("claude", { env });
      writeSheet(plan, runDir, { home, env });
      assert.equal(readFileSync(integration, "utf8"), `<!--@noise-->@./pstack-models.md${lineEnd}`);
      assert.equal(readFileSync(join(cfg, "pstack-models.md"), "utf8"), sheetWithHighHillclimb());
    });

    it(`still refuses comment-split and marked list targets with nested @ characters with ${label}`, () => {
      const cfg = join(home, "cfg");
      const env = { CLAUDE_CONFIG_DIR: cfg };
      for (const text of [
        "<!-- before -->@./at<!--@noise-->literal/pstack-models.md",
        "- @./at<!--@noise-->@literal/pstack-models.md",
        "*@./at@literal/pstack-models.md*",
        "@@./at@literal/pstack-models.md",
      ]) {
        const before = `${text}${lineEnd}`;
        const integration = put(join(cfg, "CLAUDE.md"), before);
        assert.throws(() => loadState({ parent: "claude", home, env, matrix }), /cannot read the way Claude Code does/);
        assert.throws(() => buildPlan({ parent: "claude", home, env, matrix }), /cannot read the way Claude Code does/);
        assert.equal(readFileSync(integration, "utf8"), before);
        assert.equal(existsSync(join(cfg, "pstack-models.md")), false);
      }
    });
  }

  it("carries a copied profile's imported sheet into the redirected home and replaces the one import in place", async () => {
    const cfg = join(home, "cfg");
    const env = { CLAUDE_CONFIG_DIR: cfg };
    const imported = put(join(home, ".claude", "pstack-models.md"), sheetWithHighHillclimb());
    put(join(cfg, "CLAUDE.md"), "# work profile\n@~/.claude/pstack-models.md\nKeep this.\n");
    const state = loadState({ parent: "claude", home, env, matrix });
    assert.deepEqual(state.source, { kind: "import", path: imported });
    assert.equal(state.exists, false);
    assert.equal(state.sheetPath, join(cfg, "pstack-models.md"));
    assert.deepEqual(state.rows.find((r) => r.role === "hillclimb")?.lanes, ["claude:claude-opus-5-5@high"]);

    const plan = await planAndProbe("claude", { env });
    assert.equal(plan.firstRun, false);
    writeSheet(plan, runDir, { home, env });
    assert.match(readFileSync(join(cfg, "pstack-models.md"), "utf8"), /^hillclimb: claude:claude-opus-5-5@high$/m);
    assert.equal(readFileSync(join(cfg, "CLAUDE.md"), "utf8"), "# work profile\n@./pstack-models.md\nKeep this.\n");
    assert.equal(readFileSync(imported, "utf8"), sheetWithHighHillclimb(), "the imported sheet is only read");
    assert.deepEqual(loadState({ parent: "claude", home, env, matrix }).source, { kind: "sheet", path: join(cfg, "pstack-models.md") });
  });

  it("replaces an import that names the sheet elsewhere with the legacy line, inside its list item", async () => {
    const elsewhere = put(join(home, "dotfiles", "pstack-models.md"), sheetWithHighHillclimb());
    const integration = put(join(home, ".claude", "CLAUDE.md"), `# mine\n- models: @${elsewhere}\n`);
    assert.deepEqual(loadState({ parent: "claude", home, matrix }).source, { kind: "import", path: elsewhere });
    const plan = await planAndProbe("claude");
    writeSheet(plan, runDir, { home });
    assert.equal(readFileSync(integration, "utf8"), "# mine\n- models: @~/.claude/pstack-models.md\n");
    assert.match(readFileSync(join(home, ".claude", "pstack-models.md"), "utf8"), /^hillclimb: claude:claude-opus-5-5@high$/m);
  });

  it("resolves a relative import with an escaped space against the CLAUDE.md directory", () => {
    const spaced = put(join(home, ".claude", "My Sheets", "pstack-models.md"), sheetWithHighHillclimb());
    put(join(home, ".claude", "CLAUDE.md"), "@./My\\ Sheets/pstack-models.md\n");
    assert.deepEqual(loadState({ parent: "claude", home, matrix }).source, { kind: "import", path: spaced });
  });

  it("ignores a mention in a fenced block, a code span, an HTML comment or quotes, and appends the one import", async () => {
    const mentions = "```text\n@~/.claude/pstack-models.md\n```\nLoad it with `@~/.claude/pstack-models.md`.\n<!-- off for now:\n@~/.claude/pstack-models.md -->\nNot this: @\"~/x/pstack-models.md\"\n";
    const integration = put(join(home, ".claude", "CLAUDE.md"), mentions);
    assert.deepEqual(loadState({ parent: "claude", home, matrix }).source, { kind: "first-run" });
    const plan = await planAndProbe("claude");
    writeSheet(plan, runDir, { home });
    assert.equal(readFileSync(integration, "utf8"), `${mentions}@~/.claude/pstack-models.md\n`);
  });
});

describe("loadState sources", () => {
  it("reports a missing import target and uses the first-run map, or the sheet when one survives", () => {
    put(join(home, ".claude", "CLAUDE.md"), "@~/gone/pstack-models.md\n");
    const missing = loadState({ parent: "claude", home, matrix });
    assert.deepEqual([missing.source, missing.missingImport, missing.exists], [{ kind: "first-run" }, join(home, "gone", "pstack-models.md"), false]);
    assert.equal(missing.efforts.grok.status, "unassigned");
    putSheet("claude", sheetWithHighHillclimb());
    const kept = loadState({ parent: "claude", home, matrix });
    assert.deepEqual([kept.source, kept.missingImport, kept.exists], [{ kind: "sheet", path: sheetPathFor("claude", home) }, join(home, "gone", "pstack-models.md"), true]);
  });

  it("stops when the config home's sheet and the imported sheet differ, and uses the sheet when they agree", () => {
    const cfg = join(home, "cfg");
    const env = { CLAUDE_CONFIG_DIR: cfg };
    const imported = put(join(home, ".claude", "pstack-models.md"), sheetWithHighHillclimb());
    const integration = put(join(cfg, "CLAUDE.md"), "@~/.claude/pstack-models.md\n");
    const sheet = put(join(cfg, "pstack-models.md"), firstRunSheet("claude"));
    assert.throws(
      () => loadState({ parent: "claude", home, env, matrix }),
      { message: `inconsistent state: ${sheet} and ${imported} (imported by ${integration}) assign different lanes to hillclimb (sheet: claude:claude-opus-5-5@xhigh; import: claude:claude-opus-5-5@high); delete the sheet to carry the imported one over, or change the import to @./pstack-models.md to keep the sheet` }
    );
    writeFileSync(sheet, `${sheetWithHighHillclimb()}\nA note the operator kept.\n`);
    assert.deepEqual(loadState({ parent: "claude", home, env, matrix }).source, { kind: "sheet", path: sheet });
  });

  it("recovers the Codex rows from the AGENTS.md block when the sheet is missing, and writes the sheet back", async () => {
    const customized = firstRunSheet("codex").replace("hillclimb: codex:gpt-6-sol@xhigh", "hillclimb: codex:gpt-6-sol@high");
    const integration = put(integrationPathFor("codex", home), `# agents\n${CODEX_BLOCK_BEGIN}\n${customized}${CODEX_BLOCK_END}\n`);
    const state = loadState({ parent: "codex", home, matrix });
    assert.deepEqual([state.source, state.exists], [{ kind: "block", path: integration }, false]);
    assert.deepEqual(state.rows.find((r) => r.role === "hillclimb")?.lanes, ["codex:gpt-6-sol@high"]);
    const plan = await planAndProbe("codex");
    assert.equal(plan.firstRun, false);
    assert.equal(plan.sheet, customized);
    const result = writeSheet(plan, runDir, { home });
    assert.deepEqual([result.sheet, result.integration], ["created", "unchanged"]);
    assert.equal(readFileSync(sheetPathFor("codex", home), "utf8"), customized);
  });

  it("stops when the Codex sheet and its block assign different lanes, naming both sides of each role", () => {
    const sheet = putSheet("codex", firstRunSheet("codex"));
    const changed = firstRunSheet("codex")
      .replace("hillclimb: codex:gpt-6-sol@xhigh", "hillclimb: codex:gpt-6-sol@high")
      .replace("why synthesizer: inherit-parent\n", "");
    const integration = put(integrationPathFor("codex", home), `${CODEX_BLOCK_BEGIN}\n${changed}${CODEX_BLOCK_END}\n`);
    assert.throws(
      () => buildPlan({ parent: "codex", home, matrix }),
      { message: `inconsistent state: ${sheet} and the pstack:models block of ${integration} assign different lanes to hillclimb (sheet: codex:gpt-6-sol@xhigh; block: codex:gpt-6-sol@high), why synthesizer (sheet: inherit-parent; block: no row); delete the sheet to recover the block, or remove the block to keep the sheet` }
    );
  });

  it("uses the sheet when it differs from its block only in prose", () => {
    const sheet = putSheet("codex", `${firstRunSheet("codex")}\nA note the operator kept.\n`);
    put(integrationPathFor("codex", home), `${CODEX_BLOCK_BEGIN}\n${firstRunSheet("codex")}${CODEX_BLOCK_END}\n`);
    assert.deepEqual(loadState({ parent: "codex", home, matrix }).source, { kind: "sheet", path: sheet });
  });

  it("recovers a Grok sheet from its block the same way", () => {
    const integration = put(integrationPathFor("grok", home), `${CODEX_BLOCK_BEGIN}\n${firstRunSheet("grok")}${CODEX_BLOCK_END}\n`);
    assert.deepEqual(loadState({ parent: "grok", home, matrix }).source, { kind: "block", path: integration });
  });
});

describe("imports that a line scan reads differently from Claude Code", () => {
  const elsewhere = (): string => put(join(home, "dotfiles", "pstack-models.md"), sheetWithHighHillclimb());
  const claudeMd = (text: string): string => put(join(home, ".claude", "CLAUDE.md"), text);
  const unsure = (path: string, line: number, reason: string): string =>
    `inconsistent state: ${path} line ${line} mentions an import of pstack-models.md that this script cannot read the way Claude Code does (${reason}); move the import to the top of the file as a line of its own, or remove the mention`;

  async function rewritten(before: string, after: string): Promise<void> {
    const sheet = elsewhere();
    const integration = claudeMd(before);
    assert.deepEqual(loadState({ parent: "claude", home, matrix }).source, { kind: "import", path: sheet });
    const plan = await planAndProbe("claude");
    assert.equal(plan.firstRun, false);
    writeSheet(plan, runDir, { home });
    assert.equal(readFileSync(integration, "utf8"), after);
    assert.match(readFileSync(join(home, ".claude", "pstack-models.md"), "utf8"), /^hillclimb: claude:claude-opus-5-5@high$/m);
  }

  async function appended(before: string, after = `${before}@~/.claude/pstack-models.md\n`): Promise<void> {
    elsewhere();
    const integration = claudeMd(before);
    assert.deepEqual(loadState({ parent: "claude", home, matrix }).source, { kind: "first-run" });
    const plan = await planAndProbe("claude");
    writeSheet(plan, runDir, { home });
    assert.equal(readFileSync(integration, "utf8"), after);
  }

  function stops(before: string, message: string): void {
    elsewhere();
    const integration = claudeMd(before);
    assert.throws(() => loadState({ parent: "claude", home, matrix }), { message });
    assert.throws(() => buildPlan({ parent: "claude", home, matrix }), { message });
    assert.equal(readFileSync(integration, "utf8"), before);
    assert.equal(existsSync(join(home, ".claude", "pstack-models.md")), false);
  }

  it("loads an import right after an HTML comment on its line, and rewrites it there", async () => {
    await rewritten("<!-- models -->@~/dotfiles/pstack-models.md\n", "<!-- models -->@~/.claude/pstack-models.md\n");
  });

  it("loads an import after an indented fence line that only continues a paragraph", async () => {
    await rewritten("Para\n    ```\n@~/dotfiles/pstack-models.md\n", "Para\n    ```\n@~/.claude/pstack-models.md\n");
  });

  it("counts only the plain import when a second one sits in an indented code block", async () => {
    await rewritten("@~/dotfiles/pstack-models.md\n\n    @./pstack-models.md\n", "@~/.claude/pstack-models.md\n\n    @./pstack-models.md\n");
  });

  it("skips an import in an indented code block and appends one that loads", async () => {
    await appended("Notes.\n\n    @~/dotfiles/pstack-models.md\n");
  });

  it("skips an import in front matter and appends one that loads", async () => {
    await appended("---\nnote: @~/dotfiles/pstack-models.md\n---\nBody\n");
  });

  it("puts the import at the top, followed by a blank line, when an unclosed HTML comment would hide it at the end", async () => {
    await appended("<!-- @~/dotfiles/pstack-models.md\n", "@~/.claude/pstack-models.md\n\n<!-- @~/dotfiles/pstack-models.md\n");
  });

  it("puts a top import after the front matter and after a byte order mark", async () => {
    await appended("---\ntitle: x\n---\n<!-- off\n", "---\ntitle: x\n---\n@~/.claude/pstack-models.md\n\n<!-- off\n");
    rmSync(join(home, ".claude"), { recursive: true });
    await appended("﻿\n<!-- off\n", "﻿@~/.claude/pstack-models.md\n\n\n<!-- off\n");
  });

  it("skips an import in an HTML block and appends one after a blank line, which ends the block", async () => {
    await appended("<div>\n@~/dotfiles/pstack-models.md\n</div>\n", "<div>\n@~/dotfiles/pstack-models.md\n</div>\n\n@~/.claude/pstack-models.md\n");
  });

  it("stops on an import glued to emphasis, which Claude Code loads", () => {
    stops("*@~/dotfiles/pstack-models.md*\n", unsure(join(home, ".claude", "CLAUDE.md"), 1, "markup touches it"));
  });

  it("stops on an import in link text, which Claude Code loads", () => {
    stops("[@~/dotfiles/pstack-models.md](https://example.com)\n", unsure(join(home, ".claude", "CLAUDE.md"), 1, "an HTML tag, a link or a backslash comes before it in its paragraph"));
  });

  it("stops on an import glued inside an inline tag, which Claude Code loads", () => {
    stops("<span>@~/dotfiles/pstack-models.md</span>\n", unsure(join(home, ".claude", "CLAUDE.md"), 1, "an HTML tag, a link or a backslash comes before it in its paragraph"));
  });

  it("appends after a blank line when the last paragraph would leave a lazy line unsure", async () => {
    await appended("See [the docs](https://example.com).", "See [the docs](https://example.com).\n\n@~/.claude/pstack-models.md\n");
  });

  it("still reads a plain list item and appends after a list as a lazy line", async () => {
    await rewritten("# Rules\n- one\n- models @~/dotfiles/pstack-models.md\n", "# Rules\n- one\n- models @~/.claude/pstack-models.md\n");
    rmSync(join(home, ".claude"), { recursive: true });
    await appended("# Rules\n- one\n- two\n");
  });
});

describe("a CLAUDE.md with carriage returns, which Claude Code's lexer reads as line feeds", () => {
  const elsewhere = (): string => put(join(home, "dotfiles", "pstack-models.md"), sheetWithHighHillclimb());
  const claudeMd = (text: string): string => put(join(home, ".claude", "CLAUDE.md"), text);

  async function written(before: string, source: State["source"], after: string): Promise<void> {
    elsewhere();
    const integration = claudeMd(before);
    assert.deepEqual(loadState({ parent: "claude", home, matrix }).source, source);
    const plan = await planAndProbe("claude");
    writeSheet(plan, runDir, { home });
    assert.equal(readFileSync(integration, "utf8"), after);
  }

  it("appends the import with an LF line end to a CRLF file that has none", async () => {
    const before = "Prefer small commits.\r\nAnswer in plain language.\r\nRun the tests before declaring done.\r\n";
    await written(before, { kind: "first-run" }, `${before}@~/.claude/pstack-models.md\n`);
  });

  it("reads an import on a CRLF line and replaces only its path", async () => {
    const sheet = join(home, "dotfiles", "pstack-models.md");
    await written("Rules.\r\n\r\n@~/dotfiles/pstack-models.md\r\nMore.\r\n", { kind: "import", path: sheet }, "Rules.\r\n\r\n@~/.claude/pstack-models.md\r\nMore.\r\n");
  });

  it("reads an import after lone carriage returns and replaces only its path", async () => {
    const sheet = join(home, "dotfiles", "pstack-models.md");
    await written("Rules.\rMore.\r\r@~/dotfiles/pstack-models.md\r", { kind: "import", path: sheet }, "Rules.\rMore.\r\r@~/.claude/pstack-models.md\r");
  });

  it("leaves a CRLF file whose first line imports the config-home sheet byte for byte and creates the sheet", async () => {
    const before = "@~/.claude/pstack-models.md\r\nPrefer small commits.\r\nAnswer in plain language.\r\nRun the tests before declaring done.\r\n";
    const integration = claudeMd(before);
    const state = loadState({ parent: "claude", home, matrix });
    assert.deepEqual([state.source, state.missingImport], [{ kind: "first-run" }, join(home, ".claude", "pstack-models.md")]);
    const plan = await planAndProbe("claude");
    const result = writeSheet(plan, runDir, { home });
    assert.deepEqual([result.sheet, result.integration], ["created", "unchanged"]);
    assert.equal(readFileSync(integration, "utf8"), before);
  });

  it("skips imports in a CRLF fence and in CRLF front matter, and appends one that loads", async () => {
    const fenced = "```\r\n@~/dotfiles/pstack-models.md\r\n```\r\n";
    await written(fenced, { kind: "first-run" }, `${fenced}@~/.claude/pstack-models.md\n`);
    rmSync(join(home, ".claude"), { recursive: true });
    const frontMatter = "---\r\nnote: @~/dotfiles/pstack-models.md\r\n---\r\nBody\r\n";
    await written(frontMatter, { kind: "first-run" }, `${frontMatter}@~/.claude/pstack-models.md\n`);
  });

  it("numbers the lines of a CRLF file as an editor does when it stops on two imports", () => {
    const before = "@~/.claude/pstack-models.md\r\nNotes.\r\n@./pstack-models.md\r\n";
    const integration = claudeMd(before);
    const message = `inconsistent state: ${integration} imports pstack-models.md 2 times (lines 1, 3); keep exactly one import`;
    assert.throws(() => loadState({ parent: "claude", home, matrix }), { message });
    assert.throws(() => buildPlan({ parent: "claude", home, matrix }), { message });
    assert.equal(readFileSync(integration, "utf8"), before);
  });
});

describe("a config home that is a file", () => {
  it("stops state and plan before any probe", () => {
    const cfg = put(join(home, "cfg"), "not a directory\n");
    const env = { CLAUDE_CONFIG_DIR: cfg };
    const message = `inconsistent state: the config home ${cfg} is a file, not a directory; move it aside or point CLAUDE_CONFIG_DIR at a directory`;
    assert.throws(() => loadState({ parent: "claude", home, env, matrix }), { message });
    assert.throws(() => buildPlan({ parent: "claude", home, env, matrix }), { message });
    put(join(home, ".grok"), "not a directory\n");
    assert.throws(() => loadState({ parent: "grok", home, matrix }), { message: `inconsistent state: the config home ${join(home, ".grok")} is a file, not a directory; move it aside` });
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

  it("follows CLAUDE_CONFIG_DIR from its own environment through state, plan and write", () => {
    const cfg = join(home, "cfg");
    const redirected = (env: NodeJS.ProcessEnv) => ({ ...env, CLAUDE_CONFIG_DIR: cfg });
    const state = JSON.parse(cli(["state", "--parent", "claude", "--home", home], redirected(noCliEnv())).stdout);
    assert.deepEqual([state.configHome, state.sheetPath, state.source], [cfg, join(cfg, "pstack-models.md"), { kind: "first-run" }]);

    assert.equal(cli(["plan", "--parent", "claude", "--home", home, "--dir", runDir], redirected(noCliEnv())).code, 0);
    assert.equal(cli(["probe", "--dir", runDir], redirected(fakeEnv())).code, 0);
    const plan = JSON.parse(readFileSync(join(runDir, "plan.json"), "utf8")) as Plan;
    for (const pair of plan.pairs.filter((p) => p.native)) {
      assert.equal(cli(["attest", "--dir", runDir, "--pair", pair.pair, "--observed", `reply ${pair.marker}`], noCliEnv()).code, 0);
    }
    const elsewhere = cli(["write", "--dir", runDir, "--home", home], noCliEnv());
    assert.equal(elsewhere.code, 1);
    assert.match(elsewhere.stderr, /was made for the config home .*, but this write resolves .*\.claude; run write with the --home and CLAUDE_CONFIG_DIR that plan used/);
    const written = cli(["write", "--dir", runDir, "--home", home], redirected(noCliEnv()));
    assert.equal(written.code, 0, written.stderr);
    assert.equal(readFileSync(join(cfg, "CLAUDE.md"), "utf8"), "@./pstack-models.md\n");
    assert.equal(existsSync(join(home, ".claude")), false);
  });

  it("refuses an empty CLAUDE_CONFIG_DIR from its own environment", () => {
    const result = cli(["state", "--parent", "claude", "--home", home], { ...noCliEnv(), CLAUDE_CONFIG_DIR: "" });
    assert.equal(result.code, 1);
    assert.equal(result.stderr, "error: CLAUDE_CONFIG_DIR is empty; Claude Code 2.1.289 then reads settings.json and CLAUDE.md from the directory it starts in, not from ~/.claude, so unset it or set it to an absolute path\n");
    assert.equal(result.stdout, "");
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
    assert.equal(saved.schemaVersion, 7);
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

  it("pick prints the lanes of another provider and exits 1 when none is eligible", () => {
    const first = cli(["pick", "--parent", "claude", "--home", home, "--role", "trail reviewer pool"], noCliEnv());
    assert.equal(first.code, 0, first.stderr);
    const picked = JSON.parse(first.stdout);
    assert.deepEqual([picked.parent, picked.role, picked.source], ["claude", "trail reviewer pool", "default"]);
    assert.deepEqual(picked.executors, ["claude"]);
    assert.equal(picked.chosen.descriptor, "codex:gpt-6.1-sol@xhigh");
    assert.deepEqual(picked.eligible.map((l: { descriptor: string }) => l.descriptor), ["codex:gpt-6.1-sol@xhigh", "grok:grok-4.7@xhigh"]);

    const grokWrote = cli(["pick", "--parent", "codex", "--home", home, "--role", "trail reviewer pool", "--executor", "grok"], noCliEnv());
    assert.equal(grokWrote.code, 0, grokWrote.stderr);
    assert.equal(JSON.parse(grokWrote.stdout).chosen.descriptor, "claude:claude-opus-5-5@xhigh");

    const none = cli(["pick", "--parent", "claude", "--home", home, "--role", "trail reviewer pool", "--executor", "codex", "--executor", "grok"], noCliEnv());
    assert.equal(none.code, 1);
    const empty = JSON.parse(none.stdout);
    assert.equal(empty.chosen, null);
    assert.deepEqual(empty.eligible, []);
    assert.equal(empty.skipped.length, 3);
    assert.deepEqual(
      JSON.parse(cli(["pick", "--parent", "claude", "--home", home, "--role", "trail reviewer pool", "--executor", "codex,grok"], noCliEnv()).stdout).executors,
      ["claude", "codex", "grok"]
    );

    assert.equal(cli(["pick", "--parent", "claude", "--home", home], noCliEnv()).code, 64);
    const unknown = cli(["pick", "--parent", "claude", "--home", home, "--role", "trail reviewer pool", "--executor", "cursor"], noCliEnv());
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /unknown provider "cursor"/);
    assert.equal(existsSync(join(home, ".claude")), false, "pick writes nothing");
  });

  it("probe refuses a plan.json from the previous schema", () => {
    assert.equal(cli(["plan", "--parent", "claude", "--home", home, "--dir", runDir], noCliEnv()).code, 0);
    const path = join(runDir, "plan.json");
    const { warnings: _warnings, ...current } = JSON.parse(readFileSync(path, "utf8")) as Plan;
    writeFileSync(path, `${JSON.stringify({ ...current, schemaVersion: 5 }, null, 2)}\n`);
    const result = cli(["probe", "--dir", runDir], noCliEnv());
    assert.equal(result.code, 1);
    assert.match(result.stderr, /plan/);
    assert.match(result.stderr, /run plan again with this version of the script/);
    assert.deepEqual(readdirSync(runDir), ["plan.json"], "no probe lane ran");
    assert.equal(existsSync(join(home, ".claude", "pstack-models.md")), false);
  });
});
