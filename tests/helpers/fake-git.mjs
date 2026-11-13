import { ghRunner, gitRunner } from '../../scripts/lib/spike/exec.mjs';

export const readOnlySubcommands = ['rev-parse', 'remote', 'status', 'for-each-ref', 'worktree list', 'ls-remote', 'log', 'rev-list'];

const VALUE_OPTIONS = new Set(['-C', '-c']);

export function subcommandOf(argv) {
  let i = 0;
  while (i < argv.length && argv[i].startsWith('-')) i += VALUE_OPTIONS.has(argv[i]) ? 2 : 1;
  return argv[i] === 'worktree' ? `worktree ${argv[i + 1]}` : argv[i];
}

const reply = out => {
  if (out === undefined) return null;
  if (typeof out === 'string') return { status: 0, stdout: out, stderr: '' };
  return { status: 0, stdout: '', stderr: '', ...out };
};

// Answers go through the real runners, so the git deny-list, the gh allowlist and throw-on-non-zero are the shipped ones.
export function fakeGit(table = {}) {
  const calls = [];
  const spawn = (cmd, argv, opts) => {
    const sub = subcommandOf(argv);
    calls.push({ sub, argv: [...argv], cwd: opts.cwd, env: opts.env });
    const answer = table[sub];
    return reply(typeof answer === 'function' ? answer(argv, opts) : answer)
      ?? { status: 1, stdout: '', stderr: `fakeGit: no answer for ${sub}` };
  };
  return { calls, run: gitRunner({ spawn, env: {} }) };
}

export function fakeGitHub(respond = () => '[]') {
  const calls = [];
  const spawn = (cmd, argv, opts) => {
    calls.push({ argv: [...argv], cwd: opts.cwd });
    return reply(respond(argv)) ?? { status: 1, stdout: '', stderr: 'fakeGitHub: no answer' };
  };
  return { calls, run: ghRunner({ spawn, env: {} }) };
}
