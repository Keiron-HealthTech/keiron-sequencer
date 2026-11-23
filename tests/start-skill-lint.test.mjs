import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { guardNetwork } from './helpers/no-network.mjs';
import { fakeStartFixture } from './helpers/start-fixture.mjs';

guardNetwork();

const read = rel => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const skill = read('skills/start/SKILL.md');
const frontMatter = skill.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';
const flat = skill.replace(/\s+/g, ' ');
const says = text => assert.ok(flat.includes(text), `SKILL.md does not say ${JSON.stringify(text)}`);

const fences = [...skill.matchAll(/^```(\w*)\n([\s\S]*?)^```$/gm)].map(m => ({ lang: m[1], body: m[2] }));
const outsideFences = skill.replace(/^```\w*\n[\s\S]*?^```$/gm, '');
const inlineCode = [...outsideFences.matchAll(/`([^`\n]+)`/g)].map(m => m[1]);
const bashLines = fences.filter(f => f.lang === 'bash').flatMap(f => f.body.split('\n')).filter(l => l.trim());
const PACKS = 'node ${CLAUDE_PLUGIN_ROOT}/scripts/packs.mjs ';
const isPacks = line => line.includes('scripts/packs.mjs');
const commandLines = [...bashLines, ...inlineCode.filter(c => c.includes('start.mjs'))].filter(l => !isPacks(l));

const CLI = 'node ${CLAUDE_PLUGIN_ROOT}/scripts/start.mjs ';
const FLAG = /(?<![\w-])--[a-z][a-z-]*/g;
const hasToken = (text, flag) => new RegExp(`(?<![\\w-])${flag}(?![\\w-])`).test(text);

async function usageText(t) {
  const f = fakeStartFixture();
  t.after(f.dispose);
  const r = await f.run([]);
  assert.equal(r.code, 2);
  return r.stderr;
}

test('front matter names the skill start, keeps the plain trigger, adds "sequencer start" and names the plugin as author', () => {
  assert.match(frontMatter, /^name: start$/m);
  assert.match(frontMatter, /^description: /m);
  assert.match(frontMatter, /Trigger: .*start the card/);
  assert.match(frontMatter, /Trigger: .*sequencer start/);
  assert.match(frontMatter, /after \/keiron-sequencer:next picks a card/);
  assert.match(frontMatter, /^ {2}author: keiron-sequencer$/m);
});

test('the skill holds no old name, in its front matter or its text', () => {
  assert.doesNotMatch(skill, new RegExp('mi' + 'kado', 'i'));
});

test('the steps run preflight, plan, recall, show, act, ask, fetch and branch, baseline, pack, move, route, in that order', () => {
  const headings = [
    '## Step 1: Preflight', '## Step 2: Plan', '## Step 3: Recall', '## Step 4: Show the plan', '## Step 5: Act on the action',
    '## Step 6: Go on, or stop on a real choice', '## Step 7: Fetch, then branch', '## Step 8: Typecheck baseline',
    '## Step 9: Decision pack', '## Step 10: Move, only on an explicit yes', '## Step 11: Route',
  ];
  const at = headings.map(h => skill.indexOf(`\n${h}\n`));
  headings.forEach((h, i) => assert.ok(at[i] > 0, `missing heading ${JSON.stringify(h)}`));
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'the steps are out of order');
});

test('the subcommands the skill runs are exactly the ones the usage lists', async t => {
  const usage = await usageText(t);
  const fromUsage = new Set([...usage.matchAll(/^usage: node scripts\/start\.mjs (\w+)/gm)].map(m => m[1]));
  const fromSkill = new Set([...skill.matchAll(/start\.mjs (\w+)/g)].map(m => m[1]));
  assert.equal(fromUsage.size, 5);
  assert.deepEqual([...fromSkill].sort(), [...fromUsage].sort());
});

test('every usage flag is documented, and every flag the skill passes is a usage flag', async t => {
  const usage = await usageText(t);
  const fromUsage = new Set(usage.match(FLAG));
  assert.ok(fromUsage.has('--blocker-branch') && fromUsage.has('--confirm'), [...fromUsage].join(', '));
  for (const flag of fromUsage) assert.ok(hasToken(skill, flag), `SKILL.md does not document ${flag}`);
  const passed = new Set([...commandLines, ...inlineCode.filter(c => !isPacks(c))].flatMap(l => l.match(FLAG) ?? []));
  assert.deepEqual([...passed].filter(f => !fromUsage.has(f)), []);
});

test('every bash fence runs only the start CLI, or the packs CLI to draft and answer the card\'s own pack', () => {
  assert.ok(bashLines.length >= 6, `only ${bashLines.length} bash lines`);
  for (const line of bashLines) assert.ok(line.startsWith(CLI) || line.startsWith(PACKS), `bash line runs something else: ${line}`);
  const packs = bashLines.filter(isPacks);
  assert.deepEqual(packs, [
    `${PACKS}draft <card.project.slug> --card <CARD>`,
    `${PACKS}answer <card.project.slug> <CARD> <question id> --outcome "<the outcome>"`,
  ]);
});

test('Step 9 drafts the card\'s own pack after the fetch, asks its open questions and saves every answer', () => {
  const step = skill.slice(skill.indexOf('## Step 9: Decision pack'), skill.indexOf('## Step 10:'));
  const flatStep = step.replace(/\s+/g, ' ');
  for (const text of [
    'after the baseline', 'the fetch moved the default tip', 'resume', 'no-project mode', '`pack.questions`',
    'stated as outcomes, not mechanisms', 'Never answer a question for the user', 'plan again', 'survive',
  ]) assert.ok(flatStep.includes(text), `Step 9 does not say ${JSON.stringify(text)}`);
  assert.doesNotMatch(skill, /offer `\/keiron-sequencer:next` to draft it again/);
});

test('no-project mode: the plan goes on without the map, the record, the pack and the staleness', () => {
  says('`no-project` (`blocking: false`)');
  says('only the `--blocker` flags');
  says('When it is "no project", decide from the card text');
});

test('a text fence documents the branch command with the plan base on the configured remote', () => {
  const text = fences.filter(f => f.lang === 'text').map(f => f.body).join('\n');
  assert.match(text, /git checkout -b <branch> origin\/<base>/);
  says('origin is the configured remote');
});

test('the skill holds no tree-changing or publishing git command', () => {
  for (const s of ['git apply', 'git switch', 'git reset', 'worktree add', 'git commit', 'git push', 'gh pr create', 'patch -p']) {
    assert.ok(!skill.includes(s), `SKILL.md contains ${JSON.stringify(s)}`);
  }
  assert.doesNotMatch(skill, /\bgit am\b/);
});

test('fetch, branch and baseline run without asking on a ready plan, always with an approve hash the CLI printed', () => {
  const writes = commandLines.filter(l => /start\.mjs (fetch|branch|baseline)\b/.test(l));
  assert.ok(writes.length >= 4, writes.join('\n'));
  for (const line of writes) assert.match(line, /start\.mjs (fetch|branch|baseline) <CARD> --approve <(hash|nextApprove)>/);
  says('Run `fetch`, `branch` and `baseline` without asking when the plan is ready with no asks, and only with a hash the CLI printed');
  says('the `approve` hash of the plan that was shown');
  says('The hash binds the actions to the plan that was shown and catches a plan that moved; it is not the user\'s yes');
  says('`nextApprove`');
  says('or `branch` exits 5');
  says('plan again and show the new plan');
  says('"fetch to decide", the blocker heads are not fetched yet: run `fetch` with the plan\'s `approve` hash');
  assert.ok(!flat.includes('only after the user approves'), 'the branch is no longer an ask');
  assert.ok(!flat.includes('yes or no?'), 'Step 6 no longer asks to create the branch');
});

test('the same blocker flags go on every command of one start', () => {
  says('Repeat the same blocker flags on `plan`, `fetch`, `branch` and `baseline`');
});

test('the move is never run without an explicit yes and the repeated card key', () => {
  const moves = commandLines.filter(l => /start\.mjs move\b/.test(l));
  assert.ok(moves.length >= 1);
  for (const line of moves) assert.match(line, /start\.mjs move <CARD> --confirm <CARD>/);
  says('Default: no.');
  says('The PR automation moves the card when its PR opens');
  assert.doesNotMatch(flat, /wrong branch name/);
  says('explicit yes');
  says('Never move a card in Linear unless the user explicitly opts in');
  says('never run `move` without `--confirm <CARD>`');
});

test('the move carries no unverified-API warning', () => {
  assert.doesNotMatch(flat, /have not been checked against the live Linear API/);
});

test('the show step renders every plan reason, the non-blocking ones included', () => {
  const codes = [
    'not-execution-card', 'card-closed', 'repo-unconfigured', 'wrong-repo', 'no-branch-name', 'unstarted-blocker', 'unverified-blocker',
    'wait-blocker', 'push-reviews', 'pr-merged', 'pr-closed', 'gh-unavailable', 'dirty-checkout', 'no-project',
  ];
  const plan = read('scripts/lib/start/plan.mjs');
  const emitted = [...plan.matchAll(/reason\('([a-z-]+)'/g)].map(m => m[1]);
  for (const code of emitted) assert.ok(codes.includes(code), `plan.mjs emits ${code}, missing from the list`);
  for (const code of codes) {
    assert.ok(plan.includes(`'${code}'`), `plan.mjs no longer has ${code}`);
    assert.ok(skill.includes(`\`${code}\``), `SKILL.md does not name ${code}`);
  }
  says('Show every entry of `reasons`');
  says('including the non-blocking `gh-unavailable` and `dirty-checkout`');
  says('every blocker `warning`');
  says('every entry of `warnings`');
});

test('a custom branch name without the card id is warned about before branch runs, since a later start would not find it', () => {
  const warning = 'a later `/keiron-sequencer:start` will not detect that branch as a resume';
  says(warning);
  const warnedAt = flat.indexOf(warning);
  const named = commandLines.find(l => /start\.mjs branch .*--name/.test(l));
  assert.ok(named, 'no branch command with --name');
  assert.ok(warnedAt >= 0 && warnedAt < flat.indexOf(named), 'the warning comes after the --name command');
  says('Only for a custom name that does not carry the card id, warn before running `branch --name`');
});

test('a custom branch name carrying the card id is accepted and still resumes', () => {
  says('A custom name that carries the card id is accepted and a later `/keiron-sequencer:start` resumes it');
  assert.ok(!flat.includes('only with a valid name that does not carry the card id'), 'SKILL.md still says --name must lack the card id');
  const sentences = flat.split(/(?<=[.:])\s/).filter(s => /carr(y|ies) the card id/.test(s));
  for (const s of sentences) assert.doesNotMatch(s, /refus|reject|Exit 5/, s);
});

test('the anchors of the start flow are present', () => {
  for (const anchor of [
    'current checkout', 'never renamed', 'reference only', 'Ajustes de alcance', 'comments supersede the description', 'mem_search',
    'fetch before branching', 'typecheck baseline', '/sdd-new', 'superpowers:writing-plans', 'superpowers:test-driven-development',
    '"unknown"', '"no record"', 'never replaces sdd-explore', 'No commits, pushes or PRs', 'planning artifacts stay untracked',
    'never from origin/HEAD', 'no worktree creation', 'dirty count', 'siblings', 'Push these reviews',
  ]) says(anchor);
});

test('every step of the old card-start flow is covered', () => {
  const steps = {
    'read the card and its comments': ['`card.comments`', 'comments supersede the description'],
    'already started': ['`resume`', 'never renamed'],
    'recall': ['mem_search', '`brief.record.engramRefs`'],
    'project context': ['`siblings`'],
    'current repo': ['current checkout', '`wrong-repo`'],
    'base and branch': ['fetch before branching', '`base.ref`', 'git checkout -b'],
    'typecheck baseline': ['typecheck baseline', 'not a failure'],
    'decide SDD out loud': ['`verdict`', '`route`', 'out loud'],
    'hand off to the work': ['/sdd-new', 'superpowers:test-driven-development'],
  };
  for (const [step, anchors] of Object.entries(steps)) {
    for (const a of anchors) assert.ok(flat.includes(a) || skill.includes(a), `${step}: missing ${JSON.stringify(a)}`);
  }
});

test('the skill runs no SDD phase itself', () => {
  assert.doesNotMatch(skill, /\/sdd-(explore|spec|design|propose|tasks|apply)\b/);
  assert.doesNotMatch(skill.replace(/never replaces sdd-explore/g, ''), /sdd-(explore|spec|design)\b/);
});

test('the predecessor skill is not named', () => {
  assert.ok(!skill.includes('linear-card-start'), 'SKILL.md still names /linear-card-start');
});

test('the plugin install is documented, not performed, and no symlink is named', () => {
  says('`claude plugin marketplace add <owner>/keiron-sequencer`');
  says('`claude plugin install keiron-sequencer@keiron-sequencer`');
  says('do not run these yourself');
  assert.doesNotMatch(skill, /ln -s|\.claude\/skills/);
});

test('every exit code of the CLI is handled', () => {
  for (const code of [0, 1, 2, 3, 5]) assert.ok(skill.includes(`Exit ${code}`), `missing Exit ${code}`);
  says('A gh command that fails is not exit 1: the plan completes with `gh-unavailable`');
});

test('the skill never shows a key or tells anyone to read one', () => {
  assert.doesNotMatch(skill, /lin_api_/i);
  assert.doesNotMatch(skill, /Bearer/i);
  assert.doesNotMatch(skill, /LINEAR_API_KEY/);
  assert.doesNotMatch(skill, /linear\.key/);
  assert.doesNotMatch(skill, /keiron-planner/i);
  says('Never read, print or cat the Linear key');
});

test('a plan that waits, stops or resumes creates no new branch, and the typecheck baseline is recorded, never fixed', () => {
  says('`wait` or `stop`: create nothing.');
  says('`resume`: the card is already started. With one candidate in `resume.branches`, one candidate is resumed without asking');
  says('A started branch is never renamed');
  says('Errors are not a failure: do not fix them and do not block on them.');
});

test('the route is a recommendation from evidence, said with its reasons, and another workflow the user picks is followed', () => {
  for (const anchor of [
    'Full SDD for new contracts others build on, permission or exposure changes, cross-app or cross-repo work, or open people-owned design decisions',
    'Light (superpowers:writing-plans, then superpowers:test-driven-development) for a contained change that follows an existing pattern',
    'TDD (superpowers:test-driven-development) for a fix, 1 or 2 files, or a deletion with proof of no usage',
    '`route.reasons`', 'a recommendation', 'follow it without arguing or blocking', 'decide from the card text with the same rule',
  ]) says(anchor);
  assert.ok(!flat.includes('SDD is the default'), 'SKILL.md still makes SDD the default');
  assert.ok(!/route[^.]*risk areas/.test(flat), 'the route no longer reads risk areas');
});

test('the staleness shows the hunk level, its fallback and the touched commits', () => {
  for (const anchor of ['`staleness.hunks`', '`level`', '`fallback`', '`staleness.touched`']) says(anchor);
});

test('the pack: answers are binding outcomes, code-settled decisions are hypotheses, discovery is fed and never replaced', () => {
  for (const anchor of [
    '`brief.pack`', 'Answers to people-owned decisions are binding requirements', 'stated as outcomes', 'sdd-verify checks them',
    'Reopening one needs evidence and the user\'s OK', 'Code-settled decisions are hypotheses', 'without reading the pack first',
    'every disagreement goes to the user', 'The pack feeds SDD discovery and never replaces it', 'Spike code is reference only',
  ]) says(anchor);
});

test('Step 11 lists every route before the pack rules, so no route bullet reads as a pack rule', () => {
  const step = skill.slice(skill.indexOf('## Step 11: Route'), skill.indexOf('## Exit codes'));
  const pack = step.indexOf('With a pack');
  for (const route of ['- `sdd`:', '- `light`:', '- `tdd`:']) {
    assert.ok(step.indexOf(route) > 0 && step.indexOf(route) < pack, `${route} must come before the pack rules`);
  }
});

test('the route counts a people decision answered in a fresh pack as settled, and says so with pack-answered', () => {
  says('`pack-answered:<n>`');
  says('answered in a fresh decision pack no longer counts as open');
  says('a stale pack answers nothing');
});

test('the start stops and asks only on a real choice or a risk; route and move are asked once the branch exists', () => {
  for (const anchor of [
    'Stop and ask only when there is a real choice or a risk', 'any plan `ask`', 'more than one candidate branch',
    'one candidate is resumed without asking', 'a dirty checkout', '`git checkout -b` carries the uncommitted changes onto the new branch',
    'checked out in another worktree', 'only when the user has said they want a custom name',
    'asked once, after the branch and the baseline exist',
  ]) says(anchor);
});
