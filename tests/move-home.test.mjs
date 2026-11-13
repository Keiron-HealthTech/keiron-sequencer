import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../scripts/maintenance/move-home.mjs';
import { makeRepo, tempDir } from './helpers/git-sandbox.mjs';
import { guardNetwork } from './helpers/no-network.mjs';

guardNetwork();

const SCRIPT = fileURLToPath(new URL('../scripts/maintenance/move-home.mjs', import.meta.url));
const TMP = tempDir('keiron-sequencer-move-home-');
after(() => rmSync(TMP, { recursive: true, force: true }));

const OLD_NAME = '.mi' + 'kado';
const NEW_NAME = '.keiron-sequencer';
const SLUG = 'abc123def456';
const RUN = `${SLUG}/runs/20261110T100000Z`;

let n = 0;
function put(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

// A user home holding the old data home, with stored absolute paths in a run state, a compact JSON file,
// a log and a jsonl that must stay verbatim, and a sibling folder the move must never touch.
function fixture() {
  const userHome = join(TMP, `case-${++n}`);
  const oldHome = join(userHome, OLD_NAME);
  const newHome = join(userHome, NEW_NAME);
  const state = {
    runId: '20261110T100000Z',
    home: oldHome,
    dataDir: oldHome,
    repos: [{ name: 'web', path: `${oldHome}/${RUN}/trees/web`, checkout: '/elsewhere/web' }],
    log: `${oldHome}/${RUN}/logs/setup-web.log`,
    sibling: `${oldHome}-other/y`,
    far: `/elsewhere/${OLD_NAME}`,
  };
  put(join(oldHome, 'config.json'), `${JSON.stringify({ repos: [{ name: 'web', path: '/elsewhere/web' }] }, null, 2)}\n`);
  put(join(oldHome, RUN, 'run.json'), `${JSON.stringify(state, null, 2)}\n`);
  put(join(oldHome, RUN, 'logs/setup-web.log'), `cloned into ${oldHome}/${RUN}/trees/web\n`);
  put(join(oldHome, SLUG, 'spike/report.json'), `{"${oldHome}/key":"${oldHome}/spike/a.md","note":"read \\"${oldHome}\\" first","n":1}`);
  put(join(oldHome, SLUG, 'harvest/applied.jsonl'), `{"at":"${oldHome}/x"}\n`);
  put(join(oldHome, '_backup', 'mi' + 'kado-pre-strip-x.bundle'), Buffer.from([0, 1, 2, 255, 254]));
  mkdirSync(join(oldHome, RUN, 'trees'), { recursive: true });
  put(join(userHome, 'other/note.txt'), `${oldHome}\n`);
  return { userHome, oldHome, newHome, state };
}

const sha = data => createHash('sha256').update(data).digest('hex');

// Every path under dir with a sha256 per file, so a listing change and a byte change both show.
function snapshot(dir) {
  if (!existsSync(dir)) return null;
  const out = {};
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const path = join(e.parentPath, e.name);
    out[relative(dir, path)] = e.isDirectory() ? 'dir' : sha(readFileSync(path));
  }
  return out;
}

const expectedRewrites = ({ oldHome, newHome }) => [
  { file: `${RUN}/run.json`, old: oldHome, new: newHome },
  { file: `${RUN}/run.json`, old: oldHome, new: newHome },
  { file: `${RUN}/run.json`, old: `${oldHome}/${RUN}/trees/web`, new: `${newHome}/${RUN}/trees/web` },
  { file: `${RUN}/run.json`, old: `${oldHome}/${RUN}/logs/setup-web.log`, new: `${newHome}/${RUN}/logs/setup-web.log` },
  { file: `${SLUG}/spike/report.json`, old: `${oldHome}/spike/a.md`, new: `${newHome}/spike/a.md` },
];

test('a bare run previews the move and every stored path it would rewrite, changing nothing', async () => {
  const f = fixture();
  const before = snapshot(f.userHome);
  const r = await run([], { userHome: f.userHome });
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.action, 'move-home');
  assert.equal(out.direction, 'forward');
  assert.equal(out.applied, false);
  assert.equal(out.from, f.oldHome);
  assert.equal(out.to, f.newHome);
  assert.deepEqual(out.entries, ['_backup', SLUG, 'config.json']);
  assert.deepEqual(out.rewrites, expectedRewrites(f));
  assert.deepEqual(snapshot(f.userHome), before);
});

test('--dry-run and unknown arguments are usage errors that change nothing', async () => {
  const f = fixture();
  const before = snapshot(f.userHome);
  for (const argv of [['--dry-run'], ['--apply', '--dry-run'], ['extra'], ['--from']]) {
    const r = await run(argv, { userHome: f.userHome });
    assert.equal(r.code, 2, argv.join(' '));
    assert.match(r.stderr, /usage:/);
  }
  assert.deepEqual(snapshot(f.userHome), before);
});

test('--from and --to override both roots', async () => {
  const f = fixture();
  const to = join(f.userHome, 'elsewhere-home');
  const r = await run(['--from', f.oldHome, '--to', to], { userHome: f.userHome });
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.from, f.oldHome);
  assert.equal(out.to, to);
  assert.ok(out.rewrites.every(w => w.new.startsWith(`${to}/`) || w.new === to), JSON.stringify(out.rewrites));
});

async function assertRefused(f, argv, pattern) {
  const before = snapshot(f.userHome);
  for (const extra of [[], ['--apply']]) {
    const r = await run([...argv, ...extra], { userHome: f.userHome });
    assert.equal(r.code, 5, `${[...argv, ...extra].join(' ')}: ${r.stdout}${r.stderr}`);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, pattern);
    assert.deepEqual(snapshot(f.userHome), before);
  }
}

const quoted = path => new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

test('an existing destination is refused, naming it, and both homes stay byte-identical', async () => {
  const f = fixture();
  put(join(f.newHome, 'config.json'), '{}\n');
  await assertRefused(f, [], quoted(f.newHome));
});

test('a missing source is refused, naming it', async () => {
  const f = fixture();
  rmSync(f.oldHome, { recursive: true });
  await assertRefused(f, [], quoted(f.oldHome));
});

test('a run lock is refused, naming the lock', async () => {
  const f = fixture();
  put(join(f.oldHome, RUN, 'run.lock'), '4242\n');
  await assertRefused(f, [], quoted(join(f.oldHome, RUN, 'run.lock')));
});

test('a spike tree under a run is refused, naming the trees folder; an empty trees folder is not', async () => {
  const f = fixture();
  const empty = await run([], { userHome: f.userHome });
  assert.equal(empty.code, 0, empty.stderr);
  put(join(f.oldHome, RUN, 'trees/web/README.md'), '# web\n');
  await assertRefused(f, [], quoted(join(f.oldHome, RUN, 'trees')));
});

test('a file that is not valid JSON is refused before anything moves, naming it', async () => {
  const f = fixture();
  put(join(f.oldHome, SLUG, 'notes.json'), '{oops');
  await assertRefused(f, [], quoted(join(f.oldHome, SLUG, 'notes.json')));
});

test('a source inside a git work tree is refused', async () => {
  const repo = makeRepo();
  after(repo.dispose);
  const userHome = join(repo.dir, 'home');
  put(join(userHome, OLD_NAME, 'config.json'), '{}\n');
  await assertRefused({ userHome }, [], quoted(repo.dir));
});

test('a destination inside a git work tree is refused', async () => {
  const repo = makeRepo();
  after(repo.dispose);
  const f = fixture();
  await assertRefused(f, ['--to', join(repo.dir, NEW_NAME)], quoted(repo.dir));
});

test('--apply moves the whole home verbatim, leaves the sibling folder alone and asks for /add-dir', async () => {
  const f = fixture();
  const before = snapshot(f.oldHome);
  const other = snapshot(join(f.userHome, 'other'));
  const r = await run(['--apply'], { userHome: f.userHome });
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.applied, true);
  assert.deepEqual(out.rewrites, expectedRewrites(f));
  assert.match(out.next, /\/add-dir ~\/\.keiron-sequencer\b/);
  assert.equal(existsSync(f.oldHome), false);
  const moved = snapshot(f.newHome);
  assert.deepEqual(Object.keys(moved).sort(), Object.keys(before).sort());
  const rewritten = new Set(out.rewrites.map(w => w.file));
  for (const path of Object.keys(before).filter(p => !rewritten.has(p))) assert.equal(moved[path], before[path], path);
  assert.deepEqual(snapshot(join(f.userHome, 'other')), other);
});

test('--apply rewrites only values that are the old root or sit under it, keeping key order and formatting', async () => {
  const f = fixture();
  const log = readFileSync(join(f.oldHome, RUN, 'logs/setup-web.log'), 'utf8');
  const jsonl = readFileSync(join(f.oldHome, SLUG, 'harvest/applied.jsonl'), 'utf8');
  const config = readFileSync(join(f.oldHome, 'config.json'), 'utf8');
  assert.equal((await run(['--apply'], { userHome: f.userHome })).code, 0);
  const moved = {
    ...f.state,
    home: f.newHome,
    dataDir: f.newHome,
    repos: [{ ...f.state.repos[0], path: `${f.newHome}/${RUN}/trees/web` }],
    log: `${f.newHome}/${RUN}/logs/setup-web.log`,
  };
  assert.equal(readFileSync(join(f.newHome, RUN, 'run.json'), 'utf8'), `${JSON.stringify(moved, null, 2)}\n`);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(f.newHome, RUN, 'run.json'), 'utf8'))), Object.keys(f.state));
  assert.equal(readFileSync(join(f.newHome, SLUG, 'spike/report.json'), 'utf8'), `{"${f.oldHome}/key":"${f.newHome}/spike/a.md","note":"read \\"${f.oldHome}\\" first","n":1}`);
  assert.equal(readFileSync(join(f.newHome, RUN, 'logs/setup-web.log'), 'utf8'), log);
  assert.equal(readFileSync(join(f.newHome, SLUG, 'harvest/applied.jsonl'), 'utf8'), jsonl);
  assert.equal(readFileSync(join(f.newHome, 'config.json'), 'utf8'), config);
});

test('--apply then --inverse --apply leaves the user home byte-identical to the start', async () => {
  const f = fixture();
  const before = snapshot(f.userHome);
  assert.equal((await run(['--apply'], { userHome: f.userHome })).code, 0);
  const r = await run(['--inverse', '--apply'], { userHome: f.userHome });
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.direction, 'inverse');
  assert.match(out.next, new RegExp(`/add-dir ~/${OLD_NAME.replace('.', '\\.')}\\b`));
  assert.deepEqual(snapshot(f.userHome), before);
});

test('--inverse alone previews the reverse move and changes nothing', async () => {
  const f = fixture();
  assert.equal((await run(['--apply'], { userHome: f.userHome })).code, 0);
  const moved = snapshot(f.userHome);
  const r = await run(['--inverse'], { userHome: f.userHome });
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.direction, 'inverse');
  assert.equal(out.applied, false);
  assert.equal(out.from, f.newHome);
  assert.equal(out.to, f.oldHome);
  assert.deepEqual(out.rewrites, expectedRewrites(f).map(w => ({ file: w.file, old: w.new, new: w.old })));
  assert.deepEqual(snapshot(f.userHome), moved);
});

test('the inverse refuses an existing old home, a run lock or a spike tree under the new home', async () => {
  const cases = [
    f => [put(join(f.oldHome, 'config.json'), '{}\n'), f.oldHome],
    f => [put(join(f.newHome, RUN, 'run.lock'), '4242\n'), join(f.newHome, RUN, 'run.lock')],
    f => [put(join(f.newHome, RUN, 'trees/web/README.md'), '# web\n'), join(f.newHome, RUN, 'trees')],
  ];
  for (const plant of cases) {
    const f = fixture();
    assert.equal((await run(['--apply'], { userHome: f.userHome })).code, 0);
    const [, named] = plant(f);
    await assertRefused(f, ['--inverse'], quoted(named));
  }
});

test('a rename that fails rolls the rewritten files back and exits 1 naming the step', async () => {
  const f = fixture();
  const preview = await run([], { userHome: f.userHome });
  const before = snapshot(f.userHome);
  const rename = () => { throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' }); };
  const r = await run(['--apply'], { userHome: f.userHome, rename });
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stderr, /rename/);
  assert.match(r.stderr, /cross-device link not permitted/);
  assert.match(r.stderr, /nothing was moved/);
  assert.deepEqual(snapshot(f.userHome), before);
  assert.equal(existsSync(f.newHome), false);
  assert.deepEqual(await run([], { userHome: f.userHome }), preview);
});

test('a rewrite that fails part way restores the files already rewritten and moves nothing', async () => {
  const f = fixture();
  const before = snapshot(f.userHome);
  const locked = join(f.oldHome, SLUG, 'spike');
  chmodSync(locked, 0o555);
  try {
    const r = await run(['--apply'], { userHome: f.userHome });
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stderr, quoted(`rewriting ${join(locked, 'report.json')} failed`));
    assert.match(r.stderr, /nothing was moved/);
  } finally {
    chmodSync(locked, 0o755);
  }
  assert.deepEqual(snapshot(f.userHome), before);
  assert.equal(existsSync(f.newHome), false);
});

test('the default roots come from HOME when the script is spawned', () => {
  const f = fixture();
  const before = snapshot(f.userHome);
  const r = spawnSync(process.execPath, [SCRIPT], { env: { PATH: process.env.PATH, HOME: f.userHome }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.ok(out.from.startsWith(`${f.userHome}/`), out.from);
  assert.equal(out.from, f.oldHome);
  assert.equal(out.to, f.newHome);
  assert.equal(out.applied, false);
  assert.deepEqual(snapshot(f.userHome), before);
});
