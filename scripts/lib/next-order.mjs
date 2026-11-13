export const SOON_DAYS = 7;

const pad = n => String(n).padStart(2, '0');
const asDay = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

// Local calendar date: the ISO timestamp's date is UTC and is a day off near midnight.
export const localDay = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

export function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

export function dueBucket(dueDate, today, soonDays = SOON_DAYS) {
  const day = asDay(dueDate);
  if (!day) return null;
  if (day < today) return 'overdue';
  return day <= addDays(today, soonDays - 1) ? 'soon' : null;
}

const FINISHED = new Set(['completed', 'canceled']);
const DUE_ORDER = { overdue: 0, soon: 1 };
const cardNumber = key => Number(String(key).match(/(\d+)$/)?.[1] ?? 0);
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// A card's deadline is its own due date or its milestone's target date, whichever comes first: an overdue or soon
// deadline outranks milestone order, so a dated card beats an earlier milestone with no date.
const KEYS = [
  ['deadline', c => DUE_ORDER[c.deadline] ?? 2],
  ['milestone order', c => c.milestoneOrder ?? Infinity],
  ['card due date', c => DUE_ORDER[c.due] ?? 2],
  ['critical path', (c, onPath) => (onPath.has(c.key) ? 0 : 1)],
  ['downstream', c => -(c.downstream ?? 0)],
  ['card number', c => cardNumber(c.key)],
];

export const ORDER_KEYS = KEYS.map(([label]) => label);

export function rankCards(cards, { today, critical = [], criticalTies = [], soonDays = SOON_DAYS }) {
  const onPath = new Set([...critical, ...criticalTies]);
  const facts = cards.map(c => {
    const target = asDay(c.milestoneTargetDate);
    const finished = FINISHED.has(c.statusType);
    const due = asDay(c.dueDate);
    const earliest = [finished ? null : due, target].filter(Boolean).sort()[0] ?? null;
    return {
      ...c,
      due: finished ? null : dueBucket(c.dueDate, today, soonDays),
      milestoneOverdue: target !== null && target < today,
      deadline: finished ? null : dueBucket(earliest, today, soonDays),
    };
  });
  const first = (a, b) => {
    for (const [, key] of KEYS) {
      const d = compare(key(a, onPath), key(b, onPath));
      if (d) return d;
    }
    return compare(a.key, b.key);
  };
  const rank = new Map(facts.filter(c => !FINISHED.has(c.statusType)).sort(first).map((c, i) => [c, i + 1]));
  return facts.map(c => ({ ...c, rank: rank.get(c) ?? null }));
}
