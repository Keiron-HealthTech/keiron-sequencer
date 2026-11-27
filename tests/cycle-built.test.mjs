import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BRANCH_LEFT, builtState, MERGED_LEFT, OPEN_PR_LEFT, readBuilt } from '../scripts/lib/cycle/built.mjs';
import { fakeGitHub } from './helpers/fake-git.mjs';
import { guardNetwork } from './helpers/no-network.mjs';

guardNetwork();

const DEFAULTS = { 'acme/app': 'development', 'acme/auth': 'main' };
const defaultOf = p => DEFAULTS[p.github] ?? null;
const pr = (number, over = {}) => ({
  github: 'acme/app', repoDir: 'app', number, state: 'OPEN', isDraft: false, mergedAt: null, baseRefName: 'development',
  headRefName: `abc-1-x-${number}`, title: `[ABC-1] x`, url: `https://github.com/acme/app/pull/${number}`, ...over,
});
const merged = (number, mergedAt, over = {}) => pr(number, { state: 'MERGED', mergedAt, ...over });
const NO_WORK = { local: [], repos: new Map() };
const state = (prs, work = NO_WORK) => builtState('ABC-1', prs, work, defaultOf);

test('a PR merged into the default branch is merged, 10% left, with its merge time', () => {
  assert.deepEqual(state([merged(7, '2026-11-20T10:00:00Z')]), {
    kind: 'merged', fraction: MERGED_LEFT, evidence: 'merged app#7', mergedAt: '2026-11-20T10:00:00Z',
  });
});

test('an open [Prod] port beside a merged PR is not more work: the card stays merged', () => {
  const s = state([merged(7, '2026-11-20T10:00:00Z'), pr(9, { baseRefName: 'main', title: '[Prod] [ABC-1] x' })]);
  assert.deepEqual([s.kind, s.fraction], ['merged', MERGED_LEFT]);
});

test('a second PR still open into the default branch beside a merged one is open work, 25% left', () => {
  const s = state([merged(7, '2026-11-20T10:00:00Z'), pr(9)]);
  assert.deepEqual([s.kind, s.fraction, s.evidence, s.mergedAt], ['pr', OPEN_PR_LEFT, 'PR app#9', null]);
});

test('an open PR, draft or ready, is 25% left', () => {
  assert.deepEqual([state([pr(3, { isDraft: true })]).fraction, state([pr(3, { isDraft: true })]).evidence], [OPEN_PR_LEFT, 'draft PR app#3']);
  assert.deepEqual([state([pr(4)]).kind, state([pr(4)]).evidence], ['pr', 'PR app#4']);
});

test('a PR merged only into another branch waits on that branch, like an open PR', () => {
  const s = state([merged(5, '2026-11-20T10:00:00Z', { baseRefName: 'abc-0-parent' })]);
  assert.deepEqual([s.kind, s.fraction, s.evidence, s.mergedAt], ['pr', OPEN_PR_LEFT, 'app#5 merged into abc-0-parent', null]);
});

test('a card is as built as its least built repo', () => {
  const s = state([merged(7, '2026-11-20T10:00:00Z'), pr(2, { github: 'acme/auth', repoDir: 'auth', baseRefName: 'main', isDraft: true })]);
  assert.deepEqual([s.kind, s.fraction, s.evidence, s.mergedAt], ['pr', OPEN_PR_LEFT, 'merged app#7, draft PR auth#2', null]);
  const both = state([merged(7, '2026-11-20T10:00:00Z'), merged(2, '2026-11-22T10:00:00Z', { github: 'acme/auth', repoDir: 'auth', baseRefName: 'main' })]);
  assert.deepEqual([both.kind, both.mergedAt], ['merged', '2026-11-22T10:00:00Z']);
});

test('a branch with no PR is 50% left, pushed or local; a card with a PR ignores its branches', () => {
  const pushed = { local: [], repos: new Map([['app', { heads: { 'abc-1-guard': 'sha' } }]]) };
  const local = { local: [{ repoDir: 'app', path: '/src/app', branch: 'claude/abc-1-x', kind: 'branch' }], repos: new Map() };
  assert.deepEqual(state([], pushed), { kind: 'branch', fraction: BRANCH_LEFT, evidence: 'branch abc-1-guard pushed', mergedAt: null });
  assert.deepEqual([state([], local).fraction, state([], local).evidence], [BRANCH_LEFT, 'branch claude/abc-1-x local']);
  assert.equal(state([merged(7, '2026-11-20T10:00:00Z')], pushed).kind, 'merged');
});

test('a card with no PR and no branch has no build state', () => {
  assert.equal(state([]), null);
});

test("readBuilt reads every open card of the team, through next's readers, and a failed repo is a warning", () => {
  const TEAM = { id: 'team-abc' };
  const issue = (identifier, over = {}) => ({
    identifier, title: `Card ${identifier}`, state: { name: 'In Progress', type: 'started' }, team: TEAM, labels: { nodes: [] }, archivedAt: null, ...over,
  });
  const raw = {
    project: { slug: 'p1' },
    issues: [
      issue('ABC-1'), issue('ABC-2', { state: { name: 'Done', type: 'completed' } }), issue('ABC-3', { team: { id: 'other' } }),
      issue('ABC-4', { state: { name: 'Todo', type: 'unstarted' } }),
    ],
  };
  const config = { repos: { app: { github: 'acme/app', defaultBranch: 'development' }, auth: { github: 'acme/auth', defaultBranch: 'main' } } };
  const github = fakeGitHub(argv => {
    if (argv.includes('acme/auth')) return { status: 1, stderr: 'HTTP 502' };
    if (argv.includes('open')) return JSON.stringify([{ ...pr(3, { isDraft: true }), github: undefined, repoDir: undefined }]);
    return '[]';
  });
  const r = readBuilt({ raw, team: TEAM, config, gh: github.run, git: () => '', listDir: () => [] });
  assert.deepEqual([...r.built].map(([k, v]) => [k, v.kind, v.evidence]), [['ABC-1', 'pr', 'draft PR app#3']]);
  const searched = github.calls.filter(c => c.argv.includes('--search')).map(c => c.argv[c.argv.indexOf('--search') + 1]);
  assert.ok(searched.every(q => q.includes('"ABC-1"') && q.includes('"ABC-4"') && !q.includes('ABC-2') && !q.includes('ABC-3')), searched.join(' | '));
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /^build state may be incomplete: .*acme\/auth.*HTTP 502/);
});
