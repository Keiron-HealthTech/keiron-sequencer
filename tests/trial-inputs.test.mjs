import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

test('patches are stored byte-for-byte: .gitattributes marks *.patch as -text', () => {
  const path = join(ROOT, '.gitattributes');
  assert.ok(existsSync(path), '.gitattributes missing');
  assert.ok(readFileSync(path, 'utf8').split('\n').map(l => l.trim()).includes('*.patch -text'));
});
