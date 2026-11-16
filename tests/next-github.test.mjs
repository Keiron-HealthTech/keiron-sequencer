import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pullRequests } from '../scripts/lib/next/github.mjs';
import { fakeGitHub } from './helpers/fake-git.mjs';
import { guardNetwork } from './helpers/no-network.mjs';

guardNetwork();

const APP = { dir: 'app', github: 'acme/app' };
const WEB = { dir: 'web', github: 'acme/web' };
const OPS = { dir: 'ops', github: 'acme/ops' };

const pr = (n, title, over = {}) => ({
  number: n, state: 'OPEN', isDraft: false, mergedAt: null, baseRefName: 'main', headRefName: `b-${n}`, title,
  url: `https://github.com/acme/app/pull/${n}`, ...over,
});
const merged = (n, title, over) => pr(n, title, { state: 'MERGED', mergedAt: '2026-11-01T00:00:00Z', ...over });

const at = (argv, flag) => argv[argv.indexOf(flag) + 1];
const repoOf = argv => at(argv, '--repo');
const stateOf = argv => at(argv, '--state');
const searchOf = argv => (argv.includes('--search') ? at(argv, '--search') : null);

// Answers by repo and state; a function answer gets the argv.
const ghFrom = table => fakeGitHub(argv => {
  if (argv[1] === 'view') return JSON.stringify(table.view?.[`${repoOf(argv)}#${argv[2]}`] ?? null);
  const answer = table[repoOf(argv)]?.[stateOf(argv)];
  if (answer && typeof answer === 'object' && 'status' in answer) return answer;
  return JSON.stringify(typeof answer === 'function' ? answer(argv) : answer ?? []);
});
const run = (gh, over = {}) => pullRequests(gh.run, { repos: [APP], known: [APP], keys: [], offMapKeys: [], attachments: new Map(), ...over });
const numbers = (byKey, key) => (byKey.get(key) ?? []).map(p => p.number).sort((a, b) => a - b);

test('one open listing per repo, merged ids batched by 20, PRs filed by title tag', () => {
  const keys = Array.from({ length: 25 }, (_, i) => `CRM-${i + 1}`);
  const gh = ghFrom({ 'acme/app': { open: [pr(1, '[CRM-1] a')], merged: argv => (searchOf(argv).includes('"CRM-2"') ? [merged(2, '(CRM-2) b')] : []) } });
  const { byKey, failed } = run(gh, { keys });
  const calls = gh.calls.map(c => c.argv);
  assert.equal(calls.filter(a => stateOf(a) === 'open').length, 1);
  assert.equal(calls.find(a => stateOf(a) === 'open').includes('--search'), false);
  assert.deepEqual(calls.filter(a => stateOf(a) === 'merged').map(a => searchOf(a).split(' OR ').length), [20, 5]);
  assert.match(searchOf(calls.find(a => stateOf(a) === 'merged')), /^"CRM-1" OR "CRM-2" OR .* in:title$/);
  assert.deepEqual([numbers(byKey, 'CRM-1'), numbers(byKey, 'CRM-2')], [[1], [2]]);
  assert.equal(failed.size, 0);
});

test('every project repo is listed once', () => {
  const gh = ghFrom({ 'acme/app': { open: [pr(1, '[CRM-1] a')] }, 'acme/web': { open: [pr(5, '[CRM-5] w', { url: 'https://github.com/acme/web/pull/5' })] } });
  const { byKey } = run(gh, { repos: [APP, WEB], known: [APP, WEB] });
  assert.deepEqual(gh.calls.map(c => repoOf(c.argv)).sort(), ['acme/app', 'acme/web']);
  assert.equal(byKey.get('CRM-5')[0].repoDir, 'web');
});

test('CRM-12 is not filed under a PR titled [CRM-123]', () => {
  const { byKey } = run(ghFrom({ 'acme/app': { open: [pr(9, '[CRM-123] other')] } }), { keys: ['CRM-12'] });
  assert.equal(byKey.has('CRM-12'), false);
  assert.deepEqual(numbers(byKey, 'CRM-123'), [9]);
});

test('a PR tagging two cards is filed under both', () => {
  const { byKey } = run(ghFrom({ 'acme/app': { open: [pr(4, '[CRM-1][CRM-2] shared')] } }));
  assert.deepEqual([numbers(byKey, 'CRM-1'), numbers(byKey, 'CRM-2')], [[4], [4]]);
});

test('a title that only mentions an id without a tag files nothing', () => {
  const { byKey } = run(ghFrom({ 'acme/app': { open: [pr(4, 'follow-up to CRM-1')] } }));
  assert.equal(byKey.size, 0);
});

test('off-map keys are searched, state all, in every configured repo', () => {
  const gh = ghFrom({ 'acme/ops': { all: [merged(7, '[OPS-3] infra', { url: 'https://github.com/acme/ops/pull/7' })] } });
  const { byKey } = run(gh, { known: [APP, OPS], offMapKeys: ['OPS-3'] });
  const all = gh.calls.map(c => c.argv).filter(a => stateOf(a) === 'all');
  assert.deepEqual(all.map(repoOf).sort(), ['acme/app', 'acme/ops']);
  assert.ok(all.every(a => searchOf(a) === '"OPS-3" in:title'));
  assert.equal(byKey.get('OPS-3')[0].repoDir, 'ops');
});

test('an attachment already listed costs no call; an unlisted one costs one pr view', () => {
  const gh = ghFrom({ 'acme/app': { open: [pr(1, 'no tag here')] }, view: { 'acme/app#2': merged(2, 'no tag either') } });
  const attachments = new Map([['CRM-1', ['https://github.com/acme/app/pull/1']], ['CRM-2', ['https://github.com/acme/app/pull/2']]]);
  const { byKey } = run(gh, { attachments });
  assert.deepEqual(gh.calls.filter(c => c.argv[1] === 'view').map(c => c.argv[2]), ['2']);
  assert.deepEqual([numbers(byKey, 'CRM-1'), numbers(byKey, 'CRM-2')], [[1], [2]]);
  assert.equal(byKey.get('CRM-2')[0].via, 'attachment');
});

test('a failing repo lands in failed, and the other repo still answers', () => {
  const gh = ghFrom({ 'acme/app': { open: { status: 1, stdout: '', stderr: 'HTTP 502' } }, 'acme/web': { open: [pr(5, '[CRM-5] w')] } });
  const { byKey, failed } = run(gh, { repos: [APP, WEB], known: [APP, WEB] });
  assert.deepEqual([...failed.keys()], ['acme/app']);
  assert.match(failed.get('acme/app'), /HTTP 502/);
  assert.deepEqual(numbers(byKey, 'CRM-5'), [5]);
});

test('no keys means no merged search', () => {
  const gh = ghFrom({});
  run(gh);
  assert.deepEqual(gh.calls.map(c => stateOf(c.argv)), ['open']);
});

test('a listing that comes back at its limit is treated as a failed read of that repo', () => {
  const full = Array.from({ length: 200 }, (_, i) => merged(1000 + i, `[CRM-${1000 + i}] x`));
  const { failed } = run(ghFrom({ 'acme/app': { merged: full } }), { keys: ['CRM-1'] });
  assert.match(failed.get('acme/app'), /limit of 200/);
});

test('a failed attachment view is charged to its card, not to a repo', () => {
  const gh = fakeGitHub(argv => (argv[1] === 'view' ? { status: 1, stdout: '', stderr: 'HTTP 404' } : '[]'));
  const { failed, failedFor } = run(gh, { attachments: new Map([['CRM-2', ['https://github.com/Other/Repo/pull/9']]]) });
  assert.equal(failed.size, 0);
  assert.match(failedFor.get('CRM-2'), /HTTP 404/);
});

test('failed repos are keyed in lowercase', () => {
  const { failed } = run(ghFrom({ 'Acme/App': { open: { status: 1, stdout: '', stderr: 'HTTP 502' } } }), { repos: [{ dir: 'app', github: 'Acme/App' }], known: [{ dir: 'app', github: 'Acme/App' }] });
  assert.deepEqual([...failed.keys()], ['acme/app']);
});

test('a lowercase tag files under the card, as start reads it', () => {
  const { byKey } = run(ghFrom({ 'acme/app': { open: [pr(3, '[crm-12] lower')] } }));
  assert.deepEqual(numbers(byKey, 'CRM-12'), [3]);
});

test('one bracket naming several cards files the PR under each', () => {
  const { byKey } = run(ghFrom({ 'acme/app': { open: [pr(5, '(CRM-1, CRM-2) both'), pr(6, '[CRM-3/CRM-4] pair'), pr(7, '[CRM-5 & CRM-6] and')] } }));
  assert.deepEqual(['CRM-1', 'CRM-2', 'CRM-3', 'CRM-4', 'CRM-5', 'CRM-6'].map(k => numbers(byKey, k)), [[5], [5], [6], [6], [7], [7]]);
});
