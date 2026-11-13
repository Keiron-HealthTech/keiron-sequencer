import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyBlocker } from '../scripts/lib/start/base.mjs';
import { prsFor } from '../scripts/lib/start/checkout.mjs';
import { fakeGitHub } from './helpers/fake-git.mjs';
import { guardNetwork } from './helpers/no-network.mjs';

guardNetwork();

const FIELDS = 'number,state,isDraft,mergedAt,baseRefName,headRefName,title,url';
const ghPr = (over = {}) => ({
  number: 10, state: 'OPEN', isDraft: false, mergedAt: null, baseRefName: 'main', headRefName: 'user/abc-2-x',
  title: '[ABC-2] the blocker', url: 'https://github.com/acme/app/pull/10', ...over,
});
const known = [{ dir: 'app', github: 'acme/app' }, { dir: 'web', github: 'acme/web' }];
const lookup = (gh, over = {}) => prsFor(gh.run, { key: 'ABC-2', search: [known[0]], known, attachments: [], given: [], ...over });
const byArgv = table => argv => {
  const hit = table.find(([match]) => match(argv));
  return hit ? JSON.stringify(hit[1]) : '[]';
};
const isList = github => argv => argv[1] === 'list' && argv.includes(github) && argv.includes('--search');
const isView = (github, n) => argv => argv[1] === 'view' && argv[2] === String(n) && argv.includes(github);

test('a blocker search in the repo returns a PR the classifier can use', () => {
  const gh = fakeGitHub(byArgv([[isList('acme/app'), [ghPr()]]]));
  const { prs } = lookup(gh);
  assert.deepEqual(gh.calls.map(c => c.argv), [['pr', 'list', '--repo', 'acme/app', '--state', 'all', '--search', 'ABC-2', '--json', FIELDS]]);
  assert.deepEqual(prs, [{ repoDir: 'app', github: 'acme/app', ...ghPr(), via: 'search' }]);
  const blocker = { key: 'ABC-2', linearState: { name: 'In Progress', type: 'started' }, prs, pushedBranch: null };
  assert.equal(classifyBlocker(blocker, { currentRepoDir: 'app', defaultBranchOf: () => 'main' }).status, 'open');
});

test('search hits count only when the title carries the card id in brackets or parentheses, in any case', () => {
  const hits = [
    ghPr({ number: 1, title: '[ABC-2] bracket' }), ghPr({ number: 2, title: 'fix (abc-2) paren' }),
    ghPr({ number: 3, title: 'number only, matched by #2' }), ghPr({ number: 4, title: '[ABC-20] longer id' }), ghPr({ number: 5, title: 'ABC-2 bare' }),
  ];
  const { prs } = lookup(fakeGitHub(byArgv([[isList('acme/app'), hits]])));
  assert.deepEqual(prs.map(p => p.number), [1, 2]);
});

test('each allowed repo is searched; attachment and given PRs are read with pr view in their own repo', () => {
  const gh = fakeGitHub(byArgv([
    [isList('acme/web'), [ghPr({ number: 5, url: 'https://github.com/acme/web/pull/5' })]],
    [isView('acme/app', 7), ghPr({ number: 7, title: 'no tag in the title', url: 'https://github.com/acme/app/pull/7' })],
    [isView('other/lib', 3), ghPr({ number: 3, title: 'given', url: 'https://github.com/other/lib/pull/3' })],
  ]));
  const { prs } = lookup(gh, {
    search: known, attachments: ['https://github.com/acme/app/pull/7'], given: ['https://github.com/other/lib/pull/3'],
  });
  assert.deepEqual(prs.map(p => [p.number, p.repoDir, p.github, p.via]), [
    [3, null, 'other/lib', 'given'], [7, 'app', 'acme/app', 'attachment'], [5, 'web', 'acme/web', 'search'],
  ]);
  for (const c of gh.calls) assert.ok(['pr list', 'pr view'].includes(c.argv.slice(0, 2).join(' ')), c.argv.join(' '));
  assert.ok(gh.calls.some(c => c.argv.join(' ') === `pr view 7 --repo acme/app --json ${FIELDS}`));
});

test('the same PR found twice is listed once, keeping the most explicit source', () => {
  const url = 'https://github.com/acme/app/pull/10';
  const gh = fakeGitHub(byArgv([[isList('acme/app'), [ghPr()]], [isView('acme/app', 10), ghPr()]]));
  const { prs } = lookup(gh, { attachments: [url], given: [url] });
  assert.deepEqual(prs.map(p => [p.number, p.via]), [[10, 'given']]);
});

test('a gh failure is reported as unavailable, never read as no PRs', () => {
  const gh = fakeGitHub(argv => (argv[1] === 'list' ? { status: 1, stderr: 'HTTP 401: bad credentials' } : '[]'));
  const out = lookup(gh);
  assert.deepEqual(out.prs, []);
  assert.match(out.unavailable, /gh pr list .*acme\/app.*401/);
});

test('a blocker whose GitHub lookup failed is unverified, even when Linear says unstarted', () => {
  const blocker = { key: 'ABC-2', linearState: { name: 'Todo', type: 'unstarted' }, prs: [], pushedBranch: { name: 'abc-2', via: 'ls-remote' }, lookupFailed: 'gh down' };
  const out = classifyBlocker(blocker, { currentRepoDir: 'app', defaultBranchOf: () => 'main' });
  assert.equal(out.status, 'unverified');
  assert.match(out.warning, /gh down/);
});

test('a failed pr view names the PR and its repo', () => {
  const gh = fakeGitHub(argv => (argv[1] === 'view' ? { status: 1, stderr: 'not found' } : '[]'));
  const out = lookup(gh, { attachments: ['https://github.com/acme/app/pull/7'] });
  assert.match(out.unavailable, /gh pr view acme\/app#7 failed \(1\): not found/);
});
