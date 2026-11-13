import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { guardNetwork } from './helpers/no-network.mjs';

guardNetwork();

const TESTS = new URL('./', import.meta.url);
const GUARDED = /^(harvest.*|spike.*|respike.*|maintenance.*|start.*|linear-write|patch-dirs|no-network-guard|plugin-manifest|move-home|rewrite-markers|skill-lint|backfill-build)\.test\.mjs$/;

const unguarded = source =>
  !/^import \{[^}]*\bguardNetwork\b[^}]*\} from '\.\/helpers\/no-network\.mjs';$/m.test(source) || !/^guardNetwork\(\);$/m.test(source);

test('the coverage check flags a test file that does not import and call guardNetwork', () => {
  assert.equal(unguarded("import { test } from 'node:test';\n"), true);
  assert.equal(unguarded("import { guardNetwork } from './helpers/no-network.mjs';\n"), true);
  assert.equal(unguarded("import { guardNetwork } from './helpers/no-network.mjs';\n\nguardNetwork();\n"), false);
});

test('every harvest, spike, respike, maintenance, start and linear-write test file imports guardNetwork and calls it at the top level', () => {
  const files = readdirSync(TESTS).filter(f => GUARDED.test(f)).sort();
  assert.ok(files.length >= 10, `expected the harvest test files, found ${files.join(', ')}`);
  const missing = files.filter(f => unguarded(readFileSync(new URL(f, TESTS), 'utf8')));
  assert.deepEqual(missing, []);
});

test('every respike test file is in the guarded set', () => {
  const respike = readdirSync(TESTS).filter(f => /^respike.*\.test\.mjs$/.test(f));
  assert.ok(respike.length >= 1);
  assert.deepEqual(respike.filter(f => !GUARDED.test(f)), []);
});

test('the patch-dirs test file is in the guarded set', () => {
  assert.ok(readdirSync(TESTS).includes('patch-dirs.test.mjs'));
  assert.equal(GUARDED.test('patch-dirs.test.mjs'), true);
});

test('the plugin manifest, move-home, rewrite-markers, skill-lint and backfill-build test files are in the guarded set', () => {
  for (const name of ['plugin-manifest', 'move-home', 'rewrite-markers', 'skill-lint', 'backfill-build']) {
    assert.ok(readdirSync(TESTS).includes(`${name}.test.mjs`), name);
    assert.equal(GUARDED.test(`${name}.test.mjs`), true, name);
  }
});

const PLANNING_ID = [/\b(P-)?CRM-\d+\b/i, /\b(PK|MP|HM|MR|TH|KX)-\d+\b/];
const planningIds = text => PLANNING_ID.flatMap(re => text.match(new RegExp(re.source, re.flags + 'g')) ?? []);

test('the planning-id check catches card and requirement ids and passes neutral fixture keys', () => {
  for (const id of ['CRM' + '-12', 'p-crm' + '-12', 'HM' + '-2', 'KX' + '-6']) assert.notDeepEqual(planningIds(`a ${id} b`), [], id);
  for (const text of ['ABC-1', 'k1', 'CRM-XXXX', 'trial-p-crm-x', 'HMAC-1']) assert.deepEqual(planningIds(text), [], text);
});

test('the files this plugin added name no planning or requirement id', () => {
  const added = [
    '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', 'hooks/hooks.json', 'hooks/register.tsx', 'types/index.d.ts',
    'scripts/maintenance/move-home.mjs', 'scripts/maintenance/rewrite-markers.mjs',
    'tests/move-home.test.mjs', 'tests/rewrite-markers.test.mjs', 'tests/plugin-manifest.test.mjs', 'tests/backfill-build.test.mjs',
    'tests/metro.test.tsx', 'tests/no-network-guard.test.mjs',
  ];
  const hits = added.flatMap(f => planningIds(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')).map(id => `${f}: ${id}`));
  assert.deepEqual(hits, []);
});

test('guardNetwork makes the global fetch throw and restores the previous fetch after the test that called it', async t => {
  const previous = globalThis.fetch;
  await t.test('guarded', () => {
    globalThis.fetch = previous;
    guardNetwork();
    assert.notEqual(globalThis.fetch, previous);
    assert.throws(() => globalThis.fetch('https://api.linear.app/graphql'), /network disabled/);
  });
  assert.equal(globalThis.fetch, previous);
});
