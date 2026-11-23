import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, globSync, readdirSync, readFileSync } from 'node:fs';
import { ORDER_KEYS } from '../scripts/lib/next-order.mjs';
import { run as runSpike } from '../scripts/spike.mjs';
import { guardNetwork } from './helpers/no-network.mjs';

guardNetwork();

const skill = readFileSync(new URL('../skills/next/SKILL.md', import.meta.url), 'utf8');
const frontMatter = skill.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';

const has = (text) => assert.ok(skill.includes(text), `SKILL.md is missing ${JSON.stringify(text)}`);
const flat = skill.replace(/\s+/g, ' ');
const says = (text) => assert.ok(flat.includes(text), `SKILL.md does not say ${JSON.stringify(text)}`);
const count = (text) => flat.split(text).length - 1;
const section = (heading) => skill.split(`\n## ${heading}\n`)[1]?.split('\n## ')[0] ?? '';

test('front matter names the skill next, keeps the plain triggers and adds "sequencer next"', () => {
  assert.match(frontMatter, /^name: next$/m);
  assert.match(frontMatter, /what's next/);
  assert.match(frontMatter, /sequencer next/);
});

test('the next skill holds no old name, in its front matter or its text', () => {
  assert.doesNotMatch(skill, new RegExp('mi' + 'kado', 'i'));
});

const STEP0 = 'Step 0: Run the CLI';
const LIB = name => readFileSync(new URL(`../scripts/${name}`, import.meta.url), 'utf8');

test('next runs only next.mjs, packs.mjs and move-data.mjs, with no DEGRADED mode and no gh or git recipe', () => {
  const scripts = [...skill.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/([\w/.-]+\.mjs)/g)].map(m => m[1]);
  assert.deepEqual([...new Set(scripts)].sort(), ['maintenance/move-data.mjs', 'next.mjs', 'packs.mjs']);
  assert.doesNotMatch(skill, /DEGRADED|graph\.mjs|gh pr list|gh search prs|gh api|for-each-ref|worktree list|ls-remote/);
});

test('Step 0 runs the CLI with a long timeout and stops on exits 1, 2 and 3', () => {
  const step0 = section(STEP0);
  assert.ok(step0.includes('node ${CLAUDE_PLUGIN_ROOT}/scripts/next.mjs "<project-ref>"'), 'Step 0 must run next.mjs');
  assert.ok(step0.includes('timeout: 180000'));
  for (const code of ['Exit 0', 'Exit 1', 'Exit 2', 'Exit 3']) assert.ok(step0.includes(code), code);
  has('LINEAR_API_KEY');
  has('~/.config/keiron-planner/linear.key');
});

test('the spike-record check names the data folder in the spike home, and the data-in-repo warning', () => {
  has('~/.keiron-sequencer/<project.slug>');
  has('data-in-repo');
  has('node ${CLAUDE_PLUGIN_ROOT}/scripts/maintenance/move-data.mjs <project.slug>');
  assert.ok(!skill.includes('${CLAUDE_PLUGIN_ROOT}/data/'), 'SKILL.md names a data folder inside the plugin');
});

test('Step 0 tells "no spike record" from "records unreadable" with records.count and records.invalid, one line at most', () => {
  const step0 = section(STEP0);
  for (const text of ['records.count', 'records.invalid', '~/.keiron-sequencer/<project.slug>', 'No spike record for', 'Spike records unreadable for', 'record-invalid']) {
    assert.ok(step0.includes(text), `Step 0 is missing ${JSON.stringify(text)}`);
  }
  assert.equal(count('No spike record for'), 1);
  assert.equal(count('Spike records unreadable for'), 1);
  says('Print at most one of these lines for this project in this run, and continue');
  assert.ok(step0.replace(/\s+/g, ' ').includes('are ignored: neither counted nor invalid'));
});

test('the pick and the alternate state one size rule and the verdict tag, never effort', () => {
  const rule = 'its size (`size.label` when non-null, else the Linear `estimate` (rough size), else "no size")';
  for (const heading of ['The pick', 'The alternate']) {
    const item = section('Output').split('\n- **').find(b => b.startsWith(`${heading}**`)) ?? '';
    assert.ok(item.replace(/\s+/g, ' ').includes(rule), `Output "${heading}" must state the size rule`);
    assert.ok(item.includes('verdict tag'), `Output "${heading}" must show the verdict tag`);
  }
  has('`<tier> · <verdict>`');
  says('`unknown` is shown literally, never replaced by `No SDD`');
  says('Never show effort or `timeBox`');
  says("comes from the spike record's origin (the trial copied a real PR), not from GitHub");
});

test('the skill names every ranking key of the order lib, in order, and never re-derives them', () => {
  const json = section('What the JSON says').replace(/\s+/g, ' ');
  const at = ORDER_KEYS.map(k => json.indexOf(k));
  assert.ok(at.every(i => i >= 0), ORDER_KEYS.filter((k, i) => at[i] < 0).join(', '));
  assert.deepEqual([...at].sort((a, b) => a - b), at);
  says('Never re-derive');
});

test('every overdue reason and every warning kind the CLI emits is named in the skill', () => {
  const free = LIB('lib/next/free.mjs');
  const reasons = ['in-review', 'taken', 'started-local', 'started-remote', 'started-linear', 'triage', 'assigned-other', 'blocked', 'waiting-reviews', 'excluded'];
  for (const r of reasons) {
    assert.ok(free.includes(`'${r}'`), `free.mjs no longer emits ${r}`);
    has(`\`${r}\``);
  }
  const kinds = new Set([...`${free}\n${LIB('next.mjs')}`.matchAll(/kind: '([a-z-]+)'/g)].map(m => m[1]));
  for (const k of ['backward-milestone', 'record-invalid', 'data-in-repo', 'relations-truncated']) kinds.add(k);
  assert.ok(kinds.size >= 12, [...kinds].join(', '));
  for (const k of kinds) has(`\`${k}\``);
});

test('the pick says unverified and checks, a deferrable card drops only inside a tie, and textBlockers go to start', () => {
  has('`unverified`');
  has('`checks`');
  says('a `deferrable` card drops below');
  has('`textBlockers`');
  has('--blocker');
});

test('the output names the rule that chose the milestone, lists the overdue cards and states today', () => {
  for (const rule of ['deadline <date> (<card or milestone>)', 'milestone order (<name> is the first with writable work)', 'no milestone (no milestone has writable work)']) has(rule);
  has('**Overdue**');
  has('`today`');
});

test('starting a card hands off to /keiron-sequencer:start, never to an older start command', () => {
  has('`/keiron-sequencer:start');
  assert.ok(!skill.includes('/linear-card-start'), 'SKILL.md still names /linear-card-start');
  assert.ok(!skill.includes('/mi' + 'kado-start'), 'SKILL.md still names the old start command');
});

test('the skill never shows a key or an auth header', () => {
  assert.doesNotMatch(skill, /Bearer/i);
  assert.doesNotMatch(skill, /lin_api_/i);
  assert.doesNotMatch(skill, /LINEAR_API_KEY\s*=\s*\S/);
});

test('next: a backward-milestone warning and cards with no milestone are named, the latter to fix before a respike', () => {
  says('`backward-milestone`');
  says('`no-milestone`');
  says('before a respike');
});

const SPIKE_SKILL = new URL('../skills/spike/SKILL.md', import.meta.url);
const spike = existsSync(SPIKE_SKILL) ? readFileSync(SPIKE_SKILL, 'utf8') : '';
const spikeFlat = spike.replace(/\s+/g, ' ');
const spikeSays = text => assert.ok(spikeFlat.includes(text), `spike SKILL.md does not say ${JSON.stringify(text)}`);
const spikeUsage = async () => {
  const { code, stderr } = await runSpike(['--help']);
  assert.equal(code, 2);
  return stderr;
};
const FLAG = /(?<![\w-])--[a-z][a-z-]*/g;

test('spike: front matter names the skill spike, keeps the plain trigger and adds "sequencer spike"', () => {
  const front = spike.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';
  assert.match(front, /^name: spike$/m);
  assert.match(front, /^description: /m);
  assert.match(front, /spike the project/);
  assert.match(front, /sequencer spike/);
});

test('spike: the skill holds no old name, in its front matter or its text', () => {
  assert.doesNotMatch(spike, new RegExp('mi' + 'kado', 'i'));
});

test('spike: every command the skill runs is a spike CLI command, and the skill runs all of them', async () => {
  const named = new Set([...spike.matchAll(/node \$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/spike\.mjs ([a-z-]+)/g)].map(m => m[1]));
  const commands = [...new Set([...(await spikeUsage()).matchAll(/^usage: node scripts\/spike\.mjs ([a-z-]+)/gm)].map(m => m[1]))].sort();
  assert.deepEqual(commands, ['abandon', 'begin', 'candidates', 'check', 'config', 'cross', 'end', 'fixup', 'next', 'notes-template', 'pause', 'prune', 'rebuild', 'status', 'tracks', 'tree']);
  assert.deepEqual([...named].sort(), commands);
});

test('spike: every flag the skill shows is a spike CLI flag, and every CLI flag is documented', async () => {
  const usage = await spikeUsage();
  const documented = [...new Set(spike.match(FLAG))].sort();
  const cli = [...new Set(usage.match(FLAG))].sort();
  assert.deepEqual(documented, cli);
  spikeSays('`--project <project ref>`');
  spikeSays('only when more than one project has an active run');
});

test('spike: the main session works every card inline, with no subagent per card and no headless runs', () => {
  spikeSays('The main session does the card work inline');
  spikeSays('no subagent per card, no headless runs');
});

test('spike: never commit, push or open a PR; the records stay personal', () => {
  spikeSays('Never commit, push or open a PR');
  spikeSays('they stay personal: never committed or shared');
  spikeSays('~/.keiron-sequencer/<slug>/');
  assert.doesNotMatch(spike, /the user commits them|`data\/<slug>\/`/);
  spikeSays('push guard');
  assert.doesNotMatch(spike, /\bgit (commit|push|tag)\b/);
});

test('spike: the Linear key is never read, and the skill holds no key path or key-shaped string', () => {
  spikeSays('Never read, print, cat or copy the Linear key');
  spikeSays('Linear only through the CLI');
  for (const re of [/linear\.key/i, /keiron-planner/i, /LINEAR_API_KEY/, /lin_api_/i, /Bearer/i, /\b(gh[pousr]_|AKIA|xox[abprs]-)/, /[A-Za-z0-9_]{32,}/]) {
    assert.doesNotMatch(spike, re);
  }
});

test('spike: preflight asks for ~/.keiron-sequencer as an additional directory before the first live run and stops until it is', () => {
  spikeSays('~/.keiron-sequencer');
  spikeSays('/add-dir ~/.keiron-sequencer');
  spikeSays('additional directory');
  spikeSays('before the first live run');
  spikeSays('Stop until the session can edit `~/.keiron-sequencer`');
  spikeSays('do not edit their settings yourself');
  spikeSays('~/.keiron-sequencer/config.json');
  spikeSays('docs/spike-config.example.json');
});

test('spike: every checkout whose extensions.worktreeConfig the run sets is reported to the user', () => {
  spikeSays('`extensions.worktreeConfig`');
  spikeSays('`touchedCheckouts`');
  spikeSays('Report every checkout');
});

test('spike: caps are optional and checked only between cards; the box is warn-only and fixed at the first window', () => {
  for (const flag of ['--max-tokens', '--max-cards', '--box']) spikeSays(flag);
  spikeSays('Both caps are optional');
  spikeSays('checked only between cards');
  spikeSays('a fresh budget');
  spikeSays('warn-only');
  spikeSays("fixed at the card's first window");
  spikeSays('Existing-PR cards never get a box');
  spikeSays('Never mark the scope incomplete for a box overrun');
});

test('spike: notes start from notes-template, carry about 4 English cases, open decisions after the implication check, and the attested PII paths', () => {
  spikeSays('About 4 English given/when/then cases at card end');
  spikeSays('Start from `notes-template`');
  spikeSays('Run the implication check on every open guess before recording it');
  for (const text of ['`resolved`', '`narrowed`', '`eliminated`', 'tag it with `impact` (`design` or `detail`) and `owner` (`people` or `code`)']) spikeSays(text);
  spikeSays('Never auto-resolve a decision about policy, security posture, legal or retention, UX copy, or rollout timing');
  spikeSays('`piiInLogs`');
  spikeSays('use `[]` when there are none');
  spikeSays('No diff text in the notes');
});

test('spike: the working rules: trivial decisions proceed, heavy commands one at a time, no prod DB writes, no patient data in logs', () => {
  spikeSays('Proceed on trivial decisions');
  spikeSays('Ask the user mid-card only on real conflicts');
  spikeSays('one at a time');
  spikeSays('No production DB writes');
  spikeSays('No patient data in logs');
  spikeSays('Patches and run state live in `~/.keiron-sequencer`');
});

test("spike: an existing-PR card gets the PR's diff once, at tree or at next, and a conflict is reported", () => {
  spikeSays("the CLI applies the PR's diff into that repo's tree once");
  spikeSays('at `tree <repoDir>` while the card is current');
  spikeSays('at `next` when that tree is already open');
  for (const key of ['`prDiff`', '`prDiffError`']) spikeSays(key);
});

test('spike: every exit code and every output action the loop branches on is handled', () => {
  for (let code = 0; code <= 8; code++) assert.ok(spike.includes(`Exit ${code}`), `missing Exit ${code}`);
  for (const action of ['card', 'pause', 'complete', 'unmeasured', 'nothing-to-do', 'setup-failed', 'secret', 'candidates', 'typecheck']) {
    spikeSays(`\`action: '${action}'\``);
  }
  for (const key of ['`resumed: true`', '`noChange`', '`warnings`', '`removed`', '`pruned`']) spikeSays(key);
  spikeSays('run begin to resume it');
});

test('spike: nothing-to-do on a completed project points to /keiron-sequencer:respike for a new pass', () => {
  const pointer = 'the pass is complete, and a new pass is made with /keiron-sequencer:respike';
  spikeSays(pointer);
  const handled = spikeFlat.indexOf("`action: 'nothing-to-do'`");
  const at = spikeFlat.indexOf(pointer);
  assert.ok(handled >= 0 && at > handled && at - handled < 200, 'the pointer is not next to the nothing-to-do handling');
});

test('spike: the plugin install is documented, not performed, and no symlink is named', () => {
  spikeSays('`claude plugin marketplace add <owner>/keiron-sequencer`');
  spikeSays('`claude plugin install keiron-sequencer@keiron-sequencer`');
  spikeSays('the user installs it');
  assert.doesNotMatch(spike, /ln -s|\.claude\/skills/);
});

test('spike: the premise check runs before building, New Relic is optional and never named as a skill, relevance is report-only', () => {
  spikeSays('Premise check, before building');
  spikeSays('checkable claims');
  spikeSays('only when a New Relic CLI or tool is available on this machine');
  spikeSays('stays an open decision marked unverified');
  spikeSays('possibly obsolete');
  spikeSays('never move or cancel the Linear card');
  assert.doesNotMatch(spike, /newrelic-cli/i);
});

test('spike: on a respike each old finding gets an outcome in priorFindings instead of being rewritten', () => {
  spikeSays('`previous`');
  spikeSays('`priorFindings`');
  spikeSays('`holds`, `resolved` or `wrong`');
  spikeSays('instead of rewriting it');
});

test('spike: fixups before the shared file is touched, a constructor sweep before end, lint through the repo target', () => {
  spikeSays('Record a fixup before the current card touches the same file');
  spikeSays('snapshots whole files');
  spikeSays('list the integration specs that build that class and run them');
  spikeSays("Lint through the repo's own target");
  spikeSays('never eslint directly');
});

test('spike: end type-checks the changed files with no config, refuses with Exit 8, and a skip needs a reason', () => {
  spikeSays('needs no config');
  spikeSays('`spikeTypecheck`');
  spikeSays('`--skip-typecheck "<reason>"`');
  spikeSays('only when the failure is not this card');
});

test('next only reports the packs of startable cards that are unanswered or stale; it never drafts, asks or answers', () => {
  has('node ${CLAUDE_PLUGIN_ROOT}/scripts/packs.mjs status <project-ref>');
  assert.doesNotMatch(skill, /packs\.mjs (draft|answer)/);
  says('in `free[]`');
  says('`unanswered` or `stale`');
  says('Never ask a pack question here');
  says('/keiron-sequencer:start drafts the pack');
});

test('spike: next and end run with the longest shell timeout or in the background, since a typecheck can take minutes', () => {
  spikeSays('Run `next` and `end` with the shell tool\'s longest timeout (600000 ms) or in the background');
});

test('spike: the auto typecheck checks the whole program and refuses only on errors in the changed files', () => {
  spikeSays('type-checks the whole program through the repo\'s own TypeScript config');
  spikeSays('only an error in a file the card changed refuses');
});

test('spike: a reorder finding that would run backward across milestones is recorded as a milestone question', () => {
  spikeSays("compare the two cards' milestones");
  spikeSays('a milestone question (which card moves)');
});

const ROOT = new URL('..', import.meta.url);
const FOLDERS = ['cycle', 'harvest', 'next', 'respike', 'spike', 'start'];
const skills = Object.fromEntries(FOLDERS.map(f => [f, readFileSync(new URL(`skills/${f}/SKILL.md`, ROOT), 'utf8')]));
const OLD = new RegExp('mi' + 'kado', 'i');
const REPO_PATH = new RegExp('Desktop\\/(mi' + 'kado|keiron-sequencer)\\b', 'i');
const ROOT_MISUSE = /export CLAUDE_PLUGIN_ROOT|\$\{CLAUDE_PLUGIN_ROOT:-|\$CLAUDE_PLUGIN_ROOT\b/;
const PREFIXED = /^node \$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/[a-z-]+(\/[a-z-]+)*\.mjs\b/;
const INVOKES = /\bnode\s+\S*scripts\/[a-z-]+(\/[a-z-]+)*\.mjs/;
const SCRIPT_PATH = /(\S*)\/scripts\/[a-z-]+(?:\/[a-z-]+)*\.mjs/g;
const NAMED_SCRIPT = /\$\{CLAUDE_PLUGIN_ROOT\}\/(scripts\/[a-z-]+(?:\/[a-z-]+)*\.mjs)/g;
const commandsOf = text => {
  const fenced = [...text.matchAll(/^```bash\n([\s\S]*?)^```$/gm)].flatMap(m => m[1].split('\n'));
  const inline = [...text.replace(/^```\w*\n[\s\S]*?^```$/gm, '').matchAll(/`([^`\n]+)`/g)].map(m => m[1]);
  return [...fenced, ...inline].map(l => l.trim()).filter(l => INVOKES.test(l));
};

test('plugin: skills/ holds exactly the six skills, and each name equals its folder', () => {
  assert.deepEqual(readdirSync(new URL('skills/', ROOT)).sort(), FOLDERS);
  for (const [folder, text] of Object.entries(skills)) {
    const front = text.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';
    assert.match(front, new RegExp(`^name: ${folder}$`, 'm'), folder);
  }
});

test('plugin: no skill holds the old name, in its front matter or its text', () => {
  assert.match('name: ' + 'mi' + 'kado-next', OLD);
  for (const [folder, text] of Object.entries(skills)) assert.doesNotMatch(text, OLD, folder);
});

test('plugin: no skill names the plugin repo folder or sets, defaults or reads the plugin root variable', () => {
  for (const planted of ['~/Desktop/' + 'mi' + 'kado/scripts', '~/Desktop/keiron-sequencer/scripts']) assert.match(planted, REPO_PATH);
  for (const planted of ['export CLAUDE_PLUGIN_ROOT=/x', '${CLAUDE_PLUGIN_ROOT:-/x}', 'node $CLAUDE_PLUGIN_ROOT/scripts/next.mjs']) assert.match(planted, ROOT_MISUSE);
  assert.doesNotMatch('node ${CLAUDE_PLUGIN_ROOT}/scripts/next.mjs', ROOT_MISUSE);
  assert.doesNotMatch('cd ~/Desktop/work/<repo>', REPO_PATH);
  for (const [folder, text] of Object.entries(skills)) {
    assert.doesNotMatch(text, REPO_PATH, folder);
    assert.doesNotMatch(text, ROOT_MISUSE, folder);
  }
});

test('plugin: every script a skill runs goes through the plugin root, and every script it names exists', () => {
  assert.doesNotMatch('node ~/Desktop/x/scripts/spike.mjs begin', PREFIXED);
  assert.match('node ${CLAUDE_PLUGIN_ROOT}/scripts/maintenance/move-data.mjs <slug>', PREFIXED);
  for (const [folder, text] of Object.entries(skills)) {
    const commands = commandsOf(text);
    assert.ok(commands.length > 0, `${folder} runs no script`);
    for (const line of commands) assert.match(line, PREFIXED, `${folder}: ${line}`);
    for (const [, before] of text.matchAll(SCRIPT_PATH)) assert.ok(before.endsWith('${CLAUDE_PLUGIN_ROOT}'), `${folder}: a script path after ${before}`);
    for (const [, script] of text.matchAll(NAMED_SCRIPT)) assert.ok(existsSync(new URL(script, ROOT)), `${folder}: ${script} does not exist`);
  }
});

test('plugin: every cross-reference names one of the six skills', () => {
  const refs = Object.values(skills).flatMap(text => [...text.matchAll(/\/keiron-sequencer:([a-z-]+)/g)].map(m => m[1]));
  assert.ok(refs.length > 0);
  assert.deepEqual(refs.filter(name => !FOLDERS.includes(name)), []);
});

test('plugin: the install is the plugin install, and no skill or script names a symlink or a path under .claude/skills', () => {
  for (const folder of ['respike', 'spike', 'start']) assert.ok(skills[folder].includes('keiron-sequencer@keiron-sequencer'), folder);
  for (const [folder, text] of Object.entries(skills)) assert.doesNotMatch(text, /ln -s|\.claude\/skills/, folder);
  const scripts = globSync('scripts/**/*.mjs', { cwd: ROOT });
  assert.ok(scripts.length > 0);
  assert.deepEqual(scripts.filter(f => /\.claude\/skills/.test(readFileSync(new URL(f, ROOT), 'utf8'))), []);
});

test('spike: the config is drafted by the skill from the cards and the checkouts, and written only on the approved hash', () => {
  spikeSays('the user never writes it by hand');
  spikeSays('node ${CLAUDE_PLUGIN_ROOT}/scripts/spike.mjs config <project ref> --out <draft.json>');
  spikeSays('--approve <hash>');
  spikeSays('ask once which folders hold their checkouts');
  assert.doesNotMatch(spikeFlat, /The user writes `~\/\.keiron-sequencer\/config\.json`/);
});

test('spike: the config is shown as one line per repo and its path, found from this session\'s checkout first', () => {
  spikeSays('One line per repo: `<repo> → <checkout path>`');
  spikeSays('the folder that holds the checkout this session runs in');
  spikeSays('Never show the JSON, the hash, the setup or the risk paths unless the user asks');
});
