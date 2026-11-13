import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../scripts/graph.mjs';
import { fakeLinear, FIXTURE_URL } from './helpers/fake-linear.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'keiron-sequencer-tracer-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

test('the CLI reads a project through Linear and prints its graph as JSON', async () => {
  const { fetchImpl } = fakeLinear();
  const r = await run([FIXTURE_URL], { env: { LINEAR_API_KEY: 'k'.repeat(24) }, keyFile: join(TMP, 'absent.key'), fetchImpl, dataDir: TMP });
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.schemaVersion, 1);
  assert.deepEqual(out.summary, { cards: 12, open: 10, free: 3, blocks: 13, critical: 4, implied: 2, cycles: 0 });
});

test('the next skill calls the CLI in Step 0', () => {
  const skill = readFileSync(new URL('../skills/next/SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /node \$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/graph\.mjs/);
});
