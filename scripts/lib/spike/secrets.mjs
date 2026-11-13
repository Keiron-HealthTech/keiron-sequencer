import { basename } from 'node:path';

const LINE_RULES = [
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['aws-access-key', /AKIA[0-9A-Z]{16}/],
  ['github-token', /gh[pousr]_[A-Za-z0-9]{36,}/],
  ['linear-key', /lin_api_[A-Za-z0-9]{32,}/],
  ['slack-token', /xox[abprs]-/],
  ['assignment', /(api[_-]?key|secret|password|token)\s*[:=]\s*['"][^'"\s]{12,}['"]/i],
];

export const SECRET_KINDS = [...LINE_RULES.map(([kind]) => kind), 'secret-file'];

const isSecretFile = path => {
  const name = basename(path);
  return (name === '.env' || (name.startsWith('.env.') && name !== '.env.example')) || name.endsWith('.pem') || name.startsWith('id_rsa');
};

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

// Only added lines are read; the hit names where the line is, never what it holds.
export function scanPatch(text, allow = []) {
  const hits = [];
  let file = null;
  const flush = () => {
    if (file && !file.deleted && isSecretFile(file.path)) hits.push({ path: file.path, line: file.firstAdded, kind: 'secret-file' });
  };
  let line = 0;
  for (const raw of text.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      flush();
      file = { path: raw.split(' b/').at(-1), deleted: false, firstAdded: null, inHunk: false };
      continue;
    }
    if (!file) continue;
    const hunk = raw.match(HUNK);
    if (hunk) { file.inHunk = true; line = Number(hunk[1]); continue; }
    if (!file.inHunk) {
      if (raw.startsWith('deleted file mode')) file.deleted = true;
      continue;
    }
    if (raw.startsWith('+')) {
      file.firstAdded ??= line;
      for (const [kind, rule] of LINE_RULES) if (rule.test(raw.slice(1))) hits.push({ path: file.path, line, kind });
      line++;
    } else if (raw.startsWith(' ')) {
      line++;
    }
  }
  flush();
  return hits.filter(h => !allow.some(a => a.kind === h.kind && a.path === h.path));
}
