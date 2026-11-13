import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../scripts/spike.mjs';
import { scanPatch, SECRET_KINDS } from '../scripts/lib/spike/secrets.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import { notes, PROJECT_URL, SLUG, spikeFixture, walk } from './helpers/spike-fixture.mjs';

guardNetwork();

// Assembled here so no secret-shaped literal is ever committed.
const FAKE = {
  'private-key': `-----BEGIN ${'RSA PRIVATE'} KEY-----`,
  'aws-access-key': `AKIA${'Q'.repeat(16)}`,
  'github-token': `gh${'p'}_${'a'.repeat(36)}`,
  'linear-key': `lin_${'api'}_${'b'.repeat(32)}`,
  'slack-token': `xo${'xb'}-${'1234567890'}`,
  assignment: `password = "${'c'.repeat(14)}"`,
};

const added = (path, lines, { from = 1, mode = null } = {}) => [
  `diff --git a/${path} b/${path}`,
  ...(mode === 'new' ? ['new file mode 100644', '--- /dev/null'] : [`--- a/${path}`]),
  `+++ b/${path}`,
  `@@ -${from},1 +${from},${lines.length + 1} @@`,
  ' context line',
  ...lines.map(l => `+${l}`),
].join('\n');

test('every kind hits on an added line, with its path and new-file line number, and never carries the value', () => {
  assert.deepEqual(SECRET_KINDS, ['private-key', 'aws-access-key', 'github-token', 'linear-key', 'slack-token', 'assignment', 'secret-file']);
  for (const [kind, value] of Object.entries(FAKE)) {
    const hits = scanPatch(added('src/config.js', ['const ok = 1', `const x = '${value}'`], { from: 10 }));
    assert.deepEqual(hits, [{ path: 'src/config.js', line: 12, kind }], kind);
    assert.equal(JSON.stringify(hits).includes(value), false);
  }
  assert.deepEqual(scanPatch(added('src/a.js', [`API_KEY: '${'d'.repeat(20)}'`])), [{ path: 'src/a.js', line: 2, kind: 'assignment' }]);
});

test('removed and context lines never hit, and a short or unquoted assignment is not a secret', () => {
  const patch = [
    'diff --git a/src/a.js b/src/a.js', '--- a/src/a.js', '+++ b/src/a.js', '@@ -1,3 +1,3 @@',
    ` ${FAKE['aws-access-key']}`, `-${FAKE['github-token']}`, '+const token = "short"', '+const secret = process.env.SECRET_VALUE_FROM_ENV',
  ].join('\n');
  assert.deepEqual(scanPatch(patch), []);
});

test('secret files hit by name: .env and .env.* but not .env.example, *.pem and id_rsa*', () => {
  const hits = ['.env', 'app/.env.local', '.env.example', 'certs/server.pem', 'keys/id_rsa', 'src/env.js']
    .flatMap(p => scanPatch(added(p, ['A=1'], { mode: 'new' })));
  assert.deepEqual(hits, [
    { path: '.env', line: 2, kind: 'secret-file' },
    { path: 'app/.env.local', line: 2, kind: 'secret-file' },
    { path: 'certs/server.pem', line: 2, kind: 'secret-file' },
    { path: 'keys/id_rsa', line: 2, kind: 'secret-file' },
  ]);
  const deleted = ['diff --git a/.env b/.env', 'deleted file mode 100644', '--- a/.env', '+++ /dev/null', '@@ -1 +0,0 @@', '-A=1'].join('\n');
  assert.deepEqual(scanPatch(deleted), []);
});

test('an allow entry drops exactly the hits of its kind and path', () => {
  const patch = [added('src/a.js', [FAKE['aws-access-key'], FAKE['linear-key']]), added('src/b.js', [FAKE['aws-access-key']])].join('\n');
  assert.deepEqual(scanPatch(patch, [{ kind: 'aws-access-key', path: 'src/a.js' }]), [
    { path: 'src/a.js', line: 3, kind: 'linear-key' },
    { path: 'src/b.js', line: 2, kind: 'aws-access-key' },
  ]);
  assert.deepEqual(scanPatch(added('src/clean.js', ['export const one = 1'])), []);
});

async function cardWithSecret() {
  const fixture = spikeFixture();
  const { deps, home, at } = fixture;
  const { runId } = JSON.parse((await run(['begin', PROJECT_URL], deps)).stdout);
  const dir = join(home, SLUG, 'runs', runId);
  at('2026-11-10T10:01:00.000Z');
  await run(['next'], deps);
  const tree = JSON.parse((await run(['tree', 'backend'], deps)).stdout).path;
  writeFileSync(join(tree, 'src', 'index.js'), `export const one = 1\nexport const key = '${FAKE['aws-access-key']}'\n`);
  mkdirSync(join(dir, 'notes'), { recursive: true });
  writeFileSync(join(dir, 'notes', 'CRM-1.json'), JSON.stringify(notes));
  at('2026-11-10T10:05:00.000Z');
  return { ...fixture, dir };
}

test('end on a patch with a secret exits 4 naming patch, path, line and kind, writes no patch and does not move last', async () => {
  const { deps, dir, dataDir } = await cardWithSecret();
  const before = readFileSync(join(dir, 'run.json'), 'utf8');
  const r = await run(['end', 'CRM-1'], deps);
  assert.equal(r.code, 4);
  assert.deepEqual(JSON.parse(r.stdout), {
    action: 'secret', hits: [{ patch: 'backend/00001-new.patch', path: 'src/index.js', line: 2, kind: 'aws-access-key' }],
  });
  assert.match(r.stderr, /--allow aws-access-key:src\/index\.js/);
  assert.equal(`${r.stdout}${r.stderr}`.includes(FAKE['aws-access-key']), false);
  assert.deepEqual(walk(join(dir, 'patches')), []);
  assert.deepEqual(walk(dataDir), []);
  assert.equal(readFileSync(join(dir, 'run.json'), 'utf8'), before);
});

test('--allow kind:path accepts a false positive and records it in the run state', async () => {
  const { deps, dir } = await cardWithSecret();
  const r = await run(['end', 'CRM-1', '--allow', 'aws-access-key:src/index.js'], deps);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(walk(join(dir, 'patches')), ['backend/00001-new.patch']);
  const state = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
  assert.deepEqual(state.cards['CRM-1'].allowedSecrets, [{ patch: 'backend/00001-new.patch', path: 'src/index.js', line: 2, kind: 'aws-access-key' }]);
  const bad = await run(['end', 'CRM-1', '--allow', 'nonsense'], deps);
  assert.equal(bad.code, 2);
});
