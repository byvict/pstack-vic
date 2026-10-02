import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  MATRIX_PATH,
  PLUGIN_ROOT,
  agentName,
  crossFamilyRowProblem,
  cursorSlugPattern,
  declaredAgentNames,
  defaultDescriptor,
  familyFor,
  fromCursorSlug,
  loadMatrix,
  nativeParentOf,
  nativeProviderOf,
  parseDescriptor,
  pickCrossFamily,
  renderMatrixMarkdown,
  renderRoleDefaultsMarkdown,
  renderRoleSheet,
  reportedModelMatches,
  resolveDescriptor,
  roleDefault,
  roleNamed,
  routeFor,
  spliceMatrixBlock,
  validateMatrix,
  type Family,
  type ModelMatrix,
} from "./model-matrix.ts";
import { DISPATCH_PATH, SETUP_PATH, renderDispatch, renderSetup } from "./render-model-matrix.ts";

const matrix = loadMatrix();

// Files whose prose or frontmatter may cite a model. Anything here that names a
// descriptor outside model-matrix.json fails the consumer test. Test files are
// skipped: their fixtures hold deliberately invalid descriptors and legacy pins.
// docs/arquivo is skipped too: archived documents are history and keep the
// descriptors of families the matrix no longer has.
const CONSUMER_DIRS = ["skills", "agents", "docs"] as const;
const CONSUMER_ROOT_FILES = ["README.md"] as const;
const CONSUMER_EXTENSIONS = new Set([".md", ".json", ".mjs", ".ts", ".sh"]);
const SKIP_DIRS = new Set(["node_modules", ".git"]);
const ARCHIVE_DIR = join(PLUGIN_ROOT, "docs", "arquivo");

function walk(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (path === ARCHIVE_DIR) continue;
    if (statSync(path).isDirectory()) {
      walk(path, out);
      continue;
    }
    if (name.endsWith(".test.ts")) continue;
    const dot = name.lastIndexOf(".");
    if (dot >= 0 && CONSUMER_EXTENSIONS.has(name.slice(dot))) out.push(path);
  }
}

function consumerFiles(): string[] {
  const files: string[] = [];
  for (const dir of CONSUMER_DIRS) walk(join(PLUGIN_ROOT, dir), files);
  for (const name of CONSUMER_ROOT_FILES) {
    const path = join(PLUGIN_ROOT, name);
    if (existsSync(path)) files.push(path);
  }
  return files.sort();
}

function rel(path: string): string {
  return relative(PLUGIN_ROOT, path);
}

function rawMatrix(): Record<string, unknown> {
  return JSON.parse(readFileSync(MATRIX_PATH, "utf8"));
}

function withFamilies(
  edit: (families: Record<string, unknown>[]) => void
): unknown {
  const raw = rawMatrix();
  const families = raw.families as Record<string, unknown>[];
  edit(families);
  return raw;
}

function withRoles(edit: (roles: Record<string, unknown>[]) => void): unknown {
  const raw = rawMatrix();
  edit(raw.roles as Record<string, unknown>[]);
  return raw;
}

function parseFrontmatter(text: string): Record<string, string> {
  assert.ok(text.startsWith("---\n"), "agent file must start with frontmatter");
  const end = text.indexOf("\n---\n", 4);
  assert.ok(end > 0, "agent frontmatter must terminate");
  const fields: Record<string, string> = {};
  for (const line of text.slice(4, end).split("\n")) {
    const idx = line.indexOf(": ");
    assert.ok(idx > 0, `bad frontmatter line: ${line}`);
    fields[line.slice(0, idx)] = line.slice(idx + 2);
  }
  return fields;
}

describe("model-matrix.json", () => {
  it("loads and every family is internally consistent", () => {
    assert.equal(matrix.schemaVersion, 1);
    assert.ok(matrix.families.length >= 1);
    for (const f of matrix.families) {
      assert.ok(matrix.providers[f.provider], `${f.family}: provider exists`);
      assert.ok(f.efforts.includes(f.defaultEffort), `${f.family}: default is selectable`);
      for (const e of f.efforts) assert.ok(matrix.efforts.includes(e));
      const native = nativeParentOf(matrix, f);
      assert.equal(
        f.agentStem !== null,
        native === "claude",
        `${f.family}: agent stem iff native in Claude Code`
      );
    }
  });

  it("routes every provider natively in exactly one parent and externally elsewhere", () => {
    for (const parent of Object.keys(matrix.parents)) {
      const natives = Object.keys(matrix.providers).filter(
        (p) => routeFor(matrix, parent, p) === "native"
      );
      assert.equal(natives.length, 1, `${parent}: one native provider`);
      assert.equal(matrix.providers[natives[0]].nativeIn, parent);
    }
    for (const [provider, spec] of Object.entries(matrix.providers)) {
      for (const parent of Object.keys(matrix.parents)) {
        const expected = spec.nativeIn === parent ? "native" : "runner";
        assert.equal(routeFor(matrix, parent, provider), expected);
      }
    }
  });

  it("carries the five decided families with the decided providers", () => {
    // Decisions of 2026-09-17 (Linear project description). A sixth family is
    // welcome; these five must not silently disappear or move provider.
    const byName = new Map(matrix.families.map((f) => [f.family, f]));
    const decided: Array<[string, string, string]> = [
      ["fable", "claude", "fable"],
      ["opus", "claude", "claude-opus-5-5"],
      ["sol", "codex", "gpt-6-sol"],
      ["astra", "codex", "gpt-6-astra"],
      ["grok", "grok", "grok-4.6"],
    ];
    for (const [family, provider, model] of decided) {
      const row = byName.get(family);
      assert.ok(row, `${family} present`);
      assert.equal(row.provider, provider, `${family} provider`);
      assert.equal(row.model, model, `${family} model`);
    }
  });

  it("carries gpt-6.1-sol as its own codex family beside sol", () => {
    // Codex CLI 0.159.0 lists gpt-6.1-sol (2026-09-29); gpt-6-sol stays in sol.
    const row = matrix.families.find((f) => f.family === "sol-6-1");
    assert.ok(row, "sol-6-1 present");
    assert.equal(row.provider, "codex");
    assert.equal(row.model, "gpt-6.1-sol");
    assert.deepEqual(row.efforts, ["low", "medium", "high", "xhigh", "max"]);
    assert.equal(row.defaultEffort, "max");
    assert.equal(row.reportedModel, null, "codex pins by argv");
    assert.equal(routeFor(matrix, "codex", row.provider), "native");
    assert.equal(routeFor(matrix, "claude", row.provider), "runner");
  });

  it("rejects a family whose provider is unknown", () => {
    assert.throws(
      () =>
        validateMatrix(
          withFamilies((fs) => {
            fs[0] = { ...fs[0], provider: "gemini" };
          })
        ),
      /provider must be one of/
    );
  });

  it("rejects a default effort that is not selectable", () => {
    assert.throws(
      () =>
        validateMatrix(
          withFamilies((fs) => {
            fs[0] = { ...fs[0], efforts: ["low"], defaultEffort: "max" };
          })
        ),
      /defaultEffort must be one of/
    );
  });

  it("rejects an effort outside the universe", () => {
    assert.throws(
      () =>
        validateMatrix(
          withFamilies((fs) => {
            fs[0] = { ...fs[0], efforts: [...(fs[0].efforts as string[]), "ultra"] };
          })
        ),
      /outside the universe/
    );
  });

  it("rejects a route cell that contradicts the provider's native parent", () => {
    const raw = rawMatrix();
    (raw.routes as Record<string, Record<string, string>>).claude.grok = "native";
    assert.throws(() => validateMatrix(raw), /routes\.claude\.grok is native/);
  });

  it("rejects a provider without a CLI binary", () => {
    for (const cli of [null, ""]) {
      const raw = rawMatrix();
      (raw.providers as Record<string, Record<string, unknown>>).grok.cli = cli;
      assert.throws(() => validateMatrix(raw), /providers\.grok\.cli must be a non-empty string/);
    }
  });

  it("rejects a duplicate family name or provider:model pair", () => {
    assert.throws(
      () => validateMatrix(withFamilies((fs) => fs.push({ ...fs[0] }))),
      /duplicate|share provider:model/
    );
    assert.throws(
      () =>
        validateMatrix(
          withFamilies((fs) => fs.push({ ...fs[0], family: "fable-two" }))
        ),
      /share provider:model/
    );
  });

  it("rejects a Claude family without an agent stem and a non-Claude family with one", () => {
    assert.throws(
      () =>
        validateMatrix(
          withFamilies((fs) => {
            const claude = fs.find((f) => f.provider === "claude") as Record<string, unknown>;
            claude.agentStem = null;
          })
        ),
      /agentStem must be present iff/
    );
    assert.throws(
      () =>
        validateMatrix(
          withFamilies((fs) => {
            const grok = fs.find((f) => f.provider === "grok") as Record<string, unknown>;
            grok.agentStem = "grok";
          })
        ),
      /agentStem must be present iff/
    );
  });

  it("accepts a new family added as one line, and every derived view picks it up", () => {
    // A model name no real family can claim, so the experiment never collides
    // with a family someone adds to model-matrix.json later.
    const model = "test-model-" + matrix.families.length;
    const added: Record<string, unknown> = {
      family: "test-family",
      provider: "grok",
      model,
      efforts: ["low", "high"],
      defaultEffort: "high",
      agentStem: null,
      cursorSlug: null,
      reportedModel: `^${model}$`,
    };
    const extended: ModelMatrix = validateMatrix(
      withFamilies((fs) => fs.push(added))
    );
    assert.equal(extended.families.length, matrix.families.length + 1);
    const row = familyFor(extended, { provider: "grok", model });
    assert.ok(row);
    assert.equal(defaultDescriptor(row), `grok:${model}@high`);
    assert.deepEqual(resolveDescriptor(extended, `grok:${model}@low`).family, row);
    assert.throws(() => resolveDescriptor(extended, `grok:${model}@max`), /does not select effort max/);
    assert.ok(renderMatrixMarkdown(extended).includes(`| test-family | grok | \`${model}\` | high | low high | - | - | - |`));
    assert.deepEqual(declaredAgentNames(extended), declaredAgentNames(matrix));
    // The route table does not change when a family is added: routes are per provider.
    assert.deepEqual(extended.routes, matrix.routes);
  });
});

describe("descriptors", () => {
  it("parse and resolve against the matrix", () => {
    for (const f of matrix.families) {
      const text = defaultDescriptor(f);
      assert.deepEqual(parseDescriptor(text), {
        provider: f.provider,
        model: f.model,
        effort: f.defaultEffort,
      });
      assert.equal(resolveDescriptor(matrix, text).family, f);
    }
    assert.equal(parseDescriptor("inherit-parent"), null);
    assert.equal(parseDescriptor("grok-4.6-fast-xhigh"), null);
    assert.throws(() => resolveDescriptor(matrix, "claude:sonnet@max"), /no matrix family/);
    assert.throws(() => resolveDescriptor(matrix, "cursor:composer@high"), /no matrix family/);
    assert.throws(() => resolveDescriptor(matrix, "codex:gpt-6-astra@ultra"), /does not select effort ultra/);
  });

  it("map Cursor 0.15.2 selectors back to a family and effort", () => {
    const cases: Array<[string, string, string]> = [
      ["claude-fable-5-1-thinking-max", "fable", "max"],
      ["claude-fable-5-1-thinking-medium", "fable", "medium"],
      ["claude-opus-5-thinking-xhigh", "opus", "xhigh"],
      ["gpt-5.6-sol-max", "sol", "max"],
      ["grok-4.6-fast-xhigh", "grok", "xhigh"],
    ];
    for (const [slug, family, effort] of cases) {
      const hit = fromCursorSlug(matrix, slug);
      assert.ok(hit, slug);
      assert.equal(hit.family.family, family);
      assert.equal(hit.effort, effort);
    }
    assert.equal(fromCursorSlug(matrix, "grok-4.6-fast-ultra"), null);
    assert.equal(fromCursorSlug(matrix, "gpt-5.5-max"), null);
  });

  it("verify provider-reported models per family", () => {
    const fable = matrix.families.find((f) => f.family === "fable") as Family;
    const sol = matrix.families.find((f) => f.family === "sol") as Family;
    const grok = matrix.families.find((f) => f.family === "grok") as Family;
    assert.equal(reportedModelMatches(fable, "claude-fable-5-1"), true);
    assert.equal(reportedModelMatches(fable, "claude-opus-5"), false);
    assert.equal(reportedModelMatches(fable, "fable"), false);
    assert.equal(reportedModelMatches(sol, "gpt-6-sol"), false, "codex pins by argv");
    assert.equal(reportedModelMatches(grok, "grok-4.6"), true);
    assert.equal(reportedModelMatches(grok, "grok-4.5"), false);
    assert.equal(reportedModelMatches(grok, "grok-4.6-build"), true, "grok 1.0.5 reports a build suffix");
    assert.equal(reportedModelMatches(grok, "grok-4.6.1"), false);
  });
});

describe("roles", () => {
  it("give every role a one-line description and render it in the role table", () => {
    const table = renderRoleDefaultsMarkdown(matrix);
    assert.ok(table.includes("| Role | What the lane does |"));
    for (const role of matrix.roles) {
      assert.equal(typeof role.description, "string", role.role);
      assert.ok(role.description.trim().length > 0 && !role.description.includes("\n"), role.role);
      assert.ok(table.includes(`| \`${role.role}\` | ${role.description} |`), role.role);
    }
    assert.equal(
      roleNamed(matrix, "bug-fix")?.description,
      "Reproduces a reported defect, finds the root cause, and writes the fix with runtime evidence."
    );
  });

  it("reject a role without a one-line description", () => {
    for (const bad of [undefined, "", "   ", "two\nlines"]) {
      assert.throws(
        () =>
          validateMatrix(
            withRoles((roles) => {
              roles[0] = { ...roles[0], description: bad };
            })
          ),
        /description must be one non-empty line/,
        JSON.stringify(bad)
      );
    }
  });

  const parents = Object.keys(matrix.parents);

  it("resolve every role default to descriptors or aliases for every parent", () => {
    assert.ok(matrix.roles.length >= 1);
    for (const role of matrix.roles) {
      for (const parent of parents) {
        const lanes = roleDefault(matrix, role.role, parent);
        assert.ok(lanes.length >= 1, `${role.role}/${parent}: at least one lane`);
        for (const lane of lanes) {
          if (matrix.aliases.includes(lane)) continue;
          resolveDescriptor(matrix, lane);
        }
      }
    }
  });

  it("carry the decided default map: authoring on the parent's native code family, swarm and exploration on grok, frontier solo on the parent's native frontier, panels mixed, why and reflect inherit", () => {
    // Decisions of 2026-09-17 (plan, fase 6 bullets); CLI-196 moved the four authoring volume rows off grok on 2026-09-25.
    // The labels are the sheet lines /setup-pstack writes.
    for (const label of ["feature, refactoring", "bug-fix", "perf-issue", "hillclimb"]) {
      assert.deepEqual(roleDefault(matrix, label, "claude"), ["claude:claude-opus-5-5@xhigh"], `${label}/claude`);
      assert.deepEqual(roleDefault(matrix, label, "codex"), ["codex:gpt-6-sol@xhigh"], `${label}/codex`);
    }
    for (const label of ["swarm workers", "how explorer"]) {
      for (const parent of parents) {
        assert.deepEqual(roleDefault(matrix, label, parent), ["grok:grok-4.6@xhigh"], `${label}/${parent}`);
      }
    }
    for (const label of ["hardest tasks", "judgment and prose", "how explainer"]) {
      assert.deepEqual(roleDefault(matrix, label, "claude"), ["claude:fable@max"], `${label}/claude`);
      assert.deepEqual(roleDefault(matrix, label, "codex"), ["codex:gpt-6-astra@max"], `${label}/codex`);
    }
    for (const label of ["why investigators", "why synthesizer", "reflect tooling", "reflect judgment, divergent, synthesizer"]) {
      for (const parent of parents) assert.deepEqual(roleDefault(matrix, label, parent), ["inherit-parent"]);
    }
    for (const label of ["arena runners", "arena cross-judge pool", "architect runners", "interrogate reviewers"]) {
      for (const parent of parents) {
        const lanes = roleDefault(matrix, label, parent);
        const providers = new Set(lanes.map((l) => parseDescriptor(l)?.provider));
        assert.equal(lanes.length, 4, `${label}: four lanes`);
        assert.deepEqual([...providers].sort(), ["claude", "codex", "grok"], `${label}: every provider present`);
      }
    }
  });

  it("pins the 18 roles in matrix order", () => {
    assert.deepEqual(
      matrix.roles.map((r) => r.role),
      [
        "feature, refactoring",
        "bug-fix",
        "perf-issue",
        "hillclimb",
        "judgment and prose",
        "hardest tasks",
        "how explorer",
        "how explainer",
        "why investigators",
        "why synthesizer",
        "reflect tooling",
        "reflect judgment, divergent, synthesizer",
        "arena runners",
        "arena cross-judge pool",
        "swarm workers",
        "architect runners",
        "interrogate reviewers",
        "trail reviewer pool",
      ]
    );
    assert.equal(matrix.roles.length, 18);
    const mixedPanel = [
      "claude:fable@max",
      "codex:gpt-6-astra@max",
      "grok:grok-4.6@xhigh",
      "claude:claude-opus-5-5@xhigh",
    ];
    for (const parent of parents) {
      for (const label of ["arena runners", "arena cross-judge pool", "architect runners", "interrogate reviewers"]) {
        assert.deepEqual(roleDefault(matrix, label, parent), mixedPanel, `${label}/${parent}`);
      }
    }
  });

  it("reject a role default naming an unknown family, an unselectable effort, or a foreign parent", () => {
    assert.throws(
      () => validateMatrix(withRoles((rs) => { rs[0] = { ...rs[0], default: "gemini@high" }; })),
      /unknown family gemini/
    );
    assert.throws(
      () => validateMatrix(withRoles((rs) => { rs[0] = { ...rs[0], default: "grok@ultra" }; })),
      /does not select effort ultra/
    );
    assert.throws(
      () => validateMatrix(withRoles((rs) => { rs[0] = { ...rs[0], default: { claude: "grok@xhigh", cursor: "grok@xhigh" } }; })),
      /one entry per parent/
    );
    assert.throws(
      () => validateMatrix(withRoles((rs) => { rs.push({ ...rs[0] }); })),
      /duplicate/
    );
    assert.throws(
      () => validateMatrix(withRoles((rs) => { rs[0] = { ...rs[0], default: [] }; })),
      /empty list/
    );
    assert.throws(() => roleDefault(matrix, "no such role", "claude"), /unknown role/);
  });

  it("carry the trail reviewer pool as the one cross-family role, with the operator's three providers in order", () => {
    // Victor's decision of 2026-10-02: the trail reviewer comes from an explicit list, in this order of preference.
    assert.deepEqual(
      matrix.roles.filter((r) => r.selection === "cross-family").map((r) => r.role),
      ["trail reviewer pool"]
    );
    for (const parent of parents) {
      assert.deepEqual(
        roleDefault(matrix, "trail reviewer pool", parent),
        ["claude:claude-opus-5-5@xhigh", "codex:gpt-6.1-sol@xhigh", "grok:grok-4.7@xhigh"],
        parent
      );
    }
  });

  it("reject a cross-family role whose default holds an alias, names only the parent's provider, or carries an unknown selection", () => {
    const pool = (value: unknown) =>
      withRoles((rs) => {
        const index = rs.findIndex((r) => r.role === "trail reviewer pool");
        rs[index] = { ...rs[index], ...(value as Record<string, unknown>) };
      });
    assert.throws(
      () => validateMatrix(pool({ default: ["opus@xhigh", "inherit-parent", "grok@xhigh"] })),
      /role "trail reviewer pool" takes provider-qualified lanes only: inherit-parent runs on the parent model/
    );
    assert.throws(
      () => validateMatrix(pool({ default: ["opus@xhigh", "fable@max"] })),
      /role "trail reviewer pool" needs at least one lane from a provider other than claude, the parent's own; got claude:claude-opus-5-5@xhigh, claude:fable@max \(default for parent claude\)/
    );
    assert.throws(
      () => validateMatrix(pool({ default: ["sol@xhigh", "astra@max"] })),
      /provider other than codex, the parent's own/
    );
    assert.throws(() => validateMatrix(pool({ selection: "panel" })), /selection must be "cross-family" when present/);
    assert.doesNotThrow(() => validateMatrix(pool({ default: ["opus@xhigh", "sol@xhigh"] })));
  });

  it("render one sheet per parent in the line shape the sheet uses", () => {
    for (const parent of parents) {
      const lines = renderRoleSheet(matrix, parent).split("\n");
      assert.equal(lines.length, matrix.roles.length);
      for (const [i, line] of lines.entries()) {
        const role = matrix.roles[i];
        assert.equal(line, `${role.role}: ${roleDefault(matrix, role.role, parent).join(", ")}`);
      }
    }
    const table = renderRoleDefaultsMarkdown(matrix);
    for (const role of matrix.roles) assert.ok(table.includes(`| \`${role.role}\` |`), role.role);
  });
});

describe("cross-family selection", () => {
  const pool = ["claude:claude-opus-5-5@xhigh", "codex:gpt-6.1-sol@xhigh", "grok:grok-4.7@xhigh"];
  const chosen = (parent: string, executors: string[], lanes: readonly string[] = pool) =>
    pickCrossFamily(matrix, parent, lanes, executors).chosen?.descriptor ?? null;

  it("names the provider that runs natively in each parent", () => {
    assert.equal(nativeProviderOf(matrix, "claude"), "claude");
    assert.equal(nativeProviderOf(matrix, "codex"), "codex");
    assert.throws(() => nativeProviderOf(matrix, "cursor"), /unknown parent cursor/);
  });

  it("picks the first lane of another provider than the session's, in the operator's order", () => {
    assert.equal(chosen("claude", []), "codex:gpt-6.1-sol@xhigh");
    assert.equal(chosen("codex", []), "claude:claude-opus-5-5@xhigh");
    assert.equal(chosen("claude", [], [...pool].reverse()), "grok:grok-4.7@xhigh");
    const pick = pickCrossFamily(matrix, "claude", pool, []);
    assert.deepEqual(pick.executors, ["claude"]);
    assert.deepEqual(pick.eligible.map((l) => l.descriptor), ["codex:gpt-6.1-sol@xhigh", "grok:grok-4.7@xhigh"]);
    assert.deepEqual(pick.chosen, {
      descriptor: "codex:gpt-6.1-sol@xhigh",
      provider: "codex",
      model: "gpt-6.1-sol",
      effort: "xhigh",
      route: "runner",
    });
    assert.deepEqual(pick.skipped, [
      { lane: "claude:claude-opus-5-5@xhigh", reason: "same family: claude wrote part of the work" },
    ]);
  });

  it("drops every provider whose write lane is part of the result", () => {
    assert.equal(chosen("codex", ["grok"]), "claude:claude-opus-5-5@xhigh");
    assert.equal(chosen("claude", ["grok"]), "codex:gpt-6.1-sol@xhigh");
    assert.equal(chosen("claude", ["codex"]), "grok:grok-4.7@xhigh");
    assert.equal(chosen("codex", ["claude"]), "grok:grok-4.7@xhigh");
    assert.equal(chosen("claude", ["claude", "grok", "grok"]), "codex:gpt-6.1-sol@xhigh");
  });

  it("yields no lane when the three providers wrote, and never a lane of an executor", () => {
    const pick = pickCrossFamily(matrix, "claude", pool, ["codex", "grok"]);
    assert.equal(pick.chosen, null);
    assert.deepEqual(pick.eligible, []);
    assert.deepEqual(pick.skipped.map((s) => s.lane), pool);
    assert.deepEqual(pick.executors, ["claude", "codex", "grok"]);
  });

  it("compares providers, not families: another model of the session's provider is not cross-family", () => {
    const sameProvider = ["codex:gpt-6.1-sol@xhigh", "codex:gpt-6-astra@max", "codex:gpt-6-sol@high"];
    assert.equal(chosen("codex", [], sameProvider), null);
    assert.equal(chosen("claude", [], ["claude:fable@max", "claude:claude-opus-5-5@xhigh"]), null);
    assert.equal(chosen("claude", ["codex"], [...sameProvider, "claude:fable@max"]), null);
  });

  it("skips an alias, which runs on the parent model, and still picks the next lane", () => {
    const pick = pickCrossFamily(matrix, "claude", ["inherit-parent", "auto", "grok:grok-4.7@xhigh"], []);
    assert.equal(pick.chosen?.descriptor, "grok:grok-4.7@xhigh");
    assert.deepEqual(pick.skipped, [
      { lane: "inherit-parent", reason: "alias: runs on the parent model" },
      { lane: "auto", reason: "alias: runs on the parent model" },
    ]);
    assert.equal(chosen("codex", [], ["auto"]), null);
  });

  it("keeps each lane's effort as written and refuses an unknown executor or an unselectable effort", () => {
    assert.equal(chosen("claude", [], ["codex:gpt-6.1-sol@low", "grok:grok-4.7@xhigh"]), "codex:gpt-6.1-sol@low");
    assert.throws(() => pickCrossFamily(matrix, "claude", pool, ["cursor"]), /unknown provider "cursor"/);
    assert.throws(() => pickCrossFamily(matrix, "claude", ["grok:grok-4.7@max"], []), /does not select effort max/);
  });

  it("says why a row can never yield a lane under a parent", () => {
    assert.equal(crossFamilyRowProblem(matrix, "claude", "trail reviewer pool", pool), null);
    assert.equal(crossFamilyRowProblem(matrix, "codex", "trail reviewer pool", pool), null);
    assert.match(
      crossFamilyRowProblem(matrix, "codex", "trail reviewer pool", ["codex:gpt-6.1-sol@xhigh", "codex:gpt-6-astra@max"]) ?? "",
      /needs at least one lane from a provider other than codex/
    );
    assert.match(
      crossFamilyRowProblem(matrix, "claude", "trail reviewer pool", ["auto", "grok:grok-4.7@xhigh"]) ?? "",
      /takes provider-qualified lanes only: auto runs on the parent model/
    );
  });
});

describe("consumers", () => {
  const files = consumerFiles();
  const effortAlternation = matrix.efforts.join("|");
  const descriptorScan = new RegExp(
    `\\b([a-z][a-z0-9-]*):([a-z0-9][a-z0-9.-]*)@(${effortAlternation})\\b`,
    "g"
  );

  it("scan a non-empty consumer set", () => {
    assert.ok(files.length > 20, `found ${files.length} consumer files`);
    assert.ok(files.includes(DISPATCH_PATH));
  });

  it("cite only descriptors that resolve to a matrix family", () => {
    const offenders: string[] = [];
    for (const path of files) {
      const text = readFileSync(path, "utf8");
      for (const match of text.matchAll(descriptorScan)) {
        try {
          resolveDescriptor(matrix, match[0]);
        } catch (error) {
          offenders.push(`${rel(path)}: ${match[0]} (${(error as Error).message})`);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });

  it("keep the generated blocks of provider-dispatch.md and setup-pstack current", () => {
    const dispatch = readFileSync(DISPATCH_PATH, "utf8");
    assert.equal(renderDispatch(dispatch), dispatch, "run: node scripts/render-model-matrix.ts");
    const setup = readFileSync(SETUP_PATH, "utf8");
    assert.equal(renderSetup(setup), setup, "run: node scripts/render-model-matrix.ts");
    assert.throws(() => spliceMatrixBlock("no markers here", "x"), /exactly one/);
    assert.throws(() => renderSetup("no markers here"), /exactly one/);
  });

  it("cite only role labels the matrix declares", () => {
    // Skills say "your configured `<label>` role" or "the `<label>` row"; every
    // label has to be a sheet line, or /setup-pstack cannot override it.
    const citation = /`([^`\n]+)` (?:role\b|row (?:in|of) the (?:same )?role table)/g;
    const unknown: string[] = [];
    for (const path of files) {
      if (!rel(path).startsWith("skills/")) continue;
      const text = readFileSync(path, "utf8");
      for (const match of text.matchAll(citation)) {
        if (roleNamed(matrix, match[1]) === null) unknown.push(`${rel(path)}: ${match[0]}`);
      }
    }
    assert.deepEqual(unknown, []);
  });

  it("ship pstack-* agents only for declared families and efforts", () => {
    const agentsDir = join(PLUGIN_ROOT, "agents");
    const declared = new Set(declaredAgentNames(matrix));
    const shipped = readdirSync(agentsDir)
      .filter((n) => n.startsWith("pstack-") && n.endsWith(".md"))
      .map((n) => n.slice(0, -3))
      .sort();
    for (const name of shipped) {
      assert.ok(declared.has(name), `${name} is not declared by the matrix`);
      const fields = parseFrontmatter(readFileSync(join(agentsDir, `${name}.md`), "utf8"));
      const family = matrix.families.find(
        (f) => f.agentStem !== null && name.startsWith(`pstack-${f.agentStem}-`)
      ) as Family;
      assert.equal(fields.name, name);
      assert.equal(fields.model, family.model);
      assert.equal(agentName(family, fields.effort), name);
    }
    // The missing/stale directions and the generator live in generate-agents.test.ts (fase 3).
  });

  it("no longer cite Cursor 0.15.2 selectors (fase 4 substitution tracker)", () => {
    const pattern = cursorSlugPattern(matrix);
    const hits = new Map<string, number>();
    for (const path of files) {
      const text = readFileSync(path, "utf8");
      const count = [...text.matchAll(pattern)].length;
      if (count > 0) hits.set(rel(path), count);
    }
    const summary = [...hits].map(([file, n]) => `${file} (${n})`).sort();
    assert.deepEqual(summary, [], `Cursor selectors still present in ${hits.size} files`);
  });

  it("every Cursor selector still present has a family to migrate to", () => {
    const pattern = cursorSlugPattern(matrix);
    const unmapped: string[] = [];
    for (const path of files) {
      const text = readFileSync(path, "utf8");
      for (const match of text.matchAll(pattern)) {
        if (fromCursorSlug(matrix, match[0]) === null) unmapped.push(`${rel(path)}: ${match[0]}`);
      }
    }
    assert.deepEqual(unmapped, []);
  });
});
