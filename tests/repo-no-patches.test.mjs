import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

test('no tracked file in the repo is a .patch file', () => {
  const run = spawnSync('git', ['-C', ROOT, 'ls-files', '-z', '--', '*.patch'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.stdout.split('\0').filter(Boolean), []);
});
