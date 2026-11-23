import { closeSync, mkdirSync, openSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { holderAlive, readHolder, takeOver } from './home.mjs';

export const CHECKS_DIR = 'checks';
// Under the 600 s the shell tool allows a command, so a busy answer comes back before the tool times out.
export const CHECK_WAIT_MS = 540_000;

const pause = ms => new Promise(r => setTimeout(r, ms));

// The slot's release, or null when it is held by a live process; 'again' when a dead holder was cleared or the file vanished.
function take(path, { pid, command, isAlive }) {
  let fd;
  try {
    fd = openSync(path, 'wx');
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const holder = readHolder(path);
    if (holder === null) return 'again';
    return !holderAlive(holder, isAlive) && takeOver(path, holder, isAlive) ? 'again' : null;
  }
  try {
    writeSync(fd, `${pid}\n${command}\n`);
  } finally {
    closeSync(fd);
  }
  return () => rmSync(path, { force: true });
}

// Heavy commands (type-check, tests, tree setup) share `slots` places across every worker of a run, so a small machine is
// never asked to run them all at once. Never call it while holding the run lock: a waiter would block every other command.
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
        return { busy: false, value: await fn() };
      } finally {
        taken();
      }
    }
    if (again) continue;
    if (Date.now() >= deadline) return { busy: true };
    await pause(pollMs);
  }
}
