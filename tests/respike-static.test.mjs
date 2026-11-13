import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardNetwork } from './helpers/no-network.mjs';

guardNetwork();

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = file => readFileSync(join(ROOT, file), 'utf8');
const RESPIKE = globSync(['scripts/respike.mjs', 'scripts/lib/respike/*.mjs'], { cwd: ROOT }).sort();
const SKILL = 'skills/respike/SKILL.md';

const IMPORT = /^\s*(?:import|export)\b[^;]*?\bfrom\s+'([^']+)'/gm;
const importsOf = file => [...read(file).matchAll(IMPORT)].map(m => m[1]);

const DENIED_ARGV = /'(apply|read-tree|worktree|commit|commit-tree|update-ref|push|tag|set-url|clone)'/;
const GIT_SUBCOMMAND = /\bgit\(\s*\[\s*'([a-z-]+)'/g;
const ORG = ['Kei', 'ron'].join('');
const dashed = (...parts) => parts.join('-');
const REPO_LITERALS = [new RegExp(dashed('crm', 'backend'), 'i'), new RegExp(dashed('crm', 'frontend'), 'i'), new RegExp(`${ORG}(?!-sequencer|_sequencer_)`, 'i')];
const PLANNING_IDS = [
  /\b(RP|RB|RR|RM|RK|RX)-\d/, /\bT\d+\.\d+\b/, /(?<![\w-])#\d+/, new RegExp(['sdd', '/'].join('')),
  /\bRC-A?\d/, /\bSP-ST\d/, /\bSS-A\d/,
];

const CHANGED = [
  'docs/spike-config.example.json', 'scripts/backfill/build-records.mjs', 'scripts/backfill/extract-usage.mjs', 'scripts/backfill/patch-map.mjs', 'scripts/lib/patch-dirs.mjs', 'scripts/lib/record.mjs',
  'scripts/lib/respike/built.mjs', 'scripts/lib/respike/coverage.mjs', 'scripts/lib/respike/plan.mjs', 'scripts/lib/respike/replay-plan.mjs',
  'scripts/lib/respike/report.mjs', 'scripts/lib/respike/selection.mjs', 'scripts/lib/spike/build-record.mjs', 'scripts/lib/spike/combine.mjs',
  'scripts/lib/spike/config.mjs', 'scripts/lib/spike/config-detect.mjs', 'scripts/lib/spike/config-draft.mjs', 'scripts/lib/spike/home.mjs',
  'scripts/lib/spike/limits.mjs', 'scripts/lib/spike/order.mjs', 'scripts/lib/spike/prune.mjs', 'scripts/lib/spike/replay.mjs',
  'scripts/lib/spike/trees.mjs', 'scripts/maintenance/move-reference.mjs', 'scripts/maintenance/rename-trial-dirs.mjs', 'scripts/respike.mjs', 'scripts/spike.mjs',
  'skills/respike/SKILL.md', 'skills/spike/SKILL.md',
  'tests/backfill-build.test.mjs', 'tests/backfill-curated.test.mjs', 'tests/backfill-extract.test.mjs', 'tests/backfill-fixups.test.mjs', 'tests/backfill-patch-root.test.mjs', 'tests/backfill-size.test.mjs',
  'tests/helpers/git-sandbox.mjs', 'tests/helpers/respike-fixture.mjs', 'tests/helpers/trial-store.mjs', 'tests/maintenance-rename.test.mjs', 'tests/move-reference.test.mjs', 'tests/no-network-guard.test.mjs',
  'tests/patch-dirs.test.mjs', 'tests/patch-map.test.mjs', 'tests/record.test.mjs', 'tests/respike-begin.test.mjs', 'tests/respike-built.test.mjs',
  'tests/respike-combine.test.mjs', 'tests/respike-config-detect.test.mjs', 'tests/respike-config-draft.test.mjs', 'tests/respike-config.test.mjs', 'tests/respike-coverage.test.mjs', 'tests/respike-preflight.test.mjs', 'tests/respike-replay-plan.test.mjs',
  'tests/respike-replay.test.mjs', 'tests/respike-report.test.mjs', 'tests/respike-selection.test.mjs', 'tests/respike-skill-lint.test.mjs',
  'tests/respike-static.test.mjs', 'tests/respike-tracer.test.mjs', 'tests/skill-lint.test.mjs', 'tests/spike-abandon.test.mjs',
  'tests/spike-build-record.test.mjs', 'tests/spike-caps.test.mjs', 'tests/spike-cli.test.mjs', 'tests/spike-config.test.mjs', 'tests/spike-fixup.test.mjs', 'tests/spike-home.test.mjs',
  'tests/spike-order.test.mjs', 'tests/spike-prune.test.mjs', 'tests/spike-resume.test.mjs', 'tests/spike-state.test.mjs', 'tests/spike-status.test.mjs',
  'tests/spike-trees.test.mjs',
];

test('the respike sources are the CLI and its lib folder', () => {
  for (const f of ['scripts/respike.mjs', 'scripts/lib/respike/plan.mjs', 'scripts/lib/respike/built.mjs', 'scripts/lib/respike/report.mjs']) {
    assert.ok(RESPIKE.includes(f), RESPIKE.join(', '));
  }
});

test('no respike source imports linear-write, child_process, the tree module or the replay module; the combine helper is allowed', () => {
  const banned = /(linear-write|child_process|\/trees\.mjs|\/replay\.mjs)$/;
  assert.ok(banned.test('../spike/trees.mjs') && banned.test('node:child_process') && !banned.test('../spike/combine.mjs'));
  const hits = RESPIKE.flatMap(f => importsOf(f).filter(s => banned.test(s)).map(s => `${f}: ${s}`));
  assert.deepEqual(hits, []);
  assert.ok(importsOf('scripts/lib/respike/built.mjs').includes('../spike/combine.mjs'));
});

// The one branch the respike may move is a local branch with no own commits, by the fast-forward subcommand on an approved hash.
const fastForwardBody = () => {
  const cli = read('scripts/respike.mjs');
  const start = cli.indexOf('async function fastForward(');
  const end = cli.indexOf('\n}\n', start);
  assert.ok(start > 0 && end > start);
  return { cli, start, end };
};
const outside = (f, text) => (f === 'scripts/respike.mjs' ? (({ cli, start, end }) => cli.slice(0, start) + cli.slice(end))(fastForwardBody()) : text);

test('no respike source names a git argv that applies, moves a tree, commits, publishes or clones, outside fast-forward', () => {
  for (const s of ["['apply'", "'read-tree'", "['worktree', 'add'", "'commit-tree'", "'update-ref'", "'set-url'", "'clone'"]) assert.match(s, DENIED_ARGV);
  const hits = RESPIKE.flatMap(f => (DENIED_ARGV.test(outside(f, read(f))) ? [`${f}: ${outside(f, read(f)).match(DENIED_ARGV)[0]}`] : []));
  assert.deepEqual(hits, []);
});

test('a branch is moved only by the fast-forward subcommand: update-ref or merge --ff-only, after the hash check, never push', () => {
  const { cli, start, end } = fastForwardBody();
  const body = cli.slice(start, end);
  assert.deepEqual([...body.matchAll(GIT_SUBCOMMAND)].map(m => m[1]).sort(), ['merge', 'rev-parse', 'status', 'update-ref', 'worktree']);
  assert.match(body, /'merge', '--ff-only'/);
  assert.ok(body.indexOf('plan.approve !== a.flags.approve') < body.indexOf("'update-ref'"));
  assert.doesNotMatch(body, /'push'|'rebase'|'reset'|'checkout'/);
  assert.match(cli, /COMMANDS = \{[^}]*'fast-forward': fastForward/);
});

test('git fetch is run only by the fetch subcommand', () => {
  assert.deepEqual([..."deps.git(['fetch', '-q'], {}); answers: ['fetch']".matchAll(GIT_SUBCOMMAND)].map(m => m[1]), ['fetch']);
  const fetches = RESPIKE.flatMap(f => [...read(f).matchAll(GIT_SUBCOMMAND)].filter(m => m[1] === 'fetch').map(m => ({ f, at: m.index })));
  assert.equal(fetches.length, 1, JSON.stringify(fetches));
  const cli = read('scripts/respike.mjs');
  const start = cli.indexOf('async function fetchHeads(');
  const end = cli.indexOf('\n}\n', start);
  assert.ok(start > 0 && end > start);
  assert.deepEqual(fetches.map(({ f, at }) => f === 'scripts/respike.mjs' && at > start && at < end), [true]);
  assert.match(cli, /COMMANDS = \{[^}]*fetch: fetchHeads/);
});

test('the combine helper names only cat-file, merge-base, merge-tree and diff', () => {
  const used = new Set([...read('scripts/lib/spike/combine.mjs').matchAll(GIT_SUBCOMMAND)].map(m => m[1]));
  assert.deepEqual([...used].sort(), ['cat-file', 'diff', 'merge-base', 'merge-tree']);
});

test('only the spike exec module imports child_process or spawns', () => {
  const scripts = globSync(['scripts/**/*.mjs'], { cwd: ROOT }).sort();
  assert.ok(scripts.includes('scripts/maintenance/rename-trial-dirs.mjs') && scripts.includes('scripts/respike.mjs'));
  assert.deepEqual(scripts.filter(f => /child_process|\bspawn(Sync)?\(/.test(read(f))), ['scripts/lib/spike/exec.mjs']);
});

test('the spike git deny-list is unchanged', () => {
  const exec = read('scripts/lib/spike/exec.mjs');
  assert.ok(exec.includes("const GIT_DENIED = new Set(['commit', 'push', 'tag']);"));
  assert.ok(exec.includes("const GIT_REMOTE_DENIED = new Set(['set-url']);"));
  assert.ok(exec.includes("const GH_ALLOWED = new Set(['pr list', 'pr view', 'pr diff']);"));
  assert.equal([...exec.matchAll(/const GIT_DENIED = /g)].length, 1);
});

test('no respike source and not the skill holds a repo literal from the user\'s projects', () => {
  const planted = [dashed('crm', 'backend'), dashed('CRM', 'Frontend'), ORG];
  REPO_LITERALS.forEach((re, i) => assert.match(planted[i], re));
  assert.ok(REPO_LITERALS.some(re => re.test(dashed(ORG, ['Health', 'Tech'].join('')))));
  for (const own of ['keiron-sequencer', '~/.keiron-sequencer', '/keiron-sequencer:next', 'KEIRON_SEQUENCER_HOME']) {
    assert.deepEqual(REPO_LITERALS.filter(re => re.test(own)), [], `the plugin's own name ${own} is caught`);
  }
  const hits = [...RESPIKE, SKILL].flatMap(f => REPO_LITERALS.filter(re => re.test(read(f))).map(re => `${f}: ${re}`));
  assert.deepEqual(hits, []);
});

test('no file this change adds or modifies holds a planning id', () => {
  const planted = [
    'R' + 'P-1', 'see T' + '7.2', 'per ' + '#' + '829', ['sdd', 'respike'].join('/'),
    ['R', 'C-1'].join(''), ['SP', 'ST5'].join('-'), ['SS', 'A4'].join('-'),
  ];
  planted.forEach((sample, i) => assert.ok(PLANNING_IDS[i]?.test(sample), `no planning-id pattern catches ${sample}`));
  assert.equal(PLANNING_IDS.length, planted.length);
  assert.doesNotMatch(['example-api', '635'].join('#'), PLANNING_IDS[2]);
  const missing = CHANGED.filter(f => !existsSync(join(ROOT, f)));
  assert.deepEqual(missing, []);
  const hits = CHANGED.flatMap(f => PLANNING_IDS.filter(re => re.test(read(f))).map(re => `${f}: ${read(f).match(re)[0]}`));
  assert.deepEqual(hits, []);
});

const CONFIG_SOURCES = ['scripts/lib/spike/config-draft.mjs', 'scripts/lib/spike/config-detect.mjs'];

test('the config draft and detect modules hold no repo literal and no git argv that applies, moves a tree, commits, publishes or clones', () => {
  const hits = CONFIG_SOURCES.flatMap(f => [...REPO_LITERALS, DENIED_ARGV].filter(re => re.test(read(f))).map(re => `${f}: ${read(f).match(re)[0]}`));
  assert.deepEqual(hits, []);
});

test('config detection names only the remote and symbolic-ref git subcommands', () => {
  const used = new Set([...read('scripts/lib/spike/config-detect.mjs').matchAll(GIT_SUBCOMMAND)].map(m => m[1]));
  assert.deepEqual([...used].sort(), ['remote', 'symbolic-ref']);
});

test('config.json is written only by the config module and the CLI write step, and only the config module names its backup', () => {
  const scripts = globSync(['scripts/**/*.mjs'], { cwd: ROOT }).sort();
  const calls = scripts.flatMap(f => [...read(f).matchAll(/\bwriteConfig\(/g)].map(m => ({ f, at: m.index })));
  assert.deepEqual([...new Set(calls.map(c => c.f))].sort(), ['scripts/lib/spike/config.mjs', 'scripts/respike.mjs']);
  const cli = read('scripts/respike.mjs');
  const start = cli.indexOf('function configWrite(');
  const end = cli.indexOf('\n}\n', start);
  assert.ok(start > 0 && end > start);
  for (const { at } of calls.filter(c => c.f === 'scripts/respike.mjs')) assert.ok(at > start && at < end, 'writeConfig is called outside the config write step');
  const BACKUP = /config\.json\.bak|\.bak\b/;
  assert.match('`${path}.bak`', BACKUP);
  assert.deepEqual(scripts.filter(f => BACKUP.test(read(f))), ['scripts/lib/spike/config.mjs']);
});

test('the config modules and the respike CLI name no tool-install literal and no default root', () => {
  const sources = [...CONFIG_SOURCES, 'scripts/respike.mjs'];
  const INSTALL = /'(--global|brew|enable|apt-get|winget)'/;
  const HOME_PATH = /'~\/[^']*'/;
  for (const sample of ["'--global'", "'brew'", "'enable'", "'apt-get'", "'winget'"]) assert.match(sample, INSTALL);
  assert.match(['\'~', 'src\''].join('/'), HOME_PATH);
  const hits = sources.flatMap(f => [INSTALL, HOME_PATH].filter(re => re.test(read(f))).map(re => `${f}: ${read(f).match(re)[0]}`));
  assert.deepEqual(hits, []);
});

test('the skill names no default root: every --root it shows takes <dir>', () => {
  const skill = read(SKILL);
  const roots = [...skill.matchAll(/--root(?![\w-])(.{0,6})/g)].map(m => m[1]);
  assert.ok(roots.length >= 3, `only ${roots.length} --root in the skill`);
  for (const after of roots) assert.ok(after.startsWith(' <dir>'), `a --root without <dir>: --root${after}`);
});

test('the config modules declare each shared helper once and compute the broken repos in one place', () => {
  const modules = ['scripts/lib/spike/config.mjs', ...CONFIG_SOURCES];
  const DECLARED = name => new RegExp(`^(?:export )?(?:const|function) ${name}\\b`, 'gm');
  assert.equal(['const isObject = v', 'export const isObject = v'].join('\n').match(DECLARED('isObject')).length, 2);
  for (const name of ['repoPart', 'REPO_DIR', 'isObject', 'isNonEmpty']) {
    const where = modules.flatMap(f => (read(f).match(DECLARED(name)) ?? []).map(() => f));
    assert.equal(where.length, 1, `${name} is declared in ${where.join(', ')}`);
  }
  const BROKEN = /i\.field === 'dir' \|\| i\.field === 'entry'/g;
  assert.equal(modules.flatMap(f => read(f).match(BROKEN) ?? []).length, 1);
});
