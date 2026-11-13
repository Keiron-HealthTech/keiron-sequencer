import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { run } from '../scripts/maintenance/move-data.mjs';
import { run as graph } from '../scripts/graph.mjs';
import { run as packs } from '../scripts/packs.mjs';
import { run as spike } from '../scripts/spike.mjs';
import { fakeLinear, fakeLinearStore, FIXTURE_SLUG as SLUG, FIXTURE_URL } from './helpers/fake-linear.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'keiron-sequencer-move-data-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const RECORD = readFileSync(new URL('./fixtures/records/ABC-903.json', import.meta.url), 'utf8');
const FILES = {
  'ABC-903.json': RECORD,
  'spike/respike-20261111T100000Z.json': '{"report":1}\n',
  'spike/history/ABC-903/2026-11-01T10-00-00.000Z.json': '{"old":1}\n',
  'harvest/harvest.json': '{"schemaVersion":1}\n',
  'harvest/applied.jsonl': '{"run":1}\n',
};

let n = 0;
function layout({ homeFiles = {} } = {}) {
  const root = join(TMP, `case-${++n}`);
  const data = join(root, 'repo-data');
  const home = join(root, 'home');
  for (const [file, text] of Object.entries(FILES)) put(join(data, SLUG, file), text);
  for (const [file, text] of Object.entries(homeFiles)) put(join(home, SLUG, file), text);
  return { data, home };
}
function put(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

test('dry run lists the moves and writes nothing', async () => {
  const { data, home } = layout();
  const r = await run([SLUG, '--data', data, '--home', home]);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.action, 'move-data');
  assert.equal(out.applied, false);
  assert.deepEqual(out.moves, Object.keys(FILES).sort().map(f => ({ from: join(data, SLUG, f), to: join(home, SLUG, f) })));
  for (const f of Object.keys(FILES)) assert.equal(readFileSync(join(data, SLUG, f), 'utf8'), FILES[f]);
  assert.equal(existsSync(home), false);
});

test('apply moves records, spike/, harvest/ and refuses an existing target', async () => {
  const { data, home } = layout({ homeFiles: { 'runs/20261111T100000Z/run.json': '{}\n' } });
  const r = await run([SLUG, '--data', data, '--home', home, '--apply']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).applied, true);
  for (const f of Object.keys(FILES)) assert.equal(readFileSync(join(home, SLUG, f), 'utf8'), FILES[f], f);
  assert.equal(existsSync(join(data, SLUG)), false);
  assert.equal(readFileSync(join(home, SLUG, 'runs/20261111T100000Z/run.json'), 'utf8'), '{}\n');

  const clash = layout({ homeFiles: { 'harvest/harvest.json': '{"mine":1}\n' } });
  const refused = await run([SLUG, '--data', clash.data, '--home', clash.home, '--apply']);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /harvest[/]harvest\.json/);
  assert.match(refused.stderr, /already exists/);
  for (const f of Object.keys(FILES)) assert.equal(readFileSync(join(clash.data, SLUG, f), 'utf8'), FILES[f], f);
  assert.equal(readFileSync(join(clash.home, SLUG, 'harvest/harvest.json'), 'utf8'), '{"mine":1}\n');
  assert.equal(existsSync(join(clash.home, SLUG, 'ABC-903.json')), false);
});

test('a slug with nothing in the repo data dir moves nothing and says so', async () => {
  const { data, home } = layout();
  const r = await run(['abc123def456', '--data', data, '--home', home, '--apply']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).moves, []);
});

test('graph warns data-in-repo instead of reporting no record', async () => {
  const { data, home } = layout();
  const { fetchImpl } = fakeLinear();
  const deps = { env: { LINEAR_API_KEY: 'lin_api_dummy_' + 'm'.repeat(30) }, keyFile: join(TMP, 'absent.key'), now: () => new Date('2026-11-12T10:00:00.000Z'), fetchImpl };
  const r = await graph([FIXTURE_URL], { ...deps, dataDir: home, repoDataDir: data });
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.records.count, 0);
  const w = out.warnings.find(x => x.kind === 'data-in-repo');
  assert.ok(w, JSON.stringify(out.warnings));
  assert.match(w.message, new RegExp(`move-data\\.mjs ${SLUG}`));
  assert.ok(w.message.includes(join(data, SLUG)), w.message);
  assert.match(r.stderr, /data-in-repo|move-data/);

  put(join(home, SLUG, 'ABC-903.json'), RECORD);
  const partial = JSON.parse((await graph([FIXTURE_URL], { ...deps, fetchImpl: fakeLinear().fetchImpl, dataDir: home, repoDataDir: data })).stdout);
  const still = partial.warnings.find(x => x.kind === 'data-in-repo');
  assert.ok(still, 'a home holding some records does not silence the warning');
  assert.match(still.message, /already exists/);

  rmSync(join(home, SLUG, 'ABC-903.json'));
  assert.equal((await run([SLUG, '--data', data, '--home', home, '--apply'])).code, 0);
  const moved = JSON.parse((await graph([FIXTURE_URL], { ...deps, fetchImpl: fakeLinear().fetchImpl, dataDir: home, repoDataDir: data })).stdout);
  assert.equal(moved.warnings.some(x => x.kind === 'data-in-repo'), false);
});

test('spike begin and packs warn data-in-repo while the repo still holds records', async () => {
  const { data, home } = layout();
  const spiked = await spike(['begin', 'nonsense-ref'], { env: {}, home, dataDir: home, repoDataDir: data, keyFile: join(TMP, 'absent.key') });
  assert.match(spiked.stderr, /data-in-repo|move-data\.mjs/);
  const store = fakeLinearStore({ issues: [] });
  const packed = await packs(['status', SLUG], { env: { LINEAR_API_KEY: 'lin_api_dummy_' + 'q'.repeat(30) }, keyFile: join(TMP, 'absent.key'), fetchImpl: store.fetchImpl, dataDir: home, home, repoDataDir: data });
  assert.equal(packed.code, 0, packed.stderr);
  assert.ok(JSON.parse(packed.stdout).warnings.some(w => w.kind === 'data-in-repo'));
});
