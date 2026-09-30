import { appendFileSync, readFileSync } from 'node:fs';

const [behavior, log] = process.argv.slice(2);
const input = JSON.parse(readFileSync(0, 'utf8'));
appendFileSync(log, JSON.stringify({ behavior, tool: input.tool_name, args: input.tool_input, toolUseId: input.tool_use_id, permissionMode: input.permission_mode }) + '\n', { mode: 0o600 });
if (behavior === 'allow') process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }) + '\n');
else if (behavior === 'deny') { process.stderr.write('PSTACK_FIXTURE_DENIED\n'); process.exitCode = 2; }
else if (behavior === 'exit1') { process.stderr.write('PSTACK_FIXTURE_HOOK_FAILED\n'); process.exitCode = 1; }
else if (behavior === 'timeout') await new Promise(resolve => setTimeout(resolve, 30_000));
else throw new Error('Unknown fixture hook behavior');
