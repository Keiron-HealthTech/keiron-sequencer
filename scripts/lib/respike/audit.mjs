import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withoutNotesBlock } from '../harvest.mjs';
import { AUDIT_VERDICTS, validateRecord } from '../record.mjs';
import { isLive } from '../records.mjs';
import { runDir } from '../spike/home.mjs';

export const AUDIT_SCHEMA = 1;

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const cardNumber = key => Number(String(key).match(/(\d+)$/)?.[1] ?? 0);
const byCard = (a, b) => cardNumber(a) - cardNumber(b) || compare(a, b);
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = v => typeof v === 'string' && v.trim() !== '';
const CARD_KEY = /^[A-Z]+-\d+$/;

export const againstOf = b => ({ repoDir: b.repoDir, kind: b.kind, pr: b.pr?.number ?? null, branch: b.branch ?? null, sha: b.sha ?? null });

export const latestPrCheck = record => [...(record?.audits ?? [])].filter(a => a.check === 'pr').sort((a, b) => compare(a.at, b.at)).at(-1) ?? null;

const prCheckSummary = entry => {
  if (!entry) return null;
  const of = v => entry.verdicts.filter(x => x.verdict === v).map(x => x.id);
  return { at: entry.at, holds: of('holds'), notBuilt: of('not-built'), missing: entry.missing ?? [] };
};

export const auditDir = (home, slug, runId) => join(runDir(home, slug, runId), 'audit');
export const inputsPath = (home, slug, runId) => join(auditDir(home, slug, runId), 'inputs.json');

export function readInputs(home, slug, runId) {
  const path = inputsPath(home, slug, runId);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

const byCaseId = (a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1));

// The old cases and decisions of a record, each with its id; a decision's id is its 1-based position, as harvest reads it.
export function itemsOf(record, { audit = true } = {}) {
  const mark = item => (audit ? { audit: item.audit ?? null } : {});
  return [
    ...[...(record.cases ?? [])].sort(byCaseId).map(c => ({ id: c.id, kind: 'case', given: c.given, when: c.when, then: c.then, ...mark(c) })),
    ...(record.decisions ?? []).map((d, i) => ({ id: `d${i + 1}`, kind: 'decision', text: d.text, ...mark(d) })),
  ];
}

const caseText = c => `${c.given}; ${c.when}; ${c.then}`;

// Every case, decision, open decision and finding of the fresh records that names the card. CRM-12 never matches inside CRM-123.
function mentionsOf(fresh, key) {
  const names = new RegExp(`(?<![\\w-])${key}(?!\\d)`);
  const out = [];
  for (const r of fresh) {
    const listed = [
      ...[...(r.cases ?? [])].sort(byCaseId).map(c => ({ id: c.id, kind: 'case', text: caseText(c) })),
      ...(r.decisions ?? []).map((d, i) => ({ id: `d${i + 1}`, kind: 'decision', text: d.text })),
      ...(r.openDecisions ?? []).map((d, i) => ({ id: `o${i + 1}`, kind: 'openDecision', text: d.text })),
      ...(r.findings ?? []).map((f, i) => ({ id: `f${i + 1}`, kind: 'finding', text: f.text })),
    ];
    for (const item of listed) if (names.test(item.text)) out.push({ card: r.card, ...item });
  }
  return out;
}

// The cards an audit looks at: every open card on the map the run did not spike. A merged one is left alone, a PR, a draft or
// an accepted local branch is checked against its diff, and the rest only against the run's fresh records.
export function auditTargets(state, records) {
  const { order, cards: planned, respike } = state.plan;
  const live = new Map(records.filter(isLive).map(r => [r.card, r]));
  // Fresh is what the record says, not the plan: a replay that turned, or a card a crossing re-spiked, was spiked by this run.
  const isFresh = k => live.get(k)?.refs?.runId === state.runId && !live.get(k).replayed;
  const spiked = new Set([...order.filter(k => planned[k].mode === 'spike'), ...[...live.keys()].filter(isFresh)]);
  const cards = [];
  const skipped = [];
  for (const key of [...(respike.map?.open ?? [])].filter(k => !spiked.has(k)).sort(byCard)) {
    const entries = (respike.built ?? []).filter(b => b.key === key);
    const against = entries.filter(b => b.kind === 'pr' || b.kind === 'local');
    if (!against.length && entries.some(b => b.kind === 'merged')) { skipped.push({ card: key, reason: 'merged' }); continue; }
    if (!live.has(key)) { skipped.push({ card: key, reason: 'no-record' }); continue; }
    cards.push({ card: key, kind: against.length ? 'built' : 'unbuilt', against, record: live.get(key) });
  }
  const fresh = [...spiked].filter(isFresh).sort(byCard).map(k => live.get(k));
  return { cards, skipped, fresh };
}

// Lines added and deleted per file; the header lines of each file are not counted.
export function diffFiles(text) {
  const files = [];
  let file = null;
  let header = false;
  for (const line of String(text).split('\n')) {
    const start = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (start) { file = { path: start[2], added: 0, deleted: 0 }; files.push(file); header = true; continue; }
    if (!file) continue;
    if (line.startsWith('@@')) { header = false; continue; }
    if (header && (line.startsWith('+++ ') || line.startsWith('--- '))) continue;
    if (line.startsWith('+')) { file.added++; header = false; } else if (line.startsWith('-')) { file.deleted++; header = false; }
  }
  return files;
}

// The PR was read before the run (the PR check); after it, every card is held only against the fresh records. A built card
// brings what its PR check found, and every card where the plan handed or dropped its gaps.
export function gatherAudit({ state, records, descriptions, now }) {
  const { cards, skipped, fresh } = auditTargets(state, records);
  const { handoffs = [], drops = [] } = state.plan.respike;
  const out = cards.map(({ card, kind, against, record }) => ({
    card,
    kind,
    title: record.title,
    record: { spikedAt: record.spikedAt, runId: record.refs?.runId ?? null },
    against: against.map(b => ({ repoDir: b.repoDir, kind: b.kind, pr: b.pr ? { number: b.pr.number, url: b.pr.url, isDraft: Boolean(b.pr.isDraft) } : null, branch: b.branch ?? null, sha: b.sha ?? null })),
    prCheck: kind === 'built' ? prCheckSummary(latestPrCheck(record)) : null,
    handed: handoffs.filter(h => h.from === card).map(h => ({ id: h.id, to: h.to })),
    dropped: drops.filter(d => d.from === card).map(d => d.id),
    description: withoutNotesBlock(descriptions.get(card)?.description ?? '').trimEnd(),
    items: itemsOf(record),
    mentions: mentionsOf(fresh, card),
  }));
  return {
    schemaVersion: AUDIT_SCHEMA,
    runId: state.runId,
    gatheredAt: now.toISOString(),
    cards: out,
    fresh: fresh.map(r => ({ card: r.card, title: r.title, spikedAt: r.spikedAt, items: itemsOf(r, { audit: false }) })),
    skipped,
  };
}

const CARD_FIELDS = ['items', 'description'];
const ITEM_FIELDS = ['verdict', 'card', 'note'];

// Every item of every card named gets exactly one verdict; the CLI checks the shape, the skill made the calls.
export function validateVerdicts(value, inputs, { onMap }) {
  if (!isObject(value)) return ['the verdicts file must be a JSON object'];
  const errors = [];
  const err = m => errors.push(m);
  if (value.schemaVersion !== AUDIT_SCHEMA) err(`schemaVersion must be ${AUDIT_SCHEMA}`);
  if (value.runId !== inputs.runId) err(`runId ${value.runId} is not the run ${inputs.runId}`);
  for (const k of Object.keys(value).filter(k => !['schemaVersion', 'runId', 'cards'].includes(k))) err(`unknown top-level field ${k}`);
  if (!isObject(value.cards)) return [...errors, 'cards must be an object of card keys'];
  const gathered = new Map(inputs.cards.map(c => [c.card, c]));
  for (const [card, v] of Object.entries(value.cards)) {
    const at = gathered.get(card);
    if (!at) { err(`${card} is not a card this audit gathered`); continue; }
    if (!isObject(v)) { err(`${card} must be an object`); continue; }
    if ('missing' in v) err(`${card}: missing scope belongs to the PR check, before the run`);
    for (const k of Object.keys(v).filter(k => !CARD_FIELDS.includes(k) && k !== 'missing')) err(`${card}: unknown field ${k}`);
    const items = isObject(v.items) ? v.items : {};
    if (!isObject(v.items)) err(`${card}: items must be an object of item ids`);
    const ids = new Set(at.items.map(i => i.id));
    for (const id of ids) if (!(id in items)) err(`${card}: ${id} has no verdict`);
    for (const [id, item] of Object.entries(items)) {
      if (!ids.has(id)) { err(`${card}: ${id} is not an item of its record`); continue; }
      if (!isObject(item)) { err(`${card} ${id}: expected an object`); continue; }
      for (const k of Object.keys(item).filter(k => !ITEM_FIELDS.includes(k))) err(`${card} ${id}: unknown field ${k}`);
      if (!AUDIT_VERDICTS.includes(item.verdict)) err(`${card} ${id}: verdict must be one of ${AUDIT_VERDICTS.join(', ')}`);
      if (!isText(item.note)) err(`${card} ${id}: note must be a non-empty string`);
      if (item.verdict === 'not-built' && at.kind !== 'built') err(`${card} ${id}: not-built is only for a built card`);
      if (item.verdict === 'moved') {
        if (!(typeof item.card === 'string' && CARD_KEY.test(item.card))) err(`${card} ${id}: a moved item names the card that owns it now`);
        else if (item.card === card) err(`${card} ${id}: moved to itself`);
        else if (!onMap.has(item.card)) err(`${card} ${id}: ${item.card} is not a card of the project map`);
      } else if ('card' in item) err(`${card} ${id}: only a moved item names a card`);
    }
    if ('description' in v && v.description !== null) {
      if (!isObject(v.description)) err(`${card}: description must be an object with text and why, or null`);
      else {
        for (const k of Object.keys(v.description).filter(k => !['text', 'why'].includes(k))) err(`${card}: description: unknown field ${k}`);
        for (const k of ['text', 'why']) if (!isText(v.description[k])) err(`${card}: description.${k} must be a non-empty string`);
      }
    }
  }
  return errors;
}

// Marks each item with its verdict and records the audit; nothing is renumbered or removed, and the spike time stays.
export function markRecord(record, gathered, verdicts, { runId, at }) {
  const verdictOf = id => verdicts.items[id];
  const markOf = id => {
    const v = verdictOf(id);
    return { check: 'fresh', verdict: v.verdict, ...(v.verdict === 'moved' ? { card: v.card } : {}), note: v.note, runId, at };
  };
  const entry = {
    check: 'fresh',
    runId,
    at,
    kind: gathered.kind,
    against: gathered.against.map(againstOf),
    verdicts: itemsOf(record).map(({ id }) => ({ id, verdict: verdictOf(id).verdict, ...(verdictOf(id).verdict === 'moved' ? { card: verdictOf(id).card } : {}) })),
    description: verdicts.description ?? null,
  };
  const next = {
    ...record,
    cases: record.cases.map(c => ({ ...c, audit: markOf(c.id) })),
    decisions: (record.decisions ?? []).map((d, i) => ({ ...d, audit: markOf(`d${i + 1}`) })),
    audits: [...(record.audits ?? []).filter(a => !(a.check === 'fresh' && a.runId === runId)), entry].sort((a, b) => compare(a.at, b.at)),
  };
  const errors = validateRecord(next);
  if (errors.length) throw new Error(`the audited record of ${record.card} does not validate: ${errors.join('; ')}`);
  return next;
}

// The verdicts of one audit run, grouped as the report and the stored output show them.
export function verdictSummary(entry) {
  const of = v => entry.verdicts.filter(x => x.verdict === v);
  return {
    holds: of('holds').map(x => x.id),
    moved: of('moved').map(x => ({ id: x.id, card: x.card })),
    notBuilt: of('not-built').map(x => x.id),
    dropped: of('dropped').map(x => x.id),
  };
}

export function auditReport(inputs, records) {
  if (!inputs) return { gathered: false, cards: [], pending: [], skipped: [] };
  const live = new Map(records.filter(isLive).map(r => [r.card, r]));
  const entryOf = card => live.get(card)?.audits?.find(a => a.check === 'fresh' && a.runId === inputs.runId) ?? null;
  const judged = inputs.cards.filter(c => entryOf(c.card));
  return {
    gathered: true,
    cards: judged.map(({ card }) => {
      const entry = entryOf(card);
      return {
        card, kind: entry.kind, against: entry.against, ...verdictSummary(entry), description: entry.description,
        prCheck: entry.kind === 'built' ? prCheckSummary(latestPrCheck(live.get(card))) : null,
      };
    }),
    pending: inputs.cards.filter(c => !entryOf(c.card)).map(c => c.card),
    skipped: inputs.skipped,
  };
}
