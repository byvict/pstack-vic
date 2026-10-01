import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { clisOutsideFakes, isolateProcessEnv } from "../skills/poteto-mode/scripts/runner/isolated-env.test-helper.ts";
import { PLUGIN_ROOT } from "./model-matrix.ts";
import { git, readSyncPoints } from "./upstream-digest.ts";
import {
  FETCH_HINT,
  ParityError,
  TABLE_PATH,
  applyPairs,
  buildReport,
  firstDifference,
  pairsFor,
  parseTable,
  problemsOf,
  residueOf,
  unifiedDiff,
  writeGenerated,
  type RowPair,
  type SubstitutionTable,
} from "./upstream-parity.ts";

const SCRIPT = join(PLUGIN_ROOT, "scripts", "upstream-parity.ts");

let scratch = "";
let gitBin = "";
let restoreProcessEnv: () => void = () => {};

function findGit(): string {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, "git");
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error("git is not on PATH");
}

// The tool reads the pin with git and the fixtures are git repositories, so
// git is the one program these tests run.
before(() => {
  const realGit = findGit();
  scratch = mkdtempSync(join(tmpdir(), "pstack-parity-"));
  gitBin = join(scratch, "git-bin");
  mkdirSync(gitBin);
  symlinkSync(realGit, join(gitBin, "git"));
  const home = join(scratch, "home");
  mkdirSync(home);
  restoreProcessEnv = isolateProcessEnv(home, [gitBin]);
});

after(() => {
  restoreProcessEnv();
  rmSync(scratch, { recursive: true, force: true });
});

describe("test isolation", () => {
  it("keeps every provider CLI and gh off the PATH of the test process", () => {
    assert.deepEqual(clisOutsideFakes(process.env.PATH, [gitBin]), [], "a CLI is on the PATH of the test process");
    assert.equal(process.env.PATH, [gitBin, join(scratch, "home", ".node-bin")].join(delimiter));
    assert.equal(process.env.HOME, join(scratch, "home"));
  });
});

const FILE = "skills/poteto-mode/playbooks/a.md";

function pair(id: string, from: string, to: string, count = 1): RowPair {
  return { id, file: FILE, from, to, count };
}

describe("upstream-parity: pair semantics", () => {
  it("applies the pairs of a file at once, whatever their order", () => {
    const upstream = "Triage Bugbot. Re-read it from trunk.\n";
    const pairs = [
      pair("T3", "Bugbot", "the review-bot"),
      pair("T6", "from trunk", "from the installed plugin"),
    ];
    const expected = "Triage the review-bot. Re-read it from the installed plugin.\n";
    assert.deepEqual(applyPairs(upstream, pairs), { text: expected, problems: [] });
    assert.deepEqual(applyPairs(upstream, [...pairs].reverse()), { text: expected, problems: [] });
  });

  it("matches every pair in the upstream text, never in the output of another pair", () => {
    const pairs = [pair("T1", "cloud", "local lane"), pair("T2", "lane", "worktree")];
    assert.equal(applyPairs("a cloud, a lane\n", pairs).text, "a local lane, a worktree\n");
    assert.equal(applyPairs("a cloud, a lane\n", [...pairs].reverse()).text, "a local lane, a worktree\n");
  });

  it("deletes with an empty to", () => {
    const applied = applyPairs("Run `/deslop` from `cursor-team-kit` over the diff.\n", [
      pair("T4", " from `cursor-team-kit`", ""),
    ]);
    assert.deepEqual(applied, { text: "Run `/deslop` over the diff.\n", problems: [] });
  });

  it("inserts with a to that starts with its from", () => {
    const applied = applyPairs("Run `check-plan.mjs <plan.md>` and fix it.\n", [
      pair("T6", " <plan.md>`", " <plan.md>` under the installed plugin"),
    ]);
    assert.deepEqual(applied, { text: "Run `check-plan.mjs <plan.md>` under the installed plugin and fix it.\n", problems: [] });
  });

  it("replaces every occurrence when the count is the number of occurrences", () => {
    const applied = applyPairs("`pstack/skills/how` and `pstack/skills/why`\n", [pair("T6", "pstack/skills/", "skills/", 2)]);
    assert.deepEqual(applied, { text: "`skills/how` and `skills/why`\n", problems: [] });
  });

  it("calls a pair that matches nothing a dead pair and generates no text", () => {
    const applied = applyPairs("Nothing Cursor here.\n", [pair("T2", "a Cursor cloud agent", "a worktree")]);
    assert.equal(applied.text, null);
    assert.deepEqual(applied.problems, [
      `T2 dead pair in ${FILE}: "a Cursor cloud agent" does not occur in the upstream text`,
    ]);
  });

  it("refuses a count that is not the number of occurrences", () => {
    const upstream = "the control skill and its control skill path\n";
    for (const count of [1, 3]) {
      const applied = applyPairs(upstream, [pair("T5", "control skill", "driver skill", count)]);
      assert.equal(applied.text, null);
      assert.deepEqual(applied.problems, [
        `T5 wrong count in ${FILE}: "control skill" occurs 2 times in the upstream text, the table says ${count}`,
      ]);
    }
  });

  it("refuses two pairs that overlap in the upstream text", () => {
    const upstream = "`git show origin/main:<control skill path>`\n";
    const applied = applyPairs(upstream, [
      pair("T6", "git show origin/main:<control", "<driver"),
      pair("T5", "control skill", "driver skill"),
    ]);
    assert.equal(applied.text, null);
    assert.deepEqual(applied.problems, [
      `T6 and T5 overlap in ${FILE}: "git show origin/main:<control" and "control skill"`,
    ]);
  });

  it("lets two pairs that touch without overlapping through", () => {
    const applied = applyPairs("`git show origin/main:<control skill path>`\n", [
      pair("T6", "git show origin/main:", ""),
      pair("T5", "<control skill", "<driver skill"),
    ]);
    assert.deepEqual(applied, { text: "`<driver skill path>`\n", problems: [] });
  });

  it("reports every problem of a file, not only the first", () => {
    const applied = applyPairs("one two\n", [pair("T1", "zero", "0"), pair("T2", "three", "3")]);
    assert.equal(applied.problems.length, 2);
  });
});

describe("upstream-parity: residue diff", () => {
  const generated = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\n";

  it("is empty for equal texts", () => {
    assert.equal(unifiedDiff(generated, generated, "generated", "local"), "");
    assert.equal(firstDifference(generated, generated), null);
  });

  it("prints a changed line with three lines of context on each side", () => {
    const local = generated.replace("five", "five, and a sentence of ours");
    assert.equal(
      unifiedDiff(generated, local, "generated", "local"),
      [
        "--- generated",
        "+++ local",
        "@@ -2,7 +2,7 @@",
        " two",
        " three",
        " four",
        "-five",
        "+five, and a sentence of ours",
        " six",
        " seven",
        " eight",
        "",
      ].join("\n"),
    );
  });

  it("prints a line the local file adds and a line it lacks", () => {
    assert.equal(
      unifiedDiff("one\ntwo\n", "one\nours\ntwo\n", "generated", "local"),
      ["--- generated", "+++ local", "@@ -1,2 +1,3 @@", " one", "+ours", " two", ""].join("\n"),
    );
    assert.equal(
      unifiedDiff("one\ntwo\nthree\n", "one\nthree\n", "generated", "local"),
      ["--- generated", "+++ local", "@@ -1,3 +1,2 @@", " one", "-two", " three", ""].join("\n"),
    );
  });

  it("splits changes that are far apart into hunks", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const local = lines.map((line, i) => (i === 1 || i === 17 ? `${line} changed` : line));
    const diff = unifiedDiff(`${lines.join("\n")}\n`, `${local.join("\n")}\n`, "generated", "local");
    assert.deepEqual(diff.match(/^@@.*@@$/gm), ["@@ -1,5 +1,5 @@", "@@ -15,6 +15,6 @@"]);
  });

  it("marks a file that lost its final newline", () => {
    assert.equal(
      unifiedDiff("one\ntwo\n", "one\ntwo", "generated", "local"),
      ["--- generated", "+++ local", "@@ -1,2 +1,2 @@", " one", "-two", "+two", "\\ No newline at end of file", ""].join("\n"),
    );
  });

  it("names the line and the column where a long paragraph first differs", () => {
    const paragraph = "This playbook replaces the standalone **babysit** skill for these requests.";
    const local = paragraph.replace("replaces", "supersedes");
    assert.equal(
      firstDifference(`### Babysit\n\n${paragraph}\n`, `### Babysit\n\n${local}\n`),
      [
        "first difference at line 3, column 15",
        "  generated: This playbook replaces the standalone **babysit** skill for thes",
        "  local:     This playbook supersedes the standalone **babysit** skill for th",
      ].join("\n"),
    );
  });
});

describe("upstream-parity: table shape", () => {
  const files = [{ upstream: "pstack/skills/poteto-mode/playbooks/a.md", local: FILE }];
  const row = { id: "T6", reason: "The installed plugin is the stable source.", pairs: [{ file: FILE, from: "a", to: "b", count: 1 }] };

  it("reads files and rows, and hands a file its pairs with their row ids", () => {
    const table = parseTable(
      JSON.stringify({ files, rows: [row, { id: "T2", reason: "No cloud.", pairs: [{ file: FILE, from: "c", to: "", count: 2 }] }] }),
    );
    assert.deepEqual(table.files, files);
    assert.deepEqual(pairsFor(table, FILE), [
      { id: "T6", file: FILE, from: "a", to: "b", count: 1 },
      { id: "T2", file: FILE, from: "c", to: "", count: 2 },
    ]);
    assert.deepEqual(pairsFor(table, "skills/poteto-mode/playbooks/other.md"), []);
  });

  it("refuses every shape the semantics do not define", () => {
    const bad: Array<[string, unknown]> = [
      ["no rows", { files }],
      ["a pin field instead of files", { pin: "abc", rows: [row] }],
      ["a pin field beside files and rows", { pin: "abc", files, rows: [row] }],
      ["a file without a local path", { files: [{ upstream: "pstack/a.md" }], rows: [row] }],
      ["a file listed twice", { files: [...files, ...files], rows: [row] }],
      ["a row id that is not a table row", { files, rows: [{ ...row, id: "liveness" }] }],
      ["a row listed twice", { files, rows: [row, row] }],
      ["a row without a reason", { files, rows: [{ ...row, reason: " " }] }],
      ["a row without pairs", { files, rows: [{ ...row, pairs: [] }] }],
      ["a pair without a count", { files, rows: [{ ...row, pairs: [{ file: FILE, from: "a", to: "b" }] }] }],
      ["a pair on a file outside the guard", { files, rows: [{ ...row, pairs: [{ file: "SKILL.md", from: "a", to: "b", count: 1 }] }] }],
      ["an empty from", { files, rows: [{ ...row, pairs: [{ file: FILE, from: "", to: "b", count: 1 }] }] }],
      ["a pair that changes nothing", { files, rows: [{ ...row, pairs: [{ file: FILE, from: "a", to: "a", count: 1 }] }] }],
      ["a count of zero", { files, rows: [{ ...row, pairs: [{ file: FILE, from: "a", to: "b", count: 0 }] }] }],
    ];
    for (const [name, table] of bad) {
      assert.throws(() => parseTable(JSON.stringify(table)), ParityError, name);
    }
    assert.throws(() => parseTable("{"), ParityError);
  });

  it("refuses a pin in the table and says where the pin lives", () => {
    assert.throws(
      () => parseTable(JSON.stringify({ pin: "0123", files, rows: [row] })),
      (err: unknown) =>
        err instanceof ParityError &&
        err.message.includes('unknown top-level key "pin"') &&
        err.message.endsWith("the pin lives in the sync table of UPSTREAM.md"),
    );
  });
});

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  }).trim();
}

function put(repo: string, path: string, text: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
}

const UPSTREAM_PATH = "pstack/skills/poteto-mode/playbooks/a.md";
const UPSTREAM_TEXT = "### A\n\nOne Cursor cloud agent per PR owns the build.\n\nThe tick re-reads the playbook from trunk.\n";
const GENERATED_TEXT = "### A\n\nOne background subagent per PR owns the build.\n\nThe tick re-reads the playbook from the installed plugin.\n";
const TABLE: SubstitutionTable = {
  files: [{ upstream: UPSTREAM_PATH, local: FILE }],
  rows: [
    { id: "T2", reason: "No cloud agents.", pairs: [{ file: FILE, from: "Cursor cloud agent", to: "background subagent", count: 1 }] },
    { id: "T6", reason: "The installed plugin is the stable source.", pairs: [{ file: FILE, from: "from trunk", to: "from the installed plugin", count: 1 }] },
  ],
};

const SECOND_FILE = "skills/poteto-mode/playbooks/b.md";
const SECOND_UPSTREAM_PATH = "pstack/skills/poteto-mode/playbooks/b.md";

/**
 * A checkout with one guarded file: a commit that holds the upstream text
 * under `pstack/`, and a working tree with UPSTREAM.md, the table and the
 * local file. `pin` is the sync point UPSTREAM.md names. `second` adds a
 * second upstream file to that commit and its local file to the working tree.
 */
function fixture(
  options: { table?: SubstitutionTable; local?: string; pin?: string; second?: { upstream: string; local: string } } = {},
): string {
  const repo = mkdtempSync(join(scratch, "repo-"));
  sh(repo, "init", "-q");
  put(repo, UPSTREAM_PATH, UPSTREAM_TEXT);
  if (options.second) put(repo, SECOND_UPSTREAM_PATH, options.second.upstream);
  sh(repo, "add", ".");
  sh(repo, "commit", "-q", "-m", "upstream");
  const pin = options.pin ?? sh(repo, "rev-parse", "HEAD");
  put(repo, "UPSTREAM.md", `| | \`cursor\` | \`open\` |\n| --- | --- | --- |\n| Commit | \`${pin}\` | \`${"1".repeat(40)}\` |\n`);
  put(repo, TABLE_PATH, JSON.stringify(options.table ?? TABLE));
  put(repo, FILE, options.local ?? GENERATED_TEXT);
  if (options.second) put(repo, SECOND_FILE, options.second.local);
  return repo;
}

function run(repo: string, ...args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args, "--repo", repo], { encoding: "utf8", env: process.env });
}

describe("upstream-parity: check and --write on a fixture checkout", () => {
  it("check exits 0 when the local file is the upstream text plus the pairs", () => {
    const repo = fixture();
    const result = run(repo, "check");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^upstream-parity: 1 files equal [0-9a-f]{40} plus the 2 pairs of /);
  });

  it("check exits 1 on residue and prints its unified diff", () => {
    const local = GENERATED_TEXT.replace("owns the build.", "owns the build. Take its lease first.");
    const repo = fixture({ local });
    const result = run(repo, "check");
    assert.equal(result.status, 1);
    assert.match(result.stdout, new RegExp(`^--- generated: [0-9a-f]{8}:${UPSTREAM_PATH} plus the table\\n\\+\\+\\+ ${FILE}\\n`));
    assert.match(result.stdout, /^-One background subagent per PR owns the build\.$/m);
    assert.match(result.stdout, /^\+One background subagent per PR owns the build\. Take its lease first\.$/m);
    assert.match(result.stdout, /^first difference at line 3, column 47$/m);
    assert.match(result.stderr, /^upstream-parity: 1 files with residue, 0 table problems against /m);
    assert.equal(readFileSync(join(repo, FILE), "utf8"), local, "check never writes");
  });

  it("--write regenerates the local file, and check is green afterwards", () => {
    const repo = fixture({ local: "### A\n\nA file rewritten by hand.\n" });
    const written = run(repo, "--write");
    assert.equal(written.status, 0, written.stderr);
    assert.match(written.stdout, new RegExp(`^wrote ${FILE}$`, "m"));
    assert.equal(readFileSync(join(repo, FILE), "utf8"), GENERATED_TEXT);
    assert.equal(run(repo, "check").status, 0);
    assert.doesNotMatch(run(repo, "--write").stdout, /^wrote /m, "a second --write has nothing to rewrite");
  });

  it("a dead pair fails check and keeps --write from writing anything", () => {
    const dead: SubstitutionTable = {
      ...TABLE,
      rows: [...TABLE.rows, { id: "T3", reason: "Bugbot is Cursor's.", pairs: [{ file: FILE, from: "Bugbot", to: "review-bot", count: 1 }] }],
    };
    const local = "### A\n\nA file rewritten by hand.\n";
    const repo = fixture({ table: dead, local });
    for (const command of ["check", "--write"]) {
      const result = run(repo, command);
      assert.equal(result.status, 1, command);
      assert.match(result.stderr, new RegExp(`^T3 dead pair in ${FILE}: "Bugbot" does not occur in the upstream text$`, "m"));
    }
    assert.equal(readFileSync(join(repo, FILE), "utf8"), local);
    const report = buildReport(repo);
    assert.equal(problemsOf(report).length, 1);
    assert.deepEqual(writeGenerated(repo, report), []);
  });

  it("a dead pair on one file keeps --write from writing any other file", () => {
    const table: SubstitutionTable = {
      files: [...TABLE.files, { upstream: SECOND_UPSTREAM_PATH, local: SECOND_FILE }],
      rows: [
        ...TABLE.rows,
        { id: "T3", reason: "Bugbot is Cursor's.", pairs: [{ file: FILE, from: "Bugbot", to: "review-bot", count: 1 }] },
        { id: "T4", reason: "The plugin ships its own deslop.", pairs: [{ file: SECOND_FILE, from: " from `cursor-team-kit`", to: "", count: 1 }] },
      ],
    };
    const stale = "### B\n\nA file rewritten by hand.\n";
    const repo = fixture({
      table,
      second: { upstream: "### B\n\nRun `/deslop` from `cursor-team-kit` over the diff.\n", local: stale },
    });

    const result = run(repo, "--write");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^upstream-parity: nothing written, fix the table first$/m);
    assert.doesNotMatch(result.stdout, /^wrote /m);
    assert.equal(readFileSync(join(repo, SECOND_FILE), "utf8"), stale);

    const report = buildReport(repo);
    const second = report.files.find((f) => f.file.local === SECOND_FILE);
    assert.equal(second?.generated, "### B\n\nRun `/deslop` over the diff.\n", "the second file has no problem of its own");
    assert.notEqual(second?.residue, null, "and its local text is stale");
    assert.deepEqual(writeGenerated(repo, report), []);
    assert.equal(readFileSync(join(repo, SECOND_FILE), "utf8"), stale);
  });

  it("a local file that is missing is all residue", () => {
    const repo = fixture();
    rmSync(join(repo, FILE));
    const report = buildReport(repo);
    assert.deepEqual(problemsOf(report), []);
    assert.equal(residueOf(report).length, 1);
    assert.deepEqual(writeGenerated(repo, report), [FILE]);
    assert.equal(readFileSync(join(repo, FILE), "utf8"), GENERATED_TEXT);
  });

  it("a clone without the pin commit exits 2 and says how to fetch it", () => {
    const repo = fixture({ pin: "0".repeat(40) });
    assert.throws(() => buildReport(repo), (err: unknown) => err instanceof ParityError && err.message.startsWith(FETCH_HINT));
    for (const command of ["check", "--write"]) {
      const result = run(repo, command);
      assert.equal(result.status, 2, command);
      assert.match(result.stderr, /^fetch the cursor remote first: git fetch --no-tags cursor main /);
    }
  });

  it("runs the same when the script path goes through a symlinked directory", () => {
    const link = join(scratch, "plugin-link");
    symlinkSync(PLUGIN_ROOT, link);
    const linked = join(link, "scripts", "upstream-parity.ts");
    const viaLink = (repo: string, command: string) =>
      spawnSync(process.execPath, [linked, command, "--repo", repo], { encoding: "utf8", env: process.env });

    const clean = viaLink(fixture(), "check");
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.stdout, /^upstream-parity: 1 files equal [0-9a-f]{40} plus the 2 pairs of /);

    const residue = viaLink(fixture({ local: `${GENERATED_TEXT}Take its lease first.\n` }), "check");
    assert.equal(residue.status, 1);
    assert.match(residue.stderr, /^upstream-parity: 1 files with residue, 0 table problems against /m);

    const repo = fixture({ local: "### A\n\nA file rewritten by hand.\n" });
    const written = viaLink(repo, "--write");
    assert.equal(written.status, 0, written.stderr);
    assert.equal(readFileSync(join(repo, FILE), "utf8"), GENERATED_TEXT);
  });

  it("the command line takes check or --write, and nothing else", () => {
    const repo = fixture();
    for (const args of [[], ["check", "--write"], ["write"], ["check", "check"], ["--fix"]]) {
      const result = run(repo, ...args);
      assert.equal(result.status, 2, args.join(" "));
    }
    assert.equal(run(repo, "--help").status, 0);
  });
});

describe("upstream-parity: this checkout", () => {
  // CI fetches the cursor remote before npm test. A clone without the pin
  // fails here instead of skipping: a skip would hide drift.
  function pin(): string {
    const sha = readSyncPoints(readFileSync(join(PLUGIN_ROOT, "UPSTREAM.md"), "utf8")).cursor;
    const probe = spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: PLUGIN_ROOT, stdio: "ignore" });
    assert.equal(probe.status, 0, FETCH_HINT);
    return sha;
  }

  it("the six guarded playbooks are the upstream text at the pin plus the table: check exits 0", () => {
    pin();
    const result = spawnSync(process.execPath, [SCRIPT, "check"], { encoding: "utf8", env: process.env });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /^upstream-parity: 6 files equal /);
  });

  it("the table guards exactly the six autopilot playbooks", () => {
    const table = parseTable(readFileSync(join(PLUGIN_ROOT, TABLE_PATH), "utf8"));
    const names = ["autopilot-full", "autopilot-stack", "babysit", "multi-phase-plan", "opening-a-pr", "shipping"];
    assert.deepEqual(
      [...table.files].sort((a, b) => (a.local < b.local ? -1 : 1)),
      names.map((name) => ({
        upstream: `pstack/skills/poteto-mode/playbooks/${name}.md`,
        local: `skills/poteto-mode/playbooks/${name}.md`,
      })),
    );
  });

  it("the two Autopilot entries of the poteto-mode playbook list equal upstream's", () => {
    const entries = (text: string): string[] => text.split("\n").filter((line) => line.startsWith("- **Autopilot-"));
    const upstream = entries(git(PLUGIN_ROOT, "show", `${pin()}:pstack/skills/poteto-mode/SKILL.md`));
    assert.equal(upstream.length, 2);
    assert.deepEqual(entries(readFileSync(join(PLUGIN_ROOT, "skills", "poteto-mode", "SKILL.md"), "utf8")), upstream);
  });
});
