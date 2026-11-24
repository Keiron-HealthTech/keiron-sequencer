import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../scripts/spike.mjs';
import { readState, saveState } from '../scripts/lib/spike/state.mjs';
import { replanAfterTurn } from '../scripts/lib/spike/replay.mjs';
import { fakeSetup, tempDir } from './helpers/git-sandbox.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import { activeRunDir, blocks, issue, notes, PROJECT_URL, twoRepoFixture } from './helpers/spike-fixture.mjs';
import * as R from './helpers/respike-fixture.mjs';

guardNetwork();

const json = r => JSON.parse(r.stdout);

// spike begin keeps one track; the run is split into t1 = CRM-1→CRM-2 and t2 = CRM-3 before any tree opens.
async function twoTracks({ config: edit = () => {}, crossings = [] } = {}) {
  const f = twoRepoFixture({ issues: [issue('CRM-1', { relations: blocks('CRM-2') }), issue('CRM-2'), issue('CRM-3')] });
  const config = JSON.parse(readFileSync(join(f.home, 'config.json'), 'utf8'));
  edit(config);
  writeFileSync(join(f.home, 'config.json'), JSON.stringify(config));
  const begun = await run(['begin', PROJECT_URL], f.deps);
  assert.equal(begun.code, 0, begun.stderr);
  const dir = activeRunDir(f.home);
  const state = readState(dir);
  assert.deepEqual(state.plan.order, ['CRM-1', 'CRM-2', 'CRM-3']);
  state.tracks = { t1: { ...state.tracks.t1, cards: ['CRM-1', 'CRM-2'] }, t2: { ...state.tracks.t1, cards: ['CRM-3'] } };
  state.crossings = crossings;
  saveState(dir, state, f.deps.now());
  mkdirSync(join(dir, 'notes'), { recursive: true });
  const spike = argv => run(argv, f.deps);
  const open = async (card, track, at) => {
    f.at(at);
    const brief = await spike(['next', '--track', track]);
    assert.equal(brief.code, 0, brief.stderr);
    assert.deepEqual([json(brief).action, json(brief).card, json(brief).track], ['card', card, track]);
    const tree = await spike(['tree', 'backend', '--track', track]);
    assert.equal(tree.code, 0, tree.stderr);
    writeFileSync(join(json(tree).path, `${card}.txt`), `${card}\n`);
    writeFileSync(join(dir, 'notes', `${card}.json`), JSON.stringify(notes));
    return json(tree).path;
  };
  const end = async (card, track, at) => {
    f.at(at);
    const r = await spike(['end', card, '--track', track]);
    assert.equal(r.code, 0, r.stderr);
    return json(r);
  };
  return { f, dir, spike, open, end };
}

test('two tracks are worked independently: each card in its own track tree, scratch logs kept apart', async () => {
  const { f, dir, spike, open, end } = await twoTracks({
    config: c => Object.assign(c.repos.backend, { setup: [['yarn', 'install']], spikeTypecheck: ['tc', '{changed}'] }),
  });
  const t1 = await open('CRM-1', 't1', '2026-11-10T10:01:00.000Z');
  const t2 = await open('CRM-3', 't2', '2026-11-10T10:02:00.000Z');
  assert.deepEqual([t1, t2], [join(dir, 'trees', 't1', 'backend'), join(dir, 'trees', 't2', 'backend')]);
  assert.deepEqual([existsSync(join(t2, 'CRM-1.txt')), existsSync(join(t1, 'CRM-3.txt'))], [false, false]);
  assert.deepEqual(['t1', 't2'].map(t => existsSync(join(dir, 'logs', t, 'setup-backend.log'))), [true, true]);

  f.at('2026-11-10T10:03:00.000Z');
  const failing = fakeSetup({ 'tc CRM-3.txt': 2 });
  const refused = await run(['end', 'CRM-3', '--track', 't2'], { ...f.deps, runSetup: failing.run });
  assert.equal(refused.code, 8, refused.stderr);
  assert.equal(json(refused).log, join(dir, 'logs', 't2', 'typecheck-backend.log'));

  assert.deepEqual((await end('CRM-3', 't2', '2026-11-10T10:04:00.000Z')).patches, ['backend/00003-new.patch']);
  assert.deepEqual((await end('CRM-1', 't1', '2026-11-10T10:05:00.000Z')).patches, ['backend/00001-new.patch']);
  assert.ok(existsSync(join(dir, 'logs', 't1', 'typecheck-backend.log')));
  const state = readState(dir);
  assert.deepEqual(['CRM-1', 'CRM-2', 'CRM-3'].map(k => state.cards[k].status), ['done', 'pending', 'done']);
  assert.deepEqual([state.tracks.t1.current, state.tracks.t2.current], [null, null]);
  assert.ok(existsSync(t1) && existsSync(t2));
  assert.equal((await spike(['next', '--track', 't1'])).code, 0);
});

test('a track with no cards left answers track-done; the run completes through combine once every track is done', async () => {
  const { dir, spike, open, end } = await twoTracks();
  await open('CRM-1', 't1', '2026-11-10T10:01:00.000Z');
  await end('CRM-1', 't1', '2026-11-10T10:02:00.000Z');
  await open('CRM-2', 't1', '2026-11-10T10:03:00.000Z');
  await end('CRM-2', 't1', '2026-11-10T10:04:00.000Z');
  const done = await spike(['next', '--track', 't1']);
  assert.equal(done.code, 0, done.stderr);
  assert.deepEqual(json(done), { action: 'track-done', track: 't1' });
  assert.deepEqual([readState(dir).status, readState(dir).tracks.t1.status, readState(dir).tracks.t2.status], ['active', 'done', 'pending']);
  assert.deepEqual(json(await spike(['next', '--track', 't1'])), { action: 'track-done', track: 't1' });

  await open('CRM-3', 't2', '2026-11-10T10:05:00.000Z');
  await end('CRM-3', 't2', '2026-11-10T10:06:00.000Z');
  const last = await spike(['next', '--track', 't2']);
  assert.equal(last.code, 0, last.stderr);
  assert.deepEqual(json(last), { action: 'track-done', track: 't2', combine: true });
  assert.deepEqual([readState(dir).status, readState(dir).tracks.t2.status], ['active', 'done']);
  const complete = await spike(['combine']);
  assert.equal(complete.code, 0, complete.stderr);
  assert.equal(json(complete).action, 'combined-ok');
  assert.equal(readState(dir).status, 'complete');
});

test('tracks and status list each track with done/total', async () => {
  const { spike, open, end } = await twoTracks();
  await open('CRM-1', 't1', '2026-11-10T10:01:00.000Z');
  await end('CRM-1', 't1', '2026-11-10T10:02:00.000Z');
  await open('CRM-3', 't2', '2026-11-10T10:03:00.000Z');
  const expected = [
    { id: 't1', status: 'active', current: null, done: 1, total: 2, mergedInto: null, cards: ['CRM-1', 'CRM-2'] },
    { id: 't2', status: 'active', current: 'CRM-3', done: 0, total: 1, mergedInto: null, cards: ['CRM-3'] },
  ];
  const tracks = await spike(['tracks']);
  assert.equal(tracks.code, 0, tracks.stderr);
  assert.deepEqual(json(tracks), { action: 'tracks', workers: 1, checks: 1, tracks: expected });
  const status = await spike(['status']);
  assert.equal(status.code, 0, status.stderr);
  assert.deepEqual(json(status).tracks, expected);
  assert.equal(json(status).current, null);
});

test('next without --track on a two-track run is refused with the track list', async () => {
  const { spike, open } = await twoTracks();
  for (const argv of [['next'], ['tree', 'backend'], ['candidates'], ['notes-template', 'CRM-1']]) {
    const r = await spike(argv);
    assert.equal(r.code, 1, argv.join(' '));
    assert.match(r.stderr, /pass --track <id>: this run has 2 tracks: t1, t2/);
  }
  assert.match((await spike(['next', '--track', 't9'])).stderr, /t9 is not a track of run/);
  await open('CRM-1', 't1', '2026-11-10T10:01:00.000Z');
  assert.match((await spike(['end', 'CRM-1'])).stderr, /pass --track <id>: this run has 2 tracks: t1, t2/);
  assert.match((await spike(['notes-template', 'CRM-1', '--track', 't2'])).stderr, /CRM-1 is not a card of track t2/);
});

test('a fixup from one track into a done card of another is refused: that is a crossing', async () => {
  const { dir, spike, open, end } = await twoTracks();
  await open('CRM-1', 't1', '2026-11-10T10:01:00.000Z');
  await end('CRM-1', 't1', '2026-11-10T10:02:00.000Z');
  const tree = await open('CRM-3', 't2', '2026-11-10T10:03:00.000Z');
  writeFileSync(join(tree, 'CRM-1.txt'), 'adapted\n');
  const candidates = await spike(['candidates', '--track', 't2']);
  assert.deepEqual(json(candidates).candidates.map(c => [c.card, c.path, c.otherTrack]), [['CRM-1', 'CRM-1.txt', 't1']]);
  const before = readFileSync(join(dir, 'run.json'), 'utf8');
  const r = await spike(['fixup', '--track', 't2', '--fixes', 'CRM-1', '--slug', 'adapt', '--note', 'Adapts CRM-1.', '--repo', 'backend', '--', 'CRM-1.txt']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /CRM-1 is in track t1, not t2/);
  assert.equal(readFileSync(join(dir, 'run.json'), 'utf8'), before);
});

test('a track whose next card has an unmet crossing edge answers waiting', async () => {
  const crossing = { at: '2026-11-10T10:00:30.000Z', kind: 'depends', from: 'CRM-3', to: 'CRM-2', fromTrack: 't2', toTrack: 't1', note: 'Needs CRM-2.', respiked: [] };
  const { dir, spike, open, end } = await twoTracks({ crossings: [crossing] });
  const waiting = await spike(['next', '--track', 't2']);
  assert.equal(waiting.code, 0, waiting.stderr);
  assert.deepEqual(json(waiting), { action: 'waiting', track: 't2', card: 'CRM-3', waitingOn: 'CRM-2' });
  assert.deepEqual([readState(dir).tracks.t2.status, readState(dir).cards['CRM-3'].status], ['waiting', 'pending']);
  await open('CRM-1', 't1', '2026-11-10T10:01:00.000Z');
  await end('CRM-1', 't1', '2026-11-10T10:02:00.000Z');
  await open('CRM-2', 't1', '2026-11-10T10:03:00.000Z');
  await end('CRM-2', 't1', '2026-11-10T10:04:00.000Z');
  await open('CRM-3', 't2', '2026-11-10T10:05:00.000Z');
  assert.equal(readState(dir).tracks.t2.status, 'active');
});

test('in a respike run a track turns active when its first replay entry is adopted, before any card of it opens', async () => {
  const C = 'CRM-5';
  const f = R.respikeFixture({ issues: ([a, b]) => [a, b, R.issue(C)] });
  const pick = [R.PROJECT_URL, '--cards', `${R.B},${C}`];
  const plan = json(await f.run('preflight', pick));
  f.at('2026-11-10T10:01:00.000Z');
  const { runId } = json(await f.run('begin', [...pick, '--approve', plan.approve, '--max-cards', '1']));
  const dir = join(f.home, R.SLUG, 'runs', runId);
  assert.deepEqual(Object.entries(readState(dir).tracks).map(([id, t]) => [id, t.cards]), [['t1', [R.A, R.B]], ['t2', [C]]]);
  f.at('2026-11-10T10:02:00.000Z');
  assert.equal(json(await f.spike(['next', '--track', 't2'])).card, C);
  const tree = json(await f.spike(['tree', 'backend', '--track', 't2'])).path;
  writeFileSync(join(tree, 'c.txt'), 'c\n');
  mkdirSync(join(dir, 'notes'), { recursive: true });
  writeFileSync(join(dir, 'notes', `${C}.json`), JSON.stringify(R.notes(C)));
  f.at('2026-11-10T10:03:00.000Z');
  assert.equal((await f.spike(['end', C, '--track', 't2'])).code, 0);
  f.at('2026-11-10T10:04:00.000Z');
  const paused = await f.spike(['next', '--track', 't1']);
  assert.equal(paused.code, 0, paused.stderr);
  assert.deepEqual([json(paused).action, json(paused).reason, json(paused).replayed.map(r => r.card)], ['pause', 'cards', [R.A]]);
  const state = readState(dir);
  assert.deepEqual([state.cards[R.A].replay.status, state.cards[R.B].status, state.tracks.t1.status], ['replayed', 'pending', 'active']);
  assert.deepEqual(state.tracks.t1.repos.backend.path, join(dir, 'trees', 't1', 'backend'));
  const indexes = [...new Set(f.git.calls.map(c => c.env?.GIT_INDEX_FILE).filter(i => i?.includes('replay-')))];
  assert.deepEqual(indexes, [join(dir, 'tmp', 't1', 'replay-backend.index')]);
});

test('a replan after a turned entry touches only the pending entries of the turned card\'s track', () => {
  const dataDir = tempDir('keiron-sequencer-replan-data-');
  const home = tempDir('keiron-sequencer-replan-home-');
  after(() => { for (const d of [dataDir, home]) rmSync(d, { recursive: true, force: true }); });
  const slug = 'replan';
  const fix = n => `backend/fixup-${n}-from-1-adapt.patch`;
  const entry = n => ({ key: `CRM-${n}`, mode: 'replay', reason: null, from: 'trial', patches: [`backend/0000${n}-new.patch`, fix(n)].sort(), dropped: [], sharedWith: [], units: { backend: [`backend/0000${n}-new.patch`, fix(n)] } });
  const records = { 'CRM-1': {}, 'CRM-2': { fixups: { received: [{ from: 'CRM-1', patch: fix(2) }] } }, 'CRM-4': { fixups: { received: [{ from: 'CRM-1', patch: fix(4) }] } } };
  mkdirSync(join(dataDir, slug), { recursive: true });
  for (const [card, record] of Object.entries(records)) writeFileSync(join(dataDir, slug, `${card}.json`), JSON.stringify(record));
  const mode = { 'CRM-1': 'spike', 'CRM-2': 'replay', 'CRM-3': 'spike', 'CRM-4': 'replay' };
  const state = {
    home,
    project: { slug },
    plan: {
      order: ['CRM-1', 'CRM-2', 'CRM-3', 'CRM-4'],
      cards: Object.fromEntries(Object.entries(mode).map(([k, m]) => [k, { mode: m }])),
      respike: { replay: { 'CRM-1': { ...entry(1), mode: 'spike' }, 'CRM-2': entry(2), 'CRM-4': entry(4) } },
    },
    tracks: { t1: { cards: ['CRM-1', 'CRM-2'] }, t2: { cards: ['CRM-3', 'CRM-4'] } },
    cards: Object.fromEntries(Object.keys(mode).map(k => [k, { status: 'pending' }])),
  };
  const dropped = replanAfterTurn(state, { dataDir }, 'CRM-1');
  assert.deepEqual(dropped, [{ card: 'CRM-2', patch: fix(2), reason: 'from-absent' }]);
  assert.deepEqual(state.plan.respike.replay['CRM-2'].units, { backend: ['backend/00002-new.patch'] });
  assert.deepEqual(state.plan.respike.replay['CRM-4'], entry(4));
});

const edit = (tree, text) => writeFileSync(join(tree, 'src', 'index.js'), text)

test('candidates marks an overlap with another track\'s patch as otherTrack', async () => {
  const { spike, open, end } = await twoTracks();
  const t1 = await open('CRM-1', 't1', '2026-11-10T10:01:00.000Z');
  edit(t1, 'export const one = 11\n');
  await end('CRM-1', 't1', '2026-11-10T10:02:00.000Z');
  const t2 = await open('CRM-3', 't2', '2026-11-10T10:03:00.000Z');
  edit(t2, 'export const one = 33\n');
  const r = await spike(['candidates', '--track', 't2']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(json(r).candidates, [{ card: 'CRM-1', repo: 'backend', path: 'src/index.js', ranges: [[1, 1]], otherTrack: 't1' }]);
  edit(t2, 'export const one = 1\n');
  writeFileSync(join(t2, 'README.md'), '# other\n');
  assert.deepEqual(json(await spike(['candidates', '--track', 't2'])).candidates, []);
});

test('end lists another track\'s card that changed the same path as a crossing suspect and still ends the card', async () => {
  const { dir, open, end } = await twoTracks();
  const t1 = await open('CRM-1', 't1', '2026-11-10T10:01:00.000Z');
  edit(t1, 'export const one = 11\n');
  assert.equal((await end('CRM-1', 't1', '2026-11-10T10:02:00.000Z')).crossingSuspects, undefined);
  const t2 = await open('CRM-3', 't2', '2026-11-10T10:03:00.000Z');
  edit(t2, 'export const one = 22\n');
  const ended = await end('CRM-3', 't2', '2026-11-10T10:04:00.000Z');
  assert.deepEqual(ended.crossingSuspects, [{ card: 'CRM-1', track: 't1', repo: 'backend', path: 'src/index.js' }]);
  assert.equal(readState(dir).cards['CRM-3'].status, 'done');
});

test('an unreadable patch of another track gives no crossing suspects and never fails the end', async () => {
  const { dir, open, end } = await twoTracks();
  const t1 = await open('CRM-1', 't1', '2026-11-10T10:01:00.000Z');
  edit(t1, 'export const one = 11\n');
  await end('CRM-1', 't1', '2026-11-10T10:02:00.000Z');
  rmSync(join(dir, 'patches', 'backend', '00001-new.patch'));
  const t2 = await open('CRM-3', 't2', '2026-11-10T10:03:00.000Z');
  edit(t2, 'export const one = 22\n');
  const ended = await end('CRM-3', 't2', '2026-11-10T10:04:00.000Z');
  assert.equal(ended.crossingSuspects, undefined);
  assert.equal(readState(dir).cards['CRM-3'].status, 'done');
});
