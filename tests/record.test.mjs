import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import {
  validateRecord, canonicalRecord, serializeRecord, SCHEMA_VERSION, ORIGINS, FINDING_KINDS, CASE_SOURCES, TOKEN_KEYS, DELETION_WEIGHT,
  OPEN_DECISION_IMPACTS, OPEN_DECISION_STATUSES, OPEN_DECISION_OWNERS, PRIOR_FINDING_OUTCOMES,
} from '../scripts/lib/record.mjs';

const FULL_TEXT = readFileSync(new URL('./fixtures/records/ABC-903.json', import.meta.url), 'utf8');
const FULL = JSON.parse(FULL_TEXT);

const minimal = () => ({
  schemaVersion: 1,
  card: 'CRM-1',
  title: 'Hacer algo',
  project: { slug: 'abc123', name: 'Proyecto' },
  origin: 'existing-pr',
  spikedAt: '2026-11-06T21:20:00.000Z',
  scope: { complete: true, note: null },
  size: null,
  effort: null,
  fixups: { received: [], caused: [] },
  cases: [{ id: 'c1', given: 'a card', when: 'it is read', then: 'it is valid', source: 'linear', ref: 'linear:CRM-1' }],
  decisions: [],
  findings: [],
  refs: { engram: [], patches: [], linear: null },
});

const variant = (base, path, value) => {
  const r = structuredClone(base);
  const keys = path.split('.');
  const last = keys.pop();
  const parent = keys.reduce((o, k) => o[k], r);
  if (value === undefined) delete parent[last];
  else parent[last] = value;
  return r;
};

const errorPaths = record => validateRecord(record).map(e => e.slice(0, e.indexOf(': ')));

const REQUIRED = ['schemaVersion', 'card', 'title', 'project', 'origin', 'spikedAt', 'scope', 'size', 'effort',
  'fixups', 'cases', 'decisions', 'findings', 'refs'];

test('a complete record and a required-only record are valid', () => {
  assert.deepEqual(validateRecord(FULL), []);
  assert.deepEqual(validateRecord(minimal()), []);
  assert.deepEqual(validateRecord({ ...minimal(), archived: null, supersededBy: null }), []);
});

test('removing any required field fails with an error naming that field', () => {
  for (const field of REQUIRED) {
    for (const base of [FULL, minimal()]) {
      assert.ok(errorPaths(variant(base, field, undefined)).includes(`$.${field}`), `$.${field} not reported`);
    }
  }
  for (const path of ['project.slug', 'project.name', 'scope.complete', 'fixups.received', 'fixups.caused',
    'refs.engram', 'refs.patches', 'refs.linear']) {
    assert.ok(errorPaths(variant(FULL, path, undefined)).includes(`$.${path}`), `$.${path} not reported`);
  }
});

test('out-of-enum and wrongly-typed values are rejected with their field path', () => {
  const table = [
    ['origin', 'spike', '$.origin'],
    ['findings.0.kind', 'other', '$.findings[0].kind'],
    ['schemaVersion', 2, '$.schemaVersion'],
    ['schemaVersion', '1', '$.schemaVersion'],
    ['spikedAt', 'yesterday', '$.spikedAt'],
    ['spikedAt', '2026-11-06', '$.spikedAt'],
    ['card', 'crm-1', '$.card'],
    ['title', '', '$.title'],
    ['size.prodLines', -1, '$.size.prodLines'],
    ['size.prodLines', 'x', '$.size.prodLines'],
    ['size.testLines', 2.5, '$.size.testLines'],
    ['size.files', 1.5, '$.size.files'],
    ['size.repos', [], '$.size.repos'],
    ['size.deletionWeight', 0.5, '$.size.deletionWeight'],
    ['effort.basis', 'guess', '$.effort.basis'],
    ['effort.windows.0.tokens.output', 1.5, '$.effort.windows[0].tokens.output'],
    ['effort.windows.0.tokens.thinking', undefined, '$.effort.windows[0].tokens.thinking'],
    ['effort.windows.0.messages', -1, '$.effort.windows[0].messages'],
    ['cases.0.given', '', '$.cases[0].given'],
    ['cases.0.source', undefined, '$.cases[0].source'],
    ['cases.0.ref', undefined, '$.cases[0].ref'],
    ['cases.0.source', 'slack', '$.cases[0].source'],
    ['decisions.0.text', '', '$.decisions[0].text'],
    ['scope.complete', 'yes', '$.scope.complete'],
    ['refs.engram', ['635'], '$.refs.engram[0]'],
  ];
  for (const [path, value, expected] of table) {
    const paths = errorPaths(variant(FULL, path, value));
    assert.ok(paths.includes(expected), `${path}=${JSON.stringify(value)}: got ${JSON.stringify(paths)}`);
  }
  assert.deepEqual(validateRecord(variant(FULL, 'size.files', 1.5)), ['$.size.files: expected integer >= 0']);
});

test('every error is reported in one pass, not only the first', () => {
  const r = variant(variant(FULL, 'origin', 'spike'), 'spikedAt', 'yesterday');
  assert.deepEqual(errorPaths(r), ['$.origin', '$.spikedAt']);
});

test('non-object input and wrongly-shaped containers are rejected without throwing', () => {
  for (const value of [null, [], 'CRM-1', 42, undefined]) assert.deepEqual(validateRecord(value), ['$: expected object']);
  const shapes = [
    ['cases', 'x', '$.cases'], ['fixups', null, '$.fixups'], ['refs', [], '$.refs'], ['project', 'p', '$.project'],
    ['effort.windows', 'x', '$.effort.windows'], ['cases.0', null, '$.cases[0]'], ['size', [], '$.size'],
    ['fixups.received', {}, '$.fixups.received'], ['effort.windows.0.tokens', null, '$.effort.windows[0].tokens'],
  ];
  for (const [path, value, expected] of shapes) {
    assert.ok(errorPaths(variant(FULL, path, value)).includes(expected), `${path} not reported`);
  }
});

test('duplicate case ids within one record are rejected', () => {
  const r = structuredClone(FULL);
  r.cases.push({ ...r.cases[0] });
  assert.ok(errorPaths(r).includes('$.cases[1].id'));
  assert.ok(errorPaths(variant(FULL, 'cases.0.id', 'case-1')).includes('$.cases[0].id'));
});

test('the v1 constants are exported', () => {
  assert.equal(SCHEMA_VERSION, 1);
  assert.deepEqual(ORIGINS, ['thin-spike', 'existing-pr']);
  assert.deepEqual(FINDING_KINDS, ['reorder', 'split', 'under-scoped', 'risk']);
  assert.deepEqual(CASE_SOURCES, ['engram', 'linear', 'patch']);
  assert.deepEqual(TOKEN_KEYS, ['input', 'cacheCreation', 'cacheRead', 'output', 'thinking']);
  assert.equal(DELETION_WEIGHT, 0.25);
});

test('a stored tier is rejected because the tier is computed at read time', () => {
  for (const [record, path] of [[{ ...FULL, tier: 'L' }, '$.tier'], [variant(FULL, 'size.tier', 'S'), '$.size.tier']]) {
    const errors = validateRecord(record);
    assert.equal(errors.length, 1, JSON.stringify(errors));
    assert.match(errors[0], new RegExp(`^\\${path}: tier is computed at read time`));
  }
});

test('an existing-pr record must have effort null; a thin-spike record may have either', () => {
  assert.ok(errorPaths({ ...FULL, origin: 'existing-pr' }).includes('$.effort'));
  assert.deepEqual(validateRecord({ ...FULL, origin: 'existing-pr', effort: null }), []);
  assert.deepEqual(validateRecord({ ...FULL, effort: null }), []);
  assert.deepEqual(validateRecord(FULL), []);
});

test('a record cannot be both archived and superseded', () => {
  const r = { ...FULL, archived: { at: '2026-11-09', reason: 'archived in Linear' }, supersededBy: { card: 'ABC-903', spikedAt: '2026-11-10T10:00:00Z' } };
  assert.ok(errorPaths(r).includes('$.supersededBy'));
});

test('a spiked card that is not archived needs at least one case; an archived one may have none', () => {
  assert.ok(errorPaths({ ...FULL, cases: [] }).includes('$.cases'));
  assert.deepEqual(validateRecord({ ...FULL, cases: [], archived: { at: '2026-11-09', reason: 'archived in Linear' } }), []);
});

test('refs follow the ref grammar and a case ref uses the scheme of its source', () => {
  const table = [
    ['cases.0.ref', 'linear:ABC-903', '$.cases[0].ref'],
    ['cases.0.ref', 'example-api#635', '$.cases[0].ref'],
    ['cases.0.ref', 'engram:example-api', '$.cases[0].ref'],
    ['decisions.0.ref', 'see the spike', '$.decisions[0].ref'],
    ['findings.0.ref', 'patch:00903-new.patch', '$.findings[0].ref'],
  ];
  for (const [path, value, expected] of table) {
    assert.ok(errorPaths(variant(FULL, path, value)).includes(expected), `${path}=${value} not rejected`);
  }
  const ok = [
    { source: 'linear', ref: 'linear:ABC-903' },
    { source: 'patch', ref: 'patch:example-api/00903-new.patch' },
    { source: 'engram', ref: 'engram:example-api#651' },
  ];
  for (const over of ok) assert.deepEqual(validateRecord({ ...FULL, cases: [{ ...FULL.cases[0], ...over }] }), [], over.ref);
});

test('scope.note is required when the scope is incomplete', () => {
  assert.ok(errorPaths(variant(FULL, 'scope', { complete: false, note: null })).includes('$.scope.note'));
  assert.ok(errorPaths(variant(FULL, 'scope', { complete: false })).includes('$.scope.note'));
  assert.ok(errorPaths(variant(FULL, 'scope.note', 7)).includes('$.scope.note'));
  assert.deepEqual(validateRecord(variant(FULL, 'scope', { complete: false, note: 'list endpoint only' })), []);
});

test('effort windows need start < end, member cards that include the card, and at least one window', () => {
  const w = FULL.effort.windows[0];
  assert.ok(errorPaths(variant(FULL, 'effort.windows.0.start', w.end)).includes('$.effort.windows[0]'));
  assert.ok(errorPaths(variant(FULL, 'effort.windows.0.cards', ['ABC-902'])).includes('$.effort.windows[0].cards'));
  assert.ok(errorPaths(variant(FULL, 'effort.windows', [])).includes('$.effort.windows'));
});

test('a card-run effort needs a runId, refs may carry a runId, and both keys serialize in their canonical place', () => {
  const runId = '20261110T100000Z';
  const cardRun = { ...FULL, effort: { windows: FULL.effort.windows, runId, basis: 'card-run' } };
  assert.deepEqual(validateRecord(cardRun), []);
  assert.ok(errorPaths(variant(cardRun, 'effort.runId', undefined)).includes('$.effort.runId'));
  assert.ok(errorPaths(variant(cardRun, 'effort.runId', '')).includes('$.effort.runId'));
  assert.deepEqual(validateRecord(variant(FULL, 'refs.runId', runId)), []);

  const shuffled = { ...cardRun, refs: { runId, linear: FULL.refs.linear, patches: FULL.refs.patches, engram: FULL.refs.engram } };
  const canonical = canonicalRecord(shuffled);
  assert.deepEqual(Object.keys(canonical.effort), ['basis', 'runId', 'windows']);
  assert.deepEqual(Object.keys(canonical.refs), ['engram', 'patches', 'linear', 'runId']);
});

test('fixup items carry a card, a patch path and a note that is a string or null', () => {
  const table = [
    ['fixups.received.0.from', 'x', '$.fixups.received[0].from'],
    ['fixups.received.0.patch', undefined, '$.fixups.received[0].patch'],
    ['fixups.received.0.patch', 'fixup.patch', '$.fixups.received[0].patch'],
    ['fixups.caused.0.note', 1, '$.fixups.caused[0].note'],
    ['fixups.caused.0.note', undefined, '$.fixups.caused[0].note'],
    ['fixups.caused.0.to', undefined, '$.fixups.caused[0].to'],
  ];
  for (const [path, value, expected] of table) {
    assert.ok(errorPaths(variant(FULL, path, value)).includes(expected), `${path}=${value} not rejected`);
  }
  assert.deepEqual(validateRecord(variant(FULL, 'fixups.caused.0.note', null)), []);
});

test('archived is null or {at, reason}', () => {
  for (const at of ['2026-11-09', '2026-11-09T12:00:00Z']) {
    assert.deepEqual(validateRecord({ ...FULL, archived: { at, reason: 'archived in Linear' } }), [], at);
  }
  const table = [
    ['yes', '$.archived'], [true, '$.archived'], [{ at: 'today', reason: 'x' }, '$.archived.at'],
    [{ at: '2026-11-09', reason: '' }, '$.archived.reason'], [{ reason: 'x' }, '$.archived.at'],
  ];
  for (const [archived, expected] of table) {
    assert.ok(errorPaths({ ...FULL, archived }).includes(expected), `${JSON.stringify(archived)} not rejected`);
  }
});

test('supersededBy is null or {card, spikedAt}', () => {
  assert.deepEqual(validateRecord({ ...FULL, supersededBy: { card: 'ABC-903', spikedAt: '2026-11-10T10:00:00Z' } }), []);
  const table = [
    ['', '$.supersededBy'], ['ABC-903', '$.supersededBy'], [{ card: 'x', spikedAt: '2026-11-10T10:00:00Z' }, '$.supersededBy.card'],
    [{ card: 'ABC-903', spikedAt: '2026-11-10' }, '$.supersededBy.spikedAt'],
  ];
  for (const [supersededBy, expected] of table) {
    assert.ok(errorPaths({ ...FULL, supersededBy }).includes(expected), `${JSON.stringify(supersededBy)} not rejected`);
  }
});

test('alias.splitFrom and alias.mergedInto are card keys when present', () => {
  assert.deepEqual(validateRecord({ ...FULL, alias: { splitFrom: 'ABC-916', mergedInto: null } }), []);
  assert.deepEqual(validateRecord({ ...FULL, alias: { mergedInto: 'ABC-956' } }), []);
  assert.ok(errorPaths({ ...FULL, alias: { splitFrom: 'x', mergedInto: null } }).includes('$.alias.splitFrom'));
  assert.ok(errorPaths({ ...FULL, alias: { splitFrom: null, mergedInto: 'x' } }).includes('$.alias.mergedInto'));
  assert.ok(errorPaths({ ...FULL, alias: 'ABC-916' }).includes('$.alias'));
});

test('unknown fields are accepted at every level and the input is not mutated', () => {
  const r = structuredClone(FULL);
  r.futureThing = { a: 1 };
  r.size.extra = 'x';
  r.cases[0].extra = true;
  r.effort.windows[0].extra = [1];
  r.refs.extra = null;
  const before = structuredClone(r);
  assert.deepEqual(validateRecord(r), []);
  assert.deepEqual(r, before);
});

const shuffled = () => {
  const r = structuredClone(FULL);
  r.size.repos = ['example-web', 'example-api'];
  r.size.sharedWith = ['ABC-922', 'ABC-921'];
  r.effort.windows.unshift({ ...structuredClone(r.effort.windows[0]), start: '2026-11-06T21:30:00.000Z', end: '2026-11-06T21:40:00.000Z', cards: ['ABC-903'] });
  r.effort.windows[1].cards = ['ABC-903', 'ABC-902'];
  r.refs.engram = ['example-api#651', 'example-api#99', 'example-api#635'];
  r.refs.patches = ['example-api/00903-new.patch', 'example-api/00902-new.patch'];
  r.fixups.caused = [r.fixups.caused[1], r.fixups.caused[0]];
  r.cases = [{ ...r.cases[0], id: 'c2' }, r.cases[0]];
  r.zeta = 1;
  r.alpha = 2;
  return Object.fromEntries(Object.entries(r).reverse());
};

test('canonicalRecord fixes the key order and sorts set-like arrays, keeping authored order', () => {
  const input = shuffled();
  const before = structuredClone(input);
  const c = canonicalRecord(input);
  assert.deepEqual(input, before);
  assert.deepEqual(Object.keys(c), ['schemaVersion', 'card', 'title', 'project', 'origin', 'spikedAt', 'archived',
    'supersededBy', 'alias', 'scope', 'size', 'effort', 'fixups', 'cases', 'decisions', 'findings', 'refs', 'alpha', 'zeta']);
  assert.deepEqual(Object.keys(c.size), ['prodLines', 'testLines', 'files', 'repos', 'sharedWith', 'deletionWeight']);
  assert.deepEqual(Object.keys(c.cases[0]), ['id', 'given', 'when', 'then', 'source', 'ref']);
  assert.deepEqual(c.size.repos, ['example-api', 'example-web']);
  assert.deepEqual(c.size.sharedWith, ['ABC-921', 'ABC-922']);
  assert.deepEqual(c.effort.windows.map(w => w.end), ['2026-11-06T21:20:00.000Z', '2026-11-06T21:40:00.000Z']);
  assert.deepEqual(c.effort.windows[0].cards, ['ABC-902', 'ABC-903']);
  assert.deepEqual(c.refs.engram, ['example-api#99', 'example-api#635', 'example-api#651']);
  assert.deepEqual(c.refs.patches, ['example-api/00902-new.patch', 'example-api/00903-new.patch']);
  assert.deepEqual(c.fixups.caused.map(f => f.to), ['ABC-911', 'ABC-912']);
  assert.deepEqual(c.cases.map(x => x.id), ['c2', 'c1']);
  assert.equal(c.zeta, 1);
});

test('serializeRecord is canonical, idempotent, newline-terminated and adds nothing', () => {
  const text = serializeRecord(FULL);
  assert.equal(text, FULL_TEXT);
  assert.ok(text.endsWith('}\n'));
  assert.equal(serializeRecord(JSON.parse(text)), text);
  assert.equal(serializeRecord(Object.fromEntries(Object.entries(FULL).reverse())), text);
  assert.equal(serializeRecord(shuffled()), serializeRecord(JSON.parse(serializeRecord(shuffled()))));
  assert.deepEqual(Object.keys(JSON.parse(text)).sort(), Object.keys(FULL).sort());
  assert.deepEqual(JSON.parse(serializeRecord(minimal())), canonicalRecord(minimal()));
});

test('riskAreas is optional: absent and empty are both valid and stay distinct through canonicalization', () => {
  assert.deepEqual(validateRecord(FULL), []);
  assert.deepEqual(validateRecord({ ...FULL, riskAreas: [] }), []);
  const areas = [{ kind: 'migrations', paths: ['backend/db/x.ts'] }, { kind: 'authorization', paths: ['backend/a.ts', 'backend/b.ts'] }];
  assert.deepEqual(validateRecord({ ...FULL, riskAreas: areas }), []);
  assert.equal('riskAreas' in canonicalRecord(FULL), false);
  assert.deepEqual(canonicalRecord({ ...FULL, riskAreas: [] }).riskAreas, []);
  const canonical = canonicalRecord({ ...FULL, riskAreas: [{ paths: ['backend/db/x.ts'], kind: 'migrations' }, areas[1]] });
  assert.deepEqual(canonical.riskAreas.map(a => a.kind), ['authorization', 'migrations']);
  assert.deepEqual(Object.keys(canonical.riskAreas[1]), ['kind', 'paths']);
});

test('a risk area needs a kind, sorted non-empty string paths and a kind not used twice', () => {
  const table = [
    [{ kind: '', paths: ['backend/a.ts'] }, '$.riskAreas[0].kind'],
    [{ paths: ['backend/a.ts'] }, '$.riskAreas[0].kind'],
    [{ kind: 'migrations', paths: [] }, '$.riskAreas[0].paths'],
    [{ kind: 'migrations' }, '$.riskAreas[0].paths'],
    [{ kind: 'migrations', paths: ['backend/a.ts', 3] }, '$.riskAreas[0].paths[1]'],
    [{ kind: 'migrations', paths: [''] }, '$.riskAreas[0].paths[0]'],
    [{ kind: 'migrations', paths: ['backend/b.ts', 'backend/a.ts'] }, '$.riskAreas[0].paths'],
    ['migrations', '$.riskAreas[0]'],
  ];
  for (const [area, expected] of table) {
    assert.ok(errorPaths({ ...FULL, riskAreas: [area] }).includes(expected), `${JSON.stringify(area)}: ${errorPaths({ ...FULL, riskAreas: [area] })}`);
  }
  const twice = [{ kind: 'migrations', paths: ['backend/a.ts'] }, { kind: 'migrations', paths: ['backend/b.ts'] }];
  assert.ok(errorPaths({ ...FULL, riskAreas: twice }).includes('$.riskAreas[1].kind'));
  assert.ok(errorPaths({ ...FULL, riskAreas: {} }).includes('$.riskAreas'));
});

test('openDecisions is optional; each item has non-empty text and, when present, a ref in the ref grammar', () => {
  assert.equal('openDecisions' in canonicalRecord(FULL), false);
  assert.deepEqual(canonicalRecord({ ...FULL, openDecisions: [] }).openDecisions, []);
  const ok = [{ text: 'Which flag gates the new path is a guess.' }, { ref: 'linear:CRM-1', text: 'Retention period is unconfirmed.' }];
  assert.deepEqual(validateRecord({ ...FULL, openDecisions: ok }), []);
  assert.deepEqual(Object.keys(canonicalRecord({ ...FULL, openDecisions: ok }).openDecisions[1]), ['text', 'ref']);
  const table = [
    [{ text: '' }, '$.openDecisions[0].text'],
    [{ ref: 'linear:CRM-1' }, '$.openDecisions[0].text'],
    [{ text: 'x', ref: 'see the card' }, '$.openDecisions[0].ref'],
    [{ text: 'x', ref: null }, '$.openDecisions[0].ref'],
    ['x', '$.openDecisions[0]'],
  ];
  for (const [item, expected] of table) {
    assert.ok(errorPaths({ ...FULL, openDecisions: [item] }).includes(expected), JSON.stringify(item));
  }
  assert.ok(errorPaths({ ...FULL, openDecisions: 'none' }).includes('$.openDecisions'));
});

test('the new optional fields serialize between findings and refs', () => {
  const r = { ...FULL, refs: FULL.refs, riskAreas: [], openDecisions: [] };
  const keys = Object.keys(canonicalRecord(Object.fromEntries(Object.entries(r).reverse())));
  assert.deepEqual(keys.slice(keys.indexOf('findings')), ['findings', 'openDecisions', 'riskAreas', 'refs']);
});

test('novelty carries a newPaths array of non-empty strings, a trailing slash marking a directory', () => {
  for (const newPaths of [[], ['backend/newsvc/'], ['backend/README2.md', 'backend/newsvc/']]) {
    assert.deepEqual(validateRecord({ ...FULL, novelty: { newPaths } }), [], JSON.stringify(newPaths));
  }
  const table = [
    [{ newPaths: 'backend/newsvc/' }, '$.novelty.newPaths'],
    [{ newPaths: [''] }, '$.novelty.newPaths[0]'],
    [{ newPaths: [7] }, '$.novelty.newPaths[0]'],
    [{}, '$.novelty.newPaths'],
    [[], '$.novelty'],
  ];
  for (const [novelty, expected] of table) {
    assert.ok(errorPaths({ ...FULL, novelty }).includes(expected), JSON.stringify(novelty));
  }
  assert.equal('novelty' in canonicalRecord(FULL), false);
});

test('timeBox holds integer budget and spent with over equal to spent > budget', () => {
  for (const timeBox of [{ budget: 100, spent: 140, over: true }, { budget: 100, spent: 60, over: false }, { budget: 100, spent: 100, over: false }]) {
    assert.deepEqual(validateRecord({ ...FULL, timeBox }), [], JSON.stringify(timeBox));
  }
  const table = [
    [{ budget: 100, spent: 140, over: false }, '$.timeBox.over'],
    [{ budget: 100, spent: 60, over: true }, '$.timeBox.over'],
    [{ budget: -1, spent: 0, over: true }, '$.timeBox.budget'],
    [{ budget: 100, spent: -5, over: false }, '$.timeBox.spent'],
    [{ budget: 100, spent: 1.5, over: false }, '$.timeBox.spent'],
    [{ budget: 100, spent: 60 }, '$.timeBox.over'],
    [{ budget: 100, spent: 60, over: 'no' }, '$.timeBox.over'],
    [null, '$.timeBox'],
  ];
  for (const [timeBox, expected] of table) {
    assert.ok(errorPaths({ ...FULL, timeBox }).includes(expected), JSON.stringify(timeBox));
  }
  const canonical = canonicalRecord({ ...FULL, novelty: { newPaths: [] }, timeBox: { over: true, spent: 140, budget: 100 } });
  assert.deepEqual(Object.keys(canonical.timeBox), ['budget', 'spent', 'over']);
  const keys = Object.keys(canonical);
  assert.deepEqual(keys.slice(keys.indexOf('findings')), ['findings', 'novelty', 'timeBox', 'refs']);
});

test('an existing-pr record never carries a timeBox', () => {
  const pr = { ...FULL, origin: 'existing-pr', effort: null };
  assert.deepEqual(validateRecord(pr), []);
  assert.ok(errorPaths({ ...pr, timeBox: { budget: 100, spent: 0, over: false } }).includes('$.timeBox'));
});

test('a stored verdict is rejected because the verdict is computed at read time', () => {
  const errors = validateRecord({ ...FULL, verdict: 'SDD' });
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], /^\$\.verdict: verdict is computed at read time/);
});

test('a card-run runId and a refs.runId use the run id format, and the two agree when both are present', () => {
  const runId = '20261110T100000Z';
  const cardRun = { ...FULL, effort: { basis: 'card-run', runId, windows: FULL.effort.windows }, refs: { ...FULL.refs, runId } };
  assert.deepEqual(validateRecord(cardRun), []);
  for (const bad of ['run-1', '2026-11-10T10:00:00Z', '20261110T100000']) {
    assert.ok(errorPaths(variant(cardRun, 'effort.runId', bad)).includes('$.effort.runId'), bad);
    assert.ok(errorPaths(variant(cardRun, 'refs.runId', bad)).includes('$.refs.runId'), bad);
  }
  assert.ok(errorPaths(variant(cardRun, 'refs.runId', '20261111T100000Z')).includes('$.refs.runId'));
  assert.deepEqual(validateRecord(variant(cardRun, 'refs.runId', undefined)), []);
  assert.ok(errorPaths(variant(cardRun, 'effort.basis', 'other')).includes('$.effort.basis'));
});

test('an existing-pr record points at its run through refs.runId alone, with effort null', () => {
  const pr = { ...FULL, origin: 'existing-pr', effort: null, refs: { ...FULL.refs, runId: '20261110T100000Z' } };
  assert.deepEqual(validateRecord(pr), []);
});

test('a replayed marker naming the refs run lets refs.runId move past effort.runId, and serializes between timeBox and refs', () => {
  const oldRun = '20261101T100000Z';
  const newRun = '20261110T100000Z';
  const moved = { ...FULL, effort: { basis: 'card-run', runId: oldRun, windows: FULL.effort.windows }, refs: { ...FULL.refs, runId: newRun } };
  assert.ok(errorPaths(moved).includes('$.refs.runId'));
  const replayed = { ...moved, replayed: { folded: ['backend/00001-new.patch'], fromRunId: oldRun, runId: newRun, at: '2026-11-10T10:02:00.000Z' } };
  assert.deepEqual(validateRecord(replayed), []);
  assert.ok(errorPaths({ ...replayed, replayed: { ...replayed.replayed, runId: '20261111T100000Z' } }).includes('$.replayed.runId'));

  const keys = Object.keys(canonicalRecord({ ...replayed, timeBox: { budget: 10, spent: 5, over: false } }));
  assert.deepEqual(keys.slice(-3), ['timeBox', 'replayed', 'refs']);
  assert.deepEqual(Object.keys(canonicalRecord(replayed).replayed), ['at', 'runId', 'fromRunId', 'folded']);
});

const replayedTrial = () => ({
  ...structuredClone(FULL),
  replayed: { at: '2026-11-10T10:02:00.000Z', runId: '20261110T100000Z', fromRunId: null, folded: ['example-api/00903-new.patch'] },
  refs: { ...structuredClone(FULL.refs), patches: ['example-api/00903-new.patch'], runId: '20261110T100000Z' },
});

test('a replayed trial record (transcript-window effort, no effort.runId) validates with its marker', () => {
  assert.deepEqual(validateRecord(replayedTrial()), []);
});

test('a malformed replayed marker is rejected naming the field', () => {
  const base = replayedTrial();
  const bad = (field, value) => errorPaths(variant(base, `replayed.${field}`, value));
  assert.ok(bad('at', '2026-11-10').includes('$.replayed.at'));
  assert.ok(bad('at', undefined).includes('$.replayed.at'));
  assert.ok(bad('fromRunId', 'yesterday').includes('$.replayed.fromRunId'));
  assert.ok(bad('fromRunId', undefined).includes('$.replayed.fromRunId'));
  assert.ok(bad('runId', '20261111T100000Z').includes('$.replayed.runId'));
  assert.ok(bad('runId', 'later').includes('$.replayed.runId'));
  assert.ok(bad('folded', ['example-api/00903-new.diff']).includes('$.replayed.folded[0]'));
  assert.ok(bad('folded', 'example-api/00903-new.patch').includes('$.replayed.folded'));
  assert.ok(errorPaths({ ...base, replayed: 'yes' }).includes('$.replayed'));
  assert.ok(errorPaths(variant(base, 'refs.runId', undefined)).includes('$.replayed.runId'));
});

test('a replayed marker serializes with folded sorted', () => {
  const r = replayedTrial();
  r.replayed.folded = ['example-api/fixup-903-from-912-x.patch', 'example-api/00903-new.patch'];
  assert.deepEqual(canonicalRecord(r).replayed.folded, ['example-api/00903-new.patch', 'example-api/fixup-903-from-912-x.patch']);
});

test('every committed fixture record validates and re-serializes byte-identically under the additive fields', () => {
  const keys = new Set();
  for (const dir of ['./fixtures/records/', './fixtures/sample-records/c0ffee000001/'].map(d => new URL(d, import.meta.url))) {
    for (const file of readdirSync(dir).filter(f => f.endsWith('.json'))) {
      const text = readFileSync(new URL(file, dir), 'utf8');
      const value = JSON.parse(text);
      assert.deepEqual(validateRecord(value), [], file);
      assert.equal(serializeRecord(value), text, file);
      for (const key of Object.keys(value)) keys.add(key);
    }
  }
  assert.deepEqual([...keys].sort(), ['alias', 'archived', 'card', 'cases', 'decisions', 'effort', 'findings', 'fixups', 'novelty',
    'openDecisions', 'origin', 'priorFindings', 'project', 'refs', 'replayed', 'riskAreas', 'schemaVersion', 'scope', 'size',
    'spikedAt', 'supersededBy', 'timeBox', 'title']);
});

test('impact, status, owner and eliminated validate when present and keep ORDER', () => {
  const full = { ref: 'linear:CRM-1', eliminated: [{ why: 'the frontend passes it', option: 'drop the override' }], owner: 'people', status: 'narrowed', impact: 'design', text: 'Which phone wins.' };
  assert.deepEqual(validateRecord({ ...FULL, openDecisions: [full] }), []);
  assert.deepEqual(Object.keys(canonicalRecord({ ...FULL, openDecisions: [full] }).openDecisions[0]), ['text', 'impact', 'status', 'owner', 'eliminated', 'ref']);
  assert.deepEqual(Object.keys(canonicalRecord({ ...FULL, openDecisions: [full] }).openDecisions[0].eliminated[0]), ['option', 'why']);
  assert.deepEqual(OPEN_DECISION_IMPACTS, ['design', 'detail', 'gate']);
  assert.deepEqual(OPEN_DECISION_STATUSES, ['open', 'narrowed']);
  assert.deepEqual(OPEN_DECISION_OWNERS, ['people', 'code']);
  const table = [
    [{ text: 'x', impact: 'big' }, '$.openDecisions[0].impact'],
    [{ text: 'x', status: 'resolved' }, '$.openDecisions[0].status'],
    [{ text: 'x', owner: 'ai' }, '$.openDecisions[0].owner'],
    [{ text: 'x', eliminated: 'none' }, '$.openDecisions[0].eliminated'],
    [{ text: 'x', eliminated: [{ option: 'a' }] }, '$.openDecisions[0].eliminated[0].why'],
    [{ text: 'x', eliminated: [{ why: 'b' }] }, '$.openDecisions[0].eliminated[0].option'],
  ];
  for (const [item, expected] of table) assert.ok(errorPaths({ ...FULL, openDecisions: [item] }).includes(expected), JSON.stringify(item));
});

test('priorFindings validates outcomes', () => {
  const prior = [{ ref: 'linear:CRM-1', outcome: 'holds', text: 'The route is unused.' }];
  assert.deepEqual(validateRecord({ ...FULL, priorFindings: prior }), []);
  const canon = canonicalRecord({ ...FULL, priorFindings: prior });
  assert.deepEqual(Object.keys(canon.priorFindings[0]), ['text', 'outcome', 'ref']);
  const keys = Object.keys(canon);
  assert.equal(keys[keys.indexOf('findings') + 1], 'priorFindings');
  assert.deepEqual(PRIOR_FINDING_OUTCOMES, ['holds', 'resolved', 'wrong']);
  const table = [
    [{ text: 'x', outcome: 'verdict', ref: 'linear:CRM-1' }, '$.priorFindings[0].outcome'],
    [{ outcome: 'holds', ref: 'linear:CRM-1' }, '$.priorFindings[0].text'],
    [{ text: 'x', outcome: 'holds' }, '$.priorFindings[0].ref'],
    ['x', '$.priorFindings[0]'],
  ];
  for (const [item, expected] of table) assert.ok(errorPaths({ ...FULL, priorFindings: [item] }).includes(expected), JSON.stringify(item));
  assert.ok(errorPaths({ ...FULL, priorFindings: {} }).includes('$.priorFindings'));
});
