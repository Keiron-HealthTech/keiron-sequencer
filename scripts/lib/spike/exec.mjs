import { spawnSync } from 'node:child_process';

const MAX_BUFFER = 256 * 1024 * 1024;
const GIT_DENIED = new Set(['commit', 'push', 'tag']);
const GIT_REMOTE_DENIED = new Set(['set-url']);
// Global options that take their value as the next argument; `--opt=value` forms carry it inline.
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--exec-path']);
const GH_ALLOWED = new Set(['pr list', 'pr view', 'pr diff']);

const positionals = args => {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('-')) out.push(args[i]);
    else if (!out.length && GIT_VALUE_OPTIONS.has(args[i])) i++;
  }
  return out;
};

// An alias given on the command line could run a refused subcommand under another name.
const definesAlias = args => args.some((a, i) => {
  const value = ['-c', '--config-env'].includes(args[i - 1]) ? a : a.startsWith('--config-env=') ? a.slice('--config-env='.length) : null;
  return value !== null && value.toLowerCase().startsWith('alias.');
});

export function gitDenied(args) {
  if (definesAlias(args)) return 'with an alias';
  const [sub, action] = positionals(args);
  if (GIT_DENIED.has(sub)) return sub;
  if (sub === 'remote' && GIT_REMOTE_DENIED.has(action)) return `remote ${action}`;
  return null;
}

export function gitRunner({ spawn = spawnSync, env = process.env } = {}) {
  return (args, { cwd, env: extra } = {}) => {
    const denied = gitDenied(args);
    if (denied) throw new Error(`git ${denied} is never run by the spike`);
    const r = spawn('git', args, { cwd, env: extra ? { ...env, ...extra } : env, encoding: 'utf8', maxBuffer: MAX_BUFFER });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`git ${positionals(args)[0]} failed (${r.status}): ${String(r.stderr).trim()}`);
    return r.stdout;
  };
}

export function ghRunner({ spawn = spawnSync, env = process.env } = {}) {
  return (argv, { cwd } = {}) => {
    const sub = argv.slice(0, 2).join(' ');
    if (!GH_ALLOWED.has(sub)) throw new Error(`gh ${sub} is never run by the spike`);
    const r = spawn('gh', argv, { cwd, env, encoding: 'utf8', maxBuffer: MAX_BUFFER });
    if (r.error) throw r.error;
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
}

const isArgv = argv => Array.isArray(argv) && argv.length > 0 && argv.every(a => typeof a === 'string' && a.length > 0);

// The shell writes its own pid, then exec makes the command that very process: the pid file names the command itself.
const RECORD_PID = 'echo $$ > "$0"; exec "$@"';

// childPidFile: a check slot's pid file, so the slot stays held while the command runs even if the caller is killed.
export function setupRunner({ spawn = spawnSync, env = process.env } = {}) {
  return (given, { cwd, timeoutMs, childPidFile } = {}) => {
    if (!isArgv(given)) throw new Error('a setup command must be a non-empty argv array of strings');
    const argv = childPidFile ? ['sh', '-c', RECORD_PID, childPidFile, ...given] : given;
    const r = spawn(argv[0], argv.slice(1), { cwd, env, encoding: 'utf8', shell: false, timeout: timeoutMs, maxBuffer: MAX_BUFFER });
    if (r.error) throw r.error;
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
}
