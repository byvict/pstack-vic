import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerReceipt } from "./types.ts";
import { isolatedEnv, isolateProcessEnv } from "./isolated-env.test-helper.ts";

const RUNNER_DIR = import.meta.dirname;
const LAUNCHER = join(RUNNER_DIR, "pstack-runner");
const RUN_BUDGET_MS = 10_000;
const PROMPT_PAST_PIPE_CAPACITY = "Return the marker.\n".repeat(100_000);

interface Startup {
  readonly nodeOptions?: string;
  readonly bunOptions?: string;
  readonly dotenv?: true;
  readonly hostileHelpers?: true;
  readonly bareName?: true;
}

const STARTUPS: Readonly<Record<string, Startup>> = {
  "node-options-require": { nodeOptions: "--require=./project-preload.cjs" },
  "node-options-import": { nodeOptions: "--import=./project-preload.mjs" },
  "bun-options": { bunOptions: "--env-file=./startup.env" },
  combined: {
    nodeOptions: "--require=./project-preload.cjs --import=./project-preload.mjs",
    bunOptions: "--env-file=./startup.env",
    dotenv: true,
  },
  "hostile-path": { hostileHelpers: true },
  "bare-name": { bareName: true },
};

const fakeCodex = `#!/bin/sh
if [ "$1" = "login" ]; then
  printf '%s\\n' 'Logged in using ChatGPT'
  exit 0
fi
/bin/cat > "$PSTACK_PROMPT_CAPTURE"
printf '%s\\n' "\${PSTACK_PROJECT_ENV_SENTINEL-unset}" "\${PSTACK_LOCAL_ENV_SENTINEL-unset}" "\${PSTACK_INHERITED_ENV_SENTINEL-unset}" "\${BUN_OPTIONS-unset}" "\${NODE_OPTIONS-unset}" "\${PSTACK_SENTINEL-unset}" > "$PSTACK_ENV_CAPTURE"
printf '%s\\n' '{"type":"thread.started","thread_id":"isolated"}' '{"type":"item.completed","item":{"type":"agent_message","text":"CODEX_OK"}}' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
`;

let scratch = "";
let bin = "";
let restoreProcessEnv: () => void = () => {};

function executable(path: string, text: string): void {
  writeFileSync(path, text);
  chmodSync(path, 0o755);
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "pstack-launcher-test-"));
  bin = join(scratch, "bin");
  mkdirSync(bin);
  executable(join(bin, "codex"), fakeCodex);
  restoreProcessEnv = isolateProcessEnv(join(scratch, "home"), [bin]);
  // macOS vets a fresh executable on its first exec, and a checkout leaves
  // the launcher fresh. Pay that outside the timed run.
  execFileSync(join(bin, "codex"), ["login"], { stdio: "ignore" });
  execFileSync(LAUNCHER, ["--help"], { stdio: "ignore" });
});

afterEach(() => {
  restoreProcessEnv();
  rmSync(scratch, { recursive: true, force: true });
});

describe("pstack-runner launcher", () => {
  for (const [name, startup] of Object.entries(STARTUPS)) {
    it(`isolates runner startup: ${name}`, () => {
      const prompt = join(scratch, "prompt.md");
      const output = join(scratch, "codex.out");
      const receipt = join(scratch, "codex.receipt.json");
      const capturedEnv = join(scratch, "provider-env.txt");
      const capturedPrompt = join(scratch, "provider-prompt.txt");
      const requirePreload = join(scratch, "require-preload.ran");
      const importPreload = join(scratch, "import-preload.ran");
      const helperRan = join(scratch, "helper.ran");
      writeFileSync(prompt, PROMPT_PAST_PIPE_CAPACITY);
      writeFileSync(join(scratch, "project-preload.cjs"),
        `require("node:fs").writeFileSync(${JSON.stringify(requirePreload)}, "require preload ran\\n");\n`);
      writeFileSync(join(scratch, "project-preload.mjs"),
        `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(importPreload)}, "import preload ran\\n");\nprocess.env.PSTACK_SENTINEL = "set-by-import-preload";\n`);
      writeFileSync(join(scratch, "startup.env"), "PSTACK_PROJECT_ENV_SENTINEL=loaded-from-bun-options\n");
      if (startup.dotenv) {
        writeFileSync(join(scratch, ".env"), "PSTACK_PROJECT_ENV_SENTINEL=loaded-from-project-dotenv\n");
        writeFileSync(join(scratch, ".env.local"), "PSTACK_LOCAL_ENV_SENTINEL=loaded-from-project-local-dotenv\n");
      }
      if (startup.hostileHelpers) {
        for (const helper of ["env", "dirname", "readlink"]) {
          executable(join(bin, helper), `#!/bin/sh\nprintf '%s\\n' '${helper}' > "${helperRan}"\nexit 1\n`);
        }
      }
      const env = isolatedEnv(join(scratch, "home"), [bin], {
        PSTACK_ENV_CAPTURE: capturedEnv,
        PSTACK_PROMPT_CAPTURE: capturedPrompt,
        PSTACK_INHERITED_ENV_SENTINEL: "inherited-from-parent",
        ...(startup.nodeOptions === undefined ? {} : { NODE_OPTIONS: startup.nodeOptions }),
        ...(startup.bunOptions === undefined ? {} : { BUN_OPTIONS: startup.bunOptions }),
      });
      const flags = [
        "--parent", "claude",
        "--provider", "codex",
        "--model", "gpt-6-sol",
        "--effort", "max",
        "--mode", "read-only",
        "--prompt", prompt,
        "--cwd", scratch,
        "--output", output,
        "--receipt", receipt,
      ];
      const [command, args, cwd]: [string, string[], string] = startup.bareName
        ? ["/bin/sh", ["pstack-runner", ...flags], RUNNER_DIR]
        : [LAUNCHER, flags, scratch];

      const run = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: RUN_BUDGET_MS, killSignal: "SIGKILL" });

      assert.equal(run.status, 0, JSON.stringify({
        error: run.error?.message,
        stdout: run.stdout,
        stderr: run.stderr,
        receipt: existsSync(receipt) ? readFileSync(receipt, "utf8") : null,
      }));
      assert.equal(readFileSync(capturedPrompt, "utf8"), readFileSync(prompt, "utf8"));
      assert.equal(readFileSync(capturedEnv, "utf8"), "unset\nunset\ninherited-from-parent\nunset\nunset\nunset\n");
      assert.equal(existsSync(requirePreload), false, "the --require preload ran");
      assert.equal(existsSync(importPreload), false, "the --import preload ran");
      assert.equal(existsSync(helperRan), false, "a PATH helper ran before exec");
      assert.match(readFileSync(output, "utf8"), /CODEX_OK/);
      assert.equal((JSON.parse(readFileSync(receipt, "utf8")) as RunnerReceipt).status, "complete");
    });
  }
});
