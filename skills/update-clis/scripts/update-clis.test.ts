import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { loadMatrix, PLUGIN_ROOT } from "../../../scripts/model-matrix.ts";
import { invocationCommand, preflightCommand } from "../../poteto-mode/scripts/runner/commands.ts";
import { ACCESS_MODES } from "../../poteto-mode/scripts/runner/types.ts";
import {
  codexStableVersions,
  fetchNotes,
  NotesError,
  parseClaudeChangelog,
  parseCodexReleaseBody,
  parseGrokChangelog,
  PROBE_LANES,
  probePairs,
} from "./update-clis.ts";

const FIXTURES = join(import.meta.dirname, "fixtures");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

let root = "";

before(() => {
  root = mkdtempSync(join(tmpdir(), "pstack-update-clis-"));
});

after(() => rmSync(root, { recursive: true, force: true }));

function executable(path: string, text: string): string {
  writeFileSync(path, text);
  chmodSync(path, 0o755);
  // macOS vets a fresh executable on its first exec; pay that once here.
  execFileSync(path, ["--version"], { stdio: "ignore", env: { ...process.env, FAKE_WARMUP: "1" } });
  return path;
}

/** Serve fixture bodies by path on loopback; anything else is a 404 like the CDN's. */
async function serve(routes: Record<string, string>): Promise<{ url: string; server: Server; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((request, response) => {
    hits.push(request.url ?? "");
    const body = routes[request.url ?? ""];
    if (body === undefined) {
      response.writeHead(404, { "content-type": "application/xml" });
      response.end("<Error><Code>NoSuchKey</Code></Error>");
      return;
    }
    response.writeHead(200);
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return { url: `http://127.0.0.1:${address.port}`, server, hits };
}

describe("notes parsers", () => {
  it("reads one version per CHANGELOG section with its bullet entries", () => {
    const versions = parseClaudeChangelog(fixture("claude-CHANGELOG.md"));
    assert.deepEqual(
      versions.map((v) => [v.version, v.entries.length]),
      [
        ["2.1.278", 2],
        ["2.1.277", 87],
        ["2.1.276", 1],
        ["2.1.275", 95],
      ]
    );
    assert.match(versions[2].entries[0].text, /^Fixed every request failing with `400/);
    assert.equal(versions[2].date, null);
  });

  it("reads a codex release body section by section, the per-PR changelog included", () => {
    const entries = parseCodexReleaseBody(JSON.parse(fixture("codex-rust-v0.156.0.json")).body);
    const bySection = new Map<string, number>();
    for (const entry of entries) bySection.set(entry.category ?? "", (bySection.get(entry.category ?? "") ?? 0) + 1);
    assert.deepEqual(Object.fromEntries(bySection), {
      "New Features": 6,
      "Bug Fixes": 6,
      Documentation: 2,
      Chores: 1,
      Changelog: 525,
    });
    assert.ok(entries.every((entry) => entry.breaking === undefined));
    assert.deepEqual(parseCodexReleaseBody("## Breaking Changes\n\n- `--foo` is now `--bar`.\n"), [
      { text: "`--foo` is now `--bar`.", category: "Breaking Changes", breaking: true },
    ]);
  });

  it("keeps only stable rust releases from the codex release list", () => {
    assert.deepEqual(codexStableVersions(fixture("codex-releases.json")), [
      { version: "0.154.0", tag: "rust-v0.154.0", date: "2026-09-09T22:35:38Z" },
      { version: "0.155.0", tag: "rust-v0.155.0", date: "2026-09-17T23:14:43Z" },
      { version: "0.155.1", tag: "rust-v0.155.1", date: "2026-09-18T20:03:04Z" },
      { version: "0.156.0", tag: "rust-v0.156.0", date: "2026-09-22T19:51:01Z" },
      { version: "0.156.1", tag: "rust-v0.156.1", date: "2026-09-23T02:41:36Z" },
    ]);
  });

  it("reads the grok CDN entries with their category and breaking flag", () => {
    const entries = parseGrokChangelog(fixture("grok-1.0.6.external.json"));
    assert.equal(entries.length, 12);
    const breaking = entries.filter((entry) => entry.breaking === true);
    assert.equal(breaking.length, 1);
    assert.match(breaking[0].text, /^\*\*Subagent spawning\*\* no longer accepts capability_mode/);
    assert.equal(parseGrokChangelog(fixture("grok-1.0.39.external.json"))[0].category, "features");
  });
});

describe("fetchNotes", () => {
  it("returns the claude sections of (from, to], oldest first", async () => {
    const cdn = await serve({ "/CHANGELOG.md": fixture("claude-CHANGELOG.md") });
    try {
      const notes = await fetchNotes("claude", "2.1.275", "2.1.277", {
        env: { ...process.env, PSTACK_UPDATE_CLIS_CLAUDE_CHANGELOG_URL: `${cdn.url}/CHANGELOG.md` },
      });
      assert.deepEqual(notes.versions.map((v) => [v.version, v.entries.length]), [
        ["2.1.276", 1],
        ["2.1.277", 87],
      ]);
      assert.deepEqual(notes.missing, []);
    } finally {
      cdn.server.close();
    }
  });

  it("fails cleanly when the claude CHANGELOG has no section for the target yet", async () => {
    const cdn = await serve({ "/CHANGELOG.md": fixture("claude-CHANGELOG.md") });
    try {
      await assert.rejects(
        fetchNotes("claude", "2.1.278", "2.1.279", {
          env: { ...process.env, PSTACK_UPDATE_CLIS_CLAUDE_CHANGELOG_URL: `${cdn.url}/CHANGELOG.md` },
        }),
        (error: unknown) => error instanceof NotesError && /no notes for claude 2\.1\.279/.test(error.message)
      );
    } finally {
      cdn.server.close();
    }
  });

  it("fails cleanly when the source does not answer", async () => {
    const cdn = await serve({});
    cdn.server.close();
    await assert.rejects(
      fetchNotes("claude", "2.1.275", "2.1.277", {
        env: { ...process.env, PSTACK_UPDATE_CLIS_CLAUDE_CHANGELOG_URL: `${cdn.url}/CHANGELOG.md` },
      }),
      (error: unknown) => error instanceof NotesError && /could not fetch/.test(error.message)
    );
  });

  it("ignores a source override that is not loopback", async () => {
    await assert.rejects(
      fetchNotes("grok", "1.0.40", "1.0.41", {
        env: { ...process.env, PSTACK_UPDATE_CLIS_GROK_CHANGELOGS_URL: "http://example.invalid/changelogs" },
        fetch: async (url: string) => {
          throw new Error(`fetched ${url}`);
        },
      }),
      (error: unknown) => error instanceof NotesError && /https:\/\/x\.ai\/cli\/changelogs\/1\.0\.41\.external\.json/.test(error.message)
    );
  });

  it("walks the grok versions of (from, to] one file each and records a missing middle version", async () => {
    const cdn = await serve({
      "/changelogs/1.0.39.external.json": fixture("grok-1.0.39.external.json"),
      "/changelogs/1.0.41.external.json": fixture("grok-1.0.41.external.json"),
    });
    try {
      const notes = await fetchNotes("grok", "1.0.38", "1.0.41", {
        env: { ...process.env, PSTACK_UPDATE_CLIS_GROK_CHANGELOGS_URL: `${cdn.url}/changelogs` },
      });
      assert.deepEqual(notes.versions.map((v) => [v.version, v.entries.length]), [
        ["1.0.39", 13],
        ["1.0.41", 16],
      ]);
      assert.deepEqual(notes.missing, ["1.0.40"]);
      assert.deepEqual(cdn.hits, [
        "/changelogs/1.0.39.external.json",
        "/changelogs/1.0.40.external.json",
        "/changelogs/1.0.41.external.json",
      ]);
    } finally {
      cdn.server.close();
    }
  });

  it("lists an entry the CDN repeats in a later version once, under the oldest version", async () => {
    const cdn = await serve({
      "/changelogs/1.0.40.external.json": fixture("grok-1.0.39.external.json"),
      "/changelogs/1.0.41.external.json": JSON.stringify([
        ...JSON.parse(fixture("grok-1.0.39.external.json")).slice(0, 2),
        { category: "fixes", description: "Only in 1.0.41.", breaking_change: false },
      ]),
    });
    try {
      const notes = await fetchNotes("grok", "1.0.39", "1.0.41", {
        env: { ...process.env, PSTACK_UPDATE_CLIS_GROK_CHANGELOGS_URL: `${cdn.url}/changelogs` },
      });
      assert.deepEqual(notes.versions.map((v) => [v.version, v.entries.length]), [
        ["1.0.40", 13],
        ["1.0.41", 1],
      ]);
      assert.equal(notes.versions[1].entries[0].text, "Only in 1.0.41.");
    } finally {
      cdn.server.close();
    }
  });

  it("keeps the breaking flag of a repeat on the entry it folds into", async () => {
    const entry = { category: "features", description: "Flag --x is gone.", breaking_change: false };
    const cdn = await serve({
      "/changelogs/1.0.40.external.json": JSON.stringify([entry]),
      "/changelogs/1.0.41.external.json": JSON.stringify([{ ...entry, breaking_change: true }]),
    });
    try {
      const notes = await fetchNotes("grok", "1.0.39", "1.0.41", {
        env: { ...process.env, PSTACK_UPDATE_CLIS_GROK_CHANGELOGS_URL: `${cdn.url}/changelogs` },
      });
      assert.deepEqual(notes.versions.map((v) => v.entries), [[{ text: "Flag --x is gone.", category: "features", breaking: true }], []]);
      assert.deepEqual(notes.missing, []);
    } finally {
      cdn.server.close();
    }
  });

  it("fails when the grok target version has no notes", async () => {
    const cdn = await serve({ "/changelogs/1.0.40.external.json": fixture("grok-1.0.40.external.json") });
    try {
      await assert.rejects(
        fetchNotes("grok", "1.0.39", "1.0.41", {
          env: { ...process.env, PSTACK_UPDATE_CLIS_GROK_CHANGELOGS_URL: `${cdn.url}/changelogs` },
        }),
        (error: unknown) => error instanceof NotesError && /no notes for grok 1\.0\.41/.test(error.message)
      );
    } finally {
      cdn.server.close();
    }
  });

  it("reads the codex releases of (from, to] through gh, with their publish dates", async () => {
    const bin = join(root, "gh-bin");
    mkdirSync(bin, { recursive: true });
    const log = join(root, "gh-calls.log");
    executable(
      join(bin, "gh"),
      `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeSync } from "node:fs";
const args = process.argv.slice(2);
if (process.env.FAKE_WARMUP) process.exit(0);
appendFileSync(${JSON.stringify(log)}, args.join(" ") + "\\n");
if (process.env.FAKE_GH_DOWN === "1") { writeSync(2, "error connecting to api.github.com\\n"); process.exit(1); }
const fixtures = ${JSON.stringify(FIXTURES)};
if (args[0] === "release" && args[1] === "list") { writeSync(1, readFileSync(fixtures + "/codex-releases.json", "utf8")); process.exit(0); }
if (args[0] === "release" && args[1] === "view") { writeSync(1, readFileSync(fixtures + "/codex-" + args[2] + ".json", "utf8")); process.exit(0); }
process.exit(2);
`
    );
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` };
    const notes = await fetchNotes("codex", "0.155.1", "0.156.1", { env });
    assert.deepEqual(notes.versions.map((v) => [v.version, v.date, v.entries.length]), [
      ["0.156.0", "2026-09-22T19:51:01Z", 540],
      ["0.156.1", "2026-09-23T02:41:36Z", 2],
    ]);
    const calls = readFileSync(log, "utf8").trim().split("\n");
    assert.ok(calls[0].startsWith("release list -R openai/codex --exclude-pre-releases"), calls[0]);
    assert.deepEqual(calls.slice(1).map((call) => call.split(" ").slice(0, 3).join(" ")), [
      "release view rust-v0.156.0",
      "release view rust-v0.156.1",
    ]);
    await assert.rejects(
      fetchNotes("codex", "0.155.1", "0.156.1", { env: { ...env, FAKE_GH_DOWN: "1" } }),
      (error: unknown) => error instanceof NotesError && /gh release list/.test(error.message)
    );
  });
});

const SCRIPT = join(import.meta.dirname, "update-clis.ts");

function cli(args: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

describe("notes command", () => {
  it("prints the notes as JSON and keeps a copy in the run directory", async () => {
    const cdn = await serve({ "/changelogs/1.0.41.external.json": fixture("grok-1.0.41.external.json") });
    const dir = join(root, "notes-run");
    mkdirSync(dir, { recursive: true });
    try {
      const env = { ...process.env, PSTACK_UPDATE_CLIS_GROK_CHANGELOGS_URL: `${cdn.url}/changelogs` };
      const result = await cli(["notes", "--cli", "grok", "--from", "1.0.40", "--to", "1.0.41", "--dir", dir], env);
      assert.equal(result.code, 0, result.stderr);
      const printed = JSON.parse(result.stdout);
      assert.deepEqual(printed.versions.map((v: { version: string }) => v.version), ["1.0.41"]);
      assert.deepEqual(JSON.parse(readFileSync(join(dir, "notes-grok-1.0.40-1.0.41.json"), "utf8")), printed);
    } finally {
      cdn.server.close();
    }
  });

  it("exits 2 with the reason when the notes cannot be read, and 64 on a bad invocation", async () => {
    const cdn = await serve({});
    cdn.server.close();
    const env = { ...process.env, PSTACK_UPDATE_CLIS_GROK_CHANGELOGS_URL: `${cdn.url}/changelogs` };
    const down = await cli(["notes", "--cli", "grok", "--from", "1.0.40", "--to", "1.0.41"], env);
    assert.equal(down.code, 2);
    assert.match(down.stderr, /could not fetch/);
    const bad = await cli(["notes", "--cli", "cursor", "--from", "1.0.40", "--to", "1.0.41"]);
    assert.equal(bad.code, 64);
    assert.match(bad.stderr, /--cli must be one of: codex, grok, claude/);
  });
});

// --- A fake machine for check and install ---------------------------------------
//
// The layout copies Victor's: claude from nvm 24.21.0, codex through a Homebrew
// link into nvm 24.19.0 (which also holds a stale second claude), grok through
// ~/.grok/bin into ~/.grok/downloads. Each fake CLI carries its version in its
// own source; `npm install -g` and `grok update --version` rewrite that line,
// the way a real install replaces the file. PATH holds only the fakes and the
// system tools, so no real CLI is ever reached.

function fakeCliSource(cli: string, version: string): string {
  // CommonJS on purpose: Node refuses ESM syntax in a file named claude.exe.
  return `#!/usr/bin/env node
const { chmodSync, readFileSync, realpathSync, statSync, writeFileSync, writeSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { dirname } = require("node:path");
const VERSION = "${version}";
const CLI = "${cli}";
const out = (text) => writeSync(1, text + "\\n");
const args = process.argv.slice(2);
if (process.env.FAKE_WARMUP) process.exit(0);
if (args[0] === "--version") {
  out(CLI === "claude" ? VERSION + " (Claude Code)" : CLI === "codex" ? "codex-cli " + VERSION : "grok " + VERSION + " (5115b46bc909) [stable]");
  process.exit(0);
}
if (CLI === "grok" && args[0] === "update" && args.includes("--check")) {
  out(JSON.stringify({ currentVersion: VERSION, latestVersion: process.env.FAKE_GROK_LATEST ?? "1.0.41", updateAvailable: true, installer: "internal", channel: "stable", autoUpdate: false, error: null }));
  process.exit(0);
}
if (CLI === "grok" && args[0] === "update" && args[1] === "--version") {
  const self = realpathSync(process.argv[1]);
  const mode = process.env.FAKE_GROK_UPDATE ?? "ok";
  if (mode === "fail") { writeSync(2, "error: download failed\\n"); process.exit(1); }
  if (mode === "corrupt") { writeFileSync(self, "#!/usr/bin/env node\\nprocess.exit(9)\\n"); writeSync(2, "error: interrupted\\n"); process.exit(1); }
  writeFileSync(self, readFileSync(self, "utf8").replace(/const VERSION = "[^"]*";/, 'const VERSION = "' + args[2] + '";'));
  out("Installed grok " + args[2]);
  process.exit(0);
}
if (CLI === "claude" && args[0] === "auth") { out(JSON.stringify({ loggedIn: true })); process.exit(0); }
if (CLI === "codex" && args[0] === "login") { out("Logged in using ChatGPT"); process.exit(0); }
if (CLI === "grok" && args[0] === "models") { out("You are logged in with grok.com.\\n  * grok-4.7 (default)\\n  * grok-4.6"); process.exit(0); }
if (CLI === "claude" && args[0] === "plugin" && args[1] === "validate") {
  const ok = process.env.FAKE_VALIDATE_FAIL !== "1";
  out(JSON.stringify({ success: ok, manifest: {} }));
  process.exit(ok ? 0 : 1);
}
if (CLI === "codex" && args[0] === "sandbox") {
  // The seatbelt, emulated: the command runs from the workspace, sees
  // CODEX_SANDBOX, and cannot write next to the workspace.
  const split = args.indexOf("--");
  if (process.env.FAKE_SANDBOX_LOG) writeFileSync(process.env.FAKE_SANDBOX_LOG, JSON.stringify({ cwd: process.cwd(), flags: args.slice(1, split) }));
  const parent = dirname(process.cwd());
  const enforce = process.env.FAKE_SANDBOX_OPEN !== "1";
  const before = statSync(parent).mode & 0o777;
  if (enforce) chmodSync(parent, 0o555);
  const env = { ...process.env };
  if (process.env.FAKE_SANDBOX_NO_MARKER !== "1") env.CODEX_SANDBOX = "seatbelt";
  const run = spawnSync(args[split + 1], args.slice(split + 2), { stdio: "inherit", env });
  if (enforce) chmodSync(parent, before);
  if (args.includes("--log-denials")) writeSync(2, "\\n=== Sandbox denials ===\\n(zsh) file-write-data /dev/dtracehelper\\n(claude) file-write-create /fake/home/.claude.json\\n(bash) file-write-data /dev/tty\\n");
  process.exit(run.status ?? 1);
}
if (process.env.FAKE_ENV_DUMP) writeFileSync(process.env.FAKE_ENV_DUMP, JSON.stringify(process.env));
const modelIndex = args.indexOf("--model");
const model = modelIndex >= 0 ? args[modelIndex + 1] : "unknown";
const promptIndex = args.indexOf("--prompt-file");
const prompt = promptIndex >= 0 ? readFileSync(args[promptIndex + 1], "utf8") : readFileSync(0, "utf8");
const marker = (prompt.match(/PSTACK-[A-Za-z0-9-]+/) ?? ["missing"])[0];
if (/probe\\.txt/.test(prompt) && process.env.FAKE_SKIP_FILE !== "1") writeFileSync("probe.txt", marker + "\\n");
const reported = model.startsWith("grok-") ? model + "-build" : model;
if (CLI === "claude") {
  out(JSON.stringify({ result: marker, session_id: "c1", usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0, modelUsage: { [reported]: {} } }));
} else if (CLI === "codex") {
  out(JSON.stringify({ type: "thread.started", thread_id: "o1" }));
  out(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: marker } }));
  out(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));
} else {
  out(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: marker, session_id: "g1", usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0, modelUsage: { [reported]: {} } }));
}
`;
}

const fakeNpm = `#!/usr/bin/env node
import { appendFileSync, readFileSync, realpathSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
const args = process.argv.slice(2);
if (process.env.FAKE_WARMUP) process.exit(0);
const prefix = resolve(dirname(realpathSync(process.argv[1])), "..");
if (process.env.FAKE_NPM_LOG) appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify({ prefix, args, firstPath: (process.env.PATH ?? "").split(":")[0] }) + "\\n");
if (process.env.FAKE_NPM_DOWN === "1") { writeSync(2, "npm error code ENOTFOUND\\n"); process.exit(1); }
if (args[0] === "view" && args[2] === "dist-tags") {
  const tags = JSON.parse(process.env.FAKE_DIST_TAGS ?? "{}")[args[1]];
  if (!tags) { writeSync(2, "npm error 404\\n"); process.exit(1); }
  writeSync(1, JSON.stringify(tags));
  process.exit(0);
}
if (args[0] === "install" && args[1] === "-g") {
  const at = args[2].lastIndexOf("@");
  const [pkg, version] = [args[2].slice(0, at), args[2].slice(at + 1)];
  if (process.env.FAKE_NPM_INSTALL === "noop") process.exit(0);
  if (process.env.FAKE_NPM_INSTALL === "fail") { writeSync(2, "npm error code E500\\n"); process.exit(1); }
  const file = join(prefix, "lib", "node_modules", pkg, pkg === "@openai/codex" ? "bin/codex.js" : "bin/claude.exe");
  writeFileSync(file, readFileSync(file, "utf8").replace(/const VERSION = "[^"]*";/, 'const VERSION = "' + version + '";'));
  writeSync(1, "added 1 package\\n");
  process.exit(0);
}
process.exit(2);
`;

const DIST_TAGS = JSON.stringify({
  "@anthropic-ai/claude-code": { latest: "2.1.282", stable: "2.1.273", next: "2.1.283" },
  "@openai/codex": { latest: "0.156.1", beta: "0.1.2505172116" },
});

interface FakeMachine {
  readonly home: string;
  readonly applications: string;
  readonly env: NodeJS.ProcessEnv;
  readonly node21: string;
  readonly node19: string;
  readonly brew: string;
}

let machineCount = 0;

function fakeMachine(): FakeMachine {
  machineCount += 1;
  const base = join(root, `machine-${machineCount}`);
  const home = join(base, "home");
  const node21 = join(home, ".nvm", "versions", "node", "v24.21.0");
  const node19 = join(home, ".nvm", "versions", "node", "v24.19.0");
  const brew = join(base, "homebrew", "bin");
  const tools = join(base, "tools");
  const applications = join(base, "Applications");
  for (const dir of [join(node21, "bin"), join(node19, "bin"), brew, tools, join(home, ".grok", "bin"), join(home, ".grok", "downloads")]) {
    mkdirSync(dir, { recursive: true });
  }
  symlinkSync(process.execPath, join(tools, "node"));
  const npmPackage = (prefix: string, pkg: string, file: string, cli: string, version: string): string => {
    const target = join(prefix, "lib", "node_modules", pkg, file);
    mkdirSync(dirname(target), { recursive: true });
    executable(target, fakeCliSource(cli, version));
    return target;
  };
  symlinkSync(npmPackage(node21, "@anthropic-ai/claude-code", "bin/claude.exe", "claude", "2.1.281"), join(node21, "bin", "claude"));
  symlinkSync(npmPackage(node19, "@anthropic-ai/claude-code", "bin/claude.exe", "claude", "2.1.280"), join(node19, "bin", "claude"));
  symlinkSync(npmPackage(node19, "@openai/codex", "bin/codex.js", "codex", "0.155.1"), join(node19, "bin", "codex"));
  symlinkSync(join(node19, "bin", "codex"), join(brew, "codex"));
  for (const prefix of [node21, node19]) executable(join(prefix, "bin", "npm"), fakeNpm);
  executable(join(home, ".grok", "downloads", "grok-macos-aarch64"), fakeCliSource("grok", "1.0.5"));
  symlinkSync("../downloads/grok-macos-aarch64", join(home, ".grok", "bin", "grok"));
  const PATH = [join(node21, "bin"), brew, join(home, ".grok", "bin"), join(node19, "bin"), tools, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
  const env: NodeJS.ProcessEnv = { HOME: home, PATH, FAKE_DIST_TAGS: DIST_TAGS };
  return { home, applications, env, node21, node19, brew };
}

async function json(args: readonly string[], env: NodeJS.ProcessEnv): Promise<{ code: number; value: any; stderr: string }> {
  const result = await cli(args, env);
  let value: unknown = null;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    value = result.stdout;
  }
  return { code: result.code, value, stderr: result.stderr };
}

describe("check", () => {
  it("reports the copy the parents resolve, its version, the latest of its channel, and duplicates", async () => {
    const machine = fakeMachine();
    const { code, value, stderr } = await json(["check", "--home", machine.home, "--applications", machine.applications], machine.env);
    assert.equal(code, 0, stderr);
    const byCli = Object.fromEntries(value.clis.map((entry: { cli: string }) => [entry.cli, entry]));
    assert.deepEqual(value.clis.map((entry: { cli: string }) => entry.cli), ["codex", "grok", "claude"]);

    assert.equal(byCli.claude.resolved.path, join(machine.node21, "bin", "claude"));
    assert.equal(byCli.claude.resolved.version, "2.1.281");
    assert.deepEqual(byCli.claude.resolved.installer, { kind: "npm", package: "@anthropic-ai/claude-code", prefix: realpathSync(machine.node21) });
    assert.equal(byCli.claude.channel, "latest");
    assert.equal(byCli.claude.latest, "2.1.282");
    assert.equal(byCli.claude.status, "update-available");
    assert.deepEqual(byCli.claude.duplicates.map((copy: { path: string; version: string }) => [copy.path, copy.version]), [
      [join(machine.node19, "bin", "claude"), "2.1.280"],
    ]);

    assert.equal(byCli.codex.resolved.path, join(machine.brew, "codex"));
    assert.deepEqual(byCli.codex.resolved.installer, { kind: "npm", package: "@openai/codex", prefix: realpathSync(machine.node19) });
    assert.equal(byCli.codex.resolved.version, "0.155.1");
    assert.equal(byCli.codex.latest, "0.156.1");
    assert.deepEqual(byCli.codex.duplicates, []);

    assert.equal(byCli.grok.resolved.path, join(machine.home, ".grok", "bin", "grok"));
    assert.deepEqual(byCli.grok.resolved.installer, { kind: "grok", binary: realpathSync(join(machine.home, ".grok", "downloads", "grok-macos-aarch64")) });
    assert.equal(byCli.grok.resolved.version, "1.0.5");
    assert.equal(byCli.grok.channel, "stable");
    assert.equal(byCli.grok.latest, "1.0.41");
    for (const entry of value.clis) assert.deepEqual(entry.inUse, [], entry.cli);
  });

  it("reads the claude channel from ~/.claude/settings.json and reports a CLI already on it as current", async () => {
    const machine = fakeMachine();
    mkdirSync(join(machine.home, ".claude"), { recursive: true });
    writeFileSync(join(machine.home, ".claude", "settings.json"), JSON.stringify({ autoUpdatesChannel: "stable" }));
    const { value } = await json(["check", "--cli", "claude", "--home", machine.home], machine.env);
    assert.deepEqual(value.clis.map((entry: { cli: string }) => entry.cli), ["claude"]);
    assert.equal(value.clis[0].channel, "stable");
    assert.equal(value.clis[0].latest, "2.1.273");
    assert.equal(value.clis[0].status, "current");
  });

  it("marks a CLI whose latest version cannot be read as unverified and still checks the others", async () => {
    const machine = fakeMachine();
    const { code, value } = await json(["check", "--home", machine.home], { ...machine.env, FAKE_NPM_DOWN: "1" });
    assert.equal(code, 0);
    const byCli = Object.fromEntries(value.clis.map((entry: { cli: string }) => [entry.cli, entry]));
    assert.equal(byCli.claude.status, "unverified");
    assert.equal(byCli.claude.latest, null);
    assert.match(byCli.claude.error, /npm view @anthropic-ai\/claude-code dist-tags/);
    assert.equal(byCli.codex.status, "unverified");
    assert.equal(byCli.grok.status, "update-available");
  });

  it("reports the versions the desktop apps carry", async () => {
    const machine = fakeMachine();
    for (const version of ["2.1.275", "2.1.280"]) {
      mkdirSync(join(machine.home, "Library", "Application Support", "Claude", "claude-code", version, "claude.app"), { recursive: true });
    }
    const resources = join(machine.applications, "ChatGPT.app", "Contents", "Resources");
    mkdirSync(resources, { recursive: true });
    executable(join(resources, "codex"), `#!/usr/bin/env node\nif (process.env.FAKE_WARMUP) process.exit(0);\nconsole.log("codex-cli 0.155.0-alpha.16.3");\n`);
    const { value } = await json(["check", "--home", machine.home, "--applications", machine.applications], machine.env);
    const byCli = Object.fromEntries(value.clis.map((entry: { cli: string }) => [entry.cli, entry]));
    assert.deepEqual(byCli.claude.apps.map((app: { app: string; version: string }) => [app.app, app.version]), [
      ["Claude", "2.1.275"],
      ["Claude", "2.1.280"],
    ]);
    assert.deepEqual(byCli.codex.apps.map((app: { app: string; version: string }) => [app.app, app.version]), [["ChatGPT", "0.155.0-alpha.16.3"]]);
    assert.deepEqual(byCli.grok.apps, []);
  });

  it("reports a running process of the resolved install as in use, and nothing once it exits", async (t) => {
    if (spawnSync("lsof", ["-v"], { stdio: "ignore" }).error) return t.skip("lsof not on PATH");
    const machine = fakeMachine();
    const helper = join(machine.node19, "lib", "node_modules", "@openai", "codex", "vendor", "codex-helper");
    mkdirSync(dirname(helper), { recursive: true });
    copyFileSync(process.execPath, helper, fsConstants.COPYFILE_FICLONE);
    chmodSync(helper, 0o755);
    const running = spawn(helper, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const busy = await json(["check", "--cli", "codex", "--home", machine.home], machine.env);
      assert.deepEqual(busy.value.clis[0].inUse.map((process: { pid: number }) => process.pid), [running.pid]);
    } finally {
      running.kill();
      await new Promise((resolve) => running.once("exit", resolve));
    }
    const idle = await json(["check", "--cli", "codex", "--home", machine.home], machine.env);
    assert.deepEqual(idle.value.clis[0].inUse, []);
  });
});

describe("run lock", () => {
  it("lets one execution run at a time and says so to the second", async () => {
    const machine = fakeMachine();
    const first = await json(["start", "--home", machine.home], machine.env);
    assert.equal(first.code, 0, first.stderr);
    const cache = join(machine.home, "Library", "Caches", "pstack-vic", "update-clis");
    assert.equal(dirname(first.value.dir), cache);
    assert.ok(existsSync(first.value.dir));
    const second = await json(["start", "--home", machine.home], machine.env);
    assert.equal(second.code, 3);
    assert.match(second.stderr, /already running \(já em execução\)/);
    const finished = await json(["finish", "--dir", first.value.dir, "--home", machine.home], machine.env);
    assert.equal(finished.code, 0, finished.stderr);
    assert.equal(finished.value.lockReleased, true);
    const third = await json(["start", "--home", machine.home], machine.env);
    assert.equal(third.code, 0, third.stderr);
  });

  it("refuses to install from a directory that does not hold the lock", async () => {
    const machine = fakeMachine();
    const held = await json(["start", "--home", machine.home], machine.env);
    const stray = join(dirname(held.value.dir), "not-the-run");
    mkdirSync(stray);
    const result = await json(["install", "--cli", "codex", "--version", "0.156.1", "--dir", stray, "--home", machine.home], machine.env);
    assert.equal(result.code, 3);
    assert.match(result.stderr, /does not hold the update-clis lock/);
  });

  it("takes over a lock left behind by an execution that died more than 12 hours ago", async () => {
    const machine = fakeMachine();
    const cache = join(machine.home, "Library", "Caches", "pstack-vic", "update-clis");
    mkdirSync(cache, { recursive: true });
    const startedAt = new Date(Date.now() - 13 * 3600_000).toISOString();
    writeFileSync(join(cache, "lock"), JSON.stringify({ dir: join(cache, "old"), startedAt }));
    const result = await json(["start", "--home", machine.home], machine.env);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.value.staleLock, { dir: join(cache, "old"), startedAt });
  });

  it("keeps the ten most recent runs when an execution finishes", async () => {
    const machine = fakeMachine();
    const cache = join(machine.home, "Library", "Caches", "pstack-vic", "update-clis");
    const old = Array.from({ length: 11 }, (_, index) => `2026-09-${String(index + 1).padStart(2, "0")}T07-00-00Z`);
    for (const name of old) mkdirSync(join(cache, name), { recursive: true });
    const run = await json(["start", "--home", machine.home], machine.env);
    const finished = await json(["finish", "--dir", run.value.dir, "--home", machine.home], machine.env);
    assert.deepEqual(finished.value.pruned.map((path: string) => basename(path)), old.slice(0, 2));
    assert.equal(readdirSync(cache).filter((name) => name !== "lock").length, 10);
    assert.ok(existsSync(run.value.dir));
  });
});

describe("install", () => {
  async function started(machine: FakeMachine): Promise<string> {
    const run = await json(["start", "--home", machine.home], machine.env);
    assert.equal(run.code, 0, run.stderr);
    return run.value.dir;
  }

  it("installs an exact npm version with the npm of the resolved copy's Node and checks it, both ways", async () => {
    const machine = fakeMachine();
    const dir = await started(machine);
    const log = join(root, `npm-${machineCount}.log`);
    const env = { ...machine.env, FAKE_NPM_LOG: log };
    const up = await json(["install", "--cli", "codex", "--version", "0.156.1", "--dir", dir, "--home", machine.home], env);
    assert.equal(up.code, 0, up.stderr);
    assert.deepEqual([up.value.from, up.value.to, up.value.version, up.value.ok, up.value.method], ["0.155.1", "0.156.1", "0.156.1", true, "npm"]);
    const back = await json(["install", "--cli", "codex", "--version", "0.155.1", "--dir", dir, "--home", machine.home], env);
    assert.deepEqual([back.code, back.value.version, back.value.ok], [0, "0.155.1", true]);
    const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const node19 = realpathSync(machine.node19);
    assert.deepEqual(calls.map((call) => [call.prefix, call.args.join(" "), call.firstPath]), [
      [node19, "install -g @openai/codex@0.156.1", join(node19, "bin")],
      [node19, "install -g @openai/codex@0.155.1", join(node19, "bin")],
    ]);
  });

  it("fails when the installed version does not match the requested one", async () => {
    const machine = fakeMachine();
    const dir = await started(machine);
    const result = await json(["install", "--cli", "claude", "--version", "2.1.282", "--dir", dir, "--home", machine.home], { ...machine.env, FAKE_NPM_INSTALL: "noop" });
    assert.equal(result.code, 1);
    assert.equal(result.value.ok, false);
    assert.equal(result.value.version, "2.1.281");
    assert.match(result.value.detail, /claude --version reports 2\.1\.281, expected 2\.1\.282/);
  });

  it("keeps a copy of the grok binary before replacing it and updates through grok update", async () => {
    const machine = fakeMachine();
    const dir = await started(machine);
    const binary = join(machine.home, ".grok", "downloads", "grok-macos-aarch64");
    const before = readFileSync(binary, "utf8");
    const result = await json(["install", "--cli", "grok", "--version", "1.0.41", "--dir", dir, "--home", machine.home], machine.env);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual([result.value.method, result.value.version], ["grok update", "1.0.41"]);
    assert.equal(readFileSync(join(dir, "grok-backup-1.0.5"), "utf8"), before);
  });

  it("goes back to the grok copy when grok update breaks the binary on the way back", async () => {
    const machine = fakeMachine();
    const dir = await started(machine);
    const args = (version: string) => ["install", "--cli", "grok", "--version", version, "--dir", dir, "--home", machine.home];
    assert.equal((await json(args("1.0.41"), machine.env)).code, 0);
    const back = await json(args("1.0.5"), { ...machine.env, FAKE_GROK_UPDATE: "corrupt" });
    assert.equal(back.code, 0, back.stderr);
    assert.deepEqual([back.value.method, back.value.version, back.value.ok], ["restored-copy", "1.0.5", true]);
    assert.match(back.value.detail, /grok update --version 1\.0\.5 failed/);
    const check = await json(["check", "--cli", "grok", "--home", machine.home], machine.env);
    assert.equal(check.value.clis[0].resolved.version, "1.0.5");
  });

  it("fails without a copy to go back to when grok update fails", async () => {
    const machine = fakeMachine();
    const dir = await started(machine);
    const result = await json(["install", "--cli", "grok", "--version", "1.0.41", "--dir", dir, "--home", machine.home], { ...machine.env, FAKE_GROK_UPDATE: "fail" });
    assert.equal(result.code, 1);
    assert.deepEqual([result.value.ok, result.value.version], [false, "1.0.5"]);
    assert.match(result.value.detail, /no copy of grok 1\.0\.41/);
  });

  it("finish --keep-copies leaves the grok copies for a manual restore and still releases the lock", async () => {
    const machine = fakeMachine();
    const dir = await started(machine);
    await json(["install", "--cli", "grok", "--version", "1.0.41", "--dir", dir, "--home", machine.home], machine.env);
    const finished = await json(["finish", "--dir", dir, "--keep-copies", "--home", machine.home], machine.env);
    assert.deepEqual([finished.value.removedCopies, finished.value.lockReleased], [[], true]);
    assert.ok(existsSync(join(dir, "grok-backup-1.0.5")));
  });

  it("finish deletes the grok copies of the run and keeps everything else", async () => {
    const machine = fakeMachine();
    const dir = await started(machine);
    await json(["install", "--cli", "grok", "--version", "1.0.41", "--dir", dir, "--home", machine.home], machine.env);
    writeFileSync(join(dir, "notes-grok-1.0.5-1.0.41.json"), "{}");
    const finished = await json(["finish", "--dir", dir, "--home", machine.home], machine.env);
    assert.deepEqual(finished.value.removedCopies.map((path: string) => basename(path)), ["grok-backup-1.0.5", "grok-backup-1.0.5.json"]);
    assert.deepEqual(readdirSync(dir).sort(), ["install-grok-1.0.41.log", "notes-grok-1.0.5-1.0.41.json"]);
  });
});

// --- npm commands in skills and docs ---------------------------------------------
//
// npm's bin/npm starts with `#!/usr/bin/env node`: it runs on the first node in
// PATH and takes the global prefix from that node, not from the directory it
// lives in. `<prefix>/bin/npm install -g` installs into whichever Node leads
// PATH (2026-09-24: the npm of v24.19.0 uninstalled claude from v24.21.0). The
// script puts `<prefix>/bin` first on PATH, as the install test above checks;
// a command that a skill or doc hands to a person has to do the same.

function markdownUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : markdownUnder(path);
    return entry.name.endsWith(".md") ? [path] : [];
  });
}

describe("npm commands in skills and docs", () => {
  const files = [...markdownUnder(join(PLUGIN_ROOT, "skills")), ...markdownUnder(join(PLUGIN_ROOT, "docs")), join(PLUGIN_ROOT, "README.md")];
  const rel = (path: string) => relative(PLUGIN_ROOT, path);

  it("scan this skill's SKILL.md", () => {
    assert.ok(files.map(rel).includes("skills/update-clis/SKILL.md"));
  });

  it("never run an npm by its path, which picks the prefix of the first node in PATH", () => {
    const byPath = /\/bin\/np[mx][ \t]+\S/;
    const offenders = files.flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .flatMap((line, index) => (byPath.test(line) ? [`${rel(path)}:${index + 1}: ${line.trim()}`] : [])),
    );
    assert.deepEqual(offenders, []);
  });
});

// --- cli-touchpoints.json ---------------------------------------------------------
//
// The list the skill reads the notes against. A pointer that no longer finds
// its anchor, a lane the probe does not run, or a runner flag no contract names
// fails here, so the list cannot drift from the code it describes.

interface Touchpoint {
  readonly id: string;
  readonly cli: string;
  readonly kind: string;
  readonly contract: string;
  readonly pointers: ReadonlyArray<{ readonly file: string; readonly anchor: string }>;
  readonly coveredBy: readonly string[];
  readonly measuredOn: string;
}

describe("cli-touchpoints.json", () => {
  const matrix = loadMatrix();
  const raw = JSON.parse(readFileSync(join(import.meta.dirname, "..", "references", "cli-touchpoints.json"), "utf8"));
  const touchpoints: readonly Touchpoint[] = raw.touchpoints;
  const cliNames = Object.values(matrix.providers).flatMap((provider) => (provider.cli === null ? [] : [provider.cli]));

  it("gives each touchpoint a unique id under its CLI, a runner CLI, a kind, a contract, and the version it was measured on", () => {
    assert.equal(raw.schemaVersion, 1);
    assert.ok(touchpoints.length > 0);
    const ids = touchpoints.map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length, "duplicate ids");
    for (const t of touchpoints) {
      assert.deepEqual(Object.keys(t).sort(), ["cli", "contract", "coveredBy", "id", "kind", "measuredOn", "pointers"], t.id);
      assert.ok(cliNames.includes(t.cli), `${t.id}: ${t.cli} is not a cli-transport CLI in model-matrix.json`);
      assert.ok(t.id.startsWith(`${t.cli}.`), `${t.id} is not under ${t.cli}.`);
      assert.ok(t.kind === "lane" || t.kind === "harness", `${t.id}: kind ${t.kind}`);
      assert.ok(t.contract.trim().length > 0, `${t.id}: empty contract`);
      assert.match(t.measuredOn, /^\d+\.\d+\.\d+$/, t.id);
      assert.ok(t.pointers.length > 0, `${t.id}: no pointers`);
    }
    assert.deepEqual([...new Set(touchpoints.map((t) => t.cli))].sort(), [...cliNames].sort());
  });

  it("points at files that exist and anchors found in them", () => {
    const missing: string[] = [];
    for (const t of touchpoints) {
      for (const pointer of t.pointers) {
        const path = join(PLUGIN_ROOT, pointer.file);
        if (!existsSync(path)) missing.push(`${t.id}: ${pointer.file} does not exist`);
        else if (!readFileSync(path, "utf8").includes(pointer.anchor)) missing.push(`${t.id}: ${pointer.file} lacks ${JSON.stringify(pointer.anchor)}`);
      }
    }
    assert.deepEqual(missing, []);
  });

  it("covers a lane touchpoint only with lanes its CLI's probe runs and leaves every harness touchpoint uncovered", () => {
    for (const t of touchpoints) {
      const lanes: readonly string[] = PROBE_LANES[t.cli as keyof typeof PROBE_LANES];
      assert.equal(new Set(t.coveredBy).size, t.coveredBy.length, `${t.id}: repeated lane`);
      for (const lane of t.coveredBy) assert.ok(lanes.includes(lane), `${t.id}: ${t.cli} probe has no ${lane} lane (${lanes.join(", ")})`);
      if (t.kind === "harness") assert.deepEqual(t.coveredBy, [], `${t.id}: a harness touchpoint is never probed`);
    }
    for (const [cli, lanes] of Object.entries(PROBE_LANES)) {
      for (const lane of lanes) {
        assert.ok(touchpoints.some((t) => t.cli === cli && t.coveredBy.includes(lane)), `${cli} ${lane} lane covers no touchpoint`);
      }
    }
  });

  it("names in some contract of the same CLI every flag the runner generates, in every access mode", () => {
    const unnamed: string[] = [];
    const named = (cli: string, flag: string): boolean => {
      const token = new RegExp(`(^|[^A-Za-z0-9-])${flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9-]|$)`);
      return touchpoints.some((t) => t.cli === cli && token.test(t.contract));
    };
    for (const [provider, spec] of Object.entries(matrix.providers)) {
      if (spec.cli === null) continue;
      const cli = spec.cli;
      const family = matrix.families.find((f) => f.provider === provider);
      assert.ok(family, provider);
      const parent = matrix.parents.claude && matrix.routes.claude[provider] === "runner" ? "claude" : "codex";
      const envs: NodeJS.ProcessEnv[] = cli === "grok" ? [{}, { CODEX_SANDBOX: "seatbelt" }] : [{}];
      const argvs: string[][] = [[...preflightCommand(provider).args]];
      for (const mode of ACCESS_MODES) {
        for (const env of envs) {
          const options = {
            parent, provider, model: family.model, effort: family.defaultEffort, mode,
            promptPath: "/p/prompt.md", cwd: "/p", outputPath: "/p/out.md", receiptPath: "/p/receipt.json", timeoutMs: null, target: null,
          } as const;
          argvs.push([...invocationCommand(options, env).args]);
        }
      }
      for (const flag of new Set(argvs.flat().filter((arg) => /^--?[A-Za-z]/.test(arg)))) {
        if (!named(cli, flag)) unnamed.push(`${cli} ${flag}`);
      }
    }
    assert.deepEqual(unnamed, []);
  });
});

// --- probe ---------------------------------------------------------------------

const CLAUDE_SHEET = `# pstack model configuration

feature, refactoring: grok:grok-4.7@xhigh
bug-fix: claude:claude-opus-5-5@xhigh
arena runners: codex:gpt-6-sol@xhigh, grok:grok-4.7@xhigh, claude:claude-opus-5-5@xhigh
why investigators: inherit-parent
pr owner: cursor:grok-4.7@xhigh
`;

const CODEX_SHEET = `# pstack model configuration

feature, refactoring: grok:grok-4.7@xhigh
bug-fix: codex:gpt-6-sol@xhigh
swarm workers: grok:grok-4.6@high
arena runners: codex:gpt-6-sol@xhigh, grok:grok-4.7@xhigh, claude:claude-opus-5-5@xhigh
pr verifier: cursor:grok-4.7@xhigh
`;

function withSheets(machine: FakeMachine, sheets: { claude?: string; codex?: string }): void {
  for (const [parent, text] of Object.entries(sheets)) {
    mkdirSync(join(machine.home, `.${parent}`), { recursive: true });
    writeFileSync(join(machine.home, `.${parent}`, "pstack-models.md"), text);
  }
}

function fakePluginRoot(): string {
  const plugin = join(root, `plugin-${machineCount}`);
  mkdirSync(join(plugin, "scripts"), { recursive: true });
  writeFileSync(
    join(plugin, "scripts", "manifests.test.ts"),
    `import { it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
it("share one plugin name and one version", () => {});
it("pass \`claude plugin validate --strict\` for the marketplace and the plugin", (t) => {
  if (process.env.FAKE_MANIFEST_SKIP === "1") return t.skip("claude CLI not on PATH");
  const run = spawnSync("claude", ["plugin", "validate", "--strict", "--json", "."], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stdout);
});
`
  );
  return plugin;
}

async function probeRun(machine: FakeMachine, cli: string, env: NodeJS.ProcessEnv = {}): Promise<{ code: number; value: any; stderr: string; dir: string }> {
  const run = await json(["start", "--home", machine.home], machine.env);
  assert.equal(run.code, 0, run.stderr);
  const result = await json(
    ["probe", "--cli", cli, "--dir", run.value.dir, "--home", machine.home, "--timeout", "60", "--plugin-root", fakePluginRoot()],
    { ...machine.env, ...env }
  );
  return { ...result, dir: run.value.dir };
}

const laneRows = (summary: any): string[][] =>
  summary.lanes.map((lane: { lane: string; pair: string | null; status: string }) => [lane.lane, lane.pair ?? "-", lane.status]);

describe("probe pairs", () => {
  it("takes codex from the Claude sheet, claude from the Codex sheet, grok from both, each pair once", () => {
    const machine = fakeMachine();
    withSheets(machine, { claude: CLAUDE_SHEET, codex: CODEX_SHEET });
    assert.deepEqual(probePairs("codex", machine.home).map((p) => p.pair), ["sol@xhigh"]);
    assert.deepEqual(probePairs("claude", machine.home).map((p) => p.pair), ["opus@xhigh"]);
    assert.deepEqual(probePairs("grok", machine.home).map((p) => p.pair), ["grok@high", "grok-4-7@xhigh"]);
  });

  it("falls back to the matrix defaults of a parent whose sheet does not exist", () => {
    const machine = fakeMachine();
    withSheets(machine, { claude: CLAUDE_SHEET });
    assert.deepEqual(probePairs("claude", machine.home).map((p) => p.pair), ["fable@max", "opus@xhigh"]);
  });
});

describe("probe", () => {
  it("runs read, write and seatbelt for each grok pair; the seatbelt lane goes through codex sandbox with --sandbox none", async () => {
    const machine = fakeMachine();
    withSheets(machine, { claude: CLAUDE_SHEET, codex: CLAUDE_SHEET });
    const log = join(root, `sandbox-${machineCount}.json`);
    const { code, value, stderr, dir } = await probeRun(machine, "grok", { FAKE_SANDBOX_LOG: log });
    assert.equal(code, 0, `${stderr}\n${JSON.stringify(value, null, 2)}`);
    assert.equal(value.version, "1.0.5");
    assert.equal(value.dir, join(dir, "probe-grok-1.0.5"));
    assert.deepEqual(laneRows(value), [
      ["read", "grok-4-7@xhigh", "passed"],
      ["write", "grok-4-7@xhigh", "passed"],
      ["seatbelt", "grok-4-7@xhigh", "passed"],
    ]);
    const seatbelt = value.lanes[2];
    assert.match(seatbelt.detail, /argv has --sandbox none/);
    assert.deepEqual(seatbelt.denials, ["(claude) file-write-create /fake/home/.claude.json"]);
    const wrapped = JSON.parse(readFileSync(log, "utf8"));
    assert.equal(wrapped.cwd, realpathSync(seatbelt.dir));
    assert.deepEqual(wrapped.flags, [
      "--log-denials",
      "-c", 'sandbox_mode="workspace-write"',
      "-c", "sandbox_workspace_write.network_access=true",
      "-c", `sandbox_workspace_write.writable_roots=[${JSON.stringify(join(machine.home, ".grok"))}]`,
    ]);
    const receipts = value.lanes.map((lane: { dir: string }) => JSON.parse(readFileSync(join(lane.dir, "receipt.json"), "utf8")));
    assert.deepEqual(receipts.map((r: { parent: string; mode: string }) => [r.parent, r.mode]), [
      ["claude", "read-only"],
      ["claude", "isolated-write"],
      ["codex", "isolated-write"],
    ]);
    assert.deepEqual(JSON.parse(readFileSync(join(value.dir, "summary.json"), "utf8")), value);
  });

  it("runs the codex pairs from a simulated Claude parent and the sandbox lane without a model", async () => {
    const machine = fakeMachine();
    withSheets(machine, { claude: CLAUDE_SHEET, codex: CODEX_SHEET });
    const { code, value } = await probeRun(machine, "codex");
    assert.equal(code, 0, JSON.stringify(value, null, 2));
    assert.deepEqual(laneRows(value), [
      ["read", "sol@xhigh", "passed"],
      ["write", "sol@xhigh", "passed"],
      ["sandbox", "-", "passed"],
    ]);
    assert.match(value.lanes[2].detail, /CODEX_SANDBOX=seatbelt, lane write accepted, ~\/\.grok write accepted, write outside the workspace denied/);
  });

  it("fails the sandbox lane when a write outside the workspace goes through or CODEX_SANDBOX is missing", async () => {
    const machine = fakeMachine();
    withSheets(machine, { claude: CLAUDE_SHEET, codex: CODEX_SHEET });
    const open = await probeRun(machine, "codex", { FAKE_SANDBOX_OPEN: "1" });
    assert.equal(open.code, 1);
    assert.equal(open.value.ok, false);
    assert.match(open.value.lanes[2].detail, /write outside the workspace went through/);
    await json(["finish", "--dir", open.dir, "--home", machine.home], machine.env);
    const unmarked = await probeRun(machine, "codex", { FAKE_SANDBOX_NO_MARKER: "1" });
    assert.match(unmarked.value.lanes[2].detail, /CODEX_SANDBOX was not exported/);
  });

  it("runs the claude pairs as a Codex parent would, without the Claude Code identity, then the manifest lane", async () => {
    const machine = fakeMachine();
    withSheets(machine, { claude: CLAUDE_SHEET, codex: CODEX_SHEET });
    const dump = join(root, `claude-env-${machineCount}.json`);
    const { code, value } = await probeRun(machine, "claude", { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "s", FAKE_ENV_DUMP: dump });
    assert.equal(code, 0, JSON.stringify(value, null, 2));
    assert.deepEqual(laneRows(value), [
      ["read", "opus@xhigh", "passed"],
      ["write", "opus@xhigh", "passed"],
      ["seatbelt", "opus@xhigh", "passed"],
      ["manifest", "-", "passed"],
    ]);
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    assert.equal(seen.CLAUDECODE, undefined);
    assert.equal(seen.CLAUDE_CODE_SESSION_ID, undefined);
  });

  it("fails the manifest lane when the validate test was skipped or failed", async () => {
    const machine = fakeMachine();
    withSheets(machine, { claude: CLAUDE_SHEET, codex: CODEX_SHEET });
    const skipped = await probeRun(machine, "claude", { FAKE_MANIFEST_SKIP: "1" });
    assert.deepEqual(laneRows(skipped.value).at(-1), ["manifest", "-", "failed"]);
    assert.match(skipped.value.lanes.at(-1).detail, /claude plugin validate test was skipped/);
    await json(["finish", "--dir", skipped.dir, "--home", machine.home], machine.env);
    const failed = await probeRun(machine, "claude", { FAKE_VALIDATE_FAIL: "1" });
    assert.match(failed.value.lanes.at(-1).detail, /node --test scripts\/manifests\.test\.ts exited 1/);
  });

  it("keeps running the other lanes after one fails and exits 1", async () => {
    const machine = fakeMachine();
    withSheets(machine, { claude: CLAUDE_SHEET, codex: CODEX_SHEET });
    const { code, value } = await probeRun(machine, "codex", { FAKE_SKIP_FILE: "1" });
    assert.equal(code, 1);
    assert.deepEqual(laneRows(value), [
      ["read", "sol@xhigh", "passed"],
      ["write", "sol@xhigh", "failed"],
      ["sandbox", "-", "passed"],
    ]);
    assert.match(value.lanes[1].detail, /probe\.txt is missing/);
  });

  it("refuses to probe from a directory that does not hold the lock", async () => {
    const machine = fakeMachine();
    const stray = join(root, `stray-${machineCount}`);
    mkdirSync(stray);
    const result = await json(["probe", "--cli", "codex", "--dir", stray, "--home", machine.home], machine.env);
    assert.equal(result.code, 3);
  });
});
