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

function cursorArgv(extra: readonly string[] = []): string[] {
  return argv(["--provider", "cursor", "--model", "composer-2.5", "--effort", "high", ...extra]);
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

  it("parses the unsandboxed mode", () => {
    const parsed = parseArgs(
      argv(["--provider", "grok", "--model", "grok-4.7", "--effort", "high", "--mode", "unsandboxed"])
    );
    assert.equal(parsed?.mode, "unsandboxed");
  });

  it("parses --repo and --pr into a target for an http provider only", () => {
    const parsed = parseArgs(cursorArgv(["--repo", "acme/app", "--pr", "7"]));
    assert.deepEqual(parsed?.target, { owner: "acme", name: "app", pullNumber: 7 });
    assert.equal(parsed?.provider, "cursor");
    assert.equal(parseArgs(argv())?.target, null);
  });

  it("requires --repo and --pr together for an http provider and refuses them for a cli one", () => {
    assert.throws(
      () => parseArgs(cursorArgv()),
      /--repo and --pr are required for cursor \(http transport\)/
    );
    assert.throws(
      () => parseArgs(argv(["--provider", "grok", "--model", "grok-4.6", "--repo", "acme/app", "--pr", "7"])),
      /--repo and --pr are only accepted for: cursor/
    );
    assert.throws(() => parseArgs(cursorArgv(["--repo", "acme/app"])), /--pr is required with --repo/);
    assert.throws(() => parseArgs(cursorArgv(["--pr", "7"])), /--repo is required with --pr/);
  });

  it("rejects a --repo that is not owner/name and a --pr that is not a positive integer", () => {
    for (const repo of ["acme", "acme/", "/app", "https://github.com/acme/app", "acme/app/extra", " /app"]) {
      assert.throws(
        () => parseArgs(cursorArgv(["--repo", repo, "--pr", "7"])),
        /--repo must be owner\/name/,
        repo
      );
    }
    for (const pr of ["0", "-1", "1.5", "seven", "1e3", ""]) {
      assert.throws(
        () => parseArgs(cursorArgv(["--repo", "acme/app", `--pr=${pr}`])),
        /--pr must be a positive integer/,
        pr
      );
    }
  });
});
