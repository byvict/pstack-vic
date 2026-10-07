import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { freshRoot, Journal } from "./io.ts";

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "pstack-verifier-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("preparation logs survive both nonzero exit and a later JSON parse failure", async (t) => {
  const root = fixture(t), journal = new Journal(root);
  const bad = await journal.run([process.execPath, "-e", "process.stdout.write('partial\\u001b[31m'); process.stderr.write('diagnostic'); process.exitCode=3"], { cwd: root, label: "prepare" });
  assert.equal(bad.exitCode, 3);
  assert.equal(readFileSync(bad.stdout, "utf8"), "partial\u001b[31m");
  assert.equal(readFileSync(bad.stderr, "utf8"), "diagnostic");
  const malformed = await journal.run([process.execPath, "-e", "console.log('not JSON')"], { cwd: root, label: "parse" });
  assert.throws(() => JSON.parse(readFileSync(malformed.stdout, "utf8")));
  assert.equal(JSON.parse(readFileSync(malformed.receipt, "utf8")).status, "complete");
  assert.equal(readFileSync(malformed.stdout, "utf8"), "not JSON\n");
  assert.equal(statSync(malformed.stdout).mode & 0o777, 0o600);
});

test("stdout is visible before the command terminates", async (t) => {
  const root = fixture(t), controller = new AbortController(), journal = new Journal(root, controller.signal);
  const pending = journal.run([process.execPath, "-e", "console.log('ready'); setInterval(()=>{},1000)"], { cwd: root, label: "long" });
  const path = join(root, "commands/0001-long/stdout");
  try {
    for (let count = 0; count < 100 && !readFileSync(path, "utf8").includes("ready"); count++) await delay(20);
    assert.equal(readFileSync(path, "utf8"), "ready\n");
    assert.equal(JSON.parse(readFileSync(join(root, "commands/0001-long/command.json"), "utf8")).status, "running");
  } finally { controller.abort(); }
  assert.equal((await pending).status, "cancelled");
});

test("cancellation stops the owned grandchild group and preserves partial output", async (t) => {
  const root = fixture(t), controller = new AbortController(), journal = new Journal(root, controller.signal);
  const heartbeat = join(root, "heartbeat");
  const child = `const fs=require('node:fs'); setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'x'),20);`;
  const script = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'inherit'}); console.log('spawned'); setInterval(()=>{},1000);`;
  const pending = journal.run([process.execPath, "-e", script], { cwd: root, label: "tree" });
  let observed = false;
  try {
    for (let index = 0; index < 100; index++) {
      try { if (statSync(heartbeat).size > 0) { observed = true; break; } } catch {}
      await delay(20);
    }
  } finally { controller.abort(); }
  const result = await pending;
  assert.equal(observed, true);
  assert.equal(result.status, "cancelled");
  const length = statSync(heartbeat).size;
  await delay(100);
  assert.equal(statSync(heartbeat).size, length);
  assert.equal(readFileSync(result.stdout, "utf8"), "spawned\n");
});

test("explicit deadline and spawn failure each leave a terminal receipt", async (t) => {
  const root = fixture(t), journal = new Journal(root);
  const timeout = await journal.run([process.execPath, "-e", "setInterval(()=>{},1000)"], { cwd: root, label: "timeout", timeoutMs: 100 });
  assert.equal(timeout.status, "timed-out");
  const missing = await journal.run([join(root, "missing-binary")], { cwd: root, label: "missing" });
  assert.equal(missing.status, "failed");
  assert.match(JSON.parse(readFileSync(missing.receipt, "utf8")).error, /ENOENT/);
});

test("attempt roots cannot overwrite prior evidence or sit inside source", (t) => {
  const root = fixture(t), path = join(root, "proof");
  freshRoot(path, process.cwd());
  assert.throws(() => freshRoot(path, process.cwd()), /EEXIST/);
  assert.throws(() => freshRoot(join(process.cwd(), "proof"), process.cwd()), /outside/);
});
