import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readOnlySubcommands } from './helpers/fake-git.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import { blocksIt, fakeNextFixture, folder, M1, nextIssue, PROJECT_URL, SENTINEL, SLUG } from './helpers/next-fixture.mjs';
import { startRecord } from './helpers/start-fixture.mjs';

guardNetwork();

const CLI = fileURLToPath(new URL('../scripts/next.mjs', import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), 'keiron-sequencer-next-cli-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const fixture = (t, over) => {
  const f = fakeNextFixture(over);
  t.after(f.dispose);
  return f;
};
const parsed = async (f, argv) => {
  const r = await f.run(argv);
  assert.equal(r.code, 0, r.stderr);
  return { r, out: JSON.parse(r.stdout) };
};
const KEYS = ['critical', 'criticalTies', 'fetched', 'free', 'overdue', 'project', 'records', 'schemaVersion', 'summary', 'today', 'viewer', 'warnings'];
const windows = (secret, size = 8) => Array.from({ length: secret.length - size + 1 }, (_, i) => secret.slice(i, i + size));
const assertNoKey = r => {
  const all = `${r.stdout}\n${r.stderr}`;
  for (const w of windows(SENTINEL)) assert.ok(!all.includes(w), `leaked ${w}`);
};
const pr = (n, over = {}) => ({
  number: n, state: 'OPEN', isDraft: false, mergedAt: null, baseRefName: 'main', headRefName: `abc-${n}-x`,
  title: `[ABC-${n}] x`, url: `https://github.com/acme/app/pull/${n}`, ...over,
});
const ghOpen = prs => argv => (argv.includes('open') ? JSON.stringify(prs) : '[]');

test('a clean run prints one JSON line with exactly the next keys and nothing on stderr', async t => {
  const f = fixture(t);
  const { r, out } = await parsed(f);
  assert.equal(r.stderr, '');
  assert.ok(r.stdout.endsWith('\n'));
  assert.equal(r.stdout.trim().split('\n').length, 1);
  assert.deepEqual(Object.keys(out).sort(), KEYS);
  assert.equal(out.schemaVersion, 1);
  assert.deepEqual(out.viewer, { id: 'viewer-1', name: 'Me' });
  assert.deepEqual(out.summary, { open: 1, free: 1 });
  assert.deepEqual(out.free.map(c => [c.key, c.base.kind, c.base.ref, c.repo]), [['ABC-1', 'default', 'origin/main', 'app-repo']]);
  assert.deepEqual(out.overdue, []);
});

test('free and overdue end to end: a draft takes an overdue card, a blocker PR stacks another', async t => {
  const f = fixture(t, {
    issues: [
      nextIssue('ABC-1', { state: { name: 'In Progress', type: 'started' }, ...blocksIt('ABC-2') }),
      nextIssue('ABC-2'),
      nextIssue('ABC-3', { dueDate: '2026-11-10' }),
    ],
    folders: { '/src/app': folder({ common: '/src/app/.git', heads: ['main', 'abc-1-x'], tracking: ['main', 'abc-1-x'] }) },
    gh: ghOpen([pr(1), pr(3, { isDraft: true })]),
  });
  const { out } = await parsed(f);
  assert.deepEqual(out.free.map(c => [c.key, c.base.kind, c.base.ref]), [['ABC-2', 'stack', 'origin/abc-1-x']]);
  assert.deepEqual(out.overdue.map(o => [o.key, o.reason]), [['ABC-3', 'taken']]);
});

test('an open blocker in another project is read from Linear and blocks', async t => {
  const f = fixture(t, {
    issues: [
      nextIssue('ABC-1', { dueDate: '2026-11-01' }),
      nextIssue('OPS-9', { projectId: 'other-project', title: 'Infra', ...blocksIt('ABC-1') }),
    ],
  });
  const { out } = await parsed(f);
  assert.deepEqual(out.free, []);
  assert.deepEqual(out.overdue.map(o => [o.key, o.reason, o.detail]), [['ABC-1', 'blocked', 'OPS-9']]);
  assert.ok(f.linear.sent.some(s => /OffMapIssue/.test(s.body.query) && s.body.variables.id === 'OPS-9'));
});

test('board warnings: no milestone, a cycle and a text-only dependency, on stderr too', async t => {
  const f = fixture(t, {
    issues: [
      nextIssue('ABC-1', { projectMilestone: null }),
      nextIssue('ABC-2', blocksIt('ABC-3')),
      nextIssue('ABC-3', blocksIt('ABC-2')),
      nextIssue('ABC-4', { description: 'Depende de ABC-1' }),
    ],
  });
  const { r, out } = await parsed(f);
  const kinds = out.warnings.map(w => w.kind).sort();
  assert.deepEqual(kinds, ['cycle', 'no-milestone', 'text-only-dependency']);
  assert.match(out.warnings.find(w => w.kind === 'no-milestone').message, /ABC-1/);
  assert.match(out.warnings.find(w => w.kind === 'cycle').message, /ABC-2 → ABC-3/);
  for (const w of out.warnings) assert.ok(r.stderr.includes(`warning: ${w.message}`), w.kind);
});

test('records give free cards their size, and an invalid record is a warning', async t => {
  const f = fixture(t, { issues: [nextIssue('ABC-1')], records: [startRecord('ABC-1')] });
  writeFileSync(join(f.dataDir, SLUG, 'ABC-2.json'), '{ not json');
  const { out } = await parsed(f);
  assert.deepEqual([out.records.count, out.records.invalid], [1, 1]);
  assert.ok(out.free[0].size?.label, JSON.stringify(out.free[0].size));
  assert.ok(out.warnings.some(w => w.kind === 'record-invalid'));
});

test('today is the local calendar day, and fetched stays the UTC timestamp', async t => {
  const saved = process.env.TZ;
  process.env.TZ = 'America/Santiago';
  t.after(() => { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; });
  const f = fixture(t, { now: new Date('2026-11-16T02:30:00.000Z') });
  const { out } = await parsed(f);
  assert.deepEqual([out.today, out.fetched], ['2026-11-15', '2026-11-16T02:30:00.000Z']);
});

test('only read-only git subcommands run, and gh only lists and views PRs', async t => {
  const f = fixture(t, { issues: [nextIssue('ABC-1', { attachments: [{ url: 'https://github.com/acme/app/pull/77' }] })] });
  await parsed(f);
  assert.ok(f.git.calls.length > 0);
  for (const c of f.git.calls) assert.ok(readOnlySubcommands.includes(c.sub), c.sub);
  for (const c of f.gh.calls) assert.ok(['list', 'view'].includes(c.argv[1]), c.argv.join(' '));
});

test('a missing config exits 2 naming it, before GitHub or git', async t => {
  const f = fixture(t);
  rmSync(join(f.home, 'config.json'));
  const r = await f.run();
  assert.equal(r.code, 2);
  assert.match(r.stderr, /config\.json/);
  assert.equal(f.gh.calls.length + f.git.calls.length, 0);
});

test('no key exits 3 before any request', async t => {
  const f = fixture(t);
  const r = await f.run([PROJECT_URL], { keyFile: join(TMP, 'absent.key'), env: {} });
  assert.equal(r.code, 3);
  assert.equal(r.stdout, '');
  assert.equal(f.linear.sent.length, 0);
});

test('a missing or unparseable project argument exits 2 with usage', async t => {
  const f = fixture(t);
  for (const argv of [[], ['not a project'], ['CRM-1184']]) {
    const r = await f.run(argv);
    assert.equal(r.code, 2, JSON.stringify(argv));
    assert.match(r.stderr, /usage/i);
  }
  assert.equal(f.linear.sent.length, 0);
});

test('a Linear failure exits 1 with one line and nothing on stdout', async t => {
  const f = fixture(t);
  const fetchImpl = async () => ({ ok: false, status: 401, statusText: 'Unauthorized', json: async () => ({}) });
  const r = await f.run([PROJECT_URL], { fetchImpl });
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, 'Linear HTTP 401 Unauthorized\n');
});

test('an error after the reads exits 1 as an internal error, one redacted line, no stack', async t => {
  const f = fixture(t);
  const r = await f.run([PROJECT_URL], { listDir: () => { throw new Error(`boom ${SENTINEL}`); } });
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^internal error: /);
  assert.equal(r.stderr.trimEnd().split('\n').length, 1);
  assertNoKey(r);
});

test('Linear data that echoes the key is redacted from the JSON, which still parses', async t => {
  const f = fixture(t, { issues: [nextIssue('ABC-1', { title: `app-repo: ${SENTINEL}` })] });
  const r = await f.run();
  assert.equal(r.code, 0, r.stderr);
  assertNoKey(r);
  JSON.parse(r.stdout);
});

test('importing the CLI module runs nothing, and run as a script it exits 2 with usage', () => {
  const home = join(TMP, 'user-home');
  mkdirSync(home, { recursive: true });
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(CLI)})`], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } });
  assert.deepEqual([imported.status, imported.stdout, imported.stderr], [0, '', '']);
  const script = spawnSync(process.execPath, [CLI], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } });
  assert.equal(script.status, 2);
  assert.match(script.stderr, /usage/i);
});

test('a project milestone with no cards still orders the others', async t => {
  const f = fixture(t, { milestones: [{ id: 'ms-0', name: 'Discovery', sortOrder: 0 }, M1] });
  const { out } = await parsed(f);
  assert.equal(out.free[0].milestoneOrder, 2);
});

test('text in a card off the map neither blocks nor warns', async t => {
  const f = fixture(t, {
    issues: [nextIssue('ABC-1'), nextIssue('ABC-9', { title: 'Old idea', state: { name: 'Canceled', type: 'canceled' }, description: 'Esto bloquea ABC-1 y depende de ABC-77' })],
  });
  const { out } = await parsed(f);
  assert.deepEqual(out.free.map(c => c.key), ['ABC-1']);
  assert.deepEqual(out.warnings, []);
});

test('a linked PR is looked up only for cards that could be free or block one', async t => {
  const link = n => [{ url: `https://github.com/acme/app/pull/${n}` }];
  const f = fixture(t, {
    issues: [
      nextIssue('ABC-1', { state: { name: 'In Review', type: 'started' }, attachments: link(71) }),
      nextIssue('ABC-2', { state: { name: 'In Progress', type: 'started' }, attachments: link(72), ...blocksIt('ABC-3') }),
      nextIssue('ABC-3', { attachments: link(73) }),
    ],
  });
  await parsed(f);
  assert.deepEqual(f.gh.calls.filter(c => c.argv[1] === 'view').map(c => c.argv[2]).sort(), ['72', '73']);
});
