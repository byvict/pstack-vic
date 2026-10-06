import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, parseArgs } from "./cli.ts";
import { UsageError } from "./types.ts";
import { clisOutsideFakes, isolateProcessEnv } from "./isolated-env.test-helper.ts";

let home = "";
let restoreProcessEnv: () => void = () => {};

// main() runs in this process. Every case here stops in the argument parser;
// if one ever gets past it, the process holds no CLI and a temporary HOME.
before(() => {
  home = mkdtempSync(join(tmpdir(), "pstack-runner-cli-"));
  restoreProcessEnv = isolateProcessEnv(home);
});

after(() => {
  restoreProcessEnv();
  rmSync(home, { recursive: true, force: true });
});

describe("test isolation", () => {
  it("keeps every provider CLI and gh off the PATH of the test process", () => {
    assert.deepEqual(clisOutsideFakes(process.env.PATH), [], "a CLI is on the PATH of the test process");
    assert.equal(process.env.PATH, join(home, ".node-bin"));
    assert.equal(process.env.HOME, home);
  });
});

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
  it("accepts external lanes from a Grok root and refuses Grok's native lane", async () => {
    const codex = parseArgs(argv(["--parent", "grok", "--model", "gpt-6.1-sol"]));
    assert.equal(codex?.parent, "grok");
    assert.equal(codex?.provider, "codex");
    const claude = parseArgs(argv(["--parent", "grok", "--provider", "claude", "--model", "fable"]));
    assert.equal(claude?.provider, "claude");
    let stderr = "";
    const code = await main(argv(["--parent", "grok", "--provider", "grok", "--model", "grok-4.7", "--effort", "xhigh"]), Date.now(), {
      stdout: () => {}, stderr: (text) => { stderr += text; },
    });
    assert.equal(code, 64);
    assert.match(stderr, /native|same.provider/);
  });
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
      /provider must be one of: claude, codex, grok$/
    );
    assert.throws(
      () => parseArgs(argv(["--parent", "gemini"])),
      /parent must be one of: claude, codex, grok/
    );
    assert.throws(
      () => parseArgs(argv(["--effort", "ultra"])),
      /effort must be one of: low, medium, high, xhigh, max/
    );
  });

  // Each one stops in the argument parser, before any path is reserved or any
  // CLI is looked up.
  it("refuses the retired --mode unsandboxed, --repo, and --pr with exit 64 and the reason", async () => {
    const refused: ReadonlyArray<readonly [string[], RegExp]> = [
      [["--mode", "unsandboxed"], /^error: mode must be one of: read-only, isolated-write, full-access\n/],
      [["--repo", "acme/app"], /^error: Unknown option '--repo'/],
      [["--pr", "7"], /^error: Unknown option '--pr'/],
    ];
    for (const [extra, reason] of refused) {
      assert.throws(() => parseArgs(argv(extra)), UsageError, extra.join(" "));
      const stdout: string[] = [];
      const stderr: string[] = [];
      const exitCode = await main(argv(extra), Date.now(), {
        stdout: (value) => stdout.push(value),
        stderr: (value) => stderr.push(value),
      });
      assert.equal(exitCode, 64, extra.join(" "));
      assert.match(stderr.join(""), reason);
      assert.match(stderr.join(""), /Usage: pstack-runner/);
      assert.deepEqual(stdout, []);
    }
  });
});
