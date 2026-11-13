import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardNetwork } from './helpers/no-network.mjs';

guardNetwork();

const json = path => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
const plugin = json('.claude-plugin/plugin.json');

test('the plugin manifest names the plugin keiron-sequencer, with a semver version', () => {
  assert.equal(plugin.name, 'keiron-sequencer');
  assert.match(plugin.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.ok(plugin.description, 'plugin.json needs a description');
  assert.ok(plugin.author?.name, 'plugin.json needs an author');
});

test('the marketplace lists exactly one plugin, this repo, under the manifest name', () => {
  const catalog = json('.claude-plugin/marketplace.json');
  assert.equal(catalog.name, 'keiron-sequencer');
  assert.ok(catalog.description, 'marketplace.json needs a description');
  assert.equal(catalog.plugins.length, 1);
  assert.equal(catalog.plugins[0].name, 'keiron-sequencer');
  assert.equal(catalog.plugins[0].source, './');
  assert.equal(catalog.plugins[0].name, plugin.name);
});

test('hooks.json loads the metro module, and the module file exists', () => {
  const hooks = json('hooks/hooks.json');
  assert.deepEqual(hooks.modules, ['./register.tsx']);
  assert.ok(existsSync(new URL('../hooks/register.tsx', import.meta.url)), 'hooks/register.tsx is missing');
});

test('package.json carries the plugin name and keeps its module type and test script', () => {
  const pkg = json('package.json');
  assert.equal(pkg.name, 'keiron-sequencer');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.scripts.test, 'node --test');
});

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OLD_NAME = new RegExp('mi' + 'kado', 'i');
const ONE_OFF_SCRIPTS = [
  'scripts/maintenance/move-home.mjs', 'scripts/maintenance/rewrite-markers.mjs',
  'tests/move-home.test.mjs', 'tests/rewrite-markers.test.mjs',
];
const PLUGIN_PATHS = ['.claude-plugin', 'hooks', 'types', 'scripts', 'skills', 'tests', 'package.json', 'tsconfig.json'];

const git = (...args) => {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split('\0').filter(Boolean);
};
const read = path => readFileSync(join(ROOT, path), 'utf8');
const testSources = () => [
  ...readdirSync(join(ROOT, 'tests')).filter(f => f.endsWith('.test.mjs')).map(f => `tests/${f}`),
  ...readdirSync(join(ROOT, 'tests/helpers')).filter(f => f.endsWith('.mjs')).map(f => `tests/helpers/${f}`),
];

test('only the two one-off scripts and their tests hold the old name, and no tracked or plugin path is named after it', () => {
  assert.equal(OLD_NAME.test('a ' + 'Mi' + 'kado bug'), true);
  const files = [...new Set([
    ...git('ls-files', '-z'),
    ...git('ls-files', '-z', '--others', '--exclude-standard', '--', ...PLUGIN_PATHS),
  ])].filter(f => existsSync(join(ROOT, f)) && statSync(join(ROOT, f)).isFile());
  assert.ok(files.includes('skills/next/SKILL.md') && files.includes('scripts/maintenance/move-home.mjs'), 'the listing misses the plugin files');
  assert.deepEqual(files.filter(f => OLD_NAME.test(f)), []);
  const holders = files.filter(f => OLD_NAME.test(read(f)));
  assert.deepEqual(holders.filter(f => !ONE_OFF_SCRIPTS.includes(f)), []);
});

const TRIAL_VAR = new RegExp('[A-Z0-9]_TRIAL' + '_PATCHES\\b');
const HOME_LOOKUP = /\b(sequencerHome|dataDirFor)\b|\bhomedir\(/;

test('no test reads a trial-patches variable, and no test helper resolves the real home', () => {
  assert.equal(TRIAL_VAR.test('process.env.OLD' + '_TRIAL' + '_PATCHES'), true);
  for (const sample of ["import { sequencerHome } from 'x'", 'dataDirFor(env)', 'join(homedir(), x)']) assert.equal(HOME_LOOKUP.test(sample), true, sample);
  assert.equal(HOME_LOOKUP.test("import { runDir, trialPatchRoot } from 'x'"), false);
  assert.deepEqual(testSources().filter(f => TRIAL_VAR.test(read(f))), []);
  assert.deepEqual(testSources().filter(f => f.startsWith('tests/helpers/') && HOME_LOOKUP.test(read(f))), []);
});

test('the trial-data tests carry no skip option', () => {
  assert.equal(/\bskip:/.test("test('x', { skip: !existsSync(root) }, () => {})"), true);
  const files = ['backfill-build', 'backfill-patch-root', 'backfill-size', 'patch-map', 'trial-inputs'].map(f => `tests/${f}.test.mjs`);
  assert.deepEqual(files.filter(f => /\bskip:/.test(read(f))), []);
});

// Each spawn of node with its argument list, up to the matching close paren.
const nodeSpawns = text => [...text.matchAll(/\b(spawn|spawnSync|execFile|execFileSync)\(process\.execPath\b/g)].map(m => {
  let depth = 0;
  for (let i = m.index + m[1].length; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return text.slice(m.index, i + 1);
  }
  return text.slice(m.index);
});
const homeless = text => nodeSpawns(text).filter(call => !/\bHOME:/.test(call));

test('every spawned node process gets a HOME in its env', () => {
  const call = 'spawnSync(process' + '.execPath, [CLI], { encoding: "utf8", env: { PATH: x } });';
  assert.equal(homeless(call).length, 1);
  assert.equal(homeless(call.replace('PATH: x', 'PATH: x, HOME: join(dir, "h")')).length, 0);
  assert.deepEqual(nodeSpawns(`a(); ${call} b(c(d));`), [call.slice(0, -1)]);
  assert.deepEqual(testSources().filter(f => homeless(read(f)).length > 0), []);
});

test('the metro test reads no home path and answers every process run with its mock', () => {
  const source = read('tests/metro.test.tsx');
  assert.doesNotMatch(source, /homedir|~\/\.|\/Users\//);
  assert.match(source, /on\('process\.run',/);
  const unmocked = text => text.split(/^test\(/m).slice(1).filter(t => t.includes('start($)') && !/engine\(on,[\s\S]*start\(\$\)/.test(t));
  assert.equal(unmocked("x\ntest('a', async ($, on) => {\n  await start($)\n})\n").length, 1);
  assert.deepEqual(unmocked(source), []);
});

const ORG_PATTERN = ['kei', 'r[oó]n'].join('');
const REAL_IDS = [
  new RegExp(['bda31', '46f36'].join(''), 'i'), new RegExp(['f20a8', '94aadb3'].join(''), 'i'), new RegExp(['crm', '371'].join('-'), 'i'),
  new RegExp(['crm', 'backend'].join('-'), 'i'), new RegExp(['crm', 'frontend'].join('-'), 'i'), new RegExp(['kai', 'bot'].join(''), 'i'),
  new RegExp(['ws', 'events'].join('-?'), 'i'), new RegExp(`${ORG_PATTERN}(?!-sequencer|_sequencer|-planner)`, 'i'),
  new RegExp(['health', 'tech'].join(''), 'i'), new RegExp(['ley', '21'].join('[ -]'), 'i'), new RegExp(['permi', 'sos'].join(''), 'i'),
  new RegExp(['\\bCRM-(?:3[89]|40)', '\\d\\d\\b'].join(''), 'i'), new RegExp(['(?<!\\d)0(?:3[89]|40)', '\\d\\d-'].join('')),
  new RegExp(['\\bk', 'z\\b'].join('')),
];

test('no file under tests holds an identifier from a real project', () => {
  const planted = [
    ['bda31', '46f3604'], ['F20A8', '94AADB3'], ['trial-p-crm-', '371'], ['crm-', 'backend'], ['CRM-', 'Frontend'], ['crm-kai', 'bot'],
    ['crm-ws-', 'events'], ['Kei', 'rón'], ['Hea', 'lthTech'], ['Ley ', '21'], ['permi', 'sos-v2'], ['CRM-', '3999'], ['backend/0', '3999-new.patch'], ['k', 'z'],
  ].map(parts => parts.join(''));
  REAL_IDS.forEach((re, i) => assert.match(planted[i], re));
  for (const own of ['keiron-sequencer', '~/.keiron-sequencer', 'KEIRON_SEQUENCER_HOME', '~/.config/keiron-planner', 'ABC-901', 'backend/00001-new.patch']) {
    assert.deepEqual(REAL_IDS.filter(re => re.test(own)), [], own);
  }
  const files = [...new Set([
    ...git('ls-files', '-z', '--', 'tests'),
    ...git('ls-files', '-z', '--others', '--exclude-standard', '--', 'tests'),
  ])].filter(f => existsSync(join(ROOT, f)) && statSync(join(ROOT, f)).isFile());
  assert.ok(files.includes('tests/plugin-manifest.test.mjs') && files.includes('tests/fixtures/cardmap-synthetic.json'), 'the listing misses the test files');
  const offenders = files.flatMap(f => REAL_IDS.filter(re => re.test(f) || re.test(read(f))).map(re => `${f}: ${read(f).match(re)?.[0] ?? f}`));
  assert.deepEqual(offenders, []);
});
