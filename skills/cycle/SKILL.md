---
name: cycle
description: >
  Plan a project's next Linear cycle: carry over the current cycle's unfinished
  cards, fill the rest in /keiron-sequencer:next's order with blockers respected,
  size each card from its spike record tier (or a guess from the card), and share
  unassigned cards among the project's members by availability. Capacity comes
  from what each person finished in recent cycles, never a stored number; the
  plan has a committed band (the worst recent cycle) and a stretch band (the
  average). It writes to Linear only on the user's command with the plan hash.
  Trigger: "sequencer cycle", "plan the next cycle", "what fits in the next cycle",
  "planificar el próximo ciclo".
license: Apache-2.0
metadata:
  author: keiron-sequencer
---

# keiron-sequencer cycle

The CLI is `node ${CLAUDE_PLUGIN_ROOT}/scripts/cycle.mjs`. `needs` and `plan` only
read Linear (`plan` writes `plan.json` and `plan.md` under
`~/.keiron-sequencer/<slug>/cycle/`); `apply` writes to Linear and runs only on
the user's explicit command with the plan hash. Run each with a Bash timeout of
at least 3 minutes (`timeout: 180000`).

Never print, echo or `cat` the key, `$LINEAR_API_KEY` or the key file. On exit 3
tell the user the CLI looks for `LINEAR_API_KEY` or
`~/.config/keiron-planner/linear.key`; never ask them to paste the key.

## How the plan is built

- **Size:** spike tier points, S=1, M=2, L=3, XL=5. A record outside the
  thin-spike population (an existing PR) is placed on the same line-count scale.
  A card with no record, or 0 lines, uses the tier you guess in Step 3, else
  default M.
- **Capacity per person:** the tier points they finished on this project in
  their last 3 cycles with work: the current cycle first, with what is finished
  in it so far, then the completed ones (looking back 6). Built work counts
  before Linear says Done: a card whose PR is merged into the default branch
  counts in the cycle it merged, and the built share of an open PR or a branch
  (its points × (1 − remaining)) counts in the current cycle. With fewer than 3 such cycles
  (thin history), committed is 80% of the mean instead of the lowest. Committed = the
  lowest × availability; stretch = the mean × availability. No history: 1 point
  per working day of the next cycle × availability, marked as guessed.
- **Fixed load first:** carry-over cards (current cycle, unfinished) and cards
  already in the next cycle are always in the plan, at their remaining work:
  by Linear (not started 100%, in progress 75%, in review 25%) or by what is
  built, whichever is less. The build is read the way /next reads it, GitHub PRs
  (drafts included) across every repo of the project and pushed or local
  branches: merged into the default branch 10% (an open [Prod] port adds
  nothing), an open PR 25%, a branch with no PR 50%. A failed read is a warning
  in the review, and the cards it could hide keep their Linear figure. A person whose fixed load
  passes committed is flagged over and gets no new card.
- **Later cycles stay put:** a card already scheduled for a later cycle than
  the next is left out ("scheduled for cycle N"), never moved.
- **Fill:** the rest in /next's order (deadline, milestone order, card due
  date, critical path, downstream, number). A card waits until every open
  blocker is placed and lands in the same band or later; an open blocker outside
  the project keeps it out. Assigned cards stay with their assignee; unassigned
  cards go to the member with the lowest load against their stretch.

## Step 1: Resolve the project and team

Take the project URL, slug, UUID or identifier (`P-CRM-371`) from the args. A
project *name* needs the Linear MCP (`list_projects`) to find one of those. A
project with several teams needs `--team <KEY>` on every command (exit 2 lists
them); ask the user which team when it is not clear.

## Step 2: Ask availability

Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/cycle.mjs needs <project-ref> [--team KEY]`
once and keep its JSON for Step 3: its `members` lists every project member
(`name`, `displayName`). Ask the user each one's availability for the next cycle, starting at 100%. The % is
relative to the person's usual pace on this project: 100% means like their
recent cycles, 50% half of that. Say to set 0% for anyone who does not take
cards (a PM, QA). An assignee who is not a project member is planned at 100%. Pass each as `--availability "<name>=<percent>"`; a name
matches the member's name or display name. Nothing is stored: ask on every run.

## Step 3: Guess sizes

The `needs` JSON from Step 2 also lists `needs[]`: the open cards and the history cards with no usable spike
record (`key`, `title`, `description`, `completed`), and `anchors`: up to three
spiked cards per tier from this project. For each card, read its title and
description and pick the tier whose anchors it most resembles; pass it as
`--guess <CARD>=<S|M|L|XL>`. Give no guess for a card you cannot judge (an empty
description, say): it falls back to default M and the plan marks it so. Guess
history cards the same way as open ones, so capacity and sizes share one scale.

## Step 4: Plan

`node ${CLAUDE_PLUGIN_ROOT}/scripts/cycle.mjs plan <project-ref> [--team KEY] --availability "<name>=<percent>"... --guess <CARD>=<TIER>... [--focus <milestone>]...`

Pass `--focus` only when the user asks for a milestone first ("take cards from
the logs milestone"). It names a milestone by its number or whole name and
ranks that milestone's cards, with their open blockers, ahead of the rest for
this plan only; Linear's milestone order and /next are unchanged.

stdout is one JSON line `{status, plan, review, hash, counts}`.

- **Exit 0**: `plan.json` and `plan.md` are written.
- **Exit 1**: Linear failed (one line on stderr). A line starting with
  `internal error:` is a keiron-sequencer bug: report it, do not retry blindly.
- **Exit 2**: usage: a bad flag, an unknown member name, a tier other than
  S, M, L or XL, or several teams without `--team`. Fix the command.
- **Exit 3**: no usable key.
- **Exit 4**: plan refused (the team has no next cycle, or the project has no
  members); a stale `plan.json` is removed. Tell the user.

## Step 5: Present the plan and STOP

Show the user `plan.md`: per person the availability, the history behind the
capacity (or that it was guessed, and how many history cards were sized by
guess), committed and stretch with points and card counts, any over-commitment
from fixed load, each card with its band, size and remaining work, the left-out
cards with their reasons, a spike suggestion when many open cards have no
record, the hash, and the Options section: A (committed only), B (with stretch)
and, when it helps, C (stretch less the lowest-ranked cards that take someone
past the middle of their range; built cards are never dropped), each with its
apply command, and the recommended one with its reason. A committed pinned by
one outlier cycle (under half the next) recommends B or C. Say that apply sets
an assignee only where a card has none, adds the committed cards, adds the
stretch cards only with `--with-stretch`, leaves out any `--drop <CARD>`, and
that carry-over cards move with Linear's own rollover. The user may pick an
option or drop other cards. Then STOP and wait. Offer to re-plan with other
availability, guesses or `--focus`.

## Step 6: Apply, only on the user's explicit command

The rule: never apply without the user's command and the hash. Do not apply on your own
initiative, after a silence, or because an earlier message approved a different
plan. When the user's message asks for it with the hash:

`node ${CLAUDE_PLUGIN_ROOT}/scripts/cycle.mjs apply <project-ref> [--team KEY] --plan <plan.json> --approve <hash> [--with-stretch] [--drop <CARD>]...`

Pass `--with-stretch` and `--drop` exactly as the option the user chose names them.

It re-reads Linear, checks every change before the first write, writes, reads
each change back, and appends one line per change to `applied.jsonl`.

- **Exit 0**: every change applied or already in place (`skipped`).
- **Exit 1**: a write failed or did not show up when read back; it stopped
  there. Running the same apply again continues and never repeats a change.
- **Exit 5**: approval refused: no `--plan` or `--approve`, a hash that does not
  match, an edited plan, a ref for another project, a `--drop` card that is not
  among the changes, or `--with-stretch` on a plan with no stretch changes.
  Nothing was sent.
- **Exit 6**: Linear changed since the plan (the next cycle, a card's cycle,
  assignee or state) and nothing was written. Plan again and present the new
  plan.
