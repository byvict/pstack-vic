# Task capabilities for local CLI sessions

Select the tools the assigned role needs before dispatch. The model/effort descriptor, access mode and complete task remain separate. Prefer native dispatch when it already supplies those requirements. For an external session, pass `--capabilities /absolute/task-capabilities.json` to `pstack-runner`:

```json
{
  "schemaVersion": 1,
  "agentKind": "lane",
  "web": true,
  "skills": true,
  "mcpSources": [
    {
      "name": "pstack_docs",
      "url": "https://developers.openai.com/mcp",
      "tools": ["search_openai_docs", "fetch_openai_doc"]
    }
  ]
}
```

Omitted fields mean `lane`, false, false and no explicit sources. No file means the previous bounded lane command. Unknown fields and unsupported combinations fail before dispatch. The receipt retains the parsed request, absolute source path and SHA-256 of the original file. These are **requested capabilities**, not an attestation of every effective tool or inherited integration.

| Request | Codex CLI | Claude CLI | Grok CLI / ACP |
| --- | --- | --- | --- |
| `web: true` | Native live search | WebSearch/WebFetch in the tool and permission lists | CLI: native web_search/web_fetch; ACP: adds those builtins to its profile |
| `skills: true` | Enables configured plugins; uses native project/installed skills | Enables native skills and Skill; removes disable-slash-commands | Accessible skill instructions through native discovery/read_file; assign exact paths and verify effects |
| `mcpSources` | Per-invocation mcp_servers URL and enabled_tools | Explicit HTTP config under strict-mcp-config; selected tool permission rules | ACP session/new HTTP attachments; search_tool/use_tool, assigned tool names in the brief; CLI rejects sources |
| `agentKind: owner` | Enables multi_agent, persists the fresh session | Enables Agent, ListAgents, TaskStop and SendMessage; persists the fresh session, captures verbose root messages | Use the native owner route and its owner → helper setup proof |

MCP sources support public HTTP MCP servers or authentication already provided by the CLI for that source. HTTPS is required except on loopback. This small adapter does not forward conversation connectors, invent credentials, provision OAuth, accept credential-bearing URLs, or configure arbitrary stdio commands. The separate T3 ACP route already supports its explicit bearer-token environment contract. An inaccessible required source is a named gap; changing model is governed only by the existing calling skill and configured swarm fallback.

Source names select per-invocation configuration; use distinct names when an existing configured server must remain untouched. Codex may still load other user-configured MCPs and its own authenticated app connectors. Claude's strict config limits the attached servers, while allowedTools preapproves the selected tools rather than filtering every server's advertised catalog. Grok ACP records configured-and-forwarded MCPs, including ambient integrations; its source tool names constrain the assignment, not the server's catalog. A task requiring enforced MCP tool isolation needs a source/runtime that enforces it. Configured skills and plugins are trusted code/instructions available to the selected CLI, not the parent's conversation. The access mode still controls the CLI's existing permission/sandbox behavior; tool selection is not an OS security boundary.

For a Grok lane, select `--transport grok-acp --mode read-only|isolated-write --capabilities <file>` when HTTP MCP is required. The same bounded sandbox selection as the CLI applies, including the enclosing Codex sandbox when nested; read-only also omits the file-edit builtin. Use `full-access` only for a task already authorized to need it. The T3 `--mcp-config` remains full-access-only and cannot be combined with a general capability profile. Grok owners remain unsupported by these external routes. A general source attachment neither enables delegation nor changes model or effort.

Skills need their dependencies as well as their text. Assign the exact skill and supporting paths, required executables and source operations; inspect an actual result. Reading a portable skill through `read_file` does not recreate a foreign plugin's hooks, slash-command machinery or connectors. The [Codex mapping](codex-tools.md#skills-plugins-and-sources) and [front B proof](../../../docs/research/2026-10-08-codex-front-b.md) distinguish these cases.

## Owners and lifecycle

An ordinary lane gives one independent result and must not recursively manufacture more votes. An owner explicitly needs native delegation. Pass the complete helper descriptors and briefs, keep a handle inventory, and follow [native lifecycle](native-lifecycle.md) for capacity, fresh contexts, compatible same-task follow-ups, interruption and closure. The runner does not allocate worktrees or reserve native capacity: the parent/owner assigns a distinct worktree to every writer and confines each helper to its task. Read-only helpers can inspect assigned worktrees; sibling write access is not granted by this profile.

Claude owners need the lifecycle tools as well as Agent. A background helper's result arrives as the host's completion notification (which also names the worktree it used) and in the files the helper wrote; `TaskOutput` was removed in Claude Code 2.1.277, and the helper's transcript under `subagents/agent-<id>.jsonl` is evidence, not a result to load into context. Reconcile the handle inventory with `ListAgents`, continue the exact collected helper through SendMessage, and stop a live task through TaskStop. A background helper gets a reduced tool set: no Agent, no ListAgents, no CronCreate or ScheduleWakeup (measured 2026-10-08 on 2.1.293); plan the owner so that only the owner itself spawns and schedules. Scope these operations to the assigned local helpers. An Agent launch alone does not demonstrate that the owner can finish that lifecycle. A stopped or completed handle is not proof of slot release.

For a Claude writer, prefer Agent's native `isolation: "worktree"` when it supplies the assigned repository and scope; retain the returned path and inspect the actual effects there. A directory named in a prompt does not change the helper's cwd or permissions. Headless Claude can ignore capability-granting `permissions.additionalDirectories` in an untrusted project's settings. Confirm effective access before selecting a precreated sibling worktree; a settings entry alone is not a grant or a proof. Do not bypass a denial through another tool.

An owner starts fresh but retains its session ID so the native CLI can resume the same task when state must survive. Use the exact receipt's ID and the CLI's advertised resume operation; check the configured descriptor, cwd and tools before continuing. A persisted writer context is never an independent reviewer. Ordinary lanes remain ephemeral/nonpersistent where the previous route supported it. Ending a headless owner still requires draining its live children; persistence is not a background service. On 2.1.292 a headless owner whose turn ended with a native helper still running was re-invoked by the helper's completion inside the same `claude -p` process, so its JSON output carried two `result` events and the receipt kept the last; the owner must still not treat its own first reply as final while a helper is live.

For Claude owners, usage aggregated across helpers cannot attest the owner's model. The parser uses the model in a root assistant message (`parent_tool_use_id: null`) from verbose JSON. Without that evidence it cannot claim a verified root model. Codex continues to report the pinned argv and `modelVerified: false`, not a backend attestation. The receipt's `effort` is requested effort for every provider. Grok's ACP model selection response corroborates configuration and its final usage reports the served model; neither establishes served effort. Codex thread/turn metadata is also local configuration. Keep these distinctions in the report without adding an attestation gate; see [model and effort evidence](codex-tools.md#model-and-effort-evidence).

Hooks and cross-session memories remain disabled in Codex to keep task context independent and avoid implicit execution outside the selected task. Grok retains its measured core-shell-environment overlay and sandbox rules. No effort, matrix default, Arena exclusion, trail policy, swarm fallback or delivery gate changes. The [decision and evidence](../../../docs/research/2026-10-07-runner-capabilities.md) record what was actually exercised, including provider limits.
