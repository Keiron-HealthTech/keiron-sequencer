---
name: next
description: >
  Pick the next Linear card to work on in a project, ordered by the project's
  Linear blocks graph (critical path, downstream count) plus the dependencies
  written in card text: reconcile Linear state against GitHub PRs (including
  drafts, across every repo the project touches) and local branches and
  worktrees (uncommitted work GitHub cannot see), and recommend the next
  unstarted card — the nearest deadline first (a card's due date or its
  milestone's target, overdue or due within a week), then milestones in delivery
  order, from the first that still has writable work.
  Trigger: "sequencer next", "what's next", "next card", "which card should I start",
  "qué tarjeta sigue", or after finishing/parking a PR.
license: Apache-2.0
metadata:
  author: keiron
  version: "1.0"
---

## When to Use

- The user asks what to work on next in a Linear project.
- A PR just merged or went to review and the write-queue is empty.
- Do NOT use to *start* the card — hand off to `/keiron-sequencer:start` for that.

## Arguments

Natural language. Resolve, in order:
- **Project**: the graph CLI takes the project URL, slug, UUID or identifier
  (`P-CRM-371`) directly; pass it as given. Only a project *name* needs the Linear
  MCP (`list_projects` / `get_project`) to find one of those. With no project in
  the args, take the team's most recently updated `In Progress` project (confirm
  which one you picked in the output).
- **Constraints**: "backend", "frontend", "small", "no AuthContext" — filter candidates.

## Step 0: Read the Graph

Run once per invocation and reuse the JSON for the whole run:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/graph.mjs "<project-ref>"
```

Run it with a Bash timeout of at least 3 minutes (`timeout: 180000`): each Linear
request may wait up to 30 s before the CLI gives up on it.

- **Exit 0**: stdout is one JSON document (`schemaVersion` 1). Show every
  `warnings[]` message verbatim (stderr repeats them as `warning: …` lines; show
  each once).
- **Exit 3** (no usable key): print this banner and continue in DEGRADED mode:
  > **DEGRADED — Linear blocks NOT read.** Set `LINEAR_API_KEY` or put the key in
  > `~/.config/keiron-planner/linear.key`. Dependencies come from card text only;
  > no critical path, no downstream counts, no off-project blockers.
- **Exit 1** (Linear failure; an `internal error:` prefix means a keiron-sequencer bug) or
  **Exit 2** (usage): show the stderr line, then the same DEGRADED banner with that
  reason instead of the key hint, and continue.
- **No exit code**: if the call is still killed by the caller, treat it like Exit 1:
  show the DEGRADED banner with the reason "graph CLI timed out", take dependencies
  from card text only, and continue.

Never print, echo or `cat` the key, `$LINEAR_API_KEY` or the key file. The CLI only
reads Linear; this skill writes nothing to Linear unless the user accepts a hygiene
fix.

**Spike record.** The JSON's `records.count` is the number of live spike records in
`~/.keiron-sequencer/<project.slug>/` for cards on this map; `records.invalid` is the
number of files there that could not be read (each is also a `record-invalid`
warning). Valid files for archived cards or cards not on this map (e.g.
`CRM-3918.json`) are ignored: neither counted nor invalid. Print at most one of these
lines for this project in this run, and continue:
- `records.count` 0 and `records.invalid` 0:
  > No spike record for <project> (`~/.keiron-sequencer/<project.slug>/` has no live record for this
  > map); ranking uses Linear and card text only.
- `records.count` 0 and `records.invalid` above 0:
  > Spike records unreadable for <project> (`~/.keiron-sequencer/<project.slug>/` has N invalid
  > files, see the warnings); ranking uses Linear and card text only.
- `records.count` 1 or more: no line; a card without a record has no `size.label`, so
  its size falls back as in Output.

A `data-in-repo` warning means the records are still in the plugin repo's old
`data/<project.slug>/` folder and `~/.keiron-sequencer/<project.slug>/` has none: show the
warning, and offer the dry run of
`node ${CLAUDE_PLUGIN_ROOT}/scripts/maintenance/move-data.mjs <project.slug>`; run it with
`--apply` only on the user's explicit yes.

In DEGRADED mode there is no JSON: check the folder with `ls` (Commands), taking
`project.slug` as the 12-hex suffix of the project URL, from `get_project` when the
argument was not a URL. No `*.json` file there gets the "no spike record" line (the
folder also holds `runs/`, which is not a record); a record file cannot be checked
without the CLI, so print nothing. In DEGRADED mode
no `size.label` is shown (the tier only appears inside the label), and no verdict tag.

## Critical Patterns

**1. GitHub is the truth; Linear lags.** Never rank from Linear states alone.
For every candidate-ish card, and every blocker of one, reconcile against PRs:

- PR merged (+ prod port if the repo uses `[Prod]` ports) → card is effectively
  done, whatever Linear says. As a *blocker*, merged to `development` is already
  enough to unblock (pattern 2).
- Draft PR exists → card is **taken** (someone's writing it). Never recommend it.
- Open non-draft PR → card is in review, not startable. Review latency is not a
  reason to start it again.
- The project may span **multiple repos** — a card's repo is its title prefix
  (`crm-backend: …`, `keiron-authorization: …`) or, when the title has none, the
  `Repo: <repo>` line in its description. Check PRs in every repo the candidate
  set names, not just the cwd's.

**1b. Local work counts as started, and GitHub cannot see it.** A card can be
underway with no commit, no push and no PR, as uncommitted edits in a worktree.
Before ranking, check every local clone of every repo the candidates name
(the parent folder of every `checkout` in `~/.keiron-sequencer/config.json`, which
holds the repo and extra clones such as `crm-backend-pr11`; not the session's cwd,
which may be an errand folder):

- A worktree or local branch whose name carries the card's id (`crm-XXXX-…`,
  Linear's `gitBranchName`) → **started**, even with zero commits ahead and
  only dirty files. Never recommend it.
- A pushed branch with no PR (`git ls-remote --heads origin 'crm-XXXX*'`) →
  started.
- In the output, state what was found (path, last activity, commits ahead,
  dirty files) so the user can tell live work from an abandoned spike. A stale
  local branch is still not a pick (pattern 5); mention it as closing-line
  material.

Verified on CRM-3884: Linear said `Todo` and GitHub showed nothing, but
`.claude/worktrees/crm-3884` held 10 uncommitted files from two days earlier,
so a GitHub-only check had recommended it.

**2. Dependencies = Linear blocks ∪ card text.** A card C's blockers are the union of:

- every `edges[].from` where `to == C`;
- `C.offMapBlockers`: open cards in another Linear project that block C;
- text dependencies from card descriptions (`list_issues`, or `get_issue` when a
  description is missing or truncated). Read the blockers' cards too, since
  `bloquea` / `habilita` / `Gates:` live on the blocker.
  A description may name a card as a Linear tag, `<issue id="…" label="CRM-B" …/>`:
  read the tag's `label` as the card id, the same as a plain `CRM-B`:

  | Text | Means |
  |---|---|
  | `Depende de CRM-B`, `espera a CRM-B`, `Necesita CRM-B` or `necesita CRM-B` on A | B blocks A |
  | `bloquea CRM-B`, `habilita CRM-B` or `Gates: CRM-B` on A | A blocks B |
  | `deployado en QA` on a dependency | it must be *merged and live*, not just merged |

A blocker named by both sources counts once. Milestone order is a soft dependency;
explicit text beats it. A text dependency is Linear-backed when `edges[]` links the
two cards directly or through a chain, or `danglingBlocks` holds it; otherwise it is
text-only: it still blocks, and it goes to Board hygiene as "move it to Linear".

`free[]` is the starting set from Linear state, not the verdict. Evaluate every open
unstarted card, and re-check each blocker under pattern 1:

- done in Linear → done;
- merged to `development` → done for unblocking, whatever Linear says: only missing
  code blocks, and the code is on `development`. If Linear still shows it open, the
  card silently unblocked and hygiene gets "blocker CRM-X merged, still open in
  Linear". If the repo uses `[Prod]` ports and the port is a draft or unmerged,
  hygiene gets "blocker CRM-X merged to development, [Prod] port pending". Such a
  blocker gets only the port line, not also "still open in Linear": until the port
  merges, a state short of Done (Self QA, say) is correct (Gotchas);
- open PR, ready or draft → the card is startable stacked on that PR's head branch
  (Gotchas), when exactly one blocker is open; a ready PR wins over a draft of the
  same blocker;
- no PR and exactly one branch carrying the blocker's id, pushed or only in the
  checkout → startable stacked on that branch, as `/keiron-sequencer:start` does.
  Several branches carrying its id: the card is startable once the user names one,
  which start takes as `--blocker-branch`;
- no PR and no branch → blocked;
- `deployado en QA` dependency merged but not live in QA → blocked.

When two or more blockers are open PRs or branches where neither contains
the other, the card waits: it is not a pick or the alternate, since no single base
carries both. Name those PRs under **Push these reviews**: their reviews unblock it.
If one branch contains the other (the PRs form one stack), stack on the top branch
instead. When exactly one blocker is an open PR, the single-stack rule above applies,
so the card drops back to it as soon as all but one of those PRs merge. Decide
containment from the PRs' head branches (Commands).

`offMapBlockers` go through the same re-check, with PRs looked up in the blocker's
own repo. A card whose off-project blocker still blocks is not offered as free: name
that blocker in the discards (its key, plus title and project via `get_issue`).

QA, planner (`map`, `map:design-delivery`), archived and canceled cards never block,
whether `danglingBlocks` or card text names them. Hygiene still lists the
`danglingBlocks` entries worth a look, told apart by `reason`: `archived` or
`canceled` (a stale block; remove it in Linear); `qa` or `planner` where that card is
the blocker (`offMap` equals `from`) and still `open` (a wiring mistake); and, for
information, `outside-project`: a map card that blocks an open card outside the project
(another project's work waits on it; if the block does not apply, remove it in
Linear). `open` alone does not mark a stale block: a block to a QA card that is done
is `open: false` too. A map card blocking its own QA card (`qa`, `offMap` equals `to`)
is normal wiring; leave it out.
"Its own" is a guess from the QA card's title (it names the map card or repeats its
title): `danglingBlocks` carries no parent link, so say it is a guess when you drop
one.

**3. The nearest deadline is a gate, not a tiebreaker.** A card's deadline is
its own due date or its milestone's target date, whichever comes first. Today is
the machine's local calendar date (`date +%F`), never the date part of `fetched`,
which is UTC. The graph JSON carries the answer as `cards[].deadline`: `overdue`
(before today), `soon` (within 7 days, today included) or null; in DEGRADED mode
pull `list_milestones` and the cards' `dueDate`, and compare every `targetDate` against today yourself. Writable
cards with an `overdue` deadline come first, then `soon` ones, then the rest, and
milestone order decides inside each: a card due today in milestone 4 comes before
milestone 3 when milestone 3 has no target date, while milestone 3 due in two days
still comes before a card in milestone 4 due in five. Never cross a deadline
because another card looks more strategic: "unblocks the most others" or a longer
critical path does not outrank a date. State the deadline and whose it is (the
card's or the milestone's) in the output so the user can overrule it deliberately.

Otherwise milestones go in `sortOrder`, dated or not: the JSON's
`cards[].milestoneOrder` is that order (1 = first), and cards with no milestone
come after all of them. A target date further away than a week does not move a
milestone ahead.

Passing over a card with an earlier deadline is legitimate only when it is not
writable: done, in review, started locally (pattern 1b), taken by a draft PR
(pattern 1), or blocked. Prove that card by card; never infer it from a
milestone's `progress` percentage. Name the deadline you passed over and why that
card is not writable; never skip it silently.

**4. Write-queue vs review-queue.** The current milestone being "unfinished"
does not mean its cards are startable: if everything left in it is awaiting
review, the next card comes from the next milestone or a parallel track — but
only after pattern 3's check. That crossing is normal — say so when it happens.

**5. The pick is always new, unstarted work.** This skill exists to *start a
card*. A card that already has a branch or PR is not a pick — including the
user's own parked, stale or conflicting draft — and neither is "get PR #N
reviewed". Those are closing-line material at most. If the only unstarted card
is a small one, recommend the small card; do not promote a resume job or a
review nudge to headline because it looks more substantial.

**5b. Never recommend a card assigned to someone else.** Only cards assigned
to the user (`assignee: "me"`; resolve with `whoami` if needed) or unassigned
are picks. Someone else's card is theirs even when it sits in `Todo` with no
branch or PR: they may have local work you cannot see (pattern 1b only reaches
the user's machine). Filter these out before ranking, not after. A milestone
whose only unstarted cards belong to others has nothing writable for the user,
so crossing forward is legitimate (pattern 3); say whose cards they are. If
the best candidate overall is someone else's, mention it in the discards as
"ask <name>"; never make it the pick or the alternate.

**6. Ranking**, after the filters (assignee 5b, started 1b/5, blocked 2) and the
argument constraints. The graph CLI ranks every open card before any filter
(`scripts/lib/next-order.mjs`): the pick is the card with the lowest `rank` among
those that survive. Finished cards carry `rank: null` and are never candidates.
Never re-derive the dates or the order. The keys, each deciding only when the
ones above it are equal:

1. Deadline (`deadline`, pattern 3): `overdue` first, then `soon`, then the rest.
2. Lower milestone order (`milestoneOrder`); cards with no milestone last.
3. Card due date (`due`): `overdue` first, then `soon` (due within 7 days, today
   included), then the rest. How late an overdue card is does not matter.
4. On the critical path: in `critical`, or a head listed in `criticalTies`.
5. Higher `downstream` (cards reachable through Linear blocks). Text-only
   dependents are not counted until they are moved to Linear.
6. Lower card number.

`rank` is a total order, so it hides ties: cards with the same
`deadline`, `milestoneOrder`, `due`, critical-path membership and
`downstream` are tied on keys 1–5. Refinements act only inside such a tie and
override only key 6; they never move a card across a milestone, due-date,
critical-path or downstream difference:
- A card self-marked elastic ("se puede diferir", "carta elástica", "Diferido")
  drops below the cards it ties with.
- A card with a file-area conflict with an in-flight PR (don't send two PRs into
  `AuthContext.tsx` at once; stacking is a decision, not a default) drops below the
  cards it ties with, only if a non-conflicting card exists in that tie.

Cards still tied on keys 1–5 are shown as a tie, naming each one and stating that
the lower number won. Parallel tracks (B0/B1-style) count as candidates on equal
footing — they exist to absorb slack when the main track is review-bound.

In DEGRADED mode there is no `rank`: apply keys 1–3 and 6 yourself from MCP data
(`targetDate` and `sortOrder` from `list_milestones`, `dueDate` from `list_issues`,
today as in pattern 3). Keys 4–5 do not exist; say so. Use the text rule in their
place: tracer bullets and cards whose description says they `habilita` others
outrank their siblings.

**7. Recommend one card + one alternate in a different area** (frontend vs
backend, or different file zone), so the user can keep a second front open.
The alternate is the next-ranked card (pattern 6 order) in a different area:
prefer a different repo, else a different file zone; say which. When no
frontend card is free, a different backend file zone counts as a different
area; say so in the output.

## Output

- **Graph** (one line): project name, critical path (`CRM-A → CRM-B → …`, plus
  `criticalTies` if any), both counts out of `summary.open` open cards (e.g. `14
  free in Linear, N startable after reconciliation`: the `free[]` length, then
  what is left after patterns 1–5b), fetch time, and the date used as today
  (always: the milestone gate and the card due dates are both read against it,
  pattern 3). In DEGRADED mode:
  `Graph: DEGRADED — Linear blocks not read (<reason>)`.
- **The pick**: `CRM-XXXX — title`, base branch (note if it must stack on an open
  PR's branch, with the two stacking costs), why it's next (deps satisfied, Linear
  and text; the rule that chose the milestone, one of
  `deadline <date> (<card or milestone>)`,
  `milestone order (<name> is the first with writable work)` or
  `no milestone (no milestone has writable work)`, plus any earlier deadline
  passed over (pattern 3); the card's `dueDate` and `due` when it has one; critical
  path; what it unblocks via `downstream`; any tie), and its size (`size.label`
  when non-null, else the Linear `estimate` (rough size), else "no size"). A `size.label` reads `L · 412 lines`: the tier is
  relative to this project's spiked cards and comes from the CLI's `cards[].size`,
  never from a record file. In `1109 lines · existing PR`, "existing PR" comes from
  the spike record's origin (the trial copied a real PR), not from GitHub; PR
  reconciliation (patterns 1 and 1b) still decides whether the card is taken. Next
  to the size, print the verdict tag `<tier> · <verdict>` built from `size.tier` and
  `size.verdict` when `size.tier` is non-null (e.g. `XL · SDD`, `L · Light`,
  `S · No SDD`); a verdict of `unknown` is shown literally, never replaced by `No SDD`
  (`L · unknown`). No tag in DEGRADED mode or for existing-pr cards (their tier is
  null). Never show effort or `timeBox`.
- **The alternate**, one line: the next-ranked card in a different area, its size
  (`size.label` when non-null, else the Linear `estimate` (rough size), else "no
  size"), its verdict tag as in the pick, and
  whether that is a different repo or only a different file zone (say so when it is
  only a different backend file zone, pattern 7).
- **Discards** worth naming: off-project blockers, someone else's card ("ask
  <name>"), started local work.
- **Overdue elsewhere**, only if found: every candidate (it passed the filters:
  yours or unassigned) with `due: "overdue"` in a milestone other than the pick's,
  or in no milestone, with its due date and milestone. Never skip one silently;
  someone else's overdue card is not listed.
- **Push these reviews**, only if a card waits on two or more open PRs on separate
  branches (pattern 2): the card, and each PR whose review unblocks it (`#N`, repo,
  title). Closing-line material, never the pick or the headline (pattern 5).
- **Board hygiene**, only if found: stale Linear states vs PR reality ("blocker
  CRM-X merged, still open in Linear"), blockers merged with the port still open
  ("blocker CRM-X merged to development, [Prod] port pending"), every `backward-milestone`
  warning (a blocks edge from a card in a later milestone to one in an earlier milestone:
  move a milestone, or remove the edge if it is no hard dependency), cards with no milestone
  (list them and recommend assigning one in Linear before a respike, which plans by
  milestone), deps that
  silently unblocked, text-only deps ("move it to Linear: CRM-A blocks CRM-B"),
  `cycles`, the `danglingBlocks` pattern 2 lists (stale
  blocks to archived or canceled cards; open QA or planner cards blocking a map
  card; for information, a map card that blocks an open card outside the project),
  truncation warnings. Implied blocks are not hygiene; mention them
  only if the user asks for cleanup. Offer to fix; don't fix unprompted.
- **Decision packs**, when the project has spike records: offer to draft them
  for the startable frontier, so the people-owned open decisions are answered
  in one sitting and the work later runs without stopping. `packs.mjs draft`
  writes one pack per frontier card (blockers all done) that has a
  people-owned open or narrowed decision, never for a descendant: its
  questions change when its parent lands. Each question carries what the
  spike already ruled out (`evidence`); add the options still standing.
  `packs.mjs status` lists each pack as `fresh`, `unanswered`, or `stale` with
  its reason (`card-text`, `record` or `base`): draft a stale one again, which
  keeps the answers to questions asked in the same words. Ask the user each
  open question, then record the answer with `packs.mjs answer`, stated as
  outcomes, not mechanisms ("no patient data reaches an internal user without
  a grant", not "return 403"): /keiron-sequencer:start carries them as binding
  requirements. Never answer a question for the user.
- End with: start it via `/keiron-sequencer:start CRM-XXXX`.

## Commands

```bash
# Graph (Step 0). Exit 0 JSON; 1 Linear/internal error; 2 usage; 3 no key.
node ${CLAUDE_PLUGIN_ROOT}/scripts/graph.mjs "<project-ref>"

# Decision packs (Output). draft and status read Linear (exit 3 with no key); answer reads only the pack.
node ${CLAUDE_PLUGIN_ROOT}/scripts/packs.mjs draft <project-ref>
node ${CLAUDE_PLUGIN_ROOT}/scripts/packs.mjs status <project-ref>
node ${CLAUDE_PLUGIN_ROOT}/scripts/packs.mjs answer <slug> <CARD> <question id> --outcome "<the outcome>"

# Spike record: no output = no record file.
ls ~/.keiron-sequencer/<project.slug>/*.json 2>/dev/null | head -1

# Linear side (MCP): list_issues on the project with
#   fields: id,title,description,labels,projectMilestone,status,dueDate,assignee
#   — orderBy createdAt. Descriptions often come back truncated:
#   fetch the full description with `get_issue` for every open card whose description came back truncated,
#   candidates and their potential blockers alike (`bloquea` / `habilita` / `Gates:`
#   live on the blocker's card); skip only done, canceled or archived cards.
# whoami for the assignee filter: the graph JSON has no assignee. The JSON
# carries `milestoneTargetDate`, `dueDate`, `due`, `deadline` and `rank`; list_milestones
# (targetDate) and the dueDate field are needed only in DEGRADED mode.

# PR reality, one search per card id (candidates and their blockers), each run
# in the card's own repo (its title prefix, else the `Repo:` line in its description).
# state=all catches merged & drafts; a per-card search also
# finds old PRs that a "latest N" listing misses. --search also matches a PR
# number or body, so keep only hits whose title carries the card id in any bracket
# style ([CRM-XXXX] or (CRM-XXXX)); drop hits matched only by PR number.
# The filter reads the card id from the environment, so it stays one
# single-quoted string; never splice the id into it (a double-quoted filter
# breaks in a zsh loop). For several cards: `for CARD in CRM-A CRM-B; do … done`.
export CARD=CRM-XXXX
gh pr list --repo Keiron-HealthTech/<repo> --state all --search "$CARD" \
  --json number,state,isDraft,mergedAt,baseRefName,headRefName,title \
  -q '.[] | select(.title | test("[\\[(]" + env.CARD + "[\\])]"; "i")) | "\(.number) [\(.state)\(if .isDraft then "/DRAFT" else "" end)] base:\(.baseRefName) head:\(.headRefName) \(.title)"'

# When a card's repo is unknown, cross-check across the org with `gh search prs`,
# same title filter; then run the per-repo search above in each repo it names:
gh search prs --owner Keiron-HealthTech "$CARD" --match title \
  --json repository,number,title \
  -q '.[] | select(.title | test("[\\[(]" + env.CARD + "[\\])]"; "i")) | "\(.repository.nameWithOwner) #\(.number) \(.title)"'

# Two open-PR blockers (pattern 2): does one head branch contain the other?
# A PR whose base is the other PR's head is stacked on it. Otherwise compare the
# heads: "ahead" or "identical" = headB contains headA, "behind" = headA contains
# headB, "diverged" = neither (the card waits).
gh api repos/Keiron-HealthTech/<repo>/compare/<headA>...<headB> -q .status

# Match PRs to cards by the [CRM-XXXX] or (CRM-XXXX) tag in PR titles;
# Linear attachments on each card are the fallback when titles don't carry it.

# Local work (pattern 1b), per clone of each repo the cards name. IDS is the
# candidate ids, lowercased and |-joined, e.g. "crm-3883|crm-3884|crm-3885":
# Sibling folders like crm-backend-pr11 can be worktrees of one repo; dedupe on
# the common git dir or every hit prints once per folder. Hits are labelled with
# the repo the common dir belongs to, not the folder that was visited first.
CONFIG="${KEIRON_SEQUENCER_HOME:-$HOME/.keiron-sequencer}/config.json"
PARENTS=$(node -e 'const c = require(process.argv[1]); const h = require("os").homedir()
  console.log([...new Set(Object.values(c.repos).filter(r => r.checkout)
    .map(r => require("path").dirname(r.checkout.replace(/^~/, h))))].join("\n"))' "$CONFIG")
seen=" "
for d in $(for p in $PARENTS; do printf '%s\n' "$p"/*/; done); do
  c=$(cd "$d" 2>/dev/null && cd "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null && pwd) || continue
  case "$seen" in *" $c "*) continue;; esac; seen="$seen$c "
  r=${c%/.git}
  git -C "$d" worktree list | grep -iE "$IDS" | sed "s|^|$r wt: |"
  git -C "$d" for-each-ref --format='%(refname:short) %(committerdate:relative)' \
    refs/heads refs/remotes | grep -iE "$IDS" | sed "s|^|$r br: |"
done
# For each hit: commits ahead (git log --oneline origin/development..<branch>)
# and dirty files (git -C <worktree> status --porcelain).

# Pushed branch with no PR:
git -C <checkout> ls-remote --heads origin 'crm-XXXX*'
```

## Gotchas

- **A card blocked by an *open* PR is startable now, stacked on that PR's head
  branch** — it does not have to wait for the base to merge. Verified on
  CRM-3451, opened on `crm-3285-…` while #2569 was still in review: the PR shows
  only the card's own diff (1 file) instead of the 55 files a `development` base
  would have carried. Two costs to state at pick time so the user can choose
  stack-now vs hold: a stacked PR gets **no Amplify preview** (only closing and
  reopening it against `development` provisions one afterwards), and the
  auto-rebase never touches it when the base merges — retarget and rebase by
  hand, bottom-up. This is the single-blocker case: with two or more open-PR
  blockers on separate branches the card waits instead (pattern 2).
- A **draft** or branch base is stackable but costs more; name the cost with
  the pick. A draft must be marked ready and merge before this one; a branch
  with no PR opens its PR first, and this one targets it; a branch only in the
  checkout: push it before pushing this branch. A base that is still moving is
  a bad base, since the stack rebases under you: between two otherwise equal
  cards, prefer the one whose base is a ready PR.
- "Done" for QA-state purposes follows the team flow (In Review → Approved →
  Self QA → Peer QA → Done); merged-to-development ≠ Done if the repo ports
  to `main` for prod. For unblocking another card, merged to `development` is
  enough (pattern 2).
- Cards labeled Discovery or with "No lleva PR" are never the pick — the
  project convention is one card = one PR.
- keiron-planner's tickets are never the pick either: label `map` is a decision
  ticket, resolved with `/map-work`, and `map:design-delivery` is closed by
  Design. Neither becomes a branch.
- QA sub-cards (label QA, or a title `QA` / `QA: …`) are never the pick. The graph
  already drops planner, QA, canceled and archived cards, but card text and MCP
  lists can still surface them; apply these rules to those too.
- The CLI breaks critical-path ties by the highest card number, which is
  arbitrary for ranking: a `criticalTies` head is as much on the critical path as
  `critical[0]`.
- `downstream` counts only cards on this project's map; work a card unblocks in
  other projects is not counted.
