import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { UsageError } from "./types.ts";

export interface McpSource {
  readonly name: string;
  readonly url: string;
  readonly tools: readonly string[];
}

/** Task-selected capabilities, not a claim about the host's effective catalog. */
export interface CliCapabilities {
  readonly sourcePath: string;
  readonly sha256: string;
  readonly agentKind: "lane" | "owner";
  readonly web: boolean;
  readonly skills: boolean;
  readonly mcpSources: readonly McpSource[];
  /** Absolute directories the session may read and write beside its cwd, such as a precreated sibling worktree. */
  readonly additionalDirectories: readonly string[];
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new UsageError("Capabilities require a JSON object");
  return Object.fromEntries(Object.entries(value));
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length) throw new UsageError(`Unknown capability fields: ${extra.join(", ")}`);
}
function flag(value: unknown, name: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new UsageError(`${name} must be boolean`);
  return value;
}
const NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;
function name(value: unknown): string {
  if (typeof value !== "string" || !NAME.test(value)) throw new UsageError("MCP source and tool names must start with a letter and contain letters, digits, underscores or hyphens");
  return value;
}

function directory(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value)) throw new UsageError("additionalDirectories entries must be absolute paths");
  const path = resolve(value);
  let stat;
  try { stat = statSync(path); } catch { throw new UsageError(`additional directory does not exist: ${path}`); }
  if (!stat.isDirectory()) throw new UsageError(`additional directory is not a directory: ${path}`);
  return path;
}

export function readCapabilities(path: string): CliCapabilities {
  const sourcePath = resolve(path), raw = readFileSync(sourcePath, "utf8");
  const value = object(JSON.parse(raw));
  keys(value, ["schemaVersion", "agentKind", "web", "skills", "mcpSources", "additionalDirectories"]);
  if (value.schemaVersion !== 1) throw new UsageError("Capabilities require schemaVersion 1");
  const agentKind = value.agentKind ?? "lane";
  if (agentKind !== "lane" && agentKind !== "owner") throw new UsageError("agentKind must be lane or owner");
  const sources = value.mcpSources ?? [];
  if (!Array.isArray(sources)) throw new UsageError("mcpSources must be an array");
  const mcpSources = sources.map((entry): McpSource => {
    const source = object(entry); keys(source, ["name", "url", "tools"]);
    if (typeof source.url !== "string") throw new UsageError("MCP source requires a URL");
    const url = new URL(source.url);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
      || url.username || url.password || url.search || url.hash) throw new UsageError("MCP source requires HTTPS or loopback HTTP without credentials, query or fragment");
    if (!Array.isArray(source.tools) || source.tools.length === 0) throw new UsageError("MCP source requires explicit tool names");
    const tools = source.tools.map(name);
    if (new Set(tools).size !== tools.length) throw new UsageError("Duplicate MCP tool name");
    return { name: name(source.name), url: url.href, tools };
  });
  if (new Set(mcpSources.map((source) => source.name)).size !== mcpSources.length) throw new UsageError("Duplicate MCP source name");
  const directories = value.additionalDirectories ?? [];
  if (!Array.isArray(directories)) throw new UsageError("additionalDirectories must be an array");
  const additionalDirectories = directories.map(directory);
  if (new Set(additionalDirectories).size !== additionalDirectories.length) throw new UsageError("Duplicate additional directory");
  return { sourcePath, sha256: createHash("sha256").update(raw).digest("hex"), agentKind,
    web: flag(value.web, "web"), skills: flag(value.skills, "skills"), mcpSources, additionalDirectories };
}

export function validateCapabilities(provider: string, capabilities: CliCapabilities | undefined): void {
  if (capabilities === undefined) return;
  if (provider === "grok" && (capabilities.agentKind === "owner" || capabilities.skills || capabilities.mcpSources.length || capabilities.additionalDirectories.length)) {
    throw new UsageError("Grok CLI task capabilities currently support web only; use its native owner/skills/source route, its assigned cwd for directory access, or the explicit T3 ACP attachment where applicable");
  }
}

/** One `--add-dir` per directory: repeated flags accumulate in Claude Code 2.1.292 and Codex 0.161.0 (measured 2026-10-08). */
function addDirArgs(capabilities: CliCapabilities): string[] {
  return capabilities.additionalDirectories.flatMap((path) => ["--add-dir", path]);
}

export function codexCapabilityArgs(capabilities: CliCapabilities | undefined): string[] {
  if (capabilities === undefined) return [];
  return ["--config", `web_search=${JSON.stringify(capabilities.web ? "live" : "disabled")}`,
    ...capabilities.mcpSources.flatMap((source) => [
      "--config", `mcp_servers.${source.name}.url=${JSON.stringify(source.url)}`,
      "--config", `mcp_servers.${source.name}.enabled_tools=${JSON.stringify(source.tools)}`,
    ]),
    ...addDirArgs(capabilities)];
}

export function claudeCapabilityTools(capabilities: CliCapabilities | undefined): { available: string[]; denied: string[] } {
  const groups = [
    { enabled: capabilities?.agentKind === "owner", tools: ["Agent", "ListAgents", "TaskStop", "SendMessage"], denyWhenDisabled: true },
    { enabled: capabilities?.web, tools: ["WebSearch", "WebFetch"], denyWhenDisabled: true },
    { enabled: capabilities?.skills, tools: ["Skill"], denyWhenDisabled: false },
  ];
  return {
    available: groups.filter((group) => group.enabled).flatMap((group) => group.tools),
    denied: groups.filter((group) => !group.enabled && group.denyWhenDisabled).flatMap((group) => group.tools),
  };
}

export function claudeCapabilityArgs(capabilities: CliCapabilities | undefined): string[] {
  if (capabilities === undefined) return [];
  const allowed = [
    ...claudeCapabilityTools(capabilities).available,
    ...capabilities.mcpSources.flatMap((source) => source.tools.map((tool) => `mcp__${source.name}__${tool}`)),
  ];
  const servers = Object.fromEntries(capabilities.mcpSources.map((source) => [source.name, { type: "http", url: source.url }]));
  return [...(capabilities.agentKind === "owner" ? ["--verbose"] : []),
    ...addDirArgs(capabilities),
    ...(capabilities.mcpSources.length ? ["--mcp-config", JSON.stringify({ mcpServers: servers })] : []),
    ...(allowed.length ? ["--allowedTools", allowed.join(",")] : [])];
}
