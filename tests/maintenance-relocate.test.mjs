import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { relocate, TRIAL } from '../scripts/maintenance/relocate-patches.mjs';
import { TRIAL_DIR } from '../scripts/lib/spike/home.mjs';
import { gitRunner } from '../scripts/lib/spike/exec.mjs';
import { makeRepo, SANDBOX_ENV, tempDir } from './helpers/git-sandbox.mjs';
import { guardNetwork } from './helpers/no-network.mjs';

guardNetwork();

const PATCHES = {
  [`${TRIAL}/backend/00001-new.patch`]: 'diff --git a/a b/a\n+backend one\n',
  [`${TRIAL}/web/fixup-1-from-2-x.patch`]: 'diff --git a/k b/k\n+web fixup\n',
};
const UNATTRIBUTED = {
  [`${TRIAL}/other/00009-new.patch`]: 'diff --git a/o b/o\n+other\n',
  'notes/stray.patch': 'diff --git a/s b/s\n+stray\n',
};

function trialRepo() {
  const repo = makeRepo();
  const home = tempDir('keiron-sequencer-relocate-home-');
  after(() => {
    repo.dispose();
    rmSync(home, { recursive: true, force: true });
  });
  const files = {
    ...PATCHES,
    ...UNATTRIBUTED,
    [`${TRIAL}/backend/log.txt`]: 'snapshot log\n',
    [`${TRIAL}/backfill/patch-map.json`]: JSON.stringify({ repos: { backend: 'b', web: 'w' } }),
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo.dir, path)), { recursive: true });
    writeFileSync(join(repo.dir, path), text);
  }
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'add the trial']);
  return { repo, dest: join(home, 'c0ffee000001'), git: gitRunner({ env: SANDBOX_ENV }) };
}

const tracked = repo => repo.git(['ls-files', '--', '*.patch']).trim().split('\n').filter(Boolean).sort();

test('tracer: without apply, the tracked patches are listed and nothing is touched', () => {
  const { repo, dest, git } = trialRepo();
  const out = relocate({ repo: repo.dir, dest, apply: false, git });
  assert.deepEqual(out.files.map(f => f.path), Object.keys(PATCHES).sort());
  assert.deepEqual(out.removed, []);
  assert.equal(existsSync(dest), false);
  assert.deepEqual(tracked(repo), [...Object.keys(PATCHES), ...Object.keys(UNATTRIBUTED)].sort());
  assert.equal(repo.git(['status', '--porcelain']), '');
});

const sha = text => createHash('sha256').update(text).digest('hex');
const copyOf = (dest, path) => join(dest, TRIAL_DIR, path.slice(TRIAL.length + 1));

test('with apply, each patch is copied to <dest>/<trial dir>/<repoDir>/ with an equal sha256, then untracked and deleted', () => {
  const { repo, dest, git } = trialRepo();
  const out = relocate({ repo: repo.dir, dest, apply: true, git });
  assert.deepEqual(out.removed, Object.keys(PATCHES).sort());
  for (const [path, text] of Object.entries(PATCHES)) {
    const entry = out.files.find(f => f.path === path);
    assert.deepEqual(entry, { path, to: copyOf(dest, path), sha256: sha(text), copied: true });
    assert.equal(readFileSync(copyOf(dest, path), 'utf8'), text);
    assert.equal(existsSync(join(repo.dir, path)), false, path);
  }
  assert.deepEqual(tracked(repo), Object.keys(UNATTRIBUTED).sort());
  assert.ok(existsSync(join(repo.dir, TRIAL, 'backend/log.txt')));
  assert.match(repo.git(['ls-files', '--', `${TRIAL}/backend/log.txt`]), /log\.txt/);
});

test('a patch outside a recognised repo dir is reported for the user and left tracked and in place', () => {
  const { repo, dest, git } = trialRepo();
  const out = relocate({ repo: repo.dir, dest, apply: true, git });
  assert.deepEqual(out.unattributed, Object.keys(UNATTRIBUTED).sort());
  for (const path of Object.keys(UNATTRIBUTED)) assert.ok(existsSync(join(repo.dir, path)), path);
  assert.equal(existsSync(join(dest, TRIAL_DIR, 'other')), false);
});

test('every copy is verified before the first removal from the index', () => {
  const { repo, dest, git } = trialRepo();
  const seen = [];
  const watching = (args, opts) => {
    if (args.includes('rm')) seen.push(Object.entries(PATCHES).every(([path, text]) => existsSync(copyOf(dest, path)) && sha(readFileSync(copyOf(dest, path))) === sha(text)));
    return git(args, opts);
  };
  relocate({ repo: repo.dir, dest, apply: true, git: watching });
  assert.deepEqual(seen, [true]);
});

test('a copy whose sha256 differs aborts before any removal and keeps the copies made', () => {
  const { repo, dest, git } = trialRepo();
  const corrupt = (from, to, mode) => {
    copyFileSync(from, to, mode);
    if (to.endsWith('00001-new.patch')) writeFileSync(to, 'damaged\n');
  };
  assert.throws(() => relocate({ repo: repo.dir, dest, apply: true, git, copyFile: corrupt }), /00001-new\.patch[\s\S]*nothing was removed/);
  assert.deepEqual(tracked(repo), [...Object.keys(PATCHES), ...Object.keys(UNATTRIBUTED)].sort());
  for (const path of Object.keys(PATCHES)) {
    assert.ok(existsSync(join(repo.dir, path)), path);
    assert.ok(existsSync(copyOf(dest, path)), path);
  }
  assert.equal(repo.git(['status', '--porcelain']), '');
});

test('a different file already at a copy path stops before anything is copied or removed; an identical one is reused', () => {
  const { repo, dest, git } = trialRepo();
  const [first, second] = Object.keys(PATCHES).sort();
  mkdirSync(dirname(copyOf(dest, first)), { recursive: true });
  writeFileSync(copyOf(dest, first), 'someone else\n');
  assert.throws(() => relocate({ repo: repo.dir, dest, apply: true, git }), new RegExp(copyOf(dest, first).replace(/[.]/g, '\\.')));
  assert.equal(existsSync(copyOf(dest, second)), false);
  assert.deepEqual(tracked(repo), [...Object.keys(PATCHES), ...Object.keys(UNATTRIBUTED)].sort());

  writeFileSync(copyOf(dest, first), PATCHES[first]);
  const out = relocate({ repo: repo.dir, dest, apply: true, git });
  assert.equal(out.files.find(f => f.path === first).copied, false);
  assert.equal(out.files.find(f => f.path === second).copied, true);
  assert.deepEqual(out.removed, [first, second]);
});

test('a patch whose working copy differs from the index, or is missing, is refused before anything is copied', () => {
  const { repo, dest, git } = trialRepo();
  const [first, second] = Object.keys(PATCHES).sort();
  writeFileSync(join(repo.dir, first), 'edited\n');
  rmSync(join(repo.dir, second));
  assert.throws(() => relocate({ repo: repo.dir, dest, apply: true, git }), err => {
    assert.ok(err.message.includes(first) && err.message.includes(second), err.message);
    return true;
  });
  assert.equal(existsSync(dest), false);
  assert.deepEqual(tracked(repo), [...Object.keys(PATCHES), ...Object.keys(UNATTRIBUTED)].sort());
});

test('a destination inside a git work tree is refused', () => {
  const { repo, git } = trialRepo();
  const inside = join(repo.dir, 'copies');
  assert.throws(() => relocate({ repo: repo.dir, dest: inside, apply: true, git }), /inside the git work tree/);
  assert.equal(existsSync(inside), false);
  assert.deepEqual(tracked(repo), [...Object.keys(PATCHES), ...Object.keys(UNATTRIBUTED)].sort());
});
