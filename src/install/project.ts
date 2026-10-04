// Install steps shared by `factory new` and `factory adopt` (contracts/cli.md): Spec Kit, the
// pinned release's guardrails checked against its manifest, labels, the pinned Owner inbox,
// `.factory/config`, and the `claude/define` branch. The commands commit and push the result
// as an Owner-signed commit.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EnvironmentError, RefusedError } from '../cli/env.js';
import type { GhOptions } from '../github/gh.js';
import { parseConfig } from '../model/config.js';
import { formatReleasePin } from '../model/naming.js';
import type { AgentsMode, ReleasePin } from '../model/types.js';
import { createInboxIssue } from './inbox.js';
import { installLabels } from './labels.js';
import {
  buildManifest,
  fetchPinnedManifest,
  ManifestError,
  manifestMismatches,
} from './manifest.js';
import { render } from './render.js';

export const DEFINE_BRANCH = 'claude/define';
export const CONFIG_PATH = '.factory/config';

export interface InstallOptions extends GhOptions {
  /** The project, `owner/name`. */
  repo: string;
  /** The project's local clone. */
  workdir: string;
  /** The public factory repository holding the release tag. */
  factoryRepo: string;
  /** The `factory/` directory of the pinned release commit. */
  factoryRoot: string;
  pin: ReleasePin;
  agents: AgentsMode;
  /** Adopted repos: main's last unsigned commit. */
  baseline?: string;
  /** Default: `specify init` in the work tree. */
  runSpecify?: (cwd: string) => void;
}

/** Spec Kit's own files, without prompts. Its `.claude/` output is replaced by the release's. */
export function runSpecifyInit(cwd: string, env: NodeJS.ProcessEnv = process.env): void {
  const args = ['init', '--here', '--force', '--non-interactive', '--integration', 'claude'];
  const result = spawnSync('specify', [...args, '--script', 'sh', '--ignore-agent-tools'], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT')
    throw new EnvironmentError('`specify` not found on PATH; install Spec Kit and try again');
  if (result.status !== 0)
    throw new EnvironmentError(`specify init failed: ${(result.stderr || result.stdout).trim()}`);
}

export function formatConfig(fields: {
  pin: ReleasePin;
  baseline?: string;
  agents: AgentsMode;
  repo: string;
  inboxIssue: number;
}): string {
  const lines = [
    `factory_release: ${formatReleasePin(fields.pin)}`,
    ...(fields.baseline === undefined ? [] : [`baseline: ${fields.baseline}`]),
    `agents: ${fields.agents}`,
    'profile: typescript',
    `repo: ${fields.repo}`,
    `inbox_issue: ${String(fields.inboxIssue)}`,
  ];
  const text = `${lines.join('\n')}\n`;
  parseConfig(text);
  return text;
}

/**
 * Install everything into the work tree and the GitHub repo. Files come first and are checked
 * against the pinned manifest; GitHub is touched only once they match. Nothing is committed.
 */
export async function installProject(options: InstallOptions): Promise<{ inboxIssue: number }> {
  const { repo, workdir, pin } = options;
  if (existsSync(join(workdir, CONFIG_PATH)))
    throw new RefusedError(`${repo} already has ${CONFIG_PATH}; it is installed`);

  const manifest = await fetchPinnedManifest(options.factoryRepo, pin, options);
  if (options.runSpecify) options.runSpecify(workdir);
  else runSpecifyInit(workdir, options.env);
  render(options.factoryRoot, workdir, { repo });
  const mismatches = manifestMismatches(manifest.files, buildManifest(workdir, pin).files);
  if (mismatches.length > 0)
    throw new ManifestError(
      `the installed guardrails differ from the manifest of ${formatReleasePin(pin)}:\n  ` +
        mismatches.join('\n  '),
    );

  await installLabels(repo, options);
  const inboxIssue = await createInboxIssue(repo, options);
  mkdirSync(join(workdir, '.factory'), { recursive: true });
  writeFileSync(join(workdir, CONFIG_PATH), formatConfig({ ...options, inboxIssue }));
  return { inboxIssue };
}

/** Create `claude/define` at the work tree's HEAD and push it. */
export function createDefineBranch(workdir: string, env: NodeJS.ProcessEnv = process.env): void {
  for (const args of [
    ['branch', DEFINE_BRANCH, 'HEAD'],
    ['push', '-q', 'origin', `refs/heads/${DEFINE_BRANCH}`],
  ]) {
    const result = spawnSync('git', args, { cwd: workdir, env, encoding: 'utf8' });
    if (result.error) throw new EnvironmentError(`could not run git: ${result.error.message}`);
    if (result.status !== 0)
      throw new RefusedError(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  }
}
