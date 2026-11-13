import { after } from 'node:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { run as renameTrialDirs } from '../../scripts/maintenance/rename-trial-dirs.mjs';
import { serializeRecord } from '../../scripts/lib/record.mjs';
import { trialPatchRoot } from '../../scripts/lib/spike/home.mjs';
import { tempDir } from './git-sandbox.mjs';

// A valid trial record (no run id): what the backfill wrote for a card spiked by hand.
export const trialRecord = (card, patches, slug) => ({
  schemaVersion: 1,
  card,
  title: `Card ${card}`,
  project: { slug, name: 'Trial store' },
  origin: 'thin-spike',
  spikedAt: '2026-10-01T10:00:00.000Z',
  scope: { complete: true, note: null },
  size: { prodLines: 1, testLines: 0, files: 1, repos: ['example-api'], sharedWith: [], deletionWeight: 0.25 },
  effort: null,
  fixups: { received: [], caused: [] },
  cases: [{ id: 'c1', given: 'a list', when: 'read', then: 'it holds', source: 'patch', ref: `patch:${patches[0]}` }],
  decisions: [],
  findings: [],
  refs: { engram: [], patches, linear: null },
});

// A temp docs trial dir (patch map and logs), home (config and trial patches) and data dir (records); rename runs the
// trial-folder migration on them only.
export function trialStore({ slug, repos, config, patches = {}, records = [], logs = {} }) {
  const trial = tempDir('keiron-sequencer-trial-store-docs-');
  const home = tempDir('keiron-sequencer-trial-store-home-');
  const data = tempDir('keiron-sequencer-trial-store-data-');
  after(() => { for (const d of [trial, home, data]) rmSync(d, { recursive: true, force: true }); });
  const put = (path, text) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  put(join(trial, 'backfill', 'patch-map.json'), JSON.stringify({ schemaVersion: 1, project: { slug, name: 'Trial store' }, repos, patches: {}, cards: {} }));
  for (const [dir, names] of Object.entries(logs)) put(join(trial, dir, 'log.txt'), names.map(n => `${n} ${'a'.repeat(40)}  1 file changed\n`).join(''));
  if (config) put(join(home, 'config.json'), JSON.stringify(config));
  for (const [path, text] of Object.entries(patches)) put(join(trialPatchRoot(home, slug), path), text);
  for (const r of records) put(join(data, slug, `${r.card}.json`), serializeRecord(r));
  return {
    trial, home, data,
    record: card => JSON.parse(readFileSync(join(data, slug, `${card}.json`), 'utf8')),
    rename: (...flags) => renameTrialDirs([...flags, '--home', home, '--data', data, '--trial', trial], { env: {} }),
  };
}
