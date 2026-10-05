import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { it } from "node:test";
import assert from "node:assert/strict";
import { PLUGIN_ROOT } from "./model-matrix.ts";

const script = join(PLUGIN_ROOT, "skills/poteto-mode/scripts/grok-audit-ticker.ts");

it("emits a root audit event for the program and stops on cancellation", { timeout: 5000 }, async () => {
  const child = spawn(process.execPath, [script, "--program", PLUGIN_ROOT, "--interval-ms", "20"], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit");
  try {
    assert.ok(child.stdout);
    const [chunk] = await once(child.stdout, "data");
    const text = String(chunk);
    const event = JSON.parse(text.split("\n")[0]);
    assert.equal(event.event, "pstack-audit-tick");
    assert.equal(event.program, PLUGIN_ROOT);
    assert.ok(Number.isFinite(Date.parse(event.at)));
    child.kill("SIGTERM");
    const [code, signal] = await exited;
    assert.equal(code, 0);
    assert.equal(signal, null);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

it("refuses a missing program or an invalid interval before starting a monitor", () => {
  for (const args of [[], ["--program", PLUGIN_ROOT, "--interval-ms", "0"], ["--program", script], ["--program", PLUGIN_ROOT, "--interval-ms", "2147483648"]]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
    assert.equal(result.status, 64);
    assert.equal(result.stdout, "");
    assert.ok(result.stderr.length > 0);
  }
});
