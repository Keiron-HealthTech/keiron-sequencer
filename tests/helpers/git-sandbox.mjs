import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The user's global and system git config (hooks, templates, signing) must not leak into sandbox repos,
// and a GIT_DIR inherited from a hook would point every call at the wrong repository.
const INHERITED = /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|COMMON_DIR|CONFIG|CONFIG_PARAMETERS|CONFIG_COUNT)$/;
export const SANDBOX_ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !INHERITED.test(k))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

const IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];

export function sandboxGit(args, { cwd } = {}) {
  const r = spawnSync('git', [...IDENTITY, ...args], { cwd, env: SANDBOX_ENV, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (${r.status}): ${r.stderr}`);
  return r.stdout;
}

export const tempDir = prefix => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

const disposer = dir => () => rmSync(dir, { recursive: true, force: true });

export function makeRepo() {
  const dir = tempDir('keiron-sequencer-sandbox-repo-');
  const git = (args, opts = {}) => sandboxGit(args, { cwd: dir, ...opts });
  git(['init', '-q', '-b', 'main']);
  writeFileSync(join(dir, 'README.md'), '# sandbox\n');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'index.js'), 'export const one = 1\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'initial']);
  return { dir, git, dispose: disposer(dir) };
}

export function makeBareOrigin({ from } = {}) {
  const parent = tempDir('keiron-sequencer-sandbox-origin-');
  const dir = join(parent, 'origin.git');
  if (from) sandboxGit(['clone', '-q', '--bare', from, dir]);
  else sandboxGit(['init', '-q', '--bare', '-b', 'main', dir]);
  return { dir, dispose: disposer(parent) };
}

function recorder(answer) {
  const calls = [];
  const run = (argv, { cwd } = {}) => {
    calls.push({ argv: [...argv], cwd });
    return answer(argv);
  };
  return { calls, run };
}

export const fakeGh = (respond = () => '[]') => recorder(argv => ({ status: 0, stdout: respond(argv), stderr: '' }));

export const fakeSetup = (exitCodes = {}) => recorder(argv => ({ status: exitCodes[argv.join(' ')] ?? 0, stdout: '', stderr: '' }));

// Answers a version probe like spawnSync through setupRunner: a version string is status 0 with it on stdout,
// null is a tool that runs but fails, and a tool left out is not installed (spawn's ENOENT).
export const fakeTools = (versions = {}) => recorder(argv => {
  if (!Object.hasOwn(versions, argv[0])) throw Object.assign(new Error(`spawnSync ${argv[0]} ENOENT`), { code: 'ENOENT' });
  const version = versions[argv[0]];
  return version === null ? { status: 1, stdout: '', stderr: '' } : { status: 0, stdout: `${version}\n`, stderr: '' };
});
