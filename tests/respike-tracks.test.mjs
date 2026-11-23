import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProjectRef } from '../scripts/lib/linear-fetch.mjs';
import { buildRespikePlan } from '../scripts/lib/respike/plan.mjs';
import { serializeRecord, validateRecord } from '../scripts/lib/record.mjs';
import { runDir } from '../scripts/lib/spike/home.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import { A, B, issue, oldRecord, PATCH_A, PROJECT_URL, SLUG, respikeFixture } from './helpers/respike-fixture.mjs';

guardNetwork();

const C = 'CRM-3';
const ref = parseProjectRef(PROJECT_URL);
const planOf = (f, cards) => buildRespikePlan(ref, f.key, { cards }, f.deps).then(r => r.plan);

const fixture = () => respikeFixture({ issues: defaults => [...defaults, issue(C)] });

function recordWithFixup(f, card, from) {
  const record = oldRecord(card, { spikedAt: '2026-11-01T10:30:00.000Z', patches: card === A ? [PATCH_A] : [] });
  record.fixups = { received: [{ from, patch: PATCH_A, note: 'the list needs the new order' }], caused: [] };
  const errors = validateRecord(record);
  if (errors.length) throw new Error(errors.join('; '))
  mkdirSync(join(f.dataDir, SLUG), { recursive: true });
  writeFileSync(join(f.dataDir, SLUG, `${card}.json`), serializeRecord(record));
}

test('the plan lists one track per disconnected part of the selection', async () => {
  const f = fixture();
  const plan = await planOf(f, [A, B, C]);
  assert.deepEqual(plan.tracks, [{ id: 't1', cards: [A, B] }, { id: 't2', cards: [C] }]);
});

test('a chain through a card outside the run keeps its two ends in one track, as the run order does', async () => {
  const [X, Y] = ['CRM-8', 'CRM-9'];
  const blocks = key => ({ nodes: [{ type: 'blocks', relatedIssue: { identifier: key } }] });
  const f = respikeFixture({
    issues: defaults => [...defaults, issue(C, { relations: blocks(X) }), issue(X, { state: { name: 'Done', type: 'completed' }, relations: blocks(Y) }), issue(Y)],
  });
  const plan = await planOf(f, [A, B, C, Y]);
  assert.deepEqual(plan.order.map(e => e.key).filter(k => [C, Y].includes(k)), [C, Y]);
  assert.deepEqual(plan.tracks, [{ id: 't1', cards: [A, B] }, { id: 't2', cards: [C, Y] }]);
});

test('a previous fixup from CRM-3 into CRM-1 puts them in one track', async () => {
  const f = fixture();
  recordWithFixup(f, A, C);
  const plan = await planOf(f, [A, B, C]);
  assert.equal(plan.tracks.length, 1);
  assert.deepEqual([...plan.tracks[0].cards].sort(), [A, B, C]);
});

test('a fix made on the combined tree for CRM-1 and CRM-3 puts them in one track', async () => {
  const f = fixture();
  const combined = 'backend/fixup-1-3-from-combine-1.patch';
  for (const card of [A, C]) {
    const record = oldRecord(card, { spikedAt: '2026-11-01T10:30:00.000Z', patches: card === A ? [PATCH_A] : [] });
    record.fixups = { received: [{ from: 'combine', patch: combined, note: 'the two tracks did not fit' }], caused: [] };
    assert.deepEqual(validateRecord(record), []);
    mkdirSync(join(f.dataDir, SLUG), { recursive: true });
    writeFileSync(join(f.dataDir, SLUG, `${card}.json`), serializeRecord(record));
  }
  const plan = await planOf(f, [A, B, C]);
  assert.equal(plan.tracks.length, 1);
});

test('the approve hash changes when the tracks change', async () => {
  const f = fixture();
  const apart = await planOf(f, [A, B, C]);
  recordWithFixup(f, A, C);
  const joined = await planOf(f, [A, B, C]);
  assert.notEqual(apart.approve, joined.approve);
});

test('a run begun from a two-part selection keeps one track per part in run.json', async () => {
  const f = fixture();
  const cards = [PROJECT_URL, '--cards', `${A},${B},${C}`];
  const plan = JSON.parse((await f.run('preflight', cards)).stdout);
  assert.equal(plan.action, 'ready');
  const r = await f.run('begin', [...cards, '--approve', plan.approve]);
  assert.equal(r.code, 0, r.stderr);
  const state = JSON.parse(readFileSync(join(runDir(f.home, SLUG, JSON.parse(r.stdout).runId), 'run.json'), 'utf8'));
  assert.deepEqual(Object.entries(state.tracks).map(([id, t]) => [id, t.cards, t.status]), [['t1', [A, B], 'pending'], ['t2', [C], 'pending']]);
});
