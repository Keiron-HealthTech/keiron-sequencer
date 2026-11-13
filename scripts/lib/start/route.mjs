import { sizesFor, verdict } from '../records.mjs';

export function verdictFor(live, cardKey) {
  const size = sizesFor(live)[cardKey];
  if (size) return { value: size.verdict, tier: size.tier, label: size.label };
  const record = live.find(r => r.card === cardKey);
  return { value: record ? verdict(record, null) : 'no record', tier: null, label: null };
}

const changeNameOf = gitBranchName => (gitBranchName ? gitBranchName.replace(/^[^/]+\//, '') : null);
const isDesign = d => (d?.impact ?? 'design') === 'design';
// An open decision from before owner existed is treated as the people's, like an untagged impact is treated as design.
const isPeople = d => (d?.owner ?? 'people') === 'people';

// The questions a fresh pack answered, by the text draftPack copied from the decision; a stale pack answers nothing.
const answeredIn = pack => new Set(pack && !pack.stale ? (pack.answered ?? []).map(a => a.text) : []);

// The facts the route is decided from, in a fixed order, so the skill can say them out loud. A people-owned design
// decision answered in a fresh pack is settled: it no longer counts as open.
export function routeFacts({ verdict, record, siblings, pack = null }) {
  const open = Array.isArray(record.openDecisions) ? record.openDecisions : [];
  const design = open.filter(isDesign);
  const people = design.filter(isPeople);
  const answered = answeredIn(pack);
  const stillOpen = people.filter(d => !answered.has(d.text)).length;
  return {
    repos: record.size?.repos?.length ?? 0,
    designDecisions: design.length,
    peopleDecisions: stillOpen,
    packAnswered: people.length - stillOpen,
    newPaths: record.novelty?.newPaths?.length ?? 0,
    files: record.size?.files ?? 0,
    fixupsReceived: record.fixups?.received?.length ?? 0,
    tier: verdict.tier,
    unblocks: siblings?.dependents?.length ?? 0,
  };
}

// A recommendation, said with its reasons: sdd for cross-repo work, an open design decision the people own or an XL
// card; light for an L card, new paths or two fixups received; tdd otherwise. With no record the skill decides from the
// card text by the same rule; an old record missing the verdict inputs stays sdd and says unknown.
export function routeFor({ verdict, record, siblings, pack = null }, gitBranchName) {
  const changeName = changeNameOf(gitBranchName);
  if (!record) return { route: null, said: 'no record', reasons: [], changeName };
  const f = routeFacts({ verdict, record, siblings, pack });
  const reasons = [
    ...(f.repos > 1 ? ['repos>1'] : []), `design-decisions:${f.designDecisions}`, `people-decisions:${f.peopleDecisions}`,
    ...(f.packAnswered ? [`pack-answered:${f.packAnswered}`] : []),
    `new-paths:${f.newPaths}`, `files:${f.files}`, `fixups-received:${f.fixupsReceived}`, ...(f.tier ? [`tier:${f.tier}`] : []), `unblocks:${f.unblocks}`,
  ];
  if (verdict.value === 'unknown') return { route: 'sdd', said: 'unknown', reasons, changeName };
  const route = f.repos > 1 || f.peopleDecisions > 0 || f.tier === 'XL' ? 'sdd'
    : f.tier === 'L' || f.newPaths > 0 || f.fixupsReceived >= 2 ? 'light' : 'tdd';
  return { route, said: null, reasons, changeName };
}
