import { readCapabilities } from "./capabilities.ts";
import { parseArgs as parseNodeArgs } from "node:util";
import { resolvedOptions, runLane, validateRoute } from "./run.ts";
import {
  ACCESS_MODES,
  EFFORTS,
  PARENTS,
  PROVIDERS,
  type Effort,
  type Parent,
  type Provider,
  type RunnerOptions,
  UsageError,
} from "./types.ts";

const HELP = `Usage: pstack-runner --parent <${PARENTS.join("|")}> --provider <${PROVIDERS.join("|")}> \\
  --model <slug> --effort <${EFFORTS.join("|")}> --mode <${ACCESS_MODES.join("|")}> \\
  --prompt <file> --cwd <dir> --output <file> --receipt <file> [--timeout <seconds>]
  [--capabilities <task-capabilities.json>]
  [--transport grok-acp --mode full-access [--mcp-config <file>]]

Runs one fresh top-level model session, including the parent's own provider.
The default is a non-delegating lane. --capabilities selects task tools and an
explicit owner role; owners must collect their helpers before returning.
The parent prefers native agents and uses this runner when native dispatch cannot
meet the task. CLI sessions do not inherit conversation MCP access. The (provider, model)
pair must be a family in model-matrix.json and the effort must be selectable for
it. Output and receipt paths must not already exist. There is no implicit
timeout. Pass --timeout only when the user or task supplies a real deadline; it
is one end-to-end launcher deadline shared by setup, preflight, and model
execution.
Grok ACP is an explicit full-access route for Codex and Claude parents. MCP
configuration contains endpoint and bearer-token environment references. There
is no default endpoint. Assign a separate preview tab for each preview lane.
`;

interface Io {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
}

const defaultIo: Io = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
};

function oneOf<T extends string>(
  name: string,
  value: string | undefined,
  choices: readonly T[]
): T {
  const selected = choices.find((choice) => choice === value);
  if (selected === undefined) {
    throw new UsageError(`${name} must be one of: ${choices.join(", ")}`);
  }
  return selected;
}

function required(name: string, value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    throw new UsageError(`${name} is required`);
  }
  return value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function parseArgs(argv: readonly string[]): RunnerOptions | null {
  let parsed: ReturnType<typeof parseNodeArgs>;
  try {
    parsed = parseNodeArgs({
      args: [...argv],
      allowPositionals: false,
      strict: true,
      options: {
        parent: { type: "string" },
        provider: { type: "string" },
        model: { type: "string" },
        effort: { type: "string" },
        mode: { type: "string" },
        transport: { type: "string" },
        "mcp-config": { type: "string" },
        capabilities: { type: "string" },
        prompt: { type: "string" },
        cwd: { type: "string" },
        output: { type: "string" },
        receipt: { type: "string" },
        timeout: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  if (parsed.values.help) return null;
  const mode = oneOf(
    "mode",
    stringValue(parsed.values.mode),
    [...ACCESS_MODES, "full-access"] as const
  );
  const timeoutValue = stringValue(parsed.values.timeout);
  const timeoutSeconds = timeoutValue === undefined ? null : Number(timeoutValue);
  if (
    timeoutSeconds !== null &&
    (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)
  ) {
    throw new UsageError("timeout must be a number greater than zero");
  }
  const transport = stringValue(parsed.values.transport);
  const capabilityPath = stringValue(parsed.values.capabilities);
  const mcpConfigPath = stringValue(parsed.values["mcp-config"]);
  const options = resolvedOptions({
    parent: oneOf("parent", stringValue(parsed.values.parent), PARENTS) as Parent,
    provider: oneOf("provider", stringValue(parsed.values.provider), PROVIDERS) as Provider,
    model: required("model", stringValue(parsed.values.model)),
    effort: oneOf("effort", stringValue(parsed.values.effort), EFFORTS) as Effort,
    mode,
    ...(transport === undefined ? {} : { transport: oneOf("transport", transport, ["cli", "grok-acp"] as const) }),
    ...(mcpConfigPath === undefined ? {} : { mcpConfigPath: required("mcp-config", mcpConfigPath) }),
    ...(capabilityPath === undefined ? {} : { capabilities: readCapabilities(required("capabilities", capabilityPath)) }),
    promptPath: required("prompt", stringValue(parsed.values.prompt)),
    cwd: required("cwd", stringValue(parsed.values.cwd)),
    outputPath: required("output", stringValue(parsed.values.output)),
    receiptPath: required("receipt", stringValue(parsed.values.receipt)),
    timeoutMs: timeoutSeconds === null ? null : timeoutSeconds * 1_000,
  });
  validateRoute(options);
  return options;
}

export async function main(
  argv: readonly string[],
  startedAt: number = Date.now(),
  io: Io = defaultIo
): Promise<number> {
  try {
    const options = parseArgs(argv);
    if (options === null) {
      io.stdout(HELP);
      return 0;
    }
    const result = await runLane(options, startedAt);
    const rendered = `${JSON.stringify(result.receipt)}\n`;
    if (result.exitCode === 0) io.stdout(rendered);
    else io.stderr(rendered);
    return result.exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`error: ${message}\n`);
    io.stderr(HELP);
    return 64;
  }
}
