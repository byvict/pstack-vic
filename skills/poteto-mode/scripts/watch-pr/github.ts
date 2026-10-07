import { spawn } from "node:child_process";
import type * as T from "./types.ts";
import { nonEmpty, parsePrNumber } from "./types.ts";
export const REVIEW_THREADS_QUERY =
  "\nquery ReviewThreads($owner: String!, $repo: String!, $pr: Int!) {\n  repository(owner: $owner, name: $repo) {\n    pullRequest(number: $pr) {\n      reviewThreads(first: 100) {\n        nodes {\n          id\n          isResolved\n          comments(first: 10) {\n            nodes {\n              body\n              createdAt\n              path\n              line\n              author { login }\n            }\n          }\n        }\n      }\n    }\n  }\n}\n";
export const PR_COMMIT_STATUS_QUERY =
  "\nquery PrCommitStatuses($owner: String!, $repo: String!, $pr: Int!) {\n  repository(owner: $owner, name: $repo) {\n    pullRequest(number: $pr) {\n      commits(last: 50) {\n        nodes {\n          commit {\n            oid\n            statusCheckRollup {\n              state\n            }\n          }\n        }\n      }\n    }\n  }\n}\n";
export const PR_CHECK_ROLLUP_QUERY =
  "\nquery PrCheckRollup($owner: String!, $repo: String!, $pr: Int!, $after: String) {\n  repository(owner: $owner, name: $repo) {\n    pullRequest(number: $pr) {\n      commits(last: 1) {\n        nodes {\n          commit {\n            statusCheckRollup {\n              contexts(first: 100, after: $after) {\n                pageInfo {\n                  hasNextPage\n                  endCursor\n                }\n                nodes {\n                  __typename\n                  ... on CheckRun {\n                    name\n                    status\n                    conclusion\n                    detailsUrl\n                  }\n                  ... on StatusContext {\n                    context\n                    state\n                    targetUrl\n                  }\n                }\n              }\n            }\n          }\n        }\n      }\n    }\n  }\n}\n";

export const PR_NATIVE_QUERY = `
query NativeAdmission($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    nameWithOwner
    pullRequest(number: $pr) {
      id number url mergeable mergeStateStatus reviewDecision
      headRefOid headRefName baseRefName baseRefOid state mergedAt isDraft
      baseRef { target { oid } branchProtectionRule {
        requiredStatusChecks { context app { databaseId slug } }
      } }
      autoMergeRequest { enabledAt }
      mergeQueueEntry {
        id state position enqueuedAt
        headCommit { oid url } baseCommit { oid url }
      }
      timelineItems(last: 1, itemTypes: [ADDED_TO_MERGE_QUEUE_EVENT, REMOVED_FROM_MERGE_QUEUE_EVENT]) {
        nodes {
          __typename
          ... on AddedToMergeQueueEvent { createdAt }
          ... on RemovedFromMergeQueueEvent { createdAt reason beforeCommit { oid } }
        }
      }
    }
  }
}`;
const COMMIT_CHECKS_QUERY = `
query NativeChecks($owner: String!, $repo: String!, $sha: String!, $after: String) {
  repository(owner: $owner, name: $repo) {
    object(expression: $sha) {
      ... on Commit {
        oid statusCheckRollup {
          contexts(first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              __typename
              ... on CheckRun {
                name status conclusion detailsUrl startedAt
                checkSuite { app { databaseId slug } workflowRun { event workflow { id } } }
              }
              ... on StatusContext { context state targetUrl }
            }
          }
        }
      }
    }
  }
}`;
interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}
export class WatcherQueryError extends Error {
  readonly failure: T.QueryFailure;
  constructor(failure: T.QueryFailure) {
    super(failure.detail);
    this.name = "WatcherQueryError";
    this.failure = failure;
  }
}
export class ChecksUnavailable extends WatcherQueryError {
  constructor(detail: string) {
    super({ kind: "checks-unavailable", retryable: true, detail });
    this.name = "ChecksUnavailable";
  }
}
const firstLine = (value: string): string =>
  value.trim().split(/\r?\n/, 1)[0]?.slice(0, 240) ?? "";
function run(argv: readonly [string, ...string[]]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}
function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new WatcherQueryError({
      kind: "json-parse",
      retryable: true,
      detail: `${label}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}
async function runJson(argv: readonly [string, ...string[]]): Promise<unknown> {
  const result = await run(argv);
  if (result.code !== 0)
    throw new WatcherQueryError({
      kind: "command-exit",
      retryable: true,
      code: result.code,
      detail:
        firstLine(result.stderr) || `${argv.join(" ")} exited ${result.code}`,
    });
  return parseJson(result.stdout, argv.join(" "));
}
function raw(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
function missing(path: string, value?: unknown): never {
  throw new WatcherQueryError({
    kind: "missing-key",
    retryable: true,
    detail:
      value === undefined
        ? `missing ${path}`
        : `invalid ${path}: ${raw(value)}`,
    ...(value === undefined ? {} : { rawValue: raw(value) }),
  });
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) missing(path, value);
  return value;
}
function list(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) missing(path, value);
  return value;
}
function at(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    const object = record(current, path.join("."));
    if (!(key in object)) missing(path.join("."));
    current = object[key];
  }
  return current;
}
function string(value: unknown, path: string): string {
  if (typeof value !== "string") missing(path, value);
  return value;
}
const optionalString = (value: unknown, path: string): string | null =>
  value === null ? null : string(value, path);
function enumValue<const V extends readonly string[]>(
  value: unknown,
  values: V,
  path: string
): V[number] {
  if (typeof value === "string")
    for (const candidate of values) if (candidate === value) return candidate;
  return missing(path, value);
}
const nullableEnum = <const V extends readonly string[]>(
  value: unknown,
  values: V,
  path: string
): V[number] | null => (value === null ? null : enumValue(value, values, path));
const MERGE_STATES = [
  "BEHIND",
  "BLOCKED",
  "CLEAN",
  "CONFLICTING",
  "DIRTY",
  "DRAFT",
  "HAS_HOOKS",
  "UNKNOWN",
  "UNSTABLE",
] as const satisfies readonly T.MergeStateStatus[];
const ROLLUP_STATES = [
  "ERROR",
  "EXPECTED",
  "FAILURE",
  "PENDING",
  "SUCCESS",
] as const;
const REVIEW_DECISIONS = [
  "APPROVED",
  "CHANGES_REQUESTED",
  "REVIEW_REQUIRED",
] as const;
// `gh pr view` reports no review decision as "", not null. Only this field does
// it, so the normalization stays here rather than in nullableEnum, where it
// would stop a genuinely unexpected rollup state from failing closed.
const reviewDecision = (value: unknown): T.ReviewDecision =>
  nullableEnum(
    value === "" ? null : value,
    REVIEW_DECISIONS,
    "pull request.reviewDecision"
  );
function parseRemote(value: string): T.Repository | null {
  let normalized = value.trim();
  if (normalized.startsWith("git@github.com:"))
    normalized = `https://github.com/${normalized.slice(15)}`;
  if (normalized.startsWith("ssh://git@github.com/"))
    normalized = `https://github.com/${normalized.slice(21)}`;
  try {
    const url = new URL(normalized);
    const parts = url.pathname
      .replace(/\.git$/, "")
      .split("/")
      .filter(Boolean);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      parts.length !== 2
    )
      return null;
    return { owner: parts[0], repo: parts[1] };
  } catch {
    return null;
  }
}
function parsePrUrl(value: string): T.PrContext {
  try {
    const url = new URL(value);
    const parts = url.pathname.split("/").filter(Boolean);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      parts.length !== 4 ||
      parts[2] !== "pull"
    )
      throw new Error("not a canonical GitHub pull URL");
    return {
      owner: parts[0],
      repo: parts[1],
      number: parsePrNumber(Number(parts[3])),
    };
  } catch (error) {
    throw new WatcherQueryError({
      kind: "invalid-context-url",
      retryable: false,
      rawValue: value,
      detail: `could not infer owner/repo from PR URL: ${value} (${error instanceof Error ? error.message : String(error)})`,
    });
  }
}
function checkDetails(value: Record<string, unknown>, nameKey: string) {
  return {
    name: string(value[nameKey], nameKey),
    description: typeof value.description === "string" ? value.description : "",
    link:
      typeof value.link === "string"
        ? value.link
        : typeof value.detailsUrl === "string"
          ? value.detailsUrl
          : "",
    workflow: typeof value.workflow === "string" ? value.workflow : "",
  };
}
export function parseFastCheck(value: unknown): T.Check {
  const object = record(value, "check");
  const details = checkDetails(object, "name");
  const state = string(object.state, "check.state").toUpperCase();
  const bucket = string(object.bucket, "check.bucket");
  if (
    bucket === "fail" ||
    ["FAILURE", "ERROR", "ACTION_REQUIRED"].includes(state)
  )
    return { ...details, kind: "failed", reportedState: state };
  if (bucket === "pending") return pendingOrGate(details, state);
  if (bucket === "pass")
    return { ...details, kind: "passed", reportedState: state };
  if (bucket === "skipping")
    return { ...details, kind: "skipped", reportedState: state };
  return { ...details, kind: "failed", reportedState: state };
}
// The owner-approval gate is excluded from pending everywhere, so the rule has
// one home. Classifying it as pending on either read path makes the watcher
// wait on a human, which is the behaviour #172004 removed from the Python.
function pendingOrGate(
  details: {
    readonly name: string;
    readonly description: string;
    readonly link: string;
    readonly workflow: string;
  },
  reportedState: string
): T.Check {
  return details.name === "Code Review Gate"
    ? {
        ...details,
        kind: "code-review-gate",
        name: "Code Review Gate",
        reportedState,
      }
    : { ...details, kind: "pending", reportedState };
}
export function mapRollupNode(value: unknown): T.Check | null {
  const object = record(value, "rollup node");
  const typename = object.__typename;
  if (typename !== "CheckRun" && typename !== "StatusContext") return null;
  const details = checkDetails(
    object,
    typename === "CheckRun" ? "name" : "context"
  );
  const link =
    typeof object.targetUrl === "string" ? object.targetUrl : details.link;
  if (typename === "CheckRun") {
    const status =
      typeof object.status === "string" ? object.status.toUpperCase() : "";
    const conclusion =
      typeof object.conclusion === "string"
        ? object.conclusion.toUpperCase()
        : "";
    if (status !== "COMPLETED")
      return pendingOrGate({ ...details, link }, "PENDING");
    if (conclusion === "SUCCESS")
      return { ...details, link, kind: "passed", reportedState: "SUCCESS" };
    if (conclusion === "NEUTRAL" || conclusion === "SKIPPED")
      return { ...details, link, kind: "skipped", reportedState: conclusion };
    return {
      ...details,
      link,
      kind: "failed",
      reportedState: conclusion === "ACTION_REQUIRED" ? conclusion : "FAILURE",
    };
  }
  const state =
    typeof object.state === "string" ? object.state.toUpperCase() : "";
  if (state === "PENDING" || state === "EXPECTED")
    return pendingOrGate({ ...details, link }, "PENDING");
  return state === "SUCCESS"
    ? { ...details, link, kind: "passed", reportedState: state }
    : { ...details, link, kind: "failed", reportedState: state || "FAILURE" };
}
function parseComment(value: unknown): T.ReviewComment {
  const object = record(value, "review comment");
  const author =
    object.author === null
      ? null
      : record(object.author, "review comment.author");
  return {
    authorLogin:
      author === null
        ? null
        : optionalString(author.login, "review comment.author.login"),
    body: string(object.body, "review comment.body"),
    path: optionalString(object.path, "review comment.path"),
    line:
      object.line === null
        ? null
        : Number.isInteger(object.line)
          ? Number(object.line)
          : missing("review comment.line", object.line),
    createdAt: string(object.createdAt, "review comment.createdAt"),
  };
}
function isBugbot(comment: T.ReviewComment | null): boolean {
  if (comment === null) return false;
  const author = (comment.authorLogin ?? "").toLowerCase();
  const body = comment.body.toLowerCase();
  return (
    author.includes("bugbot") ||
    (author === "cursor" &&
      [
        "bugbot",
        "cursor_automation_id",
        "agentic security review",
        "description start",
        "severity",
      ].some((token) => body.includes(token)))
  );
}
function passKey(comment: T.ReviewComment | null): string | null {
  if (comment === null) return null;
  for (const pattern of [
    /RUN_ID:\s*([a-zA-Z0-9_.:-]+)/,
    /CURSOR_AUTOMATION_ID:\s*([a-zA-Z0-9_.:-]+)/,
  ]) {
    const match = pattern.exec(comment.body);
    if (match?.[1]) return match[1];
  }
  return null;
}
export function parseReviewThreads(value: unknown): readonly T.ReviewThread[] {
  const nodes = list(
    at(value, ["data", "repository", "pullRequest", "reviewThreads", "nodes"]),
    "reviewThreads.nodes"
  );
  const threads: {
    readonly id: string;
    readonly firstComment: T.ReviewComment | null;
    readonly resolved: boolean;
  }[] = [];
  for (const node of nodes) {
    const thread = record(node, "review thread");
    if (typeof thread.isResolved !== "boolean")
      missing("review thread.isResolved", thread.isResolved);
    const comments = list(
      at(thread, ["comments", "nodes"]),
      "review thread.comments.nodes"
    );
    threads.push({
      id: string(thread.id, "review thread.id"),
      firstComment: comments.length === 0 ? null : parseComment(comments[0]),
      resolved: thread.isResolved,
    });
  }
  const keys = new Set<string>();
  let keyless = false;
  for (const thread of threads) {
    if (!isBugbot(thread.firstComment)) continue;
    const key = passKey(thread.firstComment);
    if (key === null) keyless = true;
    else keys.add(key);
  }
  const passes = keys.size > 0 ? keys.size : keyless ? 1 : 0;
  return threads
    .filter((thread) => !thread.resolved)
    .map(({ id, firstComment }) => ({
      id,
      firstComment,
      isBugbot: isBugbot(firstComment),
      bugbotReviewPasses: passes,
    }));
}
export function parsePullRequest(
  value: unknown,
  context: T.PrContext
): T.PullRequestFacts {
  const object = record(value, "pull request");
  if (typeof object.isDraft !== "boolean")
    missing("pull request.isDraft", object.isDraft);
  return {
    context,
    native: { kind: "unknown", reason: "native admission was not read" },
    mergeable: enumValue(
      object.mergeable,
      ["MERGEABLE", "CONFLICTING", "UNKNOWN"] as const,
      "pull request.mergeable"
    ),
    mergeStateStatus: enumValue(
      object.mergeStateStatus,
      MERGE_STATES,
      "pull request.mergeStateStatus"
    ),
    reviewDecision: reviewDecision(object.reviewDecision),
    headRefOid: optionalString(object.headRefOid, "pull request.headRefOid"),
    headRefName: string(object.headRefName, "pull request.headRefName"),
    baseRefName: string(object.baseRefName, "pull request.baseRefName"),
    state: enumValue(
      object.state,
      ["OPEN", "CLOSED", "MERGED"] as const,
      "pull request.state"
    ),
    mergedAt: optionalString(object.mergedAt, "pull request.mergedAt"),
    isDraft: object.isDraft,
  };
}
function positiveId(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0)
    missing(path, value);
  return value;
}
function queueCommit(value: unknown): T.NativeQueueEntry["candidate"] {
  if (value === null || value === undefined) return "unknown";
  const commit = record(value, "queue commit");
  return {
    sha: string(commit.oid, "queue commit.oid"),
    url: string(commit.url, "queue commit.url"),
  };
}
export function parseNativeLanding(
  value: unknown,
  context: T.PrContext
): Omit<Extract<T.NativeLandingFacts, { kind: "observed" }>, "requirements"> {
  const repository = record(at(value, ["data", "repository"]), "repository");
  const pr = record(repository.pullRequest, "pull request");
  const repositoryName = string(
    repository.nameWithOwner,
    "repository.nameWithOwner"
  );
  const number = parsePrNumber(pr.number);
  const url = string(pr.url, "pull request.url");
  const parsedUrl = parsePrUrl(url);
  if (
    repositoryName.toLowerCase() !==
      `${context.owner}/${context.repo}`.toLowerCase() ||
    number !== context.number ||
    parsedUrl.number !== context.number ||
    `${parsedUrl.owner}/${parsedUrl.repo}`.toLowerCase() !==
      repositoryName.toLowerCase()
  )
    missing("canonical pull request identity", pr);
  const base =
    pr.baseRef === null ? null : record(pr.baseRef, "pull request.baseRef");
  const auto =
    pr.autoMergeRequest === null
      ? null
      : record(pr.autoMergeRequest, "autoMergeRequest");
  const queue =
    pr.mergeQueueEntry === null
      ? null
      : record(pr.mergeQueueEntry, "mergeQueueEntry");
  const events = list(at(pr, ["timelineItems", "nodes"]), "queue events");
  let lastQueueEvent: Extract<
    T.NativeLandingFacts,
    { kind: "observed" }
  >["lastQueueEvent"] = null;
  if (events.length > 0) {
    const event = record(events[0], "queue event");
    const createdAt = string(event.createdAt, "queue event.createdAt");
    if (event.__typename === "AddedToMergeQueueEvent")
      lastQueueEvent = { kind: "added", createdAt };
    else if (event.__typename === "RemovedFromMergeQueueEvent")
      lastQueueEvent = {
        kind: "removed",
        createdAt,
        removedCandidateSha:
          event.beforeCommit === null
            ? "unknown"
            : string(
                at(event, ["beforeCommit", "oid"]),
                "queue event.beforeCommit.oid"
              ),
        reason: optionalString(event.reason, "queue event.reason") ?? "unknown",
      };
    else missing("queue event.__typename", event.__typename);
  }
  return {
    kind: "observed",
    repository: repositoryName,
    prNodeId: string(pr.id, "pull request.id"),
    prNumber: number,
    prUrl: url,
    headSha: string(pr.headRefOid, "pull request.headRefOid"),
    baseRef: string(pr.baseRefName, "pull request.baseRefName"),
    prBaseSha: string(pr.baseRefOid, "pull request.baseRefOid"),
    currentBaseSha:
      base === null || base.target === null
        ? "unknown"
        : string(at(base, ["target", "oid"]), "baseRef.target.oid"),
    autoMerge:
      auto === null
        ? null
        : { enabledAt: string(auto.enabledAt, "autoMergeRequest.enabledAt") },
    candidate: queue === null ? "unknown" : queueCommit(queue.headCommit),
    queueEntry:
      queue === null
        ? null
        : {
            id: string(queue.id, "mergeQueueEntry.id"),
            state: enumValue(
              queue.state,
              [
                "QUEUED",
                "AWAITING_CHECKS",
                "LOCKED",
                "MERGEABLE",
                "UNMERGEABLE",
              ],
              "mergeQueueEntry.state"
            ),
            position: positiveId(queue.position, "mergeQueueEntry.position"),
            enqueuedAt: string(queue.enqueuedAt, "mergeQueueEntry.enqueuedAt"),
            candidate: queueCommit(queue.headCommit),
            base: queueCommit(queue.baseCommit),
          },
    lastQueueEvent,
  };
}
interface Requirement {
  readonly context: string;
  readonly appId: number | "any";
}
export function parseRequirements(
  value: unknown,
  rules: unknown
): readonly Requirement[] {
  const pr = at(value, ["data", "repository", "pullRequest"]);
  const base = at(pr, ["baseRef"]);
  if (base === null) missing("baseRef for current requirements");
  const protection = at(base, ["branchProtectionRule"]);
  const checks: Requirement[] =
    protection === null
      ? []
      : list(
          at(protection, ["requiredStatusChecks"]),
          "requiredStatusChecks"
        ).map((value) => {
          const check = record(value, "required status check");
          return {
            context: string(check.context, "required check.context"),
            appId:
              check.app === null
                ? "any"
                : positiveId(
                    at(check, ["app", "databaseId"]),
                    "required check.appId"
                  ),
          };
        });
  for (const value of list(rules, "effective branch rules")) {
    const rule = record(value, "effective branch rule");
    if (rule.type !== "required_status_checks") continue;
    for (const value of list(
      at(rule, ["parameters", "required_status_checks"]),
      "required_status_checks"
    )) {
      const check = record(value, "required status check");
      checks.push({
        context: string(check.context, "required check.context"),
        appId:
          check.integration_id === null || check.integration_id === undefined
            ? "any"
            : positiveId(check.integration_id, "required check.integration_id"),
      });
    }
  }
  return [
    ...new Map(
      checks.map((check) => [`${check.context}:${check.appId}`, check])
    ).values(),
  ];
}
export type ProducedCheck =
  | {
      readonly kind: "status-context";
      readonly check: T.Check;
      readonly producer: "unknown";
    }
  | {
      readonly kind: "check-run";
      readonly check: T.Check;
      readonly producer: T.CheckProducer | "unknown";
      readonly attempt:
        | {
            readonly workflowId: string;
            readonly event: string;
            readonly startedAt: number;
          }
        | "unknown";
    };
export function parseProducedCheck(value: unknown): ProducedCheck {
  const node = record(value, "commit check");
  const check = mapRollupNode(node);
  if (check === null) missing("commit check.__typename", node.__typename);
  if (node.__typename === "StatusContext")
    return { kind: "status-context", check, producer: "unknown" };
  const app = at(node, ["checkSuite", "app"]);
  const run = at(node, ["checkSuite", "workflowRun"]);
  const startedAt = optionalString(node.startedAt, "commit check.startedAt");
  const startTime = startedAt === null ? null : Date.parse(startedAt);
  if (startTime !== null && !Number.isFinite(startTime))
    missing("commit check.startedAt", startedAt);
  return {
    kind: "check-run",
    check,
    producer:
      app === null
        ? "unknown"
        : {
            appId: positiveId(at(app, ["databaseId"]), "check producer.appId"),
            slug: string(at(app, ["slug"]), "check producer.slug"),
          },
    attempt:
      run === null || startTime === null
        ? "unknown"
        : {
            workflowId: string(
              at(run, ["workflow", "id"]),
              "check workflow.id"
            ),
            event: string(at(run, ["event"]), "check workflow.event"),
            startedAt: startTime,
          },
  };
}
function currentAttempts(
  checks: readonly ProducedCheck[]
): readonly ProducedCheck[] {
  const selected = new Map<
    string,
    { readonly startedAt: number; readonly checks: readonly ProducedCheck[] }
  >();
  const separate: ProducedCheck[] = [];
  for (const check of checks) {
    if (
      check.kind !== "check-run" ||
      check.producer === "unknown" ||
      check.attempt === "unknown"
    ) {
      separate.push(check);
      continue;
    }
    const key = JSON.stringify([
      check.producer.appId,
      check.check.name,
      check.attempt.workflowId,
      check.attempt.event,
    ]);
    const prior = selected.get(key);
    if (prior === undefined || check.attempt.startedAt > prior.startedAt)
      selected.set(key, {
        startedAt: check.attempt.startedAt,
        checks: [check],
      });
    else if (check.attempt.startedAt === prior.startedAt)
      selected.set(key, {
        startedAt: prior.startedAt,
        checks: [...prior.checks, check],
      });
  }
  return [...selected.values()]
    .flatMap((bucket) => bucket.checks)
    .concat(separate);
}
export function requiredCheckResult(
  requirement: Requirement,
  checks: readonly ProducedCheck[] | "unknown"
): T.RequiredCheckResult {
  if (checks === "unknown")
    return { state: "unknown", producer: "unknown", links: [] };
  const matching = currentAttempts(checks).filter(
    ({ check, producer }) =>
      check.name === requirement.context &&
      (requirement.appId === "any" ||
        (producer !== "unknown" && producer.appId === requirement.appId))
  );
  if (matching.length === 0)
    return { state: "pending", producer: "unknown", links: [] };
  const ambiguous =
    matching.length > 1 &&
    matching.some(
      (check) => check.kind === "check-run" && check.attempt === "unknown"
    );
  const state = ambiguous
    ? "unknown"
    : matching.some(({ check }) => check.kind === "failed")
      ? "failed"
      : matching.some(
            ({ check }) =>
              check.kind === "pending" || check.kind === "code-review-gate"
          )
        ? "pending"
        : "passed";
  const firstProducer = matching[0].producer;
  const producer =
    firstProducer !== "unknown" &&
    matching.every(
      (check) =>
        check.producer !== "unknown" &&
        check.producer.appId === firstProducer.appId &&
        check.producer.slug === firstProducer.slug
    )
      ? firstProducer
      : "unknown";
  return {
    state,
    producer,
    links: matching.flatMap(({ check }) => (check.link ? [check.link] : [])),
  };
}
async function readProducedChecks(
  context: T.PrContext,
  sha: string
): Promise<readonly ProducedCheck[]> {
  const checks: ProducedCheck[] = [];
  let after: string | null = null;
  do {
    const argv = graphqlArgs(COMMIT_CHECKS_QUERY, context);
    argv.push("-f", `sha=${sha}`);
    if (after !== null) argv.push("-f", `after=${after}`);
    const value = await runJson(argv);
    const commit = record(
      at(value, ["data", "repository", "object"]),
      "commit checks"
    );
    if (commit.oid !== sha) missing("commit checks.oid", commit.oid);
    if (commit.statusCheckRollup === null) return checks;
    const contexts = at(commit, ["statusCheckRollup", "contexts"]);
    for (const value of list(at(contexts, ["nodes"]), "commit check nodes"))
      checks.push(parseProducedCheck(value));
    const page = record(at(contexts, ["pageInfo"]), "commit checks.pageInfo");
    if (typeof page.hasNextPage !== "boolean")
      missing("commit checks.hasNextPage", page.hasNextPage);
    const next = page.hasNextPage
      ? string(page.endCursor, "commit checks.endCursor")
      : null;
    if (next !== null && next === after)
      missing("advancing commit checks cursor", next);
    after = next;
  } while (after !== null);
  return checks;
}
async function readRequirements(
  value: unknown,
  context: T.PrContext,
  native: ReturnType<typeof parseNativeLanding>
): Promise<T.RequiredChecks> {
  try {
    const rules = await runJson([
      "gh",
      "api",
      `repos/${context.owner}/${context.repo}/rules/branches/${encodeURIComponent(native.baseRef)}`,
    ]);
    const requirements = parseRequirements(value, rules);
    if (requirements.length === 0) return { kind: "known", checks: [] };
    const head = await readProducedChecks(context, native.headSha);
    const candidate = native.queueEntry?.candidate;
    const candidateChecks =
      candidate === undefined || candidate === "unknown"
        ? "unknown"
        : candidate.sha === native.headSha
          ? head
          : await readProducedChecks(context, candidate.sha);
    return {
      kind: "known",
      checks: requirements.map((requirement) => ({
        ...requirement,
        head: requiredCheckResult(requirement, head),
        candidate: requiredCheckResult(requirement, candidateChecks),
      })),
    };
  } catch (error) {
    if (!(error instanceof WatcherQueryError)) throw error;
    return { kind: "unknown", reason: error.failure.detail };
  }
}
function graphqlArgs(
  query: string,
  context: T.PrContext
): [string, ...string[]] {
  return [
    "gh",
    "api",
    "graphql",
    "-f",
    `query=${query}`,
    "-f",
    `owner=${context.owner}`,
    "-f",
    `repo=${context.repo}`,
    "-F",
    `pr=${context.number}`,
  ];
}

export class GhGitHubReader implements T.GitHubReader {
  async originRepo(): Promise<T.Repository | null> {
    const result = await run(["git", "remote", "get-url", "origin"]);
    return result.code === 0 ? parseRemote(result.stdout) : null;
  }
  async currentPr(pr: T.PrNumber | null): Promise<T.PrContext> {
    const argv: [string, ...string[]] = ["gh", "pr", "view"];
    if (pr !== null) argv.push(String(pr));
    argv.push("--json", "number,url");
    const object = record(await runJson(argv), "current PR");
    const parsed = parsePrUrl(string(object.url, "current PR.url"));
    return {
      ...parsed,
      number: pr ?? parsePrNumber(object.number, "current PR.number"),
    };
  }
  async pullRequest(context: T.PrContext): Promise<T.PullRequestFacts> {
    try {
      const value = await runJson(graphqlArgs(PR_NATIVE_QUERY, context));
      const native = parseNativeLanding(value, context);
      return {
        ...parsePullRequest(
          at(value, ["data", "repository", "pullRequest"]),
          context
        ),
        native: {
          ...native,
          requirements: await readRequirements(value, context, native),
        },
      };
    } catch (error) {
      if (!(error instanceof WatcherQueryError)) throw error;
      // Optional landing fields must not make the upstream PR facts unreadable.
      const facts = parsePullRequest(
        await runJson([
          "gh", "pr", "view", String(context.number), "--repo",
          `${context.owner}/${context.repo}`, "--json",
          "mergeable,mergeStateStatus,reviewDecision,headRefOid,headRefName,baseRefName,state,mergedAt,isDraft",
        ]),
        context
      );
      return { ...facts, native: { kind: "unknown", reason: error.failure.detail } };
    }
  }
  async openPullRequests(
    repository: T.Repository
  ): Promise<readonly T.OpenPullRequest[]> {
    const value = await runJson([
      "gh",
      "pr",
      "list",
      "--repo",
      `${repository.owner}/${repository.repo}`,
      "--state",
      "open",
      "--limit",
      "300",
      "--json",
      "number,headRefName,baseRefName",
    ]);
    return list(value, "open PRs").map((item, index) => {
      const object = record(item, `open PRs[${index}]`);
      return {
        number: parsePrNumber(object.number, `open PRs[${index}].number`),
        headRefName: string(
          object.headRefName,
          `open PRs[${index}].headRefName`
        ),
        baseRefName: string(
          object.baseRefName,
          `open PRs[${index}].baseRefName`
        ),
      };
    });
  }
  async checksFastPath(context: T.PrContext): Promise<T.ChecksFastPath> {
    const result = await run([
      "gh",
      "pr",
      "checks",
      String(context.number),
      "--repo",
      `${context.owner}/${context.repo}`,
      "--json",
      "name,state,description,link,workflow,bucket",
    ]);
    if ([0, 1, 8].includes(result.code) && result.stdout.trim()) {
      try {
        const value = parseJson(result.stdout, "gh pr checks");
        if (Array.isArray(value))
          return { kind: "checks", checks: value.map(parseFastCheck) };
      } catch (error) {
        if (!(error instanceof WatcherQueryError)) throw error;
      }
    }
    return { kind: "unusable", exitCode: result.code, stderr: result.stderr };
  }
  async checkRollupPage(
    context: T.PrContext,
    after: string | null
  ): Promise<T.RollupPage> {
    const argv = graphqlArgs(PR_CHECK_ROLLUP_QUERY, context);
    if (after !== null) argv.push("-f", `after=${after}`);
    const value = await runJson(argv);
    const commits = list(
      at(value, ["data", "repository", "pullRequest", "commits", "nodes"]),
      "commits.nodes"
    );
    if (commits.length === 0) return { checks: [], endCursor: null };
    const commit = record(
      at(commits[commits.length - 1], ["commit"]),
      "commit"
    );
    if (commit.statusCheckRollup === null)
      return { checks: [], endCursor: null };
    const contexts = record(
      at(commit, ["statusCheckRollup", "contexts"]),
      "contexts"
    );
    const checks = list(contexts.nodes, "contexts.nodes")
      .map(mapRollupNode)
      .filter((check): check is T.Check => check !== null);
    const page = record(contexts.pageInfo, "contexts.pageInfo");
    if (typeof page.hasNextPage !== "boolean")
      missing("contexts.pageInfo.hasNextPage", page.hasNextPage);
    const cursor = optionalString(
      page.endCursor,
      "contexts.pageInfo.endCursor"
    );
    return { checks, endCursor: page.hasNextPage && cursor ? cursor : null };
  }
  async reviewThreads(
    context: T.PrContext
  ): Promise<readonly T.ReviewThread[]> {
    return parseReviewThreads(
      await runJson(graphqlArgs(REVIEW_THREADS_QUERY, context))
    );
  }
  async commitRollups(
    context: T.PrContext
  ): Promise<readonly T.CommitRollup[]> {
    const value = await runJson(graphqlArgs(PR_COMMIT_STATUS_QUERY, context));
    const commits = list(
      at(value, ["data", "repository", "pullRequest", "commits", "nodes"]),
      "commits.nodes"
    );
    return commits.map((item, index) => {
      const commit = record(at(item, ["commit"]), `commits[${index}].commit`);
      const rollup = commit.statusCheckRollup;
      return {
        oid: string(commit.oid, `commits[${index}].oid`),
        state:
          rollup === null
            ? null
            : nullableEnum(
                at(rollup, ["state"]),
                ROLLUP_STATES,
                `commits[${index}].statusCheckRollup.state`
              ),
      };
    });
  }
}

export async function resolveChecks(
  reader: T.GitHubReader,
  context: T.PrContext
): Promise<T.CheckRead> {
  const fast = await reader.checksFastPath(context);
  const direct = fast.kind === "checks" ? nonEmpty(fast.checks) : null;
  if (direct !== null) return { source: "gh-pr-checks", checks: direct };
  const checks: T.Check[] = [];
  let after: string | null = null;
  do {
    const page = await reader.checkRollupPage(context, after);
    checks.push(...page.checks);
    after = page.endCursor;
  } while (after !== null);
  const fallback = nonEmpty(checks);
  if (fallback !== null) return { source: "graphql-rollup", checks: fallback };
  const suffix =
    fast.kind === "unusable"
      ? `fast path exit=${fast.exitCode}; GraphQL rollup was empty${firstLine(fast.stderr) ? `; ${firstLine(fast.stderr)}` : ""}`
      : "fast path and GraphQL rollup were empty";
  throw new ChecksUnavailable(`could not read PR checks: ${suffix}`);
}
export async function resolveContext(args: {
  readonly reader: T.GitHubReader;
  readonly owner: string | null;
  readonly repo: string | null;
  readonly pr: T.PrNumber | null;
}): Promise<T.PrContext> {
  if (args.pr !== null && args.owner !== null && args.repo !== null)
    return { owner: args.owner, repo: args.repo, number: args.pr };
  if (args.pr !== null) {
    const origin = await args.reader.originRepo();
    if (origin !== null)
      return {
        owner: args.owner ?? origin.owner,
        repo: args.repo ?? origin.repo,
        number: args.pr,
      };
  }
  const inferred = await args.reader.currentPr(args.pr);
  return {
    owner: args.owner ?? inferred.owner,
    repo: args.repo ?? inferred.repo,
    number: args.pr ?? inferred.number,
  };
}
export function orderStack(
  context: T.PrContext,
  open: readonly T.OpenPullRequest[]
): T.NonEmpty<T.PrContext> {
  const byNumber = new Map(open.map((pr) => [pr.number, pr]));
  const byHead = new Map(open.map((pr) => [pr.headRefName, pr]));
  const children = new Map<string, T.OpenPullRequest[]>();
  for (const pr of open)
    children.set(pr.baseRefName, [...(children.get(pr.baseRefName) ?? []), pr]);
  for (const values of children.values())
    values.sort((a, b) => a.number - b.number);
  const start = byNumber.get(context.number);
  if (start === undefined) return [context];
  const down: T.OpenPullRequest[] = [];
  let current = start;
  while (byHead.has(current.baseRefName)) {
    const parent = byHead.get(current.baseRefName);
    if (parent === undefined) break;
    down.push(parent);
    current = parent;
  }
  const seen = new Set<T.PrNumber>([
    ...down.map((pr) => pr.number),
    start.number,
  ]);
  const up: T.OpenPullRequest[] = [];
  const visit = (parent: T.OpenPullRequest): void => {
    for (const child of children.get(parent.headRefName) ?? []) {
      if (seen.has(child.number)) continue;
      seen.add(child.number);
      up.push(child);
      visit(child);
    }
  };
  visit(start);
  return (
    nonEmpty(
      [...down.reverse(), start, ...up].map((pr) => ({
        ...context,
        number: pr.number,
      }))
    ) ?? [context]
  );
}
export async function discoverStack(
  reader: T.GitHubReader,
  context: T.PrContext
): Promise<T.NonEmpty<T.PrContext>> {
  return orderStack(context, await reader.openPullRequests(context));
}
