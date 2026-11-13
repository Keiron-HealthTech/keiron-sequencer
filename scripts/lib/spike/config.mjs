import { readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { exitError } from '../cli.mjs';
import { assertHomeOutsideWorkTree, writeAtomic } from './home.mjs';

// Attested by the agent in the card notes, never matched from paths.
const ATTESTED_KINDS = new Set(['pii-in-logs']);
export const REPO_DIR = /^[^/\s]+$/;
const GITHUB = /^[\w.-]+\/[\w.-]+$/;
export const repoPart = slug => slug.slice(slug.indexOf('/') + 1);
export const BRANCH_NAMING = ['verbatim', 'strip-card-id'];

export const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export const isNonEmpty = v => typeof v === 'string' && v.length > 0;
const isSet = v => v !== null && v !== undefined;
const isArgv = v => Array.isArray(v) && v.length > 0 && v.every(isNonEmpty);
const isRoot = v => isNonEmpty(v) && (isAbsolute(v) || v.startsWith('~/'));
const isRootList = v => Array.isArray(v) && v.length > 0 && v.every(isRoot) && new Set(v).size === v.length;

export const TOP_KEYS = ['schemaVersion', 'repos', 'projects', 'checkoutRoots'];
export const REPO_KEYS = [
  'name', 'github', 'checkout', 'url', 'remote', 'defaultBranch', 'setup', 'typecheck', 'setupTimeoutMs', 'typecheckTimeoutMs',
  'spikeTypecheck', 'spikeTypecheckTimeoutMs', 'branchNaming', 'notes', 'risk',
];
export const PROJECT_KEYS = ['repos'];

function repoIssues(dir, repo, add) {
  const at = `repos.${dir}`;
  const issue = (field, where, message) => add({ at: where, repo: dir, field, message });
  if (!REPO_DIR.test(dir)) issue('dir', at, 'a repo dir is one path segment with no spaces');
  if (!isObject(repo)) { issue('entry', at, 'expected object'); return; }
  if (!isNonEmpty(repo.name)) issue('name', `${at}.name`, 'expected non-empty string');
  if (isSet(repo.github) && !(typeof repo.github === 'string' && GITHUB.test(repo.github))) issue('github', `${at}.github`, 'expected <owner>/<repo>');
  const sources = ['checkout', 'url'].filter(k => isSet(repo[k]));
  if (sources.length !== 1 || !isNonEmpty(repo[sources[0]])) issue('source', at, 'set exactly one of checkout and url');
  if (repo.remote === null) {
    if (!isNonEmpty(repo.checkout)) issue('remote', `${at}.remote`, 'null is only allowed with a checkout');
  } else if (!isNonEmpty(repo.remote)) {
    issue('remote', `${at}.remote`, 'expected a remote name, or null for a checkout read from its local branch');
  }
  if (isSet(repo.defaultBranch) && !isNonEmpty(repo.defaultBranch)) issue('defaultBranch', `${at}.defaultBranch`, 'expected non-empty string or null');
  for (const key of ['setup', 'typecheck']) {
    if (!isSet(repo[key])) continue;
    if (!Array.isArray(repo[key])) issue(key, `${at}.${key}`, 'expected an array of argv arrays');
    else repo[key].forEach((argv, i) => { if (!isArgv(argv)) issue(key, `${at}.${key}[${i}]`, 'expected a non-empty argv array of strings'); });
  }
  if (isSet(repo.spikeTypecheck) && repo.spikeTypecheck !== false && !isArgv(repo.spikeTypecheck)) {
    issue('spikeTypecheck', `${at}.spikeTypecheck`, 'expected false or a non-empty argv array of strings ("{changed}" expands to the changed files)');
  }
  for (const key of ['setupTimeoutMs', 'typecheckTimeoutMs', 'spikeTypecheckTimeoutMs']) {
    if (isSet(repo[key]) && !(Number.isInteger(repo[key]) && repo[key] > 0)) issue(key, `${at}.${key}`, 'expected a positive integer');
  }
  if (isSet(repo.branchNaming) && !BRANCH_NAMING.includes(repo.branchNaming)) {
    issue('branchNaming', `${at}.branchNaming`, `expected ${BRANCH_NAMING.map(r => `"${r}"`).join(' or ')}`);
  }
  if (isSet(repo.notes)) {
    if (!Array.isArray(repo.notes)) issue('notes', `${at}.notes`, 'expected an array of strings');
    else repo.notes.forEach((note, i) => { if (!isNonEmpty(note)) issue('notes', `${at}.notes[${i}]`, 'expected a non-empty string'); });
  }
  if (!isSet(repo.risk)) return;
  if (!Array.isArray(repo.risk)) { issue('risk', `${at}.risk`, 'expected array'); return; }
  const kinds = new Set();
  repo.risk.forEach((rule, i) => {
    const r = `${at}.risk[${i}]`;
    if (!isObject(rule)) { issue('risk', r, 'expected object'); return; }
    if (!isNonEmpty(rule.kind)) issue('risk', `${r}.kind`, 'expected non-empty string');
    else if (ATTESTED_KINDS.has(rule.kind)) issue('risk', `${r}.kind`, `${rule.kind} is attested in the card notes, not configured`);
    else if (kinds.has(rule.kind)) issue('risk', `${r}.kind`, `duplicate kind ${rule.kind}`);
    kinds.add(rule.kind);
    if (!Array.isArray(rule.paths) || !rule.paths.length || !rule.paths.every(isNonEmpty)) issue('risk', `${r}.paths`, 'expected a non-empty array of globs');
  });
}

// Each problem as { at, repo, field, message }; validateConfig is these joined, so its strings stay as they were.
export function configIssues(config) {
  if (!isObject(config)) return [{ at: 'config', repo: null, field: 'config', message: 'expected object' }];
  const issues = [];
  const add = issue => issues.push(issue);
  const top = (field, at, message) => add({ at, repo: null, field, message });
  if (config.schemaVersion !== 1) top('schemaVersion', 'schemaVersion', 'expected 1');
  if (!isObject(config.repos) || !Object.keys(config.repos).length) top('repos', 'repos', 'expected at least one repo');
  const repos = isObject(config.repos) ? config.repos : {};
  for (const [dir, repo] of Object.entries(repos)) repoIssues(dir, repo, add);
  if (config.checkoutRoots !== undefined && !isRootList(config.checkoutRoots)) {
    top('checkoutRoots', 'checkoutRoots', 'expected a non-empty array of distinct folder paths, each absolute or starting with ~/');
  }
  if (!isSet(config.projects)) return issues;
  if (!isObject(config.projects)) return [...issues, { at: 'projects', repo: null, field: 'projects', message: 'expected object' }];
  for (const [slug, project] of Object.entries(config.projects)) {
    const at = `projects.${slug}.repos`;
    if (!isObject(project)) { top('projects', `projects.${slug}`, 'expected object'); continue; }
    if (!isSet(project.repos)) continue;
    // An absent list allows every repo; an empty one would allow none, which is never what a config means.
    if (!Array.isArray(project.repos) || !project.repos.length) { top('projects', at, 'expected a non-empty array of repo dirs, or no repos key for all repos'); continue; }
    project.repos.forEach((dir, i) => { if (!Object.hasOwn(repos, dir)) top('projects', `${at}[${i}]`, `${dir} is not a configured repo`); });
  }
  return issues;
}

export const validateConfig = config => configIssues(config).map(i => `${i.at}: ${i.message}`);

export const expandHome = (path, userHome) => (typeof path === 'string' && path.startsWith('~/') ? join(userHome, path.slice(2)) : path);

export const configPath = home => join(home, 'config.json');

export function readConfigBytes(home) {
  try {
    return readFileSync(configPath(home));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw exitError(2, `cannot read the spike config ${configPath(home)}: ${e.code ?? e.message}`);
  }
}

export function loadConfig(home, { userHome = homedir() } = {}) {
  const path = configPath(home);
  let config;
  try {
    config = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`cannot read the spike config ${path}: ${e.code ?? e.message}`);
  }
  const errors = validateConfig(config);
  if (errors.length) throw new Error(`invalid spike config ${path}: ${errors.join('; ')}`);
  for (const repo of Object.values(config.repos)) repo.checkout = expandHome(repo.checkout, userHome);
  return config;
}

// baseBytes are the config.json bytes the text was drafted on, null when there was none: those go to the one backup.
// A text that fails to load is undone: the base bytes go back, or the file a first write made is removed.
export function writeConfig(home, text, baseBytes, { rename } = {}) {
  assertHomeOutsideWorkTree(home);
  const path = configPath(home);
  const backup = baseBytes === null ? null : `${path}.bak`;
  if (backup) writeAtomic(backup, baseBytes, { rename });
  writeAtomic(path, text, { rename });
  try {
    loadConfig(home);
  } catch (e) {
    try {
      if (backup) writeAtomic(path, baseBytes, { rename });
      else rmSync(path, { force: true });
    } catch (undo) {
      // The load error can quote the rejected text, so this message carries only paths and the undo's error code.
      const held = backup ? `; ${backup} holds the previous bytes` : '';
      throw exitError(1, `the written config did not load and undoing it failed (${undo.code ?? 'unknown error'}): ${path} may still hold the rejected text${held}`);
    }
    throw exitError(1, `${e.message}; ${backup ? 'the previous config.json was put back' : 'the new config.json was removed'}`);
  }
  return { path, backup };
}

export const allowedRepos = (config, slug) => config.projects?.[slug]?.repos ?? Object.keys(config.repos);

export function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/';
      out += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (ch === '*') {
      out += '[^/]*';
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

export const riskKinds = (repo, path) => (repo.risk ?? [])
  .filter(rule => rule.paths.some(glob => globToRegExp(glob).test(path)))
  .map(rule => rule.kind)
  .sort();
