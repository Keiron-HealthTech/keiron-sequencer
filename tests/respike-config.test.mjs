import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serializeRecord } from '../scripts/lib/record.mjs';
import { loadConfig } from '../scripts/lib/spike/config.mjs';
import { draftHash, readRiskTemplate } from '../scripts/lib/spike/config-draft.mjs';
import { runDir, TRIAL_DIR, writeJsonAtomic } from '../scripts/lib/spike/home.mjs';
import { createRun } from '../scripts/lib/spike/state.mjs';
import { subcommandOf } from './helpers/fake-git.mjs';
import { fakeTools, sandboxGit, tempDir } from './helpers/git-sandbox.mjs';
import { guardNetwork } from './helpers/no-network.mjs';
import { B, PROJECT_URL, SLUG, checkoutUnder, issue, oldRecord, respikeFixture, snapshotDir, walk } from './helpers/respike-fixture.mjs';

guardNetwork();

const json = r => JSON.parse(r.stdout);
const pick = [PROJECT_URL, '--cards', B];
const BACKEND_URL = 'https://github.com/acme/backend.git';

test('a url-only repo found under a root is drafted, reviewed and written with one backup, and preflight stops asking for it', async () => {
  const fx = respikeFixture({ config: c => ({ ...c, repos: { backend: { ...c.repos.backend, checkout: null, url: BACKEND_URL } } }) });
  const root = tempDir('keiron-sequencer-respike-roots-');
  after(() => rmSync(root, { recursive: true, force: true }));
  checkoutUnder(root, 'backend', { from: fx.origin.dir, remoteUrl: BACKEND_URL, head: 'main' });
  const before = readFileSync(join(fx.home, 'config.json'));
  const blocked = await fx.run('preflight', pick);
  assert.deepEqual(json(blocked).missingConfig.filter(g => g.code === 'repo-not-local').map(g => g.repo), ['backend']);

  const out = join(fx.scratch, 'draft-1.json');
  const draft = await fx.run('config', [...pick, '--out', out, '--root', root]);
  assert.equal(draft.code, 0, draft.stderr);
  const { approve } = json(draft);
  assert.match(approve, /^[0-9a-f]{12}$/);

  const review = await fx.run('config', ['--draft', out]);
  assert.equal(review.code, 0, review.stderr);
  assert.equal(json(review).approve, approve);

  const write = await fx.run('config', ['--draft', out, '--approve', approve]);
  assert.equal(write.code, 0, write.stderr);
  assert.deepEqual(readFileSync(join(fx.home, 'config.json.bak')), before);
  assert.equal(readFileSync(join(fx.home, 'config.json'), 'utf8'), readFileSync(out, 'utf8'));
  const written = loadConfig(fx.home, { userHome: fx.deps.userHome });
  assert.equal(written.repos.backend.checkout, join(root, 'backend'));
  assert.equal(written.repos.backend.url, null);

  const again = await fx.run('preflight', pick);
  assert.deepEqual(json(again).missingConfig.filter(g => g.code === 'repo-not-local'), []);
});

test('a config entry whose name is not a string is still searched for by its dir, never thrown on', async () => {
  const fx = respikeFixture({ config: c => ({ ...c, repos: { backend: { ...c.repos.backend, name: 7, checkout: null, url: BACKEND_URL } } }) });
  const root = tempDir('keiron-sequencer-respike-roots-');
  after(() => rmSync(root, { recursive: true, force: true }));
  checkoutUnder(root, 'backend', { from: fx.origin.dir, remoteUrl: BACKEND_URL, head: 'main' });
  const draft = await fx.run('config', [...pick, '--out', join(fx.scratch, 'draft-1.json'), '--root', root]);
  assert.equal(draft.code, 0, draft.stderr);
  const lines = json(draft).items.filter(i => i.code === 'repo-not-local').flatMap(i => i.lines);
  assert.deepEqual(lines.map(l => [l.path, l.value]), [['repos.backend.checkout', join(root, 'backend')], ['repos.backend.url', null]]);
});

test('a configured repo with no risk is proposed the example template, read from the injected example path', async () => {
  const fx = respikeFixture({ config: c => ({ ...c, repos: { backend: { ...c.repos.backend, risk: undefined } } }) });
  const example = join(fx.scratch, 'example.json');
  writeFileSync(example, JSON.stringify({ repos: { a: { risk: [{ kind: 'secrets', paths: ['**/secrets/**'] }] } } }));
  const draft = await fx.run('config', [...pick, '--out', join(fx.scratch, 'draft-1.json')], { riskTemplate: example });
  assert.equal(draft.code, 0, draft.stderr);
  const lines = json(draft).items.filter(i => i.code === 'risk-missing').flatMap(i => i.lines);
  assert.deepEqual(lines.map(l => [l.kind, l.path, l.value]), [['proposed', 'repos.backend.risk', [{ kind: 'secrets', paths: ['**/secrets/**'] }]]]);
  assert.deepEqual(JSON.parse(readFileSync(join(fx.scratch, 'draft-1.json'), 'utf8')).repos.backend.risk, [{ kind: 'secrets', paths: ['**/secrets/**'] }]);
});

test('a plan with no config gap has nothing to draft: no file, no hash', async () => {
  const fx = respikeFixture();
  const out = join(fx.scratch, 'draft-1.json');
  const draft = await fx.run('config', [...pick, '--out', out]);
  assert.equal(draft.code, 0, draft.stderr);
  const result = json(draft);
  assert.deepEqual([result.draft, result.approve], [null, null]);
  assert.match(result.message, /nothing to draft/);
  assert.equal(existsSync(out), false);
});

// A fresh set of tools per call, all installed unless a test says otherwise; the fixture's own runner says yes to anything.
const TOOLS = { corepack: '0.29.4', yarn: '1.22.22', npm: '10.8.1', pnpm: '9.12.0', go: 'go version go1.22.0 darwin/arm64' };
const config = (fx, argv, extra = {}) => fx.run('config', argv, { runSetup: fakeTools(TOOLS).run, ...extra });
const urlOnly = () => respikeFixture({ config: c => ({ ...c, repos: { backend: { ...c.repos.backend, checkout: null, url: BACKEND_URL } } }) });
const rootDir = () => {
  const root = tempDir('keiron-sequencer-respike-roots-');
  after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};
const homeState = fx => ({ home: snapshotDir(fx.home), data: snapshotDir(fx.dataDir) });

const riskMissing = () => respikeFixture({ config: c => ({ ...c, repos: { backend: { ...c.repos.backend, risk: undefined } } }) });

test('with no trial patch map the draft goes ahead and writes its file', async () => {
  const fx = riskMissing();
  assert.equal(existsSync(join(fx.deps.trialLogDir, 'backfill', 'patch-map.json')), false);
  const out = join(fx.scratch, 'draft-1.json');
  const draft = await config(fx, [...pick, '--out', out]);
  assert.equal(draft.code, 0, draft.stderr);
  assert.equal(existsSync(out), true);
});

test('a trial patch map that is there but cannot be read or parsed stops the draft with exit 2 naming its path, never its text', async () => {
  for (const [label, plant] of [
    ['not JSON', path => writeFileSync(path, '{"repos": planted-patch-map-marker')],
    ['a folder', path => mkdirSync(path)],
  ]) {
    const fx = riskMissing();
    const path = join(fx.deps.trialLogDir, 'backfill', 'patch-map.json');
    mkdirSync(join(fx.deps.trialLogDir, 'backfill'), { recursive: true });
    plant(path);
    const out = join(fx.scratch, 'draft-1.json');
    const draft = await config(fx, [...pick, '--out', out]);
    assert.equal(draft.code, 2, `${label}: ${draft.stdout}`);
    assert.ok(draft.stderr.includes(path), `${label}: ${draft.stderr}`);
    assert.doesNotMatch(draft.stdout + draft.stderr, /planted-patch-map-marker|Unexpected token|JSON at position/, label);
    assert.equal(existsSync(out), false, label);
  }
});

test('the draft step refuses a usage error with exit 2 before any request: no ref, both --out and --draft, neither', async () => {
  const fx = respikeFixture();
  const out = join(fx.scratch, 'draft-1.json');
  for (const argv of [['--out', out], [...pick, '--out', out, '--draft', out], [...pick], [...pick, '--out']]) {
    const r = await config(fx, argv);
    assert.equal(r.code, 2, `${argv.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, /usage: node scripts\/respike\.mjs config/);
  }
  assert.equal(fx.linear.sent.length, 0);
  assert.equal(existsSync(out), false);
});

test('a draft path inside the home, the data dir or a repo is refused with exit 2 before any request, and nothing is written there', async () => {
  const fx = respikeFixture();
  const before = homeState(fx);
  for (const out of [join(fx.home, 'draft.json'), join(fx.home, 'config.json'), join(fx.dataDir, 'draft.json'), join(fx.repo.dir, 'draft.json')]) {
    const r = await config(fx, [...pick, '--out', out]);
    assert.equal(r.code, 2, `${out}: ${r.stderr}`);
    assert.match(r.stderr, /draft path/);
    if (!out.endsWith('config.json')) assert.equal(existsSync(out), false, out);
  }
  assert.deepEqual(homeState(fx), before);
  assert.equal(fx.linear.sent.length, 0);
});

test('an --out file that already exists is refused with exit 2 and left as it was', async () => {
  const fx = urlOnly();
  const out = join(fx.scratch, 'draft-1.json');
  writeFileSync(out, 'my edits\n');
  const r = await config(fx, [...pick, '--out', out, '--root', rootDir()]);
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /already exists/);
  assert.equal(readFileSync(out, 'utf8'), 'my edits\n');
  assert.equal(fx.linear.sent.length, 0);
});

test('a relative or missing --root is refused with exit 2 before the key is read, and nothing is stored', async () => {
  const fx = urlOnly();
  const before = homeState(fx);
  const out = join(fx.scratch, 'draft-1.json');
  for (const root of ['src', './src', join(fx.scratch, 'no-such-folder'), '~/no-such-folder']) {
    const r = await config(fx, [...pick, '--out', out, '--root', rootDir(), '--root', root], { keyFile: join(fx.scratch, 'no-key') });
    assert.equal(r.code, 2, `${root}: ${r.stderr}`);
    assert.match(r.stderr, /--root/);
  }
  assert.equal(existsSync(out), false);
  assert.equal(fx.linear.sent.length, 0);
  assert.deepEqual(homeState(fx), before);
});

test('the draft path is checked before the roots, and the roots before the key', async () => {
  const fx = urlOnly();
  const noKey = { keyFile: join(fx.scratch, 'no-key') };
  const both = await config(fx, [...pick, '--out', join(fx.home, 'd.json'), '--root', 'src'], noKey);
  assert.equal(both.code, 2);
  assert.match(both.stderr, /draft path/);
  assert.doesNotMatch(both.stderr, /--root/);
  const root = await config(fx, [...pick, '--out', join(fx.scratch, 'd.json'), '--root', 'src'], noKey);
  assert.equal(root.code, 2);
  assert.match(root.stderr, /--root/);
});

test('with no Linear key the draft step exits 3 before any request and writes no file', async () => {
  const fx = urlOnly();
  const out = join(fx.scratch, 'draft-1.json');
  const r = await config(fx, [...pick, '--out', out, '--root', rootDir()], { keyFile: join(fx.scratch, 'no-key') });
  assert.equal(r.code, 3, r.stderr);
  assert.equal(fx.linear.sent.length, 0);
  assert.equal(existsSync(out), false);
});

test('a config.json that is not JSON, is empty or is not an object is reported with exit 2, never drafted from and left as it was', async () => {
  for (const [text, why] of [['{"repos":', /not valid JSON/], ['', /empty/], ['[]', /not a JSON object/], ['null', /not a JSON object/]]) {
    const fx = urlOnly();
    writeFileSync(join(fx.home, 'config.json'), text);
    const before = homeState(fx);
    const out = join(fx.scratch, 'draft-1.json');
    const r = await config(fx, [...pick, '--out', out, '--root', rootDir()]);
    assert.equal(r.code, 2, `${JSON.stringify(text)}: ${r.stderr}`);
    assert.match(r.stderr, why);
    assert.match(r.stderr, /config\.json/);
    assert.match(r.stderr, /never replaced/);
    assert.equal(existsSync(out), false);
    assert.deepEqual(homeState(fx), before);
    assert.equal(existsSync(join(fx.home, 'config.json.bak')), false);
  }
});

test('an open run does not block the draft step', async () => {
  const fx = urlOnly();
  const project = { id: 'project-uuid', slug: SLUG, name: 'P', url: PROJECT_URL };
  const runId = '20261105T100000Z';
  const state = createRun({ runId, project, plan: { fetchedAt: '2026-11-05T10:00:00.000Z', order: [], skipped: [], cards: {} }, home: fx.home, dataDir: fx.dataDir, now: new Date('2026-11-05T10:00:00.000Z') });
  state.status = 'active';
  writeJsonAtomic(join(runDir(fx.home, SLUG, runId), 'run.json'), state);
  const root = rootDir();
  checkoutUnder(root, 'backend', { from: fx.origin.dir, remoteUrl: BACKEND_URL, head: 'main' });
  const r = await config(fx, [...pick, '--out', join(fx.scratch, 'draft-1.json'), '--root', root]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(json(r).approve, /^[0-9a-f]{12}$/);
});

const ABSENCE = /absent|no local copy|not on (this|the) machine|missing from the machine|does not exist on/i;

test('the draft and review output carries the report, the change list and the diff, and a credential in the base url never shows', async () => {
  const secret = ['SECRETA', 'SECRETB'];
  const planted = `https://x-token:${secret.join('"')}@github.com/acme/backend.git`;
  const fx = respikeFixture({ config: c => ({ ...c, repos: { backend: { ...c.repos.backend, checkout: null, url: planted } } }) });
  const root = rootDir();
  checkoutUnder(root, 'backend', { from: fx.origin.dir, remoteUrl: BACKEND_URL, head: 'main' });
  const out = join(fx.scratch, 'draft-1.json');
  const draft = await config(fx, [...pick, '--out', out, '--root', root]);
  assert.equal(draft.code, 0, draft.stderr);
  const shown = json(draft);
  assert.deepEqual(Object.keys(shown).sort(), [
    'action', 'approve', 'base', 'changes', 'diff', 'draft', 'errors', 'fixes', 'items', 'needs', 'reformat', 'roots', 'stray', 'valid', 'warnings',
  ]);
  assert.deepEqual([shown.action, shown.draft, shown.valid, shown.errors, shown.reformat], ['config-draft', out, true, [], true]);
  assert.deepEqual(shown.base, { state: 'read', issues: [] });
  assert.deepEqual(shown.roots, { searched: [root], missing: [], from: 'flag' });
  assert.deepEqual(shown.changes.filter(c => c.path === 'repos.backend.url').map(c => [c.op, c.before, c.after]), [['set', 'https://***@github.com/acme/backend.git', null]]);
  assert.ok(shown.changes.some(c => c.op === 'add' && c.path === 'checkoutRoots'));
  assert.ok(shown.diff.some(l => l.startsWith('- ') && l.includes('"url": "https://***@github.com')), shown.diff.join('\n'));
  assert.ok(shown.diff.some(l => l.startsWith('+ ') && l.includes('"checkout"')));

  const review = await config(fx, ['--draft', out]);
  assert.equal(review.code, 0, review.stderr);
  const reviewed = json(review);
  assert.deepEqual(Object.keys(reviewed).sort(), ['action', 'approve', 'base', 'changes', 'diff', 'draft', 'errors', 'reformat', 'stray', 'valid']);
  assert.deepEqual([reviewed.action, reviewed.approve, reviewed.valid], ['config-review', shown.approve, true]);
  assert.deepEqual(reviewed.changes, shown.changes);
  assert.deepEqual(reviewed.diff, shown.diff);

  const write = await config(fx, ['--draft', out, '--approve', shown.approve]);
  assert.equal(write.code, 0, write.stderr);
  for (const r of [draft, review, write]) for (const text of [r.stdout, r.stderr]) {
    for (const part of secret) assert.equal(text.includes(part), false, text);
    assert.doesNotMatch(text, ABSENCE);
  }
});

// A url-only backend found under a root, drafted into the scratch dir: the draft path and its hash.
async function drafted(fx = urlOnly(), name = 'draft-1.json') {
  const root = rootDir();
  checkoutUnder(root, 'backend', { from: fx.origin.dir, remoteUrl: BACKEND_URL, head: 'main' });
  const out = join(fx.scratch, name);
  const r = await config(fx, [...pick, '--out', out, '--root', root]);
  assert.equal(r.code, 0, r.stderr);
  return { fx, out, approve: json(r).approve, root };
}

test('a draft edited after its hash was shown is refused with exit 5 and nothing is written', async () => {
  const { fx, out, approve } = await drafted();
  writeFileSync(out, readFileSync(out, 'utf8').replace('"main"', '"mainx"'));
  const before = homeState(fx);
  const r = await config(fx, ['--draft', out, '--approve', approve]);
  assert.equal(r.code, 5, r.stderr);
  assert.match(r.stderr, /changed since its hash was shown/);
  assert.deepEqual(homeState(fx), before);
  assert.equal(existsSync(join(fx.home, 'config.json.bak')), false);
});

test('a config.json changed or deleted after the hash was shown refuses the write with exit 5', async () => {
  for (const change of [home => writeFileSync(join(home, 'config.json'), `${readFileSync(join(home, 'config.json'), 'utf8')} `), home => rmSync(join(home, 'config.json'))]) {
    const { fx, out, approve } = await drafted();
    change(fx.home);
    const before = homeState(fx);
    const r = await config(fx, ['--draft', out, '--approve', approve]);
    assert.equal(r.code, 5, r.stderr);
    assert.deepEqual(homeState(fx), before);
  }
});

test('a config.json that appears after a bootstrap draft refuses the write with exit 5 and is left as it was', async () => {
  const fx = respikeFixture();
  rmSync(join(fx.home, 'config.json'));
  const root = rootDir();
  checkoutUnder(root, 'backend', { from: fx.origin.dir, remoteUrl: BACKEND_URL, head: 'main' });
  const out = join(fx.scratch, 'draft-1.json');
  const draft = await config(fx, [...pick, '--out', out, '--root', root]);
  assert.equal(draft.code, 0, draft.stderr);
  const { approve } = json(draft);
  assert.match(approve, /^[0-9a-f]{12}$/);
  writeFileSync(join(fx.home, 'config.json'), '{"appeared":true}\n');
  const r = await config(fx, ['--draft', out, '--approve', approve]);
  assert.equal(r.code, 5, r.stderr);
  assert.equal(readFileSync(join(fx.home, 'config.json'), 'utf8'), '{"appeared":true}\n');
  assert.equal(existsSync(join(fx.home, 'config.json.bak')), false);
});

test('an edited draft gets a new hash at review; the old hash is refused and the new one writes exactly the edited bytes', async () => {
  const { fx, out, approve } = await drafted();
  const edited = readFileSync(out, 'utf8').replace('"main"', '"trunk"');
  writeFileSync(out, edited);
  const review = await config(fx, ['--draft', out]);
  assert.equal(review.code, 0, review.stderr);
  const fresh = json(review).approve;
  assert.match(fresh, /^[0-9a-f]{12}$/);
  assert.notEqual(fresh, approve);
  assert.ok(json(review).changes.some(c => c.path === 'repos.backend.defaultBranch' && c.after === 'trunk'));
  assert.equal((await config(fx, ['--draft', out, '--approve', approve])).code, 5);
  assert.equal((await config(fx, ['--draft', out, '--approve', fresh.slice(0, 8)])).code, 5);
  const write = await config(fx, ['--draft', out, '--approve', fresh]);
  assert.equal(write.code, 0, write.stderr);
  assert.equal(readFileSync(join(fx.home, 'config.json'), 'utf8'), edited);
  assert.deepEqual(json(write), { action: 'config-written', path: join(fx.home, 'config.json'), backup: join(fx.home, 'config.json.bak'), approve: fresh });
});

test('a draft edited into an invalid config gets no hash at review, and a write with its hash is refused with exit 2', async () => {
  const { fx, out } = await drafted();
  const text = readFileSync(out, 'utf8').replace('"url": null', '"url": "https://github.com/acme/backend.git"');
  writeFileSync(out, text);
  const review = await config(fx, ['--draft', out]);
  assert.equal(review.code, 0, review.stderr);
  const reviewed = json(review);
  assert.deepEqual([reviewed.approve, reviewed.valid], [null, false]);
  assert.deepEqual(reviewed.errors, ['repos.backend: set exactly one of checkout and url']);
  const before = homeState(fx);
  const write = await config(fx, ['--draft', out, '--approve', draftHash(readFileSync(join(fx.home, 'config.json')), text)]);
  assert.equal(write.code, 2, write.stderr);
  assert.match(write.stderr, /set exactly one of checkout and url/);
  assert.deepEqual(homeState(fx), before);
});

test('a draft holding a URL with credentials is refused at the write with exit 2, naming the path and never the value', async () => {
  const { fx, out } = await drafted();
  const text = readFileSync(out, 'utf8').replace('"remote": "origin"', '"remote": "origin", "mirror": "https://u:SECRETC@host/x"');
  writeFileSync(out, text);
  const review = await config(fx, ['--draft', out]);
  assert.deepEqual([review.code, json(review).approve], [0, null]);
  const before = homeState(fx);
  const write = await config(fx, ['--draft', out, '--approve', draftHash(readFileSync(join(fx.home, 'config.json')), text)]);
  assert.equal(write.code, 2, write.stderr);
  assert.match(write.stderr, /repos\.backend\.mirror/);
  for (const r of [review, write]) assert.equal(`${r.stdout}${r.stderr}`.includes('SECRETC'), false);
  assert.deepEqual(homeState(fx), before);
});

test('a credential holding a quote never shows when a refused write or a refused --root echoes it', async () => {
  const { fx, out } = await drafted();
  const secret = ['SECRETD', 'SECRETE', 'SECRETF', 'SECRETG', 'SECRETH', 'SECRETI'];
  const value = JSON.parse(readFileSync(out, 'utf8'));
  value.repos[`https://x-token:${secret[0]}"${secret[1]}@github.com`] = { name: 'x', url: 'https://github.com/acme/x.git', remote: 'origin' };
  value.projects[SLUG].repos.push(`https://x-token:${secret[2]}"${secret[3]}@github.com/acme/x`);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(out, text);
  const review = await config(fx, ['--draft', out]);
  assert.deepEqual([review.code, json(review).approve], [0, null]);
  const before = homeState(fx);
  const write = await config(fx, ['--draft', out, '--approve', draftHash(readFileSync(join(fx.home, 'config.json')), text)]);
  assert.equal(write.code, 2, write.stdout);
  assert.match(write.stderr, /https:\/\/\*\*\*@github\.com/);
  assert.deepEqual(homeState(fx), before);
  const root = await config(fx, [...pick, '--out', join(fx.scratch, 'draft-2.json'), '--root', `ssh://u:${secret[4]}"${secret[5]}@host`]);
  assert.equal(root.code, 2, root.stdout);
  assert.match(root.stderr, /--root ssh:\/\/\*\*\*@host/);
  for (const r of [review, write, root]) for (const part of secret) assert.equal(`${r.stdout}${r.stderr}`.includes(part), false, `${r.stdout}${r.stderr}`);
});

test('a draft that is not a JSON object, or is not there, is refused at review and at the write with exit 2', async () => {
  const { fx, out } = await drafted();
  const before = homeState(fx);
  for (const text of ['{"repos":', '[]', 'null']) {
    writeFileSync(out, text);
    const review = await config(fx, ['--draft', out]);
    assert.equal(review.code, 2, `${text}: ${review.stdout}`);
    assert.match(review.stderr, /draft/);
    const write = await config(fx, ['--draft', out, '--approve', draftHash(readFileSync(join(fx.home, 'config.json')), text)]);
    assert.equal(write.code, 2, `${text}: ${write.stdout}`);
  }
  const gone = join(fx.scratch, 'no-such-draft.json');
  assert.equal((await config(fx, ['--draft', gone])).code, 2);
  assert.equal((await config(fx, ['--draft', gone, '--approve', 'abcdefabcdef'])).code, 2);
  assert.deepEqual(homeState(fx), before);
});

test('a config.json that is not a JSON object is never compared with at review and never replaced by a write', async () => {
  const { fx, out } = await drafted();
  writeFileSync(join(fx.home, 'config.json'), '{"repos":');
  const before = homeState(fx);
  const review = await config(fx, ['--draft', out]);
  assert.equal(review.code, 2, review.stdout);
  assert.match(review.stderr, /never replaced/);
  const write = await config(fx, ['--draft', out, '--approve', draftHash(readFileSync(join(fx.home, 'config.json')), readFileSync(out, 'utf8'))]);
  assert.equal(write.code, 2, write.stdout);
  assert.match(write.stderr, /never replaced/);
  assert.deepEqual(homeState(fx), before);
});

test('review and write refuse a draft inside the home, the data dir or a repo with exit 2, and the home stays as it was', async () => {
  const { fx, out } = await drafted();
  const text = readFileSync(out, 'utf8');
  const approve = draftHash(readFileSync(join(fx.home, 'config.json')), text);
  for (const inside of [join(fx.home, 'draft.json'), join(fx.dataDir, 'draft.json'), join(fx.repo.dir, 'draft.json')]) {
    writeFileSync(inside, text);
    const before = homeState(fx);
    const review = await config(fx, ['--draft', inside]);
    assert.equal(review.code, 2, `${inside}: ${review.stdout}`);
    assert.match(review.stderr, /draft path/);
    const write = await config(fx, ['--draft', inside, '--approve', approve]);
    assert.equal(write.code, 2, `${inside}: ${write.stdout}`);
    assert.match(write.stderr, /draft path/);
    assert.deepEqual(homeState(fx), before);
    assert.equal(existsSync(join(fx.home, 'config.json.bak')), false);
    rmSync(inside);
  }
});

const subcommands = fx => fx.git.calls.map(c => c.argv.find(x => !x.startsWith('-')));

test('with no roots stored or given and a repo to look for, the draft step asks for --root with exit 2, prints the gaps and reads no folder', async () => {
  const fx = urlOnly();
  const before = homeState(fx);
  const out = join(fx.scratch, 'draft-1.json');
  const r = await config(fx, [...pick, '--out', out]);
  assert.equal(r.code, 2, r.stdout);
  assert.match(r.stderr, /no checkout roots: ask the user once which folders hold their checkouts and pass each with --root <dir>/);
  assert.match(r.stderr, /backend: repo-not-local, needed by/);
  assert.equal(existsSync(out), false);
  assert.deepEqual(subcommands(fx).filter(s => s === 'remote' || s === 'symbolic-ref'), []);
  assert.deepEqual(homeState(fx), before);
});

test('roots given with none stored are proposed as checkoutRoots and stored by the write', async () => {
  const { fx, out, approve, root } = await drafted();
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')).checkoutRoots, [root]);
  assert.equal((await config(fx, ['--draft', out, '--approve', approve])).code, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(fx.home, 'config.json'), 'utf8')).checkoutRoots, [root]);
});

test('stored roots are searched when no --root is given; a --root replaces them for that call only, and a stored root that is gone is listed', async () => {
  const stored = rootDir();
  const gone = join(stored, 'gone');
  const fx = respikeFixture({ config: c => ({ ...c, checkoutRoots: [stored, gone], repos: { backend: { ...c.repos.backend, checkout: null, url: BACKEND_URL } } }) });
  const given = rootDir();
  checkoutUnder(given, 'backend', { from: fx.origin.dir, remoteUrl: BACKEND_URL, head: 'main' });

  const fromConfig = await config(fx, [...pick, '--out', join(fx.scratch, 'draft-1.json')]);
  assert.equal(fromConfig.code, 0, fromConfig.stderr);
  const shown = json(fromConfig);
  assert.deepEqual(shown.roots, { searched: [stored, gone], missing: [gone], from: 'config' });
  assert.equal(shown.draft, null);
  assert.match(shown.items.find(i => i.code === 'repo-not-local').lines[0].text, new RegExp(`^not found under ${stored}, ${gone}`));

  const fromFlag = await config(fx, [...pick, '--out', join(fx.scratch, 'draft-2.json'), '--root', given]);
  assert.equal(fromFlag.code, 0, fromFlag.stderr);
  const flagged = json(fromFlag);
  assert.deepEqual(flagged.roots, { searched: [given], missing: [], from: 'flag' });
  assert.deepEqual(flagged.changes.filter(c => c.path.startsWith('checkoutRoots')), []);
  assert.deepEqual(JSON.parse(readFileSync(flagged.draft, 'utf8')).checkoutRoots, [stored, gone]);
});

test('a --root under the user home is accepted as ~/, searched, proposed ~/-relative, and two spellings of one folder count once', async () => {
  const fx = urlOnly();
  const src = join(fx.deps.userHome, 'src');
  mkdirSync(src);
  checkoutUnder(src, 'backend', { from: fx.origin.dir, remoteUrl: BACKEND_URL, head: 'main' });
  const out = join(fx.scratch, 'draft-1.json');
  const r = await config(fx, [...pick, '--out', out, '--root', '~/src', '--root', `${src}/`]);
  assert.equal(r.code, 0, r.stderr);
  const shown = json(r);
  assert.deepEqual(shown.roots.searched, [src]);
  assert.equal(shown.valid, true);
  const text = JSON.parse(readFileSync(out, 'utf8'));
  assert.deepEqual(text.checkoutRoots, ['~/src']);
  assert.equal(text.repos.backend.checkout, '~/src/backend');
});

const keysOf = value => (value && typeof value === 'object' ? Object.entries(value).flatMap(([k, v]) => [...(Array.isArray(value) ? [] : [k]), ...keysOf(v)]) : []);
const VERSION_ARGVS = [['corepack', '--version'], ['yarn', '--version'], ['npm', '--version'], ['pnpm', '--version'], ['go', 'version']].map(a => a.join(' '));

test('with every tool missing, a yarn 4 repo is drafted with setup null and a needs line, and the draft still validates, carries a hash and writes', async () => {
  const fx = respikeFixture({ config: c => ({ ...c, repos: { backend: { ...c.repos.backend, checkout: null, url: BACKEND_URL, setup: undefined } } }) });
  const root = rootDir();
  const dir = checkoutUnder(root, 'backend', { from: fx.origin.dir, remoteUrl: BACKEND_URL, head: 'main' });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ packageManager: 'yarn@4.1.0' }));
  writeFileSync(join(dir, 'yarn.lock'), '__metadata:\n  version: 8\n');
  const tools = fakeTools({});
  const out = join(fx.scratch, 'draft-1.json');
  const draft = await config(fx, [...pick, '--out', out, '--root', root], { runSetup: tools.run });
  assert.equal(draft.code, 0, draft.stderr);
  const shown = json(draft);
  const setupLines = shown.items.filter(i => i.code === 'setup-missing').flatMap(i => i.lines);
  assert.deepEqual(setupLines.map(l => [l.kind, l.path, l.reason]), [['unfilled', 'repos.backend.setup', 'needs yarn 4 via corepack, or yarn 4 on PATH']]);
  assert.deepEqual(shown.needs, [{ repo: 'backend', text: 'needs yarn 4 via corepack, or yarn 4 on PATH' }]);
  assert.deepEqual([shown.valid, shown.errors], [true, []]);
  assert.match(shown.approve, /^[0-9a-f]{12}$/);
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).repos.backend.setup, undefined);
  assert.deepEqual(tools.calls.map(c => c.argv.join(' ')), ['corepack --version', 'yarn --version']);

  const reviewTools = fakeTools({});
  const review = await config(fx, ['--draft', out], { runSetup: reviewTools.run });
  assert.equal(json(review).approve, shown.approve);
  const write = await config(fx, ['--draft', out, '--approve', shown.approve], { runSetup: reviewTools.run });
  assert.equal(write.code, 0, write.stderr);
  assert.deepEqual(reviewTools.calls, []);
  assert.equal(loadConfig(fx.home, { userHome: fx.deps.userHome }).repos.backend.checkout, dir);
  for (const r of [draft, review, write]) {
    assert.deepEqual(keysOf(json(r)).filter(k => /install/i.test(k)), []);
    assert.doesNotMatch(r.stdout, /--global|\bbrew\b|corepack enable|apt-get|winget/);
  }
});

test('a setup the tools allow is proposed from the first installed candidate, each tool probed once with its version argv only', async () => {
  const fx = respikeFixture({ config: c => ({ ...c, repos: { backend: { ...c.repos.backend, checkout: null, url: BACKEND_URL, setup: undefined } } }) });
  const root = rootDir();
  const dir = checkoutUnder(root, 'backend', { from: fx.origin.dir, remoteUrl: BACKEND_URL, head: 'main' });
  writeFileSync(join(dir, 'yarn.lock'), '# yarn lockfile v1\n');
  const tools = fakeTools({ yarn: '1.22.22' });
  const draft = await config(fx, [...pick, '--out', join(fx.scratch, 'draft-1.json'), '--root', root], { runSetup: tools.run });
  assert.equal(draft.code, 0, draft.stderr);
  const lines = json(draft).items.filter(i => i.code === 'setup-missing').flatMap(i => i.lines);
  assert.deepEqual(lines.map(l => [l.kind, l.value]), [['proposed', [['yarn', 'install', '--frozen-lockfile']]]]);
  const argvs = tools.calls.map(c => c.argv.join(' '));
  assert.deepEqual(argvs.filter(a => !VERSION_ARGVS.includes(a)), []);
  assert.equal(new Set(argvs).size, argvs.length);
  assert.ok(tools.calls.every(c => c.cwd === fx.deps.tmpRoot));
});

test('install is not a respike subcommand: exit 2 with usage, and no tool runs', async () => {
  const fx = respikeFixture();
  const tools = fakeTools(TOOLS);
  const r = await fx.run('install', ['yarn'], { runSetup: tools.run });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /usage: node scripts\/respike\.mjs config/);
  assert.deepEqual(tools.calls, []);
});

test('an origin URL credential and a git error quoting it never reach the output, the draft, config.json or its backup', async () => {
  const sentinel = 'ghp_SENTINEL_config_cred';
  const fx = urlOnly();
  const root = rootDir();
  checkoutUnder(root, 'backend', { from: fx.origin.dir, remoteUrl: `https://x-token:${sentinel}@github.com/acme/backend.git`, head: 'main' });
  checkoutUnder(root, 'broken', { from: fx.origin.dir, remoteUrl: BACKEND_URL, head: 'main' });
  const git = (args, opts = {}) => {
    if (opts.cwd === join(root, 'broken')) throw new Error(`fatal: could not read https://x-token:${sentinel}@github.com/acme/backend.git`);
    return fx.deps.git(args, opts);
  };
  const out = join(fx.scratch, 'draft-1.json');
  const draft = await config(fx, [...pick, '--out', out, '--root', root], { git });
  assert.equal(draft.code, 0, draft.stderr);
  const { approve } = json(draft);
  const review = await config(fx, ['--draft', out], { git });
  const write = await config(fx, ['--draft', out, '--approve', approve], { git });
  assert.equal(write.code, 0, write.stderr);
  const texts = [draft, review, write].flatMap(r => [r.stdout, r.stderr]);
  texts.push(...['config.json', 'config.json.bak'].map(f => readFileSync(join(fx.home, f), 'utf8')), readFileSync(out, 'utf8'));
  for (const text of texts) assert.equal(text.includes(sentinel), false, text);
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).repos.backend.remote, 'origin');
});

test('the draft reports on exactly the gaps preflight blocks on, with the same selection flags', async () => {
  const fx = respikeFixture({ config: c => ({ ...c, repos: { backend: { ...c.repos.backend, checkout: null, url: BACKEND_URL, setup: undefined, risk: undefined } } }) });
  const root = rootDir();
  checkoutUnder(root, 'backend', { from: fx.origin.dir, remoteUrl: BACKEND_URL, head: 'main' });
  for (const [i, flags] of [pick, [...pick, '--stale'], [PROJECT_URL, '--cards', `${B},CRM-1`]].entries()) {
    const pre = await fx.run('preflight', flags);
    assert.equal(pre.code, 2, pre.stdout);
    const draft = await config(fx, [...flags, '--out', join(fx.scratch, `draft-${i}.json`), '--root', root]);
    assert.equal(draft.code, 0, draft.stderr);
    const pairs = list => list.map(g => `${g.code} ${g.repo}`).sort();
    assert.deepEqual(pairs(json(draft).items), pairs(json(pre).missingConfig));
    assert.ok(json(draft).items.length >= 3);
  }
});

test('draft and review leave the home and the data dir byte-identical, backup included; only the draft file is created', async () => {
  const fx = urlOnly();
  writeFileSync(join(fx.home, 'config.json.bak'), '{"earlier":true}\n');
  const root = rootDir();
  checkoutUnder(root, 'backend', { from: fx.origin.dir, remoteUrl: BACKEND_URL, head: 'main' });
  const before = homeState(fx);
  const scratch = walk(fx.scratch);
  const out = join(fx.scratch, 'draft-1.json');
  assert.equal((await config(fx, [...pick, '--out', out, '--root', root])).code, 0);
  const drafted = readFileSync(out);
  assert.equal((await config(fx, ['--draft', out])).code, 0);
  assert.deepEqual(homeState(fx), before);
  assert.deepEqual(walk(fx.scratch), [...scratch, 'draft-1.json'].sort());
  assert.deepEqual(readFileSync(out), drafted);
});

const PLAN_READS = ['for-each-ref', 'rev-parse', 'cat-file', 'rev-list', 'log', 'merge-base', 'merge-tree', 'diff'];

test('over the whole draft step git only reads: the plan reads, remote -v and symbolic-ref; review and write run no git at all', async () => {
  const fx = respikeFixture({
    issues: d => [...d.map(i => (i.identifier === B ? { ...i, description: 'Do it.\nRepo: web' } : i)), issue('CRM-8', { description: 'Repo: api' })],
  });
  const root = rootDir();
  checkoutUnder(root, 'web', { from: fx.origin.dir, remoteUrl: 'git@github.com:acme/web.git', head: 'main' });
  const other = checkoutUnder(root, 'other-dir', { from: fx.origin.dir, remoteUrl: 'https://github.com/acme/api.git', head: 'main' });
  sandboxGit(['worktree', 'add', '-q', '-b', 'side', join(root, 'api')], { cwd: other });
  mkdirSync(join(root, 'junk', '.git'), { recursive: true });
  writeFileSync(join(root, 'junk', '.git', 'HEAD'), 'not a ref\n');
  const flags = [PROJECT_URL, '--cards', `${B},CRM-8`, '--stale'];
  const out = join(fx.scratch, 'draft-1.json');
  fx.git.calls.length = 0;
  const draft = await config(fx, [...flags, '--out', out, '--root', root]);
  assert.equal(draft.code, 0, draft.stderr);
  const shown = json(draft);
  const lines = repo => shown.items.filter(i => i.repo === repo).flatMap(i => i.lines);
  assert.ok(lines('web').some(l => l.path === 'repos.web.checkout' && l.value === join(root, 'web')), JSON.stringify(shown.items));
  assert.ok(lines('api').some(l => l.path === 'repos.api.checkout' && l.value === other), JSON.stringify(shown.items));
  assert.ok(lines('api').some(l => l.path === 'repos.api.github' && l.value === 'acme/api'));
  assert.ok(lines('web').some(l => l.path === 'repos.web.defaultBranch' && l.value === 'main'));
  assert.ok(lines('api').some(l => l.kind === 'skipped' && l.text.includes(join(root, 'api'))), JSON.stringify(lines('api')));

  // The plan's one write is the default-branch fetch, which moves only that remote-tracking ref.
  const subs = fx.git.calls.filter(c => !/^fetch -q \S+ main$/.test(c.argv.join(' '))).map(c => subcommandOf(c.argv));
  assert.ok(subs.some(s => PLAN_READS.includes(s)), subs.join(' '));
  assert.deepEqual([...new Set(subs)].filter(s => !PLAN_READS.includes(s) && s !== 'remote' && s !== 'symbolic-ref'), []);
  assert.deepEqual(fx.git.calls.filter(c => subcommandOf(c.argv) === 'remote').map(c => c.argv), fx.git.calls.filter(c => subcommandOf(c.argv) === 'remote').map(() => ['remote', '-v']));
  for (const banned of ['clone', 'fetch', 'ls-remote', 'worktree add', 'config', 'checkout', 'commit', 'push']) assert.equal(subs.includes(banned), false, banned);

  fx.git.calls.length = 0;
  const review = await config(fx, ['--draft', out]);
  const write = await config(fx, ['--draft', out, '--approve', shown.approve]);
  assert.deepEqual([review.code, write.code], [0, 0], write.stderr);
  assert.deepEqual(fx.git.calls, []);
});

test('~/ paths stay unexpanded through draft, review and write, and loadConfig still expands them', async () => {
  const fx = respikeFixture({
    issues: d => d.map(i => (i.identifier === B ? { ...i, description: 'Do it.\nRepo: web' } : i)),
    config: c => ({ ...c, repos: { backend: { ...c.repos.backend, checkout: '~/src/api' } } }),
  });
  const src = join(fx.deps.userHome, 'src');
  mkdirSync(src);
  checkoutUnder(src, 'api', { from: fx.origin.dir, remoteUrl: BACKEND_URL, head: 'main' });
  checkoutUnder(src, 'web', { from: fx.origin.dir, remoteUrl: 'https://github.com/acme/web.git', head: 'main' });
  const out = join(fx.scratch, 'draft-1.json');
  const draft = await config(fx, [...pick, '--out', out, '--root', '~/src']);
  assert.equal(draft.code, 0, draft.stderr);
  const { approve } = json(draft);
  assert.equal(json(await config(fx, ['--draft', out])).approve, approve);
  const write = await config(fx, ['--draft', out, '--approve', approve]);
  assert.equal(write.code, 0, write.stderr);
  const text = readFileSync(join(fx.home, 'config.json'), 'utf8');
  assert.equal(text, readFileSync(out, 'utf8'));
  for (const path of ['"~/src/api"', '"~/src/web"', '"~/src"']) assert.ok(text.includes(path), path);
  assert.equal(text.includes(fx.deps.userHome), false, text);
  const loaded = loadConfig(fx.home, { userHome: fx.deps.userHome });
  assert.deepEqual([loaded.repos.backend.checkout, loaded.repos.web.checkout], [join(src, 'api'), join(src, 'web')]);
});

test('with no config.json the draft is a whole file over a missing base; the write creates it with no backup', async () => {
  const fx = respikeFixture();
  rmSync(join(fx.home, 'config.json'));
  const root = rootDir();
  checkoutUnder(root, 'backend', { from: fx.origin.dir, remoteUrl: BACKEND_URL, head: 'main' });
  const out = join(fx.scratch, 'draft-1.json');
  const draft = await config(fx, [...pick, '--out', out, '--root', root]);
  assert.equal(draft.code, 0, draft.stderr);
  const shown = json(draft);
  assert.deepEqual(shown.base, { state: 'missing', issues: [] });
  assert.equal(shown.reformat, false);
  const text = readFileSync(out, 'utf8');
  assert.equal(shown.approve, draftHash(null, text));
  const value = JSON.parse(text);
  assert.deepEqual(Object.keys(value), ['schemaVersion', 'checkoutRoots', 'repos']);
  assert.deepEqual(value.checkoutRoots, [root]);
  assert.equal(value.repos.backend.checkout, join(root, 'backend'));
  assert.deepEqual(Object.keys(value.repos.backend), ['name', 'github', 'checkout', 'url', 'remote', 'defaultBranch', 'setup', 'risk']);
  assert.deepEqual([value.repos.backend.github, value.repos.backend.remote, value.repos.backend.defaultBranch], ['acme/backend', 'origin', 'main']);
  assert.ok(shown.diff.every(l => l.startsWith('+ ')));
  const write = await config(fx, ['--draft', out, '--approve', shown.approve]);
  assert.equal(write.code, 0, write.stderr);
  assert.equal(json(write).backup, null);
  assert.equal(existsSync(join(fx.home, 'config.json.bak')), false);
  assert.equal(readFileSync(join(fx.home, 'config.json'), 'utf8'), text);
  loadConfig(fx.home, { userHome: fx.deps.userHome });
});

test('with no config.json and nothing found under the roots there is nothing to draft, no file is created and preflight still blocks', async () => {
  const fx = respikeFixture();
  rmSync(join(fx.home, 'config.json'));
  const root = rootDir();
  const before = homeState(fx);
  const out = join(fx.scratch, 'draft-1.json');
  const draft = await config(fx, [...pick, '--out', out, '--root', root]);
  assert.equal(draft.code, 0, draft.stderr);
  const shown = json(draft);
  assert.deepEqual([shown.draft, shown.approve, shown.message], [null, null, 'nothing to draft']);
  assert.deepEqual(shown.roots.searched, [root]);
  assert.ok(shown.items.length > 0);
  for (const item of shown.items) assert.ok(item.lines.some(l => l.kind === 'not-found' && l.text.startsWith(`not found under ${root}`)), JSON.stringify(item));
  assert.doesNotMatch(draft.stdout, ABSENCE);
  assert.equal(existsSync(out), false);
  assert.deepEqual(homeState(fx), before);
  const pre = await fx.run('preflight', pick);
  assert.equal(pre.code, 2);
  assert.match(pre.stderr, /cannot read the spike config/);
});

test('a parseable config that does not validate is drafted on top: valid parts kept, stray key kept, failing parts redrafted or reset, and the write passes preflight', async () => {
  const root = rootDir();
  const web = {
    name: 'web', github: 'Acme web', chekout: join(root, 'web'), remote: 'origin', defaultBranch: 'main', setup: [], branchNaming: 'other',
    risk: [{ kind: 'pii-in-logs', paths: ['**'] }, { kind: 'auth', paths: ['src/auth/**'] }],
  };
  const fx = respikeFixture({ config: c => ({ ...c, repos: { ...c.repos, web } }) });
  checkoutUnder(root, 'web', { from: fx.origin.dir, remoteUrl: 'https://github.com/acme/web.git', head: 'main' });
  const base = JSON.parse(readFileSync(join(fx.home, 'config.json'), 'utf8'));
  const blocked = await fx.run('preflight', pick);
  assert.equal(blocked.code, 2);
  assert.match(blocked.stderr, /invalid spike config/);

  const out = join(fx.scratch, 'draft-1.json');
  const draft = await config(fx, [...pick, '--out', out, '--root', root]);
  assert.equal(draft.code, 0, draft.stderr);
  const shown = json(draft);
  assert.equal(shown.valid, true, JSON.stringify(shown.errors));
  assert.match(shown.approve, /^[0-9a-f]{12}$/);
  const value = JSON.parse(readFileSync(out, 'utf8'));
  assert.deepEqual(value.repos.backend, base.repos.backend);
  assert.deepEqual(value.projects, base.projects);
  assert.equal(value.repos.web.chekout, join(root, 'web'));
  assert.deepEqual([value.repos.web.checkout, value.repos.web.github, value.repos.web.branchNaming], [join(root, 'web'), 'acme/web', null]);
  assert.deepEqual(value.repos.web.risk, [{ kind: 'auth', paths: ['src/auth/**'] }]);
  assert.deepEqual(shown.stray.map(s => [s.path, s.suggestion]), [['repos.web.chekout', 'checkout']]);
  assert.ok(shown.changes.some(c => c.op === 'set' && c.path === 'repos.web.branchNaming' && c.before === 'other' && c.after === null));
  const carried = new Set(shown.fixes.flatMap(l => l.issues ?? []));
  for (const issue of shown.base.issues) assert.ok(carried.has(issue), issue);

  const write = await config(fx, ['--draft', out, '--approve', shown.approve]);
  assert.equal(write.code, 0, write.stderr);
  assert.equal(JSON.parse(readFileSync(join(fx.home, 'config.json.bak'), 'utf8')).repos.web.branchNaming, 'other');
  const after = await fx.run('preflight', pick);
  assert.equal(after.code, 0, after.stderr);
});

test('a repo dir key the config refuses is kept, the draft gets no hash, the write is refused and preflight still blocks on the same file', async () => {
  const fx = respikeFixture({
    config: c => ({ ...c, repos: { backend: { ...c.repos.backend, checkout: null, url: BACKEND_URL }, 'bad key': { name: 'x', url: 'https://github.com/acme/x.git', remote: 'origin' } } }),
  });
  const root = rootDir();
  checkoutUnder(root, 'backend', { from: fx.origin.dir, remoteUrl: BACKEND_URL, head: 'main' });
  const out = join(fx.scratch, 'draft-1.json');
  const draft = await config(fx, [...pick, '--out', out, '--root', root]);
  assert.equal(draft.code, 0, draft.stderr);
  const shown = json(draft);
  assert.deepEqual([shown.approve, shown.valid], [null, false]);
  assert.ok(shown.errors.some(e => e.startsWith('repos.bad key')), JSON.stringify(shown.errors));
  const text = readFileSync(out, 'utf8');
  assert.deepEqual(JSON.parse(text).repos['bad key'], { name: 'x', url: 'https://github.com/acme/x.git', remote: 'origin' });
  const before = homeState(fx);
  const write = await config(fx, ['--draft', out, '--approve', draftHash(readFileSync(join(fx.home, 'config.json')), text)]);
  assert.equal(write.code, 2, write.stdout);
  assert.deepEqual(homeState(fx), before);
  const pre = await fx.run('preflight', pick);
  assert.equal(pre.code, 2);
  assert.match(pre.stderr, /invalid spike config/);
});

test('every gap of a mixed project gets a line, and after the write preflight reports only the gaps the draft could not fill', async () => {
  const named = { 'CRM-8': 'alpha', 'CRM-9': 'gomod', 'CRM-10': 'nowhere', 'CRM-11': 'twin' };
  const patched = { 'CRM-12': 'delta/00012-x.patch', 'CRM-13': 'old-gamma/00013-x.patch' };
  const fx = respikeFixture({
    issues: d => [...d, ...Object.entries(named).map(([k, r]) => issue(k, { description: `Repo: ${r}` })), ...Object.keys(patched).map(k => issue(k))],
    config: c => ({ ...c, repos: { backend: { ...c.repos.backend, risk: undefined } } }),
  });
  for (const [card, patch] of Object.entries(patched)) {
    const record = oldRecord(card, { spikedAt: '2026-11-01T11:30:00.000Z', patches: [patch] });
    writeFileSync(join(fx.dataDir, SLUG, `${card}.json`), serializeRecord(record));
  }
  mkdirSync(join(fx.deps.trialLogDir, 'backfill'), { recursive: true });
  writeFileSync(join(fx.deps.trialLogDir, 'backfill', 'patch-map.json'), JSON.stringify({ project: { slug: SLUG }, repos: { 'old-gamma': 'gamma' }, patches: {} }));
  const [one, two] = [rootDir(), rootDir()];
  const clone = (root, name) => checkoutUnder(root, name, { from: fx.origin.dir, remoteUrl: `https://github.com/acme/${name}.git`, head: 'main' });
  writeFileSync(join(clone(one, 'alpha'), 'package-lock.json'), '{}\n');
  writeFileSync(join(clone(one, 'gomod'), 'go.mod'), 'module gomod\n');
  clone(one, 'delta');
  clone(one, 'twin');
  clone(two, 'twin');
  const flags = [PROJECT_URL, '--cards', [B, ...Object.keys(named), ...Object.keys(patched)].join(',')];
  const pre = json(await fx.run('preflight', flags));
  const pairs = list => list.map(g => `${g.code} ${g.repo}`).sort();

  const goMissing = await config(fx, [...flags, '--out', join(fx.scratch, 'draft-1.json'), '--root', one, '--root', two], { runSetup: fakeTools({ npm: '10.8.1' }).run });
  assert.equal(goMissing.code, 0, goMissing.stderr);
  const lineOf = (shown, repo) => shown.items.filter(i => i.repo === repo).flatMap(i => i.lines);
  assert.ok(lineOf(json(goMissing), 'gomod').some(l => l.kind === 'unfilled' && l.reason === 'needs go'));
  assert.deepEqual(json(goMissing).needs, [{ repo: 'gomod', text: 'needs go' }]);

  const out = join(fx.scratch, 'draft-2.json');
  const draft = await config(fx, [...flags, '--out', out, '--root', one, '--root', two]);
  assert.equal(draft.code, 0, draft.stderr);
  const shown = json(draft);
  assert.deepEqual(pairs(shown.items), pairs(pre.missingConfig));
  for (const item of shown.items) assert.ok(item.lines.length > 0, JSON.stringify(item));
  assert.doesNotMatch(draft.stdout, ABSENCE);
  assert.deepEqual(lineOf(shown, 'gomod').find(l => l.path === 'repos.gomod.setup').value, [['go', 'mod', 'download']]);
  assert.deepEqual(lineOf(shown, 'alpha').find(l => l.path === 'repos.alpha.setup').value, [['npm', 'ci']]);
  assert.deepEqual(lineOf(shown, 'delta').filter(l => l.kind === 'unfilled').map(l => [l.path, l.reason]), [['repos.delta.setup', 'no ecosystem detected']]);
  assert.deepEqual(lineOf(shown, 'old-gamma').map(l => l.kind), ['rename-trial-dirs']);
  const nowhere = lineOf(shown, 'nowhere');
  assert.deepEqual(nowhere.map(l => [l.kind, l.roots]), [['not-found', [one, two]]]);
  assert.match(nowhere[0].text, new RegExp(`^not found under ${one}, ${two}.*clone it yourself.*add a root.*leave its cards out with --cards`));
  const twin = lineOf(shown, 'twin');
  assert.deepEqual(twin.map(l => l.kind), ['unfilled']);
  for (const path of [join(one, 'twin'), join(two, 'twin')]) assert.ok(twin[0].reason.includes(path), twin[0].reason);
  assert.deepEqual(lineOf(shown, 'backend').map(l => [l.path, l.value]), [['repos.backend.risk', readRiskTemplate(fileURLToPath(new URL('../docs/spike-config.example.json', import.meta.url)))]]);

  const value = JSON.parse(readFileSync(out, 'utf8'));
  assert.deepEqual(Object.keys(value.repos), ['backend', 'alpha', 'delta', 'gomod']);
  assert.deepEqual(value.projects[SLUG].repos, ['backend', 'alpha', 'delta', 'gomod']);
  assert.equal(value.repos['old-gamma'], undefined);
  assert.equal(shown.valid, true, JSON.stringify(shown.errors));
  const write = await config(fx, ['--draft', out, '--approve', shown.approve]);
  assert.equal(write.code, 0, write.stderr);

  const again = await fx.run('preflight', flags);
  assert.equal(again.code, 2, again.stdout);
  const open = new Set(shown.items.filter(i => i.lines.some(l => ['not-found', 'unfilled', 'rename-trial-dirs'].includes(l.kind))).map(i => i.repo));
  assert.deepEqual(open, new Set(['delta', 'nowhere', 'old-gamma', 'twin']));
  assert.deepEqual(new Set(json(again).missingConfig.map(g => g.repo)), open);
  assert.deepEqual(pairs(json(again).missingConfig), ['repo-missing nowhere', 'repo-missing twin', 'setup-missing delta', 'trial-dir-unmapped old-gamma']);
});

test('reading the trial reference from the home: a trial folder gap with trial patches but no patch map stops the draft with exit 2 naming the path; with no trial patches, or with the map in place, the draft goes ahead', async () => {
  const fx = respikeFixture({
    issues: d => [...d, issue('CRM-13')],
    config: c => ({ ...c, repos: { backend: { ...c.repos.backend, risk: undefined } } }),
  });
  writeFileSync(join(fx.dataDir, SLUG, 'CRM-13.json'), serializeRecord(oldRecord('CRM-13', { spikedAt: '2026-11-01T11:30:00.000Z', patches: ['old-gamma/00013-x.patch'] })));
  const flags = [PROJECT_URL, '--cards', [B, 'CRM-13'].join(','), '--root', rootDir()];
  const fromHome = { trialLogDir: undefined };
  const lineOf = (shown, repo) => shown.items.filter(i => i.repo === repo).flatMap(i => i.lines);

  const noTrial = await config(fx, [...flags, '--out', join(fx.scratch, 'draft-1.json')], fromHome);
  assert.equal(noTrial.code, 0, noTrial.stderr);

  mkdirSync(join(fx.home, SLUG, TRIAL_DIR), { recursive: true });
  const out = join(fx.scratch, 'draft-2.json');
  const stopped = await config(fx, [...flags, '--out', out], fromHome);
  const map = join(fx.home, SLUG, 'trial-reference', 'backfill', 'patch-map.json');
  assert.equal(stopped.code, 2, stopped.stdout);
  assert.ok(stopped.stderr.includes(map), stopped.stderr);
  assert.match(stopped.stderr, /move-reference\.mjs/);
  assert.equal(existsSync(out), false);

  mkdirSync(join(fx.home, SLUG, 'trial-reference', 'backfill'), { recursive: true });
  writeFileSync(map, JSON.stringify({ project: { slug: SLUG }, repos: { 'old-gamma': 'gamma' }, patches: {} }));
  const read = await config(fx, [...flags, '--out', out], fromHome);
  assert.equal(read.code, 0, read.stderr);
  assert.deepEqual(lineOf(json(read), 'old-gamma').map(l => l.kind), ['rename-trial-dirs']);
});
