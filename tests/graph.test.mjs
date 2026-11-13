import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RELATIONS_PAGE } from '../scripts/lib/linear-fetch.mjs';
import {
  isExecutionCard, milestoneTags, buildCardMap, freeNow, downstreamCounts,
  impliedEdges, impliedLines, cycles, criticalPath, analyzeCardMap, danglingBlocks,
  analyzeProject,
} from '../scripts/lib/graph.mjs';

const FIX = JSON.parse(readFileSync(new URL('./fixtures/cardmap-synthetic.json', import.meta.url)));

const card = (key, statusType = 'backlog') => ({ key, statusType });
const edge = (from, to) => ({ from, to });
const node = over => ({
  identifier: 'CRM-1', title: 'Hacer algo', url: 'u', state: { name: 'Backlog', type: 'backlog' },
  labels: { nodes: [] }, relations: { nodes: [] }, ...over,
});

test('execution cards: the planner label decides, not the «¿» in the title', () => {
  assert.equal(isExecutionCard(node({ labels: { nodes: [{ name: 'map' }] }, title: 'Sin pregunta' })), false);
  assert.equal(isExecutionCard(node({ title: '¿Esto es una card?' })), true);
  assert.equal(isExecutionCard(node({ labels: { nodes: [{ name: 'map:design-delivery' }] } })), false);
  assert.equal(isExecutionCard(node({ title: 'QA: algo (CRM-1)' })), false);
  assert.equal(isExecutionCard(node({ state: { type: 'canceled' } })), false);
  assert.equal(isExecutionCard(node({ archivedAt: '2026-11-09' })), false);
});

test('milestones are numbered by sortOrder, not by the order Linear returns them', () => {
  const tags = milestoneTags([{ name: 'b', sortOrder: 7 }, { name: 'a', sortOrder: 1 }]);
  assert.deepEqual(tags, { a: { tag: 'M1', order: 1 }, b: { tag: 'M2', order: 2 } });
});

test('only blocks between cards on the map become edges, once each', () => {
  const issues = [
    node({ identifier: 'CRM-1', relations: { nodes: [
      { type: 'blocks', relatedIssue: { identifier: 'CRM-2' } },
      { type: 'blocks', relatedIssue: { identifier: 'CRM-2' } },
      { type: 'related', relatedIssue: { identifier: 'CRM-3' } },
      { type: 'blocks', relatedIssue: { identifier: 'CRM-9' } },
    ] } }),
    node({ identifier: 'CRM-2' }),
    node({ identifier: 'CRM-3' }),
  ];
  assert.deepEqual(buildCardMap({ issues, milestones: [] }).edges, [edge('CRM-1', 'CRM-2')]);
});

test('a card blocking itself makes no edge', () => {
  const issues = [node({ relations: { nodes: [{ type: 'blocks', relatedIssue: { identifier: 'CRM-1' } }] } })];
  assert.deepEqual(buildCardMap({ issues, milestones: [] }).edges, []);
});

test('a size from the spike record rides on the card when there is one', () => {
  const m = buildCardMap({ issues: [node({}), node({ identifier: 'CRM-2' })], milestones: [] }, { sizes: { 'CRM-1': 'L' } });
  assert.deepEqual(m.cards.map(c => c.size), ['L', null]);
});

test('a card carries its due date and its milestone target date', () => {
  const milestones = [{ name: 'Dated', sortOrder: 1, targetDate: '2026-12-01' }, { name: 'Undated', sortOrder: 2 }];
  const issues = [
    node({ identifier: 'CRM-1', dueDate: '2026-11-20', projectMilestone: { name: 'Dated' } }),
    node({ identifier: 'CRM-2', projectMilestone: { name: 'Undated' } }),
    node({ identifier: 'CRM-3' }),
  ];
  const facts = buildCardMap({ issues, milestones }).cards.map(c => [c.key, c.dueDate, c.milestoneTargetDate]);
  assert.deepEqual(facts, [['CRM-1', '2026-11-20', '2026-12-01'], ['CRM-2', null, null], ['CRM-3', null, null]]);
});

test('a project without dates gives every card null date facts', () => {
  const { cards } = buildCardMap(FIX);
  assert.ok(cards.length > 0);
  for (const c of cards) {
    assert.equal(c.dueDate, null, c.key);
    assert.equal(c.milestoneTargetDate, null, c.key);
  }
});

test('free now: not started and every blocker done', () => {
  const cards = [card('A', 'completed'), card('B'), card('C', 'unstarted'), card('D'), card('E', 'started')];
  const edges = [edge('A', 'B'), edge('B', 'D'), edge('A', 'C')];
  assert.deepEqual(freeNow(cards, edges), ['B', 'C'], 'D waits on B; E is already started');
});

test('free now: a blocker in review still blocks', () => {
  assert.deepEqual(freeNow([card('A', 'started'), card('B')], [edge('A', 'B')]), []);
});

test('downstream counts every card a chain reaches, once', () => {
  const cards = ['A', 'B', 'C', 'D'].map(k => card(k));
  const d = downstreamCounts(cards, [edge('A', 'B'), edge('A', 'C'), edge('B', 'D'), edge('C', 'D')]);
  assert.deepEqual(d, { A: 3, B: 1, C: 1, D: 0 });
});

test('an edge is implied when a longer chain already enforces it', () => {
  const cards = ['A', 'B', 'C'].map(k => card(k));
  const implied = impliedEdges(cards, [edge('A', 'B'), edge('B', 'C'), edge('A', 'C')]);
  assert.deepEqual(implied, [edge('A', 'C')]);
});

test('no edge of a plain chain is implied', () => {
  const cards = ['A', 'B', 'C'].map(k => card(k));
  assert.deepEqual(impliedEdges(cards, [edge('A', 'B'), edge('B', 'C')]), []);
});

test('cycles come out as one group each', () => {
  const cards = ['A', 'B', 'C', 'D'].map(k => card(k));
  assert.deepEqual(cycles(cards, [edge('A', 'B'), edge('B', 'C'), edge('C', 'A'), edge('C', 'D')]), [['A', 'B', 'C']]);
  assert.deepEqual(cycles(cards, [edge('A', 'B')]), []);
});

test('the critical path counts open cards, in progress included', () => {
  const cards = [card('CRM-1', 'completed'), card('CRM-2', 'started'), card('CRM-3'), card('CRM-4'), card('CRM-5')];
  const edges = [edge('CRM-1', 'CRM-2'), edge('CRM-2', 'CRM-3'), edge('CRM-3', 'CRM-4'), edge('CRM-1', 'CRM-5')];
  assert.deepEqual(criticalPath(cards, edges), { path: ['CRM-2', 'CRM-3', 'CRM-4'], ties: [] });
});

test('the critical path skips cards caught in a cycle instead of looping', () => {
  const cards = ['CRM-1', 'CRM-2', 'CRM-3'].map(k => card(k));
  const r = criticalPath(cards, [edge('CRM-1', 'CRM-2'), edge('CRM-2', 'CRM-1'), edge('CRM-2', 'CRM-3')]);
  assert.deepEqual(r.path, ['CRM-3']);
});

test('a tie is broken the same way every time and reported', () => {
  const cards = ['CRM-1', 'CRM-2', 'CRM-3'].map(k => card(k));
  const edges = [edge('CRM-1', 'CRM-3'), edge('CRM-2', 'CRM-3')];
  assert.deepEqual(criticalPath(cards, edges), { path: ['CRM-2', 'CRM-3'], ties: ['CRM-1'] });
  assert.deepEqual(criticalPath([...cards].reverse(), [...edges].reverse()).path, ['CRM-2', 'CRM-3']);
});

test('an empty project gives an empty map, not an error', () => {
  const r = analyzeCardMap(buildCardMap({ issues: [], milestones: [] }));
  assert.deepEqual(r.summary, { cards: 0, open: 0, free: 0, blocks: 0, critical: 0, implied: 0, cycles: 0 });
});

test('an implied edge carries the chain that enforces it', () => {
  const cards = ['A', 'B', 'C', 'D'].map(k => card(k));
  const r = analyzeCardMap({ cards, edges: [edge('A', 'B'), edge('B', 'C'), edge('C', 'D'), edge('A', 'D')] });
  assert.deepEqual(r.edges.find(e => e.implied), { from: 'A', to: 'D', implied: true, via: ['A', 'B', 'C', 'D'] });
  assert.equal(impliedLines(r.edges), '- A → D  (A → B → C → D)');
});

const SUMMARY = { cards: 12, open: 10, free: 3, blocks: 13, critical: 4, implied: 2, cycles: 0 };

test('the fixture gives the numbers derived by hand from its cards and blocks', () => {
  const r = analyzeCardMap(buildCardMap(FIX));
  assert.deepEqual(r.summary, SUMMARY);
  assert.deepEqual(r.free, ['ABC-4', 'ABC-5', 'ABC-9'], 'ABC-6 waits on a card in progress; ABC-3 is already started');
  assert.deepEqual(r.critical, ['ABC-4', 'ABC-7', 'ABC-10', 'ABC-12']);
  assert.deepEqual(r.criticalTies, ['ABC-3'], 'ABC-3 starts a chain just as long');
});

test('the fixture keeps decisions, QA sub-cards, canceled and archived cards off the map', () => {
  const keys = new Set(buildCardMap(FIX).cards.map(c => c.key));
  assert.equal(keys.has('ABC-13'), false, 'a decision ticket (label map)');
  assert.equal(keys.has('ABC-14'), false, 'a design delivery ticket');
  assert.equal(keys.has('ABC-15'), false, '«¿» title with no labels in the payload');
  assert.equal(keys.has('ABC-9'), true, '«¿» title with an empty label list');
  assert.equal(keys.has('ABC-16'), false, 'sub-card titled QA');
  assert.equal(keys.has('ABC-17'), false, 'sub-card labelled QA');
  assert.equal(keys.has('ABC-18'), false, '«QA: …» sub-card');
  assert.equal(keys.has('ABC-19'), false, 'canceled');
  assert.equal(keys.has('ABC-20'), false, 'archived');
  assert.equal(keys.size, 12);
});

test('the fixture lists its milestones out of order and the cards are tagged by sortOrder', () => {
  const tag = Object.fromEntries(buildCardMap(FIX).cards.map(c => [c.key, c.milestoneTag]));
  assert.notDeepEqual(FIX.milestones.map(m => m.sortOrder), [...FIX.milestones.map(m => m.sortOrder)].sort((a, b) => a - b));
  assert.deepEqual([tag['ABC-1'], tag['ABC-5'], tag['ABC-10'], tag['ABC-12']], ['M1', 'M2', 'M3', null]);
});

test('the fixture reads its relations past the first page', () => {
  const hub = FIX.issues.find(i => i.identifier === 'ABC-3');
  assert.ok(hub.relations.nodes.length > RELATIONS_PAGE);
  assert.equal(hub.relations.nodes.findIndex(r => r.relatedIssue.identifier === 'ABC-11'), RELATIONS_PAGE);
  const { edges } = buildCardMap(FIX);
  assert.deepEqual(edges.filter(e => e.from === 'ABC-3').map(e => e.to), ['ABC-6', 'ABC-11']);
});

test('in the fixture, each implied block carries the chain that enforces it', () => {
  const r = analyzeCardMap(buildCardMap(FIX));
  assert.deepEqual(r.edges.filter(e => e.implied), [
    { from: 'ABC-3', to: 'ABC-11', implied: true, via: ['ABC-3', 'ABC-6', 'ABC-8', 'ABC-11'] },
    { from: 'ABC-4', to: 'ABC-10', implied: true, via: ['ABC-4', 'ABC-7', 'ABC-10'] },
  ]);
});

test('a «¿» title excludes the card only when the payload carries no labels at all', () => {
  const { labels: _, ...bare } = node({ title: '¿Decidimos esto?' });
  assert.equal(isExecutionCard(bare), false, 'labels undefined');
  assert.equal(isExecutionCard({ ...bare, labels: null }), false, 'labels null');
  assert.equal(isExecutionCard(node({ title: '¿Decidimos esto?', labels: { nodes: [] } })), true, 'empty label list');
  assert.equal(isExecutionCard(node({ title: 'Sin pregunta', labels: { nodes: [{ name: 'map' }] } })), false);
  assert.equal(isExecutionCard({ ...bare, title: 'Hacer algo' }), true, 'no labels, plain title');
});

test('QA sub-cards are recognised by label or title, but not by QA inside a word', () => {
  assert.equal(isExecutionCard(node({ title: 'QA' })), false);
  assert.equal(isExecutionCard(node({ title: '  qa  ' })), false);
  assert.equal(isExecutionCard(node({ labels: { nodes: [{ name: 'qa' }] } })), false);
  assert.equal(isExecutionCard(node({ title: 'qa : algo' })), false);
  assert.equal(isExecutionCard(node({ title: 'Quality of QA flows' })), true);
});

const blocks = (identifier, extra = {}) => ({ type: 'blocks', relatedIssue: { identifier, ...extra } });
const blockedBy = (identifier, extra = {}) => ({ type: 'blocks', issue: { identifier, ...extra } });
const dangling = issues => danglingBlocks(issues, buildCardMap({ issues, milestones: [] }));

test('a block from a map card to a card off the map is dangling, with the reason it is off', () => {
  const issues = [
    node({ identifier: 'CRM-1', relations: { nodes: [
      blocks('CRM-2'), blocks('CRM-3'), blocks('CRM-4'), blocks('CRM-5'), blocks('CRM-6'), blocks('CRM-7'),
    ] } }),
    node({ identifier: 'CRM-2', archivedAt: '2026-11-09' }),
    node({ identifier: 'CRM-3', state: { name: 'Canceled', type: 'canceled' } }),
    node({ identifier: 'CRM-4', labels: { nodes: [{ name: 'map' }] } }),
    node({ identifier: 'CRM-5', labels: { nodes: [{ name: 'map:design-delivery' }] } }),
    node({ identifier: 'CRM-6', title: 'QA: algo' }),
  ];
  assert.deepEqual(dangling(issues), [
    { from: 'CRM-1', to: 'CRM-2', offMap: 'CRM-2', reason: 'archived', open: false },
    { from: 'CRM-1', to: 'CRM-3', offMap: 'CRM-3', reason: 'canceled', open: false },
    { from: 'CRM-1', to: 'CRM-4', offMap: 'CRM-4', reason: 'planner', open: true },
    { from: 'CRM-1', to: 'CRM-5', offMap: 'CRM-5', reason: 'planner', open: true },
    { from: 'CRM-1', to: 'CRM-6', offMap: 'CRM-6', reason: 'qa', open: true },
    { from: 'CRM-1', to: 'CRM-7', offMap: 'CRM-7', reason: 'outside-project', open: true },
  ]);
});

test('an off-map end missing from the payload is archived when Linear says so, else outside the project', () => {
  const issues = [node({ relations: { nodes: [
    blocks('CRM-8', { archivedAt: '2026-10-01', state: { type: 'backlog' } }),
    blocks('CRM-9', { state: { type: 'completed' } }),
    blocks('CRM-10', { state: { type: 'canceled' } }),
    blocks('CRM-11', { state: { type: 'started' } }),
  ] } })];
  assert.deepEqual(dangling(issues).map(d => [d.offMap, d.reason, d.open]), [
    ['CRM-8', 'archived', false],
    ['CRM-9', 'outside-project', false],
    ['CRM-10', 'outside-project', false],
    ['CRM-11', 'outside-project', true],
  ]);
});

test('a «¿» ticket with no labels in the payload is dangling as a planner ticket', () => {
  const { labels: _, ...decision } = node({ identifier: 'CRM-4', title: '¿Decidimos esto?', relations: { nodes: [blocks('CRM-1')] } });
  assert.deepEqual(dangling([node({}), decision]).map(d => d.reason), ['planner']);
});

test('dangling blocks are read in both directions', () => {
  const issues = [
    node({ identifier: 'CRM-1', inverseRelations: { nodes: [blockedBy('CRM-50', { state: { type: 'unstarted' } })] } }),
    node({ identifier: 'CRM-4', labels: { nodes: [{ name: 'map' }] }, relations: { nodes: [blocks('CRM-1')] } }),
  ];
  assert.deepEqual(dangling(issues), [
    { from: 'CRM-4', to: 'CRM-1', offMap: 'CRM-4', reason: 'planner', open: true },
    { from: 'CRM-50', to: 'CRM-1', offMap: 'CRM-50', reason: 'outside-project', open: true },
  ]);
});

test('each dangling block is reported once, and self, related and fully off-map relations are not', () => {
  const issues = [
    node({ identifier: 'CRM-1',
      relations: { nodes: [blocks('CRM-1'), blocks('CRM-7'), blocks('CRM-7'), { type: 'related', relatedIssue: { identifier: 'CRM-8' } }] },
      inverseRelations: { nodes: [blockedBy('CRM-4'), { type: 'related', issue: { identifier: 'CRM-9' } }] } }),
    node({ identifier: 'CRM-4', labels: { nodes: [{ name: 'map' }] }, relations: { nodes: [blocks('CRM-1'), blocks('CRM-6')] } }),
    node({ identifier: 'CRM-6', title: 'QA', relations: { nodes: [blocks('CRM-99')] } }),
  ];
  assert.deepEqual(dangling(issues).map(d => `${d.from}>${d.to}`), ['CRM-1>CRM-7', 'CRM-4>CRM-1']);
});

test('dangling blocks leave the edges and the ordering untouched', () => {
  const plain = [node({ identifier: 'CRM-1', relations: { nodes: [blocks('CRM-2')] } }), node({ identifier: 'CRM-2' })];
  const withOff = [
    node({ identifier: 'CRM-1', relations: { nodes: [blocks('CRM-2'), blocks('CRM-9')] },
      inverseRelations: { nodes: [blockedBy('CRM-50', { state: { type: 'started' } })] } }),
    node({ identifier: 'CRM-2' }),
  ];
  assert.deepEqual(analyzeCardMap(buildCardMap({ issues: withOff, milestones: [] })),
    analyzeCardMap(buildCardMap({ issues: plain, milestones: [] })));
});

test('a card blocked by an open card outside the project lists it, and stays free as far as the map goes', () => {
  const issues = [
    node({ identifier: 'CRM-1', inverseRelations: { nodes: [
      blockedBy('CRM-50', { state: { type: 'started' } }),
      blockedBy('CRM-51', { state: { type: 'completed' } }),
      blockedBy('CRM-52', { state: { type: 'canceled' } }),
      blockedBy('CRM-53', { archivedAt: '2026-10-01', state: { type: 'backlog' } }),
    ] } }),
    node({ identifier: 'CRM-2', relations: { nodes: [blocks('CRM-60', { state: { type: 'backlog' } })] } }),
    node({ identifier: 'CRM-4', labels: { nodes: [{ name: 'map' }] }, relations: { nodes: [blocks('CRM-1')] } }),
  ];
  const r = analyzeProject({ issues, milestones: [] });
  const base = analyzeCardMap(buildCardMap({ issues, milestones: [] }));
  assert.deepEqual(r.cards.map(c => [c.key, c.offMapBlockers]), [['CRM-1', ['CRM-50']], ['CRM-2', []]]);
  assert.deepEqual(r.free, base.free);
  assert.deepEqual(r.summary, base.summary);
  assert.equal(r.danglingBlocks.length, 6);
});

test('only an open blocker outside the project is an off-map blocker; a QA blocker stays dangling only', () => {
  const issues = [
    node({ identifier: 'CRM-1', inverseRelations: { nodes: [blockedBy('CRM-50', { state: { type: 'started' } })] } }),
    node({ identifier: 'CRM-6', title: 'QA: algo', relations: { nodes: [blocks('CRM-1')] } }),
  ];
  const r = analyzeProject({ issues, milestones: [] });
  assert.deepEqual(r.cards.map(c => [c.key, c.offMapBlockers]), [['CRM-1', ['CRM-50']]]);
  assert.deepEqual(r.danglingBlocks.map(d => [d.offMap, d.reason, d.open]),
    [['CRM-6', 'qa', true], ['CRM-50', 'outside-project', true]]);
});

test('analyzeProject adds dangling blocks and off-map blockers to the card map analysis', () => {
  const r = analyzeProject(FIX);
  const base = analyzeCardMap(buildCardMap(FIX));
  assert.deepEqual(Object.keys(r), [...Object.keys(base), 'danglingBlocks']);
  assert.deepEqual(r.cards.map(({ offMapBlockers, ...c }) => c), base.cards);
  assert.ok(r.cards.every(c => Array.isArray(c.offMapBlockers)));
  assert.deepEqual(r.summary, SUMMARY);
  assert.deepEqual(r.critical, base.critical);
  assert.deepEqual(r.criticalTies, ['ABC-3']);
});

test('analyzeProject passes sizes through to the cards and, by default, leaves every size null and the rest unchanged', () => {
  const plain = analyzeProject(FIX);
  assert.ok(plain.cards.every(c => c.size === null));
  const size = { tier: 'L', lines: 412, origin: 'thin-spike', label: 'L · 412 lines' };
  const sized = analyzeProject(FIX, { sizes: { 'ABC-3': size, 'ABC-13': size } });
  assert.deepEqual(sized.cards.filter(c => c.size).map(c => [c.key, c.size]), [['ABC-3', size]]);
  const strip = r => ({ ...r, cards: r.cards.map(({ size: _, ...c }) => c) });
  assert.deepEqual(strip(sized), strip(plain));
});

test('a size member graph does not know, such as verdict, rides on the card unmodified', () => {
  const size = { tier: 'XL', lines: 900, origin: 'thin-spike', label: 'XL · 900 lines', verdict: 'SDD' };
  const sized = analyzeProject(FIX, { sizes: { 'ABC-3': size } });
  assert.deepEqual(sized.cards.find(c => c.key === 'ABC-3').size, size);
  assert.deepEqual(sized.summary, SUMMARY);
});

test('the fixture has 2 dangling blocks, each with exactly one end on the map', () => {
  const r = analyzeProject(FIX);
  const onMap = new Set(r.cards.map(c => c.key));
  assert.deepEqual(r.danglingBlocks, [
    { from: 'ABC-5', to: 'ABC-20', offMap: 'ABC-20', reason: 'archived', open: false },
    { from: 'ABC-13', to: 'ABC-4', offMap: 'ABC-13', reason: 'planner', open: true },
  ], 'the design delivery ticket blocking the decision has no end on the map');
  assert.ok(r.cards.every(c => c.offMapBlockers.length === 0));
  for (const d of r.danglingBlocks) {
    assert.notEqual(onMap.has(d.from), onMap.has(d.to), `${d.from}>${d.to}`);
    assert.equal(onMap.has(d.offMap), false);
    if (['archived', 'canceled'].includes(d.reason)) assert.equal(d.open, false, `${d.from}>${d.to}`);
  }
});

test('a map card blocking an archived card in the project is dangling as archived', () => {
  const issues = [
    node({ identifier: 'CRM-1184', relations: { nodes: [blocks('CRM-1218')] } }),
    node({ identifier: 'CRM-1218', archivedAt: '2026-11-09T10:00:00.000Z', state: { name: 'Todo', type: 'unstarted' } }),
  ];
  assert.deepEqual(analyzeProject({ issues, milestones: [] }).danglingBlocks,
    [{ from: 'CRM-1184', to: 'CRM-1218', offMap: 'CRM-1218', reason: 'archived', open: false }]);
});
