import { readFileSync } from 'node:fs';
import { object, oneOf, string } from '../contract.ts';
import { claimLinearEffect } from './linear.ts';

try {
  const input = object(JSON.parse(readFileSync(0, 'utf8')));
  claimLinearEffect(string(process.argv[3]), string(input.tool_name), input.tool_input, oneOf(process.argv[2], ['read', 'write']));
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }) + '\n');
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  process.stderr.write(reason + '\n');
  process.exitCode = 2;
}
