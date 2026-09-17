// Copied from open-pstack 1.4.1 (de67e6b) runner/commands.ts. Change from the
// original: the command binary and the flag shape are keyed by the CLI that
// model-matrix.json assigns to the provider (`providers.<name>.cli`), so an
// unknown provider fails loudly instead of falling through a switch. Every
// Codex family (sol, astra) shares the same argv; only `--model` differs.

import {
  cliFor,
  UsageError,
  type AccessMode,
  type Effort,
  type Provider,
  type RunnerOptions,
} from "./types.ts";

export interface CommandSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly stdin: "prompt" | "none";
}

function requireCli(provider: Provider): string {
  const cli = cliFor(provider);
  if (cli === null) {
    throw new UsageError(`provider ${provider} has no CLI in model-matrix.json`);
  }
  return cli;
}

export function preflightCommand(provider: Provider): CommandSpec {
  const cli = requireCli(provider);
  switch (cli) {
    case "claude":
      return {
        command: cli,
        args: ["auth", "status", "--json"],
        stdin: "none",
      };
    case "codex":
      return {
        command: cli,
        args: ["login", "status"],
        stdin: "none",
      };
    case "grok":
      return { command: cli, args: ["models"], stdin: "none" };
    default:
      throw new UsageError(`no preflight command for CLI ${cli}`);
  }
}

function claudeDeniedTools(mode: AccessMode): string {
  const always = ["Agent", "Task", "WebSearch", "WebFetch"];
  const readonly = ["Edit", "Write", "NotebookEdit"];
  return [...always, ...(mode === "read-only" ? readonly : [])].join(",");
}

function claudeTools(mode: AccessMode): string {
  return mode === "read-only"
    ? "Read,Grep,Glob,Bash"
    : "Read,Write,Edit,Grep,Glob,Bash";
}

function codexSandbox(mode: AccessMode): string {
  return mode === "read-only" ? "read-only" : "workspace-write";
}

function grokSandbox(mode: AccessMode): string {
  return mode === "read-only" ? "read-only" : "workspace";
}

function grokTools(mode: AccessMode): string {
  const readonly = ["read_file", "grep", "list_dir", "run_terminal_cmd"];
  return [...readonly, ...(mode === "isolated-write" ? ["search_replace"] : [])].join(",");
}

function permissionMode(mode: AccessMode): string {
  return mode === "read-only" ? "plan" : "acceptEdits";
}

function effortOverride(effort: Effort): string {
  return `model_reasoning_effort=${JSON.stringify(effort)}`;
}

export function invocationCommand(options: RunnerOptions): CommandSpec {
  const cli = requireCli(options.provider);
  switch (cli) {
    case "claude":
      return {
        command: cli,
        args: [
          "-p",
          "--model",
          options.model,
          "--effort",
          options.effort,
          "--permission-mode",
          permissionMode(options.mode),
          "--setting-sources",
          "project",
          "--strict-mcp-config",
          "--tools",
          claudeTools(options.mode),
          "--no-session-persistence",
          "--disable-slash-commands",
          "--disallowed-tools",
          claudeDeniedTools(options.mode),
          "--output-format",
          "json",
        ],
        stdin: "prompt",
      };
    case "codex":
      return {
        command: cli,
        args: [
          "exec",
          "--model",
          options.model,
          "--config",
          effortOverride(options.effort),
          "--sandbox",
          codexSandbox(options.mode),
          "--cd",
          options.cwd,
          "--skip-git-repo-check",
          "--ephemeral",
          "--disable",
          "plugins",
          "--disable",
          "multi_agent",
          "--disable",
          "hooks",
          "--disable",
          "memories",
          "--json",
          "-",
        ],
        stdin: "prompt",
      };
    case "grok":
      return {
        command: cli,
        args: [
          "--prompt-file",
          options.promptPath,
          "--model",
          options.model,
          "--reasoning-effort",
          options.effort,
          "--permission-mode",
          permissionMode(options.mode),
          "--sandbox",
          grokSandbox(options.mode),
          "--tools",
          grokTools(options.mode),
          "--disallowed-tools",
          "Agent,search_tool,use_tool",
          "--output-format",
          "streaming-messages-json",
          "--cwd",
          options.cwd,
          "--no-subagents",
          "--disable-web-search",
          "--verbatim",
        ],
        stdin: "none",
      };
    default:
      throw new UsageError(`no invocation command for CLI ${cli}`);
  }
}
