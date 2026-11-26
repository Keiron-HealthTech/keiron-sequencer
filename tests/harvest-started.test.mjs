import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../scripts/harvest.mjs';
import { caseSource, computePlan, renderNotesBlock, renderReview, validateHarvest } from '../scripts/lib/harvest.mjs';
import { serializeRecord } from '../scripts/lib/record.mjs';
import { fakeGit, fakeGitHub } from './helpers/fake-git.mjs';
import { fakeLinearStore, FIXTURE_SLUG as SLUG } from './helpers/fake-linear.mjs';
import { guardNetwork } from './helpers/no-network.mjs';

guardNetwork();

// A project-wide harvest meant for one unstarted card (CRM-21) must leave the started ones alone: CRM-20 is in review with
// its notes fixed by hand to match what shipped. Made-up keys and text.
const kase = id => ({ id, given: `dado ${id}`, when: `cuando ${id}`, then: `entonces ${id}`, source: 'patch', ref: 'patch:a/b.patch' });
const rec = card => ({ card, cases: [kase('c1'), kase('c2')], decisions: [], openDecisions: [], archived: null, supersededBy: null });
const NOTES = { schemaVersion: 1, cards: Object.fromEntries(['CRM-20', 'CRM-21'].map(card => [card, Object.fromEntries(rec(card).cases.map(c => [c.id, { source: caseSource(c), es: `Caso ${card} ${c.id}.` }]))])) };
const HAND_FIXED = 'Texto.\n\n+++ Notas del agente\n\n**Casos de aceptación**\n\n- **c1.** Corregido a mano.\n\n+++';
const STARTED = new Map([['CRM-20', 'PR #77 open in acme/app']]);

const issue = (identifier, over = {}) => ({
  id: `uuid-${identifier}`, identifier, title: `Card ${identifier}`, url: `u/${identifier}`, estimate: null, archivedAt: null,
  state: { name: 'Backlog', type: 'backlog' }, projectMilestone: null, labels: { nodes: [] }, ...over,
});

function world(descriptions = {}) {
  const issues = ['CRM-20', 'CRM-21'].map(k => ({ ...issue(k), relations: { nodes: [] }, inverseRelations: { nodes: [] } }));
  return {
    raw: { project: { id: 'p', slug: SLUG, name: 'P', url: 'u', teams: [{ id: 't', key: 'CRM' }] }, issues, milestones: [], warnings: [] },
    descriptions: new Map(issues.map(i => [i.identifier, { id: i.id, title: i.title, description: descriptions[i.identifier] ?? 'Texto.', archivedAt: null }])),
  };
}

const plan = (harvest, { started = STARTED, descriptions = { 'CRM-20': HAND_FIXED } } = {}) => computePlan({
  harvest: { schemaVersion: 1, project: { slug: SLUG }, ...harvest }, records: [rec('CRM-20'), rec('CRM-21')], notes: NOTES,
  ...world(descriptions), started,
});

test('a started card in notes gets no notes op, and the review lists it as not written with the size of the change', () => {
  const r = plan({ notes: 'all' });
  assert.deepEqual(r.refusals, []);
  assert.deepEqual(r.plan.ops.map(op => op.id), ['notes:CRM-21']);
  assert.deepEqual(r.plan.notWritten, [{ id: 'notes:CRM-20', card: 'CRM-20', started: 'PR #77 open in acme/app', added: 2, removed: 1 }]);
  const md = renderReview(r.plan, { approveCommand: 'apply' });
  assert.match(md, /## Not written: card started\n\n- notes:CRM-20 \(PR #77 open in acme\/app\): \+2 −1 lines; name it in writeStarted to write it/);
});

test('a started card whose block already matches is not listed', () => {
  const current = `Texto.\n\n${renderNotesBlock(rec('CRM-20'), NOTES.cards['CRM-20'])}`;
  assert.deepEqual(plan({ notes: 'all' }, { descriptions: { 'CRM-20': current } }).plan.notWritten, []);
});

test('order lines and ship-after lines never reach a started card either; the relation itself is still written', () => {
  const r = plan({
    rejected: [{ from: 'CRM-20', to: 'CRM-21', reason: 'no shared code', order: 'Si CRM-20 llega primero, nada cambia.' }],
    edges: [{ from: 'CRM-21', to: 'CRM-20', kind: 'deploy', evidence: 'ships first' }],
  });
  assert.deepEqual(r.refusals, []);
  assert.deepEqual(r.plan.ops.map(op => op.id), ['rel+:CRM-21>CRM-20', 'notes:CRM-21']);
  assert.deepEqual(r.plan.notWritten.map(n => n.id), ['notes:CRM-20']);
});

test('a description entry for a started card is not written either', () => {
  const r = plan({ descriptions: { 'CRM-20': { text: 'Nuevo texto.', evidence: 'audit' } } });
  assert.deepEqual(r.plan.ops, []);
  assert.deepEqual(r.plan.notWritten.map(n => n.id), ['description:CRM-20']);
});

test('writeStarted names a started card whose notes and description are written anyway, marked started in the review', () => {
  const r = plan({ notes: 'all', writeStarted: ['CRM-20'], descriptions: { 'CRM-20': { text: 'Nuevo texto.', evidence: 'audit' } } });
  assert.deepEqual(r.refusals, []);
  assert.deepEqual(r.plan.ops.map(op => [op.id, op.started ?? null]), [['notes:CRM-21', null], ['description:CRM-20', 'PR #77 open in acme/app']]);
  assert.deepEqual(r.plan.notWritten, []);
  const md = renderReview(r.plan, { approveCommand: 'apply' });
  assert.match(md, /### CRM-20: replace the description \(started: PR #77 open in acme\/app; writeStarted\)/);
  const notes = plan({ notes: 'all', writeStarted: ['CRM-20'] });
  assert.match(renderReview(notes.plan, { approveCommand: 'apply' }), /### CRM-20: replace the block \(started: PR #77 open in acme\/app; writeStarted\)/);
});

test('writeStarted is a list of distinct card keys', () => {
  const base = { schemaVersion: 1, project: { slug: SLUG } };
  assert.deepEqual(validateHarvest({ ...base, writeStarted: ['CRM-20'] }), []);
  for (const bad of ['CRM-20', ['crm-20'], ['CRM-20', 'CRM-20']]) {
    assert.deepEqual(validateHarvest({ ...base, writeStarted: bad }), ['writeStarted must be a list of distinct card keys']);
  }
});

// ---------- the CLI decides which cards started from Linear, GitHub PRs and pushed branches ----------

const TMP = mkdtempSync(join(tmpdir(), 'keiron-sequencer-harvest-started-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const KEY = 'lin_api_dummy_' + 's'.repeat(30);

const fullRecord = card => ({
  schemaVersion: 1, card, title: `Card ${card}`, project: { slug: SLUG, name: 'P' }, origin: 'thin-spike', spikedAt: '2026-11-01T10:00:00.000Z',
  scope: { complete: true, note: null }, size: { prodLines: 3, testLines: 1, files: 1, repos: ['app-repo'], sharedWith: [], deletionWeight: 0.25 },
  effort: null, fixups: { received: [], caused: [] }, cases: rec(card).cases, decisions: [], findings: [], openDecisions: [],
  riskAreas: [], novelty: { newPaths: [] }, refs: { engram: [], patches: [], linear: null },
});
const CARDS = ['CRM-1', 'CRM-2', 'CRM-3', 'CRM-4'];
const CLI_NOTES = { schemaVersion: 1, cards: Object.fromEntries(CARDS.map(card => [card, Object.fromEntries(rec(card).cases.map(c => [c.id, { source: caseSource(c), es: `Caso ${c.id}.` }]))])) };
const CONFIG = {
  schemaVersion: 1,
  repos: { app: { name: 'app-repo', github: 'acme/app', checkout: '/src/app', url: null, remote: 'origin', defaultBranch: 'main', branchNaming: 'verbatim', setup: [['npm', 'ci']], risk: [] } },
  projects: { [SLUG]: { repos: ['app'] } },
};

let n = 0;
function home({ config = true } = {}) {
  const dir = join(TMP, `home-${++n}`);
  mkdirSync(join(dir, SLUG, 'harvest'), { recursive: true });
  for (const card of CARDS) writeFileSync(join(dir, SLUG, `${card}.json`), serializeRecord(fullRecord(card)));
  writeFileSync(join(dir, SLUG, 'harvest', 'harvest.json'), JSON.stringify({ schemaVersion: 1, project: { slug: SLUG }, notes: 'all' }));
  writeFileSync(join(dir, SLUG, 'harvest', 'notes.es.json'), JSON.stringify(CLI_NOTES));
  if (config) writeFileSync(join(dir, 'config.json'), JSON.stringify(CONFIG));
  return dir;
}

const linear = () => fakeLinearStore({
  issues: [
    issue('CRM-1', { state: { name: 'In Review', type: 'started' } }),
    issue('CRM-2', { state: { name: 'Todo', type: 'unstarted' } }),
    issue('CRM-3', { state: { name: 'Todo', type: 'unstarted' } }),
    issue('CRM-4', { state: { name: 'Todo', type: 'unstarted' } }),
  ],
});
const PR = { number: 9, state: 'OPEN', isDraft: false, mergedAt: null, baseRefName: 'main', headRefName: 'user/crm-2-x', headRefOid: 'b'.repeat(40), isCrossRepository: false, title: '[CRM-2] x', url: 'https://github.com/acme/app/pull/9' };

test('the plan reads a card as started from its Linear state, an open or merged PR, or a pushed branch, and writes notes only for the rest', async () => {
  const dir = home();
  const gh = fakeGitHub(argv => (argv[1] === 'list' ? JSON.stringify([PR]) : undefined));
  const git = fakeGit({ 'ls-remote': `${'c'.repeat(40)}\trefs/heads/main\n${'d'.repeat(40)}\trefs/heads/user/crm-3-wip\n` });
  const r = await run(['plan', SLUG], { env: { LINEAR_API_KEY: KEY }, keyFile: join(dir, 'none'), now: () => new Date(), fetchImpl: linear().fetchImpl, dataDir: dir, gh: gh.run, git: git.run });
  assert.equal(r.code, 0, r.stderr);
  const p = JSON.parse(readFileSync(join(dir, SLUG, 'harvest', 'plan.json'), 'utf8'));
  assert.deepEqual(p.ops.map(op => op.id), ['notes:CRM-4']);
  assert.deepEqual(p.notWritten.map(x => [x.card, x.started]), [
    ['CRM-1', 'Linear says In Review'], ['CRM-2', 'PR #9 open in acme/app'], ['CRM-3', 'branch user/crm-3-wip pushed to app-repo'],
  ]);
  assert.equal(r.stdout.includes(KEY), false);
});

test('a GitHub read that fails leaves each card Linear calls unstarted unwritten, and says why', async () => {
  const dir = home();
  const gh = fakeGitHub(() => ({ status: 1, stdout: '', stderr: 'offline' }));
  const git = fakeGit({ 'ls-remote': '' });
  const r = await run(['plan', SLUG], { env: { LINEAR_API_KEY: KEY }, keyFile: join(dir, 'none'), now: () => new Date(), fetchImpl: linear().fetchImpl, dataDir: dir, gh: gh.run, git: git.run });
  assert.equal(r.code, 0, r.stderr);
  const p = JSON.parse(readFileSync(join(dir, SLUG, 'harvest', 'plan.json'), 'utf8'));
  assert.deepEqual(p.ops, []);
  assert.match(p.notWritten.find(x => x.card === 'CRM-2').started, /GitHub could not be read: .*offline/);
});

test('with no spike config, only the Linear states decide, and the plan warns that GitHub was not read', async () => {
  const dir = home({ config: false });
  const r = await run(['plan', SLUG], { env: { LINEAR_API_KEY: KEY }, keyFile: join(dir, 'none'), now: () => new Date(), fetchImpl: linear().fetchImpl, dataDir: dir });
  assert.equal(r.code, 0, r.stderr);
  const p = JSON.parse(readFileSync(join(dir, SLUG, 'harvest', 'plan.json'), 'utf8'));
  assert.deepEqual(p.ops.map(op => op.id), ['notes:CRM-2', 'notes:CRM-3', 'notes:CRM-4']);
  assert.ok(p.warnings.some(w => w.kind === 'github-unread'), JSON.stringify(p.warnings));
});
