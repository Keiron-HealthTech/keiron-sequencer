import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../scripts/spike.mjs';
import { patchStats } from '../scripts/lib/patch-stats.mjs';
import { serializeRecord, validateRecord } from '../scripts/lib/record.mjs';
import { readRecords } from '../scripts/lib/records.mjs';
import { buildSpikeRecord, checkNotes, replayedRecord, writeSpikeRecord } from '../scripts/lib/spike/build-record.mjs';
import { runDir } from '../scripts/lib/spike/home.mjs';
import { createRun } from '../scripts/lib/spike/state.mjs';
import { tempDir } from './helpers/git-sandbox.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import { issue, notes, PROJECT_URL, SLUG, spikeFixture, walk } from './helpers/spike-fixture.mjs';

guardNetwork();

const HOME = tempDir('keiron-sequencer-build-home-');
after(() => rmSync(HOME, { recursive: true, force: true }));

const RUN_ID = '20261110T100000Z';
const PATCH = [
  'diff --git a/src/a.js b/src/a.js', '--- a/src/a.js', '+++ b/src/a.js', '@@ -1 +1,3 @@', ' x', '+one', '+two',
  'diff --git a/src/a.test.js b/src/a.test.js', '--- a/src/a.test.js', '+++ b/src/a.test.js', '@@ -1 +1,2 @@', ' t', '+check', '',
].join('\n');
const TOKENS = { input: 10, cacheCreation: 0, cacheRead: 0, output: 10, thinking: 0 };

function doneState({ origin = 'thin-spike', box = null, windows, offProject = [], runId = RUN_ID } = {}) {
  const plan = {
    fetchedAt: '2026-11-10T10:00:00.000Z', order: ['CRM-1'], skipped: [],
    cards: { 'CRM-1': { title: 'Card one', url: 'https://linear.app/x/issue/CRM-1', number: 1, milestoneOrder: null, description: '', origin, pr: null, offProject } },
  };
  const state = createRun({ runId, project: { id: 'p', slug: SLUG, name: 'Project', url: 'u' }, plan, home: HOME, dataDir: '/data', now: new Date('2026-11-10T10:00:00.000Z') });
  state.tracks.t1.repos.backend = { name: 'backend-repo', kind: 'worktree', status: 'open' };
  const name = `backend/00001-${origin === 'existing-pr' ? 'existing' : 'new'}.patch`;
  Object.assign(state.cards['CRM-1'], {
    status: 'done', box, patches: [name], riskAreas: [], newPaths: [],
    windows: windows ?? [{ execution: 1, start: '2026-11-10T10:01:00.000Z', end: '2026-11-10T10:05:00.000Z', messages: 2, tokens: TOKENS, w: 60.4 }],
  });
  const file = join(runDir(HOME, SLUG, runId), 'patches', name);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, PATCH);
  return state;
}

test('a record built from state and notes validates, sizes the patch with patchStats and dates the card at its last window end, in UTC', () => {
  const record = buildSpikeRecord(doneState(), 'CRM-1', notes);
  assert.deepEqual(validateRecord(record), []);
  const stats = patchStats(PATCH);
  assert.deepEqual([record.size.prodLines, record.size.testLines, record.size.files], [stats.prod, stats.test, stats.files.length]);
  assert.equal(record.spikedAt, '2026-11-10T10:05:00.000Z');
  assert.deepEqual(record.refs, { engram: [], patches: ['backend/00001-new.patch'], linear: 'https://linear.app/x/issue/CRM-1', runId: RUN_ID });
});

test('a card patch whose name does not parse back to the card is refused', () => {
  const state = doneState();
  state.cards['CRM-1'].patches = ['backend/00002-new.patch'];
  writeFileSync(join(runDir(HOME, SLUG, RUN_ID), 'patches', 'backend', '00002-new.patch'), PATCH);
  assert.throws(() => buildSpikeRecord(state, 'CRM-1', notes), /backend\/00002-new\.patch is not a card patch of CRM-1/);
});

test('a card with zero cases is refused naming cases', () => {
  assert.throws(() => buildSpikeRecord(doneState(), 'CRM-1', { ...notes, cases: [] }), /\$\.cases/);
});

test('notes holding diff text are refused, naming the field', () => {
  for (const text of ['see diff --git a/x b/x', 'line\n+++ b/src/a.js', 'line\n--- a/src/a.js', 'hunk @@ -1,2 +1,3 @@']) {
    const bad = { ...notes, decisions: [{ text }] };
    assert.match(checkNotes(bad).join(' '), /notes\.decisions\[0\]\.text: holds diff text/, JSON.stringify(text));
    assert.throws(() => buildSpikeRecord(doneState(), 'CRM-1', bad), /diff text/);
  }
  assert.deepEqual(checkNotes(notes), []);
});

test('a diff header at the very start of a notes string is diff text too, while a plus or minus sign in prose is not', () => {
  for (const text of ['+++ b/src/a.js', '--- a/src/a.js']) {
    assert.match(checkNotes({ ...notes, findings: [{ kind: 'risk', text }] }).join(' '), /notes\.findings\[0\]\.text: holds diff text/, text);
  }
  assert.deepEqual(checkNotes({ ...notes, findings: [{ kind: 'risk', text: 'a +++ b/ c and --- a/ d in prose', ref: 'linear:CRM-1' }] }), []);
});

test('notes must list openDecisions and piiInLogs, empty when there are none', () => {
  const { openDecisions, piiInLogs, ...rest } = notes;
  assert.deepEqual(checkNotes(rest), [
    'notes.openDecisions: expected an array (use [] when there are none)',
    'notes.piiInLogs: expected an array of <repoDir>/<path> (use [] when there are none)',
  ]);
  assert.deepEqual(checkNotes({ ...notes, piiInLogs: [''] }), ['notes.piiInLogs[0]: expected a non-empty <repoDir>/<path>']);
  assert.deepEqual([openDecisions, piiInLogs], [[], []]);
});

test('an existing-PR record has effort null and no timeBox even with measured windows, and still points at its run', () => {
  const record = buildSpikeRecord(doneState({ origin: 'existing-pr', box: 100 }), 'CRM-1', notes);
  assert.deepEqual(validateRecord(record), []);
  assert.equal(record.origin, 'existing-pr');
  assert.equal(record.effort, null);
  assert.equal('timeBox' in record, false);
  assert.equal(record.refs.runId, RUN_ID);
});

test('a thin spike carries a timeBox only when its card has a stored box', () => {
  assert.equal('timeBox' in buildSpikeRecord(doneState(), 'CRM-1', notes), false);
  const windows = [
    { execution: 1, start: '2026-11-10T10:01:00.000Z', end: '2026-11-10T10:05:00.000Z', messages: 1, tokens: TOKENS, w: 60.4 },
    { execution: 2, start: '2026-11-10T11:01:00.000Z', end: '2026-11-10T11:05:00.000Z', messages: 1, tokens: TOKENS, w: 80 },
  ];
  const over = buildSpikeRecord(doneState({ box: 100, windows }), 'CRM-1', notes);
  assert.deepEqual(over.timeBox, { budget: 100, spent: 140, over: true });
  assert.deepEqual(validateRecord(over), []);
  assert.deepEqual(buildSpikeRecord(doneState({ box: 200, windows }), 'CRM-1', notes).timeBox, { budget: 200, spent: 140, over: false });
  assert.equal(over.scope.complete, true);
});

test('an off-project blocker becomes a risk finding', () => {
  const record = buildSpikeRecord(doneState({ offProject: ['CRM-900'] }), 'CRM-1', notes);
  assert.deepEqual(record.findings, [{ kind: 'risk', text: 'Blocked by off-project card CRM-900, still open.', ref: 'linear:CRM-900' }]);
});

test('a re-spike from another run moves the old record to spike/history; the same run overwrites in place', () => {
  const dataDir = tempDir('keiron-sequencer-build-data-');
  after(() => rmSync(dataDir, { recursive: true, force: true }));
  const first = buildSpikeRecord(doneState(), 'CRM-1', notes);
  writeSpikeRecord(dataDir, SLUG, first);
  assert.deepEqual(walk(dataDir), [`${SLUG}/CRM-1.json`]);

  writeSpikeRecord(dataDir, SLUG, { ...first, title: 'Card one, again' });
  assert.deepEqual(walk(dataDir), [`${SLUG}/CRM-1.json`]);

  const later = buildSpikeRecord(doneState({ runId: '20261111T090000Z', windows: [
    { execution: 1, start: '2026-11-11T09:01:00.000Z', end: '2026-11-11T09:05:00.000Z', messages: 1, tokens: TOKENS, w: 1 },
  ] }), 'CRM-1', notes);
  writeSpikeRecord(dataDir, SLUG, later);
  assert.deepEqual(walk(dataDir), [`${SLUG}/CRM-1.json`, `${SLUG}/spike/history/CRM-1/2026-11-10T10-05-00.000Z.json`]);
  assert.equal(readFileSync(join(dataDir, SLUG, 'spike', 'history', 'CRM-1', '2026-11-10T10-05-00.000Z.json'), 'utf8'), serializeRecord({ ...first, title: 'Card one, again' }));
  const { records, invalid } = readRecords(join(dataDir, SLUG));
  assert.deepEqual([records.map(r => r.refs.runId), invalid], [['20261111T090000Z'], []]);

  const { refs: { runId, ...refs }, effort, ...rest } = first;
  writeFileSync(join(dataDir, SLUG, 'CRM-2.json'), serializeRecord({ ...rest, card: 'CRM-2', effort: null, refs }));
  writeSpikeRecord(dataDir, SLUG, { ...later, card: 'CRM-2' });
  assert.ok(existsSync(join(dataDir, SLUG, 'spike', 'history', 'CRM-2', '2026-11-10T10-05-00.000Z.json')));
  assert.equal(effort.runId, runId);
});

test('end with a bound session on an existing-PR card writes effort null; end warns when the cases are outside 3 to 6', async () => {
  const prs = [{ number: 41, title: '[CRM-1] feature', url: 'https://github.com/acme/backend/pull/41', isDraft: false }];
  const diff = 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n # sandbox\n+from the pr\n';
  const { deps, home, dataDir, sessionFile, at } = spikeFixture({ issues: [issue('CRM-1')], gh: argv => (argv[1] === 'list' ? JSON.stringify(prs) : diff) });
  const { runId } = JSON.parse((await run(['begin', PROJECT_URL, '--session-file', sessionFile], deps)).stdout);
  const dir = join(home, SLUG, 'runs', runId);
  at('2026-11-10T10:01:00.000Z');
  await run(['next'], deps);
  await run(['tree', 'backend'], deps);
  mkdirSync(join(dir, 'notes'), { recursive: true });
  writeFileSync(join(dir, 'notes', 'CRM-1.json'), JSON.stringify({ ...notes, cases: notes.cases.slice(0, 1) }));
  at('2026-11-10T10:05:00.000Z');
  const r = await run(['end', 'CRM-1'], deps);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).warnings, ['1 case(s) written; 3 to 6 are expected']);
  const record = JSON.parse(readFileSync(join(dataDir, SLUG, 'CRM-1.json'), 'utf8'));
  assert.deepEqual([record.origin, record.effort, 'timeBox' in record, record.refs.runId], ['existing-pr', null, false, runId]);
  assert.deepEqual(record.refs.patches, ['backend/00001-existing.patch']);
});

test('end refuses notes holding diff text and writes nothing', async () => {
  const { deps, home, dataDir, at } = spikeFixture();
  const { runId } = JSON.parse((await run(['begin', PROJECT_URL], deps)).stdout);
  const dir = join(home, SLUG, 'runs', runId);
  at('2026-11-10T10:01:00.000Z');
  await run(['next'], deps);
  const tree = JSON.parse((await run(['tree', 'backend'], deps)).stdout).path;
  writeFileSync(join(tree, 'README.md'), 'changed\n');
  mkdirSync(join(dir, 'notes'), { recursive: true });
  writeFileSync(join(dir, 'notes', 'CRM-1.json'), JSON.stringify({ ...notes, findings: [{ kind: 'risk', text: 'see\n--- a/README.md' }] }));
  const before = readFileSync(join(dir, 'run.json'), 'utf8');
  at('2026-11-10T10:05:00.000Z');
  const r = await run(['end', 'CRM-1'], deps);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /notes\.findings\[0\]\.text: holds diff text/);
  assert.deepEqual([walk(join(dir, 'patches')), walk(dataDir)], [[], []]);
  assert.equal(readFileSync(join(dir, 'run.json'), 'utf8'), before);
});

test('a replayed record takes the recomputed size, risk areas and new paths, keeps the attested pii area and every other field, and validates', () => {
  const old = {
    ...JSON.parse(serializeRecord(buildSpikeRecord(doneState(), 'CRM-1', notes))),
    riskAreas: [{ kind: 'auth', paths: ['backend/old.js'] }, { kind: 'pii-in-logs', paths: ['backend/src/log.js'] }],
  };
  const size = { prodLines: 9, testLines: 2, files: 3, repos: ['backend-repo'], sharedWith: [], deletionWeight: 0.25 };
  const derived = [{ riskAreas: [{ kind: 'auth', paths: ['backend/src/auth/a.js'] }], newPaths: ['backend/tools/'] }, { riskAreas: [], newPaths: [] }];
  const next = replayedRecord(old, {
    size, derived, patches: ['backend/00001-new.patch'], replayed: { at: '2026-11-12T10:00:00.000Z', runId: '20261112T100000Z', fromRunId: RUN_ID, folded: ['backend/00001-new.patch'] },
  });
  assert.deepEqual(validateRecord(next), []);
  assert.deepEqual(next.size, size);
  assert.deepEqual(next.riskAreas, [{ kind: 'auth', paths: ['backend/src/auth/a.js'] }, { kind: 'pii-in-logs', paths: ['backend/src/log.js'] }]);
  assert.deepEqual(next.novelty, { newPaths: ['backend/tools/'] });
  assert.deepEqual(next.refs, { ...old.refs, patches: ['backend/00001-new.patch'], runId: '20261112T100000Z' });
  for (const key of ['findings', 'cases', 'decisions', 'openDecisions', 'fixups', 'scope', 'spikedAt', 'effort', 'timeBox', 'origin', 'title']) {
    assert.equal(JSON.stringify(next[key]), JSON.stringify(old[key]), key);
  }
});

test('a replayed trial record with no risk areas or novelty gains them', () => {
  const { riskAreas: _, novelty: __, ...trial } = JSON.parse(serializeRecord(buildSpikeRecord(doneState(), 'CRM-1', notes)));
  const next = replayedRecord(trial, {
    size: trial.size, derived: [{ riskAreas: [], newPaths: [] }], patches: ['backend/00001-new.patch'],
    replayed: { at: '2026-11-12T10:00:00.000Z', runId: '20261112T100000Z', fromRunId: null, folded: ['backend/00001-new.patch'] },
  });
  assert.deepEqual([next.riskAreas, next.novelty], [[], { newPaths: [] }]);
});

test('new notes without impact are refused with notes.openDecisions[i].impact', () => {
  const open = [{ text: 'a', impact: 'design', owner: 'people' }, { text: 'b', owner: 'code' }];
  assert.ok(checkNotes({ ...notes, openDecisions: open }).includes('notes.openDecisions[1].impact: required (design or detail)'), checkNotes({ ...notes, openDecisions: open }).join('; '));
  assert.deepEqual(checkNotes({ ...notes, openDecisions: [open[0]] }), []);
});
