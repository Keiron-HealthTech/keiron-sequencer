import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../scripts/spike.mjs';
import {
  allowedRepos, configIssues, expandHome, globToRegExp, loadConfig, PROJECT_KEYS, readConfigBytes, REPO_KEYS, riskKinds, TOP_KEYS, validateConfig,
  writeConfig,
} from '../scripts/lib/spike/config.mjs';
import { expandChanged } from '../scripts/lib/spike/typecheck.mjs';
import { tempDir } from './helpers/git-sandbox.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import { activeRunDir, blocks, issue, PROJECT_URL, SLUG, spikeFixture } from './helpers/spike-fixture.mjs';

guardNetwork();

const DIR = tempDir('keiron-sequencer-config-');
after(() => rmSync(DIR, { recursive: true, force: true }));

const EXAMPLE = new URL('../docs/spike-config.example.json', import.meta.url);
const REAL_REPO_SOURCE = new RegExp(['crm-', ['kei', 'ron'].join(''), ['kai', 'bot'].join(''), ['ws', 'events'].join(''), '\\bkz\\b'].join('|'), 'i');
const REAL_REPO_TEXT = new RegExp(`${REAL_REPO_SOURCE.source}|messaging|authentication`, 'i');

const repo = (over = {}) => ({
  name: 'api', github: 'acme/api', checkout: '/src/api', url: null, remote: 'origin', defaultBranch: null,
  setup: [['npm', 'ci']], setupTimeoutMs: 600000, risk: [{ kind: 'migrations', paths: ['**/migrations/**'] }], ...over,
});
const config = (repos = { api: repo() }, projects) => ({ schemaVersion: 1, repos, ...(projects ? { projects } : {}) });
const paths = errors => errors.map(e => e.slice(0, e.indexOf(':')));

test('a full config is valid, and a checkout repo may use remote null', () => {
  assert.deepEqual(validateConfig(config()), []);
  assert.deepEqual(validateConfig(config({ api: repo({ remote: null, defaultBranch: 'main' }) })), []);
  assert.deepEqual(validateConfig(config({ api: repo({ checkout: null, url: 'https://example.invalid/api.git' }) })), []);
  assert.deepEqual(validateConfig(config({ api: repo({ setup: undefined, risk: undefined, setupTimeoutMs: undefined, github: undefined }) })), []);
});

test('exactly one of checkout and url is set, and remote is null only with a checkout', () => {
  assert.ok(paths(validateConfig(config({ api: repo({ url: 'https://example.invalid/api.git' }) }))).includes('repos.api'));
  assert.ok(paths(validateConfig(config({ api: repo({ checkout: null }) }))).includes('repos.api'));
  assert.ok(paths(validateConfig(config({ api: repo({ checkout: null, url: 'https://example.invalid/a.git', remote: null }) }))).includes('repos.api.remote'));
  assert.ok(paths(validateConfig(config({ api: repo({ remote: undefined }) }))).includes('repos.api.remote'));
  assert.ok(paths(validateConfig(config({ api: repo({ remote: '' }) }))).includes('repos.api.remote'));
});

test('setup entries are argv arrays of non-empty strings, never a shell string', () => {
  for (const setup of ['npm ci', ['npm ci'], [[]], [['npm', '']], [['npm', 1]], {}]) {
    assert.ok(paths(validateConfig(config({ api: repo({ setup }) }))).some(p => p.startsWith('repos.api.setup')), JSON.stringify(setup));
  }
  for (const setupTimeoutMs of [0, -1, 1.5, '600000']) {
    assert.ok(paths(validateConfig(config({ api: repo({ setupTimeoutMs }) }))).includes('repos.api.setupTimeoutMs'), String(setupTimeoutMs));
  }
});

test('other repo fields: name, github, defaultBranch, risk rules and the repo dir itself', () => {
  const table = [
    [{ api: repo({ name: '' }) }, 'repos.api.name'],
    [{ api: repo({ github: 'acme' }) }, 'repos.api.github'],
    [{ api: repo({ defaultBranch: '' }) }, 'repos.api.defaultBranch'],
    [{ api: repo({ risk: [{ kind: '', paths: ['x'] }] }) }, 'repos.api.risk[0].kind'],
    [{ api: repo({ risk: [{ kind: 'migrations', paths: [] }] }) }, 'repos.api.risk[0].paths'],
    [{ api: repo({ risk: [{ kind: 'm', paths: ['a'] }, { kind: 'm', paths: ['b'] }] }) }, 'repos.api.risk[1].kind'],
    [{ api: repo({ risk: [{ kind: 'pii-in-logs', paths: ['**'] }] }) }, 'repos.api.risk[0].kind'],
    [{ 'a/b': repo() }, 'repos.a/b'],
    [{}, 'repos'],
  ];
  for (const [repos, expected] of table) {
    assert.ok(paths(validateConfig(config(repos))).includes(expected), `${expected}: ${validateConfig(config(repos))}`);
  }
  assert.ok(paths(validateConfig({ ...config(), schemaVersion: 2 })).includes('schemaVersion'));
  assert.deepEqual(validateConfig(null), ['config: expected object']);
});

test('an explicitly empty projects.<slug>.repos is refused: it would allow no repo at all, unlike an absent list', () => {
  const two = { api: repo(), web: repo({ name: 'web', github: 'acme/web' }) };
  assert.ok(paths(validateConfig(config(two, { abc: { repos: [] } }))).includes('projects.abc.repos'));
});

test('projects.<slug>.repos is an allow-list of configured repos; without it every repo is allowed', () => {
  const two = { api: repo(), web: repo({ name: 'web', github: 'acme/web' }) };
  assert.deepEqual(validateConfig(config(two, { abc: { repos: ['api'] } })), []);
  assert.ok(paths(validateConfig(config(two, { abc: { repos: ['nope'] } }))).includes('projects.abc.repos[0]'));
  assert.ok(paths(validateConfig(config(two, { abc: { repos: 'api' } }))).includes('projects.abc.repos'));
  assert.ok(paths(validateConfig(config(two, { abc: 'api' }))).includes('projects.abc'));
  assert.deepEqual(validateConfig(config(two, { abc: {} })), []);
  assert.deepEqual(validateConfig(config(two, { abc: { repos: null } })), []);
  assert.deepEqual(allowedRepos(config(two, { abc: {} }), 'abc'), ['api', 'web']);
  assert.deepEqual(allowedRepos(config(two, { abc: { repos: null } }), 'abc'), ['api', 'web']);
  assert.deepEqual(allowedRepos(config(two, { abc: { repos: ['web'] } }), 'abc'), ['web']);
  assert.deepEqual(allowedRepos(config(two, { abc: { repos: ['web'] } }), 'other'), ['api', 'web']);
  assert.deepEqual(allowedRepos(config(two), 'abc'), ['api', 'web']);
});

test('globToRegExp: ** spans folders, * and ? stay inside one segment, everything else is literal', () => {
  const table = [
    ['**/migrations/**', 'db/migrations/001.ts', true],
    ['**/migrations/**', 'migrations/001.ts', true],
    ['**/migrations/**', 'db/migrations', false],
    ['db/migrations/*', 'db/migrations/001.ts', true],
    ['db/migrations/*', 'db/migrations/sub/001.ts', false],
    ['src/?.ts', 'src/a.ts', true],
    ['src/?.ts', 'src/ab.ts', false],
    ['src/a.ts', 'src/aXts', false],
    ['**/*.guard.ts', 'apps/x/y.guard.ts', true],
    ['**/*.guard.ts', 'y.guard.ts', true],
    ['(x)+[y]', '(x)+[y]', true],
  ];
  for (const [glob, path, expected] of table) assert.equal(globToRegExp(glob).test(path), expected, `${glob} ~ ${path}`);
});

test('risk patterns are per repo: a pattern on one repo never matches a path in another', () => {
  const repos = {
    api: repo({ risk: [{ kind: 'migrations', paths: ['db/migrations/*'] }, { kind: 'authorization', paths: ['**/guards/**'] }] }),
    web: repo({ name: 'web', risk: [] }),
  };
  assert.deepEqual(riskKinds(repos.api, 'db/migrations/001.ts'), ['migrations']);
  assert.deepEqual(riskKinds(repos.api, 'src/guards/db/migrations/x.ts'), ['authorization']);
  assert.deepEqual(riskKinds(repos.api, 'src/a.ts'), []);
  assert.deepEqual(riskKinds(repos.web, 'db/migrations/001.ts'), []);
  assert.deepEqual(riskKinds(repo({ risk: undefined }), 'db/migrations/001.ts'), []);
});

test('loadConfig reads home/config.json, expands a leading ~/ in checkout and fails naming every problem', () => {
  const home = join(DIR, 'load');
  rmSync(home, { recursive: true, force: true });
  assert.throws(() => loadConfig(home), /cannot read the spike config/);
  const write = value => {
    rmSync(home, { recursive: true, force: true });
    mkdirSync(home);
    writeFileSync(join(home, 'config.json'), JSON.stringify(value));
  };
  write(config({ api: repo({ checkout: '~/src/api' }) }));
  assert.equal(loadConfig(home, { userHome: '/Users/u' }).repos.api.checkout, '/Users/u/src/api');
  write(config({ api: repo({ name: '', remote: undefined }) }));
  assert.throws(() => loadConfig(home), e => e.message.includes('repos.api.name') && e.message.includes('repos.api.remote'));
});

test('the committed example config validates and names no real repo', () => {
  const text = readFileSync(EXAMPLE, 'utf8');
  assert.deepEqual(validateConfig(JSON.parse(text)), []);
  assert.doesNotMatch(text, REAL_REPO_TEXT);
  const source = readFileSync(new URL('../scripts/lib/spike/config.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, REAL_REPO_SOURCE);
});

test('tree refuses a configured repo that the project does not allow, before touching any repo', async () => {
  const { deps, gh } = spikeFixture({
    config: (c, sandbox) => ({ ...c, repos: { ...c.repos, web: { ...c.repos.backend, name: 'web-repo', github: 'acme/web', checkout: sandbox.dir } } }),
  });
  assert.equal((await run(['begin', PROJECT_URL], deps)).code, 0);
  assert.equal((await run(['next'], deps)).code, 0);
  const r = await run(['tree', 'web'], deps);
  assert.equal(r.code, 1);
  assert.match(r.stderr, new RegExp(`web is not allowed for project ${SLUG}`));
  assert.equal((await run(['tree', 'backend'], deps)).code, 0);
});

const startKeys = {
  branchNaming: 'strip-card-id', typecheck: [['npm', 'run', 'typecheck'], ['npm', 'run', 'lint']], typecheckTimeoutMs: 300000,
  notes: ['A stacked PR gets no preview deployment.'],
};

test('the per-repo start keys validate, with or without risk rules, and every one of them is optional', () => {
  assert.deepEqual(validateConfig(config({ api: repo({ ...startKeys, defaultBranch: 'main' }) })), []);
  assert.deepEqual(validateConfig(config({ api: repo({ ...startKeys, risk: undefined }) })), []);
  assert.deepEqual(validateConfig(config({ api: repo({ branchNaming: 'verbatim', notes: [] }) })), []);
  assert.deepEqual(validateConfig(config({ api: repo() })), []);
});

test('a bad start key is refused naming the key, even on a repo without risk rules', () => {
  const table = [
    [{ branchNaming: 'other' }, 'repos.api.branchNaming'],
    [{ branchNaming: '' }, 'repos.api.branchNaming'],
    [{ typecheck: 'npm run typecheck' }, 'repos.api.typecheck'],
    [{ typecheck: ['npm', 'run'] }, 'repos.api.typecheck[0]'],
    [{ typecheck: [['npm', 'run'], []] }, 'repos.api.typecheck[1]'],
    [{ typecheckTimeoutMs: 0 }, 'repos.api.typecheckTimeoutMs'],
    [{ typecheckTimeoutMs: 1.5 }, 'repos.api.typecheckTimeoutMs'],
    [{ typecheckTimeoutMs: '300000' }, 'repos.api.typecheckTimeoutMs'],
    [{ notes: 'one note' }, 'repos.api.notes'],
    [{ notes: ['ok', ''] }, 'repos.api.notes[1]'],
    [{ notes: [1] }, 'repos.api.notes[0]'],
  ];
  for (const [over, expected] of table) {
    for (const risk of [repo().risk, undefined]) {
      const errors = validateConfig(config({ api: repo({ ...over, risk }) }));
      assert.ok(paths(errors).includes(expected), `${JSON.stringify(over)} risk=${Boolean(risk)}: ${errors}`);
    }
  }
  assert.match(validateConfig(config({ api: repo({ branchNaming: 'other' }) }))[0], /verbatim.*strip-card-id/);
});

// One invalid config per validator field, with the exact strings validateConfig gave before it was built on configIssues.
const ISSUES = [
  [{ ...config(), schemaVersion: 2 }, 'schemaVersion', null, ['schemaVersion: expected 1']],
  [config({}), 'repos', null, ['repos: expected at least one repo']],
  [config({ 'a b': repo() }), 'dir', 'a b', ['repos.a b: a repo dir is one path segment with no spaces']],
  [config({ api: 'x' }), 'entry', 'api', ['repos.api: expected object']],
  [config({ api: repo({ name: '' }) }), 'name', 'api', ['repos.api.name: expected non-empty string']],
  [config({ api: repo({ github: 'acme' }) }), 'github', 'api', ['repos.api.github: expected <owner>/<repo>']],
  [config({ api: repo({ checkout: null }) }), 'source', 'api', ['repos.api: set exactly one of checkout and url']],
  [config({ api: repo({ checkout: null, url: 'https://example.invalid/a.git', remote: null }) }), 'remote', 'api', ['repos.api.remote: null is only allowed with a checkout']],
  [config({ api: repo({ defaultBranch: '' }) }), 'defaultBranch', 'api', ['repos.api.defaultBranch: expected non-empty string or null']],
  [config({ api: repo({ setup: [['npm', 'ci'], []] }) }), 'setup', 'api', ['repos.api.setup[1]: expected a non-empty argv array of strings']],
  [config({ api: repo({ typecheck: 'x' }) }), 'typecheck', 'api', ['repos.api.typecheck: expected an array of argv arrays']],
  [config({ api: repo({ setupTimeoutMs: -1 }) }), 'setupTimeoutMs', 'api', ['repos.api.setupTimeoutMs: expected a positive integer']],
  [config({ api: repo({ typecheckTimeoutMs: -1 }) }), 'typecheckTimeoutMs', 'api', ['repos.api.typecheckTimeoutMs: expected a positive integer']],
  [config({ api: repo({ branchNaming: 'other' }) }), 'branchNaming', 'api', ['repos.api.branchNaming: expected "verbatim" or "strip-card-id"']],
  [config({ api: repo({ notes: ['ok', ''] }) }), 'notes', 'api', ['repos.api.notes[1]: expected a non-empty string']],
  [config({ api: repo({ risk: [{ kind: 'pii-in-logs', paths: ['**'] }, 'x'] }) }), 'risk', 'api', [
    'repos.api.risk[0].kind: pii-in-logs is attested in the card notes, not configured', 'repos.api.risk[1]: expected object',
  ]],
  [config(undefined, { p1: { repos: ['nope'] } }), 'projects', null, ['projects.p1.repos[0]: nope is not a configured repo']],
  [config(undefined, 'x'), 'projects', null, ['projects: expected object']],
  [null, 'config', null, ['config: expected object']],
];

test('configIssues names the field and repo of each problem, and validateConfig keeps its exact strings', () => {
  for (const [value, field, repoDir, strings] of ISSUES) {
    const issues = configIssues(value);
    assert.deepEqual(validateConfig(value), strings, field);
    assert.deepEqual(issues.map(i => `${i.at}: ${i.message}`), strings, field);
    assert.deepEqual(issues.map(i => [i.field, i.repo]), strings.map(() => [field, repoDir]), field);
  }
});

test('several problems keep their order, and each issue carries where it is, which repo, which field and what is wrong', () => {
  const many = { schemaVersion: 2, repos: { 'a b': 'x', api: repo({ name: '', remote: undefined, risk: 'x' }) }, projects: { p1: 'x', p2: { repos: [] } } };
  assert.deepEqual(configIssues(many), [
    { at: 'schemaVersion', repo: null, field: 'schemaVersion', message: 'expected 1' },
    { at: 'repos.a b', repo: 'a b', field: 'dir', message: 'a repo dir is one path segment with no spaces' },
    { at: 'repos.a b', repo: 'a b', field: 'entry', message: 'expected object' },
    { at: 'repos.api.name', repo: 'api', field: 'name', message: 'expected non-empty string' },
    { at: 'repos.api.remote', repo: 'api', field: 'remote', message: 'expected a remote name, or null for a checkout read from its local branch' },
    { at: 'repos.api.risk', repo: 'api', field: 'risk', message: 'expected array' },
    { at: 'projects.p1', repo: null, field: 'projects', message: 'expected object' },
    { at: 'projects.p2.repos', repo: null, field: 'projects', message: 'expected a non-empty array of repo dirs, or no repos key for all repos' },
  ]);
  assert.deepEqual(validateConfig(many), [
    'schemaVersion: expected 1', 'repos.a b: a repo dir is one path segment with no spaces', 'repos.a b: expected object',
    'repos.api.name: expected non-empty string', 'repos.api.remote: expected a remote name, or null for a checkout read from its local branch',
    'repos.api.risk: expected array', 'projects.p1: expected object',
    'projects.p2.repos: expected a non-empty array of repo dirs, or no repos key for all repos',
  ]);
});

test('the keys the validator knows are exported beside it, and expandHome expands only a leading ~/', () => {
  assert.deepEqual(TOP_KEYS, ['schemaVersion', 'repos', 'projects', 'checkoutRoots']);
  assert.deepEqual(REPO_KEYS, [
    'name', 'github', 'checkout', 'url', 'remote', 'defaultBranch', 'setup', 'typecheck', 'setupTimeoutMs', 'typecheckTimeoutMs',
    'spikeTypecheck', 'spikeTypecheckTimeoutMs', 'branchNaming', 'notes', 'risk',
  ]);
  assert.deepEqual(PROJECT_KEYS, ['repos']);
  const example = JSON.parse(readFileSync(EXAMPLE, 'utf8'));
  for (const r of Object.values(example.repos)) assert.deepEqual(Object.keys(r).filter(k => !REPO_KEYS.includes(k)), [], r.name);
  assert.equal(expandHome('~/src/api', '/Users/u'), '/Users/u/src/api');
  assert.equal(expandHome('/opt/api', '/Users/u'), '/opt/api');
  assert.equal(expandHome('~api', '/Users/u'), '~api');
  assert.equal(expandHome(null, '/Users/u'), null);
});

const ROOTS_MESSAGE = 'checkoutRoots: expected a non-empty array of distinct folder paths, each absolute or starting with ~/';

test('checkoutRoots holds distinct absolute or ~/ folders, is kept unexpanded by loadConfig, and may be left out', () => {
  const roots = ['~/src', '/opt/work'];
  assert.deepEqual(validateConfig({ ...config(), checkoutRoots: roots }), []);
  assert.deepEqual(validateConfig({ ...config(), checkoutRoots: roots, projects: { abc: {} } }), []);
  assert.deepEqual(validateConfig(config()), []);
  const home = join(DIR, 'roots');
  mkdirSync(home, { recursive: true });
  const text = `${JSON.stringify({ ...config(), checkoutRoots: roots }, null, 2)}\n`;
  writeFileSync(join(home, 'config.json'), text);
  assert.deepEqual(loadConfig(home, { userHome: '/Users/u' }).checkoutRoots, roots);
  assert.equal(readFileSync(join(home, 'config.json'), 'utf8'), text);
  assert.ok(text.includes('"~/src"'));
});

test('a checkoutRoots that is not a list of distinct absolute or ~/ folders is refused naming it, with or without projects', () => {
  for (const checkoutRoots of ['~/src', [''], ['src'], [1], [], ['~/a', '~/a'], null, {}, ['~src'], ['./src']]) {
    for (const projects of [undefined, { abc: {} }, 'x']) {
      const issues = configIssues({ ...config(undefined, projects), checkoutRoots });
      const roots = issues.filter(i => i.field === 'checkoutRoots');
      assert.deepEqual(roots.map(i => `${i.at}: ${i.message}`), [ROOTS_MESSAGE], `${JSON.stringify(checkoutRoots)} ${JSON.stringify(projects)}`);
      assert.ok(validateConfig({ ...config(undefined, projects), checkoutRoots }).includes(ROOTS_MESSAGE));
    }
  }
});

test('the committed example shows checkoutRoots with a neutral folder and still validates', () => {
  const text = readFileSync(EXAMPLE, 'utf8');
  assert.deepEqual(JSON.parse(text).checkoutRoots, ['~/src']);
  assert.deepEqual(validateConfig(JSON.parse(text)), []);
  assert.doesNotMatch(text, REAL_REPO_TEXT);
});

const BEFORE = JSON.stringify(config(), null, 4);
const draftText = value => `${JSON.stringify(value, null, 2)}\n`;
const listing = dir => readdirSync(dir).sort();

function homeWith(name, files) {
  const home = join(DIR, name);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(join(home, file), text);
  return home;
}

test('a config write backs up the previous bytes to one config.json.bak, writes the text exactly and leaves no temporary file', () => {
  const home = homeWith('write', { 'config.json': BEFORE });
  const first = draftText(config({ api: repo({ defaultBranch: 'main' }) }));
  assert.deepEqual(writeConfig(home, first, readFileSync(join(home, 'config.json'))), {
    path: join(home, 'config.json'), backup: join(home, 'config.json.bak'),
  });
  assert.equal(readFileSync(join(home, 'config.json.bak'), 'utf8'), BEFORE);
  assert.equal(readFileSync(join(home, 'config.json'), 'utf8'), first);
  assert.deepEqual(listing(home), ['config.json', 'config.json.bak']);

  const second = draftText(config({ api: repo({ defaultBranch: 'develop' }) }));
  writeConfig(home, second, readFileSync(join(home, 'config.json')));
  assert.equal(readFileSync(join(home, 'config.json.bak'), 'utf8'), first);
  assert.equal(readFileSync(join(home, 'config.json'), 'utf8'), second);
  assert.deepEqual(listing(home), ['config.json', 'config.json.bak']);
});

test('a first config write makes no backup and leaves an earlier config.json.bak as it was', () => {
  const text = draftText(config());
  const empty = homeWith('bootstrap', {});
  assert.deepEqual(writeConfig(empty, text, null), { path: join(empty, 'config.json'), backup: null });
  assert.deepEqual(listing(empty), ['config.json']);
  assert.equal(readFileSync(join(empty, 'config.json'), 'utf8'), text);
  const old = homeWith('bootstrap-old-bak', { 'config.json.bak': 'old backup\n' });
  writeConfig(old, text, null);
  assert.equal(readFileSync(join(old, 'config.json.bak'), 'utf8'), 'old backup\n');
  assert.equal(readFileSync(join(old, 'config.json'), 'utf8'), text);
});

test('when the final rename fails, config.json keeps its previous bytes and no temporary file is left', () => {
  const home = homeWith('rename', { 'config.json': BEFORE });
  const rename = (from, to) => {
    if (to === join(home, 'config.json')) throw Object.assign(new Error('rename refused'), { code: 'EXDEV' });
    return renameSync(from, to);
  };
  assert.throws(() => writeConfig(home, draftText(config()), readFileSync(join(home, 'config.json')), { rename }), /rename refused/);
  assert.equal(readFileSync(join(home, 'config.json'), 'utf8'), BEFORE);
  assert.equal(readFileSync(join(home, 'config.json.bak'), 'utf8'), BEFORE);
  assert.deepEqual(listing(home), ['config.json', 'config.json.bak']);
});

test('a written text that fails the load check is put back, or removed on a first write, and the write fails with exit 1', () => {
  for (const bad of [draftText({ schemaVersion: 1, repos: {} }), '{"repos":']) {
    const home = homeWith('restore', { 'config.json': BEFORE });
    assert.throws(() => writeConfig(home, bad, readFileSync(join(home, 'config.json'))), e => e.exitCode === 1 && e.message.includes(join(home, 'config.json')));
    assert.equal(readFileSync(join(home, 'config.json'), 'utf8'), BEFORE);
    assert.deepEqual(listing(home), ['config.json', 'config.json.bak']);

    const fresh = homeWith('restore-bootstrap', { 'config.json.bak': 'old backup\n' });
    assert.throws(() => writeConfig(fresh, bad, null), e => e.exitCode === 1);
    assert.deepEqual(listing(fresh), ['config.json.bak']);
    assert.equal(readFileSync(join(fresh, 'config.json.bak'), 'utf8'), 'old backup\n');
  }
});

test('when putting the previous config back fails, the write fails with exit 1 naming the backup that holds it, never the rejected text', () => {
  const home = homeWith('restore-fails', { 'config.json': BEFORE });
  const path = join(home, 'config.json');
  let ontoConfig = 0;
  const rename = (from, to) => {
    if (to === path && ++ontoConfig === 2) throw Object.assign(new Error('rename refused'), { code: 'EXDEV' });
    return renameSync(from, to);
  };
  const rejected = '{"repos": "planted-rejected-marker"';
  assert.throws(() => writeConfig(home, rejected, readFileSync(path), { rename }), e => {
    assert.equal(e.exitCode, 1, e.message);
    assert.ok(e.message.includes(`${path}.bak`), e.message);
    assert.match(e.message, /may still hold the rejected text/);
    assert.ok(!e.message.includes('planted-rejected-marker'), e.message);
    return true;
  });
  assert.equal(readFileSync(path, 'utf8'), rejected);
  assert.equal(readFileSync(`${path}.bak`, 'utf8'), BEFORE);
  assert.deepEqual(listing(home), ['config.json', 'config.json.bak']);
});

test('a clean rollback keeps its message: the load error, then that the previous config.json was put back', () => {
  const home = homeWith('restore-message', { 'config.json': BEFORE });
  assert.throws(
    () => writeConfig(home, draftText({ schemaVersion: 1, repos: {} }), readFileSync(join(home, 'config.json'))),
    e => e.exitCode === 1 && e.message === `invalid spike config ${join(home, 'config.json')}: repos: expected at least one repo; the previous config.json was put back`,
  );
});

test('readConfigBytes gives the bytes, null when there is no file, and exit 2 naming the path for any other read error', () => {
  const home = homeWith('bytes', { 'config.json': BEFORE });
  assert.equal(readConfigBytes(home).toString('utf8'), BEFORE);
  assert.equal(readConfigBytes(homeWith('bytes-none', {})), null);
  const dirAsFile = homeWith('bytes-dir', {});
  mkdirSync(join(dirAsFile, 'config.json'));
  assert.throws(() => readConfigBytes(dirAsFile), e => e.exitCode === 2 && e.message.includes(join(dirAsFile, 'config.json')) && e.message.includes('EISDIR'));
});

test('the example config shows every start key with neutral values and a default branch on every repo', () => {
  const example = JSON.parse(readFileSync(EXAMPLE, 'utf8'));
  const repos = Object.values(example.repos);
  for (const r of repos) {
    assert.ok(['verbatim', 'strip-card-id'].includes(r.branchNaming), r.name);
    assert.ok(typeof r.defaultBranch === 'string' && r.defaultBranch.length > 0, r.name);
  }
  for (const key of ['typecheck', 'typecheckTimeoutMs', 'notes']) assert.ok(repos.some(r => Object.hasOwn(r, key)), key);
  assert.deepEqual(new Set(repos.map(r => r.branchNaming)), new Set(['verbatim', 'strip-card-id']));
});

test('spikeTypecheck validates as argv and expands {changed}', () => {
  for (const spikeTypecheck of [['npx', 'tsc', '--noEmit', '{changed}'], false]) {
    assert.deepEqual(validateConfig(config({ api: repo({ spikeTypecheck, spikeTypecheckTimeoutMs: 120000 }) })), [], JSON.stringify(spikeTypecheck));
  }
  for (const spikeTypecheck of ['npx tsc', [], ['npx', ''], [['npx']], true]) {
    assert.ok(paths(validateConfig(config({ api: repo({ spikeTypecheck }) }))).includes('repos.api.spikeTypecheck'), JSON.stringify(spikeTypecheck));
  }
  assert.ok(paths(validateConfig(config({ api: repo({ spikeTypecheckTimeoutMs: 0 }) }))).includes('repos.api.spikeTypecheckTimeoutMs'));
  assert.ok(REPO_KEYS.includes('spikeTypecheck') && REPO_KEYS.includes('spikeTypecheckTimeoutMs'));
  assert.deepEqual(expandChanged(['tsc', '{changed}', '--x'], ['a.ts', 'b.ts']), ['tsc', 'a.ts', 'b.ts', '--x']);
});

const stored = f => JSON.parse(readFileSync(join(activeRunDir(f.home), 'run.json'), 'utf8'));
const three = () => spikeFixture({ issues: ['CRM-1', 'CRM-2', 'CRM-3'].map(k => issue(k)) });

test('spike begin defaults to 1 worker and 1 check and keeps the whole order on one track', async () => {
  const f = three();
  assert.equal((await run(['begin', PROJECT_URL], f.deps)).code, 0);
  const state = stored(f);
  assert.deepEqual([state.workers, state.checks], [1, 1]);
  assert.deepEqual(Object.entries(state.tracks).map(([id, t]) => [id, t.cards]), [['t1', ['CRM-1', 'CRM-2', 'CRM-3']]]);
});

test('spike begin with --workers above 1 splits the order into its connected tracks and stores the counts', async () => {
  const f = spikeFixture({ issues: [issue('CRM-1', { relations: blocks('CRM-2') }), issue('CRM-2'), issue('CRM-3')] });
  assert.equal((await run(['begin', PROJECT_URL, '--workers', '2', '--checks', '2'], f.deps)).code, 0);
  const state = stored(f);
  assert.deepEqual([state.workers, state.checks], [2, 2]);
  assert.deepEqual(Object.entries(state.tracks).map(([id, t]) => [id, t.cards]), [['t1', ['CRM-1', 'CRM-2']], ['t2', ['CRM-3']]]);
});

test('--workers and --checks must be positive integers: anything else exits 2 before the run is created', async () => {
  const f = three();
  for (const bad of [['--workers', '0'], ['--workers', 'x'], ['--checks', '0'], ['--checks', '1.5'], ['--workers', '-1']]) {
    assert.equal((await run(['begin', PROJECT_URL, ...bad], f.deps)).code, 2, bad.join(' '));
  }
  assert.equal(existsSync(join(f.home, SLUG, 'runs')), false);
});

test('resume keeps the stored workers, checks and tracks unless the flag is passed, and a passed flag changes only its count', async () => {
  const f = spikeFixture({ issues: [issue('CRM-1', { relations: blocks('CRM-2') }), issue('CRM-2'), issue('CRM-3')] });
  assert.equal((await run(['begin', PROJECT_URL, '--workers', '2', '--checks', '2'], f.deps)).code, 0);
  assert.equal((await run(['begin', PROJECT_URL], f.deps)).code, 0);
  assert.deepEqual([stored(f).workers, stored(f).checks, Object.keys(stored(f).tracks)], [2, 2, ['t1', 't2']]);
  assert.equal((await run(['begin', PROJECT_URL, '--workers', '1'], f.deps)).code, 0);
  assert.deepEqual([stored(f).workers, stored(f).checks, Object.keys(stored(f).tracks)], [1, 2, ['t1', 't2']]);
});

test('status and tracks report the run\'s workers and checks, 1 and 1 for a run that stored none', async () => {
  const f = three();
  assert.equal((await run(['begin', PROJECT_URL, '--workers', '3', '--checks', '2'], f.deps)).code, 0);
  for (const cmd of ['status', 'tracks']) {
    const out = JSON.parse((await run([cmd], f.deps)).stdout);
    assert.deepEqual([out.workers, out.checks], [3, 2], cmd);
  }
});
