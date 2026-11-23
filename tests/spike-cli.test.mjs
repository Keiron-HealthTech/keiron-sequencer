import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../scripts/spike.mjs';
import { validateRecord } from '../scripts/lib/record.mjs';
import { checkNotes } from '../scripts/lib/spike/build-record.mjs';
import { fakeSetup, sandboxGit } from './helpers/git-sandbox.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import {
  activeRunDir, appendTranscript, blocks, call, issue, notes, PROJECT_URL, SENTINEL, SLUG, spikeFixture, twoRepoFixture, usageEntry, walk,
} from './helpers/spike-fixture.mjs';
import * as R from './helpers/respike-fixture.mjs';

guardNetwork();

const PR_DIFF = ['diff --git a/pr.txt b/pr.txt', 'new file mode 100644', '--- /dev/null', '+++ b/pr.txt', '@@ -0,0 +1 @@', '+from the pr', ''].join('\n');

const prGh = argv => {
  if (argv[1] === 'diff') return PR_DIFF;
  return JSON.stringify(argv.includes('acme/backend') ? [{ number: 12, title: 'feat: the third card (CRM-3)', url: 'https://github.com/acme/backend/pull/12', isDraft: false }] : []);
};

const worktrees = cwd => sandboxGit(['worktree', 'list', '--porcelain'], { cwd }).split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice(9));

test('begin, then next, tree and end over three cards, completes the run: records only in the data dir, no key, no mutation', async () => {
  const fixture = twoRepoFixture({
    issues: [issue('CRM-1'), issue('CRM-2', { relations: blocks('CRM-1') }), issue('CRM-3')],
    gh: prGh,
  });
  const { deps, home, dataDir, repo, other, linear, gh, setupCommands, at } = fixture;
  const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
  config.repos.backend.setup = [['yarn', 'install']];
  writeFileSync(join(home, 'config.json'), JSON.stringify(config));
  const heads = [repo, other].map(r => r.git(['rev-parse', 'HEAD']).trim());
  const session = join(fixture.transcripts, '-work', 'session-1.jsonl');
  const outputs = [];
  const step = async (argv, clock) => {
    at(clock);
    const r = await call(fixture, argv, { session });
    outputs.push(r);
    assert.equal(r.code, 0, `${argv.join(' ')}: ${r.stderr}`);
    return JSON.parse(r.stdout);
  };

  const begun = await step(['begin', PROJECT_URL, '--box', '1000'], '2026-11-10T10:00:00.000Z');
  assert.deepEqual(begun.plan.order, ['CRM-2', 'CRM-1', 'CRM-3']);
  const dir = activeRunDir(home);
  mkdirSync(join(dir, 'notes'), { recursive: true });

  const work = [
    { card: 'CRM-2', repo: 'frontend', file: 'two.txt', minute: 1 },
    { card: 'CRM-1', repo: 'backend', file: 'one.txt', minute: 11 },
    { card: 'CRM-3', repo: 'backend', file: null, minute: 21 },
  ];
  for (const { card, repo: repoDir, file, minute } of work) {
    const brief = await step(['next'], `2026-11-10T10:${String(minute).padStart(2, '0')}:00.000Z`);
    assert.equal(brief.card, card);
    appendTranscript(session, [usageEntry(`${card}-work`, `2026-11-10T10:${String(minute + 1).padStart(2, '0')}:00.000Z`, 100)]);
    const tree = await step(['tree', repoDir], `2026-11-10T10:${String(minute + 2).padStart(2, '0')}:00.000Z`);
    if (file) writeFileSync(join(tree.path, file), `${card}\n`);
    else assert.equal(brief.prDiff, 'applied', 'the backend tree was already open, so next applied the PR diff');
    const notesFile = card === 'CRM-1' ? join(fixture.scratch, 'CRM-1-notes.json') : join(dir, 'notes', `${card}.json`);
    writeFileSync(notesFile, JSON.stringify(notes));
    const ended = await step(['end', card, ...(card === 'CRM-1' ? ['--notes', notesFile] : [])], `2026-11-10T10:${String(minute + 5).padStart(2, '0')}:00.000Z`);
    assert.equal(ended.usage.w, 100);
  }
  const done = await step(['next'], '2026-11-10T10:40:00.000Z');
  assert.equal(done.action, 'complete');
  assert.equal(done.removed.length, 2);
  assert.deepEqual(done.touchedCheckouts.map(t => t.repo), ['frontend', 'backend'], 'in the order the trees were opened');

  assert.deepEqual(walk(dataDir), ['CRM-1', 'CRM-2', 'CRM-3'].map(k => `${SLUG}/${k}.json`));
  for (const k of ['CRM-1', 'CRM-2', 'CRM-3']) {
    const text = readFileSync(join(dataDir, SLUG, `${k}.json`), 'utf8');
    const record = JSON.parse(text);
    assert.deepEqual(validateRecord(record), [], k);
    assert.equal(/diff --git|\n\+\+\+ b\/|\n--- a\/|@@ -/.test(text), false, k);
  }
  const third = JSON.parse(readFileSync(join(dataDir, SLUG, 'CRM-3.json'), 'utf8'));
  assert.deepEqual([third.origin, third.effort, third.timeBox, third.refs.patches], ['existing-pr', null, undefined, ['backend/00003-existing.patch']]);
  assert.deepEqual(JSON.parse(readFileSync(join(dataDir, SLUG, 'CRM-1.json'), 'utf8')).timeBox, { budget: 1000, spent: 100, over: false });
  assert.ok(existsSync(join(dir, 'notes', 'CRM-1.json')));
  assert.deepEqual(walk(join(dir, 'patches')), ['backend/00001-new.patch', 'backend/00003-existing.patch', 'frontend/00002-new.patch']);

  for (const r of outputs) assert.equal(`${r.stdout}${r.stderr}`.includes(SENTINEL), false);
  for (const r of outputs) assert.equal(/diff --git|^@@ -|^\+\+\+ b\//m.test(`${r.stdout}${r.stderr}`), false, 'no CLI output carries diff content');
  assert.equal(linear.sent.filter(s => /\bmutation\b/i.test(s.body.query)).length, 0);
  assert.ok(gh.calls.every(c => ['pr list', 'pr view', 'pr diff'].includes(c.argv.slice(0, 2).join(' '))));
  assert.deepEqual(setupCommands.calls.map(c => c.argv), [['yarn', 'install']]);
  for (const [i, r] of [repo, other].entries()) {
    assert.equal(r.git(['rev-parse', 'HEAD']).trim(), heads[i]);
    assert.equal(r.git(['rev-list', '--count', '--all']).trim(), '1');
    assert.deepEqual(worktrees(r.dir), [r.dir]);
  }
  assert.match((await run(['next'], deps)).stderr, /no active spike run/);
});

const twoCards = () => spikeFixture({ issues: [issue('CRM-1'), issue('CRM-2')] });

async function cardOpen(fixture, flags = []) {
  await call(fixture, ['begin', PROJECT_URL, ...flags]);
  fixture.at('2026-11-10T10:01:00.000Z');
  await call(fixture, ['next']);
  const tree = JSON.parse((await call(fixture, ['tree', 'backend'])).stdout).path;
  const dir = activeRunDir(fixture.home);
  mkdirSync(join(dir, 'notes'), { recursive: true });
  writeFileSync(join(dir, 'notes', 'CRM-1.json'), JSON.stringify(notes));
  fixture.at('2026-11-10T10:05:00.000Z');
  return tree;
}

test('exit 2 for usage, 3 without a Linear key, and 1 for a home inside a git work tree on every command', async () => {
  const fixture = twoCards();
  assert.equal((await run(['nope'], fixture.deps)).code, 2);
  assert.equal((await run(['begin'], fixture.deps)).code, 2);
  const noKey = await run(['begin', PROJECT_URL], { ...fixture.deps, keyFile: join(fixture.scratch, 'absent.key') });
  assert.equal(noKey.code, 3);
  assert.equal(fixture.linear.sent.length, 0);
  const inside = join(fixture.repo.dir, '.keiron-sequencer');
  for (const argv of [['status'], ['prune'], ['next'], ['pause'], ['abandon']]) {
    const r = await run(argv, { ...fixture.deps, home: inside });
    assert.equal(r.code, 1, argv[0]);
    assert.match(r.stderr, /inside the git work tree/, argv[0]);
  }
});

test('exit 4 on a secret in the card patch, writing nothing', async () => {
  const fixture = twoCards();
  const tree = await cardOpen(fixture);
  writeFileSync(join(tree, 'config.js'), `const key = '${`AKIA${'Z'.repeat(16)}`}'\n`);
  const r = await call(fixture, ['end', 'CRM-1']);
  assert.equal(r.code, 4);
  assert.equal(r.stdout.includes('Z'.repeat(16)), false);
  assert.deepEqual(walk(fixture.dataDir), []);
});

test('exit 5 on a cycle among the run cards', async () => {
  const fixture = spikeFixture({ issues: [issue('CRM-1', { relations: blocks('CRM-2') }), issue('CRM-2', { relations: blocks('CRM-1') })] });
  assert.equal((await call(fixture, ['begin', PROJECT_URL])).code, 5);
  assert.equal(existsSync(join(fixture.home, SLUG)), false);
});

test('exit 6 when a spike tree holds a commit', async () => {
  const fixture = twoCards();
  const tree = await cardOpen(fixture);
  writeFileSync(join(tree, 'x.txt'), 'x\n');
  sandboxGit(['add', '-A'], { cwd: tree });
  sandboxGit(['commit', '-q', '-m', 'not allowed'], { cwd: tree });
  assert.equal((await call(fixture, ['end', 'CRM-1'])).code, 6);
});

test('exit 7 when a token cap is set and no session is bound', async () => {
  const fixture = twoCards();
  await call(fixture, ['begin', PROJECT_URL, '--max-tokens', '50']);
  fixture.at('2026-11-10T10:01:00.000Z');
  assert.equal((await call(fixture, ['next'])).code, 7);
});

test('a paused respike run resumes through spike begin with no hash, and once it is complete spike begin is nothing-to-do', async () => {
  const f = R.respikeFixture();
  const pick = [R.PROJECT_URL, '--cards', R.B];
  const plan = JSON.parse((await f.run('preflight', pick)).stdout);
  f.at('2026-11-10T10:01:00.000Z');
  const { runId } = JSON.parse((await f.run('begin', [...pick, '--approve', plan.approve])).stdout);
  assert.equal((await f.spike(['pause'])).code, 0);
  f.at('2026-11-10T10:02:00.000Z');
  const resumed = await f.spike(['begin', R.PROJECT_URL]);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.deepEqual([JSON.parse(resumed.stdout).runId, JSON.parse(resumed.stdout).resumed], [runId, true]);
  const brief = JSON.parse((await f.spike(['next'])).stdout);
  assert.equal(brief.card, R.B);
  const tree = JSON.parse((await f.spike(['tree', 'backend'])).stdout).path;
  writeFileSync(join(tree, 'b.txt'), 'b\n');
  const dir = join(f.home, R.SLUG, 'runs', runId);
  mkdirSync(join(dir, 'notes'), { recursive: true });
  writeFileSync(join(dir, 'notes', `${R.B}.json`), JSON.stringify(R.notes(R.B)));
  f.at('2026-11-10T10:05:00.000Z');
  assert.equal((await f.spike(['end', R.B])).code, 0);
  assert.equal(JSON.parse((await f.spike(['next'])).stdout).action, 'complete');
  const runs = walk(join(f.home, R.SLUG, 'runs')).filter(p => p.endsWith('run.json'));
  const again = await f.spike(['begin', R.PROJECT_URL]);
  assert.equal(again.code, 0, again.stderr);
  assert.deepEqual(JSON.parse(again.stdout), { action: 'nothing-to-do', runId, project: { slug: R.SLUG, name: R.PROJECT_NAME } });
  assert.deepEqual(walk(join(f.home, R.SLUG, 'runs')).filter(p => p.endsWith('run.json')), runs);
});

const FILL = { source: 'linear', ref: 'linear:CRM-1', kind: 'risk', impact: 'design', status: 'open', owner: 'people', outcome: 'holds' };
const fill = (value, key) => {
  if (typeof value === 'string') return value.startsWith('<') ? (FILL[key] ?? 'filled in') : value;
  if (Array.isArray(value)) return value.map(v => fill(v, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, k)]));
  return value;
};

test('notes-template prints a skeleton that passes checkNotes once placeholders are filled', async () => {
  const fixture = spikeFixture();
  assert.equal((await call(fixture, ['begin', PROJECT_URL, '--session-file', fixture.sessionFile])).code, 0);
  const r = await call(fixture, ['notes-template', 'CRM-1']);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.action, 'notes-template');
  assert.equal(out.card, 'CRM-1');
  assert.deepEqual(Object.keys(out.notes).sort(), ['cases', 'decisions', 'engram', 'findings', 'openDecisions', 'piiInLogs', 'scope']);
  assert.deepEqual(Object.keys(out.notes.openDecisions[0]), ['text', 'impact', 'status', 'owner', 'eliminated', 'ref']);
  assert.deepEqual(out.allowed, {
    source: ['engram', 'linear', 'patch'], kind: ['reorder', 'split', 'under-scoped', 'risk'], impact: ['design', 'detail'],
    status: ['open', 'narrowed'], owner: ['people', 'code'], outcome: ['holds', 'resolved', 'wrong'],
  });
  assert.notDeepEqual(checkNotes(out.notes), []);
  assert.deepEqual(checkNotes(fill(out.notes)), []);
});

test('a finding with kind blocker is refused at notes.findings[0].kind', () => {
  const errors = checkNotes({ ...notes, findings: [{ kind: 'blocker', text: 'x', ref: 'linear:CRM-1' }] });
  assert.ok(errors.includes('notes.findings[0].kind: expected one of reorder, split, under-scoped, risk'), errors.join('; '));
  assert.ok(checkNotes({ ...notes, cases: [{ given: 'a', when: 'b', then: 'c', source: 'jira', ref: 'linear:CRM-1' }] }).includes('notes.cases[0].source: expected one of engram, linear, patch'));
  assert.ok(checkNotes({ ...notes, scope: { complete: false } }).includes('notes.scope.note: required when the scope is incomplete'));
  assert.deepEqual(checkNotes(notes), []);
});

test('end refuses with exit 8 on a failing typecheck and accepts --skip-typecheck', async () => {
  const fixture = spikeFixture();
  const { deps, home, dataDir, at } = fixture;
  const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
  config.repos.backend.spikeTypecheck = ['tc', '{changed}'];
  writeFileSync(join(home, 'config.json'), JSON.stringify(config));
  const failing = fakeSetup({ 'tc README.md': 2 });
  const { runId } = JSON.parse((await run(['begin', PROJECT_URL], deps)).stdout);
  const runDir = join(home, SLUG, 'runs', runId);
  at('2026-11-10T10:01:00.000Z');
  await run(['next'], deps);
  const tree = JSON.parse((await run(['tree', 'backend'], deps)).stdout);
  writeFileSync(join(tree.path, 'README.md'), '# sandbox\nspiked\n');
  mkdirSync(join(runDir, 'notes'), { recursive: true });
  writeFileSync(join(runDir, 'notes', 'CRM-1.json'), JSON.stringify(notes));
  const before = readFileSync(join(runDir, 'run.json'), 'utf8');

  at('2026-11-10T10:05:00.000Z');
  const refused = await run(['end', 'CRM-1'], { ...deps, runSetup: failing.run });
  assert.equal(refused.code, 8, refused.stderr);
  const out = JSON.parse(refused.stdout);
  assert.deepEqual([out.action, out.repo, out.status, out.timedOut], ['typecheck', 'backend', 2, false]);
  assert.equal(out.log, join(runDir, 'logs', 't1', 'typecheck-backend.log'));
  assert.match(out.tail, /tc README\.md/);
  assert.match(refused.stderr, /--skip-typecheck/);
  assert.equal(readFileSync(join(runDir, 'run.json'), 'utf8'), before);
  assert.deepEqual(walk(dataDir), []);

  const skipped = await run(['end', 'CRM-1', '--skip-typecheck', 'the base already fails the same check'], { ...deps, runSetup: failing.run });
  assert.equal(skipped.code, 0, skipped.stderr);
  const state = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
  assert.deepEqual(state.cards['CRM-1'].typecheck, { backend: { skipped: 'the base already fails the same check' } });

  const passing = spikeFixture();
  const pconfig = JSON.parse(readFileSync(join(passing.home, 'config.json'), 'utf8'));
  pconfig.repos.backend.spikeTypecheck = ['tc', '{changed}'];
  writeFileSync(join(passing.home, 'config.json'), JSON.stringify(pconfig));
  const runs = fakeSetup();
  const begun = JSON.parse((await run(['begin', PROJECT_URL], passing.deps)).stdout);
  await run(['next'], passing.deps);
  const ptree = JSON.parse((await run(['tree', 'backend'], passing.deps)).stdout);
  writeFileSync(join(ptree.path, 'README.md'), '# sandbox\nspiked\n');
  mkdirSync(join(passing.home, SLUG, 'runs', begun.runId, 'notes'), { recursive: true });
  writeFileSync(join(passing.home, SLUG, 'runs', begun.runId, 'notes', 'CRM-1.json'), JSON.stringify(notes));
  const ended = await run(['end', 'CRM-1'], { ...passing.deps, runSetup: runs.run });
  assert.equal(ended.code, 0, ended.stderr);
  assert.ok(runs.calls.some(c => c.argv.join(' ') === 'tc README.md'), JSON.stringify(runs.calls));
});

test('config is respike\'s config step: the same draft review and the same refusals', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { run: respike } = await import('../scripts/respike.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'spike-config-'));
  const home = join(dir, 'home');
  mkdirSync(home);
  const draft = join(dir, 'draft.json');
  writeFileSync(draft, `${JSON.stringify({ schemaVersion: 1, repos: {} }, null, 2)}\n`);
  for (const args of [['--draft', draft], ['--draft', join(dir, 'missing.json')], []]) {
    const deps = { env: {}, home, keyFile: join(dir, 'no-key') };
    const [a, b] = [await run(['config', ...args], deps), await respike(['config', ...args], deps)];
    assert.equal(a.code, b.code, args.join(' '));
    assert.equal(a.stdout, b.stdout, args.join(' '));
    if (args.length) assert.equal(a.stderr, b.stderr, args.join(' '));
  }
});
