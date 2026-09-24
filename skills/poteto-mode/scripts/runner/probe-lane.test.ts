import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProbeLane, type ProbeLane } from "./probe-lane.ts";

// Fake provider CLIs in the shapes the runner parses. A model turn echoes the
// PSTACK marker from its prompt; in a write prompt it also creates probe.txt in
// its working directory. FAKE_ENV_DUMP records the environment the CLI saw.
// Pipes are asynchronous on macOS, so every write goes through fs.writeSync.
const fakeCli = `#!/usr/bin/env node
import { readFileSync, writeFileSync, writeSync } from "node:fs";
const out = (text) => writeSync(1, text + "\\n");
const args = process.argv.slice(2);
const name = process.argv[1].split("/").at(-1);
if (name === "claude" && args[0] === "auth") { out(JSON.stringify({ loggedIn: true })); process.exit(0); }
if (name === "codex" && args[0] === "login") { out("Logged in using ChatGPT"); process.exit(0); }
if (name === "grok" && args[0] === "models") { out("You are logged in with grok.com.\\n  * grok-4.7 (default)"); process.exit(0); }
if (process.env.FAKE_ENV_DUMP) writeFileSync(process.env.FAKE_ENV_DUMP, JSON.stringify(process.env));
const modelIndex = args.indexOf("--model");
const model = modelIndex >= 0 ? args[modelIndex + 1] : "unknown";
const promptIndex = args.indexOf("--prompt-file");
const prompt = promptIndex >= 0 ? readFileSync(args[promptIndex + 1], "utf8") : readFileSync(0, "utf8");
const marker = (prompt.match(/PSTACK-[A-Za-z0-9-]+/) ?? ["missing"])[0];
if (/probe\\.txt/.test(prompt) && process.env.FAKE_SKIP_FILE !== "1") {
  writeFileSync("probe.txt", process.env.FAKE_FILE_CONTENT ?? marker + "\\n");
}
const reported = model === "grok-4.7" ? "grok-4.7-build" : model;
if (name === "claude") {
  out(JSON.stringify({ result: marker, session_id: "c1", usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0, modelUsage: { [reported]: {} } }));
} else if (name === "codex") {
  out(JSON.stringify({ type: "thread.started", thread_id: "o1" }));
  out(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: marker } }));
  out(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));
} else {
  out(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: marker, session_id: "g1", usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0, modelUsage: { [reported]: {} } }));
}
`;

// Stands in for \`codex sandbox <flags> -- <command>\`: exports the seatbelt
// marker, records where it ran, and runs the command with the same stdio.
const fakeWrapper = `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const split = args.indexOf("--");
if (process.env.FAKE_WRAP_LOG) writeFileSync(process.env.FAKE_WRAP_LOG, JSON.stringify({ cwd: process.cwd(), flags: args.slice(0, split) }));
process.stderr.write("=== Sandbox denials ===\\n(node) file-write-create /somewhere/else\\n");
const [command, ...rest] = args.slice(split + 1);
const run = spawnSync(command, rest, { stdio: "inherit", env: { ...process.env, CODEX_SANDBOX: "seatbelt" } });
process.exit(run.status ?? 1);
`;

let root = "";
let bin = "";

function write(path: string, text: string): void {
  writeFileSync(path, text);
  chmodSync(path, 0o755);
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "pstack-probe-lane-"));
  bin = join(root, "bin");
  mkdirSync(bin);
  for (const name of ["claude", "codex", "grok"]) write(join(bin, name), fakeCli);
  write(join(bin, "wrap"), fakeWrapper);
  // macOS vets a fresh executable on its first exec; pay that once here.
  for (const name of ["claude", "codex", "grok", "wrap"]) {
    execFileSync(join(bin, name), name === "wrap" ? ["--", "true"] : ["models"], { stdio: "ignore" });
  }
});

after(() => rmSync(root, { recursive: true, force: true }));

let laneCount = 0;

function lane(overrides: Partial<ProbeLane> & Pick<ProbeLane, "provider" | "model">, env: Record<string, string> = {}): ProbeLane {
  laneCount += 1;
  const dir = join(root, `lane-${laneCount}`);
  const cwd = join(dir, "work");
  mkdirSync(cwd, { recursive: true });
  return {
    parent: overrides.provider === "claude" ? "codex" : "claude",
    effort: "xhigh",
    marker: `PSTACK-TEST-${laneCount}-abcd1234`,
    cwd,
    promptPath: join(dir, "prompt.md"),
    outputPath: join(dir, "output.md"),
    receiptPath: join(dir, "receipt.json"),
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, ...env },
    ...overrides,
  };
}

describe("runProbeLane, write mode", () => {
  it("runs the launcher in isolated-write and passes when probe.txt holds the marker", async () => {
    const probe = lane({ provider: "codex", model: "gpt-6-sol", mode: "isolated-write" });
    const verdict = await runProbeLane(probe);
    assert.equal(verdict.passed, true, verdict.detail);
    assert.match(verdict.detail, /probe\.txt/);
    const receipt = JSON.parse(readFileSync(probe.receiptPath, "utf8"));
    assert.equal(receipt.mode, "isolated-write");
    assert.match(readFileSync(probe.promptPath, "utf8"), /`ls`/);
  });

  it("fails when the lane never creates probe.txt", async () => {
    const probe = lane({ provider: "grok", model: "grok-4.7", mode: "isolated-write" }, { FAKE_SKIP_FILE: "1" });
    const verdict = await runProbeLane(probe);
    assert.equal(verdict.passed, false);
    assert.match(verdict.detail, /probe\.txt is missing/);
  });

  it("fails when probe.txt holds something other than the exact marker", async () => {
    const probe = lane({ provider: "grok", model: "grok-4.7", mode: "isolated-write" }, { FAKE_FILE_CONTENT: "PSTACK-TEST-close-but-no" });
    const verdict = await runProbeLane(probe);
    assert.equal(verdict.passed, false);
    assert.match(verdict.detail, /probe\.txt holds "PSTACK-TEST-close-but-no"/);
  });
});

describe("runProbeLane, wrapped", () => {
  it("runs the launcher under the wrapping command from the lane directory", async () => {
    const log = join(root, "wrap-log.json");
    const probe = lane(
      {
        provider: "grok",
        model: "grok-4.7",
        parent: "codex",
        mode: "isolated-write",
        requireArgv: ["--sandbox", "none"],
      },
      { FAKE_WRAP_LOG: log }
    );
    const laneDir = join(probe.cwd, "..");
    const verdict = await runProbeLane({ ...probe, wrap: { command: join(bin, "wrap"), args: ["-c", "x=1", "--"], cwd: laneDir } });
    assert.equal(verdict.passed, true, verdict.detail);
    assert.deepEqual(JSON.parse(readFileSync(log, "utf8")), { cwd: realpathSync(laneDir), flags: ["-c", "x=1"] });
    const receipt = JSON.parse(readFileSync(probe.receiptPath, "utf8"));
    assert.ok(receipt.argv.join(" ").includes("--sandbox none"), receipt.argv.join(" "));
  });

  it("keeps what the lane printed in the transcript file", async () => {
    const probe = lane({ provider: "grok", model: "grok-4.7", parent: "codex" });
    const transcriptPath = join(probe.cwd, "..", "transcript.log");
    const laneDir = join(probe.cwd, "..");
    const verdict = await runProbeLane({ ...probe, transcriptPath, wrap: { command: join(bin, "wrap"), args: ["--"], cwd: laneDir } });
    assert.equal(verdict.passed, true, verdict.detail);
    const transcript = readFileSync(transcriptPath, "utf8");
    assert.match(transcript, /file-write-create \/somewhere\/else/);
    assert.match(transcript, /"status":"complete"/);
  });

  it("fails a lane whose receipt argv lacks the required tokens", async () => {
    const probe = lane({ provider: "grok", model: "grok-4.7", parent: "codex", requireArgv: ["--sandbox", "none"] });
    const verdict = await runProbeLane(probe);
    assert.equal(verdict.passed, false);
    assert.match(verdict.detail, /argv lacks "--sandbox none"/);
  });
});

describe("runProbeLane, simulated parent", () => {
  const identity = {
    CLAUDECODE: "1",
    CLAUDE_CODE_SESSION_ID: "s-1",
    CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
    PSTACK_KEEP_ME: "kept",
  };

  it("removes the Claude Code identity when the lane simulates a Codex parent", async () => {
    const dump = join(root, "env-simulated.json");
    const probe = lane({ provider: "claude", model: "claude-opus-5-5", simulatedParent: true }, { ...identity, FAKE_ENV_DUMP: dump });
    const verdict = await runProbeLane(probe);
    assert.equal(verdict.passed, true, verdict.detail);
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    assert.equal(seen.PSTACK_KEEP_ME, "kept");
    assert.deepEqual(Object.keys(seen).filter((key) => key === "CLAUDECODE" || key.startsWith("CLAUDE_CODE_")), []);
  });

  it("leaves the environment alone for a parent that really runs the lane", async () => {
    const dump = join(root, "env-real.json");
    const probe = lane({ provider: "claude", model: "claude-opus-5-5" }, { ...identity, FAKE_ENV_DUMP: dump });
    await runProbeLane(probe);
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    assert.equal(seen.CLAUDECODE, "1");
    assert.equal(seen.CLAUDE_CODE_SESSION_ID, "s-1");
    assert.ok(existsSync(probe.receiptPath));
  });
});
