import { liveIndex, markerOf, observe, planHash } from './harvest.mjs';
import { fetchDescriptions, fetchIssueState, fetchProjectMap, redact } from './linear-fetch.mjs';
import { createBlocks, createIssue, deleteRelation, updateDescription } from './linear-write.mjs';

// IssueState holds only one card's outgoing relations and no byKey, so reverse-direction and
// archived-endpoint drift are caught by the full re-fetch before the first write, not here.
export function stateIndex(state) {
  const blocks = new Map();
  for (const b of state?.blocks ?? []) {
    const key = `${state.identifier}>${b.to}`;
    blocks.set(key, [...(blocks.get(key) ?? []), b.id].sort());
  }
  return { blocks, descriptions: new Map(state ? [[state.identifier, state]] : []) };
}

// Errors from the Linear transport start with "Linear"; anything else is a keiron-sequencer bug and is rethrown.
const fromLinear = e => /^Linear\b/.test(e.message);

const refuse = message => ({ code: 5, results: [], messages: [message] });

// Linear answers an unknown identifier with an "Entity not found" error, not a null issue.
export async function issueOrNull(id, key, fetchImpl) {
  try {
    return await fetchIssueState(id, key, { fetchImpl });
  } catch (e) {
    if (/^Linear: Entity not found\b/i.test(e.message)) return null;
    throw e;
  }
}

async function readLive(projectId, apiKey, fetchImpl) {
  const raw = await fetchProjectMap(projectId, apiKey, { fetchImpl });
  const descriptions = raw.project.id === projectId ? await fetchDescriptions(projectId, apiKey, { fetchImpl }) : new Map();
  return { raw, descriptions, index: liveIndex(raw, descriptions) };
}

function offProjectDrift(op, outside) {
  if (!op.offProject) return null;
  const card = outside.get(op.offProject);
  if (!card) return `${op.offProject} was not found in Linear`;
  return card.archivedAt ? `${op.offProject} is archived` : null;
}

// Linear can answer a read made right after a write with the state from before it. A read-back that does not show the
// change yet is read again after each delay; only one still wrong after the last is a real mismatch.
export const READ_BACK_DELAYS_MS = [500, 1500];
const realSleep = ms => new Promise(r => setTimeout(r, ms));

export async function readBack(read, shows, sleep) {
  let state = await read();
  for (const ms of READ_BACK_DELAYS_MS) {
    if (shows(state)) return state;
    await sleep(ms);
    state = await read();
  }
  return state;
}

export async function applyPlan(plan, { apiKey, fetchImpl, now, appendLog, sleep = realSleep }) {
  if (typeof plan?.hash !== 'string' || planHash(plan) !== plan.hash) {
    return refuse('the plan file does not match its hash: it was edited after planning; run plan again');
  }
  const ctx = { apiKey, fetchImpl };
  const run = `${plan.hash.slice(0, 12)}@${now().toISOString()}`;
  const { raw, descriptions, index } = await readLive(plan.project.id, apiKey, fetchImpl);
  if (raw.project.id !== plan.project.id) {
    return refuse(`the plan is for project ${plan.project.name} (${plan.project.slug}), but Linear returned ${raw.project.name} (${raw.project.slug})`);
  }
  const outside = new Map();
  for (const key of new Set(plan.ops.map(op => op.offProject).filter(Boolean))) {
    outside.set(key, await fetchIssueState(key, apiKey, { fetchImpl }));
  }
  const drifted = plan.ops
    .map(op => ({ op, reason: observe(op, index).drift ?? offProjectDrift(op, outside) }))
    .filter(({ reason }) => reason);
  if (drifted.length) {
    return {
      code: 6,
      results: drifted.map(({ op, reason }) => ({ op: op.id, result: 'drift', reason })),
      messages: [...drifted.map(({ op, reason }) => `drift: ${op.id}: ${reason}`), 'nothing was written; run plan again'],
    };
  }

  const ids = new Map([...descriptions].map(([identifier, d]) => [identifier, d.id]));
  for (const i of raw.issues) ids.set(i.identifier, i.id);
  for (const [key, card] of outside) ids.set(key, card.id);
  const resolved = new Map([...index.markers].map(([key, identifier]) => [`new:${key}`, identifier]));
  const card = ref => (ref.startsWith('new:') ? resolved.get(ref) : ref);
  const issueState = id => fetchIssueState(id, apiKey, { fetchImpl });

  const steps = {
    'card.create': async op => {
      const scan = liveIndex({ issues: [] }, await fetchDescriptions(plan.project.id, apiKey, { fetchImpl }));
      const seen = observe(op, scan, resolved);
      if (seen === 'applied') {
        const identifier = resolved.get(`new:${op.key}`) ?? scan.markers.get(op.key);
        resolved.set(`new:${op.key}`, identifier);
        ids.set(identifier, scan.descriptions.get(identifier)?.id ?? ids.get(identifier));
      }
      const known = () => ({ key: op.key, issueId: ids.get(resolved.get(`new:${op.key}`)), identifier: resolved.get(`new:${op.key}`) });
      if (seen !== 'pending') return { seen, extra: known };
      const created = await createIssue(op.after, ctx);
      ids.set(created.identifier, created.id);
      const marked = state => Boolean(state?.description.includes(markerOf(op.key)));
      const after = await readBack(() => issueState(created.id), marked, sleep);
      const verified = marked(after);
      if (verified) resolved.set(`new:${op.key}`, created.identifier);
      return { verified, extra: () => ({ key: op.key, issueId: created.id, identifier: created.identifier }) };
    },
    'relation.create': async op => {
      const [from, to] = [card(op.from), card(op.to)];
      const relationIn = state => state?.blocks.find(b => b.to === to)?.id ?? null;
      const before = await issueState(ids.get(from));
      const seen = observe(op, stateIndex(before), resolved);
      if (seen !== 'pending') return { seen, extra: () => ({ from, to, relationId: relationIn(before) }) };
      const { relationId } = await createBlocks(ids.get(from), ids.get(to), ctx);
      const shows = state => observe(op, stateIndex(state), resolved) === 'applied';
      const after = await readBack(() => issueState(ids.get(from)), shows, sleep);
      const verified = shows(after);
      return { verified, extra: () => ({ from, to, relationId: relationIn(after) ?? relationId }) };
    },
    'relation.delete': async op => {
      const [from, to] = [card(op.from), card(op.to)];
      const extra = () => ({ from, to, relationIds: op.before.relationIds });
      const seen = observe(op, stateIndex(await issueState(ids.get(from))), resolved);
      if (seen !== 'pending') return { seen, extra };
      for (const id of op.before.relationIds) await deleteRelation(id, ctx);
      const shows = state => observe(op, stateIndex(state), resolved) === 'applied';
      const verified = shows(await readBack(() => issueState(ids.get(from)), shows, sleep));
      return { verified, extra };
    },
    'notes.replace': async op => replaceDescription(op, () => ({ card: op.card, issueId: op.issueId, before: { block: op.before.block } })),
    'description.replace': async op => replaceDescription(op, () => ({ card: op.card, issueId: op.issueId, before: { description: op.before.description } })),
  };
  // Notes and description ops both write the whole description, checked against the hash the plan read.
  async function replaceDescription(op, extra) {
    const seen = observe(op, stateIndex(await issueState(op.issueId)));
    if (seen !== 'pending') return { seen, extra };
    await updateDescription(op.issueId, op.after.description, ctx);
    const shows = state => observe(op, stateIndex(state)) === 'applied';
    const verified = shows(await readBack(() => issueState(op.issueId), shows, sleep));
    return { verified, extra };
  }

  const results = [];
  let wrote = false;
  const log = (op, result, extra) => {
    appendLog({ v: 1, run, at: now().toISOString(), op: op.id, type: op.type, result, ...extra });
    results.push({ op: op.id, result });
  };
  const describe = op => {
    if (op.type === 'card.create') return { key: op.key };
    if (op.type === 'notes.replace') return { card: op.card, issueId: op.issueId, before: { block: op.before.block } };
    if (op.type === 'description.replace') return { card: op.card, issueId: op.issueId, before: { description: op.before.description } };
    return { from: card(op.from) ?? op.from, to: card(op.to) ?? op.to };
  };
  for (const op of plan.ops) {
    let step;
    try {
      step = await steps[op.type](op);
    } catch (e) {
      log(op, 'failed', { ...describe(op), error: redact(e.message, apiKey) });
      if (!fromLinear(e)) throw e;
      return { code: 1, results, messages: [`failed: ${op.id}: ${e.message}`, 'stopped; run apply again with the same plan to continue'] };
    }
    if (step.seen === 'applied') { log(op, 'skipped', step.extra()); continue; }
    if (step.seen?.drift) {
      log(op, 'failed', { ...step.extra(), error: `drift: ${step.seen.drift}` });
      const written = wrote ? 'earlier ops were written' : 'nothing was written';
      return { code: wrote ? 1 : 6, results, messages: [`drift: ${op.id}: ${step.seen.drift}`, `stopped; ${written}; run plan again`] };
    }
    wrote = true;
    if (!step.verified) {
      log(op, 'unverified', step.extra());
      return { code: 1, results, messages: [`unverified: ${op.id}: Linear did not show the change after the write; stopped`] };
    }
    log(op, 'applied', step.extra());
  }
  const final = await readLive(plan.project.id, apiKey, fetchImpl);
  const missing = plan.ops.filter(op => observe(op, final.index, resolved) !== 'applied');
  return { code: missing.length ? 1 : 0, results, messages: missing.map(op => `unverified: ${op.id}: not applied in the final re-fetch`) };
}

function undoAction(line) {
  switch (line.type) {
    case 'relation.create': return { result: 'listed', action: `delete relation ${line.relationId}: ${line.from} blocks ${line.to}` };
    case 'relation.delete': return { result: 'listed', action: `recreate ${line.from} blocks ${line.to}` };
    case 'card.create': return { result: 'manual', action: `archive ${line.identifier} by hand; a created card cannot be undone` };
    case 'notes.replace':
      return line.before?.block == null
        ? { result: 'manual', action: `remove the agent notes block from ${line.card} by hand; it had none before this run` }
        : { result: 'manual', action: `restore the agent notes block of ${line.card} by hand from block`, block: line.before.block };
    case 'description.replace':
      return { result: 'manual', action: `restore the description of ${line.card} by hand from description`, description: line.before.description };
    default: return { result: 'manual', action: `unknown op type ${line.type}; check it by hand` };
  }
}

export async function undoRun(entries, runId, { apiKey, fetchImpl, now, appendLog, execute = false, sleep = realSleep }) {
  const changed = entries.filter(l => l.run === runId && !l.undo && ['applied', 'unverified'].includes(l.result)).reverse();
  if (!changed.length) return { code: 4, results: [], messages: [`no applied lines for run ${runId} in applied.jsonl`] };
  const listed = changed.map(line => ({ op: line.op, type: line.type, ...undoAction(line) }));
  if (!execute) return { code: 0, results: listed, messages: [] };

  const ctx = { apiKey, fetchImpl };
  const issueState = async identifier => {
    const state = await fetchIssueState(identifier, apiKey, { fetchImpl });
    if (!state) throw new Error(`Linear has no card ${identifier}`);
    return state;
  };
  const between = (state, to) => state.blocks.filter(b => b.to === to).map(b => b.id);
  const steps = {
    'relation.create': async line => {
      if (!between(await issueState(line.from), line.to).includes(line.relationId)) return { result: 'skipped' };
      await deleteRelation(line.relationId, ctx);
      const isGone = state => !between(state, line.to).includes(line.relationId);
      const gone = isGone(await readBack(() => issueState(line.from), isGone, sleep));
      return { result: gone ? 'undone' : 'unverified' };
    },
    'relation.delete': async line => {
      const from = await issueState(line.from);
      if (between(from, line.to).length) return { result: 'skipped' };
      const { relationId } = await createBlocks(from.id, (await issueState(line.to)).id, ctx);
      const isBack = state => between(state, line.to).length > 0;
      const back = isBack(await readBack(() => issueState(line.from), isBack, sleep));
      return { result: back ? 'undone' : 'unverified', relationId };
    },
  };

  const results = [];
  for (const [i, line] of changed.entries()) {
    const step = steps[line.type];
    if (!step) { results.push(listed[i]); continue; }
    const ends = { from: line.from, to: line.to, ...(line.relationId ? { relationId: line.relationId } : {}) };
    const log = (result, extra = {}) => {
      appendLog({ v: 1, run: runId, at: now().toISOString(), op: line.op, type: line.type, result, undo: true, ...ends, ...extra });
      results.push({ op: line.op, type: line.type, result, action: listed[i].action });
    };
    let outcome;
    try {
      outcome = await step(line);
    } catch (e) {
      log('failed', { error: redact(e.message, apiKey) });
      if (!fromLinear(e)) throw e;
      return { code: 1, results, messages: [`failed: undo ${line.op}: ${e.message}`, 'stopped; run undo again to continue'] };
    }
    const { result, ...extra } = outcome;
    log(result, extra.relationId ? { relationId: extra.relationId } : {});
    if (result === 'unverified') return { code: 1, results, messages: [`unverified: undo ${line.op}: Linear did not show the change; stopped`] };
  }
  return { code: 0, results, messages: [] };
}
