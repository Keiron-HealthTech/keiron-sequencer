import { REQUEST_TIMEOUT_MS, linearQuery } from './linear-fetch.mjs';

// The relation type is a literal in the text, never a variable, so no input can turn a write into another relation kind.
const RELATION_CREATE = `
mutation RelationCreate($blocker: String!, $blocked: String!) {
  issueRelationCreate(input: { type: blocks, issueId: $blocker, relatedIssueId: $blocked }) { success issueRelation { id } }
}`;

const RELATION_DELETE = `
mutation RelationDelete($id: String!) {
  issueRelationDelete(id: $id) { success }
}`;

const ISSUE_CREATE = `
mutation IssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { id identifier url } }
}`;

const DESCRIPTION_UPDATE = `
mutation DescriptionUpdate($id: String!, $description: String!) {
  issueUpdate(id: $id, input: { description: $description }) { success issue { id } }
}`;

const ISSUE_STATE_UPDATE = `
mutation IssueStateUpdate($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) { success issue { id state { name } } }
}`;

// Only the fields given are sent, so a card's existing assignee is never part of the write.
const CYCLE_ISSUE_UPDATE = `
mutation CycleIssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success issue { id } }
}`;

function transport({ apiKey, fetchImpl, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('linear-write needs an injected fetchImpl; it has no default transport');
  return { apiKey, fetchImpl, timeoutMs };
}

async function write(name, text, field, variables, ctx) {
  const { apiKey, fetchImpl, timeoutMs } = transport(ctx);
  const data = await linearQuery(text, variables, apiKey, fetchImpl, timeoutMs);
  const payload = data?.[field];
  if (payload?.success !== true) throw new Error(`Linear did not accept ${name} (success: false)`);
  return payload;
}

export async function createBlocks(blockerId, blockedId, ctx) {
  const payload = await write('RelationCreate', RELATION_CREATE, 'issueRelationCreate', { blocker: blockerId, blocked: blockedId }, ctx);
  return { relationId: payload.issueRelation?.id ?? null };
}

export async function deleteRelation(relationId, ctx) {
  await write('RelationDelete', RELATION_DELETE, 'issueRelationDelete', { id: relationId }, ctx);
}

export async function createIssue(input, ctx) {
  const { issue } = await write('IssueCreate', ISSUE_CREATE, 'issueCreate', { input }, ctx);
  return { id: issue.id, identifier: issue.identifier, url: issue.url };
}

export async function updateDescription(issueId, description, ctx) {
  await write('DescriptionUpdate', DESCRIPTION_UPDATE, 'issueUpdate', { id: issueId, description }, ctx);
}

export async function setIssueState(issueId, stateId, ctx) {
  const { issue } = await write('IssueStateUpdate', ISSUE_STATE_UPDATE, 'issueUpdate', { id: issueId, stateId }, ctx);
  return { stateName: issue?.state?.name ?? null };
}

export async function updateIssueCycle(issueId, { cycleId, assigneeId } = {}, ctx) {
  const input = { ...(cycleId ? { cycleId } : {}), ...(assigneeId ? { assigneeId } : {}) };
  if (!Object.keys(input).length) throw new Error('updateIssueCycle needs a cycleId or an assigneeId');
  await write('CycleIssueUpdate', CYCLE_ISSUE_UPDATE, 'issueUpdate', { id: issueId, input }, ctx);
}
