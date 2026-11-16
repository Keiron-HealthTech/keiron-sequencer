import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const ENDPOINT = 'https://api.linear.app/graphql';
export const ISSUES_PAGE = 60;
export const RELATIONS_PAGE = 15;
export const RELATIONS_MAX = 100;
const DESCRIPTIONS_PAGE = 50;
const ATTACHMENTS_PAGE = 50;
const COMMENTS_PAGE = 50;
const STATES_PAGE = 100;
export const REQUEST_TIMEOUT_MS = 30_000;
export const PLANNER_KEY_FILE = join(homedir(), '.config', 'keiron-planner', 'linear.key');

const MIN_KEY_LENGTH = 20;

function firstLine(path) {
  try { return readFileSync(path, 'utf8').split(/\r?\n/)[0].trim() || null; } catch { return null; }
}

const tilde = path => (path.startsWith(homedir() + '/') ? `~${path.slice(homedir().length)}` : path);

export function readLinearKey(env = process.env, keyFile = PLANNER_KEY_FILE) {
  const raw = env.LINEAR_API_KEY?.trim() || firstLine(keyFile);
  if (!raw) return { key: null, reason: `no Linear key: set LINEAR_API_KEY or put it in ${tilde(keyFile)}` };
  if (raw.includes('...')) return { key: null, reason: 'the Linear key is still the placeholder' };
  if (raw.length < MIN_KEY_LENGTH) return { key: null, reason: `the Linear key looks too short (${raw.length} chars)` };
  return { key: raw, reason: null };
}

export const projectSlugFromUrl = url =>
  String(url ?? '').match(/\/project\/[^/?#]*?-?([0-9a-f]{12})(?:[/?#]|$)/i)?.[1] ?? null;

const REF_KINDS = [
  ['slug', /^[0-9a-f]{12}$/i],
  ['uuid', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i],
  ['identifier', /^P-[A-Z]+-\d+$/i],
];

export function parseProjectRef(arg) {
  const s = String(arg ?? '').trim();
  if (/^https?:\/\//i.test(s)) {
    const slug = projectSlugFromUrl(s);
    return slug ? { ref: slug, kind: 'url' } : null;
  }
  const kind = REF_KINDS.find(([, re]) => re.test(s))?.[0];
  return kind ? { ref: s, kind } : null;
}

const PROJECT = `
query($ref: String!) {
  project(id: $ref) {
    id slugId name url teams(first: 10) { nodes { id key } } projectMilestones(first: 50) { nodes { id name sortOrder targetDate } }
  }
}`;

// Every read takes the branch name through this one alias, so a different field name is a one-token change.
const BRANCH_NAME = 'gitBranchName: branchName';

const ISSUES = `
query($projectId: ID!, $after: String) {
  issues(filter: { project: { id: { eq: $projectId } } }, includeArchived: true, first: ${ISSUES_PAGE}, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id identifier title url estimate dueDate archivedAt completedAt ${BRANCH_NAME}
      assignee { id name } cycle { id number } team { id key }
      attachments(first: ${ATTACHMENTS_PAGE}) { nodes { url } }
      state { name type } projectMilestone { name } labels(first: 20) { nodes { name } }
      relations(first: ${RELATIONS_PAGE}, includeArchived: true) { nodes { id type relatedIssue { identifier archivedAt state { type } } } }
      inverseRelations(first: ${RELATIONS_PAGE}, includeArchived: true) { nodes { id type issue { identifier archivedAt state { type } } } }
    }
  }
}`;

const ALL_RELATIONS = `
query($id: String!) {
  issue(id: $id) {
    relations(first: ${RELATIONS_MAX}, includeArchived: true) { nodes { id type relatedIssue { identifier archivedAt state { type } } } }
    inverseRelations(first: ${RELATIONS_MAX}, includeArchived: true) { nodes { id type issue { identifier archivedAt state { type } } } }
  }
}`;

const DESCRIPTIONS = `
query HarvestDescriptions($projectId: ID!, $after: String) {
  issues(filter: { project: { id: { eq: $projectId } } }, includeArchived: true, first: ${DESCRIPTIONS_PAGE}, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { id identifier title description archivedAt }
  }
}`;

const ISSUE_STATE = `
query IssueState($id: String!) {
  issue(id: $id) {
    id identifier title description archivedAt project { id }
    relations(first: ${RELATIONS_MAX}, includeArchived: true) { nodes { id type relatedIssue { identifier } } }
  }
}`;

const START_ISSUE = `
query StartIssue($id: String!) {
  issue(id: $id) {
    id identifier title url description archivedAt ${BRANCH_NAME}
    state { name type } team { id key } project { id slugId name url } projectMilestone { name }
    attachments(first: ${ATTACHMENTS_PAGE}) { nodes { url } }
    comments(first: ${COMMENTS_PAGE}) { pageInfo { hasNextPage } nodes { body createdAt } }
  }
}`;

const CYCLE = 'id number startsAt endsAt';

const CYCLE_CONTEXT = `
query CycleContext($projectId: String!, $teamId: String!, $since: DateTimeOrDuration!) {
  project(id: $projectId) { members(first: 50) { nodes { id name displayName } } }
  team(id: $teamId) {
    activeCycle { ${CYCLE} }
    next: cycles(first: 1, filter: { isNext: { eq: true } }) { nodes { ${CYCLE} } }
    past: cycles(first: 50, filter: { isPast: { eq: true }, endsAt: { gte: $since } }) { nodes { ${CYCLE} } }
  }
}`;

export const PAST_CYCLES = 6;
const LOOKBACK_DAYS = 180;

const ISSUE_TEAM_STATES = `
query IssueTeamStates($id: String!) {
  issue(id: $id) { id identifier state { id name type } team { id key states(first: ${STATES_PAGE}) { nodes { id name type } } } }
}`;

const CONNECTIONS = [
  ['relations', 'relations-truncated'],
  ['inverseRelations', 'inverse-relations-truncated'],
];

const count = (issue, field) => (issue[field]?.nodes ?? []).length;

const KEY_WINDOW = 8;

export function redact(text, secret) {
  const s = String(text);
  if (!secret || secret.length < KEY_WINDOW) return s;
  const hidden = new Array(s.length).fill(false);
  for (let i = 0; i + KEY_WINDOW <= secret.length; i++) {
    const piece = secret.slice(i, i + KEY_WINDOW);
    for (let j = s.indexOf(piece); j !== -1; j = s.indexOf(piece, j + 1)) hidden.fill(true, j, j + KEY_WINDOW);
  }
  let out = '';
  for (let j = 0; j < s.length; j++) {
    if (!hidden[j]) out += s[j];
    else if (!hidden[j - 1]) out += '[redacted]';
  }
  return out;
}

export async function linearQuery(query, variables, apiKey, fetchImpl, timeoutMs) {
  const fail = message => new Error(redact(message, apiKey));
  const timedOut = e => e?.name === 'TimeoutError';
  const timeoutError = () => fail(`Linear request timed out after ${timeoutMs / 1000}s`);
  const signal = AbortSignal.timeout(timeoutMs);
  let res;
  try {
    res = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: apiKey },
      body: JSON.stringify({ query, variables }),
      signal,
    });
  } catch (e) {
    throw timedOut(e) ? timeoutError() : fail(`Linear request failed: ${e.message}`);
  }
  if (!res.ok) throw fail(`Linear HTTP ${res.status} ${res.statusText}`);
  let body;
  try {
    body = await res.json();
  } catch (e) {
    throw timedOut(e) ? timeoutError() : e;
  }
  if (body.errors?.length) throw fail(`Linear: ${body.errors[0].message}`);
  return body.data;
}

export async function fetchProject(ref, apiKey, { fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  if (!apiKey) throw new Error('Linear API key missing');
  const { project } = await linearQuery(PROJECT, { ref }, apiKey, fetchImpl, timeoutMs);
  if (!project) throw new Error(`Linear did not resolve project '${ref}'; pass its URL or slug`);
  return project;
}

export async function fetchProjectMap(ref, apiKey, { fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS, project: known = null } = {}) {
  if (!apiKey) throw new Error('Linear API key missing');
  const project = known ?? await fetchProject(ref, apiKey, { fetchImpl, timeoutMs });
  const issues = [];
  let after = null;
  do {
    const data = await linearQuery(ISSUES, { projectId: project.id, after }, apiKey, fetchImpl, timeoutMs);
    issues.push(...(data.issues?.nodes ?? []));
    after = data.issues?.pageInfo?.hasNextPage ? data.issues.pageInfo.endCursor : null;
  } while (after);
  const capped = issues.filter(i => CONNECTIONS.some(([field]) => count(i, field) >= RELATIONS_PAGE));
  await Promise.all(capped.map(async i => {
    const { issue } = await linearQuery(ALL_RELATIONS, { id: i.id }, apiKey, fetchImpl, timeoutMs);
    for (const [field] of CONNECTIONS) i[field] = issue?.[field] ?? i[field];
  }));
  const warnings = [];
  for (const i of capped) {
    for (const [field, kind] of CONNECTIONS) {
      if (count(i, field) >= RELATIONS_MAX) {
        warnings.push({ key: i.identifier, kind, message: `${i.identifier}: ${RELATIONS_MAX} ${field} returned; blocks may be missing` });
      }
    }
  }
  return {
    project: { id: project.id, slug: project.slugId, name: project.name, url: project.url, teams: project.teams?.nodes ?? [] },
    issues,
    milestones: project.projectMilestones?.nodes ?? [],
    warnings,
  };
}

export async function fetchDescriptions(projectId, apiKey, { fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const out = new Map();
  let after = null;
  do {
    const data = await linearQuery(DESCRIPTIONS, { projectId, after }, apiKey, fetchImpl, timeoutMs);
    for (const n of data.issues?.nodes ?? []) {
      out.set(n.identifier, { id: n.id, title: n.title, description: n.description ?? '', archivedAt: n.archivedAt ?? null });
    }
    after = data.issues?.pageInfo?.hasNextPage ? data.issues.pageInfo.endCursor : null;
  } while (after);
  return out;
}

export async function fetchIssueState(id, apiKey, { fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const { issue } = await linearQuery(ISSUE_STATE, { id }, apiKey, fetchImpl, timeoutMs);
  if (!issue) return null;
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? '',
    archivedAt: issue.archivedAt ?? null,
    projectId: issue.project?.id ?? null,
    blocks: (issue.relations?.nodes ?? [])
      .filter(r => r?.type === 'blocks' && r.relatedIssue?.identifier)
      .map(r => ({ id: r.id, to: r.relatedIssue.identifier })),
  };
}

export const GITHUB_PULL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+(?:[/?#]|$)/i;

// Linear answers an unknown identifier with a GraphQL error, not a null issue.
const NOT_FOUND = /^Linear: Entity not found\b/;

export async function fetchStartIssue(identifier, apiKey, { fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  let issue;
  try {
    ({ issue } = await linearQuery(START_ISSUE, { id: identifier }, apiKey, fetchImpl, timeoutMs));
  } catch (e) {
    if (NOT_FOUND.test(e.message)) return null;
    throw e;
  }
  if (!issue) return null;
  const project = issue.project;
  return {
    id: issue.id,
    key: issue.identifier,
    title: issue.title,
    url: issue.url,
    description: issue.description ?? '',
    archivedAt: issue.archivedAt ?? null,
    state: { name: issue.state?.name ?? null, type: issue.state?.type ?? null },
    gitBranchName: issue.gitBranchName ?? null,
    team: issue.team ? { id: issue.team.id, key: issue.team.key } : null,
    project: project ? { id: project.id, slugId: project.slugId ?? null, name: project.name ?? null, url: project.url ?? null } : null,
    milestone: issue.projectMilestone?.name ?? null,
    attachments: (issue.attachments?.nodes ?? []).map(a => a?.url).filter(url => GITHUB_PULL.test(url ?? '')),
    comments: (issue.comments?.nodes ?? [])
      .map(c => ({ createdAt: c.createdAt, body: c.body ?? '' }))
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))),
    commentsTruncated: issue.comments?.pageInfo?.hasNextPage === true,
  };
}

const stateOf = s => s && { id: s.id, name: s.name, type: s.type };

export async function fetchIssueTeamStates(identifier, apiKey, { fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const { issue } = await linearQuery(ISSUE_TEAM_STATES, { id: identifier }, apiKey, fetchImpl, timeoutMs);
  if (!issue) return null;
  return {
    id: issue.id,
    identifier: issue.identifier,
    state: stateOf(issue.state) ?? null,
    team: issue.team ? { id: issue.team.id, key: issue.team.key, states: (issue.team.states?.nodes ?? []).map(stateOf) } : null,
  };
}

export async function fetchCycleContext(projectId, teamId, apiKey, { fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS, now = new Date() } = {}) {
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000).toISOString();
  const { project, team } = await linearQuery(CYCLE_CONTEXT, { projectId, teamId, since }, apiKey, fetchImpl, timeoutMs);
  const pick = c => c && { id: c.id, number: c.number, startsAt: c.startsAt, endsAt: c.endsAt };
  return {
    members: (project?.members?.nodes ?? []).map(m => ({ id: m.id, name: m.name, displayName: m.displayName ?? null })),
    active: pick(team?.activeCycle) ?? null,
    next: pick(team?.next?.nodes?.[0]) ?? null,
    past: (team?.past?.nodes ?? []).map(pick).sort((a, b) => String(b.endsAt).localeCompare(String(a.endsAt))).slice(0, PAST_CYCLES),
  };
}

const CYCLE_ISSUE = `
query CycleIssue($id: String!) {
  issue(id: $id) { id identifier archivedAt state { type } cycle { id } assignee { id } }
}`;

export async function fetchIssueCycle(id, apiKey, { fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const { issue } = await linearQuery(CYCLE_ISSUE, { id }, apiKey, fetchImpl, timeoutMs);
  if (!issue) return null;
  return { id: issue.id, key: issue.identifier, cycleId: issue.cycle?.id ?? null, assigneeId: issue.assignee?.id ?? null };
}

const VIEWER = `
query Viewer {
  viewer { id name }
}`;

export async function fetchViewer(apiKey, { fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const { viewer } = await linearQuery(VIEWER, {}, apiKey, fetchImpl, timeoutMs);
  return { id: viewer.id, name: viewer.name ?? null };
}

const OFF_MAP_ISSUE = `
query OffMapIssue($id: String!) {
  issue(id: $id) {
    identifier title description archivedAt
    state { name type } labels(first: 20) { nodes { name } }
    attachments(first: ${ATTACHMENTS_PAGE}) { nodes { url } }
  }
}`;

export async function fetchOffMapIssue(identifier, apiKey, { fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  let issue;
  try {
    ({ issue } = await linearQuery(OFF_MAP_ISSUE, { id: identifier }, apiKey, fetchImpl, timeoutMs));
  } catch (e) {
    if (NOT_FOUND.test(e.message)) return null;
    throw e;
  }
  if (!issue) return null;
  return {
    key: issue.identifier,
    title: issue.title,
    description: issue.description ?? '',
    archivedAt: issue.archivedAt ?? null,
    state: { name: issue.state?.name ?? null, type: issue.state?.type ?? null },
    labels: (issue.labels?.nodes ?? []).map(l => l.name),
    attachments: (issue.attachments?.nodes ?? []).map(a => a?.url).filter(url => GITHUB_PULL.test(url ?? '')),
  };
}
