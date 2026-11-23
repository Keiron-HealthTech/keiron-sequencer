import { closeSync, existsSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { exitError } from '../cli.mjs';

export { RUN_ID } from '../record.mjs';

export const TRIAL_DIR = 'trial-p-crm-371';
const STATE_FILE = 'run.json';
const LOCK_FILE = 'run.lock';

export const sequencerHome = (env = process.env) => env.KEIRON_SEQUENCER_HOME || join(homedir(), '.keiron-sequencer');

// Records, reports and harvest inputs are personal: they live in the spike home, never in the repo.
export const dataDirFor = (env = process.env) => sequencerHome(env);

// The data folder of a slug as output names it: under the user's home it starts with ~.
export function displayData(dataDir, slug, userHome = homedir()) {
  const path = join(dataDir, slug);
  return path === userHome || path.startsWith(`${userHome}${sep}`) ? `~${path.slice(userHome.length)}` : path;
}

export const runIdAt = date => date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

export const runDir = (home, slug, runId) => join(home, slug, 'runs', runId);

export const statePath = (home, slug, runId) => join(runDir(home, slug, runId), STATE_FILE);

export const trialPatchRoot = (home, slug) => join(home, slug, TRIAL_DIR);

// The hand-run trial's patch map, logs, Linear snapshot and curated notes, beside its patches.
export const TRIAL_REFERENCE = 'trial-reference';
export const trialReferenceDir = (home, slug) => join(home, slug, TRIAL_REFERENCE);

// The one trial reference under the home; the backfill learns the slug from it, so it cannot be looked up by slug.
export function findTrialReference(home) {
  const slugs = existsSync(home) ? readdirSync(home, { withFileTypes: true }).filter(e => e.isDirectory() && existsSync(trialReferenceDir(home, e.name))).map(e => e.name).sort() : [];
  if (slugs.length === 1) return trialReferenceDir(home, slugs[0]);
  const where = join(home, '<slug>', TRIAL_REFERENCE);
  if (!slugs.length) throw new Error(`no trial reference at ${where}: move it there with scripts/maintenance/move-reference.mjs, or pass --trial <dir>`);
  throw new Error(`several trial references under ${home} (${slugs.join(', ')}): pass --trial <dir>`);
}

// The nearest folder at or above path holding a .git, so a path that does not exist yet is placed too; null outside every repo.
export function workTreeOf(path) {
  for (let dir = resolve(path); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

// A home inside a work tree would let `git add -A` in that repo pick up run state and patches.
export function assertHomeOutsideWorkTree(home) {
  const dir = workTreeOf(home);
  if (dir) throw new Error(`the spike home ${home} is inside the git work tree ${dir}: set KEIRON_SEQUENCER_HOME to a folder outside every repo`);
}

export function writeAtomic(path, text, { rename = renameSync } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text);
    rename(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

export const writeJsonAtomic = (path, value) => writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`);

const pause = ms => new Promise(r => setTimeout(r, ms));

// The pid is the first line: a check slot file carries its command after it.
export function readHolder(path) {
  try {
    return readFileSync(path, 'utf8').split('\n')[0].trim();
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

// An empty or unparsable pid is a holder still writing its lock, so it counts as alive. EPERM is a live process of another user.
export function holderAlive(holder, isAlive) {
  const pid = Number(holder);
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    return isAlive(pid) !== false;
  } catch (e) {
    return e.code !== 'ESRCH';
  }
}

// A rename or a re-read could still remove a lock another waiter has just re-created. The claim is a hard link only one
// waiter can make, and it pins the file that waiter saw: only that file's holder is checked again, and only it is removed.
// True when the lock is gone and worth contending for again.
export function takeOver(path, holder, isAlive) {
  const claim = `${path}.dead-${holder}`;
  try {
    linkSync(path, claim);
  } catch (e) {
    if (e.code === 'ENOENT') return true;
    if (e.code === 'EEXIST') return false;
    throw e;
  }
  try {
    if (readHolder(claim) !== holder || holderAlive(holder, isAlive)) return false;
    rmSync(path, { force: true });
    return true;
  } finally {
    rmSync(claim, { force: true });
  }
}

export const RUN_LOCK_WAIT_MS = 120_000;

// A wait that runs out answers busy (75) like a full check slot: the holder is alive, so its lock is never removed by hand.
export async function acquireLock(dir, { pid = process.pid, waitMs = RUN_LOCK_WAIT_MS, pollMs = 100, isAlive = p => process.kill(p, 0) } = {}) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, LOCK_FILE);
  const deadline = Date.now() + waitMs;
  for (;;) {
    let fd;
    try {
      fd = openSync(path, 'wx');
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const holder = readHolder(path);
      if (holder === null) continue;
      if (!holderAlive(holder, isAlive) && takeOver(path, holder, isAlive)) continue;
      if (Date.now() >= deadline) {
        throw Object.assign(exitError(75, `the run is locked by pid ${holder || 'unknown'}: run the command again once it ends`), {
          output: { action: 'busy', lock: { pid: Number(holder) || null } },
        });
      }
      await pause(pollMs);
      continue;
    }
    try {
      writeSync(fd, `${pid}\n`);
    } finally {
      closeSync(fd);
    }
    return () => rmSync(path, { force: true });
  }
}

export async function withLock(dir, fn, options) {
  const release = await acquireLock(dir, options);
  try {
    return await fn();
  } finally {
    release();
  }
}
