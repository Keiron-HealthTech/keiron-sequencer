import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardNetwork } from './helpers/no-network.mjs';
import { CARD, fakeStartFixture, GIT_BRANCH_NAME, startIssue } from './helpers/start-fixture.mjs';

guardNetwork();

const blocks = to => ({ relations: { nodes: [{ type: 'blocks', relatedIssue: { identifier: to } }] } });
const card = startIssue(CARD, { gitBranchName: GIT_BRANCH_NAME });
const fixture = (t, opts = {}) => {
  const f = fakeStartFixture({ issues: [card, ...(opts.extra ?? [])], ...opts });
  t.after(f.dispose);
  return f;
};
const plan = async (f, argv) => {
  const r = await f.run(['plan', CARD, ...argv]);
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const startIssueReads = f => f.linear.sent.filter(s => /^\s*query StartIssue\b/.test(s.body.query)).map(s => s.body.variables.id);

test('the usage lists every blocker flag of plan', async t => {
  const f = fixture(t);
  const r = await f.run([]);
  assert.equal(r.code, 2);
  for (const flag of ['--blocker <CARD>', '--blocker-pr <CARD>=<PR url>', '--blocker-branch <CARD>=<branch>', '--skip-blocker <CARD>']) {
    assert.ok(r.stderr.includes(`[${flag}]...`), flag);
  }
});

test('a keyed flag without <CARD>= is a usage error naming the flag, before any request', async t => {
  const f = fixture(t);
  for (const [flag, value] of [['--blocker-pr', 'https://github.com/acme/app/pull/3'], ['--blocker-branch', 'user/abc-2-x']]) {
    const r = await f.run(['plan', CARD, flag, value]);
    assert.equal(r.code, 2, flag);
    assert.match(r.stderr, new RegExp(`${flag} expects <CARD>=`));
  }
  assert.equal(f.linear.sent.length, 0);
});

test('a bad card key, a non-PR url, an unknown flag or a missing value is a usage error', async t => {
  const f = fixture(t);
  const bad = [
    ['--blocker', 'abc-2'], ['--skip-blocker', 'nope'], ['--blocker-pr', 'ABC-2=https://example.com/x'],
    ['--blocker-branch', 'ABC-2='], ['--bogus', 'x'], ['--blocker'],
  ];
  for (const argv of bad) assert.equal((await f.run(['plan', CARD, ...argv])).code, 2, argv.join(' '));
  assert.equal(f.linear.sent.length, 0);
});

test('every flag repeats, and a keyed value splits on its first =', async t => {
  const extra = [startIssue('ABC-2', blocks(CARD)), startIssue('ABC-3'), startIssue('ABC-4')];
  const f = fixture(t, { extra, git: { 'ls-remote': '' } });
  const out = await plan(f, ['--blocker', 'ABC-3', '--blocker', 'ABC-4', '--blocker-branch', 'ABC-2=feat/a=b', '--blocker-branch', 'ABC-3=c']);
  assert.deepEqual(out.blockers.map(b => [b.key, b.source]), [['ABC-2', 'linear'], ['ABC-3', 'given'], ['ABC-4', 'given']]);
  const lookedUp = f.git.calls.filter(c => c.argv.length === 4 && c.sub === 'ls-remote').map(c => c.argv[3]);
  assert.deepEqual(lookedUp, ['refs/heads/feat/a=b', 'refs/heads/c']);
});

test('an extra blocker that is canceled or archived is ignored with a warning', async t => {
  const extra = [startIssue('ABC-7', { state: { name: 'Canceled', type: 'canceled' } }), startIssue('ABC-8', { archivedAt: '2026-10-01T00:00:00Z' })];
  const f = fixture(t, { extra });
  const out = await plan(f, ['--blocker', 'ABC-7', '--blocker', 'ABC-8']);
  assert.deepEqual(out.blockers, []);
  assert.ok(out.warnings.some(w => /ABC-7.*canceled/.test(w)), out.warnings.join('; '));
  assert.ok(out.warnings.some(w => /ABC-8.*archived/.test(w)), out.warnings.join('; '));
  assert.equal(out.base.kind, 'default');
});

test('an extra blocker Linear does not know exits 1 naming it', async t => {
  const f = fixture(t);
  const r = await f.run(['plan', CARD, '--blocker', 'ABC-99']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /ABC-99 was not found in Linear/);
});

test('a skipped blocker is listed apart and never read; a flag naming a non-blocker is ignored with a warning', async t => {
  const extra = [startIssue('ABC-2', blocks(CARD)), startIssue('ABC-5')];
  const f = fixture(t, { extra });
  const out = await plan(f, ['--skip-blocker', 'ABC-2', '--blocker-pr', 'ABC-5=https://github.com/acme/app/pull/5', '--skip-blocker', 'ABC-6']);
  assert.deepEqual(out.blockers, []);
  assert.deepEqual(out.skippedBlockers, [{ key: 'ABC-2', source: 'linear' }]);
  assert.ok(!startIssueReads(f).includes('ABC-2'));
  assert.ok(out.warnings.some(w => /--blocker-pr ABC-5: not a blocker/.test(w)), out.warnings.join('; '));
  assert.ok(out.warnings.some(w => /--skip-blocker ABC-6: not a blocker/.test(w)), out.warnings.join('; '));
  assert.equal(out.base.kind, 'default');
});
