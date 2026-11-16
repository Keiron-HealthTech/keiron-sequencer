const ID = '[A-Z][A-Z0-9]*-\\d+';
const LIST = `${ID}(?:\\s*(?:,|\\by\\b|\\band\\b|/)\\s*${ID})*`;
// Only the first letter of a phrase may change case: an `i` flag would also read "tabla-2" as a card id.
const BLOCKED_BY = new RegExp(`(?<![Nn]o )\\b(?:[Dd]epende de|[Ee]spera a|[Nn]ecesita)\\s+(${LIST})`, 'g');
const BLOCKS = new RegExp(`(?:(?<![Nn]o )\\b(?:[Bb]loquea|[Hh]abilita)\\s+|\\b[Gg]ates:\\s*)(${LIST})`, 'g');
const ISSUE_TAG = /<issue\b[^>]*\blabel="([^"]+)"[^>]*\/?>(?:<\/issue>)?/g;
const MENTION = new RegExp(`\\[(${ID})\\]\\(<?https?://linear\\.app/[^)\\s>]*>?\\)`, 'g');
const ISSUE_URL = new RegExp(`https?://linear\\.app/[^/\\s]+/issue/(${ID})(?:/[^\\s)>]*)?`, 'g');
const QA_LIVE = new RegExp(`(${ID})\\s+deployado en QA`, 'g');

// Linear writes a card mention as an <issue> tag (MCP), a markdown link or a bare URL (GraphQL); each reads as its id.
const plain = text => String(text ?? '').replace(ISSUE_TAG, '$1').replace(MENTION, '$1').replace(ISSUE_URL, '$1');
const idsIn = list => list.match(new RegExp(ID, 'g')) ?? [];

export function textEdges(descriptions) {
  const seen = new Map();
  const add = (from, to, phrase) => {
    if (from !== to && !seen.has(`${from}>${to}`)) seen.set(`${from}>${to}`, { from, to, phrase });
  };
  for (const [key, description] of descriptions) {
    const text = plain(description);
    for (const m of text.matchAll(BLOCKED_BY)) for (const id of idsIn(m[1])) add(id, key, m[0]);
    for (const m of text.matchAll(BLOCKS)) for (const id of idsIn(m[1])) add(key, id, m[0]);
  }
  return [...seen.values()];
}

export function markers(description) {
  const text = plain(description);
  return {
    deferrable: /se puede diferir|carta elástica|\bdiferido\b/i.test(text),
    noPr: /\bno lleva PR\b/i.test(text),
    qaLive: [...new Set([...text.matchAll(QA_LIVE)].map(m => m[1]))],
  };
}
