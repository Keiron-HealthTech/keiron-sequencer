import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../scripts/packs.mjs';
import { packPath } from '../scripts/lib/packs.mjs';
import { serializeRecord } from '../scripts/lib/record.mjs';
import { fakeLinearStore, FIXTURE_SLUG as SLUG } from './helpers/fake-linear.mjs';
import { tempDir } from './helpers/git-sandbox.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import { startRecord } from './helpers/start-fixture.mjs';

guardNetwork();

const DIR = tempDir('keiron-sequencer-packs-cli-');
after(() => rmSync(DIR, { recursive: true, force: true }));
const KEY = 'lin_api_dummy_' + 'p'.repeat(30);
const done = { state: { name: 'Done', type: 'completed' } };
const blocks = to => ({ relations: { nodes: [{ type: 'blocks', relatedIssue: { identifier: to } }] } });
const issue = (identifier, over = {}) => ({
  identifier, title: `Card ${identifier}`, url: `u/${identifier}`, estimate: null, archivedAt: null, description: `Text of ${identifier}.`,
  state: { name: 'Backlog', type: 'backlog' }, projectMilestone: null, labels: { nodes: [] }, ...over,
});
// CRM-1 is done and blocks CRM-2, which is startable; CRM-2 blocks CRM-3, a descendant; CRM-4 is startable with no people decision.
const issues = (over = {}) => [
  issue('CRM-1', { ...done, ...blocks('CRM-2') }), issue('CRM-2', { ...blocks('CRM-3'), ...over['CRM-2'] }), issue('CRM-3'), issue('CRM-4'),
];
const people = text => ({ text, impact: 'design', owner: 'people', status: 'open' });
const record = (card, openDecisions) => ({ ...startRecord(card, { openDecisions, project: { slug: SLUG, name: 'P' } }), card, title: `Card ${card}` });

let n = 0;
function home() {
  const dir = join(DIR, `home-${++n}`);
  mkdirSync(join(dir, SLUG), { recursive: true });
  for (const r of [record('CRM-2', [people('Who may see it.')]), record('CRM-3', [people('Which retention.')]), record('CRM-4', [{ ...people('Which index.'), owner: 'code' }])]) {
    writeFileSync(join(dir, SLUG, `${r.card}.json`), serializeRecord(r));
  }
  return dir;
}
const deps = (dir, store) => ({ env: { LINEAR_API_KEY: KEY }, keyFile: join(DIR, 'absent.key'), now: () => new Date('2026-11-12T10:00:00.000Z'), fetchImpl: store.fetchImpl, dataDir: dir, home: dir });

test('draft covers only frontier cards', async () => {
  const dir = home();
  const r = await run(['draft', SLUG], deps(dir, fakeLinearStore({ issues: issues() })));
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.drafted, ['CRM-2']);
  assert.deepEqual(out.skipped, [{ card: 'CRM-4', reason: 'no people-owned open decision' }]);
  assert.equal(existsSync(packPath(dir, SLUG, 'CRM-3')), false);
  const pack = JSON.parse(readFileSync(packPath(dir, SLUG, 'CRM-2'), 'utf8'));
  assert.deepEqual(pack.questions.map(q => q.text), ['Who may see it.']);
  const again = JSON.parse((await run(['draft', SLUG], deps(dir, fakeLinearStore({ issues: issues() })))).stdout);
  assert.deepEqual([again.drafted, again.fresh], [[], ['CRM-2']]);
});

test('status reports a pack stale after the card text changes, and an answer is kept when the pack is drafted again', async () => {
  const dir = home();
  await run(['draft', SLUG], deps(dir, fakeLinearStore({ issues: issues() })));
  const fresh = JSON.parse((await run(['status', SLUG], deps(dir, fakeLinearStore({ issues: issues() })))).stdout);
  assert.deepEqual(fresh.packs, [{ card: 'CRM-2', state: 'unanswered', reason: null, answered: 0, open: 1 }]);

  const answered = await run(['answer', SLUG, 'CRM-2', 'q1', '--outcome', 'No customer record reaches a user without a grant.'], deps(dir, fakeLinearStore({ issues: issues() })));
  assert.equal(answered.code, 0, answered.stderr);
  const done1 = JSON.parse((await run(['status', SLUG], deps(dir, fakeLinearStore({ issues: issues() })))).stdout);
  assert.deepEqual(done1.packs, [{ card: 'CRM-2', state: 'fresh', reason: null, answered: 1, open: 0 }]);

  const changed = fakeLinearStore({ issues: issues({ 'CRM-2': { description: 'A rewritten card.' } }) });
  const stale = JSON.parse((await run(['status', SLUG], deps(dir, changed))).stdout);
  assert.deepEqual(stale.packs, [{ card: 'CRM-2', state: 'stale', reason: 'card-text', answered: 1, open: 0 }]);
  await run(['draft', SLUG], deps(dir, fakeLinearStore({ issues: issues({ 'CRM-2': { description: 'A rewritten card.' } }) })));
  const redrafted = JSON.parse(readFileSync(packPath(dir, SLUG, 'CRM-2'), 'utf8'));
  assert.equal(redrafted.questions[0].answer.outcome, 'No customer record reaches a user without a grant.');

  const bad = await run(['answer', SLUG, 'CRM-2', 'q9', '--outcome', 'x'], deps(dir, fakeLinearStore({ issues: issues() })));
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /q9/);
});

test('draft --card drafts only that card, even a descendant start is starting, and prints its questions', async t => {
  const dir = home();
  const r = await run(['draft', SLUG, '--card', 'CRM-3'], deps(dir, fakeLinearStore({ issues: issues() })));
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual([out.drafted, out.fresh, out.skipped], [['CRM-3'], [], []]);
  assert.equal(existsSync(packPath(dir, SLUG, 'CRM-2')), false, 'no other card is drafted');
  assert.deepEqual(out.pack, {
    card: 'CRM-3', state: 'unanswered', answered: 0, open: 1,
    questions: [{ id: 'q1', text: 'Which retention.', evidence: [], options: [], owner: 'people', answer: null }],
  });

  await run(['answer', SLUG, 'CRM-3', 'q1', '--outcome', 'Records are kept as long as the law requires.'], deps(dir, fakeLinearStore({ issues: issues() })));
  const again = JSON.parse((await run(['draft', SLUG, '--card', 'CRM-3'], deps(dir, fakeLinearStore({ issues: issues() })))).stdout);
  assert.deepEqual([again.drafted, again.fresh, again.pack.state, again.pack.open], [[], ['CRM-3'], 'fresh', 0]);
  assert.equal(again.pack.questions[0].answer.outcome, 'Records are kept as long as the law requires.');
});

test('draft --card skips a card with no record or nothing to ask, and refuses a card off the map', async t => {
  const dir = home();
  const store = () => fakeLinearStore({ issues: [...issues(), issue('CRM-5')] });
  const none = JSON.parse((await run(['draft', SLUG, '--card', 'CRM-4'], deps(dir, store()))).stdout);
  assert.deepEqual([none.skipped, none.pack], [[{ card: 'CRM-4', reason: 'no people-owned open decision' }], null]);
  const unrecorded = JSON.parse((await run(['draft', SLUG, '--card', 'CRM-5'], deps(dir, store()))).stdout);
  assert.deepEqual([unrecorded.skipped, unrecorded.pack], [[{ card: 'CRM-5', reason: 'no record' }], null]);
  const off = await run(['draft', SLUG, '--card', 'CRM-9'], deps(dir, store()));
  assert.equal(off.code, 2);
  assert.match(off.stderr, /CRM-9 is not an execution card/);
  const bad = await run(['draft', SLUG, '--card', 'nope'], deps(dir, store()));
  assert.equal(bad.code, 2);
});
