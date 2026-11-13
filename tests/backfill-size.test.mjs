import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardSizes, patchStats, roundHalfEven } from '../scripts/backfill/size.mjs';

const diff = (file, body) => [
  `diff --git a/${file} b/${file}`, 'index 1111111..2222222 100644', `--- a/${file}`, `+++ b/${file}`, '@@ -1,4 +1,10 @@', ...body,
].join('\n');
const lines = (sign, n) => Array.from({ length: n }, (_, i) => `${sign}line ${i}`);

test('added lines weigh 1 and removed lines 0.25, before any rounding', () => {
  assert.deepEqual(patchStats(`${diff('src/a.ts', [...lines('+', 10), ...lines('-', 4), ' context'])}\n`), { prod: 11, test: 0, files: ['src/a.ts'] });
  assert.deepEqual(patchStats(diff('src/a.ts', lines('-', 3))), { prod: 0.75, test: 0, files: ['src/a.ts'] });
});

test('files matching the test-path regex go to the test bucket', () => {
  for (const file of ['src/a.spec.ts', 'src/a.integration-spec.ts', 'pkg/a_test.go', 'src/__tests__/a.tsx', 'src/a.test.js']) {
    assert.deepEqual(patchStats(diff(file, lines('+', 2))), { prod: 0, test: 2, files: [file] }, file);
  }
  for (const file of ['src/spec/helper.ts', 'pkg/a_test.go.orig', 'src/testing.ts']) {
    assert.equal(patchStats(diff(file, lines('+', 2))).prod, 2, file);
  }
});

test('headers, hunk markers and no-newline notes are not counted; build.py quirks are kept', () => {
  assert.equal(patchStats(diff('a.ts', ['\\ No newline at end of file', '+x'])).prod, 1);
  assert.equal(patchStats(diff('a.ts', ['---removed line starting with dashes', '+++added line starting with pluses', '+x'])).prod, 1);
  assert.equal(patchStats(['+a', '-b'].join('\n')).prod, 1.25);
  assert.equal(patchStats(diff('a.ts', ['+a\r+b\r\n+c'])).prod, 3);
});

test('binary and rename-only diffs count the file with zero lines', () => {
  const binary = ['diff --git a/img.png b/img.png', 'new file mode 100644', 'index 0000000..3333333', 'GIT binary patch', 'literal 5', 'zcmV-+0BV', '', 'literal 0', 'HcmV?d00001', ''].join('\n');
  const rename = ['diff --git a/old.ts b/new.ts', 'similarity index 100%', 'rename from old.ts', 'rename to new.ts', ''].join('\n');
  assert.deepEqual(patchStats(binary), { prod: 0, test: 0, files: ['img.png'] });
  assert.deepEqual(patchStats(rename), { prod: 0, test: 0, files: ['new.ts'] });
});

test('roundHalfEven matches Python round()', () => {
  assert.deepEqual([0.5, 1.5, 2.5, 3.5, 0.25, 0.75, 2.625, 10.125, 7].map(roundHalfEven), [0, 2, 2, 4, 0, 1, 3, 10, 7]);
});

const synthetic = patches => ({
  repos: { backend: 'example-api', frontend: 'example-web', perms: 'example-auth' },
  patches,
  cards: { 'CRM-7': {} },
});
const PATCHES = {
  'backend/01-new.patch': diff('src/a.ts', [...lines('+', 10), ...lines('-', 2)]),
  'frontend/01-new.patch': [diff('src/a.ts', lines('+', 3)), diff('src/b.spec.ts', lines('+', 5))].join('\n'),
  'backend/02-03-shared.patch': [diff('src/s.ts', lines('+', 41)), diff('src/s.spec.ts', lines('+', 3))].join('\n'),
  'backend/03-new.patch': diff('src/c.ts', lines('+', 1)),
  'backend/fixup-3-from-1-x.patch': diff('src/c.ts', lines('+', 100)),
};
const readSynthetic = path => PATCHES[path];

test('a card with patches in two repos gets sorted repos, the file union and rounded totals', () => {
  const sizes = cardSizes(synthetic({
    'frontend/01-new.patch': { kind: 'card', cards: ['CRM-1'] },
    'backend/01-new.patch': { kind: 'card', cards: ['CRM-1'] },
  }), readSynthetic);
  assert.deepEqual(sizes['CRM-1'], {
    prodLines: 14, testLines: 5, files: 2, repos: ['example-api', 'example-web'], sharedWith: [], deletionWeight: 0.25,
  });
});

test('a shared patch gives each card exactly half, rounded half-even, and names the other card', () => {
  const sizes = cardSizes(synthetic({
    'backend/02-03-shared.patch': { kind: 'card', cards: ['CRM-2', 'CRM-3'] },
    'backend/03-new.patch': { kind: 'card', cards: ['CRM-3'] },
  }), readSynthetic);
  assert.deepEqual(sizes['CRM-2'], { prodLines: 20, testLines: 2, files: 2, repos: ['example-api'], sharedWith: ['CRM-3'], deletionWeight: 0.25 });
  assert.deepEqual(sizes['CRM-3'], { prodLines: 22, testLines: 2, files: 3, repos: ['example-api'], sharedWith: ['CRM-2'], deletionWeight: 0.25 });
  const total = patchStats(PATCHES['backend/02-03-shared.patch']);
  assert.equal(total.prod / 2 + total.prod / 2, total.prod);
});

test('fixup and skip lines never count; a mapped card with no card patch has size null', () => {
  const sizes = cardSizes(synthetic({
    'backend/03-new.patch': { kind: 'card', cards: ['CRM-3'] },
    'backend/fixup-3-from-1-x.patch': { kind: 'fixup', fixed: ['CRM-3'], from: 'CRM-1' },
    'backend/01-new.patch': { kind: 'skip', replacedBy: 'backend/03-new.patch', reason: 'r' },
  }), readSynthetic);
  assert.deepEqual(Object.keys(sizes), ['CRM-3', 'CRM-7']);
  assert.equal(sizes['CRM-3'].prodLines, 1);
  assert.equal(sizes['CRM-7'], null);
});
