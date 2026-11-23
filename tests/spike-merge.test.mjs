import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../scripts/spike.mjs';
import { readState, saveState, trackOfCard, waitingOn } from '../scripts/lib/spike/state.mjs';
import { SANDBOX_ENV, sandboxGit } from './helpers/git-sandbox.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import { activeRunDir, blocks, issue, notes, PROJECT_URL, SLUG, spikeFixture } from './helpers/spike-fixture.mjs';
import * as R from './helpers/respike-fixture.mjs';

guardNetwork();

const json = r => JSON.parse(r.stdout);
const SPIKE = fileURLToPath(new URL('../scripts/spike.mjs', import.meta.url));
const at = minute => `2026-11-10T10:${String(minute).padStart(2, '0')}:00.000Z`;

// spike begin keeps one track; the run is split by hand into `split` before any tree opens.
async function tracksRun(issues, split, { config } = {}) {
  const f = spikeFixture({ issues, config });
  const begun = await run(['begin', PROJECT_URL], f.deps);
  assert.equal(begun.code, 0, begun.stderr);
  const dir = activeRunDir(f.home);
  const state = readState(dir);
  state.tracks = Object.fromEntries(Object.entries(split).map(([id, cards]) => [id, { ...state.tracks.t1, cards }]));
  saveState(dir, state, f.deps.now());
  mkdirSync(join(dir, 'notes'), { recursive: true });
  const spike = argv => run(argv, f.deps);
  let minute = 0;
  const tick = () => f.at(at(++minute));
  const open = async (card, track, files = { [`${card}.txt`]: `${card}\n` }) => {
    tick();
    const brief = await spike(['next', '--track', track]);
    assert.equal(brief.code, 0, brief.stderr);
    assert.deepEqual([json(brief).action, json(brief).card], ['card', card]);
    const tree = await spike(['tree', 'backend', '--track', track]);
    assert.equal(tree.code, 0, tree.stderr);
    for (const [file, text] of Object.entries(files)) writeFileSync(join(json(tree).path, file), text);
    writeFileSync(join(dir, 'notes', `${card}.json`), JSON.stringify(notes));
    return { brief: json(brief), tree: json(tree).path };
  };
  const end = async (card, track) => {
    tick();
    const r = await spike(['end', card, '--track', track]);
    assert.equal(r.code, 0, r.stderr);
    return json(r);
  };
  const cross = (track, card, needs, kind) => {
    tick();
    return spike(['cross', '--track', track, '--card', card, '--needs', needs, '--kind', kind, '--note', `${card} needs ${needs}.`]);
  };
  const record = card => JSON.parse(readFileSync(join(f.dataDir, SLUG, `${card}.json`), 'utf8'));
  return { f, dir, spike, open, end, cross, record };
}

const treeOf = (dir, track) => join(dir, 'trees', track, 'backend');
const files = tree => sandboxGit(['ls-files'], { cwd: tree }).split('\n').filter(f => f.startsWith('CRM-'));
const clean = (dir, track) => {
  const tree = treeOf(dir, track);
  sandboxGit(['add', '-A'], { cwd: tree });
  return sandboxGit(['write-tree'], { cwd: tree }).trim() === readState(dir).tracks[track].repos.backend.last;
};

test('a depends crossing merges R into G, replays R\'s done cards with mergedFrom, and C waits until B is done', async () => {
  const { dir, spike, open, end, cross, record } = await tracksRun(
    [issue('CRM-1', { relations: blocks('CRM-2') }), issue('CRM-2'), issue('CRM-3', { relations: blocks('CRM-4') }), issue('CRM-4')],
    { t1: ['CRM-1', 'CRM-2'], t2: ['CRM-3', 'CRM-4'] },
  );
  await open('CRM-1', 't1');
  await end('CRM-1', 't1');
  await open('CRM-3', 't2');
  await end('CRM-3', 't2');
  await open('CRM-2', 't1');

  const r = await cross('t1', 'CRM-2', 'CRM-4', 'depends');
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(json(r), { action: 'merged', crossing: 0, track: 't2', merged: 't1', kind: 'depends', replayed: ['CRM-1'], respiked: [], wip: join(dir, 'wip', 'CRM-2.patch') });
  const state = readState(dir);
  assert.deepEqual([state.tracks.t1.status, state.tracks.t1.mergedInto, state.tracks.t1.current], ['merged', 't2', null]);
  assert.deepEqual(state.tracks.t2.cards, ['CRM-1', 'CRM-3', 'CRM-4', 'CRM-2']);
  assert.deepEqual(state.crossings, [{
    at: at(6), kind: 'depends', from: 'CRM-2', to: 'CRM-4', fromTrack: 't1', toTrack: 't2', note: 'CRM-2 needs CRM-4.', respiked: [],
  }]);
  assert.deepEqual(state.cards['CRM-1'].mergedFrom, { track: 't1', crossing: 0 });
  assert.deepEqual(record('CRM-1').mergedFrom, { track: 't1', crossing: 0 });
  assert.equal(state.cards['CRM-2'].status, 'pending');
  assert.equal(state.cards['CRM-2'].windows.at(-1).endReason, 'crossing');
  assert.deepEqual([trackOfCard(state, 'CRM-1'), waitingOn(state, 'CRM-2')], ['t2', 'CRM-4']);
  assert.deepEqual(files(treeOf(dir, 't2')), ['CRM-1.txt', 'CRM-3.txt']);
  assert.deepEqual(state.tracks.t2.repos.backend.log.map(e => e.name), ['00003-new', '00001-new']);
  assert.ok(clean(dir, 't1'));

  const refused = await spike(['next', '--track', 't1']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /t1 was merged into t2: pass --track t2/);
  await open('CRM-4', 't2');
  await end('CRM-4', 't2');
  const c = await open('CRM-2', 't2', {});
  assert.equal(c.brief.track, 't2');
  const opened = readState(dir);
  assert.deepEqual([opened.tracks.t2.current.card, opened.tracks.t1.current], ['CRM-2', null]);
  sandboxGit(['apply', '-p2', c.brief.wip], { cwd: c.tree });
  await end('CRM-2', 't2');
  const done = await spike(['next', '--track', 't2']);
  assert.equal(done.code, 0, done.stderr);
  assert.equal(json(done).action, 'complete');
});

test('a changes crossing puts C right after B and re-spikes only B\'s done dependents before C', async () => {
  const { dir, spike, open, end, cross, record } = await tracksRun(
    [issue('CRM-1', { relations: blocks('CRM-3') }), issue('CRM-2'), issue('CRM-3'), issue('CRM-4'), issue('CRM-5')],
    { t1: ['CRM-1', 'CRM-2', 'CRM-3', 'CRM-4'], t2: ['CRM-5'] },
  );
  for (const card of ['CRM-1', 'CRM-2', 'CRM-3', 'CRM-4']) {
    await open(card, 't1');
    await end(card, 't1');
  }
  await open('CRM-5', 't2', { 'CRM-1.txt': 'CRM-1 changed by CRM-5\n' });

  const r = await cross('t2', 'CRM-5', 'CRM-1', 'changes');
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual([json(r).track, json(r).merged, json(r).respiked], ['t1', 't2', ['CRM-3']]);
  const state = readState(dir);
  assert.deepEqual(state.tracks.t1.cards, ['CRM-1', 'CRM-5', 'CRM-2', 'CRM-3', 'CRM-4']);
  assert.deepEqual(['CRM-1', 'CRM-2', 'CRM-3', 'CRM-4', 'CRM-5'].map(k => state.cards[k].status), ['done', 'done', 'pending', 'done', 'pending']);
  assert.deepEqual([state.cards['CRM-3'].respikedBy, state.plan.cards['CRM-3'].mode], [{ crossing: 0 }, 'spike']);
  assert.deepEqual(record('CRM-3').respikedBy, { crossing: 0 });
  assert.deepEqual([state.cards['CRM-2'].respikedBy, state.cards['CRM-4'].respikedBy], [undefined, undefined]);
  assert.deepEqual(state.crossings[0].respiked, ['CRM-3']);
  assert.deepEqual(files(treeOf(dir, 't1')), ['CRM-1.txt', 'CRM-2.txt', 'CRM-4.txt']);
  assert.equal(readFileSync(join(treeOf(dir, 't1'), 'CRM-1.txt'), 'utf8'), 'CRM-1\n');
  assert.deepEqual(state.tracks.t1.repos.backend.log.map(e => e.name), ['00001-new', '00002-new', '00004-new']);
  assert.ok(clean(dir, 't2'));
  const rebuilt = await spike(['rebuild', 'backend', '--track', 't1']);
  assert.equal(rebuilt.code, 0, rebuilt.stderr);

  const c = await open('CRM-5', 't1', {});
  assert.match(readFileSync(c.brief.wip, 'utf8'), /\+CRM-1 changed by CRM-5/);
});

test('a merge replay that conflicts turns the card into a spike with respikedBy', async () => {
  const { dir, spike, open, end, cross, record } = await tracksRun(
    [issue('CRM-1', { relations: blocks('CRM-2') }), issue('CRM-2'), issue('CRM-3', { relations: blocks('CRM-4') }), issue('CRM-4')],
    { t1: ['CRM-1', 'CRM-2'], t2: ['CRM-3', 'CRM-4'] },
  );
  await open('CRM-1', 't1', { 'src/index.js': 'export const one = 11\n' });
  await end('CRM-1', 't1');
  await open('CRM-3', 't2', { 'src/index.js': 'export const one = 33\n' });
  await end('CRM-3', 't2');
  await open('CRM-2', 't1');

  const r = await cross('t1', 'CRM-2', 'CRM-4', 'depends');
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual([json(r).replayed, json(r).respiked], [[], ['CRM-1']]);
  const state = readState(dir);
  assert.deepEqual([state.cards['CRM-1'].status, state.cards['CRM-1'].respikedBy, state.plan.cards['CRM-1'].mode], ['pending', { crossing: 0 }, 'spike']);
  assert.equal(state.cards['CRM-1'].mergedFrom, undefined);
  assert.deepEqual(record('CRM-1').respikedBy, { crossing: 0 });
  assert.equal(readFileSync(join(treeOf(dir, 't2'), 'src', 'index.js'), 'utf8'), 'export const one = 33\n');
  assert.deepEqual(state.tracks.t2.repos.backend.log.map(e => e.name), ['00003-new']);
  assert.ok(clean(dir, 't2'));
  const next = await spike(['next', '--track', 't2']);
  assert.equal(json(next).card, 'CRM-1');
});

test('a merge replay that fails the type-check is re-spiked and leaves the target tree as it was', async () => {
  const typecheck = config => ({ ...config, repos: { backend: { ...config.repos.backend, spikeTypecheck: ['tc', '{changed}'] } } });
  const { f, dir, open, end } = await tracksRun(
    [issue('CRM-1', { relations: blocks('CRM-2') }), issue('CRM-2'), issue('CRM-3', { relations: blocks('CRM-4') }), issue('CRM-4')],
    { t1: ['CRM-1', 'CRM-2'], t2: ['CRM-3', 'CRM-4'] }, { config: typecheck },
  );
  await open('CRM-1', 't1');
  await end('CRM-1', 't1');
  await open('CRM-3', 't2');
  await end('CRM-3', 't2');
  await open('CRM-2', 't1');
  const failing = (argv, { cwd } = {}) => ({ status: argv.join(' ') === 'tc CRM-1.txt' && cwd === treeOf(dir, 't2') ? 2 : 0, stdout: '', stderr: '' });
  const r = await run(['cross', '--track', 't1', '--card', 'CRM-2', '--needs', 'CRM-4', '--kind', 'depends', '--note', 'Needs CRM-4.'], { ...f.deps, runSetup: failing });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual([json(r).replayed, json(r).respiked], [[], ['CRM-1']]);
  const state = readState(dir);
  assert.deepEqual([state.cards['CRM-1'].status, state.cards['CRM-1'].respikedBy], ['pending', { crossing: 0 }]);
  assert.deepEqual(files(treeOf(dir, 't2')), ['CRM-3.txt']);
  assert.ok(clean(dir, 't2'));
});

test('cross while G has a card in progress is deferred and changes nothing', async () => {
  const { dir, open, end, cross } = await tracksRun([issue('CRM-1', { relations: blocks('CRM-2') }), issue('CRM-2'), issue('CRM-3')], { t1: ['CRM-1', 'CRM-2'], t2: ['CRM-3'] });
  await open('CRM-1', 't1');
  const c = await open('CRM-3', 't2');
  const before = readState(dir);

  const r = await cross('t2', 'CRM-3', 'CRM-2', 'depends');
  assert.equal(r.code, 1);
  assert.deepEqual(json(r), { action: 'deferred', crossing: 0, track: 't1', card: 'CRM-1' });
  assert.match(r.stderr, /CRM-1 is in progress in t1/);
  const state = readState(dir);
  assert.deepEqual([state.tracks, state.cards], [before.tracks, before.cards]);
  assert.equal(state.crossings[0].pending, true);
  assert.equal(waitingOn({ ...state, cards: { ...state.cards, 'CRM-3': { status: 'pending' } } }, 'CRM-3'), null);
  assert.equal(readFileSync(join(c.tree, 'CRM-3.txt'), 'utf8'), 'CRM-3\n');
  assert.equal(existsSync(join(dir, 'wip')), false);

  await end('CRM-1', 't1');
  const again = await cross('t2', 'CRM-3', 'CRM-2', 'depends');
  assert.equal(again.code, 0, again.stderr);
  const merged = readState(dir);
  assert.equal(merged.crossings.length, 1);
  assert.deepEqual([merged.crossings[0].pending, merged.tracks.t2.mergedInto, merged.tracks.t1.cards], [undefined, 't1', ['CRM-1', 'CRM-2', 'CRM-3']]);
});

test('cross that closes a cycle exits 5 and changes nothing', async () => {
  const { dir, open, cross } = await tracksRun([issue('CRM-1', { relations: blocks('CRM-2') }), issue('CRM-2'), issue('CRM-3')], { t1: ['CRM-1', 'CRM-2'], t2: ['CRM-3'] });
  await open('CRM-1', 't1');
  await open('CRM-3', 't2');
  assert.equal(json(await cross('t2', 'CRM-3', 'CRM-1', 'depends')).action, 'deferred');
  const before = readFileSync(join(dir, 'run.json'), 'utf8');
  const r = await cross('t1', 'CRM-1', 'CRM-3', 'changes');
  assert.equal(r.code, 5);
  assert.match(r.stderr, /CRM-3 -> CRM-1 closes a cycle/);
  assert.equal(readFileSync(join(dir, 'run.json'), 'utf8'), before);
});

test('C\'s work in progress is saved as wip and offered in its next brief', async () => {
  const { dir, spike, open, end, cross } = await tracksRun([issue('CRM-1'), issue('CRM-2')], { t1: ['CRM-1'], t2: ['CRM-2'] });
  await open('CRM-2', 't2');
  await end('CRM-2', 't2');
  await open('CRM-1', 't1', { 'CRM-1.txt': 'CRM-1\n', 'src/index.js': 'export const one = 1\nexport const two = 2\n' });

  const r = await cross('t1', 'CRM-1', 'CRM-2', 'depends');
  assert.equal(r.code, 0, r.stderr);
  const wip = join(dir, 'wip', 'CRM-1.patch');
  assert.equal(json(r).wip, wip);
  assert.match(readFileSync(wip, 'utf8'), /^diff --git a\/backend\/CRM-1\.txt b\/backend\/CRM-1\.txt/m);
  assert.match(readFileSync(wip, 'utf8'), /\+export const two = 2/);
  assert.ok(clean(dir, 't1'));

  const c = await open('CRM-1', 't2', {});
  assert.equal(c.brief.wip, wip);
  sandboxGit(['apply', '-p2', wip], { cwd: c.tree });
  assert.equal(readFileSync(join(c.tree, 'src', 'index.js'), 'utf8'), 'export const one = 1\nexport const two = 2\n');
  await end('CRM-1', 't2');
  assert.equal(existsSync(wip), false);
  assert.equal(json(await spike(['next', '--track', 't2'])).action, 'complete');
});

test('a crossing recorded after C ended re-spikes C too', async () => {
  const { dir, spike, open, end, cross, record } = await tracksRun([issue('CRM-1'), issue('CRM-2')], { t1: ['CRM-1'], t2: ['CRM-2'] });
  await open('CRM-2', 't2');
  await end('CRM-2', 't2');
  await open('CRM-1', 't1', { 'CRM-1.txt': 'CRM-1\n', 'CRM-2.txt': 'CRM-2 changed by CRM-1\n' });
  const ended = await end('CRM-1', 't1');
  assert.deepEqual(ended.crossingSuspects.map(s => s.card), ['CRM-2']);
  const spiked = record('CRM-1');

  const r = await cross('t1', 'CRM-1', 'CRM-2', 'changes');
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual([json(r).replayed, json(r).respiked, json(r).wip], [[], ['CRM-1'], undefined]);
  const state = readState(dir);
  assert.deepEqual([state.cards['CRM-1'].status, state.cards['CRM-1'].respikedBy], ['pending', { crossing: 0 }]);
  assert.deepEqual(record('CRM-1').respikedBy, { crossing: 0 });
  assert.deepEqual(files(treeOf(dir, 't2')), ['CRM-2.txt']);
  const next = json(await spike(['next', '--track', 't2']));
  assert.deepEqual([next.card, next.wip], ['CRM-1', undefined]);
  assert.deepEqual(next.previous, { spikedAt: spiked.spikedAt, findings: spiked.findings, decisions: spiked.decisions, openDecisions: spiked.openDecisions });
  const template = json(await spike(['notes-template', 'CRM-1', '--track', 't2']));
  assert.deepEqual(template.notes.priorFindings, []);
});

test('a crossing recorded after C ended also re-spikes B\'s done dependents numbered after C', async () => {
  const { dir, open, end, cross } = await tracksRun(
    [issue('CRM-1', { relations: blocks('CRM-3') }), issue('CRM-2'), issue('CRM-3')], { t1: ['CRM-1', 'CRM-3'], t2: ['CRM-2'] },
  );
  for (const card of ['CRM-1', 'CRM-3']) {
    await open(card, 't1');
    await end(card, 't1');
  }
  await open('CRM-2', 't2', { 'CRM-1.txt': 'CRM-1 changed by CRM-2\n' });
  await end('CRM-2', 't2');
  const r = await cross('t2', 'CRM-2', 'CRM-1', 'changes');
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(json(r).respiked, ['CRM-2', 'CRM-3']);
  assert.deepEqual(files(treeOf(dir, 't1')), ['CRM-1.txt']);
  assert.deepEqual(readState(dir).tracks.t1.cards, ['CRM-1', 'CRM-2', 'CRM-3']);
});

test('fixups that leave every live log are marked droppedBy and leave the fixed card\'s record', async () => {
  const { dir, spike, open, end, cross, record } = await tracksRun(
    [issue('CRM-1', { relations: blocks('CRM-2') }), issue('CRM-2'), issue('CRM-3', { relations: blocks('CRM-4') }), issue('CRM-4')],
    { t1: ['CRM-1', 'CRM-2'], t2: ['CRM-3', 'CRM-4'] },
  );
  await open('CRM-1', 't1');
  await end('CRM-1', 't1');
  await open('CRM-3', 't2');
  await end('CRM-3', 't2');
  await open('CRM-2', 't1', { 'CRM-1.txt': 'CRM-1 adapted\n' });
  const fixed = await spike(['fixup', '--track', 't1', '--fixes', 'CRM-1', '--slug', 'adapt', '--note', 'Adapts CRM-1.', '--repo', 'backend', '--', 'CRM-1.txt']);
  assert.equal(fixed.code, 0, fixed.stderr);
  const patch = 'backend/fixup-1-from-2-adapt.patch';
  assert.deepEqual(record('CRM-1').fixups.received.map(f => f.patch), [patch]);

  const r = await cross('t1', 'CRM-2', 'CRM-4', 'depends');
  assert.equal(r.code, 0, r.stderr);
  const state = readState(dir);
  assert.deepEqual(state.fixups.map(f => [f.patch, f.droppedBy]), [[patch, { crossing: 0 }]]);
  assert.deepEqual(record('CRM-1').fixups.received, []);
  assert.deepEqual(record('CRM-1').mergedFrom, { track: 't1', crossing: 0 });
  assert.equal(readFileSync(join(treeOf(dir, 't2'), 'CRM-1.txt'), 'utf8'), 'CRM-1\n');
  assert.match(readFileSync(json(r).wip, 'utf8'), /\+CRM-1 adapted/);
});

test('cross into or from a track whose replay is in flight answers 75; a dead replay mark does not count', async () => {
  const { f, dir, open, end, cross } = await tracksRun([issue('CRM-1'), issue('CRM-2')], { t1: ['CRM-1'], t2: ['CRM-2'] });
  await open('CRM-2', 't2');
  await end('CRM-2', 't2');
  await open('CRM-1', 't1');
  const mark = (track, pid) => {
    const state = readState(dir);
    state.tracks[track].replaying = pid ? { pid } : undefined;
    saveState(dir, state, f.deps.now());
  };
  for (const track of ['t2', 't1']) {
    mark(track, process.pid);
    const r = await cross('t1', 'CRM-1', 'CRM-2', 'depends');
    assert.equal(r.code, 75, r.stderr);
    assert.deepEqual(json(r), { action: 'busy', replaying: track });
    assert.equal(readState(dir).crossings.length, 0);
    mark(track, null);
  }
  const gone = spawnSync(process.execPath, ['-e', ''], { env: { HOME: f.scratch } }).pid;
  mark('t2', gone);
  const r = await cross('t1', 'CRM-1', 'CRM-2', 'depends');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(json(r).action, 'merged');
});

test('two tracks crossing each other mid-card: the second cross merges, and the first applies inside the track on its rerun', async () => {
  const { dir, spike, open, end, cross } = await tracksRun(
    [issue('CRM-1', { relations: blocks('CRM-2') }), issue('CRM-2'), issue('CRM-3', { relations: blocks('CRM-4') }), issue('CRM-4'), issue('CRM-5')],
    { t1: ['CRM-1', 'CRM-2'], t2: ['CRM-3', 'CRM-4', 'CRM-5'] },
  );
  await open('CRM-1', 't1');
  await end('CRM-1', 't1');
  for (const card of ['CRM-3', 'CRM-4']) {
    await open(card, 't2');
    await end(card, 't2');
  }
  await open('CRM-2', 't1', { 'CRM-2.txt': 'CRM-2\n', 'CRM-3.txt': 'CRM-3 changed by CRM-2\n' });
  await open('CRM-5', 't2');
  assert.equal(json(await cross('t1', 'CRM-2', 'CRM-3', 'changes')).action, 'deferred');

  const merged = await cross('t2', 'CRM-5', 'CRM-1', 'depends');
  assert.equal(merged.code, 0, merged.stderr);
  assert.deepEqual([json(merged).action, json(merged).track, json(merged).merged, json(merged).parked], ['merged', 't1', 't2', 'CRM-2']);
  let state = readState(dir);
  assert.deepEqual(['CRM-2', 'CRM-5'].map(k => state.cards[k].status), ['pending', 'pending']);
  assert.equal(state.tracks.t1.current, null);
  assert.match(readFileSync(join(dir, 'wip', 'CRM-2.patch'), 'utf8'), /\+CRM-3 changed by CRM-2/);
  assert.deepEqual(files(treeOf(dir, 't1')), ['CRM-1.txt', 'CRM-3.txt', 'CRM-4.txt']);
  assert.ok(clean(dir, 't1'));
  assert.equal(state.crossings[0].pending, true);

  const applied = await cross('t1', 'CRM-2', 'CRM-3', 'changes');
  assert.equal(applied.code, 0, applied.stderr);
  assert.deepEqual(json(applied), { action: 'applied', crossing: 0, track: 't1', kind: 'changes', respiked: ['CRM-4'] });
  state = readState(dir);
  assert.deepEqual([state.crossings[0].pending, state.crossings[0].fromTrack, state.crossings[0].toTrack], [undefined, 't1', 't1']);
  assert.deepEqual([state.cards['CRM-4'].status, state.cards['CRM-4'].respikedBy], ['pending', { crossing: 0 }]);
  assert.deepEqual(files(treeOf(dir, 't1')), ['CRM-1.txt', 'CRM-3.txt']);
  assert.deepEqual(state.tracks.t1.cards, ['CRM-1', 'CRM-3', 'CRM-2', 'CRM-4', 'CRM-5']);
  const next = json(await spike(['next', '--track', 't1']));
  assert.deepEqual([next.card, next.wip], ['CRM-2', join(dir, 'wip', 'CRM-2.patch')]);
});

test('a replay that goes stale leaves a tree another command moved where that command put it', async () => {
  const f = R.respikeFixture();
  const plan = json(await f.run('preflight', [R.PROJECT_URL, '--cards', R.B]));
  f.at('2026-11-10T10:01:00.000Z');
  const { runId } = json(await f.run('begin', [R.PROJECT_URL, '--cards', R.B, '--approve', plan.approve]));
  const dir = join(f.home, R.SLUG, 'runs', runId);
  const tree = join(dir, 'trees', 't1', 'backend');
  f.at('2026-11-10T10:02:00.000Z');
  assert.equal((await f.spike(['tree', 'backend'])).code, 0);
  const rebuilt = 'rebuilt by a merge\n';
  let merged = false;
  // After the replay's snapshot and before its second locked section, as a merge's tree work would land.
  const git = (args, opts = {}) => {
    const out = f.deps.git(args, opts);
    if (!merged && args[0] === 'ls-tree' && opts.cwd === tree) {
      merged = true;
      const state = readState(dir);
      assert.deepEqual(state.tracks.t1.replaying, { pid: process.pid });
      state.tracks.t1.generation += 1;
      saveState(dir, state, f.deps.now());
      writeFileSync(join(tree, 'src', 'list.js'), rebuilt);
      sandboxGit(['add', '-A'], { cwd: tree });
    }
    return out;
  };
  const r = await f.spike(['next'], { git });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(json(r), { action: 'stale', track: 't1' });
  assert.equal(readFileSync(join(tree, 'src', 'list.js'), 'utf8'), rebuilt);
  assert.equal(readState(dir).tracks.t1.replaying, undefined);
});

test('while a cross runs both tracks answer 75; a pause makes it stale, the crossing stays pending and a rerun applies it', async () => {
  const typecheck = config => ({ ...config, repos: { backend: { ...config.repos.backend, spikeTypecheck: ['tc', '{changed}'] } } });
  const { f, dir, spike, open, end, cross } = await tracksRun(
    [issue('CRM-1', { relations: blocks('CRM-2') }), issue('CRM-2'), issue('CRM-3', { relations: blocks('CRM-4') }), issue('CRM-4')],
    { t1: ['CRM-1', 'CRM-2'], t2: ['CRM-3', 'CRM-4'] }, { config: typecheck },
  );
  await open('CRM-1', 't1');
  await end('CRM-1', 't1');
  await open('CRM-3', 't2');
  await end('CRM-3', 't2');
  await open('CRM-2', 't1');
  const child = argv => spawnSync(process.execPath, [SPIKE, ...argv], {
    env: { ...SANDBOX_ENV, HOME: f.scratch, KEIRON_SEQUENCER_HOME: f.home, KEIRON_SEQUENCER_TRANSCRIPTS: f.scratch }, encoding: 'utf8',
  });
  const seen = [];
  let busy = null;
  const pausing = (argv, { cwd } = {}) => {
    if (argv.join(' ') === 'tc CRM-1.txt' && cwd === treeOf(dir, 't2') && !seen.length) {
      const refused = ['t1', 't2'].map(t => child(['next', '--track', t]));
      busy = JSON.parse(refused[1].stdout);
      seen.push(...refused.map(c => c.status), child(['pause']).status);
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  f.at(at(6));
  const r = await run(['cross', '--track', 't1', '--card', 'CRM-2', '--needs', 'CRM-4', '--kind', 'depends', '--note', 'CRM-2 needs CRM-4.'], { ...f.deps, runSetup: pausing });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(json(r), { action: 'stale', track: 't1' });
  assert.deepEqual(seen, [75, 75, 0]);
  assert.deepEqual(busy, { action: 'busy', merging: { from: 't1', into: 't2' } });
  const state = readState(dir);
  assert.deepEqual([state.crossings[0].pending, state.crossings[0].merging, state.tracks.t1.mergedInto], [true, undefined, null]);
  assert.deepEqual(files(treeOf(dir, 't2')), ['CRM-3.txt']);
  assert.ok(clean(dir, 't2'));
  assert.equal(state.cards['CRM-2'].status, 'in-progress');
  assert.ok(existsSync(join(treeOf(dir, 't1'), 'CRM-2.txt')));

  assert.equal((await spike(['begin', PROJECT_URL])).code, 0);
  const again = await cross('t1', 'CRM-2', 'CRM-4', 'depends');
  assert.equal(again.code, 0, again.stderr);
  assert.deepEqual([json(again).crossing, json(again).replayed], [0, ['CRM-1']]);
  assert.match(readFileSync(json(again).wip, 'utf8'), /b\/backend\/CRM-2\.txt/);
  assert.equal(readState(dir).crossings.length, 1);
});

test('in a respike run a merge keeps a replayed card\'s record as replayed and adds mergedFrom, and the run completes', async () => {
  const C = 'CRM-5';
  const f = R.respikeFixture({ issues: ([a, b]) => [a, b, R.issue(C)] });
  const pick = [R.PROJECT_URL, '--cards', `${R.B},${C}`];
  const plan = json(await f.run('preflight', pick));
  f.at('2026-11-10T10:01:00.000Z');
  const { runId } = json(await f.run('begin', [...pick, '--approve', plan.approve]));
  const dir = join(f.home, R.SLUG, 'runs', runId);
  assert.deepEqual(readState(dir).plan.edges, [{ from: R.A, to: R.B }]);
  mkdirSync(join(dir, 'notes'), { recursive: true });
  const work = async (card, track, minute) => {
    f.at(at(minute));
    const brief = json(await f.spike(['next', '--track', track]));
    assert.deepEqual([brief.action, brief.card], ['card', card]);
    const tree = json(await f.spike(['tree', 'backend', '--track', track])).path;
    writeFileSync(join(tree, `${card}.txt`), `${card}\n`);
    writeFileSync(join(dir, 'notes', `${card}.json`), JSON.stringify(R.notes(card)));
    return brief;
  };
  await work(C, 't2', 2);
  f.at(at(3));
  assert.equal((await f.spike(['end', C, '--track', 't2'])).code, 0);
  const b = await work(R.B, 't1', 4);
  assert.deepEqual(b.replayed.map(e => [e.card, e.status]), [[R.A, 'replayed']]);
  assert.equal(readState(dir).tracks.t1.replaying, undefined);

  f.at(at(5));
  const r = await f.spike(['cross', '--track', 't1', '--card', R.B, '--needs', C, '--kind', 'depends', '--note', 'B needs C.']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual([json(r).replayed, json(r).respiked], [[R.A], []]);
  const state = readState(dir);
  assert.deepEqual(state.tracks.t2.cards, [R.A, C, R.B]);
  const recordA = JSON.parse(readFileSync(join(f.dataDir, R.SLUG, `${R.A}.json`), 'utf8'));
  assert.deepEqual([recordA.replayed.runId, recordA.mergedFrom], [runId, { track: 't1', crossing: 0 }]);
  const brief = await work(R.B, 't2', 6);
  assert.equal(brief.wip, join(dir, 'wip', `${R.B}.patch`));
  f.at(at(7));
  assert.equal((await f.spike(['end', R.B, '--track', 't2'])).code, 0);
  assert.equal(json(await f.spike(['next', '--track', 't2'])).action, 'complete');
});
