// Repositories: visibility (agents act only in private project repos), creation, cloning.
import { resolve } from 'node:path';
import { Fields, gh, GhError, repoArg, type GhOptions } from './gh.js';

export type Visibility = 'public' | 'private' | 'internal';

export async function visibility(repo: string, options: GhOptions = {}): Promise<Visibility> {
  const out = await gh(['api', `repos/${repoArg(repo)}`], { ...options, json: true });
  const value = Fields.of(out, 'repository').str('visibility');
  if (value !== 'public' && value !== 'private' && value !== 'internal') {
    throw new GhError(`unexpected gh output: visibility ${JSON.stringify(value)}`);
  }
  return value;
}

/** Create an empty private repository (no README, no initial commit); returns `owner/name`. */
export async function createRepo(repo: string, options: GhOptions = {}): Promise<string> {
  const url = (await gh(['repo', 'create', repoArg(repo), '--private'], options)).trim();
  const match = /github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
  if (!match?.[1]) throw new GhError(`unexpected gh output: ${JSON.stringify(url)}`);
  return match[1];
}

/** Clone into `dir` (resolved to an absolute path, so it is never read as a flag). */
export async function cloneRepo(repo: string, dir: string, options: GhOptions = {}): Promise<void> {
  await gh(['repo', 'clone', repoArg(repo), resolve(options.cwd ?? '.', dir)], options);
}
