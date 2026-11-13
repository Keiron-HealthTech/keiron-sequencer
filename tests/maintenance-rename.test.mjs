import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync as renameFolder, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { run } from '../scripts/maintenance/rename-trial-dirs.mjs';
import { TRIAL_DIR } from '../scripts/lib/spike/home.mjs';
import { serializeRecord } from '../scripts/lib/record.mjs';
import { tempDir } from './helpers/git-sandbox.mjs';
import { guardNetwork } from './helpers/no-network.mjs';

guardNetwork();

const SLUG = 'aaaa00000001';
const OTHER = 'bbbb00000002';
const REPOS = { backend: 'example-api', perms: 'example-auth', worker: 'worker' };
const PATCHES = {
  'backend/00001-new.patch': 'diff --git a/a.js b/a.js\n+backend one\n',
  'backend/fixup-1-from-2-x.patch': 'diff --git a/b.js b/b.js\n+fixup\n',
  'perms/00002-new.patch': 'diff --git a/k.js b/k.js\n+perms two\n',
  'worker/00003-new.patch': 'diff --git a/m.js b/m.js\n+worker three\n',
};

const walk = dir => (existsSync(dir)
  ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => relative(dir, join(e.parentPath, e.name))).sort()
  : []);
const snapshot = dir => walk(dir).map(p => [p, readFileSync(join(dir, p), 'utf8')]);
const sha = text => createHash('sha256').update(text).digest('hex');

const repo = (name, over = {}) => ({ name, github: null, checkout: '/nowhere', url: null, remote: 'origin', defaultBranch: 'main', setup: [], risk: [], ...over });

const ref = patch => `patch:${patch}`;
function record(card, patches, over = {}) {
  return {
    schemaVersion: 1,
    card,
    title: `Card ${card}`,
    project: { slug: SLUG, name: 'Rename trial' },
    origin: 'thin-spike',
    spikedAt: '2026-10-01T10:00:00.000Z',
    scope: { complete: true, note: null },
    size: { prodLines: 1, testLines: 0, files: 1, repos: ['example-api'], sharedWith: [], deletionWeight: 0.25 },
    effort: null,
    fixups: { received: [], caused: [] },
    cases: [{ id: 'c1', given: 'backend/00001-new.patch is named', when: 'read', then: 'it holds', source: 'patch', ref: ref(patches[0]) }],
    decisions: [{ text: 'One file', ref: ref(patches[0]) }],
    findings: [{ kind: 'risk', text: 'Order matters', ref: ref(patches[0]) }],
    openDecisions: [{ text: 'Which locale?', ref: ref(patches[0]) }],
    riskAreas: [],
    novelty: { newPaths: [] },
    refs: { engram: [], patches, linear: null },
    ...over,
  };
}

const RECORDS = [
  record('CRM-1', ['backend/00001-new.patch'], {
    fixups: { received: [{ from: 'CRM-2', patch: 'backend/fixup-1-from-2-x.patch', note: null }], caused: [] },
  }),
  record('CRM-2', ['perms/00002-new.patch'], {
    fixups: { received: [], caused: [{ to: 'CRM-1', patch: 'backend/fixup-1-from-2-x.patch', note: null }] },
  }),
  record('CRM-3', ['worker/00003-new.patch']),
];

// A trial store: the docs trial dir (its patch map), a home with the trial patches and a data dir with the records.
function store({ config = { schemaVersion: 1, repos: { 'example-api': repo('example-api') } }, repos = REPOS, patches = PATCHES, records = RECORDS } = {}) {
  const trial = tempDir('keiron-sequencer-rename-trial-');
  const home = tempDir('keiron-sequencer-rename-home-');
  const data = tempDir('keiron-sequencer-rename-data-');
  after(() => { for (const d of [trial, home, data]) rmSync(d, { recursive: true, force: true }); });
  mkdirSync(join(trial, 'backfill'), { recursive: true });
  writeFileSync(join(trial, 'backfill', 'patch-map.json'), JSON.stringify({ schemaVersion: 1, project: { slug: SLUG, name: 'Rename trial' }, repos, patches: {}, cards: {} }));
  for (const dir of Object.keys(repos)) {
    mkdirSync(join(trial, dir), { recursive: true });
    writeFileSync(join(trial, dir, 'log.txt'), '00001-new\n');
  }
  if (config) writeFileSync(join(home, 'config.json'), JSON.stringify(config));
  const put = (path, text) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  for (const [path, text] of Object.entries(patches)) put(join(home, SLUG, TRIAL_DIR, path), text);
  put(join(home, OTHER, TRIAL_DIR, 'backend', '00001-new.patch'), PATCHES['backend/00001-new.patch']);
  for (const r of records) put(join(data, SLUG, `${r.card}.json`), serializeRecord(r));
  const go = (...flags) => run([...flags, '--home', home, '--data', data, '--trial', trial], { env: {} });
  const state = () => ({ home: snapshot(home), data: snapshot(data), trial: snapshot(trial) });
  return { trial, home, data, put, go, state, root: join(home, SLUG, TRIAL_DIR) };
}

const json = r => JSON.parse(r.stdout);

test('the map takes each trial dir to the configured key carrying its repo name, else to the repo name, marked unconfigured', async () => {
  const s = store();
  const r = await s.go();
  assert.equal(r.code, 0, r.stderr);
  const out = json(r);
  assert.equal(out.direction, 'forward');
  assert.deepEqual(out.map, { backend: 'example-api', perms: 'example-auth', worker: 'worker' });
  assert.deepEqual(out.warnings.filter(w => w.code === 'unconfigured').map(w => [w.dir, w.to]), [['perms', 'example-auth'], ['worker', 'worker']]);
  assert.deepEqual(out.folders, [
    { from: 'backend', to: 'example-api', state: 'todo' },
    { from: 'perms', to: 'example-auth', state: 'todo' },
    { from: 'worker', to: 'worker', state: 'same' },
  ]);
});

test('a configured dir whose name is the repo name is the target', async () => {
  const s = store({ config: { schemaVersion: 1, repos: { 'example-api': repo('example-api'), auth: repo('example-auth') } } });
  const out = json(await s.go());
  assert.equal(out.map.perms, 'auth');
  assert.deepEqual(out.warnings.filter(w => w.code === 'unconfigured').map(w => w.dir), ['worker']);
});

test('the dry run writes nothing and lists the folder renames, every reference per record and a patch digest, never patch content', async () => {
  const s = store();
  const before = s.state();
  const r = await s.go();
  assert.deepEqual(s.state(), before);
  const out = json(r);
  assert.equal(out.applied, false);
  const crm1 = out.records.find(x => x.file === 'CRM-1.json');
  assert.deepEqual(crm1.changes.map(c => c.path), [
    '$.fixups.received[0].patch', '$.cases[0].ref', '$.decisions[0].ref', '$.findings[0].ref', '$.openDecisions[0].ref', '$.refs.patches[0]',
  ]);
  assert.deepEqual(crm1.changes[5], { path: '$.refs.patches[0]', from: 'backend/00001-new.patch', to: 'example-api/00001-new.patch' });
  assert.deepEqual(out.records.map(x => [x.file, x.changes.length]), [['CRM-1.json', 6], ['CRM-2.json', 6]]);
  assert.equal(out.patches.count, 4);
  assert.match(out.patches.sha256, /^[0-9a-f]{64}$/);
  for (const text of Object.values(PATCHES)) assert.equal(r.stdout.includes(text.split('\n')[1]), false);
});

test('a trial folder absent from the map refuses the whole migration, naming it, with nothing changed', async () => {
  const s = store();
  s.put(join(s.root, 'extra', '00009-new.patch'), 'diff --git a/x b/x\n+x\n');
  const before = s.state();
  const r = await s.go('--apply');
  assert.equal(r.code, 5);
  assert.match(r.stderr, /extra/);
  assert.deepEqual(s.state(), before);
});

test('two trial dirs that map to one target refuse before anything is written', async () => {
  const s = store({ repos: { backend: 'example-api', api: 'example-api' }, patches: { 'backend/00001-new.patch': 'a\n', 'api/00002-new.patch': 'b\n' }, records: [] });
  const before = s.state();
  const r = await s.go('--apply');
  assert.equal(r.code, 5);
  assert.match(r.stderr, /api.*backend|backend.*api/);
  assert.deepEqual(s.state(), before);
});

test('a usage error exits 2 before any path is read', async () => {
  const r = await run(['--bogus'], { env: { KEIRON_SEQUENCER_HOME: '/nonexistent/home' } });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /usage/);
  assert.equal((await run(['--home'], { env: {} })).code, 2);
});

const digests = root => Object.fromEntries(walk(root).filter(p => p.endsWith('.patch')).map(p => [p.split('/').pop(), sha(readFileSync(join(root, p)))]));
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));

test('apply rewrites every trial reference of the top-level records, renames the folders and writes the manifest, keeping patch bytes and case hashes', async () => {
  const s = store();
  const runRecord = record('CRM-4', ['backend/00004-new.patch'], { refs: { engram: [], patches: ['backend/00004-new.patch'], linear: null, runId: '20261101T100000Z' } });
  s.put(join(s.data, SLUG, 'CRM-4.json'), serializeRecord(runRecord));
  s.put(join(s.data, SLUG, 'spike', 'history', 'CRM-1', '2026-09-01T10-00-00.000Z.json'), serializeRecord(record('CRM-1', ['backend/00001-new.patch'])));
  s.put(join(s.data, SLUG, 'harvest', 'harvest.json'), JSON.stringify({ ref: 'patch:backend/00001-new.patch' }));
  s.put(join(s.home, SLUG, 'runs', '20261101T100000Z', 'patches', 'backend', '00004-new.patch'), 'run patch\n');
  const before = { ...s.state(), patches: digests(s.root) };
  const untouched = ['CRM-3.json', 'CRM-4.json', 'spike/history/CRM-1/2026-09-01T10-00-00.000Z.json', 'harvest/harvest.json']
    .map(f => [f, readFileSync(join(s.data, SLUG, f), 'utf8')]);

  const r = await s.go('--apply');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(json(r).applied, true);
  assert.deepEqual(json(r).warnings.filter(w => w.code === 'not-rewritten').map(w => w.file), [`${SLUG}/harvest/harvest.json`, `${SLUG}/spike/history/CRM-1/2026-09-01T10-00-00.000Z.json`]);
  assert.deepEqual(readdirSync(s.root, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort(), ['example-api', 'example-auth', 'worker']);
  assert.deepEqual(readJson(join(s.root, 'dirs.json')), { schemaVersion: 1, dirs: { backend: 'example-api', perms: 'example-auth' } });
  assert.deepEqual(digests(s.root), before.patches);

  const crm1 = readJson(join(s.data, SLUG, 'CRM-1.json'));
  const old1 = RECORDS[0];
  assert.deepEqual(crm1.refs.patches, ['example-api/00001-new.patch']);
  assert.equal(crm1.fixups.received[0].patch, 'example-api/fixup-1-from-2-x.patch');
  for (const list of ['cases', 'decisions', 'findings', 'openDecisions']) assert.equal(crm1[list][0].ref, 'patch:example-api/00001-new.patch', list);
  assert.equal(crm1.cases[0].given, old1.cases[0].given);
  const strip = r => ({ ...r, refs: null, fixups: null, cases: r.cases.map(c => ({ ...c, ref: null })), decisions: null, findings: null, openDecisions: null });
  assert.deepEqual(strip(crm1), strip(old1));
  assert.equal(readJson(join(s.data, SLUG, 'CRM-2.json')).fixups.caused[0].patch, 'example-api/fixup-1-from-2-x.patch');
  assert.deepEqual(readJson(join(s.data, SLUG, 'CRM-2.json')).refs.patches, ['example-auth/00002-new.patch']);
  for (const [f, text] of untouched) assert.equal(readFileSync(join(s.data, SLUG, f), 'utf8'), text, f);

  const after = s.state();
  assert.deepEqual(after.trial, before.trial);
  const other = st => st.home.filter(([p]) => !p.startsWith(`${SLUG}/${TRIAL_DIR}/`));
  assert.deepEqual(other(after), other(before));
});

test('a second apply is a no-op', async () => {
  const s = store();
  assert.equal((await s.go('--apply')).code, 0);
  const before = s.state();
  const again = await s.go('--apply');
  assert.equal(again.code, 0, again.stderr);
  assert.deepEqual(json(again).folders.map(f => f.state), ['done', 'done', 'same']);
  assert.deepEqual(json(again).records, []);
  assert.deepEqual(s.state(), before);
});

test('apply refuses, writing nothing, on an open run, a taken target folder, a non-canonical record, a record that would not validate or a home inside a work tree', async () => {
  const cases = [
    ['an open run', s => s.put(join(s.home, SLUG, 'runs', '20261101T100000Z', 'run.json'), JSON.stringify({ schemaVersion: 1, runId: '20261101T100000Z', status: 'paused', project: { slug: SLUG } })), /paused/],
    ['a taken target', s => s.put(join(s.root, 'example-api', 'other.patch'), 'x\n'), /example-api already exists/],
    ['a non-canonical record', s => s.put(join(s.data, SLUG, 'CRM-1.json'), JSON.stringify(RECORDS[0])), /CRM-1\.json is not in canonical form/],
    ['an invalid record', s => s.put(join(s.data, SLUG, 'CRM-1.json'), serializeRecord({ ...RECORDS[0], cases: [] })), /CRM-1\.json would not validate/],
  ];
  for (const [name, edit, message] of cases) {
    const s = store();
    edit(s);
    const before = s.state();
    const r = await s.go('--apply');
    assert.equal(r.code, 5, name);
    assert.match(r.stderr, message, name);
    assert.deepEqual(s.state(), before, name);
  }
  const outer = tempDir('keiron-sequencer-rename-worktree-');
  after(() => rmSync(outer, { recursive: true, force: true }));
  mkdirSync(join(outer, '.git'));
  const s = store();
  const home = join(outer, 'home');
  mkdirSync(home);
  const r = await run(['--apply', '--home', home, '--data', s.data, '--trial', s.trial], { env: {} });
  assert.equal(r.code, 5);
  assert.match(r.stderr, /work tree/);
  assert.deepEqual(walk(home), []);
});

test('an apply interrupted after one folder is finished by running apply again', async () => {
  const s = store();
  const start = s.state();
  let calls = 0;
  const flaky = (from, to) => {
    calls += 1;
    if (calls === 2) throw new Error('disk went away');
    return renameFolder(from, to);
  };
  const broken = await run(['--apply', '--home', s.home, '--data', s.data, '--trial', s.trial], { env: {}, rename: flaky });
  assert.equal(broken.code, 1);
  assert.deepEqual(readdirSync(s.root, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort(), ['example-api', 'perms', 'worker']);
  const resumed = await s.go('--apply');
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.deepEqual(json(resumed).folders.map(f => f.state), ['done', 'todo', 'same']);
  assert.deepEqual(readdirSync(s.root, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort(), ['example-api', 'example-auth', 'worker']);
  assert.notDeepEqual(s.state(), start);
});

test('the inverse is a dry run unless --apply is given, and an applied inverse restores every folder name and record byte for byte', async () => {
  const s = store({ config: { schemaVersion: 1, repos: { 'example-api': repo('example-api'), auth: repo('example-auth') } } });
  const start = s.state();
  assert.equal((await s.go('--apply')).code, 0);
  rmSync(join(s.home, 'config.json'));
  const applied = s.state();
  const dry = await s.go('--inverse');
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal(json(dry).direction, 'inverse');
  assert.equal(json(dry).applied, false);
  assert.deepEqual(json(dry).map, { auth: 'perms', 'example-api': 'backend' });
  assert.deepEqual(s.state(), applied);
  const back = await s.go('--inverse', '--apply');
  assert.equal(back.code, 0, back.stderr);
  assert.equal(existsSync(join(s.root, 'dirs.json')), false);
  const withoutConfig = st => ({ ...st, home: st.home.filter(([p]) => p !== 'config.json') });
  assert.deepEqual(withoutConfig(s.state()), withoutConfig(start));
  assert.equal(json(back).patches.sha256, json(dry).patches.sha256);
});

test('the inverse on a store never renamed is a no-op', async () => {
  const s = store();
  const before = s.state();
  const r = await s.go('--inverse', '--apply');
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual([json(r).folders, json(r).records], [[], []]);
  assert.deepEqual(s.state(), before);
});

test('the inverse refuses once a top-level record has a run id or a replay marker, and says how to restore by hand', async () => {
  for (const over of [
    { refs: { engram: [], patches: ['example-api/00009-new.patch'], linear: null, runId: '20261110T100000Z' } },
    {
      refs: { engram: [], patches: ['example-api/00009-new.patch'], linear: null, runId: '20261110T100000Z' },
      replayed: { at: '2026-11-10T10:00:00.000Z', runId: '20261110T100000Z', fromRunId: null, folded: ['example-api/00009-new.patch'] },
    },
  ]) {
    const s = store();
    assert.equal((await s.go('--apply')).code, 0);
    s.put(join(s.data, SLUG, 'CRM-9.json'), serializeRecord(record('CRM-9', ['example-api/00009-new.patch'], over)));
    const before = s.state();
    const r = await s.go('--inverse', '--apply');
    assert.equal(r.code, 5);
    assert.match(r.stderr, /CRM-9\.json/);
    assert.match(r.stderr, /git/);
    assert.match(r.stderr, /rename the folders by hand/);
    assert.deepEqual(s.state(), before);
  }
});

test('the inverse refuses, writing nothing, while the slug has an active or paused run', async () => {
  for (const status of ['active', 'paused']) {
    const s = store();
    assert.equal((await s.go('--apply')).code, 0);
    s.put(join(s.home, SLUG, 'runs', '20261112T100000Z', 'run.json'), JSON.stringify({ schemaVersion: 1, runId: '20261112T100000Z', status, project: { slug: SLUG } }));
    const before = s.state();
    for (const flags of [['--inverse'], ['--inverse', '--apply']]) {
      const r = await s.go(...flags);
      assert.equal(r.code, 5, `${status} ${flags.join(' ')}`);
      assert.match(r.stderr, new RegExp(`20261112T100000Z of ${SLUG} is ${status}`));
      assert.equal(r.stdout, '');
      assert.deepEqual(s.state(), before);
    }
  }
});

test('an interrupted apply finished by a re-run, then an inverse interrupted and re-run, ends where the store started', async () => {
  const s = store();
  const start = s.state();
  const failSecond = () => {
    let calls = 0;
    return (from, to) => {
      calls += 1;
      if (calls === 2) throw new Error('disk went away');
      return renameFolder(from, to);
    };
  };
  const flags = ['--home', s.home, '--data', s.data, '--trial', s.trial];
  assert.equal((await run(['--apply', ...flags], { env: {}, rename: failSecond() })).code, 1);
  assert.equal((await s.go('--apply')).code, 0);
  assert.equal((await run(['--inverse', '--apply', ...flags], { env: {}, rename: failSecond() })).code, 1);
  assert.equal(existsSync(join(s.root, 'dirs.json')), true);
  const again = await s.go('--inverse', '--apply');
  assert.equal(again.code, 0, again.stderr);
  assert.deepEqual(s.state(), start);
});

test('with no --trial the rename reads the trial reference beside the patches in the home; with none it fails naming the path and --trial', async () => {
  const s = store();
  const bare = await run(['--home', s.home, '--data', s.data], { env: {} });
  assert.equal(bare.code, 1);
  assert.ok(bare.stderr.includes(join(s.home, '<slug>', 'trial-reference')), bare.stderr);
  assert.match(bare.stderr, /--trial <dir>/);
  cpSync(s.trial, join(s.home, SLUG, 'trial-reference'), { recursive: true });
  const found = await run(['--home', s.home, '--data', s.data], { env: {} });
  assert.equal(found.code, 0, found.stderr);
  assert.deepEqual(json(found).map, { backend: 'example-api', perms: 'example-auth', worker: 'worker' });
  const viaEnv = await run(['--data', s.data], { env: { KEIRON_SEQUENCER_HOME: s.home } });
  assert.equal(viaEnv.code, 0, viaEnv.stderr);
  cpSync(s.trial, join(s.home, OTHER, 'trial-reference'), { recursive: true });
  const several = await run(['--home', s.home, '--data', s.data], { env: {} });
  assert.equal(several.code, 1);
  assert.match(several.stderr, new RegExp(`several trial references .*${SLUG}, ${OTHER}.*--trial <dir>`));
});
