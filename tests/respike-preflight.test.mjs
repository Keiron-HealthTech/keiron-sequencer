import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseProjectRef } from '../scripts/lib/linear-fetch.mjs';
import { buildRespikePlan } from '../scripts/lib/respike/plan.mjs';
import { runDir, writeJsonAtomic } from '../scripts/lib/spike/home.mjs';
import { createRun } from '../scripts/lib/spike/state.mjs';
import { subcommandOf } from './helpers/fake-git.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import { A, B, issue, PROJECT_URL, SENTINEL, SLUG, respikeFixture, snapshotDir, walk } from './helpers/respike-fixture.mjs';

guardNetwork();

const P = 'CRM-3';
const Q = 'CRM-4';
const json = r => JSON.parse(r.stdout);
const blocks = (...keys) => ({ nodes: keys.map(k => ({ type: 'blocks', relatedIssue: { identifier: k } })) });
const inReview = { state: { name: 'In Review', type: 'started' } };

// A blocks B as in the tracer; P and Q are cards with open PRs that also block B.
function withPrs({ extra = [], cycle = false } = {}) {
  const prs = [];
  const f = respikeFixture({
    gh: () => JSON.stringify(prs),
    issues: ([a, b]) => [
      a, cycle ? { ...b, relations: blocks(A) } : b,
      issue(P, { ...inReview, relations: blocks(B) }), issue(Q, { ...inReview, relations: blocks(B) }), ...extra,
    ],
  });
  const branch = (name, file, content, from = 'main') => {
    f.repo.git(['checkout', '-q', name === from ? name : '-B', ...(name === from ? [] : [name, from])].filter(Boolean));
    writeFileSync(join(f.repo.dir, file), content);
    f.repo.git(['add', '-A']);
    f.repo.git(['commit', '-q', '-m', `${name} ${file}`]);
    const sha = f.repo.git(['rev-parse', 'HEAD']).trim();
    f.repo.git(['checkout', '-q', 'main']);
    return sha;
  };
  const pr = (number, key, headRefName, headRefOid) => ({
    number, state: 'OPEN', isDraft: false, mergedAt: null, baseRefName: 'main', headRefName, headRefOid, isCrossRepository: false,
    title: `[${key}] work`, url: `https://github.com/acme/backend/pull/${number}`,
  });
  return { f, prs, branch, pr };
}

const pick = [PROJECT_URL, '--cards', B];
const KEYS = ['schemaVersion', 'approve', 'action', 'project', 'previous', 'selection', 'built', 'ancestors', 'bases', 'order', 'tracks', 'asks', 'stops', 'missingConfig', 'warnings'];

test('the plan carries every top-level key and no diff text', async () => {
  const { f } = withPrs();
  const r = await f.run('preflight', pick);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(Object.keys(json(r)), KEYS);
  for (const marker of ['diff --git', '+++ b/', '--- a/', '@@ -']) assert.equal(r.stdout.includes(marker), false, marker);
});

test('a needed open PR is the pinned base; a moved head and each answer change approve, a moved default tip does not', async () => {
  const { f, prs, branch, pr } = withPrs();
  const p1 = branch('p3', 'p.txt', 'p\n');
  prs.push(pr(30, P, 'p3', p1));
  const first = json(await f.run('preflight', pick));
  assert.equal(first.action, 'ready');
  assert.deepEqual(first.bases.backend, { kind: 'pr', ref: 'refs/pull/30/head', sha: p1, card: P, heads: null, tree: null, behind: 0, ownCommits: 1, warning: null });
  assert.deepEqual(first.built.map(b => [b.key, b.kind, b.needed]), [[P, 'pr', true]]);
  assert.deepEqual(first.order, [{ key: A, mode: 'replay' }, { key: Q, mode: 'spike' }, { key: B, mode: 'spike' }]);
  assert.equal(json(await f.run('preflight', pick)).approve, first.approve);

  writeFileSync(join(f.repo.dir, 'main.txt'), 'm\n');
  f.repo.git(['add', '-A']);
  f.repo.git(['commit', '-q', '-m', 'main moves']);
  f.repo.git(['push', '-q', 'origin', 'main']);
  f.repo.git(['fetch', '-q', 'origin']);
  const behind = json(await f.run('preflight', pick));
  assert.equal(behind.bases.backend.behind, 1);
  assert.equal(behind.bases.backend.warning, 'base 1 commits behind default');
  assert.equal(behind.approve, first.approve);

  const unbuilt = json(await f.run('preflight', [...pick, '--unbuilt', P]));
  assert.deepEqual(unbuilt.order, [{ key: A, mode: 'replay' }, { key: P, mode: 'spike' }, { key: Q, mode: 'spike' }, { key: B, mode: 'spike' }]);
  assert.equal(unbuilt.bases.backend.kind, 'default');
  assert.notEqual(unbuilt.approve, first.approve);

  prs[0] = pr(30, P, 'p3', branch('p3', 'p.txt', 'p moved\n', 'p3'));
  const moved = json(await f.run('preflight', pick));
  assert.notEqual(moved.approve, first.approve);

  prs.push(pr(40, Q, 'q4', branch('q4', 'q.txt', 'q\n')));
  const combined = json(await f.run('preflight', pick));
  assert.equal(combined.bases.backend.kind, 'combine');
  assert.deepEqual(combined.bases.backend.heads.map(h => h.card), [P, Q]);
  assert.match(combined.bases.backend.tree, /^[0-9a-f]{40}$/);
  prs[1] = pr(40, Q, 'q4', branch('q4', 'q.txt', 'q moved\n', 'q4'));
  const recombined = json(await f.run('preflight', pick));
  assert.notEqual(recombined.bases.backend.tree, combined.bases.backend.tree);
  assert.notEqual(recombined.approve, combined.approve);
});

function runIn(f, status) {
  const project = { id: 'project-uuid', slug: SLUG, name: 'P', url: PROJECT_URL };
  const runId = '20261105T100000Z';
  const state = createRun({ runId, project, plan: { fetchedAt: '2026-11-05T10:00:00.000Z', order: [], skipped: [], cards: {} }, home: f.home, dataDir: f.dataDir, now: new Date('2026-11-05T10:00:00.000Z') });
  state.status = status;
  writeJsonAtomic(join(runDir(f.home, SLUG, runId), 'run.json'), state);
  return runId;
}

test('an active or paused run refuses with exit 5 naming it; an abandoned newest run does not; missing config is reported first', async () => {
  const { f } = withPrs();
  const runId = runIn(f, 'paused');
  const paused = await f.run('preflight', pick);
  assert.equal(paused.code, 5);
  assert.match(paused.stderr, new RegExp(runId));
  assert.match(paused.stderr, /spike\.mjs begin/);
  assert.match(paused.stderr, /abandon/);
  const config = JSON.parse(readFileSync(join(f.home, 'config.json'), 'utf8'));
  writeFileSync(join(f.home, 'config.json'), JSON.stringify({ ...config, repos: { backend: { ...config.repos.backend, risk: undefined } } }));
  const blocked = await f.run('preflight', pick);
  assert.equal(blocked.code, 2);
  assert.equal(json(blocked).action, 'blocked');
  writeFileSync(join(f.home, 'config.json'), JSON.stringify(config));
  runIn(f, 'abandoned');
  assert.equal((await f.run('preflight', pick)).code, 0);
});

test('a cycle through a run card is a stop plan; a card with an unanswered local branch asks; nothing left to spike is nothing-to-do', async () => {
  const stop = withPrs({ cycle: true });
  const stopped = await stop.f.run('preflight', pick);
  assert.equal(stopped.code, 0);
  assert.deepEqual([json(stopped).action, json(stopped).approve], ['stop', null]);
  assert.deepEqual(json(stopped).stops.map(s => [s.code, s.members]), [['cycle', [A, B]]]);

  const asking = withPrs({ extra: [issue('CRM-5')] });
  asking.branch('crm-5-wip', 'five.txt', '5\n');
  const askedRun = await asking.f.run('preflight', pick);
  assert.equal(askedRun.code, 0);
  const asked = json(askedRun);
  assert.equal(asked.action, 'ask');
  assert.match(asked.approve, /^[0-9a-f]{12}$/);
  assert.deepEqual(asked.asks.map(a => [a.code, a.card, a.branches]), [['local-branch', 'CRM-5', ['crm-5-wip']]]);
  const answered = json(await asking.f.run('preflight', [...pick, '--unbuilt', 'CRM-5']));
  assert.equal(answered.action, 'ready');
  assert.notEqual(answered.approve, asked.approve);

  const { f, prs, branch, pr } = withPrs();
  prs.push(pr(30, P, 'p3', branch('p3', 'p.txt', 'p\n')));
  const noneRun = await f.run('preflight', [PROJECT_URL, '--cards', P]);
  assert.equal(noneRun.code, 0);
  const none = json(noneRun);
  assert.deepEqual([none.action, none.approve, none.order], ['nothing-to-do', null, []]);
  assert.deepEqual(none.selection.dropped, [{ key: P, reason: 'built' }]);
});

const READS = ['for-each-ref', 'rev-parse', 'cat-file', 'rev-list', 'log', 'merge-base', 'merge-tree', 'diff'];

test('preflight runs only read-only git; the combine writes its objects in a temp dir outside home, data dir and repo, removed afterwards', async () => {
  const { f, prs, branch, pr } = withPrs();
  prs.push(pr(30, P, 'p3', branch('p3', 'p.txt', 'p\n')), pr(40, Q, 'q4', branch('q4', 'q.txt', 'q\n')));
  const objects = resolve(f.repo.dir, f.repo.git(['rev-parse', '--git-path', 'objects']).trim());
  const before = {
    home: snapshotDir(f.home), data: snapshotDir(f.dataDir), objects: snapshotDir(objects), refs: f.repo.git(['for-each-ref']),
    index: readFileSync(join(f.repo.dir, '.git', 'index')).toString('base64'), files: walk(f.repo.dir).filter(p => !p.startsWith('.git/')),
  };
  const r = await f.run('preflight', [...pick, '--stale']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(json(r).bases.backend.kind, 'combine');
  const subs = f.git.calls.map(c => subcommandOf(c.argv));
  assert.deepEqual([...new Set(subs)].filter(s => !READS.includes(s)), []);
  const merges = f.git.calls.filter(c => subcommandOf(c.argv) === 'merge-tree');
  assert.ok(merges.length > 0);
  for (const c of merges) {
    const dir = c.env?.GIT_OBJECT_DIRECTORY;
    assert.ok(dir && dir.startsWith(join(f.scratch, 'keiron-sequencer-combine-')), dir);
    for (const root of [f.home, f.dataDir, f.repo.dir]) assert.equal(dir.startsWith(root), false);
  }
  assert.deepEqual(readdirSync(f.scratch).filter(n => n.startsWith('keiron-sequencer-combine-')), []);
  assert.deepEqual(snapshotDir(f.home), before.home);
  assert.deepEqual(snapshotDir(f.dataDir), before.data);
  assert.deepEqual(snapshotDir(objects), before.objects);
  assert.equal(f.repo.git(['for-each-ref']), before.refs);
  assert.equal(readFileSync(join(f.repo.dir, '.git', 'index')).toString('base64'), before.index);
  assert.deepEqual(walk(f.repo.dir).filter(p => !p.startsWith('.git/')), before.files);
});

test('two needed PRs that conflict ask combine-conflict; --unbuilt on one makes the other PR the base and puts the demoted card in the order', async () => {
  const { f, prs, branch, pr } = withPrs();
  const p3 = branch('p3', 'shared.txt', 'from p\n');
  prs.push(pr(30, P, 'p3', p3), pr(40, Q, 'q4', branch('q4', 'shared.txt', 'from q\n')));
  const asked = json(await f.run('preflight', pick));
  assert.equal(asked.action, 'ask');
  assert.match(asked.approve, /^[0-9a-f]{12}$/);
  assert.deepEqual(asked.asks.map(a => [a.code, a.repoDir, a.cards, a.paths, a.answers]), [
    ['combine-conflict', 'backend', [P, Q], ['shared.txt'], [`--unbuilt ${P}`, `--unbuilt ${Q}`]],
  ]);
  const demoted = json(await f.run('preflight', [...pick, '--unbuilt', Q]));
  assert.equal(demoted.action, 'ready');
  assert.deepEqual([demoted.bases.backend.kind, demoted.bases.backend.card, demoted.bases.backend.sha], ['pr', P, p3]);
  assert.deepEqual(demoted.order.map(e => e.key).sort(), [A, B, Q].sort());
  assert.equal(demoted.order.find(e => e.key === Q).mode, 'spike');
  assert.deepEqual(demoted.built.filter(b => b.needed).map(b => b.key), [P]);
});

test('a url-only repo blocks before any git runs: no base, no combine, no local-branch ask and no hash', async () => {
  const { f, prs, branch, pr } = withPrs();
  prs.push(pr(30, P, 'p3', branch('p3', 'p.txt', 'p\n')), pr(40, Q, 'q4', branch('q4', 'q.txt', 'q\n')));
  branch('crm-1-wip', 'one.txt', '1\n');
  const local = json(await f.run('preflight', pick));
  assert.equal(local.bases.backend.kind, 'combine');
  assert.deepEqual(local.asks.map(a => [a.code, a.card]), [['local-branch', A]]);

  const config = JSON.parse(readFileSync(join(f.home, 'config.json'), 'utf8'));
  config.repos.backend = { ...config.repos.backend, checkout: null, url: 'https://example.invalid/backend.git' };
  writeFileSync(join(f.home, 'config.json'), JSON.stringify(config));
  const home = snapshotDir(f.home);
  const data = snapshotDir(f.dataDir);
  const calls = f.git.calls.length;
  const r = await f.run('preflight', pick);
  assert.equal(r.code, 2);
  const blocked = json(r);
  assert.equal(blocked.action, 'blocked');
  assert.equal(blocked.approve, null);
  assert.deepEqual(blocked.missingConfig.filter(g => g.code === 'repo-not-local').map(g => g.repo), ['backend']);
  assert.deepEqual([blocked.asks, blocked.bases], [[], {}]);
  assert.equal(f.git.calls.length, calls);
  assert.deepEqual(snapshotDir(f.home), home);
  assert.deepEqual(snapshotDir(f.dataDir), data);
});

test('exit codes: usage and coverage are 2, a missing key is 3 with no request, and the key never shows on any path', async () => {
  const { f } = withPrs();
  const outputs = [];
  const keep = r => { outputs.push(r); return r; };
  assert.equal(keep(await f.run('preflight', [PROJECT_URL, '--cards', 'CRM-404'])).code, 2);
  const malformed = keep(await f.run('preflight', [...pick, '--built', 'CRM-5']));
  assert.equal(malformed.code, 2);
  assert.match(malformed.stderr, /--built/);

  const sentBefore = f.linear.sent.length;
  const noKey = keep(await f.run('preflight', pick, { keyFile: join(f.scratch, 'absent') }));
  assert.equal(noKey.code, 3);
  assert.equal(f.linear.sent.length, sentBefore);

  const ghFails = keep(await f.run('preflight', pick, { gh: () => ({ status: 1, stdout: '', stderr: `bad credentials ${SENTINEL}` }) }));
  assert.equal(ghFails.code, 1);
  assert.match(ghFails.stderr, /acme\/backend/);
  const linearFails = keep(await f.run('preflight', pick, {
    fetchImpl: async () => new Response(JSON.stringify({ errors: [{ message: `token ${SENTINEL} rejected` }] }), { status: 400, headers: { 'content-type': 'application/json' } }),
  }));
  assert.equal(linearFails.code, 1);

  const config = JSON.parse(readFileSync(join(f.home, 'config.json'), 'utf8'));
  writeFileSync(join(f.home, 'config.json'), JSON.stringify({ ...config, repos: { backend: { ...config.repos.backend, github: null, risk: undefined } } }));
  const blocked = keep(await f.run('preflight', pick));
  assert.equal(blocked.code, 2);
  assert.deepEqual(json(blocked).missingConfig.map(g => g.code), ['github-missing', 'risk-missing']);
  assert.equal(blocked.stderr.trim().split('\n').length, 2);
  for (const r of outputs) for (const text of [r.stdout, r.stderr]) assert.equal(text.includes(SENTINEL), false);
});

test('a plan over an empty or partial config given in memory stops at coverage without throwing and leaves the home as it was', async () => {
  const f = respikeFixture();
  const { ref } = parseProjectRef(PROJECT_URL);
  const home = snapshotDir(f.home);
  const empty = await buildRespikePlan(ref, f.key, { config: { schemaVersion: 1, repos: {} }, coverageOnly: true }, f.deps);
  assert.deepEqual(Object.keys(empty).sort(), ['config', 'coverage', 'raw', 'slug', 'touched']);
  assert.deepEqual(empty.coverage, {
    missingConfig: [{ code: 'trial-dir-unmapped', repo: 'backend', cards: [A] }, { code: 'repo-missing', repo: 'backend-repo', cards: [A, B] }],
    warnings: [],
  });
  assert.equal(f.gh.calls.length, 0);

  const partial = { schemaVersion: 1, repos: { backend: { name: 'backend-repo', github: 'acme/backend', checkout: f.repo.dir } } };
  const { coverage } = await buildRespikePlan(ref, f.key, { cards: [B], config: partial, coverageOnly: true }, f.deps);
  assert.deepEqual(coverage.missingConfig.map(g => [g.code, g.repo]), [
    ['default-branch-missing', 'backend'], ['remote-missing', 'backend'], ['setup-missing', 'backend'], ['risk-missing', 'backend'],
  ]);
  assert.deepEqual(snapshotDir(f.home), home);
});

test('records left in the repo data dir, with none in the data dir, are a data-in-repo warning naming the move', async () => {
  const { f } = withPrs();
  const empty = join(f.scratch, 'empty-data');
  const r = await f.run('preflight', pick, { dataDir: empty, repoDataDir: f.dataDir });
  assert.equal(r.code, 0, r.stderr);
  const w = json(r).warnings.find(x => x.code === 'data-in-repo');
  assert.ok(w, JSON.stringify(json(r).warnings));
  assert.match(w.message, /move-data\.mjs/);
});

const moveMain = f => {
  writeFileSync(join(f.repo.dir, 'main.txt'), `m ${Date.now()}\n`);
  f.repo.git(['add', '-A']);
  f.repo.git(['commit', '-q', '-m', 'main moves']);
  f.repo.git(['push', '-q', 'origin', 'main']);
  f.repo.git(['fetch', '-q', 'origin']);
};

test('--with-default merges the default tip into a base behind it, as one more head, and changes the hash', async () => {
  const { f, prs, branch, pr } = withPrs();
  prs.push(pr(30, P, 'p3', branch('p3', 'p.txt', 'p\n')));
  moveMain(f);
  const behind = json(await f.run('preflight', pick));
  assert.deepEqual([behind.bases.backend.behind, behind.bases.backend.ownCommits], [1, 1]);
  const caught = json(await f.run('preflight', [...pick, '--with-default', 'backend']));
  assert.equal(caught.action, 'ready');
  assert.equal(caught.bases.backend.kind, 'combine');
  assert.deepEqual(caught.bases.backend.heads.map(h => [h.card, h.kind]), [[P, 'pr'], [null, 'default']]);
  assert.equal(caught.bases.backend.behind, 0);
  assert.notEqual(caught.approve, behind.approve);
});

test('fast-forward moves a local branch with no own commits to the default tip on the approved hash, and refuses one with own commits', async () => {
  const { f, branch } = withPrs();
  f.repo.git(['branch', 'crm-3-old', 'main']);
  const old = f.repo.git(['rev-parse', 'crm-3-old']).trim();
  moveMain(f);
  const tip = f.repo.git(['rev-parse', 'origin/main']).trim();
  const answered = [...pick, '--built', `${P}=crm-3-old`];
  const plan = json(await f.run('preflight', answered));
  assert.deepEqual([plan.bases.backend.kind, plan.bases.backend.behind, plan.bases.backend.ownCommits], ['local', 1, 0]);

  const wrong = await f.run('fast-forward', [...answered, '--repo', 'backend', '--approve', 'f'.repeat(12)]);
  assert.equal(wrong.code, 5);
  assert.equal(f.repo.git(['rev-parse', 'crm-3-old']).trim(), old);

  const r = await f.run('fast-forward', [...answered, '--repo', 'backend', '--approve', plan.approve]);
  assert.equal(r.code, 0, r.stderr);
  const out = json(r);
  assert.deepEqual([out.action, out.repo, out.branch, out.from, out.to], ['fast-forward', 'backend', 'crm-3-old', old, tip]);
  assert.equal(f.repo.git(['rev-parse', 'crm-3-old']).trim(), tip);
  assert.equal(out.nextApprove, json(await f.run('preflight', answered)).approve);

  const own = branch('crm-3-own', 'p.txt', 'p\n');
  moveMain(f);
  const ownAnswered = [...pick, '--built', `${P}=crm-3-own`];
  const ownPlan = json(await f.run('preflight', ownAnswered));
  assert.deepEqual([ownPlan.bases.backend.ownCommits > 0, ownPlan.bases.backend.behind], [true, 1]);
  const refused = await f.run('fast-forward', [...ownAnswered, '--repo', 'backend', '--approve', ownPlan.approve]);
  assert.equal(refused.code, 5);
  assert.match(refused.stderr, /own commit/);
  assert.match(refused.stderr, /--with-default backend/);
  assert.equal(f.repo.git(['rev-parse', 'crm-3-own']).trim(), own);
});

test('open execution cards with no milestone are a no-milestone warning, listed, to assign before begin', async () => {
  const ms = { projectMilestone: { id: 'ms-1', name: 'Build' } };
  const f = respikeFixture({ issues: ([a, b]) => [{ ...a, ...ms }, b, issue('CRM-9', { state: { name: 'Done', type: 'completed' } })] });
  const out = json(await f.run('preflight', pick));
  const w = out.warnings.find(x => x.code === 'no-milestone');
  assert.ok(w, JSON.stringify(out.warnings));
  assert.deepEqual(w.cards, [B]);
  assert.match(w.message, /assign/);
});
