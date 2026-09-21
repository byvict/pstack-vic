// Copied from open-pstack 1.4.1 (de67e6b) runner/cli.test.ts; bun:test
// replaced by node:test and node:assert/strict.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { parseArgs } from "./cli.ts";

function argv(extra: readonly string[] = []): string[] {
  return [
    "--parent",
    "claude",
    "--provider",
    "codex",
    "--model",
    "gpt-5.6-sol",
    "--effort",
    "max",
    "--mode",
    "read-only",
    "--prompt",
    join(process.cwd(), "prompt.md"),
    "--cwd",
    process.cwd(),
    "--output",
    join(process.cwd(), "output.md"),
    "--receipt",
    join(process.cwd(), "receipt.json"),
    ...extra,
  ];
}

describe("runner CLI parsing", () => {
  it("does not invent a timeout", () => {
    assert.equal(parseArgs(argv())?.timeoutMs, null);
  });

  it("honors an explicit positive timeout", () => {
    assert.equal(parseArgs(argv(["--timeout", "5400"]))?.timeoutMs, 5_400_000);
  });

  it("rejects a non-positive timeout", () => {
    assert.throws(() => parseArgs(argv(["--timeout", "0"])), /greater than zero/);
  });

  it("derives parent, provider, and effort choices from the matrix", () => {
    assert.throws(
      () => parseArgs(argv(["--provider", "gemini"])),
      /provider must be one of: claude, codex, cursor, grok$/
    );
    assert.throws(
      () => parseArgs(argv(["--parent", "cursor"])),
      /parent must be one of: claude, codex/
    );
    assert.throws(
      () => parseArgs(argv(["--effort", "ultra"])),
      /effort must be one of: low, medium, high, xhigh, max/
    );
  });
});
