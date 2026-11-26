import { existsSync } from 'node:fs';
import { PR_LIST_FIELDS } from './respike/built.mjs';
import { allowedRepos, configPath, loadConfig } from './spike/config.mjs';
import { isMerged, isOpen } from './start/base.mjs';
import { carriesKey, titleTag } from './start/checkout.mjs';

// A card has started once Linear moves it past Backlog, Todo or Triage, a PR carrying its key is open or merged, or a branch
// carrying its key is pushed: the signals next and respike read too. Harvest writes no notes or description on a started
// card unless the user names it in writeStarted, so text fixed by hand to match what shipped is never reverted.

const NOT_STARTED = new Set(['backlog', 'unstarted', 'triage']);

const firstLine = text => String(text ?? '').split('\n').map(l => l.trim()).find(Boolean) ?? 'unknown error';

// The PR lists and pushed heads of every repo of the project; a read that fails is a failure, never "nothing there".
export function readGithub({ gh, git, home, slug }) {
  if (!existsSync(configPath(home))) return { config: null, unread: 'no spike config, so GitHub was not read: only the Linear states tell a started card' };
  let config;
  try {
    config = loadConfig(home);
  } catch (e) {
    return { config: null, unread: `the spike config could not be read (${firstLine(e.message)}), so GitHub was not read: only the Linear states tell a started card` };
  }
  const prs = [];
  const heads = [];
  const failures = [];
  for (const dir of allowedRepos(config, slug)) {
    const repo = config.repos[dir];
    if (repo?.github) {
      const r = gh(['pr', 'list', '--repo', repo.github, '--state', 'all', '--limit', '500', '--json', PR_LIST_FIELDS]);
      if (r.status !== 0) failures.push(`gh pr list --repo ${repo.github} failed (${r.status}): ${firstLine(r.stderr)}`);
      else {
        try {
          prs.push(...JSON.parse(r.stdout).map(p => ({ ...p, github: repo.github })));
        } catch {
          failures.push(`gh pr list --repo ${repo.github} returned no JSON`);
        }
      }
    }
    if (repo?.checkout && repo.remote) {
      try {
        const out = git(['ls-remote', '--heads', repo.remote], { cwd: repo.checkout });
        for (const line of out.split('\n').filter(Boolean)) heads.push({ name: line.split('\t')[1]?.replace(/^refs\/heads\//, ''), repo: repo.name ?? dir });
      } catch (e) {
        failures.push(`git ls-remote ${repo.remote} in ${repo.name ?? dir} failed: ${firstLine(e.message)}`);
      }
    }
  }
  return { config, prs, heads: heads.filter(h => h.name), failures };
}

// card -> why it counts as started. With GitHub unread for lack of a config, only Linear decides; with a read that failed,
// a card Linear calls unstarted is not known to be unstarted, so it counts as started too.
export function startedCards(raw, github) {
  const out = new Map();
  for (const issue of raw.issues ?? []) {
    const key = issue.identifier;
    if (!NOT_STARTED.has(issue.state?.type)) { out.set(key, `Linear says ${issue.state?.name ?? 'unknown'}`); continue; }
    if (!github?.config) continue;
    const pr = github.prs.find(p => titleTag(key).test(String(p.title ?? '')) && (isOpen(p) || isMerged(p)));
    if (pr) { out.set(key, `PR #${pr.number} ${isMerged(pr) ? 'merged' : 'open'} in ${pr.github}`); continue; }
    const head = github.heads.find(h => carriesKey(h.name, key));
    if (head) { out.set(key, `branch ${head.name} pushed to ${head.repo}`); continue; }
    if (github.failures.length) out.set(key, `GitHub could not be read: ${github.failures.join('; ')}`);
  }
  return out;
}
