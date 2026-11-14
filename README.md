# keiron-sequencer

A Claude Code plugin that sequences a Linear project's cards. It spikes every open
card in throwaway trees, writes what the spikes learned back to Linear, picks the
next card to start, starts it on the right base, and plans the next cycle.

## Skills

| Skill | What it does |
|---|---|
| `/keiron-sequencer:spike` | Runs a thin spike pass over every open execution card of a project, in dependency order, in throwaway trees, with no commits. Writes one record per card. |
| `/keiron-sequencer:respike` | Spikes a project again: drops the cards already built, bases every repo on what is built, replays old patches at no token cost and re-spikes the rest. |
| `/keiron-sequencer:harvest` | Turns the spike records into Linear: blocks relations, new cards, and agent notes with acceptance cases, decisions and order notes. Writes only on your command with the plan hash. |
| `/keiron-sequencer:next` | Recommends the next card to start, from the earliest milestone with writable work, checking GitHub PRs and local branches. |
| `/keiron-sequencer:start` | Starts one card: reads its record and blockers, picks the base branch (stacking on a blocker's PR or branch when needed) and creates the branch. |
| `/keiron-sequencer:cycle` | Plans the next Linear cycle: carry-over first, then cards in `/next` order, sized from the spike records and shared by availability. |

The plugin also ships a spike metro pane (`/spike-metro`) that shows a running spike
pass as a metro line. It is a hooks module, so it needs Claude Code's mods feature;
the skills work without it.

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
