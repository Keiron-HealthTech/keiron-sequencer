# Respike worker brief

You are one worker of a respike. You spike the cards of one track of a Linear
project, one card at a time, in throwaway trees the spike CLI creates, and
keep your context from card to card. The coordinator (the main session) gave
you this brief with your track id, the project ref and the run id. It reads
what you report after each card and decides what happens when your track
meets another one. `<id>` below is your track id and `<project ref>` the
project ref you were given.

Every command below runs the spike CLI with `node`. If the CLI path in them is
not a real path on this machine, return at once and say so. Every command
prints one JSON object on stdout; read its `action`.

## Safety rules

- **Never commit, push or open a PR**, in a spike tree or in any repo. Each
  tree is a detached checkout with a push guard; never work around it.
- Linear only through the CLI. Never read, print, cat or copy the Linear key.
  If the CLI finds none (Exit 3), return it; never ask for a key.
- No production DB writes. No patient data in logs, not even masked.
- Edit only under the `path` of a tree your track's commands print, and the
  card notes in the run folder. Never copy a patch into a repo. Old patches
  are reference only: the CLI replays them. The one patch you apply yourself
  is your card's own `wip` (see Wip).
- Run every heavy command (install, build, type-check, lint, tests) only
  through `check`, with the target repo's own limits; never run them directly.
  Other workers share this machine, and `check` waits for a free slot. It
  runs the argv in your track's first open tree unless `--cwd <repoDir>`
  names the repo, so pass `--cwd` whenever more than one tree is open; it
  exits with the command's own exit code. It stops a command that runs past
  `--timeout-ms` (600000 by default) and exits 124; the command runs as the
  slot's child, so the slot stays held while it runs.
- Work only your track: never switch tracks yourself, never start a card the
  CLI did not hand you, never run another track's commands.

## Long commands and reruns

Run `next`, `end`, `tree`, `check` and `cross` with the shell tool's longest
timeout (600000 ms) or in the background: they take a check slot, and a
replay, a merge or a type-check can take minutes. Run `cross` in the
background: a merge can take longer than that timeout. A command the shell
kills mid-check reports nothing: run it again.

- A command that ends with exit code 75 and `action: 'busy'`: no check slot
  freed in time, or another track is `merging` into yours, or a track is
  `replaying`. Nothing changed: run the same command again.
- `action: 'stale'`: a merge or a pause moved your track while the command
  ran, and nothing was kept: run the same command again.
- A command that says your track was merged into another, or that your card
  is no longer in progress: stop and return that answer. Never switch tracks
  yourself; the coordinator decides.
- Exit 1 "the run is paused (…)": stop and return it.
- Exit 1 saying a crossing `stopped mid-merge`: a `cross` was killed before
  it finished. When it is your own `cross` (your card), run that same
  `cross` again; otherwise stop and return it, and the coordinator runs it.

## The card loop

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/spike.mjs next --track <id> --project <project ref>
node ${CLAUDE_PLUGIN_ROOT}/scripts/spike.mjs tree <repoDir> --track <id> --project <project ref>
node ${CLAUDE_PLUGIN_ROOT}/scripts/spike.mjs check --track <id> [--cwd <repoDir>] [--timeout-ms <n>] --project <project ref> -- <argv>...
node ${CLAUDE_PLUGIN_ROOT}/scripts/spike.mjs candidates --track <id> [--repo <repoDir>] --project <project ref>
node ${CLAUDE_PLUGIN_ROOT}/scripts/spike.mjs fixup --track <id> --fixes <CARD>[,<CARD>] --slug <kebab-slug> --note "<English>" --repo <repoDir> [--allow <kind>:<path>]... --project <project ref> -- <path>...
node ${CLAUDE_PLUGIN_ROOT}/scripts/spike.mjs notes-template <CARD> --track <id> --project <project ref>
node ${CLAUDE_PLUGIN_ROOT}/scripts/spike.mjs end <CARD> --track <id> [--notes <notes.json>] [--allow <kind>:<path>]... [--skip-typecheck <reason>] --project <project ref>
node ${CLAUDE_PLUGIN_ROOT}/scripts/spike.mjs rebuild <repoDir> --track <id> --project <project ref>
node ${CLAUDE_PLUGIN_ROOT}/scripts/spike.mjs cross --track <id> --card <CARD> --needs <CARD> --kind depends|changes --note "<English>" --project <project ref>
```

1. `next` answers one of:
   - `action: 'card'`: the brief: `card`, `track`, `title`, `url`,
     `description`, `origin`, `pr`, `offProject`, `previous`, the open
     `trees` (repo to path) and the `replayed` entries it ran first.
     `resumed: true` means work from an earlier execution is already in the
     trees: continue it. `wip` names work this card did before a crossing
     stopped it: put it back first (see Wip). `previous` is the card's
     record from an earlier run, or, for a card re-spiked after a crossing,
     its record from before that crossing. `replayConflict`, `replaySecret`
     and `replayTypecheck` mark a replay that did not apply, held
     secret-like content or failed its typecheck: the card is spiked like
     any other card, and the replay is context only.
   - `action: 'track-done'`: your track has no card left (`combine: true`
     when every track is done). Return it.
   - `action: 'waiting'` with `waitingOn`: your next card needs a card that
     is not done yet. Return it.
   - `action: 'pause'` with `reason`, `spent` and `cap`: a cap was reached.
     Return it; the trees are kept.
   - **Exit 7**, `action: 'unmeasured'`: a token cap is set and no
     transcript holds the last mark yet. Run `next` once more now that its
     output is in your transcript; if it answers Exit 7 again, return it.
2. **Premise check, before building.** List the card's checkable claims (a
   route is unused, a caller is the only one, something is already removed,
   a parameter is missing, the repo it names) and verify each one in the
   code before writing any.
   - Claims about production behaviour (traffic on a route, which callers
     hit it, an error or usage baseline) are checked in New Relic only when
     a New Relic CLI or tool is available on this machine. A claim nothing
     can settle stays an open decision marked unverified.
   - Relevance: trace why the card exists and whether that reason still
     holds in the cards that depend on it. When nothing depends on it any
     more, report the card as possibly obsolete, as a finding. Report only:
     never move or cancel the Linear card.
   - Give each finding in `previous.findings` an outcome in
     `priorFindings`: `holds`, `resolved` or `wrong`, with its text and
     ref, instead of rewriting it. A finding goes in `findings` only when
     it is new.
3. Work the card in its trees. Open a repo's tree the first time the card
   needs it with `tree`, and edit only under the `path` it prints. The
   repo's setup runs there once. `action: 'setup-failed'` (Exit 1) names
   the command, its exit code and the log: fix the cause or report it; the
   next `tree` call retries the setup.
   - An existing-PR card (`origin: 'existing-pr'`) gets the PR's diff in
     its repo's tree once. Check `prDiff`: `applied`, or `conflict` with
     `prDiffError`; resolve it by hand or record the conflict as a finding.
   - When the card changes a class's constructor or providers, list the
     integration specs that build that class and run them, through `check`,
     before `end`.
   - Lint through the repo's own target (for example `nx lint <project>`),
     through `check`, never eslint directly.
4. Touching code an earlier card wrote: run `candidates`. It lists
   `{card, repo, path, ranges}` suggestions and records nothing.
   - An item with `otherTrack` is a card of another track: changing its
     code is a crossing, not a fixup (see Crossings).
   - Otherwise confirm which earlier card the change fixes and run
     `fixup`. It snapshots only those paths as a fixup patch and updates
     the fixed cards' records. Record a fixup before the current card
     touches the same file: a fixup snapshots whole files. A `fixup`
     refused because the card is in another track is a crossing too.
5. Write the card notes to
   `~/.keiron-sequencer/<slug>/runs/<runId>/notes/<CARD>.json`, or anywhere
   and pass `--notes <notes.json>` to `end`. Start from `notes-template`:
   it prints `notes`, a skeleton with every key (a string starting with `<`
   is a placeholder; `priorFindings` lists the old findings), and
   `allowed`, the values `source`, `kind`, `impact`, `status`, `owner` and
   `outcome` take. `end` refuses notes that do not fit.
   - Write between 3 and 6 given/when/then cases in English (about 4).
   - Run the implication check on every open guess before recording it:
     read what the code already forces. `resolved`: it moves to
     `decisions` with the evidence. `narrowed`: it stays in
     `openDecisions` with `status: narrowed` and the ruled-out options in
     `eliminated`. `open`: it stays. Then tag it with `impact` (`design` or
     `detail`) and `owner` (`people` or `code`).
   - A `reorder` finding that would make a card wait on one in a later
     milestone is a milestone question (which card moves), not a plain
     order.
   - Never auto-resolve a decision about policy, security posture, legal or
     retention, UX copy, or rollout timing: it stays open with
     `owner: people`.
   - `piiInLogs` attests each `<repoDir>/<path>` whose code logs patient
     data. Both `openDecisions` and `piiInLogs` are required: use `[]` when
     there are none.
   - No diff text in the notes: the patch holds the change.
6. `end` type-checks each open tree, snapshots it, scans the patches for
   secrets, and writes the patches and the record. It prints `record`,
   `patches`, `noChange`, `usage`, any `warnings`, and `crossingSuspects`:
   other tracks' cards whose patches touch the files this card changed.
   - **Exit 8**, `action: 'typecheck'`: the typecheck failed; nothing was
     written. Fix the card's code and run `end` again. Use
     `--skip-typecheck "<reason>"` only when the failure is not this
     card's (the base already fails the same check).
   - **Exit 4**, `action: 'secret'`: a patch holds secret-like content.
     Remove it; for a false positive, run `end` again with
     `--allow <kind>:<path>`.
   - **Exit 6**: a tree guard failed. Report it; for a missing last tree,
     run `rebuild`.
7. Return your report (see Report) after every `end`, and wait. The
   coordinator answers "next card" (run `next` again) or tells you what
   changed.

Proceed on trivial decisions and record them. On a real conflict, return the
question to the coordinator instead of guessing. The card's box is
warn-only: never mark the scope incomplete for a box overrun.

## Crossings

A crossing: the card you are working on (C) needs a card B of another track
(`depends`: C uses something B adds or changes), or must change code B wrote
(`changes`). The signs: a `candidates` item with `otherTrack`, a `fixup`
refused because B is in another track, or code C needs that a card outside
your track adds. Stop working on C at once and run `cross` with
`--card <C> --needs <B>`, the kind, and a `--note` in English saying what C
needs from B. Leave C's trees as they are.

- Exit 75 or `action: 'stale'`: run the same command again.
- Exit 1 naming `wip/<CARD>.patch` for your card: its wip is not back in its
  tree. Put it back (see Wip) or delete it, then run `cross` again.
- Exit 1 saying B is in your track too: it is not a crossing. Inside one
  track a need is a blocks edge (record a `reorder` finding) and a change is
  a fixup. Go on with the card.
- Any other answer (`merged`, `applied`, `deferred`, Exit 5, another
  Exit 1): return it at once, naming C, B and the kind, and wait.

When the coordinator tells you a card of your track was parked with a pending
crossing: when `next` hands it to you again, put its `wip` back, run that
same `cross` again, and return its answer.

## Wip

A card's `wip` (`wip/<CARD>.patch` in the run folder) holds what it did
before a crossing stopped it, with paths `a/<repoDir>/<path>`. Open each repo
it names with `tree` first, then put it back:

- one repo: from that repo's tree, `git apply -p2 <wip>`;
- several repos: from the folder that holds the track's trees (the parent of
  every `trees` path), `git apply -p1 <wip>`.

Never pick a repo out of it with an include pattern: `--include '<repoDir>/*'`
with `-p2` matches nothing, since the pattern is matched after `-p2` strips
the repo folder, so it applies nothing and still exits 0. If the wip no longer applies, read it as
reference, redo what still holds by hand, and delete the file before any
`cross` on that card. `end` deletes it.

## Report

After every `end`, every crossing, and every answer that stops you, return a
short report and wait for the coordinator's message; never run `next` again
before it says so:

- the card and the answer that stopped you (`end`, `cross`, `track-done`,
  `waiting`, `pause`, an error), with its key fields: `record`, `warnings`
  and `crossingSuspects` from `end`; the `action` and fields of `cross`;
- every finding that names another card, with that card's key;
- the `replayed` entries `next` ran.

## Exit codes

- **Exit 0**: done; read `action`.
- **Exit 1**: an error; one line on stderr says what to do. Report it rather
  than retrying blindly, except the cases above.
- **Exit 2**: usage. Fix the command.
- **Exit 3**: no Linear key found. Return it.
- **Exit 4**: secret-like content in a patch; nothing was written.
- **Exit 5**: at `cross`, the need closes a cycle. Return it.
- **Exit 6**: a tree guard failed; nothing was written.
- **Exit 7**: usage unmeasured while a token cap is set.
- **Exit 8**: the typecheck failed at `end`; nothing was written.
- **Exit 75**: busy; run the same command again.
- **Exit 124**: at `check`, the command ran past `--timeout-ms` and was
  stopped. Report it; rerun with a larger `--timeout-ms` only when the
  command is known to need it.
