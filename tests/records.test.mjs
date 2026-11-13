import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serializeRecord } from '../scripts/lib/record.mjs';
import { isLive, readRecords, sizeLabel, sizesFor, tiers, verdict } from '../scripts/lib/records.mjs';

const BASE = JSON.parse(readFileSync(new URL('./fixtures/records/ABC-901.json', import.meta.url), 'utf8'));
const TMP = mkdtempSync(join(tmpdir(), 'keiron-sequencer-records-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const rec = (card, { prod = 10, test = 0, origin = 'thin-spike', size = true, ...over } = {}) => ({
  ...BASE,
  card,
  origin,
  size: size ? { ...BASE.size, prodLines: prod, testLines: test } : null,
  cases: [{ ...BASE.cases[0], ref: `linear:${card}` }],
  ...over,
});

let n = 0;
const dirWith = files => {
  const dir = join(TMP, `d${n++}`);
  mkdirSync(dir);
  for (const [name, text] of Object.entries(files)) {
    if (text === null) mkdirSync(join(dir, name));
    else writeFileSync(join(dir, name), typeof text === 'string' ? text : serializeRecord(text));
  }
  return dir;
};

test('the reader returns valid records, and every bad file becomes an invalid entry with a reason without stopping the rest', () => {
  const dir = dirWith({
    'CRM-1.json': rec('CRM-1'),
    'CRM-2.json': '{ not json',
    'CRM-3.json': rec('CRM-3', { origin: 'spike' }),
    'CRM-4.json': rec('CRM-4', { archived: { at: '2026-11-09', reason: 'archived in Linear' } }),
    'CRM-5.json': rec('CRM-6'),
    'CRM-7.json': rec('CRM-7'),
    'notes.txt': 'not a record',
    'superseded': null,
  });
  writeFileSync(join(dir, 'superseded', 'CRM-1.2026-11-01T00:00:00.000Z.json'), serializeRecord(rec('CRM-1')));
  const { records, invalid } = readRecords(dir);
  assert.deepEqual(records.map(r => r.card), ['CRM-1', 'CRM-4', 'CRM-7']);
  assert.deepEqual(invalid.map(i => i.file), ['CRM-2.json', 'CRM-3.json', 'CRM-5.json']);
  for (const i of invalid) {
    assert.ok(i.errors.length > 0, i.file);
    for (const e of i.errors) assert.equal(typeof e, 'string');
  }
  assert.match(invalid[0].errors[0], /JSON/);
  assert.ok(invalid[1].errors.some(e => e.startsWith('$.origin')), invalid[1].errors.join('; '));
  assert.ok(invalid[2].errors.some(e => /CRM-6.*CRM-5\.json/.test(e)), invalid[2].errors.join('; '));
});

test('a JSON file that is not a record object, or that cannot be read, is invalid and never throws', () => {
  const dir = dirWith({ 'CRM-1.json': 'null', 'CRM-2.json': '[]', 'CRM-3.json': '', 'CRM-4.json': rec('CRM-4'), 'CRM-5.json': rec('CRM-5') });
  chmodSync(join(dir, 'CRM-5.json'), 0o000);
  const { records, invalid } = readRecords(dir);
  chmodSync(join(dir, 'CRM-5.json'), 0o644);
  assert.deepEqual(records.map(r => r.card), process.getuid?.() === 0 ? ['CRM-4', 'CRM-5'] : ['CRM-4']);
  assert.deepEqual(invalid.map(i => i.file).slice(0, 3), ['CRM-1.json', 'CRM-2.json', 'CRM-3.json']);
  if (process.getuid?.() !== 0) assert.match(invalid[3].errors[0], /^unreadable: EACCES$/);
});

test('a missing directory, an empty one or a path that is a file gives no records and no invalid entries', () => {
  const file = join(TMP, 'plain-file');
  writeFileSync(file, 'x');
  for (const dir of [join(TMP, 'absent'), dirWith({}), file]) {
    assert.deepEqual(readRecords(dir), { records: [], invalid: [] }, dir);
  }
});

test('isLive excludes archived and superseded records', () => {
  assert.equal(isLive(rec('CRM-1')), true);
  assert.equal(isLive(rec('CRM-1', { archived: { at: '2026-11-09', reason: 'r' } })), false);
  assert.equal(isLive(rec('CRM-1', { supersededBy: { card: 'CRM-1', spikedAt: '2026-11-09T00:00:00.000Z' } })), false);
});

test('eight sized thin-spike cards split 2/2/2/2 by rank, ties broken by card number', () => {
  const records = [80, 10, 20, 20, 50, 60, 70, 40].map((prod, i) => rec(`CRM-${100 - i}`, { prod }));
  assert.deepEqual(Object.fromEntries(tiers(records)), {
    'CRM-99': 'S', 'CRM-97': 'S',
    'CRM-98': 'M', 'CRM-93': 'M',
    'CRM-96': 'L', 'CRM-95': 'L',
    'CRM-94': 'XL', 'CRM-100': 'XL',
  });
});

test('existing-PR, zero-line, sizeless and non-live records get no tier and do not shift the ranks', () => {
  const ranked = [10, 20, 30, 40].map((prod, i) => rec(`CRM-${i + 1}`, { prod }));
  const others = [
    rec('CRM-50', { origin: 'existing-pr', prod: 5000 }),
    rec('CRM-51', { prod: 0, test: 0 }),
    rec('CRM-52', { size: false }),
    rec('CRM-53', { prod: 1, archived: { at: '2026-11-09', reason: 'r' } }),
  ];
  const t = tiers([...others, ...ranked]);
  assert.deepEqual(Object.fromEntries(t), { 'CRM-1': 'S', 'CRM-2': 'M', 'CRM-3': 'L', 'CRM-4': 'XL' });
});

test('there is no minimum population: one sized card is S', () => {
  assert.deepEqual(Object.fromEntries(tiers([rec('CRM-1', { prod: 7 })])), { 'CRM-1': 'S' });
  assert.equal(tiers([]).size, 0);
});

test('tiers and sizesFor do not mutate the records and write nothing', () => {
  const dir = dirWith({ 'CRM-1.json': rec('CRM-1'), 'CRM-2.json': rec('CRM-2', { prod: 40 }) });
  const { records } = readRecords(dir);
  const before = JSON.stringify(records);
  tiers(records);
  sizesFor(records);
  assert.equal(JSON.stringify(records), before);
  assert.deepEqual(readdirSync(dir).sort(), ['CRM-1.json', 'CRM-2.json']);
});

test('sizesFor covers live records with a size only, with tier, lines, origin, label and verdict', () => {
  const records = [
    rec('CRM-1', { prod: 300, test: 112 }),
    rec('CRM-2', { origin: 'existing-pr', prod: 1000, test: 109 }),
    rec('CRM-3', { prod: 0, test: 0 }),
    rec('CRM-4', { size: false }),
    rec('CRM-5', { prod: 5, archived: { at: '2026-11-09', reason: 'r' } }),
  ];
  assert.deepEqual(sizesFor(records), {
    'CRM-1': { tier: 'S', lines: 412, origin: 'thin-spike', label: 'S · 412 lines', verdict: 'unknown' },
    'CRM-2': { tier: null, lines: 1109, origin: 'existing-pr', label: '1109 lines · existing PR', verdict: 'unknown' },
    'CRM-3': { tier: null, lines: 0, origin: 'thin-spike', label: '0 lines', verdict: 'unknown' },
  });
});

test('sizeLabel reads "L · 412 lines", "1109 lines · existing PR" or "0 lines"', () => {
  assert.equal(sizeLabel({ tier: 'L', lines: 412, origin: 'thin-spike' }), 'L · 412 lines');
  assert.equal(sizeLabel({ tier: null, lines: 1109, origin: 'existing-pr' }), '1109 lines · existing PR');
  assert.equal(sizeLabel({ tier: null, lines: 0, origin: 'thin-spike' }), '0 lines');
});

const inputs = ({ risk = [], open = [], newPaths = [], received = 0, caused = 0 } = {}) => ({
  ...BASE,
  riskAreas: risk.map(kind => ({ kind, paths: [`backend/${kind}.ts`] })),
  openDecisions: open.map(text => ({ text })),
  novelty: { newPaths },
  fixups: {
    received: Array.from({ length: received }, (_, i) => ({ from: `CRM-${50 + i}`, patch: `backend/fixup-${i}.patch`, note: null })),
    caused: Array.from({ length: caused }, (_, i) => ({ to: `CRM-${60 + i}`, patch: `backend/fixup-c${i}.patch`, note: null })),
  },
});
const without = (record, ...keys) => Object.fromEntries(Object.entries(record).filter(([k]) => !keys.includes(k)));

test('verdict: SDD for a design open decision or XL; Light for L, two fixups or a new top-level path; else No SDD; risk areas never count', () => {
  const table = [
    ['neither field', without(BASE, 'riskAreas', 'openDecisions', 'novelty'), 'S', 'unknown'],
    ['novelty absent', without(inputs(), 'novelty'), 'S', 'unknown'],
    ['openDecisions absent', without(inputs(), 'openDecisions'), 'XL', 'unknown'],
    ['riskAreas absent', without(inputs(), 'riskAreas'), 'XL', 'SDD'],
    ['open decision at S', inputs({ open: ['guess'] }), 'S', 'SDD'],
    ['risk area at M', inputs({ risk: ['migrations'] }), 'M', 'No SDD'],
    ['XL with all empty', inputs(), 'XL', 'SDD'],
    ['L alone', inputs(), 'L', 'Light'],
    ['1 received + 1 caused at M', inputs({ received: 1, caused: 1 }), 'M', 'Light'],
    ['new path at S', inputs({ newPaths: ['backend/newsvc/'] }), 'S', 'Light'],
    ['new path and a risk area', inputs({ newPaths: ['backend/newsvc/'], risk: ['authorization'] }), 'S', 'Light'],
    ['L and a risk area', inputs({ risk: ['authorization'] }), 'L', 'Light'],
    ['one fixup at S', inputs({ received: 1 }), 'S', 'No SDD'],
    ['tier null, empty', inputs(), null, 'No SDD'],
    ['tier null, new path', inputs({ newPaths: ['backend/README2.md'] }), null, 'Light'],
    ['tier null, open decision', inputs({ open: ['guess'] }), null, 'SDD'],
  ];
  for (const [name, record, tier, expected] of table) assert.equal(verdict(record, tier), expected, name);
});

test('verdict is pure: the record is deep-equal before and after', () => {
  const r = inputs({ risk: ['migrations'], newPaths: ['backend/x/'], received: 2 });
  const before = structuredClone(r);
  verdict(r, 'L');
  verdict(without(r, 'novelty'), 'S');
  assert.deepEqual(r, before);
});

test('sizesFor gives each entry the verdict computed with its tier; an old record is unknown', () => {
  const records = [
    { ...inputs(), card: 'CRM-1', size: { ...BASE.size, prodLines: 10, testLines: 0 }, cases: [{ ...BASE.cases[0], ref: 'linear:CRM-1' }] },
    { ...inputs({ open: ['guess'] }), card: 'CRM-2', size: { ...BASE.size, prodLines: 20, testLines: 0 }, cases: [{ ...BASE.cases[0], ref: 'linear:CRM-2' }] },
    { ...inputs(), card: 'CRM-3', size: { ...BASE.size, prodLines: 30, testLines: 0 }, cases: [{ ...BASE.cases[0], ref: 'linear:CRM-3' }] },
    { ...inputs(), card: 'CRM-4', size: { ...BASE.size, prodLines: 40, testLines: 0 }, cases: [{ ...BASE.cases[0], ref: 'linear:CRM-4' }] },
    rec('CRM-5', { prod: 1 }),
  ];
  const sizes = sizesFor(records);
  assert.deepEqual(Object.fromEntries(Object.entries(sizes).map(([k, v]) => [k, [v.tier, v.verdict]])), {
    'CRM-1': ['S', 'No SDD'], 'CRM-2': ['M', 'SDD'], 'CRM-3': ['L', 'Light'], 'CRM-4': ['XL', 'SDD'], 'CRM-5': ['S', 'unknown'],
  });
  assert.equal(sizes['CRM-3'].label, 'L · 30 lines');
});

test('readRecords ignores the spike history subdirectory: an old record there is neither returned nor invalid', () => {
  const dir = dirWith({ 'CRM-5.json': rec('CRM-5'), spike: null });
  mkdirSync(join(dir, 'spike', 'history', 'CRM-5'), { recursive: true });
  writeFileSync(join(dir, 'spike', 'history', 'CRM-5', 'old.json'), serializeRecord(rec('CRM-5', { prod: 99 })));
  writeFileSync(join(dir, 'spike', 'history', 'CRM-5', 'broken.json'), '{ not json');
  const { records, invalid } = readRecords(dir);
  assert.deepEqual(records.map(r => [r.card, r.size.prodLines]), [['CRM-5', 10]]);
  assert.deepEqual(invalid, []);
});

test('riskAreas alone no longer make a card SDD', () => {
  assert.equal(verdict(inputs({ risk: ['authorization'] }), 'S'), 'No SDD');
  assert.equal(verdict(inputs({ risk: ['migrations'] }), 'L'), 'Light');
  assert.equal(verdict(without(inputs(), 'riskAreas'), 'S'), 'No SDD');
});

test('only design-impact open decisions count; an untagged one counts as design', () => {
  const tagged = impact => ({ ...inputs(), openDecisions: [{ text: 'which flag gates it', ...(impact ? { impact } : {}) }] });
  assert.equal(verdict(tagged('detail'), 'S'), 'No SDD');
  assert.equal(verdict(tagged('detail'), 'L'), 'Light');
  assert.equal(verdict(tagged('design'), 'S'), 'SDD');
  assert.equal(verdict(tagged(null), 'S'), 'SDD');
});
