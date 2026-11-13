import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupRunner } from '../scripts/lib/spike/exec.mjs';
import { GENERATED_TSCONFIG, runCommand, runTypecheck } from '../scripts/lib/spike/typecheck.mjs';
import { tempDir } from './helpers/git-sandbox.mjs';
import { guardNetwork } from './helpers/no-network.mjs';

guardNetwork();

const DIR = tempDir('keiron-sequencer-typecheck-');
after(() => rmSync(DIR, { recursive: true, force: true }));
const runner = setupRunner();
let n = 0;
const fresh = () => { const d = join(DIR, `case-${++n}`); mkdirSync(d, { recursive: true }); return d; };

// A tree with a tsconfig and a fake tsc that prints the project file it was given and fails when it names bad.ts.
function tsTree() {
  const tree = fresh();
  writeFileSync(join(tree, 'tsconfig.json'), '{ "compilerOptions": { "strict": true }, "exclude": ["**/*.spec.ts"] }\n');
  mkdirSync(join(tree, 'node_modules', '.bin'), { recursive: true });
  const tsc = join(tree, 'node_modules', '.bin', 'tsc');
  writeFileSync(tsc, [
    '#!/usr/bin/env node',
    "const fs = require('fs');",
    "const p = process.argv[process.argv.indexOf('-p') + 1];",
    "const text = fs.readFileSync(p, 'utf8');",
    'console.log(`project ${p}`);',
    'console.log(text);',
    "if (text.includes('outside.ts')) { console.log('src/old.ts(2,24): error TS2305: Module has no exported member.'); process.exit(2); }",
    "if (text.includes('crash.ts')) { console.log('error TS5083: Cannot read file tsconfig.json.'); process.exit(1); }",
    "if (text.includes('bad.ts')) console.log('src/bad.ts(1,7): error TS2322: Type string is not assignable to type number.');",
    "process.exit(text.includes('bad.ts') ? 2 : 0);",
    '',
  ].join('\n'));
  chmodSync(tsc, 0o755);
  return tree;
}

test('a timeout returns ok false, timedOut true, with the log tail', () => {
  const cwd = fresh();
  const logPath = join(cwd, 'logs', 'typecheck-api.log');
  const r = runCommand(runner, [process.execPath, '-e', "console.log('started'); setTimeout(() => {}, 5000)"], { cwd, timeoutMs: 300, logPath });
  assert.deepEqual([r.ok, r.timedOut, r.status], [false, true, null]);
  assert.match(r.tail, /timed out after 300 ms/);
  assert.match(readFileSync(logPath, 'utf8'), /timed out/);
  const done = runCommand(runner, [process.execPath, '-e', "console.log('fine')"], { cwd, timeoutMs: 5000, logPath });
  assert.deepEqual([done.ok, done.timedOut, done.status], [true, false, 0]);
  assert.match(done.tail, /fine/);
});

test('no spikeTypecheck means no check when the tree is not a TypeScript project, and false turns the check off', () => {
  const plain = fresh();
  const none = runTypecheck(runner, { setting: undefined, treePath: plain, changed: ['src/a.js'], logPath: join(plain, 'x.log') });
  assert.deepEqual([none.ran, none.skipped], [false, 'no-typescript-project']);
  const ts = tsTree();
  const off = runTypecheck(runner, { setting: false, treePath: ts, changed: ['src/a.ts'], logPath: join(ts, 'x.log') });
  assert.deepEqual([off.ran, off.skipped], [false, 'off']);
  const nothing = runTypecheck(runner, { setting: undefined, treePath: ts, changed: ['README.md'], logPath: join(ts, 'x.log') });
  assert.deepEqual([nothing.ran, nothing.skipped], [false, 'no-typescript-changes']);
});

test('with no config, a TypeScript tree is checked through a generated tsconfig that adds the changed files, specs included, and is removed after', () => {
  const tree = tsTree();
  const logPath = join(fresh(), 'typecheck-api.log');
  const ok = runTypecheck(runner, { setting: undefined, treePath: tree, changed: ['src/a.ts', 'src/a.spec.ts', 'README.md'], logPath });
  assert.equal(ok.ran, true);
  assert.equal(ok.ok, true, ok.tail);
  const shown = JSON.parse(ok.tail.slice(ok.tail.indexOf('{'), ok.tail.lastIndexOf('}') + 1));
  assert.deepEqual(shown.files, ['src/a.spec.ts', 'src/a.ts']);
  assert.equal('include' in shown, false);
  assert.equal(shown.extends, './tsconfig.json');
  assert.equal(shown.compilerOptions.noEmit, true);
  assert.doesNotMatch(GENERATED_TSCONFIG, new RegExp('mi' + 'kado', 'i'));
  assert.equal(existsSync(join(tree, GENERATED_TSCONFIG)), false);
  const bad = runTypecheck(runner, { setting: undefined, treePath: tree, changed: ['src/bad.ts'], logPath });
  assert.deepEqual([bad.ran, bad.ok, bad.status], [true, false, 2]);
  assert.equal(existsSync(join(tree, GENERATED_TSCONFIG)), false);
});

test('a configured argv runs as given, with {changed} expanded, and is skipped when nothing changed', () => {
  const cwd = fresh();
  const logPath = join(cwd, 'tc.log');
  const setting = [process.execPath, '-e', 'console.log(process.argv.slice(1).join(","))', '{changed}'];
  const r = runTypecheck(runner, { setting, treePath: cwd, changed: ['a.ts', 'b.ts'], logPath });
  assert.equal(r.ok, true, r.tail);
  assert.match(r.tail, /a\.ts,b\.ts/);
  assert.deepEqual([runTypecheck(runner, { setting, treePath: cwd, changed: [], logPath }).skipped], ['no-changes']);
});

test('the generated tsconfig keeps the repo\'s own include, so the whole program is checked, with the changed files added', () => {
  const tree = tsTree();
  const r = runTypecheck(runner, { setting: undefined, treePath: tree, changed: ['src/b.ts', 'src/a.spec.ts'], logPath: join(fresh(), 'tc.log') });
  assert.equal(r.ok, true, r.tail);
  const shown = JSON.parse(r.tail.slice(r.tail.indexOf('{'), r.tail.lastIndexOf('}') + 1));
  assert.equal('include' in shown, false, 'the repo include is inherited, not overridden');
  assert.deepEqual(shown.files, ['src/a.spec.ts', 'src/b.ts']);
  assert.deepEqual(r.argv.slice(1), ['-p', GENERATED_TSCONFIG, '--pretty', 'false']);
});

test('in auto mode, errors only in files the card did not change are reported, not refused; an error in a changed file refuses', () => {
  const tree = tsTree();
  const logPath = join(fresh(), 'tc.log');
  const outside = runTypecheck(runner, { setting: undefined, treePath: tree, changed: ['src/outside.ts'], logPath });
  assert.deepEqual([outside.ran, outside.ok, outside.status], [true, true, 2]);
  assert.deepEqual(outside.ignored, ['src/old.ts(2,24): error TS2305: Module has no exported member.']);
  const inside = runTypecheck(runner, { setting: undefined, treePath: tree, changed: ['src/bad.ts'], logPath });
  assert.deepEqual([inside.ok, inside.ignored], [false, []]);
  const crashed = runTypecheck(runner, { setting: undefined, treePath: tree, changed: ['src/crash.ts'], logPath });
  assert.equal(crashed.ok, false, 'a failure with no error located in a file still refuses');
  const custom = runTypecheck(runner, { setting: [process.execPath, '-e', "console.log('x.ts(1,1): error TS1: y'); process.exit(2)"], treePath: tree, changed: ['a.ts'], logPath });
  assert.equal(custom.ok, false, 'a configured command keeps its own exit status');
});
