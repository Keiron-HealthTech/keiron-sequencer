---
name: harvest
description: >
  Turn what the spikes learned into Linear: curate the blocks relations, new
  cards and agent notes for a project in ~/.keiron-sequencer/<slug>/harvest/harvest.json,
  translate the acceptance cases into Spanish, compute a hash-bound plan
  against live Linear and present it for review. Writes to Linear only when the
  user gives the apply command with the plan hash.
  Trigger: "sequencer harvest", "harvest the spikes", "write the map to Linear",
  "cosechar el mapa", or after a batch of spike records lands.
license: Apache-2.0
metadata:
  author: keiron
---

# keiron-sequencer harvest

The CLI is `node ${CLAUDE_PLUGIN_ROOT}/scripts/harvest.mjs`. It never calls an LLM:
you write the curated input and the Spanish translations, the CLI computes the
plan and, only on the user's command, writes it.

## Safety rules

- **never apply without the user's command and the hash.** A plan review is not
  approval. Run `apply` only when the user's own message asks for it and carries
  the plan hash (or its first 12 or more hex characters). Do the same for `undo
  --approve`: it needs the user's command and the run id.
- Never print, cat or copy the Linear key. The CLI reads `LINEAR_API_KEY`, else
  `~/.config/keiron-planner/linear.key`, and redacts it from every output.
- Never edit `plan.json` by hand: `apply` recomputes the hash and refuses an
  edited plan. Change the inputs and run `plan` again.
- Files live in `~/.keiron-sequencer/<slug>/harvest/`, next to the records, outside
  every repo: `harvest.json` and `notes.es.json` (inputs, kept), `plan.json`
  and `plan.md` (rewritten by each `plan`), and `applied.jsonl` (append-only
  audit trail and the undo source, kept). They are personal: Linear is the
  only shared surface.

## Step 1: Draft

`node ${CLAUDE_PLUGIN_ROOT}/scripts/harvest.mjs draft <slug>` reads the spike records
only (no network, no key) and prints draft `code` edges from fixups and draft
splits from `alias.splitFrom`. Every draft carries `"draft": true`. Pairs
already in `edges`, `removals` or `rejected` are left out.

## Step 2: Curate

Write `~/.keiron-sequencer/<slug>/harvest/harvest.json` (`schemaVersion: 1`, `project.slug`).

- `edges[{from, to, kind, evidence}]`: `kind` is `code`, `deploy` or `gate`. A
  `deploy` or `gate` edge needs none of the blocker's code: the plan writes
  "Sale después de <blocker>: no necesita su código." into the blocked card's
  notes, under «Orden con otras tarjetas», and /keiron-sequencer:next and
  /keiron-sequencer:start read it as a gate on merging and deploying instead
  of a blocker to stack on. A Linear relation with no such line is a `code`
  dependency, so list a hand-made relation that only orders shipping here
  with its kind (it is kept, and gets the line). Every kind still orders the
  cards, for the backward-milestone, redundant and unordered-reference checks;
  `evidence` is required. Copy a draft only after checking it, and drop its
  `"draft": true` (a draft entry is rejected).

An edge needs a hard dependency: the blocked card cannot build, pass its own
tests or deploy without the blocker. Two traps make edges that are not:

- A card that only touches the same file as another card has no dependency:
  whichever merges second rebases. When a decision of the blocked card uses
  code the blocker adds ("updateDeal calls FlowRestrictionService"), the
  card cannot build without it: that is an edge.
- A fixup draft is evidence only when the later card needed the earlier
  card's code. Read the fixup's note in the draft's `evidence`: a fixup that
  only repaired the earlier card's own patch (a stale replay, a type-check
  after a rebuild, a shared rename) while the spike was on another card is no
  dependency, so list the pair under `rejected` and reject it with that reason.

Never add an edge a chain already implies, even with real code evidence: if
A blocks B and B blocks C, then A blocks C adds nothing, because the chain
already orders the cards. The plan refuses one as `redundant`, naming the
chain, including a chain made only of this plan's own adds; drop the edge, or
list it under `rejected` with the reason "redundant". When the plan's adds
make an edge that is already live in Linear redundant, the plan warns
`live-redundant`, naming that live edge: it was someone's call, so propose its
removal (in `removals`) to the user instead of dropping it yourself.

Milestones are deliverables, in order: an edge never runs backward, from a
card in a later milestone to one in an earlier milestone. The plan refuses
one as `backward-milestone`, naming both cards and their milestones. A
`backward-milestone` refusal is the user's call, never yours: an earlier
card that needs a later card's code is usually in the wrong milestone. Show
both cards, their milestones and the evidence, and ask whether to move a
milestone in Linear or to reject the edge. A card with no milestone is not
checked: assign it one first.

A pair you leave unblocked can still be an order someone has to know. The
plan refuses a `rejected` or `removals` entry as `unordered-reference` while
a case, decision, open decision or finding of either card names the other
card, unless either card is done or canceled or a chain of relations already orders them. Keep the edge, or give the
entry an `order`: one Spanish line saying what each card does if the other
lands first ("Si CRM-3887 llega primero, CRM-4070 usa su servicio; si no,
CRM-3887 pasa updateDeal al servicio."). The plan writes it into both cards'
agent notes, under **Orden con otras tarjetas**, even for a card outside
`notes`. When a named decision is spike bookkeeping (how a patch was
replayed), fix the record instead. Removing an `order` later does not clear
the line from a card with no record: edit that block by hand.

When the card that names the other sits in the earlier milestone, the plan
also gives a `backward-reference` warning, even with an `order`: the card
may be in the wrong milestone. Take it to the user like a
`backward-milestone` refusal.
- `removals[{from, to, reason, order?}]`: only listed relations are removed; a live
  relation that is not listed stays.
- `splits[{parent, new, parentHalf, newHalf, evidence}]`: review only. The
  parent keeps its ID; write the halves' relations explicitly in `edges` and
  `removals`.
- `newCards[{key, title, repo, milestone, description, evidence, blocks, team?}]`:
  refer to them as `new:<key>`. Cards created by hand are referenced by
  identifier, never as new cards. `team` defaults to the project's only team.
- `rejected[{from, to, reason, order?}]`: pairs looked at and refused.
- `hold: "<decision>"` on an entry lists it as held and never writes it.
- `notes`: `"all"` or a list of card keys whose acceptance cases, decisions
  and open decisions go into the agent notes block. Linear is the only shared
  surface, so a teammate with no record reads them there. A card the respike
  audited publishes only what holds: an item marked `moved`, `not-built` or
  `dropped` is left out (an item with no audit mark holds), and a card where
  nothing holds has its block removed. Linear says what each card builds now,
  never where an item went: the card that owns a moved item publishes it in
  its own notes, and the record keeps every item, marked.
- **Started cards are left alone.** A card has started when Linear moved it
  past Backlog, Todo and Triage, a PR carrying its key is open or merged, or a
  branch carrying its key is pushed. The plan writes no notes and no
  description on such a card, whatever asks for it (`notes`, an order line, a
  "Sale después de" line or a `descriptions` entry): its text may have been
  corrected by hand to match what shipped, and the record would revert it.
  Relations are still added and removed on any card. The plan reads the PRs
  and pushed branches of the project's repos from the spike config; with no
  config only the Linear states decide (a `github-unread` warning), and a
  read that fails counts every card Linear calls unstarted as started.
- `writeStarted`: a list of started cards whose notes and description entry
  are written anyway, on the user's yes for each card (for a built card whose
  record the respike audit just corrected). The review marks each such op
  `started`.
- `descriptions`: `{ "<CARD>": { "text", "evidence", "hold"? } }`, a new
  text for the part of a card's description people wrote, usually the
  respike audit's proposal (`description` in the record's `audits`). Add an
  entry only on the user's yes to that text. `text` is Spanish and holds no
  agent notes block and no `+++` line; the plan keeps the card's notes block
  (the new one when the card is in `notes`) and any keiron-sequencer marker,
  and writes the whole description in one `description.replace` op. Once
  that op is applied, remove the entry: left in, it would undo a later hand
  edit of the card on the next plan.

A card outside the project may be one end of an edge when it exists and is not
archived; the review marks it off-project.

## Step 3: Cases

`node ${CLAUDE_PLUGIN_ROOT}/scripts/harvest.mjs cases <slug>` (no network, no key)
lists every selected item whose Spanish text is `missing` or `stale`, with its
`source` hash: `cases` with the English given/when/then, and the record's
`decisions` and `openDecisions` with their English `text`. A decision's id is
`d1`, `d2`… and an open decision's `o1`, `o2`…, by position in the record, so a
reordered list shows the moved items as `stale`. An item the respike audit marked
`moved`, `not-built` or `dropped` is not listed: it is not published.

## Step 4: Translate

Write `~/.keiron-sequencer/<slug>/harvest/notes.es.json`:
`{ "schemaVersion": 1, "cards": { "CRM-123": { "c1": { "source": "<hash from cases>", "es": "Dado …, cuando …, entonces …." }, "d1": { "source": "<hash>", "es": "…" }, "o1": { "source": "<hash>", "es": "…" } } } }`.
Each `es` is one non-empty line, not a heading, and never contains `+++`.
Translate an open decision's question only: the block adds how it stands. Run
`cases` again until it lists nothing. If there are too many items, ask the
user to narrow `notes`.

## Step 5: Plan

`node ${CLAUDE_PLUGIN_ROOT}/scripts/harvest.mjs plan <project-ref>` (the word `plan`
is optional). The ref is the project URL, slug, UUID or identifier. A slug or
URL is validated before any request. A UUID or identifier such as `P-CRM-371`
costs exactly one read-only project query to learn the slug; then
`harvest.json` and `notes.es.json` are validated, and Linear is read further
only if they are valid. It also reads `gh pr list` and `git ls-remote` for the
project's repos, to tell which cards have started. The plan never writes to Linear.

stdout is one JSON line: `{status, plan, review, hash, counts, refusals}`.

- **Exit 0**: `status: "written"`; `plan.json` and `plan.md` are written.
- **Exit 1**: Linear failed (one line on stderr). A line starting with
  `internal error:` is a keiron-sequencer bug: report it, do not retry blindly.
- **Exit 2**: usage. Fix the command.
- **Exit 3**: no usable key. Tell the user where the CLI looks; never ask them
  to paste the key into the chat.
- **Exit 4**: plan refused: invalid input, a conflict, a cycle that a planned
  add closes, `backward-milestone`, `redundant`, `unordered-reference`, or `needs-translation`. No `plan.json` is
  written (a stale one is removed); `plan.md` lists the refusals. Fix the input and plan again; take a
  `backward-milestone` to the user first.

## Step 6: Present the review and STOP

Show the user `plan.md`: the hash, warnings (`live-redundant` edges, untouched live
cycles), new cards (they cannot be undone), splits, relations to add and
remove, the agent notes blocks, the descriptions with their text before and
after, the cards under "Not written: card started" (each with why it counts
as started and how many lines would change: ask the user whether to name it
in `writeStarted`, never add it yourself), the unchanged and held counts, and
the exact apply command. Each notes block starts with `+++ Notas del agente` and holds
up to three sections, in this order: «Casos de aceptación», «Decisiones» and
«Decisiones abiertas». An open decision ends with `(abierta, la deciden
personas)` when people own it, `(acotada)` when the code narrowed it, `(antes
de mergear o desplegar)` when it is a gate, combined as `(acotada, la deciden
personas)` or `(antes de mergear o desplegar, la deciden personas)`. A block under the old title, `+++ Notas
del agente (casos de aceptación)`, is replaced, not duplicated. For a card
the respike audited, the review's evidence under its block names the items
that moved and where, and the ones left out; none of that is written to
Linear. Then STOP and wait. Do not apply on your own initiative, after a
silence, or because an earlier message approved a different plan.

## Step 7: Apply or undo, only on the user's explicit command

Apply, when the user's message asks for it with the hash:
`node ${CLAUDE_PLUGIN_ROOT}/scripts/harvest.mjs apply <project-ref> --plan <plan.json> --approve <hash>`

It re-reads Linear, checks every op before the first write, writes in the order
new cards, added relations, removed relations, notes, descriptions, reads each
change back, and appends one line per op to `applied.jsonl`.

- **Exit 0**: every op applied or already in place (`skipped`).
- **Exit 1**: a write failed or did not show up when read back; it stopped
  there. Running the same apply command again continues from where it stopped
  and never duplicates a card or a relation.
- **Exit 5**: approval refused: no `--plan` or `--approve`, a hash that does
  not match, an edited plan, or a ref for another project. Nothing was sent.
- **Exit 6**: Linear changed since the plan (drift) and nothing was written.
  Run `plan` again and present the new review.

Undo, when the user asks for it:
`node ${CLAUDE_PLUGIN_ROOT}/scripts/harvest.mjs undo <project-ref> --run <run id>`
lists what it would do and writes nothing (an unknown run id exits 4). Adding `--approve <run id>`, with
the user's command and the run id, deletes the relations that run created and
recreates the ones it removed. New cards must be archived by hand, agent
notes are restored by hand from the block it prints, and a description from
the `description` it prints.
