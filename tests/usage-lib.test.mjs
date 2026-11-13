import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addUsage, COUNTERS, zeroTokens } from '../scripts/lib/usage.mjs';

const line = (id, timestamp, usage, over = {}) => ({ type: 'assistant', timestamp, message: { id, usage }, ...over });
const fold = lines => {
  const messages = new Map();
  for (const o of lines) addUsage(messages, o, Date.parse(o.timestamp));
  return messages;
};

test('the counters are the five raw token fields and start at zero', () => {
  assert.deepEqual(COUNTERS.map(([k]) => k), ['input', 'cacheCreation', 'cacheRead', 'output', 'thinking']);
  assert.deepEqual(zeroTokens(), { input: 0, cacheCreation: 0, cacheRead: 0, output: 0, thinking: 0 });
});

test('one message logged three times counts once with the max of each counter, dated by its first line', () => {
  const messages = fold([
    line('m1', '2026-11-10T10:00:02.000Z', { input_tokens: 5, output_tokens: 1 }),
    line('m1', '2026-11-10T10:00:01.000Z', { input_tokens: 3, output_tokens: 9, cache_read_input_tokens: 7 }),
    line('m1', '2026-11-10T10:00:03.000Z', { input_tokens: 4, output_tokens: 2, output_tokens_details: { thinking_tokens: 6 } }),
  ]);
  assert.equal(messages.size, 1);
  const m = messages.get('m1');
  assert.equal(m.t, Date.parse('2026-11-10T10:00:01.000Z'));
  assert.deepEqual(m.tokens, { input: 5, cacheCreation: 0, cacheRead: 7, output: 9, thinking: 6 });
});

test('the id falls back to requestId; lines that are not assistant usage are ignored', () => {
  const messages = fold([
    { type: 'assistant', timestamp: '2026-11-10T10:00:00.000Z', requestId: 'r1', message: { usage: { input_tokens: 2 } } },
    line('u1', '2026-11-10T10:00:00.000Z', { input_tokens: 1 }, { type: 'user' }),
    line('n1', 'not a date', { input_tokens: 1 }),
    { type: 'assistant', timestamp: '2026-11-10T10:00:00.000Z', message: { id: 'x1' } },
    { type: 'assistant', timestamp: '2026-11-10T10:00:00.000Z', message: { usage: { input_tokens: 1 } } },
  ]);
  assert.deepEqual([...messages.keys()], ['r1']);
  assert.equal(messages.get('r1').tokens.input, 2);
});
