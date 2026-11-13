import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { serializeRecord } from '../scripts/lib/record.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import {
  appendTranscript, call, issue, playCard, PROJECT_URL, SLUG, spikeFixture, toolResult, usageEntry,
} from './helpers/spike-fixture.mjs';

guardNetwork();

const stateIn = dir => JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
const recordOf = (fixture, card) => JSON.parse(readFileSync(join(fixture.dataDir, SLUG, `${card}.json`), 'utf8'));

// The card's last usage line is flushed after its end, inside the window, followed by a line that settles it.
const lateFlush = session => appendTranscript(session, [
  usageEntry('late', '2026-11-10T10:04:30.000Z', 60), toolResult('{}', '2026-11-10T10:05:30.000Z'),
]);

async function oneUnsettledCard(fixture) {
  const session = join(fixture.transcripts, '-work', 'session-1.jsonl');
  await call(fixture, ['begin', PROJECT_URL], { session });
  const { ended, dir } = await playCard(fixture, 'CRM-1', {
    start: '2026-11-10T10:01:00.000Z', end: '2026-11-10T10:05:00.000Z', session, w: [40], settle: false,
  });
  assert.equal(ended.code, 0, ended.stderr);
  return { session, dir };
}

test('end writes the provisional sum; next settles the window once a later line exists and rewrites only effort in the record', async () => {
  const fixture = spikeFixture({ issues: [issue('CRM-1'), issue('CRM-2')] });
  const { session, dir } = await oneUnsettledCard(fixture);
  const [window] = stateIn(dir).cards['CRM-1'].windows;
  assert.deepEqual([window.settled, window.w], [false, 40]);
  assert.equal(recordOf(fixture, 'CRM-1').effort.windows[0].tokens.input, 40);

  lateFlush(session);
  const path = join(fixture.dataDir, SLUG, 'CRM-1.json');
  writeFileSync(path, serializeRecord({ ...recordOf(fixture, 'CRM-1'), title: 'Edited by hand' }));
  fixture.at('2026-11-10T10:06:00.000Z');
  const brief = await call(fixture, ['next'], { session });
  assert.equal(JSON.parse(brief.stdout).card, 'CRM-2');

  const settled = stateIn(dir).cards['CRM-1'].windows[0];
  assert.deepEqual([settled.settled, settled.w, settled.messages], [true, 100, 2]);
  const record = recordOf(fixture, 'CRM-1');
  assert.equal(record.effort.windows[0].tokens.input, 100);
  assert.equal(record.effort.windows[0].messages, 2);
  assert.equal(record.title, 'Edited by hand');
  assert.equal(readFileSync(path, 'utf8'), serializeRecord(record));
});

test('settling leaves alone a record that is gone or that another run wrote, and still settles the window in the state', async () => {
  for (const change of ['removed', 'other run']) {
    const fixture = spikeFixture({ issues: [issue('CRM-1'), issue('CRM-2')] });
    const { session, dir } = await oneUnsettledCard(fixture);
    const path = join(fixture.dataDir, SLUG, 'CRM-1.json');
    const other = serializeRecord({ ...recordOf(fixture, 'CRM-1'), refs: { ...recordOf(fixture, 'CRM-1').refs, runId: '20261109T090000Z' }, effort: null });
    if (change === 'removed') rmSync(path);
    else writeFileSync(path, other);

    lateFlush(session);
    fixture.at('2026-11-10T10:06:00.000Z');
    const brief = await call(fixture, ['next'], { session });
    assert.equal(brief.code, 0, brief.stderr);
    assert.equal(JSON.parse(brief.stdout).card, 'CRM-2', change);
    assert.deepEqual([stateIn(dir).cards['CRM-1'].windows[0].settled, stateIn(dir).cards['CRM-1'].windows[0].w], [true, 100], change);
    if (change === 'removed') assert.equal(existsSync(path), false);
    else assert.equal(readFileSync(path, 'utf8'), other);
  }
});

test('completion polls five times a second apart, then keeps the provisional sum and marks settled false in the state only', async () => {
  const fixture = spikeFixture();
  const { dir } = await oneUnsettledCard(fixture);
  const before = readFileSync(join(fixture.dataDir, SLUG, 'CRM-1.json'), 'utf8');
  fixture.at('2026-11-10T10:06:00.000Z');
  const r = await call(fixture, ['next']);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.action, 'complete');
  assert.deepEqual(fixture.sleeps, [1000, 1000, 1000, 1000, 1000]);
  assert.match(out.warnings.join(' '), /CRM-1.*not settled/);
  assert.equal(stateIn(dir).cards['CRM-1'].windows[0].settled, false);
  const after = readFileSync(join(fixture.dataDir, SLUG, 'CRM-1.json'), 'utf8');
  assert.equal(after, before);
  assert.equal(after.includes('settled'), false);
});

test('completion stops polling as soon as the window settles and rewrites the record with the settled sum', async () => {
  const fixture = spikeFixture();
  const { session, dir } = await oneUnsettledCard(fixture);
  fixture.deps.sleep = async ms => {
    fixture.sleeps.push(ms);
    if (fixture.sleeps.length === 2) lateFlush(session);
  };
  fixture.at('2026-11-10T10:06:00.000Z');
  const out = JSON.parse((await call(fixture, ['next'])).stdout);
  assert.equal(out.action, 'complete');
  assert.equal(out.warnings, undefined);
  assert.deepEqual(fixture.sleeps, [1000, 1000]);
  assert.equal(stateIn(dir).cards['CRM-1'].windows[0].settled, true);
  assert.equal(recordOf(fixture, 'CRM-1').effort.windows[0].tokens.input, 100);
});

test('begin on resume settles the windows of earlier executions', async () => {
  const fixture = spikeFixture({ issues: [issue('CRM-1'), issue('CRM-2')] });
  const { session, dir } = await oneUnsettledCard(fixture);
  lateFlush(session);
  fixture.at('2026-11-10T11:00:00.000Z');
  const resumed = await call(fixture, ['begin', PROJECT_URL]);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(stateIn(dir).cards['CRM-1'].windows[0].w, 100);
  assert.equal(recordOf(fixture, 'CRM-1').effort.windows[0].tokens.input, 100);
});
