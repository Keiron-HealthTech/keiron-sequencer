import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../scripts/spike.mjs';
import { readState, saveState } from '../scripts/lib/spike/state.mjs';
import { bindSession, sessionFiles, transcriptsRoot, weighted, windowUsage, WEIGHTS } from '../scripts/lib/spike/usage-window.mjs';
import { tempDir } from './helpers/git-sandbox.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import { appendTranscript, card, issue, notes, PROJECT_URL, SLUG, spikeFixture, toolResult, usageEntry } from './helpers/spike-fixture.mjs';

guardNetwork();

const DIR = tempDir('keiron-sequencer-usage-');
after(() => rmSync(DIR, { recursive: true, force: true }));

const usageLine = (id, timestamp, output = 1) => JSON.stringify({
  type: 'assistant', timestamp, message: { id, usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: output } },
});
const file = (name, lines) => {
  const path = join(DIR, name);
  writeFileSync(path, `${lines.join('\n')}\n`);
  return path;
};

const START = '2026-11-10T10:00:00.000Z';
const END = '2026-11-10T10:05:00.000Z';

test('the window is (start, end] by default and [start, end] with startInclusive; an entry exactly at end belongs to it', async () => {
  const f = file('bounds.jsonl', [usageLine('at-start', START), usageLine('inside', '2026-11-10T10:02:00.000Z'), usageLine('at-end', END)]);
  const open = await windowUsage({ files: [f], start: START, end: END });
  assert.equal(open.messages, 2);
  const closed = await windowUsage({ files: [f], start: START, end: END, startInclusive: true });
  assert.equal(closed.messages, 3);
});

test('a window is settled only once some transcript line is dated after its end', async () => {
  const unsettled = file('unsettled.jsonl', [usageLine('a', '2026-11-10T10:01:00.000Z'), usageLine('b', END)]);
  assert.equal((await windowUsage({ files: [unsettled], start: START, end: END })).settled, false);
  const userLine = JSON.stringify({ type: 'user', timestamp: '2026-11-10T10:05:01.000Z', message: { role: 'user' } });
  const settled = file('settled.jsonl', [usageLine('a', '2026-11-10T10:01:00.000Z'), userLine]);
  const usage = await windowUsage({ files: [settled], start: START, end: END });
  assert.equal(usage.settled, true);
  assert.equal(usage.messages, 1);
});

test('a message logged three times under one id counts once, at the max of each counter', async () => {
  const line = (output, cacheRead, timestamp) => JSON.stringify({
    type: 'assistant', timestamp, message: { id: 'same', usage: { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: cacheRead, output_tokens: output } },
  });
  const f = file('dedupe.jsonl', [
    line(1, 300, '2026-11-10T10:01:00.000Z'), line(9, 100, '2026-11-10T10:01:01.000Z'), line(4, 200, '2026-11-10T10:01:02.000Z'),
  ]);
  const usage = await windowUsage({ files: [f], start: START, end: END });
  assert.equal(usage.messages, 1);
  assert.deepEqual(usage.tokens, { input: 5, cacheCreation: 0, cacheRead: 300, output: 9, thinking: 0 });
});

test('a message belongs to the window of its first line, even when later lines of it fall outside', async () => {
  const f = file('dating.jsonl', [
    usageLine('early', '2026-11-10T09:59:00.000Z', 3), usageLine('early', '2026-11-10T10:01:00.000Z', 30),
    usageLine('edge', '2026-11-10T10:04:59.000Z', 4), usageLine('edge', '2026-11-10T10:05:30.000Z', 40),
  ]);
  const usage = await windowUsage({ files: [f], start: START, end: END });
  assert.equal(usage.messages, 1);
  assert.equal(usage.tokens.output, 40);
});

test('a session reads its main transcript and every jsonl under <session>/subagents', async () => {
  const main = fileURLToPath(new URL('./fixtures/spike/transcripts/session-a.jsonl', import.meta.url));
  const files = sessionFiles(main);
  assert.deepEqual(files, [main, join(dirname(main), 'session-a', 'subagents', 'agent-1.jsonl')]);
  assert.deepEqual(sessionFiles(join(DIR, 'no-subagents.jsonl')), [join(DIR, 'no-subagents.jsonl')]);
  const usage = await windowUsage({ files, start: START, end: END });
  assert.equal(usage.messages, 2);
  assert.deepEqual(usage.tokens, { input: 110, cacheCreation: 0, cacheRead: 0, output: 22, thinking: 0 });
  assert.equal(weighted(usage.tokens), 110 + 22 * 5);
});

test('weighted tokens use the fixed weights, thinking at 0', () => {
  assert.deepEqual(WEIGHTS, { input: 1, cacheCreation: 1.25, cacheRead: 0.1, output: 5, thinking: 0 });
  assert.equal(weighted({ input: 10, cacheCreation: 4, cacheRead: 100, output: 2, thinking: 1000 }), 10 + 5 + 10 + 10);
});

test('the transcripts root is $KEIRON_SEQUENCER_TRANSCRIPTS, else $CLAUDE_CONFIG_DIR/projects, else ~/.claude/projects', () => {
  assert.equal(transcriptsRoot({ KEIRON_SEQUENCER_TRANSCRIPTS: '/t', CLAUDE_CONFIG_DIR: '/c' }, '/h'), '/t');
  assert.equal(transcriptsRoot({ CLAUDE_CONFIG_DIR: '/c' }, '/h'), join('/c', 'projects'));
  assert.equal(transcriptsRoot({}, '/h'), join('/h', '.claude', 'projects'));
});

test('bindSession keeps a bound transcript that holds the nonce, else binds the recent main transcript that does', async () => {
  const root = join(DIR, 'root');
  const issuedAt = '2026-11-10T10:00:00.000Z';
  const holding = toolResult('{"mark":"keiron-sequencer-spike:20261110T100000Z:1:abc123abc123"}', '2026-11-10T10:00:01.000Z');
  const bound = appendTranscript(join(DIR, 'elsewhere', 'bound.jsonl'), [holding]);
  assert.deepEqual(await bindSession({ root: join(DIR, 'missing-root'), nonce: 'abc123abc123', issuedAt, bound: [bound] }), { file: bound });

  appendTranscript(join(root, '-old', 'stale.jsonl'), [holding], '2026-11-10T09:59:54.000Z');
  appendTranscript(join(root, '-p', 'other.jsonl'), [usageEntry('x', '2026-11-10T10:00:02.000Z')]);
  assert.equal(await bindSession({ root, nonce: 'abc123abc123', issuedAt, bound: [] }), null);
  const fresh = appendTranscript(join(root, '-p', 's2.jsonl'), [holding], '2026-11-10T09:59:56.000Z');
  assert.deepEqual(await bindSession({ root, nonce: 'abc123abc123', issuedAt, bound: [] }), { file: fresh });
  assert.equal(await bindSession({ root, nonce: 'ffffffffffff', issuedAt, bound: [bound] }), null);
});

test('a mark written in a subagent transcript binds that file', async () => {
  const root = join(DIR, 'sub-root');
  const issuedAt = '2026-11-10T10:00:00.000Z';
  const holding = toolResult('{"mark":"keiron-sequencer-spike:20261110T100000Z:1:def456def456"}', '2026-11-10T10:00:01.000Z');
  const main = appendTranscript(join(root, '-p', 's1.jsonl'), [usageEntry('m', '2026-11-10T10:00:02.000Z')]);
  const worker = appendTranscript(join(root, '-p', 's1', 'subagents', 'agent-1.jsonl'), [holding]);
  appendTranscript(join(root, '-p', 's1', 'subagents', 'agent-2.jsonl'), [usageEntry('y', '2026-11-10T10:00:02.000Z')]);
  assert.deepEqual(await bindSession({ root, nonce: 'def456def456', issuedAt, bound: [] }), { file: worker, subagent: true });
  assert.deepEqual(await bindSession({ root: null, nonce: 'def456def456', issuedAt, bound: [main, worker] }), { file: worker, subagent: true });
  assert.deepEqual(await bindSession({ root, nonce: 'ffffffffffff', issuedAt, bound: [] }), null);
});

const stateOf = (home, runId) => JSON.parse(readFileSync(join(home, SLUG, 'runs', runId, 'run.json'), 'utf8'));

async function workTheCard(fixture, runId) {
  const { deps, home } = fixture;
  const tree = JSON.parse((await run(['tree', 'backend'], deps)).stdout).path;
  writeFileSync(join(tree, 'README.md'), '# sandbox\nspiked\n');
  mkdirSync(join(home, SLUG, 'runs', runId, 'notes'), { recursive: true });
  writeFileSync(join(home, SLUG, 'runs', runId, 'notes', 'CRM-1.json'), JSON.stringify(notes));
}

test('next binds the session whose transcript holds the last mark, and end measures the card from it', async () => {
  const fixture = spikeFixture();
  const { deps, transcripts, home, dataDir, at } = fixture;
  const begun = await run(['begin', PROJECT_URL], deps);
  const { runId } = JSON.parse(begun.stdout);
  const main = appendTranscript(join(transcripts, '-work', 'session-1.jsonl'), [toolResult(begun.stdout, '2026-11-10T10:00:01.000Z')]);

  at('2026-11-10T10:01:00.000Z');
  const brief = await run(['next'], deps);
  assert.equal(brief.code, 0, brief.stderr);
  assert.deepEqual(stateOf(home, runId).executions[0].sessions, [{ file: main, boundAt: '2026-11-10T10:01:00.000Z' }]);
  appendTranscript(main, [
    toolResult(brief.stdout, '2026-11-10T10:01:01.000Z'), usageEntry('m1', '2026-11-10T10:02:00.000Z', 40), usageEntry('m2', '2026-11-10T10:04:00.000Z', 60),
  ]);
  await workTheCard(fixture, runId);

  at('2026-11-10T10:05:00.000Z');
  const ended = await run(['end', 'CRM-1'], deps);
  assert.equal(ended.code, 0, ended.stderr);
  assert.deepEqual(JSON.parse(ended.stdout).usage, { messages: 2, w: 100 });
  const record = JSON.parse(readFileSync(join(dataDir, SLUG, 'CRM-1.json'), 'utf8'));
  assert.equal(record.effort.windows[0].tokens.input, 100);
});

test('after a session switch the rescan binds the new transcript holding the mark and adds it to the execution', async () => {
  const fixture = spikeFixture();
  const { deps, transcripts, home, at } = fixture;
  const begun = await run(['begin', PROJECT_URL], deps);
  const { runId } = JSON.parse(begun.stdout);
  const first = appendTranscript(join(transcripts, '-work', 'session-1.jsonl'), [toolResult(begun.stdout, '2026-11-10T10:00:01.000Z')]);
  at('2026-11-10T10:01:00.000Z');
  const brief = await run(['next'], deps);
  appendTranscript(first, [usageEntry('m1', '2026-11-10T10:01:30.000Z', 40)]);
  const second = appendTranscript(join(transcripts, '-work', 'session-2.jsonl'), [
    toolResult(brief.stdout, '2026-11-10T10:02:00.000Z'), usageEntry('m2', '2026-11-10T10:03:00.000Z', 7),
  ]);
  await workTheCard(fixture, runId);

  at('2026-11-10T10:05:00.000Z');
  const ended = await run(['end', 'CRM-1'], deps);
  assert.equal(ended.code, 0, ended.stderr);
  assert.deepEqual(stateOf(home, runId).executions[0].sessions.map(s => s.file), [first, second]);
  assert.deepEqual(JSON.parse(ended.stdout).usage, { messages: 2, w: 47 });
});

test('after a /clear the card is measured from the old transcript, then the next call binds the new one and settles the window from both', async () => {
  const fixture = spikeFixture({ issues: [card, issue('CRM-2')] });
  const { deps, transcripts, home, dataDir, at } = fixture;
  const begun = await run(['begin', PROJECT_URL], deps);
  const { runId } = JSON.parse(begun.stdout);
  const old = appendTranscript(join(transcripts, '-work', 'session-1.jsonl'), [toolResult(begun.stdout, '2026-11-10T10:00:01.000Z')]);
  at('2026-11-10T10:01:00.000Z');
  const brief = await run(['next'], deps);
  appendTranscript(old, [toolResult(brief.stdout, '2026-11-10T10:01:01.000Z'), usageEntry('m1', '2026-11-10T10:01:30.000Z', 40)]);
  const cleared = appendTranscript(join(transcripts, '-work', 'session-2.jsonl'), [usageEntry('m2', '2026-11-10T10:03:00.000Z', 7)]);
  await workTheCard(fixture, runId);

  at('2026-11-10T10:05:00.000Z');
  const ended = await run(['end', 'CRM-1'], deps);
  assert.equal(ended.code, 0, ended.stderr);
  assert.deepEqual(JSON.parse(ended.stdout).usage, { messages: 1, w: 40 });
  assert.deepEqual(stateOf(home, runId).executions[0].sessions.map(s => s.file), [old]);
  assert.equal(stateOf(home, runId).cards['CRM-1'].windows[0].settled, false);
  appendTranscript(cleared, [toolResult(ended.stdout, '2026-11-10T10:05:01.000Z')]);

  at('2026-11-10T10:06:00.000Z');
  const second = await run(['next'], deps);
  assert.equal(JSON.parse(second.stdout).card, 'CRM-2');
  const state = stateOf(home, runId);
  assert.deepEqual(state.executions[0].sessions.map(s => s.file), [old, cleared]);
  assert.deepEqual([state.cards['CRM-1'].windows[0].settled, state.cards['CRM-1'].windows[0].w], [true, 47]);
  const { effort } = JSON.parse(readFileSync(join(dataDir, SLUG, 'CRM-1.json'), 'utf8'));
  assert.deepEqual([effort.windows[0].messages, effort.windows[0].tokens.input], [2, 47]);
});

test('--session-file overrides discovery, and with nothing bindable the card is unmeasured, never zero', async () => {
  const fixture = spikeFixture();
  const { deps, transcripts, sessionFile, home, at } = fixture;
  const begun = await run(['begin', PROJECT_URL, '--session-file', sessionFile], deps);
  const { runId } = JSON.parse(begun.stdout);
  appendTranscript(join(transcripts, '-work', 'session-1.jsonl'), [toolResult(begun.stdout, '2026-11-10T10:00:01.000Z')]);
  at('2026-11-10T10:01:00.000Z');
  await run(['next'], deps);
  assert.deepEqual(stateOf(home, runId).executions[0].sessions.map(s => s.file), [sessionFile]);

  const other = spikeFixture();
  const again = await run(['begin', PROJECT_URL], other.deps);
  appendTranscript(join(other.transcripts, '-work', 'session-1.jsonl'), [usageEntry('m', '2026-11-10T10:00:02.000Z', 5)]);
  other.at('2026-11-10T10:01:00.000Z');
  await run(['next'], other.deps);
  await workTheCard(other, JSON.parse(again.stdout).runId);
  other.at('2026-11-10T10:05:00.000Z');
  const ended = await run(['end', 'CRM-1'], other.deps);
  assert.equal(ended.code, 0, ended.stderr);
  assert.equal(JSON.parse(ended.stdout).usage, 'unmeasured');
  assert.equal(JSON.parse(readFileSync(join(other.dataDir, SLUG, 'CRM-1.json'), 'utf8')).effort, null);
});

test('two cards in two subagent transcripts are measured on their own files only', async () => {
  const fixture = spikeFixture({ issues: [issue('CRM-1'), issue('CRM-2'), issue('CRM-3')] });
  const { deps, transcripts, home, dataDir, at } = fixture;
  const begun = await run(['begin', PROJECT_URL, '--max-tokens', '46'], deps);
  const dir = join(home, SLUG, 'runs', JSON.parse(begun.stdout).runId);
  const main = appendTranscript(join(transcripts, '-work', 'session-1.jsonl'), [toolResult(begun.stdout, '2026-11-10T10:00:01.000Z')]);
  const workerOf = n => join(transcripts, '-work', 'session-1', 'subagents', `agent-${n}.jsonl`);
  const state = readState(dir);
  state.tracks = { t1: { ...state.tracks.t1, cards: ['CRM-1', 'CRM-3'] }, t2: { ...state.tracks.t1, cards: ['CRM-2'] } };
  saveState(dir, state, deps.now());
  mkdirSync(join(dir, 'notes'), { recursive: true });

  const start = async (cardKey, track, n, when) => {
    at(when);
    const brief = await run(['next', '--track', track], deps);
    assert.equal(JSON.parse(brief.stdout).card, cardKey, brief.stderr);
    appendTranscript(workerOf(n), [toolResult(brief.stdout, new Date(Date.parse(when) + 1000).toISOString())]);
    const tree = JSON.parse((await run(['tree', 'backend', '--track', track], deps)).stdout).path;
    writeFileSync(join(tree, `${cardKey}.txt`), `${cardKey}\n`);
    writeFileSync(join(dir, 'notes', `${cardKey}.json`), JSON.stringify(notes));
  };
  await start('CRM-1', 't1', 1, '2026-11-10T10:01:00.000Z');
  await start('CRM-2', 't2', 2, '2026-11-10T10:02:00.000Z');
  appendTranscript(workerOf(1), [usageEntry('w1', '2026-11-10T10:03:00.000Z', 40)]);
  appendTranscript(workerOf(2), [usageEntry('w2', '2026-11-10T10:03:30.000Z', 7)]);
  appendTranscript(main, [usageEntry('controller', '2026-11-10T10:03:40.000Z', 1000)]);

  at('2026-11-10T10:05:00.000Z');
  const first = await run(['end', 'CRM-1', '--track', 't1'], deps);
  assert.equal(first.code, 0, first.stderr);
  at('2026-11-10T10:06:00.000Z');
  const second = await run(['end', 'CRM-2', '--track', 't2'], deps);
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(JSON.parse(first.stdout).usage, { messages: 1, w: 40 });
  assert.deepEqual(JSON.parse(second.stdout).usage, { messages: 1, w: 7 });
  const after = readState(dir);
  assert.deepEqual(after.cards['CRM-1'].windows[0].worker, workerOf(1));
  assert.equal(JSON.parse(readFileSync(join(dataDir, SLUG, 'CRM-2.json'), 'utf8')).effort.windows[0].tokens.input, 7);

  const status = JSON.parse((await run(['status'], deps)).stdout);
  assert.deepEqual(status.execution.spent, { cards: 2, tokens: 47 });
  const capped = JSON.parse((await run(['next', '--track', 't1'], deps)).stdout);
  assert.deepEqual([capped.action, capped.reason, capped.spent, capped.cap], ['pause', 'tokens', 47, 46]);
});

test('a card marked in the main transcript is measured without the files of worker windows, each file counted once', async () => {
  const fixture = spikeFixture({ issues: [issue('CRM-1'), issue('CRM-2')] });
  const { deps, transcripts, home, at } = fixture;
  const begun = await run(['begin', PROJECT_URL], deps);
  const dir = join(home, SLUG, 'runs', JSON.parse(begun.stdout).runId);
  const main = appendTranscript(join(transcripts, '-work', 'session-1.jsonl'), [toolResult(begun.stdout, '2026-11-10T10:00:01.000Z')]);
  const worker = join(transcripts, '-work', 'session-1', 'subagents', 'agent-1.jsonl');
  const state = readState(dir);
  state.tracks = { t1: { ...state.tracks.t1, cards: ['CRM-1'] }, t2: { ...state.tracks.t1, cards: ['CRM-2'] } };
  saveState(dir, state, deps.now());
  mkdirSync(join(dir, 'notes'), { recursive: true });

  const start = async (cardKey, track, transcript, when) => {
    at(when);
    const brief = await run(['next', '--track', track], deps);
    appendTranscript(transcript, [toolResult(brief.stdout, new Date(Date.parse(when) + 1000).toISOString())]);
    const tree = JSON.parse((await run(['tree', 'backend', '--track', track], deps)).stdout).path;
    writeFileSync(join(tree, `${cardKey}.txt`), `${cardKey}\n`);
    writeFileSync(join(dir, 'notes', `${cardKey}.json`), JSON.stringify(notes));
  };
  await start('CRM-1', 't1', main, '2026-11-10T10:01:00.000Z');
  await start('CRM-2', 't2', worker, '2026-11-10T10:02:00.000Z');
  appendTranscript(main, [usageEntry('controller', '2026-11-10T10:03:00.000Z', 40)]);
  appendTranscript(worker, [usageEntry('w', '2026-11-10T10:03:30.000Z', 7)]);

  at('2026-11-10T10:05:00.000Z');
  const mainEnd = await run(['end', 'CRM-1', '--track', 't1'], deps);
  assert.equal(mainEnd.code, 0, mainEnd.stderr);
  assert.deepEqual(JSON.parse(mainEnd.stdout).usage, { messages: 1, w: 40 });
});
