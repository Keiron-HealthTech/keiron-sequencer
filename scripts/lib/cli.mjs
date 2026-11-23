import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { redact } from './linear-fetch.mjs';

export const lines = messages => messages.map(m => `${String(m).replace(/\s*\n\s*/g, ' ')}\n`).join('');

export const fail = (code, ...messages) => ({ code, stdout: '', stderr: lines(messages) });

export const exitError = (code, message) => Object.assign(new Error(message), { exitCode: code });

export const ok = value => ({ code: 0, stdout: `${JSON.stringify(value)}\n`, stderr: '' });

// An error that carries an `output` answers it as JSON beside its message (busy, for one).
export const failed = e => ({ ...fail(e.exitCode ?? 1, e.message), ...(e.output ? { stdout: `${JSON.stringify(e.output)}\n` } : {}) });

export const redacted = (result, key) => ({ ...result, stdout: redact(result.stdout, key), stderr: redact(result.stderr, key) });

export function parseArgs(args, flags = [], repeatable = []) {
  const out = { positional: [], flags: {} };
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) { out.positional.push(args[i]); continue; }
    const many = repeatable.includes(args[i]);
    if ((!flags.includes(args[i]) && !many) || i + 1 >= args.length) return null;
    const name = args[i].slice(2);
    out.flags[name] = many ? [...(out.flags[name] ?? []), args[++i]] : args[++i];
  }
  return out;
}

export const isEntry = moduleUrl => {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(moduleUrl)); } catch { return false; }
};
