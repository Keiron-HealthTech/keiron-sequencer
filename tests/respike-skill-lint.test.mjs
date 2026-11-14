import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { run as runRespike } from '../scripts/respike.mjs';
import { run as runSpike } from '../scripts/spike.mjs';
import { tempDir } from './helpers/git-sandbox.mjs';
import { guardNetwork } from './helpers/no-network.mjs';

guardNetwork();

const read = rel => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const SKILL_PATH = new URL('../skills/respike/SKILL.md', import.meta.url);
const skill = existsSync(SKILL_PATH) ? readFileSync(SKILL_PATH, 'utf8') : '';
const frontMatter = skill.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';
const flat = skill.replace(/\s+/g, ' ');
const says = text => assert.ok(flat.includes(text), `SKILL.md does not say ${JSON.stringify(text)}`);

const fences = [...skill.matchAll(/^```(\w*)\n([\s\S]*?)^```$/gm)].map(m => ({ lang: m[1], body: m[2] }));
const outsideFences = skill.replace(/^```\w*\n[\s\S]*?^```$/gm, '');
const inlineCode = [...outsideFences.matchAll(/`([^`\n]+)`/g)].map(m => m[1]);
const bashLines = fences.filter(f => f.lang === 'bash').flatMap(f => f.body.split('\n')).filter(l => l.trim());

const RESPIKE = 'node ${CLAUDE_PLUGIN_ROOT}/scripts/respike.mjs ';
const SPIKE = 'node ${CLAUDE_PLUGIN_ROOT}/scripts/spike.mjs ';
const RESPIKE_COMMAND = /(?<![\w-])scripts\/respike\.mjs ([a-z-]+)/g;
const SPIKE_COMMAND = /(?<![\w-])scripts\/spike\.mjs ([a-z-]+)/g;
const FLAG = /(?<![\w-])--[a-z][a-z-]*/g;
const hasToken = (text, flag) => new RegExp(`(?<![\\w-])${flag}(?![\\w-])`).test(text);
const commandLines = cli => [...bashLines, ...inlineCode].filter(l => l.includes(cli));
const sectionOf = heading => skill.split(`\n## ${heading}\n`)[1]?.split('\n## ')[0] ?? '';
const configStep = (skill.split('\n### Missing config: draft, review, write\n')[1] ?? '').split('\n## ')[0];
const stepSays = (section, text) => assert.ok(section.replace(/\s+/g, ' ').includes(text), `the section does not say ${JSON.stringify(text)}`);

const home = tempDir('keiron-sequencer-respike-lint-home-');
after(() => rmSync(home, { recursive: true, force: true }));

async function respikeUsage() {
  const r = await runRespike([], { env: {}, home });
  assert.equal(r.code, 2);
  return r.stderr;
}

async function spikeUsage() {
  const r = await runSpike(['--help'], { env: {}, home });
  assert.equal(r.code, 2);
  return r.stderr;
}

test('front matter names the skill respike, keeps the plain trigger, adds "sequencer respike" and names the plugin as author', () => {
  assert.match(frontMatter, /^name: respike$/m);
  assert.match(frontMatter, /^description: /m);
  assert.match(frontMatter, /Trigger: .*re-spike/);
  assert.match(frontMatter, /Trigger: .*sequencer respike/);
  assert.match(frontMatter, /^ {2}author: keiron-sequencer$/m);
});

test('the skill holds no old name, in its front matter or its text', () => {
  assert.doesNotMatch(skill, new RegExp('mi' + 'kado', 'i'));
});

test('the steps run preflight, show the plan, the asks, the approval, begin, the card loop, pause, the report and the harvest offer, in that order', () => {
  const headings = [
    '## Preflight (before the first live run)', '## Step 1: Plan', '## Step 2: Show the plan', '## Step 3: Asks, one question per ask',
    '## Step 4: One approval, on the plan hash', '## Step 5: Begin', '## Step 6: The card loop', '## Step 7: Pause and resume',
    '## Step 8: Report', '## Step 9: Offer /keiron-sequencer:harvest',
  ];
  const at = headings.map(h => skill.indexOf(`\n${h}\n`));
  headings.forEach((h, i) => assert.ok(at[i] > 0, `missing heading ${JSON.stringify(h)}`));
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'the steps are out of order');
});

test('the respike subcommands the skill names are exactly the ones the usage lists', async () => {
  const usage = await respikeUsage();
  const fromUsage = new Set([...usage.matchAll(/^usage: node scripts\/respike\.mjs ([a-z-]+)/gm)].map(m => m[1]));
  const fromSkill = new Set([...skill.matchAll(RESPIKE_COMMAND)].map(m => m[1]));
  assert.deepEqual([...fromUsage].sort(), ['begin', 'config', 'fast-forward', 'fetch', 'preflight', 'report']);
  assert.deepEqual([...fromSkill].sort(), [...fromUsage].sort());
});

test('every respike usage flag is documented, and every flag on a respike command is a respike usage flag', async () => {
  const usage = await respikeUsage();
  const fromUsage = new Set(usage.match(FLAG));
  assert.ok(fromUsage.has('--unbuilt') && fromUsage.has('--run') && fromUsage.has('--approve'), [...fromUsage].join(', '));
  for (const flag of fromUsage) assert.ok(hasToken(skill, flag), `SKILL.md does not document ${flag}`);
  const passed = new Set(commandLines('scripts/respike.mjs').flatMap(l => l.match(FLAG) ?? []));
  assert.ok(passed.size >= 8, [...passed].join(', '));
  assert.deepEqual([...passed].filter(f => !fromUsage.has(f)), []);
});

test('every spike command the skill names is a spike CLI command, with spike flags only', async () => {
  const usage = await spikeUsage();
  const commands = new Set([...usage.matchAll(/^usage: node scripts\/spike\.mjs ([a-z-]+)/gm)].map(m => m[1]));
  const named = new Set([...skill.matchAll(SPIKE_COMMAND)].map(m => m[1]));
  for (const c of ['next', 'tree', 'candidates', 'fixup', 'end', 'begin', 'abandon', 'pause']) assert.ok(named.has(c), `SKILL.md does not run spike.mjs ${c}`);
  assert.deepEqual([...named].filter(c => !commands.has(c)), []);
  const flags = new Set(usage.match(FLAG));
  const passed = new Set(commandLines('scripts/spike.mjs').filter(l => !l.includes('respike.mjs')).flatMap(l => l.match(FLAG) ?? []));
  assert.deepEqual([...passed].filter(f => !flags.has(f)), []);
});

test('the command patterns tell spike.mjs from respike.mjs and skip prose', () => {
  const sample = 'node ${CLAUDE_PLUGIN_ROOT}/scripts/respike.mjs begin x, then node ${CLAUDE_PLUGIN_ROOT}/scripts/spike.mjs next, and respike.mjs or spike.mjs';
  assert.deepEqual([...sample.matchAll(RESPIKE_COMMAND)].map(m => m[1]), ['begin']);
  assert.deepEqual([...sample.matchAll(SPIKE_COMMAND)].map(m => m[1]), ['next']);
});

test('every bash fence runs only the respike or the spike CLI', () => {
  assert.ok(bashLines.length >= 8, `only ${bashLines.length} bash lines`);
  for (const line of bashLines) assert.ok(line.startsWith(RESPIKE) || line.startsWith(SPIKE), `bash line runs something else: ${line}`);
});

test('begin and fetch always carry an approve hash the CLI printed, after the user approves', () => {
  const gated = commandLines('scripts/respike.mjs').filter(l => /respike\.mjs (begin|fetch|fast-forward)\b/.test(l));
  assert.ok(gated.length >= 3, gated.join('\n'));
  for (const line of gated) assert.match(line, /respike\.mjs ((begin|fetch) <project ref>|fast-forward <project ref> --repo <repoDir>) --approve <hash>/);
  const approving = commandLines('scripts/respike.mjs').filter(l => hasToken(l, '--approve'));
  const APPROVED = /respike\.mjs ((begin|fetch) <project ref>|fast-forward <project ref> --repo <repoDir>|config --draft <draft\.json>) --approve <hash>/;
  for (const line of approving) assert.match(line, APPROVED);
  says('Run `begin` only after the user approves, and only with the `approve` hash the CLI printed for the plan the user approved');
  says('Never invent, shorten or reuse a hash from another plan');
  says('One question:');
  says('On exit 5, show the new plan and ask again');
});

test('every reason, ask, stop, block and warning code the plan emits is named, and the plan is shown in full', () => {
  const sources = ['scripts/lib/respike/built.mjs', 'scripts/lib/respike/coverage.mjs', 'scripts/lib/respike/plan.mjs', 'scripts/lib/respike/replay-plan.mjs', 'scripts/lib/respike/selection.mjs'];
  const codes = new Set();
  for (const file of sources) {
    const text = read(file);
    for (const [, code] of text.matchAll(/(?:code|reason): '([a-z][a-z-]*)'/g)) codes.add(code);
    for (const [, code] of text.matchAll(/spike\('([a-z][a-z-]*)'/g)) codes.add(code);
  }
  const hints = read('scripts/lib/respike/coverage.mjs').split('const HINTS = {')[1]?.split('\n};')[0] ?? '';
  for (const [, code] of hints.matchAll(/^\s*'([a-z][a-z-]*)':/gm)) codes.add(code);
  for (const code of ['repo-not-local', 'trial-dir-unmapped', 'repo-missing', 'local-branch', 'merged-into-branch', 'combine-conflict', 'default-conflict', 'bases-unknown', 'cycle', 'shared-patch', 'no-record', 'patch-missing', 'base-behind-default', 'risk-empty', 'repo-unknown']) {
    assert.ok(codes.has(code), `the sources no longer emit ${code}`);
  }
  for (const code of codes) assert.ok(skill.includes(`\`${code}\``), `SKILL.md does not name ${code}`);
  says('Show every entry of `missingConfig`');
  says('every entry of `warnings`');
  says('Show, in this order');
  says('drafts count as built');
  says('base N commits behind default');
  says('`sharedWith`');
  says('`selection.unknown`');
  says('`selection.dropped`');
});

test('one question per ask, preflight again with every answer so far, and a stop or a block creates nothing', () => {
  says('One question per ask');
  says('preflight again with every answer given so far');
  says('A `stop` creates nothing');
  says('`--unbuilt <CARD>`');
  says('`--built <CARD>=<branch>`');
  says('`nextApprove`');
});

test('the trial rename runs only on the user\'s explicit yes, and only the dry run is offered first', () => {
  says('show the output of its dry run');
  says('Run `--apply` or `--inverse` only on the user\'s explicit yes; otherwise stop');
  assert.ok(!flat.includes('say so and stop'), 'the rename step says to stop before it offers the dry run');
  says('`--apply`');
  says('`--inverse`');
  const lines = skill.split('\n').filter(l => l.includes('rename-trial-dirs.mjs'));
  assert.ok(lines.length >= 1);
  for (const f of fences) assert.ok(!f.body.includes('rename-trial-dirs.mjs'), 'a fence runs the rename');
});

test('the card loop is the /keiron-sequencer:spike loop: inline in the main session, no subagent, notes and cases, caps between cards, a warn-only box', () => {
  for (const anchor of [
    'The main session does the card work inline', 'no subagent per card', 'exactly as /keiron-sequencer:spike', 'between 3 and 6 given/when/then cases',
    '`openDecisions`', '`piiInLogs`', 'checked only between cards', 'warn-only', '`replayed`', '`replayConflict`', '`replaySecret`',
    'spiked like any other card', 'context only', '`previous`', '`priorFindings`', '`holds`, `resolved` or `wrong`', 'premise check',
    'implication check', '`impact`', '`owner`',
  ]) says(anchor);
  assert.doesNotMatch(skill, /newrelic-cli/i);
});


test('a spike begin with no hash only resumes a paused respike run, and the safety rules name that one exception', () => {
  const RESUME = 'node ${CLAUDE_PLUGIN_ROOT}/scripts/spike.mjs begin <project ref>';
  const begins = [...bashLines, ...inlineCode].filter(l => /scripts\/spike\.mjs begin\b/.test(l));
  assert.ok(begins.length >= 1);
  for (const line of begins) assert.equal(line, RESUME, `a spike begin that is not the bare resume: ${line}`);
  const allowed = [sectionOf('Safety rules'), sectionOf('Step 7: Pause and resume')];
  const everywhere = skill.split(RESUME).length - 1;
  const inAllowed = allowed.reduce((n, text) => n + text.split(RESUME).length - 1, 0);
  assert.equal(everywhere, inAllowed, 'spike.mjs begin appears outside the safety rules and the resume step');
  assert.ok(sectionOf('Step 7: Pause and resume').includes(RESUME));
  const safety = sectionOf('Safety rules').replace(/\s+/g, ' ');
  assert.ok(safety.includes('Run `begin` only after the user approves'));
  assert.ok(safety.includes(`\`${RESUME}\` with no hash only resumes an already-begun paused respike run and never creates a run`), 'the safety rules do not name the resume exception');
});

test('pause and resume go through spike begin, and an open run is offered resume or abandon', () => {
  says('a paused respike run resumes with');
  says('`node ${CLAUDE_PLUGIN_ROOT}/scripts/spike.mjs begin <project ref>`');
  says('needs no hash');
  says('`node ${CLAUDE_PLUGIN_ROOT}/scripts/spike.mjs abandon [--discard] [--project <project ref>]`');
});

test('the report is printed and saved, advisory, its file named for the user to review, with every project list shown', () => {
  for (const anchor of [
    'printed and saved', 'advisory', 'for the user to review', '~/.keiron-sequencer/<slug>/spike/respike-<runId>.json', '`path`', '`project.newCards`', '`project.orphans`', '`project.built`',
    '`project.selectedBuilt`', '`project.replayed`', '`project.replayToSpike`', '`project.replanned`', '`project.unselected`', '`project.pending`',
    '`bases`', '`replayed`', '`respike: true`',
  ]) says(anchor);
});

test('/keiron-sequencer:harvest is offered, never run', () => {
  says('Offer /keiron-sequencer:harvest');
  says('never run it');
});

test('the safety rules are stated', () => {
  for (const anchor of [
    'Never commit, push or open a PR', 'Patches and run state stay in `~/.keiron-sequencer`', 'they stay personal: never committed or shared', 'data-in-repo', 'move-data.mjs',
    'Never read, print, cat or copy the Linear key', 'No production DB writes', 'No patient data in logs', 'one at a time',
    'additional directory', 'Stop until the session can edit `~/.keiron-sequencer`', '/add-dir ~/.keiron-sequencer', 'reference only',
  ]) says(anchor);
});

test('the skill holds no git apply, commit, push or tag command', () => {
  for (const s of ['git apply', 'git commit', 'git push', 'git tag', 'git am', 'gh pr create', 'patch -p', 'worktree add']) {
    assert.ok(!skill.includes(s), `SKILL.md contains ${JSON.stringify(s)}`);
  }
  assert.doesNotMatch(skill, /\bgit (commit|push|tag)\b/);
});

test('the skill holds no planning id', () => {
  const ids = [/\b(RP|RB|RR|RM|RK|RX)-\d/, /\bT\d+\.\d+\b/, /(?<![\w-])#\d+/, new RegExp(['sdd', '/'].join(''))];
  for (const re of ids) assert.doesNotMatch(skill, re);
});

test('the skill never shows a key or a key path, or tells anyone to read one', () => {
  for (const re of [/linear\.key/i, /keiron-planner/i, /LINEAR_API_KEY/, /lin_api_/i, /Bearer/i, /\b(gh[pousr]_|AKIA|xox[abprs]-)/, /[A-Za-z0-9_]{32,}/, /\.config\//]) {
    assert.doesNotMatch(skill, re);
  }
  says('If it finds none (Exit 3), tell the user; never ask them to paste a key into the chat');
});

test('the plugin install is documented, not performed, and no symlink is named', () => {
  says('`claude plugin marketplace add <owner>/keiron-sequencer`');
  says('`claude plugin install keiron-sequencer@keiron-sequencer`');
  says('do not run these yourself');
  assert.doesNotMatch(skill, /ln -s|\.claude\/skills/);
});

test('every exit code of the respike CLI and of the loop is handled', () => {
  for (const code of [0, 1, 2, 3, 4, 5, 6, 7]) assert.ok(skill.includes(`Exit ${code}`), `missing Exit ${code}`);
});

const RULE = 'Missing config blocks the run. The skill never edits the file; the CLI writes it only with the approved hash, after a backup (`config.json.bak`, one copy, replaced on each write).';

test('the config rule: the skill never edits the file, and the CLI writes it only with the approved hash after a backup', () => {
  assert.ok(sectionOf('Safety rules').replace(/\s+/g, ' ').includes(RULE), 'the safety rules do not state the config rule');
  assert.ok(flat.toLowerCase().includes('the skill never edits the file; the cli writes it only with the approved hash, after a backup'));
  assert.ok(!flat.toLowerCase().includes('the user fixes the config; the skill never edits it'), 'the old config rule is still there');
  says('The CLI never installs a tool');
});

test('the config step runs its three forms in order: --out only on the draft, --draft only on the review and the write', () => {
  const draftForm = `${RESPIKE}config <project ref> --out <draft.json> [--root <dir>]... [--cards <CARD>[,<CARD>]...] [--stale] [--built <CARD>=<branch>]... [--unbuilt <CARD>]...`;
  const reviewForm = `${RESPIKE}config --draft <draft.json>`;
  const writeForm = `${RESPIKE}config --draft <draft.json> --approve <hash>`;
  const lines = commandLines('scripts/respike.mjs').filter(l => /respike\.mjs config\b/.test(l));
  assert.ok(lines.length >= 3, lines.join('\n'));
  for (const line of lines) {
    if (hasToken(line, '--out')) {
      assert.equal(line, draftForm);
    } else {
      assert.ok([reviewForm, writeForm].includes(line), `a config form that is neither the draft, the review nor the write: ${line}`);
    }
  }
  const at = [`\n${draftForm}\n`, `\n${reviewForm}\n`, `\n${writeForm}\n`].map(form => configStep.indexOf(form));
  assert.ok(at.every(i => i >= 0), JSON.stringify(at));
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'the config forms are out of order');
  for (const flag of ['--out', '--draft', '--root']) assert.ok(hasToken(skill, flag), `SKILL.md does not document ${flag}`);
});

test('the config step goes: show the gaps, draft into scratch, ask for roots once, show the report, review an edit, write on yes, report the backup, preflight again', () => {
  const step1 = sectionOf('Step 1: Plan').replace(/\s+/g, ' ');
  const anchors = [
    'Show every entry of `missingConfig`', "a new file in the session's scratch directory", 'ask the user once',
    'Show the report, the change list and the hash', 'run the review: it prints a new change list, diff and hash',
    'only with the `approve` hash the CLI printed for the draft text the user approved', 'report the config path and the backup path',
    'preflight again with the same flags',
  ];
  const at = anchors.map(a => step1.indexOf(a));
  anchors.forEach((a, i) => assert.ok(at[i] >= 0, `Step 1 does not say ${JSON.stringify(a)}`));
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'the config step is out of order');
  for (const anchor of [
    'not found under', 'ask the user once', '`checkoutRoots`', '`config.json.bak`', 'never clone', 'a separate yes per tool',
    'never part of the config write', 'draft again after an install', 'never into config.json', 'preflight again with the same flags',
    'Never suggest a default folder',
  ]) stepSays(configStep, anchor);
});

test('the config step names the bootstrap, the no-roots refusal, every line kind and the draft report fields', () => {
  const kinds = new Set([...read('scripts/lib/spike/config-draft.mjs').matchAll(/kind: '([a-z][a-z-]*)'/g)].map(m => m[1]));
  for (const kind of ['proposed', 'unfilled', 'not-found', 'skipped', 'rename-trial-dirs', 'reset', 'dropped', 'resolved']) assert.ok(kinds.has(kind), `the drafter no longer emits ${kind}`);
  for (const kind of kinds) assert.ok(configStep.includes(`\`${kind}\``), `the config step does not name ${kind}`);
  const cli = read('scripts/respike.mjs');
  assert.ok(cli.includes("'no checkout roots: ") && cli.includes("'read' : 'missing'"), 'the CLI no longer prints the no-roots refusal or the missing base state the skill keys on');
  for (const anchor of [
    '`base.state`', '`missing`', 'bootstrap', '`no checkout roots`', '`items`', '`fixes`', '`stray`', '`warnings`', '`needs`', '`changes`',
    '`diff`', '`reformat`', '`approve: null`', '`errors`', '`backup`', 'not an open item',
  ]) stepSays(configStep, anchor);
});

test('the config step offers the three options for a not-found item', () => {
  for (const anchor of ['not found under', 'clone it yourself', 'add a root', 'leave its cards out with `--cards`', 'never clone']) stepSays(configStep, anchor);
  for (const anchor of ['replaces the stored roots for that call', '`roots.searched`', 'adds it to `checkoutRoots` in the draft']) stepSays(configStep, anchor);
});

test('an unparseable config is reported and the skill stops', () => {
  assert.ok(read('scripts/respike.mjs').includes('it is never replaced: fix or remove it by hand'), 'the CLI no longer prints the refusal the skill keys on');
  for (const anchor of ['`it is never replaced: fix or remove it by hand`', 'is not JSON', 'Report it and stop', 'never drafts from it and never replaces it', 'fixes it by hand']) {
    stepSays(configStep, anchor);
  }
});

test('the config loop has its three end conditions', () => {
  for (const anchor of ['no longer blocks', 'proposes no change', '`nothing to draft`', 'the user stops']) stepSays(configStep, anchor);
});

const CLONE = /\bgit\s+clone\b|\bgh\s+repo\s+clone\b|\bgit\s+worktree\s+add\b/;

test('the skill never names a clone command', () => {
  for (const sample of [['git', 'clone x'].join(' '), ['gh', 'repo', 'clone o/n'].join(' '), ['git', 'worktree', 'add ../t'].join(' ')]) assert.match(sample, CLONE);
  for (const line of skill.split('\n')) assert.doesNotMatch(line, CLONE);
  stepSays(configStep, 'never clone');
});

const TOOL_INSTALL = /\b(npm|pnpm|yarn|corepack|brew|apt(-get)?|winget|go)\s+(install|i|add|enable|get)\b/;

test('the skill names no tool-install command, and no bash fence installs anything', () => {
  for (const sample of [['brew', 'install go'], ['npm', 'install --global x'], ['corepack', 'enable'], ['apt-get', 'install y'], ['go', 'get z'], ['yarn', 'add w']]) {
    assert.match(sample.join(' '), TOOL_INSTALL);
  }
  for (const line of skill.split('\n')) assert.doesNotMatch(line, TOOL_INSTALL);
  for (const f of fences.filter(f => f.lang === 'bash')) assert.ok(!/install/i.test(f.body), 'a bash fence holds install');
  for (const anchor of ['a separate yes per tool', 'never part of the config write', 'draft again after an install']) stepSays(sectionOf('Safety rules'), anchor);
});

test('the exit codes name the config step\'s refusals', () => {
  const codes = sectionOf('Exit codes').replace(/\s+/g, ' ');
  for (const anchor of ['no checkout roots', 'an existing `--out`', 'never replaced', 'a config draft or config.json changed since its hash']) {
    assert.ok(codes.includes(anchor), `the exit codes do not say ${JSON.stringify(anchor)}`);
  }
});

test('stale is the default selection, read by hunks, with touched cards shown and --all for every open card', () => {
  for (const anchor of [
    'With no flags the selection is the stale cards', '`--all` selects every open execution card', 'in the hunks the card changed',
    'A commit elsewhere in the same file', '`selection.touched`', 'falls back to the whole file',
  ]) says(anchor);
});

test('a replay below a spiked ancestor is spiked, a replay that fails its typecheck turns, and end can refuse with Exit 8', () => {
  for (const anchor of ['`ancestor-spiked`', '`spikedAncestors`', '`replayTypecheck`', '`typecheck`', '**Exit 8**', '--skip-typecheck']) says(anchor);
});

test('a base behind default is brought up to date on the user\'s yes: --with-default merges it in, fast-forward moves a branch with no own commits', () => {
  for (const anchor of [
    '`ownCommits`', '--with-default <repoDir>', 'no branch of the user\'s moves', 'node ${CLAUDE_PLUGIN_ROOT}/scripts/respike.mjs fast-forward <project ref> --repo <repoDir> --approve <hash>',
    'except a local branch with no own commits', 'nothing is pushed', '`default-conflict`',
  ]) says(anchor);
  assert.doesNotMatch(skill, /rebase/i);
});

test('the respike loop runs next and end with the longest shell timeout or in the background', () => {
  says('Run `next` and `end` with the shell tool\'s longest timeout (600000 ms) or in the background');
});

test('no-milestone cards are shown in the plan with the advice to assign them before begin', () => {
  says('`no-milestone`');
  says('assign them a milestone in Linear before `begin`');
  says('a milestone question (which card moves)');
});
