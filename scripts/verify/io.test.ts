import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

test("signal failures preserve command outcomes and spawn errors in terminal receipts", async (t) => {
  const root = fixture(t);
  t.mock.method(process, "kill", () => { throw Object.assign(new Error("kill EPERM"), { code: "EPERM", errno: -1, syscall: "kill" }); });
  const journal = new Journal(root);
  for (const exit of [0, 7]) {
    const result = await journal.run([process.execPath, "-e", `process.exit(${exit})`], { cwd: root, label: `exit-${exit}` });
    assert.equal(result.status, "failed");
    assert.equal(result.exitCode, exit);
    assert.deepEqual(result.cleanupErrors, [{ operation: "signal", target: -result.pid!, signal: "SIGKILL", message: "kill EPERM", code: "EPERM", errno: -1, syscall: "kill" }]);
    assert.deepEqual(JSON.parse(readFileSync(result.receipt, "utf8")), result);
  }
  const missing = await journal.run([process.execPath], { cwd: join(root, "missing"), label: "spawn-error" });
  assert.match(missing.error!, /ENOENT/);
  assert.equal(missing.status, "failed");
});

test("a command error and close failure coexist while later descriptors still close", async (t) => {
  const root = fixture(t), closed: number[] = [], owned = new Set<number>();
  let renames = 0;
  const originalClose = fs.closeSync, originalRename = fs.renameSync, originalOpen = fs.openSync;
  const open = t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    const descriptor = originalOpen(...args);
    if (String(args[0]).endsWith("/stdout") || String(args[0]).endsWith("/stderr") || (String(args[0]).endsWith("/stdin") && args[1] === "r")) owned.add(descriptor);
    return descriptor;
  });
  const rename = t.mock.method(fs, "renameSync", (source: fs.PathLike, destination: fs.PathLike) => {
    // Fail the running receipt, after the initial receipt and child launch.
    if (++renames === 2) throw new Error("receipt write failed");
    return originalRename(source, destination);
  });
  const close = t.mock.method(fs, "closeSync", (descriptor: number) => {
    originalClose(descriptor);
    if (owned.delete(descriptor)) {
      closed.push(descriptor);
      if (closed.length === 1) throw Object.assign(new Error("close EIO"), { code: "EIO" });
    }
  });
  syncBuiltinESMExports();
  let result;
  try { result = await new Journal(root).run([process.execPath, "-e", "process.exit(0)"], { cwd: root, label: "close-failure", input: "input" }); }
  finally { open.mock.restore(); rename.mock.restore(); close.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(result.status, "failed");
  assert.equal(result.error, "receipt write failed");
  assert.equal(result.cleanupErrors?.[0].operation, "close");
  assert.equal(result.cleanupErrors?.[0].code, "EIO");
  assert.equal(closed.length, 3);
  for (const descriptor of closed) assert.throws(() => fs.fstatSync(descriptor), /EBADF/);
  assert.equal(JSON.parse(readFileSync(result.receipt, "utf8")).error, "receipt write failed");
});

for (const reason of ["timeout", "abort"] as const) test(`${reason} and escalation callbacks retain signal failures without throwing`, async (t) => {
  const root = fixture(t), controller = new AbortController();
  t.mock.method(process, "kill", () => { throw Object.assign(new Error("kill EPERM"), { code: "EPERM" }); });
  const pending = new Journal(root, controller.signal).run([process.execPath, "-e", "setTimeout(()=>process.exit(4),1400)"],
    { cwd: root, label: reason, ...(reason === "timeout" ? { timeoutMs: 50 } : {}) });
  if (reason === "abort") controller.abort();
  const result = await pending;
  assert.equal(result.status, reason === "timeout" ? "timed-out" : "cancelled");
  assert.equal(result.exitCode, 4);
  assert.deepEqual(result.cleanupErrors?.map((error) => error.operation === "signal" ? error.signal : error.operation), ["SIGTERM", "SIGKILL", "SIGKILL"]);
  assert.equal(JSON.parse(readFileSync(result.receipt, "utf8")).status, result.status);
});

test("cleanup signals surviving descendants after the leader has exited", async (t) => {
  const root = fixture(t), heartbeat = join(root, "orphan-heartbeat");
  const descendant = `require('node:fs').appendFileSync(${JSON.stringify(heartbeat)},'x');setInterval(()=>require('node:fs').appendFileSync(${JSON.stringify(heartbeat)},'x'),20)`;
  const leader = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'inherit'});setTimeout(()=>process.exit(0),200)`;
  const result = await new Journal(root).run([process.execPath, "-e", leader], { cwd: root, label: "dead-leader" });
  assert.equal(result.status, "complete");
  const size = statSync(heartbeat).size;
  await delay(100);
  assert.equal(statSync(heartbeat).size, size);
});

test("macOS zombie-only group produces a terminal receipt with the real EPERM", { skip: process.platform !== "darwin" }, async (t) => {
  const root = fixture(t), holder = join(root, "holder.py");
  writeFileSync(holder, `import os,subprocess,time,pathlib,json,sys
root=pathlib.Path(sys.argv[1]);group=int(sys.argv[2]);os.setpgid(0,0)
child=subprocess.Popen(['/bin/sleep','.01'],preexec_fn=lambda:os.setpgid(0,group))
time.sleep(.05)
(root/'ready').write_text(json.dumps({'holder':os.getpid(),'zombie':child.pid}))
end=time.monotonic()+10
while not(root/'release').exists() and time.monotonic()<end:time.sleep(.005)
child.wait()
(root/'reaped').write_text('yes')
`);
  const leader = `import subprocess,os,time,pathlib
root=pathlib.Path(${JSON.stringify(root)})
subprocess.Popen(['/usr/bin/python3',${JSON.stringify(holder)},str(root),str(os.getpgrp())])
while not(root/'ready').exists():time.sleep(.005)
`;
  let result;
  try { result = await new Journal(root).run(["/usr/bin/python3", "-c", leader], { cwd: root, label: "zombie" }); }
  finally {
    writeFileSync(join(root, "release"), "yes");
    for (let i = 0; i < 200 && !existsSync(join(root, "reaped")); i++) await delay(10);
    assert.ok(existsSync(join(root, "reaped")), "fixture must reap its zombie");
    const ids = JSON.parse(readFileSync(join(root, "ready"), "utf8"));
    for (const pid of [ids.holder, ids.zombie]) {
      for (let i = 0; i < 100; i++) { try { process.kill(pid, 0); } catch { break; } await delay(10); }
      assert.throws(() => process.kill(pid, 0), /ESRCH/);
    }
  }
  assert.equal(result.status, "failed");
  assert.equal(result.exitCode, 0);
  assert.equal(result.cleanupErrors?.[0].code, "EPERM");
  assert.equal(JSON.parse(readFileSync(result.receipt, "utf8")).status, "failed");
});
