import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { addUsage, COUNTERS, zeroTokens } from '../usage.mjs';

export const WEIGHTS = { input: 1, cacheCreation: 1.25, cacheRead: 0.1, output: 5, thinking: 0 };

export const weighted = tokens => Object.entries(WEIGHTS).reduce((sum, [k, w]) => sum + w * (tokens[k] ?? 0), 0);

export const transcriptsRoot = (env = process.env, home = homedir()) =>
  env.KEIRON_SEQUENCER_TRANSCRIPTS || (env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, 'projects') : join(home, '.claude', 'projects'));

const RESCAN_SLACK_MS = 5000;

const holds = (file, nonce) => {
  try {
    return readFileSync(file, 'utf8').includes(nonce);
  } catch {
    return false;
  }
};

const entries = dir => readdirSync(dir, { withFileTypes: true });

// Main transcripts sit one level under the root; subagent transcripts sit deeper and never carry a mark.
function mainTranscripts(root) {
  if (!existsSync(root)) return [];
  return entries(root).filter(e => e.isDirectory())
    .flatMap(d => entries(join(root, d.name)).filter(e => e.isFile() && e.name.endsWith('.jsonl')).map(e => join(root, d.name, e.name)))
    .sort();
}

export async function bindSession({ root, nonce, issuedAt, bound = [] }) {
  const kept = bound.find(f => holds(f, nonce));
  if (kept) return { file: kept };
  if (!root) return null;
  const since = Date.parse(issuedAt) - RESCAN_SLACK_MS;
  const file = mainTranscripts(root).find(f => statSync(f).mtimeMs >= since && holds(f, nonce));
  return file ? { file } : null;
}

export function sessionFiles(main) {
  const sub = join(dirname(main), basename(main, '.jsonl'), 'subagents');
  const agents = existsSync(sub) ? readdirSync(sub).filter(f => f.endsWith('.jsonl')).sort() : [];
  return [main, ...agents.map(f => join(sub, f))];
}

export function lastEntryAt(files, until) {
  const untilMs = Date.parse(until);
  let latest = -Infinity;
  for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      let ms;
      try {
        ms = Date.parse(JSON.parse(line)?.timestamp);
      } catch {
        continue;
      }
      if (ms <= untilMs) latest = Math.max(latest, ms);
    }
  }
  return latest === -Infinity ? null : new Date(latest).toISOString();
}

// Lines are appended in order, so any line dated after the end proves every line of the window is on disk.
export async function windowUsage({ files, start, end, startInclusive = false }) {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  const messages = new Map();
  let latest = -Infinity;
  for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      const ms = Date.parse(o?.timestamp);
      if (!Number.isNaN(ms)) latest = Math.max(latest, ms);
      addUsage(messages, o, ms);
    }
  }
  const tokens = zeroTokens();
  let count = 0;
  for (const m of messages.values()) {
    if ((startInclusive ? m.t < startMs : m.t <= startMs) || m.t > endMs) continue;
    count++;
    for (const [k] of COUNTERS) tokens[k] += m.tokens[k];
  }
  return { messages: count, tokens, settled: latest > endMs };
}
