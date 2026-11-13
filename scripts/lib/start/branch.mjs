export function fetchRemote(git, plan, { cwd }) {
  const { remote } = plan.fetch;
  if (!remote) return { refused: `no remote to fetch: ${plan.checkout.path} is not a configured checkout` };
  git(['fetch', '--quiet', remote], { cwd });
  return { action: 'fetched', remote };
}

const ACCEPTABLE = new Set(['pr-merged', 'pr-closed']);

function validName(git, name, { cwd }) {
  try {
    git(['check-ref-format', '--branch', name], { cwd });
    return true;
  } catch {
    return false;
  }
}

function chosenName(git, plan, name, { cwd }) {
  if (name === undefined) return plan.branch.name ? { name: plan.branch.name } : { refused: `${plan.card.key} has no branch name to start from` };
  if (!plan.branch.editable) return { refused: `--name is only for a strip-card-id repo; ${plan.checkout.name} names branches ${plan.branch.rule}` };
  if (!validName(git, name, { cwd })) return { refused: `--name ${name} is not a valid branch name` };
  return { name };
}

export function createBranch(git, plan, { cwd, name, accept = [] }) {
  if (plan.action === 'resume') {
    return { refused: `the plan resumes ${plan.resume.branches.map(b => b.name).join(', ')}: run branch --resume ${plan.resume.branches[0].name}; a started branch is never renamed` };
  }
  const blocking = plan.reasons.filter(r => r.blocking).map(r => r.code);
  const bad = accept.filter(code => !ACCEPTABLE.has(code) || !blocking.includes(code));
  if (bad.length) return { refused: `--accept ${bad.join(', ')}: only a pr-merged or pr-closed reason of this plan can be accepted` };
  const cleared = plan.action === 'ask' && accept.length > 0 && blocking.every(code => accept.includes(code));
  if (plan.action !== 'create' && !cleared) {
    return { refused: `the plan is ${plan.action} (${blocking.join(', ') || 'no reason'}), not create: nothing is created` };
  }
  const chosen = chosenName(git, plan, name, { cwd });
  if (chosen.refused) return chosen;
  git(['checkout', '-b', chosen.name, plan.base.ref], { cwd });
  return { action: 'created', branch: chosen.name, base: plan.base.ref };
}

export function resumeBranch(git, plan, name, { cwd }) {
  if (plan.action !== 'resume') return { refused: `the plan is ${plan.action}, not resume: there is no branch to resume` };
  const found = plan.resume.branches.find(b => b.name === name);
  if (!found) return { refused: `${name} is not a branch of ${plan.card.key}; the plan resumes ${plan.resume.branches.map(b => b.name).join(', ')}` };
  if (found.where === 'worktree') return { refused: `${name} is checked out in ${found.path}: work there, this checkout is not switched` };
  if (plan.checkout.branch === name) return { action: 'already-on', branch: name };
  const args = found.where === 'local' ? ['checkout', name] : ['checkout', '-b', name, '--track', `${plan.checkout.remote}/${name}`];
  git(args, { cwd });
  return { action: 'resumed', branch: name };
}
