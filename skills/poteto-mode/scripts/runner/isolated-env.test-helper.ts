import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * The environment for anything a test runs that could launch a provider CLI.
 * PATH holds only `fakeBins` and a directory with one link to this node (the
 * fakes and the launcher start with `#!/usr/bin/env node`), and HOME is `home`,
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
