export const COUNTERS = [
  ['input', u => u.input_tokens],
  ['cacheCreation', u => u.cache_creation_input_tokens],
  ['cacheRead', u => u.cache_read_input_tokens],
  ['output', u => u.output_tokens],
  ['thinking', u => u.output_tokens_details?.thinking_tokens],
];

export const zeroTokens = () => Object.fromEntries(COUNTERS.map(([k]) => [k, 0]));

// A message is logged once per content block under the same id: its usage counts once, at the max of each counter,
// dated by its first line.
export function addUsage(messages, o, ms) {
  const id = o?.message?.id ?? o?.requestId;
  const usage = o?.message?.usage;
  if (o?.type !== 'assistant' || Number.isNaN(ms) || !id || !usage) return null;
  const m = messages.get(id) ?? { t: Infinity, tokens: zeroTokens() };
  m.t = Math.min(m.t, ms);
  for (const [k, read] of COUNTERS) m.tokens[k] = Math.max(m.tokens[k], read(usage) ?? 0);
  messages.set(id, m);
  return m;
}
