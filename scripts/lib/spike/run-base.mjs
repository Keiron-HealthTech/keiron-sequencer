import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { patchStats } from '../patch-stats.mjs';
import { runDir, statePath } from './home.mjs';
import { parseCardPatchName } from './snapshot.mjs';
import { readState, trackOfCard } from './state.mjs';

const NO_CHAIN = { baseCommit: null, patchTexts: [], chainedFiles: [], combine: false };

const runRepo = (record, { home, slug, repoDir }) => {
  const runId = record?.refs?.runId;
  if (!runId || !existsSync(statePath(home, slug, runId))) return null;
  const state = readState(runDir(home, slug, runId));
  const tracks = Object.values(state.tracks);
  const repo = (state.tracks[trackOfCard(state, record.card)] ?? (tracks.length === 1 ? tracks[0] : null))?.repos[repoDir];
  return repo ? { runId, repo } : null;
};

export const runBaseCommit = (record, where) => runRepo(record, where)?.repo.baseCommit ?? null;

// What the card's line numbers rest on in one repo: the run's base commit, the card's own patch, and the files whose lines
// it does not share with that base. Those are the files an earlier patch of the run touched (the card patch was cut on top
// of them) and the files of the fixups the card received (cut later still). A trial record has no run: no chain.
export function runChain(record, { home, slug, repoDir, patchDir = repoDir }) {
  const found = runRepo(record, { home, slug, repoDir });
  if (!found) return NO_CHAIN;
  const { runId, repo } = found;
  const dir = join(runDir(home, slug, runId), 'patches', patchDir);
  const read = name => {
    const path = join(dir, `${name}.patch`);
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  };
  const own = (record.refs.patches ?? []).filter(p => p.startsWith(`${patchDir}/`)).map(p => p.slice(patchDir.length + 1, -'.patch'.length));
  const card = own.find(n => parseCardPatchName(`${n}.patch`));
  const log = repo.log ?? [];
  const at = log.findIndex(e => e.name === card);
  const earlier = at === -1 ? log.map(e => e.name) : log.slice(0, at).map(e => e.name);
  const filesOf = names => names.map(read).filter(Boolean).flatMap(text => patchStats(text).files);
  const cardText = at === -1 ? null : read(card);
  return {
    baseCommit: repo.baseCommit ?? null,
    patchTexts: cardText ? [cardText] : [],
    chainedFiles: [...new Set(filesOf([...earlier, ...own.filter(n => n !== card)]))].sort(),
    combine: Boolean(repo.combine),
  };
}
