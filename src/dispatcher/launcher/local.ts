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
//
// Before launch the launcher fetches main and the branch into the factory's own clone and checks
// the branch's history there, by hash (T078): its own commits since the merge base with main
// change no protected path (the merge rules' path rule, Define's brief allowed), and the clone is
// checked against the release pinned at that merge base, so a branch made before an upgrade still
// starts. The session's clone is then made from the factory's own clone at exactly those commits,
// never by fetching origin again. Any git failure stops the launch with an error, never read as
// nothing there and never as tampering.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EnvironmentError } from '../../cli/env.js';
import { mergeBase, safeDiff } from '../../git/diff.js';
import { buildManifest, coversHashed } from '../../install/manifest.js';
import { DEFINE_BRANCH } from '../../install/project.js';
import { pathRule } from '../../merge/rules.js';
import { configOnMain } from '../../model/config.js';
import { visible } from '../../notify/summary.js';
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

/** The commits a session starts from, as fetched into the factory's own clone. */
interface Heads {
  main: string;
  /** The branch's head; main's for a session on main or a Define branch not on origin yet. */
  head: string;
  onOrigin: boolean;
}

/** Runs a step of the checks; any failure but a refusal is an error, never tampering. */
function step<T>(what: string, run: () => T): T {
  try {
    return run();
  } catch (err) {
    if (err instanceof LaunchRefused) throw err;
    const why = err instanceof Error ? err.message : String(err);
    throw new EnvironmentError(`no local session started: ${what}: ${why}`);
  }
}

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
  private manifest(project: string): GuardrailManifest | Unavailable {
    const { mainRef } = this.options;
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

  /**
   * The protected files of the tree at `ref` in `dir`, by path. A symlink or submodule at a
   * protected path, or at a folder holding one (`.claude`, `.github`), is tampering: it would
   * point the session's writes elsewhere, such as the Owner's clone.
   */
  private treeFiles(
    dir: string,
    ref: string,
    where: string,
  ): { found: Record<string, string>; settings?: Buffer } | Unavailable {
    const found: Record<string, string> = {};
    let settings: Buffer | undefined;
    const tree = this.git(dir, ['ls-tree', '-r', '-z', ref]).split('\0');
    for (const entry of tree.filter((e) => e !== '')) {
      const [meta = '', path = ''] = entry.split('\t');
      if (!coversHashed(path)) continue;
      const [mode, , oid = ''] = meta.split(' ');
      if (mode !== '100644' && mode !== '100755')
        return { ok: false, urgent: true, reason: `${where}: ${path} is not a regular file` };
      const blob = spawnSync('git', ['cat-file', 'blob', oid], { cwd: dir, env: this.options.env });
      found[path] = sha256(blob.stdout);
      if (path === SETTINGS) settings = blob.stdout;
    }
    return settings === undefined ? { found } : { found, settings };
  }

  async available(project: string): Promise<Availability> {
    const manifest = this.manifest(project);
    if ('ok' in manifest) return manifest;
    const { mainRef = 'origin/main' } = this.options;
    const main = this.treeFiles(project, mainRef, 'main');
    if ('ok' in main) return main;
    const guardrails = guardrailCheck(main.found, main.settings, manifest, 'main');
    if (!guardrails.ok) return guardrails;
    try {
      const result = await this.run('claude', ['--version'], {
        cwd: project,
        env: this.options.env,
      });
      return result.status === 0 ? { ok: true } : { ok: false, reason: 'claude --version failed' };
    } catch {
      return { ok: false, reason: 'claude is not installed' };
    }
  }

  /** Main and the branch fetched into the factory's own clone, by hash. */
  private heads(project: string, branch: string): Heads {
    const listed = (b: string) => this.git(project, ['ls-remote', '--heads', 'origin', b]);
    const onOrigin = branch !== 'main' && listed(`refs/heads/${branch}`) !== '';
    // Define's branch may not exist yet: its first session starts it from main.
    if (branch !== 'main' && !onOrigin && branch !== DEFINE_BRANCH)
      throw new LaunchRefused(`no local session started: ${branch} is not on origin`);
    const refspec = (b: string) => `+refs/heads/${b}:refs/remotes/origin/${b}`;
    const refs = [refspec('main'), ...(onOrigin ? [refspec(branch)] : [])];
    this.git(project, ['fetch', '-q', '--no-tags', 'origin', ...refs]);
    const commit = (b: string) =>
      this.git(project, ['rev-parse', '--verify', `refs/remotes/origin/${b}^{commit}`]);
    const main = commit('main');
    return { main, head: onOrigin ? commit(branch) : main, onOrigin };
  }

  /**
   * The checks on the branch's history, in the factory's own clone: its own commits since the
   * merge base change no protected path, and the manifest is the release pinned at the merge base.
   */
  private history(project: string, branch: string, heads: Heads): GuardrailManifest {
    const { env } = this.options;
    const base = step('the merge base with main', () =>
      mergeBase(project, heads.main, heads.head, env),
    );
    const changes = step(`the changes since ${base}`, () =>
      safeDiff(project, base, heads.head, env),
    );
    const problems = pathRule(changes, branch === DEFINE_BRANCH);
    if (problems.length > 0)
      throw new LaunchRefused(
        `no local session started: ${branch}'s own commits change ${problems.map(visible).join('; ')}`,
        true,
      );
    const pin = step(`the release pinned at ${base}`, () => configOnMain(project, base));
    try {
      return this.options.release(pin.factory_release);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      // A tag that is not the Owner's is tampering. One git cannot read, which verifyReleaseTag
      // reports as not existing, and any other failure are errors.
      if (err instanceof ReleaseTagError && !/does not exist/.test(why))
        throw new LaunchRefused(`the release pinned at ${base} cannot be trusted: ${why}`, true);
      throw new EnvironmentError(`no local session started: the release pinned at ${base}: ${why}`);
    }
  }

  /**
   * A fresh clone for the session, from the factory's own clone at exactly the checked commits,
   * its `origin` the project's GitHub remote, never fetched.
   */
  private clone(project: string, branch: string, heads: Heads): string {
    const { home } = this.options;
    const repo = configOnMain(project, heads.main).repo;
    const name = branch === 'main' ? 'main' : branch.slice('claude/'.length);
    const dir = join(home, '.factory', 'work', ...repo.split('/'), name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dirname(dir), { recursive: true });
    this.git(home, ['init', '-q', '-b', 'main', dir]);
    const refs = [
      `+${heads.main}:refs/remotes/origin/main`,
      ...(heads.onOrigin ? [`+${heads.head}:refs/remotes/origin/${branch}`] : []),
    ];
    this.git(dir, ['fetch', '-q', '--no-tags', project, ...refs]);
    this.git(dir, ['remote', 'add', 'origin', this.git(project, ['remote', 'get-url', 'origin'])]);
    if (branch === 'main') this.git(dir, ['checkout', '-q', '-f', '--detach', heads.main]);
    else this.git(dir, ['checkout', '-q', '-f', '-B', branch, heads.head]);
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
      const heads = step('fetching main and the branch into the factory’s own clone', () =>
        this.heads(request.project, request.branch),
      );
      const manifest = this.history(request.project, request.branch, heads);
      const cwd = this.clone(request.project, request.branch, heads);
      // The tree first: a symlinked `.claude` would pass a walk of the files it points at.
      const tree = this.treeFiles(cwd, 'HEAD', request.branch);
      const committed =
        'ok' in tree ? tree : guardrailCheck(tree.found, tree.settings, manifest, request.branch);
      if (!committed.ok && committed.urgent === true)
        throw new LaunchRefused(`no local session started: ${committed.reason}`, true);
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
      // No Spec Kit variables: the release's commands take the feature folder from the prompt.
      const env = {
        ...this.options.env,
        // Define works for the project, not an item: it gets a station and no item.
        ...(request.item > 0 ? { FACTORY_ITEM: String(request.item) } : {}),
        FACTORY_STATION: String(request.station),
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
