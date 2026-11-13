import { analyzeProject, isExecutionCard } from '../graph.mjs';
import { planHash } from '../harvest.mjs';
import { localDay, rankCards } from '../next-order.mjs';
import { capacityOf, workingDays } from './capacity.mjs';
import { fillCycle } from './fill.mjs';
import { makeSizer } from './size.mjs';

export const CYCLE_PLAN_SCHEMA = 1;

const cardNumber = key => Number(String(key).match(/(\d+)$/)?.[1] ?? 0);
const byCardNumber = (a, b) => cardNumber(a.key) - cardNumber(b.key) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
const codePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const inside = (at, c) => Date.parse(at) >= Date.parse(c.startsAt) && Date.parse(at) < Date.parse(c.endsAt);

export function computeCyclePlan({ raw, context, team, records, guesses = {}, availability = {}, now }) {
  const refusals = [];
  if (!context.next) refusals.push('the team has no next cycle');
  if (!context.members.length) refusals.push('the project has no members');
  if (refusals.length) return { plan: null, needs: [], refusals, warnings: [] };

  const sizeOf = makeSizer(records, guesses);
  const issueOf = new Map(raw.issues.map(i => [i.identifier, i]));
  const ours = key => issueOf.get(key)?.team?.id === team.id;
  const a = analyzeProject(raw, {});
  const ranked = rankCards(a.cards, { today: localDay(now), critical: a.critical, criticalTies: a.criticalTies })
    .filter(c => c.rank !== null).sort((x, y) => x.rank - y.rank);
  const done = new Set(raw.issues.filter(i => ['completed', 'canceled'].includes(i.state?.type)).map(i => i.identifier));
  const open = ranked.filter(c => ours(c.key)).map(c => {
    const i = issueOf.get(c.key);
    const later = i.cycle && i.cycle.number > context.next.number ? i.cycle.number : null;
    return { key: c.key, id: i.id, title: i.title, state: i.state, assignee: i.assignee ?? null, offMapBlockers: c.offMapBlockers ?? [], cycleId: i.cycle?.id ?? null, laterCycle: later };
  });
  const inCycle = (id, kind) => open.filter(c => id && c.cycleId === id).map(c => ({ ...c, kind }));
  const fixed = [...inCycle(context.active?.id, 'carry-over'), ...inCycle(context.next.id, 'planned')];
  const fixedKeys = new Set(fixed.map(c => c.key));
  const candidates = open.filter(c => !fixedKeys.has(c.key));

  // Linear may auto-archive closed issues, so history keeps archived cards that would be on the map otherwise.
  const completed = raw.issues.filter(i => i.state?.type === 'completed' && i.completedAt && ours(i.identifier) && isExecutionCard({ ...i, archivedAt: null })).map(i => ({ key: i.identifier, assigneeId: i.assignee?.id ?? null, completedAt: i.completedAt, title: i.title }));
  const peopleIn = [...context.members.map(m => ({ id: m.id, name: m.name, member: true }))];
  for (const c of open) if (c.assignee && !peopleIn.some(p => p.id === c.assignee.id)) peopleIn.push({ ...c.assignee, member: false });
  const people = peopleIn.map(p => {
    const share = availability[p.id] ?? 100;
    return { ...p, availability: share, ...capacityOf({ personId: p.id, completed, past: context.past, active: context.active, availability: share, next: context.next, sizeOf }) };
  });

  const filled = fillCycle({ people, fixed, candidates, edges: a.edges.map(e => ({ from: e.from, to: e.to })), done, sizeOf });
  const before = key => ({ cycleId: issueOf.get(key).cycle?.id ?? null, assigneeId: issueOf.get(key).assignee?.id ?? null });
  const ops = filled.cards.flatMap(c => {
    if (c.band === 'committed') {
      const set = { cycleId: context.next.id, ...(c.assigns ? { assigneeId: c.assignee.id } : {}) };
      return [{ type: 'issue.update', card: c.key, issueId: c.id, set, before: before(c.key) }];
    }
    if (c.band === 'fixed' && c.assigns) return [{ type: 'issue.update', card: c.key, issueId: c.id, set: { assigneeId: c.assignee.id }, before: before(c.key) }];
    return [];
  }).sort((x, y) => codePoint(x.card, y.card));

  const windows = [...(context.active ? [context.active] : []), ...context.past];
  const historyKeys = completed.filter(x => windows.some(c => inside(x.completedAt, c)));
  const needs = [
    ...open.filter(c => sizeOf(c.key).source === 'default').map(c => ({ key: c.key, title: c.title, completed: false })),
    ...historyKeys.filter(x => sizeOf(x.key).source === 'default').map(x => ({ key: x.key, title: x.title, completed: true })),
  ].sort(byCardNumber);

  const count = band => filled.cards.filter(c => c.band === band).length;
  const plan = {
    schemaVersion: CYCLE_PLAN_SCHEMA,
    project: { id: raw.project.id, slug: raw.project.slug, name: raw.project.name },
    team: { id: team.id, key: team.key },
    activeCycle: context.active ? { id: context.active.id, number: context.active.number } : null,
    nextCycle: { ...context.next, workingDays: workingDays(context.next) },
    inputs: { guesses, availability },
    people: filled.people,
    cards: filled.cards,
    ops,
    unspiked: { open: open.filter(c => sizeOf(c.key).source !== 'record').length, total: open.length },
    counts: { fixed: count('fixed'), committed: count('committed'), stretch: count('stretch'), leftOut: count('left-out'), ops: ops.length },
    generatedAt: now.toISOString(),
  };
  return { plan: { ...plan, hash: planHash(plan) }, needs, members: context.members, refusals, warnings: raw.warnings ?? [] };
}

const pct = n => `${Math.round(n * 100)}%`;
const pts = n => `${n} pt${n === 1 ? '' : 's'}`;
const cardsOf = n => `${n} card${n === 1 ? '' : 's'}`;
const sizeLabel = c => `${c.tier}·${c.points}${c.sizeSource === 'guess' ? ' (guessed from card)' : c.sizeSource === 'default' ? ' (default M)' : ''}`;
const sum = (list, f) => Math.round(list.reduce((s, x) => s + f(x), 0) * 100) / 100;
const BAND_LABEL = { fixed: 'carry-over / planned', committed: 'committed', stretch: 'stretch' };

function capacityLine(p, next) {
  if (p.basis === 'guessed') return `capacity guessed, no cycle history: ${next.workingDays} working days × ${p.availability}% → committed ${p.committed}, stretch ${p.stretch}`;
  const thin = p.basis === 'thin' ? ' (thin history: committed is 80% of the average)' : '';
  const cycles = p.cycles.map(n => (n === p.partial ? `${n} so far` : n)).join(', ');
  return `history ${p.history.join(' · ')} (cycles ${cycles})${thin} → committed ${p.committed}, stretch ${p.stretch}`;
}

export function renderCycleReview(plan, { approveCommand }) {
  const out = [
    `# Cycle plan: ${plan.project.name}, cycle ${plan.nextCycle.number}`,
    '',
    `- Next cycle: ${plan.nextCycle.startsAt.slice(0, 10)} to ${plan.nextCycle.endsAt.slice(0, 10)} (${plan.nextCycle.workingDays} working days), team ${plan.team.key}`,
    `- Hash: \`${plan.hash}\``,
    `- Cards: ${plan.counts.fixed} already in a cycle, ${plan.counts.committed} committed, ${plan.counts.stretch} stretch, ${plan.counts.leftOut} left out`,
    '',
  ];
  if (plan.unspiked.total && plan.unspiked.open * 3 > plan.unspiked.total) {
    out.push(`> ${plan.unspiked.open} of ${plan.unspiked.total} open cards have no spike record, so their sizes are guesses. Run /keiron-sequencer:spike first for measured sizes.`, '');
  }
  for (const p of plan.people) {
    const mine = plan.cards.filter(c => c.assignee?.id === p.id && c.band !== 'left-out');
    if (!p.member && !mine.length) continue;
    out.push(`## ${p.name}: ${p.availability}%${p.member ? '' : ' (not a project member)'}`, '', `- ${capacityLine(p, plan.nextCycle)}`);
    if (p.guessedCards || p.defaultCards) out.push(`- ${p.guessedCards} of ${p.counted} history cards guessed, ${p.defaultCards} default`);
    if (p.over) out.push(`- ⚠ over committed by ${p.over} before any new card`);
    for (const band of ['fixed', 'committed', 'stretch']) {
      const list = mine.filter(c => c.band === band);
      if (list.length) out.push(`- ${BAND_LABEL[band]}: ${pts(sum(list, c => c.remaining))}, ${cardsOf(list.length)}`);
    }
    out.push('', '| Card | Band | Size | Left | Running |', '|---|---|---|---|---|');
    let running = 0;
    for (const c of mine) {
      running = Math.round((running + c.remaining) * 100) / 100;
      const who = c.assigns ? ' (assigned by the plan)' : '';
      out.push(`| ${c.key} ${c.title}${who} | ${c.kind === 'new' ? c.band : `${c.band}, ${c.kind}`} | ${sizeLabel(c)} | ${c.fraction === 1 ? c.remaining : `${c.remaining} (${pct(c.fraction)})`} | ${running} |`);
    }
    out.push(`| | | | load | ${p.load} |`, '');
  }
  const left = plan.cards.filter(c => c.band === 'left-out');
  if (left.length) {
    out.push('## Left out', '');
    for (const c of left) out.push(`- ${c.key} ${c.title}, ${sizeLabel(c)}: left out, ${c.reason}`);
    out.push('');
  }
  out.push('## Apply', '',
    `Apply adds the ${cardsOf(plan.counts.committed)} marked committed to cycle ${plan.nextCycle.number} and sets an assignee only where a card has none.`,
    'Stretch cards are not added: they are next if there is room. Carry-over cards move with Linear\'s own rollover.', '',
    `${plan.ops.length} change${plan.ops.length === 1 ? '' : 's'}: \`${approveCommand}\``, '');
  return out.join('\n');
}
