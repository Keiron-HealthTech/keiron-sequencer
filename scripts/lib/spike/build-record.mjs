import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cardSizes } from '../patch-stats.mjs';
import {
  CASE_SOURCES, FINDING_KINDS, OPEN_DECISION_IMPACTS, OPEN_DECISION_OWNERS, OPEN_DECISION_STATUSES, PRIOR_FINDING_OUTCOMES,
  serializeRecord, validateNoteFields, validateRecord,
} from '../record.mjs';
import { displayData, runDir, writeAtomic } from './home.mjs';
import { mergeRiskAreas, riskAreas } from './derive.mjs';
import { offProjectFindings } from './order.mjs';
import { parseCardPatchName } from './snapshot.mjs';
import { timeBoxFor } from './state.mjs';

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const patchRoot = state => join(runDir(state.home, state.project.slug, state.runId), 'patches');

function sizeOf(state, card, readPatch) {
  const names = state.cards[card].patches;
  const prefix = card.split('-')[0];
  for (const name of names) {
    if (parseCardPatchName(name, { prefix })?.card !== card) throw new Error(`${name} is not a card patch of ${card}`);
  }
  const patchMap = {
    cards: { [card]: {} },
    repos: Object.fromEntries(names.map(n => n.split('/')[0]).map(dir => [dir, state.repos[dir].name])),
    patches: Object.fromEntries(names.map(n => [n, { kind: 'card', cards: [card] }])),
  };
  return cardSizes(patchMap, readPatch)[card];
}

const DIFF_TEXT = [/diff --git/, /(^|\n)\+\+\+ b\//, /(^|\n)--- a\//, /@@ -/];

function diffTextAt(value, path, out, why) {
  if (typeof value === 'string') {
    if (DIFF_TEXT.some(re => re.test(value))) out.push(`${path}: holds diff text; ${why}`);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => diffTextAt(v, `${path}[${i}]`, out, why));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) diffTextAt(v, `${path}.${k}`, out, why);
  }
  return out;
}

export const findDiffText = (value, path, why) => diffTextAt(value, path, [], why);

const one = values => `<one of: ${values.join(', ')}>`;

export const NOTES_ALLOWED = {
  source: CASE_SOURCES, kind: FINDING_KINDS, impact: OPEN_DECISION_IMPACTS, status: OPEN_DECISION_STATUSES, owner: OPEN_DECISION_OWNERS,
  outcome: PRIOR_FINDING_OUTCOMES,
};

// Every notes key with one placeholder item; on a respike each old finding is listed for its outcome. A string starting
// with < is a placeholder: replace it, drop an item that does not apply, and list [] where there are none.
export function notesTemplate(previous) {
  return {
    scope: { complete: true, note: null },
    cases: [{ given: '<the starting state>', when: '<the action>', then: '<the observable result>', source: one(CASE_SOURCES), ref: '<source>:<id, matching the source>' }],
    decisions: [{ text: '<a decision the spike settled, with its evidence>', ref: '<engram:<project>#<id> | linear:<KEY> | patch:<dir>/<file>.patch>' }],
    findings: [{ kind: one(FINDING_KINDS), text: '<what the spike found>', ref: '<ref>' }],
    ...(previous ? { priorFindings: previous.findings.map(f => ({ text: f.text, outcome: one(PRIOR_FINDING_OUTCOMES), ref: f.ref })) } : {}),
    openDecisions: [{
      text: '<a question the code does not settle>', impact: one(OPEN_DECISION_IMPACTS), status: one(OPEN_DECISION_STATUSES),
      owner: one(OPEN_DECISION_OWNERS), eliminated: [{ option: '<an option the code rules out>', why: '<the evidence>' }], ref: '<ref>',
    }],
    piiInLogs: [],
    engram: [],
  };
}

export function checkNotes(notes) {
  const errors = findDiffText(notes, 'notes', 'the notes describe the change and the patch holds it');
  if (!Array.isArray(notes?.openDecisions)) errors.push('notes.openDecisions: expected an array (use [] when there are none)');
  else {
    notes.openDecisions.forEach((d, i) => {
      if (d && typeof d === 'object' && !('impact' in d)) errors.push(`notes.openDecisions[${i}].impact: required (design or detail)`);
    });
  }
  errors.push(...validateNoteFields(notes).filter(e => !e.startsWith('notes:')));
  if (!Array.isArray(notes?.piiInLogs)) errors.push('notes.piiInLogs: expected an array of <repoDir>/<path> (use [] when there are none)');
  else notes.piiInLogs.forEach((p, i) => { if (typeof p !== 'string' || !p) errors.push(`notes.piiInLogs[${i}]: expected a non-empty <repoDir>/<path>`); });
  return errors;
}

// An existing PR was not written in this run, so its tokens are not the card's effort.
function effortOf(state, card, windows) {
  if (state.plan.cards[card].origin === 'existing-pr') return null;
  if (!windows.length || windows.some(w => !w.tokens)) return null;
  return {
    basis: 'card-run',
    runId: state.runId,
    windows: windows.map(w => ({ start: w.start, end: w.end, cards: [card], messages: w.messages, tokens: w.tokens })),
  };
}

function fixupsOf(state, card) {
  const fixups = state.fixups ?? [];
  return {
    received: fixups.filter(f => f.fixed.includes(card)).map(f => ({ from: f.from, patch: f.patch, note: f.note })),
    caused: fixups.filter(f => f.from === card).flatMap(f => f.fixed.map(to => ({ to, patch: f.patch, note: f.note }))),
  };
}

function withOffProject(findings, offProject) {
  if (!Array.isArray(findings)) return findings;
  const known = new Set(findings.map(f => f?.ref));
  return [...findings, ...offProjectFindings(offProject).filter(f => !known.has(f.ref))];
}

// Derived fields stay absent when the state never computed them, so such a record reads as unknown, not as none.
function derivedFields(cardState, notes, origin) {
  const out = {};
  if (Array.isArray(cardState.riskAreas)) {
    out.riskAreas = mergeRiskAreas([cardState.riskAreas, riskAreas(null, [], [], notes.piiInLogs ?? [])]);
  }
  if (Array.isArray(cardState.newPaths)) out.novelty = { newPaths: cardState.newPaths };
  const timeBox = origin === 'existing-pr' ? null : timeBoxFor(cardState);
  if (timeBox) out.timeBox = timeBox;
  return out;
}

function assemble(state, card, notes, readPatch) {
  const noteErrors = checkNotes(notes);
  if (noteErrors.length) throw new Error(`the notes for ${card} are invalid: ${noteErrors.join('; ')}`);
  const planned = state.plan.cards[card];
  const { windows, patches } = state.cards[card];
  const record = {
    schemaVersion: 1,
    card,
    title: planned.title,
    project: { slug: state.project.slug, name: state.project.name },
    origin: planned.origin,
    spikedAt: windows.at(-1).end,
    scope: notes.scope,
    size: sizeOf(state, card, readPatch),
    effort: effortOf(state, card, windows),
    fixups: fixupsOf(state, card),
    cases: Array.isArray(notes.cases) ? notes.cases.map((c, i) => ({ id: `c${i + 1}`, ...c })) : notes.cases,
    decisions: notes.decisions,
    findings: withOffProject(notes.findings, planned.offProject ?? []),
    ...(notes.priorFindings !== undefined ? { priorFindings: notes.priorFindings } : {}),
    openDecisions: notes.openDecisions,
    ...derivedFields(state.cards[card], notes, planned.origin),
    refs: { engram: notes.engram ?? [], patches: [...patches].sort(compare), linear: planned.url, runId: state.runId },
  };
  const errors = validateRecord(record);
  if (errors.length) throw new Error(`the record for ${card} is invalid: ${errors.join('; ')}`);
  return record;
}

export const buildSpikeRecord = (state, card, notes) =>
  assemble(state, card, notes, name => readFileSync(join(patchRoot(state), name), 'utf8'));

function readExisting(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`cannot read the existing record ${path}: ${e.message}`);
  }
}

// A record from another run (or from the backfill, which has no run id) is history, not something to overwrite.
export function writeSpikeRecord(dataDir, slug, record) {
  const path = join(dataDir, slug, `${record.card}.json`);
  if (existsSync(path)) {
    const old = readExisting(path);
    if (old.refs?.runId !== record.refs.runId) {
      const target = join(dataDir, slug, 'spike', 'history', record.card, `${String(old.spikedAt).replaceAll(':', '-')}.json`);
      mkdirSync(dirname(target), { recursive: true });
      renameSync(path, target);
    }
  }
  writeAtomic(path, serializeRecord(record));
  return `${displayData(dataDir, slug)}/${record.card}.json`;
}

const PII = 'pii-in-logs';

// Only what a replay can measure moves: size, the glob-matched risk areas and the new paths. A replay cannot re-attest
// pii paths, so the attested area stays as recorded.
export function replayedRecord(record, { size, derived, patches, replayed }) {
  const attested = (record.riskAreas ?? []).filter(a => a.kind === PII);
  return {
    ...record,
    size,
    riskAreas: mergeRiskAreas([...derived.map(d => d.riskAreas), attested]),
    novelty: { ...record.novelty, newPaths: [...new Set(derived.flatMap(d => d.newPaths))].sort(compare) },
    replayed,
    refs: { ...record.refs, patches: [...patches].sort(compare), runId: replayed.runId },
  };
}

// A replay keeps the card's record in place: it is the same spike, now pointing at the run that replayed it.
export function writeReplayedRecord(dataDir, slug, record) {
  const errors = validateRecord(record);
  if (errors.length) throw new Error(`the replayed record for ${record.card} is invalid: ${errors.join('; ')}`);
  writeAtomic(join(dataDir, slug, `${record.card}.json`), serializeRecord(record));
  return `${displayData(dataDir, slug)}/${record.card}.json`;
}

// Settling only changes a written record's effort and timeBox; the rest stays as written.
export function rewriteUsage(state, card, dataDir) {
  const path = join(dataDir, state.project.slug, `${card}.json`);
  if (!existsSync(path)) return null;
  const { timeBox: _, ...old } = readExisting(path);
  if (old.refs?.runId !== state.runId) return null;
  const record = { ...old, effort: effortOf(state, card, state.cards[card].windows) };
  const timeBox = state.plan.cards[card].origin === 'existing-pr' ? null : timeBoxFor(state.cards[card]);
  if (timeBox) record.timeBox = timeBox;
  const errors = validateRecord(record);
  if (errors.length) throw new Error(`the record for ${card} is invalid: ${errors.join('; ')}`);
  writeAtomic(path, serializeRecord(record));
  return `${displayData(dataDir, state.project.slug)}/${card}.json`;
}

export const notesPath = (state, card) => join(runDir(state.home, state.project.slug, state.runId), 'notes', `${card}.json`);

// A replayed card kept its record and has no notes in this run: the fixup is only appended to what it received.
function receivedOnReplayed(state, card, dataDir) {
  const path = join(dataDir, state.project.slug, `${card}.json`);
  const record = readExisting(path);
  const fixup = state.fixups.at(-1);
  const next = { ...record, fixups: { ...record.fixups, received: [...(record.fixups?.received ?? []), { from: fixup.from, patch: fixup.patch, note: fixup.note }] } };
  const errors = validateRecord(next);
  if (errors.length) throw new Error(`the record for ${card} is invalid: ${errors.join('; ')}`);
  return next;
}

// The fixed cards' records are rebuilt from the notes kept at their end; the fixup patch counts toward no card's size.
// Every record is built and validated before the patch or any record is written.
export function finishFixup(state, fixed, { pending, dataDir }) {
  const records = fixed.map(card => {
    if (state.cards[card].replay?.status === 'replayed') return { replayed: true, record: receivedOnReplayed(state, card, dataDir) };
    let notes;
    try {
      notes = JSON.parse(readFileSync(notesPath(state, card), 'utf8'));
    } catch (e) {
      throw new Error(`cannot read the notes kept for ${card} at ${notesPath(state, card)}: ${e.code ?? e.message}`);
    }
    return { replayed: false, record: buildSpikeRecord(state, card, notes) };
  });
  writeAtomic(join(patchRoot(state), pending.name), pending.text);
  return records.map(r => (r.replayed ? writeReplayedRecord : writeSpikeRecord)(dataDir, state.project.slug, r.record));
}

// The record is validated against the in-memory patches before any patch or record reaches the disk,
// so a refused card leaves the run exactly as it was and can be ended again once the notes are fixed.
export function finishCard(state, card, notes, { pending, dataDir }) {
  const texts = new Map(pending.map(p => [p.name, p.text]));
  const record = assemble(state, card, notes, name => texts.get(name) ?? readFileSync(join(patchRoot(state), name), 'utf8'));
  for (const p of pending) writeAtomic(join(patchRoot(state), p.name), p.text);
  return { record, path: writeSpikeRecord(dataDir, state.project.slug, record) };
}
