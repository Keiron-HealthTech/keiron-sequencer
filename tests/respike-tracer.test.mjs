import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { serializeRecord, validateRecord } from '../scripts/lib/record.mjs';
import { TRIAL_DIR } from '../scripts/lib/spike/home.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import { sandboxGit } from './helpers/git-sandbox.mjs';
import { A, B, D, K, notes, P1, P2, PATCH_A, PATCH_D, PATCH_K, PROJECT_URL, SENTINEL, SLUG, respikeFixture, snapshotDir, walk } from './helpers/respike-fixture.mjs';

guardNetwork();

const json = r => JSON.parse(r.stdout);

test('a respike after a completed run replays the unbuilt ancestor, re-spikes the selected card and saves a report', async () => {
  const f = respikeFixture();
  const outputs = [];
  const keep = r => { outputs.push(r); return r; };
  const refsBefore = f.repo.git(['for-each-ref']);
  const commitsBefore = f.repo.git(['rev-list', '--count', '--all']);
  const recordA = readFileSync(join(f.dataDir, SLUG, `${A}.json`), 'utf8');
  const recordB = readFileSync(join(f.dataDir, SLUG, `${B}.json`), 'utf8');
  const homeBefore = snapshotDir(f.home);
  const dataBefore = snapshotDir(f.dataDir);
  const pick = [PROJECT_URL, '--cards', B];

  const first = keep(await f.run('preflight', pick));
  assert.equal(first.code, 0, first.stderr);
  const plan = json(first);
  assert.equal(plan.action, 'ready');
  assert.equal(plan.bases.backend.kind, 'default');
  assert.deepEqual(plan.order, [{ key: A, mode: 'replay' }, { key: B, mode: 'spike' }]);
  assert.deepEqual(plan.ancestors.map(x => ({ key: x.key, mode: x.mode, from: x.from, patches: x.patches })), [{ key: A, mode: 'replay', from: f.oldRunId, patches: [PATCH_A] }]);
  assert.match(plan.approve, /^[0-9a-f]{12}$/);
  f.at('2026-11-10T10:00:30.000Z');
  const second = keep(await f.run('preflight', pick));
  assert.equal(json(second).approve, plan.approve);
  assert.deepEqual(snapshotDir(f.home), homeBefore);
  assert.deepEqual(snapshotDir(f.dataDir), dataBefore);

  const plain = keep(await f.spike(['begin', PROJECT_URL]));
  assert.equal(json(plain).action, 'nothing-to-do');
  const unapproved = keep(await f.run('begin', pick));
  assert.equal(unapproved.code, 2);
  const wrong = keep(await f.run('begin', [...pick, '--approve', '000000000000']));
  assert.equal(wrong.code, 5);
  assert.deepEqual(snapshotDir(f.home), homeBefore);

  f.at('2026-11-10T10:01:00.000Z');
  const begun = keep(await f.run('begin', [...pick, '--approve', plan.approve]));
  assert.equal(begun.code, 0, begun.stderr);
  const { runId } = json(begun);
  assert.equal(runId, '20261110T100100Z');
  const runDir = join(f.home, SLUG, 'runs', runId);
  const state = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
  assert.equal(state.status, 'active');
  assert.ok(state.plan.respike);
  assert.equal(state.plan.cards[A].mode, 'replay');
  assert.equal(state.plan.cards[B].mode, 'spike');
  assert.deepEqual(json(keep(await f.spike(['status']))).modes, { [A]: 'replay', [B]: 'spike' });

  f.at('2026-11-10T10:02:00.000Z');
  const brief = keep(await f.spike(['next']));
  assert.equal(brief.code, 0, brief.stderr);
  const out = json(brief);
  assert.deepEqual(out.replayed, [{ card: A, status: 'replayed', patches: [PATCH_A] }]);
  assert.equal(out.action, 'card');
  assert.equal(out.card, B);

  const fresh = readFileSync(join(runDir, 'patches', PATCH_A), 'utf8');
  assert.match(fresh, /^\+line5 from A$/m);
  const treePath = join(runDir, 'trees', 't1', 'backend');
  assert.match(readFileSync(join(treePath, 'src', 'list.js'), 'utf8'), /^line3 from main\n[^]*^line5 from A$/m);
  const oldA = JSON.parse(recordA);
  const textA = readFileSync(join(f.dataDir, SLUG, `${A}.json`), 'utf8');
  const newA = JSON.parse(textA);
  assert.deepEqual(validateRecord(newA), []);
  assert.equal(textA, serializeRecord(newA));
  assert.equal(newA.refs.runId, runId);
  assert.deepEqual(newA.refs.patches, [PATCH_A]);
  assert.deepEqual(newA.replayed, { at: '2026-11-10T10:02:00.000Z', runId, fromRunId: f.oldRunId, folded: [PATCH_A] });
  for (const key of ['findings', 'cases', 'decisions', 'openDecisions', 'scope', 'spikedAt', 'effort']) assert.deepEqual(newA[key], oldA[key], key);
  assert.equal(existsSync(join(f.dataDir, SLUG, 'spike', 'history', A)), false);

  const tree = json(keep(await f.spike(['tree', 'backend'])));
  assert.equal(tree.path, treePath);
  writeFileSync(join(treePath, 'src', 'b.js'), 'export const b = 2\n');
  mkdirSync(join(runDir, 'notes'), { recursive: true });
  writeFileSync(join(runDir, 'notes', `${B}.json`), JSON.stringify(notes(B)));
  f.at('2026-11-10T10:05:00.000Z');
  const ended = keep(await f.spike(['end', B]));
  assert.equal(ended.code, 0, ended.stderr);
  assert.deepEqual(json(ended).patches, ['backend/00002-new.patch']);
  assert.doesNotMatch(readFileSync(join(runDir, 'patches', 'backend', '00002-new.patch'), 'utf8'), /line5 from A/);

  f.at('2026-11-10T10:06:00.000Z');
  const done = keep(await f.spike(['next']));
  assert.equal(done.code, 0, done.stderr);
  assert.equal(json(done).action, 'complete');
  assert.equal(json(done).respike, true);
  assert.deepEqual(walk(join(f.dataDir, SLUG, 'spike', 'history')), [`${B}/2026-11-01T11-00-00.000Z.json`]);
  assert.equal(readFileSync(join(f.dataDir, SLUG, 'spike', 'history', B, '2026-11-01T11-00-00.000Z.json'), 'utf8'), recordB);
  const newB = JSON.parse(readFileSync(join(f.dataDir, SLUG, `${B}.json`), 'utf8'));
  assert.deepEqual(validateRecord(newB), []);
  assert.equal(newB.refs.runId, runId);

  f.at('2026-11-10T10:07:00.000Z');
  const reported = keep(await f.run('report', [PROJECT_URL]));
  assert.equal(reported.code, 0, reported.stderr);
  const { action, path, ...report } = json(reported);
  assert.equal(action, 'report');
  const file = join(f.dataDir, SLUG, 'spike', `respike-${runId}.json`);
  assert.equal(path, file);
  const saved = readFileSync(file, 'utf8');
  assert.equal(saved, `${JSON.stringify(report, null, 2)}\n`);
  assert.equal(report.runId, runId);
  assert.equal(report.complete, true);
  assert.deepEqual(report.cards.map(c => ({ card: c.card, previous: c.previous })), [{ card: B, previous: { spikedAt: '2026-11-01T11:00:00.000Z', runId: f.oldRunId } }]);
  assert.deepEqual(report.cards[0].size.old, { prodLines: 1, testLines: 0, files: 1, repos: ['backend-repo'] });
  assert.deepEqual(report.cards[0].size.new, { prodLines: newB.size.prodLines, testLines: newB.size.testLines, files: newB.size.files, repos: newB.size.repos });
  assert.deepEqual(Object.keys(report.cards[0].verdict), ['old', 'new']);
  assert.deepEqual(report.replayed.map(r => ({ card: r.card, status: r.status, from: r.from })), [{ card: A, status: 'replayed', from: f.oldRunId }]);
  f.at('2026-11-10T10:08:00.000Z');
  keep(await f.run('report', [PROJECT_URL]));
  assert.equal(readFileSync(file, 'utf8'), saved);

  assert.equal(f.repo.git(['for-each-ref']), refsBefore);
  assert.equal(f.repo.git(['rev-list', '--count', '--all']), commitsBefore);
  assert.deepEqual(walk(f.dataDir).filter(p => !p.endsWith('.json')), []);
  const written = [...walk(f.dataDir).map(p => join(f.dataDir, p)), join(runDir, 'run.json')].map(p => readFileSync(p, 'utf8'));
  for (const text of [...outputs.flatMap(r => [r.stdout, r.stderr]), ...written]) assert.equal(text.includes(SENTINEL), false);
  assert.equal(f.linear.sent.filter(s => /\bmutation\b/i.test(s.body.query)).length, 0);
  assert.ok(f.gh.calls.every(c => ['pr list', 'pr view', 'pr diff'].includes(c.argv.slice(0, 2).join(' '))));
});

test('with no flags the selection is stale, and --all selects every open card', async () => {
  const f = respikeFixture();
  const plain = json(await f.run('preflight', [PROJECT_URL]));
  assert.equal(plain.selection.mode, 'stale');
  assert.deepEqual(json(await f.run('preflight', [PROJECT_URL, '--stale'])).selection.mode, 'stale');
  assert.deepEqual(json(await f.run('preflight', [PROJECT_URL, '--cards', B])).selection.mode, 'cards');
  const all = json(await f.run('preflight', [PROJECT_URL, '--all']));
  assert.equal(all.selection.mode, 'all');
  assert.notEqual(all.approve, plain.approve);
});

test('preflight with --all selects every open card, refuses a key not on the map and blocks a touched repo with no checkout', async () => {
  const f = respikeFixture();
  const all = json(await f.run('preflight', [PROJECT_URL, '--all']));
  assert.equal(all.selection.mode, 'all');
  assert.deepEqual(all.order, [{ key: A, mode: 'spike' }, { key: B, mode: 'spike' }]);
  assert.deepEqual(all.ancestors, []);

  const unknown = await f.run('preflight', [PROJECT_URL, '--cards', 'CRM-99']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /CRM-99/);

  const config = JSON.parse(readFileSync(join(f.home, 'config.json'), 'utf8'));
  config.repos.backend = { ...config.repos.backend, checkout: null, url: 'https://example.invalid/backend.git' };
  writeFileSync(join(f.home, 'config.json'), JSON.stringify(config));
  const before = f.git.calls.length;
  const blocked = await f.run('preflight', [PROJECT_URL, '--cards', B]);
  assert.equal(blocked.code, 2);
  const out = json(blocked);
  assert.equal(out.action, 'blocked');
  assert.equal(out.approve, null);
  assert.deepEqual(out.missingConfig, [{ code: 'repo-not-local', repo: 'backend', cards: [A, B] }]);
  assert.match(blocked.stderr, /backend/);
  assert.equal(f.git.calls.length, before);
});

test('an ancestor holding trial patches replays from the trial root, folds every patch it held and records no source run', async () => {
  const f = respikeFixture();
  const trial = join(f.home, SLUG, TRIAL_DIR);
  const fixupName = 'backend/fixup-1-from-9-old.patch';
  mkdirSync(join(trial, 'backend'), { recursive: true });
  writeFileSync(join(trial, PATCH_A), readFileSync(join(f.home, SLUG, 'runs', f.oldRunId, 'patches', PATCH_A)));
  writeFileSync(join(trial, fixupName), 'not applied\n');
  const oldA = JSON.parse(readFileSync(join(f.dataDir, SLUG, `${A}.json`), 'utf8'));
  const { runId: _, ...refs } = oldA.refs;
  const trialA = { ...oldA, refs, fixups: { received: [{ from: 'CRM-9', patch: fixupName, note: null }], caused: [] } };
  assert.deepEqual(validateRecord(trialA), []);
  writeFileSync(join(f.dataDir, SLUG, `${A}.json`), serializeRecord(trialA));

  const pick = [PROJECT_URL, '--cards', B, '--unbuilt', 'CRM-9'];
  const plan = json(await f.run('preflight', pick));
  assert.equal(plan.action, 'ready');
  assert.deepEqual(plan.ancestors.map(a => [a.key, a.mode, a.from, a.dropped]), [[A, 'replay', 'trial', [{ patch: fixupName, reason: 'from-absent' }]]]);
  f.at('2026-11-10T10:01:00.000Z');
  const begun = await f.run('begin', [...pick, '--approve', plan.approve]);
  assert.equal(begun.code, 0, begun.stderr);
  const { runId } = json(begun);
  f.at('2026-11-10T10:02:00.000Z');
  const next = await f.spike(['next']);
  assert.equal(next.code, 0, next.stderr);
  assert.deepEqual(json(next).replayed, [{ card: A, status: 'replayed', patches: [PATCH_A] }]);
  const newA = JSON.parse(readFileSync(join(f.dataDir, SLUG, `${A}.json`), 'utf8'));
  assert.deepEqual(validateRecord(newA), []);
  assert.deepEqual(newA.replayed, { at: '2026-11-10T10:02:00.000Z', runId, fromRunId: null, folded: [PATCH_A, fixupName] });
  assert.deepEqual(newA.refs.patches, [PATCH_A]);
  assert.ok(existsSync(join(f.home, SLUG, 'runs', runId, 'patches', PATCH_A)));
});

test('on a combine of two diverged open PRs, next replays two ancestors and turns a conflicting one into a spike, and the run completes and reports', async () => {
  const f = respikeFixture({ extended: true });
  const outputs = [];
  const keep = r => { outputs.push(r); return r; };
  const view = dir => [
    sandboxGit(['for-each-ref', '--format=%(refname) %(objectname)'], { cwd: dir }),
    sandboxGit(['rev-list', '--count', '--all'], { cwd: dir }),
  ];
  const before = { checkout: view(f.repo.dir), origin: view(f.origin.dir) };

  const plan = json(keep(await f.run('preflight', [PROJECT_URL, '--cards', B])));
  assert.equal(plan.action, 'ready');
  assert.equal(plan.bases.backend.kind, 'combine');
  assert.deepEqual(plan.bases.backend.heads.map(h => [h.card, h.sha]), [[P1, f.heads[0]], [P2, f.heads[1]]]);
  assert.deepEqual(plan.order, [A, D, K].map(key => ({ key, mode: 'replay' })).concat([{ key: B, mode: 'spike' }]));
  f.at('2026-11-10T10:01:00.000Z');
  const begun = keep(await f.run('begin', [PROJECT_URL, '--cards', B, '--approve', plan.approve]));
  assert.equal(begun.code, 0, begun.stderr);
  const { runId } = json(begun);
  const dir = join(f.home, SLUG, 'runs', runId);

  f.at('2026-11-10T10:02:00.000Z');
  const first = keep(await f.spike(['next']));
  assert.equal(first.code, 0, first.stderr);
  const out = json(first);
  assert.deepEqual(out.replayed, [
    { card: A, status: 'replayed', patches: [PATCH_A] },
    { card: D, status: 'replayed', patches: [PATCH_D] },
    { card: K, status: 'conflict', patches: [] },
  ]);
  assert.equal(out.card, K);
  assert.deepEqual(out.replayConflict, { repos: ['backend'], patch: PATCH_K, reason: 'conflict', unmerged: ['src/list.js'] });
  const state = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
  assert.deepEqual(state.tracks.t1.repos.backend.combine, { heads: [{ card: P1, sha: f.heads[0] }, { card: P2, sha: f.heads[1] }], tree: plan.bases.backend.tree });
  assert.equal(state.tracks.t1.repos.backend.baseCommit, f.heads[0]);
  const treePath = state.tracks.t1.repos.backend.path;
  assert.match(readFileSync(join(treePath, 'src', 'list.js'), 'utf8'), /^line3 from main\n[^]*^line5 from A\n[^]*^line8 from P1$/m);
  assert.equal(readFileSync(join(treePath, 'p2.txt'), 'utf8'), 'from P2\n');

  const play = async (card, file, at) => {
    assert.equal(json(keep(await f.spike(['tree', 'backend']))).path, treePath);
    writeFileSync(join(treePath, file), `${card}\n`);
    mkdirSync(join(dir, 'notes'), { recursive: true });
    writeFileSync(join(dir, 'notes', `${card}.json`), JSON.stringify(notes(card)));
    f.at(at);
    const ended = keep(await f.spike(['end', card]));
    assert.equal(ended.code, 0, ended.stderr);
    return json(ended);
  };
  assert.deepEqual((await play(K, 'k.txt', '2026-11-10T10:05:00.000Z')).patches, [PATCH_K]);
  f.at('2026-11-10T10:06:00.000Z');
  assert.equal(json(keep(await f.spike(['next']))).card, B);
  await play(B, 'b.txt', '2026-11-10T10:08:00.000Z');
  f.at('2026-11-10T10:09:00.000Z');
  const done = json(keep(await f.spike(['next'])));
  assert.deepEqual([done.action, done.respike], ['complete', true]);

  for (const card of [A, D, K, B]) {
    const record = JSON.parse(readFileSync(join(f.dataDir, SLUG, `${card}.json`), 'utf8'));
    assert.deepEqual(validateRecord(record), [], card);
    assert.equal(record.refs.runId, runId, card);
  }
  assert.deepEqual(walk(join(f.dataDir, SLUG, 'spike', 'history')).map(p => p.split('/')[0]), [B, K]);
  f.at('2026-11-10T10:10:00.000Z');
  const reported = keep(await f.run('report', [PROJECT_URL]));
  assert.equal(reported.code, 0, reported.stderr);
  const file = join(f.dataDir, SLUG, 'spike', `respike-${runId}.json`);
  assert.ok(existsSync(file));

  assert.deepEqual({ checkout: view(f.repo.dir), origin: view(f.origin.dir) }, before);
  assert.deepEqual(walk(f.dataDir).filter(p => !p.endsWith('.json')), []);
  const written = [...walk(f.dataDir).map(p => join(f.dataDir, p)), join(dir, 'run.json')].map(p => readFileSync(p, 'utf8'));
  for (const text of [...outputs.flatMap(r => [r.stdout, r.stderr]), ...written]) assert.equal(text.includes(SENTINEL), false);
});

test('reading the trial reference from the home: a trial replay with no reference stops preflight with exit 2 naming the path, and with it in place the patches follow its log order', async () => {
  const f = respikeFixture();
  const trial = join(f.home, SLUG, TRIAL_DIR);
  const later = 'backend/00002-more.patch';
  mkdirSync(join(trial, 'backend'), { recursive: true });
  writeFileSync(join(trial, PATCH_A), readFileSync(join(f.home, SLUG, 'runs', f.oldRunId, 'patches', PATCH_A)));
  writeFileSync(join(trial, later), 'diff --git a/more b/more\n');
  const pick = [PROJECT_URL, '--cards', B];
  const fromHome = { trialLogDir: undefined };
  const fromRun = await f.run('preflight', pick, fromHome);
  assert.equal(fromRun.code, 0, fromRun.stderr);
  assert.deepEqual(json(fromRun).ancestors.map(a => [a.key, a.from]), [[A, f.oldRunId]]);

  const oldA = JSON.parse(readFileSync(join(f.dataDir, SLUG, `${A}.json`), 'utf8'));
  const { runId: _, ...refs } = oldA.refs;
  writeFileSync(join(f.dataDir, SLUG, `${A}.json`), serializeRecord({ ...oldA, refs: { ...refs, patches: [PATCH_A, later] } }));
  const reference = join(f.home, SLUG, 'trial-reference');
  const stopped = await f.run('preflight', pick, fromHome);
  assert.equal(stopped.code, 2, stopped.stdout);
  assert.equal(stopped.stdout, '');
  assert.ok(stopped.stderr.includes(reference), stopped.stderr);
  assert.match(stopped.stderr, /move-reference\.mjs/);

  mkdirSync(join(reference, 'backend'), { recursive: true });
  writeFileSync(join(reference, 'backend', 'log.txt'), ['00002-more', '00001-new'].map(n => `${n} ${'a'.repeat(40)}\n`).join(''));
  const ready = await f.run('preflight', pick, fromHome);
  assert.equal(ready.code, 0, ready.stderr);
  assert.deepEqual(json(ready).ancestors.map(a => [a.key, a.mode, a.from, a.units]), [[A, 'replay', 'trial', { backend: [later, PATCH_A] }]]);
});
