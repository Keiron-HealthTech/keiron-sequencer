import { readFileSync } from 'node:fs';

export const FIXTURE = JSON.parse(readFileSync(new URL('../fixtures/cardmap-synthetic.json', import.meta.url)));
export const FIXTURE_SLUG = 'c0ffee000001';
export const FIXTURE_NAME = FIXTURE.project;
export const FIXTURE_URL = `https://linear.app/example/project/sample-project-${FIXTURE_SLUG}`;
const FIXTURE_PROJECT = { id: 'project-uuid', slugId: FIXTURE_SLUG, name: FIXTURE_NAME, url: FIXTURE_URL };

export function fakeLinear({
  issues = FIXTURE.issues,
  milestones = FIXTURE.milestones,
  project = { ...FIXTURE_PROJECT },
  page = 60,
  full = {},
} = {}) {
  const sent = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push({ url, init, body });
    let data;
    if (body.query.includes('issue(id:')) {
      data = { issue: full[body.variables.id] ?? null };
    } else if (body.query.includes('project(id:')) {
      data = { project: { ...project, projectMilestones: { nodes: milestones } } };
    } else {
      const start = Number(body.variables.after ?? 0);
      const more = start + page < issues.length;
      data = { issues: { pageInfo: { hasNextPage: more, endCursor: more ? String(start + page) : null },
        nodes: issues.slice(start, start + page) } };
    }
    return { ok: true, json: async () => ({ data }) };
  };
  return { sent, fetchImpl };
}

const operationName = query => query.match(/^\s*(?:query|mutation)\s+(\w+)/)?.[1] ?? null;
const isMutationText = query => /^\s*mutation\b/.test(query);

export function fakeLinearStore({
  issues = [],
  milestones = [],
  project = { ...FIXTURE_PROJECT },
  teams = [{ id: 'team-crm', key: 'CRM' }],
  page = 60,
  failOn = null,
  markdown = {},
  members = [],
  cycles = { active: null, next: null, past: [] },
  viewer = { id: 'viewer-1', name: 'Me' },
} = {}) {
  const sent = [];
  const mutations = [];
  const calls = new Map();
  const store = { project, milestones, teams, issues: [], relations: [] };
  let relationSeq = 0;
  const nextRelationId = () => `rel-${++relationSeq}`;
  for (const { relations, inverseRelations, ...rest } of issues) {
    store.issues.push({ id: `uuid-${rest.identifier}`, description: '', archivedAt: null, ...rest });
  }
  for (const i of issues) {
    for (const r of i.relations?.nodes ?? []) {
      store.relations.push({ id: r.id ?? nextRelationId(), type: r.type, from: i.identifier, to: r.relatedIssue.identifier });
    }
  }

  const find = ref => store.issues.find(i => i.id === ref || i.identifier === ref) ?? null;
  // projectId: null is a card with no Linear project; a card that names no projectId is in the store's project.
  const projectOf = i => (i.projectId === undefined ? store.project.id : i.projectId);
  const inProject = () => store.issues.filter(i => projectOf(i) === store.project.id);
  const teamOf = i => store.teams.find(t => t.id === i.team?.id) ?? i.team ?? store.teams[0] ?? null;
  const teamRef = i => { const t = teamOf(i); return t && { id: t.id, key: t.key }; };
  const projectRef = i => {
    if (projectOf(i) === null) return null;
    const p = projectOf(i) === store.project.id ? store.project : { id: projectOf(i) };
    return { id: p.id, slugId: p.slugId ?? null, name: p.name ?? null, url: p.url ?? null };
  };
  // Linear may rewrite markdown on write; these mimic the two rewrites the apply verify must survive or catch.
  const rendered = text => {
    let out = text ?? '';
    if (markdown.dropComments) out = out.replace(/<!--[\s\S]*?-->/g, '');
    if (markdown.starBullets) out = out.replace(/^(\s*)- /gm, '$1* ');
    return out;
  };
  const brief = identifier => {
    const i = find(identifier);
    return { identifier, archivedAt: i?.archivedAt ?? null, state: i?.state ? { type: i.state.type } : null };
  };
  // The fake only returns relation ids when the query asks for them, as Linear would.
  const node = (i, withIds) => {
    const { description, projectId, team, comments, attachments, ...fields } = i;
    const rel = r => (withIds ? { id: r.id, type: r.type } : { type: r.type });
    return {
      ...fields,
      team: teamRef(i),
      attachments: { nodes: (attachments ?? []).slice(0, 50) },
      relations: { nodes: store.relations.filter(r => r.from === i.identifier).map(r => ({ ...rel(r), relatedIssue: brief(r.to) })) },
      inverseRelations: { nodes: store.relations.filter(r => r.to === i.identifier).map(r => ({ ...rel(r), issue: brief(r.from) })) },
    };
  };
  const paged = (after, map) => {
    const start = Number(after ?? 0);
    const issues = inProject();
    const more = start + page < issues.length;
    return { pageInfo: { hasNextPage: more, endCursor: more ? String(start + page) : null },
      nodes: issues.slice(start, start + page).map(map) };
  };
  const notFound = ref => { throw new Error(`Entity not found: ${ref}`); };

  const named = {
    IssueState: ({ id }) => {
      const i = find(id);
      return { issue: i && {
        id: i.id, identifier: i.identifier, title: i.title, description: i.description, archivedAt: i.archivedAt,
        project: projectOf(i) === null ? null : { id: projectOf(i) },
        relations: { nodes: store.relations.filter(r => r.from === i.identifier)
          .map(r => ({ id: r.id, type: r.type, relatedIssue: { identifier: r.to } })) },
      } };
    },
    StartIssue: ({ id }) => {
      const i = find(id);
      if (!i) return { issue: null };
      const comments = i.comments ?? [];
      return { issue: {
        id: i.id, identifier: i.identifier, title: i.title, url: i.url, description: i.description, archivedAt: i.archivedAt,
        gitBranchName: i.gitBranchName ?? null, state: i.state ?? null, team: teamRef(i),
        project: projectRef(i), projectMilestone: i.projectMilestone ?? null,
        attachments: { nodes: (i.attachments ?? []).slice(0, 50) },
        comments: { pageInfo: { hasNextPage: comments.length > 50 }, nodes: comments.slice(0, 50) },
      } };
    },
    Viewer: () => ({ viewer }),
    OffMapIssue: ({ id }) => {
      const i = find(id);
      if (!i) throw new Error(`Entity not found: ${id}`);
      return { issue: {
        identifier: i.identifier, title: i.title, description: i.description, archivedAt: i.archivedAt, state: i.state ?? null,
        labels: i.labels ?? { nodes: [] }, attachments: { nodes: (i.attachments ?? []).slice(0, 50) },
      } };
    },
    IssueTeamStates: ({ id }) => {
      const i = find(id);
      if (!i) return { issue: null };
      const team = teamOf(i);
      return { issue: {
        id: i.id, identifier: i.identifier, state: i.state ?? null,
        team: team && { id: team.id, key: team.key, states: { nodes: (team.states ?? []).slice(0, 100) } },
      } };
    },
    CycleContext: () => ({
      project: { members: { nodes: members } },
      team: { activeCycle: cycles.active, next: { nodes: cycles.next ? [cycles.next] : [] }, past: { nodes: cycles.past } },
    }),
    CycleIssueUpdate: ({ id, input }) => {
      const i = find(id) ?? notFound(id);
      if (input.cycleId) {
        const c = [cycles.active, cycles.next, ...cycles.past].find(x => x?.id === input.cycleId) ?? notFound(input.cycleId);
        i.cycle = { id: c.id, number: c.number };
      }
      if (input.assigneeId) {
        const m = members.find(x => x.id === input.assigneeId) ?? notFound(input.assigneeId);
        i.assignee = { id: m.id, name: m.name };
      }
      return { issueUpdate: { success: true, issue: { id: i.id } } };
    },
    CycleIssue: ({ id }) => {
      const i = find(id);
      return { issue: i && { id: i.id, identifier: i.identifier, archivedAt: i.archivedAt, state: i.state ? { type: i.state.type } : null,
        cycle: i.cycle ? { id: i.cycle.id } : null, assignee: i.assignee ? { id: i.assignee.id } : null } };
    },
    HarvestDescriptions: ({ after }) => ({
      issues: paged(after, i => ({ id: i.id, identifier: i.identifier, title: i.title, description: i.description, archivedAt: i.archivedAt })),
    }),
    RelationCreate: ({ blocker, blocked }) => {
      const from = find(blocker) ?? notFound(blocker);
      const to = find(blocked) ?? notFound(blocked);
      const id = nextRelationId();
      store.relations.push({ id, type: 'blocks', from: from.identifier, to: to.identifier });
      return { issueRelationCreate: { success: true, issueRelation: { id } } };
    },
    RelationDelete: ({ id }) => {
      const at = store.relations.findIndex(r => r.id === id);
      if (at === -1) notFound(id);
      store.relations.splice(at, 1);
      return { issueRelationDelete: { success: true } };
    },
    IssueCreate: ({ input }) => {
      const team = store.teams.find(t => t.id === input.teamId) ?? notFound(input.teamId);
      const numbers = store.issues.map(i => i.identifier.match(new RegExp(`^${team.key}-(\\d+)$`))?.[1]).filter(Boolean).map(Number);
      const identifier = `${team.key}-${Math.max(0, ...numbers) + 1}`;
      const milestone = store.milestones.find(m => m.id === input.projectMilestoneId);
      const created = {
        id: `uuid-${identifier}`, identifier, title: input.title, url: `u/${identifier}`, estimate: null, archivedAt: null,
        description: rendered(input.description), state: { name: 'Backlog', type: 'backlog' },
        projectMilestone: milestone ? { name: milestone.name } : null, labels: { nodes: [] },
      };
      store.issues.push(created);
      return { issueCreate: { success: true, issue: { id: created.id, identifier, url: created.url } } };
    },
    DescriptionUpdate: ({ id, description }) => {
      const i = find(id) ?? notFound(id);
      i.description = rendered(description);
      return { issueUpdate: { success: true, issue: { id: i.id } } };
    },
    IssueStateUpdate: ({ id, stateId }) => {
      const i = find(id) ?? notFound(id);
      const state = (teamOf(i)?.states ?? []).find(st => st.id === stateId) ?? notFound(stateId);
      i.state = { ...state };
      return { issueUpdate: { success: true, issue: { id: i.id, state: { name: state.name } } } };
    },
  };

  const answer = body => {
    const name = operationName(body.query);
    if (name) {
      if (!named[name]) throw new Error(`fakeLinearStore: no handler for operation ${name}`);
      return named[name](body.variables ?? {});
    }
    const withIds = /nodes \{ id type/.test(body.query.replace(/\s+/g, ' '));
    if (body.query.includes('issue(id:')) return { issue: find(body.variables.id) && node(find(body.variables.id), withIds) };
    if (body.query.includes('project(id:')) {
      const teams = store.teams.map(t => ({ id: t.id, key: t.key }));
      return { project: { ...store.project, projectMilestones: { nodes: store.milestones }, teams: { nodes: teams } } };
    }
    return { issues: paged(body.variables.after, i => node(i, withIds)) };
  };

  const FIELDS = {
    RelationCreate: 'issueRelationCreate', RelationDelete: 'issueRelationDelete', IssueCreate: 'issueCreate',
    DescriptionUpdate: 'issueUpdate', IssueStateUpdate: 'issueUpdate', CycleIssueUpdate: 'issueUpdate',
  };
  const failure = (name, init) => {
    calls.set(name, (calls.get(name) ?? 0) + 1);
    if (!failOn || failOn.op !== name || calls.get(name) !== (failOn.nth ?? 1)) return null;
    if (failOn.as === 'http500') return { ok: false, status: 500, statusText: 'Internal Server Error', json: async () => ({}) };
    if (failOn.as === 'graphql') {
      return { ok: true, json: async () => ({ data: null, errors: [{ message: `forbidden for key ${init.headers.authorization}` }] }) };
    }
    if (failOn.as === 'success-false') return { ok: true, json: async () => ({ data: { [FIELDS[name]]: { success: false } } }) };
    if (failOn.as === 'timeout') throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    throw new Error(`fakeLinearStore: unknown failOn.as ${failOn.as}`);
  };

  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push({ url, init, body });
    if (isMutationText(body.query)) mutations.push({ name: operationName(body.query), variables: body.variables });
    const failed = failure(operationName(body.query), init);
    if (failed) return failed;
    // Linear refuses a project read without its required variable, as it did for a card with no project.
    if (body.query.includes('project(id: $ref)') && body.variables?.ref == null) {
      return { ok: false, status: 400, statusText: 'Bad Request', json: async () => ({}) };
    }
    let data;
    try {
      data = answer(body);
    } catch (e) {
      if (e.message.startsWith('fakeLinearStore:')) throw e;
      return { ok: true, json: async () => ({ data: null, errors: [{ message: e.message }] }) };
    }
    return { ok: true, json: async () => ({ data }) };
  };
  return { fetchImpl, sent, store, mutations };
}
