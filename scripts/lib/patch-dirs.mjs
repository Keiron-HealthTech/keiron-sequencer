import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const MANIFEST = 'dirs.json';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const PATCH_REF = /^(patch:)?([^/\s]+)\/([^/\s]+\.patch)$/;

export function readDirMap(root) {
  try {
    const { dirs } = JSON.parse(readFileSync(join(root, MANIFEST), 'utf8'));
    return isObject(dirs) ? { ...dirs } : {};
  } catch {
    return {};
  }
}

export function renamePatchRefs(value, map) {
  if (typeof value === 'string') {
    const m = PATCH_REF.exec(value);
    return m && Object.hasOwn(map, m[2]) ? `${m[1] ?? ''}${map[m[2]]}/${m[3]}` : value;
  }
  if (Array.isArray(value)) return value.map(v => renamePatchRefs(v, map));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renamePatchRefs(v, map)]));
  return value;
}

export const invert = map => Object.fromEntries(Object.entries(map).map(([from, to]) => [to, from]));
