---
name: next
description: >
  Pick the next Linear card to work on in a project. The next CLI reads the
  project's Linear blocks graph, the dependencies written in card text, GitHub
  PRs (drafts included, across every repo the project touches) and the local
  branches and worktrees of every clone, and returns the cards you can start
  now, ranked: the nearest deadline first (a card's due date or its milestone's
  target, overdue or due within a week), then milestones in delivery order. The
  skill picks one card and an alternate, and lists the overdue cards that are
  not startable.
  Trigger: "sequencer next", "what's next", "next card", "which card should I start",
  "qué tarjeta sigue", or after finishing/parking a PR.
license: Apache-2.0
metadata:
  author: keiron-sequencer
---

## When to Use

- The user asks what to work on next in a Linear project.
- A PR just merged or went to review and the write-queue is empty.
- Do NOT use to *start* the card — hand off to `/keiron-sequencer:start` for that.

## Arguments

Natural language. Resolve, in order:
- **Project**: the CLI takes the project URL, slug, UUID or identifier
  (`P-CRM-371`) directly; pass it as given. Only a project *name* needs the Linear
  MCP (`list_projects` / `get_project`) to find one of those. With no project in
  the args, take the team's most recently updated `In Progress` project (confirm
  which one you picked in the output).
- **Constraints**: "backend", "frontend", "small", "no AuthContext" — filter `free[]`.

## Step 0: Run the CLI

Run once per invocation and reuse the JSON for the whole run, with a Bash timeout
of at least 3 minutes (`timeout: 180000`): it reads Linear, GitHub and every local
clone of the project's repos.

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/next.mjs "<project-ref>"
```

- **Exit 0**: stdout is one JSON document (`schemaVersion` 1). Each `warnings[]`
  message is repeated on stderr as `warning: …`; show each once, under Board
  hygiene.
- **Exit 3**: no usable Linear key. Tell the user the CLI looks for
  `LINEAR_API_KEY` or `~/.config/keiron-planner/linear.key`, and stop. Never ask
  them to paste the key.
- **Exit 2**: usage, or a missing or invalid `~/.keiron-sequencer/config.json`.
  Show stderr and stop; /keiron-sequencer:spike drafts the config.
- **Exit 1**: a Linear failure (an `internal error:` prefix means a
  keiron-sequencer bug). Show stderr and stop. A call the caller kills counts as
  exit 1.

Never print, echo or `cat` the key, `$LINEAR_API_KEY` or the key file. The CLI only
reads; this skill writes nothing to Linear unless the user accepts a hygiene fix.

**Spike records.** `records.count` is the number of live spike records in
`~/.keiron-sequencer/<project.slug>/` for cards on this map; `records.invalid` is the
number of files there that could not be read (each is also a `record-invalid`
warning). Valid files for archived cards or cards not on this map (e.g.
`CRM-3918.json`) are ignored: neither counted nor invalid. Print at most one of these
lines for this project in this run, and continue:
- `records.count` 0 and `records.invalid` 0:
  > No spike record for <project> (`~/.keiron-sequencer/<project.slug>/` has no live record for this
  > map); sizes fall back to the Linear estimate.
- `records.count` 0 and `records.invalid` above 0:
  > Spike records unreadable for <project> (`~/.keiron-sequencer/<project.slug>/` has N invalid
  > files, see the warnings); sizes fall back to the Linear estimate.
- `records.count` 1 or more: no line.

A `data-in-repo` warning means the records are still in the plugin repo's old
`data/<project.slug>/` folder: show it, and offer the dry run of
`node ${CLAUDE_PLUGIN_ROOT}/scripts/maintenance/move-data.mjs <project.slug>`; run it with
`--apply` only on the user's explicit yes.

## What the JSON says

- `free[]`: every card the user can start now, sorted by `rank`. The CLI ranks
  by deadline, then milestone order, then card due date, then critical path,
  then downstream, then card number (`scripts/lib/next-order.mjs`). It has
  already dropped every card that is started (Linear past Todo; a PR open, draft
  or merged, by title tag or Linear attachment; a branch or worktree with the
  card's id, pushed or in any local clone), assigned to someone else, labelled
  Discovery or marked "No lleva PR", or blocked (Linear blocks, blockers in other
  projects, and dependencies written in card text). Each card carries:
  - `base`: `default` (the repo's default branch), `stack` (on a blocker's PR or
    branch, with its `costs`), or `null` when the CLI could not decide it here;
  - `unverified`: why a read failed or a stack could not be decided; null when
    everything was read;
  - `textBlockers`: dependencies written only in card text, which Linear lacks;
  - `checks`: what the CLI cannot verify, such as a dependency that must be live
    in QA;
  - `deferrable`, `size`, `estimate`, `critical`, `downstream`, `deadline` with
    `deadlineFrom` (`card` or `milestone`), `dueDate` and `milestoneTargetDate`.
- `overdue[]`: every open card with an overdue deadline that is not free, with
  its `reason` and `detail`: `in-review` (an open PR), `taken` (a draft PR),
  `started-local`, `started-remote` (a branch, no PR), `started-linear` (Linear
  says started, no PR or branch found), `triage` (accept it into the backlog
  first), `assigned-other`, `blocked` (the open
  blockers, or a blocker branch to push), `waiting-reviews` (two or more blocker
  PRs on separate branches: their reviews unblock it), `excluded` (Discovery or
  "No lleva PR").

Never re-derive the order, the dates or what is started: the CLI decided them.
Today is the JSON's `today`, the machine's local calendar date.

## Picking

1. Apply the user's constraints to `free[]`.
2. **The pick** is the first card left. Inside a tie (the same `deadline`,
   `milestoneOrder`, `due`, `critical` and `downstream`), a `deferrable` card drops
   below the others; still tied, the lower card number wins. Say when it was a
   tie, naming the tied cards.
3. **The alternate** is the next card in a different area: a different `repo`
   first, else a different file zone (from the titles and descriptions); say
   which. When no frontend card is free, a different backend file zone counts;
   say so.
4. A pick with `unverified` or `checks` is still the pick: say what is
   unverified or what to check. With `base` null, say that start decides the base.

## Output

- **Graph** (one line): project name, critical path (`CRM-A → CRM-B → …`, plus
  `criticalTies` if any), `summary.free` startable of `summary.open` open cards,
  `fetched`, and `today`.
- **The pick**: `CRM-XXXX — title`; its base (`default`, or the PR or branch
  `stack` stacks on, with every entry of `costs`); why it is next: the rule that
  chose it, one of `deadline <date> (<card or milestone>)`,
  `milestone order (<name> is the first with writable work)` or
  `no milestone (no milestone has writable work)`, plus any earlier deadline in
  `overdue[]` it passes over; critical path; what it unblocks (`downstream`); any
  tie; its size (`size.label` when non-null, else the Linear `estimate` (rough size), else "no size"), and next to it the verdict tag
  `<tier> · <verdict>` from `size.tier` and `size.verdict` when `size.tier` is
  non-null (e.g. `XL · SDD`, `L · Light`, `S · No SDD`); a verdict of `unknown` is shown literally, never replaced by `No SDD`
  (`L · unknown`). The tier is relative to this project's spiked cards. In
  `1109 lines · existing PR`, "existing PR" comes from the spike record's origin (the trial copied a real PR), not from GitHub;
  the CLI still decides whether the card is taken. Existing-PR cards have no
  tier and no tag. Never show effort or `timeBox`. Then `unverified` and
  `checks`, when present.
- **The alternate**, one line: the card, its size (`size.label` when non-null, else the Linear `estimate` (rough size), else "no size"), its verdict tag as in the pick, and whether it is a
  different repo or only a different file zone.
- **Overdue**: every `overdue[]` entry: key, title, the date (`dueDate` or
  `milestoneTargetDate`), its `reason` and `detail`. Never skip one.
- **Board hygiene**, only when `warnings` has entries. Name each by its kind:
  `text-only-dependency` (move it to Linear), `backward-milestone` (a blocks edge
  from a later milestone to an earlier one: move a milestone, or remove the edge
  if it is no hard dependency), `no-milestone` (assign one in Linear before a
  respike, which plans by milestone), `cycle`, `stale-block` (a block to an
  archived or canceled card), `wiring` (an open QA or planner card blocking a
  map card), `outside-project` (for information: a map card blocks an open card
  in another project), `relations-truncated` and `inverse-relations-truncated`,
  `repo-unknown`, `text-dependency-unknown`, `github-unavailable` and
  `git-unavailable` (the cards that needed the read are `unverified`; a clone
  that could not be listed only warns), `github-only` (a repo with no checkout
  in the config: its local work is not seen),
  `record-invalid` and `data-in-repo`. Offer to fix the Linear ones; don't fix
  unprompted.
- **Decision packs**, only when `records.count` is 1 or more: run
  `packs.mjs status` and report, one line each, the cards in `free[]` whose
  pack is `unanswered` or `stale`, the pick first: an unanswered pack with its
  `open` count, a stale one with its reason (`card-text`, `record` or `base`). Skip `fresh` packs and
  packs of cards not in `free[]`. The user is not starting a card here:
  Never ask a pack question here, and never draft or answer a pack.
  /keiron-sequencer:start drafts the pack of the card it starts, again when it
  is stale, asks its open questions and saves the answers. `status` lists only
  the packs already drafted, so a free card with no pack yet is not listed;
  say nothing about it. A `status` that fails is one Board hygiene line, never
  a stop.
- End with: start it via `/keiron-sequencer:start CRM-XXXX`, adding
  `--blocker <CARD>` for each entry of the pick's `textBlockers` (start reads no
  card text).

## Commands

```bash
# Step 0. Exit 0 JSON; 1 Linear or internal error; 2 usage or config; 3 no key.
node ${CLAUDE_PLUGIN_ROOT}/scripts/next.mjs "<project-ref>"

# Decision packs (Output): report only. It reads Linear (exit 3 with no key) and writes nothing.
node ${CLAUDE_PLUGIN_ROOT}/scripts/packs.mjs status <project-ref>
```

## Gotchas

- A stacked PR gets **no Amplify preview** (only closing and reopening it against
  `development` provisions one afterwards), and the auto-rebase never touches it
  when its base merges: retarget and rebase by hand, bottom-up. State the
  `costs` with the pick so the user can choose stack-now or hold. Between two
  otherwise equal cards, prefer the one whose base is a ready PR, not a draft or
  a branch with no PR.
- "Done" for QA-state purposes follows the team flow (In Review → Approved →
  Self QA → Peer QA → Done); for unblocking another card, merged to the default
  branch is enough, and the CLI counts it so.
- The CLI only sees this machine's clones: someone else's local work is
  invisible, which is why their cards are never offered.
- A `criticalTies` head is as much on the critical path as `critical[0]`.
- `downstream` counts only cards on this project's map; work a card unblocks in
  other projects is not counted.
