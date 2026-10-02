import { describe, expect, it } from "bun:test";
import {
  parseNativeLanding,
  parseRequirements,
  requiredCheckResult,
} from "./github.ts";
import {
  classifyPr,
  readSnapshot,
  runQueued,
  selectTierMajorStackDecision,
} from "./policy.ts";
import { renderJson, renderPretty } from "./render.ts";
import { fakeReader, failedCheck, passingCheck } from "./fakes.test-helper.ts";
import { parsePrNumber } from "./types.ts";
import type {
  NativeLandingFacts,
  NativeQueueEntry,
  PrSnapshot,
  ProgressVerdict,
} from "./types.ts";

const context = { owner: "owner", repo: "repo", number: parsePrNumber(1) };
const native = {
  kind: "observed",
  repository: "owner/repo",
  prNodeId: "PR_1",
  prNumber: context.number,
  prUrl: "https://github.com/owner/repo/pull/1",
  headSha: "head",
  baseRef: "main",
  prBaseSha: "cached-base",
  currentBaseSha: "actual-base",
  autoMerge: null,
  queueEntry: null,
  candidate: "unknown",
  lastQueueEvent: null,
  requirements: { kind: "known", checks: [] },
} satisfies NativeLandingFacts;
const entry = {
  id: "MQE_1",
  state: "QUEUED",
  position: 1,
  enqueuedAt: "2026-10-02T10:00:00Z",
  candidate: "unknown",
  base: "unknown",
} satisfies NativeQueueEntry;
const snapshot = (
  facts: NativeLandingFacts,
  previous?: PrSnapshot,
  failed = false
) =>
  readSnapshot({
    reader: fakeReader({
      facts: {
        native: facts,
        headRefOid: facts.kind === "observed" ? facts.headSha : "head",
      },
      fastPath: {
        kind: "checks",
        checks: [failed ? failedCheck() : passingCheck()],
      },
    }),
    context,
    pendingHistory: "include",
    allowDraft: false,
    previous,
  });
const raw = {
  data: {
    repository: {
      nameWithOwner: "owner/repo",
      pullRequest: {
        id: "PR_1",
        number: 1,
        url: native.prUrl,
        headRefOid: "head",
        baseRefName: "main",
        baseRefOid: "cached-base",
        baseRef: {
          target: { oid: "actual-base" },
          branchProtectionRule: {
            requiredStatusChecks: [{ context: "classic", app: null }],
          },
        },
        autoMergeRequest: null,
        mergeQueueEntry: null,
        timelineItems: { nodes: [] },
      },
    },
  },
};

describe("native API boundary", () => {
  it("keeps cached base separate from the actual base ref and candidate unknown", () => {
    const { requirements: _requirements, ...expected } = native;
    expect(parseNativeLanding(raw, context)).toEqual(expected);
  });
  it("refuses identity mismatch and missing admission fields", () => {
    expect(() =>
      parseNativeLanding(raw, { ...context, repo: "another" })
    ).toThrow("canonical");
    expect(() =>
      parseNativeLanding(
        {
          data: {
            repository: {
              ...raw.data.repository,
              pullRequest: {
                ...raw.data.repository.pullRequest,
                autoMergeRequest: undefined,
              },
            },
          },
        },
        context
      )
    ).toThrow("autoMergeRequest");
  });
  it("combines classic and effective rules, including an absent integration ID", () => {
    expect(
      parseRequirements(raw, [
        {
          type: "required_status_checks",
          parameters: {
            required_status_checks: [
              { context: "actions", integration_id: 15368 },
              { context: "status" },
            ],
          },
        },
      ])
    ).toEqual([
      { context: "classic", appId: "any" },
      { context: "actions", appId: 15368 },
      { context: "status", appId: "any" },
    ]);
  });
  it("does not accept another app with the required context name", () => {
    const check = passingCheck("test");
    expect(
      requiredCheckResult({ context: "test", appId: 15368 }, [
        { check, producer: { appId: 9, slug: "other" } },
      ])
    ).toEqual({ state: "pending", producer: "unknown", links: [] });
    expect(
      requiredCheckResult({ context: "test", appId: "any" }, [
        { check, producer: "unknown" },
      ])
    ).toEqual({ state: "passed", producer: "unknown", links: [] });
  });
});

describe("native lifecycle observation", () => {
  it("reports readiness separately from admission", async () => {
    expect((await snapshot(native)).landing).toEqual({
      kind: "ready-unadmitted",
      reason: "unknown",
    });
  });
  it("waits on auto-merge despite stale failing head checks", async () => {
    const row = await snapshot(
      { ...native, autoMerge: { enabledAt: "now" } },
      undefined,
      true
    );
    expect(row.landing).toEqual({
      kind: "auto-merge-pending",
      reason: "unknown",
    });
    expect(classifyPr(row).kind).toBe("admitted");
  });
  it("keeps queued candidate unknown in JSON and human output", async () => {
    const row = await snapshot({ ...native, queueEntry: entry });
    expect(row.landing.kind).toBe("queued");
    const verdict = {
      schemaVersion: 1,
      sequence: 1,
      observedAt: "now",
      mode: "single",
      kind: "LANDING",
      terminal: false,
      snapshot: row,
    } as const;
    expect(
      JSON.parse(renderJson(verdict)).snapshot.facts.native.candidate
    ).toBe("unknown");
    expect(renderPretty(verdict)).toContain("candidateSha=unknown");
    expect(renderPretty(verdict)).toContain("reason=unknown");
  });
  it("reports candidate execution while preserving the contribution during recomposition", async () => {
    const previous = await snapshot({
      ...native,
      queueEntry: {
        ...entry,
        state: "AWAITING_CHECKS",
        candidate: { sha: "candidate-1", url: "first" },
      },
    });
    const row = await snapshot(
      {
        ...native,
        currentBaseSha: "advanced-base",
        queueEntry: {
          ...entry,
          state: "AWAITING_CHECKS",
          candidate: { sha: "candidate-2", url: "second" },
        },
      },
      previous
    );
    expect(row.landing.kind).toBe("group-running");
    expect(row.facts.headRefOid).toBe("head");
  });
  it("diagnoses candidate failures without inventing a queue reason", async () => {
    const result = {
      state: "failed",
      producer: { appId: 15368, slug: "github-actions" },
      links: ["run"],
    } as const;
    const row = await snapshot({
      ...native,
      queueEntry: entry,
      requirements: {
        kind: "known",
        checks: [
          {
            context: "test",
            appId: 15368,
            head: { ...result, state: "passed" },
            candidate: result,
          },
        ],
      },
    });
    expect(row.landing).toEqual({ kind: "failed", reason: "unknown" });
    expect(classifyPr(row)).toMatchObject({
      kind: "blocker",
      blocker: { kind: "native-admission" },
    });
  });
  it("binds observed removal to the unchanged head, not beforeCommit candidate", async () => {
    const previous = await snapshot({ ...native, queueEntry: entry });
    const row = await snapshot(
      {
        ...native,
        lastQueueEvent: {
          kind: "removed",
          createdAt: "2026-10-02T10:01:00Z",
          reason: "unknown",
          removedCandidateSha: "candidate-not-head",
        },
      },
      previous
    );
    expect(row.landing).toEqual({
      kind: "removed",
      reason: "unknown",
      headBinding: "current",
    });
    expect(classifyPr(row).kind).toBe("blocker");
    const newHead = await snapshot(
      {
        ...native,
        headSha: "new-head",
        lastQueueEvent: {
          kind: "removed",
          createdAt: "2026-10-02T10:01:00Z",
          reason: "unknown",
          removedCandidateSha: "candidate-not-head",
        },
      },
      row
    );
    expect(newHead.landing).toEqual({
      kind: "removed",
      reason: "unknown",
      headBinding: "unknown",
    });
    expect(classifyPr(newHead).kind).toBe("ready");
  });
  it("retains literal removal reason and leaves historical head binding unknown", async () => {
    const row = await snapshot({
      ...native,
      lastQueueEvent: {
        kind: "removed",
        createdAt: "old",
        reason: "manual",
        removedCandidateSha: "old-candidate",
      },
    });
    expect(row.landing).toEqual({
      kind: "removed",
      reason: "manual",
      headBinding: "unknown",
    });
  });
  it("never treats unavailable requirements as positive readiness", async () => {
    const row = await snapshot({
      ...native,
      requirements: { kind: "unknown", reason: "forbidden" },
    });
    expect(row.landing).toEqual({ kind: "unknown", reason: "unknown" });
    expect(classifyPr(row).kind).toBe("blocker");
  });
  it("waits for a missing required check even when visible CI is green", async () => {
    const result = {
      state: "pending",
      producer: "unknown",
      links: [],
    } as const;
    const row = await snapshot({
      ...native,
      requirements: {
        kind: "known",
        checks: [
          {
            context: "missing",
            appId: 15368,
            head: result,
            candidate: { ...result, state: "unknown" },
          },
        ],
      },
    });
    expect(classifyPr(row).kind).toBe("admitted");
    expect(selectTierMajorStackDecision([row]).kind).toBe("admitted");
  });
  it("keeps watching admitted work until the actual merged state", async () => {
    let reads = 0;
    const reader = fakeReader();
    const events: ProgressVerdict[] = [];
    const verdict = await runQueued({
      contexts: [context],
      options: {
        interval: 1,
        sweepInterval: 5,
        timeout: 10,
        maxQueryErrors: 2,
        allowDraft: false,
      },
      dependencies: {
        reader: {
          ...reader,
          async pullRequest(requested) {
            const facts = await reader.pullRequest(requested);
            reads += 1;
            return reads === 1
              ? { ...facts, native: { ...native, queueEntry: entry } }
              : { ...facts, state: "MERGED", mergedAt: "now" };
          },
        },
        emit: (event) => events.push(event),
        clock: {
          now: () => reads,
          observedAt: () => "now",
          sleep: async () => {},
        },
      },
    });
    expect(verdict.kind).toBe("COMPLETE");
    expect(reads).toBe(2);
  });
});
