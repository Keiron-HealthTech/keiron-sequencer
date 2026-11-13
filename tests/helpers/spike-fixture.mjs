import { after } from 'node:test';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { run } from '../../scripts/spike.mjs';
import { gitRunner } from '../../scripts/lib/spike/exec.mjs';
import { activeRuns } from '../../scripts/lib/spike/state.mjs';
import { fakeLinear } from './fake-linear.mjs';
import { fakeGh, fakeSetup, makeRepo, SANDBOX_ENV, tempDir } from './git-sandbox.mjs';

export const SLUG = 'abc123def456';
export const PROJECT_URL = `https://linear.app/x/project/tracer-${SLUG}`;
export const SENTINEL = 'lin_api_SENTINEL_' + 's'.repeat(30);
const BASIC = new URL('../fixtures/spike/transcripts/basic.jsonl', import.meta.url);

export const walk = dir => (existsSync(dir)
  ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => relative(dir, join(e.parentPath, e.name))).sort()
  : []);

export const issue = (identifier, over = {}) => ({
  identifier, title: `Card ${identifier}`, url: `https://linear.app/x/issue/${identifier}`, description: `Do ${identifier}.`,
  estimate: null, archivedAt: null, state: { name: 'Todo', type: 'unstarted' }, projectMilestone: null,
  labels: { nodes: [] }, relations: { nodes: [] }, inverseRelations: { nodes: [] }, ...over,
});

// A fake assistant message whose weighted cost is w (input tokens only).
export const usageEntry = (id, timestamp, w = 1) => ({
  type: 'assistant', timestamp,
  message: { id, usage: { input_tokens: w, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } },
});

// What Claude Code logs after a CLI call: its stdout, mark included, as a tool result.
export const toolResult = (stdout, timestamp) => ({
  type: 'user', timestamp, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fake', content: stdout }] },
});

// The file's mtime follows the fake clock, since binding only looks at transcripts touched since the mark.
export function appendTranscript(file, entries, mtime = entries.at(-1).timestamp) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, entries.map(e => `${JSON.stringify(e)}\n`).join(''));
  const t = new Date(mtime);
  utimesSync(file, t, t);
  return file;
}

export const blocks = (...keys) => ({ nodes: keys.map(k => ({ type: 'blocks', relatedIssue: { identifier: k } })) });

export const card = issue('CRM-1', { title: 'Add the feature', description: 'Do the thing.' });

export const notes = {
  cases: [1, 2, 3].map(i => ({
    given: `a project with the feature, case ${i}`, when: 'the user opens it', then: 'the feature answers', source: 'linear', ref: 'linear:CRM-1',
  })),
  decisions: [],
  findings: [],
  openDecisions: [],
  piiInLogs: [],
  scope: { complete: true, note: null },
  engram: [],
};

export function spikeFixture({ issues = [card], milestones = [], gh: ghRespond, config: overConfig } = {}) {
  const repo = makeRepo();
  const home = tempDir('keiron-sequencer-tracer-home-');
  const dataDir = tempDir('keiron-sequencer-tracer-data-');
  const scratch = tempDir('keiron-sequencer-tracer-scratch-');
  after(() => {
    repo.dispose();
    for (const dir of [home, dataDir, scratch]) rmSync(dir, { recursive: true, force: true });
  });
  const config = {
    schemaVersion: 1,
    repos: {
      backend: { name: 'backend-repo', github: 'acme/backend', checkout: repo.dir, url: null, remote: null, defaultBranch: 'main', setup: [] },
    },
    projects: { [SLUG]: { repos: ['backend'] } },
  };
  writeFileSync(join(home, 'config.json'), JSON.stringify(overConfig ? overConfig(config, repo) : config));
  const keyFile = join(scratch, 'key');
  writeFileSync(keyFile, `${SENTINEL}\n`);
  const sessionFile = join(scratch, 'session.jsonl');
  copyFileSync(BASIC, sessionFile);
  let clock = Date.parse('2026-11-10T10:00:00.000Z');
  const linear = fakeLinear({ issues, milestones, project: { id: 'project-uuid', slugId: SLUG, name: 'Tracer project', url: PROJECT_URL } });
  const gh = fakeGh(ghRespond);
  const setupCommands = fakeSetup();
  const transcripts = join(scratch, 'transcripts');
  const sleeps = [];
  const deps = {
    env: {}, fetchImpl: linear.fetchImpl, keyFile, now: () => new Date(clock), home, dataDir, transcripts,
    git: gitRunner({ env: SANDBOX_ENV }), gh: gh.run, runSetup: setupCommands.run, sleep: async ms => { sleeps.push(ms); },
  };
  return { repo, home, dataDir, scratch, sessionFile, transcripts, sleeps, deps, linear, gh, setupCommands, at: iso => { clock = Date.parse(iso); } };
}

export function twoRepoFixture(over = {}) {
  const other = makeRepo();
  after(other.dispose);
  const fixture = spikeFixture({
    ...over,
    config: config => ({
      ...config,
      repos: {
        ...config.repos,
        frontend: { name: 'frontend-repo', github: 'acme/frontend', checkout: other.dir, url: null, remote: null, defaultBranch: 'main', setup: [] },
      },
      projects: { [SLUG]: { repos: ['backend', 'frontend'] } },
    }),
  });
  return { ...fixture, other };
}

const later = (date, ms) => new Date(date.getTime() + ms).toISOString();

// Runs one CLI command; with a session, its output is logged there a second later, as Claude Code would.
export async function call(fixture, argv, { session } = {}) {
  const r = await run(argv, fixture.deps);
  if (session) appendTranscript(session, [toolResult(r.stdout, later(fixture.deps.now(), 1000))]);
  return r;
}

export const activeRunDir = home => activeRuns(home)[0].dir;

// next, then one file written in the backend tree and the notes, then end. Each w is one assistant message logged
// inside the window; settle: false leaves no line after the end, so the window cannot settle yet.
export async function playCard(fixture, card, { start, end, session, w = [], settle = true, cardNotes = notes } = {}) {
  fixture.at(start);
  const brief = await call(fixture, ['next'], { session });
  const out = JSON.parse(brief.stdout || 'null');
  if (brief.code !== 0 || out.action !== 'card') return { brief, out };
  if (session && w.length) {
    appendTranscript(session, w.map((cost, i) => usageEntry(`${card}-${start}-${i}`, later(new Date(start), 2000 + i * 1000), cost)));
  }
  const tree = JSON.parse((await run(['tree', 'backend'], fixture.deps)).stdout).path;
  writeFileSync(join(tree, `${card}.txt`), `${card}\n`);
  const dir = activeRunDir(fixture.home);
  mkdirSync(join(dir, 'notes'), { recursive: true });
  writeFileSync(join(dir, 'notes', `${card}.json`), JSON.stringify(cardNotes));
  fixture.at(end);
  const ended = await call(fixture, ['end', card], { session: settle ? session : null });
  return { brief, out, ended, dir };
}
