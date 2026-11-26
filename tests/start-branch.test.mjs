import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { draftPack, writePack } from '../scripts/lib/packs.mjs';
import { readStarted, startedKey, startedPath } from '../scripts/lib/start/started.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import { appRepo, CARD, FAKE_CHECKOUT, fakeStartFixture, GIT_BRANCH_NAME, HEAD_SHA, SENTINEL, SLUG, startIssue, startRecord } from './helpers/start-fixture.mjs';

guardNetwork();

const card = startIssue(CARD, { gitBranchName: GIT_BRANCH_NAME });
const blocks = to => ({ relations: { nodes: [{ type: 'blocks', relatedIssue: { identifier: to } }] } });
const started = { name: 'In Progress', type: 'started' };

// A checkout whose HEAD, local branches and worktree follow the `checkout` calls it receives.
function liveCheckout({ local = ['main'], remote = ['main'], current = 'main', status = () => '', elsewhere = [] } = {}) {
  const state = { local: [...local], current };
  const ref = r => `${HEAD_SHA} ${r}\n`;
  return {
    state,
    table: {
      'rev-parse': argv => (argv.includes('--abbrev-ref') ? `${state.current}\n` : `${FAKE_CHECKOUT}\n.git\n${HEAD_SHA}\n`),
      'for-each-ref': () => [...state.local.map(b => `refs/heads/${b}`), ...remote.map(b => `refs/remotes/origin/${b}`)].map(ref).join(''),
      'worktree list': () => [[FAKE_CHECKOUT, state.current], ...elsewhere]
        .map(([path, b]) => `worktree ${path}\nHEAD ${HEAD_SHA}\nbranch refs/heads/${b}\n\n`).join(''),
      'ls-remote': remote.map(b => `${HEAD_SHA}\trefs/heads/${b}\n`).join(''),
      status,
      'check-ref-format': argv => (/\.\.|\s|^-/.test(argv[2]) ? { status: 1, stderr: 'fatal: not a valid branch name' } : `${argv[2]}\n`),
      checkout: argv => {
        const name = argv[1] === '-b' ? argv[2] : argv[1];
        if (!state.local.includes(name)) state.local.push(name);
        state.current = name;
        return '';
      },
    },
  };
}

const fixture = (t, { extra = [], repo = {}, gh, live = liveCheckout(), git = {} } = {}) => {
  const f = fakeStartFixture({ issues: [card, ...extra], repos: { app: appRepo(FAKE_CHECKOUT, repo) }, gh, git: { ...live.table, ...git } });
  t.after(f.dispose);
  return Object.assign(f, { live });
};
const plan = async f => {
  const r = await f.run(['plan', CARD]);
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const branch = async (f, flags = [], hash) => f.run(['branch', CARD, '--approve', hash ?? (await plan(f)).approve, ...flags]);
const checkouts = f => f.git.calls.filter(c => c.sub === 'checkout').map(c => c.argv);
const refused = async (f, flags, hash) => {
  const r = await branch(f, flags, hash);
  assert.equal(r.code, 5, `${flags.join(' ')}: ${r.code} ${r.stderr}${r.stdout}`);
  assert.deepEqual(checkouts(f), [], flags.join(' '));
  return r;
};

const ownPr = (state, n = 7) => ({
  number: n, state, isDraft: false, mergedAt: state === 'MERGED' ? '2026-11-01T00:00:00Z' : null, baseRefName: 'main',
  headRefName: `user/abc-1-old-${n}`, title: `[${CARD}] earlier try`, url: `https://github.com/acme/app/pull/${n}`,
});
const searchGh = table => argv => (argv.includes('--search') ? JSON.stringify(table[argv[argv.indexOf('--search') + 1]] ?? []) : '[]');

test('branch with the approved hash on a create plan runs one checkout -b of the branch from the base, in the checkout', async t => {
  const f = fixture(t);
  const r = await branch(f);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(f.git.calls.filter(c => c.sub === 'checkout').map(c => [c.argv, c.cwd]), [[['checkout', '-b', GIT_BRANCH_NAME, 'origin/main'], FAKE_CHECKOUT]]);
  const out = JSON.parse(r.stdout);
  assert.deepEqual([out.action, out.branch, out.base, out.head], ['created', GIT_BRANCH_NAME, 'origin/main', HEAD_SHA]);
});

test('branch returns nextApprove for the plan after the checkout: HEAD on the new branch, so a resume', async t => {
  const f = fixture(t);
  const before = await plan(f);
  const out = JSON.parse((await branch(f, [], before.approve)).stdout);
  const after = await plan(f);
  assert.deepEqual([after.action, after.checkout.branch], ['resume', GIT_BRANCH_NAME]);
  assert.equal(out.nextApprove, after.approve);
  assert.notEqual(out.nextApprove, before.approve);
});

test('branch without --approve is a usage error with no git call and no Linear request', async t => {
  const f = fixture(t);
  const r = await f.run(['branch', CARD]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /usage: node scripts\/start\.mjs branch <CARD> --approve <hash>/);
  assert.deepEqual([f.git.calls.length, f.linear.sent.length], [0, 0]);
});

test('a hash that no longer matches is refused, exit 5, even when only the dirty count changed', async t => {
  let status = '';
  const f = fixture(t, { live: liveCheckout({ status: () => status }) });
  const hash = (await plan(f)).approve;
  status = ' M src/index.js\n';
  const r = await refused(f, [], hash);
  assert.match(r.stderr, /changed since it was approved/);
});

test('a dirty checkout is shown in the plan but does not refuse the branch', async t => {
  const f = fixture(t, { live: liveCheckout({ status: () => ' M src/index.js\n?? notes.md\n' }) });
  const shown = await plan(f);
  assert.equal(shown.checkout.dirty, 2);
  const r = await branch(f, [], shown.approve);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(checkouts(f).length, 1);
});

test('a plan that stops, waits or asks about a blocker creates nothing, exit 5', async t => {
  for (const [state, action] of [[{ name: 'Todo', type: 'unstarted' }, 'stop'], [started, 'ask']]) {
    const f = fixture(t, { extra: [startIssue('ABC-2', { state, ...blocks(CARD) })] });
    assert.equal((await plan(f)).action, action);
    const r = await refused(f, []);
    assert.ok(r.stderr.includes(action), r.stderr);
  }
  const elsewhere = { ...ownPr('MERGED', 2), baseRefName: 'user/abc-3-y', title: '[ABC-2] wip', headRefName: 'user/abc-2-x' };
  const f = fixture(t, { extra: [startIssue('ABC-2', { state: started, ...blocks(CARD) })], gh: searchGh({ 'ABC-2': [elsewhere] }) });
  assert.equal((await plan(f)).action, 'wait');
  await refused(f, []);
});

test('a draft blocker PR or a blocker branch only in this checkout is the start point of the new branch', async t => {
  const draft = { ...ownPr('OPEN', 2), isDraft: true, title: '[ABC-2] wip', headRefName: 'user/abc-2-x' };
  const onDraft = fixture(t, { extra: [startIssue('ABC-2', { state: started, ...blocks(CARD) })], gh: searchGh({ 'ABC-2': [draft] }) });
  assert.equal((await branch(onDraft)).code, 0);
  assert.deepEqual(checkouts(onDraft), [['checkout', '-b', GIT_BRANCH_NAME, 'origin/user/abc-2-x']]);
  const onLocal = fixture(t, { extra: [startIssue('ABC-2', { state: started, ...blocks(CARD) })], live: liveCheckout({ local: ['main', 'user/abc-2-wip'] }) });
  assert.equal((await branch(onLocal)).code, 0);
  assert.deepEqual(checkouts(onLocal), [['checkout', '-b', GIT_BRANCH_NAME, 'refs/heads/user/abc-2-wip']]);
});

test('--accept never clears an unverified-blocker ask, and only takes pr-merged or pr-closed', async t => {
  const f = fixture(t, { extra: [startIssue('ABC-2', { state: started, ...blocks(CARD) })] });
  for (const code of ['pr-merged', 'unverified-blocker', 'anything']) await refused(f, ['--accept', code]);
});

test('--accept pr-merged creates when a merged PR of the card is the only thing the plan asks about', async t => {
  const f = fixture(t, { gh: searchGh({ [CARD]: [ownPr('MERGED')] }) });
  const shown = await plan(f);
  assert.deepEqual([shown.action, shown.reasons.map(r => r.code)], ['ask', ['pr-merged']]);
  await refused(f, [], shown.approve);
  const r = await branch(f, ['--accept', 'pr-merged'], shown.approve);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(checkouts(f), [['checkout', '-b', GIT_BRANCH_NAME, 'origin/main']]);
});

test('--accept must clear every ask reason: a merged and a closed PR need both', async t => {
  const f = fixture(t, { gh: searchGh({ [CARD]: [ownPr('MERGED', 7), ownPr('CLOSED', 8)] }) });
  const shown = await plan(f);
  assert.deepEqual(shown.reasons.map(r => r.code), ['pr-closed', 'pr-merged']);
  await refused(f, ['--accept', 'pr-merged'], shown.approve);
  const r = await branch(f, ['--accept', 'pr-merged', '--accept', 'pr-closed'], shown.approve);
  assert.equal(r.code, 0, r.stderr);
});

test('--accept does not clear a merged own PR when the base would wait', async t => {
  const elsewhere = { ...ownPr('MERGED', 2), baseRefName: 'user/abc-3-y', title: '[ABC-2] wip', headRefName: 'user/abc-2-x' };
  const f = fixture(t, {
    extra: [startIssue('ABC-2', { state: started, ...blocks(CARD) })], gh: searchGh({ [CARD]: [ownPr('MERGED')], 'ABC-2': [elsewhere] }),
  });
  const shown = await plan(f);
  assert.deepEqual([shown.action, shown.base.kind], ['ask', 'wait']);
  await refused(f, ['--accept', 'pr-merged'], shown.approve);
});

test('a stack plan branches from the blocker PR head', async t => {
  const open = { ...ownPr('OPEN', 2), title: '[ABC-2] base', headRefName: 'user/abc-2-x' };
  const f = fixture(t, { extra: [startIssue('ABC-2', { state: started, ...blocks(CARD) })], gh: searchGh({ 'ABC-2': [open] }) });
  const r = await branch(f);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(checkouts(f), [['checkout', '-b', GIT_BRANCH_NAME, 'origin/user/abc-2-x']]);
});

test('--name is refused on a verbatim repo', async t => {
  const f = fixture(t);
  const r = await refused(f, ['--name', 'feat/some-title']);
  assert.match(r.stderr, /verbatim/);
});

test('on a strip-card-id repo --name replaces the derived name once git accepts it as a branch name', async t => {
  const f = fixture(t, { repo: { branchNaming: 'strip-card-id' } });
  const shown = await plan(f);
  assert.deepEqual([shown.branch.name, shown.branch.editable], ['user/some-title', true]);
  const r = await branch(f, ['--name', 'feat/some-title'], shown.approve);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(f.git.calls.filter(c => c.sub === 'check-ref-format').map(c => [c.argv, c.cwd]), [[['check-ref-format', '--branch', 'feat/some-title'], FAKE_CHECKOUT]]);
  assert.deepEqual(checkouts(f), [['checkout', '-b', 'feat/some-title', 'origin/main']]);
  assert.equal(JSON.parse(r.stdout).branch, 'feat/some-title');
});

test('on a strip-card-id repo with no --name the derived name is used', async t => {
  const f = fixture(t, { repo: { branchNaming: 'strip-card-id' } });
  const r = await branch(f);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(checkouts(f), [['checkout', '-b', 'user/some-title', 'origin/main']]);
});

test('--name that git rejects is refused', async t => {
  const f = fixture(t, { repo: { branchNaming: 'strip-card-id' } });
  await refused(f, ['--name', 'bad..name']);
});

test('--name carrying the card id, in any case, is accepted and the branch is created', async t => {
  for (const name of ['feat/abc-1-some-title', 'feat/ABC-1']) {
    const f = fixture(t, { repo: { branchNaming: 'strip-card-id' } });
    const r = await branch(f, ['--name', name]);
    assert.equal(r.code, 0, `${name}: ${r.stderr}`);
    assert.deepEqual(checkouts(f), [['checkout', '-b', name, 'origin/main']], name);
    assert.equal(JSON.parse(r.stdout).branch, name);
  }
});

test('a branch created with a --name carrying the card id is resumed by the next plan', async t => {
  const f = fixture(t, { repo: { branchNaming: 'strip-card-id' } });
  const name = 'feat/abc-1-some-title';
  const r = await branch(f, ['--name', name]);
  assert.equal(r.code, 0, r.stderr);
  const again = await plan(f);
  assert.equal(again.branch.name, 'user/some-title');
  assert.equal(again.action, 'resume');
  assert.deepEqual(again.resume.branches.map(b => [b.name, b.where]), [[name, 'local']]);
});

test('a checkout that git refuses exits 1 with git\'s message and the key redacted', async t => {
  const f = fixture(t, { git: { checkout: { status: 1, stderr: `error: your local changes would be overwritten (${SENTINEL})` } } });
  const r = await branch(f);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /checkout failed/);
  assert.ok(!r.stderr.includes(SENTINEL));
});

const resumePlan = async (f, branches) => {
  const shown = await plan(f);
  assert.equal(shown.action, 'resume');
  assert.deepEqual(shown.resume.branches.map(b => [b.name, b.where]), branches);
  return shown;
};

test('--resume of a local branch of the card checks it out, and nextApprove is the plan on it', async t => {
  const f = fixture(t, { live: liveCheckout({ local: ['main', 'abc-1-first-try'] }) });
  const shown = await resumePlan(f, [['abc-1-first-try', 'local']]);
  const r = await branch(f, ['--resume', 'abc-1-first-try'], shown.approve);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(f.git.calls.filter(c => c.sub === 'checkout').map(c => [c.argv, c.cwd]), [[['checkout', 'abc-1-first-try'], FAKE_CHECKOUT]]);
  const out = JSON.parse(r.stdout);
  assert.deepEqual([out.action, out.branch], ['resumed', 'abc-1-first-try']);
  assert.equal(out.nextApprove, (await plan(f)).approve);
});

test('--resume of a branch only on the remote creates a local branch tracking it', async t => {
  const f = fixture(t, { live: liveCheckout({ remote: ['main', GIT_BRANCH_NAME] }) });
  const shown = await resumePlan(f, [[GIT_BRANCH_NAME, 'remote']]);
  const r = await branch(f, ['--resume', GIT_BRANCH_NAME], shown.approve);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(checkouts(f), [['checkout', '-b', GIT_BRANCH_NAME, '--track', `origin/${GIT_BRANCH_NAME}`]]);
});

test('--resume of the branch HEAD is already on runs nothing', async t => {
  const f = fixture(t, { live: liveCheckout({ local: ['main', GIT_BRANCH_NAME], current: GIT_BRANCH_NAME }) });
  const shown = await resumePlan(f, [[GIT_BRANCH_NAME, 'local']]);
  const r = await branch(f, ['--resume', GIT_BRANCH_NAME], shown.approve);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(checkouts(f), []);
  assert.deepEqual(JSON.parse(r.stdout).action, 'already-on');
});

test('--resume of a branch checked out in another worktree is refused, naming where to work', async t => {
  const f = fixture(t, { live: liveCheckout({ local: ['main', GIT_BRANCH_NAME], elsewhere: [['/fake/other', GIT_BRANCH_NAME]] }) });
  await resumePlan(f, [[GIT_BRANCH_NAME, 'worktree']]);
  const r = await refused(f, ['--resume', GIT_BRANCH_NAME]);
  assert.match(r.stderr, /\/fake\/other/);
});

test('a resume plan never creates: branch without --resume, or --resume of another branch, is refused', async t => {
  const f = fixture(t, { live: liveCheckout({ local: ['main', 'abc-1-first-try'] }) });
  await resumePlan(f, [['abc-1-first-try', 'local']]);
  const r = await refused(f, []);
  assert.match(r.stderr, /--resume abc-1-first-try/);
  await refused(f, ['--resume', 'main']);
  await refused(f, ['--resume', GIT_BRANCH_NAME]);
});

test('--resume on a create plan is refused', async t => {
  const f = fixture(t);
  await refused(f, ['--resume', GIT_BRANCH_NAME]);
});

test('--resume never renames: it takes no --name or --accept', async t => {
  const f = fixture(t, { live: liveCheckout({ local: ['main', 'abc-1-first-try'] }) });
  const hash = (await resumePlan(f, [['abc-1-first-try', 'local']])).approve;
  for (const extra of [['--name', 'feat/x'], ['--accept', 'pr-merged']]) {
    const r = await branch(f, ['--resume', 'abc-1-first-try', ...extra], hash);
    assert.equal(r.code, 2, extra.join(' '));
  }
  assert.deepEqual(checkouts(f), []);
});

// The status line hook names this file the same way; the vector pins the two copies of the name together.
test('the started file is named by an FNV-1a hash of the checkout path', () => {
  assert.equal(startedKey('/w/app'), '977955ef');
  assert.equal(startedPath('/h', '/w/app'), '/h/started/977955ef.json');
});

test('a created branch is written to the started file of its checkout, with what the status line reads from the plan', async t => {
  const f = fixture(t);
  const shown = await plan(f);
  const r = await branch(f, [], shown.approve);
  assert.equal(r.code, 0, r.stderr);
  const file = readStarted(f.home, FAKE_CHECKOUT);
  assert.equal(file.path, FAKE_CHECKOUT);
  const entry = file.branches[GIT_BRANCH_NAME];
  assert.deepEqual([entry.card, entry.slug, entry.branch, entry.action], [CARD, shown.card.project.slug, GIT_BRANCH_NAME, 'created']);
  assert.deepEqual(entry.plan.route.reasons, shown.route.reasons);
  assert.deepEqual(entry.plan.base, { kind: shown.base.kind, branch: shown.base.branch ?? null });
  assert.ok(!Number.isNaN(Date.parse(entry.at)));
});

test('a resumed branch is written beside the others of the same checkout', async t => {
  const f = fixture(t, { live: liveCheckout({ local: ['main', GIT_BRANCH_NAME] }) });
  const r = await branch(f, ['--resume', GIT_BRANCH_NAME]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readStarted(f.home, FAKE_CHECKOUT).branches[GIT_BRANCH_NAME].action, JSON.parse(r.stdout).action);
});

test('a refused branch writes no started file', async t => {
  const f = fixture(t);
  await refused(f, [], 'deadbeef');
  assert.equal(readStarted(f.home, FAKE_CHECKOUT), null);
});

test('a started file that cannot be written leaves the branch made and the output unchanged', async t => {
  const f = fixture(t);
  writeFileSync(join(f.home, 'started'), 'a file where the folder goes');
  const r = await branch(f);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).action, 'created');
});

test('the started entry carries the plan facts and the pack stamp the status line reads', async t => {
  const f = fixture(t);
  const pack = draftPack(startRecord(CARD, { openDecisions: [{ text: 'Who may see it.', impact: 'design', owner: 'people' }] }), { description: card.description }, {});
  writePack(f.dataDir, SLUG, pack);
  const shown = await plan(f);
  assert.equal((await branch(f, [], shown.approve)).code, 0);
  const entry = readStarted(f.home, FAKE_CHECKOUT).branches[GIT_BRANCH_NAME];
  assert.deepEqual(entry.packStamp, pack.stamp);
  assert.deepEqual(entry.plan.card, { key: CARD, project: { slug: SLUG } });
  assert.deepEqual(entry.plan.brief.pack, { stale: shown.brief.pack.stale, answered: shown.brief.pack.answered, open: shown.brief.pack.open });
  assert.deepEqual(Object.keys(entry).sort(), ['action', 'at', 'branch', 'card', 'packStamp', 'plan', 'slug']);
});

test('resuming the branch the checkout is already on is written too', async t => {
  const f = fixture(t, { live: liveCheckout({ local: ['main', GIT_BRANCH_NAME], current: GIT_BRANCH_NAME }) });
  const r = await branch(f, ['--resume', GIT_BRANCH_NAME]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).action, 'already-on');
  assert.equal(readStarted(f.home, FAKE_CHECKOUT).branches[GIT_BRANCH_NAME].action, 'already-on');
});
