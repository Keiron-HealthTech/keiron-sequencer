import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run as respike } from '../scripts/respike.mjs';
import { caseSource, renderNotesBlock, textSource } from '../scripts/lib/harvest.mjs';
import { serializeRecord, validateRecord } from '../scripts/lib/record.mjs';
import { readRecords } from '../scripts/lib/records.mjs';
import { runDir, writeJsonAtomic } from '../scripts/lib/spike/home.mjs';
import { createRun } from '../scripts/lib/spike/state.mjs';
import { fakeGit, fakeGitHub } from './helpers/fake-git.mjs';
import { tempDir } from './helpers/git-sandbox.mjs';
import { guardNetwork } from './helpers/no-network.mjs';

guardNetwork();

// The shape of a built card whose scope moved while its PR was open, with made-up keys and text: BUILT (open PR 77) was
// spiked once. Before this run, its PR check found that only c3, d2 and d3 are built, and the plan handed c1, c2 and d1
// to OWNER_A and c4 to OWNER_B, which this run re-spiked. After the run, the audit checks every card it left alone against
// those fresh records. UNBUILT is open and outside the run, MERGED is merged, LOCAL is built on a branch.
const SLUG = 'a1b2c3d4e5f6';
const RUN = '20261122T100000Z';
const OLD_RUN = '20261106T100000Z';
const KEY = 'lin_api_AUDIT_' + 'k'.repeat(30);
const PROJECT = { id: 'project-audit', slug: SLUG, name: 'Audit project', url: `https://linear.app/x/project/audit-${SLUG}` };
const BUILT = 'CRM-20';
const OWNER_A = 'CRM-30';
const OWNER_B = 'CRM-40';
const UNBUILT = 'CRM-50';
const MERGED = 'CRM-10';
const LOCAL = 'CRM-60';
const PR_URL = 'https://github.com/example-org/example-api/pull/77';

const scratch = prefix => {
  const dir = tempDir(prefix);
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const kase = (id, given, when, then) => ({ id, given, when, then, source: 'patch', ref: 'patch:api/00001-x.patch' });
const decision = text => ({ text, ref: 'patch:api/00001-x.patch' });

function record(card, over = {}) {
  return {
    schemaVersion: 1,
    card,
    title: `Card ${card}`,
    project: { slug: SLUG, name: PROJECT.name },
    origin: 'thin-spike',
    spikedAt: '2026-11-22T10:30:00.000Z',
    scope: { complete: true, note: null },
    size: { prodLines: 10, testLines: 2, files: 2, repos: ['api'], sharedWith: [], deletionWeight: 0.25 },
    effort: null,
    fixups: { received: [], caused: [] },
    cases: [kase('c1', 'a list', 'it is read', 'it holds')],
    decisions: [],
    findings: [],
    openDecisions: [],
    riskAreas: [],
    novelty: { newPaths: [] },
    refs: { engram: [], patches: [], linear: null, runId: RUN },
    ...over,
  };
}

const PR_AT = '2026-11-21T09:00:00.000Z';
const prMark = (verdict, note) => ({ check: 'pr', verdict, note, at: PR_AT });
const PR_CHECK = {
  check: 'pr', at: PR_AT, kind: 'built', against: [{ repoDir: 'api', kind: 'pr', pr: 77, branch: 'feat/crm-20', sha: 'b'.repeat(40) }],
  verdicts: ['c1', 'c2', 'c3', 'c4', 'd1', 'd2', 'd3'].map(id => ({ id, verdict: ['c3', 'd2', 'd3'].includes(id) ? 'holds' : 'not-built' })),
  missing: [],
};
const checkedBefore = r => ({
  ...r,
  cases: r.cases.map(c => ({ ...c, audit: prMark(c.id === 'c3' ? 'holds' : 'not-built', `PR check of ${c.id}.`) })),
  decisions: r.decisions.map((d, i) => ({ ...d, audit: prMark(i === 0 ? 'not-built' : 'holds', `PR check of d${i + 1}.`) })),
  audits: [PR_CHECK],
});

const builtRecord = () => checkedBefore(record(BUILT, {
  spikedAt: '2026-11-06T10:30:00.000Z',
  refs: { engram: [], patches: [], linear: null, runId: OLD_RUN },
  cases: [
    kase('c1', 'a chat note with a picture in a thread', 'a reader opens the picture by its link', 'the picture is sent back'),
    kase('c2', 'a note id from some other thread', 'its picture is opened', 'nothing is found'),
    kase('c3', 'a letter with saved files in a thread', 'a reader asks for one by position', 'that file comes back; a missing position finds nothing'),
    kase('c4', 'a reader locked out of a folder', 'they open a picture or a letter file by its link', 'they are turned away'),
  ],
  decisions: [
    decision('Find a picture by thread and note id, looked up in the thread itself.'),
    decision('Find a letter file by thread, letter and position, since saved files carry no id.'),
    decision('Reuse the thread page checks.'),
  ],
  findings: [{ kind: 'reorder', text: `${BUILT} must land before ${OWNER_B}.`, ref: 'patch:api/00001-x.patch' }],
}));

const ownerA = () => record(OWNER_A, {
  cases: [kase('c1', 'a thread whose notes hold pictures', 'a reader opens one', 'the picture is sent back')],
  decisions: [decision('The thread comes from the server, never from the reader.')],
});

const ownerB = () => record(OWNER_B, {
  cases: [
    kase('c1', 'a reader locked out of a folder', 'they list its files', 'each file shows as hidden'),
    kase('c2', 'the same reader', 'they open a folder file, a picture or a letter file', 'they are turned away'),
  ],
  decisions: [decision(`One lock service guards folder files, pictures and letter files (${BUILT}).`)],
});

const unbuilt = () => record(UNBUILT, {
  spikedAt: '2026-11-06T11:00:00.000Z',
  refs: { engram: [], patches: [], linear: null, runId: OLD_RUN },
  cases: [kase('c1', 'a live folder', 'its owner locks it', 'its files hide')],
  decisions: [decision('Keep the lock on the folder.')],
});

const localRecord = () => record(LOCAL, { spikedAt: '2026-11-06T12:00:00.000Z', refs: { engram: [], patches: [], linear: null, runId: OLD_RUN } });

const DESCRIPTION = 'Abrir archivos de un hilo por su enlace.\n\nIncluye el bloqueo.\n\n+++ Notas del agente\n\n- **c1.** vieja\n\n+++';

function planOf() {
  const card = key => ({ title: `Card ${key}`, url: null, number: Number(key.split('-')[1]), milestoneOrder: null, description: '', origin: 'thin-spike', pr: null, offProject: [], mode: 'spike' });
  const prEntry = { number: 77, url: PR_URL, headRefName: 'feat/crm-20', baseRefName: 'main', isDraft: false };
  return {
    fetchedAt: '2026-11-22T10:00:00.000Z',
    order: [OWNER_A, OWNER_B],
    skipped: [],
    cards: { [OWNER_A]: card(OWNER_A), [OWNER_B]: card(OWNER_B) },
    respike: {
      approve: 'a'.repeat(12),
      previous: { runId: OLD_RUN },
      selection: { mode: 'cards', cards: [{ key: OWNER_A, why: 'picked' }, { key: OWNER_B, why: 'picked' }], dropped: [{ key: BUILT, reason: 'built' }] },
      built: [
        { key: MERGED, kind: 'merged', evidence: 'github', repoDir: 'api', pr: { ...prEntry, number: 70, url: PR_URL.replace('77', '70') }, branch: null, sha: null, needed: false, warning: null },
        { key: BUILT, kind: 'pr', evidence: 'github', repoDir: 'api', pr: prEntry, branch: 'feat/crm-20', sha: 'b'.repeat(40), needed: false, warning: null },
        { key: LOCAL, kind: 'local', evidence: 'branch', repoDir: 'api', pr: null, branch: 'crm-60-wip', sha: 'c'.repeat(40), needed: false, warning: null },
      ],
      ancestors: [],
      bases: {},
      replay: {},
      map: { open: [BUILT, OWNER_A, OWNER_B, UNBUILT, LOCAL, MERGED], completed: ['CRM-5'] },
      handoffs: [['c1', OWNER_A], ['c2', OWNER_A], ['c4', OWNER_B], ['d1', OWNER_A]].map(([id, to]) => ({ from: BUILT, id, to })),
      drops: [],
    },
  };
}

const CONFIG = {
  schemaVersion: 1,
  repos: {
    api: {
      name: 'example-api', github: 'example-org/example-api', checkout: '/nowhere/example-api', url: null, remote: 'origin', defaultBranch: 'main',
      branchNaming: 'verbatim', setup: [['npm', 'ci']], risk: [],
    },
  },
  projects: { [SLUG]: { repos: ['api'] } },
};

function world({ records = [builtRecord(), ownerA(), ownerB(), unbuilt()], plan = planOf() } = {}) {
  const home = scratch('keiron-sequencer-audit-home-');
  const data = scratch('keiron-sequencer-audit-data-');
  writeFileSync(join(home, 'config.json'), JSON.stringify(CONFIG));
  const state = createRun({ runId: RUN, project: PROJECT, plan, home, dataDir: data, now: new Date('2026-11-22T10:00:00.000Z') });
  state.status = 'complete';
  for (const k of state.plan.order) state.cards[k] = { ...state.cards[k], status: 'done' };
  writeJsonAtomic(join(runDir(home, SLUG, RUN), 'run.json'), state);
  mkdirSync(join(data, SLUG), { recursive: true });
  for (const r of records) writeFileSync(join(data, SLUG, `${r.card}.json`), serializeRecord(r));
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push(JSON.parse(init.body));
    const nodes = [BUILT, OWNER_A, OWNER_B, UNBUILT, LOCAL, MERGED].map(k => ({
      id: `uuid-${k}`, identifier: k, title: `Card ${k}`, archivedAt: null, description: k === BUILT ? DESCRIPTION : `Haz ${k}.`,
    }));
    return { ok: true, json: async () => ({ data: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } }) };
  };
  const gh = fakeGitHub(() => undefined);
  const git = fakeGit({});
  const deps = {
    env: { LINEAR_API_KEY: KEY }, keyFile: join(home, 'no-key'), home, dataDir: data, fetchImpl, gh: gh.run, git: git.run,
    now: () => new Date('2026-11-24T09:00:00.000Z'),
  };
  const audit = argv => respike(['audit', PROJECT.url, ...argv], deps);
  const recordOf = card => JSON.parse(readFileSync(join(data, SLUG, `${card}.json`), 'utf8'));
  return { home, data, deps, gh, git, requests, audit, recordOf, auditDir: join(runDir(home, SLUG, RUN), 'audit') };
}

const VERDICTS = {
  schemaVersion: 1,
  runId: RUN,
  cards: {
    [BUILT]: {
      items: {
        c1: { verdict: 'moved', card: OWNER_A, note: `${OWNER_A} c1 opens the same pictures.` },
        c2: { verdict: 'moved', card: OWNER_A, note: `${OWNER_A} owns the picture half.` },
        c3: { verdict: 'holds', note: 'src/letters/files.ts downloads by index.' },
        c4: { verdict: 'moved', card: OWNER_B, note: `${OWNER_B} c2 turns the same reader away.` },
        d1: { verdict: 'moved', card: OWNER_A, note: `${OWNER_A} d1 finds the thread.` },
        d2: { verdict: 'holds', note: 'The PR finds letter files by position.' },
        d3: { verdict: 'holds', note: 'The PR reuses the page checks.' },
      },
      description: { text: 'Abrir archivos de cartas de un hilo por posición.', why: `The picture half moved to ${OWNER_A} and the lock to ${OWNER_B}.` },
    },
    [UNBUILT]: {
      items: {
        c1: { verdict: 'holds', note: 'No fresh card claims it.' },
        d1: { verdict: 'holds', note: 'No fresh card contradicts it.' },
      },
    },
    [LOCAL]: {
      items: { c1: { verdict: 'not-built', note: 'The branch does not build it and no fresh card claims it.' } },
    },
  },
};

function verdictsFile(w, value = VERDICTS) {
  const path = join(scratch('keiron-sequencer-audit-verdicts-'), 'verdicts.json');
  writeFileSync(path, JSON.stringify(value));
  return path;
}

test('the audit gathers the built and unbuilt cards the run did not re-spike, and skips the merged ones and the ones with no record', async () => {
  const w = world({ records: [builtRecord(), ownerA(), ownerB(), unbuilt(), localRecord()] });
  const r = await w.audit([]);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.action, 'audit-gathered');
  assert.equal(out.runId, RUN);
  assert.deepEqual(out.cards.map(c => [c.card, c.kind]), [[BUILT, 'built'], [UNBUILT, 'unbuilt'], [LOCAL, 'built']]);
  assert.deepEqual(out.skipped, [{ card: MERGED, reason: 'merged' }]);
  assert.deepEqual(out.fresh.map(f => f.card), [OWNER_A, OWNER_B]);
  assert.deepEqual(out.fresh[1].items.map(i => i.id), ['c1', 'c2', 'd1']);
  assert.equal(JSON.parse(readFileSync(join(w.auditDir, 'inputs.json'), 'utf8')).runId, RUN);
  assert.equal(r.stdout.includes(KEY), false);
});

test('a built card is gathered with what its PR check found and where the plan handed its gaps, and no diff is read after the run', async () => {
  const w = world({ records: [builtRecord(), ownerA(), ownerB(), unbuilt(), localRecord()] });
  const out = JSON.parse((await w.audit([])).stdout);
  const card = out.cards.find(c => c.card === BUILT);
  assert.equal(card.description, 'Abrir archivos de un hilo por su enlace.\n\nIncluye el bloqueo.');
  assert.deepEqual(card.record, { spikedAt: '2026-11-06T10:30:00.000Z', runId: OLD_RUN });
  assert.deepEqual(card.against, [{ repoDir: 'api', kind: 'pr', pr: { number: 77, url: PR_URL, isDraft: false }, branch: 'feat/crm-20', sha: 'b'.repeat(40) }]);
  assert.deepEqual(card.prCheck, { at: PR_AT, holds: ['c3', 'd2', 'd3'], moved: [], notBuilt: ['c1', 'c2', 'c4', 'd1'], missing: [] });
  assert.deepEqual(card.handed, [{ id: 'c1', to: OWNER_A }, { id: 'c2', to: OWNER_A }, { id: 'c4', to: OWNER_B }, { id: 'd1', to: OWNER_A }]);
  assert.deepEqual(card.dropped, []);
  assert.deepEqual(card.items.map(i => [i.id, i.kind, i.audit.verdict]), [
    ['c1', 'case', 'not-built'], ['c2', 'case', 'not-built'], ['c3', 'case', 'holds'], ['c4', 'case', 'not-built'],
    ['d1', 'decision', 'not-built'], ['d2', 'decision', 'holds'], ['d3', 'decision', 'holds'],
  ]);
  assert.deepEqual(Object.keys(card.items[0]), ['id', 'kind', 'given', 'when', 'then', 'audit']);
  assert.deepEqual(Object.keys(card.items[4]), ['id', 'kind', 'text', 'audit']);
  assert.equal(out.cards.find(c => c.card === LOCAL).prCheck, null);
  assert.deepEqual([w.gh.calls, w.git.calls], [[], []]);
});

test('the fresh items that name an audited card are listed as its mentions', async () => {
  const w = world();
  const out = JSON.parse((await w.audit([])).stdout);
  const card = out.cards.find(c => c.card === BUILT);
  assert.deepEqual(card.mentions, [{ card: OWNER_B, id: 'd1', kind: 'decision', text: ownerB().decisions[0].text }]);
  assert.deepEqual(out.cards.find(c => c.card === UNBUILT).mentions, []);
});

test('a replayed card keeps its old findings, so it is audited; a replay that turned into a spike is fresh', async () => {
  const plan = planOf();
  for (const k of ['CRM-70', 'CRM-80']) {
    plan.order.push(k);
    plan.cards[k] = { ...plan.cards[OWNER_A], title: `Card ${k}`, number: Number(k.split('-')[1]), mode: 'replay' };
    plan.respike.map.open.push(k);
  }
  const replayed = record('CRM-70', { replayed: { at: '2026-11-22T10:20:00.000Z', runId: RUN, fromRunId: OLD_RUN, folded: [] } });
  const w = world({ plan, records: [builtRecord(), ownerA(), ownerB(), unbuilt(), replayed, record('CRM-80')] });
  const out = JSON.parse((await w.audit([])).stdout);
  assert.deepEqual(out.cards.map(c => [c.card, c.kind]), [[BUILT, 'built'], [UNBUILT, 'unbuilt'], ['CRM-70', 'unbuilt']]);
  assert.deepEqual(out.fresh.map(f => f.card), [OWNER_A, OWNER_B, 'CRM-80']);
});

test('the gather needs the Linear key and a respike run', async () => {
  const w = world();
  w.deps.env = {};
  assert.equal((await w.audit([])).code, 3);
  w.deps.env = { LINEAR_API_KEY: KEY };
  const none = await respike(['audit', 'https://linear.app/x/project/other-000000000000'], w.deps);
  assert.equal(none.code, 1);
  assert.match(none.stderr, /no respike run/);
});

test('stored verdicts mark each item in the record, keep every item and the spike time, and add the audit to the history', async () => {
  const w = world({ records: [builtRecord(), ownerA(), ownerB(), unbuilt(), localRecord()] });
  assert.equal((await w.audit([])).code, 0);
  const gathered = w.requests.length;
  const r = await w.audit(['--verdicts', verdictsFile(w)]);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.action, 'audit-stored');
  assert.deepEqual(out.cards.find(c => c.card === BUILT), {
    card: BUILT, holds: ['c3', 'd2', 'd3'], moved: [{ id: 'c1', card: OWNER_A }, { id: 'c2', card: OWNER_A }, { id: 'c4', card: OWNER_B }, { id: 'd1', card: OWNER_A }],
    notBuilt: [], dropped: [],
  });
  const stored = w.recordOf(BUILT);
  assert.deepEqual(validateRecord(stored), []);
  assert.equal(stored.spikedAt, '2026-11-06T10:30:00.000Z');
  assert.deepEqual(stored.cases.map(c => c.id), ['c1', 'c2', 'c3', 'c4']);
  assert.equal(stored.decisions.length, 3);
  assert.deepEqual(stored.cases[0].audit, { check: 'fresh', verdict: 'moved', card: OWNER_A, note: `${OWNER_A} c1 opens the same pictures.`, runId: RUN, at: '2026-11-24T09:00:00.000Z' });
  assert.deepEqual(stored.decisions[1].audit, { check: 'fresh', verdict: 'holds', note: 'The PR finds letter files by position.', runId: RUN, at: '2026-11-24T09:00:00.000Z' });
  assert.deepEqual(stored.audits, [PR_CHECK, {
    check: 'fresh', runId: RUN, at: '2026-11-24T09:00:00.000Z', kind: 'built',
    against: [{ repoDir: 'api', kind: 'pr', pr: 77, branch: 'feat/crm-20', sha: 'b'.repeat(40) }],
    verdicts: [
      { id: 'c1', verdict: 'moved', card: OWNER_A }, { id: 'c2', verdict: 'moved', card: OWNER_A }, { id: 'c3', verdict: 'holds' },
      { id: 'c4', verdict: 'moved', card: OWNER_B }, { id: 'd1', verdict: 'moved', card: OWNER_A }, { id: 'd2', verdict: 'holds' }, { id: 'd3', verdict: 'holds' },
    ],
    description: VERDICTS.cards[BUILT].description,
  }]);
  const spanish = {
    ...Object.fromEntries(stored.cases.map(c => [c.id, { source: caseSource(c), es: `Caso ${c.id}.` }])),
    ...Object.fromEntries(stored.decisions.map((d, i) => [`d${i + 1}`, { source: textSource(d), es: `Decisión d${i + 1}.` }])),
  };
  const block = renderNotesBlock(stored, spanish);
  assert.doesNotMatch(block, new RegExp(`${OWNER_A}|${OWNER_B}`));
  assert.deepEqual([...block.matchAll(/- \*\*([cd]\d)\.\*\*/g)].map(m => m[1]), ['c3', 'd2', 'd3']);
  assert.equal(w.recordOf(LOCAL).cases[0].audit.verdict, 'not-built');
  assert.equal(w.recordOf(UNBUILT).audits[0].kind, 'unbuilt');
  assert.deepEqual(readRecords(join(w.data, SLUG)).invalid, []);
  assert.equal(w.requests.length, gathered, 'storing reads no Linear');
});

test('storing the same run again replaces its audit entry and each item mark', async () => {
  const w = world();
  await w.audit([]);
  const only = { ...VERDICTS, cards: { [BUILT]: VERDICTS.cards[BUILT] } };
  assert.equal((await w.audit(['--verdicts', verdictsFile(w, only)])).code, 0);
  const again = structuredClone(only);
  again.cards[BUILT].items.c3 = { verdict: 'dropped', note: 'Nobody needs it.' };
  assert.equal((await w.audit(['--verdicts', verdictsFile(w, again)])).code, 0);
  const stored = w.recordOf(BUILT);
  assert.deepEqual(stored.audits.map(a => a.check), ['pr', 'fresh']);
  assert.equal(stored.cases[2].audit.verdict, 'dropped');
});

test('verdicts that are incomplete, unknown or inconsistent are refused, and no record changes', async () => {
  const w = world();
  await w.audit([]);
  const before = readFileSync(join(w.data, SLUG, `${BUILT}.json`), 'utf8');
  const variant = edit => {
    const v = structuredClone(VERDICTS);
    delete v.cards[LOCAL];
    edit(v);
    return v;
  };
  const cases = [
    [v => { delete v.cards[BUILT].items.d3; }, new RegExp(`${BUILT}: d3 has no verdict`)],
    [v => { v.cards[BUILT].items.c9 = { verdict: 'holds', note: 'x' }; }, new RegExp(`${BUILT}: c9 is not an item of its record`)],
    [v => { v.cards[BUILT].items.c1 = { verdict: 'moved', note: 'x' }; }, /c1: a moved item names the card that owns it now/],
    [v => { v.cards[BUILT].items.c1 = { verdict: 'moved', card: BUILT, note: 'x' }; }, /c1: moved to itself/],
    [v => { v.cards[BUILT].items.c1 = { verdict: 'moved', card: 'CRM-999', note: 'x' }; }, /c1: CRM-999 is not a card of the project map/],
    [v => { v.cards[BUILT].items.c1 = { verdict: 'gone', note: 'x' }; }, /c1: verdict must be one of holds, moved, not-built, dropped/],
    [v => { v.cards[BUILT].items.c1 = { verdict: 'holds' }; }, /c1: note must be a non-empty string/],
    [v => { v.cards[UNBUILT].items.c1 = { verdict: 'not-built', note: 'x' }; }, new RegExp(`${UNBUILT} c1: not-built is only for a built card`)],
    [v => { v.cards[BUILT].missing = ['x']; }, new RegExp(`${BUILT}: missing scope belongs to the PR check, before the run`)],
    [v => { v.cards[MERGED] = { items: {} }; }, new RegExp(`${MERGED} is not a card this audit gathered`)],
    [v => { v.runId = '20261101T100000Z'; }, /runId 20261101T100000Z is not the run 20261122T100000Z/],
    [v => { v.cards[BUILT].description = { text: 'x\n+++ Notas del agente\n+++' }; }, /description\.why must be a non-empty string/],
  ];
  for (const [edit, message] of cases) {
    const r = await w.audit(['--verdicts', verdictsFile(w, variant(edit))]);
    assert.equal(r.code, 2, `${message}: ${r.stderr}`);
    assert.match(r.stderr, message);
  }
  assert.equal(readFileSync(join(w.data, SLUG, `${BUILT}.json`), 'utf8'), before);
});

// The PR check found c2 is another card's behavior: no fresh record claims it, yet it must not flip back to this card's own.
test('an item the PR check moved stays moved: holds is refused, another owner a fresh record shows is accepted', async () => {
  const moved = builtRecord();
  moved.cases[1].audit = { check: 'pr', verdict: 'moved', card: OWNER_B, note: `${OWNER_B} owns it.`, at: PR_AT };
  moved.audits = [{ ...PR_CHECK, verdicts: PR_CHECK.verdicts.map(v => (v.id === 'c2' ? { id: 'c2', verdict: 'moved', card: OWNER_B } : v)) }];
  const w = world({ records: [moved, ownerA(), ownerB(), unbuilt()] });
  await w.audit([]);
  const v = structuredClone(VERDICTS);
  delete v.cards[LOCAL];
  v.cards[BUILT].items.c2 = { verdict: 'holds', note: 'No fresh card claims it.' };
  const refused = await w.audit(['--verdicts', verdictsFile(w, v)]);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, new RegExp(`${BUILT} c2: the PR check moved it to ${OWNER_B}: keep it moved, to ${OWNER_B} or to the card a fresh record shows owns it now, or drop it`));
  v.cards[BUILT].items.c2 = { verdict: 'moved', card: OWNER_A, note: `${OWNER_A} c1 now owns it.` };
  assert.equal((await w.audit(['--verdicts', verdictsFile(w, v)])).code, 0);
});

test('storing needs the gathered inputs, and a record re-spiked since the gather is refused', async () => {
  const w = world();
  const none = await w.audit(['--verdicts', verdictsFile(w, { ...VERDICTS, cards: { [BUILT]: VERDICTS.cards[BUILT] } })]);
  assert.equal(none.code, 5);
  assert.match(none.stderr, /gather the audit first/);
  await w.audit([]);
  writeFileSync(join(w.data, SLUG, `${BUILT}.json`), serializeRecord({ ...builtRecord(), spikedAt: '2026-11-23T10:00:00.000Z' }));
  const moved = await w.audit(['--verdicts', verdictsFile(w, { ...VERDICTS, cards: { [BUILT]: VERDICTS.cards[BUILT] } })]);
  assert.equal(moved.code, 5);
  assert.match(moved.stderr, new RegExp(`${BUILT}'s record changed since the gather`));
});

test('the report shows the audit beside the comparison: each card\'s PR check, its verdicts against the fresh records and description proposal, and the cards still to judge', async () => {
  const w = world();
  await w.audit([]);
  const before = JSON.parse((await respike(['report', PROJECT.url], w.deps)).stdout);
  assert.deepEqual(before.audit.pending, [BUILT, UNBUILT]);
  assert.deepEqual(before.audit.cards, []);
  const only = { ...VERDICTS, cards: { [BUILT]: VERDICTS.cards[BUILT] } };
  await w.audit(['--verdicts', verdictsFile(w, only)]);
  const r = await respike(['report', PROJECT.url], w.deps);
  assert.equal(r.code, 0, r.stderr);
  const { audit } = JSON.parse(r.stdout);
  assert.equal(audit.gathered, true);
  assert.deepEqual(audit.pending, [UNBUILT]);
  assert.deepEqual(audit.skipped, [{ card: MERGED, reason: 'merged' }, { card: LOCAL, reason: 'no-record' }]);
  assert.deepEqual(audit.cards, [{
    card: BUILT, kind: 'built', against: [{ repoDir: 'api', kind: 'pr', pr: 77, branch: 'feat/crm-20', sha: 'b'.repeat(40) }],
    holds: ['c3', 'd2', 'd3'], moved: [{ id: 'c1', card: OWNER_A }, { id: 'c2', card: OWNER_A }, { id: 'c4', card: OWNER_B }, { id: 'd1', card: OWNER_A }],
    notBuilt: [], dropped: [], description: VERDICTS.cards[BUILT].description,
    prCheck: { at: PR_AT, holds: ['c3', 'd2', 'd3'], moved: [], notBuilt: ['c1', 'c2', 'c4', 'd1'], missing: [] },
  }]);
});

test('a report with no audit gathered says so', async () => {
  const w = world();
  const { audit } = JSON.parse((await respike(['report', PROJECT.url], w.deps)).stdout);
  assert.deepEqual(audit, { gathered: false, cards: [], pending: [], skipped: [] });
  assert.equal(existsSync(w.auditDir), false);
});
