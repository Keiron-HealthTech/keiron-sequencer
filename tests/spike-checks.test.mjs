import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../scripts/spike.mjs';
import { withCheckSlot } from '../scripts/lib/spike/checks.mjs';
import { setupRunner } from '../scripts/lib/spike/exec.mjs';
import { tempDir } from './helpers/git-sandbox.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import { activeRunDir, notes, PROJECT_URL, spikeFixture, walk } from './helpers/spike-fixture.mjs';

import { B, PROJECT_URL as RESPIKE_URL, respikeFixture, SLUG as RESPIKE_SLUG } from './helpers/respike-fixture.mjs';

guardNetwork();

function slotDir() {
  const dir = tempDir('keiron-sequencer-checks-');
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const pause = ms => new Promise(r => setTimeout(r, ms));
const alive = () => true;

function timed(dir, options, ms) {
  return withCheckSlot(dir, { pollMs: 5, isAlive: alive, ...options }, async () => {
    const start = Date.now();
    await pause(ms);
    return [start, Date.now()];
  });
}

test('with one slot a second check waits for the first', async () => {
  const dir = slotDir();
  const [a, b] = await Promise.all([timed(dir, { slots: 1, command: 'a', pid: 1 }, 60), timed(dir, { slots: 1, command: 'b', pid: 2 }, 60)]);
  const [first, second] = [a.value, b.value].sort((x, y) => x[0] - y[0]);
  assert.ok(second[0] >= first[1], `second started at ${second[0]}, first ended at ${first[1]}`);
  assert.deepEqual(readdirSync(join(dir, 'checks')), []);
});

test('with two slots two checks run together', async () => {
  const dir = slotDir();
  const [a, b] = await Promise.all([timed(dir, { slots: 2, command: 'a', pid: 1 }, 80), timed(dir, { slots: 2, command: 'b', pid: 2 }, 80)]);
  assert.ok(a.value[0] < b.value[1] && b.value[0] < a.value[1], 'the run intervals overlap');
});

test('a slot held by a dead pid is free', async () => {
  const dir = slotDir();
  mkdirSync(join(dir, 'checks'));
  writeFileSync(join(dir, 'checks', '0.lock'), '4242\nold command\n');
  const r = await withCheckSlot(dir, { slots: 1, command: 'new', pid: 7, isAlive: p => p !== 4242, waitMs: 0 }, () => 'ran');
  assert.deepEqual(r, { busy: false, value: 'ran' });
  assert.equal(existsSync(join(dir, 'checks', '0.lock')), false);
});

test('a slot whose holder died while its heavy command still runs stays held; once both are gone it is free and the old pid file goes', async () => {
  const dir = slotDir();
  mkdirSync(join(dir, 'checks'));
  writeFileSync(join(dir, 'checks', '0.lock'), '4242\nold command\n');
  writeFileSync(join(dir, 'checks', '0.lock.child'), '4343\n');
  let ran = false;
  const held = await withCheckSlot(dir, { slots: 1, command: 'new', pid: 7, pollMs: 5, waitMs: 30, isAlive: p => p !== 4242 }, () => { ran = true; });
  assert.equal(held.busy, true);
  assert.equal(ran, false);
  const freed = await withCheckSlot(dir, { slots: 1, command: 'new', pid: 7, waitMs: 0, isAlive: p => ![4242, 4343].includes(p) }, ({ child }) => existsSync(child));
  assert.deepEqual(freed, { busy: false, value: false });
  assert.deepEqual(readdirSync(join(dir, 'checks')), []);
});

test('a wait past waitMs returns busy and runs nothing', async () => {
  const dir = slotDir();
  mkdirSync(join(dir, 'checks'));
  writeFileSync(join(dir, 'checks', '0.lock'), '4242\nholder\n');
  let ran = false;
  const r = await withCheckSlot(dir, { slots: 1, command: 'x', pollMs: 5, waitMs: 40, isAlive: alive }, () => { ran = true; });
  assert.deepEqual(r, { busy: true });
  assert.equal(ran, false);
  assert.equal(existsSync(join(dir, 'checks', '0.lock')), true);
});

test('the slot is released when the command throws', async () => {
  const dir = slotDir();
  await assert.rejects(withCheckSlot(dir, { slots: 1, command: 'x', isAlive: alive }, () => { throw new Error('boom'); }), /boom/);
  assert.deepEqual(readdirSync(join(dir, 'checks')), []);
});

async function openedFixture() {
  const fixture = spikeFixture();
  fixture.at('2026-11-10T10:00:00.000Z');
  await run(['begin', PROJECT_URL], fixture.deps);
  const brief = JSON.parse((await run(['next'], fixture.deps)).stdout);
  assert.equal(brief.action, 'card');
  const tree = JSON.parse((await run(['tree', 'backend'], fixture.deps)).stdout).path;
  return { fixture, tree, deps: { ...fixture.deps, runSetup: setupRunner() } };
}

test('check passes the command\'s exit code through', async () => {
  const { deps } = await openedFixture();
  const r = await run(['check', '--', 'sh', '-c', 'exit 3'], deps);
  assert.equal(r.code, 3);
});

test('check runs in the first open tree and passes its output through', async () => {
  const { deps, tree } = await openedFixture();
  const r = await run(['check', '--', 'sh', '-c', 'pwd; echo err >&2'], deps);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim().endsWith(tree.split('/').pop()), true);
  assert.equal(r.stderr, 'err\n');
});

test('check answers busy when no slot frees in time', async () => {
  const { fixture, deps } = await openedFixture();
  const dir = activeRunDir(fixture.home);
  mkdirSync(join(dir, 'checks'), { recursive: true });
  writeFileSync(join(dir, 'checks', '0.lock'), `${process.pid}\nother\n`);
  const r = await run(['check', '--', 'sh', '-c', 'exit 3'], { ...deps, slot: { waitMs: 30, pollMs: 5 } });
  assert.equal(r.code, 75);
  assert.equal(JSON.parse(r.stdout).action, 'busy');
});

const BUSY = { slot: { waitMs: 30, pollMs: 5 } };
const hold = dir => {
  mkdirSync(join(dir, 'checks'), { recursive: true });
  writeFileSync(join(dir, 'checks', '0.lock'), `${process.pid}\nother\n`);
};
const stateText = dir => readFileSync(join(dir, 'run.json'), 'utf8');

test('tree answers busy with exit 75 and changes nothing', async () => {
  const fixture = spikeFixture();
  fixture.at('2026-11-10T10:00:00.000Z');
  await run(['begin', PROJECT_URL], fixture.deps);
  await run(['next'], fixture.deps);
  const dir = activeRunDir(fixture.home);
  const before = stateText(dir);
  hold(dir);
  const r = await run(['tree', 'backend'], { ...fixture.deps, ...BUSY });
  assert.equal(r.code, 75);
  assert.equal(JSON.parse(r.stdout).action, 'busy');
  assert.equal(stateText(dir), before);
  assert.equal(existsSync(join(dir, 'trees')), false);
});

test('end answers busy with exit 75: the card stays in progress and nothing is written', async () => {
  const { fixture, tree } = await openedFixture();
  const dir = activeRunDir(fixture.home);
  writeFileSync(join(tree, 'CRM-1.txt'), 'x\n');
  mkdirSync(join(dir, 'notes'), { recursive: true });
  writeFileSync(join(dir, 'notes', 'CRM-1.json'), JSON.stringify(notes));
  const before = stateText(dir);
  hold(dir);
  const r = await run(['end', 'CRM-1'], { ...fixture.deps, ...BUSY });
  assert.equal(r.code, 75);
  assert.equal(JSON.parse(r.stdout).action, 'busy');
  assert.equal(stateText(dir), before);
  assert.deepEqual(walk(join(dir, 'patches')), []);
  assert.deepEqual(walk(fixture.dataDir), []);
});

test('next answers busy with exit 75 when a replay entry cannot get a slot', async () => {
  const f = respikeFixture();
  const plan = JSON.parse((await f.run('preflight', [RESPIKE_URL, '--cards', B])).stdout);
  f.at('2026-11-10T10:01:00.000Z');
  const begun = JSON.parse((await f.run('begin', [RESPIKE_URL, '--cards', B, '--approve', plan.approve])).stdout);
  const dir = join(f.home, RESPIKE_SLUG, 'runs', begun.runId);
  const before = stateText(dir);
  hold(dir);
  const r = await f.spike(['next'], BUSY);
  assert.equal(r.code, 75);
  assert.equal(JSON.parse(r.stdout).action, 'busy');
  assert.equal(stateText(dir), before);
  assert.equal(existsSync(join(dir, 'trees')), false);
});

test('check runs its command as the slot\'s child: the pid file next to the slot names it while it runs and goes after', async () => {
  const { fixture, deps } = await openedFixture();
  const child = join(activeRunDir(fixture.home), 'checks', '0.lock.child');
  const r = await run(['check', '--', 'sh', '-c', 'cat "$0"; echo $$', child], deps);
  assert.equal(r.code, 0, r.stderr);
  const [recorded, own] = r.stdout.trim().split('\n');
  assert.equal(recorded, own);
  assert.equal(existsSync(child), false);
});

test('check stops a command that runs past --timeout-ms and exits 124', async () => {
  const { deps } = await openedFixture();
  const r = await run(['check', '--timeout-ms', '200', '--', 'sleep', '5'], deps);
  assert.equal(r.code, 124);
  assert.match(r.stderr, /timed out after 200 ms/);
  assert.equal((await run(['check', '--timeout-ms', 'soon', '--', 'true'], deps)).code, 2);
});
