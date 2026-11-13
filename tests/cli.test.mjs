import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../scripts/graph.mjs';
import { serializeRecord } from '../scripts/lib/record.mjs';
import { fakeLinear, fakeLinearStore, FIXTURE_NAME, FIXTURE_SLUG as SLUG, FIXTURE_URL } from './helpers/fake-linear.mjs';

const CLI = fileURLToPath(new URL('../scripts/graph.mjs', import.meta.url));
const KEY = 'lin_api_dummy_' + 'k'.repeat(30);
const NOW = new Date('2026-11-09T10:00:00.000Z');
const TMP = mkdtempSync(join(tmpdir(), 'keiron-sequencer-cli-'));
const NO_FILE = join(TMP, 'absent', 'linear.key');
const EMPTY_DATA = join(TMP, 'empty-data');
mkdirSync(EMPTY_DATA);
after(() => rmSync(TMP, { recursive: true, force: true }));

const deps = (over = {}) => ({ env: { LINEAR_API_KEY: KEY }, keyFile: NO_FILE, now: () => NOW, dataDir: EMPTY_DATA, ...over });

const SUMMARY = { cards: 12, open: 10, free: 3, blocks: 13, critical: 4, implied: 2, cycles: 0 };
const TOP_KEYS = ['cards', 'critical', 'criticalTies', 'cycles', 'danglingBlocks', 'edges', 'fetched', 'free',
  'project', 'records', 'schemaVersion', 'summary', 'warnings'];

test('a clean run prints exactly one JSON document with the schemaVersion 1 contract and nothing on stderr', async () => {
  const { fetchImpl } = fakeLinear();
  const r = await run([FIXTURE_URL], deps({ fetchImpl }));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.ok(r.stdout.endsWith('\n'));
  assert.equal(r.stdout.trim().split('\n').length, 1);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(out).sort(), TOP_KEYS);
  assert.equal(out.schemaVersion, 1);
  assert.equal(out.fetched, NOW.toISOString());
  assert.deepEqual(out.project, { id: 'project-uuid', slug: SLUG, name: FIXTURE_NAME, url: FIXTURE_URL, teams: [] });
  assert.deepEqual(out.summary, SUMMARY);
  assert.deepEqual(out.warnings, []);
  assert.deepEqual(out.free, ['ABC-4', 'ABC-5', 'ABC-9']);
  assert.deepEqual(out.criticalTies, ['ABC-3']);
  assert.deepEqual(out.cycles, []);
});

const RECORDS = fileURLToPath(new URL('./fixtures/records/', import.meta.url));
const SAMPLE = fileURLToPath(new URL('./fixtures/sample-records/c0ffee000001/', import.meta.url));
const BASE = JSON.parse(readFileSync(join(RECORDS, 'ABC-901.json'), 'utf8'));
const SIZED = 'ABC-4';
const recordFor = (card, over = {}) => serializeRecord({ ...BASE, card, cases: [{ ...BASE.cases[0], ref: `linear:${card}` }], ...over });
// The committed records are for cards off this map; only the SIZED record is for a card on it.
const dataDirWith = (name, files = {}) => {
  const dir = join(TMP, name);
  cpSync(RECORDS, join(dir, SLUG), { recursive: true });
  writeFileSync(join(dir, SLUG, `${SIZED}.json`), recordFor(SIZED));
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, SLUG, file), text);
  return dir;
};

test('spike records in <data dir>/<slug>/ give their cards a size label; records for cards off the map are ignored', async () => {
  const { fetchImpl } = fakeLinear();
  const r = await run([FIXTURE_URL], deps({ fetchImpl, dataDir: dataDirWith('records-data') }));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stderr, '');
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.records, { dir: join(TMP, 'records-data', SLUG), count: 1, invalid: 0 });
  const sized = out.cards.filter(c => c.size !== null);
  assert.deepEqual(sized.map(c => c.key), [SIZED]);
  assert.deepEqual(sized[0].size, { tier: 'S', lines: 20, origin: 'thin-spike', label: 'S · 20 lines', verdict: 'unknown' });
});

test('a record with riskAreas, openDecisions and novelty gets a computed verdict in cards[].size; the map is otherwise unchanged', async () => {
  const plain = JSON.parse((await run([FIXTURE_URL], deps({ fetchImpl: fakeLinear().fetchImpl }))).stdout);
  const others = plain.cards.map(c => c.key).filter(k => k !== SIZED).slice(0, 3);
  const newStyle = (card, prodLines) => recordFor(card, {
    size: { ...BASE.size, prodLines }, riskAreas: [], openDecisions: [], novelty: { newPaths: [] },
  });
  const files = Object.fromEntries(others.map((k, i) => [`${k}.json`, newStyle(k, 1000 * (i + 1))]));
  const r = await run([FIXTURE_URL], deps({ fetchImpl: fakeLinear().fetchImpl, dataDir: dataDirWith('verdict-data', files) }));
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  const size = key => out.cards.find(c => c.key === key).size;
  assert.deepEqual([size(others[2]).tier, size(others[2]).verdict], ['XL', 'SDD']);
  assert.deepEqual([size(others[1]).tier, size(others[1]).verdict], ['L', 'Light']);
  assert.deepEqual([size(others[0]).tier, size(others[0]).verdict], ['M', 'No SDD']);
  assert.deepEqual([size(SIZED).tier, size(SIZED).verdict], ['S', 'unknown']);
  assert.deepEqual(out.records, { dir: join(TMP, 'verdict-data', SLUG), count: 4, invalid: 0 });
  assert.equal(out.cards.filter(c => c.size !== null).length, 4);
  assert.equal(out.schemaVersion, 1);
  assert.deepEqual(out.summary, SUMMARY);
  assert.deepEqual([out.critical, out.criticalTies], [plain.critical, plain.criticalTies]);
  const strip = o => ({ ...o, records: null, cards: o.cards.map(({ size: _, ...c }) => c) });
  assert.deepEqual(strip(out), strip(plain));
});

test('with no records folder for the project, records.count is 0, every size is null and nothing is warned', async () => {
  const { fetchImpl } = fakeLinear();
  const r = await run([FIXTURE_URL], deps({ fetchImpl }));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stderr, '');
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.records, { dir: join(EMPTY_DATA, SLUG), count: 0, invalid: 0 });
  assert.deepEqual(out.warnings, []);
  assert.ok(out.cards.every(c => c.size === null));
});

test('an invalid record is a record-invalid warning in the JSON and on stderr; the valid ones are still used and the run exits 0', async () => {
  const { fetchImpl } = fakeLinear();
  const dataDir = dataDirWith('invalid-data', { 'ABC-5.json': '{ not json' });
  const r = await run([FIXTURE_URL], deps({ fetchImpl, dataDir }));
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.records, { dir: join(dataDir, SLUG), count: 1, invalid: 1 });
  assert.equal(out.cards.find(c => c.key === SIZED).size.label, 'S · 20 lines');
  assert.equal(out.cards.find(c => c.key === 'ABC-5').size, null);
  assert.equal(out.warnings.length, 1);
  const [w] = out.warnings;
  assert.deepEqual({ key: w.key, kind: w.kind }, { key: 'ABC-5.json', kind: 'record-invalid' });
  assert.ok(w.message.includes(join(dataDir, SLUG, 'ABC-5.json')), w.message);
  assert.equal(r.stderr, `warning: ${w.message}\n`);
});

test('a folder whose every record is invalid gives count 0 with invalid > 0, so "unreadable" differs from "no record"', async () => {
  const dataDir = join(TMP, 'all-invalid');
  mkdirSync(join(dataDir, SLUG), { recursive: true });
  writeFileSync(join(dataDir, SLUG, `${SIZED}.json`), '{}');
  const { fetchImpl } = fakeLinear();
  const r = await run([FIXTURE_URL], deps({ fetchImpl, dataDir }));
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.records, { dir: join(dataDir, SLUG), count: 0, invalid: 1 });
  assert.deepEqual(out.warnings.map(w => w.kind), ['record-invalid']);
  assert.ok(out.cards.every(c => c.size === null));
});

test('an archived or superseded record is not counted and gives its card no size', async () => {
  for (const [name, over] of [
    ['archived-data', { archived: { at: '2026-11-09', reason: 'archived in Linear' } }],
    ['superseded-data', { supersededBy: { card: SIZED, spikedAt: '2026-11-08T00:00:00.000Z' } }],
  ]) {
    const dataDir = dataDirWith(name, { [`${SIZED}.json`]: recordFor(SIZED, over) });
    const { fetchImpl } = fakeLinear();
    const out = JSON.parse((await run([FIXTURE_URL], deps({ fetchImpl, dataDir }))).stdout);
    assert.deepEqual(out.records, { dir: join(dataDir, SLUG), count: 0, invalid: 0 }, name);
    assert.ok(out.cards.every(c => c.size === null), name);
  }
});

test('the default data folder is the spike home, not the repo or the cwd: the live sample records count 5', () => {
  const home = join(TMP, 'default-home');
  cpSync(SAMPLE, join(home, SLUG), { recursive: true });
  const issues = readdirSync(SAMPLE).map(f => ({
    identifier: f.replace(/\.json$/, ''), title: 'Card', url: 'u', state: { name: 'Backlog', type: 'backlog' },
    projectMilestone: null, labels: { nodes: [] }, relations: { nodes: [] },
  }));
  const script = `
    import { run } from ${JSON.stringify(CLI)};
    import { fakeLinear, FIXTURE_URL } from ${JSON.stringify(fileURLToPath(new URL('./helpers/fake-linear.mjs', import.meta.url)))};
    const { fetchImpl } = fakeLinear({ issues: ${JSON.stringify(issues)} });
    const r = await run([FIXTURE_URL], { env: { ...process.env, LINEAR_API_KEY: ${JSON.stringify(KEY)} }, keyFile: ${JSON.stringify(NO_FILE)}, fetchImpl, repoDataDir: ${JSON.stringify(EMPTY_DATA)} });
    process.stdout.write(r.stdout);
    process.stderr.write(r.stderr);
    process.exitCode = r.code;`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: TMP, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: join(TMP, 'user-home'), KEIRON_SEQUENCER_HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.records, { dir: join(home, SLUG), count: 5, invalid: 0 });
  assert.deepEqual(out.warnings, []);
  const label = key => out.cards.find(c => c.key === key).size?.label ?? null;
  assert.deepEqual(['ABC-1', 'ABC-2', 'ABC-3', 'ABC-4', 'ABC-5', 'ABC-6', 'ABC-7'].map(label),
    ['S · 20 lines', 'M · 60 lines', 'L · 164 lines', 'XL · 400 lines', '90 lines · existing PR', null, null]);
});

test('cards carry free, downstream and offMapBlockers; edges carry via only when implied', async () => {
  const { fetchImpl } = fakeLinear();
  const out = JSON.parse((await run([FIXTURE_URL], deps({ fetchImpl }))).stdout);
  for (const c of out.cards) {
    for (const k of ['key', 'title', 'url', 'status', 'statusType', 'milestone', 'milestoneTag', 'milestoneOrder',
      'estimate', 'size', 'free', 'downstream', 'offMapBlockers']) assert.ok(k in c, `${c.key} lacks ${k}`);
    assert.ok(Array.isArray(c.offMapBlockers));
  }
  for (const e of out.edges) assert.equal('via' in e, e.implied, `${e.from}>${e.to}`);
});

const ORDER_FIELDS = ['dueDate', 'due', 'milestoneTargetDate', 'milestoneOverdue', 'deadline', 'rank'];
const FINISHED = new Set(['completed', 'canceled']);
const datedIssue = (identifier, over = {}) => ({
  id: `id-${identifier}`, identifier, title: `Card ${identifier}`, url: `u/${identifier}`, estimate: null, archivedAt: null,
  state: { name: 'Backlog', type: 'backlog' }, labels: { nodes: [] }, projectMilestone: null, relations: { nodes: [] },
  inverseRelations: { nodes: [] }, ...over,
});
const inMilestone = name => ({ projectMilestone: { name } });

test('each card carries its due date, due bucket, milestone target date, milestone-overdue fact and rank', async () => {
  const { fetchImpl } = fakeLinear();
  const out = JSON.parse((await run([FIXTURE_URL], deps({ fetchImpl }))).stdout);
  for (const c of out.cards) for (const k of ORDER_FIELDS) assert.ok(k in c, `${c.key} lacks ${k}`);
});

test('a later overdue milestone ranks ahead of an earlier on-time one, open ranks run 1..N and finished cards have none', async () => {
  const { fetchImpl } = fakeLinear({
    milestones: [
      { id: 'm1', name: 'First', sortOrder: 1, targetDate: '2026-12-01' },
      { id: 'm2', name: 'Second', sortOrder: 2, targetDate: '2026-11-10' },
    ],
    issues: [
      datedIssue('CRM-10', inMilestone('First')),
      datedIssue('CRM-20', inMilestone('Second')),
      datedIssue('CRM-30', { ...inMilestone('Second'), dueDate: '2026-11-01', state: { name: 'Done', type: 'completed' } }),
    ],
  });
  const r = await run([FIXTURE_URL], deps({ fetchImpl, now: () => new Date('2026-11-13T12:00:00.000Z') }));
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  const byKey = Object.fromEntries(out.cards.map(c => [c.key, c]));
  assert.deepEqual(out.cards.map(c => c.key), ['CRM-10', 'CRM-20', 'CRM-30'], 'the cards keep their order');
  assert.equal(byKey['CRM-20'].rank, 1);
  assert.equal(byKey['CRM-10'].rank, 2);
  assert.equal(byKey['CRM-20'].milestoneOverdue, true);
  assert.equal(byKey['CRM-20'].milestoneTargetDate, '2026-11-10');
  assert.equal(byKey['CRM-30'].rank, null);
  assert.equal(byKey['CRM-30'].due, null);
  assert.equal(byKey['CRM-30'].dueDate, '2026-11-01');
});

test('the date facts use the local calendar date of the injected clock, and fetched stays its UTC timestamp', () => {
  const issues = [datedIssue('CRM-1', { ...inMilestone('Now'), dueDate: '2026-11-12' })];
  const milestones = [{ id: 'm1', name: 'Now', sortOrder: 1, targetDate: '2026-11-12' }];
  const script = `
    import { run } from ${JSON.stringify(CLI)};
    import { fakeLinear, FIXTURE_URL } from ${JSON.stringify(fileURLToPath(new URL('./helpers/fake-linear.mjs', import.meta.url)))};
    const { fetchImpl } = fakeLinear({ issues: ${JSON.stringify(issues)}, milestones: ${JSON.stringify(milestones)} });
    const r = await run([FIXTURE_URL], { env: { LINEAR_API_KEY: ${JSON.stringify(KEY)} }, keyFile: ${JSON.stringify(NO_FILE)},
      dataDir: ${JSON.stringify(EMPTY_DATA)}, fetchImpl, now: () => new Date('2026-11-13T02:30:00.000Z') });
    process.stdout.write(r.stdout);
    process.stderr.write(r.stderr);
    process.exitCode = r.code;`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: TMP, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: join(TMP, 'user-home'), TZ: 'America/Santiago' },
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.fetched, '2026-11-13T02:30:00.000Z');
  assert.equal(out.cards[0].due, 'soon');
  assert.equal(out.cards[0].milestoneOverdue, false);
});

test('a project without dates keeps its graph and ranks open cards by milestone order, critical path, downstream, card number', async () => {
  const { fetchImpl } = fakeLinear();
  const out = JSON.parse((await run([FIXTURE_URL], deps({ fetchImpl }))).stdout);
  assert.deepEqual(out.summary, { cards: 12, open: 10, free: 3, blocks: 13, critical: 4, implied: 2, cycles: 0 });
  assert.deepEqual(out.criticalTies, ['ABC-3']);
  for (const c of out.cards) {
    assert.equal(c.dueDate, null, c.key);
    assert.equal(c.due, null, c.key);
    assert.equal(c.milestoneTargetDate, null, c.key);
    assert.equal(c.milestoneOverdue, false, c.key);
  }
  const finished = out.cards.filter(c => FINISHED.has(c.statusType));
  assert.equal(finished.length, 2);
  for (const c of finished) assert.equal(c.rank, null, c.key);
  const open = out.cards.filter(c => !FINISHED.has(c.statusType)).sort((a, b) => a.rank - b.rank);
  assert.deepEqual(open.map(c => c.rank), Array.from({ length: 10 }, (_, i) => i + 1));
  const onPath = new Set([...out.critical, ...out.criticalTies]);
  const keys = c => [c.milestoneOrder ?? Infinity, onPath.has(c.key) ? 0 : 1, -c.downstream, Number(c.key.match(/\d+$/)[0])];
  for (let i = 1; i < open.length; i++) {
    const [a, b] = [keys(open[i - 1]), keys(open[i])];
    const d = a.findIndex((v, j) => v !== b[j]);
    assert.ok(d >= 0 && a[d] < b[d], `${open[i - 1].key} (rank ${i}) should not rank ahead of ${open[i].key}`);
  }
});

test('danglingBlocks in the JSON come from the analysis', async () => {
  const { fetchImpl } = fakeLinear();
  const out = JSON.parse((await run([FIXTURE_URL], deps({ fetchImpl }))).stdout);
  assert.deepEqual(out.danglingBlocks.map(d => [d.from, d.to, d.reason]), [['ABC-5', 'ABC-20', 'archived'], ['ABC-13', 'ABC-4', 'planner']]);
  for (const d of out.danglingBlocks) {
    assert.deepEqual(Object.keys(d).sort(), ['from', 'offMap', 'open', 'reason', 'to']);
  }
});

test('an open blocker outside the project shows on the card as offMapBlockers', async () => {
  const blocked = {
    id: 'id-1', identifier: 'CRM-1', title: 'Card', url: 'u', estimate: null, archivedAt: null,
    state: { name: 'Backlog', type: 'backlog' }, projectMilestone: null, labels: { nodes: [] },
    relations: { nodes: [] },
    inverseRelations: { nodes: [{ type: 'blocks', issue: { identifier: 'AUTH-7', archivedAt: null, state: { type: 'started' } } }] },
  };
  const { fetchImpl } = fakeLinear({ issues: [blocked], milestones: [] });
  const out = JSON.parse((await run([FIXTURE_URL], deps({ fetchImpl }))).stdout);
  assert.deepEqual(out.cards[0].offMapBlockers, ['AUTH-7']);
  assert.deepEqual(out.danglingBlocks, [{ from: 'AUTH-7', to: 'CRM-1', offMap: 'AUTH-7', reason: 'outside-project', open: true }]);
});

test('importing the CLI module runs nothing', () => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(CLI)})`], {
    encoding: 'utf8', env: { PATH: process.env.PATH, HOME: join(TMP, 'user-home') },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
});

const FILE_KEY = 'lin_api_file_' + 'f'.repeat(30);
const keyFileWith = (name, text) => {
  const path = join(TMP, name);
  writeFileSync(path, text);
  return path;
};

test('the env key wins over the planner key file and is sent raw', async () => {
  const { sent, fetchImpl } = fakeLinear();
  const r = await run([FIXTURE_URL], deps({ fetchImpl, keyFile: keyFileWith('both.key', `${FILE_KEY}\n`) }));
  assert.equal(r.code, 0, r.stderr);
  assert.ok(sent.length > 0);
  for (const s of sent) assert.equal(s.init.headers.authorization, KEY);
});

test('with no env key, the first line of the key file is used', async () => {
  const keyFile = keyFileWith('file.key', `  ${FILE_KEY}  \nsecond line\n`);
  for (const env of [{}, { LINEAR_API_KEY: '   ' }]) {
    const { sent, fetchImpl } = fakeLinear();
    const r = await run([FIXTURE_URL], deps({ fetchImpl, env, keyFile }));
    assert.equal(r.code, 0, r.stderr);
    for (const s of sent) assert.equal(s.init.headers.authorization, FILE_KEY);
  }
});

test('no key anywhere exits 3 before any request and says where to put it', async () => {
  const { sent, fetchImpl } = fakeLinear();
  const r = await run([FIXTURE_URL], deps({ fetchImpl, env: {} }));
  assert.equal(r.code, 3);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /LINEAR_API_KEY/);
  assert.ok(r.stderr.includes(NO_FILE), r.stderr);
  assert.equal(r.stderr.trim().split('\n').length, 1);
  assert.equal(sent.length, 0);
});

test('a placeholder or too-short key exits 3 before any request', async () => {
  for (const key of ['lin_api_...', 'lin_api_short']) {
    const { sent, fetchImpl } = fakeLinear();
    const r = await run([FIXTURE_URL], deps({ fetchImpl, env: { LINEAR_API_KEY: key } }));
    assert.equal(r.code, 3, key);
    assert.equal(r.stdout, '');
    assert.notEqual(r.stderr, '');
    assert.equal(sent.length, 0);
  }
});

const answering = reply => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push(JSON.parse(init.body));
    return reply();
  };
  return { sent, fetchImpl };
};
const ok = data => ({ ok: true, status: 200, statusText: 'OK', json: async () => data });

test('a missing or unparseable project argument exits 2 with usage, before reading a key or Linear', async () => {
  for (const argv of [[], [''], ['not a project'], ['https://linear.app/x/issue/CRM-1/x'], ['CRM-1184']]) {
    const { sent, fetchImpl } = fakeLinear();
    const r = await run(argv, deps({ fetchImpl, env: {} }));
    assert.equal(r.code, 2, JSON.stringify(argv));
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /usage/i);
    assert.equal(sent.length, 0);
  }
});

test('the project may be a URL, a slug, a UUID or an identifier', async () => {
  const uuid = '0b6d6f3c-1234-4abc-9def-0123456789ab';
  for (const [arg, ref] of [[FIXTURE_URL, SLUG], [SLUG, SLUG], [uuid, uuid], ['P-ABC-12', 'P-ABC-12']]) {
    const { sent, fetchImpl } = fakeLinear();
    const r = await run([arg], deps({ fetchImpl }));
    assert.equal(r.code, 0, `${arg}: ${r.stderr}`);
    assert.equal(sent[0].body.variables.ref, ref);
  }
});

test('Linear failures exit 1 with one plain-English line on stderr and nothing on stdout', async () => {
  const cases = [
    [() => ({ ok: false, status: 401, statusText: 'Unauthorized' }), /^Linear HTTP 401 Unauthorized$/],
    [() => ok({ errors: [{ message: 'x' }] }), /^Linear: x$/],
    [() => ok({ errors: [{ message: 'query too\ncomplex' }] }), /^Linear: query too complex$/],
    [() => ok({ data: { project: null } }), new RegExp(`${SLUG}.*URL or slug`)],
    [() => { throw new TypeError('fetch failed'); }, /^Linear request failed: fetch failed$/],
  ];
  for (const [reply, message] of cases) {
    const { fetchImpl } = answering(reply);
    const r = await run([FIXTURE_URL], deps({ fetchImpl }));
    assert.equal(r.code, 1, String(message));
    assert.equal(r.stdout, '');
    assert.ok(r.stderr.endsWith('\n'));
    assert.equal(r.stderr.trimEnd().split('\n').length, 1, r.stderr);
    assert.match(r.stderr.trimEnd(), message);
  }
});

test('a Linear request that times out exits 1 with one plain-English line, the skill\'s DEGRADED path', async () => {
  const { fetchImpl } = answering(() => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); });
  const r = await run([FIXTURE_URL], deps({ fetchImpl }));
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, 'Linear request timed out after 30s\n');
});

test('run as a script, the CLI writes its output and exits with its code', () => {
  const r = spawnSync(process.execPath, [CLI], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: join(TMP, 'user-home') } });
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /usage/i);
});

const SENTINEL = 'lin_api_SENTINEL_Zq7Xw2Pm9Kc4Rt8Ln3Vb6Hy1Jd5Fg0Ts';
const windows = (secret, size = 8) => Array.from({ length: secret.length - size + 1 }, (_, i) => secret.slice(i, i + size));
const assertNoKey = (r, secret = SENTINEL, label = '') => {
  const all = `${r.stdout}\n${r.stderr}`;
  for (const w of windows(secret)) assert.ok(!all.includes(w), `${label}: leaked ${JSON.stringify(w)}`);
};
const card = over => ({
  id: `id-${over.identifier}`, title: 'Card', url: 'u', estimate: null, archivedAt: null,
  state: { name: 'Backlog', type: 'backlog' }, projectMilestone: null, labels: { nodes: [] },
  relations: { nodes: [] }, inverseRelations: { nodes: [] }, ...over,
});

test('the key never reaches stdout or stderr on a successful run', async () => {
  const { fetchImpl } = fakeLinear();
  const r = await run([FIXTURE_URL], deps({ fetchImpl, env: { LINEAR_API_KEY: SENTINEL } }));
  assert.equal(r.code, 0, r.stderr);
  assertNoKey(r, SENTINEL, 'success');
});

test('Linear data that echoes the key is redacted from the JSON, which still parses', async () => {
  const { fetchImpl } = fakeLinear({
    issues: [card({ identifier: 'CRM-1', title: `pasted ${SENTINEL.slice(4, 30)} here` })],
    milestones: [],
    project: { id: 'project-uuid', slugId: SLUG, name: `leak ${SENTINEL}`, url: FIXTURE_URL },
  });
  const r = await run([FIXTURE_URL], deps({ fetchImpl, env: { LINEAR_API_KEY: SENTINEL } }));
  assert.equal(r.code, 0, r.stderr);
  assertNoKey(r, SENTINEL, 'echoed data');
  const out = JSON.parse(r.stdout);
  assert.match(out.project.name, /^leak \[redacted\]$/);
  assert.equal(out.cards.length, 1);
});

test('the key never reaches stdout or stderr when Linear fails, even if Linear echoes it', async () => {
  const echo = `bad key ${SENTINEL}`;
  const cases = [
    () => ({ ok: false, status: 401, statusText: echo }),
    () => ok({ errors: [{ message: echo }] }),
    () => { throw new TypeError(echo); },
  ];
  for (const reply of cases) {
    const { fetchImpl } = answering(reply);
    const r = await run([FIXTURE_URL], deps({ fetchImpl, env: { LINEAR_API_KEY: SENTINEL } }));
    assert.equal(r.code, 1);
    assertNoKey(r, SENTINEL, 'linear failure');
  }
});

test('the key never reaches stderr on a usage error, even when it was passed as the argument', async () => {
  for (const argv of [[], [SENTINEL], [`https://linear.app/x/issue/${SENTINEL}`]]) {
    const { fetchImpl } = fakeLinear();
    const r = await run(argv, deps({ fetchImpl, env: { LINEAR_API_KEY: SENTINEL } }));
    assert.equal(r.code, 2);
    assertNoKey(r, SENTINEL, `usage ${argv.length}`);
  }
});

test('the key never reaches stderr when it is rejected as unusable', async () => {
  const placeholder = `${SENTINEL}...`;
  const short = SENTINEL.slice(0, 15);
  for (const [env, keyFile, secret] of [
    [{ LINEAR_API_KEY: placeholder }, NO_FILE, placeholder],
    [{ LINEAR_API_KEY: short }, NO_FILE, short],
    [{}, keyFileWith('placeholder.key', `${placeholder}\n`), placeholder],
    [{}, keyFileWith('short.key', `${short}\n`), short],
  ]) {
    const { sent, fetchImpl } = fakeLinear();
    const r = await run([FIXTURE_URL], deps({ fetchImpl, env, keyFile }));
    assert.equal(r.code, 3);
    assert.equal(sent.length, 0);
    assertNoKey(r, secret, 'no key');
  }
});

test('a truncation warning lands in the JSON and on stderr, and the run still exits 0', async () => {
  const hundred = Array.from({ length: 100 }, (_, i) => ({
    type: 'related', relatedIssue: { identifier: `CRM-${1000 + i}`, archivedAt: null, state: { type: 'backlog' } },
  }));
  const capped = card({ identifier: 'CRM-1', relations: { nodes: hundred.slice(0, 15) } });
  const { fetchImpl } = fakeLinear({
    issues: [capped], milestones: [],
    full: { 'id-CRM-1': { relations: { nodes: hundred }, inverseRelations: { nodes: [] } } },
  });
  const r = await run([FIXTURE_URL], deps({ fetchImpl }));
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.warnings.length, 1);
  const [w] = out.warnings;
  assert.deepEqual({ key: w.key, kind: w.kind }, { key: 'CRM-1', kind: 'relations-truncated' });
  assert.ok(r.stderr.includes(w.message), r.stderr);
  assert.equal(r.stderr.trimEnd().split('\n').length, 1);
});

test('an error inside the analysis exits 1 with one redacted stderr line, no stack and nothing on stdout', async () => {
  const { fetchImpl } = fakeLinear({ issues: [card({ identifier: 'CRM-1', relations: { nodes: [null] } })], milestones: [] });
  const r = await run([FIXTURE_URL], deps({ fetchImpl, env: { LINEAR_API_KEY: SENTINEL } }));
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '');
  assert.ok(r.stderr.endsWith('\n'));
  assert.equal(r.stderr.trimEnd().split('\n').length, 1, r.stderr);
  assert.doesNotMatch(r.stderr, /\bat .+:\d+:\d+/);
  assertNoKey(r, SENTINEL, 'analysis error');
});

test('a live blocks edge that runs backward across milestones is a backward-milestone warning', async () => {
  const ms = name => ({ projectMilestone: { id: `ms-${name}`, name } });
  const issue = (identifier, over = {}) => ({
    identifier, title: `Card ${identifier}`, url: `u/${identifier}`, estimate: null, archivedAt: null,
    state: { name: 'Backlog', type: 'backlog' }, labels: { nodes: [] }, projectMilestone: null, ...over,
  });
  const store = fakeLinearStore({
    milestones: [{ id: 'ms-M1', name: 'Discovery', sortOrder: 1 }, { id: 'ms-M2', name: 'Build', sortOrder: 2 }].map(m => ({ ...m, name: m.name })),
    issues: [
      issue('CRM-1', ms('Discovery')),
      issue('CRM-2', { ...ms('Build'), relations: { nodes: [{ type: 'blocks', relatedIssue: { identifier: 'CRM-1' } }] } }),
      issue('CRM-3', { ...ms('Build'), relations: { nodes: [{ type: 'blocks', relatedIssue: { identifier: 'CRM-2' } }] } }),
      issue('CRM-4', { relations: { nodes: [{ type: 'blocks', relatedIssue: { identifier: 'CRM-1' } }] } }),
    ],
  });
  const r = await run([SLUG], deps({ fetchImpl: store.fetchImpl }));
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  const backward = out.warnings.filter(w => w.kind === 'backward-milestone');
  assert.deepEqual(backward.map(w => w.key), ['CRM-2>CRM-1']);
  assert.match(backward[0].message, /CRM-2 \(M2 Build\) blocks CRM-1 \(M1 Discovery\)/);
  assert.match(r.stderr, /backward-milestone|blocks CRM-1/);
});
