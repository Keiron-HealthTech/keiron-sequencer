import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../scripts/spike.mjs';
import { parsePatchName } from '../scripts/backfill/patch-map.mjs';
import { validateRecord } from '../scripts/lib/record.mjs';
import { fixupPatchName } from '../scripts/lib/spike/snapshot.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import { issue, notes, PROJECT_URL, SLUG, spikeFixture, walk } from './helpers/spike-fixture.mjs';
import * as R from './helpers/respike-fixture.mjs';

guardNetwork();

const NOTE = 'Rewords the README line the first card added.';
const touched = patch => [...patch.matchAll(/^diff --git a\/(\S+) /gm)].map(m => m[1]);

test('fixup patches are named by the fixed card numbers, sorted, then the causing card and a slug, and parse back', () => {
  assert.equal(fixupPatchName(['CRM-2', 'CRM-1'], 'CRM-3', 'readme-wording'), 'fixup-1-2-from-3-readme-wording.patch');
  assert.deepEqual(parsePatchName('backend/fixup-1-2-from-3-readme-wording.patch'), { kind: 'fixup', fixed: ['CRM-1', 'CRM-2'], from: 'CRM-3' });
});

// CRM-1 and CRM-2 are done; CRM-3 is in progress with one edit that belongs to CRM-1 and one of its own.
async function thirdCardInProgress() {
  const fixture = spikeFixture({ issues: [issue('CRM-1'), issue('CRM-2'), issue('CRM-3')] });
  const { deps, home, at } = fixture;
  const { runId } = JSON.parse((await run(['begin', PROJECT_URL], deps)).stdout);
  const dir = join(home, SLUG, 'runs', runId);
  mkdirSync(join(dir, 'notes'), { recursive: true });
  for (const k of ['CRM-1', 'CRM-2', 'CRM-3']) writeFileSync(join(dir, 'notes', `${k}.json`), JSON.stringify(notes));
  let tree;
  const edits = { 'CRM-1': ['README.md', '# sandbox\nfirst card\n'], 'CRM-2': ['src/index.js', 'export const one = 2\n'] };
  for (const [i, card] of ['CRM-1', 'CRM-2'].entries()) {
    at(`2026-11-10T10:0${i * 2 + 1}:00.000Z`);
    await run(['next'], deps);
    tree ??= JSON.parse((await run(['tree', 'backend'], deps)).stdout).path;
    writeFileSync(join(tree, edits[card][0]), edits[card][1]);
    at(`2026-11-10T10:0${i * 2 + 2}:00.000Z`);
    assert.equal((await run(['end', card], deps)).code, 0);
  }
  at('2026-11-10T10:05:00.000Z');
  await run(['next'], deps);
  writeFileSync(join(tree, 'README.md'), '# sandbox\nfirst card, reworded\n');
  writeFileSync(join(tree, 'src', 'feature.js'), 'export const feature = 1\n');
  at('2026-11-10T10:06:00.000Z');
  return { ...fixture, dir, tree };
}

const record = (dataDir, card) => JSON.parse(readFileSync(join(dataDir, SLUG, `${card}.json`), 'utf8'));

test('fixup snapshots only its paths, regenerates the fixed card\'s record with fixups.received, and the card patch keeps the rest', async () => {
  const { deps, dir, dataDir, at } = await thirdCardInProgress();
  const sizeBefore = record(dataDir, 'CRM-1').size;
  const r = await run(['fixup', '--fixes', 'CRM-1', '--slug', 'readme-wording', '--note', NOTE, '--repo', 'backend', '--', 'README.md'], deps);
  assert.equal(r.code, 0, r.stderr);
  const patch = 'backend/fixup-1-from-3-readme-wording.patch';
  assert.deepEqual(JSON.parse(r.stdout), { action: 'fixup', patch, fixed: ['CRM-1'], from: 'CRM-3', records: [join(dataDir, SLUG, 'CRM-1.json')] });
  assert.deepEqual(touched(readFileSync(join(dir, 'patches', patch), 'utf8')), ['README.md']);

  const fixed = record(dataDir, 'CRM-1');
  assert.deepEqual(validateRecord(fixed), []);
  assert.deepEqual(fixed.fixups, { received: [{ from: 'CRM-3', patch, note: NOTE }], caused: [] });
  assert.deepEqual(fixed.size, sizeBefore);

  at('2026-11-10T10:08:00.000Z');
  const ended = await run(['end', 'CRM-3'], deps);
  assert.equal(ended.code, 0, ended.stderr);
  assert.deepEqual(touched(readFileSync(join(dir, 'patches', 'backend', '00003-new.patch'), 'utf8')), ['src/feature.js']);
  const causing = record(dataDir, 'CRM-3');
  assert.deepEqual(validateRecord(causing), []);
  assert.deepEqual(causing.fixups, { received: [], caused: [{ to: 'CRM-1', patch, note: NOTE }] });
  assert.deepEqual([causing.size.prodLines, causing.size.files], [1, 1]);
  assert.deepEqual(causing.refs.patches, ['backend/00003-new.patch']);

  const state = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
  assert.deepEqual(state.fixups.map(f => [f.patch, f.from, f.fixed, f.note]), [[patch, 'CRM-3', ['CRM-1'], NOTE]]);
  assert.deepEqual(state.repos.backend.log.map(e => e.name), ['00001-new', '00002-new', 'fixup-1-from-3-readme-wording', '00003-new']);
});

test('one fixup may fix several done cards: each fixed record gains it', async () => {
  const { deps, dataDir, tree } = await thirdCardInProgress();
  writeFileSync(join(tree, 'src', 'index.js'), 'export const one = 3\n');
  const r = await run(['fixup', '--fixes', 'CRM-2,CRM-1', '--slug', 'shared', '--note', NOTE, '--repo', 'backend', '--', 'README.md', 'src/index.js'], deps);
  assert.equal(r.code, 0, r.stderr);
  const patch = 'backend/fixup-1-2-from-3-shared.patch';
  for (const card of ['CRM-1', 'CRM-2']) assert.deepEqual(record(dataDir, card).fixups.received, [{ from: 'CRM-3', patch, note: NOTE }]);
});

test('a fixup with an empty note, a card that is not done in this run, no change, or no card in progress fails and writes nothing', async () => {
  const { deps, dir, dataDir, at } = await thirdCardInProgress();
  const fixup = (...over) => run(['fixup', '--fixes', 'CRM-1', '--slug', 'x', '--note', NOTE, '--repo', 'backend', ...over, '--', 'README.md'], deps);
  const unchanged = () => ({ state: readFileSync(join(dir, 'run.json'), 'utf8'), patches: walk(join(dir, 'patches')), data: walk(dataDir).map(f => readFileSync(join(dataDir, f), 'utf8')) });
  const before = unchanged();
  const cases = [
    [['--note', ''], 1, /note/],
    [['--note', '   '], 1, /note/],
    [['--fixes', 'CRM-99'], 1, /CRM-99 is not done in this run/],
    [['--fixes', 'CRM-3'], 1, /CRM-3 is the card in progress/],
    [['--slug', 'Not Kebab'], 2, /usage/],
    [['--repo', 'frontend'], 1, /frontend has no open tree/],
  ];
  for (const [over, code, message] of cases) {
    const r = await fixup(...over);
    assert.equal(r.code, code, `${over.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, message);
    assert.deepEqual(unchanged(), before, over.join(' '));
  }
  const nothing = await run(['fixup', '--fixes', 'CRM-1', '--slug', 'x', '--note', NOTE, '--repo', 'backend', '--', 'src/index.js'], deps);
  assert.equal(nothing.code, 1);
  assert.match(nothing.stderr, /no change/);
  assert.equal(readFileSync(join(dir, 'run.json'), 'utf8'), before.state);
  assert.equal((await run(['fixup', '--fixes', 'CRM-1', '--slug', 'x', '--note', NOTE, '--repo', 'backend'], deps)).code, 2);

  at('2026-11-10T10:08:00.000Z');
  assert.equal((await run(['end', 'CRM-3'], deps)).code, 0);
  const idle = await fixup();
  assert.equal(idle.code, 1);
  assert.match(idle.stderr, /no card is in progress/);
});

test('notes given with --notes are kept in the run, so a later fixup can rebuild that card\'s record', async () => {
  const { deps, home, scratch, dataDir, at } = spikeFixture({ issues: [issue('CRM-1'), issue('CRM-2')] });
  const { runId } = JSON.parse((await run(['begin', PROJECT_URL], deps)).stdout);
  const elsewhere = join(scratch, 'crm-1-notes.json');
  writeFileSync(elsewhere, JSON.stringify(notes));
  at('2026-11-10T10:01:00.000Z');
  await run(['next'], deps);
  const tree = JSON.parse((await run(['tree', 'backend'], deps)).stdout).path;
  writeFileSync(join(tree, 'README.md'), 'first\n');
  at('2026-11-10T10:02:00.000Z');
  assert.equal((await run(['end', 'CRM-1', '--notes', elsewhere], deps)).code, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(home, SLUG, 'runs', runId, 'notes', 'CRM-1.json'), 'utf8')), notes);

  at('2026-11-10T10:03:00.000Z');
  await run(['next'], deps);
  writeFileSync(join(tree, 'README.md'), 'first, fixed\n');
  const r = await run(['fixup', '--fixes', 'CRM-1', '--slug', 'wording', '--note', NOTE, '--repo', 'backend', '--', 'README.md'], deps);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(record(dataDir, 'CRM-1').fixups.received.length, 1);
});

test('a fixup patch is scanned for secrets: a hit exits 4 and writes nothing, and --allow records the accepted hit on the fixup', async () => {
  const { deps, dir, tree } = await thirdCardInProgress();
  writeFileSync(join(tree, 'README.md'), `# sandbox\nfirst card, reworded\nkey AKIA${'Q'.repeat(16)}\n`);
  const argv = ['fixup', '--fixes', 'CRM-1', '--slug', 'readme-wording', '--note', NOTE, '--repo', 'backend'];
  const before = readFileSync(join(dir, 'run.json'), 'utf8');
  const refused = await run([...argv, '--', 'README.md'], deps);
  assert.equal(refused.code, 4);
  assert.doesNotMatch(refused.stdout + refused.stderr, /AKIA/);
  assert.equal(readFileSync(join(dir, 'run.json'), 'utf8'), before);
  assert.deepEqual(walk(join(dir, 'patches')).filter(f => f.includes('fixup')), []);

  const r = await run([...argv, '--allow', 'aws-access-key:README.md', '--', 'README.md'], deps);
  assert.equal(r.code, 0, r.stderr);
  const [fixup] = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')).fixups;
  assert.deepEqual(fixup.allowedSecrets.map(a => [a.patch, a.path, a.kind]), [['backend/fixup-1-from-3-readme-wording.patch', 'README.md', 'aws-access-key']]);
});

test('one fixup of a replayed card and a spiked card appends to the first record and rebuilds the second from its notes', async () => {
  const C = 'CRM-5';
  const f = R.respikeFixture({ issues: ([a, b]) => [a, b, R.issue(C)] });
  const pick = [R.PROJECT_URL, '--cards', `${R.B},${C}`];
  const plan = JSON.parse((await f.run('preflight', pick)).stdout);
  f.at('2026-11-10T10:01:00.000Z');
  const { runId } = JSON.parse((await f.run('begin', [...pick, '--approve', plan.approve])).stdout);
  const dir = join(f.home, R.SLUG, 'runs', runId);
  mkdirSync(join(dir, 'notes'), { recursive: true });
  const play = async (card, file, at) => {
    f.at(at);
    assert.equal(JSON.parse((await f.spike(['next'])).stdout).card, card);
    const tree = JSON.parse((await f.spike(['tree', 'backend'])).stdout).path;
    writeFileSync(join(tree, file), `${card}\n`);
    writeFileSync(join(dir, 'notes', `${card}.json`), JSON.stringify(R.notes(card)));
    return tree;
  };
  await play(R.B, 'b.txt', '2026-11-10T10:02:00.000Z');
  f.at('2026-11-10T10:03:00.000Z');
  assert.equal((await f.spike(['end', R.B])).code, 0);
  const tree = await play(C, 'c.txt', '2026-11-10T10:04:00.000Z');
  writeFileSync(join(tree, 'b.txt'), 'b, adapted\n');
  writeFileSync(join(tree, 'src', 'list.js'), readFileSync(join(tree, 'src', 'list.js'), 'utf8').replace('line5 from A', 'line5 from A, adapted'));
  f.at('2026-11-10T10:05:00.000Z');
  const before = JSON.parse(readFileSync(join(f.dataDir, R.SLUG, `${R.A}.json`), 'utf8'));
  const r = await f.spike(['fixup', '--fixes', `${R.A},${R.B}`, '--slug', 'adapt', '--note', NOTE, '--repo', 'backend', '--', 'b.txt', 'src/list.js']);
  assert.equal(r.code, 0, r.stderr);
  const patch = 'backend/fixup-1-2-from-5-adapt.patch';
  const a = JSON.parse(readFileSync(join(f.dataDir, R.SLUG, `${R.A}.json`), 'utf8'));
  const b = JSON.parse(readFileSync(join(f.dataDir, R.SLUG, `${R.B}.json`), 'utf8'));
  assert.deepEqual(a.fixups.received.at(-1), { from: C, patch, note: NOTE });
  assert.deepEqual({ ...a, fixups: null }, { ...before, fixups: null });
  assert.deepEqual(b.fixups.received, [{ from: C, patch, note: NOTE }]);
  assert.deepEqual([validateRecord(a), validateRecord(b)], [[], []]);
});
