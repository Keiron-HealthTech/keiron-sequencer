import { resolve } from 'node:path';

const COUNT = /^[1-9]\d*$/;

export function limitsFrom(flags) {
  const read = name => (flags[name] === undefined ? null : COUNT.test(flags[name]) ? Number(flags[name]) : NaN);
  const limits = { caps: { tokens: read('max-tokens'), cards: read('max-cards') }, box: read('box'), workers: read('workers'), checks: read('checks') };
  return [limits.caps.tokens, limits.caps.cards, limits.box, limits.workers, limits.checks].some(Number.isNaN) ? null : limits;
}

export const LIMIT_FLAGS = ['--session-file', '--max-tokens', '--max-cards', '--box', '--workers', '--checks'];

export const sessionsFrom = (flags, at) => (flags['session-file'] ? [{ file: resolve(flags['session-file']), boundAt: at.toISOString(), given: true }] : []);
