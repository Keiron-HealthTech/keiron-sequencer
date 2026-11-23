import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { holderAlive, readHolder, takeOver } from './home.mjs';

export const CHECKS_DIR = 'checks';
// Half the 600 s the shell tool allows a command: a slot won late still leaves time for the work.
export const CHECK_WAIT_MS = 300_000;

const pause = ms => new Promise(r => setTimeout(r, ms));

export const childFile = path => `${path}.child`;

// A holder killed while its heavy command runs leaves that command running: the slot stays held while either is alive.
const holderOrChild = (path, isAlive) => pid => {
  const child = readHolder(childFile(path));
  return (child && holderAlive(child, isAlive)) || isAlive(pid);
};

// The slot's release, or null when it is held by a live process; 'again' when a dead holder was cleared or the file vanished.
function take(path, { pid, command, isAlive }) {
  let fd;
  try {
    fd = openSync(path, 'wx');
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const holder = readHolder(path);
    if (holder === null) return 'again';
    const alive = holderOrChild(path, isAlive);
    return !holderAlive(holder, alive) && takeOver(path, holder, alive) ? 'again' : null;
  }
  try {
    rmSync(childFile(path), { force: true });
    writeSync(fd, `${pid}\n${command}\n`);
  } finally {
    closeSync(fd);
  }
  return () => {
    rmSync(childFile(path), { force: true });
    rmSync(path, { force: true });
  };
}

const readSlot = path => {
  try {
    return readFileSync(path, 'utf8').split('\n');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
};

// Who holds each slot, as its file says: the pid that took it, its command, and the pid of the heavy command it runs.
function holdersOf(base, slots) {
  return Array.from({ length: slots }, (_, n) => {
    const path = join(base, `${n}.lock`);
    const lines = readSlot(path);
    if (!lines) return null;
    const child = Number(readHolder(childFile(path)));
    return { slot: n, pid: Number(lines[0]) || null, command: lines[1] ?? '', ...(child > 0 ? { child } : {}) };
  }).filter(Boolean);
}

// Heavy commands (type-check, tests, tree setup) share `slots` places across every worker of a run, so a small machine is
// never asked to run them all at once. Never call it while holding the run lock: a waiter would block every other command.
// fn gets the slot's `child` pid file: each heavy command it runs passes it to the runner as childPidFile.
export async function withCheckSlot(dir, { slots, command, pollMs = 500, waitMs = CHECK_WAIT_MS, pid = process.pid, isAlive = p => process.kill(p, 0) }, fn) {
  const base = join(dir, CHECKS_DIR);
  mkdirSync(base, { recursive: true });
  const deadline = Date.now() + waitMs;
  for (;;) {
    let again = false;
    for (let n = 0; n < slots; n++) {
      const taken = take(join(base, `${n}.lock`), { pid, command, isAlive });
      if (taken === 'again') again = true;
      if (typeof taken !== 'function') continue;
      try {
        return { busy: false, value: await fn({ child: childFile(join(base, `${n}.lock`)) }) };
      } finally {
        taken();
      }
    }
    if (again) continue;
    if (Date.now() >= deadline) return { busy: true, holders: holdersOf(base, slots) };
    await pause(pollMs);
  }
}
