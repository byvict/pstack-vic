import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCapabilities } from "./capabilities.ts";
import { parseArgs } from "./cli.ts";
import { invocationCommand } from "./commands.ts";
import { parseProviderOutput } from "./parse-output.ts";
import { validateRoute } from "./run.ts";
import type { RunnerOptions } from "./types.ts";

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "pstack-capabilities-")); });
afterEach(() => rmSync(directory, { force: true, recursive: true }));
function profile(value: unknown): string {
  const path = join(directory, "capabilities.json"); writeFileSync(path, JSON.stringify(value)); return path;
}
function options(provider: string, value: unknown): RunnerOptions {
  const result = parseArgs(["--parent", "codex", "--provider", provider, "--model", provider === "claude" ? "claude-opus-5-5" : provider === "grok" ? "grok-4.7" : "gpt-6.1-sol",
    "--effort", "xhigh", "--mode", "isolated-write", "--prompt", join(directory, "prompt"), "--cwd", directory,
    "--output", join(directory, "output"), "--receipt", join(directory, "receipt"), "--capabilities", profile(value)]);
  assert.ok(result); return result;
}
const source = { name: "docs", url: "https://developers.openai.com/mcp", tools: ["search_openai_docs"] };

describe("task-selected runner capabilities", () => {
  it("binds the file digest and exact MCP source while preserving the Codex descriptor and sandbox", () => {
    const input = options("codex", { schemaVersion: 1, web: true, skills: true, mcpSources: [source] });
    const { args } = invocationCommand(input);
    assert.match(input.capabilities!.sha256, /^[a-f0-9]{64}$/);
    assert.equal(input.capabilities!.sourcePath, join(directory, "capabilities.json"));
    assert.equal(input.capabilities!.agentKind, "lane");
    assert.equal(args[args.indexOf("--model") + 1], "gpt-6.1-sol");
    assert.ok(args.includes('model_reasoning_effort="xhigh"'));
    assert.equal(args[args.indexOf("--sandbox") + 1], "workspace-write");
    assert.ok(args.includes('web_search="live"'));
    assert.ok(args.includes('mcp_servers.docs.url="https://developers.openai.com/mcp"'));
    assert.ok(args.includes('mcp_servers.docs.enabled_tools=["search_openai_docs"]'));
    assert.equal(args[args.indexOf("plugins") - 1], "--enable");
    assert.equal(args[args.indexOf("multi_agent") - 1], "--disable");
    assert.equal(args[args.indexOf("hooks") - 1], "--disable");
  });
  it("lets a Claude lane call its explicit source and native skill without enabling delegation", () => {
    const input = options("claude", { schemaVersion: 1, web: true, skills: true, mcpSources: [source] });
    const { args } = invocationCommand(input);
    assert.deepEqual(JSON.parse(args[args.indexOf("--mcp-config") + 1]!), { mcpServers: { docs: { type: "http", url: "https://developers.openai.com/mcp" } } });
    assert.equal(args[args.indexOf("--allowedTools") + 1], "WebSearch,WebFetch,Skill,mcp__docs__search_openai_docs");
    assert.equal(args[args.indexOf("--disallowed-tools") + 1], "Agent,ListAgents,TaskStop,SendMessage");
    assert.ok(args.includes("--strict-mcp-config"));
    assert.ok(!args.includes("--disable-slash-commands"));
  });
  it("distinguishes an explicit owner from a lane and keeps hooks, memory and access bounds", () => {
    for (const provider of ["codex", "claude"]) {
      const { args } = invocationCommand(options(provider, { schemaVersion: 1, agentKind: "owner" }));
      if (provider === "codex") {
        assert.equal(args[args.indexOf("multi_agent") - 1], "--enable");
        assert.equal(args[args.indexOf("hooks") - 1], "--disable");
        assert.equal(args[args.indexOf("memories") - 1], "--disable");
        assert.ok(args.includes("workspace-write"));
        assert.ok(!args.includes("--ephemeral"));
      } else {
        assert.equal(args[args.indexOf("--disallowed-tools") + 1], "WebSearch,WebFetch");
        assert.ok(args.includes("--verbose"));
        assert.ok(!args.includes("--no-session-persistence"));
        assert.ok(args.includes("acceptEdits"));
        assert.equal(args[args.indexOf("--tools") + 1], "Read,Write,Edit,Grep,Glob,Bash,Agent,ListAgents,TaskStop,SendMessage");
        assert.equal(args[args.indexOf("--allowedTools") + 1], "Agent,ListAgents,TaskStop,SendMessage");
      }
    }
  });
  it("keeps read-only tools separate from preapproved capabilities and MCP permissions", () => {
    const input = options("claude", { schemaVersion: 1, agentKind: "owner", web: true, skills: true, mcpSources: [source] });
    const { args } = invocationCommand({ ...input, mode: "read-only" });
    assert.equal(args[args.indexOf("--permission-mode") + 1], "plan");
    assert.equal(args[args.indexOf("--tools") + 1], "Read,Grep,Glob,Bash,Agent,ListAgents,TaskStop,SendMessage,WebSearch,WebFetch,Skill");
    assert.equal(args[args.indexOf("--allowedTools") + 1], "Agent,ListAgents,TaskStop,SendMessage,WebSearch,WebFetch,Skill,mcp__docs__search_openai_docs");
    assert.equal(args[args.indexOf("--disallowed-tools") + 1], "Edit,Write,NotebookEdit");
  });
  it("opens Grok web without changing its sandbox, core environment or no-subagent role", () => {
    const { args } = invocationCommand(options("grok", { schemaVersion: 1, web: true, skills: true }), {});
    assert.ok(args.includes("--no-subagents"));
    assert.ok(!args.includes("--disable-web-search"));
    assert.ok(args.includes("workspace"));
    assert.match(args[args.indexOf("--tools") + 1]!, /web_search,web_fetch/);
    assert.ok(args[args.indexOf("--tools") + 1]!.includes("read_file"));
    assert.ok(!args.includes("Skill"));
  });
  it("rejects unknown, secret-bearing or unsupported capability requests before dispatch", () => {
    for (const value of [{ schemaVersion: 2 }, { schemaVersion: 1, cloud: true }, { schemaVersion: 1, web: "yes" },
      { schemaVersion: 1, mcpSources: [{ ...source, url: "https://user:token@example.com/mcp" }] },
      { schemaVersion: 1, mcpSources: [{ ...source, tools: [] }] }, { schemaVersion: 1, mcpSources: [source, source] }]) {
      assert.throws(() => readCapabilities(profile(value)));
    }
    assert.throws(() => options("grok", { schemaVersion: 1, agentKind: "owner" }), /native owner/);
    assert.throws(() => options("grok", { schemaVersion: 1, mcpSources: [source] }), /require --transport grok-acp/);
    const input = options("codex", { schemaVersion: 1 });
    assert.throws(() => validateRoute({ ...input, parent: "codex", provider: "grok", mode: "full-access", transport: "grok-acp", mcpConfigPath: "t3.json" }), /cannot be mixed/);
  });
  it("never uses a helper's model usage to attest the Claude owner's model", () => {
    const result = { type: "result", result: "Owner complete", modelUsage: { "claude-opus-5-5": { inputTokens: 5 } } };
    const helper = { type: "assistant", parent_tool_use_id: "helper-call", message: { model: "claude-opus-5-5" } };
    const root = { type: "assistant", parent_tool_use_id: null, message: { model: "claude-fable-5" } };
    assert.equal(parseProviderOutput("claude", JSON.stringify([root, helper, result]), "", "claude-opus-5-5", "owner").reportedModel, "claude-fable-5");
    assert.equal(parseProviderOutput("claude", JSON.stringify([helper, result]), "", "claude-opus-5-5", "owner").reportedModel, null);
  });
});
