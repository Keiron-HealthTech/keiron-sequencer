import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, globSync, readdirSync, readFileSync } from 'node:fs';
import { ORDER_KEYS, SOON_DAYS } from '../scripts/lib/next-order.mjs';
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

test('Step 0 calls the graph CLI with the project reference and handles every exit code', () => {
  has('node ${CLAUDE_PLUGIN_ROOT}/scripts/graph.mjs "<project-ref>"');
  for (const code of ['Exit 0', 'Exit 1', 'Exit 2', 'Exit 3']) has(code);
  has('DEGRADED');
  has('warnings[]');
  has('LINEAR_API_KEY');
  has('~/.config/keiron-planner/linear.key');
});

test('the spike-record check names the data folder in the spike home, and the data-in-repo warning', () => {
  has('~/.keiron-sequencer/<project.slug>');
  has('data-in-repo');
  has('node ${CLAUDE_PLUGIN_ROOT}/scripts/maintenance/move-data.mjs <project.slug>');
  assert.ok(!skill.includes('${CLAUDE_PLUGIN_ROOT}/data/'), 'SKILL.md names a data folder inside the plugin');
});

test('the spike-record check reads records.count; the pick and the alternate show size.label, never effort', () => {
  has('records.count');
  for (const heading of ['The pick', 'The alternate']) {
    const item = section('Output').split('\n- **').find(b => b.startsWith(`${heading}**`)) ?? '';
    assert.ok(item.includes('size.label'), `Output "${heading}" must show size.label`);
  }
  says('Never show effort');
});

test('Step 0 tells "no spike record" from "records unreadable" with records.count and records.invalid', () => {
  const step0 = section('Step 0: Read the Graph');
  for (const text of ['records.count', 'records.invalid', '~/.keiron-sequencer/<project.slug>', 'No spike record for', 'Spike records unreadable for', 'record-invalid']) {
    assert.ok(step0.includes(text), `Step 0 is missing ${JSON.stringify(text)}`);
  }
  assert.equal(count('No spike record for'), 1);
  assert.equal(count('Spike records unreadable for'), 1);
});

test('the size shown is the CLI\'s label: never a tier read from a record file, none in DEGRADED mode, never effort', () => {
  says('never from a record file');
  says('In DEGRADED mode no `size.label` is shown (the tier only appears inside the label)');
  assert.doesNotMatch(flat, /show no tier/);
  has('ls ~/.keiron-sequencer/<project.slug>/*.json');
  says('Never show effort');
  for (const heading of ['The pick', 'The alternate']) {
    const item = section('Output').split('\n- **').find(b => b.startsWith(`${heading}**`)) ?? '';
    assert.doesNotMatch(item.replace(/\s+/g, ' ').replace('Never show effort', ''), /effort/i, `Output "${heading}" must not show effort`);
  }
});

test('the pick and the alternate state one size rule: size.label, else the Linear estimate (rough size), else "no size"', () => {
  const rule = 'its size (`size.label` when non-null, else the Linear `estimate` (rough size), else "no size")';
  for (const heading of ['The pick', 'The alternate']) {
    const item = section('Output').split('\n- **').find(b => b.startsWith(`${heading}**`)) ?? '';
    assert.ok(item.replace(/\s+/g, ' ').includes(rule), `Output "${heading}" must state the size rule`);
  }
  assert.equal(count('rough size'), count('the Linear `estimate` (rough size)'), '"rough size" only names the Linear estimate');
});

test('Step 0 prints at most one spike-record line, with no leftover candidate wording', () => {
  says('Print at most one of these lines for this project in this run, and continue');
  assert.doesNotMatch(flat, /however many candidates/);
});

test('record files for archived cards or cards off the map are ignored, neither counted nor invalid', () => {
  const step0 = section('Step 0: Read the Graph').replace(/\s+/g, ' ');
  assert.match(step0, /`CRM-\d+\.json`/, 'Step 0 must name a record file as the example');
  assert.ok(step0.includes('are ignored: neither counted nor invalid'), 'Step 0 must say ignored files are neither counted nor invalid');
});

test('"existing PR" in a size label comes from the spike record, not GitHub; reconciliation still decides', () => {
  says("comes from the spike record's origin (the trial copied a real PR), not from GitHub");
  says('PR reconciliation (patterns 1 and 1b) still decides whether the card is taken');
});

test("the per-card PR search runs in the card's own repo, with an org-wide gh search prs when the repo is unknown", () => {
  says("in the card's own repo (its title prefix, else the `Repo:` line in its description)");
  says("When a card's repo is unknown, cross-check across the org with `gh search prs`");
  assert.match(skill, /gh search prs --owner \S+/, 'SKILL.md is missing the org-wide gh search prs');
});

test('dependencies come from Linear blocks and every card-text phrase', () => {
  for (const field of ['edges[]', 'offMapBlockers', 'danglingBlocks', 'free[]', 'critical', 'criticalTies', 'downstream', 'cycles']) has(field);
  for (const phrase of ['Depende de', 'Gates:', 'espera a', 'bloquea', 'habilita', 'deployado en QA']) has(phrase);
  has('move it to Linear');
});

test("next-card's preserved rules are all present", () => {
  for (const anchor of [
    '[Prod]', 'Draft PR', 'Open non-draft PR', '[CRM-XXXX]', 'Linear attachments',
    'git ls-remote --heads origin', 'git-common-dir', 'commits ahead', 'dirty files',
    'list_milestones', 'targetDate', 'progress',
    'whoami', 'ask <name>', 'alternate', 'Amplify', 'bottom-up', 'bad base',
    'Self QA', 'Peer QA', 'Discovery', 'No lleva PR', 'map:design-delivery', 'QA sub-cards',
    'se puede diferir', 'carta elástica', 'Diferido', 'file-area', 'Parallel tracks',
    'gh pr list', '/keiron-sequencer:start CRM-XXXX',
  ]) has(anchor);
});

test('starting a card hands off to /keiron-sequencer:start, never to an older start command', () => {
  has('`/keiron-sequencer:start`');
  assert.ok(!skill.includes('/linear-card-start'), 'SKILL.md still names /linear-card-start');
  assert.ok(!skill.includes('/mi' + 'kado-start'), 'SKILL.md still names the old start command');
});

test('the skill never shows a key or an auth header', () => {
  assert.doesNotMatch(skill, /Bearer/i);
  assert.doesNotMatch(skill, /lin_api_/i);
  assert.doesNotMatch(skill, /LINEAR_API_KEY\s*=\s*\S/);
});

test('Board hygiene keeps open blocks from a map card to a card outside the project', () => {
  const anchor = 'a map card that blocks an open card outside the project';
  assert.ok(skill.split(anchor).length - 1 >= 2, `pattern 2 and Board hygiene must both carry ${JSON.stringify(anchor)}`);
});

test('an off-project blocker merged on GitHub counts as done; its stale Linear state goes to hygiene', () => {
  has('merged, still open in Linear');
  assert.doesNotMatch(skill, /until Linear agrees/);
});

test('a blocker merged to development counts as done; its pending [Prod] port goes to hygiene', () => {
  says('merged to `development` → done for unblocking');
  assert.ok(count('[Prod] port pending') >= 2, 'pattern 2 and Board hygiene must both carry "[Prod] port pending"');
});

test('two open-PR blockers on separate branches make the card wait and name the reviews to push', () => {
  says('two or more blockers are open PRs or branches where neither contains the other');
  says('the card waits');
  says('stack on the top branch');
  says('exactly one blocker is an open PR');
  assert.ok(count('Push these reviews') >= 2, 'pattern 2 and Output must both carry "Push these reviews"');
  assert.ok(section('Output').includes('**Push these reviews**'), 'Output must list a "Push these reviews" item');
});

test('the nearest deadline goes first: a card\'s due date or its milestone\'s target, whichever comes first', () => {
  says('sortOrder');
  says('milestoneOrder');
  says('card\'s deadline is its own due date or its milestone\'s target date, whichever comes first');
  says('a card due today in milestone 4 comes before milestone 3 when milestone 3 has no target date');
  assert.doesNotMatch(flat, /does not pull its milestone forward/);
});

test('a nearer milestone target date no longer moves a milestone ahead', () => {
  assert.ok(!flat.includes('nearest milestone `targetDate`'), 'SKILL.md still ranks by the nearest milestone targetDate');
});

const ranking = (skill.split('**6. Ranking**')[1] ?? '').split('**7.')[0];

test('the ranking pattern lists the order keys of the order lib, one numbered item each, in order', () => {
  const items = ranking.split(/\n(?=\d+\. )/).slice(1).map(i => i.replace(/\s+/g, ' ').toLowerCase());
  assert.equal(items.length, ORDER_KEYS.length);
  ORDER_KEYS.forEach((label, i) => assert.ok(items[i].startsWith(`${i + 1}. `) && items[i].includes(label), `Ranking key ${i + 1} is not ${JSON.stringify(label)}`));
});

test('the ranking pattern takes the best rank among the survivors and names the facts that detect a tie', () => {
  const text = ranking.replace(/\s+/g, ' ');
  for (const anchor of [`within ${SOON_DAYS} days`, '`rank`', '`deadline`', '`due`', '`scripts/lib/next-order.mjs`'])
    assert.ok(text.includes(anchor), `Ranking is missing ${JSON.stringify(anchor)}`);
});

test('the output names the rule that chose the milestone, flags overdue cards elsewhere and states today', () => {
  const output = section('Output').replace(/\s+/g, ' ');
  for (const rule of ['deadline <date> (<card or milestone>)', 'milestone order (<name> is the first with writable work)',
    'no milestone (no milestone has writable work)', '**Overdue elsewhere**', 'the date used as today'])
    assert.ok(output.includes(rule), `Output is missing ${JSON.stringify(rule)}`);
});

test('the commands note says the graph JSON carries the dates; only the assignee needs MCP', () => {
  says('carries `milestoneTargetDate`, `dueDate`, `due`, `deadline` and `rank`');
  assert.ok(!flat.includes('carries neither'), 'the commands note still says the JSON has no dates');
});

test('PRs are looked up per card id, not from the latest 40', () => {
  has('--search');
  assert.doesNotMatch(skill, /--limit 40/);
});

test('«Necesita» is a text-dependency keyword', () => {
  has('Necesita CRM-B');
  has('necesita CRM-B');
});

test('"its own QA card" is documented as a guess from the title', () => {
  says("a guess from the QA card's title");
});

test('the CLI takes the project URL, slug, UUID or identifier directly', () => {
  says('URL, slug, UUID or identifier');
  assert.doesNotMatch(skill, /<project-url>/);
});

test('with no free frontend card, a different backend file zone is a different area', () => {
  says('no frontend card is free');
  says('a different backend file zone');
});

test('next-card rules these fixes touch stay intact', () => {
  says('merged-to-development ≠ Done');
  says('neither is "get PR #N reviewed"');
  says('Review latency is not a reason to start it again');
  says('compare every `targetDate` against today');
  says('stacked on that PR\'s head branch');
  says('(frontend vs backend, or different file zone)');
});

test("a card's repo comes from its title prefix, else the description's Repo: line", () => {
  says('when the title has none, the `Repo: <repo>` line in its description');
  assert.match(skill, /`[\w-]+: …`/, 'SKILL.md is missing a title-prefix example');
});

test('text dependencies written as Linear issue tags are read by their label', () => {
  has('<issue id="…" label="CRM-B" …/>');
  says("read the tag's `label` as the card id");
});

test('list_issues asks for description and labels; every open card with a truncated description gets get_issue', () => {
  has('fields: id,title,description,labels,');
  says('fetch the full description with `get_issue` for every open card whose description came back truncated');
  says('candidates and their potential blockers alike');
  says('skip only done, canceled or archived cards');
  assert.doesNotMatch(flat, /can change the pick/);
  says("Read the blockers' cards too, since `bloquea` / `habilita` / `Gates:` live on the blocker");
});

test('Step 0 gives the CLI a long Bash timeout and treats a killed call like exit 1', () => {
  says('Bash timeout of at least 3 minutes');
  has('timeout: 180000');
  says('killed by the caller, treat it like Exit 1');
});

test('PR search hits count only when the title carries the card id in any bracket style', () => {
  has('[CRM-XXXX]');
  has('(CRM-XXXX)');
  says('drop hits matched only by PR number');
  assert.match(skill, /select\(\.title \| test\(/);
});

test('the PR search filter reads the card id from the environment, so the query stays one single-quoted string in a loop', () => {
  has('export CARD=CRM-XXXX');
  has('--search "$CARD"');
  assert.equal(count('+ env.CARD +'), 2, 'both PR searches build the title pattern from env.CARD');
  assert.doesNotMatch(skill, /test\("\[\\\\\[\(\]CRM-XXXX/, 'no filter hard-codes the card id');
});

test('hygiene tells a stale dangling block by its reason, not by open alone', () => {
  says('`open` alone does not mark a stale block');
  for (const reason of ['`archived`', '`canceled`', '`qa`', '`planner`', '`outside-project`']) has(reason);
});

test('a blocker with its [Prod] port pending gets only the port line in hygiene', () => {
  says('gets only the port line, not also "still open in Linear"');
  has('merged, still open in Linear');
});

test('crossing forward counts locally-started and draft-taken cards as not writable', () => {
  says('started locally (pattern 1b), taken by a draft PR (pattern 1)');
});

test('the alternate is the next-ranked card in a different area: different repo first, else file zone', () => {
  says('the next-ranked card (pattern 6 order) in a different area');
  says('prefer a different repo, else a different file zone');
  says('whether that is a different repo or only a different file zone');
});

test('the Graph line shows both the Linear free count and the reconciled count', () => {
  says('free in Linear');
  says('startable after reconciliation');
});

test('the local-work loop labels hits with the repo from the common git dir, not the folder', () => {
  has('r=${c%/.git}');
  assert.doesNotMatch(skill, /sed "s\|\^\|\$d /);
});

test('the pick and the alternate tag the size with `<tier> · <verdict>` from size.tier and size.verdict, unknown shown literally', () => {
  for (const heading of ['The pick', 'The alternate']) {
    const item = section('Output').split('\n- **').find(b => b.startsWith(`${heading}**`)) ?? '';
    assert.ok(item.includes('verdict tag'), `Output "${heading}" must show the verdict tag`);
  }
  has('`<tier> · <verdict>`');
  has('`size.tier`');
  has('`size.verdict`');
  has('`XL · SDD`');
  has('`L · unknown`');
  says('`unknown` is shown literally, never replaced by `No SDD`');
  says('No tag in DEGRADED mode or for existing-pr cards');
  says('Never show effort or `timeBox`');
  says('In DEGRADED mode no `size.label` is shown (the tier only appears inside the label), and no verdict tag');
  assert.doesNotMatch(flat.replace('Never show effort or `timeBox`', ''), /timeBox/);
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
  const commands = [...(await spikeUsage()).matchAll(/^usage: node scripts\/spike\.mjs ([a-z-]+)/gm)].map(m => m[1]).sort();
  assert.deepEqual(commands, ['abandon', 'begin', 'candidates', 'end', 'fixup', 'next', 'notes-template', 'pause', 'prune', 'rebuild', 'status', 'tree']);
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
  spikeSays('`claude plugin marketplace add <repo folder>`');
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

test('next: decision packs are drafted for the startable frontier only, answered in one sitting as outcomes', () => {
  for (const cmd of ['draft <project-ref>', 'status <project-ref>', 'answer <slug> <CARD> <question id> --outcome']) has('node ${CLAUDE_PLUGIN_ROOT}/scripts/packs.mjs ' + cmd);
  says('startable frontier');
  says('never for a descendant');
  says('stated as outcomes, not mechanisms');
  says('binding requirements');
});

test('spike: next and end run with the longest shell timeout or in the background, since a typecheck can take minutes', () => {
  spikeSays('Run `next` and `end` with the shell tool\'s longest timeout (600000 ms) or in the background');
});

test('spike: the auto typecheck checks the whole program and refuses only on errors in the changed files', () => {
  spikeSays('type-checks the whole program through the repo\'s own TypeScript config');
  spikeSays('only an error in a file the card changed refuses');
});

test('next: a backward-milestone warning and cards with no milestone are named, the latter to fix before a respike', () => {
  says('`backward-milestone`');
  says('cards with no milestone');
  says('before a respike');
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
  for (const planted of ['export CLAUDE_PLUGIN_ROOT=/x', '${CLAUDE_PLUGIN_ROOT:-/x}', 'node $CLAUDE_PLUGIN_ROOT/scripts/graph.mjs']) assert.match(planted, ROOT_MISUSE);
  assert.doesNotMatch('node ${CLAUDE_PLUGIN_ROOT}/scripts/graph.mjs', ROOT_MISUSE);
  assert.doesNotMatch('cd ~/Desktop/work/<repo>', REPO_PATH);
  for (const [folder, text] of Object.entries(skills)) {
    assert.doesNotMatch(text, REPO_PATH, folder);
    assert.doesNotMatch(text, ROOT_MISUSE, folder);
  }
  assert.match(skills.next, /`checkout` in `~\/\.keiron-sequencer\/config\.json`/, 'the next skill finds the user checkouts in the config');
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

test('a blocker with a draft PR or only a branch is stackable, as in start, and its costs are named', () => {
  assert.doesNotMatch(flat, /draft PR only, or no PR at all → blocked/);
  says('open PR, ready or draft → the card is startable stacked on that PR\'s head branch');
  says('no PR and exactly one branch carrying the blocker\'s id, pushed or only in the checkout → startable stacked on that branch');
  says('no PR and no branch → blocked');
  says('marked ready and merge before this one');
  says('push it before pushing this branch');
  says('`--blocker-branch`');
});

test('local clones are found from the checkouts in the sequencer config, never a fixed folder', () => {
  assert.doesNotMatch(skill, /~\/Desktop\//);
  says('the parent folder of every `checkout` in `~/.keiron-sequencer/config.json`');
  has('KEIRON_SEQUENCER_HOME');
});
