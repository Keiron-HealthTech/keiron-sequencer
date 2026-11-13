import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const TAIL_LINES = 40;
export const SPIKE_TYPECHECK_TIMEOUT_MS = 600000;
export const GENERATED_TSCONFIG = 'tsconfig.keiron-sequencer-typecheck.json';
export const CHANGED = '{changed}';

const TS_FILE = /\.[cm]?tsx?$/;
const ended = text => (text && !text.endsWith('\n') ? `${text}\n` : text ?? '');
const tailOf = text => text.split('\n').slice(0, -1).slice(-TAIL_LINES).join('\n');

// A generated tsconfig left behind by a killed check is removed before any staging, so it never reaches a patch.
export const clearGenerated = treePath => rmSync(join(treePath, GENERATED_TSCONFIG), { force: true });

// The paths a tree changed since its last snapshot, untracked ones included, deletions left out (nothing to check).
export function changedSinceLast(git, repo) {
  clearGenerated(repo.path);
  git(['add', '-A'], { cwd: repo.path });
  return git(['diff', '--cached', '--name-only', '--diff-filter=d', repo.last], { cwd: repo.path }).split('\n').filter(Boolean);
}

export const typecheckLog = (dir, repoDir) => join(dir, 'logs', `typecheck-${repoDir}.log`);

// The check one repo's config asks for: its spikeTypecheck (auto when absent) and its timeout.
export const repoTypecheck = (runner, repoConfig, { treePath, changed, logPath }) => runTypecheck(runner, {
  setting: repoConfig?.spikeTypecheck, timeoutMs: repoConfig?.spikeTypecheckTimeoutMs ?? SPIKE_TYPECHECK_TIMEOUT_MS, treePath, changed, logPath,
});

export const expandChanged = (argv, changed) => argv.flatMap(a => (a === CHANGED ? changed : [a]));

// One command, its output appended to the log; a timeout or a spawn error is a failed run, never a throw.
export function runCommand(runner, argv, { cwd, timeoutMs, logPath }) {
  let out;
  try {
    const r = runner(argv, { cwd, timeoutMs });
    out = { ok: r.status === 0, status: r.status, timedOut: false, text: `${ended(r.stdout)}${ended(r.stderr)}exit ${r.status}\n` };
  } catch (e) {
    const timedOut = e.code === 'ETIMEDOUT';
    out = { ok: false, status: null, timedOut, text: timedOut ? `timed out after ${timeoutMs} ms\n` : `error: ${e.message}\n` };
  }
  const block = `$ ${argv.join(' ')}\n${out.text}`;
  if (logPath) {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, block);
  }
  return { ok: out.ok, status: out.status, timedOut: out.timedOut, tail: tailOf(block), text: out.text };
}

// With no spikeTypecheck the tree's own TypeScript project is checked whole: a generated tsconfig extends the repo's, keeps its
// include (so global declarations, module augmentations and side-effect imports are all there, in the repo's own order) and
// adds the changed files, so a spec the repo's config excludes is checked too. It sits next to tsconfig.json, so every path
// in the repo's config resolves as usual, and it is gone before any snapshot. Only errors in the changed files refuse.
function autoCommand(treePath, changed) {
  const tsc = join(treePath, 'node_modules', '.bin', 'tsc');
  if (!existsSync(join(treePath, 'tsconfig.json')) || !existsSync(tsc)) return { skipped: 'no-typescript-project' };
  const files = changed.filter(f => TS_FILE.test(f)).sort();
  if (!files.length) return { skipped: 'no-typescript-changes' };
  const config = { extends: './tsconfig.json', compilerOptions: { noEmit: true, incremental: false, composite: false }, files };
  return { argv: [tsc, '-p', GENERATED_TSCONFIG, '--pretty', 'false'], generated: `${JSON.stringify(config, null, 2)}\n`, only: files };
}

const DIAGNOSTIC = /^(.+?)\(\d+,\d+\): error TS\d+/;

// tsc failed: it stands only when an error sits in a changed file, or when an error sits in no file at all (a config or
// crash). Errors in files the card did not change were there before it, or are its knock-on in files it did not touch.
function judged(result, only) {
  if (result.ok || result.timedOut || result.status === null) return { ...result, ignored: [] };
  const errors = result.text.split('\n').filter(l => /error TS\d+/.test(l));
  const mine = new Set(only);
  const ignored = errors.filter(l => { const m = l.match(DIAGNOSTIC); return m && !mine.has(m[1]); });
  return { ...result, ok: errors.length > 0 && ignored.length === errors.length, ignored };
}

// setting: undefined (auto), false (off) or an argv where "{changed}" expands to the changed paths.
export function runTypecheck(runner, { setting, timeoutMs = SPIKE_TYPECHECK_TIMEOUT_MS, treePath, changed, logPath }) {
  if (setting === false) return { ran: false, skipped: 'off' };
  const planned = Array.isArray(setting)
    ? (changed.length ? { argv: expandChanged(setting, changed) } : { skipped: 'no-changes' })
    : autoCommand(treePath, changed);
  if (planned.skipped) return { ran: false, skipped: planned.skipped };
  clearGenerated(treePath);
  const generatedPath = join(treePath, GENERATED_TSCONFIG);
  try {
    if (planned.generated) writeFileSync(generatedPath, planned.generated);
    const result = runCommand(runner, planned.argv, { cwd: treePath, timeoutMs, logPath });
    const { text, ...out } = planned.only ? judged(result, planned.only) : { ...result, ignored: [] };
    return { ran: true, skipped: null, argv: planned.argv, ...out };
  } finally {
    if (planned.generated) rmSync(generatedPath, { force: true });
  }
}
