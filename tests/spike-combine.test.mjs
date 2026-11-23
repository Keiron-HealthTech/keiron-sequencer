import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../scripts/spike.mjs';
import { parseTypecheckErrors } from '../scripts/lib/spike/combined.mjs';
import { readState, saveState } from '../scripts/lib/spike/state.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import { activeRunDir, issue, notes, PROJECT_URL, SLUG, spikeFixture } from './helpers/spike-fixture.mjs';

guardNetwork();

const json = r => JSON.parse(r.stdout);
const at = minute => `2026-11-10T10:${String(minute).padStart(2, '0')}:00.000Z`;
const SHARED = Array.from({ length: 10 }, (_, i) => `export const v${i + 1} = ${i + 1}`).join('\n') + '\n';

// A typecheck runner: every call is kept with the changed paths it was given and the file texts it saw in the tree.
function checker(answer = () => ({ status: 0, stdout: '' })) {
  const calls = [];
  const run = (argv, { cwd } = {}) => {
    if (argv[0] !== 'tc') return { status: 0, stdout: '', stderr: '' };
    const shared = join(cwd, 'src', 'shared.ts');
    calls.push({ cwd, changed: argv.slice(1), shared: existsSync(shared) ? readFileSync(shared, 'utf8') : null });
    return { stderr: '', ...answer(calls.at(-1)) };
  };
  return { calls, run };
}

// spike begin keeps one track; the run is split by hand into `split` before any tree opens.
async function tracksRun(issues, split) {
  const f = spikeFixture({
    issues,
    config: config => {
      Object.assign(config.repos.backend, { spikeTypecheck: ['tc', '{changed}'] });
      return config;
    },
  });
  writeFileSync(join(f.repo.dir, 'src', 'shared.ts'), SHARED);
  f.repo.git(['add', '-A']);
  f.repo.git(['commit', '-q', '-m', 'shared']);
  const begun = await run(['begin', PROJECT_URL], f.deps);
  assert.equal(begun.code, 0, begun.stderr);
  const dir = activeRunDir(f.home);
  const state = readState(dir);
  state.tracks = Object.fromEntries(Object.entries(split).map(([id, cards]) => [id, { ...state.tracks.t1, cards }]));
  saveState(dir, state, f.deps.now());
  mkdirSync(join(dir, 'notes'), { recursive: true });
  let minute = 0;
  const tick = () => f.at(at(++minute));
  const spike = (argv, runSetup) => {
    tick();
    return run(argv, runSetup ? { ...f.deps, runSetup } : f.deps);
  };
  const open = async (card, track, edit = tree => writeFileSync(join(tree, `${card}.txt`), `${card}\n`)) => {
    const brief = await spike(['next', '--track', track]);
    assert.equal(brief.code, 0, brief.stderr);
    assert.deepEqual([json(brief).action, json(brief).card], ['card', card]);
    const tree = await spike(['tree', 'backend', '--track', track]);
    assert.equal(tree.code, 0, tree.stderr);
    edit(json(tree).path);
    writeFileSync(join(dir, 'notes', `${card}.json`), JSON.stringify(notes));
    return json(tree).path;
  };
  const end = async (card, track) => {
    const r = await spike(['end', card, '--track', track]);
    assert.equal(r.code, 0, r.stderr);
    return json(r);
  };
  const play = async (card, track, edit) => {
    await open(card, track, edit);
    return end(card, track);
  };
  const record = card => JSON.parse(readFileSync(join(f.dataDir, SLUG, `${card}.json`), 'utf8'));
  return { f, dir, spike, open, end, play, record };
}

const editLine = (n, text) => tree => {
  const lines = readFileSync(join(tree, 'src', 'shared.ts'), 'utf8').split('\n');
  lines[n - 1] = text;
  writeFileSync(join(tree, 'src', 'shared.ts'), lines.join('\n'));
};

// t1 = CRM-1 then CRM-2, t2 = CRM-3: CRM-1 changes line 2 of src/shared.ts, CRM-3 changes line 8.
async function doneTracks() {
  const r = await tracksRun([issue('CRM-1'), issue('CRM-2'), issue('CRM-3')], { t1: ['CRM-1', 'CRM-2'], t2: ['CRM-3'] });
  await r.play('CRM-1', 't1', editLine(2, 'export const v2 = \'two\''));
  await r.play('CRM-3', 't2', editLine(8, 'export const v8 = \'eight\''));
  await r.play('CRM-2', 't1');
  for (const track of ['t1', 't2']) assert.equal(json(await r.spike(['next', '--track', track])).action, 'track-done');
  return r;
}

test('combine with clean tracks completes the run', async () => {
  const { dir, spike, play } = await tracksRun([issue('CRM-1'), issue('CRM-2'), issue('CRM-3')], { t1: ['CRM-1', 'CRM-2'], t2: ['CRM-3'] });
  await play('CRM-1', 't1');
  await play('CRM-3', 't2');
  await play('CRM-2', 't1');
  assert.deepEqual(json(await spike(['next', '--track', 't1'])), { action: 'track-done', track: 't1' });
  const refused = await spike(['combine']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /combine runs once every track is done: t2 is active/);

  const last = await spike(['next', '--track', 't2']);
  assert.deepEqual(json(last), { action: 'track-done', track: 't2', combine: true });
  assert.equal(readState(dir).status, 'active');

  const tc = checker();
  const r = await spike(['combine'], tc.run);
  assert.equal(r.code, 0, r.stderr);
  const out = json(r);
  assert.equal(out.action, 'combined-ok');
  assert.deepEqual(out.removed.map(x => x.path).sort(), ['combined', 't1', 't2'].map(t => join(dir, 'trees', t, 'backend')));
  assert.deepEqual(tc.calls.map(c => [c.cwd, c.changed]), [[join(dir, 'trees', 'combined', 'backend'), ['CRM-1.txt', 'CRM-2.txt', 'CRM-3.txt']]]);
  const state = readState(dir);
  assert.equal(state.status, 'complete');
  assert.deepEqual(state.combine.results.map(x => x.ok), [true]);
  assert.equal(state.combine.rounds, 0);
  assert.equal(existsSync(join(dir, 'trees', 'combined', 'backend')), false);
});

test('combine reports each type error with the cards that touched its lines', async () => {
  const { dir, spike } = await doneTracks();
  const tc = checker(() => ({
    status: 2,
    stdout: [
      'src/shared.ts(8,14): error TS2322: Type \'string\' is not assignable to type \'number\'.',
      'src/shared.ts:5:1 - error TS2304: Cannot find name \'v5\'.',
    ].join('\n'),
  }));
  const r = await spike(['combine'], tc.run);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(json(r), {
    action: 'combined-failed',
    round: 1,
    errors: [
      { repo: 'backend', file: 'src/shared.ts', line: 8, message: 'TS2322: Type \'string\' is not assignable to type \'number\'.', cards: ['CRM-3'] },
      { repo: 'backend', file: 'src/shared.ts', line: 5, message: 'TS2304: Cannot find name \'v5\'.', cards: ['CRM-1', 'CRM-3'] },
    ],
  });
  assert.deepEqual(tc.calls.map(c => c.changed), [['CRM-2.txt', 'src/shared.ts']]);
  assert.match(tc.calls[0].shared, /v2 = 'two'[\s\S]*v8 = 'eight'/);
  const state = readState(dir);
  assert.deepEqual([state.status, state.combine.rounds, state.combine.results.length, state.combine.results[0].ok], ['active', 1, 1, false]);
  assert.equal(state.combine.running, undefined);
  assert.equal(readFileSync(join(dir, 'logs', 'combined', 'typecheck-backend.log'), 'utf8').match(/TS2322/g).length, 1);
});

test('a combined fixup is credited to the clashing cards from combine', async () => {
  const { dir, spike, record } = await doneTracks();
  const failing = checker(() => ({ status: 2, stdout: 'src/shared.ts(8,14): error TS2322: Type \'string\' is not assignable to type \'number\'.' }));
  assert.equal(json(await spike(['combine'], failing.run)).action, 'combined-failed');

  const tree = join(dir, 'trees', 'combined', 'backend');
  editLine(8, 'export const v8 = 8 // fixed')(tree);
  const note = 'CRM-1 and CRM-3 change the type of the shared constants; v8 keeps its number.';
  const fix = await spike(['fixup', '--combined', '--fixes', 'CRM-3,CRM-1', '--note', note, '--repo', 'backend', '--', 'src/shared.ts']);
  assert.equal(fix.code, 0, fix.stderr);
  const patch = 'backend/fixup-1-3-from-combine-1.patch';
  assert.deepEqual([json(fix).action, json(fix).patch, json(fix).fixed, json(fix).from], ['fixup', patch, ['CRM-1', 'CRM-3'], 'combine']);
  assert.match(readFileSync(join(dir, 'patches', patch), 'utf8'), /\+export const v8 = 8 \/\/ fixed/);
  const row = readState(dir).fixups.at(-1);
  assert.deepEqual([row.patch, row.from, row.fixed, row.note, row.round], [patch, 'combine', ['CRM-1', 'CRM-3'], note, 1]);
  for (const card of ['CRM-1', 'CRM-3']) assert.deepEqual(record(card).fixups.received, [{ from: 'combine', patch, note }]);
  assert.deepEqual(record('CRM-2').fixups.received, []);

  const passing = checker(c => ({ status: c.shared.includes('v8 = 8 // fixed') ? 0 : 2, stdout: '' }));
  const r = await spike(['combine'], passing.run);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(json(r).action, 'combined-ok');
  assert.match(passing.calls[0].shared, /v2 = 'two'[\s\S]*v8 = 8 \/\/ fixed/);
  assert.equal(readState(dir).status, 'complete');
});

test('a combined fixup is refused without a combined tree, for a card not done, or with work left unrecorded', async () => {
  const { dir, spike } = await doneTracks();
  const args = ['fixup', '--combined', '--fixes', 'CRM-1', '--note', 'Fix.', '--repo', 'backend', '--', 'src/shared.ts'];
  const none = await spike(args);
  assert.equal(none.code, 1);
  assert.match(none.stderr, /backend has no combined tree: run combine first/);
  assert.equal((await spike(['fixup', '--combined', '--fixes', 'CRM-1', '--slug', 'x', '--note', 'Fix.', '--repo', 'backend', '--', 'a'])).code, 2);

  const failing = checker(() => ({ status: 2, stdout: 'src/shared.ts(8,1): error TS1: x' }));
  await spike(['combine'], failing.run);
  const state = readState(dir);
  state.cards['CRM-2'].status = 'pending';
  saveState(dir, state, new Date(at(50)));
  const pending = await spike(['fixup', '--combined', '--fixes', 'CRM-2', '--note', 'Fix.', '--repo', 'backend', '--', 'src/shared.ts']);
  assert.equal(pending.code, 1);
  assert.match(pending.stderr, /CRM-2 is not done in this run/);
  state.cards['CRM-2'].status = 'done';
  saveState(dir, state, new Date(at(51)));

  writeFileSync(join(dir, 'trees', 'combined', 'backend', 'loose.txt'), 'not recorded\n');
  const kept = await spike(['combine'], failing.run);
  assert.equal(kept.code, 6);
  assert.match(kept.stderr, /backend has work in .*trees\/combined\/backend that was not recorded: record it with fixup --combined/);
  assert.equal(readState(dir).combine.rounds, 1);
  assert.equal(readState(dir).combine.running, undefined);
});

test('the third failed round pauses the run with reason combine', async () => {
  const { dir, spike } = await doneTracks();
  const tc = checker(() => ({ status: 2, stdout: 'src/shared.ts(2,1): error TS2304: Cannot find name \'x\'.' }));
  const error = { repo: 'backend', file: 'src/shared.ts', line: 2, message: 'TS2304: Cannot find name \'x\'.', cards: ['CRM-1'] };
  for (const round of [1, 2]) assert.deepEqual(json(await spike(['combine'], tc.run)), { action: 'combined-failed', round, errors: [error] });
  const third = await spike(['combine'], tc.run);
  assert.equal(third.code, 0, third.stderr);
  const out = json(third);
  assert.deepEqual([out.action, out.reason, out.errors], ['pause', 'combine', [error]]);
  assert.match(out.mark, /^keiron-sequencer-spike:/);
  const state = readState(dir);
  assert.deepEqual([state.status, state.combine.rounds, state.executions.at(-1).endReason], ['paused', 3, 'combine']);
  const again = await spike(['combine'], tc.run);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /the run is paused \(combine\): run begin to resume it/);
});

test('a patch that does not apply on the combined tree is a failed round naming its cards', async () => {
  const { dir, spike, play } = await tracksRun([issue('CRM-1'), issue('CRM-3')], { t1: ['CRM-1'], t2: ['CRM-3'] });
  await play('CRM-1', 't1', editLine(5, 'export const v5 = \'one\''));
  await play('CRM-3', 't2', editLine(5, 'export const v5 = \'three\''));
  for (const track of ['t1', 't2']) await spike(['next', '--track', track]);
  const tc = checker();
  const r = await spike(['combine'], tc.run);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(json(r), {
    action: 'combined-failed',
    round: 1,
    errors: [{ repo: 'backend', file: 'src/shared.ts', line: null, message: '00003-new.patch does not apply on the combined tree (conflict)', cards: ['CRM-1', 'CRM-3'] }],
  });
  assert.deepEqual(tc.calls, []);
  assert.equal(readState(dir).combine.rounds, 1);
});

test('a merged track is combined in its own log order, not the plan order', async () => {
  const { dir, spike, open, end } = await tracksRun([issue('CRM-1'), issue('CRM-2')], { t1: ['CRM-1'], t2: ['CRM-2'] });
  await open('CRM-2', 't2');
  await end('CRM-2', 't2');
  await open('CRM-1', 't1');
  const crossed = await spike(['cross', '--track', 't1', '--card', 'CRM-1', '--needs', 'CRM-2', '--kind', 'depends', '--note', 'CRM-1 extends CRM-2.']);
  assert.equal(json(crossed).action, 'merged', crossed.stderr);
  await open('CRM-1', 't2', tree => writeFileSync(join(tree, 'CRM-2.txt'), 'CRM-2\nextended by CRM-1\n'));
  await end('CRM-1', 't2');
  assert.deepEqual(readState(dir).tracks.t2.repos.backend.log.map(e => e.name), ['00002-new', '00001-new']);
  assert.deepEqual(json(await spike(['next', '--track', 't2'])), { action: 'track-done', track: 't2', combine: true });
  const tc = checker();
  const r = await spike(['combine'], tc.run);
  assert.equal(json(r).action, 'combined-ok', r.stdout);
  assert.deepEqual(tc.calls.map(c => c.changed), [['CRM-2.txt']]);
});

test('combine skips dropped fixup rows and patches named by a card but held by no log', async () => {
  const { dir, spike, play } = await tracksRun([issue('CRM-1'), issue('CRM-3')], { t1: ['CRM-1'], t2: ['CRM-3'] });
  await play('CRM-1', 't1');
  await play('CRM-3', 't2');
  for (const track of ['t1', 't2']) await spike(['next', '--track', track]);
  const adds = file => `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1 @@\n+${file}\n`;
  writeFileSync(join(dir, 'patches', 'backend', 'fixup-1-from-3-gone.patch'), adds('DROPPED.txt'));
  writeFileSync(join(dir, 'patches', 'backend', '00003-existing.patch'), adds('NOOP.txt'));
  const state = readState(dir);
  state.fixups.push({ patch: 'backend/fixup-1-from-3-gone.patch', from: 'CRM-3', fixed: ['CRM-1'], note: 'Gone.', at: at(40), droppedBy: { crossing: 0 } });
  state.cards['CRM-3'].patches.push('backend/00003-existing.patch');
  saveState(dir, state, new Date(at(40)));
  const tc = checker();
  const r = await spike(['combine'], tc.run);
  assert.equal(json(r).action, 'combined-ok', r.stdout);
  assert.deepEqual(tc.calls.map(c => c.changed), [['CRM-1.txt', 'CRM-3.txt']]);
});

test('combine answers busy with exit 75 when no check slot frees, and counts no round', async () => {
  const { f, dir } = await doneTracks();
  mkdirSync(join(dir, 'checks'), { recursive: true });
  writeFileSync(join(dir, 'checks', '0.lock'), `${process.pid}\nother\n`);
  const tc = checker();
  const r = await run(['combine'], { ...f.deps, runSetup: tc.run, slot: { waitMs: 30, pollMs: 5 } });
  assert.equal(r.code, 75);
  assert.equal(json(r).action, 'busy');
  const state = readState(dir);
  assert.deepEqual([state.status, state.combine.rounds, state.combine.results, state.combine.running], ['active', 0, [], undefined]);
  assert.deepEqual([tc.calls, existsSync(join(dir, 'trees', 'combined'))], [[], false]);
});

test('combine answers stale when a track moved during the check, and keeps the tree it built', async () => {
  const { dir, spike } = await doneTracks();
  const tc = checker(() => {
    const state = readState(dir);
    state.tracks.t1.generation += 1;
    saveState(dir, state, new Date(at(45)));
    return { status: 2, stdout: 'src/shared.ts(2,1): error TS1: x' };
  });
  const r = await spike(['combine'], tc.run);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(json(r), { action: 'stale' });
  const state = readState(dir);
  assert.deepEqual([state.status, state.combine.rounds, state.combine.results, state.combine.running], ['active', 0, [], undefined]);
  assert.equal(state.combine.repos.backend.path, join(dir, 'trees', 'combined', 'backend'));
});

test('a run that always had one track completes at next and refuses combine', async () => {
  const { spike, play } = await tracksRun([issue('CRM-1')], { t1: ['CRM-1'] });
  await play('CRM-1', 't1');
  const refused = await spike(['combine']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /this run has one track: it completes at next, with no combine/);
  const done = await spike(['next']);
  assert.equal(done.code, 0, done.stderr);
  assert.equal(json(done).action, 'complete');
});

test('parseTypecheckErrors reads both tsc formats', () => {
  const text = [
    '$ tc src/a.ts',
    'src/a.ts(12,5): error TS2345: Argument of type \'string\' is not assignable to parameter of type \'number\'.',
    'src/b/c.tsx:3:10 - error TS2304: Cannot find name \'x\'.',
    '',
    '3   x()',
    '    ~',
    'error TS5083: Cannot read file \'tsconfig.json\'.',
    'Found 2 errors.',
    'exit 2',
  ].join('\n');
  assert.deepEqual(parseTypecheckErrors(text), [
    { file: 'src/a.ts', line: 12, message: 'TS2345: Argument of type \'string\' is not assignable to parameter of type \'number\'.' },
    { file: 'src/b/c.tsx', line: 3, message: 'TS2304: Cannot find name \'x\'.' },
  ]);
});
