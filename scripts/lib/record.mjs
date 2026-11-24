export const SCHEMA_VERSION = 1;
export const ORIGINS = ['thin-spike', 'existing-pr'];
export const FINDING_KINDS = ['reorder', 'split', 'under-scoped', 'risk'];
export const CASE_SOURCES = ['engram', 'linear', 'patch'];
export const OPEN_DECISION_IMPACTS = ['design', 'detail'];
export const OPEN_DECISION_STATUSES = ['open', 'narrowed'];
export const OPEN_DECISION_OWNERS = ['people', 'code'];
export const PRIOR_FINDING_OUTCOMES = ['holds', 'resolved', 'wrong'];
// What a respike audit found for an old case or decision of a card it did not re-spike. The PR check, before the run, holds
// a built card's record against its PR (holds or not-built); the fresh check, after the run, holds every such card against
// the records the run spiked. Only a built card has not-built items.
export const AUDIT_VERDICTS = ['holds', 'moved', 'not-built', 'dropped'];
export const PR_CHECK_VERDICTS = ['holds', 'not-built'];
export const AUDIT_CHECKS = ['pr', 'fresh'];
export const AUDIT_KINDS = ['built', 'unbuilt'];
export const TOKEN_KEYS = ['input', 'cacheCreation', 'cacheRead', 'output', 'thinking'];
export const DELETION_WEIGHT = 0.25;
export const EFFORT_BASES = ['transcript-window', 'card-run'];
export const RUN_ID = /^\d{8}T\d{6}Z$/;

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const STORED_TIER = 'tier is computed at read time and must not be stored';
const STORED_VERDICT = 'verdict is computed at read time and must not be stored';
const CARD_KEY = /^[A-Z]+-\d+$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ENGRAM_ID = /^[\w.-]+#\d+$/;
const PATCH_PATH = /^[^/\s]+\/[^/\s]+\.patch$/;
const CASE_ID = /^c\d+$/;
const REF = /^(engram:[\w.-]+#\d+|linear:[A-Z]+-\d+|patch:[^/\s]+\/[^/\s]+\.patch)$/;

const isDatetime = v => typeof v === 'string' && DATETIME.test(v) && !Number.isNaN(Date.parse(v));
const isDate = v => typeof v === 'string' && DATE.test(v) && !Number.isNaN(Date.parse(v));
const isNonEmpty = v => typeof v === 'string' && v.length > 0;
const isCount = v => Number.isInteger(v) && v >= 0;
const isSet = v => v !== null && v !== undefined;
const isRunId = v => typeof v === 'string' && RUN_ID.test(v);
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function checker() {
  const errors = [];
  const fail = (path, message) => { errors.push(`${path}: ${message}`); return false; };
  const check = (ok, path, message) => ok || fail(path, message);
  const has = (obj, key, path) => key in obj || fail(`${path}.${key}`, 'required');
  const object = (v, path) => check(isObject(v), path, 'expected object');
  const array = (v, path) => check(Array.isArray(v), path, 'expected array');
  const text = (v, path) => check(isNonEmpty(v), path, 'expected non-empty string');
  const count = (v, path) => check(isCount(v), path, 'expected integer >= 0');
  const card = (v, path) => check(typeof v === 'string' && CARD_KEY.test(v), path, 'expected card key like CRM-123');
  const datetime = (v, path) => check(isDatetime(v), path, 'expected ISO 8601 UTC datetime');
  const oneOf = (v, values, path) => check(values.includes(v), path, `expected one of ${values.join(', ')}`);
  const items = (v, path, each) => {
    if (!array(v, path)) return false;
    v.forEach((item, i) => each(item, `${path}[${i}]`));
    return true;
  };
  const ref = (v, path) => check(typeof v === 'string' && REF.test(v), path, 'expected engram:<project>#<id>, linear:<KEY> or patch:<dir>/<file>.patch');
  const note = (v, path) => check(v === null || isNonEmpty(v), path, 'expected non-empty string or null');
  return { errors, fail, check, has, object, array, text, count, card, datetime, oneOf, items, ref, note };
}

function validateSize(size, c) {
  if (size === null || !c.object(size, '$.size')) return;
  for (const key of ['prodLines', 'testLines', 'files']) if (c.has(size, key, '$.size')) c.count(size[key], `$.size.${key}`);
  if (c.has(size, 'repos', '$.size')) {
    c.items(size.repos, '$.size.repos', (repo, path) => c.text(repo, path));
    if (Array.isArray(size.repos)) c.check(size.repos.length > 0, '$.size.repos', 'expected at least one repo');
  }
  if ('sharedWith' in size) c.items(size.sharedWith, '$.size.sharedWith', (k, path) => c.card(k, path));
  if (c.has(size, 'deletionWeight', '$.size')) {
    c.check(size.deletionWeight === DELETION_WEIGHT, '$.size.deletionWeight', `expected ${DELETION_WEIGHT}`);
  }
}

function validateEffort(effort, card, c) {
  if (effort === null || !c.object(effort, '$.effort')) return;
  if (c.has(effort, 'basis', '$.effort')) c.oneOf(effort.basis, EFFORT_BASES, '$.effort.basis');
  if (effort.basis === 'card-run' && c.has(effort, 'runId', '$.effort')) c.check(isRunId(effort.runId), '$.effort.runId', 'expected a run id like 20261110T100000Z');
  if (!c.has(effort, 'windows', '$.effort')) return;
  if (Array.isArray(effort.windows)) c.check(effort.windows.length > 0, '$.effort.windows', 'expected at least one window');
  c.items(effort.windows, '$.effort.windows', (w, path) => {
    if (!c.object(w, path)) return;
    const start = c.has(w, 'start', path) && c.datetime(w.start, `${path}.start`);
    const end = c.has(w, 'end', path) && c.datetime(w.end, `${path}.end`);
    if (start && end) c.check(Date.parse(w.start) < Date.parse(w.end), path, 'expected start < end');
    if (c.has(w, 'cards', path) && c.items(w.cards, `${path}.cards`, (k, p) => c.card(k, p))) {
      c.check(w.cards.includes(card), `${path}.cards`, `expected to include ${card}`);
    }
    if (c.has(w, 'messages', path)) c.count(w.messages, `${path}.messages`);
    if (!c.has(w, 'tokens', path) || !c.object(w.tokens, `${path}.tokens`)) return;
    for (const key of TOKEN_KEYS) if (c.has(w.tokens, key, `${path}.tokens`)) c.count(w.tokens[key], `${path}.tokens.${key}`);
  });
}

// A fixup made on the combined tree of every track comes from no card.
export const COMBINE_FIXUP = 'combine';

function validateFixups(fixups, c) {
  if (!c.object(fixups, '$.fixups')) return;
  for (const [list, other] of [['received', 'from'], ['caused', 'to']]) {
    if (!c.has(fixups, list, '$.fixups')) continue;
    c.items(fixups[list], `$.fixups.${list}`, (item, path) => {
      if (!c.object(item, path)) return;
      if (c.has(item, other, path) && !(other === 'from' && item.from === COMBINE_FIXUP)) c.card(item[other], `${path}.${other}`);
      if (c.has(item, 'patch', path)) c.check(typeof item.patch === 'string' && PATCH_PATH.test(item.patch), `${path}.patch`, 'expected <dir>/<file>.patch');
      if (c.has(item, 'note', path)) c.note(item.note, `${path}.note`);
    });
  }
}

function validateAuditMark(mark, card, path, c) {
  if (!c.object(mark, path)) return;
  if (c.has(mark, 'check', path)) c.oneOf(mark.check, AUDIT_CHECKS, `${path}.check`);
  if (c.has(mark, 'verdict', path)) c.oneOf(mark.verdict, mark.check === 'pr' ? PR_CHECK_VERDICTS : AUDIT_VERDICTS, `${path}.verdict`);
  if (mark.verdict === 'moved' && c.has(mark, 'card', path) && c.card(mark.card, `${path}.card`)) c.check(mark.card !== card, `${path}.card`, 'expected another card');
  if (mark.verdict !== 'moved' && 'card' in mark) c.fail(`${path}.card`, 'only a moved item names a card');
  if (c.has(mark, 'note', path)) c.text(mark.note, `${path}.note`);
  if (mark.check === 'fresh' && c.has(mark, 'runId', path)) c.check(isRunId(mark.runId), `${path}.runId`, 'expected a run id like 20261110T100000Z');
  if (mark.check === 'pr' && 'runId' in mark) c.fail(`${path}.runId`, 'a PR check runs before any run');
  if (c.has(mark, 'at', path)) c.datetime(mark.at, `${path}.at`);
}

// One entry per audit run: what the card was checked against and each item's verdict at that run, so the history stays.
function validateAudits(list, card, c) {
  c.items(list, '$.audits', (entry, path) => {
    if (!c.object(entry, path)) return;
    if (c.has(entry, 'check', path)) c.oneOf(entry.check, AUDIT_CHECKS, `${path}.check`);
    if (entry.check === 'fresh' && c.has(entry, 'runId', path)) c.check(isRunId(entry.runId), `${path}.runId`, 'expected a run id like 20261110T100000Z');
    if (entry.check === 'pr' && 'runId' in entry) c.fail(`${path}.runId`, 'a PR check runs before any run');
    if (c.has(entry, 'at', path)) c.datetime(entry.at, `${path}.at`);
    if (c.has(entry, 'kind', path)) c.oneOf(entry.kind, AUDIT_KINDS, `${path}.kind`);
    if (c.has(entry, 'against', path)) {
      c.items(entry.against, `${path}.against`, (a, at) => {
        if (!c.object(a, at)) return;
        for (const key of ['repoDir', 'kind']) if (c.has(a, key, at)) c.text(a[key], `${at}.${key}`);
        if (c.has(a, 'pr', at)) c.check(a.pr === null || isCount(a.pr), `${at}.pr`, 'expected a PR number or null');
        for (const key of ['branch', 'sha']) if (c.has(a, key, at)) c.check(a[key] === null || isNonEmpty(a[key]), `${at}.${key}`, 'expected string or null');
      });
    }
    if (c.has(entry, 'verdicts', path)) {
      c.items(entry.verdicts, `${path}.verdicts`, (v, at) => {
        if (!c.object(v, at)) return;
        if (c.has(v, 'id', at)) c.check(typeof v.id === 'string' && /^[cd]\d+$/.test(v.id), `${at}.id`, 'expected an item id like c1 or d1');
        if (c.has(v, 'verdict', at)) c.oneOf(v.verdict, entry.check === 'pr' ? PR_CHECK_VERDICTS : AUDIT_VERDICTS, `${at}.verdict`);
        if (v.verdict === 'moved' && c.has(v, 'card', at) && c.card(v.card, `${at}.card`)) c.check(v.card !== card, `${at}.card`, 'expected another card');
      });
    }
    if (entry.check === 'pr' && c.has(entry, 'missing', path)) c.items(entry.missing, `${path}.missing`, (m, at) => c.text(m, at));
    if (entry.check === 'fresh' && 'missing' in entry) c.fail(`${path}.missing`, 'missing scope belongs to the PR check');
    if (entry.check === 'pr' && 'description' in entry) c.fail(`${path}.description`, 'a description is proposed by the fresh check');
    if (entry.check === 'fresh' && c.has(entry, 'description', path) && entry.description !== null && c.object(entry.description, `${path}.description`)) {
      for (const key of ['text', 'why']) if (c.has(entry.description, key, `${path}.description`)) c.text(entry.description[key], `${path}.description.${key}`);
    }
  });
}

function validateCases(cases, c, card) {
  const seen = new Set();
  c.items(cases, '$.cases', (item, path) => {
    if (!c.object(item, path)) return;
    if (c.has(item, 'id', path) && c.check(typeof item.id === 'string' && CASE_ID.test(item.id), `${path}.id`, 'expected id like c1')) {
      c.check(!seen.has(item.id), `${path}.id`, `duplicate case id ${item.id}`);
      seen.add(item.id);
    }
    for (const key of ['given', 'when', 'then']) if (c.has(item, key, path)) c.text(item[key], `${path}.${key}`);
    const source = c.has(item, 'source', path) && c.oneOf(item.source, CASE_SOURCES, `${path}.source`);
    if (c.has(item, 'ref', path) && c.ref(item.ref, `${path}.ref`) && source) {
      c.check(item.ref.startsWith(`${item.source}:`), `${path}.ref`, `expected a ${item.source}: ref to match the source`);
    }
    if ('audit' in item) validateAuditMark(item.audit, card, `${path}.audit`, c);
  });
}

function validateNotes(list, name, c, card) {
  c.items(list, `$.${name}`, (item, path) => {
    if (!c.object(item, path)) return;
    if (name === 'findings' && c.has(item, 'kind', path)) c.oneOf(item.kind, FINDING_KINDS, `${path}.kind`);
    if (c.has(item, 'text', path)) c.text(item.text, `${path}.text`);
    if (c.has(item, 'ref', path)) c.ref(item.ref, `${path}.ref`);
    if (name === 'decisions' && 'audit' in item) validateAuditMark(item.audit, card, `${path}.audit`, c);
  });
}

function validateRiskAreas(areas, c) {
  const kinds = new Set();
  c.items(areas, '$.riskAreas', (area, path) => {
    if (!c.object(area, path)) return;
    if (c.has(area, 'kind', path) && c.text(area.kind, `${path}.kind`)) {
      c.check(!kinds.has(area.kind), `${path}.kind`, `duplicate risk kind ${area.kind}`);
      kinds.add(area.kind);
    }
    if (!c.has(area, 'paths', path) || !c.items(area.paths, `${path}.paths`, (p, at) => c.text(p, at))) return;
    if (c.check(area.paths.length > 0, `${path}.paths`, 'expected at least one path')) {
      c.check(area.paths.every((p, i) => i === 0 || compare(String(area.paths[i - 1]), String(p)) < 0), `${path}.paths`, 'expected sorted, distinct paths');
    }
  });
}

// On a respike each finding of the previous record gets an outcome instead of being rewritten.
function validatePriorFindings(list, c) {
  c.items(list, '$.priorFindings', (item, path) => {
    if (!c.object(item, path)) return;
    if (c.has(item, 'text', path)) c.text(item.text, `${path}.text`);
    if (c.has(item, 'outcome', path)) c.oneOf(item.outcome, PRIOR_FINDING_OUTCOMES, `${path}.outcome`);
    if (c.has(item, 'ref', path)) c.ref(item.ref, `${path}.ref`);
  });
}

function validateOpenDecisions(list, c) {
  c.items(list, '$.openDecisions', (item, path) => {
    if (!c.object(item, path)) return;
    if (c.has(item, 'text', path)) c.text(item.text, `${path}.text`);
    if ('impact' in item) c.oneOf(item.impact, OPEN_DECISION_IMPACTS, `${path}.impact`);
    if ('status' in item) c.oneOf(item.status, OPEN_DECISION_STATUSES, `${path}.status`);
    if ('owner' in item) c.oneOf(item.owner, OPEN_DECISION_OWNERS, `${path}.owner`);
    if ('eliminated' in item) {
      c.items(item.eliminated, `${path}.eliminated`, (e, at) => {
        if (!c.object(e, at)) return;
        for (const key of ['option', 'why']) if (c.has(e, key, at)) c.text(e[key], `${at}.${key}`);
      });
    }
    if ('ref' in item) c.ref(item.ref, `${path}.ref`);
  });
}

function validateNovelty(novelty, c) {
  if (!c.object(novelty, '$.novelty') || !c.has(novelty, 'newPaths', '$.novelty')) return;
  c.items(novelty.newPaths, '$.novelty.newPaths', (p, path) => c.text(p, path));
}

function validateTimeBox(box, c) {
  if (!c.object(box, '$.timeBox')) return;
  const budget = c.has(box, 'budget', '$.timeBox') && c.count(box.budget, '$.timeBox.budget');
  const spent = c.has(box, 'spent', '$.timeBox') && c.count(box.spent, '$.timeBox.spent');
  if (!c.has(box, 'over', '$.timeBox') || !c.check(typeof box.over === 'boolean', '$.timeBox.over', 'expected boolean')) return;
  if (budget && spent) c.check(box.over === box.spent > box.budget, '$.timeBox.over', 'expected spent > budget');
}

function validateLifecycle(r, c) {
  if (isSet(r.archived) && c.object(r.archived, '$.archived')) {
    if (c.has(r.archived, 'at', '$.archived')) c.check(isDate(r.archived.at) || isDatetime(r.archived.at), '$.archived.at', 'expected ISO 8601 date or datetime');
    if (c.has(r.archived, 'reason', '$.archived')) c.text(r.archived.reason, '$.archived.reason');
  }
  if (isSet(r.supersededBy) && c.object(r.supersededBy, '$.supersededBy')) {
    if (c.has(r.supersededBy, 'card', '$.supersededBy')) c.card(r.supersededBy.card, '$.supersededBy.card');
    if (c.has(r.supersededBy, 'spikedAt', '$.supersededBy')) c.datetime(r.supersededBy.spikedAt, '$.supersededBy.spikedAt');
  }
  if (isSet(r.alias) && c.object(r.alias, '$.alias')) {
    for (const key of ['splitFrom', 'mergedInto']) if (isSet(r.alias[key])) c.card(r.alias[key], `$.alias.${key}`);
  }
  if (isSet(r.archived) && isSet(r.supersededBy)) c.fail('$.supersededBy', 'a record cannot be both archived and superseded');
}

function validateReplayed(replayed, refs, c) {
  if (!c.object(replayed, '$.replayed')) return;
  if (c.has(replayed, 'at', '$.replayed')) c.datetime(replayed.at, '$.replayed.at');
  if (c.has(replayed, 'runId', '$.replayed') && c.check(isRunId(replayed.runId), '$.replayed.runId', 'expected a run id like 20261110T100000Z')) {
    c.check(isObject(refs) && replayed.runId === refs.runId, '$.replayed.runId', 'expected to equal $.refs.runId');
  }
  if (c.has(replayed, 'fromRunId', '$.replayed')) {
    c.check(replayed.fromRunId === null || isRunId(replayed.fromRunId), '$.replayed.fromRunId', 'expected a run id or null for the trial');
  }
  if (c.has(replayed, 'folded', '$.replayed')) {
    c.items(replayed.folded, '$.replayed.folded', (p, path) => c.check(typeof p === 'string' && PATCH_PATH.test(p), path, 'expected <dir>/<file>.patch'));
  }
}

const TRACK_ID = /^t\d+$/;

// A crossing is named by its index in the run's crossings.
function validateCrossingRefs(r, c) {
  if ('mergedFrom' in r && c.object(r.mergedFrom, '$.mergedFrom')) {
    if (c.has(r.mergedFrom, 'track', '$.mergedFrom')) c.check(typeof r.mergedFrom.track === 'string' && TRACK_ID.test(r.mergedFrom.track), '$.mergedFrom.track', 'expected a track id like t2');
    if (c.has(r.mergedFrom, 'crossing', '$.mergedFrom')) c.count(r.mergedFrom.crossing, '$.mergedFrom.crossing');
  }
  if ('respikedBy' in r && c.object(r.respikedBy, '$.respikedBy') && c.has(r.respikedBy, 'crossing', '$.respikedBy')) c.count(r.respikedBy.crossing, '$.respikedBy.crossing');
}

// A replayed record keeps the effort of the run that spiked it while its refs move to the run that replayed it.
function validateRefs(refs, effort, replayed, c) {
  if (!c.object(refs, '$.refs')) return;
  const moved = isObject(replayed);
  if ('runId' in refs && c.check(isRunId(refs.runId), '$.refs.runId', 'expected a run id like 20261110T100000Z') && !moved && isObject(effort) && 'runId' in effort) {
    c.check(refs.runId === effort.runId, '$.refs.runId', 'expected to equal $.effort.runId');
  }
  if (c.has(refs, 'engram', '$.refs')) {
    c.items(refs.engram, '$.refs.engram', (id, path) => c.check(typeof id === 'string' && ENGRAM_ID.test(id), path, 'expected <project>#<id>'));
  }
  if (c.has(refs, 'patches', '$.refs')) {
    c.items(refs.patches, '$.refs.patches', (p, path) => c.check(typeof p === 'string' && PATCH_PATH.test(p), path, 'expected <dir>/<file>.patch'));
  }
  if (c.has(refs, 'linear', '$.refs')) c.check(refs.linear === null || isNonEmpty(refs.linear), '$.refs.linear', 'expected string or null');
}

export function validateRecord(value) {
  if (!isObject(value)) return ['$: expected object'];
  const c = checker();
  const r = value;
  if (c.has(r, 'schemaVersion', '$')) c.check(r.schemaVersion === SCHEMA_VERSION, '$.schemaVersion', `expected ${SCHEMA_VERSION}`);
  if (c.has(r, 'card', '$')) c.card(r.card, '$.card');
  if (c.has(r, 'title', '$')) c.text(r.title, '$.title');
  if (c.has(r, 'project', '$') && c.object(r.project, '$.project')) {
    for (const key of ['slug', 'name']) if (c.has(r.project, key, '$.project')) c.text(r.project[key], `$.project.${key}`);
  }
  if (c.has(r, 'origin', '$')) c.oneOf(r.origin, ORIGINS, '$.origin');
  if (c.has(r, 'spikedAt', '$')) c.datetime(r.spikedAt, '$.spikedAt');
  validateLifecycle(r, c);
  if (c.has(r, 'scope', '$') && c.object(r.scope, '$.scope')) {
    if (c.has(r.scope, 'complete', '$.scope')) c.check(typeof r.scope.complete === 'boolean', '$.scope.complete', 'expected boolean');
    if (r.scope.complete === false) c.check(isNonEmpty(r.scope.note), '$.scope.note', 'required when the scope is incomplete');
    else if ('note' in r.scope) c.note(r.scope.note, '$.scope.note');
  }
  if (c.has(r, 'size', '$')) validateSize(r.size, c);
  if (c.has(r, 'effort', '$')) validateEffort(r.effort, r.card, c);
  if (c.has(r, 'fixups', '$')) validateFixups(r.fixups, c);
  if (c.has(r, 'cases', '$')) {
    validateCases(r.cases, c, r.card);
    if (Array.isArray(r.cases) && !isSet(r.archived)) c.check(r.cases.length > 0, '$.cases', 'expected at least one case for a card that is not archived');
  }
  for (const name of ['decisions', 'findings']) if (c.has(r, name, '$')) validateNotes(r[name], name, c, r.card);
  if ('priorFindings' in r) validatePriorFindings(r.priorFindings, c);
  if ('openDecisions' in r) validateOpenDecisions(r.openDecisions, c);
  if ('audits' in r) validateAudits(r.audits, r.card, c);
  if ('riskAreas' in r) validateRiskAreas(r.riskAreas, c);
  if ('novelty' in r) validateNovelty(r.novelty, c);
  if ('timeBox' in r) validateTimeBox(r.timeBox, c);
  if ('replayed' in r) validateReplayed(r.replayed, r.refs, c);
  validateCrossingRefs(r, c);
  if (c.has(r, 'refs', '$')) validateRefs(r.refs, r.effort, r.replayed, c);
  if (r.origin === 'existing-pr' && isSet(r.effort)) c.fail('$.effort', 'expected null for an existing-pr record');
  if (r.origin === 'existing-pr' && 'timeBox' in r) c.fail('$.timeBox', 'an existing-pr record never carries a timeBox');
  if ('tier' in r) c.fail('$.tier', STORED_TIER);
  if ('verdict' in r) c.fail('$.verdict', STORED_VERDICT);
  if (isObject(r.size) && ['S', 'M', 'L', 'XL'].includes(r.size.tier)) c.fail('$.size.tier', STORED_TIER);
  return c.errors;
}

// The fields a spike's notes carry into its record, checked before the record is built: paths read notes.*, case ids are
// assigned at build time, and whether there is at least one case is the record's check.
export function validateNoteFields(notes) {
  if (!isObject(notes)) return ['notes: expected object'];
  const c = checker();
  const n = notes;
  if (c.has(n, 'scope', '$') && c.object(n.scope, '$.scope')) {
    if (c.has(n.scope, 'complete', '$.scope')) c.check(typeof n.scope.complete === 'boolean', '$.scope.complete', 'expected boolean');
    if (n.scope.complete === false) c.check(isNonEmpty(n.scope.note), '$.scope.note', 'required when the scope is incomplete');
    else if ('note' in n.scope) c.note(n.scope.note, '$.scope.note');
  }
  if (c.has(n, 'cases', '$')) validateCases(Array.isArray(n.cases) ? n.cases.map((x, i) => (isObject(x) ? { id: `c${i + 1}`, ...x } : x)) : n.cases, c);
  for (const name of ['decisions', 'findings']) if (c.has(n, name, '$')) validateNotes(n[name], name, c);
  if ('priorFindings' in n) validatePriorFindings(n.priorFindings, c);
  if (Array.isArray(n.openDecisions)) validateOpenDecisions(n.openDecisions, c);
  if ('engram' in n) c.items(n.engram, '$.engram', (id, path) => c.check(typeof id === 'string' && ENGRAM_ID.test(id), path, 'expected <project>#<id>'));
  return c.errors.map(e => `notes${e.slice(1)}`);
}

const ORDER = {
  record: ['schemaVersion', 'card', 'title', 'project', 'origin', 'spikedAt', 'archived', 'supersededBy', 'alias', 'scope',
    'size', 'effort', 'fixups', 'cases', 'decisions', 'findings', 'priorFindings', 'openDecisions', 'audits', 'riskAreas', 'novelty', 'timeBox', 'replayed', 'mergedFrom', 'respikedBy', 'refs'],
  project: ['slug', 'name'],
  archived: ['at', 'reason'],
  supersededBy: ['card', 'spikedAt'],
  alias: ['splitFrom', 'mergedInto'],
  scope: ['complete', 'note'],
  size: ['prodLines', 'testLines', 'files', 'repos', 'sharedWith', 'deletionWeight'],
  effort: ['basis', 'runId', 'windows'],
  window: ['start', 'end', 'cards', 'messages', 'tokens'],
  tokens: TOKEN_KEYS,
  fixups: ['received', 'caused'],
  received: ['from', 'patch', 'note'],
  caused: ['to', 'patch', 'note'],
  case: ['id', 'given', 'when', 'then', 'source', 'ref', 'audit'],
  decision: ['text', 'ref', 'audit'],
  audit: ['check', 'verdict', 'card', 'note', 'runId', 'at'],
  auditRun: ['check', 'runId', 'at', 'kind', 'against', 'verdicts', 'missing', 'description'],
  against: ['repoDir', 'kind', 'pr', 'branch', 'sha'],
  verdict: ['id', 'verdict', 'card'],
  proposal: ['text', 'why'],
  openDecision: ['text', 'impact', 'status', 'owner', 'eliminated', 'ref'],
  eliminated: ['option', 'why'],
  finding: ['kind', 'text', 'ref'],
  priorFinding: ['text', 'outcome', 'ref'],
  riskArea: ['kind', 'paths'],
  novelty: ['newPaths'],
  timeBox: ['budget', 'spent', 'over'],
  replayed: ['at', 'runId', 'fromRunId', 'folded'],
  mergedFrom: ['track', 'crossing'],
  refs: ['engram', 'patches', 'linear', 'runId'],
};

const byKeys = (...keys) => (a, b) => keys.reduce((d, k) => d || compare(String(a?.[k]), String(b?.[k])), 0);
const engramId = ref => Number(String(ref).split('#').pop());

function ordered(value, keys, fields = {}) {
  if (!isObject(value)) return value;
  const known = keys.filter(k => k in value);
  const rest = Object.keys(value).filter(k => !keys.includes(k)).sort(compare);
  return Object.fromEntries([...known, ...rest].map(k => [k, k in fields ? fields[k](value[k]) : value[k]]));
}

const list = (value, each = v => v, sort) => {
  if (!Array.isArray(value)) return value;
  const out = value.map(each);
  return sort ? out.sort(sort) : out;
};

export function canonicalRecord(record) {
  return ordered(record, ORDER.record, {
    project: v => ordered(v, ORDER.project),
    archived: v => ordered(v, ORDER.archived),
    supersededBy: v => ordered(v, ORDER.supersededBy),
    alias: v => ordered(v, ORDER.alias),
    scope: v => ordered(v, ORDER.scope),
    size: v => ordered(v, ORDER.size, {
      repos: x => list(x, undefined, compare),
      sharedWith: x => list(x, undefined, compare),
    }),
    effort: v => ordered(v, ORDER.effort, {
      windows: x => list(x, w => ordered(w, ORDER.window, {
        cards: y => list(y, undefined, compare),
        tokens: y => ordered(y, ORDER.tokens),
      }), byKeys('end', 'start')),
    }),
    fixups: v => ordered(v, ORDER.fixups, {
      received: x => list(x, f => ordered(f, ORDER.received), byKeys('patch', 'from')),
      caused: x => list(x, f => ordered(f, ORDER.caused), byKeys('patch', 'to')),
    }),
    cases: v => list(v, x => ordered(x, ORDER.case, { audit: y => ordered(y, ORDER.audit) })),
    decisions: v => list(v, x => ordered(x, ORDER.decision, { audit: y => ordered(y, ORDER.audit) })),
    audits: v => list(v, x => ordered(x, ORDER.auditRun, {
      against: y => list(y, a => ordered(a, ORDER.against)),
      verdicts: y => list(y, a => ordered(a, ORDER.verdict)),
      description: y => ordered(y, ORDER.proposal),
    })),
    findings: v => list(v, x => ordered(x, ORDER.finding)),
    priorFindings: v => list(v, x => ordered(x, ORDER.priorFinding)),
    openDecisions: v => list(v, x => ordered(x, ORDER.openDecision, { eliminated: y => list(y, e => ordered(e, ORDER.eliminated)) })),
    riskAreas: v => list(v, x => ordered(x, ORDER.riskArea), byKeys('kind')),
    novelty: v => ordered(v, ORDER.novelty),
    timeBox: v => ordered(v, ORDER.timeBox),
    replayed: v => ordered(v, ORDER.replayed, { folded: x => list(x, undefined, compare) }),
    mergedFrom: v => ordered(v, ORDER.mergedFrom),
    refs: v => ordered(v, ORDER.refs, {
      engram: x => list(x, undefined, (a, b) => engramId(a) - engramId(b) || compare(a, b)),
      patches: x => list(x, undefined, compare),
    }),
  });
}

export const serializeRecord = record => `${JSON.stringify(canonicalRecord(record), null, 2)}\n`;
