import { after, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PLUGIN_ROOT } from "./model-matrix.ts";

type Cleanup = { after(fn: () => void): void };

// The script needs bash, sed, grep, awk, find and mktemp, and nothing else.
// They live in /usr/bin and /bin, which hold no claude on the operator's Mac
// or on the CI image (there npm puts claude beside node). The developer's PATH
// and HOME stay out, so the behavioral leg reaches only a fake that a test
// puts in front; if the opt-in guard regressed, `claude` would not be found.
const SYSTEM_PATH = "/usr/bin:/bin";
const home = mkdtempSync(join(tmpdir(), "pstack-collision-home-"));
after(() => rmSync(home, { recursive: true, force: true }));

function collision(root: string, env: Record<string, string> = {}) {
  const tmp = process.env.TMPDIR;
  return spawnSync("bash", [join(root, "tests", "skill-collision-repro.sh")], {
    encoding: "utf8",
    env: { PATH: SYSTEM_PATH, HOME: home, ...(tmp === undefined ? {} : { TMPDIR: tmp }), PSTACK_BEHAVIORAL: "0", ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
}

function scratch(t: Cleanup, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function pluginCopy(t: Cleanup): string {
  const root = scratch(t, "pstack-collision-");
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: PLUGIN_ROOT, encoding: "utf8" }).split("\0");
  for (const file of files) {
    if (!file || !existsSync(join(PLUGIN_ROOT, file))) continue;
    mkdirSync(dirname(join(root, file)), { recursive: true });
    copyFileSync(join(PLUGIN_ROOT, file), join(root, file));
  }
  return root;
}

const PIPE_OVERFLOW = "x-pad: filler\n".repeat(1 << 16);

function padFrontMatter(root: string, skill: string, lines = ""): void {
  const path = join(root, "skills", skill, "SKILL.md");
  writeFileSync(path, readFileSync(path, "utf8").replace("\n---\n", `\n${lines}${PIPE_OVERFLOW}---\n`));
}

// The static invariants of tests/skill-collision-repro.sh run inside npm test.
// The behavioral leg (a real `claude -p` invocation) stays opt-in through
// PSTACK_BEHAVIORAL=1 on the script itself.
it("tests/skill-collision-repro.sh static invariants pass", () => {
  const result = collision(PLUGIN_ROOT);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.doesNotMatch(result.stdout, /^FAIL:/m, result.stdout);
});

it("a principle leaf keeps passing when its front matter outlasts the pipe", (t) => {
  const root = pluginCopy(t);
  padFrontMatter(root, "principle-prove-it-works");
  const result = collision(root);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.doesNotMatch(result.stdout, /^FAIL:/m, result.stdout);
});

it("disable-model-invocation is caught when the front matter outlasts the pipe", (t) => {
  const root = pluginCopy(t);
  padFrontMatter(root, "principle-prove-it-works", "disable-model-invocation: true\n");
  padFrontMatter(root, "tdd", "disable-model-invocation: true\n");
  const result = collision(root);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /skills\/principle-prove-it-works\/SKILL\.md \(still carries disable-model-invocation\)/, result.stdout);
  assert.doesNotMatch(result.stdout, /missing user-invocable: false/, result.stdout);
  assert.match(result.stdout, /^FAIL: skills routed by name must stay model-invocable:\n.*\/skills\/tdd\/SKILL\.md$/m, result.stdout);
});

it("the behavioral leg finds the marker at the start of a long claude output", (t) => {
  const bin = scratch(t, "pstack-collision-bin-");
  writeFileSync(join(bin, "filler"), PIPE_OVERFLOW);
  writeFileSync(join(bin, "claude"), '#!/bin/sh\necho SKILL-RAN\ncat "$(dirname "$0")/filler"\n');
  chmodSync(join(bin, "claude"), 0o755);
  const result = collision(PLUGIN_ROOT, { PSTACK_BEHAVIORAL: "1", PATH: `${bin}:${SYSTEM_PATH}` });
  assert.equal(result.status, 0, `${result.stdout.slice(0, 4000)}\n${result.stderr}`);
  assert.match(result.stdout, /^ok: model-initiated Skill-tool invocation -> SKILL-RAN$/m);
  assert.match(result.stdout, /^ok: user \/testplug:foo invocation -> SKILL-RAN$/m);
});
