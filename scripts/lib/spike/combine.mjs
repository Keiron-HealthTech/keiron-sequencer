import { exitError } from '../cli.mjs';

const lines = text => text.split('\n').filter(Boolean);
const STATUS = /^git merge-tree failed \((\d+)\)/;
const REQUIREMENT = 'combining built branches needs git 2.38 or later with merge-tree --write-tree and --merge-base';

function present(git, cwd, env, sha) {
  try {
    git(['cat-file', '-e', `${sha}^{commit}`], { cwd, env });
    return true;
  } catch {
    return false;
  }
}

const changed = (git, cwd, env, base, side) => new Set(lines(git(['diff', '--name-only', base, side], { cwd, env })));

// gitRunner throws on any non-zero status and keeps only stderr, so a conflict is read from its message.
function mergeTree(git, cwd, env, args) {
  try {
    return { tree: lines(git(['merge-tree', '--write-tree', ...args], { cwd, env }))[0] };
  } catch (e) {
    if (e.message.match(STATUS)?.[1] === '1') return { conflict: true };
    throw exitError(1, `${e.message.split('\n')[0]}; ${REQUIREMENT}`);
  }
}

// Paths both sides change since their merge base: names only, never content.
function overlap(git, cwd, env, base, a, b) {
  const left = changed(git, cwd, env, base, a);
  return [...changed(git, cwd, env, base, b)].filter(p => left.has(p)).sort();
}

export function combineTree(git, cwd, heads, { env } = {}) {
  const missing = heads.filter(h => !present(git, cwd, env, h.sha));
  if (missing.length) return { missing };
  const cards = upTo => heads.slice(0, upTo).map(h => h.card);
  const [h1, h2] = heads;
  const first = mergeTree(git, cwd, env, [h1.sha, h2.sha]);
  if (first.conflict) {
    const base = lines(git(['merge-base', h1.sha, h2.sha], { cwd, env }))[0];
    return { conflict: { reason: 'conflict', cards: cards(2), paths: overlap(git, cwd, env, base, h1.sha, h2.sha) } };
  }
  let { tree } = first;
  for (let i = 2; i < heads.length; i++) {
    const bases = lines(git(['merge-base', '--all', heads[i].sha, ...heads.slice(0, i).map(h => h.sha)], { cwd, env }));
    if (bases.length !== 1) return { conflict: { reason: 'merge-bases', cards: cards(i + 1), paths: [] } };
    const step = mergeTree(git, cwd, env, [`--merge-base=${bases[0]}`, tree, heads[i].sha]);
    if (step.conflict) return { conflict: { reason: 'conflict', cards: cards(i + 1), paths: overlap(git, cwd, env, bases[0], tree, heads[i].sha) } };
    tree = step.tree;
  }
  return { tree };
}
