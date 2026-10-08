import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertReadonlyLocation, assertReadonlyResult } from "./runner-source-evidence.ts";

const digest = "a".repeat(64), forbidden = "/proof/workspace/forbidden.txt";
const output = `${digest}\nPermissionError: [Errno 1] Operation not permitted: '${forbidden}'\n`;
for (const provider of ["codex", "grok"] as const) {
  const event = (command: string, text = output, exitCode = 1): unknown => provider === "codex"
    ? { type: "item.completed", item: { id: "terminal-1", type: "command_execution", command, exit_code: exitCode, aggregated_output: text } }
    : { update: { toolCallId: "terminal-1", status: "completed", rawOutput: { type: "Bash", command, exit_code: exitCode, output_for_prompt: text } } };
  test(`${provider}: requires the controlled execution and its own denial result`, () => {
    const command = provider === "codex" ? "/bin/zsh -lc 'python3 readonly-probe.py'" : "python3 readonly-probe.py";
    assert.equal(assertReadonlyResult([event(command)], provider, digest, forbidden).id, "terminal-1");
    const prose = { type: "item.completed", item: { type: "agent_message", text: output + "python3 readonly-probe.py" } };
    assert.throws(() => assertReadonlyResult([prose], provider, digest, forbidden), /one completed execution/);
    assert.throws(() => assertReadonlyResult([event("echo python3 readonly-probe.py"), prose], provider, digest, forbidden), /one completed execution/);
    assert.throws(() => assertReadonlyResult([event(command, "no denial"), prose], provider, digest, forbidden), /Missing computed digest/);
    assert.throws(() => assertReadonlyResult([event(command, output, 0)], provider, digest, forbidden), /did not fail/);
    assert.throws(() => assertReadonlyResult([event(command), event(command)], provider, digest, forbidden), /one completed execution/);
  });
}

test("read-only location rejects writable exceptions, including symlink aliases", () => {
  const root = mkdtempSync(join(tmpdir(), "source-proof-location-"));
  try {
    const writable = join(root, "temp"), outside = join(root, "temp-sibling"), alias = join(root, "alias");
    mkdirSync(writable); mkdirSync(outside); symlinkSync(writable, alias);
    assert.throws(() => assertReadonlyLocation(writable, [writable]), /writable sandbox exception/);
    assert.throws(() => assertReadonlyLocation(alias, [writable]), /writable sandbox exception/);
    assert.doesNotThrow(() => assertReadonlyLocation(outside, [writable]));
  } finally { rmSync(root, { recursive: true }); }
});
