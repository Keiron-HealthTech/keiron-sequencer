import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCardMap } from '../scripts/lib/graph.mjs';
import {
  ENDPOINT, ISSUES_PAGE, PLANNER_KEY_FILE, RELATIONS_MAX, RELATIONS_PAGE, REQUEST_TIMEOUT_MS,
  fetchDescriptions, fetchIssueState, fetchIssueTeamStates, fetchOffMapIssue, fetchProjectMap, fetchStartIssue, fetchViewer, parseProjectRef, projectSlugFromUrl, readLinearKey,
} from '../scripts/lib/linear-fetch.mjs';
import { fakeLinear, fakeLinearStore, FIXTURE_NAME, FIXTURE_SLUG, FIXTURE_URL } from './helpers/fake-linear.mjs';

const KEY = 'lin_api_dummy_' + 'x'.repeat(30);
const SOURCE = readFileSync(new URL('../scripts/lib/linear-fetch.mjs', import.meta.url), 'utf8');

const node = (over = {}) => ({
  id: `id-${over.identifier ?? 'CRM-1'}`, identifier: 'CRM-1', title: 'Card', url: 'u', estimate: null, archivedAt: null,
  state: { name: 'Backlog', type: 'backlog' }, projectMilestone: null, labels: { nodes: [] },
  relations: { nodes: [] }, inverseRelations: { nodes: [] }, ...over,
});

test('the fetch module imports only node builtins, never i18n or config', () => {
  const specifiers = [...SOURCE.matchAll(/^import\s.*?from\s+['"]([^'"]+)['"]/gm)].map(m => m[1]);
  for (const s of specifiers) assert.match(s, /^node:/, `unexpected import ${s}`);
  assert.doesNotMatch(SOURCE, /i18n|config\.mjs/);
});

test('every request goes through the injected fetch as a read-only POST with the raw key', async () => {
  const { sent, fetchImpl } = fakeLinear({ issues: [node({ identifier: 'CRM-1' }), node({ identifier: 'CRM-2' })], page: 1 });
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('global fetch used'); };
  try {
    await fetchProjectMap('c0ffee000001', KEY, { fetchImpl });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(sent.length >= 2);
  for (const { url, init, body } of sent) {
    assert.equal(url, ENDPOINT);
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.authorization, KEY);
    assert.equal(init.headers['content-type'], 'application/json');
    assert.doesNotMatch(body.query, /\bmutation\b/i);
  }
});

test('the project is read first, once, and its id filters the issue pages', async () => {
  const { sent, fetchImpl } = fakeLinear({ issues: [node({ identifier: 'CRM-1' }), node({ identifier: 'CRM-2' })], page: 1 });
  await fetchProjectMap('c0ffee000001', KEY, { fetchImpl });
  assert.match(sent[0].body.query, /project\(id:/);
  assert.equal(sent[0].body.variables.ref, 'c0ffee000001');
  assert.equal(sent.filter(s => /project\(id:/.test(s.body.query)).length, 1);
  const pages = sent.slice(1);
  assert.equal(pages.length, 2);
  for (const p of pages) assert.equal(p.body.variables.projectId, 'project-uuid');
});

test('the issues query asks for archived issues and everything the graph classifies', async () => {
  const { sent, fetchImpl } = fakeLinear({ issues: [node()] });
  await fetchProjectMap('c0ffee000001', KEY, { fetchImpl });
  const q = sent[1].body.query.replace(/\s+/g, ' ');
  assert.equal(ISSUES_PAGE, 60);
  assert.match(q, new RegExp(`first: ${ISSUES_PAGE}\\b`));
  assert.match(q, /includeArchived: true/);
  assert.match(q, /project: \{ id: \{ eq: \$projectId \} \}/);
  for (const field of ['archivedAt', 'estimate', 'dueDate', 'state { name type }', 'projectMilestone { name }', 'labels(first: 20) { nodes { name } }'])
    assert.ok(q.includes(field), `missing ${field}`);
  assert.match(q, /relations\(first: 15, includeArchived: true\) \{ nodes \{ id type relatedIssue \{ identifier archivedAt state \{ type \} \} \} \}/);
  assert.match(q, /inverseRelations\(first: 15, includeArchived: true\) \{ nodes \{ id type issue \{ identifier archivedAt state \{ type \} \} \} \}/);
});

test('pages are concatenated in order, archived issues kept, and the result has project, issues, milestones, warnings', async () => {
  const archived = node({ identifier: 'CRM-3', archivedAt: '2026-11-01T00:00:00.000Z' });
  const { fetchImpl } = fakeLinear({
    issues: [node({ identifier: 'CRM-1' }), node({ identifier: 'CRM-2' }), archived],
    milestones: [{ name: 'M', sortOrder: 1 }],
    page: 1,
  });
  const raw = await fetchProjectMap('c0ffee000001', KEY, { fetchImpl });
  assert.deepEqual(Object.keys(raw).sort(), ['issues', 'milestones', 'project', 'warnings']);
  assert.deepEqual(raw.issues.map(i => i.identifier), ['CRM-1', 'CRM-2', 'CRM-3']);
  assert.equal(raw.issues[2].archivedAt, '2026-11-01T00:00:00.000Z');
  assert.deepEqual(raw.project, { id: 'project-uuid', slug: FIXTURE_SLUG, name: FIXTURE_NAME, url: FIXTURE_URL, teams: [] });
  assert.deepEqual(raw.milestones, [{ name: 'M', sortOrder: 1 }]);
  assert.deepEqual(raw.warnings, []);
});

const rels = n => ({ nodes: Array.from({ length: n }, (_, i) => ({ type: 'blocks', relatedIssue: { identifier: `CRM-9${i}` } })) });
const inverse = n => ({ nodes: Array.from({ length: n }, (_, i) => ({ type: 'blocks', issue: { identifier: `CRM-8${i}` } })) });
const isRefetch = s => /issue\(id:/.test(s.body.query);

test('relations to archived cards are asked for on the nested connections too', async () => {
  const { sent, fetchImpl } = fakeLinear({
    issues: [node({ identifier: 'CRM-1', relations: rels(15) })],
    full: { 'id-CRM-1': { relations: rels(16), inverseRelations: inverse(0) } },
  });
  await fetchProjectMap('c0ffee000001', KEY, { fetchImpl });
  const page = sent.find(s => /issues\(/.test(s.body.query)).body.query.replace(/\s+/g, ' ');
  const refetch = sent.find(isRefetch).body.query.replace(/\s+/g, ' ');
  for (const q of [page, refetch]) {
    for (const conn of ['relations', 'inverseRelations'])
      assert.match(q, new RegExp(`\\b${conn}\\(first: \\d+, includeArchived: true\\)`), `${conn} misses includeArchived`);
  }
});

test('a card capped at 15 relations is re-read whole, after paging', async () => {
  const { sent, fetchImpl } = fakeLinear({
    issues: [node({ identifier: 'CRM-1', relations: rels(15) }), node({ identifier: 'CRM-2' })],
    full: { 'id-CRM-1': { relations: rels(19), inverseRelations: inverse(0) } },
    page: 1,
  });
  const raw = await fetchProjectMap('c0ffee000001', KEY, { fetchImpl });
  assert.equal(RELATIONS_PAGE, 15);
  assert.deepEqual(raw.issues.map(i => i.identifier), ['CRM-1', 'CRM-2']);
  assert.equal(raw.issues[0].relations.nodes.length, 19);
  assert.equal(sent.length, 4);
  const refetch = sent.filter(isRefetch);
  assert.equal(refetch.length, 1);
  assert.equal(refetch[0].body.variables.id, 'id-CRM-1');
  const q = refetch[0].body.query.replace(/\s+/g, ' ');
  assert.match(q, /relations\(first: 100, includeArchived: true\) \{ nodes \{ id type relatedIssue \{ identifier archivedAt state \{ type \} \} \} \}/);
  assert.match(q, /inverseRelations\(first: 100, includeArchived: true\) \{ nodes \{ id type issue \{ identifier archivedAt state \{ type \} \} \} \}/);
  assert.deepEqual(raw.warnings, []);
});

test('a card under 15 relations is not re-read', async () => {
  const { sent, fetchImpl } = fakeLinear({ issues: [node({ relations: rels(14), inverseRelations: inverse(14) })] });
  const raw = await fetchProjectMap('c0ffee000001', KEY, { fetchImpl });
  assert.equal(sent.filter(isRefetch).length, 0);
  assert.equal(sent.length, 2);
  assert.equal(raw.issues[0].relations.nodes.length, 14);
});

test('a card capped at 15 inverse relations is re-read too', async () => {
  const { sent, fetchImpl } = fakeLinear({
    issues: [node({ identifier: 'CRM-1', inverseRelations: inverse(15) })],
    full: { 'id-CRM-1': { relations: rels(0), inverseRelations: inverse(22) } },
  });
  const raw = await fetchProjectMap('c0ffee000001', KEY, { fetchImpl });
  assert.equal(sent.filter(isRefetch).length, 1);
  assert.equal(raw.issues[0].inverseRelations.nodes.length, 22);
});

test('a re-read that still returns 100 relations is a truncation warning naming the card', async () => {
  const { fetchImpl } = fakeLinear({
    issues: [node({ identifier: 'CRM-1', relations: rels(15), inverseRelations: inverse(15) })],
    full: { 'id-CRM-1': { relations: rels(RELATIONS_MAX), inverseRelations: inverse(RELATIONS_MAX) } },
  });
  const raw = await fetchProjectMap('c0ffee000001', KEY, { fetchImpl });
  assert.equal(RELATIONS_MAX, 100);
  assert.deepEqual(raw.warnings.map(w => [w.key, w.kind]), [
    ['CRM-1', 'relations-truncated'],
    ['CRM-1', 'inverse-relations-truncated'],
  ]);
  for (const w of raw.warnings) {
    assert.match(w.message, /^CRM-1: 100 (relations|inverseRelations) returned; blocks may be missing$/);
  }
});

test('a re-read returning 99 relations is complete and warns nothing', async () => {
  const { fetchImpl } = fakeLinear({
    issues: [node({ identifier: 'CRM-1', relations: rels(15), inverseRelations: inverse(15) })],
    full: { 'id-CRM-1': { relations: rels(99), inverseRelations: inverse(99) } },
  });
  const raw = await fetchProjectMap('c0ffee000001', KEY, { fetchImpl });
  assert.deepEqual(raw.warnings, []);
  assert.equal(raw.issues[0].relations.nodes.length, 99);
});

const SENTINEL = 'lin_api_SENTINEL_' + 'q7'.repeat(16);
const leaks = (message, key) => {
  for (let i = 0; i + 8 <= key.length; i++) if (message.includes(key.slice(i, i + 8))) return true;
  return false;
};
const reply = (status, statusText, json) => async () => ({ ok: status >= 200 && status < 300, status, statusText, json: async () => json });
const failure = async run => {
  try { await run(); } catch (e) { return e; }
  assert.fail('expected a rejection');
};

test('a missing key fails in plain English before any request', async () => {
  for (const apiKey of ['', undefined, null]) {
    const { sent, fetchImpl } = fakeLinear();
    const e = await failure(() => fetchProjectMap('c0ffee000001', apiKey, { fetchImpl }));
    assert.equal(e.message, 'Linear API key missing');
    assert.equal(sent.length, 0);
  }
});

test('an HTTP failure names the status', async () => {
  const e = await failure(() => fetchProjectMap('c0ffee000001', SENTINEL, { fetchImpl: reply(401, 'Unauthorized', {}) }));
  assert.equal(e.message, 'Linear HTTP 401 Unauthorized');
});

test('a GraphQL error carries its first message', async () => {
  const e = await failure(() => fetchProjectMap('c0ffee000001', SENTINEL, { fetchImpl: reply(200, 'OK', { errors: [{ message: 'x' }, { message: 'y' }] }) }));
  assert.equal(e.message, 'Linear: x');
});

test('an unresolved project names the ref and says to pass a URL or slug', async () => {
  const e = await failure(() => fetchProjectMap('P-ABC-12', SENTINEL, { fetchImpl: reply(200, 'OK', { data: { project: null } }) }));
  assert.equal(e.message, "Linear did not resolve project 'P-ABC-12'; pass its URL or slug");
});

test('a network failure is a plain-English Linear error', async () => {
  const fetchImpl = async () => { throw new TypeError('fetch failed'); };
  const e = await failure(() => fetchProjectMap('c0ffee000001', SENTINEL, { fetchImpl }));
  assert.equal(e.message, 'Linear request failed: fetch failed');
});

const timeoutReason = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');
const hangUntilAborted = signal => new Promise((_, reject) => {
  if (!signal) return reject(new Error('request sent without an abort signal'));
  const guard = setTimeout(() => reject(new Error('the request was never aborted')), 2000);
  signal.addEventListener('abort', () => { clearTimeout(guard); reject(signal.reason); }, { once: true });
});

test('every request, refetches included, carries its own timeout signal; the default is 30 seconds', async () => {
  assert.equal(REQUEST_TIMEOUT_MS, 30_000);
  const { sent, fetchImpl } = fakeLinear();
  await fetchProjectMap('c0ffee000001', KEY, { fetchImpl });
  assert.ok(sent.some(isRefetch), 'the fixture should trigger a refetch');
  for (const { init } of sent) {
    assert.ok(init.signal instanceof AbortSignal, 'request sent without an abort signal');
    assert.equal(init.signal.aborted, false);
  }
  assert.equal(new Set(sent.map(s => s.init.signal)).size, sent.length);
});

test('a request that never answers is cut at the timeout with a plain-English, redacted error', async () => {
  const fetchImpl = (url, init) => hangUntilAborted(init.signal);
  const started = Date.now();
  const e = await failure(() => fetchProjectMap('c0ffee000001', SENTINEL, { fetchImpl, timeoutMs: 20 }));
  assert.equal(e.message, 'Linear request timed out after 0.02s');
  assert.ok(Date.now() - started < 1500);
  assert.equal(leaks(e.message, SENTINEL), false);
  assert.equal(leaks(String(e.stack), SENTINEL), false);
});

test('a response body that never arrives is cut at the timeout too', async () => {
  const fetchImpl = async (url, init) => ({ ok: true, status: 200, statusText: 'OK', json: () => hangUntilAborted(init.signal) });
  const e = await failure(() => fetchProjectMap('c0ffee000001', SENTINEL, { fetchImpl, timeoutMs: 20 }));
  assert.equal(e.message, 'Linear request timed out after 0.02s');
});

test('at the default timeout the error says 30s', async () => {
  const fetchImpl = async () => { throw timeoutReason(); };
  const e = await failure(() => fetchProjectMap('c0ffee000001', SENTINEL, { fetchImpl }));
  assert.equal(e.message, 'Linear request timed out after 30s');
});

test('no error message carries the key or any 8-character piece of it', async () => {
  const cases = [
    reply(401, 'Unauthorized', {}),
    reply(500, 'Internal Server Error', {}),
    reply(200, 'OK', { errors: [{ message: 'Authentication required' }] }),
    reply(200, 'OK', { data: { project: null } }),
    async () => { throw new TypeError('fetch failed'); },
  ];
  for (const fetchImpl of cases) {
    const e = await failure(() => fetchProjectMap('c0ffee000001', SENTINEL, { fetchImpl }));
    assert.equal(leaks(e.message, SENTINEL), false, e.message);
    assert.equal(leaks(String(e.stack), SENTINEL), false);
  }
});

test('Linear text that echoes the key is redacted and keeps its message shape', async () => {
  const echo = `bad key ${SENTINEL} or ${SENTINEL.slice(5, 19)} rejected`;
  const cases = [
    [reply(200, 'OK', { errors: [{ message: echo }] }), /^Linear: bad key .+ or .+ rejected$/],
    [reply(401, echo, {}), /^Linear HTTP 401 bad key .+ or .+ rejected$/],
    [async () => { throw new TypeError(echo); }, /^Linear request failed: bad key .+ or .+ rejected$/],
  ];
  for (const [fetchImpl, shape] of cases) {
    const e = await failure(() => fetchProjectMap('c0ffee000001', SENTINEL, { fetchImpl }));
    assert.match(e.message, shape);
    assert.equal(leaks(e.message, SENTINEL), false, e.message);
    assert.equal(leaks(String(e.stack), SENTINEL), false);
  }
});

test('the project slug comes off the end of its Linear URL', () => {
  assert.equal(projectSlugFromUrl('https://linear.app/example/project/sample-project-2024-c0ffee000001'), 'c0ffee000001');
  assert.equal(projectSlugFromUrl('https://linear.app/example/project/second-project-v2-0ddba11c0de1/overview'), '0ddba11c0de1');
  assert.equal(projectSlugFromUrl(null), null);
  assert.equal(projectSlugFromUrl('https://linear.app/example/issue/ABC-1/x'), null);
});

test('a project ref is read as a URL, slug, UUID or identifier', () => {
  assert.deepEqual(parseProjectRef('https://linear.app/example/project/sample-project-2024-c0ffee000001'),
    { ref: 'c0ffee000001', kind: 'url' });
  assert.deepEqual(parseProjectRef('https://linear.app/example/project/second-project-v2-0ddba11c0de1/overview'),
    { ref: '0ddba11c0de1', kind: 'url' });
  assert.deepEqual(parseProjectRef('c0ffee000001'), { ref: 'c0ffee000001', kind: 'slug' });
  assert.deepEqual(parseProjectRef('  C0FFEE000001 '), { ref: 'C0FFEE000001', kind: 'slug' });
  assert.deepEqual(parseProjectRef('5b1f6c0e-2a8d-4c3e-9f7a-1d2e3f4a5b6c'), { ref: '5b1f6c0e-2a8d-4c3e-9f7a-1d2e3f4a5b6c', kind: 'uuid' });
  assert.deepEqual(parseProjectRef('P-ABC-12'), { ref: 'P-ABC-12', kind: 'identifier' });
  assert.deepEqual(parseProjectRef('p-abc-12'), { ref: 'p-abc-12', kind: 'identifier' });
});

test('anything else is not a project ref', () => {
  for (const arg of [undefined, null, '', '   ', 'garbage', 'ABC-12', 'c0ffee00000', 'https://linear.app/example/issue/ABC-1/x', 'https://example.com/']) {
    assert.equal(parseProjectRef(arg), null, String(arg));
  }
});

const withKeyFile = (content, check) => {
  const dir = mkdtempSync(join(tmpdir(), 'keiron-sequencer-key-'));
  const file = join(dir, 'linear.key');
  if (content !== null) writeFileSync(file, content);
  try { return check(file); } finally { rmSync(dir, { recursive: true, force: true }); }
};
const FROM_ENV = 'lin_api_dummy_env_' + 'e'.repeat(30);
const FROM_FILE = 'lin_api_dummy_file_' + 'f'.repeat(30);

test('the default key file is the planner key under the home directory', () => {
  assert.equal(PLANNER_KEY_FILE, join(homedir(), '.config', 'keiron-planner', 'linear.key'));
  assert.match(SOURCE, /export function readLinearKey\(env = process\.env, keyFile = PLANNER_KEY_FILE\)/);
});

test('the env key wins over the key file', () => {
  withKeyFile(`${FROM_FILE}\n`, file => {
    assert.deepEqual(readLinearKey({ LINEAR_API_KEY: `  ${FROM_ENV}  ` }, file), { key: FROM_ENV, reason: null });
  });
});

test('a blank env key falls back to the first line of the key file, trimmed', () => {
  withKeyFile(`  ${FROM_FILE}  \nsecond line\n`, file => {
    assert.deepEqual(readLinearKey({}, file), { key: FROM_FILE, reason: null });
    assert.deepEqual(readLinearKey({ LINEAR_API_KEY: '   ' }, file), { key: FROM_FILE, reason: null });
  });
});

test('no env key and no key file is a reason naming both places', () => {
  withKeyFile(null, file => {
    assert.deepEqual(readLinearKey({}, file), { key: null, reason: `no Linear key: set LINEAR_API_KEY or put it in ${file}` });
  });
  const realHome = process.env.HOME;
  const fakeHome = mkdtempSync(join(tmpdir(), 'keiron-sequencer-home-'));
  try {
    process.env.HOME = fakeHome;
    assert.equal(readLinearKey({ LINEAR_API_KEY: '' }, join(fakeHome, 'no-such-dir', 'linear.key')).reason,
      'no Linear key: set LINEAR_API_KEY or put it in ~/no-such-dir/linear.key');
  } finally {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('a placeholder or too-short key is rejected with an English reason that omits the key', () => {
  withKeyFile(null, file => {
    const placeholder = readLinearKey({ LINEAR_API_KEY: 'lin_api_...' }, file);
    assert.deepEqual(placeholder, { key: null, reason: 'the Linear key is still the placeholder' });
    const short = readLinearKey({ LINEAR_API_KEY: 'lin_api_abc' }, file);
    assert.deepEqual(short, { key: null, reason: 'the Linear key looks too short (11 chars)' });
  });
  withKeyFile('lin_api_...\n', file => {
    assert.equal(readLinearKey({}, file).reason, 'the Linear key is still the placeholder');
  });
});

test('the fetch module never writes a file', () => {
  assert.doesNotMatch(SOURCE, /writeFile|appendFile|mkdir|createWriteStream|copyFile|rename|unlink|rmSync/);
});

test('relation and inverse-relation nodes carry the relation id, on the issue pages and on a re-read', async () => {
  const { fetchImpl } = fakeLinearStore({ issues: [
    node({ identifier: 'CRM-1', relations: { nodes: [{ id: 'r1', type: 'blocks', relatedIssue: { identifier: 'CRM-2' } }] } }),
    node({ identifier: 'CRM-2' }),
  ] });
  const raw = await fetchProjectMap('c0ffee000001', KEY, { fetchImpl });
  assert.deepEqual(raw.issues[0].relations.nodes.map(r => [r.id, r.relatedIssue.identifier]), [['r1', 'CRM-2']]);
  assert.deepEqual(raw.issues[1].inverseRelations.nodes.map(r => [r.id, r.issue.identifier]), [['r1', 'CRM-1']]);

  const capped = fakeLinearStore({ issues: [node({ identifier: 'CRM-1', relations: rels(16) })] });
  const reread = await fetchProjectMap('c0ffee000001', KEY, { fetchImpl: capped.fetchImpl });
  assert.equal(capped.sent.filter(isRefetch).length, 1);
  assert.equal(reread.issues[0].relations.nodes.length, 16);
  assert.ok(reread.issues[0].relations.nodes.every(r => /^rel-\d+$/.test(r.id)));
});

test('the project carries its teams, and the milestones are asked for with their ids', async () => {
  const { fetchImpl, sent } = fakeLinearStore({
    issues: [node()],
    milestones: [{ id: 'm1', name: 'M', sortOrder: 1 }],
    teams: [{ id: 'team-crm', key: 'CRM' }],
  });
  const raw = await fetchProjectMap('c0ffee000001', KEY, { fetchImpl });
  assert.deepEqual(raw.project.teams, [{ id: 'team-crm', key: 'CRM' }]);
  assert.deepEqual(raw.milestones, [{ id: 'm1', name: 'M', sortOrder: 1 }]);
  const q = sent[0].body.query.replace(/\s+/g, ' ');
  assert.ok(q.includes('teams(first: 10) { nodes { id key } }'), q);
  assert.ok(q.includes('projectMilestones(first: 50) { nodes { id name sortOrder targetDate } }'), q);
});

test('a due date and a milestone target date reach the raw result verbatim', async () => {
  const { fetchImpl } = fakeLinearStore({
    issues: [node({ dueDate: '2026-11-20' })],
    milestones: [{ id: 'm1', name: 'M', sortOrder: 1, targetDate: '2026-12-01' }],
  });
  const raw = await fetchProjectMap(FIXTURE_SLUG, KEY, { fetchImpl });
  assert.equal(raw.issues[0].dueDate, '2026-11-20');
  assert.deepEqual(raw.milestones, [{ id: 'm1', name: 'M', sortOrder: 1, targetDate: '2026-12-01' }]);
});

test('a payload without the new fields still maps: no teams is an empty list and nodes without ids are kept', async () => {
  const { fetchImpl } = fakeLinear({ issues: [node({ relations: rels(2) })], milestones: [{ name: 'M', sortOrder: 1 }] });
  const raw = await fetchProjectMap('c0ffee000001', KEY, { fetchImpl });
  assert.deepEqual(raw.project.teams, []);
  assert.deepEqual(raw.milestones, [{ name: 'M', sortOrder: 1 }]);
  assert.equal(raw.issues[0].relations.nodes.length, 2);
  assert.equal(raw.issues[0].relations.nodes[0].id, undefined);
});

test('the description and issue-state reads are mutation-free too', async () => {
  const { fetchImpl, sent } = fakeLinearStore({ issues: [node({ identifier: 'CRM-1' })] });
  await fetchProjectMap('c0ffee000001', KEY, { fetchImpl });
  await fetchDescriptions('project-uuid', KEY, { fetchImpl });
  await fetchIssueState('id-CRM-1', KEY, { fetchImpl });
  assert.equal(sent.length, 4);
  for (const { body } of sent) assert.doesNotMatch(body.query, /\bmutation\b/i);
});

test('the issues query asks for the branch name under the gitBranchName alias', async () => {
  const { sent, fetchImpl } = fakeLinear({ issues: [node()] });
  await fetchProjectMap('c0ffee000001', KEY, { fetchImpl });
  const q = sent.find(s => /issues\(/.test(s.body.query)).body.query.replace(/\s+/g, ' ');
  assert.ok(q.includes('gitBranchName: branchName'), q);
});

test('a branch name on the issue node reaches the raw issue and the card verbatim', async () => {
  const name = 'User/ABC-1-Mixed_Case.title';
  const { fetchImpl } = fakeLinear({ issues: [node({ identifier: 'CRM-1', gitBranchName: name })] });
  const raw = await fetchProjectMap('c0ffee000001', KEY, { fetchImpl });
  assert.equal(raw.issues[0].gitBranchName, name);
  assert.equal(buildCardMap(raw).cards[0].gitBranchName, name);
});

test('an issue node without a branch name maps to a null card branch name', async () => {
  const { fetchImpl } = fakeLinear({ issues: [node({ identifier: 'CRM-1' }), node({ identifier: 'CRM-2', gitBranchName: null })] });
  const raw = await fetchProjectMap('c0ffee000001', KEY, { fetchImpl });
  assert.deepEqual(buildCardMap(raw).cards.map(c => c.gitBranchName), [null, null]);
});

test('adding the branch name leaves the read count and the mutation-free bodies as they were, and the key out of the result', async () => {
  const issues = [node({ identifier: 'CRM-1', gitBranchName: 'a/crm-1' }), node({ identifier: 'CRM-2' })];
  const { sent, fetchImpl } = fakeLinear({ issues, page: 1 });
  const raw = await fetchProjectMap('c0ffee000001', SENTINEL, { fetchImpl });
  assert.equal(sent.length, 1 + issues.length);
  for (const { body } of sent) assert.doesNotMatch(body.query, /\bmutation\b/i);
  assert.equal(leaks(JSON.stringify(raw), SENTINEL), false);
});

const startStore = (over = {}, store = {}) => fakeLinearStore({
  issues: [node({
    identifier: 'CRM-1', url: 'https://linear.app/x/issue/CRM-1', description: 'Do it.', gitBranchName: 'u/crm-1-card',
    state: { name: 'Todo', type: 'unstarted' }, projectMilestone: { name: 'M1' }, ...over,
  })],
  ...store,
});

test('the card read returns the description, state, team, project, milestone and archivedAt', async () => {
  const { fetchImpl } = startStore({ archivedAt: '2026-11-02T00:00:00.000Z' });
  const card = await fetchStartIssue('CRM-1', KEY, { fetchImpl });
  assert.deepEqual(card, {
    id: 'id-CRM-1', key: 'CRM-1', title: 'Card', url: 'https://linear.app/x/issue/CRM-1', description: 'Do it.',
    archivedAt: '2026-11-02T00:00:00.000Z', state: { name: 'Todo', type: 'unstarted' }, gitBranchName: 'u/crm-1-card',
    team: { id: 'team-crm', key: 'CRM' },
    project: { id: 'project-uuid', slugId: FIXTURE_SLUG, name: FIXTURE_NAME, url: FIXTURE_URL },
    milestone: 'M1', attachments: [], comments: [], commentsTruncated: false,
  });
});

test('the card read asks for every field it returns, in one mutation-free query', async () => {
  const { fetchImpl, sent } = startStore();
  await fetchStartIssue('CRM-1', KEY, { fetchImpl });
  assert.equal(sent.length, 1);
  const q = sent[0].body.query.replace(/\s+/g, ' ');
  assert.match(q, /^ ?query StartIssue\(\$id: String!\)/);
  assert.doesNotMatch(q, /\bmutation\b/i);
  assert.deepEqual(sent[0].body.variables, { id: 'CRM-1' });
  for (const field of [
    'id identifier title url description archivedAt', 'gitBranchName: branchName', 'state { name type }', 'team { id key }',
    'project { id slugId name url }', 'projectMilestone { name }', 'attachments(first: 50) { nodes { url } }',
    'comments(first: 50) { pageInfo { hasNextPage } nodes { body createdAt } }',
  ]) assert.ok(q.includes(field), `missing ${field}`);
});

test('comments come back oldest first, with their body and date', async () => {
  const comments = [
    { body: 'second', createdAt: '2026-11-03T00:00:00.000Z' },
    { body: 'third', createdAt: '2026-11-04T00:00:00.000Z' },
    { body: 'first', createdAt: '2026-11-01T00:00:00.000Z' },
  ];
  const { fetchImpl } = startStore({ comments });
  const card = await fetchStartIssue('CRM-1', KEY, { fetchImpl });
  assert.deepEqual(card.comments.map(c => c.body), ['first', 'second', 'third']);
  assert.deepEqual(card.comments[0], { createdAt: '2026-11-01T00:00:00.000Z', body: 'first' });
  assert.equal(card.commentsTruncated, false);
});

test('more than 50 comments sets commentsTruncated', async () => {
  const comments = Array.from({ length: 51 }, (_, i) => ({ body: `c${i}`, createdAt: `2026-11-01T00:00:${String(i).padStart(2, '0')}.000Z` }));
  const { fetchImpl } = startStore({ comments });
  const card = await fetchStartIssue('CRM-1', KEY, { fetchImpl });
  assert.equal(card.comments.length, 50);
  assert.equal(card.commentsTruncated, true);
});

test('attachments keep only GitHub pull request URLs', async () => {
  const attachments = [
    { url: 'https://github.com/acme/app/pull/12' },
    { url: 'https://github.com/acme/app/issues/3' },
    { url: 'https://example.com/doc' },
    { url: 'https://github.com/acme/web/pull/7/files' },
  ];
  const { fetchImpl } = startStore({ attachments });
  const card = await fetchStartIssue('CRM-1', KEY, { fetchImpl });
  assert.deepEqual(card.attachments, ['https://github.com/acme/app/pull/12', 'https://github.com/acme/web/pull/7/files']);
});

test('a card with no team, project, milestone or branch name maps those to null', async () => {
  const fetchImpl = reply(200, 'OK', { data: { issue: {
    id: 'id-CRM-1', identifier: 'CRM-1', title: 'Card', url: 'u', description: null, archivedAt: null, state: null,
  } } });
  const card = await fetchStartIssue('CRM-1', KEY, { fetchImpl });
  assert.deepEqual(
    [card.description, card.state, card.gitBranchName, card.team, card.project, card.milestone, card.attachments, card.comments, card.commentsTruncated],
    ['', { name: null, type: null }, null, null, null, null, [], [], false],
  );
});

test('a card Linear does not return is null', async () => {
  const { fetchImpl } = startStore();
  assert.equal(await fetchStartIssue('CRM-404', KEY, { fetchImpl }), null);
});

test('a card read that echoes the key is redacted, and a hanging one times out in plain English', async () => {
  const echo = reply(200, 'OK', { errors: [{ message: `bad key ${SENTINEL}` }] });
  const e = await failure(() => fetchStartIssue('CRM-1', SENTINEL, { fetchImpl: echo }));
  assert.match(e.message, /^Linear: bad key /);
  assert.equal(leaks(e.message, SENTINEL), false);
  const hang = (url, init) => hangUntilAborted(init.signal);
  const t = await failure(() => fetchStartIssue('CRM-1', SENTINEL, { fetchImpl: hang, timeoutMs: 20 }));
  assert.equal(t.message, 'Linear request timed out after 0.02s');
});

const TEAM_STATES = [
  { id: 's-backlog', name: 'Backlog', type: 'backlog' },
  { id: 's-todo', name: 'Todo', type: 'unstarted' },
  { id: 's-progress', name: 'In Progress', type: 'started' },
  { id: 's-done', name: 'Done', type: 'completed' },
];
const statesStore = () => fakeLinearStore({
  issues: [node({ identifier: 'CRM-1', state: { id: 's-todo', name: 'Todo', type: 'unstarted' } })],
  teams: [{ id: 'team-crm', key: 'CRM', states: TEAM_STATES }],
});

test('the team-state read returns the card state and every state of its team', async () => {
  const { fetchImpl } = statesStore();
  assert.deepEqual(await fetchIssueTeamStates('CRM-1', KEY, { fetchImpl }), {
    id: 'id-CRM-1', identifier: 'CRM-1', state: { id: 's-todo', name: 'Todo', type: 'unstarted' },
    team: { id: 'team-crm', key: 'CRM', states: TEAM_STATES },
  });
});

test('the team-state read is one named, mutation-free query asking for up to 100 states', async () => {
  const { fetchImpl, sent } = statesStore();
  await fetchIssueTeamStates('CRM-1', KEY, { fetchImpl });
  assert.equal(sent.length, 1);
  const q = sent[0].body.query.replace(/\s+/g, ' ');
  assert.match(q, /^ ?query IssueTeamStates\(\$id: String!\)/);
  assert.doesNotMatch(q, /\bmutation\b/i);
  assert.deepEqual(sent[0].body.variables, { id: 'CRM-1' });
  for (const field of ['id identifier state { id name type }', 'team { id key states(first: 100) { nodes { id name type } } }'])
    assert.ok(q.includes(field), `missing ${field}`);
});

test('the team-state read is null for a card Linear does not return, and a team without states maps to an empty list', async () => {
  const { fetchImpl } = statesStore();
  assert.equal(await fetchIssueTeamStates('CRM-404', KEY, { fetchImpl }), null);
  const bare = reply(200, 'OK', { data: { issue: { id: 'id-CRM-1', identifier: 'CRM-1', state: null, team: { id: 't', key: 'T' } } } });
  const r = await fetchIssueTeamStates('CRM-1', KEY, { fetchImpl: bare });
  assert.deepEqual([r.state, r.team], [null, { id: 't', key: 'T', states: [] }]);
});

test('the team states stay out of the project read', async () => {
  const { fetchImpl } = statesStore();
  const raw = await fetchProjectMap('c0ffee000001', KEY, { fetchImpl });
  assert.deepEqual(raw.project.teams, [{ id: 'team-crm', key: 'CRM' }]);
});

test('a card Linear answers with "Entity not found" reads as missing; other GraphQL errors still throw', async () => {
  assert.equal(await fetchStartIssue('CRM-404', KEY, { fetchImpl: reply(200, 'OK', { errors: [{ message: 'Entity not found: Issue' }] }) }), null);
  await assert.rejects(fetchStartIssue('CRM-1', KEY, { fetchImpl: reply(200, 'OK', { errors: [{ message: 'Authentication required' }] }) }), /^Error: Linear: Authentication required$/);
});

test('fetchViewer returns the owner of the key, in one Viewer query', async () => {
  const { fetchImpl, sent } = fakeLinearStore({ viewer: { id: 'u-7', name: 'Cris' } });
  assert.deepEqual(await fetchViewer(KEY, { fetchImpl }), { id: 'u-7', name: 'Cris' });
  assert.equal(sent.length, 1);
  assert.match(sent[0].body.query, /query Viewer\b[\s\S]*viewer \{ id name \}/);
});

test('fetchOffMapIssue returns labels, state and pull attachments, and null when Linear has no such card', async () => {
  const { fetchImpl } = startStore({
    description: 'QA de CRM-9', labels: { nodes: [{ name: 'QA' }] },
    attachments: [{ url: 'https://github.com/acme/app/pull/3' }, { url: 'https://example.com/x' }],
  });
  assert.deepEqual(await fetchOffMapIssue('CRM-1', KEY, { fetchImpl }), {
    key: 'CRM-1', title: 'Card', description: 'QA de CRM-9', archivedAt: null,
    state: { name: 'Todo', type: 'unstarted' }, labels: ['QA'], attachments: ['https://github.com/acme/app/pull/3'],
  });
  assert.equal(await fetchOffMapIssue('CRM-404', KEY, { fetchImpl }), null);
});

test('the project map asks for each card\'s attachments', async () => {
  const { fetchImpl, sent } = fakeLinear({ issues: [node()], page: 60 });
  await fetchProjectMap('c0ffee000001', KEY, { fetchImpl });
  const q = sent.map(s => s.body.query.replace(/\s+/g, ' ')).find(x => x.includes('issues(filter'));
  assert.ok(q.includes('attachments(first: 50) { nodes { url } }'), q);
});
