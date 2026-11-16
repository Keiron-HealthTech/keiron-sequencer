import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeNextFixture } from './helpers/next-fixture.mjs';

test('the CLI reads a project through Linear, GitHub and git, and prints the free cards as JSON', async t => {
  const f = fakeNextFixture();
  t.after(f.dispose);
  const r = await f.run();
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.schemaVersion, 1);
  assert.deepEqual(out.free.map(c => c.key), ['ABC-1']);
});

test('the next skill calls the CLI in Step 0', () => {
  const skill = readFileSync(new URL('../skills/next/SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /node \$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/next\.mjs/);
});
