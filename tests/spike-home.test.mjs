import { test, after } from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import {
  acquireLock, assertHomeOutsideWorkTree, dataDirFor, displayData, RUN_ID, runDir, runIdAt, sequencerHome, statePath, TRIAL_DIR, trialPatchRoot, workTreeOf, writeAtomic,
} from '../scripts/lib/spike/home.mjs';
import { writeConfig } from '../scripts/lib/spike/config.mjs';
import { resolvePatches } from '../scripts/lib/start/brief.mjs';
import { run } from '../scripts/spike.mjs';
import { makeRepo, tempDir } from './helpers/git-sandbox.mjs';
import { FIXTURE_SLUG } from './helpers/fake-linear.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import { notes, PROJECT_URL, SLUG, spikeFixture, walk } from './helpers/spike-fixture.mjs';
import { trialRecord, trialStore } from './helpers/trial-store.mjs';

guardNetwork();

const DIR = tempDir('keiron-sequencer-home-');
after(() => rmSync(DIR, { recursive: true, force: true }));

test('KEIRON_SEQUENCER_HOME overrides the default ~/.keiron-sequencer', () => {
  assert.equal(sequencerHome({ KEIRON_SEQUENCER_HOME: '/x/home' }), '/x/home');
  assert.equal(sequencerHome({}), join(homedir(), '.keiron-sequencer'));
});

test('a run id is the UTC start instant as YYYYMMDDTHHMMSSZ', () => {
  assert.equal(runIdAt(new Date('2026-11-10T09:08:07.654Z')), '20261110T090807Z');
  assert.match(runIdAt(new Date()), RUN_ID);
  for (const bad of ['20261110T090807', '2026-11-10T09:08:07Z', 'x20261110T090807Z']) assert.doesNotMatch(bad, RUN_ID);
});

test('the trial patch root and the run paths sit under the project slug', () => {
  assert.equal(trialPatchRoot('/h', FIXTURE_SLUG), join('/h', FIXTURE_SLUG, TRIAL_DIR));
  assert.equal(runDir('/h', 'abc', '20261110T090807Z'), join('/h', 'abc', 'runs', '20261110T090807Z'));
  const state = statePath('/h', 'abc', '20261110T090807Z');
  assert.equal(state, join('/h', 'abc', 'runs', '20261110T090807Z', 'run.json'));
  const trees = join(runDir('/h', 'abc', '20261110T090807Z'), 'trees');
  assert.ok(relative(trees, state).startsWith('..'), 'the state file is outside the trees folder');
});

test('a home inside a git work tree is refused, naming the work tree; one outside is accepted even before it exists', () => {
  const repo = makeRepo();
  after(repo.dispose);
  for (const home of [join(repo.dir, '.keiron-sequencer'), join(repo.dir, 'src', 'deep', 'home'), repo.dir]) {
    assert.throws(() => assertHomeOutsideWorkTree(home), e => e.message.includes('inside the git work tree') && e.message.includes(repo.dir)
      && e.message.includes('set KEIRON_SEQUENCER_HOME to a folder outside every repo'), home);
  }
  assert.doesNotThrow(() => assertHomeOutsideWorkTree(join(DIR, 'not-yet', 'home')));
});

test('workTreeOf names the work tree a path sits in, existing or not, and is null outside every repo', () => {
  const repo = makeRepo();
  after(repo.dispose);
  for (const path of [repo.dir, join(repo.dir, 'src'), join(repo.dir, 'not', 'yet', 'here.json')]) assert.equal(workTreeOf(path), repo.dir, path);
  assert.equal(workTreeOf(join(DIR, 'plain', 'home')), null);
});

test('a config write into a home inside a git work tree is refused before anything is copied', () => {
  const repo = makeRepo();
  after(repo.dispose);
  const home = join(repo.dir, '.keiron-sequencer');
  mkdirSync(home);
  const before = '{"schemaVersion": 1}\n';
  writeFileSync(join(home, 'config.json'), before);
  writeFileSync(join(home, 'config.json.bak'), 'older\n');
  const text = `${JSON.stringify({ schemaVersion: 1, repos: { api: { name: 'api', checkout: '/src/api', remote: 'origin' } } }, null, 2)}\n`;
  assert.throws(() => writeConfig(home, text, Buffer.from(before)), e => e.message.includes('inside the git work tree') && e.message.includes(repo.dir));
  assert.deepEqual(readdirSync(home).sort(), ['config.json', 'config.json.bak']);
  assert.equal(readFileSync(join(home, 'config.json'), 'utf8'), before);
  assert.equal(readFileSync(join(home, 'config.json.bak'), 'utf8'), 'older\n');
});

test('an atomic write replaces the file whole and leaves no temporary file, even when the rename fails', () => {
  const path = join(DIR, 'atomic', 'run.json');
  writeAtomic(path, 'first\n');
  writeAtomic(path, 'second\n');
  assert.equal(readFileSync(path, 'utf8'), 'second\n');
  assert.deepEqual(readdirSync(join(DIR, 'atomic')), ['run.json']);

  const blocked = join(DIR, 'atomic', 'blocked');
  mkdirSync(join(blocked, 'inside'), { recursive: true });
  assert.throws(() => writeAtomic(blocked, 'x'));
  assert.deepEqual(readdirSync(join(DIR, 'atomic')).sort(), ['blocked', 'run.json']);
});

test('the run lock is exclusive, holds the pid, and is gone once released', () => {
  const dir = join(DIR, 'lock-run');
  const release = acquireLock(dir, { pid: 4242 });
  assert.equal(readFileSync(join(dir, 'run.lock'), 'utf8'), '4242\n');
  assert.throws(() => acquireLock(dir, { pid: 4343 }), e => e.message.includes('4242') && e.message.includes(join(dir, 'run.lock')));
  assert.equal(readFileSync(join(dir, 'run.lock'), 'utf8'), '4242\n');
  release();
  assert.equal(existsSync(join(dir, 'run.lock')), false);
  acquireLock(dir, { pid: 4343 })();
  writeFileSync(join(dir, 'other'), '');
  assert.deepEqual(readdirSync(dir), ['other']);
});

test('begin with a home inside a git work tree fails naming the problem, before reading Linear or writing anything', async () => {
  const { repo, home, deps, linear } = spikeFixture();
  const inside = join(repo.dir, '.keiron-sequencer');
  mkdirSync(inside);
  writeFileSync(join(inside, 'config.json'), readFileSync(join(home, 'config.json')));
  const r = await run(['begin', PROJECT_URL], { ...deps, home: inside });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /inside the git work tree/);
  assert.deepEqual(walk(inside), ['config.json']);
  assert.equal(linear.sent.length, 0);
});

test('a command on a locked run fails naming the lock and changes nothing; every command releases its lock', async () => {
  const { home, deps, at } = spikeFixture();
  const { runId } = JSON.parse((await run(['begin', PROJECT_URL], deps)).stdout);
  const dir = join(home, SLUG, 'runs', runId);
  assert.equal(existsSync(join(dir, 'run.lock')), false);
  const before = readFileSync(join(dir, 'run.json'), 'utf8');
  const release = acquireLock(dir, { pid: 999999 });
  at('2026-11-10T10:01:00.000Z');
  for (const argv of [['next'], ['tree', 'backend'], ['end', 'CRM-1'], ['begin', PROJECT_URL]]) {
    const r = await run(argv, deps);
    assert.equal(r.code, 1, argv.join(' '));
    assert.match(r.stderr, /locked by pid 999999/, argv.join(' '));
  }
  assert.equal(readFileSync(join(dir, 'run.json'), 'utf8'), before);
  release();
  assert.equal((await run(['next'], deps)).code, 0);
  assert.equal(existsSync(join(dir, 'run.lock')), false);
});

test('the run store holds no git metadata and no ignore rules outside the spike trees', async () => {
  const { home, deps, at } = spikeFixture();
  const { runId } = JSON.parse((await run(['begin', PROJECT_URL], deps)).stdout);
  at('2026-11-10T10:01:00.000Z');
  await run(['next'], deps);
  const tree = JSON.parse((await run(['tree', 'backend'], deps)).stdout);
  writeFileSync(join(tree.path, 'README.md'), '# sandbox\nspiked\n');
  const dir = join(home, SLUG, 'runs', runId);
  mkdirSync(join(dir, 'notes'), { recursive: true });
  writeFileSync(join(dir, 'notes', 'CRM-1.json'), JSON.stringify(notes));
  at('2026-11-10T10:05:00.000Z');
  assert.equal((await run(['end', 'CRM-1'], deps)).code, 0);
  const outsideTrees = walk(home).filter(f => !f.startsWith(join(SLUG, 'runs', runId, 'trees') + '/'));
  assert.ok(outsideTrees.length > 0);
  assert.deepEqual(outsideTrees.filter(f => f.split('/').some(seg => seg === '.git' || seg === '.gitignore')), []);
  assert.equal(existsSync(join(home, '.git')), false);
});

test('after the trial rename, a trial record names the configured dir and its patch resolves under the trial root', async () => {
  const slug = 'cccc00000003';
  const s = trialStore({
    slug,
    repos: { backend: 'example-api' },
    config: { schemaVersion: 1, repos: { 'example-api': { name: 'example-api', checkout: '/nowhere', remote: 'origin' } } },
    patches: { 'backend/00001-new.patch': 'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-a\n+b\n' },
    records: [trialRecord('CRM-1', ['backend/00001-new.patch'], slug)],
  });
  const before = resolvePatches(s.record('CRM-1'), { home: s.home, slug });
  assert.deepEqual(before.map(p => [p.ref, p.location]), [['backend/00001-new.patch', 'trial']]);
  const r = await s.rename('--apply');
  assert.equal(r.code, 0, r.stderr);
  const after = resolvePatches(s.record('CRM-1'), { home: s.home, slug });
  assert.deepEqual(after.map(p => [p.ref, p.repoDir, p.location, p.files]), [['example-api/00001-new.patch', 'example-api', 'trial', before[0].files]]);
  assert.ok(existsSync(join(trialPatchRoot(s.home, slug), 'example-api', '00001-new.patch')));
});

test('records resolve under KEIRON_SEQUENCER_HOME/<slug>, not the repo', () => {
  const home = join(DIR, 'records-home');
  const slug = FIXTURE_SLUG;
  const base = JSON.parse(readFileSync(new URL('./fixtures/records/ABC-901.json', import.meta.url), 'utf8'));
  mkdirSync(join(home, slug), { recursive: true });
  writeFileSync(join(home, slug, 'ABC-4.json'), JSON.stringify({ ...base, card: 'ABC-4', cases: [{ ...base.cases[0], ref: 'linear:ABC-4' }] }));
  const repoData = join(DIR, 'records-repo-data');
  mkdirSync(repoData, { recursive: true });
  const helper = new URL('./helpers/fake-linear.mjs', import.meta.url).pathname;
  const cli = new URL('../scripts/graph.mjs', import.meta.url).pathname;
  const script = `
    import { run } from ${JSON.stringify(cli)};
    import { fakeLinear, FIXTURE_URL } from ${JSON.stringify(helper)};
    const { fetchImpl } = fakeLinear();
    const r = await run([FIXTURE_URL], { env: { ...process.env, LINEAR_API_KEY: 'lin_api_dummy_${'h'.repeat(30)}' }, keyFile: '/nonexistent/linear.key', fetchImpl, repoDataDir: ${JSON.stringify(repoData)} });
    process.stdout.write(r.stdout);
    process.stderr.write(r.stderr);
    process.exitCode = r.code;`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: DIR, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: join(DIR, 'user-home'), KEIRON_SEQUENCER_HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.records.count, 1);
  assert.equal(out.records.dir, join(home, slug));
});

test('displayData abbreviates the user home to ~ and leaves any other path whole', () => {
  assert.equal(displayData(join(homedir(), '.keiron-sequencer'), 'abc'), '~/.keiron-sequencer/abc');
  assert.equal(displayData('/x/home', 'abc'), '/x/home/abc');
  assert.equal(dataDirFor({ KEIRON_SEQUENCER_HOME: '/x/home' }), '/x/home');
  assert.equal(dataDirFor({}), join(homedir(), '.keiron-sequencer'));
});
