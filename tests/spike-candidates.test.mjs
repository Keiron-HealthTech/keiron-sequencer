import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { run } from '../scripts/spike.mjs';
import { overlapCandidates } from '../scripts/lib/spike/snapshot.mjs';
import { sandboxGit } from './helpers/git-sandbox.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import { issue, notes, PROJECT_URL, SLUG, spikeFixture, twoRepoFixture, walk } from './helpers/spike-fixture.mjs';

guardNetwork();

const hunk = (path, header, body) => [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, header, ...body].join('\n');
const changed = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => `-line ${from + i}`).concat(Array.from({ length: to - from + 1 }, (_, i) => `+LINE ${from + i}`));
const EARLIER = hunk('src/list.js', '@@ -7,17 +7,17 @@', [' line 7', ' line 8', ' line 9', ...changed(10, 20), ' line 21', ' line 22', ' line 23']);

test('a working change whose old lines overlap the lines an earlier card patch changed names that card, file and range', () => {
  const working = hunk('src/list.js', '@@ -15,4 +15,4 @@', [...changed(15, 18)]);
  assert.deepEqual(overlapCandidates(working, [{ card: 'CRM-1', patch: EARLIER }]), [{ card: 'CRM-1', path: 'src/list.js', ranges: [[15, 18]] }]);
  const spanning = hunk('src/list.js', '@@ -19,4 +19,1 @@', ['-line 19', '-line 20', '-line 21', '-line 22', '+one']);
  assert.deepEqual(overlapCandidates(spanning, [{ card: 'CRM-1', patch: EARLIER }]), [{ card: 'CRM-1', path: 'src/list.js', ranges: [[19, 20]] }]);
});

test('context lines of an earlier patch, disjoint ranges and other files are not overlaps', () => {
  const near = hunk('src/list.js', '@@ -22,2 +22,2 @@', [...changed(22, 23)]);
  const elsewhere = hunk('src/other.js', '@@ -15,1 +15,1 @@', [...changed(15, 15)]);
  assert.deepEqual(overlapCandidates([near, elsewhere].join('\n'), [{ card: 'CRM-1', patch: EARLIER }]), []);
});

const LIST = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
const withLines = (from, to, word) => LIST.map((l, i) => (i + 1 >= from && i + 1 <= to ? `${word} ${i + 1}` : l)).join('\n') + '\n';

async function secondCardStarted(fixture) {
  const { deps, home, repo, at } = fixture;
  writeFileSync(join(repo.dir, 'src', 'list.js'), `${LIST.join('\n')}\n`);
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'list']);
  const { runId } = JSON.parse((await run(['begin', PROJECT_URL], deps)).stdout);
  const dir = join(home, SLUG, 'runs', runId);
  mkdirSync(join(dir, 'notes'), { recursive: true });
  writeFileSync(join(dir, 'notes', 'CRM-1.json'), JSON.stringify(notes));
  at('2026-11-10T10:01:00.000Z');
  await run(['next'], deps);
  const tree = JSON.parse((await run(['tree', 'backend'], deps)).stdout).path;
  writeFileSync(join(tree, 'src', 'list.js'), withLines(10, 20, 'first'));
  at('2026-11-10T10:02:00.000Z');
  assert.equal((await run(['end', 'CRM-1'], deps)).code, 0);
  at('2026-11-10T10:03:00.000Z');
  await run(['next'], deps);
  return { dir, tree };
}

const indexOf = tree => {
  const path = sandboxGit(['rev-parse', '--git-path', 'index'], { cwd: tree }).trim();
  return isAbsolute(path) ? path : join(tree, path);
};

test('candidates lists the earlier card whose lines the working change touches, through a temp index, and records nothing', async () => {
  const fixture = spikeFixture({ issues: [issue('CRM-1'), issue('CRM-2')] });
  const { dir, tree } = await secondCardStarted(fixture);
  writeFileSync(join(tree, 'src', 'list.js'), withLines(10, 20, 'first').replace('first 15\nfirst 16\nfirst 17\nfirst 18', 'second 15\nsecond 16\nsecond 17\nsecond 18'));
  writeFileSync(join(tree, 'README.md'), '# sandbox\nsecond card\n');
  const index = readFileSync(indexOf(tree));
  const status = sandboxGit(['status', '--porcelain'], { cwd: tree });
  const state = readFileSync(join(dir, 'run.json'), 'utf8');
  const patches = walk(join(dir, 'patches'));
  const data = walk(fixture.dataDir).map(f => readFileSync(join(fixture.dataDir, f), 'utf8'));

  const r = await run(['candidates'], fixture.deps);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { action: 'candidates', candidates: [{ card: 'CRM-1', repo: 'backend', path: 'src/list.js', ranges: [[15, 18]] }] });

  assert.deepEqual(readFileSync(indexOf(tree)), index);
  assert.equal(sandboxGit(['status', '--porcelain'], { cwd: tree }), status);
  assert.equal(existsSync(join(dir, 'tmp.index')), false);
  assert.equal(readFileSync(join(dir, 'run.json'), 'utf8'), state);
  assert.deepEqual(walk(join(dir, 'patches')), patches);
  assert.deepEqual(walk(fixture.dataDir).map(f => readFileSync(join(fixture.dataDir, f), 'utf8')), data);
});

test('a working change outside the earlier card\'s lines has no candidate, and --repo limits the scan', async () => {
  const fixture = twoRepoFixture({ issues: [issue('CRM-1'), issue('CRM-2')] });
  const { tree } = await secondCardStarted(fixture);
  writeFileSync(join(tree, 'src', 'list.js'), withLines(10, 20, 'first').replace('line 28\n', 'second 28\n'));
  const r = await run(['candidates'], fixture.deps);
  assert.deepEqual(JSON.parse(r.stdout).candidates, []);
  assert.equal((await run(['candidates', '--repo', 'frontend'], fixture.deps)).code, 1);
  assert.equal((await run(['candidates', '--repo', 'backend'], fixture.deps)).code, 0);
});
