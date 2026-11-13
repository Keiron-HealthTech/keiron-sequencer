import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { guardNetwork } from './helpers/no-network.mjs';

guardNetwork();

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const skill = read('skills/cycle/SKILL.md');
const frontMatter = skill.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';
const flat = skill.replace(/\s+/g, ' ');
const says = text => assert.ok(flat.includes(text), `SKILL.md does not say ${JSON.stringify(text)}`);

test('front matter names the skill cycle with a "sequencer cycle" trigger', () => {
  assert.match(frontMatter, /^name: cycle$/m);
  assert.match(frontMatter, /^description: /m);
  assert.match(frontMatter, /sequencer cycle/);
});

test('the steps resolve, ask availability, guess sizes, plan, present and STOP, and only then apply', () => {
  const headings = [
    '## Step 1: Resolve the project and team', '## Step 2: Ask availability', '## Step 3: Guess sizes',
    '## Step 4: Plan', '## Step 5: Present the plan and STOP', "## Step 6: Apply, only on the user's explicit command",
  ];
  const at = headings.map(h => skill.indexOf(`\n${h}\n`));
  headings.forEach((h, i) => assert.ok(at[i] > 0, `missing heading ${JSON.stringify(h)}`));
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'the steps are out of order');
});

test('availability is relative to usual pace, 100% by default, 0% for people who take no cards', () => {
  says('relative to');
  says('100%');
  says('0%');
});

test('availability is asked for the members that needs lists, and a later-cycle card is not moved', () => {
  says('`members`');
  says('scheduled for a later cycle');
});

test('sizes are guessed from the card against spiked anchors and passed with --guess', () => {
  says('cycle.mjs needs');
  says('--guess');
  says('anchors');
  says('default M');
});

test("the skill never applies without the user's command and the hash, and says stretch cards are not added", () => {
  says("never apply without the user's command and the hash");
  says('--approve');
  says('stretch');
  says('Exit 6');
});

test('the skill never prints the key and names no old name or repo folder', () => {
  says('Never print, echo or `cat` the key');
  assert.doesNotMatch(skill, new RegExp('mi' + 'kado', 'i'));
  assert.ok(!skill.includes('Desktop/keiron-sequencer'));
});

test('the plugin and marketplace descriptions name cycle', () => {
  assert.match(JSON.parse(read('.claude-plugin/plugin.json')).description, /\bcycle\b/);
  assert.match(JSON.parse(read('.claude-plugin/marketplace.json')).plugins[0].description, /\bcycle\b/);
});
