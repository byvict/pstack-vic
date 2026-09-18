import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PLUGIN_ROOT } from "./model-matrix.ts";
import {
  DigestError,
  EXCLUDED_PATHS,
  NAO_APLICA,
  UPSTREAMS,
  buildDigest,
  hasNews,
  isExcluded,
  mapPath,
  parseSince,
  readSyncPoints,
  renderMarkdown,
  type Digest,
  type UpstreamDigest,
} from "./upstream-digest.ts";

const SCRIPT = join(PLUGIN_ROOT, "scripts", "upstream-digest.ts");

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
      GIT_AUTHOR_DATE: "2026-09-01T12:00:00Z",
      GIT_COMMITTER_DATE: "2026-09-01T12:00:00Z",
    },
  }).trim();
}

function put(repo: string, path: string, text: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
}

function commit(repo: string, subject: string, files: Record<string, string | null>): string {
  for (const [path, text] of Object.entries(files)) {
    if (text === null) sh(repo, "rm", "-q", path);
    else {
      put(repo, path, text);
      sh(repo, "add", path);
    }
  }
  sh(repo, "commit", "-q", "-m", subject);
  return sh(repo, "rev-parse", "HEAD");
}

function upstreamMd(cursor: string, open: string): string {
  return [
    "# Upstreams",
    "",
    "## Ponto de sync atual",
    "",
    "| | `cursor` | `open` |",
    "| --- | --- | --- |",
    `| Commit | \`${cursor}\` | \`${open}\` |`,
    "| Data do sync | 2026-09-01 | 2026-09-01 |",
    "",
  ].join("\n");
}

/**
 * One repository plays the three roles: the port checkout (working tree with
 * the plugin at the root), `cursor/main` (branch with the plugin under
 * `pstack/`) and `open/main` (branch with the plugin under `plugins/pstack/`).
 * The sync point of both is `base`; the remote-tracking refs point at the
 * branch tips so the script reads them exactly as it reads a real clone.
 */
interface Fixture {
  readonly repo: string;
  readonly base: string;
  readonly cursor: { readonly c1: string; readonly c2: string; readonly c3: string; readonly tip: string };
  readonly open: { readonly o1: string; readonly o2: string; readonly tip: string };
}

function buildFixture(): Fixture {
  const repo = mkdtempSync(join(tmpdir(), "pstack-digest-"));
  sh(repo, "init", "-q", "-b", "main");
  const base = commit(repo, "base", {
    "pstack/.cursor-plugin/plugin.json": '{"name":"pstack","version":"0.15.2"}\n',
    "pstack/skills/how/SKILL.md": "how v1\n",
    "pstack/README.md": "readme v1\n",
    "plugins/pstack/.claude-plugin/plugin.json": '{"name":"pstack","version":"1.4.1"}\n',
    "plugins/pstack/skills/how/SKILL.md": "how v1\n",
    "plugins/pstack/skills/gone/SKILL.md": "gone\n",
  });

  sh(repo, "checkout", "-q", "-b", "cursor-main");
  const c1 = commit(repo, "fix(pstack): how prose + readme", {
    "pstack/skills/how/SKILL.md": "how v2\n",
    "pstack/README.md": "readme v2\n",
  });
  const c2 = commit(repo, "chore(other): unrelated plugin", { "other-plugin/x.md": "x\n" });
  const c3 = commit(repo, "feat(pstack): make-bot-ui and guide", {
    "pstack/skills/make-bot-ui/SKILL.md": "bot\n",
    "pstack/docs/guide/01.md": "guide\n",
  });
  commit(repo, "feat(pstack): bump", { "pstack/.cursor-plugin/plugin.json": '{"name":"pstack","version":"0.15.3"}\n' });
  const cursorTip = sh(repo, "rev-parse", "HEAD");

  sh(repo, "checkout", "-q", base, "-b", "open-main");
  const o1 = commit(repo, "port: how prose + sync script", {
    "plugins/pstack/skills/how/SKILL.md": "how v2\n",
    "scripts/upstream-audit.py": "print()\n",
  });
  const o2 = commit(repo, "remove gone skill, add new skill", {
    "plugins/pstack/skills/gone/SKILL.md": null,
    "plugins/pstack/skills/fresh/SKILL.md": "fresh\n",
  });
  const openTip = sh(repo, "rev-parse", "HEAD");

  sh(repo, "update-ref", "refs/remotes/cursor/main", cursorTip);
  sh(repo, "update-ref", "refs/remotes/open/main", openTip);

  // The port checkout: plugin at the root, UPSTREAM.md with both sync points.
  sh(repo, "checkout", "-q", "main");
  commit(repo, "port tree", {
    "skills/how/SKILL.md": "how v1 (port)\n",
    "README.md": "port readme\n",
    "UPSTREAM.md": upstreamMd(base, base),
  });
  return {
    repo,
    base,
    cursor: { c1, c2, c3, tip: cursorTip },
    open: { o1, o2, tip: openTip },
  };
}

function upstream(digest: Digest, name: "cursor" | "open"): UpstreamDigest {
  return digest.upstreams.find((u) => u.name === name) as UpstreamDigest;
}

describe("upstream-digest: pure pieces", () => {
  it("reads both sync points from the real UPSTREAM.md and they resolve in this clone", () => {
    const points = readSyncPoints(readFileSync(join(PLUGIN_ROOT, "UPSTREAM.md"), "utf8"));
    assert.match(points.cursor, /^[0-9a-f]{40}$/);
    assert.match(points.open, /^[0-9a-f]{40}$/);
    assert.notEqual(points.cursor, points.open);
    for (const sha of [points.cursor, points.open]) {
      const probe = spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: PLUGIN_ROOT });
      assert.equal(probe.status, 0, `sync point ${sha} must be a commit reachable in this clone`);
    }
  });

  it("refuses an UPSTREAM.md without the full-hash row", () => {
    assert.throws(() => readSyncPoints("| Commit | `abc1234` | `def5678` |\n"), DigestError);
    assert.throws(() => readSyncPoints("no table"), DigestError);
  });

  it("parses --since values and rejects anything else", () => {
    assert.deepEqual(parseSince([]), {});
    assert.deepEqual(parseSince(["cursor=ABCDEF0", "open=" + "1".repeat(40)]), {
      cursor: "abcdef0",
      open: "1".repeat(40),
    });
    assert.throws(() => parseSince(["cursor=bogus"]), DigestError);
    assert.throws(() => parseSince(["origin=abcdef0"]), DigestError);
    assert.throws(() => parseSince(["abcdef0"]), DigestError);
  });

  it("maps upstream paths into the plugin and flags the excluded ones", () => {
    const [cursor, open] = UPSTREAMS as [(typeof UPSTREAMS)[0], (typeof UPSTREAMS)[1]];
    assert.equal(mapPath(cursor, "pstack/skills/how/SKILL.md"), "skills/how/SKILL.md");
    assert.equal(mapPath(cursor, "cursor-team-kit/skills/deslop/SKILL.md"), null);
    assert.equal(mapPath(open, "plugins/pstack/hooks/hooks.json"), "hooks/hooks.json");
    assert.equal(mapPath(open, "scripts/upstream-audit.py"), null);
    for (const p of EXCLUDED_PATHS) assert.ok(isExcluded(p.endsWith("/") ? `${p}x.md` : p), p);
    assert.equal(isExcluded("README.md"), true);
    assert.equal(isExcluded("docs/reference.md"), false);
    assert.equal(isExcluded("skills/how/SKILL.md"), false);
    assert.equal(isExcluded("README.md.bak"), false);
  });
});

describe("upstream-digest: fixture repository", () => {
  let fx: Fixture;
  before(() => {
    fx = buildFixture();
  });
  after(() => {
    rmSync(fx.repo, { recursive: true, force: true });
  });

  it("lists cursor commits that touched pstack/, in order, with mapped files and excluded paths", () => {
    const digest = buildDigest({ repo: fx.repo, date: "2026-09-18" });
    const cursor = upstream(digest, "cursor");
    assert.equal(cursor.since, fx.base);
    assert.equal(cursor.sinceSource, "UPSTREAM.md");
    assert.equal(cursor.tip, fx.cursor.tip);
    assert.equal(cursor.tipDate, "2026-09-01");
    assert.equal(cursor.version, "0.15.3");
    assert.deepEqual(
      cursor.commits.map((c) => c.sha),
      [fx.cursor.c1, fx.cursor.c3, fx.cursor.tip],
      "the commit outside pstack/ is not listed",
    );
    const [c1, c3, bump] = cursor.commits as [(typeof cursor.commits)[0], (typeof cursor.commits)[0], (typeof cursor.commits)[0]];
    assert.equal(c1.subject, "fix(pstack): how prose + readme");
    assert.deepEqual(
      c1.files.map((f) => [f.localPath, f.status, f.excluded, f.missingLocally]),
      [
        ["README.md", "M", true, false],
        ["skills/how/SKILL.md", "M", false, false],
      ],
    );
    assert.equal(c1.verdict, "", "a commit with a kept file waits for a verdict");
    assert.deepEqual(
      c3.files.map((f) => [f.localPath, f.status, f.excluded]),
      [
        ["docs/guide/01.md", "A", true],
        ["skills/make-bot-ui/SKILL.md", "A", true],
      ],
    );
    assert.equal(c3.verdict, NAO_APLICA, "a commit touching only excluded paths is pre-filled");
    assert.equal(bump.verdict, NAO_APLICA);
    assert.deepEqual(bump.files.map((f) => f.localPath), [".cursor-plugin/plugin.json"]);
  });

  it("lists every open commit, marks files outside the plugin and files absent from the port", () => {
    const digest = buildDigest({ repo: fx.repo, date: "2026-09-18" });
    const open = upstream(digest, "open");
    assert.equal(open.version, "1.4.1");
    assert.deepEqual(open.commits.map((c) => c.sha), [fx.open.o1, fx.open.o2]);
    const [o1, o2] = open.commits as [(typeof open.commits)[0], (typeof open.commits)[0]];
    assert.deepEqual(
      o1.files.map((f) => [f.upstreamPath, f.localPath, f.missingLocally]),
      [
        ["plugins/pstack/skills/how/SKILL.md", "skills/how/SKILL.md", false],
        ["scripts/upstream-audit.py", null, false],
      ],
    );
    assert.equal(o1.verdict, "");
    assert.deepEqual(
      o2.files.map((f) => [f.localPath, f.status, f.missingLocally]),
      [
        ["skills/fresh/SKILL.md", "A", true],
        ["skills/gone/SKILL.md", "D", false],
      ],
      "an upstream addition the port lacks is flagged; a deletion is not",
    );
  });

  it("renders markdown with one table per upstream, one row per commit and the verdict column", () => {
    const digest = buildDigest({ repo: fx.repo, date: "2026-09-18" });
    const md = renderMarkdown(digest);
    assert.ok(md.startsWith("# Upstream digest — 2026-09-18\n"));
    assert.match(md, /^## cursor /m);
    assert.match(md, /^## open /m);
    assert.match(md, /^\| Commits novos \| 3 \|$/m);
    assert.match(md, /^\| Commits novos \| 2 \|$/m);
    assert.match(md, /^\| Commit \| Data \| Assunto \| Arquivos \| Veredito \|$/m);
    const rows = md.split("\n").filter((l) => /^\| `[0-9a-f]{7}` \|/.test(l));
    assert.equal(rows.length, 5);
    assert.match(
      md,
      new RegExp(
        `^\\| \`${fx.cursor.c1.slice(0, 7)}\` \\| 2026-09-01 \\| fix\\(pstack\\): how prose \\+ readme \\| 2: \`README.md \\(excluído na fase 5\\)\`, \`skills/how/SKILL.md\` \\|  \\|$`,
        "m",
      ),
    );
    assert.match(md, new RegExp(`^\\| \`${fx.cursor.c3.slice(0, 7)}\` .* \\| ${NAO_APLICA} \\|$`, "m"));
    assert.match(md, /`scripts\/upstream-audit\.py \(fora do plugin\)`/);
    assert.match(md, /`skills\/fresh\/SKILL\.md \(novo, ausente aqui\)`/);
    assert.match(md, /`skills\/gone\/SKILL\.md \(removido\)`/);
    assert.equal(hasNews(digest), true);
  });

  it("says 'Sem novidades' for an upstream whose sync point is its tip, and --since reopens the range", () => {
    put(fx.repo, "UPSTREAM.md", upstreamMd(fx.cursor.tip, fx.open.tip));
    try {
      const quiet = buildDigest({ repo: fx.repo, date: "2026-09-18" });
      assert.equal(hasNews(quiet), false);
      const md = renderMarkdown(quiet);
      assert.equal((md.match(/^Sem novidades\.$/gm) ?? []).length, 2);
      assert.doesNotMatch(md, /^\| Commit \| Data/m);

      const reopened = buildDigest({ repo: fx.repo, date: "2026-09-18", since: { open: fx.open.o1.slice(0, 7) } });
      assert.equal(upstream(reopened, "cursor").commits.length, 0);
      const open = upstream(reopened, "open");
      assert.equal(open.sinceSource, "--since");
      assert.equal(open.since, fx.open.o1, "an abbreviated --since is resolved to the full hash");
      assert.deepEqual(open.commits.map((c) => c.sha), [fx.open.o2]);
      assert.match(renderMarkdown(reopened), /\(início por `--since`\)/);
    } finally {
      put(fx.repo, "UPSTREAM.md", upstreamMd(fx.base, fx.base));
    }
  });

  it("fails with DigestError when a sync point is not a commit", () => {
    put(fx.repo, "UPSTREAM.md", upstreamMd("0".repeat(40), fx.base));
    try {
      assert.throws(() => buildDigest({ repo: fx.repo }), DigestError);
    } finally {
      put(fx.repo, "UPSTREAM.md", upstreamMd(fx.base, fx.base));
    }
  });

  it("command line: --no-fetch --json prints the digest, bad --since exits 2, --help exits 0", () => {
    const json = spawnSync("node", [SCRIPT, "--repo", fx.repo, "--no-fetch", "--json"], { encoding: "utf8" });
    assert.equal(json.status, 0, json.stderr);
    const digest = JSON.parse(json.stdout) as Digest;
    assert.equal(digest.repo, fx.repo);
    assert.deepEqual(digest.upstreams.map((u) => [u.name, u.commits.length]), [["cursor", 3], ["open", 2]]);

    const md = spawnSync("node", [SCRIPT, "--repo", fx.repo, "--no-fetch"], { encoding: "utf8" });
    assert.equal(md.status, 0, md.stderr);
    assert.equal(md.stdout, renderMarkdown({ ...digest, date: md.stdout.slice("# Upstream digest — ".length, "# Upstream digest — ".length + 10) }));

    const bad = spawnSync("node", [SCRIPT, "--repo", fx.repo, "--no-fetch", "--since", "cursor=zzz"], { encoding: "utf8" });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /--since expects/);

    const help = spawnSync("node", [SCRIPT, "--help"], { encoding: "utf8" });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /^usage: upstream-digest/);

    const fetching = spawnSync("node", [SCRIPT, "--repo", fx.repo], { encoding: "utf8" });
    assert.equal(fetching.status, 2, "the fixture has no remotes, so the default fetch must fail cleanly");
    assert.match(fetching.stderr, /git fetch --quiet cursor main failed/);
  });
});
