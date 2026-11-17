import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeProject } from '../scripts/lib/graph.mjs';
import { classifyBuilt, decideBases, neededCandidates, pinBranch, PR_LIST_FIELDS, readPrLists, readRefs, resolvePending } from '../scripts/lib/respike/built.mjs';
import { gitRunner } from '../scripts/lib/spike/exec.mjs';
import { fakeGitHub } from './helpers/fake-git.mjs';
import { makeBareOrigin, makeRepo, SANDBOX_ENV, tempDir } from './helpers/git-sandbox.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import { blocks, issue } from './helpers/spike-fixture.mjs';

guardNetwork();

const started = { state: { name: 'In Progress', type: 'started' } };
const done = { state: { name: 'Done', type: 'completed' } };
const repoEntry = (name, over = {}) => ({ name, github: `acme/${name}`, checkout: `/tmp/${name}`, url: null, remote: 'origin', defaultBranch: 'main', setup: [], risk: [], ...over });
const CONFIG = { schemaVersion: 1, repos: { backend: repoEntry('backend'), web: repoEntry('web', { checkout: null, url: 'https://example.invalid/web.git' }), tools: repoEntry('tools', { github: null }) } };
const pr = (number, title, over = {}) => ({
  number, state: 'OPEN', isDraft: false, mergedAt: null, baseRefName: 'main', headRefName: `b${number}`, headRefOid: `${number}`.padStart(40, 'a'),
  isCrossRepository: false, title, url: `https://github.com/acme/backend/pull/${number}`, ...over,
});
const merged = (number, title, over = {}) => pr(number, title, { state: 'MERGED', mergedAt: '2026-11-01T00:00:00Z', ...over });
const noRefs = new Map([['backend', { local: {}, tracking: {} }]]);
const classify = (issues, prs, { refs = noRefs, built = new Map(), unbuilt = new Set(), pin = () => 'f'.repeat(40) } = {}) => classifyBuilt(
  analyzeProject({ issues, milestones: [] }), { config: CONFIG, prs: new Map([['backend', prs]]), refs, answers: { built, unbuilt }, pin },
);

test('one gh pr list per configured repo with github, open and merged, and a failing or non-JSON read names the repo', () => {
  const gh = fakeGitHub(() => '[]');
  const lists = readPrLists(gh.run, CONFIG, 'p1');
  assert.deepEqual([...lists.keys()], ['backend', 'web']);
  assert.deepEqual(gh.calls.map(c => c.argv), ['acme/backend', 'acme/web'].map(repo => ['pr', 'list', '--repo', repo, '--state', 'all', '--limit', '500', '--json', PR_LIST_FIELDS]));
  assert.throws(() => readPrLists(fakeGitHub(() => ({ status: 1, stderr: 'boom' })).run, CONFIG, 'p1'), e => e.exitCode === 1 && /acme\/backend/.test(e.message));
  assert.throws(() => readPrLists(fakeGitHub(() => 'nope').run, CONFIG, 'p1'), e => e.exitCode === 1 && /acme\/backend/.test(e.message) && /JSON/.test(e.message));
  const scoped = fakeGitHub(() => '[]');
  readPrLists(scoped.run, { ...CONFIG, projects: { p1: { repos: ['web'] } } }, 'p1');
  assert.deepEqual(scoped.calls.map(c => c.argv[3]), ['acme/web']);
});

test('a PR merged into the default branch makes the card merged, with a warning while Linear says open', () => {
  const out = classify([issue('CRM-5', started)], [merged(10, '[CRM-5] done')]);
  assert.deepEqual(out.built, [{
    key: 'CRM-5', kind: 'merged', evidence: 'github', repoDir: 'backend', pr: { number: 10, url: 'https://github.com/acme/backend/pull/10', headRefName: 'b10', baseRefName: 'main', isDraft: false },
    branch: null, sha: null, needed: false, warning: 'merged, still open in Linear',
  }]);
  assert.deepEqual(out.warnings, [{ code: 'merged-still-open', card: 'CRM-5', message: 'CRM-5: merged, still open in Linear' }]);
});

test('a Linear-completed card with no merged PR is merged by Linear, with a warning', () => {
  const out = classify([issue('CRM-5', done)], []);
  assert.deepEqual(out.built.map(b => [b.key, b.kind, b.evidence, b.repoDir]), [['CRM-5', 'merged', 'linear', null]]);
  assert.deepEqual(out.warnings.map(w => w.code), ['linear-done-no-pr']);
});

test('an open PR, draft included, makes the card built with its head branch and commit; a number-only title hit does not', () => {
  const out = classify([issue('CRM-5'), issue('CRM-6'), issue('CRM-7')], [pr(11, '(CRM-5) open'), pr(12, '[CRM-6] draft', { isDraft: true }), pr(13, 'CRM-7 mentioned only')]);
  assert.deepEqual(out.built.map(b => [b.key, b.kind, b.branch, b.sha, b.pr.isDraft]), [['CRM-5', 'pr', 'b11', pr(11).headRefOid, false], ['CRM-6', 'pr', 'b12', pr(12).headRefOid, true]]);
  assert.deepEqual(out.asks, []);
  const demoted = classify([issue('CRM-5')], [pr(11, '(CRM-5) open')], { unbuilt: new Set(['CRM-5']) });
  assert.deepEqual(demoted.built, []);
});

test('a card merged into the default branch adds no open PR into another branch, such as a [Prod] port, to the base', () => {
  const port = pr(20, '[Prod] [CRM-5] port', { baseRefName: 'prod', headRefName: 'crm-5-prod', isDraft: true });
  const out = classify([issue('CRM-5', started)], [merged(10, '[CRM-5] done'), port]);
  assert.deepEqual(out.built.map(b => [b.key, b.kind, b.pr.number]), [['CRM-5', 'merged', 10]]);
  assert.deepEqual(out.asks, []);
});

test('a card merged into the default branch keeps an open follow-up PR into the default branch as built code', () => {
  const out = classify([issue('CRM-5', started)], [merged(10, '[CRM-5] done'), pr(21, '[CRM-5] follow-up')]);
  assert.deepEqual(out.built.map(b => [b.key, b.kind, b.pr.number]), [['CRM-5', 'merged', 10], ['CRM-5', 'pr', 21]]);
});

test('a PR merged into another branch is pending, unless answered built (pinned) or unbuilt', () => {
  const into = [merged(14, '[CRM-5] into feature', { baseRefName: 'feature' })];
  assert.deepEqual(classify([issue('CRM-5')], into).pending, [{ key: 'CRM-5', repoDir: 'backend', branch: 'feature', pr: { number: 14, url: into[0].url, headRefName: 'b14', baseRefName: 'feature', isDraft: false } }]);
  const answered = classify([issue('CRM-5')], into, { built: new Map([['CRM-5', 'feature']]), refs: new Map([['backend', { local: { feature: 'c'.repeat(40) }, tracking: {} }]]) });
  assert.deepEqual(answered.pending, []);
  assert.deepEqual(answered.built.map(b => [b.key, b.kind, b.evidence, b.repoDir, b.branch, b.sha]), [['CRM-5', 'local', 'branch', 'backend', 'feature', 'f'.repeat(40)]]);
  assert.deepEqual(classify([issue('CRM-5')], into, { unbuilt: new Set(['CRM-5']) }).pending, []);
});

test('the branch an ask suggests resolves even when only the remote-tracking ref has it', () => {
  const into = [merged(14, '[CRM-5] into feature', { baseRefName: 'feature' })];
  const pinned = [];
  const out = classify([issue('CRM-5')], into, {
    built: new Map([['CRM-5', 'feature']]), refs: new Map([['backend', { local: {}, tracking: { feature: 'c'.repeat(40) } }]]),
    pin: (dir, branch) => { pinned.push([dir, branch]); return 'c'.repeat(40); },
  });
  assert.deepEqual(out.built.map(b => [b.kind, b.branch, b.sha]), [['local', 'origin/feature', 'c'.repeat(40)]]);
  assert.deepEqual(pinned, [['backend', 'origin/feature']]);
});

test('a card with no PR and a branch carrying its key is asked whatever its Linear state; each answer changes the outcome', () => {
  const refs = new Map([['backend', { local: { 'cris/crm-5-thing': 'c'.repeat(40), 'crm-50': 'd'.repeat(40) }, tracking: { 'crm-5-remote': 'e'.repeat(40) } }]]);
  const asked = classify([issue('CRM-5'), issue('CRM-6')], [], { refs });
  assert.deepEqual(asked.asks, [{
    code: 'local-branch', card: 'CRM-5', repoDir: 'backend', branches: ['cris/crm-5-thing', 'origin/crm-5-remote'], cards: ['CRM-5'], paths: [],
    message: 'CRM-5 has no PR but backend has branch cris/crm-5-thing, origin/crm-5-remote: treat it as built (that branch is the base) or unbuilt?',
    answers: ['--built CRM-5=cris/crm-5-thing', '--built CRM-5=origin/crm-5-remote', '--unbuilt CRM-5'],
  }]);
  const built = classify([issue('CRM-5')], [], { refs, built: new Map([['CRM-5', 'cris/crm-5-thing']]) });
  assert.deepEqual(built.asks, []);
  assert.deepEqual(built.built.map(b => [b.kind, b.branch, b.sha]), [['local', 'cris/crm-5-thing', 'f'.repeat(40)]]);
  const unbuilt = classify([issue('CRM-5')], [], { refs, unbuilt: new Set(['CRM-5']) });
  assert.deepEqual([unbuilt.asks, unbuilt.built], [[], []]);
  assert.deepEqual(classify([issue('CRM-6')], [], { refs }).asks, []);
  assert.throws(() => classify([issue('CRM-5')], [], { refs, built: new Map([['CRM-5', 'nowhere']]) }), e => e.exitCode === 2 && /nowhere/.test(e.message));
});

test('on real git, --built pins the branch\'s commit with rev-parse --verify', () => {
  const repo = makeRepo();
  after(repo.dispose);
  repo.git(['checkout', '-q', '-b', 'crm-5']);
  writeFileSync(join(repo.dir, 'x.txt'), 'x\n');
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'x']);
  repo.git(['checkout', '-q', 'main']);
  const git = gitRunner({ env: SANDBOX_ENV });
  assert.equal(pinBranch(git, repo.dir, 'crm-5'), repo.git(['rev-parse', 'crm-5']).trim());
  assert.throws(() => pinBranch(git, repo.dir, 'gone'), e => e.exitCode === 2 && /gone/.test(e.message));
});

const prEntry = (key, repoDir, branch, sha, over = {}) => ({
  key, kind: 'pr', evidence: 'github', repoDir, pr: { number: cardNum(key), url: `u/${key}`, headRefName: branch, baseRefName: 'main', isDraft: false, ...over.pr },
  branch, sha, needed: false, warning: null, ...over.entry,
});
const cardNum = key => Number(key.split('-')[1]);

test('the needed set is every pr or local branch that is a transitive ancestor of an entry touching its repo; merged cards add no head', () => {
  const issues = [
    issue('CRM-11', { relations: blocks('CRM-12') }), issue('CRM-12', { relations: blocks('CRM-2') }), issue('CRM-13', { relations: blocks('CRM-2') }), issue('CRM-2'),
    issue('CRM-14'), issue('CRM-15', { relations: blocks('CRM-3') }), issue('CRM-3'), issue('CRM-16', { relations: blocks('CRM-4') }), issue('CRM-4'),
  ];
  const built = [
    prEntry('CRM-11', 'backend', 'b11', 'a'), prEntry('CRM-12', 'backend', 'b12', 'b'), { ...prEntry('CRM-13', 'backend', null, null), kind: 'merged', branch: null },
    prEntry('CRM-14', 'backend', 'b14', 'c'), prEntry('CRM-15', 'backend', 'b15', 'd'), prEntry('CRM-16', 'web', 'b16', 'e'),
  ];
  const entries = [{ key: 'CRM-2', repos: ['backend'] }, { key: 'CRM-3', repos: ['web'] }, { key: 'CRM-4', repos: null }];
  const out = neededCandidates(analyzeProject({ issues, milestones: [] }), built, entries);
  assert.deepEqual(out.map(b => [b.key, b.needed]), [['CRM-11', true], ['CRM-12', true], ['CRM-13', false], ['CRM-14', false], ['CRM-15', false], ['CRM-16', true]]);
});

test('a PR merged into a branch that heads a needed base is built; into any other branch it is asked', () => {
  const pending = [{ key: 'CRM-7', repoDir: 'backend', branch: 'b12', pr: { number: 7 } }, { key: 'CRM-8', repoDir: 'backend', branch: 'elsewhere', pr: { number: 8 } }];
  const out = resolvePending(pending, [prEntry('CRM-12', 'backend', 'b12', 'b', { entry: { needed: true } })]);
  assert.deepEqual(out.built.map(b => [b.key, b.kind, b.repoDir, b.branch, b.warning]), [['CRM-7', 'merged', 'backend', 'b12', 'merged into b12, the head of CRM-12']]);
  assert.deepEqual(out.asks.map(a => [a.code, a.card, a.answers]), [['merged-into-branch', 'CRM-8', ['--built CRM-8=elsewhere', '--unbuilt CRM-8']]]);
});

const LIST = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
const text = lines => `${lines.join('\n')}\n`;
const edit = (n, value, from = LIST) => from.map((l, i) => (i === n - 1 ? value : l));

// Branches a, b, c, d diverge from one commit; a2 builds on a; d conflicts with a; main then moves 3 commits ahead.
function builtRepo() {
  const repo = makeRepo();
  after(repo.dispose);
  writeFileSync(join(repo.dir, 'list.txt'), text(LIST));
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'list']);
  const branch = (name, from, content) => {
    repo.git(['checkout', '-q', '-b', name, from]);
    writeFileSync(join(repo.dir, 'list.txt'), content);
    repo.git(['commit', '-q', '-am', name]);
    repo.git(['checkout', '-q', 'main']);
    return repo.git(['rev-parse', name]).trim();
  };
  const sha = {
    a: branch('a', 'main', text(edit(2, 'line2 from a'))), b: branch('b', 'main', text(edit(8, 'line8 from b'))),
    c: branch('c', 'main', text(edit(5, 'line5 from c'))), d: branch('d', 'main', text(edit(2, 'line2 from d'))),
  };
  sha.a2 = branch('a2', 'a', text(edit(4, 'line4 from a2', edit(2, 'line2 from a'))));
  for (const n of [1, 2, 3]) {
    writeFileSync(join(repo.dir, `main${n}.txt`), `${n}\n`);
    repo.git(['add', '-A']);
    repo.git(['commit', '-q', '-m', `main ${n}`]);
  }
  const origin = makeBareOrigin({ from: repo.dir });
  after(origin.dispose);
  repo.git(['remote', 'add', 'origin', origin.dir]);
  repo.git(['fetch', '-q', 'origin']);
  const config = { schemaVersion: 1, repos: { backend: repoEntry('backend', { checkout: repo.dir }) } };
  const git = gitRunner({ env: SANDBOX_ENV });
  const tmpRoot = tempDir('keiron-sequencer-built-tmp-');
  after(() => {
    assert.deepEqual(readdirSync(tmpRoot), []);
    rmSync(tmpRoot, { recursive: true, force: true });
  });
  const bases = (built, withDefault = new Set()) => decideBases(git, { config, built: built.map(b => ({ ...b, needed: true })), repos: ['backend'], refs: new Map([['backend', readRefs(git, config.repos.backend)]]), tmpRoot, withDefault });
  return { repo, sha, git, bases, tmpRoot };
}

test('on real git: no needed branch gives the default base; one gives that PR head, behind default by 3', () => {
  const { sha, bases } = builtRepo();
  assert.deepEqual(bases([]).bases.backend, { kind: 'default', ref: 'origin/main', sha: null, card: null, heads: null, tree: null, behind: null, ownCommits: null, warning: null });
  const one = bases([prEntry('CRM-11', 'backend', 'a', sha.a)]);
  assert.deepEqual(one.bases.backend, { kind: 'pr', ref: 'refs/pull/11/head', sha: sha.a, card: 'CRM-11', heads: null, tree: null, behind: 3, ownCommits: 1, warning: 'base 3 commits behind default' });
  assert.deepEqual(one.warnings, [{ code: 'base-behind-default', repo: 'backend', behind: 3, message: 'backend: base 3 commits behind default' }]);
  const local = bases([{ ...prEntry('CRM-11', 'backend', 'a', sha.a), kind: 'local', evidence: 'branch', pr: null }]);
  assert.deepEqual([local.bases.backend.kind, local.bases.backend.ref, local.bases.backend.behind], ['local', 'a', 3]);
});

test('on real git: a chain stacks on its top, by PR links or by rev-list', () => {
  const { sha, bases } = builtRepo();
  const linked = bases([
    prEntry('CRM-13', 'backend', 'x3', 'f'.repeat(40), { pr: { baseRefName: 'x2' } }), prEntry('CRM-11', 'backend', 'x1', 'd'.repeat(40)),
    prEntry('CRM-12', 'backend', 'x2', 'e'.repeat(40), { pr: { baseRefName: 'x1' } }),
  ]);
  assert.deepEqual([linked.bases.backend.kind, linked.bases.backend.card, linked.asks], ['pr', 'CRM-13', []]);
  const byGit = bases([prEntry('CRM-11', 'backend', 'a', sha.a), prEntry('CRM-12', 'backend', 'a2', sha.a2)]);
  assert.deepEqual([byGit.bases.backend.kind, byGit.bases.backend.sha], ['pr', sha.a2]);
});

test('on real git: diverged needed heads combine in card-number order with a pinned tree; a chain plus a diverged branch combines the two tops', () => {
  const { repo, sha, bases } = builtRepo();
  const two = bases([prEntry('CRM-12', 'backend', 'b', sha.b), prEntry('CRM-11', 'backend', 'a', sha.a)]).bases.backend;
  assert.equal(two.kind, 'combine');
  assert.deepEqual(two.heads, [{ card: 'CRM-11', kind: 'pr', ref: 'refs/pull/11/head', sha: sha.a, ownCommits: 1 }, { card: 'CRM-12', kind: 'pr', ref: 'refs/pull/12/head', sha: sha.b, ownCommits: 1 }]);
  assert.equal(two.sha, sha.a);
  assert.match(two.tree, /^[0-9a-f]{40}$/);
  assert.equal(two.behind, 3);
  assert.equal(existsSync(join(repo.dir, '.git', 'objects', two.tree.slice(0, 2), two.tree.slice(2))), false);
  const mixed = bases([prEntry('CRM-11', 'backend', 'a', sha.a), prEntry('CRM-13', 'backend', 'a2', sha.a2), prEntry('CRM-12', 'backend', 'b', sha.b)]).bases.backend;
  assert.deepEqual(mixed.heads.map(h => h.card), ['CRM-12', 'CRM-13']);
});

test('on real git: a conflicting combine asks combine-conflict with the cards and paths; a missing head asks bases-unknown', () => {
  const { sha, bases } = builtRepo();
  const conflict = bases([prEntry('CRM-11', 'backend', 'a', sha.a), prEntry('CRM-14', 'backend', 'd', sha.d)]);
  assert.equal(conflict.bases.backend, undefined);
  assert.deepEqual(conflict.asks, [{
    code: 'combine-conflict', repoDir: 'backend', cards: ['CRM-11', 'CRM-14'], paths: ['list.txt'],
    message: 'backend\'s built branches CRM-11, CRM-14 conflict on list.txt: which card should be treated as unbuilt (replayed or re-spiked)?',
    answers: ['--unbuilt CRM-11', '--unbuilt CRM-14'],
  }]);
  const gone = '0123456789abcdef0123456789abcdef01234567';
  const unknown = bases([prEntry('CRM-11', 'backend', 'a', sha.a), prEntry('CRM-12', 'backend', 'zz', gone)]);
  assert.deepEqual(unknown.asks.map(a => [a.code, a.repoDir, a.cards, a.answers]), [['bases-unknown', 'backend', ['CRM-12'], ['fetch', '--unbuilt CRM-12']]]);
  const combined = bases([prEntry('CRM-11', 'backend', 'a', sha.a), prEntry('CRM-12', 'backend', 'b', sha.b), prEntry('CRM-13', 'backend', 'c', sha.c)]).bases.backend;
  assert.equal(combined.behind, 3);
});

test('built-branch discovery on an empty or partial config does not throw: a dir with no remote asks only its local branches', () => {
  const refs = new Map([['backend', { local: { 'crm-5-local': 'c'.repeat(40) }, tracking: { 'crm-5-remote': 'e'.repeat(40) } }]]);
  const prs = new Map([['backend', [merged(10, '[CRM-6] done'), pr(11, '[CRM-7] open')]]]);
  const analysis = analyzeProject({ issues: [issue('CRM-5'), issue('CRM-6', started), issue('CRM-7')], milestones: [] });
  const empty = { schemaVersion: 1, repos: {} };
  const partial = { schemaVersion: 1, repos: { backend: { name: 'backend', github: 'acme/backend', checkout: '/tmp/backend' } } };
  const gh = fakeGitHub(() => '[]');
  assert.deepEqual([...readPrLists(gh.run, empty, 'p1').keys()], []);
  assert.deepEqual([...readPrLists(gh.run, partial, 'p1').keys()], ['backend']);
  assert.deepEqual(gh.calls.map(c => c.argv[3]), ['acme/backend']);
  for (const config of [empty, partial]) {
    const classify = built => classifyBuilt(analysis, { config, prs, refs, answers: { built, unbuilt: new Set() }, pin: () => 'f'.repeat(40) });
    const out = classify(new Map());
    assert.deepEqual(out.asks.map(a => [a.card, a.branches]), [['CRM-5', ['crm-5-local']]]);
    assert.deepEqual(out.pending.map(p => [p.key, p.branch]), [['CRM-6', 'main']]);
    assert.deepEqual(out.built.map(b => [b.key, b.kind]), [['CRM-7', 'pr']]);
    assert.deepEqual(classify(new Map([['CRM-5', 'crm-5-local']])).built.map(b => [b.key, b.kind, b.branch]), [['CRM-5', 'local', 'crm-5-local'], ['CRM-7', 'pr', 'b11']]);
    assert.throws(() => classify(new Map([['CRM-5', 'crm-5-remote']])), e => e.exitCode === 2 && /no branch crm-5-remote/.test(e.message));
  }
});

test('a base is decided only for a configured repo: a dir missing from the config is skipped and no git runs for it', () => {
  const git = () => { throw new Error('no git call was expected'); };
  const out = decideBases(git, { config: { schemaVersion: 1, repos: {} }, built: [], repos: ['backend'], refs: new Map(), tmpRoot: '/nowhere' });
  assert.deepEqual(out, { bases: {}, asks: [], warnings: [] });
});

test('a local branch with no own commits reports ownCommits 0', () => {
  const { repo, sha, bases } = builtRepo();
  const old = repo.git(['rev-parse', 'origin/main~3']).trim();
  const local = entry => ({ ...prEntry(entry.key, 'backend', entry.branch, entry.sha), kind: 'local', evidence: 'branch', pr: null });
  const stale = bases([local({ key: 'CRM-11', branch: 'old', sha: old })]).bases.backend;
  assert.deepEqual([stale.kind, stale.behind, stale.ownCommits], ['local', 3, 0]);
  const own = bases([local({ key: 'CRM-11', branch: 'a', sha: sha.a })]).bases.backend;
  assert.deepEqual([own.behind, own.ownCommits], [3, 1]);
  const two = bases([prEntry('CRM-12', 'backend', 'b', sha.b), prEntry('CRM-11', 'backend', 'a', sha.a)]).bases.backend;
  assert.deepEqual(two.heads.map(h => [h.card, h.ownCommits]), [['CRM-11', 1], ['CRM-12', 1]]);
});

test('--with-default adds the default tip to the base as one more head, so the base is no longer behind', () => {
  const { repo, sha, bases } = builtRepo();
  const tip = repo.git(['rev-parse', 'origin/main']).trim();
  const one = bases([prEntry('CRM-11', 'backend', 'a', sha.a)], new Set(['backend']));
  const base = one.bases.backend;
  assert.equal(base.kind, 'combine');
  assert.deepEqual(base.heads.map(h => [h.card, h.kind, h.ref, h.sha]), [['CRM-11', 'pr', 'refs/pull/11/head', sha.a], [null, 'default', 'origin/main', tip]]);
  assert.deepEqual([base.sha, base.behind, base.warning], [sha.a, 0, null]);
  assert.match(base.tree, /^[0-9a-f]{40}$/);
  assert.deepEqual(one.warnings, []);
  const two = bases([prEntry('CRM-12', 'backend', 'b', sha.b), prEntry('CRM-11', 'backend', 'a', sha.a)], new Set(['backend'])).bases.backend;
  assert.deepEqual(two.heads.map(h => h.card), ['CRM-11', 'CRM-12', null]);
  assert.equal(two.behind, 0);
  assert.equal(bases([prEntry('CRM-11', 'backend', 'a', sha.a)], new Set(['web'])).bases.backend.behind, 3);
});
