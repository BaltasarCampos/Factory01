// Local sessions (research R8, FR-031): `claude -p` on the laptop, one at a time, each in a
// fresh clone of its own under `~/.factory/work/<repo>/<name>`, never in the Owner's working copy
// and never in a worktree of it: a worktree shares `.git/config`, `.git/hooks` and the local
// branches, so a session could plant a hook that runs when the Owner signs a merge (Owner review
// 2026-10-07). The clone is made anew for every launch, its `origin` set to the project's
// GitHub remote, so nothing a session left in it (config, hooks, files) carries over. The
// launch resolves when the session ends, so `factory run` works the line one session at a time.
//
// No local session starts before the guards exist: the release pinned on main must have a tag
// the Owner signed (checked with main's pinned key lists), the protected files on main and in
// the session's clone must equal its manifest in both directions, and the manifest must carry
// the factory hooks. Until the release ships them (slice 28) no local session starts.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EnvironmentError } from '../../cli/env.js';
import { buildManifest, isHashed } from '../../install/manifest.js';
import { DEFINE_BRANCH } from '../../install/project.js';
import { configOnMain } from '../../model/config.js';
import type { GuardrailManifest, ReleasePin } from '../../model/types.js';
import { ReleaseTagError } from '../../release/tag.js';
import { git } from '../branch.js';
import {
  LaunchRefused,
  type Availability,
  type LaunchRequest,
  type SessionLauncher,
} from './types.js';

export type Runner = (
  program: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => Promise<{ status: number | null; stdout: string; stderr: string }>;

export const runProcess: Runner = (program, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(program, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (status) => {
      resolve({ status, stdout, stderr });
    });
  });

/**
 * The `claude` arguments for a local session. Not confirmed yet: the Phase 0 probe T125 checks
 * `--agent` and the `session_id` field of the JSON output, and changes only this function.
 */
export const localInvocation = (request: LaunchRequest): readonly string[] => [
  ...['-p', '--agent', request.role, '--model', 'sonnet', '--output-format', 'json'],
  request.prompt,
];

type Unavailable = Extract<Availability, { ok: false }>;

/** The branches a local session may run on; anything else is refused before any path is built. */
const ITEM_BRANCH = /^claude\/\d+-[a-z0-9-]+$/;
export const launchable = (branch: string) =>
  branch === 'main' || branch === DEFINE_BRANCH || ITEM_BRANCH.test(branch);

/** The hook events every factory session must run through `factory hook` (contracts/hooks.md). */
const HOOK_EVENTS = ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop', 'PreCompact'];
const SETTINGS = '.claude/settings.json';
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Whether settings register every factory hook: the release ships the guards yet. */
function hasFactoryHooks(settings: Buffer | undefined): boolean {
  let hooks: unknown;
  try {
    hooks = (JSON.parse(settings?.toString('utf8') ?? '') as { hooks?: unknown }).hooks;
  } catch {
    return false;
  }
  if (typeof hooks !== 'object' || hooks === null) return false;
  const byEvent = hooks as Record<string, unknown>;
  return HOOK_EVENTS.every((e) => JSON.stringify(byEvent[e] ?? null).includes('factory hook'));
}

/**
 * The protected files found (path → SHA-256) against the manifest, in both directions: every
 * manifest file present with its hash, and every hashed protected file listed. Then the hooks.
 */
export function guardrailCheck(
  found: Readonly<Record<string, string>>,
  settings: Buffer | undefined,
  manifest: GuardrailManifest,
  where: string,
): Availability {
  const tampered = (reason: string): Availability => ({
    ok: false,
    urgent: true,
    reason: `${where}: ${reason} (release ${manifest.release})`,
  });
  for (const [path, hash] of Object.entries(manifest.files)) {
    if (found[path] === undefined) return tampered(`${path} is missing`);
    if (found[path] !== hash) return tampered(`${path} does not match the manifest`);
  }
  for (const path of Object.keys(found))
    if (manifest.files[path] === undefined) return tampered(`${path} is not in the manifest`);
  if (!hasFactoryHooks(settings))
    return {
      ok: false,
      reason: `release ${manifest.release} installs no factory hooks; local sessions wait for the guards (slice 28)`,
    };
  return { ok: true };
}

export interface LocalOptions {
  /** The Owner's project clone; sessions never run in it. */
  project: string;
  /** Holds `.factory/work/`. */
  home: string;
  env: NodeJS.ProcessEnv;
  /**
   * The manifest of a release, read only after its tag verifies with main's pinned key lists
   * (src/release/tag.ts `verifiedManifest`); throws `ReleaseTagError` when it does not.
   */
  release: (pin: ReleasePin) => GuardrailManifest;
  /** Default `origin/main`. */
  mainRef?: string;
  run?: Runner;
}

export class LocalLauncher implements SessionLauncher {
  readonly mode = 'local';
  private running = false;
  private readonly options: LocalOptions;
  private readonly run: Runner;

  constructor(options: LocalOptions) {
    this.options = options;
    this.run = options.run ?? runProcess;
  }

  /** git with hooks off: nothing in a repository may run code while the launcher works. */
  private git(cwd: string, args: readonly string[]): string {
    const at = { projectDir: cwd, now: () => new Date(), env: this.options.env };
    return git(at, ['-c', 'core.hooksPath=/dev/null', ...args]);
  }

  /** The verified manifest of the release pinned on main, or why there is none. */
  private manifest(): GuardrailManifest | Unavailable {
    const { project, mainRef } = this.options;
    try {
      return this.options.release(configOnMain(project, mainRef).factory_release);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      // A tag that exists but is not the Owner's is tampering; one not fetched, or key lists
      // that cannot be read, leave the launcher unavailable.
      const urgent = err instanceof ReleaseTagError && !/does not exist/.test(why);
      return { ok: false, reason: `the pinned release cannot be trusted: ${why}`, urgent };
    }
  }

  /** The protected files of main's tree, by path; a symlink or submodule there is tampering. */
  private mainFiles(): { found: Record<string, string>; settings?: Buffer } | Unavailable {
    const { project, mainRef = 'origin/main', env } = this.options;
    const found: Record<string, string> = {};
    let settings: Buffer | undefined;
    const tree = this.git(project, ['ls-tree', '-r', '-z', mainRef]).split('\0');
    for (const entry of tree.filter((e) => e !== '')) {
      const [meta = '', path = ''] = entry.split('\t');
      if (!isHashed(path)) continue;
      const [mode, , oid = ''] = meta.split(' ');
      if (mode !== '100644' && mode !== '100755')
        return { ok: false, urgent: true, reason: `main: ${path} is not a regular file` };
      const blob = spawnSync('git', ['cat-file', 'blob', oid], { cwd: project, env });
      found[path] = sha256(blob.stdout);
      if (path === SETTINGS) settings = blob.stdout;
    }
    return settings === undefined ? { found } : { found, settings };
  }

  async available(): Promise<Availability> {
    const manifest = this.manifest();
    if ('ok' in manifest) return manifest;
    const main = this.mainFiles();
    if ('ok' in main) return main;
    const guardrails = guardrailCheck(main.found, main.settings, manifest, 'main');
    if (!guardrails.ok) return guardrails;
    try {
      const { project, env } = this.options;
      const result = await this.run('claude', ['--version'], { cwd: project, env });
      return result.status === 0 ? { ok: true } : { ok: false, reason: 'claude --version failed' };
    } catch {
      return { ok: false, reason: 'claude is not installed' };
    }
  }

  /** A fresh clone for the session at the branch's tip on origin, cleaned of every other file. */
  private clone(branch: string): string {
    const { project, home } = this.options;
    const repo = configOnMain(project, this.options.mainRef).repo;
    const name = branch === 'main' ? 'main' : branch.slice('claude/'.length);
    const dir = join(home, '.factory', 'work', ...repo.split('/'), name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dirname(dir), { recursive: true });
    this.git(home, ['clone', '-q', '--no-hardlinks', '--no-checkout', project, dir]);
    const url = this.git(project, ['remote', 'get-url', 'origin']);
    this.git(dir, ['remote', 'set-url', 'origin', url]);
    this.git(dir, ['fetch', '-q', '--prune', 'origin']);
    const onOrigin = (ref: string) => {
      try {
        this.git(dir, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${ref}`]);
        return true;
      } catch {
        return false;
      }
    };
    if (branch === 'main') this.git(dir, ['checkout', '-q', '-f', '--detach', 'origin/main']);
    else {
      // Define's branch may not exist yet: its first session starts it from main.
      const from = onOrigin(branch) ? `origin/${branch}` : 'origin/main';
      if (from === 'origin/main' && branch !== DEFINE_BRANCH)
        throw new LaunchRefused(`no local session started: ${branch} is not on origin`);
      this.git(dir, ['checkout', '-q', '-f', '-B', branch, from]);
    }
    this.git(dir, ['clean', '-q', '-ffdx']);
    return dir;
  }

  async launch(request: LaunchRequest): Promise<{ sessionId: string }> {
    if (!launchable(request.branch))
      throw new LaunchRefused(
        `no local session started: ${request.branch} is not a session branch`,
      );
    if (this.running) throw new LaunchRefused('a local session is already running');
    this.running = true;
    try {
      const manifest = this.manifest();
      if ('ok' in manifest) throw new LaunchRefused(manifest.reason, manifest.urgent);
      const cwd = this.clone(request.branch);
      let found: Record<string, string>;
      try {
        found = buildManifest(cwd, { tag: manifest.release, sha: manifest.commit }).files;
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        throw new LaunchRefused(`no local session started: ${request.branch}: ${why}`, true);
      }
      const settingsPath = join(cwd, SETTINGS);
      const settings = existsSync(settingsPath) ? readFileSync(settingsPath) : undefined;
      const check = guardrailCheck(found, settings, manifest, request.branch);
      if (!check.ok)
        throw new LaunchRefused(`no local session started: ${check.reason}`, check.urgent);
      const feature = ITEM_BRANCH.test(request.branch)
        ? request.branch.slice('claude/'.length)
        : undefined;
      const env = {
        ...this.options.env,
        // Define works for the project, not an item: it gets a station and no item.
        ...(request.item > 0 ? { FACTORY_ITEM: String(request.item) } : {}),
        FACTORY_STATION: String(request.station),
        ...(feature === undefined
          ? {}
          : { SPECIFY_FEATURE: feature, SPECIFY_FEATURE_DIRECTORY: `specs/${feature}` }),
      };
      const result = await this.run('claude', localInvocation(request), { cwd, env });
      if (result.status !== 0)
        throw new EnvironmentError(
          `claude exited ${String(result.status)}: ${result.stderr.trim()}`,
        );
      let sessionId: unknown;
      try {
        sessionId = (JSON.parse(result.stdout) as { session_id?: unknown }).session_id;
      } catch {
        sessionId = undefined;
      }
      if (typeof sessionId !== 'string') throw new EnvironmentError('claude printed no session_id');
      return { sessionId };
    } finally {
      this.running = false;
    }
  }
}
