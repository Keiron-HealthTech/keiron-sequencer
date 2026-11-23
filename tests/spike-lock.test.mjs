import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../scripts/spike.mjs';
import { acquireLock } from '../scripts/lib/spike/home.mjs';
import { fakeSetup, SANDBOX_ENV, tempDir } from './helpers/git-sandbox.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import { notes, PROJECT_URL, SLUG, spikeFixture, walk } from './helpers/spike-fixture.mjs';

guardNetwork();

const SPIKE = fileURLToPath(new URL('../scripts/spike.mjs', import.meta.url));

function lockDir() {
  const dir = tempDir('keiron-sequencer-lock-');
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const holder = dir => readFileSync(join(dir, 'run.lock'), 'utf8');

test('a second caller waits for the lock and then gets it', async () => {
  const dir = lockDir();
  const release = await acquireLock(dir, { pid: 4242, isAlive: () => true });
  const started = Date.now();
  setTimeout(release, 50);
  const second = await acquireLock(dir, { pid: 4343, isAlive: () => true, pollMs: 5 });
  assert.ok(Date.now() - started >= 45, `got the lock after ${Date.now() - started} ms`);
  assert.equal(holder(dir), '4343\n');
  second();
  assert.equal(existsSync(join(dir, 'run.lock')), false);
});

test('a lock held by a dead pid is taken over', async () => {
  const dir = lockDir();
  writeFileSync(join(dir, 'run.lock'), '4242\n');
  const release = await acquireLock(dir, { pid: 4343, isAlive: () => false, waitMs: 0 });
  assert.equal(holder(dir), '4343\n');
  release();
});

test('by default a lock whose process is gone is taken over, and a live one is waited on until waitMs', async () => {
  const dir = lockDir();
  const gone = spawnSync(process.execPath, ['-e', ''], { env: { HOME: dir } }).pid;
  writeFileSync(join(dir, 'run.lock'), `${gone}\n`);
  const release = await acquireLock(dir, { pid: process.pid, waitMs: 0 });
  assert.equal(holder(dir), `${process.pid}\n`);
  await assert.rejects(acquireLock(dir, { pid: 4343, waitMs: 30, pollMs: 5 }), e => e.message.includes(`locked by pid ${process.pid}`));
  assert.equal(holder(dir), `${process.pid}\n`);
  release();
});

async function cardReadyToEnd(typecheck) {
  const fixture = spikeFixture();
  const { deps, home } = fixture;
  const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
  config.repos.backend.spikeTypecheck = typecheck;
  writeFileSync(join(home, 'config.json'), JSON.stringify(config));
  const { runId } = JSON.parse((await run(['begin', PROJECT_URL], deps)).stdout);
  const dir = join(home, SLUG, 'runs', runId);
  fixture.at('2026-11-10T10:01:00.000Z');
  assert.equal((await run(['next'], deps)).code, 0);
  const tree = JSON.parse((await run(['tree', 'backend'], deps)).stdout);
  writeFileSync(join(tree.path, 'README.md'), '# sandbox\nspiked\n');
  mkdirSync(join(dir, 'notes'), { recursive: true });
  writeFileSync(join(dir, 'notes', 'CRM-1.json'), JSON.stringify(notes));
  fixture.at('2026-11-10T10:05:00.000Z');
  return { ...fixture, dir };
}

const stateOf = dir => JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));

test('end returns stale when the track\'s generation moved during its type-check', async () => {
  const { deps, dir, dataDir } = await cardReadyToEnd(['tc', '{changed}']);
  const bump = () => {
    const state = stateOf(dir);
    state.tracks.t1.generation += 1;
    writeFileSync(join(dir, 'run.json'), JSON.stringify(state));
    return { status: 0, stdout: '', stderr: '' };
  };
  const r = await run(['end', 'CRM-1'], { ...deps, runSetup: bump });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { action: 'stale', track: 't1' });
  const state = stateOf(dir);
  assert.equal(state.tracks.t1.generation, 1);
  assert.equal(state.cards['CRM-1'].status, 'in-progress');
  assert.equal(state.tracks.t1.current.card, 'CRM-1');
  assert.deepEqual(walk(join(dir, 'patches')), []);
  assert.deepEqual(walk(dataDir), []);
});

test('rerunning end after a kill mid-check ends the card once', async () => {
  const { deps, dir, dataDir, home, scratch } = await cardReadyToEnd(['sh', '-c', 'kill -9 $PPID']);
  const before = readFileSync(join(dir, 'run.json'), 'utf8');
  const killed = spawnSync(process.execPath, [SPIKE, 'end', 'CRM-1'], {
    env: { ...SANDBOX_ENV, HOME: scratch, KEIRON_SEQUENCER_HOME: home }, encoding: 'utf8',
  });
  assert.equal(killed.signal, 'SIGKILL', killed.stderr);
  assert.equal(readFileSync(join(dir, 'run.json'), 'utf8'), before);
  assert.equal(existsSync(join(dir, 'run.lock')), false);

  const checks = fakeSetup();
  const ended = await run(['end', 'CRM-1'], { ...deps, runSetup: checks.run });
  assert.equal(ended.code, 0, ended.stderr);
  assert.deepEqual(checks.calls.map(c => c.argv), [['sh', '-c', 'kill -9 $PPID']]);
  const again = await run(['end', 'CRM-1'], { ...deps, runSetup: checks.run });
  assert.equal(again.code, 1);
  assert.match(again.stderr, /CRM-1 is not the card in progress/);

  const state = stateOf(dir);
  assert.equal(state.cards['CRM-1'].status, 'done');
  assert.deepEqual(state.cards['CRM-1'].patches, ['backend/00001-new.patch']);
  assert.deepEqual(state.tracks.t1.repos.backend.log.map(e => e.name), ['00001-new']);
  assert.deepEqual(walk(join(dir, 'patches')), ['backend/00001-new.patch']);
  assert.deepEqual(walk(dataDir), [`${SLUG}/CRM-1.json`]);
});
