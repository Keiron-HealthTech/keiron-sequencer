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

test('a previous fixup from CRM-3 into CRM-1 puts them in one track', async () => {
  const f = fixture();
  recordWithFixup(f, A, C);
  const plan = await planOf(f, [A, B, C]);
  assert.equal(plan.tracks.length, 1);
  assert.deepEqual([...plan.tracks[0].cards].sort(), [A, B, C]);
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
