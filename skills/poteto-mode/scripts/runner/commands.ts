import {
  cliFor,
  transportFor,
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

/** A config file the child finds through `variable`, with the variables that would shadow it removed. */
export interface ConfigOverlay {
  readonly variable: string;
  readonly unset: readonly string[];
  readonly fileName: string;
  readonly content: string;
}

function requireCli(provider: Provider): string {
  if (transportFor(provider) === "http") {
    throw new UsageError(
      `provider ${provider} uses the http transport; its lane is built in http-lane.ts, not as a CLI command`
    );
  }
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

// Grok applies its own seatbelt profile and refuses to start when the profile
// cannot be initialised. Inside Codex's seatbelt (the parent exports
// CODEX_SANDBOX to the runner) a nested profile always fails with "sandbox
// initialization failed: Operation not permitted", so the lane runs on Grok's
// built-in `none` profile and the outer sandbox governs; plan mode and the
// tool list still apply. Measured with Grok CLI 1.0.5 and Codex 0.154.0.
function grokSandbox(mode: AccessMode, outerSeatbelt: boolean): string {
  if (mode === "unsandboxed") return "off";
  if (outerSeatbelt) return "none";
  return mode === "read-only" ? "read-only" : "workspace";
}

export function insideCodexSandbox(env: NodeJS.ProcessEnv): boolean {
  return (env.CODEX_SANDBOX ?? "") !== "";
}

/**
 * On macOS no Grok Seatbelt profile lets a lane open a pty or start Chromium,
 * so the certifier that drives the app runs with Grok's sandbox off (CLI-197,
 * measured with Grok CLI 1.0.41). That certifier is a Grok lane, so the mode
 * refuses every other provider. Codex's outer seatbelt denies the pty and
 * Chromium just the same, so the mode refuses a parent that exports
 * CODEX_SANDBOX too.
 */
export function requireSupportedMode(
  provider: Provider,
  mode: AccessMode,
  env: NodeJS.ProcessEnv
): void {
  if (mode !== "unsandboxed") return;
  if (cliFor(provider) !== "grok") {
    throw new UsageError(`mode unsandboxed runs only on grok, not on ${provider}`);
  }
  if (insideCodexSandbox(env)) {
    throw new UsageError("unsandboxed needs a parent without a seatbelt");
  }
}

/**
 * With its sandbox off, a Grok lane's shell would inherit the parent's whole
 * environment, credentials included; `inherit = "core"` keeps only a small
 * platform set such as PATH and HOME. Grok merges a GROK_CONFIG_PATH file
 * above the user's config.toml without replacing it, `inherit` is on the
 * overlay allowlist, and an inline GROK_CONFIG would win over the file, so the
 * child loses that variable.
 */
export function configOverlay(
  options: Pick<RunnerOptions, "provider" | "mode">
): ConfigOverlay | null {
  if (options.mode !== "unsandboxed" || cliFor(options.provider) !== "grok") return null;
  return {
    variable: "GROK_CONFIG_PATH",
    unset: ["GROK_CONFIG"],
    fileName: "grok-lane.toml",
    content: '[shell_environment_policy]\ninherit = "core"\n',
  };
}

function grokTools(mode: AccessMode): string {
  const readonly = ["read_file", "grep", "list_dir", "run_terminal_cmd"];
  return [...readonly, ...(mode === "isolated-write" ? ["search_replace"] : [])].join(",");
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
// seatbelt when Grok runs on `none`) plus the tool list. An `unsandboxed` lane
// keeps only the tool list and the disposable worktree its caller passes.
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
  const cli = requireCli(options.provider);
  requireSupportedMode(options.provider, options.mode, env);
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
          grokPermissionMode(),
          "--sandbox",
          grokSandbox(options.mode, insideCodexSandbox(env)),
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
