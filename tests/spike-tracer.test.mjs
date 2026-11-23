import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../scripts/spike.mjs';
import { buildSpikeRecord } from '../scripts/lib/spike/build-record.mjs';
import { serializeRecord, validateRecord } from '../scripts/lib/record.mjs';
import { sandboxGit } from './helpers/git-sandbox.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import { card, notes, PROJECT_URL, SENTINEL, SLUG, spikeFixture as setup, walk } from './helpers/spike-fixture.mjs';

guardNetwork();

test('begin, next, tree, end on one card in a temp repo write one patch to the home and one valid record to the data dir', async () => {
  const { repo, home, dataDir, sessionFile, deps, linear, gh, setupCommands, at } = setup();
  const baseCommit = repo.git(['rev-parse', 'HEAD']).trim();
  const outputs = [];
  const call = async argv => {
    const r = await run(argv, deps);
    outputs.push(r);
    assert.equal(r.code, 0, `${argv[0]}: ${r.stderr}`);
    return JSON.parse(r.stdout);
  };

  const begun = await call(['begin', PROJECT_URL, '--session-file', sessionFile]);
  assert.equal(Object.keys(begun)[0], 'mark');
  const runId = begun.runId;
  assert.equal(runId, '20261110T100000Z');
  assert.match(begun.mark, new RegExp(`^keiron-sequencer-spike:${runId}:1:[0-9a-f]+$`));
  assert.deepEqual(begun.plan.order, ['CRM-1']);
  const runDir = join(home, SLUG, 'runs', runId);

  at('2026-11-10T10:01:00.000Z');
  const brief = await call(['next']);
  assert.equal(Object.keys(brief)[0], 'mark');
  assert.notEqual(brief.mark, begun.mark);
  assert.equal(brief.action, 'card');
  assert.equal(brief.card, 'CRM-1');
  assert.equal(brief.title, 'Add the feature');
  assert.equal(brief.description, 'Do the thing.');
  assert.equal(brief.origin, 'thin-spike');
  assert.deepEqual(brief.window, { start: '2026-11-10T10:01:00.000Z' });
  assert.equal(brief.previous, null);

  at('2026-11-10T10:01:30.000Z');
  const tree = await call(['tree', 'backend']);
  assert.equal(tree.path, join(runDir, 'trees', 't1', 'backend'));
  assert.equal(sandboxGit(['rev-parse', 'HEAD'], { cwd: tree.path }).trim(), baseCommit);

  writeFileSync(join(tree.path, 'README.md'), '# sandbox\nspiked\n');
  writeFileSync(join(tree.path, 'src', 'feature.js'), 'export const feature = 1\nexport const more = 2\n');
  writeFileSync(join(tree.path, 'src', 'feature.test.js'), 'feature()\n');
  mkdirSync(join(runDir, 'notes'), { recursive: true });
  writeFileSync(join(runDir, 'notes', 'CRM-1.json'), JSON.stringify(notes));

  at('2026-11-10T10:05:00.000Z');
  const ended = await call(['end', 'CRM-1']);
  assert.equal(Object.keys(ended)[0], 'mark');
  assert.equal(ended.card, 'CRM-1');

  assert.deepEqual(walk(join(runDir, 'patches')), ['backend/00001-new.patch']);
  const patch = readFileSync(join(runDir, 'patches', 'backend', '00001-new.patch'), 'utf8');
  assert.match(patch, /^diff --git a\/README\.md b\/README\.md$/m);
  assert.match(patch, /^\+spiked$/m);

  assert.deepEqual(walk(dataDir), [`${SLUG}/CRM-1.json`]);
  const text = readFileSync(join(dataDir, SLUG, 'CRM-1.json'), 'utf8');
  const record = JSON.parse(text);
  assert.deepEqual(validateRecord(record), []);
  assert.equal(text, serializeRecord(record));
  assert.equal(record.card, 'CRM-1');
  assert.equal(record.origin, 'thin-spike');
  assert.equal(record.spikedAt, '2026-11-10T10:05:00.000Z');
  assert.deepEqual(record.project, { slug: SLUG, name: 'Tracer project' });
  assert.deepEqual(record.size, { prodLines: 3, testLines: 1, files: 3, repos: ['backend-repo'], sharedWith: [], deletionWeight: 0.25 });
  assert.deepEqual(record.effort, {
    basis: 'card-run',
    runId,
    windows: [{
      start: '2026-11-10T10:01:00.000Z', end: '2026-11-10T10:05:00.000Z', cards: ['CRM-1'], messages: 2,
      tokens: { input: 14, cacheCreation: 200, cacheRead: 1500, output: 68, thinking: 5 },
    }],
  });
  assert.deepEqual(record.refs, { engram: [], patches: ['backend/00001-new.patch'], linear: card.url, runId });
  assert.deepEqual(record.cases.map(c => c.id), ['c1', 'c2', 'c3']);
  assert.equal(JSON.stringify(record).includes('diff --git'), false);
  const state = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
  assert.deepEqual(buildSpikeRecord(state, 'CRM-1', notes), record);

  assert.ok(existsSync(join(runDir, 'run.json')));
  assert.equal(walk(dataDir).some(f => f.endsWith('.patch') || f.endsWith('run.json')), false);
  for (const r of outputs) assert.equal(`${r.stdout}${r.stderr}`.includes(SENTINEL), false);
  assert.equal(linear.sent.filter(s => /\bmutation\b/i.test(s.body.query)).length, 0);
  assert.deepEqual(gh.calls.map(c => c.argv), [['pr', 'list', '--repo', 'acme/backend', '--state', 'open', '--limit', '200', '--json', 'number,title,url,isDraft']]);
  assert.deepEqual(setupCommands.calls, []);

  assert.equal(repo.git(['rev-list', '--count', '--all']).trim(), '1');
  assert.equal(repo.git(['rev-parse', 'HEAD']).trim(), baseCommit);
  assert.equal(repo.git(['status', '--porcelain']).trim(), '');
  assert.equal(sandboxGit(['rev-list', `${baseCommit}..HEAD`], { cwd: tree.path }).trim(), '');
});

test('without a bound session the card is unmeasured, never zero: end says so and the record has effort null', async () => {
  const { home, dataDir, deps, at } = setup();
  const begun = JSON.parse((await run(['begin', PROJECT_URL], deps)).stdout);
  at('2026-11-10T10:01:00.000Z');
  assert.equal((await run(['next'], deps)).code, 0);

  const again = await run(['next'], deps);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /CRM-1 is still in progress/);

  const tree = JSON.parse((await run(['tree', 'backend'], deps)).stdout);
  writeFileSync(join(tree.path, 'README.md'), '# sandbox\nspiked\n');
  const runDir = join(home, SLUG, 'runs', begun.runId);
  mkdirSync(join(runDir, 'notes'), { recursive: true });
  const openDecisions = [{ text: 'Whether the feature needs a flag is a guess.', impact: 'detail' }, { text: 'The retention period is unconfirmed.', impact: 'design', owner: 'people', ref: 'linear:CRM-1' }];
  writeFileSync(join(runDir, 'notes', 'CRM-1.json'), JSON.stringify({ ...notes, openDecisions }));

  at('2026-11-10T10:05:00.000Z');
  const ended = await run(['end', 'CRM-1'], deps);
  assert.equal(ended.code, 0, ended.stderr);
  assert.equal(JSON.parse(ended.stdout).usage, 'unmeasured');
  const record = JSON.parse(readFileSync(join(dataDir, SLUG, 'CRM-1.json'), 'utf8'));
  assert.deepEqual(validateRecord(record), []);
  assert.deepEqual(record.openDecisions, openDecisions);
  assert.equal(record.effort, null);
  assert.equal(record.refs.runId, begun.runId);
});

test('an end whose record is invalid writes no patch, no record and no state, and a retry with fixed notes succeeds', async () => {
  const { home, dataDir, deps, at } = setup();
  const { runId } = JSON.parse((await run(['begin', PROJECT_URL], deps)).stdout);
  const runDir = join(home, SLUG, 'runs', runId);
  at('2026-11-10T10:01:00.000Z');
  await run(['next'], deps);
  const tree = JSON.parse((await run(['tree', 'backend'], deps)).stdout);
  writeFileSync(join(tree.path, 'README.md'), '# sandbox\nspiked\n');
  mkdirSync(join(runDir, 'notes'), { recursive: true });
  writeFileSync(join(runDir, 'notes', 'CRM-1.json'), JSON.stringify({ ...notes, cases: [] }));
  const before = readFileSync(join(runDir, 'run.json'), 'utf8');

  at('2026-11-10T10:05:00.000Z');
  const failed = await run(['end', 'CRM-1'], deps);
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /\$\.cases/);
  assert.deepEqual(walk(join(runDir, 'patches')), []);
  assert.deepEqual(walk(dataDir), []);
  assert.equal(readFileSync(join(runDir, 'run.json'), 'utf8'), before);

  writeFileSync(join(runDir, 'notes', 'CRM-1.json'), JSON.stringify(notes));
  const retried = await run(['end', 'CRM-1'], deps);
  assert.equal(retried.code, 0, retried.stderr);
  assert.deepEqual(walk(join(runDir, 'patches')), ['backend/00001-new.patch']);
  assert.match(readFileSync(join(runDir, 'patches', 'backend', '00001-new.patch'), 'utf8'), /^\+spiked$/m);
  assert.deepEqual(walk(dataDir), [`${SLUG}/CRM-1.json`]);
});

test('begin on a project that has a non-complete run resumes that run in a new execution and never creates a second run', async () => {
  const { home, sessionFile, deps, at } = setup();
  const first = JSON.parse((await run(['begin', PROJECT_URL], deps)).stdout);
  assert.equal(first.resumed, false);

  at('2026-11-10T11:00:00.000Z');
  const again = await run(['begin', SLUG, '--session-file', sessionFile], deps);
  assert.equal(again.code, 0, again.stderr);
  const second = JSON.parse(again.stdout);
  assert.equal(Object.keys(second)[0], 'mark');
  assert.equal(second.runId, first.runId);
  assert.equal(second.resumed, true);
  assert.match(second.mark, new RegExp(`^keiron-sequencer-spike:${first.runId}:2:[0-9a-f]+$`));
  assert.deepEqual(second.plan.order, ['CRM-1']);
  assert.deepEqual(readdirSync(join(home, SLUG, 'runs')), [first.runId]);

  const state = JSON.parse(readFileSync(join(home, SLUG, 'runs', first.runId, 'run.json'), 'utf8'));
  assert.deepEqual(state.executions.map(e => [e.id, e.startedAt, e.sessions.map(s => s.file)]), [
    [1, '2026-11-10T10:00:00.000Z', []],
    [2, '2026-11-10T11:00:00.000Z', [sessionFile]],
  ]);
  assert.deepEqual([state.executions[0].endedAt, state.executions[0].endReason], ['2026-11-10T10:00:00.000Z', 'interrupted']);
  assert.equal(state.executions[1].endedAt, null);

  at('2026-11-10T11:01:00.000Z');
  const brief = JSON.parse((await run(['next'], deps)).stdout);
  assert.equal(brief.card, 'CRM-1');
  assert.match(brief.mark, new RegExp(`^keiron-sequencer-spike:${first.runId}:2:`));
});
