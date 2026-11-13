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

function drift(plan, { raw, context }) {
  const out = [];
  if (context?.next?.id !== plan.nextCycle.id) out.push(`the team's next cycle is no longer cycle ${plan.nextCycle.number}`);
  const byKey = new Map((raw?.issues ?? []).map(i => [i.identifier, i]));
  for (const op of plan.ops) {
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
export async function applyCyclePlan(plan, { apiKey, fetchImpl, now, appendLog, sleep = realSleep, live }) {
  if (typeof plan?.hash !== 'string' || planHash(plan) !== plan.hash) {
    return { code: 5, results: [], messages: ['the plan file does not match its hash: it was edited after planning; run plan again'] };
  }
  const drifted = drift(plan, live);
  if (drifted.length) return { code: 6, results: [], messages: ['Linear changed since the plan; nothing was written. Run plan again.', ...drifted] };

  const byKey = new Map(live.raw.issues.map(i => [i.identifier, i]));
  const ctx = { apiKey, fetchImpl };
  const results = [];
  const log = (op, status) => {
    results.push({ card: op.card, status });
    appendLog({ at: now().toISOString(), plan: plan.hash, card: op.card, status, set: op.set });
  };
  for (const op of plan.ops) {
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
