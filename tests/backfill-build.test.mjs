import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRecords, checkRecords, spikedCards, writeRecords } from '../scripts/backfill/build-records.mjs';
import { TRIAL_DIR } from '../scripts/lib/spike/home.mjs';
import { MINI, MINI_LINEAR, materialize } from './helpers/trial-patches.mjs';
import { guardNetwork } from './helpers/no-network.mjs';

guardNetwork();

const SCRIPT = fileURLToPath(new URL('../scripts/backfill/build-records.mjs', import.meta.url));
const MAP = JSON.parse(readFileSync(join(MINI, 'backfill/patch-map.json'), 'utf8'));
const CARDS = spikedCards(MAP);

const tmp = prefix => mkdtempSync(join(tmpdir(), `keiron-sequencer-build-${prefix}-`));
const listing = dir => Object.fromEntries(readdirSync(dir).sort().map(f => [f, readFileSync(join(dir, f), 'utf8')]));
const asFiles = built => Object.fromEntries([...built].map(([card, text]) => [`${card}.json`, text]));
const withTmp = (prefixes, fn) => {
  const dirs = prefixes.map(tmp);
  try {
    return fn(...dirs);
  } finally {
    dirs.forEach(d => rmSync(d, { recursive: true, force: true }));
  }
};
const withPatches = fn => {
  const root = materialize();
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};
const build = root => buildRecords({ trialDir: MINI, patchRoot: root, linearSnapshot: MINI_LINEAR });

test('one broken curated file fails the build, names the file, and leaves the output directory unchanged', () => {
  withTmp(['trial', 'out'], (trial, out) => withPatches(root => {
    cpSync(MINI, trial, { recursive: true });
    const [card] = CARDS;
    const file = join(trial, `backfill/curated/${card}.json`);
    const curated = JSON.parse(readFileSync(file, 'utf8'));
    curated.cases[0].given = '';
    writeFileSync(file, JSON.stringify(curated));
    writeFileSync(join(out, `${card}.json`), 'previous\n');
    const before = listing(out);
    assert.throws(
      () => writeRecords(out, buildRecords({ trialDir: trial, patchRoot: root, linearSnapshot: MINI_LINEAR })),
      new RegExp(`${card}[\\s\\S]*cases\\[0\\]\\.given`),
    );
    assert.deepEqual(listing(out), before);
  }));
});

test('write mode writes exactly the records and removes a stale card file; two runs are byte-identical', () => {
  withTmp(['a', 'b'], (a, b) => withPatches(root => {
    writeFileSync(join(a, 'ABC-9999.json'), '{}\n');
    writeRecords(a, build(root));
    writeRecords(b, build(root));
    assert.deepEqual(readdirSync(a).sort(), CARDS.map(c => `${c}.json`));
    assert.deepEqual(listing(a), listing(b));
    assert.deepEqual(listing(a), asFiles(build(root)));
  }));
});

test('every live fixture record carries at least one case with a source and a ref', () => {
  withPatches(root => {
    const live = [...build(root).values()].map(text => JSON.parse(text)).filter(r => !r.archived);
    assert.ok(live.length > 0);
    for (const r of live) {
      assert.ok(r.cases.length > 0, r.card);
      for (const c of r.cases) assert.ok(c.source && c.ref, r.card);
    }
  });
});

test('--check passes on an identical directory, fails on an edited, missing or stray file, and writes nothing', () => {
  withTmp(['out'], out => withPatches(root => {
    const built = build(root);
    writeRecords(out, built);
    assert.deepEqual(checkRecords(out, built), []);

    const [edited, missing] = CARDS;
    const before = listing(out);
    writeFileSync(join(out, `${edited}.json`), before[`${edited}.json`].replace('"thin-spike"', '"existing-pr"'));
    rmSync(join(out, `${missing}.json`));
    writeFileSync(join(out, 'notes.txt'), 'stray\n');
    const after = listing(out);

    const diffs = checkRecords(out, built);
    assert.equal(diffs.length, 3);
    for (const name of [`${edited}.json`, `${missing}.json`, 'notes.txt']) assert.ok(diffs.some(d => d.startsWith(`${name}:`)), name);
    assert.deepEqual(listing(out), after);
  }));
});

test('--check ignores a subdirectory inside the output directory', () => {
  withTmp(['out'], out => withPatches(root => {
    const built = build(root);
    writeRecords(out, built);
    mkdirSync(join(out, 'harvest'));
    writeFileSync(join(out, 'harvest', 'harvest.json'), '{}\n');
    assert.deepEqual(checkRecords(out, built), []);
  }));
});

test('--check on a missing directory fails without creating it', () => {
  withTmp(['root'], dir => withPatches(root => {
    const out = join(dir, 'absent');
    assert.equal(checkRecords(out, build(root)).length, 1);
    assert.equal(existsSync(out), false);
  }));
});

test('the build needs no home: a copied trial dir holding the patches, with an empty home directory, reproduces the same bytes', () => {
  withTmp(['trial', 'home'], (trial, home) => withPatches(root => {
    cpSync(MINI, trial, { recursive: true });
    cpSync(root, trial, { recursive: true });
    const fromTrial = buildRecords({ trialDir: trial, linearSnapshot: MINI_LINEAR, home });
    assert.deepEqual(readdirSync(home), []);
    assert.deepEqual(asFiles(fromTrial), asFiles(build(root)));
  }));
});

test('the CLI refuses --patches with no value', () => {
  withTmp(['home'], home => {
    const run = spawnSync(process.execPath, [SCRIPT, '--patches'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /--patches needs a value/);
  });
});

const cli = (home, ...args) => spawnSync(process.execPath, [SCRIPT, ...args], {
  encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, KEIRON_SEQUENCER_HOME: join(home, 'sequencer') },
});
// A trial reference under a temp home, laid out as move-reference leaves it: the mini trial plus its patches beside it.
const plantReference = (home, root) => {
  const slug = MAP.project.slug;
  cpSync(MINI, join(home, 'sequencer', slug, 'trial-reference'), { recursive: true });
  cpSync(root, join(home, 'sequencer', slug, TRIAL_DIR), { recursive: true });
  return join(home, 'sequencer', slug);
};

test('with no flags the CLI reads the trial reference and its linear-snapshot.json under the home, and writes the records there', () => {
  withTmp(['home'], home => withPatches(root => {
    const dir = plantReference(home, root);
    const run = cli(home);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, new RegExp(`records: ${CARDS.length} written`));
    for (const [name, text] of Object.entries(asFiles(build(root)))) assert.equal(readFileSync(join(dir, name), 'utf8'), text, name);
  }));
});

test('--linear reads the snapshot from the given file; a missing default snapshot fails naming its path and --linear', () => {
  withTmp(['home', 'elsewhere'], (home, elsewhere) => withPatches(root => {
    const dir = plantReference(home, root);
    const snapshot = join(elsewhere, 'snapshot.json');
    cpSync(join(dir, 'trial-reference', 'linear-snapshot.json'), snapshot);
    rmSync(join(dir, 'trial-reference', 'linear-snapshot.json'));
    const missing = cli(home, '--check');
    assert.equal(missing.status, 1);
    assert.ok(missing.stderr.includes(join(dir, 'trial-reference', 'linear-snapshot.json')), missing.stderr);
    assert.match(missing.stderr, /--linear <file>/);
    const given = cli(home, '--linear', snapshot);
    assert.equal(given.status, 0, given.stderr);
    assert.equal(readFileSync(join(dir, `${CARDS[0]}.json`), 'utf8'), build(root).get(CARDS[0]));
    const absent = cli(home, '--linear', join(elsewhere, 'nope.json'));
    assert.equal(absent.status, 1);
    assert.ok(absent.stderr.includes(join(elsewhere, 'nope.json')), absent.stderr);
  }));
});

test('with no trial reference under the home the CLI fails naming the expected path and --trial, and writes nothing', () => {
  withTmp(['home'], home => {
    const run = cli(home);
    assert.equal(run.status, 1);
    assert.ok(run.stderr.includes(join(home, 'sequencer', '<slug>', 'trial-reference')), run.stderr);
    assert.match(run.stderr, /--trial <dir>/);
    assert.deepEqual(readdirSync(home), []);
  });
});

test('a --trial folder with no patch map fails naming the path it looked for', () => {
  withTmp(['home', 'trial'], (home, trial) => {
    const run = cli(home, '--trial', trial);
    assert.equal(run.status, 1);
    assert.ok(run.stderr.includes(join(trial, 'backfill/patch-map.json')), run.stderr);
  });
});

test('--linear needs a value', () => {
  withTmp(['home'], home => {
    const run = cli(home, '--linear');
    assert.equal(run.status, 1);
    assert.match(run.stderr, /--linear needs a value/);
  });
});

test('the backfill carries no project-specific scope notes', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../scripts/backfill/build-records.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /CRM-\d{4}/);
});
