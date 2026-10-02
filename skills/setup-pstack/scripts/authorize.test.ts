import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { isolatedEnv, isolateProcessEnv } from "../../poteto-mode/scripts/runner/isolated-env.test-helper.ts";
import { ALLOW_ENTRY, MARKER, backupPathFor, checkAuthorization, main, settingsPathFor } from "./authorize.ts";

const LEGACY_V2_ENTRY = "pstack standing authorization v2: the operator who wrote this entry is the only human on their projects, so no pull request waits for a human approval, and this holds in every repository a session works in. Under pstack's playbooks, an agent may merge a pull request with gh pr merge (a squash, or --auto for merge-when-ready when the playbook or the operator asks for it) although no human reviewed or approved it, in two cases: an autopilot owner merging its own pull request after the root's clean swarm verdict, given by verifiers that did not write the code; and the session running the Shipping playbook after the independent per-PR verifier verdict. The root may spawn owner and verifier subagents, push its owners' branches with --force-with-lease, and post verdicts as pull request comments. None of that is Merge Without Review or Self-Approval. An agent may also launch the lanes pstack's playbooks name through pstack-runner (an owner, a verifier, a reviewer, a judge or a worker on claude, codex or grok, in the mode the playbook names), which is not Create Unsafe Agents. This covers nothing else: not --admin or any other way around a required check, not a change to branch protection, rulesets or required checks, and nothing the other rules protect (destroying files, branches or history, production systems, secrets, data leaving the trust boundary).";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "authorize.ts");

let base = "";
let home = "";
let processHome = "";
let restoreProcessEnv: () => void = () => {};

// The script falls back to the HOME of its process when `--home` is lost, and
// `apply` writes there. So the test process and every child it spawns get a
// temporary HOME of their own, apart from the `home` every call names: a lost
// `--home` writes under `processHome`, the assertions on `home` fail, and the
// operator's ~/.claude/settings.json is never reached.
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "pstack-authorize-"));
  home = join(base, "home");
  processHome = join(base, "process-home");
  mkdirSync(home);
  restoreProcessEnv = isolateProcessEnv(processHome);
});

afterEach(() => {
  restoreProcessEnv();
  rmSync(base, { recursive: true, force: true });
});

function put(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

function putSettings(value: unknown): string {
  return put(settingsPathFor("claude", home), JSON.stringify(value, null, 2) + "\n");
}

function settings(): { autoMode?: { allow?: string[] } } & Record<string, unknown> {
  return JSON.parse(readFileSync(settingsPathFor("claude", home), "utf8"));
}

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly questions: readonly string[];
}

async function run(argv: readonly string[], answer?: string): Promise<Run> {
  let stdout = "";
  let stderr = "";
  const questions: string[] = [];
  const code = await main([...argv, "--home", home], {
    stdout: (v) => { stdout += v; },
    stderr: (v) => { stderr += v; },
    askOnTerminal: answer === undefined ? undefined : async (question) => { questions.push(question); return answer; },
  });
  return { code, stdout, stderr, questions };
}

describe("test isolation", () => {
  it("keeps the HOME of the test process temporary and apart from the --home of the tests", () => {
    assert.equal(homedir(), processHome);
    assert.equal(settingsPathFor("claude"), join(processHome, ".claude", "settings.json"));
    assert.notEqual(settingsPathFor("claude"), settingsPathFor("claude", home));
  });
});

describe("check on a Claude Code parent", () => {
  it("rejects the actual 0.5.1 v2 body without writing, then applies the current body in place", async () => {
    const original = { model: "opus", autoMode: { allow: ["$defaults", LEGACY_V2_ENTRY, "Keep this permission"], custom: true } };
    putSettings(original);
    const file = settingsPathFor("claude", home);
    const before = readFileSync(file, "utf8");
    const stale = await run(["check", "--parent", "claude"]);
    assert.equal(stale.code, 1);
    const report = JSON.parse(stale.stdout);
    assert.equal(report.authorized, false);
    assert.equal(report.entry, ALLOW_ENTRY);
    assert.match(report.grant, /apply --parent claude$/);
    assert.equal(readFileSync(file, "utf8"), before);
    assert.equal(existsSync(backupPathFor("claude", home)), false);
    const applied = await run(["apply", "--parent", "claude"], "yes");
    assert.equal(applied.code, 0);
    assert.equal(applied.questions.length, 1);
    assert.deepEqual(settings(), { ...original, autoMode: { ...original.autoMode, allow: ["$defaults", ALLOW_ENTRY, "Keep this permission"] } });
    assert.equal(readFileSync(backupPathFor("claude", home), "utf8"), before);
    assert.equal((await run(["check", "--parent", "claude"])).code, 0);
    assert.equal(MARKER, "pstack standing authorization v2");
  });

  it("refuses without a settings file and says what the operator runs", async () => {
    const result = await run(["check", "--parent", "claude"]);
    assert.equal(result.code, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.authorized, false);
    assert.equal(report.file, settingsPathFor("claude", home));
    assert.match(report.reason, /No pstack standing authorization/);
    assert.equal(report.entry, ALLOW_ENTRY);
    assert.ok(report.grant.endsWith(" apply --parent claude"), report.grant);
    assert.ok(report.grant.includes(SCRIPT), report.grant);
  });

  it("refuses when the allow list holds other entries only", async () => {
    putSettings({ autoMode: { allow: ["$defaults", "Deploying to staging is allowed"] } });
    assert.equal(checkAuthorization("claude", home).authorized, false);
  });

  it("passes once the entry is in autoMode.allow", async () => {
    putSettings({ autoMode: { allow: ["$defaults", ALLOW_ENTRY] } });
    const result = await run(["check", "--parent", "claude"]);
    assert.equal(result.code, 0);
    assert.equal(JSON.parse(result.stdout).authorized, true);
  });

  it("stops on a settings file that is not JSON", async () => {
    put(settingsPathFor("claude", home), "{ not json");
    const result = await run(["check", "--parent", "claude"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /is not valid JSON/);
  });

  it("refuses the same when the script path goes through a symlinked directory", () => {
    const link = join(base, "scripts-link");
    symlinkSync(dirname(SCRIPT), link);
    const result = spawnSync(process.execPath, [join(link, "authorize.ts"), "check", "--parent", "claude", "--home", home], {
      encoding: "utf8",
      env: isolatedEnv(processHome),
    });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).authorized, false);
  });
});

describe("apply on a Claude Code parent", () => {
  it("refuses without a terminal and writes nothing", () => {
    const result = spawnSync(process.execPath, [SCRIPT, "apply", "--parent", "claude", "--home", home], {
      encoding: "utf8",
      input: "yes\n",
      env: isolatedEnv(processHome),
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /needs a terminal/);
    assert.match(result.stderr, / apply --parent claude/);
    assert.equal(existsSync(settingsPathFor("claude", home)), false);
  });

  it("shows the entry and the file, and writes nothing on any answer but yes", async () => {
    putSettings({ model: "opus" });
    const before = readFileSync(settingsPathFor("claude", home), "utf8");
    const result = await run(["apply", "--parent", "claude"], "ok");
    assert.equal(result.code, 1);
    assert.equal(result.questions.length, 1);
    assert.ok(result.stdout.includes(ALLOW_ENTRY));
    assert.match(result.stdout, /gh pr merge --repo <owner\/name> <pr> --squash --match-head-commit <published-head>/);
    assert.match(result.stdout, /all current required checks pass/);
    assert.match(result.stdout, /Every operator-named merge hold remains in force/);
    assert.match(result.stdout, /validated push URL with --force-with-lease=refs\/heads\/<branch>:<captured-remote-head>/);
    assert.match(result.stdout, /captured before rewriting and equal to the local pre-rewrite head/);
    assert.ok(result.stdout.includes(settingsPathFor("claude", home)));
    assert.match(result.stderr, /Nothing written/);
    assert.equal(readFileSync(settingsPathFor("claude", home), "utf8"), before);
    assert.equal(existsSync(backupPathFor("claude", home)), false);
  });

  it("creates the settings file with the built-in rules kept", async () => {
    const result = await run(["apply", "--parent", "claude"], "yes");
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(settings(), { autoMode: { allow: ["$defaults", ALLOW_ENTRY] } });
    assert.equal(existsSync(backupPathFor("claude", home)), false);
    assert.equal(checkAuthorization("claude", home).authorized, true);
  });

  it("accepts sim, keeps every other setting and backs the file up", async () => {
    const original = { permissions: { allow: ["Bash(npm test)"], defaultMode: "auto" }, hooks: { Stop: [{ hooks: [{ type: "command", command: "echo \"a\\nb\"" }] }] } };
    putSettings(original);
    const before = readFileSync(settingsPathFor("claude", home), "utf8");
    const result = await run(["apply", "--parent", "claude"], " Sim ");
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(settings(), { ...original, autoMode: { allow: ["$defaults", ALLOW_ENTRY] } });
    assert.equal(readFileSync(backupPathFor("claude", home), "utf8"), before);
  });

  it("appends to an allow list that keeps the built-in rules", async () => {
    putSettings({ autoMode: { environment: ["$defaults", "Source control: example"], allow: ["Staging deploys are allowed", "$defaults"] } });
    await run(["apply", "--parent", "claude"], "yes");
    assert.deepEqual(settings().autoMode, {
      environment: ["$defaults", "Source control: example"],
      allow: ["Staging deploys are allowed", "$defaults", ALLOW_ENTRY],
    });
  });

  it("does not bring the built-in rules back into a list the operator owns", async () => {
    putSettings({ autoMode: { allow: ["Only my own rule"] } });
    await run(["apply", "--parent", "claude"], "yes");
    assert.deepEqual(settings().autoMode?.allow, ["Only my own rule", ALLOW_ENTRY]);
  });

  it("replaces an entry of this version whose text differs, in place", async () => {
    putSettings({ autoMode: { allow: ["$defaults", `${MARKER}: an older wording`, "Another rule"] } });
    const result = await run(["apply", "--parent", "claude"], "yes");
    assert.equal(JSON.parse(result.stdout.slice(result.stdout.lastIndexOf("\n{"))).outcome, "updated");
    assert.deepEqual(settings().autoMode?.allow, ["$defaults", ALLOW_ENTRY, "Another rule"]);
  });

  it("replaces the entry of an older version instead of leaving it beside the new one", async () => {
    putSettings({ autoMode: { allow: ["$defaults", "pstack standing authorization v0: what the older version granted", "Another rule"] } });
    assert.equal(checkAuthorization("claude", home).authorized, false);
    const result = await run(["apply", "--parent", "claude"], "yes");
    assert.equal(JSON.parse(result.stdout.slice(result.stdout.lastIndexOf("\n{"))).outcome, "updated");
    assert.deepEqual(settings().autoMode?.allow, ["$defaults", ALLOW_ENTRY, "Another rule"]);
  });

  it("leaves one entry when the list holds several", async () => {
    putSettings({ autoMode: { allow: [ALLOW_ENTRY, "Another rule", `${MARKER}: an older wording`] } });
    await run(["apply", "--parent", "claude"], "yes");
    assert.deepEqual(settings().autoMode?.allow, [ALLOW_ENTRY, "Another rule"]);
  });

  it("asks nothing and touches nothing when the entry is already there", async () => {
    await run(["apply", "--parent", "claude"], "yes");
    const before = readFileSync(settingsPathFor("claude", home), "utf8");
    const result = await run(["apply", "--parent", "claude"], "no");
    assert.equal(result.code, 0);
    assert.equal(result.questions.length, 0);
    assert.equal(JSON.parse(result.stdout).outcome, "unchanged");
    assert.equal(readFileSync(settingsPathFor("claude", home), "utf8"), before);
    assert.equal(existsSync(backupPathFor("claude", home)), false);
  });

  for (const [name, value] of [
    ["an autoMode that is not an object", { autoMode: [] }],
    ["an allow list that is not a list", { autoMode: { allow: "everything" } }],
    ["an allow list with an entry that is not text", { autoMode: { allow: ["$defaults", 7] } }],
    ["a settings root that is not an object", ["autoMode"]],
  ] as const) {
    it(`stops on ${name} and leaves the file alone`, async () => {
      putSettings(value);
      const before = readFileSync(settingsPathFor("claude", home), "utf8");
      const result = await run(["apply", "--parent", "claude"], "yes");
      assert.equal(result.code, 1);
      assert.equal(result.questions.length, 0);
      assert.match(result.stderr, /resolve it before/);
      assert.equal(readFileSync(settingsPathFor("claude", home), "utf8"), before);
    });
  }
});

describe("a Codex parent", () => {
  function putConfig(text: string): string {
    return put(settingsPathFor("codex", home), text);
  }

  it("passes when Codex asks for no approval", async () => {
    putConfig('approval_policy = "never"\ndefault_permissions = ":danger-full-access"\n\n[features]\njs_repl = false\n');
    const result = await run(["check", "--parent", "codex"]);
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), {
      parent: "codex",
      authorized: true,
      file: settingsPathFor("codex", home),
      reason: 'approval_policy is "never": Codex asks for no approval',
    });
  });

  it("refuses a policy that asks, and names it", async () => {
    putConfig("# comment\napproval_policy = 'on-request' # asks\n");
    const result = await run(["check", "--parent", "codex"]);
    assert.equal(result.code, 1);
    assert.match(JSON.parse(result.stdout).reason, /approval_policy is "on-request"/);
  });

  it("refuses when the policy is unset, missing, or set only inside a table", async () => {
    assert.match(checkAuthorization("codex", home).reason, /approval_policy is unset/);
    putConfig('model = "gpt"\n\n[profiles.quiet]\napproval_policy = "never"\n');
    const check = checkAuthorization("codex", home);
    assert.equal(check.authorized, false);
    assert.match(check.reason, /approval_policy is unset/);
  });

  it("has nothing to apply", async () => {
    const result = await run(["apply", "--parent", "codex"], "yes");
    assert.equal(result.code, 64);
    assert.match(result.stderr, /apply is for a Claude Code parent/);
    assert.equal(result.questions.length, 0);
  });
});

describe("usage", () => {
  it("refuses an unknown parent and a missing subcommand", async () => {
    assert.equal((await run(["check", "--parent", "grok"])).code, 64);
    assert.equal((await run(["check"])).code, 64);
    assert.equal((await run(["--parent", "claude"])).code, 64);
  });
});
