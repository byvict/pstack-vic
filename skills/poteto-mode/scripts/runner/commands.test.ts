// Copied from open-pstack 1.4.1 (de67e6b) runner/commands.test.ts; bun:test
// replaced by node:test and node:assert/strict. Added: the Astra family shares
// Sol's Codex argv except for --model, and an unknown provider is refused.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { invocationCommand, preflightCommand } from "./commands.ts";
import type { RunnerOptions } from "./types.ts";
import { arrayContaining } from "./match-object.test-helper.ts";

function options(overrides: Partial<RunnerOptions> = {}): RunnerOptions {
  return {
    parent: "claude",
    provider: "codex",
    model: "gpt-5.6-sol",
    effort: "max",
    mode: "read-only",
    promptPath: "/tmp/prompt.md",
    cwd: "/tmp/worktree",
    outputPath: "/tmp/output.md",
    receiptPath: "/tmp/receipt.json",
    timeoutMs: null,
    ...overrides,
  };
}

describe("invocationCommand", () => {
  it("pins Codex model, effort, sandbox, cwd, and JSONL output", () => {
    const spec = invocationCommand(options());
    assert.equal(spec.command, "codex");
    assert.equal(spec.stdin, "prompt");
    assert.deepEqual(spec.args, [
      "exec",
      "--model",
      "gpt-5.6-sol",
      "--config",
      'model_reasoning_effort="max"',
      "--sandbox",
      "read-only",
      "--cd",
      "/tmp/worktree",
      "--skip-git-repo-check",
      "--ephemeral",
      "--disable",
      "plugins",
      "--disable",
      "multi_agent",
      "--disable",
      "hooks",
      "--disable",
      "memories",
      "--json",
      "-",
    ]);
    assert.ok(!spec.args.includes("danger-full-access"));
  });

  it("runs Astra through the same Codex command as Sol, changing only --model", () => {
    const sol = invocationCommand(options({ model: "gpt-5.6-sol" }));
    const astra = invocationCommand(options({ model: "gpt-6-astra" }));
    assert.equal(astra.command, sol.command);
    assert.equal(astra.stdin, sol.stdin);
    assert.deepEqual(
      astra.args,
      sol.args.map((arg) => (arg === "gpt-5.6-sol" ? "gpt-6-astra" : arg))
    );
    assert.equal(astra.args[astra.args.indexOf("--model") + 1], "gpt-6-astra");
    assert.deepEqual(preflightCommand("codex"), {
      command: "codex",
      args: ["login", "status"],
      stdin: "none",
    });
  });

  it("passes Claude model, effort, permissions, and no-recursion controls", () => {
    const spec = invocationCommand(
      options({
        parent: "codex",
        provider: "claude",
        model: "fable",
      })
    );
    assert.equal(spec.command, "claude");
    assert.equal(spec.stdin, "prompt");
    assert.deepEqual(spec.args, [
      "-p",
      "--model",
      "fable",
      "--effort",
      "max",
      "--permission-mode",
      "plan",
      "--setting-sources",
      "project",
      "--strict-mcp-config",
      "--tools",
      "Read,Grep,Glob,Bash",
      "--no-session-persistence",
      "--disable-slash-commands",
      "--disallowed-tools",
      "Agent,Task,WebSearch,WebFetch,Edit,Write,NotebookEdit",
      "--output-format",
      "json",
    ]);
    assert.ok(!spec.args.includes("bypassPermissions"));
  });

  it("limits Grok to the assigned cwd and disables recursive agents", () => {
    const spec = invocationCommand(
      options({ provider: "grok", model: "grok-4.6", effort: "xhigh" })
    );
    assert.equal(spec.command, "grok");
    assert.equal(spec.stdin, "none");
    assert.deepEqual(spec.args, [
      "--prompt-file",
      "/tmp/prompt.md",
      "--model",
      "grok-4.6",
      "--reasoning-effort",
      "xhigh",
      "--permission-mode",
      "plan",
      "--sandbox",
      "read-only",
      "--tools",
      "read_file,grep,list_dir,run_terminal_cmd",
      "--disallowed-tools",
      "Agent,search_tool,use_tool",
      "--output-format",
      "streaming-messages-json",
      "--cwd",
      "/tmp/worktree",
      "--no-subagents",
      "--disable-web-search",
      "--verbatim",
    ]);
  });

  it("uses bounded write modes without blanket bypasses", () => {
    const codex = invocationCommand(options({ mode: "isolated-write" }));
    arrayContaining(codex.args, ["--sandbox", "workspace-write"]);
    const grok = invocationCommand(
      options({ provider: "grok", model: "grok-4.6", mode: "isolated-write" })
    );
    arrayContaining(grok.args, [
      "--permission-mode",
      "acceptEdits",
      "--sandbox",
      "workspace",
      "--tools",
      "read_file,grep,list_dir,run_terminal_cmd,search_replace",
    ]);
    assert.ok(!grok.args.includes("--always-approve"));

    const claude = invocationCommand(
      options({ provider: "claude", model: "fable", mode: "isolated-write" })
    );
    arrayContaining(claude.args, [
      "--permission-mode",
      "acceptEdits",
      "--tools",
      "Read,Write,Edit,Grep,Glob,Bash",
    ]);
  });

  it("covers low, medium, and high for every external provider", () => {
    const cases = [
      {
        provider: "claude",
        model: "fable",
        flag: (effort: string) => ["--effort", effort],
      },
      {
        provider: "codex",
        model: "gpt-5.6-sol",
        flag: (effort: string) => [
          "--config",
          `model_reasoning_effort="${effort}"`,
        ],
      },
      {
        provider: "grok",
        model: "grok-4.6",
        flag: (effort: string) => ["--reasoning-effort", effort],
      },
    ];
    for (const { provider, model, flag } of cases) {
      for (const effort of ["low", "medium", "high"]) {
        const spec = invocationCommand(options({ provider, model, effort }));
        arrayContaining(spec.args, flag(effort));
      }
    }
  });

  it("refuses a provider that is not in the matrix", () => {
    assert.throws(
      () => invocationCommand(options({ provider: "gemini" })),
      /provider gemini has no CLI in model-matrix.json/
    );
    assert.throws(() => preflightCommand("gemini"), /no CLI in model-matrix.json/);
  });
});
