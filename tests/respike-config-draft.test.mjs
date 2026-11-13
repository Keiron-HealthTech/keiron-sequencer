import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configIssues, validateConfig } from '../scripts/lib/spike/config.mjs';
import * as draft from '../scripts/lib/spike/config-draft.mjs';
import { mapRepo } from '../scripts/lib/start/checkout.mjs';
import { makeRepo, tempDir } from './helpers/git-sandbox.mjs';
import { guardNetwork } from './helpers/no-network.mjs';

guardNetwork();

const DIR = tempDir('keiron-sequencer-config-draft-');
after(() => rmSync(DIR, { recursive: true, force: true }));

const SENTINEL = ['planted', 'secret', 'value'].join('_');
// Short enough that a parser message would quote all of it.
const SHORT = ['pl', '4nt'].join('');
let homes = 0;
const homeWith = text => {
  const home = join(DIR, `home-${++homes}`);
  mkdirSync(home);
  if (text !== undefined) writeFileSync(join(home, 'config.json'), text);
  return home;
};

test('a home with no config file reads as absent', () => {
  assert.deepEqual(draft.readRawConfig(homeWith()), { state: 'absent' });
});

test('text that is not JSON, and an empty file, read as unparseable without echoing the file', () => {
  for (const text of [`{"r":${SHORT}`, `{"repos": ${SENTINEL}`, '', '   \n']) {
    const read = draft.readRawConfig(homeWith(text));
    assert.equal(read.state, 'unparseable', JSON.stringify(text));
    assert.equal(typeof read.error, 'string');
    assert.ok(read.error.length > 0);
    assert.ok(![SHORT, 'planted'].some(s => JSON.stringify(read).includes(s)), JSON.stringify(read));
    assert.ok(!('raw' in read) && !('bytes' in read));
  }
});

test('JSON whose root is not an object reads as not-object, carrying nothing of the file', () => {
  for (const text of ['[]', 'null', `"${SENTINEL}"`, '3', `[{"repos": "${SENTINEL}"}]`]) {
    assert.deepEqual(draft.readRawConfig(homeWith(text)), { state: 'not-object' }, text);
  }
});

test('a JSON object reads with its bytes, text, parsed value and validator issues, valid or not', () => {
  const valid = { schemaVersion: 1, repos: { api: { name: 'api', checkout: '~/src/api', remote: null } } };
  const invalid = { repos: { 'my api': 3 }, chekout: true };
  for (const value of [valid, invalid]) {
    const text = `${JSON.stringify(value, null, 4)}\n`;
    const read = draft.readRawConfig(homeWith(text));
    assert.equal(read.state, 'read');
    assert.ok(Buffer.isBuffer(read.bytes));
    assert.deepEqual(read.bytes, Buffer.from(text));
    assert.equal(read.text, text);
    assert.deepEqual(read.raw, value);
    assert.deepEqual(read.issues, configIssues(value));
  }
  assert.ok(draft.readRawConfig(homeWith(JSON.stringify(invalid))).issues.length > 0);
  assert.deepEqual(draft.readRawConfig(homeWith(JSON.stringify(valid))).raw.repos.api.checkout, '~/src/api');
});

// The planner's view of a raw file, checked here without the module's own validator.
const DIR_KEY = /^[^/\s]+$/;
const SLUG_FORM = /^[\w.-]+\/[\w.-]+$/;
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = v => typeof v === 'string' && v.length > 0;
const unsetOr = ok => v => v === null || v === undefined || ok(v);
const isGitDir = p => typeof p === 'string' && existsSync(join(p, '.git')) && statSync(p).isDirectory();
const riskOk = rules => Array.isArray(rules) && rules.every(r => isObj(r) && nonEmpty(r.kind) && r.kind !== 'pii-in-logs'
  && Array.isArray(r.paths) && r.paths.length > 0 && r.paths.every(nonEmpty)) && new Set(rules.map(r => r.kind)).size === rules.length;
const KEY_RULES = {
  name: unsetOr(nonEmpty),
  github: unsetOr(v => typeof v === 'string' && SLUG_FORM.test(v)),
  remote: unsetOr(nonEmpty),
  defaultBranch: unsetOr(nonEmpty),
  setup: unsetOr(v => Array.isArray(v) && v.every(a => Array.isArray(a) && a.length > 0 && a.every(nonEmpty))),
  risk: unsetOr(riskOk),
  checkout: unsetOr(isGitDir),
};

function planningProblems(config) {
  const problems = [];
  if (!isObj(config.repos)) return ['repos is not an object'];
  for (const [dir, entry] of Object.entries(config.repos)) {
    if (!DIR_KEY.test(dir)) problems.push(`${dir}: bad dir key kept`);
    if (!isObj(entry)) { problems.push(`${dir}: entry is not an object`); continue; }
    for (const [key, ok] of Object.entries(KEY_RULES)) if (!ok(entry[key])) problems.push(`${dir}.${key}: ${JSON.stringify(entry[key])}`);
    if (entry.checkout && entry.url) problems.push(`${dir}: both checkout and url`);
  }
  if (config.projects === undefined || config.projects === null) return problems;
  if (!isObj(config.projects)) return [...problems, 'projects is not an object'];
  for (const [slug, project] of Object.entries(config.projects)) {
    if (!isObj(project)) { problems.push(`projects.${slug} is not an object`); continue; }
    if (project.repos === undefined) continue;
    if (!Array.isArray(project.repos)) { problems.push(`projects.${slug}.repos is not a list`); continue; }
    for (const dir of project.repos) if (typeof dir !== 'string' || !Object.hasOwn(config.repos, dir)) problems.push(`projects.${slug}.repos names ${dir}`);
  }
  return problems;
}

test('the planning copy keeps only entries the planner can read, whatever the raw file holds', () => {
  const userHome = tempDir('keiron-sequencer-config-draft-userhome-');
  const otherHome = tempDir('keiron-sequencer-config-draft-otherhome-');
  after(() => { rmSync(userHome, { recursive: true, force: true }); rmSync(otherHome, { recursive: true, force: true }); });
  mkdirSync(join(userHome, 'src', 'api', '.git'), { recursive: true });
  const real = join(DIR, 'real-checkout');
  mkdirSync(join(real, '.git'), { recursive: true });
  const plain = join(DIR, 'plain-folder');
  mkdirSync(plain);
  const good = (over = {}) => ({ name: 'api', github: 'acme/api', checkout: real, url: null, remote: 'origin', defaultBranch: 'main', setup: [['npm', 'ci']], risk: [], ...over });
  const base = (repos, projects) => ({ schemaVersion: 1, repos, ...(projects === undefined ? {} : { projects }) });
  const cases = [
    ['a bad dir key', base({ 'my api': good(), api: good() }), c => assert.deepEqual(Object.keys(c.repos), ['api'])],
    ['entries that are not objects', base({ a: 3, b: null, c: [], d: 'x', api: good() }), c => assert.deepEqual(Object.keys(c.repos), ['api'])],
    ['repos that is a list', base([good()]), c => assert.deepEqual(c.repos, {})],
    ['repos that is a string', base('api'), c => assert.deepEqual(c.repos, {})],
    ['no repos key', { schemaVersion: 1 }, c => assert.deepEqual(c.repos, {})],
    ['a checkout folder with no .git', base({ api: good({ checkout: plain }) }), c => assert.equal(c.repos.api.checkout, null)],
    ['a checkout that does not exist', base({ api: good({ checkout: join(DIR, 'nowhere') }) }), c => assert.equal(c.repos.api.checkout, null)],
    ['checkouts that are not paths', base({ a: good({ checkout: 5 }), b: good({ checkout: {} }), c: good({ checkout: '' }) }), c => {
      for (const dir of ['a', 'b', 'c']) assert.equal(c.repos[dir].checkout, null, dir);
    }],
    ['a ~/ checkout under the given home', base({ api: good({ checkout: '~/src/api' }) }), c => assert.equal(c.repos.api.checkout, join(userHome, 'src', 'api'))],
    ['a ~/ checkout the given home lacks', base({ api: good({ checkout: '~/src/api' }) }), c => assert.equal(c.repos.api.checkout, null), otherHome],
    ['a real checkout and a url', base({ api: good({ url: 'https://example.com/acme/api.git' }) }), c => {
      assert.equal(c.repos.api.checkout, real);
      assert.equal(c.repos.api.url, null);
    }],
    ['a bogus checkout and a url', base({ api: good({ checkout: plain, url: 'https://example.com/acme/api.git' }) }), c => {
      assert.equal(c.repos.api.checkout, null);
      assert.equal(c.repos.api.url, 'https://example.com/acme/api.git');
    }],
    ['invalid named keys', base({
      api: good({ name: 3, github: 'not a slug', remote: '', defaultBranch: 5, setup: 'npm ci', risk: 'x' }),
      web: good({ name: 'web', remote: 7, setup: [[]], risk: [{ kind: 'pii-in-logs', paths: ['**'] }] }),
      job: good({ name: 'job', risk: [{ kind: 'migrations', paths: ['a'] }, { kind: 'migrations', paths: ['b'] }] }),
    }), c => {
      for (const key of ['name', 'github', 'remote', 'defaultBranch', 'setup', 'risk']) assert.equal(c.repos.api[key], null, key);
      for (const key of ['remote', 'setup', 'risk']) assert.equal(c.repos.web[key], null, key);
      assert.equal(c.repos.job.risk, null);
    }],
    ['valid named keys', base({ api: good() }), c => assert.deepEqual(c.repos.api, good())],
    ['project lists that are not lists, or empty', base({ api: good() }, { s: { repos: 'api' }, t: { repos: [] }, u: { repos: null }, v: 3 }), c => {
      assert.deepEqual(c.projects, { s: {}, t: {}, u: {} });
    }],
    ['projects that is not an object', base({ api: good() }, 'x'), c => assert.equal(c.projects, undefined)],
    ['a list naming a dropped or unknown dir', base({ api: good(), 'my web': good() }, { s: { repos: ['api', 'my web', 'job', 4] } }), c => {
      assert.deepEqual(c.projects.s.repos, ['api']);
    }],
    ['a list naming only dropped dirs keeps its emptiness', base({ api: good(), web: 3 }, { s: { repos: ['web'] } }), c => {
      assert.deepEqual(c.projects.s.repos, []);
    }],
  ];
  for (const [name, raw, check, home = userHome] of cases) {
    const before = structuredClone(raw);
    const planned = draft.planningConfig(raw, { userHome: home });
    assert.deepEqual(planningProblems(planned), [], name);
    check(planned);
    assert.deepEqual(raw, before, `${name}: the raw value is unchanged`);
  }
});

test('the planning copy asks the injected check whether a checkout is real', () => {
  const asked = [];
  const raw = { schemaVersion: 1, repos: { api: { name: 'api', checkout: '~/x/api', remote: 'origin' } } };
  const planned = draft.planningConfig(raw, { userHome: '/u', isCheckout: path => { asked.push(path); return true; } });
  assert.deepEqual(asked, [join('/u', 'x', 'api')]);
  assert.equal(planned.repos.api.checkout, join('/u', 'x', 'api'));
});

const deepFreeze = value => {
  if (value !== null && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
};

test('keys the config does not know are reported with the known key they are likely a typo of', () => {
  const raw = deepFreeze({
    schemaVersion: 1,
    projcts: {},
    zzz: 1,
    SCHEMAVERSION: 1,
    repos: { web: { name: 'web', chekout: '~/src/web', DEFAULTBRANCH: 'main', zzz: true }, bad: 3, 'my api': { nmae: 'api' } },
    projects: { s: { repo: ['web'] }, t: 'x' },
  });
  assert.deepEqual(draft.strayKeys(raw), [
    { path: 'projcts', suggestion: 'projects' },
    { path: 'zzz', suggestion: null },
    { path: 'SCHEMAVERSION', suggestion: 'schemaVersion' },
    { path: 'repos.web.chekout', suggestion: 'checkout' },
    { path: 'repos.web.DEFAULTBRANCH', suggestion: 'defaultBranch' },
    { path: 'repos.web.zzz', suggestion: null },
    { path: 'repos.my api.nmae', suggestion: 'name' },
    { path: 'projects.s.repo', suggestion: 'repos' },
  ]);
});

test('a config holding only known keys has no stray key, whatever its repos and projects hold', () => {
  assert.deepEqual(draft.strayKeys({ schemaVersion: 1, repos: { api: { name: 'api', checkout: '/x', setup: [], risk: [] } }, projects: { s: { repos: ['api'] } }, checkoutRoots: ['/r'] }), []);
  assert.deepEqual(draft.strayKeys({ repos: [{ chekout: 1 }], projects: [{ repo: 1 }] }), []);
  assert.deepEqual(draft.strayKeys({ repos: 'x', projects: null }), []);
});

test('the approval hash is 12 hex over the base bytes and the draft text, and a missing base differs from an empty one', () => {
  const base = Buffer.from('{"schemaVersion":1}\n');
  const text = '{\n  "schemaVersion": 1\n}\n';
  const hash = draft.draftHash(base, text);
  assert.match(hash, /^[0-9a-f]{12}$/);
  assert.equal(draft.draftHash(Buffer.from(base), text), hash);
  assert.notEqual(draft.draftHash(Buffer.from('{"schemaVersion":2}\n'), text), hash);
  assert.notEqual(draft.draftHash(base, text.replace('1', '2')), hash);
  assert.notEqual(draft.draftHash(null, text), draft.draftHash(Buffer.alloc(0), text));
  assert.match(draft.draftHash(null, text), /^[0-9a-f]{12}$/);
});

test('credentials in a URL are masked, every URL in the text, and an scp-like remote is left as it is', () => {
  const cases = [
    ['https://user:tok@host/x', 'https://***@host/x'],
    ['ssh://user@host/x', 'ssh://***@host/x'],
    ['HTTPS://user:tok@host/x', 'HTTPS://***@host/x'],
    ['https://user:p@ss@host/x', 'https://***@host/x'],
    ['a https://u:t@one/x and ssh://v@two/y', 'a https://***@one/x and ssh://***@two/y'],
    ['{"url":"https://u:t@host/x.git","n":1}', '{"url":"https://***@host/x.git","n":1}'],
    ['git@github.com:o/n.git', 'git@github.com:o/n.git'],
    ['https://github.com/o/n.git', 'https://github.com/o/n.git'],
    ['{"a":"https://host","mail":"a@b"}', '{"a":"https://host","mail":"a@b"}'],
    ['{"a":"https://host/x","mail":"a@b"}', '{"a":"https://host/x","mail":"a@b"}'],
  ];
  for (const [text, want] of cases) assert.equal(draft.redactUrls(text), want, text);
});

test('credentials holding a quote or a backslash are masked in JSON text, once or twice serialized', () => {
  const url = 'https://u:pa"ss\\w@host/x';
  for (const text of [JSON.stringify({ url }), JSON.stringify({ diff: [JSON.stringify({ url })] }), JSON.stringify({ url: 'https://u:end\\' + '@host/x', mail: 'a@b' })]) {
    const shown = draft.redactUrls(text);
    assert.doesNotMatch(shown, /u:pa|ss|u:end/);
    assert.match(shown, /https:\/\/\*\*\*@host\/x/);
  }
  assert.equal(draft.redactUrls('{"a":"https://host\\\\","mail":"a@b"}'), '{"a":"https://host\\\\","mail":"a@b"}');
});

test('credentials in a plain text message are masked whole, a raw quote or backslash in them included', () => {
  const cases = [
    ['repos.https://x-token:SECA"SECB@github.com: a repo dir is one path segment with no spaces', 'repos.https://***@github.com: a repo dir is one path segment with no spaces'],
    ['projects.p.repos[1]: https://u:a\\b"c@host/x is not a configured repo', 'projects.p.repos[1]: https://***@host/x is not a configured repo'],
    ["--root ssh://u:p'q@host/x is not an existing folder", '--root ssh://***@host/x is not an existing folder'],
    ['https://u:p@ss@host/x; https://v:w@two/y', 'https://***@host/x; https://***@two/y'],
    ['git@github.com:o/n.git and https://github.com/o/n.git', 'git@github.com:o/n.git and https://github.com/o/n.git'],
    ['a https://host and mail a@b', 'a https://host and mail a@b'],
  ];
  for (const [text, want] of cases) assert.equal(draft.redactText(text), want, text);
});

test('a draft path in the home, the data dir or a git work tree is refused with exit 2, whatever is there yet', () => {
  const base = tempDir('keiron-sequencer-config-draft-paths-');
  const repo = makeRepo();
  after(() => { rmSync(base, { recursive: true, force: true }); repo.dispose(); });
  const home = join(base, 'home');
  const dataDir = join(base, 'data');
  mkdirSync(home);
  mkdirSync(dataDir);
  writeFileSync(join(home, 'config.json'), '{}');
  writeFileSync(join(home, 'config.json.bak'), '{}');
  const refused = [
    [home, /spike home/], [join(home, 'config.json'), /spike home/], [join(home, 'config.json.bak'), /spike home/],
    [join(home, 'draft.json'), /spike home/], [join(home, 'new', 'deeper', 'draft.json'), /spike home/], [join(home, 'config.json', 'draft.json'), /spike home/],
    [dataDir, /data dir/], [join(dataDir, 'draft.json'), /data dir/], [join(dataDir, 'new', 'draft.json'), /data dir/],
    [join(repo.dir, 'draft.json'), /work tree/], [join(repo.dir, 'src', 'new', 'draft.json'), /work tree/],
  ];
  for (const [path, why] of refused) {
    assert.throws(() => draft.assertDraftPath(path, { home, dataDir }), e => e.exitCode === 2 && why.test(e.message) && e.message.includes(path), path);
  }
});

test('a draft path in a scratch folder is accepted and given back resolved, and a sibling of the home is not inside it', () => {
  const base = tempDir('keiron-sequencer-config-draft-paths-');
  after(() => rmSync(base, { recursive: true, force: true }));
  const home = join(base, 'home');
  const dataDir = join(base, 'data');
  const scratch = join(base, 'scratch');
  for (const dir of [home, dataDir, scratch]) mkdirSync(dir);
  for (const path of [join(scratch, 'draft-1.json'), join(scratch, 'new', 'draft.json'), join(`${home}-2`, 'draft.json'), join(`${dataDir}x`, 'draft.json')]) {
    assert.equal(draft.assertDraftPath(path, { home, dataDir }), path);
  }
});

test('two spellings of one folder agree, through a symlink and through the system temp folder', () => {
  const base = tempDir('keiron-sequencer-config-draft-paths-');
  const links = tempDir('keiron-sequencer-config-draft-links-');
  after(() => { rmSync(base, { recursive: true, force: true }); rmSync(links, { recursive: true, force: true }); });
  const home = join(base, 'home');
  const dataDir = join(base, 'data');
  mkdirSync(home);
  mkdirSync(dataDir);
  const alias = join(links, 'alias');
  symlinkSync(base, alias);
  const refuses = (path, dirs) => assert.throws(() => draft.assertDraftPath(path, dirs), e => e.exitCode === 2, path);
  refuses(join(alias, 'home', 'draft.json'), { home, dataDir });
  refuses(join(home, 'draft.json'), { home: join(alias, 'home'), dataDir });
  refuses(join(alias, 'data', 'new', 'draft.json'), { home, dataDir });
  refuses(join(dataDir, 'draft.json'), { home, dataDir: join(alias, 'data', '.') });
  assert.equal(draft.assertDraftPath(join(alias, 'scratch.json'), { home, dataDir }), join(base, 'scratch.json'));

  const raw = mkdtempSync(join(tmpdir(), 'keiron-sequencer-config-draft-raw-'));
  after(() => rmSync(raw, { recursive: true, force: true }));
  const real = realpathSync(raw);
  mkdirSync(join(raw, 'home'));
  refuses(join(real, 'home', 'draft.json'), { home: join(raw, 'home'), dataDir });
  refuses(join(raw, 'home', 'draft.json'), { home: join(real, 'home'), dataDir });
  refuses(join(raw, 'home-not-yet', 'draft.json'), { home: join(real, 'home-not-yet'), dataDir });
});

test('the change list names each added, set and removed path, compares lists whole, and ignores key order', () => {
  const before = {
    schemaVersion: 1,
    repos: {
      api: { name: 'api', url: 'https://example.com/acme/api.git', checkout: null, setup: [['npm', 'ci']], risk: [], chekout: '~/x' },
      old: { name: 'old', checkout: '/o' },
    },
    stray: 1,
  };
  const after = {
    schemaVersion: 1,
    repos: {
      api: { name: 'api', url: null, checkout: '~/src/api', setup: [['npm', 'ci'], ['npm', 'run', 'build']], risk: [], github: 'acme/api' },
      web: { name: 'web' },
    },
    checkoutRoots: ['~/src'],
  };
  assert.deepEqual(draft.changesBetween(before, after), [
    { op: 'set', path: 'repos.api.url', before: 'https://example.com/acme/api.git', after: null },
    { op: 'set', path: 'repos.api.checkout', before: null, after: '~/src/api' },
    { op: 'set', path: 'repos.api.setup', before: [['npm', 'ci']], after: [['npm', 'ci'], ['npm', 'run', 'build']] },
    { op: 'add', path: 'repos.api.github', after: 'acme/api' },
    { op: 'remove', path: 'repos.api.chekout', before: '~/x' },
    { op: 'add', path: 'repos.web', after: { name: 'web' } },
    { op: 'remove', path: 'repos.old', before: { name: 'old', checkout: '/o' } },
    { op: 'add', path: 'checkoutRoots', after: ['~/src'] },
    { op: 'remove', path: 'stray', before: 1 },
  ]);
  assert.deepEqual(draft.changesBetween({ a: null }, { a: { b: 1 } }), [{ op: 'set', path: 'a', before: null, after: { b: 1 } }]);
  assert.deepEqual(draft.changesBetween({ a: { b: 1 } }, { a: null }), [{ op: 'set', path: 'a', before: { b: 1 }, after: null }]);
  assert.deepEqual(draft.changesBetween({ a: [1, 2] }, { a: [2, 1] }), [{ op: 'set', path: 'a', before: [1, 2], after: [2, 1] }]);
  assert.deepEqual(draft.changesBetween({ a: 1, b: { c: 1, d: [{ x: 1, y: 2 }] } }, { b: { d: [{ y: 2, x: 1 }], c: 1 }, a: 1 }), []);
  assert.deepEqual(draft.changesBetween(null, { schemaVersion: 1, repos: {} }), [
    { op: 'add', path: 'schemaVersion', after: 1 },
    { op: 'add', path: 'repos', after: {} },
  ]);
});

const numbered = (n, over = {}) => `${Array.from({ length: n }, (_, i) => over[i + 1] ?? `L${i + 1}`).join('\n')}\n`;

test('the line diff marks removed, added and context lines, with two lines of context around each change', () => {
  assert.deepEqual(draft.lineDiff(numbered(10), numbered(10)), []);
  assert.deepEqual(draft.lineDiff(numbered(10), numbered(10, { 5: 'X' })), ['  L3', '  L4', '- L5', '+ X', '  L6', '  L7']);
  assert.deepEqual(draft.lineDiff(numbered(10), numbered(10, { 4: 'X', 7: 'Y' })), [
    '  L2', '  L3', '- L4', '+ X', '  L5', '  L6', '- L7', '+ Y', '  L8', '  L9',
  ]);
  assert.deepEqual(draft.lineDiff(numbered(10), numbered(10, { 2: 'X', 9: 'Y' })), [
    '  L1', '- L2', '+ X', '  L3', '  L4', '@@', '  L7', '  L8', '- L9', '+ Y', '  L10',
  ]);
  assert.deepEqual(draft.lineDiff('a\nb\n', 'a\nb\nc\nd\n'), ['  a', '  b', '+ c', '+ d']);
  assert.deepEqual(draft.lineDiff('', 'a\n'), ['+ a']);
  assert.deepEqual(draft.lineDiff('a\nb\nc\n', 'a\nc\n', { context: 0 }), ['- b']);
});

test('a base not written as 2-space JSON is flagged as reformatted, and the diff runs from its normalized text', () => {
  const value = { schemaVersion: 1, repos: { api: { name: 'api', checkout: '~/src/api', remote: null } } };
  const draftText = `${JSON.stringify({ ...value, checkoutRoots: ['~/src'] }, null, 2)}\n`;
  const fourSpace = draft.diffFromBase(`${JSON.stringify(value, null, 4)}\n`, draftText);
  assert.equal(fourSpace.reformat, true);
  assert.deepEqual(fourSpace.diff, draft.lineDiff(`${JSON.stringify(value, null, 2)}\n`, draftText));
  assert.deepEqual(fourSpace.diff.filter(l => !l.startsWith('  ')), ['-   }', '+   },', '+   "checkoutRoots": [', '+     "~/src"', '+   ]']);
  assert.equal(draft.diffFromBase(`${JSON.stringify(value, null, 2)}\n`, draftText).reformat, false);
  assert.equal(draft.diffFromBase(JSON.stringify(value, null, 2), draftText).reformat, true);
  const bootstrap = draft.diffFromBase(null, draftText);
  assert.equal(bootstrap.reformat, false);
  assert.ok(bootstrap.diff.length > 0 && bootstrap.diff.every(l => l.startsWith('+ ')));
});

test('a path under the user home is written ~/-relative, and any other path stays absolute', () => {
  const userHome = join('/', 'u', 'me');
  assert.equal(draft.tildeOf(join(userHome, 'src', 'web'), userHome), '~/src/web');
  assert.equal(draft.tildeOf(join(userHome, 'src', 'web'), `${userHome}/`), '~/src/web');
  assert.equal(draft.tildeOf(join(userHome, '..src'), userHome), '~/..src');
  assert.equal(draft.tildeOf(userHome, userHome), userHome);
  assert.equal(draft.tildeOf(join('/', 'u', 'mex', 'src'), userHome), join('/', 'u', 'mex', 'src'));
  assert.equal(draft.tildeOf(join('/', 'opt', 'work', 'web'), userHome), join('/', 'opt', 'work', 'web'));
});

// Draft assembly over plain facts shaped like the detection module's answers.
const USER_HOME = join('/', 'u', 'me');
const entry = (name, over = {}) => ({
  name, github: `acme/${name}`, checkout: `~/src/${name}`, url: null, remote: 'origin', defaultBranch: 'main', setup: [['npm', 'ci']], risk: [], ...over,
});
const gap = (code, repo, cards = ['A-1']) => ({ code, repo, cards });
const remoteFact = (remote, github, reason = null) => ({ remote, github, reason });
const assemble = ({ raw, planning, ...rest }) => draft.buildDraft({
  raw, planning: planning ?? draft.planningConfig(raw ?? draft.EMPTY_BASE, { userHome: USER_HOME, isCheckout: () => true }),
  slug: 's', userHome: USER_HOME, riskTemplate: [{ kind: 'migrations', paths: ['**/migrations/**'] }], ...rest,
});

test('a github gap on an existing entry takes the owner/name of the remote found for its checkout', () => {
  const raw = { schemaVersion: 1, repos: { x: entry('x', { github: null }) } };
  const result = assemble({ raw, missingConfig: [gap('github-missing', 'x')], facts: { x: { remote: remoteFact('origin', 'acme/x') } } });
  assert.equal(result.merged.repos.x.github, 'acme/x');
  assert.deepEqual(result.items.map(i => i.lines.map(({ kind, path, value }) => ({ kind, path, value }))), [[{ kind: 'proposed', path: 'repos.x.github', value: 'acme/x' }]]);
});

const linesOf = result => [...result.items.flatMap(i => i.lines), ...(result.fixes ?? [])];
const brief = line => ({ kind: line.kind, path: line.path, ...(line.kind === 'unfilled' ? { reason: line.reason } : { value: line.value }) });
const under = (p, q) => p === q || p.startsWith(`${q}.`) || p.startsWith(`${q}[`);
// Every path the draft changes is named by a line, so a value no line names is deep-equal to the base.
function assertChangesNamed(raw, result) {
  if (result.merged === null) { assert.deepEqual(result.changes, []); return; }
  const named = linesOf(result).map(l => l.path).filter(Boolean);
  const unnamed = draft.changesBetween(raw, result.merged).filter(c => !named.some(q => under(c.path, q) || under(q, c.path)));
  assert.deepEqual(unnamed, []);
}

test('each gap on an existing entry gets its key proposed from the facts of its checkout, and nothing else changes', () => {
  const raw = {
    schemaVersion: 1,
    repos: { x: entry('x', { github: null, remote: '', defaultBranch: null, setup: null, risk: null, notes: ['keep'] }), y: entry('y') },
    projects: { s: { repos: ['x', 'y'] } },
  };
  const facts = { x: { remote: remoteFact('origin', 'acme/x'), head: { branch: 'develop', reason: null }, setup: { setup: [['go', 'mod', 'download']], reason: null, needs: null } } };
  const codes = ['github-missing', 'remote-missing', 'default-branch-missing', 'setup-missing', 'risk-missing'];
  const result = assemble({ raw, missingConfig: codes.map(c => gap(c, 'x')), facts });
  assert.deepEqual(result.items.map(i => i.lines.map(brief)), [
    [{ kind: 'proposed', path: 'repos.x.github', value: 'acme/x' }],
    [{ kind: 'proposed', path: 'repos.x.remote', value: 'origin' }],
    [{ kind: 'proposed', path: 'repos.x.defaultBranch', value: 'develop' }],
    [{ kind: 'proposed', path: 'repos.x.setup', value: [['go', 'mod', 'download']] }],
    [{ kind: 'proposed', path: 'repos.x.risk', value: [{ kind: 'migrations', paths: ['**/migrations/**'] }] }],
  ]);
  assert.deepEqual(result.items.map(i => [i.code, i.repo, i.cards]), codes.map(c => [c, 'x', ['A-1']]));
  assert.deepEqual(result.merged.repos.y, raw.repos.y);
  assert.deepEqual(result.merged.repos.x.notes, ['keep']);
  assert.deepEqual(Object.keys(result.merged.repos.x), Object.keys(raw.repos.x));
  assertChangesNamed(raw, result);
  assert.match(result.items[4].lines[0].text, /template/);
  assert.match(result.items[4].lines[0].text, /\[\]/);
});

test('a gap on an existing entry the facts cannot fill gets an unfilled line with its reason, and the base value stays', () => {
  const raw = { schemaVersion: 1, repos: { x: entry('x', { github: null, defaultBranch: null, setup: null }), z: entry('z', { github: null, setup: null }) } };
  delete raw.repos.z.defaultBranch;
  const cases = [
    [{ remote: remoteFact(null, null, 'no GitHub remote'), head: { branch: null, reason: 'needs a remote' }, setup: { setup: null, reason: 'needs go', needs: 'needs go' } }, 'no GitHub remote', 'needs a remote', 'needs go'],
    [{ remote: remoteFact(null, null, 'several GitHub remotes and no origin: a, b'), head: { branch: null, reason: 'refs/remotes/origin/HEAD is not set' }, setup: { setup: null, reason: 'several lockfiles: package-lock.json, yarn.lock', needs: null } },
      'several GitHub remotes and no origin: a, b', 'refs/remotes/origin/HEAD is not set', 'several lockfiles: package-lock.json, yarn.lock'],
  ];
  for (const [fact, github, head, setup] of cases) {
    const codes = ['github-missing', 'default-branch-missing', 'setup-missing'];
    const result = assemble({ raw, missingConfig: [...codes.map(c => gap(c, 'x')), ...codes.map(c => gap(c, 'z'))], facts: { x: fact, z: fact } });
    for (const [dir, at] of [['x', 0], ['z', 3]]) {
      assert.deepEqual(result.items.slice(at, at + 3).map(i => i.lines.map(brief)), [
        [{ kind: 'unfilled', path: `repos.${dir}.github`, reason: github }],
        [{ kind: 'unfilled', path: `repos.${dir}.defaultBranch`, reason: head }],
        [{ kind: 'unfilled', path: `repos.${dir}.setup`, reason: setup }],
      ]);
    }
    assert.deepEqual([result.merged, result.changes], [null, []]);
    assert.ok(result.items.every(i => i.lines.every(l => l.text.includes(l.reason))));
  }
});

test('a gap on an entry with no checkout to read from is unfilled with that reason', () => {
  const raw = { schemaVersion: 1, repos: { x: entry('x', { checkout: null, url: 'https://github.com/acme/x.git', github: null, remote: null, defaultBranch: null, setup: null }) } };
  const codes = ['github-missing', 'remote-missing', 'default-branch-missing', 'setup-missing'];
  const result = assemble({ raw, missingConfig: codes.map(c => gap(c, 'x')), facts: {} });
  for (const item of result.items) {
    assert.equal(item.lines.length, 1);
    assert.equal(item.lines[0].kind, 'unfilled');
    assert.match(item.lines[0].reason, /no checkout/);
  }
  assert.deepEqual([result.merged, result.changes], [null, []]);
});

test('a url-only entry found under a root gets its checkout and url set to null as two lines, and keeps its url key', () => {
  const raw = { schemaVersion: 1, repos: { x: entry('x', { checkout: null, url: 'https://github.com/acme/x.git' }) } };
  const pick = { path: join(USER_HOME, 'src', 'x'), basename: 'x', remotes: { origin: 'acme/x' } };
  const result = assemble({ raw, missingConfig: [gap('repo-not-local', 'x')], facts: { x: { match: { pick, via: 'folder', ambiguous: [], linked: [] } } } });
  assert.deepEqual(result.items[0].lines.map(brief), [
    { kind: 'proposed', path: 'repos.x.checkout', value: '~/src/x' },
    { kind: 'proposed', path: 'repos.x.url', value: null },
  ]);
  assert.ok(Object.hasOwn(result.merged.repos.x, 'url'));
  assert.equal(result.merged.repos.x.url, null);
  assert.deepEqual(validateConfig(result.merged), []);
  assertChangesNamed(raw, result);
});

const KEY_ORDER = ['name', 'github', 'checkout', 'url', 'remote', 'defaultBranch', 'setup', 'risk'];
const candidate = (path, remotes = {}) => ({ path, basename: path.split('/').at(-1), remotes });
const found = (path, remotes) => ({ pick: candidate(path, remotes), via: 'folder', ambiguous: [], linked: [] });
const fullFacts = (path, github = 'acme/web') => ({
  match: found(path, { origin: github }), remote: remoteFact('origin', github), head: { branch: 'main', reason: null },
  setup: { setup: [['npm', 'ci']], reason: null, needs: null },
});

test('a repo found under a root becomes a new entry in key order, ~/-relative, named from its GitHub repo and added to the project list', () => {
  const raw = { schemaVersion: 1, repos: { api: entry('api') }, projects: { s: { repos: ['api'] }, other: { repos: ['api'] } } };
  const result = assemble({ raw, missingConfig: [gap('repo-missing', 'web', ['A-1', 'A-2'])], facts: { web: fullFacts(join(USER_HOME, 'src', 'web'), 'acme/web-app') } });
  assert.deepEqual(Object.keys(result.merged.repos), ['api', 'web']);
  assert.deepEqual(Object.keys(result.merged.repos.web), KEY_ORDER);
  assert.deepEqual(result.merged.repos.web, {
    name: 'web-app', github: 'acme/web-app', checkout: '~/src/web', url: null, remote: 'origin', defaultBranch: 'main', setup: [['npm', 'ci']],
    risk: [{ kind: 'migrations', paths: ['**/migrations/**'] }],
  });
  assert.deepEqual(result.merged.repos.api, raw.repos.api);
  assert.deepEqual(result.merged.projects, { s: { repos: ['api', 'web'] }, other: { repos: ['api'] } });
  const paths = result.items[0].lines.map(l => [l.kind, l.path]);
  for (const key of KEY_ORDER) assert.ok(paths.some(([kind, p]) => kind === 'proposed' && p === `repos.web.${key}`), key);
  assert.ok(paths.some(([kind, p]) => kind === 'proposed' && p === 'projects.s.repos'));
  assert.deepEqual(validateConfig(result.merged), []);
  assertChangesNamed(raw, result);
});

test('a new entry lists every required key it leaves unfilled, and a checkout with no GitHub remote is still proposed', () => {
  const raw = { schemaVersion: 1, repos: { api: entry('api') } };
  const facts = {
    web: {
      match: found(join('/', 'opt', 'work', 'web')), remote: remoteFact(null, null, 'no GitHub remote'), head: { branch: null, reason: 'needs a remote' },
      setup: { setup: null, reason: 'needs go', needs: 'needs go' },
    },
  };
  const result = assemble({ raw, missingConfig: [gap('repo-missing', 'web')], facts });
  assert.deepEqual(result.merged.repos.web, {
    name: 'web', github: null, checkout: join('/', 'opt', 'work', 'web'), url: null, remote: null, defaultBranch: null, setup: null,
    risk: [{ kind: 'migrations', paths: ['**/migrations/**'] }],
  });
  const unfilledLines = result.items[0].lines.filter(l => l.kind === 'unfilled').map(l => [l.path, l.reason]);
  assert.deepEqual(unfilledLines, [
    ['repos.web.github', 'no GitHub remote'], ['repos.web.remote', 'no GitHub remote'], ['repos.web.defaultBranch', 'needs a remote'], ['repos.web.setup', 'needs go'],
  ]);
  assert.deepEqual(validateConfig(result.merged), []);
});

test('a configured repo missing from the project list is appended to it and nothing else changes', () => {
  const raw = { schemaVersion: 1, repos: { api: entry('api'), web: entry('web') }, projects: { s: { repos: ['api'] } } };
  const result = assemble({ raw, missingConfig: [gap('not-in-project', 'web')] });
  assert.deepEqual(result.items[0].lines.map(brief), [{ kind: 'proposed', path: 'projects.s.repos', value: ['api', 'web'] }]);
  assert.deepEqual(draft.changesBetween(raw, result.merged), [{ op: 'set', path: 'projects.s.repos', before: ['api'], after: ['api', 'web'] }]);
});

test('an un-renamed trial dir gets the rename line and no entry, and any other trial dir name is drafted as a new repo', () => {
  const raw = { schemaVersion: 1, repos: { api: entry('api') } };
  const result = assemble({
    raw,
    missingConfig: [gap('trial-dir-unmapped', 'old-api'), gap('trial-dir-unmapped', 'web')],
    facts: { 'old-api': { oldTrial: true, ...fullFacts(join(USER_HOME, 'src', 'old-api'), 'acme/old-api') }, web: fullFacts(join(USER_HOME, 'src', 'web')) },
  });
  assert.deepEqual(result.items[0].lines.map(l => l.kind), ['rename-trial-dirs']);
  assert.match(result.items[0].lines[0].text, /rename the trial dirs first/);
  assert.deepEqual(Object.keys(result.merged.repos), ['api', 'web']);
  assert.equal(result.merged.repos.web.checkout, '~/src/web');
});

test('a raw slot for the repo that holds no object, or sits under a bad dir key, is to be fixed by hand and never gets a second entry', () => {
  for (const repos of [{ api: entry('api'), web: 3 }, { api: entry('api'), 'my web': entry('web') }, { api: entry('api'), WEB: null }]) {
    const raw = { schemaVersion: 1, repos };
    const result = assemble({ raw, missingConfig: [gap('repo-missing', 'web')], facts: { web: fullFacts(join(USER_HOME, 'src', 'web')) } });
    const [slot] = Object.keys(repos).filter(k => k !== 'api');
    assert.deepEqual(result.items[0].lines.map(l => [l.kind, l.path]), [['unfilled', `repos.${slot}`]], slot);
    assert.match(result.items[0].lines[0].reason, new RegExp(`fix repos\\.${slot} by hand`));
    assert.deepEqual([result.merged, result.changes], [null, []]);
  }
});

test('a folder that is already another entry\'s checkout, or that another gap took first, is not proposed again', () => {
  const raw = { schemaVersion: 1, repos: { api: entry('api', { checkout: '~/src/api' }), job: entry('job', { checkout: null, url: 'https://github.com/acme/job.git' }) } };
  const apiPath = join(USER_HOME, 'src', 'api');
  const facts = {
    web: fullFacts(apiPath, 'acme/api'),
    job: { match: { pick: null, via: null, ambiguous: [], linked: [], sameAs: 'api', reason: 'same checkout as repos.api' } },
    zed: fullFacts(join(USER_HOME, 'src', 'zed'), 'acme/zed'),
    alt: fullFacts(join(USER_HOME, 'src', 'zed'), 'acme/zed'),
  };
  const result = assemble({ raw, missingConfig: [gap('repo-missing', 'web'), gap('repo-not-local', 'job'), gap('github-missing', 'job'), gap('repo-missing', 'zed'), gap('repo-missing', 'alt')], facts });
  assert.deepEqual(result.items.map(i => i.lines.map(l => [l.kind, l.path, l.reason])), [
    [['unfilled', 'repos.web.checkout', 'same checkout as repos.api']],
    [['unfilled', 'repos.job.checkout', 'same checkout as repos.api']],
    [['unfilled', 'repos.job.github', 'no checkout to read it from']],
    [['unfilled', 'repos.zed.checkout', 'same checkout as repos.alt']],
    result.items[4].lines.map(l => [l.kind, l.path, l.reason]),
  ]);
  assert.equal(result.merged.repos.alt.checkout, '~/src/zed');
  assert.deepEqual(Object.keys(result.merged.repos), ['api', 'job', 'alt']);
  assert.deepEqual(result.merged.repos.job, raw.repos.job);
});

test('a gap whose name cannot be a dir key is keyed by its folder name', () => {
  const raw = { schemaVersion: 1, repos: { api: entry('api') } };
  const result = assemble({ raw, missingConfig: [gap('repo-missing', 'my web')], facts: { 'my web': fullFacts(join(USER_HOME, 'src', 'web')) } });
  assert.deepEqual(Object.keys(result.merged.repos), ['api', 'web']);
  assert.deepEqual(validateConfig(result.merged), []);
});

const ABSENCE = /absent|no local copy|not on (this|the) machine|missing from the machine|does not exist on/i;
const ROOTS = { searched: [join('/', 'r1'), join('/', 'r2')], missing: [join('/', 'r2')], from: 'config' };

test('a repo found under none of the roots gets a not-found line naming every root searched, with the three options', () => {
  const raw = { schemaVersion: 1, repos: { api: entry('api'), job: entry('job', { checkout: null, url: 'https://github.com/acme/job.git' }) } };
  const nothing = { match: { pick: null, via: null, ambiguous: [], linked: [] } };
  const result = assemble({
    raw, roots: ROOTS,
    missingConfig: [gap('repo-missing', 'web'), gap('repo-not-local', 'job'), gap('trial-dir-unmapped', 'tool')],
    facts: { web: nothing, job: nothing, tool: nothing },
  });
  for (const item of result.items) {
    assert.deepEqual(item.lines.map(l => l.kind), ['not-found'], item.repo);
    const [line] = item.lines;
    assert.deepEqual(line.roots, ROOTS.searched);
    assert.equal(line.options.length, 3);
    assert.match(line.text, new RegExp(`not found under ${ROOTS.searched.join(', ')}`));
    for (const option of ['clone it yourself', 'add a root', 'leave its cards out with --cards']) assert.ok(line.text.includes(option), option);
  }
  assert.deepEqual([result.merged, result.changes], [null, []]);
});

test('several folders with the name, or several origin matches, leave the checkout unfilled with every path, and skipped linked checkouts are named', () => {
  const raw = { schemaVersion: 1, repos: { api: entry('api') } };
  const a = candidate(join('/', 'r1', 'web'), { origin: 'acme/web' });
  const b = candidate(join('/', 'r2', 'Web'), { origin: 'acme/other' });
  const linked = [{ path: join('/', 'r1', 'job'), basename: 'job' }];
  const result = assemble({
    raw, roots: ROOTS,
    missingConfig: [gap('repo-missing', 'web'), gap('repo-missing', 'job')],
    facts: {
      web: { match: { pick: null, via: 'folder', ambiguous: [a, b], linked: [] } },
      job: { match: { pick: null, via: 'origin', ambiguous: [a, b], linked } },
    },
  });
  assert.deepEqual(result.items.map(i => i.lines.map(l => [l.kind, l.path])), [[['unfilled', 'repos.web.checkout']], [['unfilled', 'repos.job.checkout']]]);
  assert.equal(result.items[0].lines[0].reason, `several folders named web: ${a.path}, ${b.path}`);
  assert.equal(result.items[1].lines[0].reason, `several checkouts whose origin is the repo: ${a.path}, ${b.path}; skipped, a linked checkout: ${linked[0].path}`);
  assert.ok(!JSON.stringify(result).includes('acme/other'));
  assert.deepEqual([result.merged, result.changes], [null, []]);
});

test('a linked checkout named like a repo found nowhere else is named on its not-found line', () => {
  const raw = { schemaVersion: 1, repos: { api: entry('api') } };
  const linked = [{ path: join('/', 'r1', 'web'), basename: 'web' }];
  const result = assemble({ raw, roots: ROOTS, missingConfig: [gap('repo-missing', 'web')], facts: { web: { match: { pick: null, via: null, ambiguous: [], linked } } } });
  assert.equal(result.items[0].lines[0].kind, 'not-found');
  assert.match(result.items[0].lines[0].text, new RegExp(`skipped, a linked checkout: ${linked[0].path}`));
});

const CODES = ['repo-missing', 'trial-dir-unmapped', 'repo-not-local', 'github-missing', 'default-branch-missing', 'remote-missing', 'setup-missing', 'risk-missing', 'not-in-project'];

test('every gap of every code gets at least one line, whatever the facts hold, and no line says a repo is not on the machine', () => {
  const raw = { schemaVersion: 1, repos: { api: entry('api', { checkout: null, url: 'https://github.com/acme/api.git', github: null, remote: null, defaultBranch: null, setup: null, risk: null }) }, projects: { s: { repos: ['web'] } } };
  const path = join(USER_HOME, 'src', 'api');
  const situations = {
    'no facts': {},
    'nothing found': { match: { pick: null, via: null, ambiguous: [], linked: [] } },
    'several found': { match: { pick: null, via: 'folder', ambiguous: [candidate(path), candidate(join('/', 'r2', 'api'))], linked: [] } },
    'same checkout': { match: { pick: null, via: null, ambiguous: [], linked: [], sameAs: 'x', reason: 'same checkout as repos.x' } },
    'everything found': fullFacts(path, 'acme/api'),
    'nothing readable': { match: found(path), remote: remoteFact(null, null, 'no GitHub remote'), head: { branch: null, reason: 'needs a remote' }, setup: { setup: null, reason: 'no ecosystem detected', needs: null } },
    'old trial dir': { oldTrial: true },
  };
  for (const [name, fact] of Object.entries(situations)) {
    for (const template of [[{ kind: 'migrations', paths: ['**/migrations/**'] }], null]) {
      const missingConfig = CODES.map(code => gap(code, ['repo-missing', 'trial-dir-unmapped'].includes(code) ? `new-${code}` : 'api'));
      const facts = Object.fromEntries(missingConfig.map(g => [g.repo, fact]));
      for (const roots of [ROOTS, { searched: [], missing: [], from: null }]) {
        const result = assemble({ raw, roots, missingConfig, facts, riskTemplate: template });
        assert.equal(result.items.length, missingConfig.length);
        const silent = result.items.filter(i => !i.lines.length).map(i => i.code);
        assert.deepEqual(silent, [], name);
        assert.ok(result.items.every(i => i.lines.every(l => typeof l.text === 'string' && l.text.length > 0)), name);
        assert.doesNotMatch(JSON.stringify(result), ABSENCE, name);
      }
    }
  }
});

// Every validator error of the base is carried by at least one line of the draft.
function assertIssuesCovered(raw, result) {
  const carried = new Set(linesOf(result).flatMap(l => l.issues ?? []));
  assert.deepEqual(validateConfig(raw).filter(text => !carried.has(text)), []);
}
const START_ONLY = ['typecheck', 'setupTimeoutMs', 'typecheckTimeoutMs', 'branchNaming', 'notes'];
function assertStartOnlyNeverFilled(raw, result) {
  for (const [dir, after] of Object.entries(result.merged?.repos ?? {})) {
    if (!isObj(after)) continue;
    const before = isObj(raw.repos) && isObj(raw.repos[dir]) ? raw.repos[dir] : {};
    for (const key of START_ONLY) {
      if (!Object.hasOwn(before, key)) assert.ok(!Object.hasOwn(after, key), `${dir}.${key} added`);
      else assert.ok(after[key] === null || JSON.stringify(after[key]) === JSON.stringify(before[key]), `${dir}.${key}`);
    }
  }
}
const checkAll = (raw, result) => { assertIssuesCovered(raw, result); assertChangesNamed(raw, result); assertStartOnlyNeverFilled(raw, result); };

test('a malformed github is redrafted from the remote of the matched folder, on a gap or on an untouched entry', () => {
  const raw = { schemaVersion: 1, repos: { x: entry('x', { github: 'not a slug' }), y: entry('y', { github: 5 }), z: entry('z', { github: 'a/b/c' }) } };
  const facts = { x: { remote: remoteFact('origin', 'acme/x') }, y: { remote: remoteFact('origin', 'acme/y') }, z: { remote: remoteFact(null, null, 'no GitHub remote') } };
  const result = assemble({ raw, missingConfig: [gap('github-missing', 'x')], facts });
  assert.deepEqual(result.items[0].lines.map(brief), [{ kind: 'proposed', path: 'repos.x.github', value: 'acme/x' }]);
  assert.deepEqual(result.items[0].lines[0].issues, ['repos.x.github: expected <owner>/<repo>']);
  assert.deepEqual(result.fixes.map(brief), [
    { kind: 'proposed', path: 'repos.y.github', value: 'acme/y' },
    { kind: 'unfilled', path: 'repos.z.github', reason: 'no GitHub remote' },
  ]);
  assert.deepEqual([result.merged.repos.x.github, result.merged.repos.y.github, result.merged.repos.z.github], ['acme/x', 'acme/y', null]);
  assert.deepEqual(validateConfig(result.merged), []);
  checkAll(raw, result);
});

test('a stray chekout is kept and reported, and the checkout is drafted beside it', () => {
  const raw = { schemaVersion: 1, repos: { api: entry('api'), web: { name: 'web', chekout: '~/src/web', remote: 'origin', github: 'acme/web', risk: [] } } };
  const result = assemble({ raw, missingConfig: [gap('repo-not-local', 'web')], facts: { web: { match: found(join(USER_HOME, 'src', 'web')) } } });
  assert.equal(result.merged.repos.web.chekout, '~/src/web');
  assert.equal(result.merged.repos.web.checkout, '~/src/web');
  assert.deepEqual(result.stray.map(({ path, suggestion }) => ({ path, suggestion })), [{ path: 'repos.web.chekout', suggestion: 'checkout' }]);
  assert.match(result.stray[0].text, /if this is a typo, delete it in the draft/i);
  assert.ok(result.items[0].lines[0].issues.includes('repos.web: set exactly one of checkout and url'));
  assert.deepEqual(validateConfig(result.merged), []);
  checkAll(raw, result);
});

test('risk rules the config refuses are dropped one line each, the valid ones kept, and a risk that is not a list takes the template', () => {
  const auth = { kind: 'authorization', paths: ['**/guards/**'] };
  const raw = {
    schemaVersion: 1,
    repos: {
      x: entry('x', { risk: [auth, { kind: 'pii-in-logs', paths: ['**'] }, { kind: 'authorization', paths: ['b'] }, { kind: 'migrations', paths: [] }, 'x'] }),
      y: entry('y', { risk: 'all' }),
    },
  };
  const result = assemble({ raw, missingConfig: [gap('risk-missing', 'x')] });
  assert.deepEqual(result.merged.repos.x.risk, [auth]);
  assert.deepEqual(result.items[0].lines.map(l => [l.kind, l.path]), [
    ['proposed', 'repos.x.risk'], ['dropped', 'repos.x.risk[1]'], ['dropped', 'repos.x.risk[2]'], ['dropped', 'repos.x.risk[3]'], ['dropped', 'repos.x.risk[4]'],
  ]);
  assert.match(result.items[0].lines[1].text, /pii-in-logs/);
  assert.deepEqual(result.merged.repos.y.risk, [{ kind: 'migrations', paths: ['**/migrations/**'] }]);
  assert.deepEqual(result.fixes.map(l => [l.kind, l.path]), [['proposed', 'repos.y.risk']]);
  assert.deepEqual(validateConfig(result.merged), []);
  checkAll(raw, result);
});

test('an invalid start-only key is reset to null as a set line carrying the old value, and none is ever added or filled', () => {
  const resets = { branchNaming: 'other', typecheck: 'x', notes: 3, setupTimeoutMs: -1, typecheckTimeoutMs: -1 };
  for (const [key, bad] of [...Object.entries(resets), ['notes', ['ok', '']], ['typecheck', [['npm'], []]]]) {
    const raw = { schemaVersion: 1, repos: { x: entry('x', { [key]: bad }), y: entry('y') } };
    const result = assemble({ raw, missingConfig: [gap('setup-missing', 'y')], facts: { y: { setup: { setup: null, reason: 'needs go', needs: 'needs go' } } } });
    assert.deepEqual(result.fixes.map(l => [l.kind, l.path, l.before, l.value]), [['reset', `repos.x.${key}`, bad, null]], key);
    assert.deepEqual(draft.changesBetween(raw, result.merged), [{ op: 'set', path: `repos.x.${key}`, before: bad, after: null }], key);
    assert.deepEqual(validateConfig(result.merged), [], key);
    checkAll(raw, result);
  }
});

test('schemaVersion is set to 1 when it is missing and left unfilled when it is another value', () => {
  const missing = { repos: { api: entry('api') } };
  const set = assemble({ raw: missing, missingConfig: [] });
  assert.deepEqual(set.fixes.map(brief), [{ kind: 'proposed', path: 'schemaVersion', value: 1 }]);
  assert.deepEqual(validateConfig(set.merged), []);
  checkAll(missing, set);
  const other = { schemaVersion: 2, repos: { api: entry('api') } };
  const kept = assemble({ raw: other, missingConfig: [] });
  assert.deepEqual(kept.fixes.map(l => [l.kind, l.path]), [['unfilled', 'schemaVersion']]);
  assert.match(kept.fixes[0].reason, /version 1 only/);
  assert.equal(kept.merged?.schemaVersion ?? 2, 2);
  checkAll(other, { ...kept, merged: kept.merged ?? other });
});

test('repos that is not an object is replaced by the drafted entries with a line', () => {
  for (const repos of [['api'], 'api', null]) {
    const raw = { schemaVersion: 1, repos };
    const result = assemble({ raw, missingConfig: [gap('repo-missing', 'web')], facts: { web: fullFacts(join(USER_HOME, 'src', 'web')) } });
    assert.deepEqual(Object.keys(result.merged.repos), ['web']);
    assert.ok(result.fixes.some(l => l.kind === 'proposed' && l.path === 'repos' && /backup/.test(l.text)), JSON.stringify(repos));
    assert.deepEqual(validateConfig(result.merged), []);
    checkAll(raw, result);
  }
});

test('a bad dir key and an entry that is not an object are kept verbatim with a fix-by-hand line, and the draft stays invalid', () => {
  const raw = { schemaVersion: 1, repos: { 'my api': { name: 3 }, job: 7, web: entry('web', { branchNaming: 'other' }) } };
  const result = assemble({ raw, missingConfig: [] });
  assert.deepEqual(result.merged.repos['my api'], { name: 3 });
  assert.equal(result.merged.repos.job, 7);
  const byHand = result.fixes.filter(l => l.kind === 'unfilled').map(l => [l.path, /by hand/.test(l.reason)]);
  assert.deepEqual(byHand, [['repos.my api', true], ['repos.job', true]]);
  assert.ok(validateConfig(result.merged).length > 0);
  checkAll(raw, result);
});

test('both a real checkout and a url: the url is set to null; an invalid name is redrafted', () => {
  const raw = { schemaVersion: 1, repos: { x: entry('x', { url: 'https://github.com/acme/x.git', name: '' }) } };
  const result = assemble({ raw, missingConfig: [], facts: { x: { remote: remoteFact('origin', 'acme/x-app') } } });
  assert.deepEqual(result.fixes.map(brief), [{ kind: 'proposed', path: 'repos.x.name', value: 'x-app' }, { kind: 'proposed', path: 'repos.x.url', value: null }]);
  assert.deepEqual(validateConfig(result.merged), []);
  checkAll(raw, result);
});

test('a project list naming a repo the draft adds is resolved by it, and any other project error is left unfilled', () => {
  const raw = { schemaVersion: 1, repos: { api: entry('api') }, projects: { s: { repos: ['api', 'web'] }, t: { repos: [] }, u: 4 } };
  const result = assemble({ raw, missingConfig: [gap('repo-missing', 'web')], facts: { web: fullFacts(join(USER_HOME, 'src', 'web')) } });
  assert.deepEqual(result.fixes.map(l => [l.kind, l.path]), [['resolved', 'projects.s.repos[1]'], ['unfilled', 'projects.t.repos'], ['unfilled', 'projects.u']]);
  assert.deepEqual(result.merged.projects, raw.projects);
  checkAll(raw, result);
});

test('stored roots the config refuses are replaced by the --root values, or left unfilled without them', () => {
  const raw = { schemaVersion: 1, repos: { api: entry('api') }, checkoutRoots: ['src'] };
  const given = assemble({ raw, missingConfig: [], roots: { searched: [join(USER_HOME, 'src')], missing: [], from: 'flag' } });
  assert.deepEqual(given.fixes.map(brief), [{ kind: 'proposed', path: 'checkoutRoots', value: ['~/src'] }]);
  checkAll(raw, given);
  const none = assemble({ raw, missingConfig: [], roots: { searched: [], missing: [], from: null } });
  assert.deepEqual(none.fixes.map(l => [l.kind, l.path]), [['unfilled', 'checkoutRoots']]);
});

test('a base URL holding credentials gets an unfilled line that never repeats the value', () => {
  const secret = ['x-token', SHORT].join(':');
  const raw = { schemaVersion: 1, repos: { api: entry('api'), web: entry('web', { checkout: null, url: `https://${secret}@github.com/acme/web.git` }) } };
  const result = assemble({ raw, missingConfig: [] });
  assert.deepEqual(result.fixes.map(l => [l.kind, l.path]), [['unfilled', 'repos.web.url']]);
  assert.match(result.fixes[0].reason, /credentials/);
  assert.ok(!JSON.stringify(result.fixes).includes(SHORT));
});

const EXAMPLE = new URL('../docs/spike-config.example.json', import.meta.url);

test('the risk template is the example file\'s rules, one per kind in file order, read from the path given', () => {
  const template = draft.readRiskTemplate(EXAMPLE);
  assert.deepEqual(template, [
    { kind: 'authorization', paths: ['**/guards/**', '**/authorization/**'] },
    { kind: 'migrations', paths: ['**/migrations/**'] },
  ]);
  const injected = join(DIR, 'example.json');
  writeFileSync(injected, JSON.stringify({ repos: { a: { risk: [{ kind: 'k1', paths: ['x'] }] }, b: { risk: [{ kind: 'k1', paths: ['y'] }, { kind: 'k2', paths: ['z'] }] }, c: { risk: [] } } }));
  assert.deepEqual(draft.readRiskTemplate(injected), [{ kind: 'k1', paths: ['x'] }, { kind: 'k2', paths: ['z'] }]);
  const result = assemble({ raw: { schemaVersion: 1, repos: { api: entry('api') } }, missingConfig: [gap('repo-missing', 'web')], facts: { web: fullFacts(join(USER_HOME, 'src', 'web')) }, riskTemplate: template });
  assert.deepEqual(result.merged.repos.web.risk, template);
});

const keysOf = value => (Array.isArray(value) ? value.flatMap(keysOf) : isObj(value) ? Object.entries(value).flatMap(([k, v]) => [k, ...keysOf(v)]) : []);
const needsGo = { setup: null, reason: 'needs go', needs: 'needs go' };

test('every needs text of a setup line is collected with its repo, and no key of the result names an install', () => {
  const raw = { schemaVersion: 1, repos: { api: entry('api', { setup: null }) } };
  const facts = {
    api: { setup: { setup: null, reason: 'needs corepack, or pnpm on PATH', needs: 'needs corepack, or pnpm on PATH' } },
    web: { ...fullFacts(join(USER_HOME, 'src', 'web')), setup: needsGo },
    job: { ...fullFacts(join(USER_HOME, 'src', 'job'), 'acme/job'), setup: { setup: null, reason: 'no ecosystem detected', needs: null } },
  };
  const result = assemble({ raw, missingConfig: [gap('setup-missing', 'api'), gap('repo-missing', 'web'), gap('repo-missing', 'job')], facts });
  assert.deepEqual(result.needs, [{ repo: 'api', text: 'needs corepack, or pnpm on PATH' }, { repo: 'web', text: 'needs go' }]);
  assert.deepEqual(keysOf(result).filter(k => /install/i.test(k)), []);
});

const draftOf = value => `${JSON.stringify(value, null, 2)}\n`;

test('a draft that validates gets a 12-hex approve hash, whatever setup, github, defaultBranch and risk it leaves null', () => {
  const raw = { schemaVersion: 1, repos: { api: entry('api') } };
  const facts = { web: { match: found(join(USER_HOME, 'src', 'web')), remote: remoteFact(null, null, 'no GitHub remote'), head: { branch: null, reason: 'needs a remote' }, setup: needsGo } };
  const base = Buffer.from(JSON.stringify(raw));
  for (const riskTemplate of [draft.readRiskTemplate(EXAMPLE), null]) {
    const result = assemble({ raw, missingConfig: [gap('repo-missing', 'web')], facts, riskTemplate });
    const web = result.merged.repos.web;
    assert.deepEqual([web.github, web.defaultBranch, web.setup], [null, null, null]);
    assert.equal(web.risk, riskTemplate === null ? null : web.risk);
    const text = draftOf(result.merged);
    const state = draft.draftState(text, base);
    assert.deepEqual(state, { valid: true, errors: [], approve: draft.draftHash(base, text) });
    assert.match(state.approve, /^[0-9a-f]{12}$/);
  }
});

test('a draft the validator refuses, or one holding a URL with credentials, gets no hash and errors that never repeat the URL', () => {
  const badKey = draftOf({ schemaVersion: 1, repos: { 'my api': entry('api') } });
  const refused = draft.draftState(badKey, null);
  assert.equal(refused.valid, false);
  assert.equal(refused.approve, null);
  assert.deepEqual(refused.errors, validateConfig(JSON.parse(badKey)));
  const secret = ['x-token', SHORT].join(':');
  const withCredentials = draftOf({ schemaVersion: 1, repos: { api: entry('api'), web: entry('web', { checkout: null, url: `https://${secret}@github.com/acme/web.git` }) } });
  const leaked = draft.draftState(withCredentials, null);
  assert.equal(leaked.valid, false);
  assert.equal(leaked.approve, null);
  assert.equal(leaked.errors.length, 1);
  assert.match(leaked.errors[0], /^repos\.web\.url: /);
  assert.ok(!JSON.stringify(leaked).includes(SHORT));
  for (const text of ['{"repos":', '[]']) {
    const state = draft.draftState(text, null);
    assert.equal(state.valid, false, text);
    assert.equal(state.approve, null, text);
    assert.ok(state.errors.length > 0, text);
  }
});

const flagRoots = (...dirs) => ({ searched: dirs, missing: [], from: 'flag' });

test('--root values with none stored are proposed as checkoutRoots, ~/-relative, and stored roots are never changed', () => {
  const raw = { schemaVersion: 1, repos: { api: entry('api') } };
  const missingConfig = [gap('repo-missing', 'web')];
  const facts = { web: fullFacts(join(USER_HOME, 'src', 'web')) };
  const fresh = assemble({ raw, missingConfig, facts, roots: flagRoots(join(USER_HOME, 'src'), join('/', 'opt', 'work')) });
  assert.deepEqual(fresh.merged.checkoutRoots, ['~/src', join('/', 'opt', 'work')]);
  assert.ok(fresh.fixes.some(l => l.kind === 'proposed' && l.path === 'checkoutRoots'));
  assert.deepEqual(fresh.changes, draft.changesBetween(raw, fresh.merged));
  assert.deepEqual(validateConfig(fresh.merged), []);
  const stored = { ...raw, checkoutRoots: ['/a'] };
  for (const roots of [flagRoots(join('/', 'b')), { searched: ['/a'], missing: [], from: 'config' }]) {
    const result = assemble({ raw: stored, missingConfig, facts, roots });
    assert.deepEqual(result.merged.checkoutRoots, ['/a']);
    assert.ok(!result.changes.some(c => c.path.startsWith('checkoutRoots')));
  }
});

test('with no config file, the draft is a whole file with checkoutRoots after schemaVersion that validates', () => {
  const missingConfig = [gap('repo-missing', 'api'), gap('repo-missing', 'web')];
  const facts = { api: fullFacts(join(USER_HOME, 'src', 'api'), 'acme/api'), web: fullFacts(join(USER_HOME, 'src', 'web')) };
  const result = assemble({ raw: null, missingConfig, facts, roots: flagRoots(join(USER_HOME, 'src')) });
  assert.deepEqual(Object.keys(result.merged), ['schemaVersion', 'checkoutRoots', 'repos']);
  assert.deepEqual(Object.keys(result.merged.repos), ['api', 'web']);
  assert.deepEqual(validateConfig(result.merged), []);
  assert.deepEqual(result.changes, draft.changesBetween(null, result.merged));
  assert.deepEqual(result.fixes.map(l => l.path), ['checkoutRoots']);
  assert.deepEqual(result.stray, []);
  assert.match(draft.draftState(draftOf(result.merged), null).approve, /^[0-9a-f]{12}$/);
});

test('nothing to draft: no config file and nothing found, or a base whose gaps hold only not-found, unfilled and rename lines', () => {
  const nothing = { match: { pick: null, via: null, ambiguous: [], linked: [] } };
  const bootstrap = assemble({ raw: null, missingConfig: [gap('repo-missing', 'api')], facts: { api: nothing }, roots: flagRoots(join(USER_HOME, 'src')) });
  assert.deepEqual([bootstrap.merged, bootstrap.changes], [null, []]);
  assert.equal(bootstrap.items[0].lines[0].kind, 'not-found');
  const raw = { schemaVersion: 1, repos: { api: entry('api', { setup: null }), job: entry('job', { checkout: null, url: 'https://github.com/acme/job.git' }) } };
  const result = assemble({
    raw, roots: flagRoots(join(USER_HOME, 'src')),
    missingConfig: [gap('repo-missing', 'web'), gap('repo-not-local', 'job'), gap('setup-missing', 'api'), gap('trial-dir-unmapped', 'old')],
    facts: { web: nothing, job: nothing, api: { setup: needsGo }, old: { oldTrial: true } },
  });
  assert.deepEqual([result.merged, result.changes], [null, []]);
  assert.deepEqual(result.items.map(i => i.lines.map(l => l.kind)), [['not-found'], ['not-found'], ['unfilled'], ['rename-trial-dirs']]);
  assert.deepEqual(result.needs, [{ repo: 'api', text: 'needs go' }]);
});

test('a base with no repos key and nothing found has nothing to draft, and repos is never added as a key with no value', () => {
  const nothing = { match: { pick: null, via: null, ambiguous: [], linked: [] } };
  const run = raw => assemble({ raw, missingConfig: [gap('repo-missing', 'web')], facts: { web: nothing }, roots: flagRoots(join(USER_HOME, 'src')) });
  const none = run({ schemaVersion: 1 });
  assert.deepEqual([none.merged, none.changes], [null, []]);
  const versionOnly = run({});
  assert.equal(versionOnly.merged.schemaVersion, 1);
  assert.ok(!Object.hasOwn(versionOnly.merged, 'repos'));
  assert.ok(!versionOnly.changes.some(c => c.path === 'repos'), JSON.stringify(versionOnly.changes));
});

test('a real checkout beside a url that is empty or not a string gets the url set to null, never a search', () => {
  for (const url of ['', 5]) {
    const raw = { schemaVersion: 1, repos: { x: entry('x', { url }) } };
    const result = assemble({ raw, missingConfig: [], roots: ROOTS });
    assert.deepEqual(result.fixes.map(brief), [{ kind: 'proposed', path: 'repos.x.url', value: null }], JSON.stringify(url));
    assert.deepEqual(validateConfig(result.merged), []);
  }
});

test('a new entry is named so that its gap maps to it, and never so that another gap maps to it', () => {
  const raw = { schemaVersion: 1, repos: { job: entry('job') } };
  const facts = {
    api: { ...fullFacts(join(USER_HOME, 'src', 'api'), 'acme/api-server') },
    'api-server': { ...fullFacts(join(USER_HOME, 'src', 'api-server'), 'acme/api-server') },
    'my web': fullFacts(join(USER_HOME, 'src', 'web')),
  };
  const missingConfig = [gap('repo-missing', 'api'), gap('repo-missing', 'api-server'), gap('repo-missing', 'my web')];
  const result = assemble({ raw, missingConfig, facts });
  assert.deepEqual(result.items.map(i => i.lines.filter(l => l.kind !== 'proposed').map(l => l.path)), [[], [], []]);
  for (const g of missingConfig) assert.equal(mapRepo(result.merged, g.repo)?.dir, { api: 'api', 'api-server': 'api-server', 'my web': 'web' }[g.repo], g.repo);
  assert.deepEqual(validateConfig(result.merged), []);
});
