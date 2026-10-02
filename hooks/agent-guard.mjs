#!/usr/bin/env node
// PreToolUse hook on Claude Code's Agent tool. A pstack agent (poteto-agent, an
// autopilot owner) that spawns a built-in agent gets a lane without the
// poteto-mode skill and off the model sheet; Explore and Plan do not even load
// CLAUDE.md. The hook refuses that call and names the route to take.
//
// Claude Code sends `agent_type` only when the call comes from a subagent (or
// from a `claude --agent` session), so the main session is never refused. The
// hook fails open: a payload it cannot read allows the call.

import { readFileSync } from "node:fs";

const BUILT_IN = new Set(["Explore", "Plan", "general-purpose"]);
const DEFAULT_TYPE = "general-purpose";
const PSTACK_AGENT = /^pstack:/;

function refusal(input) {
  const caller = input?.agent_type;
  if (typeof caller !== "string" || !PSTACK_AGENT.test(caller)) return null;
  const target = input.tool_input?.subagent_type ?? DEFAULT_TYPE;
  if (!BUILT_IN.has(target)) return null;
  return `pstack: ${caller} may not spawn Claude Code's built-in ${target} agent, which runs without the poteto-mode skill and off the pstack model sheet. Dispatch a configured role through references/provider-dispatch.md of the poteto-mode skill (read-only exploration is the swarm or the how skill), or use poteto-agent for an inherit-parent helper.`;
}

function readInput() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return null;
  }
}

const reason = refusal(readInput());
if (reason !== null) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
}
