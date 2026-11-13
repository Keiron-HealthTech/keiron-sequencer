import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coverage, gapLine, touchedRepos } from '../scripts/lib/respike/coverage.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import { trialRecord, trialStore } from './helpers/trial-store.mjs';

guardNetwork();

const SLUG = 'p1';
const full = (over = {}) => ({
  name: 'example-api', github: 'acme/backend', checkout: '/tmp/x/backend', url: null, remote: 'origin', defaultBranch: 'main', setup: [],
  risk: [{ kind: 'auth', paths: ['src/auth/**'] }], ...over,
});
const config = (repos, projects = { [SLUG]: { repos: Object.keys(repos) } }) => ({ schemaVersion: 1, repos, projects });
const card = (key, over = {}) => ({ key, title: `Card ${key}`, description: '', ...over });
const record = (key, patches = [], repos = []) => ({ card: key, size: repos.length ? { repos } : null, refs: { patches } });

test('touched repos are the union of the cards\' repos, the replay patch dirs and the bases', () => {
  const cfg = config({ 'example-api': full(), 'example-web': full({ name: 'example-web', github: 'acme/frontend' }), auth: full({ name: 'example-auth' }) });
  const touched = touchedRepos(cfg, {
    spike: [{ card: card('CRM-1', { title: 'example-api: do it' }), record: null }, { card: card('CRM-2', { description: 'Repo: `example-auth`' }), record: null }],
    replay: [{ key: 'CRM-3', patches: ['example-web/00003-new.patch', 'example-api/fixup-3-from-4-x.patch'] }],
    bases: [{ dir: 'auth', cards: ['CRM-9'] }],
  });
  assert.deepEqual(touched.repos, [
    { repo: 'auth', configured: true, patchDir: false, cards: ['CRM-2', 'CRM-9'] },
    { repo: 'example-api', configured: true, patchDir: false, cards: ['CRM-1', 'CRM-3'] },
    { repo: 'example-web', configured: true, patchDir: true, cards: ['CRM-3'] },
  ]);
  assert.deepEqual(touched.unknown, []);
});

test('every gap of every touched repo is listed at once with its cards', () => {
  const cfg = config({
    a: full({ name: 'a', github: null }), b: full({ name: 'b', defaultBranch: null }), c: full({ name: 'c', remote: null }),
    d: full({ name: 'd', setup: undefined }), e: full({ name: 'e', risk: undefined }), f: full({ name: 'f' }),
  }, { [SLUG]: { repos: ['a', 'b', 'c', 'd', 'e'] } });
  const spike = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((r, i) => ({ card: card(`CRM-${i + 1}`, { title: `${r}: x` }), record: record(`CRM-${i + 1}`, [], [r]) }));
  const { missingConfig, warnings } = coverage(cfg, SLUG, touchedRepos(cfg, { spike }));
  assert.deepEqual(missingConfig, [
    { code: 'github-missing', repo: 'a', cards: ['CRM-1'] },
    { code: 'default-branch-missing', repo: 'b', cards: ['CRM-2'] },
    { code: 'remote-missing', repo: 'c', cards: ['CRM-3'] },
    { code: 'setup-missing', repo: 'd', cards: ['CRM-4'] },
    { code: 'risk-missing', repo: 'e', cards: ['CRM-5'] },
    { code: 'not-in-project', repo: 'f', cards: ['CRM-6'] },
    { code: 'repo-missing', repo: 'g', cards: ['CRM-7'] },
  ]);
  assert.deepEqual(warnings, []);
});

test('an empty risk list only warns, an empty setup list is silent, and a card naming no repo warns', () => {
  const cfg = config({ a: full({ name: 'a', risk: [], setup: [] }) });
  const { missingConfig, warnings } = coverage(cfg, SLUG, touchedRepos(cfg, { spike: [{ card: card('CRM-1', { title: 'a: x' }), record: null }, { card: card('CRM-2'), record: null }] }));
  assert.deepEqual(missingConfig, []);
  assert.deepEqual(warnings, [{ code: 'risk-empty', repo: 'a', message: 'a has risk: [], so no risk area is derived for it' }, { code: 'repo-unknown', card: 'CRM-2', message: 'CRM-2 names no repo; its trees open as the card goes' }]);
});

test('a touched url-only repo is repo-not-local, listed with the other gaps; an untouched one is no gap', () => {
  const cfg = config({
    web: full({ name: 'web', checkout: null, url: 'https://example.invalid/web.git' }), api: full({ name: 'api', risk: undefined }),
    docs: full({ name: 'docs', checkout: null, url: 'https://example.invalid/docs.git' }),
  });
  const spike = [
    { card: card('CRM-1', { title: 'web: x' }), record: null }, { card: card('CRM-2', { title: 'api: x' }), record: null },
    { card: card('CRM-3', { description: 'Repo: ghost' }), record: null },
  ];
  const { missingConfig } = coverage(cfg, SLUG, touchedRepos(cfg, { spike }));
  assert.deepEqual(missingConfig, [
    { code: 'risk-missing', repo: 'api', cards: ['CRM-2'] },
    { code: 'repo-missing', repo: 'ghost', cards: ['CRM-3'] },
    { code: 'repo-not-local', repo: 'web', cards: ['CRM-1'] },
  ]);
  assert.match(gapLine(missingConfig[2]), /web.*configure `checkout` instead of `url`/);
});

test('a patch dir that maps to no configured repo is trial-dir-unmapped and names the rename migration', () => {
  const cfg = config({ 'example-api': full() });
  const touched = touchedRepos(cfg, {
    spike: [{ card: card('CRM-1'), record: record('CRM-1', ['backend/01182-new.patch']) }],
    replay: [{ key: 'CRM-2', patches: ['backend/01183-new.patch'] }],
  });
  const { missingConfig } = coverage(cfg, SLUG, touched);
  assert.deepEqual(missingConfig, [{ code: 'trial-dir-unmapped', repo: 'backend', cards: ['CRM-1', 'CRM-2'] }]);
  assert.match(gapLine(missingConfig[0]), /rename-trial-dirs/);
});

test('only the cards handed in touch a repo: a stale-unknown card left out adds no gap, a new card handed in does', () => {
  const cfg = config({ web: full({ name: 'web', checkout: null, url: 'https://example.invalid/web.git' }) });
  assert.deepEqual(coverage(cfg, SLUG, touchedRepos(cfg, { spike: [] })).missingConfig, []);
  const added = coverage(cfg, SLUG, touchedRepos(cfg, { spike: [{ card: card('CRM-5', { title: 'web: new' }), record: null }] }));
  assert.deepEqual(added.missingConfig, [{ code: 'repo-not-local', repo: 'web', cards: ['CRM-5'] }]);
});

test('a record still naming a trial dir is trial-dir-unmapped until the trial rename is applied, and maps after it', async () => {
  const cfg = config({ 'example-api': full() });
  const s = trialStore({
    slug: SLUG,
    repos: { backend: 'example-api' },
    config: { schemaVersion: 1, repos: { 'example-api': { name: 'example-api', checkout: '/nowhere', remote: 'origin' } } },
    patches: { 'backend/01182-new.patch': 'x\n' },
    records: [trialRecord('CRM-1', ['backend/01182-new.patch'], SLUG)],
  });
  const gaps = () => coverage(cfg, SLUG, touchedRepos(cfg, { spike: [{ card: card('CRM-1'), record: s.record('CRM-1') }], replay: [] })).missingConfig;
  assert.deepEqual(gaps(), [{ code: 'trial-dir-unmapped', repo: 'backend', cards: ['CRM-1'] }]);
  assert.equal((await s.rename('--apply')).code, 0);
  assert.deepEqual(gaps(), []);
});

test('on an empty config every touched repo is a gap and a title prefix alone names no repo, so its card warns', () => {
  const empty = { schemaVersion: 1, repos: {} };
  const spike = [
    { card: card('CRM-1', { title: 'web: x' }), record: null },
    { card: card('CRM-2', { description: 'Repo: `api`' }), record: null },
    { card: card('CRM-3'), record: record('CRM-3', ['backend/00003-new.patch'], ['api']) },
  ];
  const touched = touchedRepos(empty, { spike, replay: [{ key: 'CRM-4', patches: ['backend/00004-new.patch'] }], bases: [{ dir: 'docs', cards: ['CRM-5'] }] });
  const { missingConfig, warnings } = coverage(empty, SLUG, touched);
  assert.deepEqual(missingConfig, [
    { code: 'repo-missing', repo: 'api', cards: ['CRM-2', 'CRM-3'] },
    { code: 'trial-dir-unmapped', repo: 'backend', cards: ['CRM-3', 'CRM-4'] },
    { code: 'repo-missing', repo: 'docs', cards: ['CRM-5'] },
  ]);
  assert.deepEqual(warnings, [{ code: 'repo-unknown', card: 'CRM-1', message: 'CRM-1 names no repo; its trees open as the card goes' }]);
});

test('a touched repo said to be configured but missing from the config is a repo-missing gap, never read', () => {
  const touched = { repos: [{ repo: 'ghost', configured: true, patchDir: false, cards: ['CRM-1'] }], unknown: [] };
  for (const projects of [undefined, { [SLUG]: { repos: ['ghost'] } }]) {
    assert.deepEqual(coverage({ schemaVersion: 1, repos: {}, projects }, SLUG, touched), {
      missingConfig: [{ code: 'repo-missing', repo: 'ghost', cards: ['CRM-1'] }], warnings: [],
    });
  }
});
