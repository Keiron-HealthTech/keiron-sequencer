import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approveHash, approvedPlan } from '../scripts/lib/start/plan.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import { CARD, fakeStartFixture, GIT_BRANCH_NAME, SENTINEL, startIssue } from './helpers/start-fixture.mjs';

guardNetwork();

const fixture = (t, opts) => {
  const f = fakeStartFixture(opts);
  t.after(f.dispose);
  return f;
};
const plan = async f => {
  const r = await f.run(['plan', CARD]);
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const depsOf = f => ({ ...f.deps, key: SENTINEL });
const strip = ({ schemaVersion, approve, ...p }) => p;

test('the approve hash is twelve hex characters, stable across runs and equal to approveHash of the plan', async t => {
  const f = fixture(t);
  const [one, two] = [await plan(f), await plan(f)];
  assert.match(one.approve, /^[0-9a-f]{12}$/);
  assert.equal(one.approve, two.approve);
  assert.equal(approveHash(strip(one)), one.approve);
});

test('the hash moves with the dirty count, the head, the checkout branch, the base, the action and the branch name', async t => {
  const p = strip(await plan(fixture(t)));
  const base = approveHash(p);
  const changed = [
    { ...p, checkout: { ...p.checkout, dirty: 1 } },
    { ...p, checkout: { ...p.checkout, head: 'b'.repeat(40) } },
    { ...p, checkout: { ...p.checkout, branch: 'other' } },
    { ...p, checkout: { ...p.checkout, path: '/elsewhere' } },
    { ...p, base: { ...p.base, kind: 'stack', ref: 'origin/user/abc-2-x' } },
    { ...p, base: { ...p.base, ref: 'origin/other' } },
    { ...p, action: 'wait' },
    { ...p, reasons: [{ code: 'dirty-checkout', message: 'x', blocking: false }] },
    { ...p, branch: { ...p.branch, name: 'user/other' } },
    { ...p, branch: { ...p.branch, rule: 'strip-card-id' } },
    { ...p, resume: { ...p.resume, branches: [{ name: 'abc-1-x', where: 'local', path: null }] } },
  ];
  for (const [i, q] of changed.entries()) assert.notEqual(approveHash(q), base, `change ${i}`);
});

test('the hash ignores fields the user does not confirm: comments, staleness, the brief, warnings and reason messages', async t => {
  const p = strip(await plan(fixture(t)));
  const base = approveHash(p);
  const same = [
    { ...p, card: { ...p.card, comments: [{ createdAt: '2026-11-10T00:00:00Z', body: 'new' }], description: 'edited' } },
    { ...p, staleness: { ...p.staleness, computed: true, reason: null } },
    { ...p, brief: { ...p.brief, otherRepos: [{ dir: 'x', name: 'x' }] } },
    { ...p, warnings: ['something'] },
    { ...p, reasons: p.reasons.map(r => ({ ...r, message: `${r.message} (reworded)` })) },
  ];
  for (const [i, q] of same.entries()) assert.equal(approveHash(q), base, `field ${i}`);
});

test('approvedPlan recomputes the plan: the hash shown gives the plan back, another hash is refused naming both', async t => {
  const f = fixture(t);
  const shown = await plan(f);
  const ok = await approvedPlan(CARD, shown.approve, depsOf(f));
  assert.equal(ok.refused, undefined);
  assert.deepEqual(ok.plan, shown);
  const other = 'f'.repeat(12);
  const no = await approvedPlan(CARD, other, depsOf(f));
  assert.equal(no.plan, undefined);
  assert.ok(no.refused.includes(other) && no.refused.includes(shown.approve), no.refused);
});

test('approvedPlan refuses when the checkout changed since the plan, even only its dirty count', async t => {
  let status = '';
  const f = fixture(t, { git: { status: () => status } });
  const shown = await plan(f);
  status = '?? new-file\n';
  const no = await approvedPlan(CARD, shown.approve, depsOf(f));
  assert.match(no.refused, /changed/);
});

test('approvedPlan refuses when the card changed in Linear in a way the plan hashes', async t => {
  const issues = [startIssue(CARD, { gitBranchName: GIT_BRANCH_NAME })];
  const f = fixture(t, { issues });
  const shown = await plan(f);
  f.linear.store.issues.find(i => i.identifier === CARD).gitBranchName = 'user/abc-1-renamed';
  const no = await approvedPlan(CARD, shown.approve, depsOf(f));
  assert.ok(no.refused, 'a renamed branch must be refused');
});
