import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run as respike } from '../scripts/respike.mjs';
import { buildReport, previousRecords } from '../scripts/lib/respike/report.mjs';
import { serializeRecord } from '../scripts/lib/record.mjs';
import { readRecords } from '../scripts/lib/records.mjs';
import { runDir, writeJsonAtomic } from '../scripts/lib/spike/home.mjs';
import { createRun } from '../scripts/lib/spike/state.mjs';
import { tempDir } from './helpers/git-sandbox.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import { B, notes, PROJECT_URL, SENTINEL, SLUG as FIXTURE_SLUG, respikeFixture, walk } from './helpers/respike-fixture.mjs';

guardNetwork();

const SLUG = 'abcdef123456';
const RUN = '20261110T100000Z';
const OLD = '20261101T100000Z';

const scratch = prefix => {
  const dir = tempDir(prefix);
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const kase = (id, given, over = {}) => ({ id, given, when: 'it is read', then: 'it holds', source: 'linear', ref: 'linear:CRM-1', ...over });

function record(card, over = {}) {
  return {
    schemaVersion: 1,
    card,
    title: `Card ${card}`,
    project: { slug: SLUG, name: 'Report project' },
    origin: 'thin-spike',
    spikedAt: '2026-11-10T10:30:00.000Z',
    scope: { complete: true, note: null },
    size: { prodLines: 10, testLines: 2, files: 2, repos: ['api'], sharedWith: [], deletionWeight: 0.25 },
    effort: null,
    fixups: { received: [], caused: [] },
    cases: [kase('c1', 'a list')],
    decisions: [],
    findings: [],
    openDecisions: [],
    riskAreas: [],
    novelty: { newPaths: [] },
    refs: { engram: [], patches: [`api/0000${card.split('-')[1]}-new.patch`], linear: null, runId: RUN },
    ...over,
  };
}

// A respike run state with the given entries: [key, mode, cardState?].
function runState(entries, { status = 'complete', respike = {} } = {}) {
  const order = entries.map(([k]) => k);
  return {
    runId: RUN,
    status,
    project: { slug: SLUG, name: 'Report project' },
    plan: {
      order,
      cards: Object.fromEntries(entries.map(([k, mode]) => [k, { mode }])),
      respike: {
        selection: { mode: 'cards', cards: [], dropped: [] }, built: [], bases: {}, replay: {}, ancestors: [],
        map: { open: order, completed: [] }, ...respike,
      },
    },
    cards: Object.fromEntries(entries.map(([k, , c]) => [k, { status: 'done', ...c }])),
  };
}

const sized = (card, lines) => record(card, { size: { prodLines: lines, testLines: 0, files: 1, repos: ['api'], sharedWith: [], deletionWeight: 0.25 } });

test('the previous record is the newest history entry written by another run; a card with no history has none', () => {
  const data = scratch('keiron-sequencer-report-data-');
  const history = card => join(data, SLUG, 'spike', 'history', card);
  const put = (card, name, r) => {
    mkdirSync(history(card), { recursive: true });
    writeFileSync(join(history(card), name), serializeRecord(r));
  };
  put('CRM-1', '2026-10-01T10-00-00.000Z.json', record('CRM-1', { spikedAt: '2026-10-01T10:00:00.000Z', refs: { engram: [], patches: [], linear: null } }));
  put('CRM-1', '2026-11-01T10-00-00.000Z.json', record('CRM-1', { spikedAt: '2026-11-01T10:00:00.000Z', refs: { engram: [], patches: [], linear: null, runId: OLD } }));
  put('CRM-1', '2026-11-10T10-10-00.000Z.json', record('CRM-1', { spikedAt: '2026-11-10T10:10:00.000Z' }));
  const state = runState([['CRM-1', 'spike'], ['CRM-2', 'spike']]);
  const previous = previousRecords(data, state);
  assert.equal(previous.get('CRM-1').spikedAt, '2026-11-01T10:00:00.000Z');
  assert.equal(previous.has('CRM-2'), false);
});

test('cases match by their given, when and then; decisions, findings and open decisions by normalized text', () => {
  const before = record('CRM-1', {
    cases: [kase('c1', 'a list'), kase('c2', 'an empty list'), kase('c3', 'a long list')],
    decisions: ['Keep  the list in ONE file.', 'Sort by date', 'Caf\u00e9 names stay'].map(text => ({ text, ref: 'linear:CRM-1' })),
    findings: [{ kind: 'risk', text: 'Order matters.', ref: 'linear:CRM-1' }, { kind: 'split', text: 'Two screens', ref: 'linear:CRM-1' }],
    openDecisions: [{ text: 'Which locale?' }],
  });
  const now = record('CRM-1', {
    cases: [kase('c7', 'a list'), kase('c2', 'an empty list', { then: 'it is empty' }), kase('c3', 'a long list')],
    decisions: ['keep the list in one file', 'Cafe\u0301 names stay', 'Group by month'].map(text => ({ text, ref: 'linear:CRM-1' })),
    findings: [{ kind: 'reorder', text: 'order matters', ref: 'linear:CRM-1' }, { kind: 'split', text: 'two screens.', ref: 'linear:CRM-1' }],
    openDecisions: [{ text: 'Which locale? ' }, { text: 'Caf\u00e9 names?' }],
  });
  const report = buildReport({ state: runState([['CRM-1', 'spike']]), records: [now], previous: new Map([['CRM-1', before]]) });
  const [card] = report.cards;
  assert.equal(card.cases.kept, 2);
  assert.deepEqual(card.cases.added.map(c => [c.id, c.then]), [['c2', 'it is empty']]);
  assert.deepEqual(card.cases.gone.map(c => [c.id, c.then]), [['c2', 'it holds']]);
  assert.match(card.cases.added[0].source, /^[0-9a-f]{12}$/);
  assert.deepEqual(Object.keys(card.cases.added[0]), ['id', 'source', 'given', 'when', 'then']);
  assert.deepEqual(card.decisions, { added: ['Group by month'], gone: ['Sort by date'], kept: 2 });
  assert.deepEqual(card.findings, { added: [{ kind: 'reorder', text: 'order matters' }], gone: [{ kind: 'risk', text: 'Order matters.' }], kept: 1 });
  assert.deepEqual(card.openDecisions, { added: ['Caf\u00e9 names?'], gone: [], kept: 1 });
});

test('fixups match by counterpart card, risk areas by kind with paths per kind, new paths by string; size, origin and scope moves are listed', () => {
  const before = record('CRM-1', {
    origin: 'existing-pr',
    scope: { complete: false, note: 'half' },
    fixups: { received: [{ from: 'CRM-3', patch: 'api/fixup-1-from-3-x.patch', note: null }], caused: [{ to: 'CRM-4', patch: 'api/fixup-4-from-1-y.patch', note: null }] },
    riskAreas: [{ kind: 'auth', paths: ['src/auth/a.js', 'src/auth/b.js'] }, { kind: 'pii-in-logs', paths: ['src/log.js'] }],
    novelty: { newPaths: ['src/a.js', 'src/b.js'] },
  });
  const now = record('CRM-1', {
    size: { prodLines: 20, testLines: 4, files: 3, repos: ['api', 'web'], sharedWith: [], deletionWeight: 0.25 },
    fixups: { received: [{ from: 'CRM-3', patch: 'api/fixup-1-from-3-other.patch', note: null }, { from: 'CRM-5', patch: 'api/fixup-1-from-5-z.patch', note: null }], caused: [] },
    riskAreas: [{ kind: 'auth', paths: ['src/auth/b.js', 'src/auth/c.js'] }, { kind: 'payments', paths: ['src/pay.js'] }],
    novelty: { newPaths: ['src/b.js', 'src/c.js'] },
  });
  const [card] = buildReport({ state: runState([['CRM-1', 'spike']]), records: [now], previous: new Map([['CRM-1', before]]) }).cards;
  assert.deepEqual(card.origin, { old: 'existing-pr', new: 'thin-spike' });
  assert.deepEqual(card.scopeComplete, { old: false, new: true });
  assert.deepEqual(card.size.old, { prodLines: 10, testLines: 2, files: 2, repos: ['api'] });
  assert.deepEqual(card.size.new, { prodLines: 20, testLines: 4, files: 3, repos: ['api', 'web'] });
  assert.deepEqual(card.fixups, { received: { added: ['CRM-5'], gone: [] }, caused: { added: [], gone: ['CRM-4'] } });
  assert.deepEqual(card.riskAreas, {
    added: ['payments'],
    gone: ['pii-in-logs'],
    paths: {
      auth: { added: ['src/auth/c.js'], gone: ['src/auth/a.js'] },
      payments: { added: ['src/pay.js'], gone: [] },
      'pii-in-logs': { added: [], gone: ['src/log.js'] },
    },
  });
  assert.deepEqual(card.newPaths, { added: ['src/c.js'], gone: ['src/a.js'] });
  assert.deepEqual(Object.keys(card), ['card', 'previous', 'origin', 'size', 'verdict', 'scopeComplete', 'fixups', 'cases', 'decisions', 'findings', 'openDecisions', 'riskAreas', 'newPaths']);
});

test('tier and verdict are read over the live records on the map, the previous record swapped in for the old side', () => {
  const others = [sized('CRM-2', 1), sized('CRM-3', 2), sized('CRM-4', 3)];
  const offMap = sized('CRM-9', 200);
  const now = sized('CRM-1', 100);
  const before = sized('CRM-1', 1);
  const state = runState([['CRM-1', 'spike']], { respike: { map: { open: ['CRM-1', 'CRM-2', 'CRM-3'], completed: ['CRM-4'] } } });
  const [card] = buildReport({ state, records: [now, ...others, offMap], previous: new Map([['CRM-1', before]]) }).cards;
  assert.deepEqual(card.size.tier, { old: 'S', new: 'XL' });
  assert.deepEqual(card.verdict, { old: 'No SDD', new: 'SDD' });
});

test('a trial previous record with no risk areas or novelty gives an unknown old verdict, which moves once the new record has them', () => {
  const trial = record('CRM-1', { refs: { engram: [], patches: ['backend/01187-new.patch'], linear: null } });
  delete trial.riskAreas;
  delete trial.novelty;
  const now = record('CRM-1', { riskAreas: [{ kind: 'auth', paths: ['src/auth/a.js'] }] });
  const [card] = buildReport({ state: runState([['CRM-1', 'spike']]), records: [now], previous: new Map([['CRM-1', trial]]) }).cards;
  assert.deepEqual(card.previous, { spikedAt: trial.spikedAt, runId: null });
  assert.deepEqual(card.verdict, { old: 'unknown', new: 'No SDD' });
  assert.deepEqual(card.riskAreas.added, ['auth']);
});

test('a card with no previous record is new: previous null, every old side null and everything it holds listed as added', () => {
  const now = record('CRM-1', { decisions: [{ text: 'Use one file', ref: 'linear:CRM-1' }] });
  const [card] = buildReport({ state: runState([['CRM-1', 'spike']]), records: [now], previous: new Map() }).cards;
  assert.equal(card.previous, null);
  assert.deepEqual([card.origin.old, card.size.old, card.size.tier.old, card.verdict.old, card.scopeComplete.old], [null, null, null, null, null]);
  assert.deepEqual(card.decisions, { added: ['Use one file'], gone: [], kept: 0 });
  assert.equal(card.cases.added.length, 1);
});

test('the cards are listed by card number, and only cards spiked and done in this run', () => {
  const state = runState([['CRM-10', 'spike'], ['CRM-2', 'spike'], ['CRM-3', 'replay', { replay: { status: 'replayed', at: RUN, applied: [], folded: [] } }], ['CRM-4', 'spike', { status: 'pending' }]], { status: 'active' });
  const report = buildReport({ state, records: ['CRM-10', 'CRM-2', 'CRM-3', 'CRM-4'].map(k => record(k)), previous: new Map() });
  assert.deepEqual(report.cards.map(c => c.card), ['CRM-2', 'CRM-10']);
});

const before = (r, over = {}) => ({ size: r.size, riskAreas: r.riskAreas ?? null, newPaths: r.novelty?.newPaths ?? null, ...over });

test('each replayed ancestor lists its size, risk areas, new paths, tier and verdict before and after; a trial ancestor moves off unknown', () => {
  const trialAfter = record('CRM-1', { riskAreas: [{ kind: 'auth', paths: ['src/auth/a.js'] }], novelty: { newPaths: ['src/auth/a.js'] } });
  const emptyOne = record('CRM-2');
  const turned = record('CRM-3');
  const state = runState([
    ['CRM-1', 'replay', { replay: { status: 'replayed', at: RUN, applied: [], folded: [], before: before(trialAfter, { size: { ...trialAfter.size, prodLines: 4 }, riskAreas: null, newPaths: null }) } }],
    ['CRM-2', 'replay', { replay: { status: 'empty', at: RUN, applied: [], folded: [] } }],
    ['CRM-3', 'spike', { replay: { status: 'conflict', at: RUN, applied: [], folded: [], conflict: { repo: 'api', patch: 'api/00003-new.patch', reason: 'conflict', unmerged: ['src/a.js'] } } }],
  ], { respike: { replay: { 'CRM-1': { from: 'trial' }, 'CRM-2': { from: OLD } } } });
  const report = buildReport({ state, records: [trialAfter, emptyOne, turned], previous: new Map() });
  assert.deepEqual(report.replayed.map(r => [r.card, r.status, r.from]), [['CRM-1', 'replayed', 'trial'], ['CRM-2', 'empty', OLD]]);
  const [one, two] = report.replayed;
  assert.deepEqual(Object.keys(one), ['card', 'status', 'from', 'size', 'verdict', 'riskAreas', 'newPaths']);
  assert.deepEqual(one.size.old, { prodLines: 4, testLines: 2, files: 2, repos: ['api'] });
  assert.deepEqual(one.size.new, { prodLines: 10, testLines: 2, files: 2, repos: ['api'] });
  assert.deepEqual(Object.keys(one.size.tier), ['old', 'new']);
  assert.deepEqual(one.verdict, { old: 'unknown', new: 'Light' });
  assert.deepEqual(one.riskAreas, { added: ['auth'], gone: [] });
  assert.deepEqual(one.newPaths, { added: ['src/auth/a.js'], gone: [] });
  assert.deepEqual(two.size.old, two.size.new);
  assert.deepEqual(two.verdict.old, two.verdict.new);
  assert.deepEqual([two.riskAreas, two.newPaths], [{ added: [], gone: [] }, { added: [], gone: [] }]);
});

test('the project lists hold built, selected-but-built, replayed, turned, re-planned, new, unselected, orphaned and pending cards', () => {
  const at = RUN;
  const state = runState([
    ['CRM-1', 'replay', { replay: { status: 'replayed', at, applied: [], folded: [], before: before(record('CRM-1')) } }],
    ['CRM-2', 'replay', { replay: { status: 'empty', at, applied: [], folded: [] } }],
    ['CRM-3', 'spike', { replay: { status: 'conflict', at, applied: [], folded: [], conflict: { repo: 'api', patch: 'api/00003-new.patch', reason: 'no-preimage', unmerged: [] } } }],
    ['CRM-4', 'spike', { replay: { status: 'secret', at, applied: [], folded: [], hits: [{ patch: 'web/00004-new.patch', path: 'src/k.js', line: 3, kind: 'aws-key' }] } }],
    ['CRM-6', 'spike'],
    ['CRM-5', 'spike'],
    ['CRM-7', 'spike'],
    ['CRM-8', 'spike', { status: 'pending' }],
  ], {
    status: 'active',
    respike: {
      selection: { mode: 'cards', cards: [{ key: 'CRM-7', why: 'picked' }, { key: 'CRM-8', why: 'picked' }], dropped: [{ key: 'CRM-20', reason: 'built' }] },
      built: [
        { key: 'CRM-21', kind: 'merged', evidence: 'linear', repoDir: null },
        { key: 'CRM-20', kind: 'pr', evidence: 'github', repoDir: 'api' },
      ],
      ancestors: [
        { key: 'CRM-1', mode: 'replay', reason: null, sharedWith: [] },
        { key: 'CRM-6', mode: 'spike', reason: 'shared-patch', sharedWith: ['CRM-5'] },
        { key: 'CRM-5', mode: 'spike', reason: 'shared-patch', sharedWith: ['CRM-6'] },
        { key: 'CRM-9', mode: 'spike', reason: 'no-record', sharedWith: [] },
      ],
      replay: { 'CRM-1': { from: OLD }, 'CRM-2': { from: 'trial' } },
      replans: [{ cause: 'CRM-3', dropped: [{ card: 'CRM-1', patch: 'api/fixup-1-from-3-x.patch', reason: 'from-absent' }] }],
      map: { open: ['CRM-1', 'CRM-2', 'CRM-3', 'CRM-4', 'CRM-5', 'CRM-6', 'CRM-7', 'CRM-8', 'CRM-20', 'CRM-30'], completed: ['CRM-21', 'CRM-40'] },
    },
  });
  const records = ['CRM-1', 'CRM-2', 'CRM-3', 'CRM-4', 'CRM-5', 'CRM-6', 'CRM-7', 'CRM-30', 'CRM-40', 'CRM-41'].map(k => record(k));
  const previous = new Map(['CRM-3', 'CRM-4', 'CRM-5', 'CRM-6'].map(k => [k, record(k, { spikedAt: '2026-11-01T10:00:00.000Z' })]));
  const report = buildReport({ state, records, previous });
  assert.equal(report.complete, false);
  assert.deepEqual(report.project, {
    slug: SLUG,
    name: 'Report project',
    newCards: ['CRM-7'],
    orphans: [{ card: 'CRM-40', reason: 'completed' }, { card: 'CRM-41', reason: 'off-map' }],
    built: [{ card: 'CRM-20', kind: 'pr', repoDir: 'api' }, { card: 'CRM-21', kind: 'merged', repoDir: null }],
    selectedBuilt: ['CRM-20'],
    replayed: [{ card: 'CRM-1', status: 'replayed', from: OLD }, { card: 'CRM-2', status: 'empty', from: 'trial' }],
    replayToSpike: [
      { card: 'CRM-3', reason: 'no-preimage', repo: 'api', patch: 'api/00003-new.patch', sharedWith: [] },
      { card: 'CRM-4', reason: 'secret', repo: 'web', patch: 'web/00004-new.patch', sharedWith: [] },
      { card: 'CRM-5', reason: 'shared-patch', repo: null, patch: null, sharedWith: ['CRM-6'] },
      { card: 'CRM-6', reason: 'shared-patch', repo: null, patch: null, sharedWith: ['CRM-5'] },
    ],
    replanned: [{ card: 'CRM-1', patch: 'api/fixup-1-from-3-x.patch', reason: 'from-absent', cause: 'CRM-3' }],
    unselected: ['CRM-30'],
    pending: ['CRM-8'],
  });
  assert.equal(JSON.stringify(report).includes('aws-key'), false);
  assert.equal(JSON.stringify(report).includes('src/k.js'), false);
});

test('each repo base is listed with its kind, the cards of a combine and how far it is behind default; a complete run has nothing pending', () => {
  const state = runState([['CRM-1', 'spike']], {
    respike: {
      bases: {
        web: { kind: 'default', ref: 'origin/main', sha: null, card: null, heads: null, tree: null, behind: null, warning: null },
        api: {
          kind: 'combine', ref: null, sha: 'a'.repeat(40), card: null, tree: 'c'.repeat(40), behind: 2, warning: 'base 2 commits behind default',
          heads: [{ card: 'CRM-20', kind: 'pr', ref: 'refs/pull/20/head', sha: 'a'.repeat(40) }, { card: 'CRM-22', kind: 'local', ref: 'work', sha: 'b'.repeat(40) }],
        },
      },
    },
  });
  const report = buildReport({ state, records: [record('CRM-1')], previous: new Map() });
  assert.deepEqual(report.bases, {
    api: { kind: 'combine', heads: ['CRM-20', 'CRM-22'], behind: 2, ownCommits: null, warning: 'base 2 commits behind default' },
    web: { kind: 'default', heads: null, behind: null, ownCommits: null, warning: null },
  });
  assert.deepEqual(Object.keys(report), ['schemaVersion', 'runId', 'project', 'complete', 'cards', 'replayed', 'bases', 'tracks', 'crossings', 'combined']);
  assert.deepEqual(report.project.pending, []);
});

const KEY = 'lin_api_REPORTSENTINEL_' + 'q'.repeat(24);
const PROJECT = { id: 'project-uuid', slug: SLUG, name: 'Report project', url: `https://linear.app/x/project/report-${SLUG}` };

// A home and data dir holding respike runs written by hand, a patch holding the sentinel and no key anywhere.
function onDisk() {
  const home = scratch('keiron-sequencer-report-home-');
  const data = scratch('keiron-sequencer-report-data-');
  const requests = [];
  const deps = {
    env: {}, keyFile: join(home, 'no-key'), home, dataDir: data, now: () => new Date('2026-11-10T12:00:00.000Z'),
    fetchImpl: async url => { requests.push(url); throw new Error(`no request expected: ${KEY}`); },
  };
  const writeRun = (runId, { slug = SLUG, respike: withRespike = true, status = 'complete', done = true } = {}) => {
    const card = key => ({ title: `Card ${key}`, url: null, number: Number(key.split('-')[1]), milestoneOrder: null, description: '', origin: 'thin-spike', pr: null, offProject: [], mode: 'spike' });
    const plan = {
      fetchedAt: '2026-11-10T10:00:00.000Z', order: ['CRM-1', 'CRM-2'], skipped: [], cards: { 'CRM-1': card('CRM-1'), 'CRM-2': card('CRM-2') },
      ...(withRespike ? { respike: { approve: 'a'.repeat(12), previous: { runId: OLD }, selection: { mode: 'all', cards: [], dropped: [] }, built: [], bases: {}, replay: {}, ancestors: [], map: { open: ['CRM-1', 'CRM-2'], completed: [] } } } : {}),
    };
    const state = createRun({ runId, project: { ...PROJECT, slug }, plan, home, dataDir: data, now: new Date('2026-11-10T10:00:00.000Z') });
    state.status = status;
    state.cards['CRM-1'] = { ...state.cards['CRM-1'], status: done ? 'done' : 'pending' };
    state.cards['CRM-2'] = { ...state.cards['CRM-2'], status: status === 'complete' ? 'done' : 'pending' };
    writeJsonAtomic(join(runDir(home, slug, runId), 'run.json'), state);
    mkdirSync(join(runDir(home, slug, runId), 'patches', 'api'), { recursive: true });
    writeFileSync(join(runDir(home, slug, runId), 'patches', 'api', '00001-new.patch'), `diff --git a/x b/x\n+${KEY}\n`);
  };
  const putRecord = r => {
    mkdirSync(join(data, SLUG), { recursive: true });
    writeFileSync(join(data, SLUG, `${r.card}.json`), serializeRecord(r));
  };
  const report = argv => respike(['report', PROJECT.url, ...argv], deps);
  return { home, data, deps, requests, writeRun, putRecord, report };
}

test('report prints the report and saves the same JSON under the data dir, byte-identically on a second run, needing no key and no request', async () => {
  const d = onDisk();
  d.writeRun(RUN);
  d.putRecord(record('CRM-1'));
  d.putRecord(record('CRM-2'));
  const first = await d.report([]);
  assert.equal(first.code, 0, first.stderr);
  const { action, path, ...value } = JSON.parse(first.stdout);
  assert.equal(action, 'report');
  assert.equal(path, join(d.data, SLUG, 'spike', `respike-${RUN}.json`));
  const file = join(d.data, SLUG, 'spike', `respike-${RUN}.json`);
  const saved = readFileSync(file, 'utf8');
  assert.equal(saved, `${JSON.stringify(value, null, 2)}\n`);
  d.deps.now = () => new Date('2026-11-11T12:00:00.000Z');
  assert.equal((await d.report([])).code, 0);
  assert.equal(readFileSync(file, 'utf8'), saved);
  assert.deepEqual(readRecords(join(d.data, SLUG)).records.map(r => r.card), ['CRM-1', 'CRM-2']);
  assert.deepEqual(d.requests, []);
  for (const text of [first.stdout, first.stderr, saved]) assert.equal(text.includes(KEY), false);
});

test('report reads the newest respike run of the project, or the run --run names; a plain spike run or another project is never read', async () => {
  const d = onDisk();
  d.writeRun('20261108T100000Z');
  d.writeRun(RUN);
  d.writeRun('20261111T100000Z', { respike: false });
  d.writeRun('20261112T100000Z', { slug: 'ffffffffffff' });
  d.putRecord(record('CRM-1'));
  assert.equal(JSON.parse((await d.report([])).stdout).runId, RUN);
  assert.equal(JSON.parse((await d.report(['--run', '20261108T100000Z'])).stdout).runId, '20261108T100000Z');
  assert.ok(existsSync(join(d.data, SLUG, 'spike', 'respike-20261108T100000Z.json')));
  const missing = await d.report(['--run', '20261111T100000Z']);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /no respike run/);
  assert.equal((await d.report(['--run', 'yesterday'])).code, 2);
});

test('an incomplete run reports the cards done so far, with complete false and the pending cards', async () => {
  const d = onDisk();
  d.writeRun(RUN, { status: 'paused' });
  d.putRecord(record('CRM-1'));
  const r = await d.report([]);
  assert.equal(r.code, 0, r.stderr);
  const value = JSON.parse(r.stdout);
  assert.equal(value.complete, false);
  assert.deepEqual(value.cards.map(c => c.card), ['CRM-1']);
  assert.deepEqual(value.project.pending, ['CRM-2']);
});

test('a record field holding diff text exits 1 and writes no report', async () => {
  const d = onDisk();
  d.writeRun(RUN);
  d.putRecord(record('CRM-1', { decisions: [{ text: 'see diff --git a/src/x.js b/src/x.js', ref: 'linear:CRM-1' }] }));
  const r = await d.report([]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /diff text/);
  assert.equal(existsSync(join(d.data, SLUG, 'spike')), false);
});

test('after a full fixture run the data dir holds only records, history and the report, with no patch, no diff header and no patch text anywhere', async () => {
  const f = respikeFixture();
  const outputs = [];
  const keep = r => { outputs.push(r); return r; };
  const pick = [PROJECT_URL, '--cards', B];
  const plan = JSON.parse(keep(await f.run('preflight', pick)).stdout);
  f.at('2026-11-10T10:01:00.000Z');
  const { runId } = JSON.parse(keep(await f.run('begin', [...pick, '--approve', plan.approve])).stdout);
  f.at('2026-11-10T10:02:00.000Z');
  assert.equal(JSON.parse(keep(await f.spike(['next'])).stdout).card, B);
  const dir = join(f.home, FIXTURE_SLUG, 'runs', runId);
  const tree = JSON.parse(keep(await f.spike(['tree', 'backend'])).stdout).path;
  const patchText = ['only', 'in', 'the', 'patch'].join('-');
  writeFileSync(join(tree, 'b.txt'), `${patchText}\n`);
  mkdirSync(join(dir, 'notes'), { recursive: true });
  writeFileSync(join(dir, 'notes', `${B}.json`), JSON.stringify(notes(B)));
  f.at('2026-11-10T10:05:00.000Z');
  assert.equal(keep(await f.spike(['end', B])).code, 0);
  assert.ok(walk(join(dir, 'patches')).some(p => readFileSync(join(dir, 'patches', p), 'utf8').includes(patchText)));
  f.at('2026-11-10T10:06:00.000Z');
  assert.equal(JSON.parse(keep(await f.spike(['next'])).stdout).action, 'complete');
  const reported = keep(await f.run('report', [PROJECT_URL], { keyFile: join(f.scratch, 'none'), fetchImpl: async () => { throw new Error('no request'); } }));
  assert.equal(reported.code, 0, reported.stderr);

  const files = walk(f.dataDir);
  assert.deepEqual(files.filter(p => !p.endsWith('.json')), []);
  const kinds = files.map(p => (p.includes('/spike/history/') ? 'history' : p.includes('/spike/respike-') ? 'report' : p.split('/').length === 2 ? 'record' : p));
  assert.deepEqual([...new Set(kinds)].sort(), ['history', 'record', 'report']);
  for (const p of files) {
    const text = readFileSync(join(f.dataDir, p), 'utf8');
    assert.doesNotMatch(text, /diff --git|^\+\+\+ b\/|^--- a\/|@@ -/m, p);
  }
  for (const text of [...outputs.flatMap(r => [r.stdout, r.stderr]), ...files.map(p => readFileSync(join(f.dataDir, p), 'utf8'))]) assert.equal(text.includes(SENTINEL), false);
  for (const p of files) assert.equal(readFileSync(join(f.dataDir, p), 'utf8').includes(patchText), false, p);
  assert.equal(reported.stdout.includes(patchText), false);
});

test('report counts outcomes instead of text matches when priorFindings exist', () => {
  const before = record('CRM-1', {
    findings: [{ kind: 'risk', text: 'Order matters.', ref: 'linear:CRM-1' }, { kind: 'split', text: 'Two screens', ref: 'linear:CRM-1' }, { kind: 'reorder', text: 'After 3', ref: 'linear:CRM-1' }],
  });
  const now = record('CRM-1', {
    findings: [{ kind: 'risk', text: 'The cache needs a key.', ref: 'linear:CRM-1' }],
    priorFindings: [
      { text: 'Order matters.', outcome: 'holds', ref: 'linear:CRM-1' },
      { text: 'Two screens', outcome: 'resolved', ref: 'linear:CRM-1' },
      { text: 'After 3', outcome: 'wrong', ref: 'linear:CRM-1' },
    ],
  });
  const [card] = buildReport({ state: runState([['CRM-1', 'spike']]), records: [now], previous: new Map([['CRM-1', before]]) }).cards;
  assert.deepEqual(card.findings.outcomes, { holds: 1, resolved: 1, wrong: 1 });
  assert.deepEqual(card.findings.added, [{ kind: 'risk', text: 'The cache needs a key.' }]);
  assert.deepEqual(card.findings.gone, [{ text: 'After 3', outcome: 'wrong' }, { text: 'Two screens', outcome: 'resolved' }]);
  assert.equal(card.findings.kept, 1);
});

test('replayToSpike lists an ancestor spiked because a blocker was spiked, and a replay turned by its typecheck', () => {
  const typecheck = { status: 'typecheck', at: RUN, applied: [], folded: [], typecheck: { repo: 'api', log: '/x/logs/typecheck-api.log' } };
  const state = runState([['CRM-1', 'spike'], ['CRM-2', 'spike'], ['CRM-3', 'spike', { replay: typecheck }]], {
    respike: { ancestors: [{ key: 'CRM-2', mode: 'spike', reason: 'ancestor-spiked', sharedWith: [], spikedAncestors: ['CRM-1'] }] },
  });
  const { replayToSpike } = buildReport({ state, records: [], previous: new Map() }).project;
  assert.deepEqual(replayToSpike, [
    { card: 'CRM-2', reason: 'ancestor-spiked', repo: null, patch: null, sharedWith: [], spikedAncestors: ['CRM-1'] },
    { card: 'CRM-3', reason: 'typecheck', repo: 'api', patch: null, sharedWith: [] },
  ]);
});

test('the report lists tracks, each crossing with its re-spiked cards, and each combine failure with its fix', () => {
  const state = runState([['CRM-1', 'spike'], ['CRM-2', 'spike'], ['CRM-3', 'spike'], ['CRM-4', 'spike']]);
  state.cards['CRM-2'].mergedFrom = { track: 't2', crossing: 0 };
  state.cards['CRM-3'].respikedBy = { crossing: 0 };
  state.tracks = {
    t1: { cards: ['CRM-1', 'CRM-3', 'CRM-2'], status: 'done', mergedInto: null, current: null, generation: 2, repos: {} },
    t2: { cards: ['CRM-2'], status: 'merged', mergedInto: 't1', current: null, generation: 1, repos: {} },
    t3: { cards: ['CRM-4'], status: 'done', mergedInto: null, current: null, generation: 0, repos: {} },
  };
  state.crossings = [
    { at: '2026-11-10T10:10:00.000Z', kind: 'changes', from: 'CRM-2', to: 'CRM-1', fromTrack: 't2', toTrack: 't1', note: 'CRM-2 renames the helper CRM-1 adds', respiked: ['CRM-3'] },
    { at: '2026-11-10T11:30:00.000Z', kind: 'depends', from: 'CRM-4', to: 'CRM-1', fromTrack: 't3', toTrack: 't1', note: 'CRM-4 reads the column CRM-1 adds', respiked: [], pending: true },
  ];
  const error = (message, cards) => ({ repo: 'api', file: 'src/a.ts', line: 3, message, cards });
  state.combine = {
    rounds: 2,
    results: [
      { at: '2026-11-10T11:00:00.000Z', ok: false, round: 1, errors: [error('TS2304: Cannot find name helper.', ['CRM-1', 'CRM-4'])] },
      { at: '2026-11-10T12:00:00.000Z', ok: false, round: 2, errors: [error('api/00004-new.patch does not apply on the combined tree (conflict)', ['CRM-4'])] },
      { at: '2026-11-10T13:00:00.000Z', ok: true },
    ],
  };
  state.fixups = [
    { patch: 'api/fixup-1-from-3-x.patch', from: 'CRM-3', fixed: ['CRM-1'], note: 'in-track', at: '2026-11-10T10:20:00.000Z' },
    { patch: 'api/fixup-1-4-from-combine-1.patch', from: 'combine', fixed: ['CRM-1', 'CRM-4'], note: 'CRM-4 used the old helper name; import the renamed one', at: '2026-11-10T11:10:00.000Z', round: 1 },
    { patch: 'api/fixup-4-from-combine-2.patch', from: 'combine', fixed: ['CRM-4'], note: 'left behind', at: '2026-11-10T11:20:00.000Z', round: 1, droppedBy: { crossing: 1 } },
  ];
  const report = buildReport({ state, records: [], previous: new Map() });
  assert.deepEqual(report.tracks, [
    { id: 't1', status: 'done', mergedInto: null, cards: ['CRM-1', 'CRM-3', 'CRM-2'] },
    { id: 't2', status: 'merged', mergedInto: 't1', cards: ['CRM-2'] },
    { id: 't3', status: 'done', mergedInto: null, cards: ['CRM-4'] },
  ]);
  assert.deepEqual(report.crossings, [
    {
      crossing: 0, at: '2026-11-10T10:10:00.000Z', kind: 'changes', from: 'CRM-2', to: 'CRM-1', fromTrack: 't2', toTrack: 't1', status: 'applied',
      note: 'CRM-2 renames the helper CRM-1 adds', respiked: ['CRM-3'], replayed: ['CRM-2'], droppedFixups: [],
    },
    {
      crossing: 1, at: '2026-11-10T11:30:00.000Z', kind: 'depends', from: 'CRM-4', to: 'CRM-1', fromTrack: 't3', toTrack: 't1', status: 'pending',
      note: 'CRM-4 reads the column CRM-1 adds', respiked: [], replayed: [], droppedFixups: ['api/fixup-4-from-combine-2.patch'],
    },
  ]);
  assert.deepEqual(report.combined, {
    passed: '2026-11-10T13:00:00.000Z',
    failures: [
      {
        at: '2026-11-10T11:00:00.000Z', round: 1, errors: [error('TS2304: Cannot find name helper.', ['CRM-1', 'CRM-4'])],
        fixups: [
          { patch: 'api/fixup-1-4-from-combine-1.patch', fixed: ['CRM-1', 'CRM-4'], note: 'CRM-4 used the old helper name; import the renamed one', dropped: false },
          { patch: 'api/fixup-4-from-combine-2.patch', fixed: ['CRM-4'], note: 'left behind', dropped: true },
        ],
        crossings: [1],
      },
      { at: '2026-11-10T12:00:00.000Z', round: 2, errors: [error('api/00004-new.patch does not apply on the combined tree (conflict)', ['CRM-4'])], fixups: [], crossings: [] },
    ],
  });
});

test('a run read without tracks reports one track t1, no crossings and no combined check', () => {
  const report = buildReport({ state: runState([['CRM-1', 'spike'], ['CRM-2', 'spike']]), records: [], previous: new Map() });
  assert.deepEqual(report.tracks, [{ id: 't1', status: 'active', mergedInto: null, cards: ['CRM-1', 'CRM-2'] }]);
  assert.deepEqual(report.crossings, []);
  assert.deepEqual(report.combined, { passed: null, failures: [] });
});
