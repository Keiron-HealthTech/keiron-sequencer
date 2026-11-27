import { readBack } from '../harvest-apply.mjs';
import { planHash } from '../harvest.mjs';
import { fetchIssueCycle } from '../linear-fetch.mjs';
import { updateIssueCycle } from '../linear-write.mjs';

const FIELDS = ['cycleId', 'assigneeId'];
const realSleep = ms => new Promise(r => setTimeout(r, ms));
const fromLinear = e => /^Linear\b/.test(e.message);
const target = op => ({ ...op.before, ...op.set });
const current = i => ({ cycleId: i.cycle?.id ?? null, assigneeId: i.assignee?.id ?? null });
const reached = (now, op) => Object.keys(op.set).every(f => now[f] === op.set[f]);

function drift(plan, ops, { raw, context }) {
  const out = [];
  if (context?.next?.id !== plan.nextCycle.id) out.push(`the team's next cycle is no longer cycle ${plan.nextCycle.number}`);
  const byKey = new Map((raw?.issues ?? []).map(i => [i.identifier, i]));
  for (const op of ops) {
    const i = byKey.get(op.card);
    if (!i || i.archivedAt) { out.push(`${op.card} is gone or archived`); continue; }
    if (['completed', 'canceled'].includes(i.state?.type)) { out.push(`${op.card} is ${i.state.type} now`); continue; }
    const now = current(i);
    const goal = target(op);
    for (const f of FIELDS) if (now[f] !== op.before[f] && now[f] !== goal[f]) out.push(`${op.card}: ${f} changed since the plan`);
  }
  return out;
}

// Every op is checked against a fresh read before the first write; each write is read back, and an op already in its target
// state is skipped, so running the same apply again continues where a failed run stopped.
// withStretch adds the plan's stretch cards; drop leaves cards out. Both are the user's choice at apply time, among the
// options the review offers.
export function chosenOps(plan, { withStretch = false, drop = [] } = {}) {
  if (withStretch && !Array.isArray(plan.stretchOps)) return { error: 'this plan has no stretch changes: run plan again' };
  const all = [...plan.ops, ...(withStretch ? plan.stretchOps : [])].sort((a, b) => (a.card < b.card ? -1 : a.card > b.card ? 1 : 0));
  const unknown = drop.filter(k => !all.some(o => o.card === k));
  if (unknown.length) return { error: `--drop ${unknown.join(', ')}: not among the changes this apply makes${withStretch ? '' : ' (stretch cards need --with-stretch)'}` };
  return { ops: all.filter(o => !drop.includes(o.card)) };
}

export async function applyCyclePlan(plan, { apiKey, fetchImpl, now, appendLog, sleep = realSleep, live, withStretch = false, drop = [] }) {
  if (typeof plan?.hash !== 'string' || planHash(plan) !== plan.hash) {
    return { code: 5, results: [], messages: ['the plan file does not match its hash: it was edited after planning; run plan again'] };
  }
  const chosen = chosenOps(plan, { withStretch, drop });
  if (chosen.error) return { code: 5, results: [], messages: [chosen.error] };
  const drifted = drift(plan, chosen.ops, live);
  if (drifted.length) return { code: 6, results: [], messages: ['Linear changed since the plan; nothing was written. Run plan again.', ...drifted] };

  const byKey = new Map(live.raw.issues.map(i => [i.identifier, i]));
  const ctx = { apiKey, fetchImpl };
  const results = [];
  const log = (op, status) => {
    results.push({ card: op.card, status });
    appendLog({ at: now().toISOString(), plan: plan.hash, card: op.card, status, set: op.set });
  };
  for (const op of chosen.ops) {
    if (reached(current(byKey.get(op.card)), op)) { log(op, 'skipped'); continue; }
    try {
      await updateIssueCycle(op.issueId, op.set, ctx);
      const after = await readBack(() => fetchIssueCycle(op.issueId, apiKey, { fetchImpl }), s => s && reached(s, op), sleep);
      if (!after || !reached(after, op)) {
        results.push({ card: op.card, status: 'failed' });
        return { code: 1, results, messages: [`${op.card}: the change did not show up when read back; run apply again`] };
      }
    } catch (e) {
      if (!fromLinear(e)) throw e;
      results.push({ card: op.card, status: 'failed' });
      return { code: 1, results, messages: [`${op.card}: ${e.message}; run apply again to continue`] };
    }
    log(op, 'applied');
  }
  return { code: 0, results, messages: [] };
}
