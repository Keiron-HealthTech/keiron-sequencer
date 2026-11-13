import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { branchNameFor, startSettings } from '../scripts/lib/start/config.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import { CARD, GIT_BRANCH_NAME, startFixture, startIssue } from './helpers/start-fixture.mjs';

guardNetwork();

const repo = (over = {}) => ({
  name: 'app-repo', github: 'acme/app', checkout: '/src/app', url: null, remote: 'origin', defaultBranch: 'main',
  branchNaming: 'verbatim', ...over,
});
const config = (over = {}) => ({ schemaVersion: 1, repos: { app: repo(over), other: repo({ name: 'other', github: 'acme/other' }) } });

test('startSettings returns the current repo settings, with the optional keys defaulted', () => {
  assert.deepEqual(startSettings(config(), 'app'), { settings: {
    repoDir: 'app', name: 'app-repo', github: 'acme/app', remote: 'origin', defaultBranch: 'main', branchNaming: 'verbatim',
    typecheck: [], typecheckTimeoutMs: null, notes: [],
  } });
  const full = config({ typecheck: [['npm', 'run', 'typecheck']], typecheckTimeoutMs: 1000, notes: ['n'] });
  const { settings } = startSettings(full, 'app');
  assert.deepEqual([settings.typecheck, settings.typecheckTimeoutMs, settings.notes], [[['npm', 'run', 'typecheck']], 1000, ['n']]);
});

test('each key start needs is an error naming repos.<dir>.<key>, and every missing key is listed', () => {
  const table = [
    [{ branchNaming: undefined }, 'repos.app.branchNaming'],
    [{ defaultBranch: null }, 'repos.app.defaultBranch'],
    [{ defaultBranch: undefined }, 'repos.app.defaultBranch'],
    [{ github: undefined }, 'repos.app.github'],
    [{ remote: null }, 'repos.app.remote'],
  ];
  for (const [over, key] of table) {
    const { errors, settings } = startSettings(config(over), 'app');
    assert.equal(settings, undefined, key);
    assert.equal(errors.length, 1, `${key}: ${errors}`);
    assert.ok(errors[0].startsWith(`${key}: `), errors[0]);
  }
  const all = startSettings(config({ branchNaming: undefined, defaultBranch: null, github: undefined, remote: null }), 'app');
  assert.deepEqual(all.errors.map(e => e.slice(0, e.indexOf(':'))),
    ['repos.app.branchNaming', 'repos.app.defaultBranch', 'repos.app.github', 'repos.app.remote']);
});

test('only the current repo is checked: a gap in another repo is not an error', () => {
  const c = config();
  c.repos.other.branchNaming = undefined;
  c.repos.other.defaultBranch = null;
  assert.ok(startSettings(c, 'app').settings);
  assert.ok(startSettings(c, 'other').errors.length === 2);
});

test('verbatim uses the Linear branch name as given', () => {
  assert.deepEqual(branchNameFor('verbatim', 'User/ABC-1-Some_Title', CARD),
    { name: 'User/ABC-1-Some_Title', source: 'linear', rule: 'verbatim', editable: false });
});

test('strip-card-id removes the card id where it opens a path component, in any case, and the name is editable', () => {
  const table = [
    ['user/abc-1-some-title', 'user/some-title'],
    ['abc-1-some-title', 'some-title'],
    ['User/ABC-1-Some-Title', 'User/Some-Title'],
    ['feat/team/abc-1-x', 'feat/team/x'],
    ['user/abc-10-x', 'user/abc-10-x'],
    ['user/fix-abc-1-x', 'user/fix-abc-1-x'],
    ['user/xabc-1-y', 'user/xabc-1-y'],
  ];
  for (const [given, expected] of table) {
    assert.deepEqual(branchNameFor('strip-card-id', given, CARD),
      { name: expected, source: 'derived', rule: 'strip-card-id', editable: true }, given);
  }
});

test('no Linear branch name, or a rule that leaves an empty name or an empty path component, gives no name and keeps the rule', () => {
  for (const [rule, given] of [['verbatim', null], ['verbatim', ''], ['strip-card-id', null], ['strip-card-id', 'abc-1-'], ['strip-card-id', 'user/abc-1-']]) {
    const branch = branchNameFor(rule, given, CARD);
    assert.equal(branch.name, null, `${rule} ${given}`);
    assert.equal(branch.rule, rule);
    assert.equal(branch.editable, false);
  }
});

const withConfig = (t, edit, issues) => {
  const f = startFixture(issues ? { issues } : undefined);
  t.after(f.dispose);
  const c = structuredClone(f.config);
  edit(c.repos.app);
  writeFileSync(join(f.home, 'config.json'), JSON.stringify(c));
  return f;
};

test('through the CLI each missing start key is exit 2 naming the key and the repo, and nothing is printed on stdout', async t => {
  const table = [
    [r => { delete r.branchNaming; }, 'repos.app.branchNaming'],
    [r => { r.defaultBranch = null; }, 'repos.app.defaultBranch'],
    [r => { delete r.github; }, 'repos.app.github'],
    [r => { r.remote = null; }, 'repos.app.remote'],
  ];
  for (const [edit, key] of table) {
    const f = withConfig(t, edit);
    const r = await f.run(['plan', CARD]);
    assert.equal(r.code, 2, `${key}: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`^${key.replace(/\./g, '\\.')}: `, 'm'));
    assert.equal(r.stdout, '');
    assert.deepEqual(f.linear.mutations, []);
  }
});

test('through the CLI a strip-card-id repo gets the derived, editable name', async t => {
  const f = withConfig(t, r => { r.branchNaming = 'strip-card-id'; });
  const r = await f.run(['plan', CARD]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(GIT_BRANCH_NAME, 'user/abc-1-some-title');
  assert.deepEqual(JSON.parse(r.stdout).branch, { name: 'user/some-title', source: 'derived', rule: 'strip-card-id', editable: true });
});

test('through the CLI a card with no Linear branch name still prints a plan, with no branch name', async t => {
  const f = withConfig(t, () => {}, [startIssue(CARD, { gitBranchName: null })]);
  const r = await f.run(['plan', CARD]);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.branch.name, null);
  assert.equal(out.branch.rule, 'verbatim');
  assert.match(out.approve, /^[0-9a-f]{12}$/);
});
