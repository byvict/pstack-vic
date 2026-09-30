# Probe native Linear permissions

Run this probe after a Claude CLI upgrade and after any change to `linearSessionCommand` or its permission flags. Use the configured native Claude Raiz model and effort. The directory must be new and outside any git checkout:

    node <plugin>/skills/update-clis/scripts/claude-linear-permission-probe.ts --directory NEW_DIRECTORY --model claude-opus-5-5 --effort xhigh --plugin-dir <plugin>

The probe uses the production command builder with `dontAsk`, `--permission-prompts none`, empty setting sources, native stream and hook events, and only the `ToolSearch` builtin. Its strict MCP configuration exposes a local fixture mutator that appends a record to a scratch file. It uses the existing CLI login and removes only `CLAUDE_CODE_OAUTH_TOKEN` from the inherited environment. It does not install or update a CLI or call an application connector.

Require exit 0 and `summary.json` with `ok: true`. Every case must show one native mutator attempt, the expected hook response, and matching server dispatch and effect counts:

| Case | Effects |
| --- | --- |
| Hook allows the call | 1 |
| Hook explicitly denies the call | 0 |
| Hook executable is missing | 0 |
| Hook exits 1 | 0 |
| Hook times out | 0 |
| Local allow rule loaded, hook exits 1 | 1 |
| Identical local allow rule excluded, hook exits 1 | 0 |
| Inline allow rule, hook exits 1 | 1 |

The two local-rule cases share the same untracked `.claude/settings.local.json`. The loaded control overrides the empty setting sources with `local`; all other cases retain the production isolation. A loaded control with zero effects fails the probe. It cannot establish that the CLI loaded the allow rule. This positive control avoids the trust requirement of shared project allow rules described in [Claude's settings documentation](https://code.claude.com/docs/en/settings).

The inline-allow control records a permission failure that remains unsafe. An effective allow rule can admit the mutation after a failed hook in `dontAsk`. Keep its expected effect count at 1, and keep allow rules out of the production inline hook settings.

The top-level receipt binds the probe, command builder, and local hook/server fixtures by SHA-256. It also hashes the shared ambient settings file and fails if any bound file changes during the run. Each case keeps its launch arguments, native transcript, hook log, server request log, effect log, and summary. The probe rejects unexpected MCP servers or tools.

This probe establishes CLI permission fallback and effective local-setting exclusion. Production Linear schemas, effect checkpoints, account connector availability, and daemon delivery require their own evidence.
