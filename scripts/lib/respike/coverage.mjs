import { cardRepos, mapRepo } from '../start/checkout.mjs';

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const cardNumber = key => Number(String(key).match(/(\d+)$/)?.[1] ?? 0);
const byCard = (a, b) => cardNumber(a) - cardNumber(b) || compare(a, b);
const isSet = v => v !== null && v !== undefined;

// spike: entries opened as cards, by their own repos; replay: patch dirs; bases: repos a needed built branch puts in play.
export function touchedRepos(config, { spike = [], replay = [], bases = [] }) {
  const found = new Map();
  const touch = (repo, configured, viaPatch, key) => {
    const at = found.get(repo) ?? { repo, configured, patchDir: true, cards: new Set() };
    at.patchDir &&= viaPatch;
    at.cards.add(key);
    found.set(repo, at);
  };
  const unknown = [];
  for (const { card, record } of spike) {
    const repos = cardRepos(card, record, record?.refs?.patches, config);
    if (!repos.length) unknown.push(card.key);
    for (const r of repos) touch(r.dir ?? r.name, Boolean(r.dir), r.source === 'patches', card.key);
  }
  for (const { key, patches } of replay) {
    for (const p of patches) {
      const dir = p.split('/')[0];
      const mapped = mapRepo(config, dir)?.dir;
      touch(mapped ?? dir, Boolean(mapped), true, key);
    }
  }
  for (const { dir, cards } of bases) for (const key of cards) touch(dir, Boolean(config.repos[dir]), false, key);
  const repos = [...found.values()].sort((a, b) => compare(a.repo, b.repo)).map(r => ({ ...r, cards: [...r.cards].sort(byCard) }));
  return { repos, unknown: unknown.sort(byCard) };
}

const CHECKS = [
  ['repo-not-local', repo => !repo.checkout],
  ['github-missing', repo => !repo.github],
  ['default-branch-missing', repo => !repo.defaultBranch],
  ['remote-missing', repo => !repo.remote],
  ['setup-missing', repo => !isSet(repo.setup)],
  ['risk-missing', repo => !isSet(repo.risk)],
];

export function coverage(config, slug, { repos, unknown }) {
  const missingConfig = [];
  const warnings = [];
  const allowed = config.projects?.[slug]?.repos ?? null;
  for (const { repo, configured, patchDir, cards } of repos) {
    if (!configured) { missingConfig.push({ code: patchDir ? 'trial-dir-unmapped' : 'repo-missing', repo, cards }); continue; }
    const entry = config.repos[repo];
    if (!entry) { missingConfig.push({ code: 'repo-missing', repo, cards }); continue; }
    for (const [code, missing] of CHECKS) if (missing(entry)) missingConfig.push({ code, repo, cards });
    if (allowed && !allowed.includes(repo)) missingConfig.push({ code: 'not-in-project', repo, cards });
    if (Array.isArray(entry.risk) && !entry.risk.length) warnings.push({ code: 'risk-empty', repo, message: `${repo} has risk: [], so no risk area is derived for it` });
  }
  for (const card of unknown) warnings.push({ code: 'repo-unknown', card, message: `${card} names no repo; its trees open as the card goes` });
  return { missingConfig, warnings };
}

const HINTS = {
  'repo-missing': g => `add repos.${g.repo} to the spike config`,
  'trial-dir-unmapped': () => 'run scripts/maintenance/rename-trial-dirs.mjs to rename the trial folders to the configured repo dirs',
  'repo-not-local': () => 'a respike opens trees only in local checkouts: configure `checkout` instead of `url`',
  'github-missing': () => 'set github to <owner>/<repo>',
  'default-branch-missing': () => 'set defaultBranch',
  'remote-missing': () => 'set remote',
  'setup-missing': () => 'set setup ([] for none)',
  'risk-missing': () => 'set risk ([] for none)',
  'not-in-project': g => `list ${g.repo} in the project's repos`,
};

export const gapLine = g => `${g.repo}: ${g.code}, needed by ${g.cards.join(', ')}; ${HINTS[g.code](g)}`;
