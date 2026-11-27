---
name: respike
description: >
  Make a new spike pass over a Linear project that was spiked before: pick the
  cards to re-spike, drop the cards already built (merged, open PRs and drafts,
  local branches the user accepts), check each built card's record against
  its PR before the run, base every repo on what is actually built,
  replay the old patches of unbuilt ancestors at no token cost, re-spike the
  rest with the /keiron-sequencer:spike card loop, audit the built and unbuilt
  cards it did not re-spike against their PR diffs and the fresh records, and
  compare the new records with the old ones in a saved report. Nothing begins
  before the user approves the plan's hash.
  Trigger: "sequencer respike", "respike the project", "re-spike", "refresh the spike", "volver a spikear".
license: Apache-2.0
metadata:
  author: keiron-sequencer
---

# keiron-sequencer respike

The CLI is `node ${CLAUDE_PLUGIN_ROOT}/scripts/respike.mjs`. `preflight` is
read-only and prints one JSON plan with an `approve` hash; `fetch` and `begin`
run only with the hash of the plan the user approved; `config` drafts the
missing config entries and writes the spike config only with the hash of the
draft the user approved; `report` is offline; `audit --before` gathers the
PR check (the plan's reads and the PR diffs) before the run, `audit` gathers
the check against the fresh records (one Linear read) after it, and each
stores your verdicts in the records with `--verdicts`, offline. The walk itself is the spike's
card loop, `node ${CLAUDE_PLUGIN_ROOT}/scripts/spike.mjs`, with the rules of
/keiron-sequencer:spike, worked track by track (Step 6). With one worker the
main session does the card work itself; with more, it coordinates one worker
subagent per track. Never a subagent per card, no headless runs.

## Safety rules

- **Never commit, push or open a PR**, in a spike tree or in any repo. Each
  tree is a detached checkout with a push guard; never work around it. The
  user's branches are never moved, checked out or reset, except a local branch
  with no own commits that `fast-forward` moves to the default tip on the
  user's yes and the plan hash (Step 3); nothing is pushed.
- Patches and run state stay in `~/.keiron-sequencer`, outside every repo. So do the
  records and the report, in `~/.keiron-sequencer/<slug>/`: they stay personal: never
  committed or shared. Linear is the only shared surface. They hold no code.
- Linear only through the CLI. Never read, print, cat or copy the Linear key:
  the CLI finds it, uses it for read-only queries and redacts it from every
  output. If it finds none (Exit 3), tell the user; never ask them to paste a
  key into the chat.
- Missing config blocks the run. The skill never edits the file; the CLI
  writes it only with the approved hash, after a backup (`config.json.bak`,
  one copy, replaced on each write). Drafts live in the session's scratch
  directory, never in `~/.keiron-sequencer` or a repo.
- The CLI never installs a tool. When a draft says a repo needs a tool,
  propose in prose the install route that fits this machine. Run it only on
  a separate yes per tool. It is never part of the config write. Then draft
  again after an install, into a new file.
- Run `begin` only after the user approves, and only with the `approve` hash the CLI printed for the plan the user approved.
  Never invent, shorten or reuse a hash from another plan. `fetch` writes
  pull-request refs into the user's checkout, so it runs only on the user's
  yes, under the same rule. The one exception:
  `node ${CLAUDE_PLUGIN_ROOT}/scripts/spike.mjs begin <project ref>` with no hash only resumes an already-begun paused respike run and never creates a run
  (Step 7); its plan was approved when that run began.
- The old patches are reference only: the CLI replays them in the throwaway
  trees, and the skill never applies a patch itself. The one exception is a
  card's own `wip` patch, which its worker puts back in the card's tree.
- No production DB writes. No patient data in logs, not even masked.
- Run heavy commands (install, build, type-check, lint, tests) one at a time,
  with the target repo's own limits, and only through `check`:
  `node ${CLAUDE_PLUGIN_ROOT}/scripts/spike.mjs check --track <id> [--cwd <repoDir>] [--timeout-ms <n>] [--project <project ref>] -- <argv>...`
  runs the argv in the track's first open tree (`--cwd` picks a repo) once a
  check slot is free, and exits with the command's exit code, or 124 when the
  command ran past `--timeout-ms` (600000 by default) and was stopped. Workers share
  the machine: never run a heavy command directly.
- Every bash fence below runs only `node ${CLAUDE_PLUGIN_ROOT}/scripts/respike.mjs …`
  or `node ${CLAUDE_PLUGIN_ROOT}/scripts/spike.mjs …`.

Install: the user installs it as a plugin; do not run these yourself:
`claude plugin marketplace add <owner>/keiron-sequencer`, then
`claude plugin install keiron-sequencer@keiron-sequencer`.

## Preflight (before the first live run)

1. `~/.keiron-sequencer/config.json` validates, and every repo the run touches has its
   entry with a local `checkout` (never only a `url`), `github`, `remote`, a
   non-null `defaultBranch`, `setup` and `risk` (`[]` is allowed for both).
   `docs/spike-config.example.json` shows the shape. A gap shows up in Step 1
   as a block, and the config step (Step 1, Missing config) drafts what it
   can find for it.
2. Ask the user to add `~/.keiron-sequencer` as a Claude Code additional directory (for
   example `/add-dir ~/.keiron-sequencer`), as for /keiron-sequencer:spike; do not edit their
   settings yourself. Stop until the session can edit `~/.keiron-sequencer`.
3. A project first spiked by hand keeps its old patches in trial folders named
   before the config existed. When Step 1 blocks with `trial-dir-unmapped`,
   say so, and show the output of its dry run: the trial rename,
   `node ${CLAUDE_PLUGIN_ROOT}/scripts/maintenance/rename-trial-dirs.mjs`, without
   flags changes nothing and lists the folder renames and the record
   references it would rewrite. Run `--apply` or `--inverse` only on the user's explicit yes; otherwise stop.
   `--apply` renames and rewrites the records in `~/.keiron-sequencer/<slug>/`, then
   preflight again. `--inverse` (with `--apply`) undoes
   the rename, and it refuses once a respike has run.
4. Push guard on real checkouts: as in /keiron-sequencer:spike, the CLI sets
   `extensions.worktreeConfig` where it is absent. Report every checkout listed
   in `touchedCheckouts`.

## Step 1: Plan

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/respike.mjs preflight <project ref> [--cards <CARD>[,<CARD>]...] [--stale] [--all] [--built <CARD>=<branch>]... [--unbuilt <CARD>]... [--with-default <repoDir>]... [--hand <CARD>:<item>=<CARD>]... [--drop <CARD>:<item>]... [--skip-check <CARD>]...
```

The ref is the project URL, slug, UUID or identifier. With no flags the
selection is the stale cards: the cards with no live record, or with
default-branch commits since their spike in the hunks the card changed (± 3
lines), read from each repo's remote-tracking default branch, which the plan
fetches first; every other card's old patch is replayed. A commit elsewhere in the same file does
not make a card stale: the card is listed in `selection.touched` with the
commit count and files, and not selected. The check falls back to the whole
file when the record's run has no base commit (trial records), when an
earlier card of the same run or a fixup the card received touched that file,
when the card's own patch cannot be read, or when the base was a combine. `--cards` picks cards; with `--stale` as
well they select the union. `--all` selects every open execution card, as a
first spike does: offer it only when the user asks to re-spike everything. `--built` and
`--unbuilt` answer the asks (Step 3). Repeat the same flags on every later
`preflight`, `config`, `fetch`, `fast-forward` and `begin` of this respike: different flags give a
different plan and hash.

Preflight reads Linear, `gh pr list` and git in the configured checkouts. Its
one write is `git fetch <remote> <defaultBranch>` in each configured checkout,
which moves only that remote-tracking ref, never a local branch; `config`,
`fetch`, `fast-forward` and `begin` fetch the same way. `fetched` reports each
repo's ref `from` and `to` and how many commits it `moved`. A fetch that fails
(offline, auth) is a `fetch-failed` warning naming the repo, and the plan reads
the ref as it was: say so. The fetch is no part of the hash: when `begin`
fetches again and a moved ref changes the plan, it refuses with Exit 5 like
any plan that moved.

- **Exit 2** with `action: 'blocked'`: Show every entry of `missingConfig`, each with the cards that need it and its hint
  from stderr: `repo-missing`, `repo-not-local` (the repo needs a `checkout`
  in place of its `url`), `github-missing`, `default-branch-missing`,
  `remote-missing`, `setup-missing`, `risk-missing`, `not-in-project`, and
  `trial-dir-unmapped` (Preflight, item 3). Then the config step below.
  Exit 2 without a plan and with `cannot read the spike config` or
  `invalid spike config` goes to the config step too: with no config.json
  the draft is a whole file (bootstrap); an invalid one is drafted on top
  (repair). Exit 2 naming a missing trial reference
  (`~/.keiron-sequencer/<slug>/trial-reference`): trial records replay in the
  order of its logs, so say so and show the dry run of
  `node ${CLAUDE_PLUGIN_ROOT}/scripts/maintenance/move-reference.mjs`; run it
  with `--apply` only on the user's explicit yes, then preflight again. Any
  other exit 2 without a plan is a usage error, such as a
  `--cards` key that is not an execution card on the map.
- **Exit 5**: the project has an active or paused run. Offer to resume it
  (Step 7) or, only when the user asks, to end it with
  `node ${CLAUDE_PLUGIN_ROOT}/scripts/spike.mjs abandon [--discard] [--project <project ref>]`.
  Stop.
- **Exit 3**: no Linear key. **Exit 1**: a Linear, gh or git failure; report
  it, do not retry blindly.

### Missing config: draft, review, write

The config step drafts the missing entries from the checkouts it finds, and
the CLI writes the spike config only with the hash of the draft the user
approved. It also changes an entry that exists but is wrong or incomplete
(a `setup` missing a step, a stale `defaultBranch`): the draft with
`--edit` holds the whole config.json even when nothing is missing, and the
change goes into that draft. Three forms, in this order: the draft, the
review and the write.

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/respike.mjs config <project ref> --out <draft.json> [--edit] [--root <dir>]... [--cards <CARD>[,<CARD>]...] [--stale] [--all] [--built <CARD>=<branch>]... [--unbuilt <CARD>]... [--with-default <repoDir>]... [--hand <CARD>:<item>=<CARD>]... [--drop <CARD>:<item>]... [--skip-check <CARD>]...
node ${CLAUDE_PLUGIN_ROOT}/scripts/respike.mjs config --draft <draft.json>
node ${CLAUDE_PLUGIN_ROOT}/scripts/respike.mjs config --draft <draft.json> --approve <hash>
```

The draft reads Linear and git and writes only its `--out` file; the review
and the write need no key and run no git. The skill never reads config.json
itself, and never edits it: a change to an existing entry is made in an
`--edit` draft, never by hand in config.json.

1. **Draft.** Run the draft with the same selection flags as the preflight,
   with `--out` a new file in the session's scratch directory, never in
   `~/.keiron-sequencer` or a repo. Every round drafts into a new file: an
   existing `--out` is refused, so edits made to a draft are never
   overwritten.
   - Add `--edit` when an existing entry needs a change: the user asked for
     one, or a `setup-failed`, a typecheck or a preflight shows a configured
     value is wrong or incomplete. The draft is then the whole config.json
     as it is, with any missing entries proposed on top, and the output
     carries `edit: true`. With no config.json there is nothing to edit:
     `nothing to draft`, and the plain draft bootstraps the file.
   - Exit 2 with `no checkout roots` (stderr, the gap lines, no JSON): ask
     the user once which folders hold their checkouts. Never suggest a
     default folder. Pass each as `--root <dir>` and draft again. The draft
     proposes storing them as `checkoutRoots`, and the write stores them;
     until then, repeat the same `--root <dir>` on every later draft of the
     session instead of asking again. A `--root <dir>` refused as relative
     or not a folder (exit 2) is shown, and the user corrects it.
   - Exit 2 ending `it is never replaced: fix or remove it by hand`:
     config.json is not JSON, or not a JSON object. Report it and stop: the
     user fixes it by hand. The skill never drafts from it and never
     replaces it.
   - `base.state` is `missing` when there is no config.json yet: the draft
     is a whole file (bootstrap), and the write creates it. `read`: the
     draft is the file as it is, with only the changes listed; valid parts
     stay as they are (repair).
2. **Report.** Show the report, the change list and the hash: every entry of
   `items` (its code, its cards and each line), then `fixes`, `stray`,
   `warnings`, `needs`, `roots` (`searched`, and `missing` for a stored root
   that is gone), `changes`, `diff`, `reformat` and `approve`. The line
   kinds:
   - `proposed`: the path and the value the draft sets.
   - `not-found`: "not found under <roots>", with the three options (step 3).
   - `unfilled`: the path left unset and why. Say plainly that preflight
     will block on it again.
   - `rename-trial-dirs`: rename the trial dirs first (Preflight, item 3).
   - `skipped`: a linked checkout named like the repo, never proposed; it is
     context, not an open item.
   - In `fixes`: `reset` (an invalid value set to null; the old value stays
     in the backup), `dropped` (an invalid risk rule removed) and `resolved`
     (a config error the drafted entries fix).
   - `stray`: an unknown key, kept as it is, with the known key it may be a
     typo of; if it is one, the user deletes it in the draft.
   - `reformat: true`: the write also reformats the file to 2-space JSON.
   - `approve: null` with `errors`: the draft does not validate or holds a
     URL with credentials, and no write is offered until an edit and a
     review give a hash.
   - `message: 'nothing to draft'` (`draft: null`, `approve: null`): no
     file was written. Show each item's lines, say what is still missing,
     and stop. When the fix is a change to an existing entry (an `unfilled`
     line that says to fix it by hand included), draft again with `--edit`
     into a new file instead of stopping.
3. **Not found.** For a line "not found under <roots>", offer the three
   options as written: clone it yourself, add a root with `--root <dir>`,
   or leave its cards out with `--cards`. A `--root <dir>` replaces the
   stored roots for that call, so to add a root, pass every folder of the
   last draft's `roots.searched` with `--root <dir>` too. Roots are stored
   only when none are, so a root added later is kept only if the user adds
   it to `checkoutRoots` in the draft. The skill and the CLI never clone,
   and never say a repo is not on this machine: it is only not found under
   the roots that were searched.
4. **Needs.** For each entry of `needs`, the install is the user's: propose
   in prose the install route that fits this machine, preferring a tool
   that is already installed, and run it only on a separate yes per tool. A
   yes to the config write is never a yes to an install, nor the reverse:
   an install is never part of the config write. Then draft again after an
   install, into a new file. When the user declines, `setup` stays unset
   and preflight blocks on `setup-missing` again.
5. **Edits.** Edits go into the draft file in the scratch directory, never
   into config.json: the user's, or the skill's on the user's words. Then
   run the review: it prints a new change list, diff and hash for the
   edited text. Show them. An `--edit` draft starts with no change of its
   own (`changes` empty unless an entry was missing): make the change in
   it, then review. Never offer the write for a draft whose `changes` is
   empty: it would only replace the backup with a copy of the same file.
6. **Write.** One question: "Write config.json with draft <hash>? (backup
   to `config.json.bak`)". On an explicit yes, run the write only with the
   `approve` hash the CLI printed for the draft text the user approved. It
   prints `path` and `backup`: report the config path and the backup path
   (`backup` is null for a first file, which has nothing to back up).
7. **Refused.** Exit 5 at the write: the draft or config.json changed since
   its hash was shown, and nothing was written. Run the review, show the
   new hash and ask again. Exit 2 at the write: the draft does not
   validate, holds a URL with credentials or sits in `~/.keiron-sequencer`
   or a repo, or config.json is not JSON; nothing was written.
8. **Loop.** Run preflight again with the same flags. Each round has its own
   draft file and its own hash. When preflight no longer blocks, go on with
   its plan (Step 2). When a round proposes no change (the draft says
   `nothing to draft`, or only not-found, unfilled or rename lines remain),
   or when the user stops, show what is still missing and stop.

## Step 2: Show the plan

Show, in this order:

- The `action` and the `approve` hash, and `fetched`: each repo whose default
  branch moved, with how many commits, and each fetch that failed.
- The selection: `selection.mode`, each card with its `why` (`all`, `picked`,
  `stale`, `new`), the `selection.unknown` cards (staleness not computable,
  with the reason; not selected, the user can add them with `--cards`), the
  `selection.touched` cards (same-file commits outside the card's hunks; not
  selected, the user can add them with `--cards`), and
  the `selection.dropped` cards, picked or selected but `built`: listed, never
  spiked.
- The built cards: kind `merged`, `pr` or `local`, the evidence, the repo, the
  PR or branch, the short sha, `needed`, and each warning. Open PRs and
  drafts count as built: a draft's head is real code, and /keiron-sequencer:start
  stacks on a draft too.
- The PR checks in `prChecks`: each built card with a record, its PR or
  branch and its `status` (`current`, `unchecked`, `stale` when the head
  moved since the check, `skipped`), then the `handoffs` (each item a PR
  does not build, handed to a card this run spikes), the `drops`, and the
  `moved` items (each item the check found another card owns, with that card
  and the note: no question, shown so the user sees where it went).
- Each repo's base in `bases`: `default`, `pr`, `local`, or `combine` with its
  heads (card and short sha), and "base N commits behind default" from
  `behind` when the base misses default-branch commits.
- The ancestors found above the selection, built cards included: each
  `replay` with its source (`from`, a run id or `trial`), its patches and its
  `dropped` fixups with their reason (`from-absent`, `fixed-absent`); each
  `spike` with its reason: `no-record` (no live record), `patch-missing` (an
  old patch is gone), `shared-patch` (an old patch names several cards;
  every card in `sharedWith` is re-spiked fresh too), or `ancestor-spiked`
  (a blocker above it, listed in `spikedAncestors`, is spiked in this run,
  so its old patch would land on code that spike changes).
- The `order`, each entry `replay` or `spike`. Ready replays run first; they
  cost no tokens and open no window.
- For each base behind default (`behind` above 0), its `ownCommits`: the
  commits it holds that the default branch does not (each head of a combine
  has its own). Offer to bring it up to date, as in Step 3.
- The `asks` (Step 3), the `stops`, and every entry of `warnings`:
  `merged-still-open`, `linear-done-no-pr`, `base-behind-default`,
  `risk-empty`, `repo-unknown` (a card naming no repo; its trees open as the
  card goes), `no-milestone` (open cards with no milestone, in `cards`:
  recommend the user assign them a milestone in Linear before `begin`, since
  milestones order the work and a reorder finding is checked against them),
  `data-in-repo` (the records are still in the plugin repo's
  `data/<slug>/` and none are in `~/.keiron-sequencer/<slug>/`, so every card reads as
  never spiked: show the dry run of
  `node ${CLAUDE_PLUGIN_ROOT}/scripts/maintenance/move-data.mjs <slug>`, run it
  with `--apply` only on the user's explicit yes, then preflight again).

## Step 3: Asks, one question per ask

On `action: 'ask'`: One question per ask, with its `message`, offering its
`answers`; then preflight again with every answer given so far.

- `local-branch`: "Treat <CARD> as built (branch <b> is the base) or
  unbuilt?" The answer is `--built <CARD>=<branch>` or `--unbuilt <CARD>`.
- `merged-into-branch`: "<CARD>'s PR was merged into <b>, which is no base.
  Treat it as built (branch <b> is the base) or unbuilt?" The same two
  answers.
- `combine-conflict`: "<repo>'s built branches <cards> conflict on <paths>.
  Which card should be treated as unbuilt (replayed or re-spiked)?" The answer
  is `--unbuilt <CARD>`, for one or more of them.
- `bases-unknown`: a needed head commit is not in the checkout. Offer the
  fetch, which writes pull-request refs into that checkout, or
  `--unbuilt <CARD>`. On the user's yes, run with the ask plan's `approve`:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/respike.mjs fetch <project ref> --approve <hash> [--cards <CARD>[,<CARD>]...] [--stale] [--all] [--built <CARD>=<branch>]... [--unbuilt <CARD>]... [--with-default <repoDir>]... [--hand <CARD>:<item>=<CARD>]... [--drop <CARD>:<item>]... [--skip-check <CARD>]...
```

  It prints `fetched` and `nextApprove`. Preflight again with the same flags
  and show the new plan.

A base behind default: ask once per repo whether to bring it up to date,
naming the repo, the base and how many commits it misses.

- With `ownCommits` 0 (a local branch the default branch already holds),
  offer to fast-forward that branch. On the user's yes, run with the plan's
  `approve`:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/respike.mjs fast-forward <project ref> --repo <repoDir> --approve <hash> [--cards <CARD>[,<CARD>]...] [--stale] [--all] [--built <CARD>=<branch>]... [--unbuilt <CARD>]... [--with-default <repoDir>]... [--hand <CARD>:<item>=<CARD>]... [--drop <CARD>:<item>]... [--skip-check <CARD>]...
```

  It moves only that branch, refuses a checked-out one with uncommitted work,
  and prints `from`, `to` and `nextApprove`. Preflight again with the same
  flags.
- Otherwise (a PR head or a branch with own commits), offer
  `--with-default <repoDir>`: the default branch's tip joins the base as one
  more head, merged in the spike's own throwaway tree, so no branch of the
  user's moves and nothing is pushed. Add the flag to every later
  `preflight`, `fetch` and `begin`. When it does not merge, the plan asks
  `default-conflict`: drop the flag, or treat a card as unbuilt.

### The PR check

A built card the run builds on keeps the record of its last spike, which
can claim more than its PR builds. Before the run, its record is checked
against the PR, so a gap is settled before any card is spiked on top of it.

- `pr-unchecked`: "<CARD>'s record has not been checked against its PR (or
  its head moved since the check)." Run the check below, or answer
  `--skip-check <CARD>` on the user's say-so to start without it.
- `not-built`: "<CARD> <item> is in its record (or its description) but the
  PR does not build it: fix the PR first, hand it to a card this run spikes,
  or drop it." The answers are `--hand <CARD>:<item>=<CARD>` (the item goes
  into that card's brief as `handed`), `--drop <CARD>:<item>`, or fixing the
  PR, which ends this preflight: the user fixes it, and the next preflight
  sees the new head as `stale`. One question per item.

Gather with the same selection flags as the preflight:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/respike.mjs audit <project ref> --before [--cards <CARD>[,<CARD>]...] [--stale] [--all] [--built <CARD>=<branch>]... [--unbuilt <CARD>]... [--with-default <repoDir>]... [--hand <CARD>:<item>=<CARD>]... [--drop <CARD>:<item>]... [--skip-check <CARD>]...
```

It needs the key, writes no record, and saves `before.json` and one diff
file per PR or branch under `~/.keiron-sequencer/<slug>/audit/`. Each of its
`cards` is a built card whose check is unchecked or stale: what it is
checked `against` (each with `diff.path` and the lines per file in
`diff.files`, or an `error`), its `description` (the notes block cut out)
and its old `items` (cases `c1`…, decisions `d1`…), and `map`, every card
key of the project. Read each diff and judge each item, each with a one-line
`note` naming the file or what is missing:

- `holds` when the diff builds it.
- `moved`, with the `card` that owns it, when the item is another card's
  behavior: a stacked spike records what its tree does after the card, so an
  earlier card's work (a check it adds, a field it carries) can sit in the
  record as if this card built it. The note says what that card builds and
  how this card relies on it. A `ref` or a card key in the item is a hint,
  never the verdict: an item can cite another card and still be this
  card's own behavior.
- `not-built` when it is this card's own behavior and the diff does not
  build it.

What the description asks for and the diff does not build goes in
`missing`, one line each (it is asked as `m1`, `m2`…). Missing scope is
behavior, never where it is tested: tests at another layer that cover the
same behavior are no gap. Write the verdicts next to the inputs as
`before-verdicts.json`:

```json
{
  "schemaVersion": 1,
  "cards": {
    "CRM-20": {
      "items": {
        "c3": { "verdict": "holds", "note": "src/letters/files.ts finds a file by position." },
        "c4": { "verdict": "not-built", "note": "The PR has no lock check." },
        "c5": { "verdict": "moved", "card": "CRM-18", "note": "CRM-18 rejects writes to a locked letter; this card relies on it." }
      },
      "missing": []
    }
  }
}
```

Show the user each card's verdicts, then store them and preflight again:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/respike.mjs audit <project ref> --before --verdicts <verdicts.json>
```

It is offline, checks every card before it writes any record, marks each
item with its `audit` (`check: 'pr'`, `verdict`, the `card` of a moved one,
`note`, `at`) and adds the check, with the heads it saw and the `missing`
scope, to the record's `audits`. A moved item is not asked and harvest does
not publish it under this card. A check never drops an item: that is the
user's answer to `not-built`. Exit 2: the verdicts do not validate (a
verdict other than `holds`, `moved` or `not-built`, or a moved item naming
no card of the map, included). Exit 5: nothing was gathered, or a record
was re-spiked since the gather.

On `action: 'stop'` (code `cycle`, with its `members`): A `stop` creates
nothing. Name the members and stop; the blocks are fixed in Linear. On
`action: 'nothing-to-do'`: nothing is left to spike or replay; report it and
stop.

## Step 4: One approval, on the plan hash

On `action: 'ready'`, ask One question: "Begin the respike of N cards (R
replays, S spikes) with plan <approve>?", counting from `order`, with the caps
the user wants. Anything other than an explicit yes is a no.

## Step 5: Begin

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/respike.mjs begin <project ref> --approve <hash> [--cards <CARD>[,<CARD>]...] [--stale] [--all] [--built <CARD>=<branch>]... [--unbuilt <CARD>]... [--with-default <repoDir>]... [--hand <CARD>:<item>=<CARD>]... [--drop <CARD>:<item>]... [--skip-check <CARD>]... [--max-tokens <n>] [--max-cards <n>] [--box <n>] [--workers <n>] [--checks <n>] [--session-file <transcript.jsonl>]
```

It recomputes the plan and creates the run only when the hash matches and
the plan is `ready`. It prints `mark`, `runId`, the `plan` and `respike`
counts (`selected`, `replay`, `spike`, `built`). The caps work as in
/keiron-sequencer:spike: both optional, checked only between cards, a fresh budget at
every begin, and replays count toward no cap. `--box` is warn-only and fixed
at the card's first window. `--workers` (default 3) is how many tracks run at once and `--checks` (default 1) how many
typechecks, test runs and setup commands may run at once; both are stored on the run and `status` and `tracks` print them.
The plan's tracks hold whatever `--workers` is: with `--workers 1` the main session works them one after another. Exit 5 means nothing was created: the plan moved
(a PR head or a branch moved), it is not `ready`, or a run is open. On exit 5, show the new plan and ask again,
after a preflight with the same flags.

## Step 6: The card loop

The loop is the /keiron-sequencer:spike card loop, worked per track. The card
work is written out in full in `${CLAUDE_PLUGIN_ROOT}/skills/respike/worker.md`,
the worker brief: read it before the first card. `tracks` lists each track
with its `status`, `current` card, `done`/`total` and `mergedInto`, and the
run's `workers` and `checks`.

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/spike.mjs tracks [--project <project ref>]
node ${CLAUDE_PLUGIN_ROOT}/scripts/spike.mjs next [--track <id>] [--project <project ref>]
node ${CLAUDE_PLUGIN_ROOT}/scripts/spike.mjs tree <repoDir> [--track <id>] [--project <project ref>]
node ${CLAUDE_PLUGIN_ROOT}/scripts/spike.mjs candidates [--track <id>] [--repo <repoDir>] [--project <project ref>]
node ${CLAUDE_PLUGIN_ROOT}/scripts/spike.mjs fixup [--track <id>] --fixes <CARD>[,<CARD>] --slug <kebab-slug> --note "<English>" --repo <repoDir> [--allow <kind>:<path>]... [--project <project ref>] -- <path>...
node ${CLAUDE_PLUGIN_ROOT}/scripts/spike.mjs notes-template <CARD> [--track <id>] [--project <project ref>]
node ${CLAUDE_PLUGIN_ROOT}/scripts/spike.mjs end <CARD> [--track <id>] [--notes <notes.json>] [--allow <kind>:<path>]... [--skip-typecheck <reason>] [--project <project ref>]
node ${CLAUDE_PLUGIN_ROOT}/scripts/spike.mjs cross --track <id> --card <CARD> --needs <CARD> --kind depends|changes --note "<English>" [--project <project ref>]
```

- Run `next`, `end`, `tree`, `check`, `cross` and `combine` with the shell
  tool's longest timeout (600000 ms) or in the background: they take a check
  slot, and replays, merges and type-checks can take minutes. Run `cross`
  and `combine` in the background: a merge replays and type-checks cards and
  `combine` builds and checks every repo, so either can take longer than
  that timeout, and a `cross` killed mid-merge stops both its tracks until
  it runs again. `next`, `end`, `tree`, `cross` and `combine` take a check
  slot themselves.
- `action: 'stale'` (a merge or a pause moved the track while the command
  ran) and Exit 75 with `action: 'busy'` (no check slot freed in time, the
  run lock stayed held, or a track is `merging` or `replaying`): nothing was kept, and whoever ran the
  command, the coordinator or a worker, reruns the same command. A slot's
  `busy` names its `holders` (each slot's pid and command), a held run lock
  its `lock` pid. After three `busy` or `stale` answers in a row to one
  command, stop rerunning it: a worker returns it to you. Read the holders:
  wait for another worker's check or a `combine` to end, then continue, and
  report a holder that is no command of this run to the user.
- `next` processes the ready replay entries first, inline: no window, no box,
  no question. Each output lists them in `replayed` (`card`, `status`,
  `patches`): `replayed` (applied cleanly; the record keeps its findings,
  cases and decisions, its patches move to this run, and its size, risk areas
  and new paths are recomputed) or `empty` (already in the base; the record is
  untouched). Show them as they pass.
- A replay that does not apply (`conflict`, `no-preimage`), whose result
  holds secret-like content (`secret`), or whose result fails the typecheck
  (`typecheck`: the replay's changed files are checked as at `end`, and every
  moved tree is put back) turns into a spike in place. `next` hands it out as
  a card with `replayConflict` (`repos`, `patch`, `reason`, `unmerged`
  paths), `replaySecret` (the hits, never the value) or `replayTypecheck`
  (`repo` and the `log`). It is
  spiked like any other card; the conflict is context only. The pending
  replays are re-planned: a fixup from or for that card is dropped, and the
  report lists it.
- Caps are checked only between cards and count every worker's cards; the
  box is warn-only. A card's spend is measured on the transcript of whoever
  worked it.

### One worker

With one worker, the main session does the card work inline, in the trees
the CLI opens, following the worker brief itself, track after track in
`tracks` order: no worker subagents, and never a subagent per card. Edit only
under a tree's `path`. Use `candidates` and `fixup` when the card changes
code an earlier card wrote. Run the premise check first, as in
/keiron-sequencer:spike. The brief's `previous` holds the card's old record:
give each of its findings an outcome in `priorFindings` (`holds`, `resolved`
or `wrong`) instead of rewriting it. The brief's `handed` lists the items a
built card's PR does not build that the user handed to this card at the
plan (`from`, `id`, the case or text, the PR check's `note`): cover each in
this card's cases or decisions, or say in a finding why the card cannot.
The brief's `unordered` lists the cards whose work is in the trees though no
blocks chain orders them first: a use of their code is a `reorder` finding
naming the card, and the cases cover only this card's own change, as in
/keiron-sequencer:spike.
Record each of the brief's `packAnswers` as a decision with its pack ref
and say where it went in the notes' `packAnswers`, as in
/keiron-sequencer:spike; a finding that contradicts one blocks `end` until
the user keeps or reopens it. Write the notes from `notes-template`:
between 3 and 6 given/when/then cases in English (about 4), each open guess
in `openDecisions` after its implication check, tagged with `impact` and
`owner`, the attested `piiInLogs` paths (`[]` when none), no diff text. A
`reorder` finding that would run backward across milestones is a milestone
question (which card moves), not a plain order. Then `end`. Proceed on
trivial decisions; ask mid-card only on real conflicts. Never mark the scope
incomplete for a box overrun.

A run with one track needs no `--track`, whatever `workers` is: the main
session works it as above, it reads like today, and it completes at `next`.
A run with several tracks and one worker passes `--track <id>` on every
card-loop command, handles crossings as below (none is ever deferred, since
only one card is in progress), and ends with the combined check.

### Several workers: the coordinator

With more than one worker and more than one track, the main session is the
coordinator: it does no card work itself.

1. **Dispatch.** Start at most `workers` workers, one per track that is not
   `done` or `merged`, in track order. A worker is a general-purpose
   subagent started with the Agent tool. Its prompt is the text of
   `${CLAUDE_PLUGIN_ROOT}/skills/respike/worker.md`, with the plugin-root
   variable in its commands replaced by the plugin root this skill's
   commands run from (the folder before `/scripts/` in them), then its track
   id, the project ref and the run id. The workers run at once, and you are
   told as each one returns. Keep each worker's agent id with its track.
2. **After `end`.** First run again every `cross` that was deferred while
   this track's card was in progress. Then read the worker's report, its
   `crossingSuspects`, and every finding that names a card in another track
   (a dependency the map missed; the plan lists each track's cards, and a
   merged track's cards live on in the track it merged into). When one is a
   crossing, run `cross` for it with the card that just ended as C (a done
   C is re-spiked), and handle the answer as below. Otherwise continue the
   same worker with `SendMessage`: "next card".
3. **After `cross`.** Handle the answer (Crossings).
4. **`track-done`.** The worker is finished: its slot goes to the next track
   not yet started. With `combine: true` every track is done: run the
   combined check.
5. **`waiting`** with `waitingOn`: continue that worker once the
   `waitingOn` card has ended.
6. **`pause`**, or "the run is paused": stop dispatching. Send no more "next
   card"; in-flight cards finish, and each worker returns after its `end`.
   Then Step 7. A cap reached in any worker pauses the whole run.
7. **A question** on a real conflict: ask the user, then answer the worker
   with `SendMessage`.

### Crossings

`cross --track <R> --card <C> --needs <B>` records that C (track R) needs
(`depends`) or must change (`changes`) B (track G), and merges the two
tracks into G. A merge runs only at card boundaries: the CLI defers it while
G has a card in progress. A rerun after another merge passes the track C
lives in now (`tracks` shows `mergedInto`). The answers:

- `merged`: R joined G under G's id. `replayed` lists R's done cards
  replayed onto G's trees (their records keep their content and get
  `mergedFrom`), `respiked` the cards to re-spike (for `changes`, B's done
  dependents; C too when it was done; and any card of R whose replay did not
  fit), and `wip` C's saved work. R's worker
  is finished: send it nothing more. G's worker carries on: continue it
  with "next card", or start one for G when it has none. When `parked`
  names a card of G, its work was set aside to its `wip` too: tell G's
  worker that card was parked with a pending crossing, which it runs again
  once `next` hands it the card.
- `applied`: by now the crossing is inside one track (its tracks merged
  since it was recorded): the edge and the re-spikes are applied. Continue
  that track's worker. A `parked` card other than C reads as above; when it
  is C itself, its crossing was just applied: it only restarts with its
  `wip`, and there is nothing to run again.
- `deferred` (exit 1) is not an error: G has a card in progress, and the
  crossing is recorded as pending. Leave R's worker stopped (its slot stays
  taken), and run the same `cross` again once that track's worker returns
  from its `end`, before you send it "next card". A parked card's own crossing
  runs again only after that card restarts through `next`.
- `stale`, or Exit 75 with `merging` or `replaying`: run the same `cross`
  again.
- Exit 1 naming `wip/<CARD>.patch`: that card's saved work is not back in
  its tree. Ask its worker to put it back or delete it, then run `cross`
  again.
- Exit 1 saying a crossing `stopped mid-merge`: a `cross` was killed between
  its sections. Every command on its two tracks, and `combine`, refuses
  until it runs again: run the `cross` the message names (with the
  crossing's note from the report) before anything else. The rerun first
  puts the target track's trees, and any parked card's work, back as they
  were before that `cross` began.
- **Exit 5** at `cross`: B → C closes a cycle among the cards. Nothing was
  merged. Report both cards to the user and ask which way the need goes.

### The combined check

A run that had more than one track completes only through it; a run with
one track completes at `next` and never runs it.

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/spike.mjs combine [--project <project ref>]
node ${CLAUDE_PLUGIN_ROOT}/scripts/spike.mjs fixup --combined --fixes <CARD>[,<CARD>] --note "<English>" --repo <repoDir> [--allow <kind>:<path>]... [--project <project ref>] -- <path>...
```

`combine` builds one tree per repo, `trees/combined/<repoDir>`, from the
respike base with every track's patches and fixups, and type-checks it.
Never type-check the combined tree by hand: `combine` checks it. It judges
errors as `end` does: an error in a file no card changed is ignored, so a
clash that only shows in a file no card touched passes `combine`. Say so
when you report `combined-ok`.

- `combined-ok`: the run is complete; report it as `complete` below, then
  Step 8. When it lists `skipped` (`{ repo, reason }`: `off`,
  `no-typescript-project`, `no-typescript-changes` or `no-changes`), the
  combined check never ran in those repos: say so, since a pass there proves
  nothing. `combined-failed` carries `skipped` the same way.
- `combined-failed` with `round` and `errors`, each `{ repo, file, line,
  message, cards }`. Diagnose before fixing, in the main session: read each
  error, the cards it names, their records and patches, and say which cards
  clash and why (a renamed symbol, a changed signature, two edits to one
  file that do not compose, a missing import, a dependency between tracks
  nobody saw). A failure never means re-spiking everything. Then fix it at
  the smallest scope that fixes it:
  - An error saying a patch `does not apply on the combined tree` is a
    missed crossing: send it to `cross` (the later card is C, with
    `--kind changes` when it must change the earlier card's code), never to
    `fixup --combined`.
  - A type error whose cards' intent composes, where the code just does not
    fit together: edit `trees/combined/<repoDir>` and record it with
    `fixup --combined`, its `--fixes` the clashing cards and its `--note`
    why it failed and what the fix does. It is credited to those cards with
    `from: 'combine'`.
  - A type error that shows a missed crossing, one that changes what a card
    must do: record it with `cross` after the fact; only the cards that
    crossing re-spikes are re-spiked, on their merged track, by a worker you
    continue or start for that track.
  Then run `combine` again once every track is done. After 3 failed rounds
  the run pauses with `reason: 'combine'`: report the remaining errors, the
  diagnosis and what you tried, and stop (Step 7).
- **Exit 6** at `combine`: a combined tree holds work no `fixup --combined`
  recorded: record it or drop it, then run `combine` again.

### Errors and the end

- `action: 'setup-failed'` (Exit 1), at a replay, at `tree`, at `cross` or
  at `combine`: fix the cause or report it; the next call retries. At
  `cross` nothing was merged and the crossing stays pending. When the cause
  is the repo's configured `setup` (a step missing, such as a code
  generator whose output is gitignored, or a wrong command), propose the
  change through the config step with `--edit` (Missing config), never a
  hand edit of config.json. With a run open, after the write go back to the
  call that failed, not to preflight (it refuses an open run with Exit 5):
  each `tree` reads config.json again, so a tree whose setup failed retries
  with the new steps. A tree whose setup already passed never runs it again
  (a step missing there shows later, for example as a typecheck error on a
  generated module): on the user's yes, run the added step once in that
  tree's `path`; trees opened later run the new setup.
- A tree that refuses (Exit 1) because its pinned base is gone or its
  combined base differs from the plan: report it; abandon only when the user
  asks, then preflight again. A repo with only a `url` is refused too: the
  user configures a `checkout`.
- **Exit 4** at `end`: secret-like content; remove it, or for a false positive
  run `end` again with `--allow <kind>:<path>`. **Exit 6**: a tree guard failed;
  for a missing last tree run
  `node ${CLAUDE_PLUGIN_ROOT}/scripts/spike.mjs rebuild <repoDir> [--track <id>] [--project <project ref>]`.
  **Exit 7**: usage unmeasured while a token cap is set; run `next` again once
  the output is in the transcript. **Exit 8** at `end`: the typecheck failed,
  as in /keiron-sequencer:spike; fix it, or run `end` again with `--skip-typecheck` and
  a reason only when the failure is not this card's.
- `action: 'pause'`: Step 7. `action: 'complete'` (one track) or
  `combined-ok` with `respike: true`: report `removed`, `pruned`,
  `touchedCheckouts` and `warnings`, then Step 8.

## Step 7: Pause and resume

`node ${CLAUDE_PLUGIN_ROOT}/scripts/spike.mjs pause [--project <project ref>]`
stops on purpose and keeps the trees. A cap pauses the same way, and a paused respike run resumes with
`node ${CLAUDE_PLUGIN_ROOT}/scripts/spike.mjs begin <project ref>`: it needs no hash, since the plan was approved when the run began, and it never reads Linear again.
Running this skill again works too: preflight refuses with Exit 5 and names
the resume. `node ${CLAUDE_PLUGIN_ROOT}/scripts/spike.mjs status [--project <project ref>]`
is read-only and shows each entry's mode, the replay outcomes and the tracks.

A pause stops dispatching: in-flight cards finish, and no worker gets another
card. The resume keeps the run's `workers`, `checks` and tracks. On resume
the workers are new subagents: each one's first message carries, besides the
brief, its track's records and the previous card's notes: the records of the
track's done cards (`~/.keiron-sequencer/<slug>/<CARD>.json`) and the notes of
its last done card (`~/.keiron-sequencer/<slug>/runs/<runId>/notes/<CARD>.json`).
A card that was in progress is reopened with `resumed: true`. A run paused with
`reason: 'combine'` resumes with every track done: a resume starts the rounds
again, and the coordinator runs `combine` again after its diagnosis.

Deferred crossings live in the run, not in the coordinator's memory: a pause
or a new session loses the coordinator's list, and `cross` refuses on a paused
run. On resume, run the report (Step 9) and take every crossing whose `status`
is `pending` (a crossing whose `cross` was killed mid-merge reads `pending` too). Run its `cross` again (its `from`, `to`, `kind` and `note`, with
the track its card lives in now) before you start a worker for its track: a
worker started first would reopen the stopped card and work it without the
merge. A crossing whose card was parked (the card is pending again) is the
exception: `cross` refuses it until the card restarts, so tell that track's
worker to run it again once `next` hands it the card. A rerun that answers
`deferred` waits for the other track's worker to return from its `end`, as in
Step 6.

## Step 8: Audit the cards the run did not re-spike

Once the run is complete. The PR check held each built card against its PR
before the run (Step 3); this audit holds every open card the run left alone
against the records the run spiked, since a fresh spike can take scope over
from one of them. The CLI gathers and stores, you make the calls.

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/respike.mjs audit <project ref> [--run <runId>]
```

It needs the key, reads the project's card descriptions once, reads no PR,
and writes no record: it saves `inputs.json` under
`~/.keiron-sequencer/<slug>/runs/<runId>/audit/` and prints:

- `cards`: every open card on the map the run did not spike (unselected or
  replayed), with a live record. `kind` is `built` (an open PR, a draft or an
  accepted local branch, in `against`) or `unbuilt`. A built card has its
  `prCheck` (what held, what moved and to which card, and what was not built before the run, and the
  `missing` scope), and every card its `handed` items (each `id` with the
  card the plan handed it `to`) and `dropped` items. Each card has its
  `description` (the notes block cut out), its old `items` (cases `c1`… and
  decisions `d1`…, each with its latest `audit` mark or null) and its
  `mentions` (the fresh cases, decisions, open decisions and findings that
  name it).
- `fresh`: the cases and decisions of every record this run spiked.
- `skipped`: `merged` cards (not audited: harvest writes no notes on a card
  that has started)
  and cards with `no-record`.

Judge each card, item by item:

- Read its `mentions` first: a fresh decision or case that names the card
  says where its scope went. Then compare its items with the `fresh` items
  of the other cards: two cards whose cases claim the same behavior, or a
  fresh decision that contradicts one of its items.
- An item a fresh card now owns is `moved`, with that `card`: a `handed`
  item is moved when the card it went to covers it. One that no card should
  build any more is `dropped`, a `dropped` item first. A built card's item
  the PR check found `not-built` that no fresh card covers stays
  `not-built`. An item the PR check moved stays `moved`, to the same card or
  to the one a fresh record shows owns it now (or `dropped`): no fresh
  record claims it, and `holds` would hand it back to this card, so the
  store refuses it. The rest `holds`.
- Judge every card in `cards`, or it stays `pending` in the report. An
  unbuilt card that no mention names and no fresh item matches holds, item by
  item, with the note that no fresh card claims it.
- Every item gets exactly one verdict and a one-line `note` with the
  evidence: the fresh card and item that claims the same behavior, or the PR
  check. Never call an item moved from a title alone. `not-built` is for a
  built card only, and `missing` scope belongs to the PR check.
- When the description no longer says what the card builds (scope moved out,
  dropped, or the PR check's `missing`), propose a new text in Spanish under
  `description`, with `why`. It is a proposal: it reaches Linear only through
  /keiron-sequencer:harvest, on the user's yes.

Write the verdicts next to the inputs, as `verdicts.json` in the same folder:

```json
{
  "schemaVersion": 1,
  "runId": "<runId>",
  "cards": {
    "CRM-20": {
      "items": {
        "c1": { "verdict": "moved", "card": "CRM-30", "note": "CRM-30 c1 opens the same pictures." },
        "c3": { "verdict": "holds", "note": "The PR check found it built; no fresh card claims it." }
      },
      "description": { "text": "<nuevo texto>", "why": "<why>" }
    }
  }
}
```

Show the user each card's verdicts (what holds, what moved and to which
card, what is not built or dropped, and the proposed description), then
store them:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/respike.mjs audit <project ref> --verdicts <verdicts.json> [--run <runId>]
```

It is offline and checks every card before it writes any record: each card
was gathered, each item of its record has one verdict, a moved item names
another card of the map. It marks each item with `audit` (`check: 'fresh'`,
`verdict`, the `card` of a moved one, `note`, `runId`, `at`) and adds the
audit to the record's `audits`, with what it was checked against, every
verdict and the proposed description. It never removes or renumbers an item
and never changes `spikedAt`, so the record keeps the history: the PR check
and each run's audit have their own entry, and storing the same run again
replaces that run's marks. It prints each card's `holds`, `moved`,
`notBuilt` and `dropped`. Harvest then publishes only the items that hold;
where an item went stays in the record and the harvest review, never in
Linear.

Exit 2: the verdicts do not validate; show the errors, fix the file and store
again. Exit 5: the run is not complete, the audit was not gathered, or a
record was re-spiked since the gather: gather again.

## Step 9: Report

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/respike.mjs report <project ref> [--run <runId>]
```

It is offline, needs no key, and works mid-run over the cards done so far.
The report is printed and saved as `~/.keiron-sequencer/<slug>/spike/respike-<runId>.json`
(its `path`); running it again rewrites the same file. It is advisory: it
blocks nothing and changes no record. Show:

- For each card in `cards`: tier and verdict old and new (`unknown` shown
  literally), the scope flip, the size moves, the fixups received and caused
  added and gone, and the cases, decisions, findings, openDecisions, risk
  areas and new paths added and gone. When the new record has
  `priorFindings`, `findings.outcomes` counts the old findings that hold,
  were resolved or were wrong, and `findings.gone` lists the resolved and
  wrong ones with their outcome; an old record without them is compared by
  text. Risk areas no longer move the verdict, and an open decision without
  `impact` counts as design.
- `replayed`: each replayed ancestor's size, risk areas, new paths, tier and
  verdict before and after.
- `bases`: each repo's base, the heads of a combine, and "base N commits
  behind default".
- The project lists: `project.newCards`, `project.orphans` (completed or off
  the map), `project.built`, `project.selectedBuilt` (picked or selected but
  built, never spiked), `project.replayed`, `project.replayToSpike` (each
  with its reason: `conflict`, `no-preimage`, `secret`, `typecheck`,
  `shared-patch` with its `sharedWith`, or `ancestor-spiked` with its
  `spikedAncestors`), `project.replanned` (each fixup dropped from a
  pending replay after a turn, with its card, patch, reason and cause),
  `project.unselected`, and `project.pending` when `complete` is false.
- Under `## Audit`, next to the comparison, `audit`: whether it was
  `gathered`; for each card judged, its `kind`, what it was checked
  `against`, the items that hold, the `moved` ones with the card that owns
  each now, the `notBuilt` and `dropped` ones, the proposed `description`
  and, for a built card, its `prCheck` (what held, what moved, what was not built and
  the `missing` scope before the run); the `pending` cards gathered but not
  judged yet; and the `skipped` ones (`merged`, `no-record`).
- Under `## Tracks`, each entry of `tracks`: its id, status, `mergedInto` and
  cards. A one-track run shows its one track, and no `## Crossings` or
  `## Combined check`.
- Under `## Crossings`, each entry of `crossings`: the two cards and tracks,
  its kind, note and status, the cards it `respiked`, the cards it
  `replayed` onto the merged track, and its `droppedFixups`.
- Under `## Combined check`, `combined`: `passed` (when the check passed),
  the `skipped` repos where that passing check never ran, with their reason,
  the limit that errors in files no card changed are not judged, and each of
  the `failures` with its errors, the `fixups` recorded for it
  (the note is the diagnosis; a dropped one is shown as dropped) and the
  crossings recorded for it.

Name the saved file for the user to review, with the records in
`~/.keiron-sequencer/<slug>/`. Exit 1 means a record field holds diff text and nothing was
written, or there is no respike run for the project.

## Step 10: Offer /keiron-sequencer:harvest

Offer /keiron-sequencer:harvest to review the new cases and notes, and the
audit's description proposals; never run it unless the user asks.

## Exit codes

- **Exit 0**: JSON on stdout; read `action`. A plan that asks, stops or has
  nothing to do is exit 0.
- **Exit 1**: a Linear, gh or git failure, an unreadable run or record, a
  report holding diff text, or a written config.json that failed to load
  (the previous file is put back, or a first one removed). Report it; do not
  retry blindly.
- **Exit 2**: usage, a config error, the missing-config block, or trial
  records with no trial reference beside their patches. From
  `config`: no checkout roots; trial folders to map with no trial patch map; a draft path inside `~/.keiron-sequencer` or a
  repo, or an existing `--out`; a `--root <dir>` that is relative or not a
  folder; a config.json that is not JSON (never replaced); a draft that is
  not JSON, or at the write one that does not validate or holds a URL with
  credentials. A `--hand` or `--drop` that answers no not-built item of a
  checked card, or hands an item to a card this run does not spike. From
  `audit --verdicts` and `audit --before --verdicts`: verdicts that do not
  validate; no record was written.
- **Exit 3**: no Linear key found (the config draft and both audit gathers
  too; the config review and write and the audit stores need none).
- **Exit 4**: secret-like content in a card patch at `end`; nothing written.
- **Exit 5**: refused, nothing ran: an open run, a hash that does not match,
  `begin` on a plan that is not `ready`, `fetch` with no `bases-unknown`
  ask, or a config draft or config.json changed since its hash was shown.
  At `cross`: the need closes a cycle. At `audit`: the run is not complete,
  the store found no gathered audit or PR check, or a record was re-spiked
  since the gather.
- **Exit 6**: a tree guard failed; nothing written.
- **Exit 7**: usage unmeasured while a token cap is set.
- **Exit 8**: the typecheck failed at `end`; nothing written.
- **Exit 75**: busy (no check slot freed in time, the run lock stayed held,
  or a track is `merging` or `replaying`); nothing changed: run the same
  command again, at most three times in a row. Never remove a lock or slot
  file by hand: its holder is alive.
