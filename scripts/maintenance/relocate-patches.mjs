import { createHash } from 'node:crypto';
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gitRunner } from '../lib/spike/exec.mjs';
import { assertHomeOutsideWorkTree, TRIAL_DIR } from '../lib/spike/home.mjs';

export const TRIAL = 'docs/reference/spike-trial-p-crm-371';

const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const nulList = text => text.split('\0').filter(Boolean);

const trackedPatches = (git, repo) => nulList(git(['ls-files', '-z', '--', '*.patch'], { cwd: repo })).filter(p => p.endsWith('.patch')).sort();

function repoDirs(repo, trial) {
  const map = join(repo, trial, 'backfill/patch-map.json');
  return existsSync(map) ? Object.keys(JSON.parse(readFileSync(map, 'utf8')).repos ?? {}) : [];
}

// The copy is taken from the working tree, so a working copy that is not the tracked content would be the only one kept.
function assertUnchanged(git, repo, paths) {
  const changed = nulList(git(['--literal-pathspecs', 'diff', '--name-only', '-z', '--', ...paths], { cwd: repo }));
  if (changed.length) throw new Error(`these patches differ from the index or are missing, so nothing was copied: ${changed.join(', ')}; restore them first`);
}

export function relocate({ repo, dest, apply = false, trial = TRIAL, git = gitRunner(), copyFile = copyFileSync }) {
  const dirs = repoDirs(repo, trial);
  const files = [];
  const unattributed = [];
  for (const path of trackedPatches(git, repo)) {
    const rest = path.startsWith(`${trial}/`) ? path.slice(trial.length + 1).split('/') : [];
    if (rest.length === 2 && dirs.includes(rest[0])) files.push({ path, to: join(dest, TRIAL_DIR, ...rest) });
    else unattributed.push(path);
  }
  const source = f => join(repo, f.path);
  if (!apply) {
    return { files: files.map(f => ({ ...f, sha256: existsSync(source(f)) ? sha256(source(f)) : null, copied: false })), unattributed, removed: [] };
  }
  if (!files.length) return { files: [], unattributed, removed: [] };

  assertHomeOutsideWorkTree(dest);
  const paths = files.map(f => f.path);
  assertUnchanged(git, repo, paths);
  for (const f of files) f.sha256 = sha256(source(f));
  const taken = files.filter(f => existsSync(f.to) && sha256(f.to) !== f.sha256).map(f => f.to);
  if (taken.length) throw new Error(`a different file is already at ${taken.join(', ')}; nothing was copied or removed`);
  for (const f of files) {
    f.copied = !existsSync(f.to);
    if (!f.copied) continue;
    mkdirSync(dirname(f.to), { recursive: true });
    copyFile(source(f), f.to, constants.COPYFILE_EXCL);
  }
  const bad = files.filter(f => sha256(f.to) !== f.sha256).map(f => f.path);
  if (bad.length) throw new Error(`the copies of ${bad.join(', ')} do not match their sha256; nothing was removed and the copies were kept`);

  git(['--literal-pathspecs', 'rm', '--cached', '-q', '--', ...paths], { cwd: repo });
  for (const f of files) rmSync(source(f), { force: true });
  return { files: files.map(({ path, to, sha256: sum, copied }) => ({ path, to, sha256: sum, copied })), unattributed, removed: paths };
}
