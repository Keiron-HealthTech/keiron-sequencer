import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { carryAnswers, draftPack } from '../scripts/lib/packs.mjs';
import { validateRecord } from '../scripts/lib/record.mjs';
import { checkPackAnswers, packRef } from '../scripts/lib/spike/pack-answers.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import { call, notes, PROJECT_URL, playCard, SLUG, spikeFixture } from './helpers/spike-fixture.mjs';

guardNetwork();

// The shape of a card whose people-owned question was answered in its pack, then reworded by a re-spike that never read the
// pack, so the redraft lost the answer (made-up keys and text). Now the answer reaches the spike as a binding decision.
const CARD = 'CRM-1';
const ANSWERS = [
  { id: 'q1', question: 'Should hidden files list their type and date?', outcome: 'Hidden files show their type and date, never their name.', answeredAt: '2026-11-12T10:00:00.000Z' },
  { id: 'q3', question: 'Who may export the list?', outcome: 'Only owners export the list.', answeredAt: '2026-11-12T10:05:00.000Z' },
];
const decided = (id, text) => ({ text, ref: packRef(CARD, id) });

const good = {
  ...notes,
  decisions: [{ text: 'Read the list through the existing module.', ref: 'linear:CRM-1' }, decided('q1', ANSWERS[0].outcome), decided('q3', ANSWERS[1].outcome)],
  packAnswers: [{ id: 'q1', now: 'd2' }, { id: 'q3', now: 'd3' }],
};

const check = n => checkPackAnswers(n, { card: CARD, answers: ANSWERS });

test('each answered pack question is recorded as a decision with its pack ref, and then nothing is refused', () => {
  assert.equal(packRef(CARD, 'q1'), 'pack:CRM-1#q1');
  assert.deepEqual(check(good), []);
});

test('an answered question left without a label, or labelled with a decision that is not its own, is refused', () => {
  assert.deepEqual(check({ ...good, packAnswers: [{ id: 'q1', now: 'd2' }] }), [
    'notes.packAnswers: q3 has no entry: record its answer as a decision with ref pack:CRM-1#q3, or reopen it with the user\'s OK',
  ]);
  assert.deepEqual(check({ ...good, packAnswers: undefined }), [
    'notes.packAnswers: q1 has no entry: record its answer as a decision with ref pack:CRM-1#q1, or reopen it with the user\'s OK',
    'notes.packAnswers: q3 has no entry: record its answer as a decision with ref pack:CRM-1#q3, or reopen it with the user\'s OK',
  ]);
  assert.deepEqual(check({ ...good, packAnswers: [{ id: 'q1', now: 'd1' }, { id: 'q3', now: 'd3' }] }), [
    'notes.packAnswers[0]: d1 is not a decision with ref pack:CRM-1#q1',
  ]);
  assert.deepEqual(check({ ...good, packAnswers: [...good.packAnswers, { id: 'q2', now: 'd1' }] }), [
    'notes.packAnswers[2].id: q2 is not an answered question of CRM-1\'s pack',
  ]);
});

test('a reopened answer names the open decision it became and the user\'s call', () => {
  const open = { text: 'Who may export the list, now that admins need it?', impact: 'design', status: 'open', owner: 'people' };
  const reopened = { ...good, decisions: good.decisions.slice(0, 2), openDecisions: [open], packAnswers: [{ id: 'q1', now: 'd2' }, { id: 'q3', now: 'o1', reopened: 'The admin export needs it; the user reopened it on 11-26.' }] };
  assert.deepEqual(check(reopened), []);
  const noCall = { ...reopened, packAnswers: [reopened.packAnswers[0], { id: 'q3', now: 'o1' }] };
  assert.deepEqual(check(noCall), ['notes.packAnswers[1]: reopening q3 needs the user\'s OK in reopened']);
  const noOpen = { ...reopened, openDecisions: [] };
  assert.deepEqual(check(noOpen), ['notes.packAnswers[1]: o1 is not an open decision of the notes']);
});

test('a finding that contradicts an answer blocks end until the user keeps the answer or reopens it', () => {
  const contradicted = { ...good, findings: [{ kind: 'risk', text: 'The export job reads the file name the answer hides.', ref: 'linear:CRM-1', contradicts: packRef(CARD, 'q1') }] };
  assert.deepEqual(check(contradicted), [
    'pack:CRM-1#q1 is contradicted by a finding: ask the user, then keep the answer (kept: <the user\'s call>) or reopen it (now: o<n>, reopened: <the user\'s call>)',
  ]);
  const kept = { ...contradicted, packAnswers: [{ id: 'q1', now: 'd2', kept: 'The user keeps it: the export job will drop the name.' }, good.packAnswers[1]] };
  assert.deepEqual(check(kept), []);
  const unknown = { ...good, findings: [{ ...contradicted.findings[0], contradicts: packRef(CARD, 'q2') }] };
  assert.deepEqual(check(unknown), ['notes.findings[0].contradicts: pack:CRM-1#q2 is not an answered question of CRM-1\'s pack']);
});

test('with no answered question, nothing is asked of the notes', () => {
  assert.deepEqual(checkPackAnswers(notes, { card: CARD, answers: [] }), []);
});

const baseRecord = over => ({
  schemaVersion: 1, card: CARD, title: 'Card', project: { slug: SLUG, name: 'P' }, origin: 'thin-spike', spikedAt: '2026-11-20T10:00:00.000Z',
  scope: { complete: true, note: null }, size: { prodLines: 3, testLines: 1, files: 1, repos: ['backend-repo'], sharedWith: [], deletionWeight: 0.25 },
  effort: null, fixups: { received: [], caused: [] }, cases: notes.cases.map((c, i) => ({ id: `c${i + 1}`, ...c })), decisions: [], findings: [],
  openDecisions: [], riskAreas: [], novelty: { newPaths: [] }, refs: { engram: [], patches: [], linear: null }, ...over,
});

test('a record carries pack refs, the labels and a contradicting finding; a record without them is valid as before', () => {
  const r = baseRecord({
    decisions: good.decisions, packAnswers: good.packAnswers,
    findings: [{ kind: 'risk', text: 'x', ref: 'linear:CRM-1', contradicts: packRef(CARD, 'q1') }],
  });
  assert.deepEqual(validateRecord(r), []);
  assert.deepEqual(validateRecord(baseRecord()), []);
  assert.deepEqual(validateRecord(baseRecord({ packAnswers: [{ id: 'x1', now: 'd1' }] })), ['$.packAnswers[0].id: expected a question id like q1']);
});

test('a redraft keeps an answer for the same words, never for a question the spike reopened, and asks nothing about an answer that became a decision', () => {
  const question = text => ({ text, impact: 'design', status: 'open', owner: 'people' });
  const oldPack = { questions: [
    { id: 'q1', text: 'Same words?', evidence: [], options: [], owner: 'people', answer: { outcome: 'Kept.', answeredAt: '2026-11-12T10:00:00.000Z' } },
    { id: 'q2', text: 'Reopened?', evidence: [], options: [], owner: 'people', answer: { outcome: 'Old answer.', answeredAt: '2026-11-12T10:00:00.000Z' } },
    { id: 'q3', text: 'Became a decision?', evidence: [], options: [], owner: 'people', answer: { outcome: 'Decided.', answeredAt: '2026-11-12T10:00:00.000Z' } },
  ] };
  const record = baseRecord({
    decisions: [decided('q3', 'Decided.')],
    openDecisions: [question('Same words?'), question('Reopened?')],
    packAnswers: [{ id: 'q2', now: 'o2', reopened: 'The user reopened it.' }, { id: 'q3', now: 'd1' }],
  });
  const pack = draftPack(record, { description: 'x' });
  carryAnswers(oldPack, pack, record);
  assert.deepEqual(pack.questions.map(q => [q.text, q.answer?.outcome ?? null]), [['Same words?', 'Kept.'], ['Reopened?', null]]);
  const before = draftPack(baseRecord({ openDecisions: [question('Same words?')] }), { description: 'x' });
  carryAnswers(oldPack, before, baseRecord({ openDecisions: [question('Same words?')] }));
  assert.deepEqual(before.questions.map(q => q.answer?.outcome), ['Kept.'], 'a record from before labels keeps the same-words rule');
});

// ---------- the spike's brief and end ----------

function writePack(fixture, answers) {
  const dir = join(fixture.dataDir, SLUG, 'packs');
  mkdirSync(dir, { recursive: true });
  const questions = [
    ...answers.map(a => ({ id: a.id, text: a.question, evidence: [], options: [], owner: 'people', answer: { outcome: a.outcome, answeredAt: a.answeredAt } })),
    { id: 'q2', text: 'Not answered yet?', evidence: [], options: [], owner: 'people', answer: null },
  ];
  writeFileSync(join(dir, `${CARD}.json`), JSON.stringify({ schemaVersion: 1, card: CARD, stamp: { descriptionHash: 'h', recordSpikedAt: 'x', runId: null, bases: {} }, questions }));
}

test('next hands the spike the answered pack questions, and notes-template asks where each went', async () => {
  const fixture = spikeFixture();
  writePack(fixture, ANSWERS);
  assert.equal((await call(fixture, ['begin', PROJECT_URL, '--session-file', fixture.sessionFile])).code, 0);
  const brief = JSON.parse((await call(fixture, ['next'])).stdout);
  assert.deepEqual(brief.packAnswers, ANSWERS);
  const template = JSON.parse((await call(fixture, ['notes-template', CARD])).stdout);
  assert.deepEqual(template.notes.packAnswers.map(p => p.id), ['q1', 'q3']);
});

test('end refuses notes that leave an answered question unlabelled, and records the labels when they are there', async () => {
  const fixture = spikeFixture();
  writePack(fixture, ANSWERS);
  assert.equal((await call(fixture, ['begin', PROJECT_URL, '--session-file', fixture.sessionFile])).code, 0);
  const refused = await playCard(fixture, CARD, { start: '2026-11-10T10:01:00.000Z', end: '2026-11-10T10:05:00.000Z', session: fixture.sessionFile });
  assert.equal(refused.ended.code, 1);
  assert.match(refused.ended.stderr, /notes\.packAnswers: q1 has no entry/);
  writeFileSync(join(refused.dir, 'notes', `${CARD}.json`), JSON.stringify(good));
  fixture.at('2026-11-10T10:06:00.000Z');
  const ended = await call(fixture, ['end', CARD], { session: fixture.sessionFile });
  assert.equal(ended.code, 0, ended.stderr);
  const record = JSON.parse(readFileSync(join(fixture.dataDir, SLUG, `${CARD}.json`), 'utf8'));
  assert.deepEqual(record.packAnswers, good.packAnswers);
  assert.deepEqual(record.decisions.map(d => d.ref), ['linear:CRM-1', 'pack:CRM-1#q1', 'pack:CRM-1#q3']);
});

test('a card with no pack, or a pack with nothing answered, ends as today', async () => {
  const fixture = spikeFixture();
  writePack(fixture, []);
  assert.equal((await call(fixture, ['begin', PROJECT_URL, '--session-file', fixture.sessionFile])).code, 0);
  const played = await playCard(fixture, CARD, { start: '2026-11-10T10:01:00.000Z', end: '2026-11-10T10:05:00.000Z', session: fixture.sessionFile });
  assert.equal('packAnswers' in played.out, false);
  assert.equal(played.ended.code, 0, played.ended.stderr);
});
