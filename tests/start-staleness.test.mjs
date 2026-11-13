import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gitRunner } from '../scripts/lib/spike/exec.mjs';
import { runDir } from '../scripts/lib/spike/home.mjs';
import { runBaseCommit, runChain } from '../scripts/lib/spike/run-base.mjs';
import { hunkOverlap, STALENESS_CAP, staleness, stalenessFiles } from '../scripts/lib/start/staleness.mjs';
import { fakeGit } from './helpers/fake-git.mjs';
import { makeRepo, SANDBOX_ENV, tempDir } from './helpers/git-sandbox.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import { CARD, fakeStartFixture, GIT_BRANCH_NAME, SLUG, startIssue, startRecord } from './helpers/start-fixture.mjs';

guardNetwork();

const SPIKED = '2026-11-01T10:00:00.000Z';
const sha = n => String(n).padStart(40, '0');
const logOf = commits => commits.map(([n, subject, files]) => `\x1e${sha(n)}\t${subject}\n\n${files.join('\n')}\n`).join('');

const inputs = (over = {}) => ({
  cwd: '/fake/checkout', remote: 'origin', baseRef: 'main', tracking: { main: sha(99) }, files: ['src/a.js'], filesFrom: 'patches',
  spikedAt: SPIKED, baseCommit: null, projectKeys: ['ABC-1', 'ABC-2', 'ABC-3'], cardKey: CARD, blockerPrNumbers: [7], unchecked: [], ...over,
});

test('commits since the spike are grouped as this card, a sibling by key or by merged blocker PR, and unrelated', () => {
  const git = fakeGit({
    log: logOf([
      [1, '[ABC-1] read the card', ['src/a.js']],
      [2, 'feat: siblings (ABC-2)', ['src/a.js', 'src/b.js']],
      [3, 'Merge the blocker (#7)', ['src/a.js']],
      [4, 'chore: bump', ['src/a.js']],
      [5, 'fix: ABC-10 and [ABC-30]', ['src/a.js']],
    ]),
  });
  const out = staleness(git.run, inputs());
  assert.equal(out.computed, true);
  assert.deepEqual(out.groups.self.commits, [{ sha: sha(1), subject: '[ABC-1] read the card', files: ['src/a.js'] }]);
  assert.deepEqual(out.groups.sibling.commits.map(c => c.sha), [sha(2), sha(3)]);
  assert.deepEqual(out.groups.unrelated.commits.map(c => c.sha), [sha(4), sha(5)]);
  assert.deepEqual([out.groups.self.more, out.groups.sibling.more, out.groups.unrelated.more], [0, 0, 0]);
  assert.deepEqual([out.anchor, out.since, out.ref, out.filesFrom], ['spikedAt', SPIKED, 'origin/main', 'patches']);
});

test('the log is one read of the remote base ref since the spike, on the files only, in the checkout', () => {
  const git = fakeGit({ log: '' });
  staleness(git.run, inputs({ files: ['src/a.js', 'src/b c.js'] }));
  assert.deepEqual(git.calls.map(c => [c.argv, c.cwd]), [[
    ['--literal-pathspecs', 'log', `--since=${SPIKED}`, '--format=%x1e%H%x09%s', '--name-only', 'origin/main', '--', 'src/a.js', 'src/b c.js'],
    '/fake/checkout',
  ]]);
});

test('a base branch only in this checkout is read from the local branch, with no fetched ref needed', () => {
  const git = fakeGit({ log: '' });
  const out = staleness(git.run, inputs({ baseRef: 'user/abc-2-x', local: true, tracking: {} }));
  assert.deepEqual([out.computed, out.ref], [true, 'refs/heads/user/abc-2-x']);
  assert.equal(git.calls[0].argv[5], 'refs/heads/user/abc-2-x');
});

test(`each group is capped at ${STALENESS_CAP} with the rest counted`, () => {
  assert.equal(STALENESS_CAP, 10);
  const git = fakeGit({ log: logOf(Array.from({ length: 30 }, (_, i) => [i + 1, `chore: ${i + 1}`, ['src/a.js']])) });
  const out = staleness(git.run, inputs());
  assert.equal(out.groups.unrelated.commits.length, 10);
  assert.equal(out.groups.unrelated.more, 20);
});

test('no spikedAt, no files or an unfetched base ref is not computed, says why and runs no git', () => {
  for (const [over, why] of [
    [{ spikedAt: null }, /spikedAt/],
    [{ files: [] }, /no patch files and no record paths/],
    [{ baseRef: 'user/abc-2-x' }, /origin\/user\/abc-2-x is not fetched/],
  ]) {
    const git = fakeGit({});
    const out = staleness(git.run, inputs(over));
    assert.equal(out.computed, false);
    assert.match(out.reason, why);
    assert.deepEqual(git.calls, []);
    assert.deepEqual(out.groups.self, { commits: [], more: 0 });
  }
});

test('the run baseCommit is an ancestor at 0, forked otherwise, absent when this clone lacks it, and unread with none', () => {
  const at = revList => staleness(fakeGit({ log: '', 'rev-list': revList }).run, inputs({ baseCommit: sha(42) })).baseCommit;
  assert.deepEqual(at('0\n'), { sha: sha(42), status: 'ancestor' });
  assert.deepEqual(at('3\n'), { sha: sha(42), status: 'forked' });
  assert.deepEqual(at({ status: 128, stderr: 'fatal: bad revision' }), { sha: sha(42), status: 'absent', note: 'baseCommit not in this clone' });
  const git = fakeGit({ log: '' });
  assert.deepEqual(staleness(git.run, inputs()).baseCommit, { sha: null, status: null });
  assert.ok(!git.calls.some(c => c.sub === 'rev-list'));
  const reads = fakeGit({ log: '', 'rev-list': '0\n' });
  staleness(reads.run, inputs({ baseCommit: sha(42) }));
  assert.deepEqual(reads.calls.find(c => c.sub === 'rev-list').argv, ['rev-list', '--count', `origin/main..${sha(42)}`]);
});

test('a failing log read is not swallowed', () => {
  const git = fakeGit({ log: { status: 128, stderr: 'fatal: bad object' } });
  assert.throws(() => staleness(git.run, inputs()), /bad object/);
});

test('the files are the current repo patch files, else the record risk and new paths, else none', () => {
  const record = startRecord(CARD, { riskAreas: [{ kind: 'auth', paths: ['src/z.js'] }], novelty: { newPaths: ['src/new.js'] } });
  const isCurrent = dir => dir === 'app-repo';
  const patches = [
    { ref: 'app-repo/a.patch', repoDir: 'app-repo', location: 'run', files: ['src/b.js', 'src/a.js'] },
    { ref: 'web/a.patch', repoDir: 'web', location: 'run', files: ['web/x.js'] },
  ];
  assert.deepEqual(stalenessFiles({ patches, record, isCurrent }), { files: ['src/a.js', 'src/b.js'], filesFrom: 'patches' });
  const pruned = patches.map(p => ({ ...p, location: null, files: [] }));
  assert.deepEqual(stalenessFiles({ patches: pruned, record, isCurrent }), { files: ['src/new.js', 'src/z.js'], filesFrom: 'record' });
  const bare = startRecord(CARD, { riskAreas: [], novelty: { newPaths: [] } });
  assert.deepEqual(stalenessFiles({ patches: [], record: bare, isCurrent }), { files: [], filesFrom: null });
});

test('on real git, only commits after spikedAt that touch the files are reported, read from the remote-tracking ref', () => {
  const repo = makeRepo();
  try {
    const commit = (file, subject, date) => {
      mkdirSync(dirname(join(repo.dir, file)), { recursive: true });
      writeFileSync(join(repo.dir, file), `${subject}\n`);
      repo.git(['add', '-A']);
      const env = { ...SANDBOX_ENV, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date };
      const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', subject], { cwd: repo.dir, env, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
    };
    commit('src/a.js', 'before the spike', '2026-10-30T10:00:00Z');
    commit('src/other.js', 'after, other file', '2026-11-02T10:00:00Z');
    commit('src/a.js', '[ABC-2] after, same file', '2026-11-03T10:00:00Z');
    repo.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    const git = gitRunner({ env: SANDBOX_ENV });
    const out = staleness(git, inputs({ cwd: repo.dir, tracking: { main: repo.git(['rev-parse', 'HEAD']).trim() } }));
    const all = [...out.groups.self.commits, ...out.groups.sibling.commits, ...out.groups.unrelated.commits];
    assert.deepEqual(all.map(c => [c.subject, c.files]), [['[ABC-2] after, same file', ['src/a.js']]]);
    assert.equal(out.groups.sibling.commits.length, 1);
  } finally {
    repo.dispose();
  }
});

const planOf = async (t, opts, argv = ['plan', CARD]) => {
  const f = fakeStartFixture(opts);
  t.after(f.dispose);
  const r = await f.run(argv);
  return { f, r, out: r.code === 0 ? JSON.parse(r.stdout) : null };
};

test('the plan reports staleness on the decided base from the record paths, and other repos as unchecked', async t => {
  const { f, out, r } = await planOf(t, { git: { log: logOf([[1, 'chore: touch', ['src/start.js']]]) } });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual([out.staleness.computed, out.staleness.filesFrom, out.staleness.ref], [true, 'record', 'origin/main']);
  assert.deepEqual(out.staleness.groups.unrelated.commits.map(c => c.subject), ['chore: touch']);
  assert.deepEqual(out.staleness.unchecked, []);
  const log = f.git.calls.find(c => c.sub === 'log');
  assert.deepEqual(log.argv.slice(-2), ['--', 'src/start.js']);
});

test('a plan with no record, or one that stops at the card, does not compute staleness and runs no log', async t => {
  const none = await planOf(t, { records: [] });
  assert.deepEqual([none.out.staleness.computed, none.out.staleness.reason], [false, 'no record']);
  assert.ok(!none.f.git.calls.some(c => c.sub === 'log'));
  const other = await planOf(t, { git: { remotes: 'origin\tgit@github.com:acme/else.git (fetch)\n', commonDir: '/elsewhere/.git' } });
  assert.equal(other.out.action, 'stop');
  assert.equal(other.out.staleness.computed, false);
  assert.ok(!other.f.git.calls.some(c => c.sub === 'log'));
});

test('a failing log read in the plan exits 1', async t => {
  const { r } = await planOf(t, { git: { log: { status: 128, stderr: 'fatal: log broke' } } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /log broke/);
});

const blocks = { relations: { nodes: [{ type: 'blocks', relatedIssue: { identifier: CARD } }] } };

test('the plan reads the current repo patch files, the run baseCommit and the merged blocker PR numbers', async t => {
  const runId = '20261101T100000Z';
  const record = startRecord(CARD, { refs: { engram: [], patches: ['app-repo/ABC-1.patch'], linear: null, runId } });
  const issues = [startIssue(CARD, { gitBranchName: GIT_BRANCH_NAME }), startIssue('ABC-2', { state: { name: 'Done', type: 'completed' }, ...blocks })];
  const merged = { number: 7, state: 'MERGED', isDraft: false, mergedAt: '2026-11-05T00:00:00Z', baseRefName: 'main', headRefName: 'x', title: '[ABC-2] x', url: 'https://github.com/acme/app/pull/7' };
  const f = fakeStartFixture({
    issues, records: [record], gh: argv => (argv.includes('ABC-2') ? JSON.stringify([merged]) : '[]'),
    git: { log: logOf([[1, 'Land the blocker (#7)', ['src/p.js']]]), revList: '2\n' },
  });
  t.after(f.dispose);
  const dir = runDir(f.home, SLUG, runId);
  mkdirSync(join(dir, 'patches', 'app-repo'), { recursive: true });
  writeFileSync(join(dir, 'patches', 'app-repo', 'ABC-1.patch'), 'diff --git a/src/p.js b/src/p.js\n+x\n');
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ repos: { app: { baseCommit: sha(42) } } }));
  const r = await f.run(['plan', CARD]);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout).staleness;
  assert.deepEqual([out.filesFrom, out.baseCommit], ['patches', { sha: sha(42), status: 'forked' }]);
  assert.deepEqual(out.groups.sibling.commits.map(c => c.subject), ['Land the blocker (#7)']);
  assert.deepEqual(f.git.calls.find(c => c.sub === 'log').argv.slice(-2), ['--', 'src/p.js']);
});

test('a stack base whose branch is not fetched yet is not computed, with no log read', async t => {
  const issues = [startIssue(CARD, { gitBranchName: GIT_BRANCH_NAME }), startIssue('ABC-2', { state: { name: 'In Progress', type: 'started' }, ...blocks })];
  const open = { number: 2, state: 'OPEN', isDraft: false, mergedAt: null, baseRefName: 'main', headRefName: 'user/abc-2-x', title: '[ABC-2] x', url: 'https://github.com/acme/app/pull/2' };
  const { f, out } = await planOf(t, { issues, gh: argv => (argv.includes('ABC-2') ? JSON.stringify([open]) : '[]') });
  assert.equal(out.base.kind, 'stack');
  assert.deepEqual([out.staleness.computed, out.staleness.ref], [false, 'origin/user/abc-2-x']);
  assert.match(out.staleness.reason, /not fetched/);
  assert.ok(!f.git.calls.some(c => c.sub === 'log'));
});

// A 50-line src/list.js at the spike base, a -U3 card patch on line 10, and default-branch commits on top of the base.
function hunkRepo() {
  const repo = makeRepo();
  const lines = Array.from({ length: 50 }, (_, i) => `line${i + 1}`);
  const write = edit => writeFileSync(join(repo.dir, 'src', 'list.js'), `${lines.map((l, i) => edit[i + 1] ?? l).join('\n')}\n`);
  write({});
  repo.git(['add', '-A']);
  const dated = { ...SANDBOX_ENV, GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z', GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z' };
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'base'], { cwd: repo.dir, env: dated, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const base = repo.git(['rev-parse', 'HEAD']).trim();
  write({ 10: 'line10 from the card' });
  const cardPatch = repo.git(['diff', '-U3', '--src-prefix=a/', '--dst-prefix=b/']);
  repo.git(['checkout', '-q', '--', '.']);
  const onDefault = edit => {
    write(edit);
    repo.git(['commit', '-q', '-am', 'default']);
    repo.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  };
  const run = over => hunkOverlap(gitRunner({ env: SANDBOX_ENV }), {
    cwd: repo.dir, ref: 'origin/main', baseCommit: base, files: ['src/list.js'], patchTexts: [cardPatch], chainedFiles: [], combine: false, ...over,
  });
  return { repo, onDefault, run };
}

test('a default-branch commit in another hunk of the same file is not stale', () => {
  const h = hunkRepo();
  try {
    h.onDefault({ 40: 'line40 on default' });
    assert.deepEqual(h.run(), { level: 'hunk', overlap: [], fallback: null });
  } finally { h.repo.dispose(); }
});

test('an overlapping hunk is stale with overlap ranges', () => {
  const h = hunkRepo();
  try {
    h.onDefault({ 12: 'line12 on default', 40: 'line40 on default' });
    assert.deepEqual(h.run(), { level: 'hunk', overlap: [{ path: 'src/list.js', ranges: [[12, 12]] }], fallback: null });
    assert.deepEqual(h.run({ margin: 0 }).overlap, []);
  } finally { h.repo.dispose(); }
});

test('no base commit falls back to file level', () => {
  const h = hunkRepo();
  try {
    h.onDefault({ 40: 'line40 on default' });
    assert.deepEqual(h.run({ baseCommit: null }), { level: 'file', overlap: [], fallback: 'no-base' });
    assert.deepEqual(h.run({ baseCommit: 'f'.repeat(40) }), { level: 'file', overlap: [], fallback: 'no-base' });
  } finally { h.repo.dispose(); }
});

test('a file chained through an earlier card falls back to file level', () => {
  const h = hunkRepo();
  try {
    h.onDefault({ 40: 'line40 on default' });
    assert.deepEqual(h.run({ chainedFiles: ['src/list.js'] }), { level: 'file', overlap: [{ path: 'src/list.js', ranges: null }], fallback: 'chained' });
  } finally { h.repo.dispose(); }
});

test('a combine base falls back to file level', () => {
  const h = hunkRepo();
  try {
    h.onDefault({ 40: 'line40 on default' });
    assert.deepEqual(h.run({ combine: true }), { level: 'file', overlap: [], fallback: 'combine' });
  } finally { h.repo.dispose(); }
});

test('staleness keeps only commits in an overlapping hunk; a same-file commit elsewhere is touched, not stale', () => {
  const h = hunkRepo();
  try {
    const git = gitRunner({ env: SANDBOX_ENV });
    const base = h.repo.git(['rev-parse', 'HEAD']).trim();
    h.onDefault({ 40: 'line40 on default' });
    const tip = h.repo.git(['rev-parse', 'HEAD']).trim();
    const cardPatch = (() => {
      writeFileSync(join(h.repo.dir, 'src', 'list.js'), h.repo.git(['show', `${base}:src/list.js`]).replace('line10\n', 'line10 from the card\n'));
      const text = h.repo.git(['diff', '-U3', '--src-prefix=a/', '--dst-prefix=b/', base, '--', 'src/list.js']);
      h.repo.git(['checkout', '-q', '--', '.']);
      return text;
    })();
    const args = inputs({ cwd: h.repo.dir, tracking: { main: tip }, files: ['src/list.js'], spikedAt: '2021-01-01T00:00:00.000Z', baseCommit: base, patchTexts: [cardPatch] });
    const away = staleness(git, args);
    assert.deepEqual(away.hunks, { level: 'hunk', overlap: [], fallback: null });
    assert.equal(away.groups.unrelated.commits.length, 0);
    assert.deepEqual(away.touched.commits.map(c => c.files), [['src/list.js']]);

    h.onDefault({ 11: 'line11 on default' });
    const near = staleness(git, { ...args, tracking: { main: h.repo.git(['rev-parse', 'HEAD']).trim() } });
    assert.equal(near.hunks.overlap[0].path, 'src/list.js');
    assert.equal(near.groups.unrelated.commits.length, 2);
    assert.equal(near.touched.commits.length, 0);
  } finally { h.repo.dispose(); }
});

test('the run chain names the base, the card patch, and the files earlier patches or the card fixups touched', t => {
  const home = tempDir('keiron-sequencer-run-chain-');
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const runId = '20261101T100000Z';
  const dir = runDir(home, SLUG, runId);
  const put = (name, file) => {
    mkdirSync(join(dir, 'patches', 'app'), { recursive: true });
    const text = `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-a\n+b\n`;
    writeFileSync(join(dir, 'patches', 'app', `${name}.patch`), text);
    return text;
  };
  put('00002-new', 'src/b.js');
  const own = put('00001-new', 'src/a.js');
  put('fixup-1-from-3-x', 'src/c.js');
  const log = ['00002-new', '00001-new', 'fixup-1-from-3-x'].map(name => ({ name, tree: sha(1), stat: '' }));
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ repos: { app: { baseCommit: sha(42), log, combine: { heads: [] } } } }));
  const record = startRecord(CARD, { refs: { engram: [], patches: ['app/00001-new.patch', 'app/fixup-1-from-3-x.patch'], linear: null, runId } });
  assert.deepEqual(runChain(record, { home, slug: SLUG, repoDir: 'app', patchDir: 'app' }), {
    baseCommit: sha(42), patchTexts: [own], chainedFiles: ['src/b.js', 'src/c.js'], combine: true,
  });
  assert.equal(runBaseCommit(record, { home, slug: SLUG, repoDir: 'app' }), sha(42));
  const trial = startRecord(CARD, { refs: { engram: [], patches: ['app/00001-new.patch'], linear: null } });
  assert.deepEqual(runChain(trial, { home, slug: SLUG, repoDir: 'app', patchDir: 'app' }), { baseCommit: null, patchTexts: [], chainedFiles: [], combine: false });
});

test('a file with no card ranges is judged at file level, so a missing card patch never reads as fresh', () => {
  const h = hunkRepo();
  try {
    h.onDefault({ 40: 'line40 on default' });
    assert.deepEqual(h.run({ patchTexts: [] }), { level: 'file', overlap: [{ path: 'src/list.js', ranges: null }], fallback: 'no-patch' });
  } finally { h.repo.dispose(); }
});
