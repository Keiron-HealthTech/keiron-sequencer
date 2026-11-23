---
name: spike
description: >
  Run a thin spike pass over every open execution card of a Linear project, in
  dependency order, in throwaway trees the spike creates, with no commits. The
  main session does each card inline; the spike CLI keeps the books (order,
  trees, snapshots, fixups, token windows, caps, resume) and writes one record
  per card to ~/.keiron-sequencer/<slug>/.
  Trigger: "sequencer spike", "spike the project", "run the spike pass",
  "resume the spike", "spikear el proyecto".
license: Apache-2.0
metadata:
  author: keiron
---

# keiron-sequencer spike

The CLI is `node ${CLAUDE_PLUGIN_ROOT}/scripts/spike.mjs`. Every command prints one
JSON object on stdout; commands that open or close something put `mark` first,
so the transcript records which session ran them. The CLI never edits code.
The main session does the card work inline, in the trees the CLI creates: no
subagent per card, no headless runs.

## Safety rules

- **Never commit, push or open a PR**, in a spike tree or in any repo. Each tree
  is a detached checkout with a push guard (a pre-push hook and an invalid push
  URL); never work around it. The CLI refuses a tree with a commit in it
  (Exit 6).
- Never commit the records either: they land in `~/.keiron-sequencer/<slug>/`, and
  they stay personal: never committed or shared. Linear is the only shared
  surface.
- Linear only through the CLI. Never read, print, cat or copy the Linear key:
  the CLI finds it, uses it for read-only queries and redacts it from every
  output. If it finds none (Exit 3), tell the user; never ask them to paste a
  key into the chat.
- No production DB writes. No patient data in logs, not even masked.
- Run heavy commands (install, build, type-check, tests) one at a time, with
  the target repo's own limits, through
  `node ${CLAUDE_PLUGIN_ROOT}/scripts/spike.mjs check [--track <id>] [--cwd <repoDir>] [--project <project ref>] -- <argv>...`:
  it runs the argv in the track's first open tree (`--cwd` picks a repo), takes a
  check slot first, and exits with the command's exit code. `next`, `tree`, `end` and `check` can
  answer `action: 'busy'` with exit code 75: no slot freed in time, nothing was
  changed, so run the same command again.
- Patches and run state live in `~/.keiron-sequencer`, outside every repo: the run's
  folder is `~/.keiron-sequencer/<slug>/runs/<runId>/` (`patches/`, `trees/`, `notes/`,
  `logs/`, `run.json`). Never copy a patch into a repo. The per-card records
  go to `~/.keiron-sequencer/<slug>/`, next to the runs, and they hold no code.

## Preflight (before the first live run)

1. Draft `~/.keiron-sequencer/config.json` yourself; the user never writes it by
   hand and does not need to know its shape. Before the first live run of a
   project, run:

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/spike.mjs config <project ref> --out <draft.json> [--root <dir>]...
   node ${CLAUDE_PLUGIN_ROOT}/scripts/spike.mjs config --draft <draft.json>
   node ${CLAUDE_PLUGIN_ROOT}/scripts/spike.mjs config --draft <draft.json> --approve <hash>
   ```

   - **Where the checkouts are.** Pass `--root` with the folder that holds the
     checkout this session runs in (for a worktree, the folder that holds the
     repo's main checkout). Only when the draft still reports a
     repo not found, or exits 2 with `no checkout roots` outside any checkout,
     ask once which folders hold their checkouts and draft again with each as
     `--root <dir>`.
   - **What the draft fills.** Each card's repo comes from its title prefix or
     its `Repo:` line. For each repo the draft reads the GitHub name and remote
     from the checkout's git remote, the default branch from the remote's HEAD,
     the setup command from the lockfile and standard risk paths from
     `docs/spike-config.example.json`. The typecheck needs no config.
   - **What the user sees.** One line per repo: `<repo> → <checkout path>`, plus
     each repo not found and each value the draft could not fill, in plain
     words, then one question: use these? Never show the JSON, the hash, the
     setup or the risk paths unless the user asks, and then the review
     (`config --draft <draft.json>`) shows them.
   - **Write** only on the user's yes, with `--approve <hash>`. A change the user
     asks for (another path, a repo to leave out) goes into a new draft; follow
     /keiron-sequencer:respike's config step (Missing config: draft, review,
     write) for every other case. `message: 'nothing to draft'` means the config
     already covers the project: say nothing and go on.
   - An empty `projects.<slug>.repos: []` is an error: leave the key out to
     allow every repo.
2. Ask the user to add `~/.keiron-sequencer` as a Claude Code additional directory
   before the first live run (for example `/add-dir ~/.keiron-sequencer`). Without it,
   every edit in a spike tree asks for permission. Ask; do not edit their
   settings yourself. Stop until the session can edit `~/.keiron-sequencer`.
3. Push guard on real checkouts: a worktree's guard is per-worktree config,
   which needs `extensions.worktreeConfig` set in the checkout. The CLI sets it
   only where it is absent and leaves it set afterwards. `tree`, the completion
   and `abandon` list those checkouts in `touchedCheckouts`. Report every
   checkout listed there to the user.

Install: the user installs it as a plugin; do not run these yourself:
`claude plugin marketplace add <owner>/keiron-sequencer`, then
`claude plugin install keiron-sequencer@keiron-sequencer`.

## Step 1: Begin or resume

`node ${CLAUDE_PLUGIN_ROOT}/scripts/spike.mjs begin <project ref> [--max-tokens <n>] [--max-cards <n>] [--box <n>] [--session-file <transcript.jsonl>]`

The ref is the project URL, slug, UUID or identifier. `begin` reads Linear
once, orders the open execution cards (blockers first, then milestone, then
card number), marks cards with an open PR tagged with their id as existing-PR
cards, and prints `{mark, runId, resumed, project, plan}`.

- Both caps are optional: use either, both or none. `--max-tokens` caps the
  weighted tokens of the cards finished in this invocation; `--max-cards` caps
  their count. Weighted tokens are input + 1.25 × cache creation + 0.1 × cache
  read + 5 × output. Caps are checked only between cards, never mid-card: a
  card that started always finishes, so a run may end over the token cap by
  the last card's cost. Every `begin` gives a fresh budget.
- `--box <n>` is a per-card budget in weighted tokens. It is warn-only: a card
  over its box keeps going, `end` warns, and the record carries
  `timeBox.over: true`. The box is fixed at the card's first window and never
  changes afterwards; a resume with another `--box` applies it only to cards
  that start later. Existing-PR cards never get a box. Never mark the scope
  incomplete for a box overrun: `scope.complete: false` is for scope that was
  genuinely left out, with a note.
- `--session-file` names this session's transcript when the CLI cannot find
  it by its mark.
- A project with a paused or interrupted run resumes it: same `runId`, done
  cards untouched, the card in progress reopened. `action: 'nothing-to-do'`
  means the project's newest run is complete: report it and stop. For that
  project the pass is complete, and a new pass is made with /keiron-sequencer:respike.
- **Exit 5**: a cycle among the run's cards. Report the members and stop;
  nothing was created.

## Step 2: The card loop

Run `next` and `end` with the shell tool's longest timeout (600000 ms) or in
the background: both type-check (a replay at `next`, the card's trees at
`end`), and a check can take minutes. A command the shell kills mid-check
reports nothing; run it again.

1. `node ${CLAUDE_PLUGIN_ROOT}/scripts/spike.mjs next [--project <project ref>]`
   prints one of:
   - `action: 'card'`: the brief (`card`, `title`, `url`, `description`,
     `origin`, `pr`, `offProject`, `previous`, the open `trees`).
     `resumed: true` means work from an earlier execution is already in the
     trees: continue it. `previous` is the card's record from an earlier
     run (`spikedAt`, `findings`, `decisions`, `openDecisions`) on a respike,
     and `null` on a first spike.
   - `action: 'pause'` with `reason`, `spent` and `cap`: a cap was reached.
     Report the reason and the spend, and stop. The trees are kept.
   - `action: 'complete'`: see Step 3.
   - **Exit 7**, `action: 'unmeasured'`: a token cap is set and no transcript
     holds the last mark, so the spend cannot be checked. Run `next` again once
     this output is in the transcript, or resume with `begin` without
     `--max-tokens`. A box alone never blocks.
   - **Exit 1** "the run is paused (…): run begin to resume it".
2. **Premise check, before building.** List the card's checkable claims (a
   route is unused, a caller is the only one, something is already removed,
   a parameter is missing, the repo it names) and verify each one in the
   code before writing any.
   - Claims about production behaviour (traffic on a route the card removes
     or replaces, which callers or tokens hit a route before it is
     enforced, the error or usage baseline the card relies on) are checked
     in New Relic only when a New Relic CLI or tool is available on this
     machine. A claim it cannot settle, or that no tool can check, stays an
     open decision marked unverified.
   - Relevance: trace why the card exists (the decision or finding it came
     from) and whether that reason still holds in the cards that depend on
     its outcome, in their current text and code. When nothing depends on it
     any more, report the card as possibly obsolete, as a finding. Report
     only: never move or cancel the Linear card.
   - On a respike, give each finding in `previous.findings` an outcome in
     `priorFindings`: `holds`, `resolved` or `wrong`, with its text and ref,
     instead of rewriting it. A finding the card still needs restated goes
     in `findings` only when it is new.
3. Work the card inline. Open a repo's tree the first time the card needs it:
   `node ${CLAUDE_PLUGIN_ROOT}/scripts/spike.mjs tree <repoDir> [--project <project ref>]`
   prints its `path`; edit only under that path. The repo's setup commands run
   there once, sequentially. `action: 'setup-failed'` (Exit 1) names the
   command, its exit code and the log: fix the cause or report it; the next
   `tree` call retries the setup.
   - For an existing-PR card (`origin: 'existing-pr'`) the CLI applies the PR's
     diff into that repo's tree once: at `tree <repoDir>` while the card is
     current, or at `next` when that tree is already open. Check `prDiff`:
     `applied`, or `conflict` with `prDiffError`, in which case the tree is
     left as it was; resolve it by hand or record the conflict as a finding.
   - When the card changes a class's constructor or providers, list the
     integration specs that build that class and run them before `end`.
   - Lint through the repo's own target (for example `nx lint <project>`),
     never eslint directly: the tree's setup already installed what the
     target needs.
4. Touching code an earlier card wrote: run
   `node ${CLAUDE_PLUGIN_ROOT}/scripts/spike.mjs candidates [--repo <repoDir>] [--project <project ref>]`.
   `action: 'candidates'` lists `{card, repo, path, ranges}` suggestions and
   records nothing. Confirm which earlier card the change fixes, then run
   `node ${CLAUDE_PLUGIN_ROOT}/scripts/spike.mjs fixup --fixes <CARD>[,<CARD>] --slug <kebab-slug> --note "<English>" --repo <repoDir> [--allow <kind>:<path>]... [--project <project ref>] -- <path>...`.
   It snapshots only those paths as a fixup patch, updates the fixed cards'
   records, and leaves every other change for the current card's patch.
   Record a fixup before the current card touches the same file: a fixup
   snapshots whole files, so a file the current card already changed would
   carry the current card's work into the fixup.
5. Write the card notes to `~/.keiron-sequencer/<slug>/runs/<runId>/notes/<CARD>.json`,
   or anywhere and pass `--notes <notes.json>` to `end`. Start from
   `notes-template`:
   `node ${CLAUDE_PLUGIN_ROOT}/scripts/spike.mjs notes-template <CARD> [--project <project ref>]`
   prints `notes`, a skeleton with every key and one placeholder item each
   (a string starting with `<` is a placeholder; `priorFindings` lists the
   old findings on a respike), and `allowed`, the values `source`, `kind`,
   `impact`, `status`, `owner` and `outcome` take. `end` refuses notes that
   do not fit, naming each `notes.*` path.
   - About 4 English given/when/then cases at card end (3 to 6; zero is
     refused).
   - Run the implication check on every open guess before recording it: read
     what the code already forces. `resolved`: it moves to `decisions`, with
     the evidence. `narrowed`: it stays in `openDecisions` with
     `status: narrowed` and the options the code rules out in `eliminated`
     (`option`, `why`). `open`: it stays as it is. Then tag it with `impact`
     (`design` or `detail`) and `owner` (`people` or `code`); only `design`
     makes the verdict SDD.
   - Before recording a `reorder` finding, compare the two cards' milestones:
     milestones are delivered in order, so a reorder that would make a card
     wait on one in a later milestone is recorded as a milestone question
     (which card moves), not as a plain order.
   - Never auto-resolve a decision about policy, security posture, legal or
     retention, UX copy, or rollout timing: it stays open with
     `owner: people`, whatever the code suggests.
   - `piiInLogs` attests each `<repoDir>/<path>` whose code logs patient data;
     the CLI never infers it. Both `openDecisions` and `piiInLogs` are
     required: use `[]` when there are none.
   - No diff text in the notes: the patch holds the change.
6. `node ${CLAUDE_PLUGIN_ROOT}/scripts/spike.mjs end <CARD> [--notes <notes.json>] [--allow <kind>:<path>]... [--skip-typecheck <reason>] [--project <project ref>]`
   type-checks each open tree, snapshots it, scans the patches for secrets,
   and writes the patches and the record. The typecheck needs no config: in
   a tree with a `tsconfig.json` and its own `tsc`, it type-checks the whole
   program through the repo's own TypeScript config, with the files the card
   changed added (specs the config excludes included), and only an error in
   a file the card changed refuses; errors elsewhere were there before.
   A repo's `spikeTypecheck` in `~/.keiron-sequencer/config.json` overrides it: an
   argv where `"{changed}"` expands to the changed files, or `false` to
   turn it off. It prints `record`, `patches`, `noChange` (repos
   with no change), `usage` and any `warnings` (case count, box overrun).
   - **Exit 8**, `action: 'typecheck'`: the typecheck failed in `repo`;
     nothing was written. The output names the `log` and holds its `tail`
     (`timedOut` when it hit its time limit). Fix the card's code and run
     `end` again. Run `end` with `--skip-typecheck "<reason>"` only when the
     failure is not this card's (the base already fails the same check); the
     reason is kept in the run.
   - **Exit 4**, `action: 'secret'`: a patch holds secret-like content. The
     output names the patch, path, line and kind, never the value. Remove it
     from the tree; for a false positive, run `end` again with
     `--allow <kind>:<path>`.
   - **Exit 6**: a tree guard failed (a commit in the tree, a moved HEAD, or a
     missing last tree). Report it. For a missing last tree, run
     `node ${CLAUDE_PLUGIN_ROOT}/scripts/spike.mjs rebuild <repoDir> [--project <project ref>]`.
7. Back to `next`.

While working a card: Proceed on trivial decisions, as a spike does, and record
them. Ask the user mid-card only on real conflicts.

## Step 3: Completion, pause and cleanup

- `action: 'complete'`: every card is done. The trees are deleted (`removed`),
  older runs are pruned (`pruned`; the newest two runs per project are kept),
  and `touchedCheckouts` and `warnings` are listed. Report them, then tell the
  user the records in `~/.keiron-sequencer/<slug>/` are ready for them to review.
- `node ${CLAUDE_PLUGIN_ROOT}/scripts/spike.mjs pause [--project <project ref>]`
  stops on purpose and keeps the trees; `begin` resumes later with a fresh
  budget.
- `node ${CLAUDE_PLUGIN_ROOT}/scripts/spike.mjs abandon [--discard] [--project <project ref>]`
  only when the user asks: it deletes the run's trees; `--discard` is needed
  when a tree holds work no `end` has snapshotted.
- `node ${CLAUDE_PLUGIN_ROOT}/scripts/spike.mjs status [--project <project ref>]` is
  read-only: the current card's spend against its box, the open trees and the
  unsettled usage windows.
- `node ${CLAUDE_PLUGIN_ROOT}/scripts/spike.mjs prune [<slug>] [--dry-run]` applies
  the retention by hand.
- `--project <project ref>` on next, tree, check, candidates, fixup, end, rebuild,
  pause, abandon and status is needed only when more than one project has an
  active run.

## Exit codes

- **Exit 0**: done; read `action`.
- **Exit 1**: an error; one line on stderr says what to do. Report it rather
  than retrying blindly.
- **Exit 2**: usage. Fix the command.
- **Exit 3**: no Linear key found.
- **Exit 4**: secret-like content in a patch; nothing was written.
- **Exit 5**: a cycle among the run's cards; nothing was created. From
  `config`: the draft or config.json changed since its hash was shown; review
  again.
- **Exit 6**: a tree guard failed; nothing was written.
- **Exit 7**: usage unmeasured while a token cap is set.
- **Exit 8**: the typecheck failed at `end`; nothing was written.
