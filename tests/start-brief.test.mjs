import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildBrief, PATCHES_NOTE, recordNote, resolvePatches } from '../scripts/lib/start/brief.mjs';
import { runDir, trialPatchRoot } from '../scripts/lib/spike/home.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import { appRepo, CARD, FAKE_CHECKOUT, fakeStartFixture, GIT_BRANCH_NAME, SENTINEL, SLUG, startIssue, startRecord } from './helpers/start-fixture.mjs';

guardNetwork();

const RUN_ID = '20261101T100000Z';
const SECRET = 'PATCH_BODY_SECRET_' + 'x'.repeat(20);
const patchText = (...files) => files.map(f => [
  `diff --git a/${f} b/${f}`, `--- a/${f}`, `+++ b/${f}`, '@@ -1 +1 @@', `-old ${SECRET}`, `+new ${SECRET}`,
].join('\n')).join('\n') + '\n';

const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

const fixture = (t, opts) => {
  const f = fakeStartFixture(opts);
  t.after(f.dispose);
  return f;
};
const plan = async f => {
  const r = await f.run(['plan', CARD]);
  assert.equal(r.code, 0, r.stderr);
  return { r, out: JSON.parse(r.stdout) };
};

const strings = value => (typeof value === 'string' ? [value]
  : Array.isArray(value) ? value.flatMap(strings)
    : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : []);

test('a full record maps every brief field, with the size from the verdict and never effort or time box', () => {
  const record = {
    ...startRecord(CARD, {
      findings: [{ text: 'The fetch already pages.', ref: `linear:${CARD}` }],
      fixups: { received: [{ from: 'ABC-2', note: 'x' }], caused: [] },
      riskAreas: [{ kind: 'auth', paths: ['src/auth.js'] }],
      refs: { engram: ['proj#12'], patches: [], linear: null },
    }),
    effort: { basis: 'card-run', minutes: 30 },
    timeBox: { budget: 1, spent: 2, over: true },
  };
  const { record: brief } = buildBrief({ record, size: { tier: 'M', label: 'M · 60 lines' } });
  assert.deepEqual(Object.keys(brief).sort(), [
    'cases', 'decisions', 'engramRefs', 'findings', 'fixups', 'novelty', 'openDecisions', 'origin', 'riskAreas', 'scope', 'size', 'spikedAt',
  ]);
  assert.deepEqual(brief.size, { label: 'M · 60 lines', tier: 'M', lines: 60, files: 3, repos: ['app-repo'], sharedWith: [] });
  for (const key of ['decisions', 'cases', 'findings', 'fixups', 'openDecisions', 'riskAreas', 'novelty', 'scope', 'spikedAt', 'origin']) {
    assert.deepEqual(brief[key], record[key], key);
  }
  assert.deepEqual(brief.engramRefs, ['proj#12']);
  assert.ok(!strings(brief).some(s => s.includes('card-run')));
});

test('no live record: the brief has no record, says why, and lists no patches', () => {
  assert.deepEqual(buildBrief({ record: null, recordNote: 'no record' }), {
    record: null, recordNote: 'no record', patches: [], patchesNote: PATCHES_NOTE, otherRepos: [], pack: null,
  });
  assert.equal(PATCHES_NOTE, 'reference only: chained diffs, not diffs against the default branch');
});

test('the record note says no record, archived or superseded, and is null for a live record', () => {
  const live = startRecord(CARD);
  assert.equal(recordNote([], CARD), 'no record');
  assert.equal(recordNote([live], CARD), null);
  assert.match(recordNote([startRecord(CARD, { archived: { at: '2026-11-02', reason: 'split' } })], CARD), /archived.*split/);
  assert.match(recordNote([startRecord(CARD, { supersededBy: { card: 'ABC-7', spikedAt: '2026-11-03T00:00:00.000Z' } })], CARD), /superseded by ABC-7/);
});

test('patches resolve from the run dir, else the trial dir, else are unavailable, with files from the diff headers only', t => {
  const f = fixture(t);
  const record = startRecord(CARD, { refs: { engram: [], patches: ['app-repo/a.patch', 'app-repo/b.patch', 'app-repo/c.patch'], linear: null, runId: RUN_ID } });
  write(join(runDir(f.home, SLUG, RUN_ID), 'patches', 'app-repo/a.patch'), patchText('src/a.js', 'src/a.test.js'));
  write(join(trialPatchRoot(f.home, SLUG), 'app-repo/b.patch'), patchText('src/b.js'));
  assert.deepEqual(resolvePatches(record, { home: f.home, slug: SLUG }), [
    { ref: 'app-repo/a.patch', repoDir: 'app-repo', location: 'run', files: ['src/a.js', 'src/a.test.js'] },
    { ref: 'app-repo/b.patch', repoDir: 'app-repo', location: 'trial', files: ['src/b.js'] },
    { ref: 'app-repo/c.patch', repoDir: 'app-repo', location: null, files: [] },
  ]);
  const noRun = startRecord(CARD, { refs: { engram: [], patches: ['app-repo/b.patch'], linear: null } });
  assert.equal(resolvePatches(noRun, { home: f.home, slug: SLUG })[0].location, 'trial');
});

test('the plan lists patch names and paths, never diff text, and says when a patch is unavailable', async t => {
  const record = startRecord(CARD, { refs: { engram: [], patches: ['app-repo/a.patch', 'app-repo/gone.patch'], linear: null, runId: RUN_ID } });
  const f = fixture(t, { records: [record] });
  write(join(runDir(f.home, SLUG, RUN_ID), 'patches', 'app-repo/a.patch'), patchText('src/a.js'));
  const { r, out } = await plan(f);
  assert.deepEqual(out.brief.patches.map(p => [p.ref, p.location, p.files]), [['app-repo/a.patch', 'run', ['src/a.js']], ['app-repo/gone.patch', null, []]]);
  assert.equal(out.brief.patchesNote, PATCHES_NOTE);
  assert.ok(out.warnings.some(w => /patches unavailable: app-repo\/gone\.patch/.test(w)), out.warnings.join('; '));
  assert.ok(!r.stdout.includes(SECRET));
  assert.ok(!r.stdout.includes(SENTINEL));
  for (const s of strings(out)) {
    for (const line of s.split('\n')) assert.doesNotMatch(line, /^(diff --git|\+\+\+|---|@@)/, line);
  }
});

test('an archived or superseded record is not used: the brief has no record and says why', async t => {
  const archived = startRecord(CARD, { archived: { at: '2026-11-02', reason: 'split' } });
  const out = (await plan(fixture(t, { records: [archived] }))).out;
  assert.equal(out.brief.record, null);
  assert.match(out.brief.recordNote, /archived/);
  assert.equal(out.verdict.value, 'no record');
});

test('a card with no record has Linear fields only: description, comments oldest first, milestone', async t => {
  const comments = [
    { body: 'Ajustes de alcance: later', createdAt: '2026-11-03T00:00:00.000Z' },
    { body: 'first', createdAt: '2026-11-01T00:00:00.000Z' },
  ];
  const issue = startIssue(CARD, { gitBranchName: GIT_BRANCH_NAME, description: 'Read the card.', comments, projectMilestone: { name: 'M1 read' } });
  const out = (await plan(fixture(t, { issues: [issue], records: [] }))).out;
  assert.deepEqual([out.brief.record, out.brief.recordNote], [null, 'no record']);
  assert.equal(out.card.description, 'Read the card.');
  assert.deepEqual(out.card.comments.map(c => c.body), ['first', 'Ajustes de alcance: later']);
  assert.equal(out.card.commentsTruncated, false);
  assert.equal(out.card.milestone, 'M1 read');
});

test('a two-repo record lists the other repo in the brief and acts on the current one', async t => {
  const record = startRecord(CARD, { size: { ...startRecord(CARD).size, repos: ['app-repo', 'web-repo'] } });
  const repos = { app: appRepo(FAKE_CHECKOUT), web: appRepo('/fake/web', { name: 'web-repo', github: 'acme/web' }) };
  const out = (await plan(fixture(t, { records: [record], repos }))).out;
  assert.equal(out.checkout.repoDir, 'app');
  assert.deepEqual(out.brief.otherRepos.map(r => [r.dir, r.name]), [['web', 'web-repo']]);
});
