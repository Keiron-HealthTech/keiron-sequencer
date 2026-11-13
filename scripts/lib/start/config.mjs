import { BRANCH_NAMING } from '../spike/config.mjs';

const isNonEmpty = v => typeof v === 'string' && v.length > 0;

const REQUIRED = [
  ['branchNaming', `${BRANCH_NAMING.map(r => `"${r}"`).join(' or ')} is required to name the branch`],
  ['defaultBranch', 'required, the default branch is never read from the remote'],
  ['github', '<owner>/<repo> is required to look up pull requests'],
  ['remote', 'a remote name is required for the base ref and the fetch'],
];

export function startSettings(config, repoDir) {
  const repo = config.repos[repoDir];
  const errors = REQUIRED.filter(([key]) => !isNonEmpty(repo[key])).map(([key, why]) => `repos.${repoDir}.${key}: ${why}`);
  if (errors.length) return { errors };
  return {
    settings: {
      repoDir, name: repo.name, github: repo.github, remote: repo.remote, defaultBranch: repo.defaultBranch, branchNaming: repo.branchNaming,
      typecheck: repo.typecheck ?? [], typecheckTimeoutMs: repo.typecheckTimeoutMs ?? null, notes: repo.notes ?? [],
    },
  };
}

const NO_NAME = rule => ({ name: null, source: null, rule, editable: false });

export function branchNameFor(rule, gitBranchName, cardKey) {
  if (!isNonEmpty(gitBranchName)) return NO_NAME(rule);
  if (rule !== 'strip-card-id') return { name: gitBranchName, source: 'linear', rule, editable: false };
  const name = gitBranchName.replace(new RegExp(`(^|/)${cardKey}-`, 'gi'), '$1');
  if (name.split('/').some(part => !part)) return NO_NAME(rule);
  return { name, source: 'derived', rule, editable: true };
}
