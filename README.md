# keiron-sequencer

A Claude Code plugin that sequences a Linear project's cards. It spikes every open
card in throwaway trees, writes what the spikes learned back to Linear, picks the
next card to start, starts it on the right base, and plans the next cycle.

## Skills

| Skill | What it does |
|---|---|
| `/keiron-sequencer:spike` | Runs a thin spike pass over every open execution card of a project, in dependency order, in throwaway trees, with no commits. Writes one record per card. |
| `/keiron-sequencer:respike` | Spikes a project again: drops the cards already built, bases every repo on what is built, replays old patches at no token cost and re-spikes the rest. Before the run, it checks each built card's record against its PR or branch, and you hand each gap to a card the run spikes or drop it; after the run, it checks every card it left alone against the fresh records, marking each item as holding, moved to another card, not built or dropped. |
| `/keiron-sequencer:harvest` | Turns the spike records into Linear: blocks relations, new cards, and agent notes with acceptance cases, decisions and order notes, publishing only what a card still builds. Rewrites a card's description only from a text you approved. Writes only on your command with the plan hash. |
| `/keiron-sequencer:next` | Recommends the next card to start: the nearest deadline first, then milestones in order, from the first with writable work, checking GitHub PRs and local branches. Reports the startable cards whose decision pack is unanswered or stale, and asks none of its questions. |
| `/keiron-sequencer:start` | Starts one card: reads its record and blockers, picks the base branch (stacking on a blocker's PR or branch when needed), creates the branch, then drafts the card's decision pack, asks its open questions and saves the answers. A card with no Linear project starts too, without the record and the pack. |
| `/keiron-sequencer:cycle` | Plans the next Linear cycle: carry-over first, then cards in `/next` order, sized from the spike records and shared by availability. |

## How they fit together

1. **Spike once.** `/keiron-sequencer:spike` on a project with no records. The
   first run drafts the config and asks you to confirm one line per repo.
2. **Harvest.** `/keiron-sequencer:harvest` after every spike or respike pass.
   Spikes only write local records; harvest is what puts their blocks relations,
   new cards and agent notes into Linear, where the rest of the team sees them.
3. **Next, then start.** Each time you finish or park a PR, `/keiron-sequencer:next`
   picks the card and `/keiron-sequencer:start` creates its branch.
4. **Cycle.** At cycle planning, `/keiron-sequencer:cycle`.
5. **Respike when the records go stale.** When start reports a card's record
   stale, or new cards were added to the project, run `/keiron-sequencer:respike`.
   It checks the built cards against their PRs first, re-spikes only what
   changed and replays the rest, then audits the open cards it left alone, so
   a card's notes stop claiming scope that moved elsewhere. Then harvest
   again.

Respike refreshes the records and never writes to Linear; harvest writes to
Linear and never spikes.

The plugin also ships a spike metro pane (`/spike-metro`) that shows a running spike
pass as a metro line, and a status line that turns on once `/keiron-sequencer:start`
creates or resumes a card's branch in a session: the card, its route, the blocker it
stacks on and the decisions still open in its pack (`ABC-7 · sdd · stacked on ABC-6 ·
2 open decisions`). Both are a hooks module, so they need Claude Code's mods feature;
the skills work without them.

## Install

```
/plugin marketplace add Keiron-HealthTech/keiron-sequencer
/plugin install keiron-sequencer@keiron-sequencer
```

## Setup

- **Node 22** and the **GitHub CLI** (`gh`), signed in.
- **A Linear key**, in `LINEAR_API_KEY` or in `~/.config/keiron-planner/linear.key`
  (the same file keiron-planner's `/keiron-planner:planner-setup` writes). The
  skills never print it.
- **Nothing to write by hand for the config.** On a project's first spike,
  `/keiron-sequencer:spike` reads each card's repo from Linear, finds your
  checkouts next to the one you run it in, and asks you to confirm one line per
  repo (`api → ~/src/api`). It reads the rest from each checkout
  and writes `~/.keiron-sequencer/config.json` on your yes. The shape is
  [docs/spike-config.example.json](docs/spike-config.example.json).
- **Edit access** to `~/.keiron-sequencer` in Claude Code (`/add-dir ~/.keiron-sequencer`)
  before the first spike.

## Your data stays local

Spike records, patches, harvest inputs and plans live in `~/.keiron-sequencer/<slug>/`
(or `$KEIRON_SEQUENCER_HOME`). They are personal to whoever spikes and never go into
this repo. Linear is the only shared surface: what others need from a spike reaches
them through the harvest's agent notes.

## Development

```
node --test --test-concurrency=1
```

The tests are hermetic: no network, no real Linear, GitHub or checkouts. Load a
working copy with `claude --plugin-dir <path>`. Bump `version` in
`.claude-plugin/plugin.json` for every release, or installed copies will not update.
