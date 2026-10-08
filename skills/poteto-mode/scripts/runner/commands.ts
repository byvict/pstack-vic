import { codexCapabilityArgs, claudeCapabilityArgs, claudeCapabilityTools, type CliCapabilities } from "./capabilities.ts";
import {
  cliFor,
  UsageError,
  type AccessMode,
  type Effort,
  type GrokSandbox,
  type Provider,
  type RunnerOptions,
} from "./types.ts";

export interface CommandSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly stdin: "prompt" | "none" | "interactive";
}

/** A config file the child finds through `variable`, with the variables that would shadow it removed. */
export interface ConfigOverlay {
  readonly variable: string;
  readonly unset: readonly string[];
  readonly fileName: string;
  readonly content: string;
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

function claudeDeniedTools(mode: AccessMode, capabilities: CliCapabilities | undefined): string {
  const readonly = ["Edit", "Write", "NotebookEdit"];
  return [...claudeCapabilityTools(capabilities).denied, ...(mode === "read-only" ? readonly : [])].join(",");
}

function claudeTools(mode: AccessMode, capabilities: CliCapabilities | undefined): string {
  const tools = mode === "read-only" ? ["Read", "Grep", "Glob", "Bash"] : ["Read", "Write", "Edit", "Grep", "Glob", "Bash"];
  return [...tools, ...claudeCapabilityTools(capabilities).available].join(",");
}

function codexSandbox(mode: AccessMode): string {
  return mode === "read-only" ? "read-only" : "workspace-write";
}

// Grok applies its own seatbelt profile and refuses to start when the profile
// cannot be initialised. Inside Codex's seatbelt (the parent exports
// CODEX_SANDBOX to the runner) a nested profile always fails with "sandbox
// initialization failed: Operation not permitted", so the lane runs on Grok's
// built-in `none` profile and the outer sandbox governs; plan mode and the
// tool list still apply. Measured with Grok CLI 1.0.5 and Codex 0.154.0.
export function grokSandbox(mode: RunnerOptions["mode"], outerSeatbelt: boolean): GrokSandbox {
  if (mode === "full-access") return "off";
  if (outerSeatbelt) return "none";
  return mode === "read-only" ? "read-only" : "workspace";
}

export function insideCodexSandbox(env: NodeJS.ProcessEnv): boolean {
  return (env.CODEX_SANDBOX ?? "") !== "";
}

/**
 * Grok's sandbox limits what a lane writes, not what its shell inherits, so
 * without a policy every Grok lane's shell sees the parent's whole
 * environment, credentials included (measured 2026-09-25, N27);
 * `inherit = "core"` keeps only a small platform set such as PATH and HOME.
 * Grok merges a GROK_CONFIG_PATH file above the user's config.toml without
 * replacing it, `inherit` is on the overlay allowlist, and an inline
 * GROK_CONFIG would win over the file, so the child loses that variable.
 */
export function configOverlay(
  options: Pick<RunnerOptions, "provider">
): ConfigOverlay | null {
  if (cliFor(options.provider) !== "grok") return null;
  return {
    variable: "GROK_CONFIG_PATH",
    unset: ["GROK_CONFIG"],
    fileName: "grok-lane.toml",
    content: '[shell_environment_policy]\ninherit = "core"\n',
  };
}

function grokTools(mode: AccessMode, web = false): string {
  const readonly = ["read_file", "grep", "list_dir", "run_terminal_cmd"];
  return [...readonly, ...(mode === "isolated-write" ? ["search_replace"] : []), ...(web ? ["web_search", "web_fetch"] : [])].join(",");
}

function permissionMode(mode: AccessMode): string {
  return mode === "read-only" ? "plan" : "acceptEdits";
}

// Grok's permission engine prompts for any shell segment its heuristics do not
// auto-approve, and a headless prompt cancels the whole turn
// (`permission_cancelled`, measured 2026-09-18 in every mode: `acceptEdits`,
// `plan` and `dontAsk` alike; the same command was approved in a scratch repo
// and prompted inside the Clinext checkout, so the trigger is repo-dependent).
// Grok's own docs send unattended automation to always-approve, and its
// "request-level floor" only yields to that mode. A lane cannot answer a
// prompt, so the runner never relies on one: always-approve, and confinement
// comes from the sandbox (`read-only` / `workspace`, or the outer Codex
// seatbelt when Grok runs on `none`) plus the tool list.
function grokPermissionMode(): string {
  return "bypassPermissions";
}

function effortOverride(effort: Effort): string {
  return `model_reasoning_effort=${JSON.stringify(effort)}`;
}

export function invocationCommand(
  options: RunnerOptions,
  env: NodeJS.ProcessEnv = process.env
): CommandSpec {
  const mode = options.mode;
  const capabilities = options.capabilities;
  if (mode === "full-access") throw new UsageError("full-access requires the Grok ACP transport");
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
          permissionMode(mode),
          "--setting-sources",
          "project",
          "--strict-mcp-config",
          "--tools",
          claudeTools(mode, capabilities),
          ...(capabilities?.agentKind === "owner" ? [] : ["--no-session-persistence"]),
          ...(capabilities?.skills ? [] : ["--disable-slash-commands"]),
          ...(claudeDeniedTools(mode, capabilities) ? ["--disallowed-tools", claudeDeniedTools(mode, capabilities)] : []),
          ...claudeCapabilityArgs(capabilities),
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
          codexSandbox(mode),
          "--cd",
          options.cwd,
          "--skip-git-repo-check",
          ...(capabilities?.agentKind === "owner" ? [] : ["--ephemeral"]),
          capabilities?.skills ? "--enable" : "--disable",
          "plugins",
          capabilities?.agentKind === "owner" ? "--enable" : "--disable",
          "multi_agent",
          "--disable",
          "hooks",
          "--disable",
          "memories",
          ...codexCapabilityArgs(capabilities),
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
          grokPermissionMode(),
          "--sandbox",
          grokSandbox(mode, insideCodexSandbox(env)),
          "--tools",
          grokTools(mode, capabilities?.web),
          "--disallowed-tools",
          "Agent,search_tool,use_tool",
          "--output-format",
          "streaming-messages-json",
          "--cwd",
          options.cwd,
          "--no-subagents",
          ...(capabilities?.web ? [] : ["--disable-web-search"]),
          "--verbatim",
        ],
        stdin: "none",
      };
    default:
      throw new UsageError(`no invocation command for CLI ${cli}`);
  }
}

export function grokAcpCommand(profilePath: string, sandbox: GrokSandbox = "off"): CommandSpec {
  return {
    command: "grok",
    args: ["--sandbox", sandbox, "agent", "--always-approve", "--no-leader", "--agent-profile", profilePath, "stdio"],
    stdin: "interactive",
  };
}

export function grokAcpTools(forwardMcp: boolean, mode: RunnerOptions["mode"] = "full-access", web = false): readonly string[] {
  return grokAcpProfileTools(forwardMcp, mode, web).map((tool) => tool === "run_terminal_cmd" ? "run_terminal_command" : tool);
}

function grokAcpProfileTools(forwardMcp: boolean, mode: RunnerOptions["mode"], web: boolean): string[] {
  return [...grokTools(mode === "read-only" ? "read-only" : "isolated-write", web).split(","), ...(forwardMcp ? ["search_tool", "use_tool"] : [])];
}

export function grokAcpProfile(forwardMcp: boolean, mode: RunnerOptions["mode"] = "full-access", web = false): string {
  const tools = grokAcpProfileTools(forwardMcp, mode, web);
  const denied = ["Agent", "Task", "spawn_subagent", "workflow", "monitor", "scheduler_create", "scheduler_delete", "scheduler_list",
    "image_gen", "image_edit", "image_to_video", "reference_to_video", "ask_user_question", "enter_plan_mode", "exit_plan_mode",
    ...(mode === "read-only" ? ["search_replace"] : []), ...(web ? [] : ["web_search", "web_fetch"]),
    ...(forwardMcp ? [] : ["search_tool", "use_tool"])];
  return ["---", "name: pstack-external-grok-lane", "description: Execute one assigned external lane.", "tools:",
    ...tools.map((tool) => `  - ${tool}`), "disallowedTools:", ...denied.map((tool) => `  - ${tool}`), "---",
    "Execute the assigned task only. Do not start workflows or subagents.", ""].join("\n");
}

export function grokAcpOverlay(): ConfigOverlay {
  return {
    variable: "GROK_CONFIG_PATH", unset: ["GROK_CONFIG"], fileName: "grok-lane.toml",
    content: '[shell_environment_policy]\ninherit = "core"\n[subagents]\nenabled = false\n',
  };
}
