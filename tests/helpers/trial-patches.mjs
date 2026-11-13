import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MINI = fileURLToPath(new URL('../fixtures/mini-trial/', import.meta.url));
export const MINI_LINEAR = join(MINI, 'linear-snapshot.json');
export const MINI_PATCHES = JSON.parse(readFileSync(new URL('../fixtures/mini-trial-patches.json', import.meta.url), 'utf8'));

export function materialize(patches = MINI_PATCHES) {
  const root = mkdtempSync(join(tmpdir(), 'keiron-sequencer-patches-'));
  for (const [path, text] of Object.entries(patches)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}
