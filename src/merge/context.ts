// The checked merge context of `factory merge` (T068, Owner decision 2026-10-11): main is fetched
// and its first-parent history verified once, the release keys are read at the verified head, and
// the pull request's head is resolved from `origin/<branch>` once. Every later check of the merge,
// and the merge itself, reads this context; none resolves main or the branch again.
//
// `merge` needs `.factory/config` on main: without it there is no baseline, pin, ledger or inbox.
// The factory repository before it adopts itself is told to sign merges by hand; any other
// repository is not a factory project.
import { spawnSync } from 'node:child_process';
import { factorySource, laptopKeys, releaseKeysFor, type ReleaseKeys } from '../approvals/keys.js';
import { RefusedError } from '../cli/env.js';
import { newestRelease } from '../commands/new.js';
import { safeGit } from '../git/diff.js';
import { ledgerPath, type KeysFor } from '../git/history.js';
import { verifiedMerges, type MainMerges } from '../git/merges.js';
import { viewPr, type PullRequest } from '../github/prs.js';
import { CONFIG_PATH } from '../install/project.js';
import { ConfigError, parseConfig } from '../model/config.js';
import type { ProjectConfig } from '../model/types.js';
import { originRepo, releaseSource } from './rules.js';

export interface MainContext {
  readonly cwd: string;
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
  /** `.factory/config` at `main`. */
  readonly config: ProjectConfig;
  /** Main's head, whose whole first-parent history verified as Owner-signed. */
  readonly main: string;
  /** The key lists of the release pinned at `main`, its tag checked on the laptop. */
  readonly keys: ReleaseKeys;
  readonly keysFor: KeysFor;
  readonly laptopKeys: ReleaseKeys;
  /** `Factory-Merge:` trailers on verified merge commits, oldest first. */
  readonly merges: MainMerges['merges'];
  /** Main's verified first-parent commits after baseline, oldest first. */
  readonly commits: MainMerges['commits'];
  /** The factory clone releases are read from. */
  readonly factory: string;
  /** `owner/repo` the release pinned at `main` names as its source. */
  readonly factoryRepo: string | undefined;
}

export interface MergeContext extends MainContext {
  readonly pr: PullRequest;
  readonly branch: string;
  /** The checked commit: `origin/<branch>` as fetched, once. */
  readonly head: string;
}

const NOTHING = 'nothing was merged';

function run(cwd: string, env: NodeJS.ProcessEnv, args: readonly string[]) {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    env,
    encoding: 'utf8',
  });
  if (result.error !== undefined) throw new RefusedError(`cannot run git: ${result.error.message}`);
  return {
    ...{ ok: result.status === 0, status: result.status },
    ...{ out: result.stdout, err: result.stderr.trim() },
  };
}

/** Why main without `.factory/config` cannot merge here; only the factory repository merges by hand. */
function noConfig(cwd: string, env: NodeJS.ProcessEnv, home: string): string {
  let isFactory = false;
  try {
    const source = releaseSource(factorySource(env), newestRelease(env, home).sha);
    const origin = safeGit(cwd, ['remote', 'get-url', 'origin'], env).stdout.toString('utf8');
    isFactory = source !== undefined && originRepo(origin) === source;
  } catch {
    // No release the laptop verifies: not identified, so the stricter answer.
  }
  return isFactory
    ? `main has no ${CONFIG_PATH}: sign merges by hand until this repository adopts itself`
    : `no ${CONFIG_PATH} on main: this is not a factory project; run factory new or factory adopt`;
}

function configAt(cwd: string, env: NodeJS.ProcessEnv, ref: string): ProjectConfig | undefined {
  const shown = run(cwd, env, ['show', `${ref}:${CONFIG_PATH}`]);
  if (!shown.ok) return undefined;
  try {
    return parseConfig(shown.out);
  } catch (err) {
    if (err instanceof ConfigError)
      throw new RefusedError(`${CONFIG_PATH} at ${ref}: ${err.message}`);
    throw err;
  }
}

/** Fetch main and verify its first-parent history with the laptop's ledger and key lists. */
export function checkedMain(
  cwd: string,
  env: NodeJS.ProcessEnv,
  home: string,
  scratch: string,
): MainContext {
  const fetched = run(cwd, env, ['fetch', '-q', 'origin', 'main']);
  if (!fetched.ok) throw new RefusedError(`cannot fetch main: ${fetched.err}`);
  const tip = configAt(cwd, env, 'origin/main');
  if (tip === undefined) throw new RefusedError(noConfig(cwd, env, home));

  const laptop = laptopKeys(home);
  const keysFor = releaseKeysFor(env, scratch, laptop);
  const history = verifiedMerges(cwd, keysFor, {
    ...{ baseline: tip.baseline, env, anchorKeys: laptop },
    ledger: ledgerPath(home, tip.repo),
  });
  if (history.rejected !== undefined)
    throw new RefusedError(
      `main has a first-parent commit not signed by the Owner: ${history.rejected.reason}; ${NOTHING}`,
    );
  const main = history.lastVerified;
  if (main === undefined) throw new RefusedError(`main has no Owner-signed commit; ${NOTHING}`);
  // The walk may have fetched again: everything is read at the commit it verified.
  const config = configAt(cwd, env, main);
  if (config === undefined) throw new RefusedError(noConfig(cwd, env, home));
  const factory = factorySource(env);
  return Object.freeze({
    ...{ cwd, home, env, config, main, keysFor, laptopKeys: laptop, factory },
    keys: keysFor(config.factory_release),
    merges: history.merges,
    commits: history.commits,
    factoryRepo: releaseSource(factory, config.factory_release.sha),
  });
}

/** Read the open pull request into main and resolve its head from `origin/<branch>`, once. */
export async function checkedHead(at: MainContext, number: number): Promise<MergeContext> {
  const pr = await viewPr(at.config.repo, number, { env: at.env });
  if (pr.state !== 'OPEN')
    throw new RefusedError(`#${String(number)} is ${pr.state.toLowerCase()}; ${NOTHING}`);
  if (pr.baseRefName !== 'main')
    throw new RefusedError(`#${String(number)} targets ${pr.baseRefName}, not main; ${NOTHING}`);
  // A fork's branch is not origin's: only this repository's own branches are checked.
  const from = pr.headRepository;
  if (pr.isCrossRepository || from?.toLowerCase() !== at.config.repo.toLowerCase())
    throw new RefusedError(
      `#${String(number)} comes from a fork (${from ?? 'a deleted repository'}); ${NOTHING}`,
    );
  const branch = pr.headRefName;
  const valid = run(at.cwd, at.env, ['check-ref-format', `refs/heads/${branch}`]).ok;
  if (!valid || branch.startsWith('-'))
    throw new RefusedError(`#${String(number)} has an unusable head branch name; ${NOTHING}`);
  const ref = `refs/remotes/origin/${branch}`;
  const fetched = run(at.cwd, at.env, ['fetch', '-q', 'origin', `+refs/heads/${branch}:${ref}`]);
  if (!fetched.ok) throw new RefusedError(`cannot fetch ${branch}: ${fetched.err}`);
  const head = run(at.cwd, at.env, ['rev-parse', '--verify', `${ref}^{commit}`]).out.trim();
  if (head !== pr.headRefOid)
    throw new RefusedError(
      `the PR head ${pr.headRefOid.slice(0, 12)} is not origin/${branch} as fetched (${head.slice(0, 12)}); run merge again`,
    );
  return Object.freeze({ ...at, pr, branch, head });
}

/**
 * Fetch `branch` from origin, as main is fetched, into `origin/<branch>`, and return its commit;
 * undefined when origin has no such branch. `factory deploy` reads the release notes on
 * `claude/factory-log` this way, once (slice 23c-1b).
 */
export function fetchBranch(at: MainContext, branch: string, nothing: string): string | undefined {
  const listed = run(at.cwd, at.env, ['ls-remote', '--exit-code', '--heads', 'origin', branch]);
  // --exit-code: 2 when origin has no such branch.
  if (listed.status === 2) return undefined;
  if (!listed.ok)
    throw new RefusedError(`cannot list ${branch} on origin: ${listed.err}; ${nothing}`);
  const ref = `refs/remotes/origin/${branch}`;
  const fetched = run(at.cwd, at.env, ['fetch', '-q', 'origin', `+refs/heads/${branch}:${ref}`]);
  if (!fetched.ok) throw new RefusedError(`cannot fetch ${branch}: ${fetched.err}; ${nothing}`);
  return run(at.cwd, at.env, ['rev-parse', '--verify', `${ref}^{commit}`]).out.trim();
}
