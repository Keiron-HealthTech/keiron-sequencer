import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { replayPlans } from '../scripts/lib/respike/replay-plan.mjs';
import { runDir, trialPatchRoot } from '../scripts/lib/spike/home.mjs';
import { tempDir } from './helpers/git-sandbox.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import { trialRecord, trialStore } from './helpers/trial-store.mjs';

guardNetwork();

const SLUG = 'p1';
const RUN = '20261101T100000Z';
const CONFIG = { schemaVersion: 1, repos: { 'example-api': { name: 'example-api' }, web: { name: 'example-web' } } };

function store() {
  const home = tempDir('keiron-sequencer-replay-plan-home-');
  const logs = tempDir('keiron-sequencer-replay-plan-logs-');
  after(() => { rmSync(home, { recursive: true, force: true }); rmSync(logs, { recursive: true, force: true }); });
  const put = (path, text = 'x\n') => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
  return {
    home, logs,
    runPatch: name => put(join(runDir(home, SLUG, RUN), 'patches', name)),
    trialPatch: name => put(join(trialPatchRoot(home, SLUG), name)),
    runState: state => put(join(runDir(home, SLUG, RUN), 'run.json'), JSON.stringify(state)),
    trialLog: (dir, names) => put(join(logs, dir, 'log.txt'), names.map(n => `${n} ${'a'.repeat(40)}  1 file changed\n`).join('')),
    manifest: dirs => put(join(trialPatchRoot(home, SLUG), 'dirs.json'), JSON.stringify({ schemaVersion: 1, dirs })),
  };
}

const record = (card, patches, { runId = RUN, received = [], folded = null, ...over } = {}) => ({
  card, refs: { patches, ...(runId ? { runId } : {}) }, fixups: { received, caused: [] }, ...(folded ? { replayed: { folded } } : {}), ...over,
});
const fixup = (from, patch) => ({ from, patch, note: null });

const plan = (s, { ancestors, selected = [], records, built = [] }) => replayPlans({
  ancestors, selected, records: new Map(records.map(r => [r.card, r])), isBuilt: k => built.includes(k),
  home: s.home, slug: SLUG, config: CONFIG, trialLogDir: s.logs, order: modes => [...ancestors, ...selected].filter(k => modes.has(k)),
});
const byKey = entries => Object.fromEntries(entries.map(e => [e.key, e]));

test('the set is refs.patches plus received fixups not yet folded, from the run root, ordered by the run log, unknown names last by name', () => {
  const s = store();
  for (const n of ['example-api/00001-new.patch', 'example-api/fixup-1-from-9-p1.patch', 'example-api/fixup-1-from-8-p1.patch', 'example-api/zz-extra.patch', 'web/00001-new.patch']) s.runPatch(n);
  s.runState({ repos: { 'example-api': { log: [{ name: 'fixup-1-from-9-p1' }, { name: '00001-new' }, { name: '00042-new' }] }, web: { log: [] } }, fixups: [] });
  const records = [record('CRM-1', ['example-api/00001-new.patch', 'example-api/zz-extra.patch', 'web/00001-new.patch'], {
    received: [fixup('CRM-9', 'example-api/fixup-1-from-9-p1.patch'), fixup('CRM-8', 'example-api/fixup-1-from-8-p1.patch'), fixup('CRM-9', 'example-api/fixup-1-from-9-p1.patch')],
    folded: ['example-api/fixup-1-from-8-p1.patch'],
  })];
  const [a] = plan(s, { ancestors: ['CRM-1'], records, built: ['CRM-9'] });
  assert.deepEqual(a, {
    key: 'CRM-1', mode: 'replay', reason: null, from: RUN,
    patches: ['example-api/00001-new.patch', 'example-api/fixup-1-from-9-p1.patch', 'example-api/zz-extra.patch', 'web/00001-new.patch'],
    dropped: [], sharedWith: [],
    units: { 'example-api': ['example-api/fixup-1-from-9-p1.patch', 'example-api/00001-new.patch', 'example-api/zz-extra.patch'], web: ['web/00001-new.patch'] },
  });
});

test('a fixup is kept only when its from card and every fixed card are built or replayed, in the unit of the last of its from, fixed and receiver cards', () => {
  const s = store();
  for (const n of ['example-api/00001-new.patch', 'example-api/00002-new.patch', 'example-api/fixup-1-2-from-9-p1.patch', 'example-api/fixup-1-from-5-p1.patch']) s.runPatch(n);
  s.runState({ repos: {}, fixups: [{ fixed: ['CRM-1', 'CRM-2'], from: 'CRM-9', patch: 'example-api/fixup-1-2-from-9-p1.patch' }] });
  const shared = fixup('CRM-9', 'example-api/fixup-1-2-from-9-p1.patch');
  const records = [
    record('CRM-1', ['example-api/00001-new.patch'], { received: [shared, fixup('CRM-5', 'example-api/fixup-1-from-5-p1.patch')] }),
    record('CRM-2', ['example-api/00002-new.patch'], { received: [shared] }),
  ];
  const out = byKey(plan(s, { ancestors: ['CRM-1', 'CRM-2'], records, built: ['CRM-9'] }));
  assert.deepEqual(out['CRM-1'].units, { 'example-api': ['example-api/00001-new.patch'] });
  assert.deepEqual(out['CRM-1'].dropped, [{ patch: 'example-api/fixup-1-from-5-p1.patch', reason: 'from-absent' }]);
  assert.deepEqual(out['CRM-2'].units, { 'example-api': ['example-api/00002-new.patch', 'example-api/fixup-1-2-from-9-p1.patch'] });
  const respiked = byKey(plan(s, { ancestors: ['CRM-1'], selected: ['CRM-2'], records, built: ['CRM-9'] }));
  assert.deepEqual(respiked['CRM-1'].dropped, [
    { patch: 'example-api/fixup-1-2-from-9-p1.patch', reason: 'fixed-absent' }, { patch: 'example-api/fixup-1-from-5-p1.patch', reason: 'from-absent' },
  ]);
  assert.deepEqual(respiked['CRM-1'].units, { 'example-api': ['example-api/00001-new.patch'] });
});

test('a fix made on the combined tree counts as present once every card it fixed is, and lands with the last of them', () => {
  const s = store();
  const combined = 'example-api/fixup-1-2-from-combine-1.patch';
  for (const n of ['example-api/00001-new.patch', 'example-api/00002-new.patch', combined]) s.runPatch(n);
  s.runState({ repos: {}, fixups: [{ fixed: ['CRM-1', 'CRM-2'], from: 'combine', patch: combined }] });
  const records = [
    record('CRM-1', ['example-api/00001-new.patch'], { received: [fixup('combine', combined)] }),
    record('CRM-2', ['example-api/00002-new.patch'], { received: [fixup('combine', combined)] }),
  ];
  const out = byKey(plan(s, { ancestors: ['CRM-1', 'CRM-2'], records }));
  assert.deepEqual([out['CRM-1'].dropped, out['CRM-2'].dropped], [[], []]);
  assert.deepEqual(out['CRM-2'].units, { 'example-api': ['example-api/00002-new.patch', combined] });
  const respiked = byKey(plan(s, { ancestors: ['CRM-1'], selected: ['CRM-2'], records }));
  assert.deepEqual(respiked['CRM-1'].dropped, [{ patch: combined, reason: 'fixed-absent' }]);
});

test('a card patch naming two cards is never replayed: its holders and every card it names in the run are spikes for a shared patch', () => {
  const s = store();
  for (const n of ['example-api/00001-new.patch', 'example-api/01220-01222-finish.patch', 'example-api/01224-01225.patch', 'example-api/01225-new.patch']) s.trialPatch(n);
  const records = [
    record('CRM-1220', ['example-api/01220-01222-finish.patch'], { runId: null }),
    record('CRM-1222', ['example-api/01220-01222-finish.patch', 'example-api/00001-new.patch'], { runId: null }),
    record('CRM-1224', ['example-api/01224-01225.patch'], { runId: null }),
    record('CRM-1225', ['example-api/01225-new.patch'], { runId: null }),
  ];
  const all = byKey(plan(s, { ancestors: ['CRM-1220', 'CRM-1222', 'CRM-1224', 'CRM-1225'], records }));
  for (const [key, other] of [['CRM-1220', 'CRM-1222'], ['CRM-1222', 'CRM-1220'], ['CRM-1224', 'CRM-1225'], ['CRM-1225', 'CRM-1224']]) {
    const e = all[key];
    assert.deepEqual([e.mode, e.reason, e.from, e.units, e.sharedWith], ['spike', 'shared-patch', null, {}, [other]], key);
    assert.equal(Object.hasOwn(e, 'unitOf'), false, key);
  }
  const built = byKey(plan(s, { ancestors: ['CRM-1220'], records, built: ['CRM-1222'] }));
  assert.deepEqual([built['CRM-1220'].mode, built['CRM-1220'].reason], ['spike', 'shared-patch']);
});

test('a fixup goes to the unit of the last of its from card and its fixed cards, so it never lands before its from card replays', () => {
  const s = store();
  for (const n of ['example-api/00001-new.patch', 'example-api/00003-new.patch', 'example-api/fixup-1-from-3-p1.patch']) s.runPatch(n);
  s.runState({ repos: {}, fixups: [] });
  const records = [
    record('CRM-1', ['example-api/00001-new.patch'], { received: [fixup('CRM-3', 'example-api/fixup-1-from-3-p1.patch')] }),
    record('CRM-3', ['example-api/00003-new.patch']),
  ];
  const out = byKey(plan(s, { ancestors: ['CRM-1', 'CRM-3'], records }));
  assert.deepEqual(out['CRM-1'].units, { 'example-api': ['example-api/00001-new.patch'] });
  assert.deepEqual(out['CRM-1'].patches, ['example-api/00001-new.patch', 'example-api/fixup-1-from-3-p1.patch']);
  assert.deepEqual(out['CRM-3'].units, { 'example-api': ['example-api/00003-new.patch', 'example-api/fixup-1-from-3-p1.patch'] });
});

test('trial patches follow the trial log read through the rename manifest; log names that are not record patches are ignored', () => {
  const s = store();
  s.manifest({ backend: 'example-api' });
  for (const n of ['example-api/01182-existing.patch', 'example-api/fixup-1182-from-1188-init.patch']) s.trialPatch(n);
  s.trialLog('backend', ['00007-test-fix', 'fixup-1182-from-1188-init', '01182-existing']);
  const records = [record('CRM-1182', ['example-api/01182-existing.patch'], { runId: null, received: [fixup('CRM-1188', 'example-api/fixup-1182-from-1188-init.patch')] })];
  const [a] = plan(s, { ancestors: ['CRM-1182'], records, built: ['CRM-1188'] });
  assert.deepEqual(a.units, { 'example-api': ['example-api/fixup-1182-from-1188-init.patch', 'example-api/01182-existing.patch'] });
});

test('no record, an archived or superseded one, a missing file or a pruned run make the ancestor a spike with the reason', () => {
  const s = store();
  s.runPatch('example-api/00001-new.patch');
  const cases = [
    [null, 'no-record'],
    [record('CRM-1', ['example-api/00001-new.patch'], { archived: { at: '2026-11-01', reason: 'gone' } }), 'no-record'],
    [record('CRM-1', ['example-api/00001-new.patch'], { supersededBy: { card: 'CRM-7', spikedAt: '2026-11-01T00:00:00.000Z' } }), 'no-record'],
    [record('CRM-1', ['example-api/00001-new.patch', 'example-api/00009-new.patch']), 'patch-missing'],
    [record('CRM-1', ['example-api/00001-new.patch'], { runId: '20261001T000000Z' }), 'patch-missing'],
    [record('CRM-1', []), 'patch-missing'],
  ];
  for (const [r, reason] of cases) {
    const [a] = plan(s, { ancestors: ['CRM-1'], records: r ? [r] : [] });
    assert.deepEqual([a.mode, a.reason, a.from, a.units], ['spike', reason, null, {}], JSON.stringify(r));
  }
  const [missing] = plan(s, { ancestors: ['CRM-1'], records: [cases[3][0]] });
  assert.deepEqual(missing.missing, ['example-api/00009-new.patch']);
});

test('after the trial rename on a temp home, a trial record replays from the trial root in the trial log order read through the manifest', async () => {
  const slug = 'dddd00000004';
  const s = trialStore({
    slug,
    repos: { backend: 'example-api' },
    config: { schemaVersion: 1, repos: { 'example-api': { name: 'example-api', checkout: '/nowhere', remote: 'origin' } } },
    patches: { 'backend/01182-existing.patch': 'x\n', 'backend/01182-more.patch': 'y\n' },
    records: [trialRecord('CRM-1182', ['backend/01182-existing.patch', 'backend/01182-more.patch'], slug)],
    logs: { backend: ['01182-more', '01182-existing'] },
  });
  const planned = () => replayPlans({
    ancestors: ['CRM-1182'], selected: [], records: new Map([['CRM-1182', s.record('CRM-1182')]]), isBuilt: () => false,
    home: s.home, slug, config: CONFIG, trialLogDir: s.trial, order: modes => [...modes.keys()],
  })[0];
  assert.deepEqual(planned().units, { backend: ['backend/01182-more.patch', 'backend/01182-existing.patch'] });
  assert.equal((await s.rename('--apply')).code, 0);
  const after = planned();
  assert.deepEqual([after.mode, after.from], ['replay', 'trial']);
  assert.deepEqual(after.units, { 'example-api': ['example-api/01182-more.patch', 'example-api/01182-existing.patch'] });
});

test('a replay below a selected ancestor becomes a spike with reason ancestor-spiked', () => {
  const s = store();
  for (const n of ['example-api/00002-new.patch', 'example-api/00003-new.patch', 'example-api/00004-new.patch']) s.runPatch(n);
  s.runState({ repos: { 'example-api': { log: [] } }, fixups: [] });
  // CRM-1 (selected) blocks CRM-2, CRM-2 blocks CRM-3; CRM-4 hangs off nothing that is spiked; CRM-3 and CRM-4 block CRM-5.
  const edges = [{ from: 'CRM-1', to: 'CRM-2' }, { from: 'CRM-2', to: 'CRM-3' }, { from: 'CRM-3', to: 'CRM-5' }, { from: 'CRM-4', to: 'CRM-5' }];
  const records = ['CRM-2', 'CRM-3', 'CRM-4'].map(k => record(k, [`example-api/0000${k.slice(-1)}-new.patch`]));
  const entries = byKey(replayPlans({
    ancestors: ['CRM-2', 'CRM-3', 'CRM-4'], selected: ['CRM-1', 'CRM-5'], records: new Map(records.map(r => [r.card, r])), isBuilt: () => false,
    home: s.home, slug: SLUG, config: CONFIG, trialLogDir: s.logs, edges, order: modes => ['CRM-1', 'CRM-2', 'CRM-3', 'CRM-4', 'CRM-5'].filter(k => modes.has(k)),
  }));
  assert.deepEqual([entries['CRM-2'].mode, entries['CRM-2'].reason, entries['CRM-2'].spikedAncestors], ['spike', 'ancestor-spiked', ['CRM-1']]);
  assert.deepEqual([entries['CRM-3'].mode, entries['CRM-3'].reason, entries['CRM-3'].spikedAncestors], ['spike', 'ancestor-spiked', ['CRM-1', 'CRM-2']]);
  assert.deepEqual([entries['CRM-4'].mode, entries['CRM-4'].reason], ['replay', null]);
  assert.deepEqual(entries['CRM-4'].units, { 'example-api': ['example-api/00004-new.patch'] });
});
