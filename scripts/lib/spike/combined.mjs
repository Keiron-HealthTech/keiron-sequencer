import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { exitError } from '../cli.mjs';
import { COMBINE_FIXUP } from '../record.mjs';
import { mergedTree } from './replay.mjs';
import { oldSideRanges, rangesOverlap } from './snapshot.mjs';
import { COMBINED } from './state.mjs';
import { checkTree, openTree } from './trees.mjs';
import { clearGenerated, repoTypecheck, typecheckLog } from './typecheck.mjs';

export const COMBINE_ROUNDS = 3;

const cardNumber = key => Number(String(key).match(/(\d+)$/)?.[1] ?? 0);
const byNumber = cards => [...new Set(cards)].sort((a, b) => cardNumber(a) - cardNumber(b));
const CARD_ENTRY = /^(\d{5})-(?:new|existing)$/;
const DIAGNOSTICS = [/^(.+?)\((\d+),\d+\): error (TS\d+: .*)$/, /^(.+?):(\d+):\d+ - error (TS\d+: .*)$/];

// tsc's plain `path(line,col): error TSn: msg` and its pretty `path:line:col - error TSn: msg`; any other line is skipped.
export function parseTypecheckErrors(text) {
  return text.split('\n').flatMap(raw => {
    const m = DIAGNOSTICS.map(re => raw.trim().match(re)).find(Boolean);
    return m ? [{ file: m[1], line: Number(m[2]), message: m[3] }] : [];
  });
}

export const combinedFixupName = (fixed, n) => `fixup-${fixed.map(cardNumber).sort((a, b) => a - b).join('-')}-from-combine-${n}.patch`;

function ownerOf(state, repoDir, name) {
  const m = name.match(CARD_ENTRY);
  if (m) return state.plan.order.find(k => cardNumber(k) === Number(m[1])) ?? null;
  return state.fixups.findLast(f => !f.droppedBy && f.patch === `${repoDir}/${name}.patch`)?.from ?? null;
}

// Each log entry was cut against the one before it in its own track, so a track's log keeps its order even where a merge
// moved it off plan.order; tracks interleave by the plan position of the card each next entry belongs to.
export function combinedEntries(state, repoDir) {
  const position = new Map(state.plan.order.map((k, i) => [k, i]));
  const queues = Object.values(state.tracks).filter(t => !t.mergedInto).map(t => {
    let rank = -1;
    return (t.repos[repoDir]?.log ?? []).map(e => {
      const card = ownerOf(state, repoDir, e.name);
      rank = position.get(card) ?? rank;
      return { name: e.name, cards: card ? [card] : [], rank };
    });
  }).filter(q => q.length);
  const out = [];
  while (queues.some(q => q.length)) out.push(queues.filter(q => q.length).reduce((a, b) => (b[0].rank < a[0].rank ? b : a)).shift());
  return out;
}

// The fixups made on the combined tree go on top of every track, in the order they were made.
const combineFixups = (state, repoDir) => state.fixups.filter(f => f.from === COMBINE_FIXUP && !f.droppedBy && f.patch.startsWith(`${repoDir}/`))
  .map(f => ({ name: basename(f.patch, '.patch'), cards: f.fixed }));

const combinedRepos = state => [...new Set(Object.values(state.tracks).filter(t => !t.mergedInto)
  .flatMap(t => Object.entries(t.repos).filter(([, r]) => r.log?.length).map(([d]) => d)))];

// A spike run's tree takes the default branch when it opens, so the combined tree is pinned where the tracks' trees started.
function baseOf(state, repoDir) {
  if (state.plan.respike) return undefined;
  const tree = Object.values(state.tracks).map(t => t.repos[repoDir]).find(r => r?.kind === 'worktree' && r.baseCommit);
  return tree ? { kind: 'pinned', sha: tree.baseCommit } : undefined;
}

// Every round rebuilds the tree from its base, so work edited into it and not recorded would be lost.
function assertRecorded(git, repoDir, repo) {
  checkTree(git, repoDir, repo);
  clearGenerated(repo.path);
  git(['add', '-A'], { cwd: repo.path });
  if (git(['write-tree'], { cwd: repo.path }).trim() !== repo.last) {
    throw exitError(6, `${repoDir} has work in ${repo.path} that was not recorded: record it with fixup --combined, or drop it, then run combine again`);
  }
}

// The cards whose patches changed the error's line; when none did, every card that changed its file.
function cardsAt(touched, file, line) {
  const inFile = touched.filter(t => t.ranges.has(file));
  const onLine = inFile.filter(t => rangesOverlap(t.ranges.get(file), [[line, line]]).length);
  return byNumber((onLine.length ? onLine : inFile).flatMap(t => t.cards));
}

function typeErrors(repoDir, repo, touched, check, log) {
  const key = e => `${e.file}\0${e.line}\0${e.message}`;
  const ignored = new Set(parseTypecheckErrors(check.ignored.join('\n')).map(key));
  const found = parseTypecheckErrors(existsSync(log) ? readFileSync(log, 'utf8') : '').filter(e => !ignored.has(key(e)));
  if (!found.length) {
    const why = check.timedOut ? 'the typecheck timed out' : `the typecheck failed with no error line (exit ${check.status})`;
    return [{ repo: repoDir, file: null, line: null, message: `${why}; see ${log}`, cards: [] }];
  }
  return found.map(e => {
    const file = e.file.startsWith(`${repo.path}/`) ? e.file.slice(repo.path.length + 1) : e.file;
    return { repo: repoDir, file, line: e.line, message: e.message, cards: cardsAt(touched, file, e.line) };
  });
}

function conflictErrors(repoDir, touched, { patch, reason, unmerged }) {
  const upTo = touched.slice(0, touched.findIndex(t => t.name === patch) + 1);
  const message = `${patch}.patch does not apply on the combined tree (${reason})`;
  if (!unmerged.length) return [{ repo: repoDir, file: null, line: null, message, cards: byNumber(upTo.at(-1).cards) }];
  return unmerged.map(file => ({ repo: repoDir, file, line: null, message, cards: byNumber(upTo.filter(t => t.ranges.has(file)).flatMap(t => t.cards)) }));
}

// One repo's combined tree, rebuilt from its base: the tracks' entries, then the fixups made on it, applied 3-way in a
// temporary index; a patch that does not apply leaves the tree where it was. The tree is then type-checked over every path
// the tracks changed.
function buildRepo(git, state, repos, repoDir, { config, dir, runSetup }) {
  const shell = { plan: state.plan, tracks: { [COMBINED]: { repos } } };
  const repo = openTree(git, shell, { trackId: COMBINED, repoDir, repo: config.repos[repoDir], dir, runSetup, base: baseOf(state, repoDir) });
  assertRecorded(git, repoDir, repo);
  const pathOf = name => join(dir, 'patches', repoDir, `${name}.patch`);
  const touched = [...combinedEntries(state, repoDir), ...combineFixups(state, repoDir)]
    .map(e => ({ ...e, ranges: oldSideRanges(readFileSync(pathOf(e.name), 'utf8')) }));
  const index = join(dir, 'tmp', COMBINED, `combine-${repoDir}.index`);
  const merged = mergedTree(git, repoDir, { ...repo, last: repo.baseTree }, touched.map(t => t.name), { index, pathOf });
  if (merged.conflict) return conflictErrors(repoDir, touched, merged.conflict);
  git(['read-tree', '-m', '-u', repo.last, merged.tree], { cwd: repo.path });
  repo.last = merged.tree;
  const changed = git(['diff', '--name-only', '--diff-filter=d', repo.baseTree, repo.last], { cwd: repo.path }).split('\n').filter(Boolean);
  const log = typecheckLog(dir, COMBINED, repoDir);
  rmSync(log, { force: true });
  const check = repoTypecheck(runSetup, config.repos[repoDir], { treePath: repo.path, changed, logPath: log });
  return !check.ran || check.ok ? [] : typeErrors(repoDir, repo, touched, check, log);
}

// `repos` is the combined trees' state, changed in place; the errors of every repo come back, none when all pass.
export function buildCombined(git, state, repos, deps) {
  mkdirSync(join(deps.dir, 'tmp', COMBINED), { recursive: true });
  return combinedRepos(state).flatMap(repoDir => buildRepo(git, state, repos, repoDir, deps));
}
