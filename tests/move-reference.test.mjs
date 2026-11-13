import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { run } from '../scripts/maintenance/move-reference.mjs';
import { trialReferenceDir } from '../scripts/lib/spike/home.mjs';
import { makeRepo, tempDir } from './helpers/git-sandbox.mjs';
import { guardNetwork } from './helpers/no-network.mjs';

guardNetwork();

const SLUG = 'ref000000001';
const SOURCE = 'docs/reference';
const FILES = {
  'build.py': 'print("oracle")\n',
  'notes.html': '<p>template</p>\n',
  'mini-linear-2026-01-01.json': JSON.stringify({ project: { name: 'Mini', issues: { nodes: [] } } }),
  'trial-x/backfill/patch-map.json': JSON.stringify({ schemaVersion: 1, project: { slug: SLUG, name: 'Mini' }, repos: { api: 'example-api' }, patches: {} }),
  'trial-x/backfill/curated/CRM-1.json': '{"card":"CRM-1"}\n',
  'trial-x/api/log.txt': '00001-new aaaa 1 file changed\n',
  'trial-x/snap.sh': '#!/bin/zsh\n',
  'trial-x/oracle-data.json': '{"nodes":[]}\n',
};
const DEST = {
  'build.py': 'build.py',
  'notes.html': 'notes.html',
  'mini-linear-2026-01-01.json': 'linear-snapshot.json',
  'trial-x/backfill/patch-map.json': 'backfill/patch-map.json',
  'trial-x/backfill/curated/CRM-1.json': 'backfill/curated/CRM-1.json',
  'trial-x/api/log.txt': 'api/log.txt',
  'trial-x/snap.sh': 'snap.sh',
  'trial-x/oracle-data.json': 'oracle-data.json',
};

const walk = dir => (existsSync(dir)
  ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => relative(dir, join(e.parentPath, e.name))).sort()
  : []);

// A repo holding the reference folder in git, and an empty home outside every work tree.
function referenceRepo() {
  const repo = makeRepo();
  const home = tempDir('keiron-sequencer-move-reference-home-');
  after(() => {
    repo.dispose();
    rmSync(home, { recursive: true, force: true });
  });
  for (const [path, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(repo.dir, SOURCE, path)), { recursive: true });
    writeFileSync(join(repo.dir, SOURCE, path), text);
  }
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'add the reference']);
  const source = join(repo.dir, SOURCE);
  return { repo, home, source, to: trialReferenceDir(home, SLUG), go: (argv = [], extra = {}) => run(argv, { env: { KEIRON_SEQUENCER_HOME: home }, source, ...extra }) };
}

const json = r => JSON.parse(r.stdout);
const expected = (source, to) => Object.entries(DEST).map(([from, dest]) => ({ from: join(source, from), to: join(to, dest) })).sort((a, b) => (a.from < b.from ? -1 : 1));

test('the dry run lists every file with its destination under <home>/<slug>/trial-reference and moves nothing', async () => {
  const s = referenceRepo();
  const r = await s.go();
  assert.equal(r.code, 0, r.stderr);
  const out = json(r);
  assert.equal(out.slug, SLUG);
  assert.equal(out.applied, false);
  assert.equal(out.to, join(s.home, SLUG, 'trial-reference'));
  assert.deepEqual(out.moves, expected(s.source, s.to));
  assert.deepEqual(out.refusals, []);
  assert.deepEqual(walk(s.source), Object.keys(FILES).sort());
  assert.deepEqual(readdirSync(s.home), []);
});

test('--apply moves every file byte for byte, removes the emptied source folders and leaves the git index alone', async () => {
  const s = referenceRepo();
  const r = await s.go(['--apply']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(json(r).applied, true);
  for (const [from, dest] of Object.entries(DEST)) assert.equal(readFileSync(join(s.to, dest), 'utf8'), FILES[from], dest);
  assert.deepEqual(walk(s.to), Object.values(DEST).sort());
  assert.equal(existsSync(s.source), false);
  const tracked = s.repo.git(['ls-files', '--', SOURCE]).trim().split('\n').filter(Boolean);
  assert.equal(tracked.length, Object.keys(FILES).length);
  assert.match(s.repo.git(['status', '--porcelain', '--', SOURCE]), /^ D /m);
});

test('a file already at a destination refuses the apply with exit 2, naming it, and nothing moves; the dry run reports it', async () => {
  const s = referenceRepo();
  const taken = join(s.to, 'backfill', 'patch-map.json');
  mkdirSync(dirname(taken), { recursive: true });
  writeFileSync(taken, 'mine\n');
  const dry = await s.go();
  assert.equal(dry.code, 0, dry.stderr);
  assert.deepEqual(json(dry).refusals, [`${taken} already exists`]);
  const r = await s.go(['--apply']);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes(`${taken} already exists: nothing was moved`), r.stderr);
  assert.equal(readFileSync(taken, 'utf8'), 'mine\n');
  assert.deepEqual(walk(s.source), Object.keys(FILES).sort());
  assert.deepEqual(walk(s.to), ['backfill/patch-map.json']);
});

test('two sources that land on one destination refuse the apply, naming both', async () => {
  const s = referenceRepo();
  writeFileSync(join(s.source, 'snap.sh'), '#!/bin/sh\n');
  const r = await s.go(['--apply']);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes(`${join(s.source, 'snap.sh')} and ${join(s.source, 'trial-x', 'snap.sh')} both go to ${join(s.to, 'snap.sh')}`), r.stderr);
  assert.equal(existsSync(s.to), false);
});

test('a copy that does not match its source fails with exit 1 and removes no source', async () => {
  const s = referenceRepo();
  const corrupt = (from, to, mode) => {
    copyFileSync(from, to, mode);
    if (to.endsWith('snap.sh')) writeFileSync(to, 'changed\n');
  };
  const r = await s.go(['--apply'], { copyFile: corrupt });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /snap\.sh do not match their sha256/);
  assert.deepEqual(walk(s.source), Object.keys(FILES).sort());
});

test('a home inside a work tree is refused with exit 2 before anything is planned', async () => {
  const s = referenceRepo();
  const inside = join(s.repo.dir, 'home');
  const r = await run(['--apply', '--home', inside], { env: {}, source: s.source });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /inside the git work tree/);
  assert.equal(existsSync(inside), false);
  assert.deepEqual(walk(s.source), Object.keys(FILES).sort());
});

test('--home overrides KEIRON_SEQUENCER_HOME, and --source the default folder', async () => {
  const s = referenceRepo();
  const other = tempDir('keiron-sequencer-move-reference-other-');
  after(() => rmSync(other, { recursive: true, force: true }));
  const r = await run(['--home', other, '--source', s.source], { env: { KEIRON_SEQUENCER_HOME: s.home }, source: join(s.home, 'nowhere') });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(json(r).to, trialReferenceDir(other, SLUG));
});

test('a source with no trial folder, two Linear snapshots, or no folder at all is refused with exit 2', async () => {
  const s = referenceRepo();
  writeFileSync(join(s.source, 'second-linear.json'), FILES['mini-linear-2026-01-01.json']);
  const two = await s.go();
  assert.equal(two.code, 2);
  assert.match(two.stderr, /expected one Linear snapshot/);
  rmSync(join(s.source, 'trial-x', 'backfill'), { recursive: true });
  const none = await s.go();
  assert.equal(none.code, 2);
  assert.match(none.stderr, /expected one trial folder/);
  const missing = await s.go([], { source: join(s.home, 'absent') });
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /no reference folder at .*absent: pass --source <dir>/);
});

test('a usage error exits 2', async () => {
  const s = referenceRepo();
  for (const argv of [['--bogus'], ['--home'], ['extra']]) assert.equal((await s.go(argv)).code, 2, argv.join(' '));
});
