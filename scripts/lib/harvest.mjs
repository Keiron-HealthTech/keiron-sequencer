import { createHash } from 'node:crypto';
import { backwardMessage, buildCardMap, cycles, impliedChain, impliedEdges, isBackward } from './graph.mjs';
import { COMBINE_FIXUP } from './record.mjs';
import { isLive } from './records.mjs';

export const HARVEST_SCHEMA = 1;
export const NOTES_SCHEMA = 1;
export const PLAN_SCHEMA = 1;
export const NOTES_TITLE = 'Notas del agente';
// Blocks written before decisions joined the cases carry this title; they are replaced, never duplicated.
export const LEGACY_NOTES_TITLE = 'Notas del agente (casos de aceptación)';

const KINDS = ['code', 'deploy', 'gate'];
const CARD_KEY = /^[A-Z]+-\d+$/;
const NOTE_ID = /^[cdo]\d+$/;
const SOURCE_HASH = /^[0-9a-f]{12}$/;

const isText = v => typeof v === 'string' && v.trim() !== '';
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const unknownFields = (value, allowed) => Object.keys(value).filter(k => !allowed.includes(k));

const NEW_KEY = /^[a-z0-9][a-z0-9-]*$/;
const PLACEHOLDER = /^new:([a-z0-9][a-z0-9-]*)$/;
const TOP_FIELDS = ['schemaVersion', 'project', 'edges', 'removals', 'splits', 'newCards', 'rejected', 'notes', 'descriptions'];
const DESCRIPTION_FIELDS = ['text', 'evidence', 'hold', 'ref'];
const ENTRY_FIELDS = {
  edges: ['from', 'to', 'kind', 'evidence', 'ref', 'hold'],
  removals: ['from', 'to', 'reason', 'ref', 'hold', 'order'],
  splits: ['parent', 'new', 'parentHalf', 'newHalf', 'evidence', 'ref'],
  newCards: ['key', 'title', 'repo', 'milestone', 'team', 'description', 'evidence', 'blocks', 'hold', 'ref'],
  rejected: ['from', 'to', 'reason', 'ref', 'order'],
};

export function validateHarvest(value) {
  if (!isObject(value)) return ['harvest.json must be a JSON object'];
  const errors = [];
  const err = message => { errors.push(message); return false; };
  if (value.schemaVersion !== HARVEST_SCHEMA) err(`schemaVersion must be ${HARVEST_SCHEMA}`);
  for (const k of unknownFields(value, TOP_FIELDS)) err(`unknown top-level field ${k}`);
  if (!isObject(value.project)) err('project must be an object with a slug');
  else {
    for (const k of unknownFields(value.project, ['slug'])) err(`project: unknown field ${k}`);
    if (!isText(value.project.slug)) err('project.slug must be a non-empty string');
  }
  const lists = {};
  for (const name of Object.keys(ENTRY_FIELDS)) {
    if (value[name] === undefined) lists[name] = [];
    else if (Array.isArray(value[name])) lists[name] = value[name];
    else { err(`${name} must be a list`); lists[name] = []; }
  }
  const declared = new Set(lists.newCards.map(c => c?.key).filter(k => typeof k === 'string' && NEW_KEY.test(k)));

  const text = (v, path) => isText(v) || err(`${path} must be a non-empty string`);
  const endpoint = (v, path) => {
    if (typeof v === 'string' && CARD_KEY.test(v)) return true;
    const placeholder = typeof v === 'string' ? v.match(PLACEHOLDER) : null;
    if (!placeholder) return err(`${path} must be a card key like CRM-123 or new:<key>`);
    return declared.has(placeholder[1]) || err(`${path} names ${v}, which is not in newCards`);
  };
  const hold = (e, path) => {
    if ('hold' in e && e.hold !== null && !isText(e.hold)) err(`${path}.hold must be a non-empty string or null`);
  };
  const ref = (e, path) => { if ('ref' in e) text(e.ref, `${path}.ref`); };
  const entries = name => lists[name].map((e, i) => [e, `${name}[${i}]`]).filter(([e, path]) => {
    if (!isObject(e)) return err(`${path} must be an object`);
    if (e.draft === true) return err(`${path} is a draft: confirm it by removing "draft": true`);
    for (const k of unknownFields(e, ENTRY_FIELDS[name])) err(`${path}: unknown field ${k}`);
    return true;
  });
  const pairList = (name, why) => {
    const seen = new Map();
    for (const [e, path] of entries(name)) {
      const ends = [endpoint(e.from, `${path}.from`), endpoint(e.to, `${path}.to`)].every(Boolean);
      if (name === 'edges' && !KINDS.includes(e.kind)) err(`${path}.kind must be one of ${KINDS.join(', ')}`);
      text(e[why], `${path}.${why}`);
      if (name !== 'rejected') hold(e, path);
      ref(e, path);
      if ('order' in e && text(e.order, `${path}.order`) && /[\r\n]|\+\+\+/.test(e.order)) err(`${path}.order must be one line with no +++`);
      if (!ends) continue;
      const id = pairId(e.from, e.to);
      if (e.from === e.to) err(`${path} is a self-edge (${id})`);
      else if (seen.has(id)) err(`${path} repeats ${seen.get(id)} (${id})`);
      else seen.set(id, path);
    }
  };

  pairList('edges', 'evidence');
  pairList('removals', 'reason');
  for (const [e, path] of entries('splits')) {
    if (!(typeof e.parent === 'string' && CARD_KEY.test(e.parent))) err(`${path}.parent must be a card key like CRM-123`);
    endpoint(e.new, `${path}.new`);
    for (const k of ['parentHalf', 'newHalf', 'evidence']) text(e[k], `${path}.${k}`);
    ref(e, path);
  }
  const keys = new Map();
  for (const [e, path] of entries('newCards')) {
    if (!(typeof e.key === 'string' && NEW_KEY.test(e.key))) err(`${path}.key must be lowercase letters, digits and dashes, like roles-users`);
    else if (keys.has(e.key)) err(`${path}.key repeats ${keys.get(e.key)} (${e.key})`);
    else keys.set(e.key, path);
    for (const k of ['title', 'repo', 'milestone', 'description', 'evidence']) text(e[k], `${path}.${k}`);
    if ('team' in e) text(e.team, `${path}.team`);
    if ('blocks' in e && !Array.isArray(e.blocks)) err(`${path}.blocks must be a list`);
    const blocked = new Set();
    (Array.isArray(e.blocks) ? e.blocks : []).forEach((to, j) => {
      const at = `${path}.blocks[${j}]`;
      if (!endpoint(to, at)) return;
      if (to === `new:${e.key}`) err(`${at} is a self-edge (${pairId(to, to)})`);
      else if (blocked.has(to)) err(`${at} repeats ${to}`);
      blocked.add(to);
    });
    hold(e, path);
    ref(e, path);
  }
  pairList('rejected', 'reason');
  const notes = value.notes;
  const notesOk = notes === undefined || notes === 'all'
    || (Array.isArray(notes) && notes.every(k => typeof k === 'string' && CARD_KEY.test(k)) && new Set(notes).size === notes.length);
  if (!notesOk) err('notes must be "all" or a list of card keys');
  if (value.descriptions !== undefined) {
    if (!isObject(value.descriptions)) err('descriptions must be an object of card keys');
    else {
      for (const [card, e] of Object.entries(value.descriptions)) {
        const path = `descriptions.${card}`;
        if (!CARD_KEY.test(card)) { err(`descriptions: ${card} is not a card key like CRM-123`); continue; }
        if (!isObject(e)) { err(`${path} must be an object`); continue; }
        for (const k of unknownFields(e, DESCRIPTION_FIELDS)) err(`${path}: unknown field ${k}`);
        if (text(e.text, `${path}.text`) && e.text.split('\n').some(line => HEADERS.has(line.trimEnd()) || line.trim() === '+++')) {
          err(`${path}.text must hold no agent notes block and no +++ line`);
        }
        text(e.evidence, `${path}.evidence`);
        hold(e, path);
        ref(e, path);
      }
    }
  }
  return errors;
}

export function validateNotes(value) {
  if (!isObject(value)) return ['notes.es.json must be a JSON object'];
  const errors = [];
  if (value.schemaVersion !== NOTES_SCHEMA) errors.push(`schemaVersion must be ${NOTES_SCHEMA}`);
  for (const k of unknownFields(value, ['schemaVersion', 'cards'])) errors.push(`unknown top-level field ${k}`);
  if (!isObject(value.cards)) return [...errors, 'cards must be an object'];
  for (const [card, cases] of Object.entries(value.cards)) {
    if (!CARD_KEY.test(card)) { errors.push(`cards.${card} must be a card key like CRM-123`); continue; }
    if (!isObject(cases)) { errors.push(`cards.${card} must be an object`); continue; }
    for (const [id, t] of Object.entries(cases)) {
      const path = `cards.${card}.${id}`;
      if (!NOTE_ID.test(id)) { errors.push(`${path} must be an item id like c1, d1 or o1`); continue; }
      if (!isObject(t)) { errors.push(`${path} must be an object`); continue; }
      for (const k of unknownFields(t, ['source', 'es'])) errors.push(`${path}: unknown field ${k}`);
      if (!SOURCE_HASH.test(t.source ?? '')) errors.push(`${path}.source must be 12 hex characters`);
      if (!isText(t.es)) errors.push(`${path}.es must be a non-empty string`);
      else if (/[\r\n]/.test(t.es)) errors.push(`${path}.es must be one line`);
      else if (/^\s*#/.test(t.es)) errors.push(`${path}.es must not be a heading`);
      else if (t.es.includes('+++')) errors.push(`${path}.es must not contain +++`);
    }
  }
  return errors;
}

const pairId = (from, to) => `${from}>${to}`;
// Code-point order, not localeCompare: the op order feeds the plan hash, which must not depend on the machine's locale.
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function draftFromRecords(records, harvest) {
  const decided = new Set();
  for (const name of ['edges', 'removals', 'rejected']) {
    for (const e of harvest?.[name] ?? []) decided.add(pairId(e.from, e.to)).add(pairId(e.to, e.from));
  }
  const found = new Map();
  const add = (from, to, patch, note) => {
    const id = pairId(from, to);
    if (!from || !to || from === to || [from, to].includes(COMBINE_FIXUP) || decided.has(id)) return;
    if (!found.has(id)) found.set(id, { from, to, patches: new Map() });
    const patches = found.get(id).patches;
    if (!patches.get(patch)) patches.set(patch, note ?? null);
  };
  for (const r of records) {
    for (const f of r.fixups?.received ?? []) add(r.card, f.from, f.patch, f.note);
    for (const f of r.fixups?.caused ?? []) add(f.to, r.card, f.patch, f.note);
  }
  // The note says what the fixup repaired: a fix to the earlier card's own patch is no dependency, so curation needs it.
  const shown = ([patch, note]) => (note ? `${patch} (note: ${JSON.stringify(note)})` : patch);
  const edges = [...found.entries()].sort(([a], [b]) => compare(a, b)).map(([, d]) => ({
    from: d.from, to: d.to, kind: 'code', evidence: `fixup: ${[...d.patches].sort(([a], [b]) => compare(a, b)).map(shown).join(', ')}`, draft: true,
  }));
  const split = new Set((harvest?.splits ?? []).map(x => pairId(x.parent, x.new)));
  const splits = records
    .filter(r => r.alias?.splitFrom && !split.has(pairId(r.alias.splitFrom, r.card)))
    .map(r => ({ parent: r.alias.splitFrom, new: r.card, evidence: `alias.splitFrom: ${r.card} was split from ${r.alias.splitFrom}`, draft: true }))
    .sort((a, b) => compare(pairId(a.parent, a.new), pairId(b.parent, b.new)));
  return { edges, splits };
}

export const markerOf = key => '<!-- keiron-sequencer:' + key + ' -->';
const MARKER = /<!-- keiron-sequencer:([a-z0-9][a-z0-9-]*) -->/g;
const titleKey = title => String(title ?? '').trim().toLowerCase();

export function liveIndex(raw, descriptions = new Map()) {
  const byKey = new Map((raw.issues ?? []).map(n => [n.identifier, n]));
  const found = new Map();
  const link = (from, to, id) => {
    if (!from || !to) return;
    const key = pairId(from, to);
    if (!found.has(key)) found.set(key, new Set());
    if (id) found.get(key).add(id);
  };
  for (const n of raw.issues ?? []) {
    for (const r of n.relations?.nodes ?? []) if (r?.type === 'blocks') link(n.identifier, r.relatedIssue?.identifier, r.id);
    for (const r of n.inverseRelations?.nodes ?? []) if (r?.type === 'blocks') link(r.issue?.identifier, n.identifier, r.id);
  }
  const blocks = new Map([...found].map(([key, ids]) => [key, [...ids].sort()]));
  const markers = new Map();
  const titles = new Map();
  for (const [identifier, d] of descriptions) {
    for (const [, key] of String(d.description ?? '').matchAll(MARKER)) if (!markers.has(key)) markers.set(key, identifier);
    const title = titleKey(d.title);
    if (title) titles.set(title, [...(titles.get(title) ?? []), identifier]);
  }
  return { byKey, blocks, descriptions, markers, titles };
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(v => canonicalJson(v ?? null)).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const sha256 = text => createHash('sha256').update(text).digest('hex');

const NOTES_HEADER = `+++ ${NOTES_TITLE}`;
const HEADERS = new Set([NOTES_HEADER, `+++ ${LEGACY_NOTES_TITLE}`]);
const number = text => Number(String(text).match(/(\d+)$/)?.[1] ?? 0);
const byCaseId = (a, b) => number(a.id) - number(b.id);

export const caseSource = c => sha256(canonicalJson({ given: c.given, when: c.when, then: c.then })).slice(0, 12);

// A decision or open decision is translated from its text; its id is its 1-based position (d1, o1), so moving one makes it
// stale where it now stands.
export const textSource = item => sha256(canonicalJson({ text: item.text })).slice(0, 12);

const NOTE_ITEMS = [['decisions', 'd', 'decision'], ['openDecisions', 'o', 'openDecision']];
// Every item with its respike audit mark, ids assigned before anything is left out: an item with no mark holds.
const markedItemsOf = r => [
  ...(Array.isArray(r.cases) ? [...r.cases].sort(byCaseId).map(c => ({
    item: { id: c.id, kind: 'case', source: caseSource(c), given: c.given, when: c.when, then: c.then }, audit: c.audit ?? null,
  })) : []),
  ...NOTE_ITEMS.flatMap(([field, prefix, kind]) => (Array.isArray(r[field]) ? r[field] : [])
    .map((item, i) => ({ item: { id: `${prefix}${i + 1}`, kind, source: textSource(item), text: item.text }, audit: item.audit ?? null }))),
];
const holds = audit => !audit || audit.verdict === 'holds';
// Only what holds is published: a moved item is named under the card that owns it now, a not-built or dropped one is left out.
const itemsOf = r => markedItemsOf(r).filter(x => holds(x.audit)).map(x => x.item);

// Linear says what a card builds now, never where an item went: a moved item is only named in the plan's evidence, and the
// record keeps its mark.
function movedOf(r) {
  const by = new Map();
  for (const { item, audit } of markedItemsOf(r)) if (audit?.verdict === 'moved') by.set(audit.card, [...(by.get(audit.card) ?? []), item.id]);
  return [...by].map(([card, ids]) => ({ card, ids })).sort((a, b) => number(a.card) - number(b.card) || compare(a.card, b.card));
}

const isAudited = r => markedItemsOf(r).some(x => x.audit);

const leftOutOf = r => markedItemsOf(r).filter(x => x.audit && !['holds', 'moved'].includes(x.audit.verdict)).map(x => ({ id: x.item.id, verdict: x.audit.verdict }));

// What a notes block says about a record: the items it publishes, the moved ones and where, and the ones left out.
function notesEvidence(record, orders = []) {
  const kept = itemsOf(record);
  const left = leftOutOf(record);
  return [
    ...(kept.length ? [`record ${record.card}: ${kept.map(i => i.id).join(', ')}`] : []),
    ...movedOf(record).map(m => `moved to ${m.card}: ${m.ids.join(', ')}`),
    ...(left.length ? [`left out: ${left.map(l => `${l.id} (${l.verdict})`).join(', ')}`] : []),
    ...(orders.length ? [`order: ${orders.map(o => o.card).join(', ')}`] : []),
  ].join('; ');
}

// Every case, decision and open decision of the selected live records whose Spanish text is missing or no longer matches.
export function itemsToTranslate(records, notes, selection = 'all') {
  const wanted = selection === 'all' ? null : new Set(selection);
  const out = [];
  for (const r of records) {
    if (!isLive(r) || (wanted && !wanted.has(r.card))) continue;
    for (const item of itemsOf(r)) {
      const t = notes?.cards?.[r.card]?.[item.id];
      if (t?.source === item.source) continue;
      out.push({ card: r.card, ...item, status: t ? 'stale' : 'missing' });
    }
  }
  return out.sort((a, b) => number(a.card) - number(b.card) || compare(a.card, b.card));
}

const SECTIONS = [['case', 'Casos de aceptación'], ['decision', 'Decisiones'], ['openDecision', 'Decisiones abiertas']];
const ORDER_HEADING = 'Orden con otras tarjetas';

// How an open decision stands, said in the card: narrowed by the code, a gate to clear before merging or deploying, and
// decided by people rather than by the code.
const GATE_TAG = 'antes de mergear o desplegar';

function openTag(d) {
  const tags = [
    ...(d.status === 'narrowed' ? ['acotada'] : []), ...(d.impact === 'gate' ? [GATE_TAG] : []),
    ...(d.owner === 'people' ? [d.status === 'narrowed' || d.impact === 'gate' ? 'la deciden personas' : 'abierta, la deciden personas'] : []),
  ];
  return tags.length ? ` (${tags.join(', ')})` : '';
}

// One section per kind the record holds, in a fixed order; an empty kind gets no heading. Order notes come last, one per
// other card, from the rejected and removed pairs that carry one.
export function renderNotesBlock(record, notesForCard, orders = []) {
  const items = itemsOf(record);
  const open = Array.isArray(record.openDecisions) ? record.openDecisions : [];
  const lines = [NOTES_HEADER, ''];
  for (const [kind, heading] of SECTIONS) {
    const mine = items.filter(i => i.kind === kind);
    if (!mine.length) continue;
    lines.push(`**${heading}**`, '');
    for (const item of mine) {
      const es = notesForCard?.[item.id]?.es;
      if (!es) throw new Error(`no Spanish text for ${item.kind === 'case' ? 'case' : 'item'} ${item.id}`);
      const tag = kind === 'openDecision' ? openTag(open[Number(item.id.slice(1)) - 1]) : '';
      lines.push(`- **${item.id}.** ${es}${tag}`);
    }
    lines.push('');
  }
  if (orders.length) {
    lines.push(`**${ORDER_HEADING}**`, '');
    for (const o of [...orders].sort((a, b) => number(a.card) - number(b.card) || compare(a.card, b.card))) lines.push(`- **${o.card}.** ${o.es}`);
    lines.push('');
  }
  return [...lines, '+++'].join('\n');
}

// The description with its one notes block cut out, and the block it had; the counts are those replaceNotesBlock reports.
function withoutBlock(description) {
  const found = replaceNotesBlock(description, '');
  if (found.count !== 1 || found.unterminated) return found;
  return { ...found, description: withoutNotesBlock(description).trimEnd() };
}

export function replaceNotesBlock(description, block) {
  const text = description ?? '';
  const lines = text.split('\n');
  const starts = lines.flatMap((line, i) => (HEADERS.has(line.trimEnd()) ? [i] : []));
  if (starts.length > 1) return { description: text, before: null, count: starts.length };
  const [start] = starts;
  const end = start === undefined ? -1 : lines.findIndex((line, i) => i > start && line.trimEnd() === '+++');
  if (start !== undefined && end === -1) return { description: text, before: null, count: 1, unterminated: true };
  if (end === -1) {
    const head = text.trimEnd();
    return { description: head ? `${head}\n\n${block}` : block, before: null, count: starts.length };
  }
  return {
    description: [...lines.slice(0, start), block, ...lines.slice(end + 1)].join('\n'),
    before: lines.slice(start, end + 1).join('\n'),
    count: 1,
  };
}

// The card text people wrote: every agent notes block, under either title, is cut out.
export function withoutNotesBlock(description) {
  const lines = String(description ?? '').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const end = HEADERS.has(lines[i].trimEnd()) ? lines.findIndex((line, j) => j > i && line.trimEnd() === '+++') : -1;
    if (end === -1) { out.push(lines[i]); continue; }
    i = end;
  }
  return out.join('\n');
}

// Linear re-serializes markdown on save: it drops <> around link targets and backslash-escapes punctuation.
export const normalizeDescription = text => String(text ?? '')
  .replace(/\r\n?/g, '\n')
  .replace(/\]\(<([^<>\s]+)>\)/g, ']($1)')
  .replace(/\\([[\]*_<>#()!|~`+.{}-])/g, '$1')
  .split('\n')
  .map(line => line.trimEnd().replace(/^(\s*)\* /, '$1- '))
  .join('\n')
  .trimEnd();

export const descriptionHash = text => sha256(normalizeDescription(text));

export function planHash(plan) {
  const { hash, generatedAt, ...hashed } = plan;
  return sha256(canonicalJson(hashed));
}

export function approvalError(plan, approve) {
  if (typeof plan?.hash !== 'string' || planHash(plan) !== plan.hash) return 'the plan file does not match its hash: it was edited after planning; run plan again';
  if (!/^[0-9a-f]{12,64}$/.test(approve)) return '--approve takes the plan hash or its first 12 or more hex characters';
  if (!plan.hash.startsWith(approve)) return 'the approved hash does not match this plan';
  return null;
}

const TYPE_RANK = ['card.create', 'relation.create', 'relation.delete', 'notes.replace', 'description.replace'];
const byTypeThenId = (a, b) => TYPE_RANK.indexOf(a.type) - TYPE_RANK.indexOf(b.type) || compare(a.id, b.id);
const byId = (a, b) => compare(a.id, b.id);
const byPair = (a, b) => compare(pairId(a.from, a.to), pairId(b.from, b.to));
const byWarning = (a, b) => compare(a.kind, b.kind) || compare(canonicalJson(a), canonicalJson(b));

const recordsHash = records => sha256(records
  .filter(isLive)
  .flatMap(r => markedItemsOf(r).map(({ item, audit }) => `${r.card}:${item.id}:${item.source}${audit ? `:${audit.verdict}:${audit.card ?? ''}` : ''}`))
  .sort(compare)
  .join('\n'));

function reaches(edges, from, to) {
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    const at = queue.shift();
    for (const [a, b] of edges) {
      if (a !== at || seen.has(b)) continue;
      if (b === to) return true;
      seen.add(b);
      queue.push(b);
    }
  }
  return false;
}

// Where a record's notes or findings name another card: c1, d2, o1 or f3. CRM-12 never matches inside CRM-123.
function mentionsOf(record, key) {
  if (!record) return [];
  const names = new RegExp(`${key}(?!\\d)`);
  // A moved, not-built or dropped item is no longer published, so it orders nothing; its mark is left out of the match.
  const listed = (list, prefix) => (Array.isArray(list) ? list : []).flatMap((item, i) => {
    const { audit, ...text } = item ?? {};
    return holds(audit) && names.test(JSON.stringify(text)) ? [prefix === 'c' ? item.id : `${prefix}${i + 1}`] : [];
  });
  return [...listed(record.cases, 'c'), ...listed(record.decisions, 'd'), ...listed(record.openDecisions, 'o'), ...listed(record.findings, 'f')];
}

const notExecution = node => (node.archivedAt ? 'archived' : node.state?.type === 'canceled' ? 'canceled' : 'planner or QA card');

function postStateCheck(cards, live, ops, outsideUsed) {
  const onMap = new Set(cards.map(c => c.key));
  const adds = ops.filter(op => op.type === 'relation.create');
  const deletes = new Set(ops.filter(op => op.type === 'relation.delete').map(op => pairId(op.from, op.to)));
  const synthetic = new Set([...adds.flatMap(op => [op.from, op.to]), ...outsideUsed].filter(key => !onMap.has(key)));
  const nodes = [...cards, ...[...synthetic].map(key => ({ key, statusType: 'backlog' }))];
  const inGraph = new Set(nodes.map(n => n.key));
  const post = [...live.blocks.keys()]
    .filter(id => !deletes.has(id))
    .map(id => { const [from, to] = id.split('>'); return { from, to }; })
    .filter(e => inGraph.has(e.from) && inGraph.has(e.to) && e.from !== e.to)
    .concat(adds.map(op => ({ from: op.from, to: op.to })));
  const refusals = [];
  const warnings = [];
  for (const group of cycles(nodes, post)) {
    const members = new Set(group);
    if (adds.some(op => members.has(op.from) && members.has(op.to))) {
      refusals.push({ kind: 'cycle', cards: group, message: `the plan closes a cycle among ${group.join(', ')}` });
    } else warnings.push({ kind: 'cycle-untouched', cards: group });
  }
  // After the cycle check the graph is a DAG, so its transitive reduction is unique: an added edge another path already
  // implies orders nothing new and is refused, even when the path is made only of this plan's adds. A live edge that only
  // this plan's adds make redundant is someone's call: it is named, for the curator to propose removing, never refused.
  const added = new Set(adds.map(op => pairId(op.from, op.to)));
  if (refusals.length) return { refusals, warnings };
  const chainOf = (edges, e) => [e.from, ...(impliedChain(nodes, edges, e) ?? [e.from, e.to]).slice(1, -1), e.to];
  const pre = post.filter(e => !added.has(pairId(e.from, e.to)));
  const redundantBefore = new Set(impliedEdges(nodes, pre).map(e => pairId(e.from, e.to)));
  for (const e of impliedEdges(nodes, post)) {
    const id = pairId(e.from, e.to);
    const chain = chainOf(post, e);
    const via = chain.slice(1, -1);
    if (added.has(id)) {
      refusals.push({
        kind: 'redundant', from: e.from, to: e.to, via,
        message: `${e.from} blocks ${e.to} already follows from ${chain.join(' → ')}: drop the edge, or list it under rejected with the reason "redundant"`,
      });
    } else if (!redundantBefore.has(id)) {
      warnings.push({
        kind: 'live-redundant', from: e.from, to: e.to, via,
        message: `the live edge ${e.from} blocks ${e.to} now follows from ${chain.join(' → ')}: propose removing it in removals if no one needs it`,
      });
    }
  }
  return { refusals, warnings };
}

export function computePlan({ harvest, records = [], notes = null, raw, descriptions = new Map(), outside = new Map() }) {
  const live = liveIndex(raw, descriptions);
  const { cards } = buildCardMap(raw);
  const onMap = new Set(cards.map(c => c.key));
  const cardBy = new Map(cards.map(c => [c.key, c]));
  const refusals = [];
  const conflict = message => { refusals.push({ kind: 'conflict', message }); return null; };
  const ops = [];
  const keep = [];
  const noop = [];
  const held = [];
  const irreversible = [];
  const newCards = harvest.newCards ?? [];
  const heldCards = new Map(newCards.filter(c => c.hold).map(c => [`new:${c.key}`, c.hold]));
  const resolve = ref => (ref.startsWith('new:') ? live.markers.get(ref.slice(4)) ?? ref : ref);
  const resolvedPair = entry => pairId(resolve(entry.from), resolve(entry.to));
  const outsideUsed = new Set();

  const end = (key, where) => {
    if (key.startsWith('new:')) {
      return heldCards.has(key) ? conflict(`${where}: ${key} is held (${heldCards.get(key)}); hold this entry too`) : 'map';
    }
    if (onMap.has(key)) return 'map';
    const node = live.byKey.get(key);
    if (node) return conflict(`${where}: ${key} is not an execution card of the project (${notExecution(node)})`);
    const card = outside.get(key);
    if (!card || card.archivedAt) return conflict(`${where}: target not found/archived: ${key}`);
    return 'outside';
  };
  const relation = (entry, where) => {
    const from = resolve(entry.from);
    const to = resolve(entry.to);
    const ends = [end(from, where), end(to, where)];
    if (!ends.every(Boolean)) return null;
    if (ends.every(e => e === 'outside')) {
      return conflict(`${where}: ${from} and ${to} are both outside the project; one end must be a card of the project`);
    }
    if (from === to) return conflict(`${where}: ${entry.from}>${entry.to} is a self-edge once new cards are resolved`);
    const offProject = ends[0] === 'outside' ? from : ends[1] === 'outside' ? to : null;
    if (offProject) outsideUsed.add(offProject);
    return { from, to, id: pairId(from, to), extra: offProject ? { offProject } : {} };
  };

  const removed = new Set((harvest.removals ?? []).map(resolvedPair));
  const rejected = new Set((harvest.rejected ?? []).map(resolvedPair));
  const edgeEntries = [
    ...(harvest.edges ?? []).map((entry, i) => ({ entry, where: `edges[${i}]` })),
    ...newCards.flatMap((c, i) => (c.hold ? [] : (c.blocks ?? []).map((to, j) => ({
      entry: { from: `new:${c.key}`, to, kind: 'code', evidence: c.evidence },
      where: `newCards[${i}].blocks[${j}]`,
    })))),
  ];
  const listed = new Map();
  for (const { entry, where } of edgeEntries) {
    const id = resolvedPair(entry);
    if (listed.has(id)) { conflict(`${id} is listed twice (${listed.get(id)} and ${where})`); continue; }
    listed.set(id, where);
    if (removed.has(id)) conflict(`${id} is both in edges and in removals`);
    if (rejected.has(id)) conflict(`${id} is both in edges and in rejected`);
    if (entry.hold) { held.push({ id: `rel+:${id}`, hold: entry.hold, entry }); continue; }
    const r = relation(entry, where);
    if (!r) continue;
    const edge = { from: r.from, to: r.to, kind: entry.kind, evidence: entry.evidence };
    const [fromCard, toCard] = [cardBy.get(r.from), cardBy.get(r.to)];
    if (!live.blocks.has(r.id) && isBackward(fromCard, toCard)) {
      refusals.push({
        kind: 'backward-milestone', from: r.from, to: r.to, fromMilestone: fromCard.milestone, toMilestone: toCard.milestone,
        message: `${where}: ${backwardMessage(fromCard, toCard)}; ask the user which: if ${r.to} needs ${r.from}'s code, move a milestone, otherwise list it under rejected`,
      });
      continue;
    }
    if (live.blocks.has(r.id)) keep.push(edge);
    else ops.push({ id: `rel+:${r.id}`, type: 'relation.create', ...edge, before: { exists: false }, after: { exists: true }, ...r.extra });
  }

  for (const [i, entry] of (harvest.removals ?? []).entries()) {
    if (entry.hold) { held.push({ id: `rel-:${resolvedPair(entry)}`, hold: entry.hold, entry }); continue; }
    const r = relation(entry, `removals[${i}]`);
    if (!r) continue;
    if (!live.blocks.has(r.id)) { noop.push({ id: `rel-:${r.id}`, reason: 'already absent in Linear' }); continue; }
    ops.push({
      id: `rel-:${r.id}`, type: 'relation.delete', from: r.from, to: r.to, evidence: entry.reason,
      before: { exists: true, relationIds: live.blocks.get(r.id) }, after: { exists: false }, ...r.extra,
    });
  }

  const teams = raw.project.teams ?? [];
  const milestones = raw.milestones ?? [];
  for (const [i, c] of newCards.entries()) {
    const where = `newCards[${i}]`;
    const id = `card:${c.key}`;
    if (c.hold) { held.push({ id, hold: c.hold, entry: c }); continue; }
    const marked = live.markers.get(c.key);
    if (marked) { noop.push({ id, reason: `exists as ${marked} (marker)` }); continue; }
    const sameTitle = live.titles.get(titleKey(c.title));
    if (sameTitle) { conflict(`${where}: "${c.title}" matches ${sameTitle.join(', ')} by title but has no keiron-sequencer marker`); continue; }
    const teamKeys = teams.map(t => t.key).join(', ');
    const team = c.team ? teams.find(t => t.key === c.team) : teams.length === 1 ? teams[0] : null;
    if (!team) {
      conflict(c.team ? `${where}: team ${c.team} is not a team of the project (${teamKeys})`
        : `${where}: the project has ${teams.length} teams (${teamKeys}); set team`);
    }
    const milestone = milestones.find(m => m.name === c.milestone);
    if (!milestone) {
      conflict(`${where}: milestone "${c.milestone}" is not in the project; its milestones are ${milestones.map(m => m.name).join(', ')}`);
    }
    if (!team || !milestone) continue;
    ops.push({
      id, type: 'card.create', key: c.key, title: c.title, repo: c.repo, milestone: c.milestone, team: team.key, evidence: c.evidence,
      before: { match: null },
      after: {
        teamId: team.id, projectId: raw.project.id, projectMilestoneId: milestone.id, title: c.title,
        description: `Repo: ${c.repo}\n\n${c.description}\n\n${markerOf(c.key)}`,
      },
    });
    irreversible.push(id);
  }

  const splits = [];
  for (const [i, s] of (harvest.splits ?? []).entries()) {
    for (const key of [s.parent, s.new].map(resolve)) {
      if (!key.startsWith('new:') && !onMap.has(key)) conflict(`splits[${i}]: ${key} is not a card of the project`);
    }
    splits.push({ parent: s.parent, new: s.new, parentHalf: s.parentHalf, newHalf: s.newHalf, evidence: s.evidence });
  }

  // A pair the plan leaves unblocked while a record of either card names the other is an order someone has to know: the
  // entry says what each card does if the other lands first, and that line goes into both cards' notes.
  const liveRecords = new Map(records.filter(isLive).map(r => [r.card, r]));
  const settled = key => ['completed', 'canceled'].includes(cardBy.get(key)?.statusType);
  const orders = new Map();
  const deleted = new Set(ops.filter(op => op.type === 'relation.delete').map(op => pairId(op.from, op.to)));
  const after = [...live.blocks.keys()].filter(id => !deleted.has(id)).map(id => id.split('>'))
    .concat(ops.filter(op => op.type === 'relation.create').map(op => [op.from, op.to]));
  const ordered = (a, b) => reaches(after, a, b) || reaches(after, b, a);
  const unblocked = [
    ...(harvest.rejected ?? []).map((entry, i) => ({ entry, where: `rejected[${i}]` })),
    ...(harvest.removals ?? []).map((entry, i) => ({ entry, where: `removals[${i}]` })).filter(({ entry }) => !entry.hold),
  ];
  const backwardRefs = [];
  for (const { entry, where } of unblocked) {
    const [from, to] = [resolve(entry.from), resolve(entry.to)];
    const [fromCard, toCard] = [cardBy.get(from), cardBy.get(to)];
    const named = mentionsOf(liveRecords.get(to), from);
    if (named.length && isBackward(fromCard, toCard) && !settled(from) && !settled(to) && !ordered(from, to)) {
      backwardRefs.push({
        kind: 'backward-reference', from, to, mentions: named.map(id => `${to} ${id}`),
        message: `${where}: ${to} (${toCard.milestone}) names ${from} (${fromCard.milestone}) in ${named.join(', ')}: `
          + `ask the user whether ${to} belongs in a later milestone, where ${from} would block it`,
      });
    }
    if (entry.order) {
      for (const [card, other] of [[from, to], [to, from]]) {
        if (onMap.has(card)) orders.set(card, [...(orders.get(card) ?? []), { card: other, es: entry.order }]);
      }
      continue;
    }
    if (![from, to].every(key => onMap.has(key)) || settled(from) || settled(to) || ordered(from, to)) continue;
    const mentions = [[to, from], [from, to]].flatMap(([card, other]) => mentionsOf(liveRecords.get(card), other).map(id => ({ card, id, other })));
    if (!mentions.length) continue;
    refusals.push({
      kind: 'unordered-reference', from, to, mentions: mentions.map(m => `${m.card} ${m.id}`),
      message: `${where}: ${mentions.map(m => `${m.card} ${m.id} names ${m.other}`).join('; ')}, but ${from} will not block ${to}: `
        + 'keep the edge, or add an order note (order) saying what each card does if the other lands first',
    });
  }

  // A deploy or gate edge needs none of the blocker's code: the blocked card says so in its order notes, in the words next
  // and start read ("Sale después de"), so the relation gates its merge and deploy instead of its start.
  for (const entry of harvest.edges ?? []) {
    if (entry.hold || entry.kind === 'code') continue;
    const [from, to] = [resolve(entry.from), resolve(entry.to)];
    if (from.startsWith('new:') || !onMap.has(to)) continue;
    orders.set(to, [...(orders.get(to) ?? []), { card: from, es: `Sale después de ${from}: no necesita su código.` }]);
  }

  const descriptionEntries = harvest.descriptions ?? {};
  for (const [card, entry] of Object.entries(descriptionEntries)) if (entry.hold) held.push({ id: `description:${card}`, hold: entry.hold, entry });
  const rewritten = new Set(Object.keys(descriptionEntries).filter(card => !descriptionEntries[card].hold));
  const newBlocks = new Map();
  const withCases = new Map(records.filter(r => isLive(r) && (itemsOf(r).length || isAudited(r))).map(r => [r.card, r]));
  const selection = harvest.notes ?? [];
  const selected = selection === 'all' ? [...withCases.keys()].filter(card => onMap.has(card)) : [];
  if (selection !== 'all') {
    for (const card of selection) {
      if (withCases.has(card) && onMap.has(card)) selected.push(card);
      else conflict(`notes: ${card} has no live record with cases or decisions on the project map`);
    }
  }
  for (const card of orders.keys()) if (!selected.includes(card)) selected.push(card);
  for (const card of selected.sort((a, b) => number(a) - number(b) || compare(a, b))) {
    if (!live.descriptions.has(card)) { conflict(`notes: the description of ${card} was not read; plan again`); continue; }
    const record = withCases.get(card) ?? { card };
    const cardOrders = orders.get(card) ?? [];
    const missing = itemsToTranslate([record], notes, [card]);
    for (const m of missing) {
      refusals.push({
        kind: 'needs-translation', card, case: m.id, status: m.status,
        message: `${card} ${m.id}: the Spanish text is ${m.status}; run cases and update notes.es.json`,
      });
    }
    if (missing.length) continue;
    // An audited card where nothing holds any more publishes no block: the one it has is removed, not left frozen.
    const block = itemsOf(record).length || cardOrders.length ? renderNotesBlock(record, notes?.cards?.[card], cardOrders) : null;
    const current = live.descriptions.get(card)?.description ?? '';
    const next = block === null ? withoutBlock(current) : replaceNotesBlock(current, block);
    const id = `notes:${card}`;
    if (next.count > 1) { conflict(`notes: ${card} has ${next.count} agent notes blocks in its description; leave one`); continue; }
    if (next.unterminated) { conflict(`notes: ${card} has an agent notes header with no closing +++; fix the description by hand`); continue; }
    const evidence = notesEvidence(record, cardOrders);
    if (rewritten.has(card)) { newBlocks.set(card, { block, evidence }); continue; }
    if (block === null && next.before === null) { noop.push({ id, reason: 'no notes block to remove' }); continue; }
    if (block !== null && next.before !== null && normalizeDescription(next.before) === normalizeDescription(block)) {
      noop.push({ id, reason: 'notes already current' });
      continue;
    }
    ops.push({
      id, type: 'notes.replace', card, issueId: live.descriptions.get(card)?.id ?? live.byKey.get(card).id,
      evidence,
      before: { descriptionHash: descriptionHash(current), block: next.before },
      after: { descriptionHash: descriptionHash(next.description), block, description: next.description },
    });
  }

  // A new card text replaces the part people wrote; the notes block goes in the same op, so the card is written once and
  // its before-hash is the one the plan read. The block is the new one when the card is in notes, else the one it has.
  for (const card of [...rewritten].sort((a, b) => number(a) - number(b) || compare(a, b))) {
    const entry = descriptionEntries[card];
    const id = `description:${card}`;
    if (!onMap.has(card)) { conflict(`descriptions: ${card} is not a card of the project`); continue; }
    if (!live.descriptions.has(card)) { conflict(`descriptions: the description of ${card} was not read; plan again`); continue; }
    if (selected.includes(card) && !newBlocks.has(card)) continue;
    const current = live.descriptions.get(card).description ?? '';
    const found = replaceNotesBlock(current, '');
    if (found.count > 1) { conflict(`descriptions: ${card} has ${found.count} agent notes blocks in its description; leave one`); continue; }
    if (found.unterminated) { conflict(`descriptions: ${card} has an agent notes header with no closing +++; fix the description by hand`); continue; }
    const block = newBlocks.has(card) ? newBlocks.get(card).block : found.before;
    const kept = [...withoutNotesBlock(current).matchAll(MARKER)].map(m => m[0]).filter(m => !entry.text.includes(m));
    const description = [entry.text.trimEnd(), ...(kept.length ? [kept.join('\n')] : []), ...(block ? [block] : [])].join('\n\n');
    if (normalizeDescription(description) === normalizeDescription(current)) { noop.push({ id, reason: 'description already current' }); continue; }
    ops.push({
      id, type: 'description.replace', card, issueId: live.descriptions.get(card).id ?? live.byKey.get(card).id,
      evidence: entry.evidence,
      before: { descriptionHash: descriptionHash(current), description: current },
      after: { descriptionHash: descriptionHash(description), description, notes: newBlocks.get(card)?.evidence ?? null },
    });
  }

  const graph = postStateCheck(cards, live, ops, outsideUsed);
  refusals.push(...graph.refusals);
  const warnings = [...graph.warnings, ...backwardRefs];
  for (const w of raw.warnings ?? []) warnings.push({ kind: w.kind, card: w.key, message: w.message });
  warnings.sort(byWarning);
  if (refusals.length) return { plan: null, refusals: refusals.sort((a, b) => compare(a.kind, b.kind)), warnings };

  const plan = {
    schemaVersion: PLAN_SCHEMA,
    project: { id: raw.project.id, slug: raw.project.slug, name: raw.project.name },
    inputs: { harvest: sha256(canonicalJson(harvest)), notes: sha256(canonicalJson(notes ?? null)), records: recordsHash(records) },
    ops: ops.sort(byTypeThenId),
    keep: keep.sort(byPair),
    noop: noop.sort(byId),
    held: held.sort(byId),
    splits: splits.sort((a, b) => compare(pairId(a.parent, a.new), pairId(b.parent, b.new))),
    warnings,
    irreversible: irreversible.sort(compare),
  };
  return { plan: { ...plan, hash: planHash(plan) }, refusals, warnings };
}

function observeRelation(op, live, from, to) {
  if (live.byKey) {
    for (const key of [from, to]) {
      if (key === op.offProject) continue;
      const n = live.byKey.get(key);
      if (!n) return { drift: `${key} is no longer in the project` };
      if (n.archivedAt) return { drift: `${key} is archived` };
    }
  }
  if (live.blocks.has(pairId(to, from))) return { drift: `${to} already blocks ${from}` };
  return live.blocks.has(pairId(from, to)) ? 'applied' : 'pending';
}

export function observe(op, live, resolved = new Map()) {
  const ref = key => (key.startsWith('new:') ? resolved.get(key) ?? live.markers?.get(key.slice(4)) ?? null : key);
  switch (op.type) {
    case 'relation.create': {
      const [from, to] = [ref(op.from), ref(op.to)];
      return from && to ? observeRelation(op, live, from, to) : 'pending';
    }
    case 'relation.delete': {
      const ids = live.blocks.get(pairId(ref(op.from), ref(op.to)));
      if (!ids) return 'applied';
      const planned = op.before.relationIds ?? [];
      if (canonicalJson(ids) === canonicalJson(planned)) return 'pending';
      return { drift: `${op.from} blocks ${op.to} under relation ids ${ids.join(', ')}, not ${planned.join(', ')} as planned` };
    }
    case 'card.create': {
      if (resolved.has(`new:${op.key}`) || live.markers?.has(op.key)) return 'applied';
      const sameTitle = live.titles?.get(titleKey(op.title));
      return sameTitle ? { drift: `a card titled "${op.title}" exists without the keiron-sequencer marker: ${sameTitle.join(', ')}` } : 'pending';
    }
    case 'notes.replace':
    case 'description.replace': {
      const current = live.descriptions?.get(op.card);
      if (!current) return { drift: `${op.card} is no longer in the project` };
      const hash = descriptionHash(current.description);
      if (hash === op.after.descriptionHash) return 'applied';
      return hash === op.before.descriptionHash ? 'pending' : { drift: `the description of ${op.card} changed since the plan` };
    }
    default:
      throw new Error(`unknown op type ${op.type}`);
  }
}

const warningLine = w => {
  if (w.kind === 'cycle-untouched') return `- cycle-untouched: ${w.cards.join(', ')} already form a cycle in Linear; this plan does not touch it`;
  return `- ${w.kind}: ${w.message}`;
};

const section = (title, lines) => (lines.length ? [`## ${title}`, '', ...lines, ''] : []);

export function renderReview(plan, { refusals = [], approveCommand, project, warnings = [] } = {}) {
  const about = plan?.project ?? project;
  const header = [`# Harvest plan: ${about.name}`, '', `- Project: ${about.name} (${about.slug})`];
  if (!plan) {
    return [
      ...header,
      '- Status: refused; no plan file was written. Fix the input and run plan again.',
      '',
      ...section('Warnings', warnings.map(warningLine)),
      ...section('Refusals', refusals.map(r => `- ${r.kind}: ${r.message}`)),
    ].join('\n');
  }
  const of = type => plan.ops.filter(op => op.type === type);
  const cards = of('card.create');
  const notes = of('notes.replace').flatMap(op => [
    `### ${op.card}: ${op.after.block === null ? 'remove the block' : op.before.block === null ? 'add the block' : 'replace the block'}`, '', op.evidence, '',
    ...(op.after.block === null ? [] : ['```text', op.after.block, '```', '']),
  ]);
  const text = description => ['```text', withoutNotesBlock(description).trimEnd(), '```'];
  const descriptions = of('description.replace').flatMap(op => [
    `### ${op.card}: replace the description`, '', op.evidence, '', 'Before:', '', ...text(op.before.description), '', 'After:', '', ...text(op.after.description), '',
    ...(op.after.notes ? [`The notes block is written in the same op (${op.after.notes}):`, '', '```text', replaceNotesBlock(op.after.description, '').before, '```', ''] : []),
  ]);
  return [
    ...header,
    `- Hash: \`${plan.hash}\``,
    '',
    ...(plan.ops.length ? [] : ['No changes: Linear already matches this harvest.', '']),
    ...section('Warnings', plan.warnings.map(warningLine)),
    ...section('Refusals', refusals.map(r => `- ${r.kind}: ${r.message}`)),
    ...section('New cards', cards.map(op => `- new:${op.key}: "${op.title}" (${op.repo}; milestone ${op.milestone}; team ${op.team}): ${op.evidence}`)),
    ...section('Splits (review only, nothing is written)',
      plan.splits.map(s => `- ${s.parent} keeps its ID as ${s.parentHalf}; ${s.new} is ${s.newHalf}: ${s.evidence}`)),
    ...section('Relations to add', of('relation.create').map(op =>
      `- ${op.from} blocks ${op.to} (${op.kind}${op.offProject ? `, ${op.offProject} is off-project` : ''}): ${op.evidence}`)),
    ...section('Relations to remove', of('relation.delete').map(op => `- ${op.from} no longer blocks ${op.to}: ${op.evidence}`)),
    ...(notes.length ? ['## Agent notes', '', ...notes] : []),
    ...(descriptions.length ? ['## Descriptions', '', ...descriptions] : []),
    '## Unchanged',
    '',
    `${plan.keep.length} listed relation(s) already in Linear.`,
    ...plan.noop.map(n => `- ${n.id}: ${n.reason}`),
    '',
    ...section('Held', plan.held.map(h => `- ${h.id}: held (${h.hold})`)),
    ...(cards.length ? ['New cards cannot be undone; archive them by hand.', ''] : []),
    '## Apply',
    '',
    'Nothing is written to Linear until this exact command is run:',
    '',
    '```',
    approveCommand,
    '```',
    '',
  ].join('\n');
}
