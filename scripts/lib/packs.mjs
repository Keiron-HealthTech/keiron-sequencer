import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeDescription, withoutNotesBlock } from './harvest.mjs';
import { writeAtomic } from './spike/home.mjs';

export const PACK_SCHEMA = 1;
const QUESTION_ID = /^q\d+$/;
const ASKED_STATUSES = ['open', 'narrowed'];

const sha256 = text => createHash('sha256').update(text).digest('hex');
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = v => typeof v === 'string' && v.length > 0;

export const packPath = (home, slug, card) => join(home, slug, 'packs', `${card}.json`);

// The card text the people wrote, so publishing the agent notes never makes a pack stale.
export const cardTextHash = issue => sha256(normalizeDescription(withoutNotesBlock(issue?.description ?? '')));

// An open decision from before owner and status existed is asked too: it is the people's until the spike says otherwise. A
// gate is cleared before merging or deploying, not answered before starting, so it is never asked.
const asked = d => (d?.owner ?? 'people') === 'people' && ASKED_STATUSES.includes(d?.status ?? 'open') && d?.impact !== 'gate';

// The people-owned open decisions of a startable card, each with what the code already ruled out, to be answered in one
// sitting before the card starts. options start empty: the skill adds the ones still standing.
// bases: config repo dir -> the default tip the card would start from there, for each repo whose tip could be read.
export function draftPack(record, issue, bases = {}) {
  const questions = (record.openDecisions ?? []).filter(asked).map((d, i) => ({
    id: `q${i + 1}`,
    text: d.text,
    evidence: (d.eliminated ?? []).map(e => `ruled out: ${e.option} (${e.why})`),
    options: [],
    owner: 'people',
    answer: null,
  }));
  return {
    schemaVersion: PACK_SCHEMA,
    card: record.card,
    stamp: { descriptionHash: cardTextHash(issue), recordSpikedAt: record.spikedAt, runId: record.refs?.runId ?? null, bases: { ...bases } },
    questions,
  };
}

export function validatePack(p) {
  if (!isObject(p)) return ['pack: expected object'];
  const errors = [];
  const err = (path, message) => errors.push(`${path}: ${message}`);
  if (p.schemaVersion !== PACK_SCHEMA) err('schemaVersion', `expected ${PACK_SCHEMA}`);
  if (!isText(p.card)) err('card', 'expected a card key');
  if (!isObject(p.stamp)) err('stamp', 'expected object');
  else {
    if (!isText(p.stamp.descriptionHash)) err('stamp.descriptionHash', 'expected non-empty string');
    if (!isText(p.stamp.recordSpikedAt)) err('stamp.recordSpikedAt', 'expected non-empty string');
    if (p.stamp.runId !== null && !isText(p.stamp.runId)) err('stamp.runId', 'expected string or null');
    if (!isObject(p.stamp.bases) || !Object.values(p.stamp.bases).every(isText)) err('stamp.bases', 'expected an object of repo dir to commit');
  }
  if (!Array.isArray(p.questions)) { err('questions', 'expected array'); return errors; }
  p.questions.forEach((q, i) => {
    const at = `questions[${i}]`;
    if (!isObject(q)) { err(at, 'expected object'); return; }
    if (!QUESTION_ID.test(q.id ?? '')) err(`${at}.id`, 'expected an id like q1');
    if (!isText(q.text)) err(`${at}.text`, 'expected non-empty string');
    for (const key of ['evidence', 'options']) {
      if (!Array.isArray(q[key]) || !q[key].every(isText)) err(`${at}.${key}`, 'expected an array of non-empty strings');
    }
    if (q.owner !== 'people') err(`${at}.owner`, 'expected people');
    if (q.answer === null) return;
    if (!isObject(q.answer)) { err(`${at}.answer`, 'expected null or object'); return; }
    if (!isText(q.answer.outcome)) err(`${at}.answer.outcome`, 'expected non-empty string');
    if (!isText(q.answer.answeredAt)) err(`${at}.answer.answeredAt`, 'expected non-empty string');
  });
  return errors;
}

// What moved since the pack was drafted: the card text, the spike record, or the base the card would start from in a repo
// both sides know. A repo whose tip cannot be read now, or that the pack never stamped, is not counted as a move.
export function packStale(pack, { issue, record, bases = {} }) {
  if (pack.stamp.descriptionHash !== cardTextHash(issue)) return 'card-text';
  if (pack.stamp.recordSpikedAt !== record?.spikedAt || pack.stamp.runId !== (record?.refs?.runId ?? null)) return 'record';
  const stamped = pack.stamp.bases ?? {};
  if (Object.entries(bases).some(([dir, sha]) => sha && stamped[dir] && stamped[dir] !== sha)) return 'base';
  return null;
}

export function readPack(home, slug, card) {
  const path = packPath(home, slug, card);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

export function writePack(home, slug, pack) {
  const errors = validatePack(pack);
  if (errors.length) throw new Error(`the pack of ${pack?.card} is invalid: ${errors.join('; ')}`);
  writeAtomic(packPath(home, slug, pack.card), `${JSON.stringify(pack, null, 2)}\n`);
}
