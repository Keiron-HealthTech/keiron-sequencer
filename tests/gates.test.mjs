import { test } from 'node:test';
import assert from 'node:assert/strict';
import { caseSource, computePlan, renderNotesBlock, textSource } from '../scripts/lib/harvest.mjs';
import { classify } from '../scripts/lib/next/free.mjs';
import { markers } from '../scripts/lib/next/text.mjs';
import { draftPack } from '../scripts/lib/packs.mjs';
import { OPEN_DECISION_IMPACTS, validateRecord } from '../scripts/lib/record.mjs';
import { verdict } from '../scripts/lib/records.mjs';
import { buildBrief } from '../scripts/lib/start/brief.mjs';
import { routeFor } from '../scripts/lib/start/route.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import { CARD, fakeStartFixture, GIT_BRANCH_NAME, startIssue, startRecord } from './helpers/start-fixture.mjs';

guardNetwork();

// The shape of a small backend card (made-up keys and text): CRM-94 is three production lines in the app repo. Its one open
// decision is who owns a caller of the route before the check is enforced: a rollout precondition, not a design question.
// CRM-29, in the web repo with an open PR, blocks it in Linear only because it has to ship first.
const GATE_TEXT = 'Who owns the script that calls GET /items/:id, and does it get read access or move off the route, before the check is enforced?';
const gateDecision = { text: GATE_TEXT, impact: 'gate', status: 'open', owner: 'people' };
const designDecision = { text: 'Whether the check lives in a guard or in the service.', impact: 'design', status: 'open', owner: 'people' };

const record = (open = [gateDecision]) => startRecord(CARD, {
  size: { prodLines: 3, testLines: 9, files: 2, repos: ['app-repo'], sharedWith: [], deletionWeight: 0.25 },
  openDecisions: open,
  novelty: { newPaths: [] },
});

// ---------- item 20: a gate open decision ----------

test('an open decision can be tagged gate, next to design and detail', () => {
  assert.deepEqual(OPEN_DECISION_IMPACTS, ['design', 'detail', 'gate']);
  assert.deepEqual(validateRecord(record()), []);
});

test('a gate never makes the verdict SDD; a design decision still does', () => {
  assert.equal(verdict(record([gateDecision]), 'S'), 'No SDD');
  assert.equal(verdict(record([gateDecision, designDecision]), 'S'), 'SDD');
});

test('a gate is no people decision for the route', () => {
  const verdictOf = { value: 'No SDD', tier: 'S', label: 'S · 12 lines' };
  const route = routeFor({ verdict: verdictOf, record: record([gateDecision]), siblings: { dependents: [] } }, GIT_BRANCH_NAME);
  assert.equal(route.route, 'tdd');
  assert.ok(route.reasons.includes('people-decisions:0'), route.reasons.join(' '));
});

test('a gate is never a question of the decision pack', () => {
  const pack = draftPack(record([gateDecision, designDecision]), { description: 'x' });
  assert.deepEqual(pack.questions.map(q => q.text), [designDecision.text]);
});

test('the start brief lists each gate as a condition to clear before merging or deploying', () => {
  const brief = buildBrief({ record: record([gateDecision, designDecision]) });
  assert.deepEqual(brief.gates, [{ kind: 'decision', text: GATE_TEXT }]);
  assert.deepEqual(buildBrief({ record: null, recordNote: 'no record' }).gates, []);
});

test('the harvest notes mark a gate in the open decisions section', () => {
  const r = { card: CARD, cases: record().cases, decisions: [], openDecisions: [gateDecision, { ...gateDecision, owner: 'code', status: 'narrowed' }] };
  const notes = {
    c1: { source: caseSource(r.cases[0]), es: 'Caso.' },
    o1: { source: textSource(gateDecision), es: 'Quién es dueño del script.' },
    o2: { source: textSource(gateDecision), es: 'Quién es dueño del script.' },
  };
  const block = renderNotesBlock(r, notes);
  assert.ok(block.includes('- **o1.** Quién es dueño del script. (antes de mergear o desplegar, la deciden personas)'), block);
  assert.ok(block.includes('- **o2.** Quién es dueño del script. (acotada, antes de mergear o desplegar)'), block);
});

// ---------- item 21: the edge kind decides whether a card can be built ----------

test('"Sale después de" names the cards a card only ships after, in every form Linear writes a mention', () => {
  assert.deepEqual(markers('Sale después de CRM-29.').after, ['CRM-29']);
  assert.deepEqual(markers('sale después de CRM-29 y CRM-31').after, ['CRM-29', 'CRM-31']);
  assert.deepEqual(markers('Sale después de [CRM-29](https://linear.app/x/issue/CRM-29/web)').after, ['CRM-29']);
  assert.deepEqual(markers('- **CRM-29.** Sale después de CRM-29: no necesita su código.').after, ['CRM-29']);
  assert.deepEqual(markers('No sale después de CRM-29.').after, []);
  assert.deepEqual(markers('Depende de CRM-29.').after, []);
});

const SHA = 'a'.repeat(40);
const repo = (name, github, checkout) => ({ name, github, checkout, url: null, remote: 'origin', defaultBranch: 'main', setup: [], risk: [] });
const CONFIG = { schemaVersion: 1, repos: { app: repo('app-repo', 'acme/app', '/src/app'), web: repo('web-repo', 'acme/web', '/src/web') } };
const card = (key, over = {}) => ({
  key, title: `app-repo: Card ${key}`, url: `https://linear.app/x/issue/${key}`, status: 'Todo', statusType: 'unstarted',
  milestone: 'M1', milestoneOrder: 1, milestoneTargetDate: null, dueDate: null, estimate: null, assignee: null, labels: [],
  attachments: [], size: null, downstream: 0, offMapBlockers: [], rank: Number(key.split('-')[1]), due: null, deadline: 'overdue',
  deadlineFrom: 'card', ...over,
});
const pr = (n, over = {}) => ({
  repoDir: 'app', github: 'acme/app', number: n, state: 'OPEN', isDraft: false, mergedAt: null, baseRefName: 'main',
  headRefName: `crm-${n}-x`, title: `[CRM-${n}] x`, url: `https://github.com/acme/app/pull/${n}`, via: 'open', ...over,
});
const work = () => ({
  repos: new Map(['app', 'web'].map(dir => [dir, {
    path: `/src/${dir}`, contains: () => null, heads: { main: SHA },
    checkout: { branches: { local: ['main'], remote: ['main'] }, tracking: { main: SHA } },
  }])),
  local: [],
  failed: new Map(),
});
const BLOCKED = card('CRM-94');
const BLOCKER = card('CRM-29', { title: 'web-repo: Card CRM-29', status: 'In Review', statusType: 'started', rank: 29, deadline: null, deadlineFrom: null });
const classifyWith = ({ description, blockerPr = pr(29, { repoDir: 'web', github: 'acme/web', url: 'https://github.com/acme/web/pull/29' }), decisionGates } = {}) => classify({
  cards: [BLOCKER, BLOCKED], edges: [{ from: 'CRM-29', to: 'CRM-94' }], offMap: new Map(),
  descriptions: new Map([['CRM-94', description ?? 'Haz el chequeo.'], ['CRM-29', 'Esta tarjeta va antes.']]), viewer: { id: 'me', name: 'Me' },
  prs: { byKey: new Map([['CRM-29', [blockerPr]]]), failed: new Map(), failedFor: new Map() }, work: work(), config: CONFIG,
  ...(decisionGates ? { decisionGates } : {}),
});

test('a plain blocks relation to an open PR in another repo still waits: with no marker it is a code dependency', () => {
  const out = classifyWith();
  assert.deepEqual(out.free.map(f => f.key), []);
  assert.deepEqual(out.overdue.map(o => [o.key, o.reason]), [['CRM-94', 'blocked']]);
});

test('a blocker the card only ships after never blocks it: it is free from the default branch, with the gate', () => {
  const out = classifyWith({ description: 'Haz el chequeo.\n\nSale después de CRM-29.' });
  assert.deepEqual(out.free.map(f => f.key), ['CRM-94']);
  const [free] = out.free;
  assert.deepEqual(free.base, { kind: 'default', ref: 'origin/main', pr: null, costs: [] });
  assert.deepEqual(free.gates, [{ kind: 'card', card: 'CRM-29', text: 'do not merge or deploy before CRM-29 is merged' }]);
});

test('a ship-after blocker in the same repo is not stacked on either', () => {
  const out = classifyWith({ description: 'Sale después de CRM-29.', blockerPr: pr(29) });
  assert.equal(out.free[0].base.kind, 'default');
  assert.equal(out.free[0].gates[0].card, 'CRM-29');
});

test('a merged ship-after blocker leaves no gate, and the record\'s gate decisions are listed with the card gates', () => {
  const merged = pr(29, { state: 'MERGED', mergedAt: '2026-11-20T00:00:00Z' });
  const out = classifyWith({ description: 'Sale después de CRM-29.', blockerPr: merged, decisionGates: new Map([['CRM-94', [GATE_TEXT]]]) });
  assert.deepEqual(out.free[0].gates, [{ kind: 'decision', text: GATE_TEXT }]);
});

test('start bases a card on the default branch past a ship-after blocker, and carries the gate in the plan and the brief', async t => {
  const blocker = startIssue('ABC-2', { state: { name: 'In Progress', type: 'started' }, relations: { nodes: [{ type: 'blocks', relatedIssue: { identifier: CARD } }] } });
  const f = fakeStartFixture({
    issues: [startIssue(CARD, { gitBranchName: GIT_BRANCH_NAME, description: 'Do ABC-1.\n\nSale después de ABC-2.' }), blocker],
    records: [record([gateDecision])],
    gh: argv => (argv.includes('--search') && argv[argv.indexOf('--search') + 1] === 'ABC-2'
      ? JSON.stringify([{ number: 2, state: 'OPEN', isDraft: false, mergedAt: null, baseRefName: 'main', headRefName: 'user/abc-2-x', title: '[ABC-2] x', url: 'https://github.com/acme/app/pull/2' }])
      : '[]'),
  });
  t.after(f.dispose);
  const r = await f.run(['plan', CARD]);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual([out.action, out.base.kind, out.base.ref], ['create', 'default', 'origin/main']);
  assert.deepEqual(out.blockers, []);
  assert.deepEqual(out.gates, [
    { kind: 'card', card: 'ABC-2', text: 'do not merge or deploy before ABC-2 is merged', state: { name: 'In Progress', type: 'started' } },
    { kind: 'decision', text: GATE_TEXT },
  ]);
  assert.deepEqual(out.brief.gates, out.gates);
});

// ---------- harvest writes the marker for its deploy and gate edges ----------

const issue = (identifier, over = {}) => ({
  id: `uuid-${identifier}`, identifier, title: `Card ${identifier}`, url: `u/${identifier}`, estimate: null, archivedAt: null,
  state: { name: 'Backlog', type: 'backlog' }, projectMilestone: null, labels: { nodes: [] }, ...over,
});

function world(live = []) {
  const issues = ['CRM-29', 'CRM-94'].map(k => ({ ...issue(k), relations: { nodes: [] }, inverseRelations: { nodes: [] } }));
  const byKey = new Map(issues.map(i => [i.identifier, i]));
  live.forEach(([from, to], n) => {
    byKey.get(from).relations.nodes.push({ id: `r${n}`, type: 'blocks', relatedIssue: { identifier: to, archivedAt: null, state: { type: 'backlog' } } });
    byKey.get(to).inverseRelations.nodes.push({ id: `r${n}`, type: 'blocks', issue: { identifier: from, archivedAt: null, state: { type: 'backlog' } } });
  });
  return {
    raw: { project: { id: 'p', slug: 'c0ffee000001', name: 'P', url: 'u', teams: [{ id: 't', key: 'CRM' }] }, issues, milestones: [], warnings: [] },
    descriptions: new Map(issues.map(i => [i.identifier, { id: i.id, title: i.title, description: 'Texto.', archivedAt: null }])),
  };
}

const harvestPlan = (kind, live) => computePlan({
  harvest: { schemaVersion: 1, project: { slug: 'c0ffee000001' }, edges: [{ from: 'CRM-29', to: 'CRM-94', kind, evidence: 'it ships first' }] },
  records: [], notes: null, ...world(live),
});

test('a deploy or gate edge writes "Sale después de" into the blocked card\'s order notes, and next reads it back', () => {
  for (const kind of ['deploy', 'gate']) {
    for (const live of [[], [['CRM-29', 'CRM-94']]]) {
      const r = harvestPlan(kind, live);
      assert.deepEqual(r.refusals, [], kind);
      const notes = r.plan.ops.filter(op => op.type === 'notes.replace');
      assert.deepEqual(notes.map(op => op.card), ['CRM-94'], kind);
      assert.ok(notes[0].after.block.includes('**Orden con otras tarjetas**\n\n- **CRM-29.** Sale después de CRM-29: no necesita su código.'), notes[0].after.block);
      assert.deepEqual(markers(notes[0].after.description).after, ['CRM-29']);
    }
  }
});

test('a code edge writes no marker', () => {
  const r = harvestPlan('code', []);
  assert.deepEqual(r.plan.ops.filter(op => op.type === 'notes.replace'), []);
});
