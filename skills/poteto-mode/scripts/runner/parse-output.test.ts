// Copied from open-pstack 1.4.1 (de67e6b) runner/parse-output.test.ts;
// bun:test replaced by node:test and node:assert/strict. Model verification now
// follows each family's reportedModel pattern in model-matrix.json, so the
// Grok case asserts the matrix pattern (which admits the `-build` suffix the
// real CLI reports) instead of a prefix rule.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseProviderOutput, reportedModelMatches } from "./parse-output.ts";
import { matchObject } from "./match-object.test-helper.ts";

describe("parseProviderOutput", () => {
  it("extracts Claude text, model, usage, cost, and session", () => {
    const parsed = parseProviderOutput(
      "claude",
      JSON.stringify({
        result: "CLAUDE_OK",
        session_id: "claude-session",
        usage: { input_tokens: 10, output_tokens: 3 },
        total_cost_usd: 0.05,
        modelUsage: { "claude-fable-9-9": { inputTokens: 10 } },
      }),
      "",
      "fable"
    );
    matchObject(parsed, {
      text: "CLAUDE_OK",
      reportedModel: "claude-fable-9-9",
      sessionId: "claude-session",
      usage: { inputTokens: 10, outputTokens: 3 },
      costUsd: 0.05,
    });
  });

  it("extracts Codex JSONL without inventing a provider-reported model", () => {
    const parsed = parseProviderOutput(
      "codex",
      [
        JSON.stringify({ type: "thread.started", thread_id: "codex-session" }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "CODEX_OK" },
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: {
            input_tokens: 20,
            cached_input_tokens: 4,
            output_tokens: 5,
            reasoning_output_tokens: 2,
          },
        }),
      ].join("\n"),
      "model: gpt-5.6-sol\nreasoning effort: max\n",
      "gpt-5.6-sol"
    );
    matchObject(parsed, {
      text: "CODEX_OK",
      reportedModel: null,
      sessionId: "codex-session",
      usage: {
        inputTokens: 20,
        cachedInputTokens: 4,
        outputTokens: 5,
        reasoningTokens: 2,
      },
    });
  });

  it("verifies Grok only against the family's matrix pattern", () => {
    const event = (model: string): string =>
      [
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "progress" }] },
        }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "GROK_OK",
          session_id: "grok-session",
          usage: {
            input_tokens: 30,
            cache_read_input_tokens: 6,
            output_tokens: 7,
            reasoning_tokens: 3,
            total_tokens: 43,
          },
          total_cost_usd: 0.02,
          modelUsage: { [model]: {} },
        }),
      ].join("\n");
    const exact = parseProviderOutput("grok", event("grok-4.6"), "", "grok-4.6");
    assert.equal(exact.text, "GROK_OK");
    assert.equal(exact.reportedModel, "grok-4.6");
    matchObject(exact, {
      sessionId: "grok-session",
      usage: {
        inputTokens: 30,
        cachedInputTokens: 6,
        outputTokens: 7,
        reasoningTokens: 3,
        totalTokens: 43,
      },
      costUsd: 0.02,
    });
    assert.equal(reportedModelMatches("grok", "grok-4.6", exact.reportedModel), true);

    const build = parseProviderOutput("grok", event("grok-4.6-build"), "", "grok-4.6");
    assert.equal(build.reportedModel, "grok-4.6-build");
    assert.equal(reportedModelMatches("grok", "grok-4.6", build.reportedModel), true);

    const other = parseProviderOutput("grok", event("grok-4.5"), "", "grok-4.6");
    assert.equal(other.reportedModel, "grok-4.5");
    assert.equal(reportedModelMatches("grok", "grok-4.6", other.reportedModel), false);
  });

  it("selects the requested Claude model when usage includes a side model", () => {
    const parsed = parseProviderOutput(
      "claude",
      JSON.stringify({
        result: "CLAUDE_OK",
        modelUsage: {
          "claude-haiku-4-5-20251001": {},
          "claude-fable-9-9": {},
        },
      }),
      "",
      "fable"
    );
    assert.equal(parsed.reportedModel, "claude-fable-9-9");
  });

  it("matches only concrete Claude revisions from the requested rolling family", () => {
    assert.equal(reportedModelMatches("claude", "fable", "claude-fable-9-9"), true);
    assert.equal(reportedModelMatches("claude", "opus", "claude-opus-9"), true);
    assert.equal(reportedModelMatches("claude", "fable", "claude-opus-9"), false);
    assert.equal(reportedModelMatches("claude", "fable", "claude-fable-beta"), false);
    assert.equal(reportedModelMatches("claude", "fable", "fable"), false);
    assert.equal(reportedModelMatches("claude", "fable", "fable-preview"), false);
    assert.equal(reportedModelMatches("grok", "fable", "claude-fable-9-9"), false);
  });

  it("never verifies a Codex family or a pair outside the matrix by report", () => {
    assert.equal(reportedModelMatches("codex", "gpt-5.6-sol", "gpt-5.6-sol"), false);
    assert.equal(reportedModelMatches("codex", "gpt-6-astra", "gpt-6-astra"), false);
    assert.equal(reportedModelMatches("claude", "sonnet", "claude-sonnet-9"), false);
    assert.equal(reportedModelMatches("claude", "fable", null), false);
  });

  it("rejects malformed or textless responses", () => {
    assert.throws(
      () => parseProviderOutput("claude", "not-json", "", "fable"),
      /valid JSON/
    );
    assert.throws(
      () =>
        parseProviderOutput(
          "codex",
          JSON.stringify({ type: "turn.completed" }),
          "",
          "gpt-5.6-sol"
        ),
      /final agent message/
    );
  });
});
