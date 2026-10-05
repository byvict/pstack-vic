#!/usr/bin/env node
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const AUDIT_INTERVAL_MS = 30 * 60 * 1000;

try {
  const { values } = parseArgs({
    options: {
      program: { type: "string" },
      "interval-ms": { type: "string", default: String(AUDIT_INTERVAL_MS) },
    },
  });
  if (!values.program) throw new Error("--program must name the program's reports directory");
  const program = resolve(values.program);
  if (!statSync(program).isDirectory()) throw new Error("--program must be a directory");
  const intervalMs = Number(values["interval-ms"]);
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0 || intervalMs > 2_147_483_647) {
    throw new Error("--interval-ms must be a positive runtime-safe integer");
  }
  const timer = setInterval(() => {
    process.stdout.write(`${JSON.stringify({ event: "pstack-audit-tick", program, at: new Date().toISOString() })}\n`);
  }, intervalMs);
  const stop = (): void => { clearInterval(timer); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 64;
}
