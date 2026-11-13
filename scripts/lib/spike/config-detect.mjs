import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { githubOf } from '../start/checkout.mjs';
import { repoPart } from './config.mjs';

const kindOf = path => {
  try {
    const stat = statSync(path);
    return stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : null;
  } catch {
    return null;
  }
};

// GIT_DIR pins every read to the child's own .git: without it git walks up past a broken one to an enclosing repo.
const at = path => ({ cwd: path, env: { GIT_DIR: join(path, '.git') } });

// githubOf keeps whatever follows the owner, so a query or fragment (which can hold a token) would ride along.
const SLUG = /^[\w.-]+\/[\w.-]+$/;
const slugOf = url => {
  const slug = githubOf(url);
  return slug && SLUG.test(slug) ? slug : null;
};

// Remote name -> lowercase GitHub owner/name, or null for a remote elsewhere. The URL never leaves this function,
// and neither does git's error text, which can quote it.
export function readRemotes(git, path) {
  let text;
  try {
    text = git(['remote', '-v'], at(path));
  } catch {
    return { remotes: null, reason: 'git could not read its remotes' };
  }
  const remotes = {};
  for (const line of text.split('\n')) {
    const [name, url, kind] = line.split(/\s+/);
    if (kind === '(fetch)') remotes[name] = slugOf(url);
  }
  return { remotes, reason: null };
}

// A main checkout keeps its .git as a directory; a linked checkout or a submodule has a .git file.
export function scanRoots(git, roots) {
  const candidates = [];
  const linked = [];
  const skipped = [];
  const missingRoots = [];
  for (const root of roots) {
    let children;
    try {
      children = readdirSync(root).sort();
    } catch {
      missingRoots.push(root);
      continue;
    }
    for (const basename of children) {
      const path = join(root, basename);
      if (kindOf(path) !== 'dir') continue;
      const dotGit = kindOf(join(path, '.git'));
      if (dotGit === 'file') linked.push({ path, basename });
      if (dotGit !== 'dir') continue;
      const { remotes, reason } = readRemotes(git, path);
      if (remotes) candidates.push({ path, basename, remotes });
      else skipped.push({ path, basename, reason });
    }
  }
  return { candidates, linked, skipped, missingRoots };
}

const lower = s => s.toLowerCase();

// names: every name the repo goes by (its config key, its entry name, a gap's raw name), compared case-insensitively.
// A main checkout folder carrying one of them wins. Only when none does, a main checkout whose origin is the repo on
// GitHub: the entry's github when it has one, else a GitHub repo carrying one of the names. More than one is never guessed.
export function matchCandidates({ candidates, linked = [] }, { names, github }) {
  const wanted = new Set(names.filter(Boolean).map(lower));
  const isRepo = slug => Boolean(slug) && (github ? slug === lower(github) : wanted.has(repoPart(slug)));
  const named = candidates.filter(c => wanted.has(lower(c.basename)));
  const [via, pool] = named.length ? ['folder', named] : ['origin', candidates.filter(c => isRepo(c.remotes.origin))];
  return {
    pick: pool.length === 1 ? pool[0] : null,
    via: pool.length ? via : null,
    ambiguous: pool.length > 1 ? pool : [],
    linked: linked.filter(c => wanted.has(lower(c.basename))),
  };
}

// Remote names only: a reason never carries a URL.
export function remoteOf({ remotes }) {
  if (remotes.origin) return { remote: 'origin', github: remotes.origin, reason: null };
  const onGithub = Object.keys(remotes).filter(name => remotes[name]).sort();
  if (onGithub.length === 1) return { remote: onGithub[0], github: remotes[onGithub[0]], reason: null };
  const reason = onGithub.length ? `several GitHub remotes and no origin: ${onGithub.join(', ')}` : 'no GitHub remote';
  return { remote: null, github: null, reason };
}

// Read only: an unset HEAD stays unset, so the reason tells the user rather than the CLI setting it.
export function originHead(git, path, remote) {
  if (!remote) return { branch: null, reason: 'needs a remote' };
  const unset = { branch: null, reason: `refs/remotes/${remote}/HEAD is not set` };
  let ref;
  try {
    ref = git(['symbolic-ref', '-q', '--short', `refs/remotes/${remote}/HEAD`], at(path)).trim();
  } catch {
    return unset;
  }
  return ref.startsWith(`${remote}/`) && ref.length > remote.length + 1 ? { branch: ref.slice(remote.length + 1), reason: null } : unset;
}

// matches: repo dir -> matchCandidates result. In dir order, the first dir to pick a checkout keeps it.
export function claimCheckouts(matches) {
  const owners = new Map();
  const claimed = {};
  for (const dir of Object.keys(matches).sort()) {
    const match = matches[dir];
    const owner = match.pick ? owners.get(match.pick.path) : undefined;
    if (match.pick && owner === undefined) owners.set(match.pick.path, dir);
    claimed[dir] = owner === undefined ? match : { ...match, pick: null, via: null, sameAs: owner, reason: `same checkout as repos.${owner}` };
  }
  return claimed;
}

const PACKAGE_MANAGER = /^(npm|pnpm|yarn)@(\d+)\.\d+\.\d+(?:[-+][\w.+-]*)?$/;
const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];

// The value only selects an ecosystem and a major number; nothing of it is ever returned as text.
function declaredManager(dir) {
  try {
    const value = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))?.packageManager;
    const m = typeof value === 'string' ? value.match(PACKAGE_MANAGER) : null;
    return m ? { tool: m[1], major: Number(m[2]) } : null;
  } catch {
    return null;
  }
}

function head(path, bytes) {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    return buffer.toString('utf8', 0, readSync(fd, buffer, 0, bytes, 0));
  } finally {
    closeSync(fd);
  }
}

function yarnLockKind(dir) {
  let text;
  try {
    text = head(join(dir, 'yarn.lock'), 1024);
  } catch {
    return null;
  }
  if (/^__metadata:/m.test(text)) return 'yarn-berry';
  return /^# yarn lockfile v1$/m.test(text) ? 'yarn-classic' : null;
}

const LOCKFILE_ECOSYSTEM = { 'package-lock.json': () => 'npm', 'pnpm-lock.yaml': () => 'pnpm', 'yarn.lock': yarnLockKind };

// Reads the checkout root only: package.json's packageManager, which lockfiles exist, the head of yarn.lock, go.mod.
export function ecosystemOf(dir) {
  const found = ecosystem => ({ ecosystem, declaredMajor: null, reason: null });
  const unfilled = reason => ({ ecosystem: null, declaredMajor: null, reason });
  const declared = declaredManager(dir);
  if (declared) {
    const ecosystem = declared.tool !== 'yarn' ? declared.tool : declared.major >= 2 ? 'yarn-berry' : 'yarn-classic';
    return { ecosystem, declaredMajor: declared.major, reason: null };
  }
  const locks = LOCKFILES.filter(name => existsSync(join(dir, name)));
  if (locks.length > 1) return unfilled(`several lockfiles: ${locks.join(', ')}`);
  if (locks.length === 1) {
    const ecosystem = LOCKFILE_ECOSYSTEM[locks[0]](dir);
    return ecosystem ? found(ecosystem) : unfilled(`${locks[0]} in an unknown format`);
  }
  if (existsSync(join(dir, 'package.json'))) return unfilled('package.json without a lockfile');
  return existsSync(join(dir, 'go.mod')) ? found('go') : unfilled('no ecosystem detected');
}

export const VERSION_ARGV = {
  corepack: ['corepack', '--version'],
  yarn: ['yarn', '--version'],
  npm: ['npm', '--version'],
  pnpm: ['pnpm', '--version'],
  go: ['go', 'version'],
};

// Only a version argv ever runs. A tool that is not installed throws ENOENT; any other outcome means it is there.
export function probeTool(runSetup, tool, { cwd }) {
  let r;
  try {
    r = runSetup(VERSION_ARGV[tool], { cwd, timeoutMs: 10_000 });
  } catch (e) {
    return { present: e.code !== 'ENOENT', version: null, major: null };
  }
  const version = r.status === 0 ? String(r.stdout).split('\n')[0].trim() || null : null;
  const major = version?.match(/\d+/)?.[0];
  return { present: true, version, major: major === undefined ? null : Number(major) };
}

// One probe per tool for the whole draft, however many repos ask.
export function toolProber(runSetup, { cwd }) {
  const known = new Map();
  return tool => {
    if (!known.has(tool)) known.set(tool, probeTool(runSetup, tool, { cwd }));
    return known.get(tool);
  };
}

// Tried in this order; the first whose tool is installed (and whose major fits) is proposed. These argvs install a
// repo's dependencies; nothing here installs a tool.
export const SETUP_CANDIDATES = {
  'yarn-berry': [
    { tool: 'corepack', setup: [['corepack', 'yarn', 'install', '--immutable']] },
    { tool: 'yarn', major: 'berry', setup: [['yarn', 'install', '--immutable']] },
  ],
  'yarn-classic': [
    { tool: 'corepack', setup: [['corepack', 'yarn', 'install', '--frozen-lockfile']] },
    { tool: 'yarn', major: 1, setup: [['yarn', 'install', '--frozen-lockfile']] },
  ],
  npm: [{ tool: 'npm', setup: [['npm', 'ci']] }],
  pnpm: [
    { tool: 'corepack', setup: [['corepack', 'pnpm', 'install', '--frozen-lockfile']] },
    { tool: 'pnpm', setup: [['pnpm', 'install', '--frozen-lockfile']] },
  ],
  go: [{ tool: 'go', setup: [['go', 'mod', 'download']] }],
};

const NEEDS = {
  'yarn-berry': declared => (declared === null ? 'needs corepack, or yarn 2 or later on PATH' : `needs yarn ${declared} via corepack, or yarn ${declared} on PATH`),
  'yarn-classic': () => 'needs corepack, or yarn 1 on PATH',
  npm: () => 'needs npm',
  pnpm: () => 'needs corepack, or pnpm on PATH',
  go: () => 'needs go',
};

// 'berry' wants the declared major, or any major from 2 up when none is declared. An unreadable version never fits.
const majorFits = (rule, major, declared) => rule === undefined
  || (major !== null && (rule === 'berry' ? (declared === null ? major >= 2 : major === declared) : major === rule));

// probe: tool -> probeTool's answer (see toolProber). declaredMajor is a number from ecosystemOf, or null.
export function setupFor(ecosystem, declaredMajor, probe) {
  for (const candidate of SETUP_CANDIDATES[ecosystem]) {
    const tool = probe(candidate.tool);
    if (tool.present && majorFits(candidate.major, tool.major, declaredMajor)) return { setup: structuredClone(candidate.setup), reason: null, needs: null };
  }
  const needs = NEEDS[ecosystem](declaredMajor);
  return { setup: null, reason: needs, needs };
}

// The facts of the checkout a repo uses, each read on its first use and kept: a repo asks git and the tools only for
// what its draft lines need. remotes: what a root scan already read for this folder, so it is not read again.
export function checkoutFacts(git, probe, { path, remotes = null }) {
  const known = new Map();
  const once = (name, read) => () => {
    if (!known.has(name)) known.set(name, read());
    return known.get(name);
  };
  const remote = once('remote', () => {
    const read = remotes ? { remotes, reason: null } : readRemotes(git, path);
    return read.remotes ? remoteOf(read) : { remote: null, github: null, reason: read.reason };
  });
  const head = once('head', () => originHead(git, path, remote().remote));
  const setup = once('setup', () => {
    const { ecosystem, declaredMajor, reason } = ecosystemOf(path);
    return ecosystem ? setupFor(ecosystem, declaredMajor, probe) : { setup: null, reason, needs: null };
  });
  return { get remote() { return remote(); }, get head() { return head(); }, get setup() { return setup(); } };
}

// facts: repo -> what is known already (oldTrial). Each repo looked for gets its match under the roots; each repo of
// repos then gets the facts of the checkout it uses: its configured one when that is real, else the folder found for it.
// planning is the planner's config: `~/` expanded, a checkout only when real, values the config refuses nulled.
export function draftFacts(git, probe, { scan, targets, repos, planning, facts = {} }) {
  const out = Object.fromEntries(Object.entries(facts).map(([repo, f]) => [repo, { ...f }]));
  for (const repo of targets) {
    const entry = planning.repos[repo];
    out[repo] = { ...out[repo], match: matchCandidates(scan, { names: [repo, entry?.name], github: entry?.github ?? null }) };
  }
  for (const repo of new Set(repos)) {
    const configured = planning.repos[repo]?.checkout;
    const pick = out[repo]?.match?.pick;
    if (configured || pick) out[repo] = Object.assign(checkoutFacts(git, probe, configured ? { path: configured } : pick), out[repo]);
  }
  return out;
}

// The trial patch map names each trial dir with its repo; a name still keyed there under another value is a dir
// the rename script has not moved yet.
export function oldTrialDir(patchMap, slug, name) {
  const repos = patchMap?.project?.slug === slug ? patchMap.repos : null;
  return Boolean(repos) && typeof repos === 'object' && Object.hasOwn(repos, name) && repos[name] !== name;
}
