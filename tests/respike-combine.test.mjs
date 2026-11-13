import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { combineTree } from '../scripts/lib/spike/combine.mjs';
import { gitRunner } from '../scripts/lib/spike/exec.mjs';
import { makeRepo, SANDBOX_ENV, tempDir } from './helpers/git-sandbox.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import { snapshotDir, walk } from './helpers/respike-fixture.mjs';

guardNetwork();

const LIST = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
const text = lines => `${lines.join('\n')}\n`;
const edit = (n, value) => LIST.map((l, i) => (i === n - 1 ? value : l));

function history() {
  const repo = makeRepo();
  after(repo.dispose);
  const sha = ref => repo.git(['rev-parse', ref]).trim();
  writeFileSync(join(repo.dir, 'list.txt'), text(LIST));
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'list']);
  const branch = (name, from, change, file = 'list.txt') => {
    repo.git(['checkout', '-q', '-b', name, from]);
    writeFileSync(join(repo.dir, file), change);
    repo.git(['add', '-A']);
    repo.git(['commit', '-q', '-m', name]);
    repo.git(['checkout', '-q', 'main']);
    return sha(name);
  };
  const heads = {
    a: branch('a', 'main', text(edit(2, 'line2 from a'))),
    b: branch('b', 'main', text(edit(8, 'line8 from b'))),
    c: branch('c', 'main', text(edit(5, 'line5 from c'))),
    d: branch('d', 'main', text(edit(2, 'line2 from d'))),
  };
  heads.a2 = branch('a2', 'a', text(edit(2, 'line2 from a').map((l, i) => (i === 3 ? 'line4 from a2' : l))));
  return { repo, sha, heads, git: gitRunner({ env: SANDBOX_ENV }) };
}

const tree = (repo, ref) => repo.git(['rev-parse', `${ref}^{tree}`]).trim();
const head = (card, sha) => ({ card, sha });

test('two diverged heads that edit different hunks of one file combine into one clean tree', () => {
  const { repo, heads, git } = history();
  const out = combineTree(git, repo.dir, [head('CRM-1', heads.a), head('CRM-2', heads.b)]);
  assert.match(out.tree, /^[0-9a-f]{40}$/);
  const merged = repo.git(['show', `${out.tree}:list.txt`]);
  assert.match(merged, /^line2 from a$/m);
  assert.match(merged, /^line8 from b$/m);
});

test('three heads combine one at a time, and the same inputs give the same tree', () => {
  const { repo, heads, git } = history();
  const three = [head('CRM-1', heads.a), head('CRM-2', heads.b), head('CRM-3', heads.c)];
  const first = combineTree(git, repo.dir, three);
  assert.deepEqual(combineTree(git, repo.dir, three), first);
  const merged = repo.git(['show', `${first.tree}:list.txt`]);
  for (const line of ['line2 from a', 'line5 from c', 'line8 from b']) assert.match(merged, new RegExp(`^${line}$`, 'm'));
});

test('a head and its descendant, in either order, give the descendant\'s tree', () => {
  const { repo, heads, git } = history();
  assert.equal(combineTree(git, repo.dir, [head('CRM-1', heads.a), head('CRM-2', heads.a2)]).tree, tree(repo, 'a2'));
  assert.equal(combineTree(git, repo.dir, [head('CRM-2', heads.a2), head('CRM-1', heads.a)]).tree, tree(repo, 'a2'));
});

test('a conflicting pair is a conflict naming the cards and the paths both sides change', () => {
  const { repo, heads, git } = history();
  writeFileSync(join(repo.dir, 'other.txt'), 'x\n');
  const out = combineTree(git, repo.dir, [head('CRM-1', heads.a), head('CRM-4', heads.d)]);
  assert.deepEqual(out, { conflict: { reason: 'conflict', cards: ['CRM-1', 'CRM-4'], paths: ['list.txt'] } });
});

test('several merge bases at a later step are a merge-bases conflict', () => {
  const { repo, sha, heads, git } = history();
  repo.git(['checkout', '-q', '-b', 'p', 'a']);
  repo.git(['merge', '-q', '--no-edit', 'c']);
  repo.git(['checkout', '-q', '-b', 'q', 'c']);
  repo.git(['merge', '-q', '--no-edit', heads.a]);
  repo.git(['checkout', '-q', 'main']);
  const r = (() => {
    repo.git(['checkout', '-q', '-b', 'r', 'main']);
    writeFileSync(join(repo.dir, 'r.txt'), 'r\n');
    repo.git(['add', '-A']);
    repo.git(['commit', '-q', '-m', 'r']);
    repo.git(['checkout', '-q', 'main']);
    return sha('r');
  })();
  const out = combineTree(git, repo.dir, [head('CRM-1', sha('p')), head('CRM-2', r), head('CRM-3', sha('q'))]);
  assert.equal(out.conflict.reason, 'merge-bases');
  assert.deepEqual(out.conflict.cards, ['CRM-1', 'CRM-2', 'CRM-3']);
});

test('a head commit missing from the checkout is reported, not combined', () => {
  const { repo, heads, git } = history();
  const gone = '0123456789abcdef0123456789abcdef01234567';
  assert.deepEqual(combineTree(git, repo.dir, [head('CRM-1', heads.a), head('CRM-2', gone)]), { missing: [head('CRM-2', gone)] });
});

test('any other merge-tree failure is a runtime error that names the git requirement', () => {
  const { repo, sha, heads, git } = history();
  repo.git(['checkout', '-q', '--orphan', 'z']);
  repo.git(['commit', '-q', '-m', 'unrelated']);
  repo.git(['checkout', '-q', 'main']);
  assert.throws(() => combineTree(git, repo.dir, [head('CRM-1', heads.a), head('CRM-2', sha('z'))]), e => e.exitCode === 1 && /merge-tree --write-tree/.test(e.message) && /git 2\.38/.test(e.message));
});

test('with a temporary object directory the checkout\'s objects, refs, index and files are untouched and nothing is committed', () => {
  const { repo, heads, git } = history();
  const objects = resolve(repo.dir, repo.git(['rev-parse', '--git-path', 'objects']).trim());
  const scratch = tempDir('keiron-sequencer-combine-objects-');
  after(() => rmSync(scratch, { recursive: true, force: true }));
  const temp = mkdtempSync(join(scratch, 'objects-'));
  const before = {
    objects: snapshotDir(objects), refs: repo.git(['for-each-ref']), count: repo.git(['rev-list', '--count', '--all']),
    index: readFileSync(join(repo.dir, '.git', 'index')).toString('base64'), files: walk(repo.dir).filter(p => !p.startsWith('.git/')),
  };
  const env = { GIT_OBJECT_DIRECTORY: temp, GIT_ALTERNATE_OBJECT_DIRECTORIES: objects };
  const out = combineTree(git, repo.dir, [head('CRM-1', heads.a), head('CRM-2', heads.b), head('CRM-3', heads.c)], { env });
  assert.match(out.tree, /^[0-9a-f]{40}$/);
  assert.ok(walk(temp).length > 0);
  assert.deepEqual(snapshotDir(objects), before.objects);
  assert.equal(repo.git(['for-each-ref']), before.refs);
  assert.equal(repo.git(['rev-list', '--count', '--all']), before.count);
  assert.equal(readFileSync(join(repo.dir, '.git', 'index')).toString('base64'), before.index);
  assert.deepEqual(walk(repo.dir).filter(p => !p.startsWith('.git/')), before.files);
});

test('the combine names only cat-file, merge-base, merge-tree and diff', () => {
  const source = readFileSync(new URL('../scripts/lib/spike/combine.mjs', import.meta.url), 'utf8');
  const named = [...source.matchAll(/git\(\[\s*'([a-z-]+)'/g)].map(m => m[1]);
  assert.ok(named.length > 0);
  assert.deepEqual([...new Set(named)].filter(sub => !['cat-file', 'merge-base', 'merge-tree', 'diff'].includes(sub)), []);
  assert.doesNotMatch(source, /'(commit|commit-tree|update-ref|read-tree|push|tag)'/);
});
