import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { serializeRecord, validateRecord } from '../scripts/lib/record.mjs';
import { prChecks } from '../scripts/lib/respike/pr-check.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import { B, K, notes, oldRecord, P1, PROJECT_URL, SENTINEL, SLUG, respikeFixture } from './helpers/respike-fixture.mjs';

guardNetwork();

// The built card P1 (open PR 61) has a record that says more than its PR builds: c2 and a line of its description are not
// in the PR. Before the run starts, the record is checked against the PR, and each gap is answered: hand it to B, which
// this run spikes, or drop it.
const json = r => JSON.parse(r.stdout);
const PICK = [PROJECT_URL, '--cards', B];
const DIFF = ['diff --git a/src/list.js b/src/list.js', '--- a/src/list.js', '+++ b/src/list.js', '@@ -8 +8 @@', '-line8', '+line8 from P1', ''].join('\n');

function fixture() {
  const f = respikeFixture({ extended: true });
  const record = oldRecord(P1, { spikedAt: '2026-11-01T10:20:00.000Z', patches: [] });
  writeFileSync(join(f.dataDir, SLUG, `${P1}.json`), serializeRecord(record));
  const ghCalls = [];
  const gh = (argv, opts) => {
    ghCalls.push(argv);
    return argv[0] === 'pr' && argv[1] === 'diff' ? { status: 0, stdout: DIFF, stderr: '' } : f.deps.gh(argv, opts);
  };
  const recordOf = () => JSON.parse(readFileSync(join(f.dataDir, SLUG, `${P1}.json`), 'utf8'));
  const verdicts = value => {
    const path = join(f.scratch, `verdicts-${Math.random().toString(16).slice(2)}.json`);
    writeFileSync(path, JSON.stringify(value));
    return path;
  };
  return { ...f, record, gh, ghCalls, recordOf, verdicts };
}

const CHECKED = {
  schemaVersion: 1,
  cards: {
    [P1]: {
      items: {
        c1: { verdict: 'holds', note: 'src/list.js changes line8.' },
        c2: { verdict: 'not-built', note: 'The PR never reads an empty list.' },
        c3: { verdict: 'holds', note: 'The order is kept.' },
        d1: { verdict: 'holds', note: 'One file, as decided.' },
      },
      missing: ['An export of the list.'],
    },
  },
};

async function checked(f) {
  assert.equal((await f.run('audit', [...PICK, '--before'], { gh: f.gh })).code, 0);
  const stored = await f.run('audit', [PROJECT_URL, '--before', '--verdicts', f.verdicts(CHECKED)]);
  assert.equal(stored.code, 0, stored.stderr);
  return json(stored);
}

test('preflight asks to check a built card\'s record against its PR before the run, and --skip-check answers it', async () => {
  const f = fixture();
  const plan = json(await f.run('preflight', PICK));
  assert.equal(plan.action, 'ask');
  const [ask] = plan.asks.filter(a => a.card === P1);
  assert.equal(ask.code, 'pr-unchecked');
  assert.match(ask.message, new RegExp(`${P1}'s record has not been checked against PR #61`));
  assert.deepEqual(ask.answers, ['audit --before', `--skip-check ${P1}`]);
  assert.deepEqual(plan.prChecks.map(c => [c.card, c.status]), [[P1, 'unchecked']]);
  const skipped = json(await f.run('preflight', [...PICK, '--skip-check', P1]));
  assert.equal(skipped.action, 'ready');
  assert.deepEqual(skipped.prChecks.map(c => [c.card, c.status]), [[P1, 'skipped']]);
});

test('audit --before gathers each built card still to check, with its PR diff saved beside it, and writes no record', async () => {
  const f = fixture();
  const r = await f.run('audit', [...PICK, '--before'], { gh: f.gh });
  assert.equal(r.code, 0, r.stderr);
  const out = json(r);
  assert.equal(out.action, 'audit-before-gathered');
  assert.equal(out.path, join(f.home, SLUG, 'audit', 'before.json'));
  assert.deepEqual(out.cards.map(c => c.card), [P1]);
  const [card] = out.cards;
  assert.deepEqual(card.items.map(i => i.id), ['c1', 'c2', 'c3', 'd1']);
  assert.equal(card.description, `Do ${P1}.`);
  assert.equal(card.against[0].pr.number, 61);
  assert.deepEqual(card.against[0].diff.files, [{ path: 'src/list.js', added: 1, deleted: 1 }]);
  assert.equal(readFileSync(card.against[0].diff.path, 'utf8'), DIFF);
  assert.ok(f.ghCalls.some(a => a[1] === 'diff' && a[2] === 'https://github.com/acme/backend/pull/61'));
  assert.deepEqual(f.recordOf(), JSON.parse(serializeRecord(f.record)));
  assert.equal(r.stdout.includes(SENTINEL), false);
});

test('the PR check stores holds and not-built marks and the missing scope; it gives no verdict but those and moved', async () => {
  const f = fixture();
  const out = await checked(f);
  assert.deepEqual(out.cards, [{ card: P1, holds: ['c1', 'c3', 'd1'], moved: [], notBuilt: ['c2'], dropped: [] }]);
  const stored = f.recordOf();
  assert.deepEqual(validateRecord(stored), []);
  assert.deepEqual(stored.cases[1].audit, { check: 'pr', verdict: 'not-built', note: 'The PR never reads an empty list.', at: '2026-11-10T10:00:00.000Z' });
  const sha = json(await f.run('preflight', PICK)).built.find(b => b.key === P1).sha;
  assert.deepEqual(stored.audits, [{
    check: 'pr', at: '2026-11-10T10:00:00.000Z', kind: 'built',
    against: [{ repoDir: 'backend', kind: 'pr', pr: 61, branch: 'work-61', sha }],
    verdicts: [{ id: 'c1', verdict: 'holds' }, { id: 'c2', verdict: 'not-built' }, { id: 'c3', verdict: 'holds' }, { id: 'd1', verdict: 'holds' }],
    missing: ['An export of the list.'],
  }]);
  const dropped = structuredClone(CHECKED);
  dropped.cards[P1].items.c1 = { verdict: 'dropped', note: 'x' };
  const refused = await f.run('audit', [PROJECT_URL, '--before', '--verdicts', f.verdicts(dropped)]);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, new RegExp(`${P1} c1: the PR check gives holds, moved or not-built`));
});

// A stacked spike records what its tree does after the card, so an earlier card's behavior can sit in the record as if
// the card built it: the judge says which card owns it, and the plan lists it without asking.
const MOVED = structuredClone(CHECKED);
MOVED.cards[P1].items.c2 = { verdict: 'moved', card: B, note: `${B} rejects the empty list; this card relies on it.` };

test('the PR check marks an item another card owns as moved, naming that card of the map', async () => {
  const f = fixture();
  assert.equal((await f.run('audit', [...PICK, '--before'], { gh: f.gh })).code, 0);
  for (const [item, error] of [
    [{ verdict: 'moved', note: 'x' }, `${P1} c2: a moved item names the card that owns it now`],
    [{ verdict: 'moved', card: P1, note: 'x' }, `${P1} c2: moved to itself`],
    [{ verdict: 'moved', card: 'CRM-99', note: 'x' }, `${P1} c2: CRM-99 is not a card of the project map`],
    [{ verdict: 'holds', card: B, note: 'x' }, `${P1} c2: only a moved item names a card`],
  ]) {
    const bad = structuredClone(CHECKED);
    bad.cards[P1].items.c2 = item;
    const r = await f.run('audit', [PROJECT_URL, '--before', '--verdicts', f.verdicts(bad)]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, new RegExp(error));
  }
  const stored = await f.run('audit', [PROJECT_URL, '--before', '--verdicts', f.verdicts(MOVED)]);
  assert.equal(stored.code, 0, stored.stderr);
  assert.deepEqual(json(stored).cards, [{ card: P1, holds: ['c1', 'c3', 'd1'], moved: [{ id: 'c2', card: B }], notBuilt: [], dropped: [] }]);
  const record = f.recordOf();
  assert.deepEqual(validateRecord(record), []);
  assert.deepEqual(record.cases[1].audit, { check: 'pr', verdict: 'moved', card: B, note: MOVED.cards[P1].items.c2.note, at: '2026-11-10T10:00:00.000Z' });
  assert.deepEqual(record.audits.at(-1).verdicts[1], { id: 'c2', verdict: 'moved', card: B });
});

test('a moved item is no ask: the plan lists it with its owner, and no --hand or --drop answers it', async () => {
  const f = fixture();
  assert.equal((await f.run('audit', [...PICK, '--before'], { gh: f.gh })).code, 0);
  assert.equal((await f.run('audit', [PROJECT_URL, '--before', '--verdicts', f.verdicts(MOVED)])).code, 0);
  const plan = json(await f.run('preflight', PICK));
  assert.deepEqual(plan.asks.filter(a => a.code === 'not-built').map(a => a.item), ['m1']);
  assert.deepEqual(plan.moved, [{ from: P1, id: 'c2', to: B, note: MOVED.cards[P1].items.c2.note }]);
  const ready = json(await f.run('preflight', [...PICK, '--drop', `${P1}:m1`]));
  assert.equal(ready.action, 'ready');
  const handed = await f.run('preflight', [...PICK, '--hand', `${P1}:c2=${B}`, '--drop', `${P1}:m1`]);
  assert.equal(handed.code, 2);
  assert.match(handed.stderr, /--hand CRM-6:c2=CRM-2: CRM-6 c2 is not a not-built item of a checked card/);
});

test('once checked, each not-built item and line of missing scope is an ask: hand it to a card the run spikes, or drop it', async () => {
  const f = fixture();
  await checked(f);
  const plan = json(await f.run('preflight', PICK));
  assert.equal(plan.action, 'ask');
  assert.deepEqual(plan.prChecks.map(c => [c.card, c.status]), [[P1, 'current']]);
  const asks = plan.asks.filter(a => a.code === 'not-built');
  assert.deepEqual(asks.map(a => a.item), ['c2', 'm1']);
  assert.match(asks[0].message, new RegExp(`${P1} c2 .* PR #61 does not build it: fix the PR first, hand it to a card this run spikes, or drop it`));
  assert.deepEqual(asks[1].answers, [`--hand ${P1}:m1=<CARD>`, `--drop ${P1}:m1`, 'fix the PR first']);

  const handed = json(await f.run('preflight', [...PICK, '--hand', `${P1}:c2=${B}`, '--drop', `${P1}:m1`]));
  assert.equal(handed.action, 'ready');
  const c2 = f.record.cases[1];
  assert.deepEqual(handed.handoffs, [{ from: P1, id: 'c2', to: B, kind: 'case', given: c2.given, when: c2.when, then: c2.then, note: 'The PR never reads an empty list.' }]);
  assert.deepEqual(handed.drops, [{ from: P1, id: 'm1' }]);
  const dropped = json(await f.run('preflight', [...PICK, '--drop', `${P1}:c2`, '--drop', `${P1}:m1`]));
  assert.equal(dropped.action, 'ready');
  assert.notEqual(dropped.approve, handed.approve);

  const off = await f.run('preflight', [...PICK, '--hand', `${P1}:c2=CRM-99`, '--drop', `${P1}:m1`]);
  assert.equal(off.code, 2);
  assert.match(off.stderr, /--hand CRM-6:c2=CRM-99: CRM-99 is not a card this run spikes/);
  const holding = await f.run('preflight', [...PICK, '--hand', `${P1}:c1=${B}`, '--hand', `${P1}:c2=${B}`, '--drop', `${P1}:m1`]);
  assert.equal(holding.code, 2);
  assert.match(holding.stderr, /--hand CRM-6:c1=CRM-2: CRM-6 c1 is not a not-built item of a checked card/);
});

test('a PR whose head moved since its check, or a record re-spiked since, is checked again', () => {
  const record = { card: 'CRM-6', spikedAt: '2026-11-01T10:20:00.000Z', cases: [], decisions: [], audits: [{ check: 'pr', at: '2026-11-02T00:00:00.000Z', kind: 'built', against: [{ repoDir: 'api', kind: 'pr', pr: 61, branch: 'w', sha: 'a'.repeat(40) }], verdicts: [], missing: [] }] };
  const built = sha => [{ key: 'CRM-6', kind: 'pr', repoDir: 'api', pr: { number: 61 }, branch: 'w', sha }];
  const none = { hand: new Map(), drop: new Set(), skipCheck: new Set() };
  assert.equal(prChecks(built('a'.repeat(40)), new Map([['CRM-6', record]]), none)[0].status, 'current');
  assert.equal(prChecks(built('b'.repeat(40)), new Map([['CRM-6', record]]), none)[0].status, 'stale');
  assert.deepEqual(prChecks(built('a'.repeat(40)), new Map(), none), []);
});

test('begin carries each handed item into the brief of the card that takes it', async () => {
  const f = fixture();
  await checked(f);
  const flags = [...PICK, '--hand', `${P1}:c2=${B}`, '--drop', `${P1}:m1`];
  const plan = json(await f.run('preflight', flags));
  f.at('2026-11-10T10:01:00.000Z');
  const begun = await f.run('begin', [...flags, '--approve', plan.approve]);
  assert.equal(begun.code, 0, begun.stderr);
  const { runId } = json(begun);
  const dir = join(f.home, SLUG, 'runs', runId);
  const state = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
  assert.deepEqual(state.plan.respike.handoffs, plan.handoffs);
  assert.deepEqual(state.plan.respike.drops, plan.drops);

  f.at('2026-11-10T10:02:00.000Z');
  const first = json(await f.spike(['next']));
  assert.equal(first.card, K);
  assert.equal('handed' in first, false);
  const treePath = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')).tracks.t1.repos.backend.path;
  writeFileSync(join(treePath, 'k.txt'), 'K\n');
  mkdirSync(join(dir, 'notes'), { recursive: true });
  writeFileSync(join(dir, 'notes', `${K}.json`), JSON.stringify(notes(K)));
  f.at('2026-11-10T10:05:00.000Z');
  assert.equal((await f.spike(['end', K])).code, 0);
  f.at('2026-11-10T10:06:00.000Z');
  const second = json(await f.spike(['next']));
  assert.equal(second.card, B);
  assert.deepEqual(second.handed, plan.handoffs.map(({ to: _, ...h }) => h));
});
