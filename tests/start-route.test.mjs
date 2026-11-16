import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run as next } from '../scripts/next.mjs';
import { routeFor, verdictFor } from '../scripts/lib/start/route.mjs';
import { verdict } from '../scripts/lib/records.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import { CARD, fakeStartFixture, GIT_BRANCH_NAME, SLUG, startIssue, startRecord } from './helpers/start-fixture.mjs';

guardNetwork();

const card = startIssue(CARD, { gitBranchName: GIT_BRANCH_NAME });
const sized = (key, prodLines) => startRecord(key, { size: { ...startRecord(key).size, prodLines, testLines: 0 } });

const plan = async (f, argv = ['plan', CARD]) => {
  const r = await f.run(argv);
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const fixture = (t, opts) => {
  const f = fakeStartFixture(opts);
  t.after(f.dispose);
  return f;
};

test('the change name is the Linear branch name without its user prefix, and null without one', () => {
  const none = { verdict: { value: 'no record', tier: null, label: null }, record: null, siblings: null };
  assert.equal(routeFor(none, 'user/abc-1-some-title').changeName, 'abc-1-some-title');
  assert.equal(routeFor(none, 'abc-1-some-title').changeName, 'abc-1-some-title');
  assert.equal(routeFor(none, null).changeName, null);
});

test('no live record is "no record", a record with no size is judged with no tier, and neither throws', () => {
  assert.deepEqual(verdictFor([], CARD), { value: 'no record', tier: null, label: null });
  const unsized = startRecord(CARD, { size: null, riskAreas: [], openDecisions: [], novelty: { newPaths: [] } });
  assert.deepEqual(verdictFor([unsized], CARD), { value: 'No SDD', tier: null, label: null });
});

test('an old record lacking the verdict inputs is unknown, never No SDD, and still routes to sdd', () => {
  const old = { ...startRecord(CARD), novelty: undefined };
  const v = verdictFor([old], CARD);
  assert.equal(v.value, 'unknown');
  const r = routeFor({ verdict: v, record: old, siblings: null }, null);
  assert.deepEqual([r.route, r.said], ['sdd', 'unknown']);
});

test('the tier is taken over the live records of the map: adding one moves it, an off-map record does not', async t => {
  const others = ['ABC-2', 'ABC-3', 'ABC-4'];
  const issues = [card, ...others.map(k => startIssue(k))];
  const base = [sized(CARD, 400), ...others.map((k, i) => sized(k, 10 + i))];
  const alone = await plan(fixture(t, { issues, records: base }));
  assert.equal(alone.verdict.tier, 'XL');

  const bigger = await plan(fixture(t, { issues: [...issues, startIssue('ABC-5')], records: [...base, sized('ABC-5', 900)] }));
  assert.equal(bigger.verdict.tier, 'L');

  const offMap = await plan(fixture(t, { issues, records: [...base, sized('ABC-50', 900)] }));
  assert.equal(offMap.verdict.tier, 'XL');
});

test('the verdict and tier equal the ones the next CLI shows for the same card', async t => {
  const issues = [card, startIssue('ABC-2'), startIssue('ABC-3')];
  const f = fixture(t, { issues, records: [sized(CARD, 50), sized('ABC-2', 5), sized('ABC-3', 500)] });
  const out = await plan(f);
  const shown = await next([SLUG], { env: {}, fetchImpl: f.linear.fetchImpl, keyFile: f.keyFile, dataDir: f.dataDir, home: f.home, gh: f.gh.run, git: f.git.run, listDir: () => [] });
  assert.equal(shown.code, 0, shown.stderr);
  const size = JSON.parse(shown.stdout).free.find(c => c.key === CARD).size;
  assert.deepEqual([out.verdict.value, out.verdict.tier, out.verdict.label], [size.verdict, size.tier, size.label]);
});

test('the plan carries the route with its reasons; a card with no record is a complete plan with route null saying "no record"', async t => {
  const withRecord = await plan(fixture(t));
  assert.deepEqual([withRecord.route.route, withRecord.route.said, withRecord.route.changeName], ['sdd', null, 'abc-1-some-title']);
  assert.ok(withRecord.route.reasons.includes('people-decisions:1'), withRecord.route.reasons.join(', '));
  const none = await plan(fixture(t, { records: [] }));
  assert.equal(none.verdict.value, 'no record');
  assert.deepEqual(none.route, { route: null, said: 'no record', reasons: [], changeName: 'abc-1-some-title' });
  assert.equal(none.action, 'create');
});

test('a live record with no size gives a verdict with no tier instead of failing', async t => {
  const unsized = startRecord(CARD, { size: null, novelty: { newPaths: [] }, openDecisions: [] });
  const out = await plan(fixture(t, { records: [unsized] }));
  assert.deepEqual(out.verdict, { value: 'No SDD', tier: null, label: null });
  assert.equal(out.route.route, 'tdd');
});

test('a card off the execution map is a stop with no base decided and no record, exit 0', async t => {
  const qa = startIssue(CARD, { gitBranchName: GIT_BRANCH_NAME, labels: { nodes: [{ name: 'QA' }] } });
  const out = await plan(fixture(t, { issues: [qa] }));
  assert.equal(out.action, 'stop');
  assert.deepEqual(out.reasons.map(r => r.code), ['not-execution-card']);
  assert.equal(out.base.kind, null);
  assert.equal(out.verdict.value, 'no record');
  assert.equal(out.route.said, 'no record');
  assert.equal(out.brief.record, null);
  assert.match(out.brief.recordNote, /not on the execution map/);
});

test('an existing-PR record has no tier however large: No SDD with empty inputs, Light with a new path', async t => {
  const others = ['ABC-2', 'ABC-3', 'ABC-4'];
  const issues = [card, ...others.map(k => startIssue(k))];
  const smaller = others.map((k, i) => sized(k, 10 + i));
  const existingPr = over => ({ ...sized(CARD, 900), origin: 'existing-pr', riskAreas: [], openDecisions: [], novelty: { newPaths: [] }, ...over });

  const plain = await plan(fixture(t, { issues, records: [existingPr(), ...smaller] }));
  assert.deepEqual([plain.verdict.value, plain.verdict.tier, plain.verdict.label], ['No SDD', null, '900 lines · existing PR']);
  assert.equal(plain.route.route, 'tdd');

  const novel = await plan(fixture(t, { issues, records: [existingPr({ novelty: { newPaths: ['src/new/'] } }), ...smaller] }));
  assert.deepEqual([novel.verdict.value, novel.verdict.tier], ['Light', null]);
  assert.equal(novel.route.route, 'light');
});

const facts = (over = {}, { tier = 'S', unblocks = 0 } = {}) => {
  const record = startRecord(CARD, { openDecisions: [], novelty: { newPaths: [] }, ...over });
  return { verdict: { value: verdict(record, tier), tier, label: null }, record, card: { key: CARD }, siblings: { dependents: Array.from({ length: unblocks }, (_, i) => ({ key: `ABC-${10 + i}` })) } };
};

test('a cross-repo card routes to sdd with reason repos>1', () => {
  const r = routeFor(facts({ size: { ...startRecord(CARD).size, repos: ['app-repo', 'web-repo'] } }), GIT_BRANCH_NAME);
  assert.equal(r.route, 'sdd');
  assert.equal(r.said, null);
  assert.ok(r.reasons.includes('repos>1'), r.reasons.join(', '));
  assert.equal(r.changeName, 'abc-1-some-title');
});

test('a people-owned design decision routes to sdd', () => {
  const people = routeFor(facts({ openDecisions: [{ text: 'Who may see it.', impact: 'design', owner: 'people' }] }), null);
  assert.equal(people.route, 'sdd');
  assert.ok(people.reasons.includes('people-decisions:1') && people.reasons.includes('design-decisions:1'), people.reasons.join(', '));
  const code = routeFor(facts({ openDecisions: [{ text: 'Which index.', impact: 'design', owner: 'code' }] }), null);
  assert.equal(code.route, 'tdd');
  assert.ok(code.reasons.includes('people-decisions:0'), code.reasons.join(', '));
  assert.equal(routeFor(facts({ openDecisions: [{ text: 'Untagged, from an old record.' }] }), null).route, 'sdd');
});

test('a contained L card routes to light', () => {
  const r = routeFor(facts({}, { tier: 'L', unblocks: 2 }), null);
  assert.equal(r.route, 'light');
  for (const reason of ['tier:L', 'files:3', 'new-paths:0', 'fixups-received:0', 'unblocks:2', 'design-decisions:0']) assert.ok(r.reasons.includes(reason), `${reason} in ${r.reasons}`);
  assert.equal(routeFor(facts({ novelty: { newPaths: ['src/new/'] } }), null).route, 'light');
  const two = { received: [{ from: 'ABC-2', patch: 'app/fixup-a.patch', note: null }, { from: 'ABC-3', patch: 'app/fixup-b.patch', note: null }], caused: [] };
  assert.equal(routeFor(facts({ fixups: two }), null).route, 'light');
  assert.equal(routeFor(facts(), null).route, 'tdd');
  assert.equal(routeFor(facts({}, { tier: 'XL' }), null).route, 'sdd');
});

test('no record returns route null and said no record', () => {
  const r = routeFor({ verdict: { value: 'no record', tier: null, label: null }, record: null, card: { key: CARD }, siblings: { dependents: [] } }, GIT_BRANCH_NAME);
  assert.deepEqual(r, { route: null, said: 'no record', reasons: [], changeName: 'abc-1-some-title' });
});

test('a people decision answered in a fresh pack no longer routes to sdd; a stale pack answers nothing; matching is by text', () => {
  const people = text => ({ text, impact: 'design', owner: 'people' });
  const base = facts({ openDecisions: [people('Who may see it.'), people('Which retention.')] });
  const pack = (answered, stale = null) => ({ fresh: !stale, stale, answered: answered.map(text => ({ text, outcome: `decided: ${text}` })), open: [] });
  const both = routeFor({ ...base, pack: pack(['Who may see it.', 'Which retention.']) }, null);
  assert.equal(both.route, 'tdd');
  assert.ok(both.reasons.includes('people-decisions:0') && both.reasons.includes('pack-answered:2'), both.reasons.join(', '));
  const one = routeFor({ ...base, pack: pack(['Which retention.']) }, null);
  assert.equal(one.route, 'sdd');
  assert.ok(one.reasons.includes('people-decisions:1') && one.reasons.includes('pack-answered:1'), one.reasons.join(', '));
  const stale = routeFor({ ...base, pack: pack(['Who may see it.', 'Which retention.'], 'card-text') }, null);
  assert.equal(stale.route, 'sdd');
  assert.ok(stale.reasons.includes('people-decisions:2') && !stale.reasons.some(r => r.startsWith('pack-answered')), stale.reasons.join(', '));
  const reworded = routeFor({ ...base, pack: pack(['Who may see the record.']) }, null);
  assert.ok(reworded.reasons.includes('people-decisions:2'), 'a question asked in other words is not this decision');
  assert.equal(routeFor({ ...base, pack: null }, null).route, 'sdd');
});
