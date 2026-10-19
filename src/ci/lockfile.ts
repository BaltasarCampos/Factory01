// The lockfile identity rule (T169, Owner decisions 2026-10-19), which `factory ci scan audit` and
// `factory ci licences` apply before anything else: both take each package's name and version
// from its `package-lock.json` entry, but npm installs whatever the entry's `resolved` names, and
// the Builder writes the lockfile. So every package entry, except the root and `link: true`
// entries, must resolve to exactly `https://registry.npmjs.org/<name>/-/<unscoped name>-<version>.tgz`
// for the name and version the checks use (`name`, else the path after its last `node_modules/`),
// with a valid npm package name and a semver version. A bundled dependency (`inBundle`) comes
// inside its parent's tarball and may have no `resolved`. Anything else is a finding naming the
// entry: another host, a git, `file:` or other tarball URL, or a name or version that does not
// match.
import { RefusedError } from '../cli/env.js';
import { fileAt } from '../git/diff.js';

export const LOCK = 'package-lock.json';
const REGISTRY_TARBALLS = 'https://registry.npmjs.org';

/** npm's rule for names, old packages' capitals included; a scope is always lower case. */
const NAME = /^(?:@[a-z0-9-*~][a-z0-9-*._~]*\/)?[a-zA-Z0-9-~][a-zA-Z0-9-._~]*$/;
/** semver.org's version grammar. */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export interface LockedPackage {
  /** The entry's key, `node_modules/…`. */
  path: string;
  name: string;
  version: string;
}

interface Entry {
  name?: unknown;
  version?: unknown;
  resolved?: unknown;
  link?: unknown;
  inBundle?: unknown;
}

/**
 * The package entries of the lockfile at `commit`, each checked against the identity rule; none
 * when the commit has no lockfile.
 */
export function readLockfile(
  repo: string,
  commit: string,
  env: NodeJS.ProcessEnv,
): { packages: LockedPackage[]; problems: string[] } {
  const bytes = fileAt(repo, commit, LOCK, env);
  if (bytes === undefined) return { packages: [], problems: [] };
  let lock: { packages?: Record<string, Entry> };
  try {
    lock = JSON.parse(bytes.toString('utf8')) as typeof lock;
  } catch {
    throw new RefusedError(`${LOCK} at ${commit.slice(0, 12)} is not JSON`);
  }
  if (lock.packages === undefined || typeof lock.packages !== 'object')
    throw new RefusedError(
      `${LOCK} at ${commit.slice(0, 12)} has no packages (lockfile v2 or later)`,
    );
  const packages: LockedPackage[] = [];
  const problems: string[] = [];
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path === '' || entry.link === true) continue;
    const fromPath = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const name = typeof entry.name === 'string' ? entry.name : fromPath;
    const version = typeof entry.version === 'string' ? entry.version : '';
    const problem = (what: string) => `${LOCK}: ${path}: ${what}`;
    if (!NAME.test(name) || name.length > 214) {
      problems.push(problem(`${JSON.stringify(name)} is not a valid npm package name`));
      continue;
    }
    if (!SEMVER.test(version)) {
      problems.push(problem(`version ${JSON.stringify(version)} is not semver`));
      continue;
    }
    const unscoped = name.slice(name.indexOf('/') + 1);
    const tarball = `${REGISTRY_TARBALLS}/${name}/-/${unscoped}-${version}.tgz`;
    if (entry.resolved === undefined && entry.inBundle === true) {
      packages.push({ path, name, version });
      continue;
    }
    if (entry.resolved !== tarball) {
      const resolved = entry.resolved === undefined ? 'nothing' : JSON.stringify(entry.resolved);
      problems.push(
        problem(`resolves to ${resolved}, not ${tarball}, the registry's ${name}@${version}`),
      );
      continue;
    }
    packages.push({ path, name, version });
  }
  return { packages, problems };
}
