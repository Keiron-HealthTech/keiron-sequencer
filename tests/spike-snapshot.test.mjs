import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../scripts/spike.mjs';
import { parsePatchName } from '../scripts/backfill/patch-map.mjs';
import { gitRunner } from '../scripts/lib/spike/exec.mjs';
import { cardPatchName, oldSideRanges, parseCardPatchName, rangesOverlap, snapshot } from '../scripts/lib/spike/snapshot.mjs';
import { changedSinceLast } from '../scripts/lib/spike/typecheck.mjs';
import { makeRepo, SANDBOX_ENV, sandboxGit, tempDir } from './helpers/git-sandbox.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import { issue, notes, PROJECT_URL, SLUG, spikeFixture, twoRepoFixture, walk } from './helpers/spike-fixture.mjs';

guardNetwork();

const git = gitRunner({ env: SANDBOX_ENV });
const touched = patch => [...patch.matchAll(/^diff --git a\/(\S+) /gm)].map(m => m[1]);
const treeOf = cwd => { sandboxGit(['add', '-A'], { cwd }); return sandboxGit(['write-tree'], { cwd }).trim(); };

function sandbox() {
  const repo = makeRepo();
  after(repo.dispose);
  return { repo, state: { path: repo.dir, last: repo.git(['rev-parse', 'HEAD^{tree}']).trim() } };
}

test('a snapshot with paths stages only those paths; the next full snapshot holds the rest', () => {
  const { repo, state } = sandbox();
  writeFileSync(join(repo.dir, 'README.md'), '# sandbox\nfixup\n');
  writeFileSync(join(repo.dir, 'src', 'index.js'), 'export const one = 2\n');

  const fixup = snapshot(git, state, { paths: ['README.md'] });
  assert.deepEqual(touched(fixup.patch), ['README.md']);
  state.last = fixup.tree;

  const rest = snapshot(git, state);
  assert.deepEqual(touched(rest.patch), ['src/index.js']);
  state.last = rest.tree;
  assert.equal(snapshot(git, state), null);
  assert.equal(repo.git(['rev-list', '--count', '--all']).trim(), '1');
});

test('two consecutive snapshots apply in order on a clean checkout of the base and reproduce the tree, with no commit made', () => {
  const { repo, state } = sandbox();
  writeFileSync(join(repo.dir, 'README.md'), '# sandbox\na\n');
  const first = snapshot(git, state);
  state.last = first.tree;
  writeFileSync(join(repo.dir, 'src', 'index.js'), 'export const one = 2\n');
  const second = snapshot(git, state);
  state.last = second.tree;
  assert.deepEqual([touched(first.patch), touched(second.patch)], [['README.md'], ['src/index.js']]);

  const clean = join(tempDir('keiron-sequencer-snapshot-clean-'), 'clean');
  after(() => rmSync(join(clean, '..'), { recursive: true, force: true }));
  sandboxGit(['clone', '-q', repo.dir, clean]);
  for (const [i, s] of [first, second].entries()) {
    writeFileSync(join(clean, '..', `${i}.patch`), s.patch);
    sandboxGit(['apply', '--binary', join(clean, '..', `${i}.patch`)], { cwd: clean });
  }
  assert.equal(treeOf(clean), second.tree);

  assert.equal(repo.git(['rev-list', '--count', '--all']).trim(), '1');
  assert.deepEqual(repo.git(['reflog', '--format=%gs']).trim().split('\n'), ['commit (initial): initial']);
});

test('an ignored file stays out of the snapshot and a binary change is carried as a binary diff', () => {
  const { repo, state } = sandbox();
  writeFileSync(join(repo.dir, '.gitignore'), '*.log\n');
  writeFileSync(join(repo.dir, 'debug.log'), 'noise\n');
  writeFileSync(join(repo.dir, 'logo.bin'), Buffer.from([0, 1, 2, 3, 0, 255, 254, 0]));
  const snap = snapshot(git, state);
  assert.deepEqual(touched(snap.patch).sort(), ['.gitignore', 'logo.bin']);
  assert.match(snap.patch, /^GIT binary patch$/m);
});

test('the patch format holds against a repo config that changes diff prefixes, colors or runs an external diff', () => {
  const { repo, state } = sandbox();
  for (const [k, v] of [['diff.noprefix', 'true'], ['diff.mnemonicPrefix', 'true'], ['diff.external', 'false'], ['color.diff', 'always'], ['color.ui', 'always']]) {
    repo.git(['config', k, v]);
  }
  writeFileSync(join(repo.dir, 'README.md'), '# sandbox\nchanged\n');
  const snap = snapshot(git, state);
  assert.match(snap.patch, /^diff --git a\/README\.md b\/README\.md$/m);
  assert.match(snap.patch, /^--- a\/README\.md$/m);
  assert.match(snap.patch, /^\+\+\+ b\/README\.md$/m);
  assert.doesNotMatch(snap.patch, /\x1b\[/);
});

test('card patches are named by the card number padded to 5 digits and the origin, and parse back to the card and kind', () => {
  assert.equal(cardPatchName('CRM-123', 'thin-spike'), '00123-new.patch');
  assert.equal(cardPatchName('CRM-123', 'existing-pr'), '00123-existing.patch');
  assert.equal(cardPatchName('OPS-98765', 'thin-spike'), '98765-new.patch');
  assert.deepEqual(parseCardPatchName('backend/00123-new.patch'), { kind: 'card', card: 'CRM-123', origin: 'thin-spike' });
  assert.deepEqual(parseCardPatchName('backend/00123-existing.patch'), { kind: 'card', card: 'CRM-123', origin: 'existing-pr' });
  assert.deepEqual(parseCardPatchName('web/98765-new.patch', { prefix: 'OPS' }), { kind: 'card', card: 'OPS-98765', origin: 'thin-spike' });
  for (const name of ['backend/123-new.patch', 'backend/00007-test-fix.patch', 'backend/00042-existing+fixup-extra.patch', 'backend/fixup-1-from-3-x.patch']) {
    assert.equal(parseCardPatchName(name), null, name);
  }
  for (const name of ['backend/00123-new.patch', 'backend/00123-existing.patch']) assert.equal(parsePatchName(name), null, name);
});

async function startCard(fixture, card = 'CRM-1') {
  const { deps, home, at } = fixture;
  const { runId } = JSON.parse((await run(['begin', PROJECT_URL], deps)).stdout);
  const dir = join(home, SLUG, 'runs', runId);
  at('2026-11-10T10:01:00.000Z');
  assert.equal(JSON.parse((await run(['next'], deps)).stdout).card, card);
  mkdirSync(join(dir, 'notes'), { recursive: true });
  writeFileSync(join(dir, 'notes', `${card}.json`), JSON.stringify(notes));
  return dir;
}

test('each repo keeps its own last tree: a card that changes only one repo leaves the other unmoved and reports it as no change', async () => {
  const fixture = twoRepoFixture();
  const dir = await startCard(fixture);
  const back = JSON.parse((await run(['tree', 'backend'], fixture.deps)).stdout).path;
  await run(['tree', 'frontend'], fixture.deps);
  const before = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')).tracks.t1.repos;
  writeFileSync(join(back, 'README.md'), 'changed\n');
  fixture.at('2026-11-10T10:05:00.000Z');
  const r = await run(['end', 'CRM-1'], fixture.deps);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.patches, ['backend/00001-new.patch']);
  assert.deepEqual(out.noChange, ['frontend']);
  const after = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')).tracks.t1.repos;
  assert.notEqual(after.backend.last, before.backend.last);
  assert.equal(after.frontend.last, before.frontend.last);
  assert.deepEqual(after.frontend.log, []);
  assert.deepEqual(walk(join(dir, 'patches')), ['backend/00001-new.patch']);
});

test('the patch of an existing-PR card is named <n5>-existing.patch and holds the applied PR diff', async () => {
  const prs = [{ number: 41, title: '[CRM-1] feature', url: 'https://github.com/acme/backend/pull/41', isDraft: false }];
  const diff = 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n # sandbox\n+from the pr\n';
  const fixture = spikeFixture({ issues: [issue('CRM-1')], gh: argv => (argv[1] === 'list' ? JSON.stringify(prs) : diff) });
  const dir = await startCard(fixture);
  await run(['tree', 'backend'], fixture.deps);
  fixture.at('2026-11-10T10:05:00.000Z');
  const r = await run(['end', 'CRM-1'], fixture.deps);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(walk(join(dir, 'patches')), ['backend/00001-existing.patch']);
  assert.match(readFileSync(join(dir, 'patches', 'backend', '00001-existing.patch'), 'utf8'), /^\+from the pr$/m);
});

const U3 = [
  'diff --git a/src/a.js b/src/a.js', 'index 1111111..2222222 100644', '--- a/src/a.js', '+++ b/src/a.js',
  '@@ -8,7 +8,8 @@ fn', ' l8', ' l9', ' l10', '-l11', '+l11 changed', '+l11b', ' l12', ' l13', ' l14',
  '@@ -40,6 +41,5 @@', ' l40', ' l41', ' l42', '-l43', ' l44', ' l45', '\\ No newline at end of file',
  'diff --git a/src/b.js b/src/b.js', 'index 3333333..4444444 100644', '--- a/src/b.js', '+++ b/src/b.js',
  '@@ -1,3 +1,4 @@', ' b1', ' b2', ' b3', '+b4', '',
].join('\n');

test('oldSideRanges reads a -U3 card patch', () => {
  const ranges = oldSideRanges(U3);
  assert.deepEqual(ranges.get('src/a.js'), [[11, 11], [43, 43]]);
  assert.deepEqual(ranges.get('src/b.js'), [[3, 3]]);
  const u0 = ['diff --git a/x.js b/x.js', '--- a/x.js', '+++ b/x.js', '@@ -5,2 +5,3 @@', '-a', '-b', '+a', '+b', '+c', '@@ -20,0 +22,1 @@', '+d', '@@ -0,0 +1 @@', '+top', ''].join('\n');
  assert.deepEqual(oldSideRanges(u0).get('x.js'), [[1, 1], [5, 6], [20, 20]]);
});

test('rangesOverlap honors the margin and returns the intersections', () => {
  assert.deepEqual(rangesOverlap([[10, 12]], [[14, 20]], { margin: 0 }), []);
  assert.deepEqual(rangesOverlap([[10, 12]], [[14, 20]], { margin: 3 }), [[14, 15]]);
  assert.deepEqual(rangesOverlap([[10, 12], [30, 30]], [[11, 11], [29, 40]], { margin: 0 }), [[11, 11], [30, 30]]);
  assert.deepEqual(rangesOverlap([[1, 2]], [[4, 9]], { margin: 5 }), [[4, 7]]);
});

test('a generated typecheck tsconfig left in a tree never lands in a snapshot or in the changed paths', () => {
  const repo = makeRepo();
  try {
    const last = treeOf(repo.dir);
    writeFileSync(join(repo.dir, 'tsconfig.keiron-sequencer-typecheck.json'), '{"files":["x.ts"]}\n');
    writeFileSync(join(repo.dir, 'README.md'), '# changed\n');
    const r = { path: repo.dir, last };
    assert.deepEqual(changedSinceLast(git, r), ['README.md']);
    const snap = snapshot(git, r);
    assert.deepEqual(touched(snap.patch), ['README.md']);
  } finally {
    repo.dispose();
  }
});
