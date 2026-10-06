import { accessSync, constants as fsConstants, existsSync, mkdirSync, statSync, symlinkSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { cliFor, PROVIDERS } from "./types.ts";

/**
 * The environment for anything a test runs that could launch a provider CLI.
 * PATH holds only `fakeBins` and a directory with one link to this node (for
 * the launcher's `exec node` and the `#!/usr/bin/env node` fakes), and HOME is `home`,
 * a temporary directory of the test. Nothing of the operator's PATH or HOME is
 * in it, so a fake that is missing or a refusal that regresses ends in a spawn
 * error, never in the real claude, codex, grok or gh. On the operator's Mac
 * and on CI the real claude sits beside node, so the directory of
 * process.execPath stays out as well.
 */
export function isolatedEnv(
  home: string,
  fakeBins: readonly string[] = [],
  extra: Readonly<Record<string, string>> = {}
): NodeJS.ProcessEnv {
  const nodeBin = join(home, ".node-bin");
  if (!existsSync(nodeBin)) {
    mkdirSync(nodeBin, { recursive: true });
    symlinkSync(process.execPath, join(nodeBin, "node"));
  }
  const tmp = process.env.TMPDIR;
  return {
    PATH: [...fakeBins, nodeBin].join(delimiter),
    HOME: home,
    ...(tmp === undefined ? {} : { TMPDIR: tmp }),
    ...extra,
  };
}

/** What no test may launch for real: the CLI of every matrix provider, and gh. */
export function guardedClis(): string[] {
  const fromMatrix = PROVIDERS.map((provider) => cliFor(provider)).filter((cli): cli is string => cli !== null);
  return [...new Set([...fromMatrix, "claude", "codex", "grok", "gh"])];
}

/**
 * The files `path` resolves for a guarded CLI in a directory that is not one
 * of `fakeBins`. A lookup only, nothing is launched: a test asserts the list
 * is empty, and the list names what broke the isolation when it is not.
 */
export function clisOutsideFakes(path: string | undefined, fakeBins: readonly string[] = []): string[] {
  const fakes = new Set(fakeBins.map((bin) => resolve(bin)));
  const found: string[] = [];
  // An empty PATH entry is the working directory, as execvp reads it.
  for (const entry of (path ?? "").split(delimiter)) {
    const directory = resolve(entry.length > 0 ? entry : ".");
    if (fakes.has(directory)) continue;
    for (const cli of guardedClis()) {
      const candidate = join(directory, cli);
      try {
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, fsConstants.X_OK);
        found.push(candidate);
      } catch {
        continue;
      }
    }
  }
  return found;
}

/**
 * Put the test process itself in the isolated environment, and return the
 * function that puts PATH and HOME back. The code under test reads
 * process.env, and a child it spawns without an `env` inherits it, so an
 * isolated env object alone leaves the real CLIs one dropped pass-through
 * away. Throws before the test body runs when a guarded CLI still resolves
 * outside `fakeBins`; the environment then stays isolated.
 */
export function isolateProcessEnv(home: string, fakeBins: readonly string[] = []): () => void {
  const isolated = isolatedEnv(home, fakeBins);
  const previous = { PATH: process.env.PATH, HOME: process.env.HOME };
  process.env.PATH = isolated.PATH;
  process.env.HOME = isolated.HOME;
  const reached = clisOutsideFakes(process.env.PATH, fakeBins);
  if (reached.length > 0) throw new Error(`the test PATH reaches a real CLI: ${reached.join(", ")}`);
  return () => {
    for (const key of ["PATH", "HOME"] as const) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  };
}
