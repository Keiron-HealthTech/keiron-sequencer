import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { guardNetwork } from './helpers/no-network.mjs';

guardNetwork();

const skill = readFileSync(new URL('../skills/harvest/SKILL.md', import.meta.url), 'utf8');
const frontMatter = skill.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';
const flat = skill.replace(/\s+/g, ' ');
const says = text => assert.ok(flat.includes(text), `SKILL.md does not say ${JSON.stringify(text)}`);

test('front matter names the skill harvest, keeps the plain trigger and adds "sequencer harvest"', () => {
  assert.match(frontMatter, /^name: harvest$/m);
  assert.match(frontMatter, /^description: /m);
  assert.match(frontMatter, /harvest the spikes/);
  assert.match(frontMatter, /sequencer harvest/);
});

test('the skill holds no old name and names no repo folder', () => {
  assert.doesNotMatch(skill, new RegExp('mi' + 'kado', 'i'));
  assert.ok(!skill.includes('Desktop/' + 'mi' + 'kado'));
  assert.ok(!skill.includes('Desktop/keiron-sequencer'));
  assert.ok(!skill.includes('/' + 'mi' + 'kado-'));
});

test('the steps run draft, curate, cases, translate, plan, then present and STOP, and only then apply or undo', () => {
  const headings = [
    '## Step 1: Draft', '## Step 2: Curate', '## Step 3: Cases', '## Step 4: Translate',
    '## Step 5: Plan', '## Step 6: Present the review and STOP', "## Step 7: Apply or undo, only on the user's explicit command",
  ];
  const at = headings.map(h => skill.indexOf(`\n${h}\n`));
  headings.forEach((h, i) => assert.ok(at[i] > 0, `missing heading ${JSON.stringify(h)}`));
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'the steps are out of order');
});

test("the skill never applies without the user's command and the hash", () => {
  says("never apply without the user's command and the hash");
  says('--approve');
  says('the run id');
});

test('every exit code 0 to 6 is handled', () => {
  for (let code = 0; code <= 6; code++) assert.ok(skill.includes(`Exit ${code}`), `missing Exit ${code}`);
});

test('the CLI is called by path, and an identifier ref is documented as costing one project read', () => {
  for (const cmd of ['draft <slug>', 'cases <slug>', 'plan <project-ref>', 'apply <project-ref> --plan', 'undo <project-ref> --run']) {
    says('node ${CLAUDE_PLUGIN_ROOT}/scripts/harvest.mjs ' + cmd);
  }
  says('~/.keiron-sequencer/<slug>/harvest/');
  says('kept');
  assert.doesNotMatch(skill, /data\/<slug>\/harvest|committed|to commit/);
  says('one read-only project query');
});

test('the skill never shows a key, an auth header or the key file contents', () => {
  assert.doesNotMatch(skill, /lin_api_/i);
  assert.doesNotMatch(skill, /Bearer/i);
  assert.doesNotMatch(skill, /LINEAR_API_KEY\s*=\s*\S/);
  assert.doesNotMatch(skill, /\b(cat|less|head|tail|more)\b[^\n]*linear\.key/);
  says('Never print, cat or copy the Linear key');
});

test('the agent notes carry the cases, the decisions and the open decisions, translated and titled Notas del agente', () => {
  for (const anchor of [
    '`decisions` and `openDecisions`', '`d1`', '`o1`', 'by position', 'Casos de aceptación', 'Decisiones', 'Decisiones abiertas',
    '(abierta, la deciden personas)', '(acotada)', '+++ Notas del agente', 'replaced, not duplicated',
  ]) says(anchor);
});

test('curation keeps only hard dependencies, never runs an edge backward across milestones, and reads the fixup note', () => {
  for (const anchor of [
    'An edge needs a hard dependency', 'cannot build, pass its own tests or deploy without the blocker',
    'whichever merges second rebases', 'uses code the blocker adds',
    'only repaired the earlier card\'s own patch', 'reject it with that reason', 'the fixup\'s note',
    '`backward-milestone`', 'Milestones are deliverables, in order',
  ]) says(anchor);
});

test('an edge a chain already implies is never added, and a live edge the plan makes redundant is named, not removed', () => {
  for (const anchor of [
    'Never add an edge a chain already implies', 'even with real code evidence', 'the chain already orders the cards',
    '`redundant`', '`live-redundant`', 'propose its removal',
  ]) says(anchor);
  assert.doesNotMatch(skill, /`implied`/);
});

test('a backward-milestone refusal goes to the user, and an unblocked pair that a record names needs an order note', () => {
  says('`backward-milestone` refusal is the user\'s call, never yours');
  says('`unordered-reference`');
  says('`unaddressed-reference`');
  says('`reorder` findings that name a card');
  says('`order`');
  says('`backward-reference` warning');
  says('a chain of relations already orders them');
  assert.doesNotMatch(flat, /is a preference, not a dependency/);
});
