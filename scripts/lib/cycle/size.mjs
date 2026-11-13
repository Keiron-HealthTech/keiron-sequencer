import { isLive, tiers } from '../records.mjs';

export const TIERS = ['S', 'M', 'L', 'XL'];
export const TIER_POINTS = { S: 1, M: 2, L: 3, XL: 5 };
export const DEFAULT_TIER = 'M';

const linesOf = r => (r.size?.prodLines ?? 0) + (r.size?.testLines ?? 0);
const cardNumber = key => Number(String(key).match(/(\d+)$/)?.[1] ?? 0);
const sized = (tier, source) => ({ tier, points: TIER_POINTS[tier], source });

// One scale for every record: a record outside the thin-spike population (an existing PR, say) takes the tier of the
// largest population record its lines reach, so carry-over, history and new cards are sized in the same units.
export function makeSizer(records, guesses = {}) {
  const tierOf = tiers(records);
  const scale = records.filter(r => tierOf.has(r.card)).map(r => [linesOf(r), tierOf.get(r.card)]).sort((a, b) => a[0] - b[0]);
  const byCard = new Map(records.filter(r => isLive(r) && r.size).map(r => [r.card, r]));
  const onScale = lines => {
    let tier = null;
    for (const [at, t] of scale) if (at <= lines) tier = t;
    return tier ?? scale[0][1];
  };
  return key => {
    const r = byCard.get(key);
    if (r && tierOf.has(key)) return sized(tierOf.get(key), 'record');
    if (r && scale.length && linesOf(r) > 0) return sized(onScale(linesOf(r)), 'record');
    return guesses[key] ? sized(guesses[key], 'guess') : sized(DEFAULT_TIER, 'default');
  };
}

export function anchors(records, perTier = 3) {
  const tierOf = tiers(records);
  const out = Object.fromEntries(TIERS.map(t => [t, []]));
  const spiked = records.filter(r => tierOf.has(r.card)).sort((a, b) => cardNumber(a.card) - cardNumber(b.card));
  for (const r of spiked) {
    const list = out[tierOf.get(r.card)];
    if (list.length < perTier) list.push({ key: r.card, title: r.title });
  }
  return out;
}
