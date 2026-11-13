import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as backfill from '../scripts/backfill/size.mjs';
import * as lib from '../scripts/lib/patch-stats.mjs';

test('size.mjs re-exports the shared patch-stats functions, so live and backfill sizes come from one implementation', () => {
  assert.equal(backfill.patchStats, lib.patchStats);
  assert.equal(backfill.roundHalfEven, lib.roundHalfEven);
  assert.equal(backfill.cardSizes, lib.cardSizes);
});
