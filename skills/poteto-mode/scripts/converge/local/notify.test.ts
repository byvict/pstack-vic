import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appleScriptString, notify } from './notify.ts';

function temporary(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'notify-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
/** An osascript that runs `body`, first on PATH; `calls` reads what a recording fake wrote. */
function fake(t: TestContext, body: string) {
  const directory = temporary(t);
  const osascript = join(directory, 'osascript');
  writeFileSync(osascript, `#!/bin/sh\n${body}\n`); chmodSync(osascript, 0o700);
  const calls = join(directory, 'osascript.calls');
  return { env: { PATH: `${directory}:${process.env.PATH}` }, calls: () => existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').slice(0, -1) : [] };
}
const recording = 'printf \'%s\\n\' "$*" >> "$0.calls"';
const notice = { title: 'Converge local', subtitle: 'Example/app', body: 'Held Example/app#1: 2 failed attempts' };

test('notify passes osascript one script as an argument, every double quote and backslash of the notice escaped, and returns null on exit 0', t => {
  const { env, calls } = fake(t, recording);
  assert.equal(notify({ title: 'Converge "local"', subtitle: 'C:\\repo', body: 'say "hi" \\ bye' }, { env }), null);
  assert.deepEqual(calls(), [String.raw`-e display notification "say \"hi\" \\ bye" with title "Converge \"local\"" subtitle "C:\\repo" sound name "Basso"`]);
});
test('AppleScript reads an escaped string back as the original text', { skip: process.platform !== 'darwin' }, () => {
  const text = 'say "hi" \\ bye';
  const result = spawnSync('/usr/bin/osascript', ['-e', 'return ' + appleScriptString(text)], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, text + '\n');
});
test('an osascript that exits non-zero returns its code and stderr', t => {
  const { env } = fake(t, 'echo boom >&2; exit 2');
  assert.equal(notify(notice, { env }), 'osascript exited 2: boom');
});
test('an osascript past the cap that ignores SIGTERM is killed and returns the cap, long before its own end', t => {
  const { env } = fake(t, 'trap "" TERM; exec sleep 5');
  const started = Date.now();
  assert.equal(notify(notice, { env, timeoutMs: 300 }), 'osascript did not finish within 0.3 s');
  assert.ok(Date.now() - started < 3_000, `returned after ${Date.now() - started} ms, not at the 300 ms cap`);
});
test('no osascript on PATH returns why it did not start', t => {
  assert.equal(notify(notice, { env: { PATH: temporary(t) } }), 'osascript did not start: spawnSync osascript ENOENT');
});
test('an argument Node refuses to pass returns why osascript did not start instead of throwing', t => {
  const { env, calls } = fake(t, recording);
  assert.match(String(notify({ ...notice, body: 'nul \0 byte' }, { env })), /^osascript did not start: .*null bytes/);
  assert.deepEqual(calls(), []);
});
