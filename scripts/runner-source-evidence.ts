import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}

export function assertReadonlyLocation(directory: string, writable = ["/tmp", "/var/tmp", tmpdir(), join(homedir(), ".grok")]): void {
  const target = realpathSync(directory);
  for (const root of writable.filter(existsSync)) {
    const path = relative(realpathSync(root), target);
    assert.ok(path === ".." || path.startsWith(`..${sep}`), `Read-only proof must be outside writable sandbox exception ${root}`);
  }
}

export function terminalResults(events: unknown[], provider: "codex" | "grok") {
  return events.flatMap((raw) => {
    const event = object(raw);
    if (provider === "codex") {
      const item = object(event.item);
      if (event.type !== "item.completed" || item.type !== "command_execution") return [];
      return [{ id: item.id, command: item.command, exitCode: item.exit_code, output: String(item.aggregated_output ?? "") }];
    }
    const update = object(event.update), output = object(update.rawOutput);
    if (!["completed", "failed"].includes(String(update.status)) || output.type !== "Bash") return [];
    return [{ id: update.toolCallId, command: output.command, exitCode: output.exit_code, output: String(output.output_for_prompt ?? "") }];
  });
}

export function assertReadonlyResult(events: unknown[], provider: "codex" | "grok", digest: string, forbidden: string) {
  // The parent writes this fixed script before launch. Accept only its execution,
  // not assistant prose, MCP content, an echoed command or an unrelated failure.
  const attempts = terminalResults(events, provider).filter((call) => typeof call.command === "string"
    && /^(?:python3 readonly-probe\.py|\/bin\/(?:zsh|bash|sh) -lc ['"]python3 readonly-probe\.py['"])$/.test(call.command));
  assert.equal(attempts.length, 1, "Expected one completed execution of the controlled write probe");
  const attempt = attempts[0];
  assert.equal(attempt.exitCode, 1, "Controlled write probe did not fail");
  assert.ok(attempt.output.includes(digest), "Missing computed digest in terminal result");
  assert.ok(attempt.output.includes(forbidden), "Denial did not name the controlled target");
  assert.match(attempt.output, /PermissionError:.*(?:Operation not permitted|Permission denied)|OSError:.*Read-only file system/);
  return attempt;
}
