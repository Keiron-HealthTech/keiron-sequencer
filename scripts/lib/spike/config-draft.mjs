import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { exitError } from '../cli.mjs';
import { canonicalJson } from '../harvest.mjs';
import {
  configIssues, expandHome, isNonEmpty, isObject, PROJECT_KEYS, readConfigBytes, REPO_DIR, REPO_KEYS, repoPart, TOP_KEYS, validateConfig,
} from './config.mjs';
import { workTreeOf } from './home.mjs';

const sha256 = data => createHash('sha256').update(data).digest('hex');

export const EMPTY_BASE = { schemaVersion: 1, repos: {} };

export const readRawConfig = home => rawConfigOf(readConfigBytes(home));

// The state of config.json bytes already read (null: no file). JSON.parse's own message quotes the text, so the reason given is fixed.
export function rawConfigOf(bytes) {
  if (bytes === null) return { state: 'absent' };
  const text = bytes.toString('utf8');
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { state: 'unparseable', error: text.trim() ? 'not valid JSON' : 'the file is empty' };
  }
  if (!isObject(raw)) return { state: 'not-object' };
  return { state: 'read', bytes, text, raw, issues: configIssues(raw) };
}

const isRealCheckout = path => {
  try {
    return statSync(path).isDirectory() && existsSync(join(path, '.git'));
  } catch {
    return false;
  }
};

// Keys the planner reads; one the validator rejects is planned as unset.
const PLANNED_KEYS = ['name', 'github', 'remote', 'defaultBranch', 'setup', 'risk'];

// The planner's copy of a file that may not validate: `~/` is expanded here, while the draft keeps the raw text's paths.
// Every kept entry is an object, a checkout is a real folder or null, a key the validator rejects is null,
// and a project list names only kept dirs. A list left empty stays empty: the raw list allows none of the others.
export function planningConfig(raw, { userHome, isCheckout = isRealCheckout }) {
  const config = structuredClone(raw);
  const rejected = new Set(configIssues(raw).filter(i => i.repo !== null).map(i => `${i.repo}\0${i.field}`));
  const repos = {};
  for (const [dir, entry] of Object.entries(isObject(config.repos) ? config.repos : {})) {
    if (rejected.has(`${dir}\0dir`) || !isObject(entry)) continue;
    for (const key of PLANNED_KEYS) if (rejected.has(`${dir}\0${key}`)) entry[key] = null;
    const checkout = isNonEmpty(entry.checkout) ? expandHome(entry.checkout, userHome) : null;
    entry.checkout = checkout !== null && isCheckout(checkout) ? checkout : null;
    if (entry.checkout !== null || !isNonEmpty(entry.url)) entry.url = null;
    repos[dir] = entry;
  }
  config.repos = repos;
  if (config.projects === undefined || config.projects === null) return config;
  if (!isObject(config.projects)) { delete config.projects; return config; }
  for (const [slug, project] of Object.entries(config.projects)) {
    if (!isObject(project)) { delete config.projects[slug]; continue; }
    if (project.repos === undefined) continue;
    if (Array.isArray(project.repos) && project.repos.length) project.repos = project.repos.filter(d => typeof d === 'string' && Object.hasOwn(repos, d));
    else delete project.repos;
  }
  return config;
}

const proposed = (path, value, text = `${path}: ${JSON.stringify(value)}`) => ({ kind: 'proposed', path, value, text });
const unfilled = (path, reason) => ({ kind: 'unfilled', path, reason, text: `${path}: left unfilled, ${reason}` });
const withIssues = (lines, issues) => (issues.length ? lines.map(line => ({ ...line, issues })) : lines);

const NO_CHECKOUT = 'no checkout to read it from';

// What a key would take from the facts of the checkout in use: { value } or { reason }.
const FROM_FACTS = {
  github: f => (f.remote?.github ? { value: f.remote.github } : { reason: f.remote?.reason ?? NO_CHECKOUT }),
  remote: f => (f.remote?.remote ? { value: f.remote.remote } : { reason: f.remote?.reason ?? NO_CHECKOUT }),
  defaultBranch: f => (f.head?.branch ? { value: f.head.branch } : { reason: f.head?.reason ?? NO_CHECKOUT }),
  setup: f => (f.setup?.setup ? { value: f.setup.setup } : { reason: f.setup?.reason ?? NO_CHECKOUT, needs: f.setup?.needs ?? null }),
};
// The config key each gap code is about; a validator issue on that key is carried by the gap's lines.
const CODE_KEY = {
  'github-missing': 'github', 'remote-missing': 'remote', 'default-branch-missing': 'defaultBranch', 'setup-missing': 'setup', 'risk-missing': 'risk',
  'repo-not-local': 'source',
};
// Keys nothing here drafts (start's, and the optional spike typecheck override): an invalid one goes back to null, a missing
// one stays missing.
const START_ONLY = new Set(['typecheck', 'setupTimeoutMs', 'typecheckTimeoutMs', 'spikeTypecheck', 'spikeTypecheckTimeoutMs', 'branchNaming', 'notes']);

const templateText = template => `risk: the example template (${template.map(r => r.kind).join(', ')}); edit to [] for none`;

const RISK_RULE = /\.risk\[(\d+)\]/;
const sameName = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const NEW_ENTRY_KEYS = ['name', 'github', 'checkout', 'url', 'remote', 'defaultBranch', 'setup', 'risk'];
const SEARCHED = new Set(['repo-missing', 'trial-dir-unmapped', 'repo-not-local']);
const isOldTrial = (gap, facts) => gap.code === 'trial-dir-unmapped' && facts[gap.repo]?.oldTrial === true;
const OPTIONS = ['clone it yourself', 'add a root with --root <dir>', 'leave its cards out with --cards'];
const pathsOf = list => list.map(c => c.path).join(', ');
const skippedOf = match => (match?.linked?.length ? `skipped, a linked checkout: ${pathsOf(match.linked)}` : null);
const RENAME = 'rename the trial dirs first: scripts/maintenance/rename-trial-dirs.mjs moves them to the configured repo dirs, then draft again';

const USERINFO_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/?#@]+@/i;
// The JSON path of every string holding a URL with credentials; the value itself is never returned.
export function credentialPaths(value, prefix = '') {
  if (typeof value === 'string') return USERINFO_URL.test(value) ? [prefix] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => credentialPaths(v, `${prefix}[${i}]`));
  if (!isObject(value)) return [];
  return Object.entries(value).flatMap(([k, v]) => credentialPaths(v, prefix ? `${prefix}.${k}` : k));
}

// A repo whose dir key or whole entry the config refuses: none of its keys can be repaired one by one.
const brokenRepos = issues => new Set(issues.filter(i => i.field === 'dir' || i.field === 'entry').map(i => i.repo));

// The repos looked for under the checkout roots, in name order: a repo with no entry (an old trial dir name excepted),
// a url-only one, and an entry whose source the config refuses that has no real checkout. Only facts' oldTrial is read.
export function searchTargets({ raw, planning, missingConfig, facts = {} }) {
  const issues = raw === null ? [] : configIssues(raw);
  const broken = brokenRepos(issues);
  const sourceRepairs = issues.filter(i => i.field === 'source' && !broken.has(i.repo) && !planning.repos[i.repo]?.checkout).map(i => i.repo);
  const gaps = missingConfig.filter(g => SEARCHED.has(g.code) && !isOldTrial(g, facts));
  return [...new Set([...gaps.map(g => g.repo), ...sourceRepairs])].sort();
}

// facts: repo -> { match, remote, head, setup, oldTrial }, each shaped like the detection module's answer. The remote,
// head and setup facts are read only when their checkout is in use: the configured one when it is real, else the
// accepted pick. planning is planningConfig(raw): which configured checkouts are real, `~/` expanded, values checked.
// roots: { searched: [absolute paths], from: 'flag' | 'config' | null }. raw is null when there is no config file.
// With no change to propose, merged is null and changes is []: there is nothing to draft, and roots are never stored alone.
export function buildDraft({ raw, planning, missingConfig, slug, facts = {}, roots = { searched: [], from: null }, riskTemplate = null, userHome }) {
  const base = raw ?? EMPTY_BASE;
  let merged = structuredClone(base);
  const replacedRepos = isObject(merged.repos) ? null : { value: merged.repos };
  if (replacedRepos) merged.repos = {};
  const set = (dir, key, value) => { merged.repos[dir][key] = structuredClone(value); };

  // Validator issues grouped by what one line can repair: a repo key, a whole broken repo, or a top-level path.
  const issues = raw === null ? [] : configIssues(raw);
  const broken = brokenRepos(issues);
  const groupOf = i => (i.repo === null ? `\0${i.field === 'projects' ? i.at : i.field}` : `${i.repo}\0${broken.has(i.repo) ? 'broken' : i.field}`);
  const groups = new Map();
  for (const i of issues) groups.set(groupOf(i), [...(groups.get(groupOf(i)) ?? []), i]);
  const consumed = new Set();
  const take = key => {
    consumed.add(key);
    return (groups.get(key) ?? []).map(i => `${i.at}: ${i.message}`);
  };

  // A folder is proposed for one repo only: configured checkouts are claimed first, then gaps in name order.
  const claims = new Map(Object.entries(planning.repos).filter(([, e]) => e.checkout).map(([dir, e]) => [resolve(e.checkout), dir]));
  const accepted = {};
  const refused = {};
  for (const repo of searchTargets({ raw, planning, missingConfig, facts })) {
    const match = facts[repo]?.match;
    if (match?.reason) { refused[repo] = match.reason; continue; }
    if (match?.ambiguous?.length) {
      const several = match.via === 'origin' ? 'several checkouts whose origin is the repo' : `several folders named ${repo}`;
      refused[repo] = [`${several}: ${pathsOf(match.ambiguous)}`, skippedOf(match)].filter(Boolean).join('; ');
      continue;
    }
    if (!match?.pick) continue;
    const owner = claims.get(resolve(match.pick.path));
    if (owner !== undefined && owner !== repo) { refused[repo] = `same checkout as repos.${owner}`; continue; }
    claims.set(resolve(match.pick.path), repo);
    accepted[repo] = match.pick;
  }
  // Says where the repo was looked for, never that the machine lacks it: only these roots were searched.
  const notFound = (repo, path) => {
    const skipped = skippedOf(facts[repo]?.match);
    const where = roots.searched.length ? `not found under ${roots.searched.join(', ')}` : 'not found: no checkout root was searched';
    return { kind: 'not-found', path, roots: [...roots.searched], options: OPTIONS, text: `${where}${skipped ? ` (${skipped})` : ''}; ${OPTIONS.slice(0, -1).join(', ')}, or ${OPTIONS.at(-1)}` };
  };
  // A linked checkout named like the repo is never proposed; beside the folder that is, it is still named.
  const linkedLines = (repo, path) => {
    const skipped = skippedOf(facts[repo]?.match);
    return skipped ? [{ kind: 'skipped', path, paths: facts[repo].match.linked.map(c => c.path), text: `${path}: ${skipped}` }] : [];
  };
  const inUse = repo => Boolean(planning.repos[repo]?.checkout || accepted[repo]);
  const factsOf = repo => (inUse(repo) ? facts[repo] ?? {} : {});
  const needs = [];

  const riskLines = (dir, invalid) => {
    const path = `repos.${dir}.risk`;
    const before = merged.repos[dir].risk;
    if (invalid && Array.isArray(before)) {
      const bad = new Map();
      for (const i of groups.get(`${dir}\0risk`)) {
        const index = Number(i.at.match(RISK_RULE)?.[1]);
        bad.set(index, [...(bad.get(index) ?? []), i.message]);
      }
      const kept = before.filter((_, index) => !bad.has(index));
      set(dir, 'risk', kept);
      return [
        proposed(path, kept, `${path}: keeps the valid rules, ${JSON.stringify(kept)}`),
        ...[...bad].map(([index, why]) => ({ kind: 'dropped', path: `${path}[${index}]`, value: before[index], text: `${path}[${index}]: dropped, ${why.join('; ')}` })),
      ];
    }
    if (!riskTemplate) {
      if (invalid) set(dir, 'risk', null);
      return [unfilled(path, 'the example template could not be read')];
    }
    set(dir, 'risk', riskTemplate);
    return [proposed(path, riskTemplate, templateText(riskTemplate))];
  };

  // invalid: the base value is one the config refuses, so a key the facts cannot fill goes back to null.
  const keyLines = (repo, dir, key, invalid = false) => {
    const path = `repos.${dir}.${key}`;
    if (key === 'risk') return riskLines(dir, invalid);
    if (START_ONLY.has(key)) {
      const before = merged.repos[dir][key];
      set(dir, key, null);
      return [{ kind: 'reset', path, before, value: null, text: `${path}: reset to null, the config refuses its value; the old value stays in the backup` }];
    }
    if (key === 'name') {
      const name = nameFor(repo, dir);
      set(dir, 'name', name);
      return [proposed(path, name)];
    }
    const found = FROM_FACTS[key](factsOf(repo));
    if ('value' in found) {
      set(dir, key, found.value);
      return [proposed(path, found.value)];
    }
    if (invalid) set(dir, key, null);
    if (found.needs) needs.push({ repo, text: found.needs });
    return [unfilled(path, found.reason)];
  };

  // The planner maps a card's repo name to an entry by dir key or name, so a name must not be another gap's name or
  // another entry's key or name. A dir that is not the gap's own name takes the gap's name, so the gap still maps.
  const gapNames = missingConfig.map(g => g.repo);
  const nameFor = (repo, dir) => {
    if (!sameName(repo, dir)) return repo;
    const github = factsOf(repo).remote?.github;
    const checkout = accepted[repo]?.path ?? planning.repos[dir]?.checkout;
    const name = github ? repoPart(github) : checkout ? basename(checkout) : dir;
    const taken = gapNames.some(n => !sameName(n, dir) && sameName(n, name))
      || Object.entries(merged.repos).some(([d, e]) => d !== dir && (sameName(d, name) || sameName(e?.name, name)));
    return taken ? dir : name;
  };

  const projectLines = dir => {
    const list = merged.projects?.[slug]?.repos;
    if (!Array.isArray(list) || list.includes(dir)) return [];
    list.push(dir);
    return [proposed(`projects.${slug}.repos`, [...list])];
  };

  const sourceLines = dir => {
    // A real checkout with a source issue has a url set beside it, whatever its value.
    if (planning.repos[dir]?.checkout) {
      set(dir, 'url', null);
      return [proposed(`repos.${dir}.url`, null, `repos.${dir}.url: null, the checkout is a real folder`)];
    }
    if (refused[dir]) return [unfilled(`repos.${dir}.checkout`, refused[dir])];
    const pick = accepted[dir];
    if (!pick) return [notFound(dir, `repos.${dir}.checkout`)];
    const checkout = tildeOf(pick.path, userHome);
    set(dir, 'checkout', checkout);
    set(dir, 'url', null);
    return [proposed(`repos.${dir}.checkout`, checkout), ...linkedLines(dir, `repos.${dir}.checkout`), proposed(`repos.${dir}.url`, null)];
  };

  // The base slot a gap's name points at, by dir key or entry name, as the planner maps names. Only the base: an entry
  // drafted in this run is not a slot.
  const baseRepos = isObject(base.repos) ? base.repos : {};
  const slotOf = name => Object.keys(baseRepos).find(k => sameName(k, name) || sameName(baseRepos[k]?.name, name));
  const byHand = dir => withIssues([unfilled(`repos.${dir}`, `fix repos.${dir} by hand: its key or its value is not one the config accepts`)], take(`${dir}\0broken`));

  const newEntryLines = repo => {
    const slot = slotOf(repo);
    if (slot !== undefined) return byHand(slot);
    if (refused[repo]) return [unfilled(`repos.${repo}.checkout`, refused[repo])];
    const pick = accepted[repo];
    if (!pick) return [notFound(repo, `repos.${repo}`)];
    const dir = [repo, pick.basename].find(d => REPO_DIR.test(d) && !Object.hasOwn(merged.repos, d));
    if (dir === undefined) return [unfilled(`repos.${repo}`, `neither ${repo} nor ${pick.basename} can be a new repo dir`)];
    merged.repos[dir] = Object.fromEntries(NEW_ENTRY_KEYS.map(key => [key, null]));
    const checkout = tildeOf(pick.path, userHome);
    set(dir, 'checkout', checkout);
    return [
      ...keyLines(repo, dir, 'name'),
      ...keyLines(repo, dir, 'github'),
      proposed(`repos.${dir}.checkout`, checkout),
      ...linkedLines(repo, `repos.${dir}.checkout`),
      proposed(`repos.${dir}.url`, null),
      ...keyLines(repo, dir, 'remote'),
      ...keyLines(repo, dir, 'defaultBranch'),
      ...keyLines(repo, dir, 'setup'),
      ...keyLines(repo, dir, 'risk'),
      ...projectLines(dir),
    ];
  };

  const repairLines = (dir, key) => {
    const invalid = groups.has(`${dir}\0${key}`);
    const issueTexts = take(`${dir}\0${key}`);
    return withIssues(key === 'source' ? sourceLines(dir) : keyLines(dir, dir, key, invalid), issueTexts);
  };

  const linesFor = gap => {
    if (isOldTrial(gap, facts)) return [{ kind: 'rename-trial-dirs', text: RENAME }];
    if (gap.code === 'repo-missing' || gap.code === 'trial-dir-unmapped') return newEntryLines(gap.repo);
    if (gap.code === 'not-in-project') return projectLines(gap.repo);
    return repairLines(gap.repo, CODE_KEY[gap.code]);
  };
  const items = missingConfig.map(gap => ({ ...gap, lines: linesFor(gap) }));

  // Issues no gap carried, in the validator's order, once every gap's entry is in place.
  const fixes = [];
  for (const [key, group] of groups) {
    if (consumed.has(key)) continue;
    const [repo, field] = key.split('\0');
    if (repo) { fixes.push(...(field === 'broken' ? byHand(repo) : repairLines(repo, field))); continue; }
    fixes.push(...withIssues(topLines(field, group), take(key)));
  }

  function topLines(field, group) {
    if (field === 'schemaVersion') {
      if (base.schemaVersion !== undefined) return [unfilled('schemaVersion', 'this CLI writes version 1 only; set it by hand')];
      merged.schemaVersion = 1;
      return [proposed('schemaVersion', 1)];
    }
    if (field === 'checkoutRoots') {
      if (roots.from !== 'flag') return [unfilled('checkoutRoots', 'pass --root <dir> to replace it, or fix it by hand')];
      merged.checkoutRoots = roots.searched.map(root => tildeOf(root, userHome));
      return [proposed('checkoutRoots', merged.checkoutRoots)];
    }
    if (field === 'repos' && replacedRepos) {
      if (!Object.keys(merged.repos).length) {
        if (Object.hasOwn(base, 'repos')) merged.repos = replacedRepos.value;
        else delete merged.repos;
        return [unfilled('repos', 'no repo could be drafted to replace it')]; }
      return [proposed('repos', structuredClone(merged.repos), 'repos: replaced by the drafted entries; the old value stays in the backup')];
    }
    const still = new Set(validateConfig(merged));
    const at = group[0].at;
    if (group.every(i => !still.has(`${i.at}: ${i.message}`))) return [{ kind: 'resolved', path: at, text: `${at}: resolved by the drafted entries` }];
    return [unfilled(at, `fix ${at} by hand: ${group.map(i => i.message).join('; ')}`)];
  }

  for (const path of credentialPaths(merged)) fixes.push(unfilled(path, 'the URL holds credentials; remove them by hand'));
  const stray = (raw === null ? [] : strayKeys(raw)).map(s => ({
    ...s, text: `${s.path}: not a key the config knows${s.suggestion ? `, perhaps ${s.suggestion}` : ''}; it is kept: if this is a typo, delete it in the draft`,
  }));
  if (!changesBetween(base, merged).length) return { merged: null, changes: [], items, fixes, stray, needs };
  if (roots.from === 'flag' && roots.searched.length && base.checkoutRoots === undefined) {
    const value = roots.searched.map(root => tildeOf(root, userHome));
    fixes.push(proposed('checkoutRoots', value, `checkoutRoots: ${JSON.stringify(value)}, stored so later drafts search the same folders`));
    const { schemaVersion, ...rest } = merged;
    merged = raw === null ? { schemaVersion, checkoutRoots: value, ...rest } : { ...merged, checkoutRoots: value };
  }
  return { merged, changes: changesBetween(raw, merged), items, fixes, stray, needs };
}

// The risk rules of the committed example, one per kind in file order: a starting point the user edits, never read from a repo.
export function readRiskTemplate(path) {
  const example = JSON.parse(readFileSync(path, 'utf8'));
  const rules = new Map();
  for (const entry of Object.values(example.repos ?? {})) for (const rule of entry.risk ?? []) if (!rules.has(rule.kind)) rules.set(rule.kind, rule);
  return [...rules.values()];
}

// The one approve rule: a hash only for a text the validator accepts that holds no URL credentials. A null setup,
// github, defaultBranch or risk is valid, so it never withholds the hash; preflight asks for those later.
export function draftState(text, baseBytes) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { valid: false, errors: ['the draft is not valid JSON'], approve: null };
  }
  const errors = [...validateConfig(value), ...credentialPaths(value).map(path => `${path}: a URL holds credentials; remove them`)];
  return errors.length ? { valid: false, errors, approve: null } : { valid: true, errors: [], approve: draftHash(baseBytes, text) };
}

// null marks a home with no config file, so a draft made with none never matches one made over an empty file.
export const draftHash = (baseBytes, draftText) => sha256(canonicalJson({ base: baseBytes === null ? null : sha256(baseBytes), draft: draftText })).slice(0, 12);

function distance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

// The known key a stray one is likely a typo of: the same letters in another case, else the nearest within two edits.
function suggestion(key, known) {
  const lower = key.toLowerCase();
  let best = null;
  let bestDistance = 3;
  for (const k of known) {
    const d = distance(lower, k.toLowerCase());
    if (d < bestDistance) [best, bestDistance] = [k, d];
  }
  return best;
}

// The validator ignores unknown keys, so a typo of a required key only shows as that key missing; these name the typo.
export function strayKeys(raw) {
  const out = [];
  const scan = (value, known, prefix) => {
    for (const key of Object.keys(value)) if (!known.includes(key)) out.push({ path: `${prefix}${key}`, suggestion: suggestion(key, known) });
  };
  scan(raw, TOP_KEYS, '');
  for (const [field, known] of [['repos', REPO_KEYS], ['projects', PROJECT_KEYS]]) {
    if (!isObject(raw[field])) continue;
    for (const [key, entry] of Object.entries(raw[field])) if (isObject(entry)) scan(entry, known, `${field}.${key}.`);
  }
  return out;
}

// scheme://user[:pass]@ becomes scheme://***@. The userinfo stops at a slash, a quote or a space, so text in JSON
// after the URL is never taken in; it runs to the last @ before those, so a password holding @ is masked whole.
// A backslash pair is stepped over: JSON text writes a quote or a backslash inside a value escaped, at any depth.
const USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)(?:\\.|[^\s/"?#\\])+@/gi;
export const redactUrls = text => text.replace(USERINFO, '$1***@');
// A plain text message escapes nothing, so a quote or a backslash in it can be part of a key or list entry it echoes:
// there the userinfo runs to the last @ before a slash or a space.
const USERINFO_TEXT = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]+@/gi;
export const redactText = text => redactUrls(text).replace(USERINFO_TEXT, '$1***@');

// The real path of a file that may not exist yet: its nearest existing parent resolved, the rest appended,
// so /tmp and /private/tmp, or a symlinked folder and its target, compare equal.
function realPathOf(path) {
  const rest = [];
  for (let dir = resolve(path); ; dir = dirname(dir)) {
    try {
      return join(realpathSync(dir), ...rest.reverse());
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
    }
    if (dirname(dir) === dir) return resolve(path);
    rest.push(basename(dir));
  }
}

const isInside = (path, dir) => path === dir || path.startsWith(`${dir}${sep}`);

// A draft is the user's scratch file: never in the spike home (the config and its backup live there), the data dir or a repo.
export function assertDraftPath(path, { home, dataDir }) {
  const real = realPathOf(path);
  const refuse = where => exitError(2, `the draft path ${real} is inside ${where}: put the draft in a scratch folder`);
  if (isInside(real, realPathOf(home))) throw refuse(`the spike home ${home}`);
  if (isInside(real, realPathOf(dataDir))) throw refuse(`the data dir ${dataDir}`);
  const tree = workTreeOf(real);
  if (tree) throw refuse(`the git work tree ${tree}`);
  return real;
}

const sameValue = (a, b) => canonicalJson(a) === canonicalJson(b);

// One line per JSON path added, set or removed, in the after object's key order, removals last at each level.
// Objects are walked; lists and scalars compare whole. A null before is a file that did not exist.
export function changesBetween(before, after, prefix = '') {
  const from = before ?? {};
  const changes = [];
  for (const [key, value] of Object.entries(after)) {
    const path = `${prefix}${key}`;
    if (!Object.hasOwn(from, key)) changes.push({ op: 'add', path, after: value });
    else if (isObject(from[key]) && isObject(value)) changes.push(...changesBetween(from[key], value, `${path}.`));
    else if (!sameValue(from[key], value)) changes.push({ op: 'set', path, before: from[key], after: value });
  }
  for (const [key, value] of Object.entries(from)) if (!Object.hasOwn(after, key)) changes.push({ op: 'remove', path: `${prefix}${key}`, before: value });
  return changes;
}

const linesOf = text => (text === '' ? [] : text.replace(/\n$/, '').split('\n'));

// A longest-common-subsequence diff: '- ' removed, '+ ' added, '  ' context, and '@@' between hunks that do not touch.
export function lineDiff(a, b, { context = 2 } = {}) {
  const x = linesOf(a);
  const y = linesOf(b);
  const lcs = Array.from({ length: x.length + 1 }, () => new Array(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) { ops.push(`  ${x[i]}`); i++; j++; }
    else if (j >= y.length || (i < x.length && lcs[i + 1][j] >= lcs[i][j + 1])) ops.push(`- ${x[i++]}`);
    else ops.push(`+ ${y[j++]}`);
  }
  const changed = ops.flatMap((op, k) => (op.startsWith('  ') ? [] : [k]));
  const shown = new Set(changed.flatMap(k => Array.from({ length: 2 * context + 1 }, (_, d) => k - context + d)));
  const out = [];
  let last = null;
  ops.forEach((op, k) => {
    if (!shown.has(k)) return;
    if (last !== null && k !== last + 1) out.push('@@');
    out.push(op);
    last = k;
  });
  return out;
}

const normalized = text => `${JSON.stringify(JSON.parse(text), null, 2)}\n`;

// The write stores the draft as 2-space JSON, so a base written otherwise is reformatted by it. The diff runs
// from the normalized base, so the reformatting never hides the real changes; reformat says it happens.
export function diffFromBase(baseText, draftText) {
  if (baseText === null) return { reformat: false, diff: lineDiff('', draftText) };
  const base = normalized(baseText);
  return { reformat: base !== baseText, diff: lineDiff(base, draftText) };
}

export function tildeOf(path, userHome) {
  const rel = relative(userHome, path);
  return rel && rel.split(sep)[0] !== '..' && !isAbsolute(rel) ? `~/${rel.split(sep).join('/')}` : path;
}
