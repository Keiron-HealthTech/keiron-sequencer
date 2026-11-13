import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeProject } from '../scripts/lib/graph.mjs';
import { readRefs } from '../scripts/lib/respike/built.mjs';
import { ancestorsOf, cardStaleness, entryOrder, selectCards } from '../scripts/lib/respike/selection.mjs';
import { gitRunner } from '../scripts/lib/spike/exec.mjs';
import { offProjectFindings } from '../scripts/lib/spike/order.mjs';
import { makeBareOrigin, makeRepo, SANDBOX_ENV } from './helpers/git-sandbox.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import { blocks, issue } from './helpers/spike-fixture.mjs';

guardNetwork();

const done = { state: { name: 'Done', type: 'completed' } };
const analysis = issues => analyzeProject({ issues, milestones: [] });
const MAP = analysis([issue('CRM-1'), issue('CRM-2'), issue('CRM-3'), issue('CRM-4'), issue('CRM-5', done), issue('CRM-6')]);
const keys = sel => sel.cards.map(c => c.key);

test('with no pick and no filter every open execution card is selected, and a built one is dropped', () => {
  const sel = selectCards(MAP, { isBuilt: k => k === 'CRM-4' });
  assert.equal(sel.mode, 'all');
  assert.deepEqual(keys(sel), ['CRM-1', 'CRM-2', 'CRM-3', 'CRM-6']);
  assert.ok(sel.cards.every(c => c.why === 'all'));
  assert.deepEqual(sel.dropped, [{ key: 'CRM-4', reason: 'built' }]);
});

test('picked cards are selected; a picked completed or built card is dropped, never an error; a key not on the map is a usage error', () => {
  const sel = selectCards(MAP, { cards: ['CRM-3', 'CRM-1', 'CRM-5', 'CRM-4'], isBuilt: k => k === 'CRM-4' });
  assert.equal(sel.mode, 'cards');
  assert.deepEqual(sel.cards, [{ key: 'CRM-1', why: 'picked', staleness: null }, { key: 'CRM-3', why: 'picked', staleness: null }]);
  assert.deepEqual(sel.dropped, [{ key: 'CRM-4', reason: 'built' }, { key: 'CRM-5', reason: 'built' }]);
  assert.throws(() => selectCards(MAP, { cards: ['CRM-1', 'CRM-99999'] }), e => e.exitCode === 2 && /CRM-99999/.test(e.message));
});

test('the stale filter selects new and stale cards, lists the unknown ones unselected, and unions with a pick', () => {
  const answers = { 'CRM-1': { why: 'new' }, 'CRM-2': { why: 'stale', staleness: { commits: 2, unchecked: [] } }, 'CRM-3': null, 'CRM-6': { unknown: 'no checkout for web' } };
  const staleOf = k => answers[k] ?? null;
  const stale = selectCards(MAP, { stale: true, isBuilt: k => k === 'CRM-4', staleOf });
  assert.equal(stale.mode, 'stale');
  assert.deepEqual(stale.cards, [
    { key: 'CRM-1', why: 'new', staleness: null }, { key: 'CRM-2', why: 'stale', staleness: { commits: 2, unchecked: [] } },
  ]);
  assert.deepEqual(stale.unknown, [{ key: 'CRM-6', reason: 'no checkout for web' }]);
  const union = selectCards(MAP, { cards: ['CRM-3', 'CRM-2'], stale: true, staleOf });
  assert.equal(union.mode, 'cards+stale');
  assert.deepEqual(union.cards.map(c => [c.key, c.why]), [['CRM-1', 'new'], ['CRM-2', 'picked'], ['CRM-3', 'picked']]);
});

function staleRepo() {
  const repo = makeRepo();
  after(repo.dispose);
  const origin = makeBareOrigin({ from: repo.dir });
  after(origin.dispose);
  repo.git(['remote', 'add', 'origin', origin.dir]);
  const commit = (file, subject) => {
    mkdirSync(join(repo.dir, 'src'), { recursive: true });
    writeFileSync(join(repo.dir, file), `${subject}\n`);
    repo.git(['add', '-A']);
    repo.git(['commit', '-q', '-m', subject]);
  };
  return { repo, origin, commit, fetch: () => { repo.git(['push', '-q', 'origin', 'main']); repo.git(['fetch', '-q', 'origin']); } };
}

const repoConfig = (dir, over = {}) => ({
  schemaVersion: 1, repos: { backend: { name: 'backend-repo', github: 'acme/backend', checkout: dir, url: null, remote: 'origin', defaultBranch: 'main', setup: [], risk: [], ...over } },
});
const liveRecord = (card, paths) => ({ card, spikedAt: '2020-01-01T00:00:00.000Z', size: { repos: ['backend'] }, novelty: { newPaths: paths }, riskAreas: [], refs: { patches: [] } });

test('on real git, a sibling commit after spikedAt makes a card stale; its own-key commit does not; a missing record is new', () => {
  const { repo, commit, fetch } = staleRepo();
  commit('src/a.js', 'touch a for the next card (CRM-2)');
  commit('src/b.js', '[CRM-1] fix b');
  fetch();
  const git = gitRunner({ env: SANDBOX_ENV });
  const config = repoConfig(repo.dir);
  const refsOf = dir => readRefs(git, config.repos[dir]).tracking;
  const at = (key, record) => cardStaleness(git, { config, card: { key, title: `Card ${key}`, description: '' }, record, home: '/nonexistent', slug: 'p1', projectKeys: ['CRM-1', 'CRM-2', 'CRM-3'], refsOf });
  const stale = at('CRM-1', liveRecord('CRM-1', ['src/a.js']));
  assert.equal(stale.why, 'stale');
  assert.equal(stale.staleness.commits, 1);
  assert.equal(at('CRM-1', liveRecord('CRM-1', ['src/b.js'])), null);
  assert.deepEqual(at('CRM-3', null), { why: 'new' });
});

test('on real git, staleness that cannot be computed is unknown with the reason', () => {
  const { repo, commit } = staleRepo();
  commit('src/a.js', 'a (CRM-2)');
  const git = gitRunner({ env: SANDBOX_ENV });
  const at = (config, record) => cardStaleness(git, {
    config, card: { key: 'CRM-1', title: 'Card', description: '' }, record, home: '/nonexistent', slug: 'p1', projectKeys: ['CRM-1'], refsOf: dir => readRefs(git, config.repos[dir]).tracking,
  });
  assert.match(at(repoConfig(repo.dir), liveRecord('CRM-1', ['src/a.js'])).unknown, /origin\/main is not fetched/);
  assert.match(at(repoConfig(repo.dir), liveRecord('CRM-1', [])).unknown, /no patch files and no record paths/);
  assert.match(at(repoConfig(null, { url: 'https://example.invalid/b.git' }), liveRecord('CRM-1', ['src/a.js'])).unknown, /backend has no checkout/);
  assert.match(at(repoConfig(repo.dir), { ...liveRecord('CRM-1', ['src/a.js']), size: null }).unknown, /names no repo/);
});

test('staleness on an empty config, or on an entry with no checkout, remote or default branch, is unknown and runs no git', () => {
  const git = () => { throw new Error('no git call was expected'); };
  const at = config => cardStaleness(git, {
    config, card: { key: 'CRM-1', title: 'backend: x', description: '' }, record: liveRecord('CRM-1', ['src/a.js']), home: '/nonexistent', slug: 'p1',
    projectKeys: ['CRM-1'], refsOf: () => { throw new Error('no refs read was expected'); },
  });
  assert.deepEqual(at({ schemaVersion: 1, repos: {} }), { unknown: 'CRM-1 names no repo with a configured entry' });
  for (const key of ['checkout', 'remote', 'defaultBranch']) {
    const partial = { schemaVersion: 1, repos: { backend: { name: 'backend-repo', checkout: '/src/backend', remote: 'origin', defaultBranch: 'main', [key]: undefined } } };
    assert.deepEqual(at(partial), { unknown: 'backend has no checkout, remote or default branch' }, key);
  }
});

const open = { state: { name: 'In Review', type: 'started' } };
const plan = (issues, selected, { built = [], modes = {} } = {}) => {
  const a = analysis(issues);
  const isBuilt = k => built.includes(k) || a.cards.find(c => c.key === k)?.statusType === 'completed';
  const ancestors = ancestorsOf(a, selected, { isBuilt });
  const mode = k => modes[k] ?? (selected.includes(k) ? 'spike' : 'replay');
  return { ancestors, ...entryOrder(a, [...ancestors, ...selected], { rank: k => (mode(k) === 'replay' ? 0 : 1) }) };
};

test('an unbuilt card above a built one joins the closure and is ordered before the selected card, the built card absent', () => {
  const issues = [issue('CRM-9', { relations: blocks('CRM-5') }), issue('CRM-5', { ...open, relations: blocks('CRM-2') }), issue('CRM-2')];
  assert.deepEqual(plan(issues, ['CRM-2'], { built: ['CRM-5'] }), { ancestors: ['CRM-9'], order: ['CRM-9', 'CRM-2'], cycles: [] });
  assert.deepEqual(plan(issues, ['CRM-2'], { built: ['CRM-5'], modes: { 'CRM-9': 'spike' } }).order, ['CRM-9', 'CRM-2']);
});

test('the walk crosses merged, completed and chained built cards, and walks a diamond once', () => {
  const above = [issue('CRM-7', { relations: blocks('CRM-4') }), issue('CRM-4', { ...done, relations: blocks('CRM-2') }), issue('CRM-2')];
  assert.deepEqual(plan(above, ['CRM-2']), { ancestors: ['CRM-7'], order: ['CRM-7', 'CRM-2'], cycles: [] });
  const chain = [issue('CRM-9', { relations: blocks('CRM-6') }), issue('CRM-6', { relations: blocks('CRM-5') }), issue('CRM-5', { relations: blocks('CRM-2') }), issue('CRM-2')];
  assert.deepEqual(plan(chain, ['CRM-2'], { built: ['CRM-5', 'CRM-6'], modes: { 'CRM-9': 'spike' } }).order, ['CRM-9', 'CRM-2']);
  const diamond = [
    issue('CRM-9', { relations: blocks('CRM-7', 'CRM-8') }), issue('CRM-7', { relations: blocks('CRM-2') }), issue('CRM-8', { relations: blocks('CRM-2') }), issue('CRM-2'),
  ];
  const out = plan(diamond, ['CRM-2']);
  assert.deepEqual(out.ancestors, ['CRM-7', 'CRM-8', 'CRM-9']);
  assert.deepEqual(out.order, ['CRM-9', 'CRM-7', 'CRM-8', 'CRM-2']);
  const outside = [...diamond, issue('CRM-11', { relations: blocks('CRM-12') }), issue('CRM-12')];
  assert.deepEqual(plan(outside, ['CRM-2']).ancestors, ['CRM-7', 'CRM-8', 'CRM-9']);
});

test('a cycle among walked cards, a built one included, that holds a run entry is reported with its members', () => {
  const issues = [issue('CRM-3', { relations: blocks('CRM-4') }), issue('CRM-4', { ...open, relations: blocks('CRM-3', 'CRM-2') }), issue('CRM-2'), issue('CRM-6', { relations: blocks('CRM-7') }), issue('CRM-7', { relations: blocks('CRM-6') })];
  const out = plan(issues, ['CRM-2'], { built: ['CRM-4'] });
  assert.deepEqual(out.cycles, [['CRM-3', 'CRM-4']]);
  assert.deepEqual(out.order, []);
});

test('an open off-project blocker of a selected card stays out of the closure and becomes a risk finding naming it', () => {
  const offMap = { inverseRelations: { nodes: [{ type: 'blocks', issue: { identifier: 'CRM-900', archivedAt: null, state: { type: 'unstarted' } } }] } };
  const a = analysis([issue('CRM-1', { relations: blocks('CRM-2') }), issue('CRM-2', offMap)]);
  const ancestors = ancestorsOf(a, ['CRM-2']);
  assert.deepEqual(ancestors, ['CRM-1']);
  assert.deepEqual(entryOrder(a, [...ancestors, 'CRM-2']).order, ['CRM-1', 'CRM-2']);
  const selected = a.cards.find(c => c.key === 'CRM-2');
  assert.deepEqual(offProjectFindings(selected.offMapBlockers), [{ kind: 'risk', text: 'Blocked by off-project card CRM-900, still open.', ref: 'linear:CRM-900' }]);
});

test('a same-file commit outside the hunks lands in touched, not selected', () => {
  const answers = { 'CRM-1': { touched: { commits: 2, files: ['src/a.js'] } }, 'CRM-2': { why: 'stale', staleness: { commits: 1, unchecked: [] } } };
  const sel = selectCards(MAP, { stale: true, staleOf: k => answers[k] ?? null });
  assert.deepEqual(keys(sel), ['CRM-2']);
  assert.deepEqual(sel.touched, [{ card: 'CRM-1', commits: 2, files: ['src/a.js'] }]);
  assert.deepEqual(selectCards(MAP, { all: true }).cards.map(c => c.why), ['all', 'all', 'all', 'all', 'all']);
  assert.equal(selectCards(MAP, { all: true }).mode, 'all');
});

test('on real git, a commit in the same file but outside the card hunks is touched; one inside them is stale', () => {
  const { repo, fetch } = staleRepo();
  const lines = Array.from({ length: 40 }, (_, i) => `line${i + 1}`);
  const write = edit => writeFileSync(join(repo.dir, 'src', 'list.js'), `${lines.map((l, i) => edit[i + 1] ?? l).join('\n')}\n`);
  write({});
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'base']);
  const base = repo.git(['rev-parse', 'HEAD']).trim();
  write({ 5: 'line5 from the card' });
  const patch = repo.git(['diff', '--src-prefix=a/', '--dst-prefix=b/']);
  repo.git(['checkout', '-q', '--', '.']);
  const home = join(repo.dir, '..', `home-${Date.now()}`);
  const run = join(home, 'p1', 'runs', '20261101T100000Z');
  mkdirSync(join(run, 'patches', 'backend'), { recursive: true });
  writeFileSync(join(run, 'patches', 'backend', '00001-new.patch'), patch);
  writeFileSync(join(run, 'run.json'), JSON.stringify({ repos: { backend: { baseCommit: base, log: [{ name: '00001-new', tree: base, stat: '' }] } } }));
  const record = { ...liveRecord('CRM-1', []), spikedAt: '2000-01-01T00:00:00.000Z', refs: { patches: ['backend/00001-new.patch'], runId: '20261101T100000Z' } };
  const git = gitRunner({ env: SANDBOX_ENV });
  const config = repoConfig(repo.dir);
  const at = () => cardStaleness(git, { config, card: { key: 'CRM-1', title: 'Card', description: '' }, record, home, slug: 'p1', projectKeys: ['CRM-1', 'CRM-2'], refsOf: dir => readRefs(git, config.repos[dir]).tracking });
  write({ 30: 'line30 elsewhere (CRM-2)' });
  repo.git(['commit', '-q', '-am', 'elsewhere (CRM-2)']);
  fetch();
  assert.deepEqual(at(), { touched: { commits: 2, files: ['src/list.js'] } });
  write({ 6: 'line6 next to the card (CRM-2)' });
  repo.git(['commit', '-q', '-am', 'near (CRM-2)']);
  fetch();
  assert.equal(at().why, 'stale');
});
