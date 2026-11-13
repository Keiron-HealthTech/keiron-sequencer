import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assertHomeOutsideWorkTree } from '../spike/home.mjs';

export const TAIL_LINES = 40;

const ended = text => (text && !text.endsWith('\n') ? `${text}\n` : text ?? '');

function runOne(runSetup, argv, opts) {
  try {
    const r = runSetup(argv, opts);
    return { shown: { argv, status: r.status }, output: `${ended(r.stdout)}${ended(r.stderr)}exit ${r.status}\n` };
  } catch (e) {
    return { shown: { argv, status: null, error: e.message }, output: `error: ${e.message}\n` };
  }
}

// The log lives under the home, outside every repo, so a typecheck baseline never lands in a commit.
export function runBaseline(runSetup, { repoDir, settings, cwd, home, now }) {
  if (!settings?.typecheck.length) return { repo: repoDir, configured: false, commands: [], log: null, tail: '' };
  assertHomeOutsideWorkTree(home);
  const log = join(home, 'start', 'logs', `typecheck-${repoDir}.log`);
  mkdirSync(dirname(log), { recursive: true });
  let text = '';
  const commands = settings.typecheck.map(argv => {
    const { shown, output } = runOne(runSetup, argv, { cwd, timeoutMs: settings.typecheckTimeoutMs ?? undefined });
    const block = `$ ${argv.join(' ')} (${now().toISOString()})\n${output}`;
    appendFileSync(log, block);
    text += block;
    return shown;
  });
  return { repo: repoDir, configured: true, commands, log, tail: text.split('\n').slice(0, -1).slice(-TAIL_LINES).join('\n') };
}
