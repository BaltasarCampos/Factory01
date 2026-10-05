// Station outputs as committed on the item branch. Checks read git objects at HEAD, never the
// work tree, so only what was committed counts; the feature folder is the one the dispatcher
// named in `.specify/feature.json`.
import { spawnSync } from 'node:child_process';
import { EnvironmentError } from '../../cli/env.js';

/** A file at HEAD, or undefined when it is not committed. */
export function committed(cwd: string, path: string): string | undefined {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', 'show', `HEAD:${path}`], {
    cwd,
    encoding: 'utf8',
  });
  if (result.error) throw new EnvironmentError(`could not run git: ${result.error.message}`);
  return result.status === 0 ? result.stdout : undefined;
}

/** The committed feature folder, `specs/<feature>`. */
export function featureDir(cwd: string): string {
  const text = committed(cwd, '.specify/feature.json');
  let dir: unknown;
  try {
    dir = (JSON.parse(text ?? '{}') as { feature_directory?: unknown }).feature_directory;
  } catch {
    dir = undefined;
  }
  if (typeof dir !== 'string' || !/^specs\/[^/.][^/]*$/.test(dir))
    throw new EnvironmentError('.specify/feature.json at HEAD names no specs/<feature> folder');
  return dir;
}

export interface FeatureFiles {
  /** Path of each file, for messages. */
  paths: Record<string, string>;
  /** Text of each committed file. */
  text: Record<string, string | undefined>;
  /** `<path>: not committed` for each file that is missing at HEAD. */
  missing: string[];
}

/** Files of the feature folder at HEAD, by name relative to the folder. */
export function featureFiles(cwd: string, names: readonly string[]): FeatureFiles {
  const dir = featureDir(cwd);
  const files: FeatureFiles = { paths: {}, text: {}, missing: [] };
  for (const name of names) {
    const path = `${dir}/${name}`;
    files.paths[name] = path;
    files.text[name] = committed(cwd, path);
    if (files.text[name] === undefined) files.missing.push(`${path}: not committed`);
  }
  return files;
}
