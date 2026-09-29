import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { PLUGIN_ROOT } from '../../../../../scripts/model-matrix.ts';
import { assertDefaultConfig, defaultConfigFile, loadConfig } from './config.ts';
import { attemptFrom, launchRaiz, raizCommand, raizLane, raizPrompt, raizRow, type RaizInput } from './raiz.ts';
import { parseOutcome, type OutcomeFile } from './outcome.ts';

const head = 'b'.repeat(40);
function temp(t: { after(fn: () => void): void }): string { const d = mkdtempSync(join(tmpdir(), 'raiz-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; }
function fakeClaude(dir: string, body: string): NodeJS.ProcessEnv {
  const bin = join(dir, 'bin'); const path = join(bin, 'claude');
  mkdirSync(bin, { recursive: true });
  writeFileSync(path, '#!/bin/sh\n' + body + '\n', { mode: 0o700 }); chmodSync(path, 0o700);
  return { ...process.env, PATH: bin + ':' + process.env.PATH, FAKE_ARGV: join(dir, 'argv.txt') };
}
const input = (dir: string, extra: Partial<RaizInput> = {}): RaizInput => ({ repo: 'Example/app', pr: 1, kind: 'certify', head, branch: 'change', checkout: dir, runDirectory: join(dir, 'run'), pluginDir: '/plugin', leaseBy: 'daemon:1', ...extra });
const outcome = (fields: Record<string, unknown>) => JSON.stringify({ schemaVersion: 1, repo: 'Example/app', pr: 1, head, kind: 'certify', outcome: 'certified', reason: '', verdictUrl: 'https://github.com/Example/app/pull/1#issuecomment-100', arm: 'armed', adjustRounds: 0, runDirectory: '__RUN__', ...fields });
const writer = (json: string) => `printf '%s\\n' "$@" > "$FAKE_ARGV"; prompt=$(cat); run=$(printf '%s\\n' "$prompt" | sed -n 's/^RUN=//p'); printf '%s' '${json}' | sed "s|__RUN__|$run|" > "$run/outcome.json"`;
const fable = { provider: 'claude', model: 'fable', effort: 'max' };

test('raizLane reads one native, non-alias lane from the sheet', () => {
  assert.equal(raizRow('# sheet\n\nbug-fix: claude:claude-opus-5-5@xhigh\nconverge raiz: claude:fable@max\n'), 'claude:fable@max');
  assert.throws(() => raizRow('bug-fix: claude:claude-opus-5-5@xhigh\n'), /no converge raiz row; run \/setup-pstack/);
  assert.throws(() => raizRow('converge raiz: claude:fable@max, claude:claude-opus-5-5@xhigh\n'), /takes one lane/);
  assert.deepEqual(raizLane('converge raiz: claude:fable@max\n', 'claude'), { provider: 'claude', model: 'fable', effort: 'max' });
  assert.deepEqual(raizLane('converge raiz: codex:gpt-6-sol@high\n', 'codex'), { provider: 'codex', model: 'gpt-6-sol', effort: 'high' });
  assert.throws(() => raizLane('converge raiz: codex:gpt-6-sol@xhigh\n', 'claude'), /must be native to the claude parent, not codex/);
  assert.throws(() => raizLane('converge raiz: inherit-parent\n', 'claude'), /cannot be an alias/);
  assert.throws(() => raizLane('converge raiz: claude:fable@ultra\n', 'claude'), /does not select effort ultra/);
});
test('raizRow refuses a sheet with two converge raiz rows', () => {
  assert.throws(() => raizRow('converge raiz: claude:fable@max\nconverge raiz: claude:claude-opus-5-5@xhigh\n'), /more than one converge raiz row/);
});
test('raizCommand builds the parent argv with the prompt on stdin', () => {
  assert.deepEqual(raizCommand({ provider: 'claude', model: 'claude-opus-5-5', effort: 'xhigh' }, { checkout: '/repo', pluginDir: '/plugin' }), { command: 'claude', args: ['-p', '--model', 'claude-opus-5-5', '--effort', 'xhigh', '--permission-mode', 'bypassPermissions', '--plugin-dir', '/plugin', '--output-format', 'json'] });
  assert.deepEqual(raizCommand({ provider: 'codex', model: 'gpt-6-sol', effort: 'xhigh' }, { checkout: '/repo', pluginDir: '/plugin' }), { command: 'codex', args: ['exec', '--model', 'gpt-6-sol', '--config', 'model_reasoning_effort="xhigh"', '--sandbox', 'danger-full-access', '--cd', '/repo', '--skip-git-repo-check', '-'] });
  assert.throws(() => raizCommand({ provider: 'grok', model: 'grok-4.7', effort: 'high' }, { checkout: '/repo', pluginDir: '/plugin' }), /No raiz command for provider grok/);
});
test('raizPrompt names the playbook and every input on its own line', () => {
  const prompt = raizPrompt(input('/work', { kind: 'repair' }));
  assert.match(prompt, /^Read \/plugin\/skills\/poteto-mode\/playbooks\/catch-up\.md in full/);
  for (const line of ['REPO=Example/app', 'PR=1', 'KIND=repair', `HEAD=${head}`, 'BRANCH=change', 'CHECKOUT=/work', 'RUN=/work/run', 'PLUGIN=/plugin', 'LEASE_BY=daemon:1']) assert.ok(prompt.split('\n').includes(line), line);
  assert.ok(prompt.includes('--by LEASE_BY --pid'), 'the renewal keeps the lease bound to the daemon pid');
});
test('raizPrompt refuses an input that would break its one-line-per-input shape', () => {
  assert.throws(() => raizPrompt(input('/work', { branch: 'change\nRUN=/elsewhere' })), /Unsafe raiz input branch/);
  assert.throws(() => raizPrompt(input('/work', { runDirectory: '/work/run\r' })), /Unsafe raiz input runDirectory/);
});
test('launchRaiz runs the parent CLI in the checkout, feeds the prompt, and reads outcome.json', async t => {
  const dir = temp(t);
  const env = fakeClaude(dir, writer(outcome({})));
  const launched = await launchRaiz(input(dir), { provider: 'claude', model: 'claude-opus-5-5', effort: 'xhigh' }, { env });
  assert.equal(launched.exitCode, 0); assert.equal(launched.timedOut, false);
  assert.equal(launched.outcome?.outcome, 'certified');
  assert.equal(launched.outcome?.runDirectory, join(dir, 'run'));
  assert.match(readFileSync(join(dir, 'argv.txt'), 'utf8'), /--permission-mode\nbypassPermissions\n--plugin-dir\n\/plugin/);
  assert.match(readFileSync(join(dir, 'run', 'prompt.txt'), 'utf8'), /^RUN=/m);
  assert.deepEqual(attemptFrom(input(dir), launched), { kind: 'certify', startedAt: launched.startedAt, endedAt: launched.endedAt, outcome: 'certified', reason: '', runDirectory: join(dir, 'run') });
});
test('a skipped outcome is no attempt; a missing or foreign outcome is a failed one', async t => {
  const dir = temp(t);
  const skipped = await launchRaiz(input(dir), { provider: 'claude', model: 'fable', effort: 'max' }, { env: fakeClaude(dir, writer(outcome({ outcome: 'skipped', reason: 'PR head moved', verdictUrl: null, arm: null, adjustRounds: null }))) });
  assert.equal(attemptFrom(input(dir), skipped), null);
  const foreign = await launchRaiz(input(dir, { runDirectory: join(dir, 'run2') }), { provider: 'claude', model: 'fable', effort: 'max' }, { env: fakeClaude(dir, writer(outcome({ pr: 2 }))) });
  assert.equal(foreign.outcome, null);
  assert.deepEqual(attemptFrom(input(dir, { runDirectory: join(dir, 'run2') }), foreign)?.reason, 'no outcome: raiz exited 0');
  const none = await launchRaiz(input(dir, { runDirectory: join(dir, 'run3') }), { provider: 'claude', model: 'fable', effort: 'max' }, { env: fakeClaude(dir, 'cat > /dev/null; exit 3') });
  assert.equal(attemptFrom(input(dir, { runDirectory: join(dir, 'run3') }), none)?.reason, 'no outcome: raiz exited 3');
});
test('an outcome counts only for the launched repo, PR, kind and run directory; its head may move', async t => {
  const dir = temp(t);
  const cases: [string, Record<string, unknown>, boolean][] = [
    ['another-repo', { repo: 'Example/other' }, false],
    ['another-kind', { kind: 'repair' }, false],
    ['another-run-directory', { runDirectory: '/elsewhere' }, false],
    ['a-moved-head', { head: 'c'.repeat(40) }, true],
  ];
  for (const [name, fields, accepted] of cases) {
    const launch = input(dir, { runDirectory: join(dir, name) });
    const launched = await launchRaiz(launch, fable, { env: fakeClaude(dir, writer(outcome(fields))) });
    assert.equal(launched.exitCode, 0, name);
    if (accepted) {
      assert.equal(launched.outcome?.head, 'c'.repeat(40), name);
      assert.equal(attemptFrom(launch, launched)?.outcome, 'certified', name);
    } else {
      assert.equal(launched.outcome, null, name);
      assert.deepEqual(attemptFrom(launch, launched), { kind: 'certify', startedAt: launched.startedAt, endedAt: launched.endedAt, outcome: 'failed', reason: 'no outcome: raiz exited 0', runDirectory: join(dir, name) }, name);
    }
  }
});
test('an outcome left in a reused run directory does not stand in for the new launch', async t => {
  const dir = temp(t);
  mkdirSync(join(dir, 'run'));
  writeFileSync(join(dir, 'run', 'outcome.json'), outcome({ outcome: 'skipped', reason: 'PR head moved', verdictUrl: null, arm: null, adjustRounds: null, runDirectory: join(dir, 'run') }));
  const launched = await launchRaiz(input(dir), fable, { env: fakeClaude(dir, 'cat > /dev/null') });
  assert.equal(launched.outcome, null);
  assert.equal(attemptFrom(input(dir), launched)?.reason, 'no outcome: raiz exited 0');
});
test('launchRaiz kills a Raiz past the cap and reports timeout', async t => {
  const dir = temp(t);
  const launched = await launchRaiz(input(dir), { provider: 'claude', model: 'fable', effort: 'max' }, { env: fakeClaude(dir, 'cat > /dev/null; exec sleep 30'), capMs: 300 });
  assert.equal(launched.timedOut, true);
  assert.deepEqual(attemptFrom(input(dir), launched)?.reason, 'timeout');
});
test('a parent CLI that cannot start is a failed attempt', async t => {
  const dir = temp(t);
  const launched = await launchRaiz(input(dir), fable, { env: { PATH: join(dir, 'empty') } });
  assert.equal(launched.exitCode, null); assert.equal(launched.timedOut, false); assert.equal(launched.outcome, null);
  assert.equal(attemptFrom(input(dir), launched)?.reason, 'no outcome: raiz did not start');
});
test('a Raiz killed by a signal reports the shell exit status, and its output lands in the log', async t => {
  const dir = temp(t);
  const launched = await launchRaiz(input(dir), fable, { env: fakeClaude(dir, 'cat > /dev/null; pwd -P; echo partial work >&2; kill -KILL $$') });
  assert.equal(launched.exitCode, 137); assert.equal(launched.timedOut, false);
  assert.equal(attemptFrom(input(dir), launched)?.reason, 'no outcome: raiz exited 137');
  assert.equal(launched.logPath, join(dir, 'run', 'raiz.log'));
  assert.deepEqual(readFileSync(launched.logPath, 'utf8').split('\n'), [realpathSync(dir), 'partial work', '']);
});
test('parseOutcome refuses a wrong schema, outcome or arm', () => {
  const good = JSON.parse(outcome({ runDirectory: '/r' }));
  assert.equal(parseOutcome(good).outcome, 'certified');
  assert.throws(() => parseOutcome({ ...good, schemaVersion: 2 }), /Unknown outcome schema/);
  assert.throws(() => parseOutcome({ ...good, outcome: 'done' }), /Invalid enum value/);
  assert.throws(() => parseOutcome({ ...good, arm: 'maybe' }), /Invalid enum value/);
});
test('parseOutcome round-trips a certified and a skipped outcome', () => {
  const certified: OutcomeFile = { schemaVersion: 1, repo: 'Example/app', pr: 7, head, kind: 'repair', outcome: 'certified', reason: '', verdictUrl: 'https://github.com/Example/app/pull/7#issuecomment-100', arm: 'armed', adjustRounds: 2, runDirectory: '/r' };
  const skipped: OutcomeFile = { ...certified, kind: 'certify', outcome: 'skipped', reason: 'PR head moved', verdictUrl: null, arm: null, adjustRounds: null };
  for (const value of [certified, skipped]) assert.deepEqual(parseOutcome(JSON.parse(JSON.stringify(value))), value);
});
test('parseOutcome refuses an empty identity field, a zero PR and negative adjust rounds', () => {
  const good = JSON.parse(outcome({ runDirectory: '/r' }));
  assert.throws(() => parseOutcome({ ...good, adjustRounds: -1 }), /Invalid adjust rounds/);
  assert.throws(() => parseOutcome({ ...good, adjustRounds: 1.5 }), /Invalid adjust rounds/);
  assert.throws(() => parseOutcome({ ...good, head: '' }), /Expected full commit SHA/);
  assert.throws(() => parseOutcome({ ...good, pr: 0 }), /Invalid PR/);
  assert.throws(() => parseOutcome({ ...good, repo: '' }), /Invalid repository/);
  assert.throws(() => parseOutcome({ ...good, runDirectory: '' }), /Invalid run directory/);
});

function gitCheckout(dir: string): string { const checkout = join(dir, 'app'); mkdirSync(join(checkout, '.git'), { recursive: true }); return checkout; }
function configFile(dir: string, value: unknown): string { const file = join(dir, 'converge-local.json'); writeFileSync(file, JSON.stringify(value)); return file; }

test('loadConfig fills the defaults from the home, the parent and the plugin root', t => {
  const dir = temp(t);
  const home = join(dir, 'home');
  const checkout = gitCheckout(dir);
  assert.equal(defaultConfigFile(home), join(home, '.config', 'pstack', 'converge-local.json'));
  const file = configFile(dir, { parent: 'codex', repos: [{ repo: 'Example/app', checkout }] });
  assert.deepEqual(loadConfig(file, home), { file, parent: 'codex', repos: [{ repo: 'Example/app', checkout }], intervalMinutes: 10, pluginDir: PLUGIN_ROOT,
    stateDirectory: join(home, 'Library', 'Application Support', 'pstack', 'converge-local'), sheetPath: join(home, '.codex', 'pstack-models.md'), logDirectory: join(home, 'Library', 'Logs') });
  assert.equal(loadConfig(configFile(dir, { parent: 'claude', repos: [{ repo: 'Example/app', checkout }] }), home).sheetPath, join(home, '.claude', 'pstack-models.md'));
});
test('loadConfig keeps explicit absolute paths and refuses a bad configuration', t => {
  const dir = temp(t);
  const checkout = gitCheckout(dir);
  const explicit = { parent: 'claude', repos: [{ repo: 'Example/app', checkout }], intervalMinutes: 5, pluginDir: '/plugin', stateDirectory: '/state', sheetPath: '/sheet.md', logDirectory: '/logs' };
  const file = configFile(dir, explicit);
  assert.deepEqual(loadConfig(file, '/home'), { file, ...explicit });
  assert.throws(() => loadConfig(join(dir, 'missing.json'), '/home'), /No configuration at .*missing\.json/);
  const refused: [Record<string, unknown>, RegExp][] = [
    [{ parent: 'grok' }, /Invalid enum value/],
    [{ repos: [] }, /Configuration lists no repository/],
    [{ repos: [{ repo: 'not a repo', checkout }] }, /Invalid repository/],
    [{ repos: [{ repo: 'Example/app', checkout: dir }] }, /is not a git repository/],
    [{ repos: [{ repo: 'Example/app', checkout: 'app' }] }, /checkout must be an absolute path/],
    [{ stateDirectory: 'state' }, /stateDirectory must be an absolute path/],
    [{ sheetPath: '~/.claude/pstack-models.md' }, /sheetPath must be an absolute path/],
    [{ intervalMinutes: 0 }, /intervalMinutes must be an integer from 1 to 60/],
    [{ intervalMinutes: 61 }, /intervalMinutes must be an integer from 1 to 60/],
    [{ intervalMinutes: 1.5 }, /intervalMinutes must be an integer from 1 to 60/],
  ];
  for (const [fields, error] of refused) assert.throws(() => loadConfig(configFile(dir, { ...explicit, ...fields }), '/home'), error, JSON.stringify(fields));
});
test('assertDefaultConfig admits only the default configuration, however the path is spelled', () => {
  const home = '/Users/v';
  const expected = defaultConfigFile(home);
  assert.doesNotThrow(() => assertDefaultConfig(expected, home));
  assert.doesNotThrow(() => assertDefaultConfig('/Users/v/.config/pstack/../pstack/converge-local.json', home));
  assert.doesNotThrow(() => assertDefaultConfig(relative(process.cwd(), expected), home), 'a relative path resolves against the working directory');
  for (const file of ['/Users/v/other.json', '/Users/w/.config/pstack/converge-local.json', 'converge-local.json']) {
    assert.throws(() => assertDefaultConfig(file, home), (error: Error) => error.message.includes(expected) && /the playbooks' converge-local lease commands read the default configuration/.test(error.message), file);
  }
});
