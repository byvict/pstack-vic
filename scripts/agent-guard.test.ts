import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { PLUGIN_ROOT } from "./model-matrix.ts";

// hooks/agent-guard.mjs is the PreToolUse hook on Claude Code's Agent tool.
// In the CLI-223 autopilot run (2026-10-02) an owner spawned two built-in
// Explore agents: they ran on the owner's model, off the model sheet, and
// Explore does not load CLAUDE.md. The guard refuses that call and names the
// route to take instead. The payload shapes below were measured on Claude
// Code 2.1.287.

const GUARD = join(PLUGIN_ROOT, "hooks", "agent-guard.mjs");

function guard(stdin: string): { status: number | null; stdout: string } {
  const run = spawnSync(process.execPath, [GUARD], { input: stdin, encoding: "utf8" });
  return { status: run.status, stdout: run.stdout };
}

function agentCall(target: string, caller?: string): string {
  return JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_input: { subagent_type: target, description: "d", prompt: "p", run_in_background: true },
    ...(caller === undefined ? {} : { agent_id: "a69b44bac98d52b7f", agent_type: caller }),
  });
}

describe("agent guard", () => {
  for (const target of ["Explore", "Plan", "general-purpose"]) {
    it(`refuses the built-in ${target} agent when a pstack agent spawns it`, () => {
      const { status, stdout } = guard(agentCall(target, "pstack:poteto-agent"));
      assert.equal(status, 0);
      const { hookSpecificOutput } = JSON.parse(stdout);
      assert.equal(hookSpecificOutput.hookEventName, "PreToolUse");
      assert.equal(hookSpecificOutput.permissionDecision, "deny");
      assert.equal(
        hookSpecificOutput.permissionDecisionReason,
        `pstack: pstack:poteto-agent may not spawn Claude Code's built-in ${target} agent, which runs without the poteto-mode skill and off the pstack model sheet. Dispatch a configured role through references/provider-dispatch.md of the poteto-mode skill (read-only exploration is the swarm or the how skill), or use poteto-agent for an inherit-parent helper.`,
      );
    });
  }

  it("refuses a built-in agent for a generated owner agent too", () => {
    const { stdout } = guard(agentCall("Explore", "pstack:pstack-owner-opus-xhigh"));
    assert.equal(JSON.parse(stdout).hookSpecificOutput.permissionDecision, "deny");
  });

  it("stays silent when the main session spawns a built-in agent", () => {
    assert.deepEqual(guard(agentCall("Explore")), { status: 0, stdout: "" });
  });

  it("stays silent when a pstack agent spawns a pstack agent", () => {
    assert.deepEqual(guard(agentCall("pstack:poteto-agent", "pstack:poteto-agent")), { status: 0, stdout: "" });
    assert.deepEqual(guard(agentCall("pstack:pstack-opus-xhigh", "pstack:poteto-agent")), { status: 0, stdout: "" });
  });

  it("stays silent for an agent of another plugin", () => {
    assert.deepEqual(guard(agentCall("Explore", "other-plugin:reviewer")), { status: 0, stdout: "" });
  });

  it("reads a call with no agent type as general-purpose, the Agent tool's default", () => {
    const call = JSON.stringify({ tool_name: "Agent", tool_input: { prompt: "p" }, agent_type: "pstack:poteto-agent" });
    const { hookSpecificOutput } = JSON.parse(guard(call).stdout);
    assert.equal(hookSpecificOutput.permissionDecision, "deny");
    assert.match(hookSpecificOutput.permissionDecisionReason, /built-in general-purpose agent/);
  });

  it("allows the call when it cannot read the payload", () => {
    assert.deepEqual(guard("not json"), { status: 0, stdout: "" });
    assert.deepEqual(guard(""), { status: 0, stdout: "" });
  });
});
