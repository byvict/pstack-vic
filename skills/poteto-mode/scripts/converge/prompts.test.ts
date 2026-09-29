import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const prompts = readFileSync(new URL('../../references/pre-pr-prompts.md', import.meta.url), 'utf8');
function firstTextFenceUnder(heading: string): string {
  const section = prompts.split(/^## /m).find(chunk => chunk.startsWith(heading + '\n'));
  const match = section?.match(/^```text\n([\s\S]*?)\n```$/m);
  assert.ok(match, `no text fence under ${heading}`);
  return match[1];
}
const placeholders = (text: string) => [...new Set(text.match(/\{\{[a-zA-Z]+\}\}/g))].sort();
const finalJson = (text: string) => text.slice(text.indexOf('End with exactly this JSON'));

test('the light reviewer block asks for the same placeholders as the reviewer block', () => {
  assert.deepEqual(placeholders(firstTextFenceUnder('Reviewer (light)')), placeholders(firstTextFenceUnder('Reviewer')));
});
test('the light reviewer block ends with the same final JSON as the reviewer block', () => {
  assert.equal(finalJson(firstTextFenceUnder('Reviewer (light)')), finalJson(firstTextFenceUnder('Reviewer')));
});
test('the light reviewer block is the reviewer block with one narrowing sentence after the review instruction', () => {
  const anchor = 'Review the diff for defects and risks.';
  const light = firstTextFenceUnder('Reviewer (light)');
  const added = light.slice(light.indexOf(anchor) + anchor.length, light.indexOf(' Read the run logs for failures'));
  assert.match(added, /^ [^.]+\.$/);
  assert.equal(light.replace(added, ''), firstTextFenceUnder('Reviewer'));
});
