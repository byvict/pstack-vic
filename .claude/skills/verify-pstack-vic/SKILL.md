---
name: verify-pstack-vic
description: Verify changes to this pstack-vic repository, diagnose missing execution evidence, reproduce an inner-tool timeout, or measure external runner concurrency with fixed recipes and retained receipts.
---

# Verify pstack-vic

Repository-only verifier, adapted from open-pstack. Start at the repository root with `npm run verify -- doctor`. Recipe definitions and costs are in [`scripts/verify/recipes.ts`](../../../scripts/verify/recipes.ts); ownership is in [`registry.json`](../../../scripts/verify/registry.json).

1. Resolve the review's base and candidate HEAD. Select checks for the actual change; retain the reason for the selection in the review. Run `npm run verify -- classify --base <base> --output <new-absolute-directory>` to inspect all changed paths, including both sides of renames. Unknown paths fail. Runtime instructions take precedence over documentation exemptions.
2. Run `npm run verify -- run --base <base> --output <another-new-absolute-directory> --feature <name>`. Repeat `--feature` for additional checks. A clean commit is the default; `--working-tree` produces an explicitly labelled development proof with a content digest. Never describe that as proof of the commit alone. Changes to this verifier require `verifier-contracts`.
3. Keep long runs in the host's persistent exec/background handle. Record the handle and output directory. Inspect `receipt.json` and its current phase while it runs. SIGINT/SIGTERM stop its owned process groups. Do not launch an untracked `&`, run extra warmups, repeat commands to recover missing logs, or replace a failed attempt. Preparation commands already have `commands/<sequence>/stdout`, `stderr`, and `command.json` before parsing.
4. Read the terminal receipt, observations and command evidence. A failed assertion preserves the earlier result and streams. A second attempt needs a new directory and an explicit reason. Only selected checks are covered; this does not replace review, native skill-invocation proofs, Arena or Shipping. Do not add the fourteen-scope workflow unless the active plan actually calls for it.

## Select a recipe

| Change/question | Recipe | What it proves |
| --- | --- | --- |
| Verifier implementation | `verifier-contracts` | Capture before parse, ownership, cancellation, source binding and method checks |
| Runner logic/ACP | `runner-contracts` | Public runner behavior with isolated fake CLIs |
| Setup | `setup-contracts` | Existing setup contract tests |
| Repository/tooling | `repository-contracts` | Root scripts and update-clis tests; excludes runner/setup to avoid duplicate suites |
| Installed provider route | `runner-smoke --route grok-acp` | One actual model session with receipt/model/stream assertions |
| Inner terminal's five-minute cutoff | `inner-timeout --route grok-acp --route grok-cli` | One 330-second command per route, requesting 450 seconds from the inner tool; preserves actual errors |
| External concurrency | `concurrency --route grok-cli` | Four actual sessions at widths 1, 2 and 4 (12 total); no warmups or retries |

Live recipes use authenticated CLIs and model usage. Available routes and fixed descriptors are reported by `doctor`. Concurrency requires Grok or Codex and rejects tool calls; the Claude runner's summary output cannot prove that method, so concurrency rejects that route before launching sessions. Runner smoke still supports Claude. These recipes invoke the candidate's public runner directly, not a newly installed plugin. For a native skill or installation change, add that specific proof to the review; these recipes do not claim it. No GitHub comments/statuses are published by this tool.

For a timeout failure, distinguish the runner deadline, tool result, observed child events, and a model that did not follow the command method. The recipe checks the actual command, tool-call count and requested timeout. Grok CLI 1.0.46 omits inner tool calls from its stdout format, so this recipe also copies its own session's `~/.grok/sessions/<encoded-cwd>/<session-id>/updates.jsonl` before parsing it. A missing completion alone cannot identify which layer imposed a limit. In the local reproduction, both CLI and ACP requested 450 seconds and timed out near 300 seconds; keep long verification commands in the host's persistent handle, outside the worker's foreground terminal tool. Concurrency timings describe this workload and route, not native agent slots or a universal safe fan-out.

Receipts/streams are private local evidence. ACP adds `<receipt>.events.jsonl`: normalized request/reply timings, tool-call updates, catalog and final process diagnostics. It excludes outbound parameters, assistant text/thoughts and partial tool deltas, and redacts the known T3 token. Tool payloads may contain task data; choose excerpts deliberately when sharing.
