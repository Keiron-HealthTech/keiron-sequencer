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

const jsonl = (dir, file) => (file.isFile() && file.name.endsWith('.jsonl') ? [join(dir, file.name)] : []);

const isSubagent = file => basename(dirname(file)) === 'subagents';

// Main transcripts sit one level under the root, <session>/subagents/*.jsonl one level further down.
function mainTranscripts(root) {
  if (!existsSync(root)) return [];
  return entries(root).filter(e => e.isDirectory())
    .flatMap(d => entries(join(root, d.name)).flatMap(e => jsonl(join(root, d.name), e)))
    .sort();
}

function subagentTranscripts(root) {
  if (!existsSync(root)) return [];
  return entries(root).filter(e => e.isDirectory())
    .flatMap(d => entries(join(root, d.name)).filter(e => e.isDirectory())
      .flatMap(s => {
        const dir = join(root, d.name, s.name, 'subagents');
        return existsSync(dir) ? entries(dir).flatMap(e => jsonl(dir, e)) : [];
      }))
    .sort();
}

// A subagent file wins over a main transcript that echoes the same mark: the worker is who ran the command.
export async function bindSession({ root, nonce, issuedAt, bound = [] }) {
  const kept = bound.filter(f => holds(f, nonce));
  const keptFile = kept.find(isSubagent) ?? kept[0];
  if (keptFile) return isSubagent(keptFile) ? { file: keptFile, subagent: true } : { file: keptFile };
  if (!root) return null;
  const since = Date.parse(issuedAt) - RESCAN_SLACK_MS;
  const recent = f => statSync(f).mtimeMs >= since && holds(f, nonce);
  const worker = subagentTranscripts(root).find(recent);
  if (worker) return { file: worker, subagent: true };
  const file = mainTranscripts(root).find(recent);
  return file ? { file } : null;
}

// Subagent files that hold one of the nonces belong to the card windows those marks opened.
export const withoutMarked = (files, nonces) => files.filter(f => !isSubagent(f) || !nonces.some(n => holds(f, n)));

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
