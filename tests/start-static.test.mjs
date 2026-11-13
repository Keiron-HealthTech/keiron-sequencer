import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardNetwork } from './helpers/no-network.mjs';

guardNetwork();

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = file => readFileSync(join(ROOT, file), 'utf8');
const START = globSync(['scripts/start.mjs', 'scripts/lib/start/*.mjs'], { cwd: ROOT }).sort();
const SKILL = 'skills/start/SKILL.md';

const SOURCE_DENY = [
  'child_process', 'spawn(', "'commit'", "'push'", "'tag'", "'set-url'", 'git apply', 'git am', 'patch -p', "'apply'",
  'symbolic-ref', 'origin/HEAD', 'linear.key', 'keiron-planner',
];

const ORG = ['Kei', 'ron'].join('');
const dashed = (...parts) => parts.join('-');
const GH_ORG = dashed(ORG, ['Health', 'Tech'].join(''));
const LITERALS = [
  new RegExp(dashed('crm', 'backend'), 'i'), new RegExp(dashed('crm', 'frontend'), 'i'), new RegExp(`${ORG}(?!-sequencer|_sequencer_)`, 'i'), new RegExp(GH_ORG, 'i'),
  /prisma/i, /tsc/i, /(?<![\w-])development(?![\w-])/i,
];

const IMPORT = /^\s*(?:import|export)\b[^;]*?\bfrom\s+'(\.{1,2}\/[^']+)'/gm;

function importClosure(entry) {
  const seen = new Set();
  const visit = file => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const [, spec] of read(file).matchAll(IMPORT)) visit(relative(ROOT, resolve(ROOT, dirname(file), spec)));
  };
  visit(entry);
  return seen;
}

test('the start sources are the CLI and its lib folder', () => {
  assert.ok(START.includes('scripts/start.mjs') && START.includes('scripts/lib/start/plan.mjs') && START.length >= 10, START.join(', '));
});

test('no start source spawns a process, writes history, publishes, applies a patch, reads origin/HEAD or names the key file', () => {
  const hits = START.flatMap(f => SOURCE_DENY.filter(s => read(f).includes(s)).map(s => `${f}: ${s}`));
  assert.deepEqual(hits, []);
});

test('no start source and not the skill holds a repo-specific literal', () => {
  const planted = [dashed('crm', 'backend'), dashed('crm', 'frontend'), ORG, GH_ORG, 'Prisma', 'npx tsc', 'origin/development'];
  LITERALS.forEach((re, i) => assert.match(planted[i], re));
  assert.doesNotMatch('superpowers:test-driven-development', LITERALS.at(-1));
  for (const own of ['keiron-sequencer', '~/.keiron-sequencer', '/keiron-sequencer:next', 'KEIRON_SEQUENCER_HOME']) {
    assert.deepEqual(LITERALS.filter(re => re.test(own)), [], `the plugin's own name ${own} is caught`);
  }
  const files = [...START, SKILL];
  const hits = files.flatMap(f => LITERALS.filter(re => re.test(read(f))).map(re => `${f}: ${re}`));
  assert.deepEqual(hits, []);
});

test('among the start sources only move.mjs imports linear-write', () => {
  assert.deepEqual(START.filter(f => /linear-write/.test(read(f))), ['scripts/lib/start/move.mjs']);
});

test('the plan import graph never reaches move.mjs or linear-write', () => {
  const plan = importClosure('scripts/lib/start/plan.mjs');
  assert.ok(plan.has('scripts/lib/linear-fetch.mjs'), [...plan].join(', '));
  assert.ok(!plan.has('scripts/lib/start/move.mjs'));
  assert.ok(!plan.has('scripts/lib/linear-write.mjs'));
});

test('setIssueState is absent from the harvest, the spike and every skill', () => {
  const files = globSync(['scripts/harvest.mjs', 'scripts/lib/harvest*.mjs', 'scripts/spike.mjs', 'scripts/lib/spike/*.mjs', 'skills/**/*.md'], { cwd: ROOT });
  assert.ok(files.includes('scripts/lib/harvest-apply.mjs') && files.includes(SKILL), files.join(', '));
  assert.deepEqual(files.filter(f => /setIssueState/.test(read(f))), []);
});

test('mutation text lives only in linear-write.mjs, six times', () => {
  const files = globSync(['scripts/**/*.mjs', 'skills/**/*.md'], { cwd: ROOT }).sort();
  const counts = Object.fromEntries(files.map(f => [f, [...read(f).matchAll(/\bmutation\b/g)].length]).filter(([, n]) => n > 0));
  assert.deepEqual(counts, { 'scripts/lib/linear-write.mjs': 6 });
});

const WRITE_ARGV = /\[\s*'(checkout|fetch|switch|reset|commit|push|pull|merge|rebase|cherry-pick|restore|stash|apply|am|tag|clone|init|branch)'|'worktree',\s*'add'/;

test('no start module the plan imports names a write git subcommand; the gated branch module does', () => {
  const plan = [...importClosure('scripts/lib/start/plan.mjs')].filter(f => START.includes(f));
  assert.ok(plan.includes('scripts/lib/start/checkout.mjs') && plan.includes('scripts/lib/start/staleness.mjs'), plan.join(', '));
  assert.ok(!plan.includes('scripts/lib/start/branch.mjs'));
  assert.deepEqual(plan.filter(f => WRITE_ARGV.test(read(f))), []);
  assert.match(read('scripts/lib/start/branch.mjs'), WRITE_ARGV);
});

test('no script names a path under .claude/skills, and no test builds a path from the real home into .claude', () => {
  const SKILLS_PATH = /\.claude\/skills|\.claude['"`]\s*,\s*['"`]skills/;
  assert.match("join(home, '.claude', 'skills')", SKILLS_PATH);
  const scripts = globSync(['scripts/**/*.mjs'], { cwd: ROOT });
  assert.deepEqual(scripts.filter(f => SKILLS_PATH.test(read(f))), []);
  const tests = globSync(['tests/**/*.mjs'], { cwd: ROOT });
  assert.deepEqual(tests.filter(f => /homedir\(\)[^\n]*\.claude/.test(read(f))), []);
});
