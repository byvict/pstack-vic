# Verify native source consumption

Use the host's existing transcript and tool-result facilities. The investigator's receipt tells you which calls and reads to check, but is not proof that they happened.

## Locate the child runtime

Retain the native `Agent` or `spawn_agent` result when dispatching each investigator. Record the actual child/runtime ID and task handle returned by the host beside its receipt. If the host exposes only a task handle, resolve its runtime through the host metadata. An investigator's claimed ID or a task name alone does not establish runtime identity.

Open only the transcript for that known child. Use a host-provided transcript path when available. Otherwise use the locator for the current host below. Scope discovery to the known checkout, parent session, and child runtime, rather than scanning unrelated chats.

### Codex

Codex Desktop stores rollouts under `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<runtime-id>.jsonl`. Locate the file whose name ends in the known child runtime ID, within the dispatch date's directory. If the dispatch crosses a date boundary, check the adjacent date directory for that same ID.

Read its `session_meta` event. Match `payload.id` to the child runtime ID and check `parent_thread_id` and `agent_path` against the retained dispatch. `payload.session_id` can be the shared parent session ID, so it is not sufficient to identify the child. When the transcript includes inherited history, use the host's history boundary, such as `subagent_history_start_ordinal`, to distinguish the child's events from copied parent events.

In this host's rollout format, native calls are top-level `response_item` events whose payload type is `custom_tool_call` or `function_call`. Pair them with `custom_tool_call_output` or `function_call_output` by the same `call_id`. Read the call's tool name and input or arguments, then the matching result's output. For a `functions.exec` wrapper, inspect the invoked source tool and its returned payload. A script that names a tool, or output that contains only a summary, cannot establish the omitted source content.

### Claude Code

Claude Code stores project transcripts under `~/.claude/projects/<encoded-checkout>/`. Use the project directory selected by the known checkout's host metadata. Native subagent transcripts are under `<parent-session-id>/subagents/agent-<agent-id>.jsonl` within that directory. Prefer the exact transcript path returned by the native `Agent` handle when it is available. Match the child `agentId`, parent `sessionId`, and checkout metadata to the retained handle. If that host version uses a different location, resolve it through that handle's metadata and record the actual path.

Read host transcript messages whose structured `message.content` contains `tool_use` or `tool_result` blocks. Pair each `tool_use.id` with the matching `tool_result.tool_use_id`. Check the tool name, input, result content, and `is_error`. Tool-shaped text inside an assistant text block is not a structured call. A parent transcript or an external CLI session proves only that runtime's calls, even when it uses the same model.

## Match calls and read coverage

For each receipt entry:

1. Identify the child's host call and matching terminal result. Record the transcript path and event or line references, call ID, actual source tool, and arguments. A missing result, access error, or timed-out call leaves a gap.
2. Compare the returned source IDs, counts, and content with the receipt. Count a query as empty only when its successful native result has no matches. Tool availability, request arguments, and a receipt's call list do not prove the result.
3. Verify a full read for every relevant object. Account separately for the body, comments, attached or linked documents, and remaining pages. Search snippets, titles, and metadata identify leads. They do not establish a full read. Inspect pagination, cursors, truncation, and output limits. Follow a document's chunk reads back to the same returned document ID and account for its full range. Name every unread portion as a gap.
4. Record `verified` only for the calls and content the host evidence confirms. Record `consumption unverified` when that evidence is missing, even if the investigator supplies a convincing receipt or writes a receipt file. Preserve `partial` for incomplete reads.

Add this verdict and the host references beside the receipt in the existing findings. Pass them to the synthesizer through the coverage map. Recovery calls belong to the runtime that made them. A parent replay or synthesizer spot-check cannot retroactively verify the child's consumption.

Partial synthesis is allowed with explicit limits. A claim supported only by unverified consumption cannot enter direct findings. Recover a verified read or keep the claim and its source gap in the uncertainty sections.
