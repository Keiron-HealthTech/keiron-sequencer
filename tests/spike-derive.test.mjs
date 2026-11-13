import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../scripts/spike.mjs';
import { verdict } from '../scripts/lib/records.mjs';
import { deriveRepo, mergeRiskAreas, newPaths, riskAreas } from '../scripts/lib/spike/derive.mjs';
import { gitRunner } from '../scripts/lib/spike/exec.mjs';
import { makeRepo, SANDBOX_ENV } from './helpers/git-sandbox.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import { issue, notes, PROJECT_URL, SLUG, spikeFixture } from './helpers/spike-fixture.mjs';

guardNetwork();

const git = gitRunner({ env: SANDBOX_ENV });
const RULES = [{ kind: 'migrations', paths: ['db/migrations/*'] }, { kind: 'authorization', paths: ['**/guards/**'] }];

test('risk areas come from the repo\'s own globs, one entry per kind, kinds and paths sorted and prefixed by the repo dir', () => {
  assert.deepEqual(riskAreas('backend', ['src/guards/z.ts', 'db/migrations/001.ts', 'src/a.ts', 'src/guards/a.ts'], RULES), [
    { kind: 'authorization', paths: ['backend/src/guards/a.ts', 'backend/src/guards/z.ts'] },
    { kind: 'migrations', paths: ['backend/db/migrations/001.ts'] },
  ]);
  assert.deepEqual(riskAreas('backend', ['src/a.ts'], RULES), []);
  assert.deepEqual(riskAreas('frontend', ['db/migrations/001.ts'], []), []);
});

test('pii-in-logs is only ever the attested paths, appended as given; file contents are never an input', () => {
  assert.deepEqual(riskAreas('backend', ['src/logger.ts'], RULES, ['backend/src/logger.ts']), [{ kind: 'pii-in-logs', paths: ['backend/src/logger.ts'] }]);
  assert.deepEqual(riskAreas('backend', ['src/logger.ts'], RULES), []);
});

test('risk areas of several repos merge into one entry per kind with distinct sorted paths', () => {
  const merged = mergeRiskAreas([
    [{ kind: 'migrations', paths: ['web/db/migrations/1.ts'] }],
    [{ kind: 'migrations', paths: ['backend/db/migrations/1.ts'] }, { kind: 'authorization', paths: ['backend/g.ts'] }],
    [{ kind: 'pii-in-logs', paths: ['backend/l.ts'] }, { kind: 'pii-in-logs', paths: ['backend/l.ts'] }],
  ]);
  assert.deepEqual(merged, [
    { kind: 'authorization', paths: ['backend/g.ts'] },
    { kind: 'migrations', paths: ['backend/db/migrations/1.ts', 'web/db/migrations/1.ts'] },
    { kind: 'pii-in-logs', paths: ['backend/l.ts'] },
  ]);
});

test('new paths are new top-level entries only: a nested add names its dir with a slash, a root file has none', () => {
  assert.deepEqual(newPaths('backend', ['newsvc/a/b.ts', 'README2.md', 'src/new.js', 'newsvc/c.ts'], ['README.md', 'src']), ['backend/README2.md', 'backend/newsvc/']);
  assert.deepEqual(newPaths('backend', ['src/deep/new.js'], ['README.md', 'src']), []);
});

test('deriveRepo reads the changed and added paths between two trees of a real repo', () => {
  const repo = makeRepo();
  after(repo.dispose);
  const start = repo.git(['rev-parse', 'HEAD^{tree}']).trim();
  for (const [file, text] of [['newsvc/a/b.ts', 'x\n'], ['README2.md', 'y\n'], ['src/new.js', 'z\n'], ['db/migrations/001.sql', 'q\n'], ['src/index.js', 'changed\n']]) {
    mkdirSync(join(repo.dir, file, '..'), { recursive: true });
    writeFileSync(join(repo.dir, file), text);
  }
  rmSync(join(repo.dir, 'README.md'));
  repo.git(['add', '-A']);
  const end = repo.git(['write-tree']).trim();
  assert.deepEqual(deriveRepo(git, 'backend', { cwd: repo.dir, rules: RULES, startTree: start, endTree: end }), {
    riskAreas: [{ kind: 'migrations', paths: ['backend/db/migrations/001.sql'] }],
    newPaths: ['backend/README2.md', 'backend/db/', 'backend/newsvc/'],
  });
  assert.deepEqual(deriveRepo(git, 'backend', { cwd: repo.dir, rules: RULES, startTree: end, endTree: end }), { riskAreas: [], newPaths: [] });
});

test('end records risk areas and novelty from the card\'s start tree, so a dir added by an earlier card is not new again', async () => {
  const { deps, home, dataDir, at } = spikeFixture({
    issues: [issue('CRM-1'), issue('CRM-2')],
    config: config => ({ ...config, repos: { backend: { ...config.repos.backend, risk: RULES } } }),
  });
  const { runId } = JSON.parse((await run(['begin', PROJECT_URL], deps)).stdout);
  const dir = join(home, SLUG, 'runs', runId);
  mkdirSync(join(dir, 'notes'), { recursive: true });
  writeFileSync(join(dir, 'notes', 'CRM-1.json'), JSON.stringify({ ...notes, piiInLogs: ['backend/newsvc/log.ts'] }));
  writeFileSync(join(dir, 'notes', 'CRM-2.json'), JSON.stringify(notes));

  at('2026-11-10T10:01:00.000Z');
  await run(['next'], deps);
  const tree = JSON.parse((await run(['tree', 'backend'], deps)).stdout).path;
  mkdirSync(join(tree, 'newsvc'));
  writeFileSync(join(tree, 'newsvc', 'log.ts'), 'log()\n');
  at('2026-11-10T10:05:00.000Z');
  assert.equal((await run(['end', 'CRM-1'], deps)).code, 0);

  at('2026-11-10T10:06:00.000Z');
  await run(['next'], deps);
  mkdirSync(join(tree, 'db', 'migrations'), { recursive: true });
  writeFileSync(join(tree, 'db', 'migrations', '002.sql'), 'q\n');
  writeFileSync(join(tree, 'newsvc', 'more.ts'), 'more()\n');
  at('2026-11-10T10:09:00.000Z');
  assert.equal((await run(['end', 'CRM-2'], deps)).code, 0);

  const first = JSON.parse(readFileSync(join(dataDir, SLUG, 'CRM-1.json'), 'utf8'));
  assert.deepEqual(first.riskAreas, [{ kind: 'pii-in-logs', paths: ['backend/newsvc/log.ts'] }]);
  assert.deepEqual(first.novelty, { newPaths: ['backend/newsvc/'] });
  const second = JSON.parse(readFileSync(join(dataDir, SLUG, 'CRM-2.json'), 'utf8'));
  assert.deepEqual(second.riskAreas, [{ kind: 'migrations', paths: ['backend/db/migrations/002.sql'] }]);
  assert.deepEqual(second.novelty, { newPaths: ['backend/db/'] });
  assert.equal(verdict(second, 'S'), 'Light');

  const state = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
  assert.equal(state.cards['CRM-2'].startTrees.backend, state.repos.backend.log[0].tree);
  assert.deepEqual(state.cards['CRM-2'].newPaths, ['backend/db/']);
});

test('a fixup made during a card counts toward that card\'s risk areas, since they span its start and end trees, but not toward its size', async () => {
  const { deps, home, dataDir, at } = spikeFixture({
    issues: [issue('CRM-1'), issue('CRM-2')],
    config: config => ({ ...config, repos: { backend: { ...config.repos.backend, risk: RULES } } }),
  });
  const { runId } = JSON.parse((await run(['begin', PROJECT_URL], deps)).stdout);
  const dir = join(home, SLUG, 'runs', runId);
  mkdirSync(join(dir, 'notes'), { recursive: true });
  for (const k of ['CRM-1', 'CRM-2']) writeFileSync(join(dir, 'notes', `${k}.json`), JSON.stringify(notes));

  at('2026-11-10T10:01:00.000Z');
  await run(['next'], deps);
  const tree = JSON.parse((await run(['tree', 'backend'], deps)).stdout).path;
  mkdirSync(join(tree, 'db', 'migrations'), { recursive: true });
  writeFileSync(join(tree, 'db', 'migrations', '001.sql'), 'create\n');
  at('2026-11-10T10:05:00.000Z');
  assert.equal((await run(['end', 'CRM-1'], deps)).code, 0);

  at('2026-11-10T10:06:00.000Z');
  await run(['next'], deps);
  writeFileSync(join(tree, 'db', 'migrations', '001.sql'), 'create, fixed\n');
  writeFileSync(join(tree, 'src', 'feature.js'), 'export const feature = 1\n');
  const fixed = await run(['fixup', '--fixes', 'CRM-1', '--slug', 'migration', '--note', 'Fixes the first migration.', '--repo', 'backend', '--', 'db/migrations/001.sql'], deps);
  assert.equal(fixed.code, 0, fixed.stderr);
  at('2026-11-10T10:09:00.000Z');
  assert.equal((await run(['end', 'CRM-2'], deps)).code, 0);

  const second = JSON.parse(readFileSync(join(dataDir, SLUG, 'CRM-2.json'), 'utf8'));
  assert.deepEqual(second.riskAreas, [{ kind: 'migrations', paths: ['backend/db/migrations/001.sql'] }]);
  assert.deepEqual(second.novelty, { newPaths: [] });
  assert.deepEqual([second.size.files, second.refs.patches], [1, ['backend/00002-new.patch']]);
  assert.equal(verdict(second, 'S'), 'No SDD');
});

test('a card with no risky path and no new top-level entry records both as empty, so its verdict is computed, not unknown', async () => {
  const { deps, home, dataDir, at } = spikeFixture();
  const { runId } = JSON.parse((await run(['begin', PROJECT_URL], deps)).stdout);
  const dir = join(home, SLUG, 'runs', runId);
  at('2026-11-10T10:01:00.000Z');
  await run(['next'], deps);
  const tree = JSON.parse((await run(['tree', 'backend'], deps)).stdout).path;
  writeFileSync(join(tree, 'src', 'index.js'), 'export const one = 2\n');
  mkdirSync(join(dir, 'notes'), { recursive: true });
  writeFileSync(join(dir, 'notes', 'CRM-1.json'), JSON.stringify(notes));
  at('2026-11-10T10:05:00.000Z');
  assert.equal((await run(['end', 'CRM-1'], deps)).code, 0);
  const record = JSON.parse(readFileSync(join(dataDir, SLUG, 'CRM-1.json'), 'utf8'));
  assert.deepEqual([record.riskAreas, record.novelty], [[], { newPaths: [] }]);
  assert.equal(verdict(record, 'S'), 'No SDD');
});
