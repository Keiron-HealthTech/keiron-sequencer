import { exitError } from '../cli.mjs';
import { withoutNotesBlock } from '../harvest.mjs';
import { PR_CHECK_VERDICTS, validateRecord } from '../record.mjs';
import { againstOf, diffFiles, itemsOf, latestPrCheck } from './audit.mjs';

// The PR check holds a built card's record against what its PR or accepted local branch builds, before a run spikes on top
// of it: each gap is answered in the plan (handed to a card the run spikes, or dropped), or the PR is fixed first.

export const PR_CHECK_SCHEMA = 1;

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const cardNumber = key => Number(String(key).match(/(\d+)$/)?.[1] ?? 0);
const byCard = (a, b) => cardNumber(a) - cardNumber(b) || compare(a, b);
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = v => typeof v === 'string' && v.trim() !== '';
const isChecked = b => b.kind === 'pr' || b.kind === 'local';

const builtByCard = built => {
  const out = new Map();
  for (const b of built.filter(isChecked)) out.set(b.key, [...(out.get(b.key) ?? []), b]);
  return out;
};

// current: the last PR check saw every head the card has now; stale: a head moved since; unchecked: never checked.
export function prChecks(built, records, answers) {
  const out = [];
  for (const [card, entries] of [...builtByCard(built)].sort(([a], [b]) => byCard(a, b))) {
    const record = records.get(card);
    if (!record) continue;
    const entry = latestPrCheck(record);
    const seen = b => entry?.against?.some(a => a.repoDir === b.repoDir && a.sha === b.sha);
    const status = answers.skipCheck?.has(card) ? 'skipped' : !entry ? 'unchecked' : entries.every(seen) ? 'current' : 'stale';
    out.push({ card, status, against: entries.map(againstOf) });
  }
  return out;
}

const headName = a => (a.kind === 'pr' ? `PR #${a.pr}` : `branch ${a.branch}`);
const headsOf = against => against.map(headName).join(' and ');

function gapsOf(record, entry) {
  const items = new Map(itemsOf(record).map(i => [i.id, i]));
  const marks = new Map([...(record.cases ?? []).map(c => [c.id, c.audit]), ...(record.decisions ?? []).map((d, i) => [`d${i + 1}`, d.audit])]);
  return [
    ...entry.verdicts.filter(v => v.verdict === 'not-built' && items.has(v.id)).map(v => {
      const { audit: _, ...item } = items.get(v.id);
      return { ...item, ...(marks.get(v.id)?.note ? { note: marks.get(v.id).note } : {}), where: 'record' };
    }),
    ...(entry.missing ?? []).map((text, i) => ({ id: `m${i + 1}`, kind: 'scope', text, where: 'description' })),
  ];
}

const summary = gap => (gap.kind === 'case' ? `${gap.given}; ${gap.when}; ${gap.then}` : gap.text);

// spiked: the cards this run spikes. Every --hand and --drop must answer a gap of a checked card, or the preflight is a usage
// error, so a typo never passes for an answer.
export function prCheckPlan({ built, records, answers, spiked }) {
  const checks = prChecks(built, records, answers);
  const asks = [];
  const handoffs = [];
  const drops = [];
  const hand = answers.hand ?? new Map();
  const drop = answers.drop ?? new Set();
  const used = new Set();
  for (const check of checks) {
    const { card, status, against } = check;
    if (status === 'skipped') continue;
    if (status !== 'current') {
      const what = headsOf(against);
      asks.push({
        code: 'pr-unchecked', card, cards: [card], paths: [],
        message: `${card}'s record has not been checked against ${what}${status === 'stale' ? ' as it is now (its head moved since the last check)' : ''}: `
          + `run audit --before, judge it and store the verdicts, then preflight again; or answer --skip-check ${card} to start without the check`,
        answers: ['audit --before', `--skip-check ${card}`],
      });
      continue;
    }
    const entry = latestPrCheck(records.get(card));
    for (const gap of gapsOf(records.get(card), entry)) {
      const key = `${card}:${gap.id}`;
      const { where, ...item } = gap;
      if (hand.has(key)) {
        used.add(key);
        const to = hand.get(key);
        if (!spiked.has(to)) throw exitError(2, `--hand ${key}=${to}: ${to} is not a card this run spikes`);
        handoffs.push({ from: card, id: gap.id, to, ...withoutId(item) });
        continue;
      }
      if (drop.has(key)) { used.add(key); drops.push({ from: card, id: gap.id }); continue; }
      asks.push({
        code: 'not-built', card, item: gap.id, cards: [card], paths: [],
        message: `${card} ${gap.id} (${summary(gap)}) is in its ${where} but ${headsOf(against)} does not build it: `
          + 'fix the PR first, hand it to a card this run spikes, or drop it',
        answers: [`--hand ${key}=<CARD>`, `--drop ${key}`, 'fix the PR first'],
      });
    }
  }
  for (const [key, to] of hand) if (!used.has(key)) throw exitError(2, `--hand ${key}=${to}: ${key.replace(':', ' ')} is not a not-built item of a checked card`);
  for (const key of drop) if (!used.has(key)) throw exitError(2, `--drop ${key}: ${key.replace(':', ' ')} is not a not-built item of a checked card`);
  return { checks, asks, handoffs, drops };
}

const withoutId = ({ id: _, ...rest }) => rest;

// A PR's diff is what GitHub shows for it; an accepted local branch is diffed from its merge base with the default branch.
function readDiff(b, { gh, git, config }) {
  if (b.kind === 'pr') {
    const r = gh(['pr', 'diff', b.pr.url]);
    if (r.status !== 0) throw new Error(`gh pr diff ${b.pr.url} failed (${r.status}): ${String(r.stderr).trim()}`);
    return r.stdout;
  }
  const repo = config.repos[b.repoDir];
  if (!repo?.checkout) throw new Error(`${b.repoDir} has no checkout in the spike config`);
  return git(['diff', '--no-color', `${repo.remote}/${repo.defaultBranch}...${b.sha}`], { cwd: repo.checkout });
}

// The cards whose check is unchecked or stale, each with its PR diff saved by writeDiff(card, repoDir, text): the diff text
// never goes into the inputs.
export function gatherPrCheck({ project, plan, records, descriptions, gh, git, config, writeDiff, now }) {
  const byCardBuilt = builtByCard(plan.built);
  const cards = plan.prChecks.filter(c => c.status === 'unchecked' || c.status === 'stale').map(({ card }) => {
    const record = records.get(card);
    return {
      card,
      kind: 'built',
      title: record.title,
      record: { spikedAt: record.spikedAt, runId: record.refs?.runId ?? null },
      against: byCardBuilt.get(card).map(b => {
        const base = { repoDir: b.repoDir, kind: b.kind, pr: b.pr ? { number: b.pr.number, url: b.pr.url, isDraft: Boolean(b.pr.isDraft) } : null, branch: b.branch ?? null, sha: b.sha ?? null };
        try {
          const text = readDiff(b, { gh, git, config });
          return { ...base, diff: { path: writeDiff(card, b.repoDir, text), files: diffFiles(text) } };
        } catch (e) {
          return { ...base, diff: null, error: e.message };
        }
      }),
      description: withoutNotesBlock(descriptions.get(card)?.description ?? '').trimEnd(),
      items: itemsOf(record),
    };
  });
  return { schemaVersion: PR_CHECK_SCHEMA, check: 'pr', project, gatheredAt: now.toISOString(), cards };
}

const CARD_FIELDS = ['items', 'missing'];
const ITEM_FIELDS = ['verdict', 'note'];

export function validatePrVerdicts(value, inputs) {
  if (!isObject(value)) return ['the verdicts file must be a JSON object'];
  const errors = [];
  const err = m => errors.push(m);
  if (value.schemaVersion !== PR_CHECK_SCHEMA) err(`schemaVersion must be ${PR_CHECK_SCHEMA}`);
  for (const k of Object.keys(value).filter(k => !['schemaVersion', 'cards'].includes(k))) err(`unknown top-level field ${k}`);
  if (!isObject(value.cards)) return [...errors, 'cards must be an object of card keys'];
  const gathered = new Map(inputs.cards.map(c => [c.card, c]));
  for (const [card, v] of Object.entries(value.cards)) {
    const at = gathered.get(card);
    if (!at) { err(`${card} is not a card the PR check gathered`); continue; }
    if (!isObject(v)) { err(`${card} must be an object`); continue; }
    for (const k of Object.keys(v).filter(k => !CARD_FIELDS.includes(k))) err(`${card}: unknown field ${k}`);
    const items = isObject(v.items) ? v.items : {};
    if (!isObject(v.items)) err(`${card}: items must be an object of item ids`);
    const ids = new Set(at.items.map(i => i.id));
    for (const id of ids) if (!(id in items)) err(`${card}: ${id} has no verdict`);
    for (const [id, item] of Object.entries(items)) {
      if (!ids.has(id)) { err(`${card}: ${id} is not an item of its record`); continue; }
      if (!isObject(item)) { err(`${card} ${id}: expected an object`); continue; }
      for (const k of Object.keys(item).filter(k => !ITEM_FIELDS.includes(k))) err(`${card} ${id}: unknown field ${k}`);
      if (!PR_CHECK_VERDICTS.includes(item.verdict)) err(`${card} ${id}: the PR check gives holds or not-built`);
      if (!isText(item.note)) err(`${card} ${id}: note must be a non-empty string`);
    }
    if ('missing' in v && (!Array.isArray(v.missing) || !v.missing.every(isText))) err(`${card}: missing must be a list of non-empty strings`);
  }
  return errors;
}

// Marks each item with its PR check and adds the check to the record's audits; nothing is renumbered or removed.
export function markPrCheck(record, gathered, verdicts, { at }) {
  const markOf = id => ({ check: 'pr', verdict: verdicts.items[id].verdict, note: verdicts.items[id].note, at });
  const entry = {
    check: 'pr', at, kind: 'built', against: gathered.against.map(againstOf),
    verdicts: itemsOf(record).map(({ id }) => ({ id, verdict: verdicts.items[id].verdict })),
    missing: verdicts.missing ?? [],
  };
  const next = {
    ...record,
    cases: record.cases.map(c => ({ ...c, audit: markOf(c.id) })),
    decisions: (record.decisions ?? []).map((d, i) => ({ ...d, audit: markOf(`d${i + 1}`) })),
    audits: [...(record.audits ?? []), entry].sort((a, b) => compare(a.at, b.at)),
  };
  const errors = validateRecord(next);
  if (errors.length) throw new Error(`the checked record of ${record.card} does not validate: ${errors.join('; ')}`);
  return next;
}
