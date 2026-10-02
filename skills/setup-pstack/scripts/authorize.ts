#!/usr/bin/env node
// Under pstack's playbooks an agent merges a pull request that no human
// approved: an autopilot owner after the root's clean swarm verdict, or the
// session running the Shipping playbook after the verdict of that pull
// request's independent verifier. Claude Code's auto mode blocks that by
// default, and its classifier reads the user's messages and the commands,
// never the agent's questions, so it stops the autopilot and the Shipping
// playbook at the merge until the operator records the decision where the
// classifier reads it: one entry in `autoMode.allow` of the operator's own
// `~/.claude/settings.json`. Claude Code reads that list from no repository
// and from no plugin, so the entry has to be the operator's act.

import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

class AuthorizeError extends Error {}
class CliUsageError extends Error {}

function fail(message: string): never {
  throw new AuthorizeError(message);
}

function usage(message: string): never {
  throw new CliUsageError(message);
}

const GRANT_NAME = "pstack standing authorization";
const GRANT_VERSION = 2;
export const MARKER = `${GRANT_NAME} v${GRANT_VERSION}`;

export const ALLOW_ENTRY = `${MARKER}: the operator who wrote this entry is the only human on their projects. This authorization applies in every repository a session works in. Under pstack's playbooks, an agent may merge a pull request without routine human approval in two cases. An autopilot owner may merge its own pull request after the root's clean swarm verdict from verifiers who did not write the code. The session running the Shipping playbook may merge after the independent per-PR verifier verdict. In both cases, the current independent verdict and all current required checks pass before submission. Every operator-named merge hold remains in force, including reserved review and the merge click. The agent binds GH_HOST to the validated host and uses gh pr merge --repo <owner/name> <pr> --squash --match-head-commit <published-head> --body-file <captured-pr-body-file>, following Shipping's direct-merge and native-queue body rules. The root may spawn owner and verifier subagents and post verdicts as pull request comments. It may push an owner's branch to the validated push URL with --force-with-lease=refs/heads/<branch>:<captured-remote-head>, captured before rewriting and equal to the local pre-rewrite head. The current local branch and the explicit source and destination refs must identify that same owned branch. URL rewrite configuration is unsupported and must be refused before transport. None of that is Merge Without Review or Self-Approval. An agent may also launch the lanes pstack's playbooks name through pstack-runner (an owner, a verifier, a reviewer, a judge or a worker on claude, codex or grok, in the mode the playbook names), which is not Create Unsafe Agents. This covers nothing else: not --admin or any other way around a required check, not a change to branch protection, rulesets or required checks, and nothing the other rules protect (destroying files, branches or history, production systems, secrets, data leaving the trust boundary).`;

const BUILT_IN_RULES = "$defaults";

const TARGETS: Readonly<Record<string, readonly string[]>> = {
  claude: [".claude", "settings.json"],
  codex: [".codex", "config.toml"],
};

export function settingsPathFor(parent: string, home: string = homedir()): string {
  const target = TARGETS[parent];
  if (!target) usage(`--parent must be one of ${Object.keys(TARGETS).join(", ")}`);
  return join(home, ...target);
}

export function backupPathFor(parent: string, home: string = homedir()): string {
  return `${settingsPathFor(parent, home)}.before-pstack-authorization`;
}

function readIfExists(path: string): string | null {
  if (!existsSync(path)) return null;
  if (!statSync(path).isFile()) fail(`${path} exists but is not a regular file; resolve it before granting the authorization`);
  return readFileSync(path, "utf8");
}

type Settings = Record<string, unknown>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSettings(text: string | null, path: string): Settings {
  if (text === null) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail(`${path} is not valid JSON; resolve it before granting the authorization`);
  }
  if (!isObject(value)) fail(`${path} does not hold a JSON object; resolve it before granting the authorization`);
  return value;
}

function allowList(settings: Settings, path: string): readonly string[] | null {
  const autoMode = settings.autoMode;
  if (autoMode === undefined) return null;
  if (!isObject(autoMode)) fail(`autoMode in ${path} is not an object; resolve it before granting the authorization`);
  const allow = autoMode.allow;
  if (allow === undefined) return null;
  if (!Array.isArray(allow) || !allow.every((entry): entry is string => typeof entry === "string")) {
    fail(`autoMode.allow in ${path} is not a list of text entries; resolve it before granting the authorization`);
  }
  return allow;
}

function isCurrentGrant(entry: string): boolean {
  return entry === ALLOW_ENTRY;
}

function isGrantOfAnyVersion(entry: string): boolean {
  return entry.startsWith(`${GRANT_NAME} v`);
}

function shellQuote(word: string): string {
  return /^[A-Za-z0-9_\/.:@%+=-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

function grantCommand(): string {
  return [process.execPath, fileURLToPath(import.meta.url), "apply", "--parent", "claude"].map(shellQuote).join(" ");
}

export interface Check {
  readonly parent: string;
  readonly authorized: boolean;
  readonly file: string;
  readonly reason: string;
  readonly entry?: string;
  readonly grant?: string;
}

function codexApprovalPolicy(text: string | null): string | null {
  for (const line of (text ?? "").split("\n")) {
    if (/^\s*\[/.test(line)) return null;
    const match = /^\s*approval_policy\s*=\s*(["'])(.*?)\1/.exec(line);
    if (match) return match[2];
  }
  return null;
}

export function checkAuthorization(parent: string, home: string = homedir()): Check {
  const file = settingsPathFor(parent, home);
  const text = readIfExists(file);
  if (parent === "codex") {
    const policy = codexApprovalPolicy(text);
    if (policy === "never") return { parent, authorized: true, file, reason: 'approval_policy is "never": Codex asks for no approval' };
    const found = policy === null ? "unset" : JSON.stringify(policy);
    return { parent, authorized: false, file, reason: `approval_policy is ${found} at the top level of ${file}: Codex stops this flow to ask for approval unless it is "never"` };
  }
  const granted = (allowList(parseSettings(text, file), file) ?? []).some(isCurrentGrant);
  return {
    parent,
    authorized: granted,
    file,
    reason: granted
      ? `The current ${MARKER} entry is in autoMode.allow`
      : `No ${MARKER} with the current exact body in autoMode.allow of ${file}: an older v2 entry is stale; the operator must review the entry and run the grant command`,
    entry: ALLOW_ENTRY,
    grant: grantCommand(),
  };
}

type GrantOutcome = "created" | "updated" | "unchanged";

function renderGrant(text: string | null, path: string): { readonly text: string; readonly outcome: GrantOutcome } {
  const settings = parseSettings(text, path);
  const current = allowList(settings, path);
  const grants = (current ?? []).filter(isGrantOfAnyVersion);
  if (text !== null && grants.length === 1 && grants[0] === ALLOW_ENTRY) return { text, outcome: "unchanged" };
  const first = current?.findIndex(isGrantOfAnyVersion) ?? -1;
  const allow = current === null
    ? [BUILT_IN_RULES, ALLOW_ENTRY]
    : first === -1
      ? [...current, ALLOW_ENTRY]
      : current.flatMap((entry, index) => (index === first ? [ALLOW_ENTRY] : isGrantOfAnyVersion(entry) ? [] : [entry]));
  const autoMode = { ...(isObject(settings.autoMode) ? settings.autoMode : {}), allow };
  return { text: JSON.stringify({ ...settings, autoMode }, null, 2) + "\n", outcome: first === -1 ? "created" : "updated" };
}

export interface Io {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
  readonly askOnTerminal?: (question: string) => Promise<string>;
}

async function apply(home: string, io: Io): Promise<number> {
  const file = settingsPathFor("claude", home);
  const snapshot = readIfExists(file);
  const rendered = renderGrant(snapshot, file);
  const report = (outcome: GrantOutcome, backup: string | null): void => {
    io.stdout(JSON.stringify({ parent: "claude", file, outcome, backup }, null, 2) + "\n");
  };
  if (rendered.outcome === "unchanged") {
    report("unchanged", null);
    return 0;
  }
  if (!io.askOnTerminal) {
    fail(`apply needs a terminal: the authorization is the operator's act, and an agent does not grant it. Run it yourself on a terminal:\n  ${grantCommand()}`);
  }
  io.stdout(`File: ${file}\nEntry for autoMode.allow:\n\n${ALLOW_ENTRY}\n\n`);
  const answer = (await io.askOnTerminal("Type yes to write it: ")).trim().toLowerCase();
  if (answer !== "yes" && answer !== "sim") {
    io.stderr("Nothing written: the answer was not yes.\n");
    return 1;
  }
  const backup = snapshot === null ? null : backupPathFor("claude", home);
  if (snapshot !== null) writeFileSync(backupPathFor("claude", home), snapshot, { mode: 0o600 });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, rendered.text);
  report(rendered.outcome, backup);
  return 0;
}

const USAGE = `Usage: authorize <check|apply> [options]

  check  --parent <${Object.keys(TARGETS).join("|")}> [--home <dir>]
         Exit 0 when the parent may run the autopilot and the Shipping playbook without a stop for approval, 1 when it may not.
  apply  --parent claude [--home <dir>]
         Add the standing authorization to autoMode.allow of ~/.claude/settings.json.
         Asks for a yes on a terminal; refuses without one.
`;

async function askOnTerminal(question: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await terminal.question(question);
  } finally {
    terminal.close();
  }
}

export async function main(argv: readonly string[], io: Io = {
  stdout: (v) => process.stdout.write(v),
  stderr: (v) => process.stderr.write(v),
  askOnTerminal: process.stdin.isTTY && process.stdout.isTTY ? askOnTerminal : undefined,
}): Promise<number> {
  try {
    const { parseArgs } = await import("node:util");
    let parsed: ReturnType<typeof parseArgs>;
    try {
      parsed = parseArgs({
        args: [...argv],
        allowPositionals: true,
        strict: true,
        options: {
          parent: { type: "string" },
          home: { type: "string" },
          help: { type: "boolean", short: "h", default: false },
        },
      });
    } catch (error) {
      usage(error instanceof Error ? error.message : String(error));
    }
    if (parsed.values.help) {
      io.stdout(USAGE);
      return 0;
    }
    const [command, ...rest] = parsed.positionals;
    if (rest.length > 0) usage(`unexpected arguments: ${rest.join(" ")}`);
    const home = typeof parsed.values.home === "string" ? parsed.values.home : homedir();
    const parent = parsed.values.parent;
    if (command !== "check" && command !== "apply") {
      usage(command === undefined ? "a subcommand is required" : `unknown subcommand ${JSON.stringify(command)}`);
    }
    if (typeof parent !== "string") usage("--parent is required");
    if (command === "check") {
      const check = checkAuthorization(parent, home);
      io.stdout(JSON.stringify(check, null, 2) + "\n");
      return check.authorized ? 0 : 1;
    }
    if (parent !== "claude") usage("apply is for a Claude Code parent; Codex has no authorization list, set approval_policy in ~/.codex/config.toml");
    return await apply(home, io);
  } catch (error) {
    if (error instanceof CliUsageError) {
      io.stderr(`error: ${error.message}\n${USAGE}`);
      return 64;
    }
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`error: ${message}\n`);
    return 1;
  }
}

// Node resolves the main module to its real path and leaves argv[1] as typed.
// Comparing real paths keeps a `check` through a symlinked directory from
// exiting 0, which reads as authorized, without checking anything.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}
