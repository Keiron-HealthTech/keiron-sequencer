import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cardSizes } from '../scripts/lib/patch-stats.mjs';
import { serializeRecord, validateRecord } from '../scripts/lib/record.mjs';
import { TRIAL_DIR } from '../scripts/lib/spike/home.mjs';
import { verdict } from '../scripts/lib/records.mjs';
import { parseCardPatchName } from '../scripts/lib/spike/snapshot.mjs';
import { fakeSetup, makeBareOrigin, makeRepo, sandboxGit } from './helpers/git-sandbox.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import { appendTranscript, usageEntry } from './helpers/spike-fixture.mjs';
import { A, B, issue, linePatch, notes, OLD_RUN, oldRecord, PATCH_A, PROJECT_URL, SLUG, respikeFixture, walk } from './helpers/respike-fixture.mjs';

guardNetwork();

const json = r => JSON.parse(r.stdout);
const pick = [PROJECT_URL, '--cards', B];

async function begin(f, argv = pick, caps = []) {
  const plan = json(await f.run('preflight', argv));
  assert.equal(plan.action, 'ready', JSON.stringify(plan.asks));
  f.at('2026-11-10T10:01:00.000Z');
  const r = await f.run('begin', [...argv, '--approve', plan.approve, ...caps]);
  assert.equal(r.code, 0, r.stderr);
  const { runId } = json(r);
  f.at('2026-11-10T10:02:00.000Z');
  return { runId, dir: join(f.home, SLUG, 'runs', runId), plan };
}

const readState = dir => JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
const recordText = (f, card) => readFileSync(join(f.dataDir, SLUG, `${card}.json`), 'utf8');

// main moves the given line of src/list.js and the origin follows, so the tree opens on it.
function moveMain(f, line, text) {
  writeFileSync(join(f.repo.dir, 'src', 'list.js'), `${readFileSync(join(f.repo.dir, 'src', 'list.js'), 'utf8').split('\n').map(l => (l === line ? text : l)).join('\n')}`);
  f.repo.git(['commit', '-q', '-am', `main: ${text}`]);
  f.repo.git(['push', '-q', 'origin', 'main']);
}

// The tree is detached at its base with no commit, holds exactly its last snapshot, and refuses a push.
function assertTreeClean(f, repo) {
  assert.equal(sandboxGit(['rev-list', '--count', `${repo.baseCommit}..HEAD`], { cwd: repo.path }).trim(), '0');
  sandboxGit(['add', '-A'], { cwd: repo.path });
  assert.equal(sandboxGit(['write-tree'], { cwd: repo.path }).trim(), repo.last);
  assert.equal(sandboxGit(['ls-files', '-u'], { cwd: repo.path }), '');
  assert.throws(() => sandboxGit(['push', '-q', f.origin.dir, 'HEAD:refs/heads/spiked'], { cwd: repo.path }), /failed/);
}

test('a conflicting replay turns the entry into a spike in place, touching neither the tree nor the record, and next hands it out with the conflict', async () => {
  const f = respikeFixture();
  moveMain(f, 'line5', 'line5 from main');
  const before = recordText(f, A);
  const { dir } = await begin(f);
  const r = await f.spike(['next']);
  assert.equal(r.code, 0, r.stderr);
  const out = json(r);
  assert.deepEqual(out.replayed, [{ card: A, status: 'conflict', patches: [] }]);
  assert.equal(out.action, 'card');
  assert.equal(out.card, A);
  assert.deepEqual(out.replayConflict, { repos: ['backend'], patch: PATCH_A, reason: 'conflict', unmerged: ['src/list.js'] });
  const state = readState(dir);
  assert.equal(state.plan.cards[A].mode, 'spike');
  assert.equal(state.cards[A].status, 'in-progress');
  assert.deepEqual(state.cards[A].replay.conflict, { repo: 'backend', patch: PATCH_A, reason: 'conflict', unmerged: ['src/list.js'] });
  assert.equal(state.cards[A].replay.status, 'conflict');
  assert.deepEqual(state.plan.order, [A, B]);
  assertTreeClean(f, state.tracks.t1.repos.backend);
  assert.equal(state.tracks.t1.repos.backend.last, state.tracks.t1.repos.backend.baseTree);
  assert.deepEqual(walk(join(dir, 'patches')), []);
  assert.equal(recordText(f, A), before);
});

test('a multi-repo unit that conflicts in its second repo leaves the first repo untouched and writes no patch', async () => {
  const web = makeRepo();
  writeFileSync(join(web.dir, 'src', 'index.js'), 'export const one = 1\nexport const two = 2\n');
  web.git(['commit', '-q', '-am', 'two']);
  const webOrigin = makeBareOrigin({ from: web.dir });
  web.git(['remote', 'add', 'origin', webOrigin.dir]);
  web.git(['fetch', '-q', 'origin']);
  const f = respikeFixture({
    config: c => ({
      ...c,
      repos: { ...c.repos, web: { ...c.repos.backend, name: 'web-repo', github: 'acme/web', checkout: web.dir } },
      projects: { [SLUG]: { repos: ['backend', 'web'] } },
    }),
  });
  const conflicting = ['diff --git a/src/index.js b/src/index.js', '--- a/src/index.js', '+++ b/src/index.js', '@@ -1,2 +1,2 @@', ' export const one = 1', '-export const two = 22', '+export const two = 3', ''].join('\n');
  mkdirSync(join(f.home, SLUG, 'runs', OLD_RUN, 'patches', 'web'), { recursive: true });
  writeFileSync(join(f.home, SLUG, 'runs', OLD_RUN, 'patches', 'web', '00001-new.patch'), conflicting);
  const before = recordText(f, A);
  const { dir } = await begin(f);
  const state = readState(dir);
  state.plan.respike.replay[A].units.web = ['web/00001-new.patch'];
  writeFileSync(join(dir, 'run.json'), JSON.stringify(state));
  const out = json(await f.spike(['next']));
  assert.deepEqual(out.replayed, [{ card: A, status: 'conflict', patches: [] }]);
  assert.equal(out.replayConflict.repos[0], 'web');
  assert.equal(out.replayConflict.patch, 'web/00001-new.patch');
  const after = readState(dir);
  assertTreeClean(f, after.tracks.t1.repos.backend);
  assert.equal(after.tracks.t1.repos.backend.last, after.tracks.t1.repos.backend.baseTree);
  assert.deepEqual(after.tracks.t1.repos.backend.log, []);
  assert.doesNotMatch(readFileSync(join(after.tracks.t1.repos.backend.path, 'src', 'list.js'), 'utf8'), /line5 from A/);
  assert.deepEqual(walk(join(dir, 'patches')), []);
  assert.equal(recordText(f, A), before);
  web.dispose();
  webOrigin.dispose();
});

test('a replay that applies cleanly but changes nothing is empty: no patch, the record byte-identical, the card done', async () => {
  const f = respikeFixture();
  moveMain(f, 'line5', 'line5 from A');
  const before = recordText(f, A);
  const { dir } = await begin(f);
  const out = json(await f.spike(['next']));
  assert.deepEqual(out.replayed, [{ card: A, status: 'empty', patches: [] }]);
  assert.equal(out.card, B);
  const state = readState(dir);
  assert.equal(state.cards[A].status, 'done');
  assert.equal(state.cards[A].replay.status, 'empty');
  assert.equal(state.plan.cards[A].mode, 'replay');
  assert.deepEqual(walk(join(dir, 'patches')), []);
  assert.equal(recordText(f, A), before);
  assertTreeClean(f, state.tracks.t1.repos.backend);
});

test('a patch whose pre-image blob is missing and whose context no longer matches is a no-preimage conflict', async () => {
  const f = respikeFixture();
  const orphan = ['diff --git a/src/list.js b/src/list.js', 'index 1234567..89abcde 100644', '--- a/src/list.js', '+++ b/src/list.js', '@@ -4,3 +4,3 @@', ' line4 elsewhere', '-line5 elsewhere', '+line5 from A', ' line6 elsewhere', ''].join('\n');
  writeFileSync(join(f.home, SLUG, 'runs', OLD_RUN, 'patches', PATCH_A), orphan);
  const { dir } = await begin(f);
  const out = json(await f.spike(['next']));
  assert.equal(out.card, A);
  assert.equal(out.replayConflict.reason, 'no-preimage');
  assert.deepEqual(out.replayConflict.unmerged, []);
  const state = readState(dir);
  assert.equal(state.cards[A].replay.conflict.reason, 'no-preimage');
  assertTreeClean(f, state.tracks.t1.repos.backend);
});

const FAKE_KEY = `AKIA${'Q'.repeat(16)}`;

test('a replay whose fresh diff holds a secret turns into a spike with the hits listed by place and kind, and writes nothing', async () => {
  const f = respikeFixture();
  const secret = ['diff --git a/src/keys.js b/src/keys.js', 'new file mode 100644', '--- /dev/null', '+++ b/src/keys.js', '@@ -0,0 +1,2 @@', '+export const id = 1', `+export const key = '${FAKE_KEY}'`, ''].join('\n');
  writeFileSync(join(f.home, SLUG, 'runs', OLD_RUN, 'patches', PATCH_A), secret);
  const before = recordText(f, A);
  const { dir } = await begin(f);
  const r = await f.spike(['next']);
  assert.equal(r.code, 0, r.stderr);
  const out = json(r);
  assert.deepEqual(out.replayed, [{ card: A, status: 'secret', patches: [] }]);
  assert.equal(out.card, A);
  const hits = [{ patch: PATCH_A, path: 'src/keys.js', line: 2, kind: 'aws-access-key' }];
  assert.deepEqual(out.replaySecret, { hits });
  const state = readState(dir);
  assert.deepEqual(state.cards[A].replay.hits, hits);
  assert.equal(state.plan.cards[A].mode, 'spike');
  assert.deepEqual(walk(join(dir, 'patches')), []);
  assert.equal(recordText(f, A), before);
  assert.equal(existsSync(join(state.tracks.t1.repos.backend.path, 'src', 'keys.js')), false);
  assertTreeClean(f, state.tracks.t1.repos.backend);
  for (const text of [r.stdout, r.stderr, readFileSync(join(dir, 'run.json'), 'utf8')]) assert.equal(text.includes(FAKE_KEY), false);
});

test('a setup that fails while opening the tree for a replay returns setup-failed with exit 1, saves the state and leaves the entry pending', async () => {
  const f = respikeFixture({ config: c => ({ ...c, repos: { backend: { ...c.repos.backend, setup: [['make', 'deps']] } } }) });
  const { dir } = await begin(f);
  const failing = await f.spike(['next'], { runSetup: (argv) => ({ status: argv.join(' ') === 'make deps' ? 2 : 0, stdout: '', stderr: '' }) });
  assert.equal(failing.code, 1);
  const out = json(failing);
  assert.deepEqual([out.action, out.repo, out.command, out.exitCode], ['setup-failed', 'backend', ['make', 'deps'], 2]);
  assert.match(out.log, /setup-backend\.log$/);
  assert.match(failing.stderr, /setup of backend failed/);
  const state = readState(dir);
  assert.equal(state.tracks.t1.repos.backend.status, 'setup');
  assert.equal(state.cards[A].status, 'pending');
  assert.equal(state.plan.cards[A].mode, 'replay');
  assert.equal(state.tracks.t1.current, null);
  const retried = json(await f.spike(['next']));
  assert.deepEqual(retried.replayed, [{ card: A, status: 'replayed', patches: [PATCH_A] }]);
  assert.equal(retried.card, B);
});

const X = 'CRM-3';
const FIXUP = 'backend/fixup-1-from-3-x.patch';
const NEW_FILE = (path, ...lines) => [`diff --git a/${path} b/${path}`, 'new file mode 100644', '--- /dev/null', `+++ b/${path}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map(l => `+${l}`), ''].join('\n');

// A received a fixup from X, a card Linear has completed, so the fixup is kept and lands in A's unit.
function withFixup(over = {}) {
  const f = respikeFixture({ ...over, issues: ([a, b]) => [a, b, issue(X, { state: { name: 'Done', type: 'completed' } })] });
  writeFileSync(join(f.home, SLUG, 'runs', OLD_RUN, 'patches', FIXUP), NEW_FILE('src/fix.js', 'export const fixed = true'));
  const path = join(f.dataDir, SLUG, `${A}.json`);
  const record = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, serializeRecord({ ...record, fixups: { received: [{ from: X, patch: FIXUP, note: 'adapt to X' }], caused: [] } }));
  return f;
}

test('a unit holding a card patch and a kept fixup snapshots one fresh card patch that rebuild reproduces', async () => {
  const f = withFixup();
  const { dir, plan } = await begin(f);
  assert.deepEqual(plan.ancestors[0].patches, [PATCH_A, FIXUP]);
  const out = json(await f.spike(['next']));
  assert.deepEqual(out.replayed, [{ card: A, status: 'replayed', patches: [PATCH_A] }]);
  assert.deepEqual(walk(join(dir, 'patches')), [PATCH_A]);
  const fresh = readFileSync(join(dir, 'patches', PATCH_A), 'utf8');
  assert.match(fresh, /^\+line5 from A$/m);
  assert.match(fresh, /^\+export const fixed = true$/m);
  assert.deepEqual(parseCardPatchName(PATCH_A), { kind: 'card', card: A, origin: 'thin-spike' });
  const state = readState(dir);
  assertTreeClean(f, state.tracks.t1.repos.backend);
  assert.deepEqual(state.tracks.t1.repos.backend.log.map(e => e.name), ['00001-new']);
  assert.equal(state.tracks.t1.repos.backend.log[0].tree, state.tracks.t1.repos.backend.last);
  assert.deepEqual(state.cards[A].replay.applied, [PATCH_A, FIXUP]);
  const rebuilt = await f.spike(['rebuild', 'backend']);
  assert.equal(rebuilt.code, 0, rebuilt.stderr);
  assert.equal(json(rebuilt).tree, state.tracks.t1.repos.backend.last);
  const record = JSON.parse(recordText(f, A));
  assert.deepEqual(record.replayed.folded, [PATCH_A, FIXUP]);
  assert.deepEqual(record.refs.patches, [PATCH_A]);
});

test('a clean replay recomputes size, risk areas and new paths from the fresh patch, keeps the rest of the record and saves the values before', async () => {
  const f = withFixup();
  writeFileSync(join(f.home, SLUG, 'runs', OLD_RUN, 'patches', FIXUP), [
    NEW_FILE('src/auth/guard.js', 'export const guard = 1', 'export const more = 2'), NEW_FILE('tools/run.js', 'run()'),
  ].join(''));
  const path = join(f.dataDir, SLUG, `${A}.json`);
  const withPii = { ...JSON.parse(readFileSync(path, 'utf8')), riskAreas: [{ kind: 'auth', paths: ['backend/stale.js'] }, { kind: 'pii-in-logs', paths: ['backend/src/log.js'] }] };
  writeFileSync(path, serializeRecord(withPii));
  const old = JSON.parse(readFileSync(path, 'utf8'));
  const { dir, runId } = await begin(f);
  await f.spike(['next']);
  assertTreeClean(f, readState(dir).tracks.t1.repos.backend);
  const text = recordText(f, A);
  const record = JSON.parse(text);
  assert.deepEqual(validateRecord(record), []);
  assert.equal(text, serializeRecord(record));
  const read = n => readFileSync(join(dir, 'patches', n), 'utf8');
  const expected = cardSizes({ cards: { [A]: {} }, repos: { backend: 'backend-repo' }, patches: { [PATCH_A]: { kind: 'card', cards: [A] } } }, read)[A];
  assert.deepEqual(record.size, expected);
  assert.equal(record.size.files, 3);
  assert.deepEqual(record.riskAreas, [{ kind: 'auth', paths: ['backend/src/auth/guard.js'] }, { kind: 'pii-in-logs', paths: ['backend/src/log.js'] }]);
  assert.deepEqual(record.novelty.newPaths, ['backend/tools/']);
  for (const key of ['findings', 'cases', 'decisions', 'openDecisions', 'fixups', 'scope', 'spikedAt', 'effort', 'timeBox']) assert.equal(JSON.stringify(record[key]), JSON.stringify(old[key]), key);
  assert.equal(record.refs.runId, runId);
  for (const p of record.refs.patches) assert.ok(existsSync(join(dir, 'patches', p)), p);
  assert.deepEqual(record.replayed.folded, [PATCH_A, FIXUP]);
  assert.deepEqual(readState(dir).cards[A].replay.before, { size: old.size, riskAreas: old.riskAreas, newPaths: old.novelty.newPaths });
  assert.equal(existsSync(join(f.dataDir, SLUG, 'spike', 'history', A)), false);
});

test('a replayed trial record with no risk areas gains them from the config globs, and its verdict leaves unknown without counting them', async () => {
  const f = respikeFixture();
  const trial = join(f.home, SLUG, TRIAL_DIR);
  mkdirSync(join(trial, 'backend'), { recursive: true });
  writeFileSync(join(trial, PATCH_A), NEW_FILE('src/auth/login.js', 'export const login = 1'));
  const path = join(f.dataDir, SLUG, `${A}.json`);
  const { runId: _, ...refs } = JSON.parse(readFileSync(path, 'utf8')).refs;
  const { riskAreas: __, novelty: ___, ...rest } = JSON.parse(readFileSync(path, 'utf8'));
  const trialRecord = { ...rest, refs, effort: { basis: 'transcript-window', windows: rest.effort.windows } };
  assert.deepEqual(validateRecord(trialRecord), []);
  assert.equal(verdict(trialRecord, null), 'unknown');
  writeFileSync(path, serializeRecord(trialRecord));
  const { dir } = await begin(f);
  assert.deepEqual(json(await f.spike(['next'])).replayed, [{ card: A, status: 'replayed', patches: [PATCH_A] }]);
  assertTreeClean(f, readState(dir).tracks.t1.repos.backend);
  const record = JSON.parse(recordText(f, A));
  assert.deepEqual(validateRecord(record), []);
  assert.deepEqual(record.riskAreas, [{ kind: 'auth', paths: ['backend/src/auth/login.js'] }]);
  assert.equal(verdict(record, null), 'No SDD');
  assert.deepEqual(readState(dir).cards[A].replay.before, { size: trialRecord.size, riskAreas: null, newPaths: null });
  assert.equal(record.effort.basis, 'transcript-window');
});

const D = 'CRM-4';
const E = 'CRM-6';
const PATCH_D = 'backend/00004-new.patch';

// D, a second ancestor of B, adds its own file; E is on the map with a record but outside the run.
function twoAncestors({ origin = 'thin-spike' } = {}) {
  const blocksB = { relations: { nodes: [{ type: 'blocks', relatedIssue: { identifier: B } }] } };
  const f = respikeFixture({ issues: ([a, b]) => [a, b, issue(D, blocksB), issue(E)] });
  writeFileSync(join(f.home, SLUG, 'runs', OLD_RUN, 'patches', PATCH_D), NEW_FILE('src/d.js', 'export const d = 4'));
  writeFileSync(join(f.dataDir, SLUG, `${D}.json`), serializeRecord(oldRecord(D, { spikedAt: '2026-11-01T10:40:00.000Z', patches: [PATCH_D] })));
  writeFileSync(join(f.dataDir, SLUG, `${E}.json`), serializeRecord(oldRecord(E, { spikedAt: '2026-11-01T10:50:00.000Z', patches: [] })));
  if (origin !== 'thin-spike') {
    const path = join(f.dataDir, SLUG, `${A}.json`);
    writeFileSync(path, serializeRecord({ ...JSON.parse(readFileSync(path, 'utf8')), origin, effort: null }));
  }
  return f;
}

async function endCard(f, dir, card, file) {
  const tree = json(await f.spike(['tree', 'backend'])).path;
  writeFileSync(join(tree, file), `${card}\n`);
  mkdirSync(join(dir, 'notes'), { recursive: true });
  writeFileSync(join(dir, 'notes', `${card}.json`), JSON.stringify(notes(card)));
  const r = await f.spike(['end', card]);
  assert.equal(r.code, 0, r.stderr);
  return json(r);
}

test('next replays every ready entry in order, with no window and no box, before it hands out the next card to spike', async () => {
  const f = twoAncestors();
  const { dir, plan } = await begin(f, pick, ['--box', '100']);
  assert.deepEqual(plan.order, [{ key: A, mode: 'replay' }, { key: D, mode: 'replay' }, { key: B, mode: 'spike' }]);
  const out = json(await f.spike(['next']));
  assert.deepEqual(out.replayed, [{ card: A, status: 'replayed', patches: [PATCH_A] }, { card: D, status: 'replayed', patches: [PATCH_D] }]);
  assert.equal(out.card, B);
  const state = readState(dir);
  assertTreeClean(f, state.tracks.t1.repos.backend);
  for (const k of [A, D]) assert.deepEqual([state.cards[k].windows, state.cards[k].box], [[], null], k);
  assert.equal(state.cards[B].box, 100);
});

test('a replay turned into a spike gets a box, an effort and a new card patch even when its record came from an existing PR', async () => {
  const f = twoAncestors({ origin: 'existing-pr' });
  moveMain(f, 'line5', 'line5 from main');
  const session = join(f.scratch, 'session.jsonl');
  const { dir, runId } = await begin(f, pick, ['--box', '100', '--session-file', session]);
  const out = json(await f.spike(['next']));
  appendTranscript(session, [usageEntry('turned', '2026-11-10T10:02:30.000Z', 30), usageEntry('after', '2026-11-10T10:03:30.000Z', 1)]);
  assert.equal(out.card, A);
  assert.equal(out.origin, 'thin-spike');
  const state = readState(dir);
  assert.equal(state.cards[A].box, 100);
  assert.equal(state.cards[A].windows.length, 1);
  f.at('2026-11-10T10:03:00.000Z');
  const ended = await endCard(f, dir, A, 'a.txt');
  assert.deepEqual(ended.patches, ['backend/00001-new.patch']);
  const record = JSON.parse(recordText(f, A));
  assert.equal(record.origin, 'thin-spike');
  assert.deepEqual(validateRecord(record), []);
  assert.deepEqual([record.effort.basis, record.effort.runId], ['card-run', runId]);
  assert.deepEqual(record.timeBox, { budget: 100, spent: 30, over: false });
  assert.deepEqual(walk(join(f.dataDir, SLUG, 'spike', 'history', A)), ['2026-11-01T10-30-00.000Z.json']);
});

test('a selected card with a trial record goes to history at its end, and a record outside the run stays byte-identical', async () => {
  const f = twoAncestors();
  const pathB = join(f.dataDir, SLUG, `${B}.json`);
  const { runId: _, ...refs } = JSON.parse(readFileSync(pathB, 'utf8')).refs;
  writeFileSync(pathB, serializeRecord({ ...JSON.parse(readFileSync(pathB, 'utf8')), refs }));
  const oldB = readFileSync(pathB, 'utf8');
  const oldE = recordText(f, E);
  const { dir, runId } = await begin(f);
  assert.equal(json(await f.spike(['next'])).card, B);
  f.at('2026-11-10T10:03:00.000Z');
  await endCard(f, dir, B, 'b.txt');
  f.at('2026-11-10T10:04:00.000Z');
  const done = json(await f.spike(['next']));
  assert.equal(done.action, 'complete');
  assert.equal(done.respike, true);
  assert.equal(readFileSync(join(f.dataDir, SLUG, 'spike', 'history', B, '2026-11-01T11-00-00.000Z.json'), 'utf8'), oldB);
  const newB = JSON.parse(recordText(f, B));
  assert.deepEqual(validateRecord(newB), []);
  assert.equal(newB.refs.runId, runId);
  assert.equal(recordText(f, E), oldE);
});

const G = 'CRM-7';
const H = 'CRM-8';
const PATCH_G = 'backend/00007-new.patch';
const FIXUP_G = 'backend/fixup-7-from-1-x.patch';

const PATCH_H = 'backend/00008-new.patch';
const PATCH_X = 'backend/00003-new.patch';
const blocksB = { relations: { nodes: [{ type: 'blocks', relatedIssue: { identifier: B } }] } };
const write = (f, card, record) => writeFileSync(join(f.dataDir, SLUG, `${card}.json`), serializeRecord(record));

// G has its own patch and a fixup received from A. With holder, H holds A's card patch too, as a two-card patch,
// and with hPatch it also has a patch of its own.
function sharedAndFixup({ holder = true, hPatch = null } = {}) {
  const f = respikeFixture({ issues: ([a, b]) => [a, b, issue(G, blocksB), ...(holder ? [issue(H, blocksB)] : [])] });
  const patches = join(f.home, SLUG, 'runs', OLD_RUN, 'patches');
  writeFileSync(join(patches, PATCH_G), NEW_FILE('src/g.js', 'export const g = 7'));
  writeFileSync(join(patches, FIXUP_G), NEW_FILE('src/g-fix.js', 'export const fix = 1'));
  write(f, G, { ...oldRecord(G, { spikedAt: '2026-11-01T10:40:00.000Z', patches: [PATCH_G] }), fixups: { received: [{ from: A, patch: FIXUP_G, note: 'adapt to A' }], caused: [] } });
  if (holder) {
    if (hPatch) writeFileSync(join(patches, PATCH_H), hPatch(f));
    write(f, H, oldRecord(H, { spikedAt: '2026-11-01T10:50:00.000Z', patches: hPatch ? [PATCH_A, PATCH_H] : [PATCH_A] }));
  }
  return f;
}

const freshTexts = dir => walk(join(dir, 'patches')).map(p => readFileSync(join(dir, 'patches', p), 'utf8'));
const freshSize = (dir, card, name, cards = [card]) => cardSizes({ cards: { [card]: {} }, repos: { backend: 'backend-repo' }, patches: { [name]: { kind: 'card', cards } } }, n => readFileSync(join(dir, 'patches', n), 'utf8'))[card];

test('an entry that turns into a spike re-plans the pending replays: a fixup from it is dropped and the re-plan is logged in the run state', async () => {
  const f = sharedAndFixup({ holder: false });
  moveMain(f, 'line5', 'line5 from main');
  const { dir, plan } = await begin(f);
  assert.deepEqual(plan.order.map(e => [e.key, e.mode]), [[A, 'replay'], [G, 'replay'], [B, 'spike']]);
  assert.deepEqual(plan.ancestors.find(a => a.key === G).units, { backend: [PATCH_G, FIXUP_G] });
  const out = json(await f.spike(['next']));
  assert.deepEqual(out.replayed, [{ card: A, status: 'conflict', patches: [] }]);
  assert.equal(out.card, A);
  const state = readState(dir);
  const g = state.plan.respike.replay[G];
  assert.deepEqual([g.replanned, g.units, g.patches, g.dropped], [true, { backend: [PATCH_G] }, [PATCH_G], [{ patch: FIXUP_G, reason: 'from-absent' }]]);
  assert.equal(state.plan.cards[G].mode, 'replay');
  assert.deepEqual(state.plan.respike.replans, [{ cause: A, dropped: [{ card: G, patch: FIXUP_G, reason: 'from-absent' }] }]);

  f.at('2026-11-10T10:03:00.000Z');
  await endCard(f, dir, A, 'a.txt');
  f.at('2026-11-10T10:04:00.000Z');
  const second = json(await f.spike(['next']));
  assertTreeClean(f, readState(dir).tracks.t1.repos.backend);
  assert.deepEqual(second.replayed, [{ card: G, status: 'replayed', patches: [PATCH_G] }]);
  assert.doesNotMatch(readFileSync(join(dir, 'patches', PATCH_G), 'utf8'), /g-fix/);
  assert.deepEqual(JSON.parse(recordText(f, G)).replayed.folded, [PATCH_G, FIXUP_G]);
});

test('a fixup waits for its from card: when that card conflicts after the fixed card replayed, no fresh patch holds the fixup', async () => {
  const f = respikeFixture({ issues: ([a, b]) => [a, b, issue(X, blocksB)] });
  const patches = join(f.home, SLUG, 'runs', OLD_RUN, 'patches');
  const fix = 'backend/fixup-1-from-3-adapt.patch';
  writeFileSync(join(patches, PATCH_X), linePatch(f.repo, 'line8', 'line8 from X'));
  writeFileSync(join(patches, fix), NEW_FILE('src/auth/adapted.js', 'export const adapted = true'));
  write(f, X, oldRecord(X, { spikedAt: '2026-11-01T10:20:00.000Z', patches: [PATCH_X] }));
  const pathA = join(f.dataDir, SLUG, `${A}.json`);
  write(f, A, { ...JSON.parse(readFileSync(pathA, 'utf8')), fixups: { received: [{ from: X, patch: fix, note: 'adapt to X' }], caused: [] } });
  moveMain(f, 'line8', 'line8 from main');
  const { dir, plan } = await begin(f);
  assert.deepEqual(plan.ancestors.map(a => [a.key, a.units]), [[A, { backend: [PATCH_A] }], [X, { backend: [PATCH_X, fix] }]]);
  const out = json(await f.spike(['next']));
  assert.deepEqual(out.replayed, [{ card: A, status: 'replayed', patches: [PATCH_A] }, { card: X, status: 'conflict', patches: [] }]);
  assert.equal(out.card, X);
  assert.deepEqual(walk(join(dir, 'patches')), [PATCH_A]);
  for (const text of freshTexts(dir)) assert.doesNotMatch(text, /adapted/);
  assert.equal(existsSync(join(readState(dir).tracks.t1.repos.backend.path, 'src', 'auth', 'adapted.js')), false);
  const record = JSON.parse(recordText(f, A));
  assert.deepEqual(record.size, freshSize(dir, A, PATCH_A));
  assert.deepEqual(record.riskAreas, []);
  assert.deepEqual(record.novelty.newPaths, []);
  assertTreeClean(f, readState(dir).tracks.t1.repos.backend);
});

test('the holders of a two-card patch are re-spiked, never replayed, and a fixup from one of them is dropped before anything is applied', async () => {
  const f = sharedAndFixup();
  const { dir, plan } = await begin(f);
  assert.deepEqual(plan.order.map(e => [e.key, e.mode]), [[G, 'replay'], [A, 'spike'], [H, 'spike'], [B, 'spike']]);
  assert.deepEqual(plan.ancestors.map(a => [a.key, a.mode, a.reason, a.sharedWith]), [[A, 'spike', 'shared-patch', [H]], [G, 'replay', null, []], [H, 'spike', 'shared-patch', [A]]]);
  assert.deepEqual(plan.ancestors.find(a => a.key === G).dropped, [{ patch: FIXUP_G, reason: 'from-absent' }]);
  const out = json(await f.spike(['next']));
  assert.deepEqual(out.replayed, [{ card: G, status: 'replayed', patches: [PATCH_G] }]);
  assert.equal(out.card, A);
  assert.deepEqual(walk(join(dir, 'patches')), [PATCH_G]);
  for (const text of freshTexts(dir)) assert.doesNotMatch(text, /g-fix|line5 from A/);
  assert.deepEqual(JSON.parse(recordText(f, G)).size, freshSize(dir, G, PATCH_G));
  assertTreeClean(f, readState(dir).tracks.t1.repos.backend);
});

test('in a chain A, then a selected X, then H, where A and H share a patch, X is spiked only after A, on a base that holds A\'s new code', async () => {
  const S = 'CRM-9';
  const f = respikeFixture({
    issues: ([a, b]) => [
      { ...a, relations: { nodes: [{ type: 'blocks', relatedIssue: { identifier: S } }] } }, b,
      issue(S, { relations: { nodes: [{ type: 'blocks', relatedIssue: { identifier: H } }] } }), issue(H, blocksB),
    ],
  });
  write(f, H, oldRecord(H, { spikedAt: '2026-11-01T10:50:00.000Z', patches: [PATCH_A] }));
  const { dir, plan } = await begin(f, [PROJECT_URL, '--cards', `${B},${S}`]);
  assert.deepEqual(plan.order, [{ key: A, mode: 'spike' }, { key: S, mode: 'spike' }, { key: H, mode: 'spike' }, { key: B, mode: 'spike' }]);
  const first = json(await f.spike(['next']));
  assert.deepEqual([first.card, first.replayed], [A, []]);
  f.at('2026-11-10T10:03:00.000Z');
  await endCard(f, dir, A, 'a-fresh.txt');
  f.at('2026-11-10T10:04:00.000Z');
  const second = json(await f.spike(['next']));
  assert.equal(second.card, S);
  assert.equal(readFileSync(join(readState(dir).tracks.t1.repos.backend.path, 'a-fresh.txt'), 'utf8'), `${A}\n`);
});

test('a fixup on a replayed card appends to its live record and writes no notes; a later replay reads its patches plus that fixup only', async () => {
  const f = respikeFixture();
  const { dir, runId } = await begin(f);
  assert.equal(json(await f.spike(['next'])).card, B);
  assertTreeClean(f, readState(dir).tracks.t1.repos.backend);
  const before = JSON.parse(recordText(f, A));
  const tree = json(await f.spike(['tree', 'backend'])).path;
  writeFileSync(join(tree, 'src', 'list.js'), readFileSync(join(tree, 'src', 'list.js'), 'utf8').replace('line5 from A', 'line5 from A, adapted'));
  f.at('2026-11-10T10:03:00.000Z');
  const r = await f.spike(['fixup', '--fixes', A, '--slug', 'adapt', '--note', 'Adapt A to B.', '--repo', 'backend', '--', 'src/list.js']);
  assert.equal(r.code, 0, r.stderr);
  const patch = 'backend/fixup-1-from-2-adapt.patch';
  assert.equal(json(r).patch, patch);
  const after = JSON.parse(recordText(f, A));
  assert.deepEqual(validateRecord(after), []);
  assert.deepEqual(after.fixups.received, [...before.fixups.received, { from: B, patch, note: 'Adapt A to B.' }]);
  assert.deepEqual({ ...after, fixups: null }, { ...before, fixups: null });
  assert.equal(existsSync(join(dir, 'notes', `${A}.json`)), false);
  assert.ok(existsSync(join(dir, 'patches', patch)));

  f.at('2026-11-10T10:04:00.000Z');
  await endCard(f, dir, B, 'b.txt');
  f.at('2026-11-10T10:05:00.000Z');
  assert.equal(json(await f.spike(['next'])).action, 'complete');
  const again = json(await f.run('preflight', pick));
  const a = again.ancestors.find(x => x.key === A);
  assert.deepEqual([a.mode, a.from, a.patches, a.dropped], ['replay', runId, [PATCH_A], [{ patch, reason: 'from-absent' }]]);
});

test('next carries the previous record on a respike and null on a first spike', async () => {
  const f = respikeFixture();
  moveMain(f, 'line5', 'line5 from main');
  const old = JSON.parse(recordText(f, A));
  await begin(f);
  const out = json(await f.spike(['next']));
  assert.equal(out.card, A);
  assert.deepEqual(out.previous, { spikedAt: old.spikedAt, findings: old.findings, decisions: old.decisions, openDecisions: old.openDecisions ?? [] });
});

test('a replay that fails typecheck turns into a spike with reason typecheck', async () => {
  const f = respikeFixture();
  const config = JSON.parse(readFileSync(join(f.home, 'config.json'), 'utf8'));
  config.repos.backend.spikeTypecheck = ['tc', '{changed}'];
  writeFileSync(join(f.home, 'config.json'), JSON.stringify(config));
  const before = recordText(f, A);
  const { dir } = await begin(f);
  const failing = fakeSetup({ 'tc src/list.js': 2 });
  const out = json(await f.spike(['next'], { runSetup: failing.run }));
  assert.deepEqual(out.replayed, [{ card: A, status: 'typecheck', patches: [] }]);
  assert.equal(out.action, 'card');
  assert.equal(out.card, A);
  assert.deepEqual(out.replayTypecheck, { repo: 'backend', log: join(dir, 'logs', 'typecheck-backend.log') });
  const state = readState(dir);
  assert.equal(state.plan.cards[A].mode, 'spike');
  assert.equal(state.cards[A].replay.status, 'typecheck');
  assertTreeClean(f, state.tracks.t1.repos.backend);
  assert.equal(state.tracks.t1.repos.backend.last, state.tracks.t1.repos.backend.baseTree);
  assert.deepEqual(walk(join(dir, 'patches')), []);
  assert.equal(recordText(f, A), before);
  assert.match(readFileSync(join(dir, 'logs', 'typecheck-backend.log'), 'utf8'), /tc src\/list\.js/);
});
