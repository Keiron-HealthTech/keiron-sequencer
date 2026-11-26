// The people answered some of a card's open decisions in its decision pack. A spike takes each answer as settled: it
// records the answer as a decision whose ref names the pack question, and says so in notes.packAnswers. Only the user
// reopens one, on evidence; a finding that contradicts an answer blocks end until the user keeps or reopens it.

export const packRef = (card, id) => `pack:${card}#${id}`;

const isText = v => typeof v === 'string' && v.trim() !== '';
const index = (id, prefix) => (typeof id === 'string' && new RegExp(`^${prefix}\\d+$`).test(id) ? Number(id.slice(1)) - 1 : -1);

// The answered questions of a pack, as the brief hands them to the spike.
export function answeredOf(pack) {
  return (pack?.questions ?? []).filter(q => q.answer).map(q => ({ id: q.id, question: q.text, outcome: q.answer.outcome, answeredAt: q.answer.answeredAt }));
}

// answers: the answered questions the brief handed the card. Every one needs one entry in notes.packAnswers: now names the
// decision that records it (with its pack ref), or the open decision it went back to, with the user's call in reopened.
export function checkPackAnswers(notes, { card, answers }) {
  const errors = [];
  const ids = new Set(answers.map(a => a.id));
  const entries = Array.isArray(notes?.packAnswers) ? notes.packAnswers : [];
  const decisions = Array.isArray(notes?.decisions) ? notes.decisions : [];
  const open = Array.isArray(notes?.openDecisions) ? notes.openDecisions : [];
  const seen = new Map();
  entries.forEach((e, i) => {
    const at = `notes.packAnswers[${i}]`;
    if (!ids.has(e?.id)) { errors.push(`${at}.id: ${e?.id} is not an answered question of ${card}'s pack`); return; }
    if (seen.has(e.id)) { errors.push(`${at}.id: ${e.id} is listed twice`); return; }
    seen.set(e.id, e);
    const ref = packRef(card, e.id);
    const d = index(e.now, 'd');
    const o = index(e.now, 'o');
    if (d >= 0) {
      if (decisions[d]?.ref !== ref) errors.push(`${at}: ${e.now} is not a decision with ref ${ref}`);
    } else if (o >= 0) {
      if (!open[o]) errors.push(`${at}: ${e.now} is not an open decision of the notes`);
      else if (!isText(e.reopened)) errors.push(`${at}: reopening ${e.id} needs the user's OK in reopened`);
    } else {
      errors.push(`${at}.now: expected d<n> (the decision that records the answer) or o<n> (reopened with the user's OK)`);
    }
  });
  for (const a of answers) {
    if (!seen.has(a.id)) {
      errors.push(`notes.packAnswers: ${a.id} has no entry: record its answer as a decision with ref ${packRef(card, a.id)}, or reopen it with the user's OK`);
    }
  }
  const findings = Array.isArray(notes?.findings) ? notes.findings : [];
  findings.forEach((f, i) => {
    if (f?.contradicts === undefined) return;
    const id = String(f.contradicts).startsWith(`pack:${card}#`) ? String(f.contradicts).split('#')[1] : null;
    if (!ids.has(id)) { errors.push(`notes.findings[${i}].contradicts: ${f.contradicts} is not an answered question of ${card}'s pack`); return; }
    const entry = seen.get(id);
    if (entry && index(entry.now, 'd') >= 0 && !isText(entry.kept)) {
      errors.push(`${f.contradicts} is contradicted by a finding: ask the user, then keep the answer (kept: <the user's call>) or reopen it (now: o<n>, reopened: <the user's call>)`);
    }
  });
  return errors;
}
