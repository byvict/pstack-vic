import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  MATRIX_PATH,
  PLUGIN_ROOT,
  agentName,
  cursorSlugPattern,
  declaredAgentNames,
  defaultDescriptor,
  familyFor,
  fromCursorSlug,
  loadMatrix,
  nativeParentOf,
  parseDescriptor,
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
const CONSUMER_DIRS = ["skills", "agents", "docs"] as const;
const CONSUMER_ROOT_FILES = ["README.md"] as const;
const CONSUMER_EXTENSIONS = new Set([".md", ".json", ".mjs", ".ts", ".sh"]);
const SKIP_DIRS = new Set(["node_modules", ".git"]);

function walk(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
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

  it("accepts cli null only for an http provider", () => {
    const cursor = matrix.providers.cursor;
    assert.deepEqual(cursor, { cli: null, transport: "http", nativeIn: null });
    assert.equal(matrix.providers.grok.transport, "cli");
    for (const parent of Object.keys(matrix.parents)) {
      assert.equal(routeFor(matrix, parent, "cursor"), "runner");
    }
    const withProvider = (spec: Record<string, unknown>): unknown => {
      const raw = rawMatrix();
      (raw.providers as Record<string, unknown>).cursor = spec;
      return raw;
    };
    assert.throws(
      () => validateMatrix(withProvider({ cli: null, nativeIn: null })),
      /providers\.cursor\.cli must be a non-empty string when transport is cli/
    );
    assert.throws(
      () => validateMatrix(withProvider({ cli: "agent", transport: "http", nativeIn: null })),
      /providers\.cursor\.cli must be null when transport is http/
    );
    assert.throws(
      () => validateMatrix(withProvider({ cli: null, transport: "ssh", nativeIn: null })),
      /providers\.cursor\.transport must be "cli" or "http"/
    );
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

  it("resolves the four Cursor PR-phase families and rejects unselectable efforts", () => {
    const cases: Array<[string, string, readonly string[], string]> = [
      ["kimi", "kimi-k3", ["low", "high"], "max"],
      ["glm", "glm-5.2", ["high"], "low"],
      ["gemini-pro", "gemini-3.1-pro", ["high"], "low"],
      ["muse", "muse-spark-1.3", ["low", "high", "xhigh"], "medium"],
    ];
    assert.deepEqual(
      matrix.families.map((f) => f.family).slice(-4),
      ["kimi", "glm", "gemini-pro", "muse"]
    );
    for (const [family, model, efforts, bad] of cases) {
      const resolved = resolveDescriptor(matrix, `cursor:${model}@high`);
      assert.equal(resolved.family.family, family);
      assert.equal(resolved.family.provider, "cursor");
      assert.equal(resolved.family.model, model);
      assert.deepEqual([...resolved.family.efforts], [...efforts]);
      assert.equal(resolved.family.defaultEffort, "high");
      assert.equal(resolved.family.agentStem, null);
      assert.equal(resolved.family.cursorSlug, null);
      assert.equal(resolved.family.reportedModel, null);
      assert.throws(
        () => resolveDescriptor(matrix, `cursor:${model}@${bad}`),
        /does not select effort/
      );
    }
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

  it("carry the decided default map: volume on grok, frontier solo on the parent's native frontier, panels mixed, why and reflect inherit", () => {
    // Decisions of 2026-09-17 (plan, fase 6 bullets). The labels are the sheet lines /setup-pstack writes.
    for (const label of ["feature, refactoring", "bug-fix", "perf-issue", "hillclimb", "swarm workers", "how explorer"]) {
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

  it("pins the 22 roles in matrix order and the two Cloud PR responsibilities", () => {
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
        "pre-pr reviewer",
        "pre-pr fixer",
        "pre-pr certifier",
        "pr owner",
        "pr verifier",
      ]
    );
    assert.equal(matrix.roles.length, 22);
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
      assert.deepEqual(roleDefault(matrix, "pr owner", parent), ["cursor:grok-4.7@high"]);
      assert.deepEqual(roleDefault(matrix, "pr verifier", parent), ["cursor:grok-4.7@high"]);
    }
    assert.equal(
      roleNamed(matrix, "pr verifier")?.description,
      "Independently checks risk, tests and user behavior of the exact PR head in Cursor Cloud without writing code."
    );
    assert.equal(
      roleNamed(matrix, "pr owner")?.description,
      "Owns an uncertified or red PR in Cursor Cloud through verification, repair and merge; start.ts exits when the head is certified."
    );
  });

  it("pre-pr roles default to Grok 4.7 lanes on both parents", () => {
    assert.deepEqual(roleDefault(matrix, "pre-pr reviewer", "claude"), ["grok:grok-4.7@xhigh"]);
    assert.deepEqual(roleDefault(matrix, "pre-pr certifier", "codex"), ["grok:grok-4.7@high"]);
    assert.deepEqual(roleDefault(matrix, "pre-pr fixer", "claude"), ["grok:grok-4.7@xhigh"]);
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
