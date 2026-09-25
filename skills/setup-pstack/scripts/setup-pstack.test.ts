import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { loadMatrix, renderRoleSheet, renderSheetDocument } from "../../../scripts/model-matrix.ts";
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

const CLI_ONLY_ROLES: Record<string, string[]> = {
  "pr owner": ["inherit-parent"],
  "pr verifier": ["inherit-parent"],
};

function cliOnlyRoleFlags(): string[] {
  return Object.entries(CLI_ONLY_ROLES).flatMap(([role, lanes]) => [
    "--role",
    `${role}=${lanes.join(", ")}`,
  ]);
}

let home = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pstack-setup-"));
});

afterEach(() => {
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

function oldSeventeenSheet(parent: string): string {
  const lines = renderRoleSheet(matrix, parent).split("\n").slice(0, 17);
  assert.equal(lines.length, 17);
  assert.ok(lines[16].startsWith("interrogate reviewers:"));
  return [
    "# pstack model configuration",
    "",
    "Provider-qualified per-role choices. Read the installed pstack provider-dispatch reference before dispatching a configured role. Every documented role remains present. `inherit-parent` and `auto` use the parent model natively and still count as one panel lane.",
    "",
    lines.join("\n"),
    "",
  ].join("\n");
}

function nineteenRowOpusSheet(parent: string): string {
  const volume = new Set(["feature, refactoring", "bug-fix", "perf-issue", "hillclimb"]);
  const lines = renderRoleSheet(matrix, parent)
    .split("\n")
    .filter((line) => !line.startsWith("pre-pr "))
    .map((line) => {
      const role = line.slice(0, line.indexOf(": "));
      return volume.has(role) ? `${role}: claude:claude-opus-5-5@xhigh` : line;
    });
  assert.equal(lines.length, 19);
  assert.deepEqual(lines.slice(-2), ["pr owner: cursor:grok-4.7@high", "pr verifier: cursor:grok-4.7@high"]);
  return renderSheetDocument(lines.join("\n"));
}

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
    const rows = parseSheet("pr reviewer: cursor:grok-4.7@high\npr fixer, simple: cursor:composer-2.5@high\npr owner: cursor:grok-4.7@high\n", matrix);
    assert.deepEqual(rows, [{ role: "pr owner", lanes: ["cursor:grok-4.7@high"] }]);
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
    assert.deepEqual(state.efforts["grok-4-7"], {
      status: "mixed",
      efforts: ["high", "xhigh"],
      rows: [
        { role: "pre-pr reviewer", lane: "grok:grok-4.7@xhigh" },
        { role: "pre-pr fixer", lane: "grok:grok-4.7@xhigh" },
        { role: "pre-pr certifier", lane: "grok:grok-4.7@high" },
      ],
    });
    const plan = buildPlan({ parent: "codex", home, matrix, roles: { "bug-fix": ["grok:grok-4.7@xhigh"] } });
    assert.deepEqual(lanesOf(plan, "bug-fix"), ["grok:grok-4.7@xhigh"]);
    assert.deepEqual(lanesOf(plan, "swarm workers"), ["grok:grok-4.6@xhigh"]);
    assert.deepEqual(lanesOf(plan, "how explorer"), ["grok:grok-4.6@xhigh"]);
    assert.deepEqual(plan.efforts.grok, ["xhigh"]);
    assert.deepEqual(plan.efforts["grok-4-7"], ["high", "xhigh"]);
    assert.deepEqual(
      plan.pairs.filter((p) => p.family.startsWith("grok")).map((p) => [p.pair, p.descriptor, p.route]),
      [
        ["grok@xhigh", "grok:grok-4.6@xhigh", "runner"],
        ["grok-4-7@high", "grok:grok-4.7@high", "runner"],
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
    assert.deepEqual(state.efforts.sol, { status: "outside-map", efforts: ["max"], rows: [] });
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
    assert.equal(plan.schemaVersion, 4);
    assert.equal(plan.ledgerPath, join(home, ".claude", "pstack-probes.json"));
    assert.deepEqual(plan.verified, []);
    assert.deepEqual(plan.efforts, {
      fable: ["max"],
      opus: ["xhigh"],
      astra: ["max"],
      grok: ["xhigh"],
      "grok-4-7": ["high", "xhigh"],
      "cursor-grok": ["high"],
    });
    assert.deepEqual(
      plan.pairs.map((p) => [p.family, p.pair, p.descriptor, p.route]),
      [
        ["fable", "fable@max", "claude:fable@max", "native"],
        ["opus", "opus@xhigh", "claude:claude-opus-5-5@xhigh", "native"],
        ["astra", "astra@max", "codex:gpt-6-astra@max", "runner"],
        ["grok", "grok@xhigh", "grok:grok-4.6@xhigh", "runner"],
        ["grok-4-7", "grok-4-7@high", "grok:grok-4.7@high", "runner"],
        ["cursor-grok", "cursor-grok@high", "cursor:grok-4.7@high", "runner"],
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
        ...CLI_ONLY_ROLES,
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
      ["fable@max", "opus@xhigh", "sol@high", "astra@max", "grok@xhigh", "grok-4-7@high"]
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
    putLedger("claude", ["fable", "opus", "astra", "grok", "grok-4-7", "cursor-grok"]);
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
        ["grok-4-7", "grok:grok-4.7", "2026-09-24T00:00:00.000Z"],
        ["cursor-grok", "cursor:grok-4.7", "2026-09-24T00:00:00.000Z"],
      ]
    );

    const newFamilies = buildPlan({
      parent: "claude",
      home,
      matrix,
      roles: { "bug-fix": ["cursor:kimi-k3@high"], "swarm workers": ["codex:gpt-6-sol@high"] },
    });
    assert.deepEqual(
      newFamilies.pairs.map((p) => [p.pair, p.descriptor, p.route]),
      [
        ["sol@high", "codex:gpt-6-sol@high", "runner"],
        ["kimi@high", "cursor:kimi-k3@high", "runner"],
      ]
    );
    assert.equal(newFamilies.verified.some((v) => v.family === "sol" || v.family === "kimi"), false);
  });

  it("probes a new model of a verified family and keeps one parent's ledger from verifying the other", () => {
    putLedger("claude", ["fable", "opus", "astra", "grok", "grok-4-7", "cursor-grok"]);
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
      ["fable@max", "opus@xhigh", "sol@xhigh", "astra@max", "grok@xhigh", "grok-4-7@high", "cursor-grok@high"]
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

  it("keeps an old 17-role sheet and materializes the pre-pr and Cloud PR defaults", () => {
    putSheet("claude", oldSeventeenSheet("claude"));
    const state = loadState({ parent: "claude", home, matrix });
    assert.equal(state.exists, true);
    assert.equal(state.rows.length, 17);
    assert.deepEqual(
      state.rows.map((r) => r.role),
      matrix.roles.slice(0, 17).map((r) => r.role)
    );
    const plan = buildPlan({ parent: "claude", home, matrix });
    assert.equal(plan.rows.length, 22);
    assert.deepEqual(lanesOf(plan, "bug-fix"), ["claude:claude-opus-5-5@xhigh"]);
    assert.deepEqual(lanesOf(plan, "interrogate reviewers"), [
      "claude:fable@max",
      "codex:gpt-6-astra@max",
      "grok:grok-4.6@xhigh",
      "claude:claude-opus-5-5@xhigh",
    ]);
    assert.deepEqual(lanesOf(plan, "pre-pr reviewer"), ["grok:grok-4.7@xhigh"]);
    assert.deepEqual(lanesOf(plan, "pre-pr fixer"), ["grok:grok-4.7@xhigh"]);
    assert.deepEqual(lanesOf(plan, "pre-pr certifier"), ["grok:grok-4.7@high"]);
    assert.deepEqual(lanesOf(plan, "pr owner"), ["cursor:grok-4.7@high"]);
    assert.deepEqual(lanesOf(plan, "pr verifier"), ["cursor:grok-4.7@high"]);
  });

  it("accepts only Grok 4.7 high or xhigh for the Converge roles, which start.ts reads as floors", () => {
    const raised = buildPlan({ parent: "claude", home, matrix, roles: { "pr owner": ["cursor:grok-4.7@xhigh"] } });
    assert.deepEqual(lanesOf(raised, "pr owner"), ["cursor:grok-4.7@xhigh"]);
    assert.throws(() => buildPlan({ parent: "claude", home, matrix, roles: { "pr verifier": ["cursor:composer-2.5@high"] } }), /"pr verifier" takes one lane/);
    assert.throws(() => buildPlan({ parent: "claude", home, matrix, roles: { "pr owner": ["cursor:grok-4.7@medium"] } }), /"pr owner" takes one lane/);
    assert.throws(() => buildPlan({ parent: "claude", home, matrix, efforts: { "cursor-grok": "low" } }), /"pr owner" takes one lane/);
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

describe("pre-pr rows", () => {
  it("refuses a non-grok lane on a pre-pr row", () => {
    assert.throws(() => buildPlan({ parent: "claude", home, matrix, roles: { "pre-pr reviewer": ["claude:claude-opus-5-5@xhigh"] } }), /"pre-pr reviewer" takes one lane, grok:grok-4\.7@high or grok:grok-4\.7@xhigh/);
  });

  it("refuses an alias, an effort below high, and a panel on the pre-pr rows", () => {
    const refusal = (message: string) => (error: unknown) => error instanceof SetupError && error.message === message;
    assert.throws(
      () => buildPlan({ parent: "claude", home, matrix, roles: { "pre-pr certifier": ["inherit-parent"] } }),
      refusal('role "pre-pr certifier" takes one lane, grok:grok-4.7@high or grok:grok-4.7@xhigh; got inherit-parent')
    );
    assert.throws(
      () => buildPlan({ parent: "claude", home, matrix, roles: { "pre-pr fixer": ["grok:grok-4.7@medium"] } }),
      refusal('role "pre-pr fixer" takes one lane, grok:grok-4.7@high or grok:grok-4.7@xhigh; got grok:grok-4.7@medium')
    );
    assert.throws(
      () => buildPlan({ parent: "claude", home, matrix, roles: { "pre-pr reviewer": ["grok:grok-4.7@xhigh", "grok:grok-4.7@high"] } }),
      refusal('role "pre-pr reviewer" takes one lane, grok:grok-4.7@high or grok:grok-4.7@xhigh; got grok:grok-4.7@xhigh, grok:grok-4.7@high')
    );
  });

  it("warns when an authoring row shares the reviewer family and is silent once they differ", () => {
    const grok = ["grok:grok-4.6@xhigh"];
    const grokAuthors = buildPlan({
      parent: "claude",
      home,
      matrix,
      roles: { "feature, refactoring": ["grok:grok-4.7@xhigh"], "bug-fix": grok, "perf-issue": grok, hillclimb: grok },
    });
    assert.deepEqual(grokAuthors.warnings, [
      "feature, refactoring and pre-pr reviewer are both grok; certification will refuse until one of them changes family",
      "bug-fix and pre-pr reviewer are both grok; certification will refuse until one of them changes family",
      "perf-issue and pre-pr reviewer are both grok; certification will refuse until one of them changes family",
      "hillclimb and pre-pr reviewer are both grok; certification will refuse until one of them changes family",
    ]);
    for (const parent of ["claude", "codex"]) {
      assert.deepEqual(buildPlan({ parent, home, matrix }).warnings, [], `${parent} first run`);
    }
  });

  it("warns for an authoring row with any lane in the reviewer's provider, never for an alias or a non-authoring row", () => {
    const opus = "claude:claude-opus-5-5@xhigh";
    const plan = buildPlan({
      parent: "codex",
      home,
      matrix,
      roles: {
        "feature, refactoring": [opus],
        "bug-fix": ["inherit-parent"],
        "perf-issue": [opus, "grok:grok-4.6@high"],
        hillclimb: ["auto"],
        "hardest tasks": ["grok:grok-4.7@xhigh"],
      },
    });
    assert.deepEqual(lanesOf(plan, "swarm workers"), ["grok:grok-4.6@xhigh"]);
    assert.deepEqual(plan.warnings, [
      "perf-issue and pre-pr reviewer are both grok; certification will refuse until one of them changes family",
      "hardest tasks and pre-pr reviewer are both grok; certification will refuse until one of them changes family",
    ]);
  });

  it("upgrades a 19-row sheet with Opus authors: the pre-pr rows take their defaults, a verified Grok 4.7 is not probed, and nothing warns", () => {
    putSheet("claude", nineteenRowOpusSheet("claude"));
    putLedger("claude", ["fable", "opus", "astra", "grok", "grok-4-7", "cursor-grok"]);
    const state = loadState({ parent: "claude", home, matrix });
    assert.equal(state.rows.length, 19);
    const plan = buildPlan({ parent: "claude", home, matrix });
    assert.deepEqual(plan.rows.map((r) => r.role), matrix.roles.map((r) => r.role));
    assert.deepEqual(lanesOf(plan, "feature, refactoring"), ["claude:claude-opus-5-5@xhigh"]);
    assert.deepEqual(lanesOf(plan, "pre-pr reviewer"), ["grok:grok-4.7@xhigh"]);
    assert.deepEqual(lanesOf(plan, "pre-pr fixer"), ["grok:grok-4.7@xhigh"]);
    assert.deepEqual(lanesOf(plan, "pre-pr certifier"), ["grok:grok-4.7@high"]);
    assert.match(plan.sheet, /\ninterrogate reviewers: .*\npre-pr reviewer: grok:grok-4\.7@xhigh\npre-pr fixer: grok:grok-4\.7@xhigh\npre-pr certifier: grok:grok-4\.7@high\npr owner: cursor:grok-4\.7@high\n/);
    assert.deepEqual(plan.efforts["grok-4-7"], ["high", "xhigh"]);
    assert.deepEqual(plan.pairs, []);
    assert.deepEqual(plan.verified.map((v) => v.family), ["fable", "opus", "astra", "grok", "grok-4-7", "cursor-grok"]);
    assert.deepEqual(plan.warnings, []);
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
  loadPlan,
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

function fakeEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, ...extra };
}

/** Plan, run the external probes with the fake CLIs, and attest every native pair. */
async function planAndProbe(parent: string, input: { efforts?: Record<string, string>; roles?: Record<string, string[]> } = {}) {
  const plan = buildPlan({
    parent,
    home,
    matrix,
    ...input,
    roles: { ...CLI_ONLY_ROLES, ...input.roles },
  });
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
    const plan = buildPlan({ parent: "claude", home, matrix, roles: CLI_ONLY_ROLES });
    savePlan(runDir, plan);
    const summary = await runProbes(plan, { dir: runDir, env: fakeEnv() });
    assert.equal(summary.externalOk, true);
    assert.deepEqual(
      summary.external.map((r) => [r.pair, r.family, r.status]),
      [
        ["astra@max", "astra", "passed"],
        ["grok@xhigh", "grok", "passed"],
        ["grok-4-7@high", "grok-4-7", "passed"],
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
        ...CLI_ONLY_ROLES,
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
    putLedger("claude", ["fable", "opus", "astra", "grok", "grok-4-7"]);
    const plan = buildPlan({ parent: "claude", home, matrix, roles: CLI_ONLY_ROLES, efforts: { grok: "high" } });
    savePlan(runDir, plan);
    const summary = await runProbes(plan, { dir: runDir, env: fakeEnv({ FAKE_GROK_UNAUTH: "1" }) });
    assert.deepEqual(summary, { external: [], native: [], externalOk: true, ok: true });
    assert.deepEqual(readdirSync(runDir), ["plan.json"]);
  });

  it("marks a lane failed when its CLI is unauthenticated and keeps the other results", async () => {
    const plan = buildPlan({ parent: "claude", home, matrix, roles: CLI_ONLY_ROLES });
    savePlan(runDir, plan);
    const summary = await runProbes(plan, { dir: runDir, env: fakeEnv({ FAKE_GROK_UNAUTH: "1" }) });
    assert.equal(summary.externalOk, false);
    const grok = summary.external.find((r) => r.family === "grok");
    assert.equal(grok?.status, "failed");
    assert.match(grok?.detail ?? "", /unauthenticated/);
    assert.equal(summary.external.find((r) => r.family === "astra")?.status, "passed");
  });

  it("fails a lane whose receipt is complete but whose output lacks the marker", async () => {
    const plan = buildPlan({ parent: "codex", home, matrix, roles: CLI_ONLY_ROLES });
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
      roles: { ...CLI_ONLY_ROLES, "hardest tasks": ["claude:fable@medium"] },
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
    const plan = buildPlan({ parent: "claude", home, matrix, roles: CLI_ONLY_ROLES });
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
    assert.deepEqual(Object.keys(ledger.families), ["claude:claude-opus-5-5", "claude:fable", "codex:gpt-6-astra", "grok:grok-4.6", "grok:grok-4.7"]);
    assert.deepEqual(
      { ...ledger.families["grok:grok-4.6"], verifiedAt: "" },
      { family: "grok", descriptor: "grok:grok-4.6@xhigh", verifiedAt: "", evidence: runDir }
    );
    assert.deepEqual(
      { ...ledger.families["grok:grok-4.7"], verifiedAt: "" },
      { family: "grok-4-7", descriptor: "grok:grok-4.7@high", verifiedAt: "", evidence: runDir }
    );
    const ledgerText = readFileSync(plan.ledgerPath, "utf8");

    const effortDir = join(home, "effort-run");
    const effort = buildPlan({ parent: "claude", home, matrix, roles: CLI_ONLY_ROLES, efforts: { grok: "high", opus: "max" } });
    assert.deepEqual(effort.pairs, []);
    savePlan(effortDir, effort);
    const written = writeSheet(effort, effortDir, { home });
    assert.deepEqual([written.sheet, written.ledger], ["updated", "unchanged"]);
    assert.equal(readFileSync(plan.ledgerPath, "utf8"), ledgerText);
    assert.match(readFileSync(plan.sheetPath, "utf8"), /^swarm workers: grok:grok-4\.6@high$/m);
    assert.match(readFileSync(plan.sheetPath, "utf8"), /^bug-fix: claude:claude-opus-5-5@max$/m);

    const solDir = join(home, "sol-run");
    const sol = buildPlan({ parent: "claude", home, matrix, roles: { ...CLI_ONLY_ROLES, "swarm workers": ["codex:gpt-6-sol@high"] } });
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

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { CURSOR_ENV } from "../../poteto-mode/scripts/runner/http-lane.ts";

const SCRIPT = join(import.meta.dirname, "setup-pstack.ts");

function cli(args: string[], env: NodeJS.ProcessEnv = process.env) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function cliAsync(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({ code: status ?? 1, stdout, stderr });
    });
  });
}

describe("command line", () => {
  it("state prints the parent's state as JSON", () => {
    const result = cli(["state", "--parent", "claude", "--home", home]);
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
    ]);
    assert.equal(result.code, 0, result.stderr);
    const { dir, ...printed } = JSON.parse(result.stdout);
    assert.equal(dir, runDir);
    const saved = JSON.parse(readFileSync(join(runDir, "plan.json"), "utf8"));
    assert.deepEqual(printed, saved);
    assert.equal(saved.parent, "codex");
    assert.equal(saved.schemaVersion, 4);
    assert.deepEqual(saved.efforts.grok, ["high"]);
    assert.deepEqual(saved.rows.find((r: { role: string }) => r.role === "swarm workers").lanes, ["auto"]);
    assert.deepEqual(saved.rows.find((r: { role: string }) => r.role === "why synthesizer").lanes, ["claude:claude-opus-5-5@xhigh"]);
    assert.match(saved.sheet, /^# pstack model configuration\n/);
  });

  it("plan chooses a fresh run directory when --dir is omitted", () => {
    const result = cli(["plan", "--parent", "claude", "--home", home]);
    assert.equal(result.code, 0, result.stderr);
    const printed = JSON.parse(result.stdout);
    assert.ok(typeof printed.dir === "string" && existsSync(join(printed.dir, "plan.json")), result.stdout);
    rmSync(printed.dir, { recursive: true, force: true });
  });

  it("probe runs the external lanes and exits 1 when one fails", () => {
    cli(["plan", "--parent", "claude", "--home", home, "--dir", runDir, ...cliOnlyRoleFlags()]);
    const ok = cli(["probe", "--dir", runDir], fakeEnv());
    assert.equal(ok.code, 0, ok.stderr);
    const summary = JSON.parse(ok.stdout);
    assert.equal(summary.externalOk, true);
    assert.equal(summary.native.length, 2);

    rmSync(runDir, { recursive: true, force: true });
    cli(["plan", "--parent", "claude", "--home", home, "--dir", runDir, ...cliOnlyRoleFlags()]);
    const failed = cli(["probe", "--dir", runDir], fakeEnv({ FAKE_GROK_UNAUTH: "1" }));
    assert.equal(failed.code, 1);
    assert.equal(JSON.parse(failed.stdout).externalOk, false);
  });

  it("attest records a native probe and write commits only when every probe passed", () => {
    cli(["plan", "--parent", "claude", "--home", home, "--dir", runDir, ...cliOnlyRoleFlags()]);
    assert.equal(cli(["probe", "--dir", runDir], fakeEnv()).code, 0);
    const plan = JSON.parse(readFileSync(join(runDir, "plan.json"), "utf8")) as Plan;

    const early = cli(["write", "--dir", runDir, "--home", home]);
    assert.equal(early.code, 1);
    assert.match(early.stderr, /fable/);
    assert.equal(existsSync(plan.sheetPath), false);

    for (const pair of plan.pairs.filter((p) => p.native)) {
      const bad = cli(["attest", "--dir", runDir, "--pair", pair.pair, "--observed", "no token here"]);
      assert.equal(bad.code, 1);
      const good = cli(["attest", "--dir", runDir, "--pair", pair.pair, "--observed", `reply ${pair.marker}`]);
      assert.equal(good.code, 0, good.stderr);
    }
    const written = cli(["write", "--dir", runDir, "--home", home]);
    assert.equal(written.code, 0, written.stderr);
    const result = JSON.parse(written.stdout);
    assert.deepEqual([result.sheet, result.integration, result.ledger], ["created", "created", "created"]);
    assert.equal(readFileSync(plan.sheetPath, "utf8"), plan.sheet);

    const again = JSON.parse(cli(["write", "--dir", runDir, "--home", home]).stdout);
    assert.deepEqual([again.sheet, again.integration, again.ledger], ["unchanged", "unchanged", "unchanged"]);
  });

  it("rejects a bad subcommand, a malformed --effort, and a missing --parent with exit 64 and usage", () => {
    for (const args of [["frobnicate"], ["plan", "--parent", "claude", "--effort", "grok"], ["plan", "--home", home], []]) {
      const result = cli(args);
      assert.equal(result.code, 64, JSON.stringify(args));
      assert.match(result.stderr, /Usage: setup-pstack/);
    }
    const help = cli(["--help"]);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /Usage: setup-pstack/);
    assert.match(help.stdout, /--pair <family>@<effort>/);
    assert.match(help.stdout, /--repo <owner\/name>/);
    assert.match(help.stdout, /--pr <number>/);
    assert.doesNotMatch(help.stdout, /--family <family>/);
  });

  it("attest --pair records a native probe and attest --family is unknown", () => {
    cli(["plan", "--parent", "claude", "--home", home, "--dir", runDir]);
    const plan = JSON.parse(readFileSync(join(runDir, "plan.json"), "utf8")) as Plan;
    const fable = plan.pairs.find((p) => p.pair === "fable@max")!;
    const unknown = cli(["attest", "--dir", runDir, "--family", "fable", "--observed", `reply ${fable.marker}`]);
    assert.equal(unknown.code, 64, unknown.stderr);
    assert.match(unknown.stderr, /Usage: setup-pstack/);
    const good = cli(["attest", "--dir", runDir, "--pair", "fable@max", "--observed", `reply ${fable.marker}`]);
    assert.equal(good.code, 0, good.stderr);
    const printed = JSON.parse(good.stdout);
    assert.equal(printed.pair, "fable@max");
    assert.equal(printed.evidencePath, join(runDir, "native-fable@max.json"));
  });

  it("probe refuses a plan.json from the previous schema", () => {
    assert.equal(cli(["plan", "--parent", "claude", "--home", home, "--dir", runDir]).code, 0);
    const path = join(runDir, "plan.json");
    const { warnings, ...older } = JSON.parse(readFileSync(path, "utf8")) as Plan;
    assert.deepEqual(warnings, []);
    writeFileSync(path, `${JSON.stringify({ ...older, schemaVersion: 3 }, null, 2)}\n`);
    const result = cli(["probe", "--dir", runDir]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /plan/);
    assert.match(result.stderr, /run plan again with this version of the script/);
    assert.equal(existsSync(join(home, ".claude", "pstack-models.md")), false);
  });

  it("plan and write print the plan's warnings on stderr, keep exit 0, and a crossed plan prints none", () => {
    putLedger("claude", ["fable", "opus", "astra", "grok", "grok-4-7", "cursor-grok"]);
    const grokWarnings = [
      "warning: feature, refactoring and pre-pr reviewer are both grok; certification will refuse until one of them changes family\n",
      "warning: bug-fix and pre-pr reviewer are both grok; certification will refuse until one of them changes family\n",
      "warning: perf-issue and pre-pr reviewer are both grok; certification will refuse until one of them changes family\n",
      "warning: hillclimb and pre-pr reviewer are both grok; certification will refuse until one of them changes family\n",
    ].join("");
    const grok = "grok:grok-4.6@xhigh";
    const planned = cli([
      "plan", "--parent", "claude", "--home", home, "--dir", runDir,
      "--role", `feature, refactoring=${grok}`, "--role", `bug-fix=${grok}`, "--role", `perf-issue=${grok}`, "--role", `hillclimb=${grok}`,
    ]);
    assert.equal(planned.code, 0, planned.stderr);
    assert.equal(planned.stderr, grokWarnings);
    assert.deepEqual(JSON.parse(planned.stdout).warnings, [
      "feature, refactoring and pre-pr reviewer are both grok; certification will refuse until one of them changes family",
      "bug-fix and pre-pr reviewer are both grok; certification will refuse until one of them changes family",
      "perf-issue and pre-pr reviewer are both grok; certification will refuse until one of them changes family",
      "hillclimb and pre-pr reviewer are both grok; certification will refuse until one of them changes family",
    ]);
    const written = cli(["write", "--dir", runDir, "--home", home]);
    assert.equal(written.code, 0, written.stderr);
    assert.equal(written.stderr, grokWarnings);
    assert.equal(JSON.parse(written.stdout).sheet, "created");

    const crossedDir = join(home, "crossed-run");
    const opus = "claude:claude-opus-5-5@xhigh";
    const crossed = cli([
      "plan", "--parent", "claude", "--home", home, "--dir", crossedDir,
      "--role", `feature, refactoring=${opus}`, "--role", `bug-fix=${opus}`, "--role", `perf-issue=${opus}`, "--role", `hillclimb=${opus}`,
    ]);
    assert.equal(crossed.code, 0, crossed.stderr);
    assert.equal(crossed.stderr, "");
    assert.deepEqual(JSON.parse(crossed.stdout).warnings, []);
    const crossedWrite = cli(["write", "--dir", crossedDir, "--home", home]);
    assert.equal(crossedWrite.code, 0, crossedWrite.stderr);
    assert.equal(crossedWrite.stderr, "");
    assert.equal(JSON.parse(crossedWrite.stdout).sheet, "updated");
    assert.match(readFileSync(sheetPathFor("claude", home), "utf8"), /^feature, refactoring: claude:claude-opus-5-5@xhigh$/m);
  });
});

const GIT_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
} as const;

interface FakeCursor {
  readonly baseUrl: string;
  readonly launch: unknown;
  close(): Promise<void>;
}

async function fakeCursor(modelsStatus?: number): Promise<FakeCursor> {
  let prompt = "";
  let launch: unknown = null;
  const server = createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      raw += chunk;
    });
    request.on("end", () => {
      const method = request.method ?? "";
      const path = request.url ?? "";
      const answer = (status: number, body: unknown): void => {
        response.writeHead(status, { "content-type": "application/json", connection: "close" });
        response.end(JSON.stringify(body));
      };
      if (method === "GET" && path === "/v1/models") {
        if (modelsStatus !== undefined) {
          answer(modelsStatus, { error: "refused" });
          return;
        }
        answer(200, {
          items: [
            {
              id: "grok-4.7",
              displayName: "grok-4.7",
              parameters: [
                { id: "reasoning_effort", displayName: "reasoning_effort", values: [{ value: "high" }] },
                { id: "fast", displayName: "fast", values: [{ value: "false" }] },
              ],
              variants: [
                { params: [{ id: "reasoning_effort", value: "high" }, { id: "fast", value: "false" }] },
              ],
            },
          ],
        });
        return;
      }
      if (method === "POST" && path === "/v1/agents") {
        const body: unknown = JSON.parse(raw);
        launch = body;
        if (typeof body === "object" && body !== null && "prompt" in body) {
          const field = body.prompt;
          if (typeof field === "object" && field !== null && "text" in field && typeof field.text === "string") {
            prompt = field.text;
          }
        }
        answer(200, {
          agent: { id: "bc_1", status: "CREATING", url: "https://cursor.com/agents/bc_1", latestRunId: "run_1" },
          run: { id: "run_1", status: "CREATING", createdAt: "2026-09-21T12:00:00.000Z" },
        });
        return;
      }
      if (method === "GET" && path === "/v1/agents/bc_1/runs/run_1") {
        const marker = (prompt.match(/PSTACK-SETUP-[A-Za-z0-9-]+/) ?? ["missing"])[0];
        answer(200, {
          id: "run_1",
          agentId: "bc_1",
          status: "FINISHED",
          createdAt: "2026-09-21T12:00:00.000Z",
          updatedAt: "2026-09-21T12:00:01.000Z",
          result: marker,
          git: { branches: [{ repoUrl: "https://github.com/acme/app" }] },
        });
        return;
      }
      answer(404, { error: `no route for ${method} ${path}` });
    });
  });
  server.unref();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fake did not bind a port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    get launch() {
      return launch;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function gitBare(root: string): string {
  mkdirSync(root, { recursive: true });
  const bare = join(root, "remote.git");
  const work = join(root, "work");
  const git = (cwd: string, args: readonly string[]): void => {
    execFileSync("git", args, { cwd, env: { ...process.env, ...GIT_ENV }, stdio: ["ignore", "pipe", "pipe"] });
  };
  git(root, ["init", "--quiet", "--bare", "--initial-branch=main", bare]);
  git(root, ["clone", "--quiet", bare, work]);
  git(work, ["commit", "--allow-empty", "--quiet", "-m", "main"]);
  git(work, ["push", "--quiet", "origin", "HEAD:refs/heads/main"]);
  git(work, ["push", "--quiet", "origin", "HEAD:refs/pull/7/head"]);
  return bare;
}

function mixedPlan(): Plan {
  return buildPlan({
    parent: "claude",
    home,
    matrix,
    roles: { ...CLI_ONLY_ROLES, "bug-fix": ["cursor:grok-4.7@high"] },
  });
}

function cursorEnv(fake: FakeCursor, gitRemote: string): Record<string, string> {
  return {
    [CURSOR_ENV.apiKey]: "test-key",
    [CURSOR_ENV.baseUrl]: fake.baseUrl,
    [CURSOR_ENV.pollIntervalMs]: "5",
    [CURSOR_ENV.gitRemote]: gitRemote,
  };
}

describe("probe target", () => {
  const fakes: FakeCursor[] = [];

  afterEach(async () => {
    await Promise.all(fakes.splice(0).map((fake) => fake.close()));
  });

  it("rejects partial and malformed --repo/--pr with exit 64 and only plan.json", () => {
    savePlan(runDir, mixedPlan());
    const cases: Array<{ readonly args: readonly string[]; readonly message: RegExp }> = [
      { args: ["--repo", "acme/app"], message: /--pr is required with --repo/ },
      { args: ["--pr", "7"], message: /--repo is required with --pr/ },
      { args: ["--repo", "acme/app", "--pr", "0"], message: /--pr must be a positive integer/ },
      { args: ["--repo", "acme/app", "--pr", "x"], message: /--pr must be a positive integer/ },
    ];
    for (const { args, message } of cases) {
      const result = cli(["probe", "--dir", runDir, ...args], fakeEnv());
      assert.equal(result.code, 64, args.join(" "));
      assert.match(result.stderr, message, args.join(" "));
      assert.match(result.stderr, /Usage: setup-pstack/);
      assert.deepEqual(readdirSync(runDir), ["plan.json"], args.join(" "));
    }
    for (const repo of ["acme", "acme/", "/app", "https://github.com/acme/app", "acme/app/extra"]) {
      const result = cli(["probe", "--dir", runDir, "--repo", repo, "--pr", "7"], fakeEnv());
      assert.equal(result.code, 64, repo);
      assert.match(result.stderr, /--repo must be owner\/name/, repo);
      assert.deepEqual(readdirSync(runDir), ["plan.json"], repo);
    }
  });

  it("rejects an http plan without a target before writing any probe file", async () => {
    const plan = mixedPlan();
    savePlan(runDir, plan);
    const missing = cli(["probe", "--dir", runDir], fakeEnv());
    assert.equal(missing.code, 64, missing.stderr);
    assert.match(missing.stderr, /--repo and --pr are required for cursor \(http transport\)/);
    assert.deepEqual(readdirSync(runDir), ["plan.json"]);

    const fresh = join(home, "never-probed");
    await assert.rejects(
      () => runProbes(plan, { dir: fresh, env: fakeEnv() }),
      (error: unknown) =>
        error instanceof SetupError && /--repo and --pr are required for cursor \(http transport\)/.test(error.message)
    );
    assert.equal(existsSync(fresh), false);
    await assert.rejects(
      () => runProbes(plan, { dir: runDir, env: fakeEnv(), target: { owner: "acme", name: "app", pullNumber: 0 } }),
      (error: unknown) => error instanceof SetupError && /--pr must be a positive integer/.test(error.message)
    );
    assert.deepEqual(readdirSync(runDir), ["plan.json"]);
  });

  it("requires --repo and --pr on a first-run plan because the PR-phase defaults include cursor pairs", () => {
    const plan = buildPlan({ parent: "claude", home, matrix });
    savePlan(runDir, plan);
    const missing = cli(["probe", "--dir", runDir], fakeEnv());
    assert.equal(missing.code, 64, missing.stderr);
    assert.match(missing.stderr, /--repo and --pr are required for cursor \(http transport\)/);
    assert.deepEqual(readdirSync(runDir), ["plan.json"]);
  });

  it("rejects a target on a cli-only plan with exit 64 and names the rule", async () => {
    const plan = buildPlan({ parent: "claude", home, matrix, roles: CLI_ONLY_ROLES });
    savePlan(runDir, plan);
    const result = cli(["probe", "--dir", runDir, "--repo", "acme/app", "--pr", "7"], fakeEnv());
    assert.equal(result.code, 64, result.stderr);
    assert.match(result.stderr, /--repo and --pr are only accepted for: cursor/);
    assert.deepEqual(readdirSync(runDir), ["plan.json"]);

    await assert.rejects(
      () => runProbes(plan, { dir: runDir, env: fakeEnv(), target: { owner: "acme", name: "app", pullNumber: 7 } }),
      (error: unknown) =>
        error instanceof SetupError && /--repo and --pr are only accepted for: cursor/.test(error.message)
    );
    assert.deepEqual(readdirSync(runDir), ["plan.json"]);
  });

  it("rejects --repo/--pr on every subcommand except probe", () => {
    for (const args of [
      ["state", "--parent", "claude", "--home", home, "--repo", "acme/app", "--pr", "7"],
      ["plan", "--parent", "claude", "--home", home, "--dir", runDir, "--repo", "acme/app", "--pr", "7"],
      ["attest", "--dir", runDir, "--pair", "fable@max", "--observed", "x", "--repo", "acme/app", "--pr", "7"],
      ["write", "--dir", runDir, "--home", home, "--repo", "acme/app", "--pr", "7"],
    ]) {
      const result = cli(args);
      assert.equal(result.code, 64, JSON.stringify(args));
      assert.match(result.stderr, /--repo and --pr are only accepted on probe/);
      assert.equal(existsSync(join(runDir, "plan.json")), false);
    }
  });

  it("routes --repo/--pr only to the http child of a mixed grok and cursor-grok plan", { timeout: 30_000 }, async () => {
    const plan = mixedPlan();
    savePlan(runDir, plan);
    const saved = loadPlan(runDir);
    assert.equal(saved.schemaVersion, 4);
    assert.equal("target" in saved, false);
    assert.ok(saved.pairs.every((pair) => !("transport" in pair)));

    const fake = await fakeCursor();
    fakes.push(fake);
    const bare = gitBare(join(home, "git"));
    const probed = await cliAsync(["probe", "--dir", runDir, "--repo", "acme/app", "--pr", "7"], fakeEnv(cursorEnv(fake, bare)));
    assert.equal(probed.code, 0, probed.stderr + probed.stdout);
    const summary: unknown = JSON.parse(probed.stdout);
    if (typeof summary !== "object" || summary === null || !("external" in summary) || !Array.isArray(summary.external)) {
      assert.fail("expected probe summary with external results");
    }
    assert.equal("externalOk" in summary ? summary.externalOk : undefined, true);
    assert.deepEqual(
      summary.external.map((result: unknown) =>
        typeof result === "object" && result !== null && "pair" in result && "status" in result
          ? [result.pair, result.status]
          : result
      ),
      [
        ["astra@max", "passed"],
        ["grok@xhigh", "passed"],
        ["grok-4-7@high", "passed"],
        ["cursor-grok@high", "passed"],
      ]
    );

    const grokReceipt = JSON.parse(readFileSync(join(runDir, "probe-grok@xhigh.receipt.json"), "utf8"));
    assert.equal(grokReceipt.status, "complete");
    assert.equal(grokReceipt.remote, null);
    const cursorReceipt = JSON.parse(readFileSync(join(runDir, "probe-cursor-grok@high.receipt.json"), "utf8"));
    assert.equal(cursorReceipt.status, "complete");
    assert.equal(cursorReceipt.mode, "read-only");
    assert.equal(cursorReceipt.modelEvidence, "pinned-argv");
    assert.equal(cursorReceipt.remote.agentUrl, "https://cursor.com/agents/bc_1");
    assert.equal(cursorReceipt.remote.agentId, "bc_1");
    const launch = fake.launch;
    if (typeof launch !== "object" || launch === null) assert.fail("expected a launch body");
    assert.deepEqual(
      {
        name: "name" in launch ? launch.name : undefined,
        repos: "repos" in launch ? launch.repos : undefined,
      },
      {
        name: "pstack acme/app#7 grok-4.7@high",
        repos: [{ url: "https://github.com/acme/app", prUrl: "https://github.com/acme/app/pull/7" }],
      }
    );
    const after = loadPlan(runDir);
    assert.equal(after.schemaVersion, 4);
    assert.equal("target" in after, false);
  });

  it("keeps the grok cli result when the cursor http lane is unauthenticated", { timeout: 30_000 }, async () => {
    const plan = mixedPlan();
    savePlan(runDir, plan);
    const fake = await fakeCursor(401);
    fakes.push(fake);
    const bare = gitBare(join(home, "git"));
    const probed = await cliAsync(["probe", "--dir", runDir, "--repo", "acme/app", "--pr", "7"], fakeEnv(cursorEnv(fake, bare)));
    assert.equal(probed.code, 1, probed.stderr + probed.stdout);
    const summary: unknown = JSON.parse(probed.stdout);
    if (typeof summary !== "object" || summary === null || !("external" in summary) || !Array.isArray(summary.external)) {
      assert.fail("expected probe summary with external results");
    }
    assert.equal("externalOk" in summary ? summary.externalOk : undefined, false);
    assert.deepEqual(
      summary.external.map((result: unknown) =>
        typeof result === "object" && result !== null && "family" in result && "status" in result
          ? [result.family, result.status]
          : result
      ),
      [
        ["astra", "passed"],
        ["grok", "passed"],
        ["grok-4-7", "passed"],
        ["cursor-grok", "failed"],
      ]
    );
    const cursor = summary.external.find(
      (result: unknown) =>
        typeof result === "object" && result !== null && "family" in result && result.family === "cursor-grok"
    );
    assert.match(
      typeof cursor === "object" && cursor !== null && "detail" in cursor && typeof cursor.detail === "string"
        ? cursor.detail
        : "",
      /unauthenticated/
    );
    const grokReceipt = JSON.parse(readFileSync(join(runDir, "probe-grok@xhigh.receipt.json"), "utf8"));
    assert.equal(grokReceipt.status, "complete");
    assert.equal(grokReceipt.remote, null);
    const cursorReceipt = JSON.parse(readFileSync(join(runDir, "probe-cursor-grok@high.receipt.json"), "utf8"));
    assert.equal(cursorReceipt.status, "unauthenticated");
    assert.equal(fake.launch, null);
  });
});
