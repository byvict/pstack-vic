import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import fs, { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { loadMatrix, renderRoleSheet, roleDefault } from "../../../scripts/model-matrix.ts";
import { clisOutsideFakes, isolatedEnv, isolateProcessEnv } from "../../poteto-mode/scripts/runner/isolated-env.test-helper.ts";
import {
  SetupError,
  buildPlan,
  dataHomeFor,
  ledgerPathFor,
  loadState,
  main,
  normalizeLane,
  parseSheet,
  pickLane,
  resolveRoles,
  sheetPathFor,
  unwireSheet,
  type ConfigEnv,
  type Plan,
  type State,
} from "./setup-pstack.ts";

const matrix = loadMatrix();

let home = "";
let restoreProcessEnv: () => void = () => {};
let previousNetworkMarker: string | undefined;

// The test process itself holds no CLI, fake or real, and its HOME is the
// temporary one: a probe whose `env` gets lost on the way to the launcher
// inherits this and finds nothing, and a path that falls back to the home
// directory lands in the temporary one.
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pstack-setup-"));
  restoreProcessEnv = isolateProcessEnv(home);
  previousNetworkMarker = process.env.CODEX_SANDBOX_NETWORK_DISABLED;
  delete process.env.CODEX_SANDBOX_NETWORK_DISABLED;
});

afterEach(() => {
  restoreProcessEnv();
  if (previousNetworkMarker === undefined) delete process.env.CODEX_SANDBOX_NETWORK_DISABLED;
  else process.env.CODEX_SANDBOX_NETWORK_DISABLED = previousNetworkMarker;
  rmSync(home, { recursive: true, force: true });
});

function putSheet(parent: string, text: string): string {
  const path = sheetPathFor(parent, home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

/** A ledger that vouches for the named families (matrix family names) on this parent, by default where setup keeps it. */
function putLedger(parent: string, families: readonly string[], path: string = ledgerPathFor(parent, home)): string {
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
    assert.equal(state.sheetPath, join(dataHomeFor("claude", home), "pstack-models.md"));
    assert.deepEqual(state.legacyFiles, []);
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
    assert.equal(state.sheetPath, join(dataHomeFor("codex", home), "pstack-models.md"));
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
    assert.equal(plan.sheetPath, join(dataHomeFor("grok", home), "pstack-models.md"));
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
    assert.equal(plan.ledgerPath, join(dataHomeFor("claude", home), "pstack-probes.json"));
    assert.deepEqual(plan.verified, []);
    assert.deepEqual(plan.efforts, {
      fable: ["max"],
      opus: ["xhigh", "max"],
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

  it("preserves explicit native MCP roles and voluntary aliases instead of replacing them with defaults", () => {
    putSheet("codex", [
      "why investigators: codex:gpt-6.1-sol@xhigh",
      "why synthesizer: codex:gpt-6.1-sol@max",
      "reflect tooling: inherit-parent",
      "reflect judgment, divergent, synthesizer: auto",
      "",
    ].join("\n"));
    const plan = buildPlan({ parent: "codex", home, matrix });
    assert.deepEqual(lanesOf(plan, "why investigators"), ["codex:gpt-6.1-sol@xhigh"]);
    assert.deepEqual(lanesOf(plan, "why synthesizer"), ["codex:gpt-6.1-sol@max"]);
    assert.deepEqual(lanesOf(plan, "reflect tooling"), ["inherit-parent"]);
    assert.deepEqual(lanesOf(plan, "reflect judgment, divergent, synthesizer"), ["auto"]);
    const sol = plan.pairs.find((p) => p.family === "sol-6-1");
    assert.equal(sol?.route, "native");
    assert.deepEqual(sol?.native, { primitive: "spawn_agent", model: "gpt-6.1-sol", reasoning_effort: "xhigh" });
    assert.deepEqual(plan.efforts["sol-6-1"], ["xhigh", "max"]);
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
    assert.deepEqual(lanesOf(plan, "why investigators"), ["claude:claude-opus-5-5@xhigh"]);
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

  it("accepts one provider besides the root without a coauthor-exhaustion warning", () => {
    const plan = buildPlan({ parent: "claude", home, matrix, roles: { "trail reviewer pool": ["claude:claude-opus-5-5@xhigh", "grok:grok-4.7@xhigh"] } });
    assert.deepEqual(plan.warnings, []);
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

describe("swarm fallback", () => {
  const nativeChoices = [
    { parent: "codex", descriptor: "codex:gpt-6.1-sol@xhigh" },
    { parent: "claude", descriptor: "claude:claude-opus-5-5@xhigh" },
    { parent: "grok", descriptor: "grok:grok-4.7@xhigh" },
  ];

  it("leaves first-run and existing sheets disabled unless explicitly configured", () => {
    for (const { parent } of nativeChoices) {
      const first = buildPlan({ parent, home, matrix });
      assert.equal(first.sheet, firstRunSheet(parent));
      putSheet(parent, first.sheet);
      assert.equal(buildPlan({ parent, home, matrix }).sheet, first.sheet);
      assert.doesNotMatch(first.sheet, /^swarm fallback:/m);
    }
  });

  it("preserves one explicit native descriptor per parent across state and plan", () => {
    for (const { parent, descriptor } of nativeChoices) {
      const plan = buildPlan({ parent, home, matrix, swarmFallback: descriptor });
      assert.equal(plan.sheet, `${firstRunSheet(parent)}swarm fallback: ${descriptor}\n`);
      putSheet(parent, plan.sheet);
      assert.deepEqual(loadState({ parent, home, matrix }).rows.at(-1), { role: "swarm fallback", lanes: [descriptor] });
      assert.equal(buildPlan({ parent, home, matrix }).sheet, plan.sheet);
    }
  });

  it("rejects aliases, lists, foreign providers and unsupported models or efforts", () => {
    for (const descriptor of [
      "auto", "inherit-parent", "off", "gpt-6.1-sol@xhigh",
      "grok:grok-4.7@xhigh", "claude:claude-opus-5-5@xhigh",
      "codex:gpt-6.1-sol@turbo", "codex:unknown@xhigh",
      "codex:gpt-6.1-sol@xhigh, codex:gpt-6-astra@max",
    ]) {
      assert.throws(() => buildPlan({ parent: "codex", home, matrix, swarmFallback: descriptor }), SetupError, descriptor);
      putSheet("codex", `swarm fallback: ${descriptor}\n`);
      assert.throws(() => loadState({ parent: "codex", home, matrix }), SetupError, descriptor);
      rmSync(sheetPathFor("codex", home));
    }
    for (const line of ["swarm fallback:", "swarm fallback: ", "swarm fallback: codex:gpt-6.1-sol@xhigh,"]) {
      assert.throws(() => parseSheet(`${line}\n`, matrix), /exactly one provider-qualified descriptor/);
    }
    assert.throws(() => parseSheet("swarm fallback: auto\nswarm fallback: auto\n", matrix), /duplicate role/);
    assert.throws(() => buildPlan({ parent: "claude", home, matrix, swarmFallback: "codex:gpt-6.1-sol@xhigh" }), /must use claude/);
    assert.throws(() => buildPlan({ parent: "grok", home, matrix, swarmFallback: "codex:gpt-6.1-sol@xhigh" }), /must use grok/);
  });

  it("includes the fallback in family effort changes and lets an explicit descriptor override them", () => {
    const first = buildPlan({ parent: "codex", home, matrix, swarmFallback: "codex:gpt-6.1-sol@xhigh" });
    putSheet("codex", first.sheet);
    const changed = buildPlan({ parent: "codex", home, matrix, efforts: { "sol-6-1": "high" } });
    assert.deepEqual(lanesOf(changed, "swarm fallback"), ["codex:gpt-6.1-sol@high"]);
    const explicit = buildPlan({ parent: "codex", home, matrix, efforts: { "sol-6-1": "high" }, swarmFallback: "codex:gpt-6.1-sol@max" });
    assert.deepEqual(lanesOf(explicit, "swarm fallback"), ["codex:gpt-6.1-sol@max"]);
    assert.deepEqual(explicit.efforts["sol-6-1"], ["high", "max"]);
  });

  it("normalizes a persisted legacy descriptor but requires a current descriptor for changes", () => {
    putSheet("claude", "swarm fallback: claude:claude-opus-5@high\n");
    const state = loadState({ parent: "claude", home, matrix });
    assert.deepEqual(state.rows, [{ role: "swarm fallback", lanes: ["claude:claude-opus-5-5@high"] }]);
    assert.deepEqual(state.migrations, [{ role: "swarm fallback", from: "claude:claude-opus-5@high", to: "claude:claude-opus-5-5@high" }]);
    assert.throws(() => buildPlan({ parent: "claude", home, matrix, swarmFallback: "claude:claude-opus-5@high" }), /legacy descriptor/);
  });

  it("requires a new fallback family's probe before writing and preserves it on a rerun", () => {
    const sheet = matrix.roles.map((role) => `${role.role}: ${role.selection === "cross-family" ? "grok:grok-4.7@xhigh" : "auto"}`).join("\n");
    putSheet("codex", `${sheet}\n`);
    putLedger("codex", ["grok-4-7"]);
    const plan = buildPlan({ parent: "codex", home, matrix, swarmFallback: "codex:gpt-6.1-sol@high" });
    assert.deepEqual(plan.pairs.map((p) => [p.pair, p.route, p.native]), [
      ["sol-6-1@high", "native", { primitive: "spawn_agent", model: "gpt-6.1-sol", reasoning_effort: "high" }],
    ]);
    savePlan(runDir, plan);
    assert.throws(() => writeSheet(plan, runDir, { home }), /sol-6-1@high/);
    assert.equal(readFileSync(plan.sheetPath, "utf8"), `${sheet}\n`);
    assert.equal(existsSync(plan.integrationPath), false);
    const [pair] = plan.pairs;
    assert.ok(pair);
    attestNative(plan, runDir, pair.pair, pair.marker);
    writeSheet(plan, runDir, { home });
    assert.match(readFileSync(plan.sheetPath, "utf8"), /^swarm fallback: codex:gpt-6\.1-sol@high$/m);
    assert.equal(existsSync(plan.integrationPath), false);
    const again = buildPlan({ parent: "codex", home, matrix });
    assert.deepEqual(again.pairs, []);
    const rerun = writeSheet(again, runDir, { home });
    assert.deepEqual([rerun.sheet, rerun.integration, rerun.ledger], ["unchanged", "unchanged", "unchanged"]);

    const disabled = buildPlan({ parent: "codex", home, matrix, swarmFallback: null });
    assert.deepEqual(disabled.pairs, []);
    writeSheet(disabled, runDir, { home });
    assert.doesNotMatch(readFileSync(disabled.sheetPath, "utf8"), /swarm fallback/);
    assert.equal(disabled.sheet, buildPlan({ parent: "codex", home, matrix }).sheet);
  });

  it("recovers the setting from an earlier version's block and rejects sheet/block disagreements", () => {
    putLedger("codex", matrix.families.map((f) => f.family));
    const plan = buildPlan({ parent: "codex", home, matrix, swarmFallback: "codex:gpt-6.1-sol@xhigh" });
    put(plan.integrationPath, `${CODEX_BLOCK_BEGIN}\n${plan.sheet}${CODEX_BLOCK_END}\n`);
    assert.deepEqual(loadState({ parent: "codex", home, matrix }).rows.at(-1), { role: "swarm fallback", lanes: ["codex:gpt-6.1-sol@xhigh"] });
    putSheet("codex", firstRunSheet("codex"));
    assert.throws(() => loadState({ parent: "codex", home, matrix }), /swarm fallback \(sheet: no row; block: codex:gpt-6.1-sol@xhigh\)/);
  });
});

describe("pickLane", () => {
  it("excludes the Grok root but keeps another provider that implemented the work", () => {
    const result = pickLane({ parent: "grok", home, matrix, role: "trail reviewer pool", executors: ["claude"] });
    assert.deepEqual(result.executors, ["grok"]);
    assert.equal(result.chosen?.descriptor, "claude:claude-opus-5-5@xhigh");
    assert.equal(result.chosen?.route, "runner");
    assert.deepEqual(result.eligible.map((lane) => lane.provider), ["claude", "codex"]);
  });
  const pick = (parent: string, executors: string[] = []) => pickLane({ parent, home, matrix, role: "trail reviewer pool", executors });

  it("still selects a reviewer for every root when all three providers wrote", () => {
    for (const [parent, descriptor, eligible] of [
      ["claude", "codex:gpt-6.1-sol@xhigh", ["codex", "grok"]],
      ["codex", "claude:claude-opus-5-5@xhigh", ["claude", "grok"]],
      ["grok", "claude:claude-opus-5-5@xhigh", ["claude", "codex"]],
    ] as const) {
      const result = pick(parent, ["claude", "codex", "grok"]);
      assert.equal(result.chosen?.descriptor, descriptor);
      assert.deepEqual(result.eligible.map((lane) => lane.provider), eligible);
      assert.deepEqual(result.executors, [parent]);
      assert.equal(result.chosen?.route, "runner");
    }
  });

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
    assert.equal(pick("claude", ["grok"]).chosen?.descriptor, "grok:grok-4.7@high");
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

  it("preserves Arena author exclusions, and refuses an unknown role, executor, or an effort the family lacks", () => {
    const arena = pickLane({ parent: "claude", home, matrix, role: "arena cross-judge pool", executors: ["codex"] });
    assert.equal(arena.chosen?.descriptor, "grok:grok-4.6@xhigh");
    assert.throws(() => pickLane({ parent: "claude", home, matrix, role: "trail reviewers" }), /unknown role "trail reviewers"/);
    assert.throws(() => pick("claude", ["cursor"]), /unknown provider "cursor"/);
    putSheet("claude", "trail reviewer pool: grok:grok-4.7@max\n");
    assert.throws(() => pick("claude"), /grok-4-7 does not select effort max/);
  });
});

/** A directory outside any project, so a Codex lookup reaches the global profile. */
function outside(): string {
  const directory = join(home, "outside");
  mkdirSync(directory, { recursive: true });
  return directory;
}

describe("resolveRoles", () => {
  it("takes each row from the sheet, the rest from the role table, and lists the swarm fallback last", () => {
    const text = `${firstRunSheet("claude")
      .replace("hillclimb: claude:claude-opus-5-5@xhigh", "hillclimb: claude:claude-opus-5-5@high")
      .replace(/^swarm workers: .*\n/m, "")}swarm fallback: claude:claude-opus-5-5@high\n`;
    const sheet = putSheet("claude", text);
    const result = resolveRoles({ parent: "claude", home, matrix });
    assert.deepEqual(result.configurationSource, { kind: "sheet", path: sheet });
    assert.equal(result.legacyWiring, null);
    assert.deepEqual(result.roles.map((r) => r.role), [...matrix.roles.map((r) => r.role), "swarm fallback"]);
    assert.deepEqual(result.roles.find((r) => r.role === "hillclimb"), { role: "hillclimb", lanes: ["claude:claude-opus-5-5@high"], source: "sheet" });
    assert.deepEqual(result.roles.find((r) => r.role === "swarm workers"), { role: "swarm workers", lanes: roleDefault(matrix, "swarm workers", "claude"), source: "default" });
    assert.deepEqual(result.roles.at(-1), { role: "swarm fallback", lanes: ["claude:claude-opus-5-5@high"], source: "sheet" });
  });

  it("uses the role table on a first run and names the wiring an earlier version left", () => {
    const integration = put(join(home, ".claude", "CLAUDE.md"), `# mine\n${CLAUDE_INCLUDE_LINE}\n`);
    const result = resolveRoles({ parent: "claude", home, matrix });
    assert.deepEqual(result.configurationSource, { kind: "first-run" });
    assert.equal(result.legacyWiring, integration);
    assert.ok(result.roles.every((r) => r.source === "default"));
    assert.deepEqual(result.roles.map((r) => r.lanes), matrix.roles.map((r) => roleDefault(matrix, r.role, "claude")));
  });

  it("normalizes an old descriptor as it reads the sheet", () => {
    putSheet("claude", "bug-fix: claude:claude-opus-5@high\n");
    assert.deepEqual(resolveRoles({ parent: "claude", home, matrix }).roles.find((r) => r.role === "bug-fix")?.lanes, ["claude:claude-opus-5-5@high"]);
  });
});

describe("unwireSheet", () => {
  it("removes the Claude include, keeps the sheet byte for byte, and a second run changes nothing", () => {
    // The include always named the config-home sheet, which a version before 0.6.0 kept there.
    const legacy = put(join(home, ".claude", "pstack-models.md"), sheetWithHighHillclimb());
    const integration = put(join(home, ".claude", "CLAUDE.md"), `# mine\n${CLAUDE_INCLUDE_LINE}\n`);
    const sheet = sheetPathFor("claude", home);
    assert.deepEqual(unwireSheet({ parent: "claude", home, matrix }), {
      sheetPath: sheet,
      integrationPath: integration,
      ledgerPath: ledgerPathFor("claude", home),
      sheet: "created",
      integration: "updated",
      ledger: "unchanged",
      missingImport: null,
      removedLegacy: [legacy],
    });
    assert.equal(readFileSync(integration, "utf8"), "# mine\n");
    assert.equal(readFileSync(sheet, "utf8"), sheetWithHighHillclimb());
    assert.equal(existsSync(legacy), false);
    assert.equal(loadState({ parent: "claude", home, matrix }).legacyWiring, null);
    const again = unwireSheet({ parent: "claude", home, matrix });
    assert.deepEqual([again.sheet, again.integration, again.ledger, again.removedLegacy], ["unchanged", "unchanged", "unchanged", []]);
    assert.equal(readFileSync(sheet, "utf8"), sheetWithHighHillclimb());
  });

  for (const parent of ["claude", "codex", "grok"]) {
    it(`reads the ${parent} sheet and ledger an earlier version kept in the config home, moves both byte for byte into the data folder, and a second run changes nothing`, () => {
      const configHome = configHomeFor(parent, home);
      const legacySheet = put(join(configHome, "pstack-models.md"), firstRunSheet(parent).replace(/^(hillclimb: \w+:[\w.-]+)@xhigh$/m, "$1@high"));
      const legacyLedger = putLedger(parent, ["fable", "grok"], join(configHome, "pstack-probes.json"));
      const bytes = [legacySheet, legacyLedger].map((path) => readFileSync(path, "utf8"));
      const state = loadState({ parent, home, matrix, cwd: outside() });
      assert.deepEqual([state.source, state.exists, state.legacyFiles], [{ kind: "legacy", path: legacySheet }, false, [legacySheet, legacyLedger]]);
      assert.equal(state.sheetPath, sheetPathFor(parent, home));
      assert.match(state.rows.find((r) => r.role === "hillclimb")?.lanes[0] ?? "", /@high$/);

      const result = unwireSheet({ parent, home, matrix, cwd: outside() });
      assert.deepEqual(result, {
        sheetPath: join(dataHomeFor(parent, home), "pstack-models.md"),
        integrationPath: integrationPathFor(parent, home),
        ledgerPath: join(dataHomeFor(parent, home), "pstack-probes.json"),
        sheet: "created",
        integration: "unchanged",
        ledger: "created",
        missingImport: null,
        removedLegacy: [legacySheet, legacyLedger],
      });
      assert.deepEqual([result.sheetPath, result.ledgerPath].map((path) => readFileSync(path, "utf8")), bytes);
      assert.deepEqual([legacySheet, legacyLedger].map((path) => existsSync(path)), [false, false]);
      const moved = loadState({ parent, home, matrix, cwd: outside() });
      assert.deepEqual([moved.source, moved.exists, moved.legacyFiles], [{ kind: "sheet", path: result.sheetPath }, true, []]);
      assert.deepEqual(moved.rows, state.rows);

      const again = unwireSheet({ parent, home, matrix, cwd: outside() });
      assert.deepEqual([again.sheet, again.integration, again.ledger, again.missingImport, again.removedLegacy], ["unchanged", "unchanged", "unchanged", null, []]);
      assert.deepEqual([result.sheetPath, result.ledgerPath].map((path) => readFileSync(path, "utf8")), bytes);
    });
  }

  for (const parent of ["codex", "grok"]) {
    it(`moves a ${parent} sheet that lived only in its block to the sheet path, then removes the block`, () => {
      const customized = firstRunSheet(parent).replace(/^(hillclimb: \w+:[\w.-]+)@xhigh$/m, "$1@high");
      assert.notEqual(customized, firstRunSheet(parent));
      const integration = put(integrationPathFor(parent, home), `# agents\n${CODEX_BLOCK_BEGIN}\n${customized}${CODEX_BLOCK_END}\n`);
      const result = unwireSheet({ parent, home, matrix, cwd: outside() });
      assert.deepEqual([result.sheet, result.integration], ["created", "updated"]);
      assert.equal(readFileSync(sheetPathFor(parent, home), "utf8"), customized);
      assert.equal(readFileSync(integration, "utf8"), "# agents\n");
      assert.deepEqual(loadState({ parent, home, matrix, cwd: outside() }).source, { kind: "sheet", path: sheetPathFor(parent, home) });
    });
  }

  it("carries a copied profile's imported sheet into the redirected home and leaves the imported file alone", () => {
    const cfg = join(home, "cfg");
    const env = { CLAUDE_CONFIG_DIR: cfg };
    const imported = put(join(home, ".claude", "pstack-models.md"), sheetWithHighHillclimb());
    const integration = put(join(cfg, "CLAUDE.md"), `# work profile\n${CLAUDE_INCLUDE_LINE}\n`);
    const result = unwireSheet({ parent: "claude", home, env, matrix });
    assert.deepEqual([result.sheet, result.integration, result.removedLegacy], ["created", "updated", []]);
    assert.equal(result.sheetPath, sheetPathFor("claude", home, env));
    assert.equal(readFileSync(sheetPathFor("claude", home, env), "utf8"), sheetWithHighHillclimb());
    assert.equal(readFileSync(integration, "utf8"), "# work profile\n");
    assert.equal(readFileSync(imported, "utf8"), sheetWithHighHillclimb());
  });

  it("removes an import whose target is gone and writes no sheet", () => {
    const integration = put(join(home, ".claude", "CLAUDE.md"), "@~/gone/pstack-models.md\n");
    const result = unwireSheet({ parent: "claude", home, matrix });
    assert.deepEqual([result.sheet, result.integration, result.missingImport], ["unchanged", "updated", join(home, "gone", "pstack-models.md")]);
    assert.equal(readFileSync(integration, "utf8"), "");
    assert.equal(existsSync(sheetPathFor("claude", home)), false);
  });

  it("reaches the global Codex block from the home folder, whose .codex is the config home", () => {
    const sheet = putSheet("codex", firstRunSheet("codex"));
    const integration = put(integrationPathFor("codex", home), `# agents\n${CODEX_BLOCK_BEGIN}\n${firstRunSheet("codex")}${CODEX_BLOCK_END}\n`);
    assert.equal(resolveRoles({ parent: "codex", home, matrix, cwd: home }).legacyWiring, integration);
    const result = unwireSheet({ parent: "codex", home, matrix, cwd: home });
    assert.deepEqual([result.sheetPath, result.integrationPath, result.sheet, result.integration], [sheet, integration, "unchanged", "updated"]);
    assert.equal(readFileSync(integration, "utf8"), "# agents\n");
    assert.equal(resolveRoles({ parent: "codex", home, matrix, cwd: home }).legacyWiring, null);
  });

  it("takes a CRLF block's sheet from after its line break and removes the block with its line break", () => {
    const integration = put(integrationPathFor("grok", home), `# g\r\n${CODEX_BLOCK_BEGIN}\r\n${firstRunSheet("grok")}${CODEX_BLOCK_END}\r\nKeep\r\n`);
    const result = unwireSheet({ parent: "grok", home, matrix });
    assert.deepEqual([result.sheet, result.integration], ["created", "updated"]);
    assert.equal(readFileSync(sheetPathFor("grok", home), "utf8"), firstRunSheet("grok"));
    assert.equal(readFileSync(integration, "utf8"), "# g\r\nKeep\r\n");
  });

  it("stops on a sheet and block that disagree, touching nothing", () => {
    const sheet = putSheet("codex", firstRunSheet("codex"));
    const changed = firstRunSheet("codex").replace("hillclimb: codex:gpt-6-sol@xhigh", "hillclimb: codex:gpt-6-sol@high");
    const wired = `${CODEX_BLOCK_BEGIN}\n${changed}${CODEX_BLOCK_END}\n`;
    const integration = put(integrationPathFor("codex", home), wired);
    assert.throws(() => unwireSheet({ parent: "codex", home, matrix, cwd: outside() }), /assign different lanes to hillclimb/);
    assert.equal(readFileSync(sheet, "utf8"), firstRunSheet("codex"));
    assert.equal(readFileSync(integration, "utf8"), wired);
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
  return isolatedEnv(home, [bin], { NO_COLOR: "1", ...extra });
}

/** For a command that must launch nothing: not even the fakes are on PATH, so a lane that starts anyway finds no CLI. */
function noCliEnv(): NodeJS.ProcessEnv {
  return isolatedEnv(home, [], { NO_COLOR: "1" });
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

describe("Codex parent network admission", () => {
  const familyNames = "Fable (claude:fable), Opus (claude:claude-opus-5-5), Grok (grok:grok-4.6), Grok-4-7 (grok:grok-4.7)";
  const networkWarnings = (plan: Plan) => plan.warnings.filter((warning) => warning.includes("Codex parent sandbox"));

  it("warns once about the complete selected family map, including verified families", () => {
    putLedger("codex", matrix.families.map((family) => family.family));
    const plan = buildPlan({ parent: "codex", home, matrix, env: { CODEX_SANDBOX_NETWORK_DISABLED: "1" } });
    assert.equal(plan.schemaVersion, 7);
    assert.deepEqual(plan.pairs, []);
    assert.equal(networkWarnings(plan).length, 1);
    assert.match(networkWarnings(plan)[0], /CODEX_SANDBOX_NETWORK_DISABLED=1/);
    assert.ok(networkWarnings(plan)[0].includes(familyNames));
    assert.match(networkWarnings(plan)[0], /provider-dispatch\.md#host-and-parent-prerequisites/);
    const roles = Object.fromEntries(plan.rows.map((row) => [row.role, row.lanes.map((lane) => lane.replace("claude:fable@", "claude:claude-opus-5-5@"))]));
    const removed = buildPlan({ parent: "codex", home, matrix, roles, env: { CODEX_SANDBOX_NETWORK_DISABLED: "1" } });
    assert.equal(networkWarnings(removed).length, 1);
    assert.doesNotMatch(networkWarnings(removed)[0], /Fable|codex:/);
    assert.match(networkWarnings(removed)[0], /Opus .*Grok .*Grok-4-7/);
  });

  it("uses matrix routes to decide which selected families are external", () => {
    const routes = { ...matrix.routes, codex: { ...matrix.routes.codex, claude: "native" as const } };
    const plan = buildPlan({ parent: "codex", home, matrix: { ...matrix, routes }, env: { CODEX_SANDBOX_NETWORK_DISABLED: "1" } });
    assert.equal(networkWarnings(plan).length, 1);
    assert.doesNotMatch(networkWarnings(plan)[0], /Fable|Opus/);
    assert.ok(networkWarnings(plan)[0].includes("Grok (grok:grok-4.6), Grok-4-7 (grok:grok-4.7)"));
  });

  it("refuses before directory creation or provider activity even with no pending pairs", async () => {
    for (const verified of [false, true]) {
      if (verified) putLedger("codex", matrix.families.map((family) => family.family));
      const plan = buildPlan({ parent: "codex", home, matrix });
      const dir = join(home, verified ? "verified-refusal" : "first-refusal");
      const log = join(home, "refused-invocations.log");
      await assert.rejects(runProbes(plan, { dir, env: fakeEnv({ CODEX_SANDBOX_NETWORK_DISABLED: "1", FAKE_INVOCATION_LOG: log }) }),
        (error: unknown) => error instanceof SetupError && error.message.includes(familyNames));
      assert.equal(existsSync(dir), false);
      assert.equal(existsSync(log), false);
    }
  });

  it("the CLI plans a warning and refuses probing with exit 1 and no new artifacts", () => {
    const env = fakeEnv({ CODEX_SANDBOX_NETWORK_DISABLED: "1" });
    const planned = cli(["plan", "--parent", "codex", "--home", home, "--dir", runDir], env);
    assert.equal(planned.code, 0, planned.stderr);
    assert.ok(JSON.parse(planned.stdout).warnings.some((warning: string) => warning.includes(familyNames)));
    const probed = cli(["probe", "--dir", runDir], env);
    assert.equal(probed.code, 1);
    assert.match(probed.stderr, /Codex parent sandbox has network disabled/);
    assert.deepEqual(readdirSync(runDir), ["plan.json"]);
  });

  it("forwards the CLI's injected current environment instead of saved warnings or ambient state", async () => {
    const plan = buildPlan({ parent: "codex", home, matrix });
    savePlan(runDir, plan);
    const errors: string[] = [];
    const code = await main(["probe", "--dir", runDir], { env: fakeEnv({ CODEX_SANDBOX_NETWORK_DISABLED: "1" }),
      stdout: () => assert.fail("blocked probe emitted a summary"), stderr: (value) => errors.push(value) });
    assert.equal(code, 1);
    assert.match(errors.join(""), /Codex parent sandbox has network disabled/);
    assert.deepEqual(readdirSync(runDir), ["plan.json"]);

    process.env.CODEX_SANDBOX_NETWORK_DISABLED = "1";
    const log = join(home, "allowed-invocations.log");
    const output: string[] = [];
    const allowed = await main(["probe", "--dir", runDir], { env: fakeEnv({ CODEX_SANDBOX_NETWORK_DISABLED: "0", FAKE_INVOCATION_LOG: log }),
      stdout: (value) => output.push(value), stderr: (value) => assert.fail(value) });
    assert.equal(allowed, 0);
    assert.equal(JSON.parse(output.join("")).externalOk, true);
    assert.match(readFileSync(log, "utf8"), /claude|grok/);
  });

  it("does not warn or refuse a Claude parent with the same marker", async () => {
    const env = fakeEnv({ CODEX_SANDBOX_NETWORK_DISABLED: "1" });
    const plan = buildPlan({ parent: "claude", home, matrix, env });
    assert.deepEqual(networkWarnings(plan), []);
    const summary = await runProbes(plan, { dir: runDir, env });
    assert.equal(summary.externalOk, true);
    assert.deepEqual(summary.external.map((result) => [result.family, result.status]), [["sol-6-1", "passed"], ["astra", "passed"], ["grok", "passed"], ["grok-4-7", "passed"]]);
  });

  it("uses exact markers and preserves unblocked empty summaries and buildPlan's default environment", async () => {
    putLedger("codex", matrix.families.map((family) => family.family));
    process.env.CODEX_SANDBOX_NETWORK_DISABLED = "1";
    assert.deepEqual(networkWarnings(buildPlan({ parent: "codex", home, matrix })), []);
    for (const marker of [undefined, "0", "true"]) {
      const env = fakeEnv(marker === undefined ? {} : { CODEX_SANDBOX_NETWORK_DISABLED: marker });
      const plan = buildPlan({ parent: "codex", home, matrix, env });
      assert.deepEqual(networkWarnings(plan), []);
      const summary = await runProbes({ ...plan, warnings: ["Codex parent sandbox saved warning"] }, { dir: runDir, env });
      assert.deepEqual(summary, { external: [], native: [], owner: null, externalOk: true, ok: true });
    }
    const plan = buildPlan({ parent: "codex", home, matrix });
    await assert.rejects(runProbes(plan, { dir: join(home, "ambient-refusal") }), /Codex parent sandbox/);
    assert.equal(existsSync(join(home, "ambient-refusal")), false);
  });

  it("keeps cross-family validation authoritative for native-only role changes", () => {
    const roles = Object.fromEntries(matrix.roles.map((role) => [role.role, ["codex:gpt-6.1-sol@xhigh"]]));
    assert.throws(() => buildPlan({ parent: "codex", home, matrix, roles, env: { CODEX_SANDBOX_NETWORK_DISABLED: "1" } }), /trail reviewer pool|cross-family/);
  });
});

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
  it("writes a Grok sheet only after its native and external probes and leaves the global rules alone", async () => {
    const plan = await planAndProbe("grok");
    const integration = integrationPathFor("grok", home);
    mkdirSync(dirname(integration), { recursive: true });
    writeFileSync(integration, "Keep these global Grok rules.\n");
    const result = writeSheet(plan, runDir, { home });
    assert.deepEqual([result.sheet, result.integration], ["created", "unchanged"]);
    assert.equal(readFileSync(integration, "utf8"), "Keep these global Grok rules.\n");
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

  it("on a Claude first run creates the sheet and the ledger but no CLAUDE.md, and an unchanged rerun is byte-identical", async () => {
    const plan = await planAndProbe("claude");
    const result = writeSheet(plan, runDir, { home });
    assert.deepEqual([result.sheet, result.integration, result.ledger], ["created", "unchanged", "created"]);
    assert.equal(readFileSync(plan.sheetPath, "utf8"), plan.sheet);
    assert.equal(existsSync(plan.integrationPath), false);
    assert.equal(plan.integrationPath, integrationPathFor("claude", home));
    const before = [plan.sheetPath, plan.ledgerPath].map((path) => statSync(path).mtimeMs);

    const again = await planAndProbe("claude");
    assert.equal(again.firstRun, false);
    assert.equal(again.sheet, plan.sheet);
    assert.deepEqual(again.pairs, []);
    const rerun = writeSheet(again, runDir, { home });
    assert.deepEqual([rerun.sheet, rerun.integration, rerun.ledger], ["unchanged", "unchanged", "unchanged"]);
    assert.deepEqual([plan.sheetPath, plan.ledgerPath].map((path) => statSync(path).mtimeMs), before);
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

  it("after an earlier version's setup carries its config-home ledger into the data folder, probes only a family it lacks, and deletes both legacy files", async () => {
    const configHome = configHomeFor("claude", home);
    const legacySheet = put(join(configHome, "pstack-models.md"), sheetWithHighHillclimb());
    const legacyLedger = putLedger("claude", ["fable", "opus", "sol-6-1", "astra", "grok"], join(configHome, "pstack-probes.json"));
    const legacyFamilies = JSON.parse(readFileSync(legacyLedger, "utf8")).families;
    assert.deepEqual(
      buildPlan({ parent: "claude", home, matrix }).pairs.map((p) => p.pair),
      ["grok-4-7@xhigh"],
      "every family the legacy ledger verified needs no new probe"
    );

    const plan = await planAndProbe("claude");
    assert.equal(plan.firstRun, false);
    assert.equal(plan.sheet, sheetWithHighHillclimb());
    assert.deepEqual(plan.verified.map((v) => v.family), ["fable", "opus", "sol-6-1", "astra", "grok"]);
    const result = writeSheet(plan, runDir, { home });
    assert.deepEqual([result.sheet, result.integration, result.ledger, result.removedLegacy], ["created", "unchanged", "created", [legacySheet, legacyLedger]]);
    assert.equal(readFileSync(sheetPathFor("claude", home), "utf8"), sheetWithHighHillclimb());
    assert.deepEqual([legacySheet, legacyLedger].map((path) => existsSync(path)), [false, false]);
    const families = JSON.parse(readFileSync(ledgerPathFor("claude", home), "utf8")).families;
    assert.deepEqual(Object.keys(families).sort(), [...Object.keys(legacyFamilies), "grok:grok-4.7"].sort());
    for (const [key, entry] of Object.entries(legacyFamilies)) assert.deepEqual(families[key], entry, key);
    assert.equal(families["grok:grok-4.7"].evidence, runDir);

    assert.deepEqual(loadState({ parent: "claude", home, matrix }).legacyFiles, []);
    const again = buildPlan({ parent: "claude", home, matrix });
    assert.deepEqual(again.pairs, []);
    assert.equal(again.sheet, sheetWithHighHillclimb());
  });

  it("on a mixed sheet creates then reports unchanged without touching mtimes", async () => {
    const plan = await planAndProbe("claude", { roles: { hillclimb: ["grok:grok-4.6@high"] } });
    assert.deepEqual(plan.efforts.grok, ["high", "xhigh"]);
    const result = writeSheet(plan, runDir, { home });
    assert.deepEqual([result.sheet, result.integration], ["created", "unchanged"]);
    assert.equal(readFileSync(plan.sheetPath, "utf8"), plan.sheet);
    const before = statSync(plan.sheetPath).mtimeMs;

    const again = await planAndProbe("claude");
    assert.equal(again.sheet, plan.sheet);
    const rerun = writeSheet(again, runDir, { home });
    assert.deepEqual([rerun.sheet, rerun.integration], ["unchanged", "unchanged"]);
    assert.equal(statSync(plan.sheetPath).mtimeMs, before);
  });

  it("removes the include an earlier version appended to CLAUDE.md and treats a duplicate include as inconsistent", async () => {
    const integration = integrationPathFor("claude", home);
    mkdirSync(dirname(integration), { recursive: true });
    writeFileSync(integration, `# mine\n${CLAUDE_INCLUDE_LINE}\n`);
    const plan = await planAndProbe("claude");
    const result = writeSheet(plan, runDir, { home });
    assert.deepEqual([result.sheet, result.integration], ["created", "updated"]);
    assert.equal(readFileSync(integration, "utf8"), "# mine\n");

    const again = await planAndProbe("claude", { efforts: { grok: "high" } });
    const duplicated = `${CLAUDE_INCLUDE_LINE}\n# mine\n- @./pstack-models.md\n`;
    writeFileSync(integration, duplicated);
    const stop = { message: `inconsistent state: ${integration} imports pstack-models.md 2 times (lines 1, 3); keep exactly one import` };
    assert.throws(() => writeSheet(again, runDir, { home }), stop);
    assert.throws(() => loadState({ parent: "claude", home, matrix }), stop);
    assert.equal(readFileSync(plan.sheetPath, "utf8"), plan.sheet, "sheet untouched when the integration is inconsistent");
    assert.equal(readFileSync(integration, "utf8"), duplicated);
  });

  it("on Codex removes the block an earlier version appended to AGENTS.md and keeps the rest of the file", async () => {
    const integration = integrationPathFor("codex", home);
    mkdirSync(dirname(integration), { recursive: true });
    writeFileSync(integration, `# agents\n\nKeep this.\n${CODEX_BLOCK_BEGIN}\n${firstRunSheet("codex")}${CODEX_BLOCK_END}\n`);
    const plan = await planAndProbe("codex");
    assert.equal(plan.sheet, firstRunSheet("codex"));
    const result = writeSheet(plan, runDir, { home });
    assert.deepEqual([result.sheet, result.integration], ["created", "updated"]);
    assert.equal(readFileSync(integration, "utf8"), "# agents\n\nKeep this.\n");

    const changed = await planAndProbe("codex", { efforts: { grok: "high" } });
    const again = writeSheet(changed, runDir, { home });
    assert.deepEqual([again.sheet, again.integration], ["updated", "unchanged"]);
    assert.equal(readFileSync(integration, "utf8"), "# agents\n\nKeep this.\n");
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

  it("refuses an unwritable CLAUDE.md that still holds the old include before touching an existing sheet, and writes past one without it", async (t) => {
    const plan = await planAndProbe("claude");
    writeSheet(plan, runDir, { home });
    const changed = await planAndProbe("claude", { efforts: { grok: "high" } });
    writeFileSync(changed.integrationPath, `# mine\n${CLAUDE_INCLUDE_LINE}\n`);
    chmodSync(changed.integrationPath, 0o444);
    if (!permissionDenied(changed.integrationPath, fs.constants.W_OK)) return t.skip("this host permits writes to chmod 0444 files; no OS permission proof");
    const before = targetState(changed);
    assertNoMutations(() => assert.throws(() => writeSheet(changed, runDir, { home }), /integration.*not writable/));
    assert.deepEqual(targetState(changed), before);
    assert.equal(readFileSync(changed.sheetPath, "utf8"), plan.sheet);

    chmodSync(changed.integrationPath, 0o644);
    writeFileSync(changed.integrationPath, "# mine\n");
    chmodSync(changed.integrationPath, 0o444);
    const result = writeSheet(changed, runDir, { home });
    assert.deepEqual([result.sheet, result.integration], ["updated", "unchanged"]);
    assert.equal(readFileSync(changed.integrationPath, "utf8"), "# mine\n");
  });

  it("creates no first-run sheet or ledger when an AGENTS.md that still holds the old block is unwritable", async (t) => {
    const plan = await planAndProbe("codex");
    mkdirSync(dirname(plan.integrationPath), { recursive: true });
    writeFileSync(plan.integrationPath, `${CODEX_BLOCK_BEGIN}\n${firstRunSheet("codex")}${CODEX_BLOCK_END}\n`);
    chmodSync(plan.integrationPath, 0o444);
    if (!permissionDenied(plan.integrationPath, fs.constants.W_OK)) return t.skip("this host permits writes to chmod 0444 files; no OS permission proof");
    const before = targetState(plan);
    assertNoMutations(() => assert.throws(() => writeSheet(plan, runDir, { home }), /integration.*not writable/));
    assert.deepEqual(targetState(plan), before);
    assert.equal(existsSync(plan.sheetPath), false);
    assert.equal(existsSync(plan.ledgerPath), false);
  });

  it("refuses a changing unwritable ledger before creating the sheet", async (t) => {
    const plan = await planAndProbe("claude");
    mkdirSync(dirname(plan.ledgerPath), { recursive: true });
    writeFileSync(plan.ledgerPath, `{"schemaVersion":1,"families":{}}\n`);
    chmodSync(plan.ledgerPath, 0o444);
    if (!permissionDenied(plan.ledgerPath, fs.constants.W_OK)) return t.skip("this host permits writes to chmod 0444 files; no OS permission proof");
    const before = targetState(plan);
    assertNoMutations(() => assert.throws(() => writeSheet(plan, runDir, { home }), /probe ledger.*not writable/));
    assert.deepEqual(targetState(plan), before);
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

function permissionDenied(path: string, mode: number): boolean {
  try {
    fs.accessSync(path, mode);
    return false;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "EACCES" || error.code === "EPERM")) return true;
    throw error;
  }
}

function targetState(plan: Plan) {
  return [plan.sheetPath, plan.integrationPath, plan.ledgerPath].map((path) => existsSync(path)
    ? { bytes: readFileSync(path, "utf8"), mtime: statSync(path).mtimeMs }
    : null);
}

function assertNoMutations(action: () => void): void {
  const mutations: string[] = [];
  const mocks = (["mkdirSync", "writeFileSync", "unlinkSync"] as const).map((name) => {
    const original = fs[name];
    return mock.method(fs, name, (...args: unknown[]) => {
      mutations.push(`${name} ${String(args[0])}`);
      return Reflect.apply(original, fs, args);
    });
  });
  syncBuiltinESMExports();
  try {
    action();
    assert.deepEqual(mutations, [], "admission changed the filesystem before refusing");
  } finally {
    for (const method of mocks) method.mock.restore();
    syncBuiltinESMExports();
  }
}

describe("write admission", () => {
  beforeEach(() => putLedger("claude", matrix.families.map((family) => family.family)));

  it("refuses an unwritable sheet before any target changes", (t) => {
    const plan = buildPlan({ parent: "claude", home, matrix });
    writeFileSync(plan.sheetPath, "# old sheet\n");
    chmodSync(plan.sheetPath, 0o444);
    if (!permissionDenied(plan.sheetPath, fs.constants.W_OK)) return t.skip("this host permits writes to chmod 0444 files; no OS permission proof");
    const before = targetState(plan);
    assertNoMutations(() => assert.throws(() => writeSheet(plan, runDir, { home }), /sheet.*not writable/));
    assert.deepEqual(targetState(plan), before);
  });

  it("does not check a CLAUDE.md without wiring when the sheet changes", () => {
    const initial = buildPlan({ parent: "claude", home, matrix });
    writeSheet(initial, runDir, { home });
    const plan = buildPlan({ parent: "claude", home, matrix, efforts: { grok: "high" } });
    writeFileSync(plan.integrationPath, "# mine\n");
    chmodSync(plan.integrationPath, 0o444);
    const result = writeSheet(plan, runDir, { home });
    assert.deepEqual([result.sheet, result.integration], ["updated", "unchanged"]);
    assert.equal(readFileSync(plan.integrationPath, "utf8"), "# mine\n");
  });

  it("does not check an unchanged sheet when only the old include goes", () => {
    const plan = buildPlan({ parent: "claude", home, matrix });
    writeFileSync(plan.sheetPath, plan.sheet);
    writeFileSync(plan.integrationPath, `# mine\n${CLAUDE_INCLUDE_LINE}\n`);
    chmodSync(plan.sheetPath, 0o444);
    const result = writeSheet(plan, runDir, { home });
    assert.deepEqual([result.sheet, result.integration], ["unchanged", "updated"]);
    assert.equal(readFileSync(plan.integrationPath, "utf8"), "# mine\n");
  });

  it("admits no writes or access checks when all target bytes are identical", () => {
    const plan = buildPlan({ parent: "claude", home, matrix });
    writeSheet(plan, runDir, { home });
    for (const path of [plan.sheetPath, plan.ledgerPath]) chmodSync(path, 0o444);
    const before = targetState(plan);
    const access = mock.method(fs, "accessSync", () => { throw new Error("no-op unexpectedly checked access"); });
    syncBuiltinESMExports();
    try {
      assertNoMutations(() => {
        const result = writeSheet(plan, runDir, { home });
        assert.deepEqual([result.sheet, result.integration, result.ledger], ["unchanged", "unchanged", "unchanged"]);
      });
      assert.equal(access.mock.callCount(), 0);
      assert.deepEqual(targetState(plan), before);
    } finally {
      access.mock.restore();
      syncBuiltinESMExports();
    }
  });

  it("does not require write permission for an unchanged ledger during a sheet update", () => {
    const initial = buildPlan({ parent: "claude", home, matrix });
    writeSheet(initial, runDir, { home });
    const plan = buildPlan({ parent: "claude", home, matrix, efforts: { grok: "high" } });
    chmodSync(plan.ledgerPath, 0o444);
    const before = targetState(plan)[2];
    const result = writeSheet(plan, runDir, { home });
    assert.deepEqual([result.sheet, result.integration, result.ledger], ["updated", "unchanged", "unchanged"]);
    assert.equal(readFileSync(plan.sheetPath, "utf8"), plan.sheet);
    assert.deepEqual(targetState(plan)[2], before);
  });

  it("admits existing writable files even when their directory is not writable", (t) => {
    const initial = buildPlan({ parent: "claude", home, matrix });
    writeSheet(initial, runDir, { home });
    const plan = buildPlan({ parent: "claude", home, matrix, efforts: { grok: "high" } });
    const configHome = dirname(plan.sheetPath);
    chmodSync(configHome, 0o555);
    try {
      if (!permissionDenied(configHome, fs.constants.W_OK)) return t.skip("this host bypasses directory write permissions; no OS permission proof");
      const result = writeSheet(plan, runDir, { home });
      assert.deepEqual([result.sheet, result.integration, result.ledger], ["updated", "unchanged", "unchanged"]);
      assert.equal(readFileSync(plan.sheetPath, "utf8"), plan.sheet);
    } finally {
      chmodSync(configHome, 0o755);
    }
  });

  it("checks ledger creation when the sheet already has the rendered bytes", async (t) => {
    rmSync(ledgerPathFor("claude", home));
    const plan = await planAndProbe("claude");
    writeFileSync(plan.sheetPath, plan.sheet);
    const configHome = dirname(plan.sheetPath);
    chmodSync(configHome, 0o555);
    try {
      if (!permissionDenied(configHome, fs.constants.W_OK | fs.constants.X_OK)) return t.skip("this host permits creation in chmod 0555 directories; no OS permission proof");
      const before = targetState(plan);
      assertNoMutations(() => assert.throws(() => writeSheet(plan, runDir, { home }), /probe ledger.*not writable/));
      assert.deepEqual(targetState(plan), before);
      assert.equal(existsSync(plan.ledgerPath), false);
    } finally {
      chmodSync(configHome, 0o755);
    }
  });

  it("checks the nearest existing parent of missing targets without creating directories", (t) => {
    const cfg = join(home, "blocked", "nested", "config");
    const env = { CLAUDE_CONFIG_DIR: cfg };
    const original = buildPlan({ parent: "claude", home, matrix });
    const plan = { ...original, sheetPath: sheetPathFor("claude", home, env), integrationPath: integrationPathFor("claude", home, env), ledgerPath: ledgerPathFor("claude", home, env) };
    const ancestor = join(home, "blocked");
    mkdirSync(ancestor);
    chmodSync(ancestor, 0o555);
    try {
      if (!permissionDenied(ancestor, fs.constants.W_OK | fs.constants.X_OK)) return t.skip("this host permits creation in chmod 0555 directories; no OS permission proof");
      assertNoMutations(() => assert.throws(() => writeSheet(plan, runDir, { home, env }), /sheet.*not writable.*blocked/));
      assert.deepEqual(readdirSync(ancestor), []);
    } finally {
      chmodSync(ancestor, 0o755);
    }
    const result = writeSheet(plan, runDir, { home, env });
    assert.deepEqual([result.sheet, result.integration, result.ledger], ["created", "unchanged", "unchanged"]);
    assert.equal(existsSync(plan.integrationPath), false);
  });

  it("refuses a missing target in an unwritable config directory", (t) => {
    const plan = buildPlan({ parent: "claude", home, matrix });
    chmodSync(dirname(plan.sheetPath), 0o555);
    try {
      if (!permissionDenied(dirname(plan.sheetPath), fs.constants.W_OK | fs.constants.X_OK)) return t.skip("this host permits creation in chmod 0555 directories; no OS permission proof");
      const before = targetState(plan);
      assertNoMutations(() => assert.throws(() => writeSheet(plan, runDir, { home }), /sheet.*not writable/));
      assert.deepEqual(targetState(plan), before);
    } finally {
      chmodSync(dirname(plan.sheetPath), 0o755);
    }
  });

  it("propagates inspection permission errors rather than treating them as absence", (t) => {
    const plan = buildPlan({ parent: "claude", home, matrix });
    chmodSync(dirname(plan.sheetPath), 0o600);
    try {
      if (!permissionDenied(dirname(plan.sheetPath), fs.constants.X_OK)) return t.skip("this host bypasses directory search permissions; no OS permission proof");
      assertNoMutations(() => assert.throws(() => writeSheet(plan, runDir, { home }), /sheet.*EACCES/));
    } finally {
      chmodSync(dirname(plan.sheetPath), 0o755);
    }
    assert.equal(existsSync(plan.sheetPath), false);
  });

  it("refuses ENOTDIR without hiding it as a missing target", () => {
    const initial = buildPlan({ parent: "claude", home, matrix });
    const cfg = join(home, "file-parent", "nested");
    const env = { CLAUDE_CONFIG_DIR: cfg };
    writeFileSync(dirname(cfg), "not a directory\n");
    const plan = { ...initial, sheetPath: sheetPathFor("claude", home, env), integrationPath: integrationPathFor("claude", home, env), ledgerPath: ledgerPathFor("claude", home, env) };
    assertNoMutations(() => assert.throws(() => writeSheet(plan, runDir, { home, env }), /sheet.*ENOTDIR/));
    assert.equal(readFileSync(dirname(cfg), "utf8"), "not a directory\n");
  });

  for (const target of ["sheetPath", "integrationPath", "ledgerPath"] as const) {
    it(`refuses a dangling ${target} symlink without writing through it`, () => {
      const plan = buildPlan({ parent: "claude", home, matrix });
      const missing = join(home, `missing-${target}`);
      if (existsSync(plan[target])) rmSync(plan[target]);
      symlinkSync(missing, plan[target]);
      assertNoMutations(() => assert.throws(() => writeSheet(plan, runDir, { home }), /ENOENT/));
      assert.equal(readlinkSync(plan[target]), missing);
      assert.equal(existsSync(missing), false);
      assert.equal(existsSync(target === "sheetPath" ? plan.integrationPath : plan.sheetPath), false);
    });
  }

  it("refuses to delete an earlier version's sheet from a read-only config home before any target changes", (t) => {
    const cfg = join(home, ".claude");
    const legacy = put(join(cfg, "pstack-models.md"), sheetWithHighHillclimb());
    chmodSync(cfg, 0o555);
    try {
      if (!permissionDenied(cfg, fs.constants.W_OK)) return t.skip("this host permits writes to a chmod 0555 folder; no OS permission proof");
      assertNoMutations(() => assert.throws(() => unwireSheet({ parent: "claude", home, matrix }), /legacy sheet .*pstack-models\.md is not writable \(checked .*\.claude:/));
      assert.equal(existsSync(sheetPathFor("claude", home)), false);
      assert.equal(readFileSync(legacy, "utf8"), sheetWithHighHillclimb());
    } finally {
      chmodSync(cfg, 0o755);
    }
  });

  it("deletes a read-only earlier-version sheet from a writable config home: deleting needs the folder, not the file", () => {
    const legacy = put(join(home, ".claude", "pstack-models.md"), sheetWithHighHillclimb());
    chmodSync(legacy, 0o444);
    const result = unwireSheet({ parent: "claude", home, matrix });
    assert.deepEqual(result.removedLegacy, [legacy]);
    assert.equal(existsSync(legacy), false);
    assert.equal(readFileSync(sheetPathFor("claude", home), "utf8"), sheetWithHighHillclimb());
  });

  it("refuses a dangling config-home symlink before creating its referent", () => {
    const initial = buildPlan({ parent: "claude", home, matrix });
    const cfg = join(home, "dangling-config");
    const missing = join(home, "missing-config");
    const env = { CLAUDE_CONFIG_DIR: cfg };
    symlinkSync(missing, cfg);
    const plan = { ...initial, sheetPath: sheetPathFor("claude", home, env), integrationPath: integrationPathFor("claude", home, env), ledgerPath: ledgerPathFor("claude", home, env) };
    assertNoMutations(() => assert.throws(() => writeSheet(plan, runDir, { home, env }), /sheet.*ENOENT/));
    assert.equal(readlinkSync(cfg), missing);
    assert.equal(existsSync(missing), false);
  });

  it("refuses a symlink cycle before any target mutation", () => {
    const plan = buildPlan({ parent: "claude", home, matrix });
    const left = join(dirname(plan.sheetPath), "loop-left");
    const right = join(dirname(plan.sheetPath), "loop-right");
    symlinkSync(right, left);
    symlinkSync(left, right);
    symlinkSync(left, plan.sheetPath);
    const ledger = readFileSync(plan.ledgerPath, "utf8");
    assertNoMutations(() => assert.throws(() => writeSheet(plan, runDir, { home }), /sheet.*ELOOP/));
    assert.equal(readlinkSync(plan.sheetPath), left);
    assert.equal(readlinkSync(left), right);
    assert.equal(readlinkSync(right), left);
    assert.equal(existsSync(plan.integrationPath), false);
    assert.equal(readFileSync(plan.ledgerPath, "utf8"), ledger);
  });

  it("refuses a usable file symlink with a read-only referent without changing its peers", (t) => {
    const plan = buildPlan({ parent: "claude", home, matrix });
    const target = join(home, "read-only-sheet-target.md");
    writeFileSync(target, "# original sheet\n");
    symlinkSync(target, plan.sheetPath);
    writeFileSync(plan.integrationPath, "# original integration\n");
    chmodSync(target, 0o444);
    try {
      if (!permissionDenied(target, fs.constants.W_OK)) return t.skip("this host permits writes to chmod 0444 referents; no OS permission proof");
      const before = targetState(plan);
      assertNoMutations(() => assert.throws(() => writeSheet(plan, runDir, { home }), /sheet.*not writable/));
      assert.equal(lstatSync(plan.sheetPath).isSymbolicLink(), true);
      assert.equal(readlinkSync(plan.sheetPath), target);
      assert.equal(readFileSync(target, "utf8"), "# original sheet\n");
      assert.deepEqual(targetState(plan), before);
    } finally {
      chmodSync(target, 0o644);
    }
  });

  it("preserves usable file and directory symlinks when updating their referents", () => {
    const cfg = join(home, "linked-config");
    symlinkSync(join(home, ".claude"), cfg);
    const env = { CLAUDE_CONFIG_DIR: cfg };
    const plan = buildPlan({ parent: "claude", home, matrix, env });
    const sheet = join(home, "sheet-target.md");
    const integration = join(home, "integration-target.md");
    writeFileSync(sheet, "# old\n");
    writeFileSync(integration, "# mine\n@./pstack-models.md\n");
    symlinkSync(sheet, plan.sheetPath);
    symlinkSync(integration, plan.integrationPath);
    const result = writeSheet(plan, runDir, { home, env });
    assert.deepEqual([result.sheet, result.integration, result.ledger], ["updated", "updated", "unchanged"]);
    assert.equal(readlinkSync(plan.sheetPath), sheet);
    assert.equal(readlinkSync(plan.integrationPath), integration);
    assert.equal(readlinkSync(cfg), join(home, ".claude"));
    assert.equal(readFileSync(sheet, "utf8"), plan.sheet);
    assert.equal(readFileSync(integration, "utf8"), "# mine\n");
  });
});

describe("late write failures after admission", () => {
  for (const failed of ["integrationPath", "ledgerPath"] as const) {
    it(`restores original bytes after a late ${failed} failure`, async () => {
      const plan = await planAndProbe("codex");
      mkdirSync(dirname(plan.sheetPath), { recursive: true });
      writeFileSync(plan.sheetPath, "# original sheet\n");
      writeFileSync(plan.integrationPath, `# original integration\n${CODEX_BLOCK_BEGIN}\n# original sheet\n${CODEX_BLOCK_END}\n`);
      writeFileSync(plan.ledgerPath, '{"schemaVersion":1,"families":{}}\n');
      const before = targetState(plan).map((target) => target?.bytes);
      const original = fs.writeFileSync;
      const written: string[] = [];
      let failedOnce = false;
      const write = mock.method(fs, "writeFileSync", (...args: unknown[]) => {
        if (args[0] === plan[failed] && !failedOnce) {
          failedOnce = true;
          throw new Error("late injected failure");
        }
        written.push(String(args[0]));
        return Reflect.apply(original, fs, args);
      });
      syncBuiltinESMExports();
      try {
        assert.throws(() => writeSheet(plan, runDir, { home }), /late injected failure.*every snapshot restored/);
        assert.ok(written.includes(plan.sheetPath));
        if (failed === "ledgerPath") assert.ok(written.includes(plan.integrationPath));
        assert.deepEqual(targetState(plan).map((target) => target?.bytes), before);
      } finally {
        write.mock.restore();
        syncBuiltinESMExports();
      }
    });
  }

  it("removes newly created files after a late ledger failure", async () => {
    const plan = await planAndProbe("claude");
    const original = fs.writeFileSync;
    const write = mock.method(fs, "writeFileSync", (...args: unknown[]) => {
      if (args[0] === plan.ledgerPath) throw new Error("late ledger failure");
      return Reflect.apply(original, fs, args);
    });
    syncBuiltinESMExports();
    try {
      assert.throws(() => writeSheet(plan, runDir, { home }), /late ledger failure.*every snapshot restored/);
      assert.deepEqual(targetState(plan), [null, null, null]);
    } finally {
      write.mock.restore();
      syncBuiltinESMExports();
    }
  });

  it("restores targets after a readback mismatch", () => {
    putLedger("claude", matrix.families.map((family) => family.family));
    const plan = buildPlan({ parent: "claude", home, matrix });
    const original = fs.writeFileSync;
    const write = mock.method(fs, "writeFileSync", (...args: unknown[]) => {
      if (args[0] === plan.sheetPath) return original(plan.sheetPath, "corrupted render\n");
      return Reflect.apply(original, fs, args);
    });
    syncBuiltinESMExports();
    try {
      assert.throws(() => writeSheet(plan, runDir, { home }), /read back differs from the render.*every snapshot restored/);
      assert.deepEqual(targetState(plan).slice(0, 2), [null, null]);
      assert.match(readFileSync(plan.ledgerPath, "utf8"), /verifiedAt/);
    } finally {
      write.mock.restore();
      syncBuiltinESMExports();
    }
  });

  it("continues restoring later targets when one restoration fails", async () => {
    const plan = await planAndProbe("codex");
    mkdirSync(dirname(plan.sheetPath), { recursive: true });
    writeFileSync(plan.sheetPath, "# original sheet\n");
    writeFileSync(plan.integrationPath, "# original integration\n");
    const original = fs.writeFileSync;
    const write = mock.method(fs, "writeFileSync", (...args: unknown[]) => {
      if (args[0] === plan.ledgerPath) throw new Error("late ledger failure");
      if (args[0] === plan.sheetPath && args[1] === "# original sheet\n") throw new Error("sheet restoration denied");
      return Reflect.apply(original, fs, args);
    });
    syncBuiltinESMExports();
    try {
      assert.throws(() => writeSheet(plan, runDir, { home }), /snapshot restore failed for .*sheet restoration denied/);
      assert.equal(readFileSync(plan.sheetPath, "utf8"), plan.sheet);
      assert.equal(readFileSync(plan.integrationPath, "utf8"), "# original integration\n");
      assert.equal(existsSync(plan.ledgerPath), false);
    } finally {
      write.mock.restore();
      syncBuiltinESMExports();
    }
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
    assert.equal(sheetPathFor("claude", home, { CLAUDE_CONFIG_DIR: cfg }), join(cfg, "plugins", "data", "pstack-pstack-vic", "pstack-models.md"));
    assert.equal(integrationPathFor("codex", home, { CODEX_HOME: codex }), join(codex, "AGENTS.md"));
    assert.equal(ledgerPathFor("claude", home, { CLAUDE_CONFIG_DIR: cfg }), join(cfg, "plugins", "data", "pstack-pstack-vic", "pstack-probes.json"));
  });

  it("puts the sheet and ledger in the host's plugin data folder, Grok's in a grok folder inside Claude Code's", () => {
    const cfg = join(home, "claude # config");
    const codex = join(home, "codex home");
    const data = (configHome: string): string => join(configHome, "plugins", "data", "pstack-pstack-vic");
    assert.equal(dataHomeFor("claude", home), data(join(home, ".claude")));
    assert.equal(dataHomeFor("claude", home, { CLAUDE_CONFIG_DIR: cfg, CODEX_HOME: codex }), data(cfg));
    assert.equal(dataHomeFor("codex", home), data(join(home, ".codex")));
    assert.equal(dataHomeFor("codex", home, { CODEX_HOME: codex, CLAUDE_CONFIG_DIR: cfg }), data(codex));
    assert.equal(dataHomeFor("codex", home, { CODEX_HOME: "" }), data(join(home, ".codex")));
    assert.equal(dataHomeFor("grok", home), join(data(join(home, ".claude")), "grok"));
    assert.equal(dataHomeFor("grok", home, { CLAUDE_CONFIG_DIR: cfg, CODEX_HOME: codex }), join(data(cfg), "grok"));
    for (const parent of ["claude", "codex", "grok"]) {
      assert.equal(sheetPathFor(parent, home), join(dataHomeFor(parent, home), "pstack-models.md"));
      assert.equal(ledgerPathFor(parent, home), join(dataHomeFor(parent, home), "pstack-probes.json"));
    }
    assert.equal(integrationPathFor("grok", home, { CLAUDE_CONFIG_DIR: cfg }), join(home, ".grok", "AGENTS.md"), "the Grok instruction file stays in its own config home");
    const empty = /^CLAUDE_CONFIG_DIR is empty; /;
    assert.throws(() => dataHomeFor("grok", home, { CLAUDE_CONFIG_DIR: "" }), { message: empty });
    assert.throws(() => loadState({ parent: "grok", home, matrix, env: { CLAUDE_CONFIG_DIR: "" } }), { message: empty });
    assert.throws(() => dataHomeFor("cursor", home), SetupError);
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
      assert.equal(loadState({ parent: "claude", home, matrix }).sheetPath, join(home, ".claude", "plugins", "data", "pstack-pstack-vic", "pstack-models.md"));
      assert.equal(buildPlan({ parent: "codex", home, matrix }).sheetPath, join(home, ".codex", "plugins", "data", "pstack-pstack-vic", "pstack-models.md"));
      assert.equal(loadState({ parent: "grok", home, matrix }).sheetPath, join(home, ".claude", "plugins", "data", "pstack-pstack-vic", "grok", "pstack-models.md"));
    } finally {
      for (const [key, value] of [["CLAUDE_CONFIG_DIR", previous.claude], ["CODEX_HOME", previous.codex]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe("writeSheet in a redirected config home", () => {
  it("writes the Claude sheet and the ledger under CLAUDE_CONFIG_DIR, no CLAUDE.md, and nothing under <home>/.claude", async () => {
    const cfg = join(home, "claude # config");
    const env = { CLAUDE_CONFIG_DIR: cfg };
    const plan = await planAndProbe("claude", { env });
    const data = dataHomeFor("claude", home, env);
    assert.ok(data.startsWith(`${cfg}/`), data);
    assert.equal(plan.sheetPath, join(data, "pstack-models.md"));
    const result = writeSheet(plan, runDir, { home, env });
    assert.deepEqual([result.sheet, result.integration, result.ledger], ["created", "unchanged", "created"]);
    assert.equal(readFileSync(join(data, "pstack-models.md"), "utf8"), plan.sheet);
    assert.equal(existsSync(join(cfg, "CLAUDE.md")), false);
    assert.ok(existsSync(join(data, "pstack-probes.json")));
    assert.equal(existsSync(join(home, ".claude")), false);

    const bytes = ["pstack-models.md", "pstack-probes.json"].map((file) => readFileSync(join(data, file), "utf8"));
    const again = await planAndProbe("claude", { env });
    assert.deepEqual(again.pairs, []);
    const rerun = writeSheet(again, runDir, { home, env });
    assert.deepEqual([rerun.sheet, rerun.integration, rerun.ledger], ["unchanged", "unchanged", "unchanged"]);
    assert.deepEqual(["pstack-models.md", "pstack-probes.json"].map((file) => readFileSync(join(data, file), "utf8")), bytes);
  });

  it("writes the Codex sheet and the ledger under CODEX_HOME and no AGENTS.md", async () => {
    const codex = join(home, "codex home");
    const env = { CODEX_HOME: codex };
    const plan = await planAndProbe("codex", { env });
    writeSheet(plan, runDir, { home, env });
    const data = dataHomeFor("codex", home, env);
    assert.ok(data.startsWith(`${codex}/`), data);
    assert.equal(readFileSync(join(data, "pstack-models.md"), "utf8"), plan.sheet);
    assert.equal(existsSync(join(codex, "AGENTS.md")), false);
    assert.ok(existsSync(join(data, "pstack-probes.json")));
    assert.equal(existsSync(join(home, ".codex")), false);
  });

  it("writes the Grok sheet and the ledger in a grok folder inside Claude Code's plugin data under CLAUDE_CONFIG_DIR", async () => {
    const cfg = join(home, "cfg");
    const env = { CLAUDE_CONFIG_DIR: cfg };
    const data = join(cfg, "plugins", "data", "pstack-pstack-vic", "grok");
    const plan = await planAndProbe("grok", { env });
    assert.deepEqual(
      [plan.sheetPath, plan.ledgerPath, plan.integrationPath],
      [join(data, "pstack-models.md"), join(data, "pstack-probes.json"), join(home, ".grok", "AGENTS.md")]
    );
    const result = writeSheet(plan, runDir, { home, env });
    assert.deepEqual([result.sheet, result.integration, result.ledger, result.removedLegacy], ["created", "unchanged", "created", []]);
    assert.equal(readFileSync(join(data, "pstack-models.md"), "utf8"), plan.sheet);
    assert.ok(existsSync(join(data, "pstack-probes.json")));
    assert.equal(existsSync(sheetPathFor("claude", home, env)), false, "the Claude parent's sheet is a separate file");
    assert.equal(existsSync(join(home, ".grok")), false);
    assert.equal(existsSync(join(home, ".claude")), false);
    assert.deepEqual(loadState({ parent: "grok", home, env, matrix }).source, { kind: "sheet", path: join(data, "pstack-models.md") });
  });

  it("refuses to write with an empty CLAUDE_CONFIG_DIR and leaves the default home alone", async () => {
    const plan = await planAndProbe("claude");
    assert.throws(() => writeSheet(plan, runDir, { home, env: { CLAUDE_CONFIG_DIR: "" } }), { message: /^CLAUDE_CONFIG_DIR is empty; / });
    assert.equal(existsSync(join(home, ".claude")), false);
  });

  it("removes the legacy include when CLAUDE_CONFIG_DIR names the default home", async () => {
    const env = { CLAUDE_CONFIG_DIR: join(home, ".claude") };
    put(join(home, ".claude", "CLAUDE.md"), `${CLAUDE_INCLUDE_LINE}\n`);
    const plan = await planAndProbe("claude", { env });
    assert.equal(writeSheet(plan, runDir, { home, env }).integration, "updated");
    assert.equal(readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8"), "");
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
      it(`carries and removes a plain import with a literal @ in its directory, ${label} and ${JSON.stringify(prefix)}`, async () => {
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
        const kept = prefix === "- models: " ? `${prefix}${lineEnd}` : "";
        assert.equal(readFileSync(integration, "utf8"), `# mine${lineEnd}${kept}${lineEnd}@./other.md${lineEnd}`);
        assert.equal(readFileSync(sheetPathFor("claude", home, env), "utf8"), sheetWithHighHillclimb());
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
      assert.deepEqual(state.rows, []);

      const plan = await planAndProbe("claude", { env });
      assert.equal(writeSheet(plan, runDir, { home, env }).integration, "unchanged");
      assert.equal(readFileSync(integration, "utf8"), before);
      assert.equal(readFileSync(sheetPathFor("claude", home, env), "utf8"), firstRunSheet("claude"));
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
      assert.equal(existsSync(sheetPathFor("claude", home, env)), false);
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
      assert.equal(existsSync(sheetPathFor("claude", home, env)), false);
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
      assert.equal(readFileSync(integration, "utf8"), `<!--@noise-->${lineEnd}`);
      assert.equal(readFileSync(sheetPathFor("claude", home, env), "utf8"), sheetWithHighHillclimb());
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
        assert.equal(existsSync(sheetPathFor("claude", home, env)), false);
      }
    });

    it(`still refuses a list target whose markup changes the basename with ${label}`, () => {
      const cfg = join(home, "cfg");
      const env = { CLAUDE_CONFIG_DIR: cfg };
      for (const text of [
        "- *<pre>   @/abs/pstack-models.md</div><?---",
        "- @./pstack-models.md*",
        "- @./pstack-models.md_",
        "- @./pstack-models.md`",
      ]) {
        const before = `${text}${lineEnd}`;
        const integration = put(join(cfg, "CLAUDE.md"), before);
        assert.throws(() => loadState({ parent: "claude", home, env, matrix }), /markup touches it/);
        assert.throws(() => buildPlan({ parent: "claude", home, env, matrix }), /markup touches it/);
        assert.equal(readFileSync(integration, "utf8"), before);
        assert.equal(existsSync(sheetPathFor("claude", home, env)), false);
      }
    });
  }

  it("carries a copied profile's imported sheet into the redirected home and removes the import", async () => {
    const cfg = join(home, "cfg");
    const env = { CLAUDE_CONFIG_DIR: cfg };
    const imported = put(join(home, ".claude", "pstack-models.md"), sheetWithHighHillclimb());
    put(join(cfg, "CLAUDE.md"), "# work profile\n@~/.claude/pstack-models.md\nKeep this.\n");
    const state = loadState({ parent: "claude", home, env, matrix });
    assert.deepEqual(state.source, { kind: "import", path: imported });
    assert.equal(state.exists, false);
    assert.equal(state.sheetPath, sheetPathFor("claude", home, env));
    assert.deepEqual(state.rows.find((r) => r.role === "hillclimb")?.lanes, ["claude:claude-opus-5-5@high"]);

    const plan = await planAndProbe("claude", { env });
    assert.equal(plan.firstRun, false);
    writeSheet(plan, runDir, { home, env });
    assert.match(readFileSync(sheetPathFor("claude", home, env), "utf8"), /^hillclimb: claude:claude-opus-5-5@high$/m);
    assert.equal(readFileSync(join(cfg, "CLAUDE.md"), "utf8"), "# work profile\nKeep this.\n");
    assert.equal(readFileSync(imported, "utf8"), sheetWithHighHillclimb(), "the imported sheet is only read");
    assert.deepEqual(loadState({ parent: "claude", home, env, matrix }).source, { kind: "sheet", path: sheetPathFor("claude", home, env) });
  });

  it("removes an import that names the sheet elsewhere and keeps the rest of its list item", async () => {
    const elsewhere = put(join(home, "dotfiles", "pstack-models.md"), sheetWithHighHillclimb());
    const integration = put(join(home, ".claude", "CLAUDE.md"), `# mine\n- models: @${elsewhere}\n`);
    assert.deepEqual(loadState({ parent: "claude", home, matrix }).source, { kind: "import", path: elsewhere });
    const plan = await planAndProbe("claude");
    writeSheet(plan, runDir, { home });
    assert.equal(readFileSync(integration, "utf8"), "# mine\n- models: \n");
    assert.match(readFileSync(sheetPathFor("claude", home), "utf8"), /^hillclimb: claude:claude-opus-5-5@high$/m);
  });

  it("resolves a relative import with an escaped space against the CLAUDE.md directory", () => {
    const spaced = put(join(home, ".claude", "My Sheets", "pstack-models.md"), sheetWithHighHillclimb());
    put(join(home, ".claude", "CLAUDE.md"), "@./My\\ Sheets/pstack-models.md\n");
    assert.deepEqual(loadState({ parent: "claude", home, matrix }).source, { kind: "import", path: spaced });
  });

  it("ignores a mention in a fenced block, a code span, an HTML comment or quotes, and leaves the file alone", async () => {
    const mentions = "```text\n@~/.claude/pstack-models.md\n```\nLoad it with `@~/.claude/pstack-models.md`.\n<!-- off for now:\n@~/.claude/pstack-models.md -->\nNot this: @\"~/x/pstack-models.md\"\n";
    const integration = put(join(home, ".claude", "CLAUDE.md"), mentions);
    assert.deepEqual(loadState({ parent: "claude", home, matrix }).source, { kind: "first-run" });
    const plan = await planAndProbe("claude");
    writeSheet(plan, runDir, { home });
    assert.equal(readFileSync(integration, "utf8"), mentions);
  });
});

describe("loadState sources", () => {
  it("reports a missing import target and uses the first-run map, or the sheet when one survives", () => {
    put(join(home, ".claude", "CLAUDE.md"), "@~/gone/pstack-models.md\n");
    const missing = loadState({ parent: "claude", home, matrix });
    assert.deepEqual([missing.source, missing.missingImport, missing.exists], [{ kind: "first-run" }, join(home, "gone", "pstack-models.md"), false]);
    assert.equal(missing.legacyWiring, join(home, ".claude", "CLAUDE.md"));
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
    const conflict = (sheet: string): string =>
      `inconsistent state: ${sheet} and ${imported} (imported by ${integration}) assign different lanes to hillclimb (sheet: claude:claude-opus-5-5@xhigh; import: claude:claude-opus-5-5@high); delete the sheet to carry the imported one over, or remove the import to keep the sheet`;
    // The sheet setup keeps in the data folder, then the one a version before 0.6.0 kept in the config home itself.
    const sheet = put(sheetPathFor("claude", home, env), firstRunSheet("claude"));
    assert.throws(() => loadState({ parent: "claude", home, env, matrix }), { message: conflict(sheet) });
    writeFileSync(sheet, `${sheetWithHighHillclimb()}\nA note the operator kept.\n`);
    assert.deepEqual(loadState({ parent: "claude", home, env, matrix }).source, { kind: "sheet", path: sheet });

    rmSync(sheet);
    const legacy = put(join(cfg, "pstack-models.md"), firstRunSheet("claude"));
    assert.throws(() => loadState({ parent: "claude", home, env, matrix }), { message: conflict(legacy) });
    writeFileSync(legacy, `${sheetWithHighHillclimb()}\nA note the operator kept.\n`);
    assert.deepEqual(loadState({ parent: "claude", home, env, matrix }).source, { kind: "legacy", path: legacy });
  });

  it("ignores a different sheet and ledger an earlier version left in the config home once the data folder holds its own, and write deletes them", () => {
    const sheet = putSheet("claude", firstRunSheet("claude"));
    const ledger = putLedger("claude", matrix.families.map((family) => family.family));
    const legacySheet = put(join(configHomeFor("claude", home), "pstack-models.md"), sheetWithHighHillclimb());
    const legacyLedger = putLedger("claude", [], join(configHomeFor("claude", home), "pstack-probes.json"));
    const state = loadState({ parent: "claude", home, matrix });
    assert.deepEqual([state.source, state.exists, state.legacyFiles], [{ kind: "sheet", path: sheet }, true, [legacySheet, legacyLedger]]);
    assert.deepEqual(state.rows.find((r) => r.role === "hillclimb")?.lanes, ["claude:claude-opus-5-5@xhigh"]);

    const plan = buildPlan({ parent: "claude", home, matrix });
    assert.equal(plan.sheet, firstRunSheet("claude"));
    assert.deepEqual(plan.pairs, [], "the data folder's ledger, not the empty legacy one, decides what needs a probe");
    const ledgerBytes = readFileSync(ledger, "utf8");
    const result = writeSheet(plan, runDir, { home });
    assert.deepEqual([result.sheet, result.integration, result.ledger, result.removedLegacy], ["unchanged", "unchanged", "unchanged", [legacySheet, legacyLedger]]);
    assert.deepEqual([legacySheet, legacyLedger].map((path) => existsSync(path)), [false, false]);
    assert.equal(readFileSync(sheet, "utf8"), firstRunSheet("claude"));
    assert.equal(readFileSync(ledger, "utf8"), ledgerBytes);
    assert.deepEqual(loadState({ parent: "claude", home, matrix }).legacyFiles, []);
  });

  it("recovers the Codex rows from the AGENTS.md block when the sheet is missing, writes the sheet back and removes the block", async () => {
    const customized = firstRunSheet("codex").replace("hillclimb: codex:gpt-6-sol@xhigh", "hillclimb: codex:gpt-6-sol@high");
    const integration = put(integrationPathFor("codex", home), `# agents\n${CODEX_BLOCK_BEGIN}\n${customized}${CODEX_BLOCK_END}\n`);
    const state = loadState({ parent: "codex", home, matrix });
    assert.deepEqual([state.source, state.exists], [{ kind: "block", path: integration }, false]);
    assert.deepEqual(state.rows.find((r) => r.role === "hillclimb")?.lanes, ["codex:gpt-6-sol@high"]);
    const plan = await planAndProbe("codex");
    assert.equal(plan.firstRun, false);
    assert.equal(plan.sheet, customized);
    const result = writeSheet(plan, runDir, { home });
    assert.deepEqual([result.sheet, result.integration], ["created", "updated"]);
    assert.equal(readFileSync(sheetPathFor("codex", home), "utf8"), customized);
    assert.equal(readFileSync(integration, "utf8"), "# agents\n");
  });

  it("stops when the Codex sheet and its block assign different lanes, naming both sides of each role", () => {
    const sheet = putSheet("codex", firstRunSheet("codex"));
    const changed = firstRunSheet("codex")
      .replace("hillclimb: codex:gpt-6-sol@xhigh", "hillclimb: codex:gpt-6-sol@high")
      .replace("why synthesizer: codex:gpt-6-astra@max\n", "");
    const integration = put(integrationPathFor("codex", home), `${CODEX_BLOCK_BEGIN}\n${changed}${CODEX_BLOCK_END}\n`);
    assert.throws(
      () => buildPlan({ parent: "codex", home, matrix }),
      { message: `inconsistent state: ${sheet} and the pstack:models block of ${integration} assign different lanes to hillclimb (sheet: codex:gpt-6-sol@xhigh; block: codex:gpt-6-sol@high), why synthesizer (sheet: codex:gpt-6-astra@max; block: no row); delete the sheet to recover the block, or remove the block to keep the sheet` }
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
    `inconsistent state: ${path} line ${line} mentions an import of pstack-models.md that this script cannot read the way Claude Code does (${reason}); remove the mention`;

  /** An import of a sheet elsewhere: write carries its rows over and removes the import. */
  async function unwired(before: string, after: string): Promise<void> {
    const sheet = elsewhere();
    const integration = claudeMd(before);
    assert.deepEqual(loadState({ parent: "claude", home, matrix }).source, { kind: "import", path: sheet });
    const plan = await planAndProbe("claude");
    assert.equal(plan.firstRun, false);
    assert.equal(writeSheet(plan, runDir, { home }).integration, "updated");
    assert.equal(readFileSync(integration, "utf8"), after);
    assert.match(readFileSync(sheetPathFor("claude", home), "utf8"), /^hillclimb: claude:claude-opus-5-5@high$/m);
  }

  /** A mention Claude Code does not load: write leaves the file byte for byte. */
  async function untouched(before: string): Promise<void> {
    elsewhere();
    const integration = claudeMd(before);
    assert.deepEqual(loadState({ parent: "claude", home, matrix }).source, { kind: "first-run" });
    const plan = await planAndProbe("claude");
    assert.equal(writeSheet(plan, runDir, { home }).integration, "unchanged");
    assert.equal(readFileSync(integration, "utf8"), before);
  }

  /** An import an earlier setup placed for the config-home sheet: write restores the bytes it found. */
  async function removed(placed: string, original: string): Promise<void> {
    const integration = claudeMd(placed);
    assert.equal(loadState({ parent: "claude", home, matrix }).missingImport, join(home, ".claude", "pstack-models.md"));
    const plan = await planAndProbe("claude");
    assert.equal(writeSheet(plan, runDir, { home }).integration, "updated");
    assert.equal(readFileSync(integration, "utf8"), original);
  }

  function stops(before: string, message: string): void {
    elsewhere();
    const integration = claudeMd(before);
    assert.throws(() => loadState({ parent: "claude", home, matrix }), { message });
    assert.throws(() => buildPlan({ parent: "claude", home, matrix }), { message });
    assert.equal(readFileSync(integration, "utf8"), before);
    assert.equal(existsSync(sheetPathFor("claude", home)), false);
  }

  it("loads an import right after an HTML comment on its line, and removes only the import", async () => {
    await unwired("<!-- models -->@~/dotfiles/pstack-models.md\n", "<!-- models -->\n");
  });

  it("loads an import after an indented fence line that only continues a paragraph", async () => {
    await unwired("Para\n    ```\n@~/dotfiles/pstack-models.md\n", "Para\n    ```\n");
  });

  it("counts only the plain import when a second one sits in an indented code block", async () => {
    await unwired("@~/dotfiles/pstack-models.md\n\n    @./pstack-models.md\n", "\n    @./pstack-models.md\n");
  });

  it("skips an import in an indented code block and leaves it", async () => {
    await untouched("Notes.\n\n    @~/dotfiles/pstack-models.md\n");
  });

  it("skips an import in front matter and leaves it", async () => {
    await untouched("---\nnote: @~/dotfiles/pstack-models.md\n---\nBody\n");
  });

  it("skips an import inside an unclosed HTML comment and leaves it", async () => {
    await untouched("<!-- @~/dotfiles/pstack-models.md\n");
  });

  it("removes only the line of a top import placed after the front matter or a byte order mark", async () => {
    await removed("---\ntitle: x\n---\n@~/.claude/pstack-models.md\n\n<!-- off\n", "---\ntitle: x\n---\n\n<!-- off\n");
    rmSync(join(home, ".claude"), { recursive: true });
    await removed("\ufeff@~/.claude/pstack-models.md\n\n\n<!-- off\n", "\ufeff\n\n<!-- off\n");
  });

  it("skips an import in an HTML block and leaves it", async () => {
    await untouched("<div>\n@~/dotfiles/pstack-models.md\n</div>\n");
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

  it("removes an import appended after a blank line and keeps the blank line", async () => {
    await removed("See [the docs](https://example.com).\n\n@~/.claude/pstack-models.md\n", "See [the docs](https://example.com).\n\n");
  });

  it("removes a line left with only its list or quote marker, and only the import from a line with other text", async () => {
    await removed("# Rules\n1. @~/.claude/pstack-models.md\n2. two\n", "# Rules\n2. two\n");
    rmSync(join(home, ".claude"), { recursive: true });
    await removed("> @~/.claude/pstack-models.md\n", "");
    rmSync(join(home, ".claude"), { recursive: true });
    await removed("Models: @~/.claude/pstack-models.md\n", "Models: \n");
    rmSync(join(home, ".claude"), { recursive: true });
    await removed("5 @~/.claude/pstack-models.md\n", "5 \n");
  });

  it("stops instead of turning the indented line after the import into a code block", () => {
    const before = "# H\n@~/.claude/pstack-models.md\n    @./other.md\n";
    const integration = claudeMd(before);
    const message = `inconsistent state: removing the import on line 2 of ${integration} would turn the indented line after it into a code block; remove the import by hand`;
    assert.throws(() => loadState({ parent: "claude", home, matrix }), { message });
    assert.throws(() => buildPlan({ parent: "claude", home, matrix }), { message });
    assert.throws(() => unwireSheet({ parent: "claude", home, matrix }), { message });
    assert.equal(readFileSync(integration, "utf8"), before);
    assert.equal(existsSync(sheetPathFor("claude", home)), false);
  });

  it("removes an import inside a paragraph even when an indented line follows, since that line still continues the paragraph", async () => {
    await removed("Para\n@~/.claude/pstack-models.md\n    continued paragraph\n", "Para\n    continued paragraph\n");
  });

  it("still reads a plain list item, and removes an import appended after a list as a lazy line", async () => {
    await unwired("# Rules\n- one\n- models @~/dotfiles/pstack-models.md\n", "# Rules\n- one\n- models \n");
    rmSync(join(home, ".claude"), { recursive: true });
    await removed("# Rules\n- one\n- two\n@~/.claude/pstack-models.md\n", "# Rules\n- one\n- two\n");
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

  it("leaves a CRLF file without an import byte for byte", async () => {
    const before = "Prefer small commits.\r\nAnswer in plain language.\r\nRun the tests before declaring done.\r\n";
    await written(before, { kind: "first-run" }, before);
  });

  it("reads an import on a CRLF line and removes that line", async () => {
    const sheet = join(home, "dotfiles", "pstack-models.md");
    await written("Rules.\r\n\r\n@~/dotfiles/pstack-models.md\r\nMore.\r\n", { kind: "import", path: sheet }, "Rules.\r\n\r\nMore.\r\n");
  });

  it("reads an import after lone carriage returns and removes that line", async () => {
    const sheet = join(home, "dotfiles", "pstack-models.md");
    await written("Rules.\rMore.\r\r@~/dotfiles/pstack-models.md\r", { kind: "import", path: sheet }, "Rules.\rMore.\r\r");
  });

  it("removes a CRLF file's first-line import of the config-home sheet and creates the sheet", async () => {
    const rest = "Prefer small commits.\r\nAnswer in plain language.\r\nRun the tests before declaring done.\r\n";
    const integration = claudeMd(`@~/.claude/pstack-models.md\r\n${rest}`);
    const state = loadState({ parent: "claude", home, matrix });
    assert.deepEqual([state.source, state.missingImport], [{ kind: "first-run" }, join(home, ".claude", "pstack-models.md")]);
    const plan = await planAndProbe("claude");
    const result = writeSheet(plan, runDir, { home });
    assert.deepEqual([result.sheet, result.integration], ["created", "updated"]);
    assert.equal(readFileSync(integration, "utf8"), rest);
  });

  it("skips imports in a CRLF fence and in CRLF front matter, and leaves both files alone", async () => {
    const fenced = "```\r\n@~/dotfiles/pstack-models.md\r\n```\r\n";
    await written(fenced, { kind: "first-run" }, fenced);
    rmSync(join(home, ".claude"), { recursive: true });
    const frontMatter = "---\r\nnote: @~/dotfiles/pstack-models.md\r\n---\r\nBody\r\n";
    await written(frontMatter, { kind: "first-run" }, frontMatter);
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
  it("plans, writes, reads and disables a native swarm fallback through the CLI", () => {
    putLedger("codex", matrix.families.map((f) => f.family));
    const planArgs = ["plan", "--parent", "codex", "--home", home, "--dir", runDir];
    const enabled = cli([...planArgs, "--swarm-fallback", "codex:gpt-6.1-sol@xhigh"], noCliEnv());
    assert.equal(enabled.code, 0, enabled.stderr);
    assert.equal(cli(["write", "--dir", runDir, "--home", home], noCliEnv()).code, 0);
    const state = cli(["state", "--parent", "codex", "--home", home], noCliEnv());
    assert.equal(state.code, 0, state.stderr);
    assert.deepEqual(JSON.parse(state.stdout).rows.at(-1), { role: "swarm fallback", lanes: ["codex:gpt-6.1-sol@xhigh"] });
    const disabled = cli([...planArgs, "--swarm-fallback", "off"], noCliEnv());
    assert.equal(disabled.code, 0, disabled.stderr);
    assert.equal(cli(["write", "--dir", runDir, "--home", home], noCliEnv()).code, 0);
    assert.doesNotMatch(readFileSync(sheetPathFor("codex", home), "utf8"), /swarm fallback/);
    assert.equal(existsSync(integrationPathFor("codex", home)), false);
    const bad = cli([...planArgs, "--swarm-fallback", "grok:grok-4.7@xhigh"], noCliEnv());
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /native provider of codex/);
    assert.equal(cli(["state", "--parent", "codex", "--home", home, "--swarm-fallback", "off"], noCliEnv()).code, 64);
  });

  it("state prints the parent's state as JSON", () => {
    const result = cli(["state", "--parent", "claude", "--home", home], noCliEnv());
    assert.equal(result.code, 0, result.stderr);
    const state = JSON.parse(result.stdout);
    assert.equal(state.exists, false);
    assert.equal(state.sheetPath, sheetPathFor("claude", home));
    assert.deepEqual(state.legacyFiles, []);
    assert.equal(state.efforts.grok.status, "unassigned");
  });

  it("follows CLAUDE_CONFIG_DIR from its own environment through state, plan and write", () => {
    const cfg = join(home, "cfg");
    const redirected = (env: NodeJS.ProcessEnv) => ({ ...env, CLAUDE_CONFIG_DIR: cfg });
    const state = JSON.parse(cli(["state", "--parent", "claude", "--home", home], redirected(noCliEnv())).stdout);
    assert.deepEqual([state.configHome, state.sheetPath, state.source], [cfg, sheetPathFor("claude", home, { CLAUDE_CONFIG_DIR: cfg }), { kind: "first-run" }]);

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
    assert.equal(readFileSync(sheetPathFor("claude", home, { CLAUDE_CONFIG_DIR: cfg }), "utf8"), plan.sheet);
    assert.equal(existsSync(join(cfg, "CLAUDE.md")), false);
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
    assert.deepEqual([result.sheet, result.integration, result.ledger], ["created", "unchanged", "created"]);
    assert.equal(readFileSync(plan.sheetPath, "utf8"), plan.sheet);

    const again = JSON.parse(cli(["write", "--dir", runDir, "--home", home], noCliEnv()).stdout);
    assert.deepEqual([again.sheet, again.integration, again.ledger], ["unchanged", "unchanged", "unchanged"]);
  });

  it("roles prints every role's lanes and unwire removes an earlier version's block", () => {
    putSheet("codex", firstRunSheet("codex"));
    const integration = put(integrationPathFor("codex", home), `# agents\n${CODEX_BLOCK_BEGIN}\n${firstRunSheet("codex")}${CODEX_BLOCK_END}\n`);
    const args = ["--parent", "codex", "--home", home, "--cwd", outside()];
    const before = cli(["roles", ...args], noCliEnv());
    assert.equal(before.code, 0, before.stderr);
    const roles = JSON.parse(before.stdout);
    assert.equal(roles.legacyWiring, integration);
    assert.equal(roles.roles.length, matrix.roles.length);
    assert.ok(roles.roles.every((r: { source: string }) => r.source === "sheet"));
    const unwired = cli(["unwire", ...args], noCliEnv());
    assert.equal(unwired.code, 0, unwired.stderr);
    assert.deepEqual([JSON.parse(unwired.stdout).sheet, JSON.parse(unwired.stdout).integration], ["unchanged", "updated"]);
    assert.equal(readFileSync(integration, "utf8"), "# agents\n");
    assert.equal(JSON.parse(cli(["roles", ...args], noCliEnv()).stdout).legacyWiring, null);
    assert.equal(cli(["roles", "--home", home], noCliEnv()).code, 64);
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
    assert.match(help.stdout, /^  roles  --parent <p>/m);
    assert.match(help.stdout, /^  unwire --parent <p>/m);
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

    const allWrote = cli(["pick", "--parent", "claude", "--home", home, "--role", "trail reviewer pool", "--executor", "codex", "--executor", "grok"], noCliEnv());
    assert.equal(allWrote.code, 0, allWrote.stderr);
    const reviewed = JSON.parse(allWrote.stdout);
    assert.equal(reviewed.chosen.descriptor, "codex:gpt-6.1-sol@xhigh");
    assert.deepEqual(reviewed.eligible.map((lane: { provider: string }) => lane.provider), ["codex", "grok"]);
    assert.equal(reviewed.skipped.length, 1);
    assert.deepEqual(
      JSON.parse(cli(["pick", "--parent", "claude", "--home", home, "--role", "trail reviewer pool", "--executor", "codex,grok"], noCliEnv()).stdout).executors,
      ["claude"]
    );

    assert.equal(cli(["pick", "--parent", "claude", "--home", home], noCliEnv()).code, 64);
    const unknown = cli(["pick", "--parent", "claude", "--home", home, "--role", "trail reviewer pool", "--executor", "cursor"], noCliEnv());
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /unknown provider "cursor"/);
    assert.equal(existsSync(join(home, ".claude")), false, "pick writes nothing");
    putSheet("claude", "trail reviewer pool: claude:claude-opus-5-5@xhigh\n");
    const none = cli(["pick", "--parent", "claude", "--home", home, "--role", "trail reviewer pool"], noCliEnv());
    assert.equal(none.code, 1);
    assert.equal(JSON.parse(none.stdout).chosen, null);
    assert.deepEqual(JSON.parse(none.stdout).eligible, []);
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
    assert.equal(existsSync(sheetPathFor("claude", home)), false);
  });
});
