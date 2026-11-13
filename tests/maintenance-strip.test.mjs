import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { applyRewrite, planRewrite, purgeBackup, verifyNoPatches } from '../scripts/maintenance/strip-history.mjs';
import { gitRunner } from '../scripts/lib/spike/exec.mjs';
import { makeBareOrigin, makeRepo, SANDBOX_ENV, tempDir } from './helpers/git-sandbox.mjs';
import { guardNetwork } from './helpers/no-network.mjs';

guardNetwork();

const PATCH = 'docs/trial/backend/00001-new.patch';
const LOG = 'docs/trial/backend/log.txt';
const MESSAGE_2 = 'feat: add the trial\n\nThe body keeps   its spacing.\n\nTrailer: kept\n';
const MESSAGE_3 = 'fix: touch the readme\n';

// Distinct authors, committers, dates and time zones, so a rewrite that loses any of them is caught.
function commitAs(dir, { author, committer, message }) {
  const env = {
    ...SANDBOX_ENV,
    GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_AUTHOR_DATE: author.date,
    GIT_COMMITTER_NAME: committer.name, GIT_COMMITTER_EMAIL: committer.email, GIT_COMMITTER_DATE: committer.date,
  };
  const r = spawnSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '--cleanup=verbatim', '-F', '-'], { cwd: dir, env, input: message, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
}

const write = (dir, path, text) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
};

function historyRepo() {
  const repo = makeRepo();
  const scratch = tempDir('keiron-sequencer-strip-scratch-');
  after(() => {
    repo.dispose();
    rmSync(scratch, { recursive: true, force: true });
  });
  const root = repo.git(['rev-parse', 'HEAD']).trim();
  write(repo.dir, PATCH, 'diff --git a/x b/x\n+trial code\n');
  write(repo.dir, LOG, 'snapshot log\n');
  write(repo.dir, 'src/index.js', 'export const one = 2\n');
  repo.git(['add', '-A']);
  commitAs(repo.dir, {
    author: { name: 'Ana', email: 'ana@example.com', date: '2026-01-02T10:00:00+01:00' },
    committer: { name: 'Ben', email: 'ben@example.com', date: '2026-01-03T11:00:00-03:00' },
    message: MESSAGE_2,
  });
  write(repo.dir, 'README.md', '# sandbox, edited\n');
  repo.git(['add', '-A']);
  commitAs(repo.dir, {
    author: { name: 'Cid', email: 'cid@example.com', date: '2026-01-04T09:30:00+00:00' },
    committer: { name: 'Cid', email: 'cid@example.com', date: '2026-01-05T09:30:00+05:30' },
    message: MESSAGE_3,
  });
  const commits = repo.git(['rev-list', '--reverse', 'main']).trim().split('\n');
  return { repo, scratch, root, commits, git: gitRunner({ env: SANDBOX_ENV }) };
}

const refs = repo => repo.git(['for-each-ref', '--format=%(refname) %(objectname)']);

const gitDirFiles = dir => {
  const base = join(dir, '.git');
  return Object.fromEntries(readdirSync(base, { recursive: true, withFileTypes: true }).filter(e => e.isFile())
    .map(e => join(e.parentPath, e.name)).sort()
    .map(f => [relative(base, f), createHash('sha256').update(readFileSync(f)).digest('hex')]));
};

test('the plan maps every commit old to new, keeps the root sha and lists the removed patch paths', () => {
  const { repo, root, commits, git } = historyRepo();
  const plan = planRewrite(repo.dir, { branch: 'main', git });
  assert.equal(plan.branch, 'main');
  assert.equal(plan.oldTip, commits[2]);
  assert.deepEqual(plan.commits.map(c => c.old), commits);
  assert.equal(plan.commits[0].new, root);
  assert.equal(plan.commits[0].rewritten, false);
  for (const c of plan.commits.slice(1)) {
    assert.equal(c.rewritten, true);
    assert.notEqual(c.new, c.old);
    assert.deepEqual(c.removed, [PATCH]);
  }
  assert.equal(plan.newTip, plan.commits[2].new);
  assert.deepEqual(plan.removed, [PATCH]);
  assert.equal(plan.pushed, false);
  assert.deepEqual(plan.remotes, []);
});

test('the plan checks that every rewritten commit keeps its author, committer, dates, message and every non-patch blob', () => {
  const { repo, git } = historyRepo();
  const plan = planRewrite(repo.dir, { branch: 'main', git });
  for (const c of plan.commits) assert.deepEqual(c.kept, { metadata: true, blobs: true }, c.old);
});

test('the preview is side-effect free: refs and every file under .git are unchanged, and nothing is applied without approve', () => {
  const { repo, scratch, git } = historyRepo();
  const before = { refs: refs(repo), files: gitDirFiles(repo.dir) };
  const plan = planRewrite(repo.dir, { branch: 'main', git });
  const out = applyRewrite(repo.dir, plan, { bundlePath: join(scratch, 'backup.bundle'), git });
  assert.equal(out.applied, false);
  assert.equal(out.plan, plan);
  assert.deepEqual({ refs: refs(repo), files: gitDirFiles(repo.dir) }, before);
  assert.equal(existsSync(join(scratch, 'backup.bundle')), false);
});

test('a commit reachable from refs/remotes/* marks the plan pushed, and the rewrite refuses and changes nothing', () => {
  const { repo, scratch, commits, git } = historyRepo();
  repo.git(['update-ref', 'refs/remotes/origin/main', commits[1]]);
  const plan = planRewrite(repo.dir, { branch: 'main', git });
  assert.equal(plan.pushed, true);
  const before = refs(repo);
  assert.throws(() => applyRewrite(repo.dir, plan, { approve: true, bundlePath: join(scratch, 'backup.bundle'), git }), /pushed/);
  assert.equal(refs(repo), before);
  assert.equal(existsSync(join(scratch, 'backup.bundle')), false);
});

test('a configured remote refuses the rewrite even when nothing was pushed', () => {
  const { repo, scratch, git } = historyRepo();
  const origin = makeBareOrigin();
  after(origin.dispose);
  repo.git(['remote', 'add', 'origin', origin.dir]);
  const plan = planRewrite(repo.dir, { branch: 'main', git });
  assert.equal(plan.pushed, false);
  assert.deepEqual(plan.remotes, ['origin']);
  const before = refs(repo);
  assert.throws(() => applyRewrite(repo.dir, plan, { approve: true, bundlePath: join(scratch, 'backup.bundle'), git }), /remote origin/);
  assert.equal(refs(repo), before);
  assert.equal(existsSync(join(scratch, 'backup.bundle')), false);
});

const BACKUP = 'refs/backup/pre-strip-patches/main';
const tip = (repo, ref = 'refs/heads/main') => repo.git(['rev-parse', ref]).trim();
const hasObject = (repo, sha) => spawnSync('git', ['cat-file', '-e', sha], { cwd: repo.dir, env: SANDBOX_ENV }).status === 0;

function applied(over = {}) {
  const h = historyRepo();
  const plan = planRewrite(h.repo.dir, { branch: 'main', git: h.git });
  const bundlePath = join(h.scratch, 'backup', 'keiron-sequencer-pre-strip.bundle');
  const out = applyRewrite(h.repo.dir, plan, { approve: true, bundlePath, git: h.git, ...over });
  return { ...h, plan, bundlePath, out };
}

test('with approve, the backup ref and the bundle are written before main moves, and main ends at the planned tip', () => {
  const h = historyRepo();
  const plan = planRewrite(h.repo.dir, { branch: 'main', git: h.git });
  const calls = [];
  const recording = (args, opts) => { calls.push(args.join(' ')); return h.git(args, opts); };
  const bundlePath = join(h.scratch, 'backup', 'keiron-sequencer-pre-strip.bundle');
  const out = applyRewrite(h.repo.dir, plan, { approve: true, bundlePath, git: recording });
  const at = text => calls.findIndex(c => c.includes(text));
  assert.ok(at(`update-ref ${BACKUP}`) >= 0 && at('bundle create') > at(`update-ref ${BACKUP}`), calls.join('\n'));
  assert.ok(at('update-ref refs/heads/main') > at('bundle create'), calls.join('\n'));
  assert.deepEqual(out, { applied: true, branch: 'main', oldTip: plan.oldTip, newTip: plan.newTip, backupRef: BACKUP, bundlePath });
  assert.equal(tip(h.repo), plan.newTip);
  assert.equal(tip(h.repo, BACKUP), plan.oldTip);
  assert.match(h.repo.git(['bundle', 'list-heads', bundlePath]), new RegExp(`^${plan.oldTip} refs/heads/main$`, 'm'));
  h.repo.git(['bundle', 'verify', '-q', bundlePath]);
});

test('the rewritten commits keep their messages, authors, committers and dates, and every non-patch blob', () => {
  const { repo, plan } = applied();
  const raw = sha => repo.git(['cat-file', 'commit', sha]);
  const meta = sha => raw(sha).split('\n').filter(l => /^(author|committer) /.test(l)).join('\n') + raw(sha).slice(raw(sha).indexOf('\n\n'));
  const files = sha => repo.git(['ls-tree', '-r', sha]).split('\n').filter(l => l && !l.endsWith('.patch'));
  for (const c of plan.commits) {
    assert.equal(meta(c.new), meta(c.old), c.old);
    assert.deepEqual(files(c.new), files(c.old), c.old);
    assert.equal(repo.git(['ls-tree', '-r', '--name-only', c.new]).includes('.patch'), false);
  }
  assert.equal(raw(plan.commits[1].new).endsWith(MESSAGE_2), true);
  assert.match(raw(plan.commits[1].new), /^author Ana <ana@example\.com> \d+ \+0100$/m);
  assert.match(raw(plan.commits[1].new), /^committer Ben <ben@example\.com> \d+ -0300$/m);
  assert.ok(repo.git(['ls-tree', '-r', '--name-only', plan.newTip]).includes(LOG));
});

test('verifyNoPatches fails before the rewrite and passes after it, with the backup excluded', () => {
  const h = historyRepo();
  const before = verifyNoPatches(h.repo.dir, { exclude: ['refs/backup/'], git: h.git });
  assert.equal(before.ok, false);
  assert.deepEqual(before.offending.map(o => o.commit).sort(), h.commits.slice(1).sort());
  assert.ok(before.offending.every(o => o.paths.join() === PATCH));
  const plan = planRewrite(h.repo.dir, { branch: 'main', git: h.git });
  applyRewrite(h.repo.dir, plan, { approve: true, bundlePath: join(h.scratch, 'b.bundle'), git: h.git });
  assert.deepEqual(verifyNoPatches(h.repo.dir, { exclude: ['refs/backup/'], git: h.git }), { ok: true, offending: [] });
  assert.equal(verifyNoPatches(h.repo.dir, { git: h.git }).ok, false);
});

test('the index drops the patches and working-tree changes are kept', () => {
  const h = historyRepo();
  writeFileSync(join(h.repo.dir, 'src/index.js'), 'export const one = 3\n');
  write(h.repo.dir, 'extra.txt', 'staged\n');
  h.repo.git(['add', 'extra.txt']);
  const plan = planRewrite(h.repo.dir, { branch: 'main', git: h.git });
  applyRewrite(h.repo.dir, plan, { approve: true, bundlePath: join(h.scratch, 'b.bundle'), git: h.git });
  assert.equal(h.repo.git(['ls-files', '--', '*.patch']), '');
  assert.equal(readFileSync(join(h.repo.dir, 'src/index.js'), 'utf8'), 'export const one = 3\n');
  const status = h.repo.git(['status', '--porcelain']).split('\n').filter(Boolean).sort();
  assert.deepEqual(status, ['?? docs/trial/backend/00001-new.patch', 'A  extra.txt', ' M src/index.js'].sort());
});

test('main moves by compare-and-swap: a tip moved just before the swap makes it fail, with the backup in place', () => {
  const h = historyRepo();
  const plan = planRewrite(h.repo.dir, { branch: 'main', git: h.git });
  const racing = (args, opts) => {
    if (args[0] === 'update-ref' && args[1] === 'refs/heads/main') h.repo.git(['update-ref', 'refs/heads/main', h.commits[1]]);
    return h.git(args, opts);
  };
  assert.throws(() => applyRewrite(h.repo.dir, plan, { approve: true, bundlePath: join(h.scratch, 'b.bundle'), git: racing }), /update-ref/);
  assert.equal(tip(h.repo), h.commits[1]);
  assert.equal(tip(h.repo, BACKUP), plan.oldTip);
});

test('a tip that moved after the plan, an existing backup ref or an existing bundle is refused before anything is written', () => {
  const h = historyRepo();
  const plan = planRewrite(h.repo.dir, { branch: 'main', git: h.git });
  const bundlePath = join(h.scratch, 'b.bundle');
  write(h.repo.dir, 'later.txt', 'later\n');
  h.repo.git(['add', '-A']);
  h.repo.git(['commit', '-q', '-m', 'later']);
  const before = refs(h.repo);
  assert.throws(() => applyRewrite(h.repo.dir, plan, { approve: true, bundlePath, git: h.git }), /moved/);
  assert.equal(refs(h.repo), before);
  assert.equal(existsSync(bundlePath), false);

  const fresh = planRewrite(h.repo.dir, { branch: 'main', git: h.git });
  h.repo.git(['update-ref', BACKUP, h.commits[0]]);
  assert.throws(() => applyRewrite(h.repo.dir, fresh, { approve: true, bundlePath, git: h.git }), /refs\/backup\/pre-strip-patches\/main already exists/);
  h.repo.git(['update-ref', '-d', BACKUP]);
  const unchanged = refs(h.repo);
  writeFileSync(bundlePath, 'x');
  assert.throws(() => applyRewrite(h.repo.dir, fresh, { approve: true, bundlePath, git: h.git }), /already exists/);
  assert.throws(() => applyRewrite(h.repo.dir, fresh, { approve: true, git: h.git }), /bundlePath/);
  assert.equal(refs(h.repo), unchanged);
  assert.equal(tip(h.repo), fresh.oldTip);
});

test('rollback: pointing main back at the backup ref restores the old history', () => {
  const { repo, plan } = applied();
  repo.git(['update-ref', 'refs/heads/main', BACKUP]);
  assert.equal(tip(repo), plan.oldTip);
  assert.ok(repo.git(['ls-tree', '-r', '--name-only', 'main']).includes(PATCH));
});

test('the purge refuses without its own approval; with it, the backup ref goes and an old patch blob is gone', () => {
  const { repo, plan, git, bundlePath } = applied();
  const blob = repo.git(['rev-parse', `${plan.oldTip}:${PATCH}`]).trim();
  assert.throws(() => purgeBackup(repo.dir, { backupRef: BACKUP, git }), /approve/);
  assert.equal(tip(repo, BACKUP), plan.oldTip);
  assert.ok(hasObject(repo, blob));
  assert.deepEqual(purgeBackup(repo.dir, { backupRef: BACKUP, approve: true, git }), { purged: true, backupRef: BACKUP });
  assert.equal(repo.git(['for-each-ref', 'refs/backup/']), '');
  assert.equal(hasObject(repo, blob), false);
  assert.equal(hasObject(repo, plan.oldTip), false);
  assert.ok(existsSync(bundlePath));
});
