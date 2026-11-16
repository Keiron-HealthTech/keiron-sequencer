import { ghLookup, parsePullUrl, uniquePrs } from '../start/checkout.mjs';

const BATCH = 20;
const ID = '[A-Z][A-Z0-9]*-\\d+';
// One bracket may name several cards: [CRM-1][CRM-2], (CRM-1, CRM-2), [CRM-3/CRM-4]. Case-insensitive, as start's titleTag.
const TAGS = new RegExp(`[[(]\\s*(${ID}(?:\\s*(?:,|/|&|\\s)\\s*${ID})*)\\s*[\\])]`, 'gi');
const tagged = title => [...String(title ?? '').matchAll(TAGS)].flatMap(m => m[1].match(new RegExp(ID, 'gi')).map(k => k.toUpperCase()));

const batches = keys => Array.from({ length: Math.ceil(keys.length / BATCH) }, (_, i) => keys.slice(i * BATCH, (i + 1) * BATCH));
const sameRepo = (a, b) => a.toLowerCase() === b.toLowerCase();

// Calls are per repo, never per card: one open listing, then merged and off-map ids in batches of 20.
export function pullRequests(gh, { repos, keys, offMapKeys, attachments, known }) {
  const look = ghLookup(gh, known);
  const failed = new Map();
  const failedFor = new Map();
  const listed = [];
  const fail = (github, message) => { if (!failed.has(github.toLowerCase())) failed.set(github.toLowerCase(), message); };
  // A listing that fills its limit may have cut the PR that decides, so it counts as a failed read.
  const read = (github, state, limit, search, via) => {
    const before = look.failures.length;
    const prs = look.list(github, ['--state', state, '--limit', String(limit), ...(search ? ['--search', search] : [])], via);
    if (look.failures.length > before) fail(github, look.failures.slice(before).join('; '));
    else if (prs.length >= limit) fail(github, `gh pr list --repo ${github} --state ${state} returned its limit of ${limit} PRs: results may be cut`);
    listed.push(...prs);
  };
  // Unquoted, GitHub splits CRM-12 into words and matches far more than the tag.
  const query = batch => `${batch.map(k => `"${k}"`).join(' OR ')} in:title`;
  for (const { github } of repos.filter(r => r.github)) {
    read(github, 'open', 1000, null, 'open');
    for (const batch of batches([...new Set(keys)])) read(github, 'merged', 200, query(batch), 'search');
  }
  for (const { github } of known.filter(r => r.github)) {
    for (const batch of batches([...new Set(offMapKeys)])) read(github, 'all', 200, query(batch), 'search');
  }
  const byKey = new Map();
  const file = (key, pr) => byKey.set(key, uniquePrs([...(byKey.get(key) ?? []), pr]));
  for (const pr of uniquePrs(listed)) for (const key of new Set(tagged(pr.title))) file(key, pr);
  for (const [key, urls] of attachments) {
    for (const url of urls) {
      const ref = parsePullUrl(url);
      if (!ref) continue;
      const known = listed.find(p => sameRepo(p.github, ref.github) && p.number === ref.number);
      if (known) { file(key, known); continue; }
      const before = look.failures.length;
      for (const p of look.view(url, 'attachment')) file(key, p);
      if (look.failures.length > before) failedFor.set(key, look.failures.slice(before).join('; '));
    }
  }
  return { byKey, failed, failedFor };
}
