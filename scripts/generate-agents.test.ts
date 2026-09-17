import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MATRIX_PATH,
  declaredAgentNames,
  loadMatrix,
  validateMatrix,
  type Family,
  type ModelMatrix,
} from "./model-matrix.ts";
import {
  AGENTS_DIR,
  diffAgents,
  expectedAgents,
  generateAgents,
  isClean,
  renderAgent,
  shippedAgents,
} from "./generate-agents.ts";

const matrix = loadMatrix();

function parseFrontmatter(text: string): { fields: Record<string, string>; body: string } {
  assert.ok(text.startsWith("---\n"), "agent file must start with frontmatter");
  const end = text.indexOf("\n---\n", 4);
  assert.ok(end > 0, "agent frontmatter must terminate");
  const fields: Record<string, string> = {};
  for (const line of text.slice(4, end).split("\n")) {
    const idx = line.indexOf(": ");
    assert.ok(idx > 0, `bad frontmatter line: ${line}`);
    fields[line.slice(0, idx)] = line.slice(idx + 2);
  }
  return { fields, body: text.slice(end + 5) };
}

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "pstack-agents-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function withClaudeFamily(): ModelMatrix {
  const raw = JSON.parse(readFileSync(MATRIX_PATH, "utf8")) as Record<string, unknown>;
  (raw.families as unknown[]).push({
    family: "test-family",
    provider: "claude",
    model: "test-model",
    efforts: ["low", "high"],
    defaultEffort: "high",
    agentStem: "test",
    cursorSlug: null,
    reportedModel: null,
  });
  return validateMatrix(raw);
}

describe("generate-agents", () => {
  it("renders one agent per Claude-native family and selectable effort, in matrix order", () => {
    const expected = expectedAgents(matrix);
    assert.deepEqual([...expected.keys()], declaredAgentNames(matrix));
    assert.ok(expected.size >= 1, "the matrix declares at least one Claude-native agent");
    const bodies = new Map<string, string>();
    for (const f of matrix.families) {
      if (f.agentStem === null) continue;
      for (const effort of f.efforts) {
        const name = `pstack-${f.agentStem}-${effort}`;
        const { fields, body } = parseFrontmatter(expected.get(name) as string);
        assert.deepEqual(fields, {
          name,
          description: `Native Claude lane for pstack roles configured as ${f.provider}:${f.model}@${effort}.`,
          model: f.model,
          effort,
          background: "true",
          disallowedTools: "Agent, Task",
        });
        const prior = bodies.get(f.agentStem);
        if (prior === undefined) bodies.set(f.agentStem, body);
        else assert.equal(body, prior, `${f.family}: same body across efforts`);
      }
    }
  });

  it("refuses to render a family without a stem or an effort it does not select", () => {
    const grok = matrix.families.find((f) => f.family === "grok") as Family;
    const fable = matrix.families.find((f) => f.family === "fable") as Family;
    assert.throws(() => renderAgent(grok, "max"), /no Claude-native agent stem/);
    assert.throws(() => renderAgent(fable, "ultra"), /does not select effort ultra/);
  });

  it("ships exactly the declared agents, byte-identical to the generator's output", () => {
    const diff = diffAgents(matrix, AGENTS_DIR);
    assert.deepEqual(diff, { missing: [], orphan: [], stale: [] }, "run: node scripts/generate-agents.ts");
    assert.deepEqual(shippedAgents(AGENTS_DIR), [...declaredAgentNames(matrix)].sort());
  });

  it("reports missing, orphan and stale agents and fixes all three on generate", () => {
    withTempDir((dir) => {
      const first = [...expectedAgents(matrix).keys()][0];
      assert.deepEqual(diffAgents(matrix, dir).missing, declaredAgentNames(matrix));
      generateAgents(matrix, dir);
      assert.ok(isClean(diffAgents(matrix, dir)));

      writeFileSync(join(dir, "pstack-sonnet-max.md"), "---\nname: pstack-sonnet-max\n---\n");
      writeFileSync(join(dir, `${first}.md`), "---\nname: edited\n---\n");
      rmSync(join(dir, `${[...expectedAgents(matrix).keys()].at(-1)}.md`));
      const diff = diffAgents(matrix, dir);
      assert.deepEqual(diff.orphan, ["pstack-sonnet-max"]);
      assert.deepEqual(diff.stale, [first]);
      assert.deepEqual(diff.missing, [[...expectedAgents(matrix).keys()].at(-1)]);
      assert.equal(isClean(diff), false);

      assert.deepEqual(generateAgents(matrix, dir), diff);
      assert.ok(isClean(diffAgents(matrix, dir)));
      assert.deepEqual(shippedAgents(dir), [...declaredAgentNames(matrix)].sort());
    });
  });

  it("picks up a Claude-native family added as one matrix line", () => {
    const extended = withClaudeFamily();
    const names = [...expectedAgents(extended).keys()];
    assert.deepEqual(names, [...declaredAgentNames(matrix), "pstack-test-low", "pstack-test-high"]);
    const { fields, body } = parseFrontmatter(expectedAgents(extended).get("pstack-test-high") as string);
    assert.equal(fields.model, "test-model");
    assert.equal(fields.effort, "high");
    assert.ok(body.trimStart().startsWith("# pstack Test lane\n"));
    withTempDir((dir) => {
      generateAgents(matrix, dir);
      assert.deepEqual(diffAgents(extended, dir).missing, ["pstack-test-low", "pstack-test-high"]);
      generateAgents(extended, dir);
      assert.deepEqual(diffAgents(matrix, dir).orphan, ["pstack-test-high", "pstack-test-low"]);
    });
  });
});
