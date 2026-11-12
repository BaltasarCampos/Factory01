// Station outputs as committed at the session's head, which the Stop hook has taken into the
// factory's own clone (src/hooks/session-commits.ts, slice 28-5a): checks read git objects there,
// never the session's clone or its work tree, so only what was committed counts. The feature folder
// is the session record's, from the branch the dispatcher issued (T170).
import { RefusedError } from '../../cli/env.js';
import { safeGit } from '../../git/diff.js';
import type { SessionOutput } from '../../hooks/session-commits.js';

/** Git in the factory's own clone, without the Owner's config: its exit, 0 or 1, and output. */
export function answer(at: Pick<SessionOutput, 'repo'>, args: readonly string[]) {
  const result = safeGit(at.repo, args, process.env);
  if (result.status === 0 || result.status === 1)
    return { ok: result.status === 0, out: result.stdout.toString().trim() };
  throw new RefusedError(`git ${args[0] ?? ''} failed: ${result.stderr}`);
}

/**
 * A regular file at the session's head, or undefined when none is committed there; a git failure
 * throws, never reading as a missing file.
 */
export function committed(
  at: Pick<SessionOutput, 'repo' | 'commit'>,
  path: string,
): string | undefined {
  const entry = answer(at, ['--literal-pathspecs', 'ls-tree', '-z', at.commit, '--', path]);
  const [mode, type, oid] = entry.out.split('\t')[0]?.split(' ') ?? [];
  if (!entry.ok) throw new RefusedError(`git ls-tree ${at.commit.slice(0, 12)} failed`);
  if (type !== 'blob' || (mode !== '100644' && mode !== '100755') || oid === undefined)
    return undefined;
  const blob = safeGit(at.repo, ['cat-file', 'blob', oid], process.env);
  if (blob.status !== 0) throw new RefusedError(`git cat-file ${oid} failed: ${blob.stderr}`);
  return blob.stdout.toString();
}

/** The session's feature folder; a session with none refuses. */
export function featureDir(at: SessionOutput): string {
  if (at.feature === '') throw new RefusedError(notOnItemBranch(at.branch));
  return at.feature;
}

export const notOnItemBranch = (branch: string) =>
  `not on a work-item branch (on ${branch}); the feature folder comes from claude/<issue>-<slug>`;

export interface FeatureFiles {
  /** Path of each file, for messages. */
  paths: Record<string, string>;
  /** Text of each committed file. */
  text: Record<string, string | undefined>;
  /** `<path>: not committed` for each file that is missing at the session's head. */
  missing: string[];
}

/** Files of the feature folder at the session's head, by name relative to the folder. */
export function featureFiles(at: SessionOutput, names: readonly string[]): FeatureFiles {
  const dir = featureDir(at);
  const files: FeatureFiles = { paths: {}, text: {}, missing: [] };
  for (const name of names) {
    const path = `${dir}/${name}`;
    files.paths[name] = path;
    files.text[name] = committed(at, path);
    if (files.text[name] === undefined) files.missing.push(`${path}: not committed`);
  }
  return files;
}
