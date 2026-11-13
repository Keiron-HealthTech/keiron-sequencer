import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateRecord } from '../scripts/lib/record.mjs';
import { readRecords, sizeLabel, sizesFor, tiers } from '../scripts/lib/records.mjs';

const FIXTURES = fileURLToPath(new URL('./fixtures/records/', import.meta.url));

test('the reader loads the ABC-903 record as valid and the read-time tier covers it', () => {
  const { records, invalid } = readRecords(FIXTURES);
  assert.deepEqual(invalid, []);
  const r = records.find(x => x.card === 'ABC-903');
  assert.ok(r, 'ABC-903 not read');
  assert.equal(r.size.prodLines, 113);
  assert.ok(['S', 'M', 'L', 'XL'].includes(tiers(records).get('ABC-903')));
});

const fixture = JSON.parse(readFileSync(new URL('./fixtures/records/ABC-903.json', import.meta.url), 'utf8'));

test('a record that stores a tier is rejected because the tier is computed at read time', () => {
  assert.deepEqual(validateRecord(fixture), []);
  for (const bad of [{ ...fixture, tier: 'L' }, { ...fixture, size: { ...fixture.size, tier: 'XL' } }]) {
    const errors = validateRecord(bad);
    assert.equal(errors.length, 1, JSON.stringify(errors));
    assert.match(errors[0], /tier is computed at read time/);
  }
});

test('sizesFor gives ABC-903 its tier, lines, an "L · N lines" label and, as an old record, verdict unknown', () => {
  const { records } = readRecords(FIXTURES);
  assert.deepEqual(sizesFor(records)['ABC-903'], { tier: 'L', lines: 164, origin: 'thin-spike', label: 'L · 164 lines', verdict: 'unknown' });
  assert.equal(sizeLabel({ tier: 'S', lines: 20, origin: 'thin-spike' }), 'S · 20 lines');
});
