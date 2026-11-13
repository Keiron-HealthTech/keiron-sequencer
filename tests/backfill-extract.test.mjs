import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, createReadStream, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { extractUsage, parseArgs } from '../scripts/backfill/extract-usage.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/transcript/', import.meta.url));
const stream = path => ({
  async *[Symbol.asyncIterator]() {
    yield* createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  },
});
const ZERO = { input: 0, cacheCreation: 0, cacheRead: 0, output: 0, thinking: 0 };

test('tracer: one snapshot command in the fixture transcript gives one window with token counters', async () => {
  const doc = await extractUsage({
    files: [
      { name: 'main.jsonl', lines: stream(join(FIXTURE, 'main.jsonl')) },
      { name: 'agent-x.jsonl', lines: stream(join(FIXTURE, 'main/subagents/agent-x.jsonl')) },
    ],
    patchMap: { patches: { 'backend/00001-new.patch': { kind: 'card', cards: ['CRM-1'] } } },
    until: '2026-01-02T00:00:00Z',
  });
  assert.equal(doc.windows.length, 1);
  assert.deepEqual(Object.keys(doc.windows[0].tokens), Object.keys(ZERO));
  assert.deepEqual(doc.windows[0].patches, ['backend/00001-new.patch']);
});

const t = s => `2026-01-01T${s}.000Z`;
const usage = (u = {}) => ({
  input_tokens: u.in ?? 0,
  cache_creation_input_tokens: u.cc ?? 0,
  cache_read_input_tokens: u.cr ?? 0,
  output_tokens: u.out ?? 0,
  output_tokens_details: { thinking_tokens: u.th ?? 0 },
});
const asst = (ts, id, { cmds = [], u = {} } = {}) => JSON.stringify({
  type: 'assistant',
  timestamp: ts,
  message: { id, content: cmds.map((command, i) => ({ type: 'tool_use', id: `${id}-${i}`, name: 'Bash', input: { command } })), usage: usage(u) },
});
const result = (ts, toolUseId, isError = false) => JSON.stringify({
  type: 'user', timestamp: ts, message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: isError, content: 'out' }] },
});
const user = ts => JSON.stringify({ type: 'user', timestamp: ts, message: { content: 'u' } });
const cards = (...paths) => ({ patches: Object.fromEntries(paths.map((p, i) => [p, { kind: 'card', cards: [`CRM-${i + 1}`] }])) });
const run = (main, opts = {}) => extractUsage({
  files: [{ name: 'main.jsonl', lines: main }, ...(opts.subagents ?? [])],
  patchMap: opts.patchMap,
  logs: opts.logs,
  until: opts.until ?? '2026-01-02T00:00:00Z',
  since: opts.since,
});
const ends = doc => doc.windows.map(w => [w.end, w.patches]);

test('snap.sh, snap-paths.sh and a redirect are detected, quotes stripped, two snaps in one command', async () => {
  const map = cards('backend/00001-new.patch', 'backend/fixup-1-from-2-x.patch', 'backend/00002-new.patch', 'worker/00003-worker.patch');
  map.patches['backend/fixup-1-from-2-x.patch'] = { kind: 'fixup', fixed: ['CRM-1'], from: 'CRM-2' };
  const doc = await run([
    user(t('00:00:00')),
    asst(t('00:01:00'), 'a', { cmds: ['$S/snap.sh "$PWD" "$S/backend" \'00001-new\''] }),
    asst(t('00:02:00'), 'b', { cmds: ['$S/snap-paths.sh $PWD $S/backend fixup-1-from-2-x a.ts b.ts && $S/snap.sh $PWD $S/backend 00002-new'] }),
    asst(t('00:03:00'), 'c', { cmds: ['git diff --binary HEAD > "$S/worker/00003-worker.patch"'] }),
  ], { patchMap: map });
  assert.deepEqual(ends(doc), [
    [t('00:01:00'), ['backend/00001-new.patch']],
    [t('00:02:00'), ['backend/00002-new.patch', 'backend/fixup-1-from-2-x.patch']],
    [t('00:03:00'), ['worker/00003-worker.patch']],
  ]);
});

test('a for-loop variable in the snapshot name expands to every loop word', async () => {
  const doc = await run([
    user(t('00:00:00')),
    asst(t('00:01:00'), 'a', { cmds: ['for c in 1182 1184; do git apply $S/src/$c.patch; $S/snap.sh $PWD $S/backend 0$c-existing; done'] }),
  ], { patchMap: cards('backend/01182-existing.patch', 'backend/01184-existing.patch') });
  assert.deepEqual(ends(doc), [[t('00:01:00'), ['backend/01182-existing.patch', 'backend/01184-existing.patch']]]);
});

test('parallel tool_uses of one message are one instant at its earliest line timestamp', async () => {
  const doc = await run([
    user(t('00:00:00')),
    asst('2026-01-01T00:01:00.005Z', 'a', { cmds: ['$S/snap.sh $PWD $S/backend 00002-new'] }),
    asst(t('00:01:00'), 'a', { cmds: ['$S/snap.sh $PWD $S/backend 00001-new'] }),
  ], { patchMap: cards('backend/00001-new.patch', 'backend/00002-new.patch') });
  assert.deepEqual(ends(doc), [[t('00:01:00'), ['backend/00001-new.patch', 'backend/00002-new.patch']]]);
});

test('an is_error result drops its tool_use; the last successful match wins; matches after --until are ignored', async () => {
  const doc = await run([
    user(t('00:00:00')),
    asst(t('00:01:00'), 'a', { cmds: ['$S/snap.sh $PWD $S/backend 00002-new'] }),
    result(t('00:01:01'), 'a-0'),
    asst(t('00:02:00'), 'b', { cmds: ['$S/snap.sh $PWD $S/backend 00001-new'] }),
    result(t('00:02:01'), 'b-0', true),
    asst(t('00:03:00'), 'c', { cmds: ['$S/snap.sh $PWD $S/backend 00001-new'] }),
    asst(t('00:04:00'), 'd', { cmds: ['$S/snap.sh $PWD $S/backend 00002-new'] }),
    asst('2026-01-03T00:00:00.000Z', 'e', { cmds: ['$S/snap.sh $PWD $S/backend 00001-new'] }),
  ], { patchMap: cards('backend/00001-new.patch', 'backend/00002-new.patch') });
  assert.deepEqual(ends(doc), [[t('00:03:00'), ['backend/00001-new.patch']], [t('00:04:00'), ['backend/00002-new.patch']]]);
});

test('a mapped non-skip patch with no instant fails, listing every missing patch; skip patches are never instants', async () => {
  const map = cards('backend/00001-new.patch', 'backend/00002-new.patch', 'backend/00003-new.patch');
  map.patches['backend/00000-old.patch'] = { kind: 'skip', replacedBy: 'backend/00001-new.patch' };
  const main = [
    user(t('00:00:00')),
    asst(t('00:01:00'), 'a', { cmds: ['$S/snap.sh $PWD $S/backend 00001-new; git diff > $S/backend/00000-old.patch'] }),
    asst(t('00:02:00'), 'b', { cmds: ['$S/snap.sh $PWD $S/backend 00002-new'] }),
    result(t('00:02:01'), 'b-0', true),
  ];
  await assert.rejects(run(main, { patchMap: map }), err => {
    assert.match(err.message, /backend\/00002-new\.patch/);
    assert.match(err.message, /backend\/00003-new\.patch/);
    assert.doesNotMatch(err.message, /00000-old|00001-new/);
    return true;
  });
  delete map.patches['backend/00002-new.patch'];
  delete map.patches['backend/00003-new.patch'];
  assert.deepEqual(ends(await run(main, { patchMap: map })), [[t('00:01:00'), ['backend/00001-new.patch']]]);
});

test('instant order must equal the log.txt order; patches of one instant may share a position', async () => {
  const map = cards('backend/00001-new.patch', 'backend/00002-new.patch', 'backend/00003-new.patch');
  const main = [
    user(t('00:00:00')),
    asst(t('00:01:00'), 'a', { cmds: ['$S/snap.sh $PWD $S/backend 00001-new'] }),
    asst(t('00:02:00'), 'b', { cmds: ['$S/snap.sh $PWD $S/backend 00002-new && $S/snap.sh $PWD $S/backend 00003-new'] }),
  ];
  const ok = await run(main, { patchMap: map, logs: { backend: ['00001-new', '00003-new', '00002-new'] } });
  assert.equal(ok.windows.length, 2);
  await assert.rejects(
    run(main, { patchMap: map, logs: { backend: ['00002-new', '00001-new', '00003-new'] } }),
    /backend\/log\.txt.*00001-new/,
  );
});

test('usage is deduped by message id with the max per counter, and summed across messages', async () => {
  const doc = await run([
    user(t('00:00:00')),
    asst(t('00:00:10'), 'm1', { u: { in: 10, out: 4, th: 2 } }),
    asst(t('00:00:11'), 'm1', { u: { in: 10, out: 5, th: 2 } }),
    asst(t('00:00:12'), 'm1', { u: { in: 10, out: 5, th: 2 } }),
    asst(t('00:01:00'), 'm2', { cmds: ['$S/snap.sh $PWD $S/backend 00001-new'], u: { in: 1, cr: 100, out: 1 } }),
  ], { patchMap: cards('backend/00001-new.patch') });
  assert.equal(doc.windows[0].messages, 2);
  assert.deepEqual(doc.windows[0].tokens, { input: 11, cacheCreation: 0, cacheRead: 100, output: 6, thinking: 2 });
});

test('subagent messages inside a window count, outside do not, and an id seen in two files counts once', async () => {
  const doc = await run([
    user(t('00:00:00')),
    asst(t('00:00:20'), 'shared', { u: { in: 5 } }),
    asst(t('00:01:00'), 'a', { cmds: ['$S/snap.sh $PWD $S/backend 00001-new'] }),
  ], {
    patchMap: cards('backend/00001-new.patch'),
    subagents: [
      { name: 'agent-b.jsonl', lines: [asst(t('00:05:00'), 'late', { u: { in: 1000 } })] },
      { name: 'agent-a.jsonl', lines: [asst(t('00:00:30'), 's1', { u: { cc: 3 } }), asst(t('00:00:20'), 'shared', { u: { in: 5 } })] },
    ],
  });
  assert.equal(doc.windows[0].messages, 3);
  assert.deepEqual(doc.windows[0].tokens, { input: 5, cacheCreation: 3, cacheRead: 0, output: 0, thinking: 0 });
  assert.deepEqual(doc.source.files, ['agent-a.jsonl', 'main.jsonl']);
});

test('windows are start-exclusive and end-inclusive: a message at exactly t2 belongs to window 2', async () => {
  const doc = await run([
    user(t('00:00:00')),
    asst(t('00:01:00'), 'a', { cmds: ['$S/snap.sh $PWD $S/backend 00001-new'], u: { in: 1 } }),
    asst(t('00:02:00'), 'b', { cmds: ['$S/snap.sh $PWD $S/backend 00002-new'], u: { in: 10 } }),
    asst(t('00:03:00'), 'c', { cmds: ['$S/snap.sh $PWD $S/backend 00003-new'], u: { in: 100 } }),
  ], { patchMap: cards('backend/00001-new.patch', 'backend/00002-new.patch', 'backend/00003-new.patch') });
  assert.deepEqual(doc.windows.map(w => [w.start, w.end, w.tokens.input]), [
    [t('00:00:00'), t('00:01:00'), 1],
    [t('00:01:00'), t('00:02:00'), 10],
    [t('00:02:00'), t('00:03:00'), 100],
  ]);
});

test('the first window starts at the earliest main-file timestamp at or after --since, start-inclusive; default is session start', async () => {
  const main = () => [
    asst(t('00:00:00'), 'early', { u: { in: 1 } }),
    user(t('00:00:05')),
    asst(t('00:00:05'), 'atStart', { u: { in: 10 } }),
    asst(t('00:01:00'), 'a', { cmds: ['$S/snap.sh $PWD $S/backend 00001-new'], u: { in: 100 } }),
  ];
  const opts = { patchMap: cards('backend/00001-new.patch'), subagents: [{ name: 'agent-a.jsonl', lines: [asst(t('00:00:04'), 'sub', { u: { in: 1000 } })] }] };
  const scoped = await run(main(), { ...opts, since: '2026-01-01T00:00:03Z' });
  assert.equal(scoped.windows[0].start, t('00:00:05'));
  assert.equal(scoped.windows[0].tokens.input, 110);
  assert.equal(scoped.source.since, '2026-01-01T00:00:03.000Z');
  const whole = await run(main(), opts);
  assert.equal(whole.windows[0].start, t('00:00:00'));
  assert.equal(whole.windows[0].tokens.input, 1111);
  assert.equal(whole.source.since, t('00:00:00'));
});

test('a first-window start not strictly before the first instant fails', async () => {
  await assert.rejects(run([
    asst(t('00:01:00'), 'a', { cmds: ['$S/snap.sh $PWD $S/backend 00001-new'] }),
    user(t('00:02:00')),
  ], { patchMap: cards('backend/00001-new.patch') }), /first window/);
});

test('output is deterministic: fixed keys, no generation time, sorted files, identical across runs', async () => {
  const lines = () => [user(t('00:00:00')), asst(t('00:01:00'), 'a', { cmds: ['$S/snap.sh $PWD $S/backend 00001-new'] })];
  const one = await run(lines(), { patchMap: cards('backend/00001-new.patch') });
  const two = await run(lines(), { patchMap: cards('backend/00001-new.patch') });
  assert.equal(JSON.stringify(one), JSON.stringify(two));
  assert.deepEqual(Object.keys(one), ['schemaVersion', 'source', 'windows']);
  assert.deepEqual(Object.keys(one.source), ['session', 'files', 'since', 'until']);
  assert.deepEqual(Object.keys(one.windows[0]), ['start', 'end', 'patches', 'messages', 'tokens']);
  assert.deepEqual(one.source, { session: 'main', files: ['main.jsonl'], since: t('00:00:00'), until: '2026-01-02T00:00:00.000Z' });
});

test('parseArgs reads the main file, --until (required) and --since, and rejects bad dates and unknown flags', () => {
  assert.deepEqual(parseArgs(['x.jsonl', '--until', '2026-11-07T00:00:00Z', '--since', '2026-11-06T21:08:14.111Z']), {
    main: 'x.jsonl', until: '2026-11-07T00:00:00.000Z', since: '2026-11-06T21:08:14.111Z', trial: undefined,
  });
  assert.equal(parseArgs(['x.jsonl', '--until', '2026-11-07T00:00:00Z']).since, undefined);
  assert.throws(() => parseArgs(['x.jsonl']), /--until/);
  assert.throws(() => parseArgs(['x.jsonl', '--until', 'tomorrow']), /--until/);
  assert.throws(() => parseArgs(['x.jsonl', '--until', '2026-11-07T00:00:00Z', '--since', 'nope']), /--since/);
  assert.throws(() => parseArgs(['x.jsonl', '--until', '2026-11-07T00:00:00Z', '--bogus']), /--bogus/);
  assert.throws(() => parseArgs(['--until', '2026-11-07T00:00:00Z']), /main/);
});

test('CLI streams the main file and its subagents/ folder and prints the usage document', ctx => {
  const home = mkdtempSync(join(tmpdir(), 'keiron-sequencer-extract-home-'));
  ctx.after(() => rmSync(home, { recursive: true, force: true }));
  const cli = fileURLToPath(new URL('../scripts/backfill/extract-usage.mjs', import.meta.url));
  const out = spawnSync(process.execPath, [cli, join(FIXTURE, 'main.jsonl'), '--until', '2026-01-02T00:00:00Z', '--trial', join(FIXTURE, 'trial')], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } });
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), {
    schemaVersion: 1,
    source: { session: 'main', files: ['agent-x.jsonl', 'main.jsonl'], since: t('00:00:00'), until: '2026-01-02T00:00:00.000Z' },
    windows: [{
      start: t('00:00:00'), end: t('00:01:00'), patches: ['backend/00001-new.patch'], messages: 3,
      tokens: { input: 18, cacheCreation: 3, cacheRead: 100, output: 6, thinking: 2 },
    }],
  });
  const bad = spawnSync(process.execPath, [cli, join(FIXTURE, 'main.jsonl'), '--until', '2026-01-01T00:00:30Z', '--trial', join(FIXTURE, 'trial')], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /backend\/00001-new\.patch/);
  assert.equal(bad.stdout, '');
});

test('with no --trial the CLI reads the one trial reference under the home; with none it fails naming the path and --trial', ctx => {
  const home = mkdtempSync(join(tmpdir(), 'keiron-sequencer-extract-home-'));
  ctx.after(() => rmSync(home, { recursive: true, force: true }));
  const cli = fileURLToPath(new URL('../scripts/backfill/extract-usage.mjs', import.meta.url));
  const extract = () => spawnSync(process.execPath, [cli, join(FIXTURE, 'main.jsonl'), '--until', '2026-01-02T00:00:00Z'], {
    encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, KEIRON_SEQUENCER_HOME: join(home, 'sequencer') },
  });
  const none = extract();
  assert.equal(none.status, 1);
  assert.ok(none.stderr.includes(join(home, 'sequencer', '<slug>', 'trial-reference')), none.stderr);
  assert.match(none.stderr, /--trial <dir>/);
  cpSync(join(FIXTURE, 'trial'), join(home, 'sequencer', 'slug00000001', 'trial-reference'), { recursive: true });
  const found = extract();
  assert.equal(found.status, 0, found.stderr);
  assert.deepEqual(JSON.parse(found.stdout).windows.map(w => w.patches), [['backend/00001-new.patch']]);
});

test('a script name ending a line does not swallow the snapshot call on the next line', async () => {
  const doc = await run([
    user(t('00:00:00')),
    asst(t('00:01:00'), 'a', { cmds: ['chmod +x $S/snap-paths.sh\n$S/snap-paths.sh $PWD $S/backend 00001-new a.ts\n$S/snap.sh $PWD $S/backend 00002-new'] }),
  ], { patchMap: cards('backend/00001-new.patch', 'backend/00002-new.patch') });
  assert.deepEqual(ends(doc), [[t('00:01:00'), ['backend/00001-new.patch', 'backend/00002-new.patch']]]);
});
