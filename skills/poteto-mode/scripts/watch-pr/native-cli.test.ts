import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("optional native observations through the public CLI", () => {
  for (const unavailable of ["native", "requirements", "core"]) {
    it(`preserves upstream exit semantics when ${unavailable} is unreadable`, async () => {
      const directory = mkdtempSync(join(tmpdir(), "watch-pr-native-"));
      try {
        writeFileSync(join(directory, "gh"), `#!/usr/bin/env node
const args = process.argv.slice(2);
const unavailable = ${JSON.stringify(unavailable)};
const facts = { mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", headRefOid: "head", headRefName: "feature", baseRefName: "main", state: "OPEN", mergedAt: null, isDraft: false };
const pr = value => ({ data: { repository: { nameWithOwner: "owner/repo", pullRequest: value } } });
const fail = () => { console.error("HTTP 403: fixture unavailable"); process.exit(1); };
let result;
if (args[0] === "pr" && args[1] === "view") {
  if (unavailable === "core") fail();
  result = facts;
} else if (args[0] === "pr" && args[1] === "checks") {
  result = [{ name: "test", state: "SUCCESS", bucket: "pass", description: "", link: "", workflow: "" }];
} else if (args.some(arg => arg.includes("query NativeAdmission"))) {
  if (unavailable !== "requirements") fail();
  result = pr({ ...facts, id: "PR_1", number: 1, url: "https://github.com/owner/repo/pull/1", baseRefOid: "base", baseRef: { target: { oid: "base" }, branchProtectionRule: { requiredStatusChecks: [] } }, autoMergeRequest: null, mergeQueueEntry: null, timelineItems: { nodes: [] } });
} else if (args.some(arg => arg.includes("rules/branches/"))) {
  fail();
} else if (args.some(arg => arg.includes("query ReviewThreads"))) {
  result = pr({ reviewThreads: { nodes: [] } });
} else if (args.some(arg => arg.includes("query PrCommitStatuses"))) {
  result = pr({ commits: { nodes: [{ commit: { oid: "head", statusCheckRollup: { state: "SUCCESS" } } }] } });
} else { console.error("Unexpected fixture command", args); process.exit(99); }
console.log(JSON.stringify(result));
`, { mode: 0o755 });
        const child = Bun.spawn([
          process.execPath, join(import.meta.dir, "watch-pr"),
          "--owner", "owner", "--repo", "repo", "--pr", "1",
          "--max-query-errors", "1",
        ], {
          env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
          stdout: "pipe", stderr: "pipe",
        });
        const [stdout, stderr, exit] = await Promise.all([
          new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
        ]);
        expect(stderr).toBe("");
        const events = stdout.trim().split("\n").map(line => JSON.parse(line));
        if (unavailable === "core") {
          expect(exit).toBe(7);
          expect(events.at(-1)).toMatchObject({ kind: "BLOCKER", blocker: { kind: "status-query" } });
        } else {
          expect(exit).toBe(0);
          expect(events.at(-1)).toMatchObject({ kind: "READY", scope: { pr: { landing: { kind: "unknown" } } } });
          const native = events[0].snapshot.facts.native;
          expect(unavailable === "native" ? native : native.requirements).toMatchObject({ kind: "unknown" });
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});
