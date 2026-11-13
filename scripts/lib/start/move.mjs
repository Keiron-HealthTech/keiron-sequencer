import { exitError } from '../cli.mjs';
import { fetchIssueTeamStates } from '../linear-fetch.mjs';
import { setIssueState } from '../linear-write.mjs';

const TARGET = 'In Progress';
const MOVABLE = new Set(['backlog', 'unstarted']);

export function inProgressStateOf(states) {
  const matches = states.filter(s => s?.type === 'started' && String(s.name).toLowerCase() === TARGET.toLowerCase());
  if (matches.length === 1) return { state: matches[0] };
  if (matches.length === 0) return { refused: `no started state named "${TARGET}"` };
  return { refused: `${matches.length} started states named "${TARGET}"` };
}

export async function moveToInProgress(cardKey, { key, fetchImpl, timeoutMs }) {
  const issue = await fetchIssueTeamStates(cardKey, key, { fetchImpl, timeoutMs });
  if (!issue) throw exitError(1, `${cardKey} was not found in Linear`);
  const from = { name: issue.state?.name ?? null, type: issue.state?.type ?? null };
  if (from.type === 'started') return { action: 'already-started', card: issue.identifier, state: from };
  if (!MOVABLE.has(from.type)) {
    return { refused: `${issue.identifier} is ${from.name} (${from.type}); only backlog and unstarted cards are moved` };
  }
  if (!issue.team) throw exitError(1, `${issue.identifier} has no team in Linear`);
  const target = inProgressStateOf(issue.team.states);
  if (target.refused) return { refused: `team ${issue.team.key} has ${target.refused}; ${issue.identifier} was not moved` };
  const { stateName } = await setIssueState(issue.id, target.state.id, { apiKey: key, fetchImpl, timeoutMs });
  return { action: 'moved', card: issue.identifier, from, to: stateName };
}
