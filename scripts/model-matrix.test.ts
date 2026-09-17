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
  reportedModelMatches,
  resolveDescriptor,
  routeFor,
  spliceMatrixBlock,
  validateMatrix,
  type Family,
  type ModelMatrix,
} from "./model-matrix.ts";
import { DISPATCH_PATH, renderDispatch } from "./render-model-matrix.ts";

const matrix = loadMatrix();

// Files whose prose or frontmatter may cite a model. Anything here that names a
// descriptor outside model-matrix.json fails the consumer test.
const CONSUMER_DIRS = ["skills", "agents", "docs", "hooks"] as const;
const CONSUMER_ROOT_FILES = ["README.md"] as const;
const CONSUMER_EXTENSIONS = new Set([".md", ".json", ".mjs", ".ts", ".sh", ".cmd"]);
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
      ["opus", "claude", "opus"],
      ["sol", "codex", "gpt-5.6-sol"],
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
    assert.equal(reportedModelMatches(sol, "gpt-5.6-sol"), false, "codex pins by argv");
    assert.equal(reportedModelMatches(grok, "grok-4.6"), true);
    assert.equal(reportedModelMatches(grok, "grok-4.5"), false);
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

  it("keep provider-dispatch.md's generated block current", () => {
    const current = readFileSync(DISPATCH_PATH, "utf8");
    assert.equal(renderDispatch(current), current, "run: node scripts/render-model-matrix.ts");
    assert.throws(() => spliceMatrixBlock("no markers here", "x"), /exactly one/);
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
    // Fase 3 adds the generator and the missing-agent direction of this check.
  });

  it("no longer cite Cursor 0.15.2 selectors (fase 4 substitution tracker)", { todo: true }, () => {
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
