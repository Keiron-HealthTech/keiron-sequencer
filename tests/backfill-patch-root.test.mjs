import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRecords, checkRecords, defaultPatchRoot, writeRecords } from '../scripts/backfill/build-records.mjs';
import { run as renameTrialDirs } from '../scripts/maintenance/rename-trial-dirs.mjs';
import { listPatches } from '../scripts/backfill/patch-map.mjs';
import { trialPatchRoot } from '../scripts/lib/spike/home.mjs';
import { validateRecord } from '../scripts/lib/record.mjs';
import { MINI, MINI_LINEAR, MINI_PATCHES, materialize } from './helpers/trial-patches.mjs';

const tmp = prefix => mkdtempSync(join(tmpdir(), `keiron-sequencer-patch-root-${prefix}-`));

const withRoot = (fn, patches) => {
  const root = materialize(patches);
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test('tracer: the mini trial builds its records from a patch root outside the repo', () => {
  withRoot(root => {
    const built = buildRecords({ trialDir: MINI, patchRoot: root, linearSnapshot: MINI_LINEAR });
    assert.deepEqual([...built.keys()], ['CRM-1', 'CRM-2', 'CRM-3']);
  });
});

const PATCH_PATH = /^[^/\s]+\/[^/\s]+\.patch$/;
const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const record = (built, card) => JSON.parse(built.get(card));
const withTmp = (prefix, fn) => {
  const dir = tmp(prefix);
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('the mini trial builds the same bytes from two separate patch roots, and every record is valid', () => {
  const a = withRoot(root => buildRecords({ trialDir: MINI, patchRoot: root, linearSnapshot: MINI_LINEAR }));
  const b = withRoot(root => buildRecords({ trialDir: MINI, patchRoot: root, linearSnapshot: MINI_LINEAR }));
  assert.deepEqual([...a], [...b]);
  for (const card of a.keys()) assert.deepEqual(validateRecord(record(a, card)), [], card);
  assert.deepEqual(record(a, 'CRM-1').size.repos, ['example-api', 'example-web']);
  assert.equal(record(a, 'CRM-1').size.testLines, 2);
  assert.deepEqual(record(a, 'CRM-1').fixups.received.map(f => f.from), ['CRM-3']);
  assert.equal(record(a, 'CRM-2').origin, 'existing-pr');
  assert.equal(record(a, 'CRM-2').effort, null);
  assert.equal(record(a, 'CRM-3').scope.complete, false);
});

test('a stray patch in the patch root fails the build, naming the patch', () => {
  withRoot(root => {
    assert.throws(() => buildRecords({ trialDir: MINI, patchRoot: root, linearSnapshot: MINI_LINEAR }), /api\/09999-stray\.patch: not mapped/);
  }, { ...MINI_PATCHES, 'api/09999-stray.patch': 'diff --git a/x b/x\n+x\n' });
});

test('every refs.patches value is one repo dir and one file, found in the patch root', () => {
  withRoot(root => {
    const built = buildRecords({ trialDir: MINI, patchRoot: root, linearSnapshot: MINI_LINEAR });
    const refs = [...built.keys()].flatMap(card => record(built, card).refs.patches);
    assert.ok(refs.length >= 4);
    for (const ref of refs) {
      assert.match(ref, PATCH_PATH);
      assert.ok(existsSync(join(root, ref)), ref);
    }
  });
});

test('the fixture patches are JSON strings: no file under tests/fixtures is a .patch file', () => {
  assert.ok(Object.values(MINI_PATCHES).every(text => typeof text === 'string' && text.startsWith('diff --git ')));
  const files = readdirSync(FIXTURES, { recursive: true });
  assert.deepEqual(files.filter(f => String(f).endsWith('.patch')), []);
});

test('the default patch root is the trial dir while it holds patches, else <home>/<slug>/<trial dir>', () => {
  withTmp('trial', trial => {
    assert.equal(defaultPatchRoot(trial, 'mini00000001', { home: '/nowhere' }), trialPatchRoot('/nowhere', 'mini00000001'));
    mkdirSync(join(trial, 'api'));
    writeFileSync(join(trial, 'api', '00001-new.patch'), MINI_PATCHES['api/00001-new.patch']);
    assert.equal(defaultPatchRoot(trial, 'mini00000001', { home: '/nowhere' }), trial);
  });
});

test('with no patch root given, the build reads the trial patches from the home', () => {
  withTmp('home', home => {
    const root = trialPatchRoot(home, 'mini00000001');
    for (const [path, text] of Object.entries(MINI_PATCHES)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    const fromHome = buildRecords({ trialDir: MINI, linearSnapshot: MINI_LINEAR, home });
    const given = buildRecords({ trialDir: MINI, patchRoot: root, linearSnapshot: MINI_LINEAR });
    assert.deepEqual([...fromHome], [...given]);
  });
});

test('a patch root that does not exist fails the build, naming it and the --patches flag', () => {
  withTmp('home', home => {
    const root = trialPatchRoot(home, 'mini00000001');
    assert.throws(() => buildRecords({ trialDir: MINI, linearSnapshot: MINI_LINEAR, home }), err => {
      assert.ok(err.message.includes(root), err.message);
      assert.match(err.message, /--patches/);
      return true;
    });
  });
});

test('the mini trial builds the same records before the rename, after apply and after inverse, each matching that state', async () => {
  const [home, data, a, b] = ['home', 'data', 'a', 'b'].map(tmp);
  try {
    const slug = 'mini00000001';
    const root = trialPatchRoot(home, slug);
    for (const [path, text] of Object.entries(MINI_PATCHES)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    const records = join(data, slug);
    const build = () => buildRecords({ trialDir: MINI, patchRoot: root, linearSnapshot: MINI_LINEAR });
    const twice = () => {
      writeRecords(a, build());
      writeRecords(b, build());
      const listing = dir => readdirSync(dir).sort().map(f => [f, readFileSync(join(dir, f), 'utf8')]);
      assert.deepEqual(listing(a), listing(b));
      return build();
    };
    const rename = (...flags) => renameTrialDirs([...flags, '--home', home, '--data', data, '--trial', MINI], { env: {} });

    const start = twice();
    writeRecords(records, start);
    assert.deepEqual(checkRecords(records, start), []);

    const applied = await rename('--apply');
    assert.equal(applied.code, 0, applied.stderr);
    assert.deepEqual(readdirSync(root).sort(), ['dirs.json', 'example-api', 'example-web']);
    const after = twice();
    assert.deepEqual(checkRecords(records, after), []);
    assert.deepEqual(record(after, 'CRM-1').refs.patches, ['example-api/00001-new.patch', 'example-web/00001-new.patch']);
    assert.deepEqual(record(after, 'CRM-1').fixups.received.map(f => f.patch), ['example-api/fixup-1-from-3-shared-helper.patch']);
    assert.deepEqual(listPatches(root), Object.keys(MINI_PATCHES).sort());
    for (const card of after.keys()) assert.deepEqual(record(after, card).size, record(start, card).size, card);

    const back = await rename('--inverse', '--apply');
    assert.equal(back.code, 0, back.stderr);
    assert.deepEqual([...twice()], [...start]);
    assert.deepEqual(checkRecords(records, start), []);
  } finally {
    for (const dir of [home, data, a, b]) rmSync(dir, { recursive: true, force: true });
  }
});
