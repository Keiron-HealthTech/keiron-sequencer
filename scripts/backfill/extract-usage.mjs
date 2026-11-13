import { createReadStream, existsSync, readFileSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findTrialReference, sequencerHome } from '../lib/spike/home.mjs';
import { addUsage, COUNTERS, zeroTokens } from '../lib/usage.mjs';

const SNAP = /snap(?:-paths)?\.sh[ \t]+([^\s;&|<>()]+)[ \t]+([^\s;&|<>()]+)[ \t]+([^\s;&|<>()]+)/g;
const REDIRECT = />\s*["']?([^\s"';&|<>()]+\.patch)(?![\w.+-])/g;
const LOOP = /for\s+(\w+)\s+in\s+([^;\n]+?)\s*[;\n]\s*do\b/g;
const VAR = /\$\{?(\w+)\}?/g;

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const unquote = s => s.replace(/["']/g, '');
const lastSegments = (path, n) => path.replace(/\/+$/, '').split('/').slice(-n).join('/');

function loopWords(command, index, name) {
  let words = null;
  for (const m of command.matchAll(LOOP)) if (m.index < index && m[1] === name) words = m[2].trim().split(/\s+/);
  return words;
}

function expand(command, index, name) {
  const vars = [...new Set([...name.matchAll(VAR)].map(m => m[1]))];
  if (vars.length !== 1) return vars.length ? [] : [name];
  const words = loopWords(command, index, vars[0]);
  return words ? words.map(w => name.replace(VAR, w)) : [];
}

function patchesInCommand(command) {
  const found = [];
  for (const m of command.matchAll(SNAP)) {
    const dir = lastSegments(unquote(m[2]), 1);
    for (const name of expand(command, m.index, unquote(m[3]))) found.push(`${dir}/${name}.patch`);
  }
  for (const m of command.matchAll(REDIRECT)) found.push(lastSegments(m[1], 2));
  return found;
}

export async function extractUsage({ files, patchMap, logs = {}, until, since }) {
  const untilMs = Date.parse(until);
  const sinceMs = since === undefined ? null : Date.parse(since);
  const wanted = new Set(Object.entries(patchMap.patches).filter(([, e]) => e.kind !== 'skip').map(([p]) => p));
  const messages = new Map();
  const mainFirst = new Map();
  const toolUses = [];
  const failed = new Set();
  let sessionStart = null;
  let firstAfterSince = null;

  // files[0] is the main transcript: snapshots are detected there only, usage comes from every file.
  for (const [fileIndex, file] of files.entries()) {
    const isMain = fileIndex === 0;
    let broken = false;
    for await (const line of file.lines) {
      if (broken) throw new Error(`${file.name}: unparsable line before the end of the file`);
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        broken = line.trim().length > 0;
        continue;
      }
      const ms = o.timestamp ? Date.parse(o.timestamp) : NaN;
      if (isMain && !Number.isNaN(ms)) {
        if (sessionStart === null || ms < sessionStart) sessionStart = ms;
        if (sinceMs !== null && ms >= sinceMs && (firstAfterSince === null || ms < firstAfterSince)) firstAfterSince = ms;
      }
      if (isMain && o.type === 'user' && Array.isArray(o.message?.content)) {
        for (const c of o.message.content) if (c.type === 'tool_result' && c.is_error === true) failed.add(c.tool_use_id);
      }
      if (o.type !== 'assistant' || Number.isNaN(ms)) continue;
      const id = o.message?.id ?? o.requestId;
      if (!id) continue;
      if (isMain) mainFirst.set(id, Math.min(ms, mainFirst.get(id) ?? Infinity));
      const m = addUsage(messages, o, ms);
      if (m) (m.files ??= new Set()).add(file.name);
      if (!isMain || ms > untilMs) continue;
      for (const c of o.message?.content ?? []) {
        if (c.type !== 'tool_use' || typeof c.input?.command !== 'string') continue;
        const patches = patchesInCommand(c.input.command).filter(p => wanted.has(p));
        if (patches.length) toolUses.push({ toolUseId: c.id, messageId: id, ms, patches });
      }
    }
  }

  const winner = new Map();
  toolUses
    .filter(u => !failed.has(u.toolUseId))
    .sort((a, b) => a.ms - b.ms)
    .forEach(u => u.patches.forEach(p => winner.set(p, u.messageId)));

  const missing = [...wanted].filter(p => !winner.has(p)).sort(compare);
  if (missing.length) throw new Error(`no snapshot instant for: ${missing.join(', ')}`);

  const byMessage = new Map();
  for (const [patch, id] of winner) byMessage.set(id, [...(byMessage.get(id) ?? []), patch]);
  const instants = [...byMessage]
    .map(([id, patches]) => ({ id, at: mainFirst.get(id), patches: patches.sort(compare) }))
    .sort((a, b) => a.at - b.at || compare(a.id, b.id));
  const atOf = new Map(instants.flatMap(i => i.patches.map(p => [p, i.at])));

  for (const [dir, names] of Object.entries(logs)) {
    let prev = null;
    for (const name of names) {
      const at = atOf.get(`${dir}/${name}.patch`);
      if (at === undefined) continue;
      if (prev && at < prev.at) {
        throw new Error(`${dir}/log.txt order disagrees with the snapshot instants: ${prev.name} is logged before ${name}`);
      }
      prev = { name, at };
    }
  }

  const resolvedSince = sinceMs ?? sessionStart;
  const firstStart = sinceMs === null ? sessionStart : firstAfterSince;
  if (firstStart === null || firstStart >= instants[0].at) {
    throw new Error('the first window start is not before the first snapshot instant');
  }

  const windows = instants.map((inst, i) => ({
    startMs: i === 0 ? firstStart : instants[i - 1].at,
    inclusive: i === 0,
    window: { start: null, end: null, patches: inst.patches, messages: 0, tokens: zeroTokens() },
    endMs: inst.at,
  }));
  const contributing = new Set();
  for (const m of messages.values()) {
    const w = windows.find(w => (w.inclusive ? m.t >= w.startMs : m.t > w.startMs) && m.t <= w.endMs);
    if (!w) continue;
    w.window.messages++;
    for (const [k] of COUNTERS) w.window.tokens[k] += m.tokens[k];
    m.files.forEach(f => contributing.add(f));
  }

  const iso = ms => new Date(ms).toISOString();
  return {
    schemaVersion: 1,
    source: {
      session: basename(files[0].name, '.jsonl'),
      files: [...contributing].sort(compare),
      since: iso(resolvedSince),
      until: iso(untilMs),
    },
    windows: windows.map(w => ({ ...w.window, start: iso(w.startMs), end: iso(w.endMs) })),
  };
}

const validDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(s) && !Number.isNaN(Date.parse(s));

export function parseArgs(argv) {
  const out = { main: undefined, until: undefined, since: undefined, trial: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--until' || arg === '--since') {
      const value = argv[++i];
      if (!validDate(value)) throw new Error(`${arg} needs an ISO-8601 datetime`);
      out[arg.slice(2)] = new Date(value).toISOString();
    } else if (arg === '--trial') {
      out.trial = argv[++i];
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option ${arg}`);
    } else if (out.main === undefined) {
      out.main = arg;
    } else {
      throw new Error(`unexpected argument ${arg}`);
    }
  }
  if (out.main === undefined) throw new Error('the main transcript path is required');
  if (out.until === undefined) throw new Error('--until is required');
  return out;
}

// Lazy: a readline interface created before iteration starts drops its early lines.
const stream = path => ({
  async *[Symbol.asyncIterator]() {
    yield* createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  },
});

function readLogs(trialDir) {
  const logs = {};
  for (const d of readdirSync(trialDir, { withFileTypes: true })) {
    const log = join(trialDir, d.name, 'log.txt');
    if (d.isDirectory() && existsSync(log)) {
      logs[d.name] = readFileSync(log, 'utf8').split('\n').map(l => l.split(/\s+/)[0]).filter(Boolean);
    }
  }
  return logs;
}

async function main(argv) {
  const args = parseArgs(argv);
  const trialDir = args.trial ?? findTrialReference(sequencerHome());
  const mapPath = join(trialDir, 'backfill/patch-map.json');
  if (!existsSync(mapPath)) throw new Error(`no trial patch map at ${mapPath}: pass --trial <dir>`);
  const patchMap = JSON.parse(readFileSync(mapPath, 'utf8'));
  const subDir = join(dirname(args.main), basename(args.main, '.jsonl'), 'subagents');
  const subagents = existsSync(subDir) ? readdirSync(subDir).filter(f => f.endsWith('.jsonl')).sort(compare) : [];
  const files = [
    { name: basename(args.main), lines: stream(args.main) },
    ...subagents.map(f => ({ name: f, lines: stream(join(subDir, f)) })),
  ];
  const doc = await extractUsage({ files, patchMap, logs: readLogs(trialDir), until: args.until, since: args.since });
  process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(err => {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(1);
  });
}
