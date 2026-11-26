---
name: start
description: >
  Start one Linear card in the current checkout: read the card, its comments,
  its spike record and its blockers, decide the base branch against GitHub,
  detect a card that is already started, show the plan, then fetch, create or
  resume the branch and run the typecheck baseline without asking when the
  plan is ready (stopping only on a real choice or risk), and hand off to the
  right workflow. The In Progress move is offered,
  off by default.
  Trigger: "sequencer start", "start the card", "start <CARD>", "empezar la tarjeta", or after /keiron-sequencer:next picks a card.
license: Apache-2.0
metadata:
  author: keiron-sequencer
---

# keiron-sequencer start

The CLI is `node ${CLAUDE_PLUGIN_ROOT}/scripts/start.mjs`. `plan` is read-only and
prints one JSON plan; `fetch`, `branch`, `baseline` and `move` each do one
action, bound to the plan by its hash. `fetch`, `branch` and `baseline` run
without asking on a plan that is ready with no asks; `move` runs only on the
user's explicit yes. The main session does the
work inline. Every git and gh call runs through the CLI, in the current
checkout only.

## Safety rules

- No commits, pushes or PRs, in this checkout or any other, and planning
  artifacts stay untracked.
- Current checkout only: no worktree creation, and never switch, reset or
  touch another checkout. A branch checked out in another worktree means
  "work there".
- Run `fetch`, `branch` and `baseline` without asking when the plan is ready with no asks, and only with a hash the CLI printed:
  the `approve` hash of the plan that was shown, or the `nextApprove` that
  `fetch` or `branch` printed after it. The hash binds the actions to the plan that was shown and catches a plan that moved; it is not the user's yes.
  Never invent, shorten or reuse a hash from another plan. Stop and ask only
  where Step 6 says.
- Never move a card in Linear unless the user explicitly opts in, and
  never run `move` without `--confirm <CARD>`.
- Never read, print or cat the Linear key. The CLI finds it, uses it and
  redacts it from every output. If it finds none (Exit 3), tell the user;
  never ask them to paste a key into the chat.
- The default branch comes from the repo's config, never from origin/HEAD.
- Spike patches are reference only: chained diffs, never applied to the tree.
- Every bash fence below runs only `node ${CLAUDE_PLUGIN_ROOT}/scripts/start.mjs …`,
  except Step 9's two `packs.mjs` lines, which draft and answer this card's
  own decision pack.
- Run each `start.mjs` and `packs.mjs` command as shown, one per Bash call: no
  shell variable for the path, no `&&` chains, so each step's exit code and
  output stand alone.

Install: the user installs it as a plugin; do not run these yourself:
`claude plugin marketplace add <owner>/keiron-sequencer`, then
`claude plugin install keiron-sequencer@keiron-sequencer`.

## Step 1: Preflight

`~/.keiron-sequencer/config.json` must hold, for the current repo, `branchNaming`
(`verbatim` or `strip-card-id`), a non-null `defaultBranch`, `github` and
`remote`. `typecheck` (a list of argv arrays), `typecheckTimeoutMs` and
`notes` are optional. `docs/spike-config.example.json` shows the shape. On
Exit 2 the message names the missing key as `repos.<dir>.<key>`, or the config
file: show it and stop; the user edits the config.

## Step 2: Plan

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/start.mjs plan <CARD> [--blocker <CARD>]... [--blocker-pr <CARD>=<PR url>]... [--blocker-branch <CARD>=<branch>]... [--skip-blocker <CARD>]...
```

The bare form `node ${CLAUDE_PLUGIN_ROOT}/scripts/start.mjs <CARD>` is the same
plan. The plan never fetches: `fetch.lastFetch` is `unknown`, and the base,
containment and staleness read the remote-tracking refs the checkout already
has. That is why the flow does a fetch before branching.

Repeat the same blocker flags on `plan`, `fetch`, `branch` and `baseline` within one start.
Different flags give a different plan, and its hash no longer matches
(Exit 5).

## Step 3: Recall

Run `mem_search` for the card id and for the card title's topic, then
`mem_get_observation` on every `brief.record.engramRefs` entry and on every
hit. This is context only: it never overrides the card or the plan.

## Step 4: Show the plan

Show, in this order:

- The card: key, title, state, project, milestone. Read `card.description`
  and `card.comments` (oldest first). The comments supersede the description, and so does any dated
  scope-adjustment block such as "Ajustes de alcance". If
  `card.commentsTruncated` is true, say that 50 comments were read and later
  scope changes may be missing.
- The checkout: path, branch (or detached), the dirty count before any
  approval, and whether the local default branch exists. Show
  `checkout.notes` verbatim.
- The `action`. Show every entry of `reasons` with its message, including the non-blocking `gh-unavailable` and `dirty-checkout`:
  - `not-execution-card`, `card-closed`, `repo-unconfigured`, `wrong-repo`:
    the card cannot start here. `wrong-repo` names the expected repo, and
    its `checkouts` give each one's configured checkout: Step 5 offers to
    carry the start there.
  - `no-branch-name`: Linear gives the card no branch name.
  - `unstarted-blocker`: a blocker has not started; name it and the
    inversion (this card depends on work nobody began).
  - `wait-blocker`, `push-reviews`: the base is not ready yet.
  - `unverified-blocker`: Linear says a blocker started or finished, but
    GitHub shows no PR or branch for it, or several branches carry its id
    and none has a PR (the blocker `warning` lists them).
  - `pr-merged`, `pr-closed`: a PR of this card already exists, merged or
    closed.
  - `gh-unavailable` (`blocking: false`): some GitHub reads failed. The plan
    still completes, but a blocker it could not read stays unverified and the
    base becomes an ask, never the default branch.
  - `dirty-checkout` (`blocking: false`): uncommitted or untracked files.
  - `no-project` (`blocking: false`): the card has no Linear project, so the
    plan runs in no-project mode. It reads no project map, spike record or
    decision pack and computes no staleness, and `card.project` is null. What
    applies to any card still runs: the base from the repo's default branch,
    the branch name from Linear, the resume of a started branch, the
    typecheck baseline, and the route from the card text. With no map, only
    the `--blocker` flags give the card blockers (the plan warns so): if the
    card text or its Linear relations name one, plan again with
    `--blocker <CARD>`. `wrong-repo` still stops it, and Step 5 offers to carry
    the start to that repo's checkout.
- The blockers: each with its Linear state, its PRs, its `status`, and
  every blocker `warning` (for example a blocker merged on GitHub whose card
  is still open in Linear). List `skippedBlockers`.
- The `gates`, as "before merge or deploy": each `card` gate (a blocker the
  card only ships after, written "Sale después de <CARD>" in its text: it is
  no blocker and gives no base, so the card starts from the default branch)
  with its Linear state, and each `decision` gate (an open decision of the
  record tagged `gate`). They are in `brief.gates` too: carry them to the
  workflow as conditions to clear before merging or deploying, never before
  building. `--blocker <CARD>` makes such a card a code blocker again.
- The base: `base.kind`, `base.ref`, the PR it stacks on, `base.note`, the
  stack costs, and `base.pushReviews` as "Push these reviews". A stack base
  can be a draft PR (its blocker `warning` says so), or a blocker branch with
  no PR (`base.pr` null), pushed or only in this checkout (`base.ref`
  `refs/heads/<branch>`); the stack costs name what each one leaves to do.
- The branch: `branch.name`, `branch.source` (`linear` or `derived`) and
  `branch.rule`.
- The resume: `resume.branches` with where each one is (`local`, `remote`,
  `worktree` with its path), the PRs, `resume.elsewhere`, and
  `resume.remote` when GitHub could not be read.
- The `siblings`: the cards this one unblocks and the milestone's open and
  done counts.
- The `verdict` and the `route`, said out loud with `route.reasons`, the
  facts the route was read from: `repos>1`, `design-decisions:<n>`,
  `people-decisions:<n>`, `pack-answered:<n>` (shown when above 0),
  `new-paths:<n>`, `files:<n>`, `fixups-received:<n>`, `tier:<T>` and
  `unblocks:<n>`. The verdict
  "unknown" (an old record), "no record" and "no project" are named as
  such, never shown as No SDD. With "no record" or "no project"
  `route.route` is null: decide from the card text with the same rule
  (Step 11), and say that is what you did.
- The staleness: by group (`self`, `sibling`, `unrelated`, each with its
  `more` count), the base commit status, the reason when it was not computed,
  and `staleness.unchecked` (other repos of the card, not checked here).
  `staleness.hunks` says how it was read: `level` `hunk` counts only commits
  on files where the default branch changed lines near the card's own hunks
  (`overlap`, with the ranges); `level` `file` with its `fallback`
  (`no-base`: a trial record or a base not in this clone; `chained`: an
  earlier card of the run or a received fixup touched the file; `no-patch`:
  the card's own patch could not be read for that file; `combine`)
  counts every commit on the files. `staleness.touched` lists the commits on
  the same files outside the card's hunks: show them, they are not stale.
- The brief highlights: scope note, decisions, open decisions, risk areas,
  findings, cases, fixups, `brief.otherRepos`, and `brief.recordNote`.
- The decision pack, `brief.pack` (null when none was drafted): its answered
  questions with their outcomes, the questions still open, and `stale` with
  its reason when the card text, the record or the base moved since it was
  drafted. Say a stale pack is stale: Step 9 drafts it again after the
  fetch, and asks its open questions before routing. A redraft keeps each
  answer whose question is asked in the same words; an answer the spike
  already recorded as a decision (ref `pack:<CARD>#<id>`) is no longer asked,
  and one the user reopened at the spike is asked again, without its answer.
- The patches, with `brief.patchesNote`: they are reference only, chained on
  the earlier cards of the spike, and never applied to the tree.
- The typecheck commands, and every entry of `warnings`.

## Step 5: Act on the action

- `wait` or `stop`: create nothing. Give the reasons, and list "Push these
  reviews" when `base.pushReviews` has entries. When `base.note` ends with
  "fetch to decide", the blocker heads are not fetched yet: run `fetch` with the plan's `approve` hash
  (Step 7), then plan again and show the new plan.
- `stop` for `wrong-repo`: nothing runs here. Offer to carry the start to
  the repo the reason names, at its `checkouts[].checkout` (with several,
  ask which repo first). A `checkout` of null means the config names none:
  ask the user for the folder. How depends on where this session runs:
  - Claude desktop app (the session tools `start_session` and
    `change_directory` exist): ask once, two options, and never pick for
    the user. Recommend a new session when this session has work of its own
    (uncommitted changes, an open PR, another task); recommend moving this
    session when the start is all it was opened for.
    - New session: `start_session` with `cwd` the checkout (or the user's
      saved preset for that folder), the prompt
      `/keiron-sequencer:start <CARD>` with the same blocker flags, and a
      background that names the `wrong-repo` stop. The app nests it under
      this session, in this repo's sidebar group; right after it starts,
      `detach_session` it so it lands in its own repo's group. Say that a
      detached session no longer reports back here.
    - This session: `change_directory` to the checkout. The move applies
      when the turn ends, so end the turn saying so, and plan again from
      the new checkout on the next turn.
  - Claude Code CLI (no session tools): tell the user to run
    `/keiron-sequencer:start <CARD>` from a session opened in that checkout,
    and give its path. Never `cd` there from this session.
- `ask` for an unverified blocker: ask the user, then plan again with one of:
  - `--blocker-pr <CARD>=<PR url>`, when the user gives the blocker's PR;
  - `--blocker-branch <CARD>=<branch>`, when the user gives the blocker's
    branch, or picks one of the branches the warning lists. The branch,
    pushed or only in this checkout, PR or not, becomes the stack base;
  - `--skip-blocker <CARD>`, when the user confirms the blocker carries no
    code this card needs.

  When the ask comes with `gh-unavailable`, GitHub may simply be down: plan
  again later with the same flags.
- `ask` for `pr-merged` or `pr-closed`: ask. Only on an explicit "create
  anyway" does Step 7 pass `--accept pr-merged` or `--accept pr-closed`. That
  works only when it is the only ask reason and the base is `default` or
  `stack`.
- `resume`: the card is already started. With one candidate in
  `resume.branches`, one candidate is resumed without asking
  (`--resume <branch>`); with more than one candidate branch, ask which. A
  started branch is never renamed (renaming a pushed branch closes its PR). A
  branch `where: 'worktree'` means "work there": nothing runs here.
- `create`: go to Step 6.
- If the card text names a dependency the Linear map lacks (a `textBlockers`
  entry of /keiron-sequencer:next, or a phrase such as "Depende de ABC-12"),
  plan again with `--blocker <CARD>`.

## Step 6: Go on, or stop on a real choice

When the plan is ready with no asks, go on: run Steps 7 and 8 with the plan's
own `approve` hash and the `nextApprove` chain, without asking. Creating
`<branch.name>` from `<base.ref>` in this current checkout (or resuming its
one candidate) is not a question.

Stop and ask only when there is a real choice or a risk:

- any plan `ask` (an unverified blocker, `pr-merged` or `pr-closed`,
  `bases-unknown` and the like), as in Step 5;
- a `resume` with more than one candidate branch: ask which;
- a dirty checkout: `git checkout -b` carries the uncommitted changes onto the new branch.
  Say so with the dirty count, and ask before Step 7;
- a branch checked out in another worktree: that means "work there", and
  nothing runs here;
- a `strip-card-id` repo (`branch.editable: true`), only when the user has
  said they want a custom name; otherwise use `branch.name`. A custom name
  that carries the card id is accepted and a later `/keiron-sequencer:start` resumes it.
  Only for a custom name that does not carry the card id, warn before
  running `branch --name`: a later `/keiron-sequencer:start` will not detect that
  branch as a resume, because it neither equals `branch.name` nor carries the
  card id.

Then two questions, asked once, after the branch and the baseline exist and
Step 9 has saved the pack's answers, in one message:

- (a) Accept or override the route (Step 11).
- (b) Move <CARD> to In Progress in Linear? Default: no. The PR automation
  moves the card when its PR opens.

Anything other than an explicit yes to (b) (no answer, "later", a doubt) is a
no. Ask (b) on a resume too.

## Step 7: Fetch, then branch

When the plan is ready with no asks, or once the user has answered the
question Step 6 stopped on, with `<hash>` the `approve` of the plan that was
shown:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/start.mjs fetch <CARD> --approve <hash> [blocker flags]
```

If its `nextApprove` equals `<hash>`, run one of these with the same hash:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/start.mjs branch <CARD> --approve <hash> [blocker flags]
node ${CLAUDE_PLUGIN_ROOT}/scripts/start.mjs branch <CARD> --approve <hash> --name <branch> [blocker flags]
node ${CLAUDE_PLUGIN_ROOT}/scripts/start.mjs branch <CARD> --approve <hash> --accept <reason> [blocker flags]
node ${CLAUDE_PLUGIN_ROOT}/scripts/start.mjs branch <CARD> --approve <hash> --resume <branch> [blocker flags]
```

If `nextApprove` differs, or `branch` exits 5, the fetch changed the plan:
plan again and show the new plan, and go on as Step 6 says (without asking
when it is ready with no asks). `--resume` takes no `--name` and
no `--accept` (Exit 2), and a resume plan needs `--resume` (Exit 5). `--name`
works only for a `strip-card-id` repo, and only with a name git accepts as a
branch name; a name that carries the card id is accepted. A dirty checkout
does not refuse; if git refuses the checkout (Exit 1), nothing changed.

What the CLI runs, in this checkout, where origin is the configured remote:

```text
git fetch --quiet origin                            fetch
git checkout -b <branch> origin/<base>              branch, a new branch
git checkout <branch>                               branch --resume, a local branch
git checkout -b <branch> --track origin/<branch>    branch --resume, a remote-only branch
```

`branch` prints `action` (`created`, `resumed` or `already-on`), the branch,
the head and `nextApprove`.

## Step 8: Typecheck baseline

Right after `branch`, with the `nextApprove` it printed and no second
question:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/start.mjs baseline <CARD> --approve <nextApprove> [blocker flags]
```

It runs the repo's typecheck commands one at a time and appends their output
to a log outside the repo. Write down the error count from `tail` or the log
as the typecheck baseline. Errors are not a failure: do not fix them and do
not block on them. `configured: false` means the repo has no typecheck
baseline. There is no test baseline. On Exit 5, plan again and show the new
plan, and go on as Step 6 says.

## Step 9: Decision pack

Skip this step in no-project mode (`card.project` null) and when
`brief.record` is null: there is no pack to draft. Otherwise draft the card's
own pack after the baseline, or after `branch --resume` on a resume, on every
start:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/packs.mjs draft <card.project.slug> --card <CARD>
```

It runs after Step 7's fetch on purpose: the pack is stamped with the
default tip, and a pack drafted before the fetch moved the default tip goes
stale at once. A fresh pack is kept (`fresh`); a stale one, or none, is
drafted (`drafted`), keeping an answer only for a question asked in the same
words. `skipped` (no record, or no people-owned open decision) and a pack
with no open question ask nothing. Exit 3 is no key: tell the user. On any
other failure, say so and go on without the pack: the route counts the
decisions as open.

`pack.questions` lists every question with its `evidence` (what the spike
already ruled out) and its `answer` (null while open). Ask every open
question in one message, with its evidence and the options still standing,
which you add from the brief and the code. Never answer a question for the
user. Save each answer the user gives, stated as outcomes, not mechanisms
("no patient data reaches an internal user without a grant", not "return
403"):

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/packs.mjs answer <card.project.slug> <CARD> <question id> --outcome "<the outcome>"
```

Saved answers survive across sessions: a later start of the same card reads
them from the pack and asks only what is still open. A question the user
leaves open stays open; save nothing for it. Then plan again with the same
blocker flags (`start.mjs plan`, read only): its route counts the answered
decisions as settled (`pack-answered:<n>`), and its approve hash does not
move with the pack. Say the new route in Step 11.

## Step 10: Move, only on an explicit yes

Only on an explicit yes to (b):

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/start.mjs move <CARD> --confirm <CARD>
```

- Exit 0 with `action: 'moved'`: report the old and new state. With
  `action: 'already-started'`: nothing was written.
- Exit 5: refused, nothing written (no single "In Progress" state in the
  card's team, a completed or canceled card, or a `--confirm` that does not
  repeat the card).

## Step 11: Route

The route is a recommendation, said out loud with its reasons before any
hand-off:

- Full SDD for new contracts others build on, permission or exposure
  changes, cross-app or cross-repo work, or open people-owned design
  decisions.
- Light (superpowers:writing-plans, then superpowers:test-driven-development)
  for a contained change that follows an existing pattern.
- TDD (superpowers:test-driven-development) for a fix, 1 or 2 files, or a
  deletion with proof of no usage.

`route.route` applies that rule to the record: `sdd` for `repos>1`, a
people-owned design decision or an XL tier; `light` for an L tier, new paths
or two fixups received; `tdd` otherwise. A people-owned decision answered in
a fresh decision pack no longer counts as open: `people-decisions:<n>` counts
only the unanswered ones, and `pack-answered:<n>` says how many the pack
settled, so say that when the route drops because of it. Answers match
decisions by their text; a stale pack answers nothing. When `route.said` is "unknown" (an
old record), the route is `sdd` and you say why. When it is "no project", decide from the card text with the same rule. When it is "no record",
decide from the card text with the same rule. If the user picks another
workflow, follow it without arguing or blocking.

- `sdd`: hand off to the spec-driven-dev orchestrator with
  `/sdd-new <route.changeName>`, the brief as the intake for its discovery.
  The start runs no SDD phase itself, and the record never replaces sdd-explore.
- `light`: superpowers:writing-plans, then superpowers:test-driven-development.
- `tdd`: superpowers:test-driven-development.

With a pack, say these four rules in the hand-off, whatever the route:

- Answers to people-owned decisions are binding requirements, stated as
  outcomes: SDD discovery imports them as requirements and sdd-verify checks
  them. Reopening one needs evidence and the user's OK.
- Code-settled decisions are hypotheses: discovery re-derives them from the
  code without reading the pack first, then compares, and every disagreement
  goes to the user.
- The pack feeds SDD discovery and never replaces it: discovery still checks
  the pack against the current code and asks the questions that only appear
  at full depth, skipping the ones the pack already answered.
- Spike code is reference only.

## Exit codes

- **Exit 0**: JSON on stdout; read `action`. A plan that waits, stops or asks
  is exit 0, and so is a move of a card already started.
- **Exit 1**: a Linear failure, a git failure (a failed remote read names the
  remote), a gh that cannot be run at all, or git refused the checkout. A gh
  command that fails is not exit 1: the plan completes with `gh-unavailable`.
  Report it; do not retry blindly.
- **Exit 2**: usage, a config error naming the key, `fetch`, `branch` or
  `baseline` without `--approve`, or `move` without `--confirm`.
- **Exit 3**: no Linear key found. Tell the user.
- **Exit 5**: refused, nothing ran: a hash that does not match the
  recomputed plan, an action `branch` cannot take, an invalid `--name`, an
  `--accept` the plan does not allow, a resume branch in another worktree, or
  a move refusal. Plan again, show the new plan, and go on as Step 6 says.
