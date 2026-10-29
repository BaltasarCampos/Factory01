// Local sessions (research R8, FR-031): `claude -p` on the laptop, one at a time, each in a
// fresh clone of its own under `~/factory-work/<repo>/<name>-<session id>`, never in the Owner's
// working copy and never in a worktree of it: a worktree shares `.git/config`, `.git/hooks` and
// the local branches, so a session could plant a hook that runs when the Owner signs a merge
// (Owner review 2026-10-07). The clone is made anew for every launch, its `origin` set to the
// project's GitHub remote, so nothing a session left in it (config, hooks, files) carries over.
// The launch resolves when the session ends, so `factory run` works the line one session at a
// time.
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
//
// Branch content is never read or written with the Owner's git config: checking it out applies
// its `.gitattributes` with every config git reads, so a filter the Owner's config defines, such
// as git-lfs's, would run against origin with the Owner's credentials. Every such call goes
// through `isolated()`, without the global and system config, hooks or submodule recursion.
//
// Every launch gets a fresh session id and a folder of its own, `~/.factory/sessions/<id>/`, made
// exclusively, so no file of an earlier launch sits beside a new one. It holds the session's
// `--settings` file and the factory's MCP config, read by Claude Code outside the sandbox, which
// denies all of `~/.factory/` to the session's shell; the clone and the session's temporary
// folder stay outside it, opened by real path.
//
// The session's environment is an allowlist, never the Owner's minus a list: their shell may hold
// their own GitHub token, cloud keys or `ANTHROPIC_API_KEY`, which would also bill the session to
// the API instead of the Owner's plan. A role with `gh` in its shell gets only the project's gh
// token, which the Owner saves under `~/.factory/tokens/`: a fine-grained token for the repository
// only, with Issues read and write, Pull requests read and write, Contents read-only and Metadata
// read-only, expiring soon after the run. GitHub has no comment-only permission, so it can also
// change labels and close issues, which is why gates rest on signed records. Without it the role
// does not start, and it never falls back to the Owner's own `gh` login, which can push.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { EnvironmentError } from '../../cli/env.js';
import { SERVED_HOOKS } from '../../commands/hook.js';
import { WRAPPERS } from '../../guard/command-guard.js';
import { isFable, roleVersion } from '../../events/schema.js';
import { mergeBase, safeDiff, safeGit } from '../../git/diff.js';
import { loadPolicy } from '../../guard/policy.js';
import { buildManifest, coversHashed } from '../../install/manifest.js';
import { DEFINE_BRANCH } from '../../install/project.js';
import { MCP_JSON } from '../../install/render.js';
import { runsGh, SHARED_TMP, under } from '../../install/sandbox.js';
import { renderSessionSettings } from '../../install/session-settings.js';
import { CLAUDE_CODE_VERSION, type Settings } from '../../install/settings.js';
import { pathRule } from '../../merge/rules.js';
import { parseConfig } from '../../model/config.js';
import { branchFeatureDir } from '../../model/naming.js';
import { visible } from '../../notify/summary.js';
import type { GuardrailManifest, ProjectConfig, ReleasePin, RoleName } from '../../model/types.js';
import { ReleaseTagError } from '../../release/tag.js';
import { isTestFile } from '../../stations/edges.js';
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

/** The session's own files, in its folder under `~/.factory/sessions/`. */
export interface SessionFiles {
  id: string;
  settings: string;
  mcp: string;
  /** The session's record, which the hooks and the MCP server read (src/hooks/session.ts). */
  record: string;
}

/** The session's own files are written once, readable only by the Owner. */
const WRITE_ONCE = { flag: 'wx', mode: 0o600 } as const;

/**
 * The `claude` arguments for a local session (T061): its id, its own settings, only the project's
 * settings besides, only the factory's MCP server and `dontAsk`, so a tool call no rule allows is
 * refused; never auto mode, a resume or a skipped permission check.
 */
export const localInvocation = (
  request: LaunchRequest,
  files: SessionFiles,
  model: string,
): readonly string[] => [
  ...['-p', '--agent', request.role, '--model', model, '--output-format', 'json'],
  ...['--session-id', files.id, '--settings', files.settings, '--setting-sources', 'project'],
  ...['--strict-mcp-config', '--mcp-config', files.mcp, '--permission-mode', 'dontAsk'],
  request.prompt,
];

const FACTORY = new URL('../../../factory/', import.meta.url);
/** A file of the installed factory, never the release a branch pins. */
const factoryFile = (path: string) => readFileSync(new URL(path, FACTORY), 'utf8');
const factoryPolicy = () => loadPolicy(factoryFile('policy/roles.yaml'));

/**
 * The feature folder a session must have: its item branch's, `specs/<issue>-<slug>`, for a role on
 * an item branch, and none for a role on a fixed branch; it becomes the session's Edit rules.
 */
function expectedFeature(request: LaunchRequest): string | undefined {
  if (factoryPolicy().roles[request.role].branch !== 'item') return '';
  const dir = branchFeatureDir(request.branch);
  return dir?.startsWith(`specs/${String(request.item)}-`) === true ? dir : undefined;
}

/** Where the Owner saves the project's gh token, never their own `gh` login's. */
const tokenFile = (home: string, repo: string) =>
  join(home, '.factory', 'tokens', ...repo.split('/'));
/** A fine-grained token; the `gh` login's (`gho_`) and a classic one (`ghp_`) are not. */
const FINE_GRAINED = /^github_pat_[A-Za-z0-9_]+$/;
/** The project's gh token as the Owner sets it up, in the words the header above uses. */
const tokenSetup = (repo: string) =>
  `a fine-grained token for ${repo} only, with Issues read and write, Pull requests read and write, Contents read-only and Metadata read-only, expiring soon after the run. GitHub has no comment-only permission, so it can also change labels and close issues, which is why gates rest on signed records`;
/** A model name, which cannot read as an option. */
const MODEL = /^[a-z0-9][a-z0-9.[\]-]*$/i;

/** The model a role file's frontmatter names; none for a missing, Fable or odd one (T078). */
function roleModel(text: string): string | undefined {
  const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';
  const model = /^model: *(.*)$/m.exec(front)?.[1]?.trim();
  return model !== undefined && MODEL.test(model) && !isFable(model) ? model : undefined;
}
/** The roles that run without the advisor (T097). */
const NO_ADVISOR: ReadonlySet<string> = new Set(['intake', 'test']);

/**
 * The Owner's PATH, its absolute folders by real path, none inside a clone or a temporary folder,
 * since the hooks run `factory` by name outside the sandbox (T061).
 */
function sessionPath(path: string | undefined, outside: readonly string[]): string {
  const folders = (path ?? '').split(':').flatMap((dir) => {
    if (!dir.startsWith('/') || !existsSync(dir)) return [];
    const real = realpathSync(dir);
    return outside.some((folder) => under(real, folder)) ? [] : [real];
  });
  return [...new Set(folders)].join(':');
}

/** `CLAUDE.md` and `CLAUDE.local.md` in any letter case, as a disk that ignores case reads them. */
const MEMORY = /^claude(\.local)?\.md$/i;

/** The memory files in every folder above `clone`, up to `/` (T061). */
function memoryAbove(clone: string): string[] {
  const found: string[] = [];
  for (let dir = dirname(clone); ; dir = dirname(dir)) {
    found.push(
      ...readdirSync(dir)
        .filter((name) => MEMORY.test(name))
        .map((n) => join(dir, n)),
    );
    if (dir === '/') return found;
  }
}

/**
 * Folders the sandbox denies besides home: the shared temporary ones, and those Claude Code
 * denies under `blockReadsOutsideWorkingDirectories`.
 */
const UNREAD = ['/home', '/root', '/mnt', '/media', '/srv', ...SHARED_TMP];

/** Where `program` really is, the first on `folders` the Owner can run; undefined for none. */
function located(program: string, folders: readonly string[]): string | undefined {
  const at = folders.map((folder) => join(folder, program)).find(executable);
  return at === undefined ? undefined : realpathSync(at);
}

/** Whether `path` is a file the Owner can run. */
function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

type Unavailable = Extract<Availability, { ok: false }>;

/** The commits a session starts from, as fetched into the factory's own clone. */
interface Heads {
  main: string;
  /** The branch's head; main's for a session on main or a Define branch not on origin yet. */
  head: string;
  onOrigin: boolean;
}

/**
 * Runs a step of the checks; any failure but a refusal is an error, never tampering. Git's text
 * can quote a path from the branch, so it is shown through `visible()`.
 */
function step<T>(what: string, run: () => T): T {
  try {
    return run();
  } catch (err) {
    if (err instanceof LaunchRefused) throw err;
    const why = err instanceof Error ? err.message : String(err);
    throw new EnvironmentError(`no local session started: ${what}: ${visible(why)}`);
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

/** The events whose hooks are guards: one that cannot run must block the action (T082). */
const GUARD_EVENTS = new Set(['SessionStart', 'PreToolUse', 'PreCompact']);
const NO_HOOKS = 'installs no factory hooks; local sessions wait for the guards (slice 28)';
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [value]);

/**
 * The events each hook may be registered under, from the installed factory's own settings, which
 * every session's `--settings` file carries: `stop` under `PreToolUse` would block every call.
 */
function hookEvents(): Map<string, Set<string>> {
  const { hooks } = JSON.parse(factoryFile('settings/settings.json')) as Settings;
  const events = new Map<string, Set<string>>();
  for (const [event, groups] of Object.entries(hooks))
    for (const { args } of groups.flatMap((group) => group.hooks))
      events.set(args[1] ?? '', new Set([...(events.get(args[1] ?? '') ?? []), event]));
  return events;
}

/**
 * Why settings do not install the factory's hooks: every event registered, every hook `factory
 * hook <name>` in exec form, with no shell, naming a hook the installed factory serves, since
 * any other blocks every call, and every guard with `onFailure: "block"`, which needs Claude
 * Code 2.1.295 or later; undefined when they do.
 */
function hookProblem(settings: Buffer | undefined): string | undefined {
  let hooks: unknown;
  try {
    hooks = (JSON.parse(settings?.toString('utf8') ?? '') as { hooks?: unknown }).hooks;
  } catch {
    return NO_HOOKS;
  }
  if (typeof hooks !== 'object' || hooks === null) return NO_HOOKS;
  const byEvent = hooks as Record<string, unknown>;
  if (!HOOK_EVENTS.every((event) => list(byEvent[event] ?? []).length > 0)) return NO_HOOKS;
  const events = hookEvents();
  for (const [event, groups] of Object.entries(byEvent))
    for (const group of list(groups))
      for (const one of list((group as { hooks?: unknown } | null)?.hooks)) {
        const hook = (one ?? {}) as { type?: unknown; command?: unknown; args?: unknown };
        const args = list(hook.args);
        if (hook.type !== 'command' || hook.command !== 'factory' || args.length !== 2)
          return `registers a ${event} hook that is not factory hook <name> in exec form`;
        if (args[0] !== 'hook' || typeof args[1] !== 'string')
          return `registers a ${event} hook that is not factory hook <name> in exec form`;
        if (!SERVED_HOOKS.includes(args[1]))
          return `registers the ${event} hook factory hook ${visible(args[1])}, which the installed factory does not serve`;
        const served = events.get(args[1]) ?? new Set<string>();
        if (!served.has(event))
          return `registers factory hook ${args[1]} under ${visible(event)}; the installed factory serves it under ${[...served].join(', ') || 'no event'}`;
        if (GUARD_EVENTS.has(event) && (one as { onFailure?: unknown }).onFailure !== 'block')
          return `registers the ${event} guard factory hook ${visible(args[1])} without onFailure: "block"`;
      }
  return undefined;
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
  const problem = hookProblem(settings);
  if (problem !== undefined) return { ok: false, reason: `release ${manifest.release} ${problem}` };
  return { ok: true };
}

export interface LocalOptions {
  /** Holds `factory-work/`, the sessions' clones, and `.factory/sessions/`, their own files. */
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
  /** A fresh session id for each launch; default a random UUID. */
  sessionId?: () => string;
  /** Where the session's temporary folder is made, kept short (T061); default `/tmp`. */
  tmpRoot?: string;
  /** The programs Claude Code's sandbox runs, on the session's PATH; default bwrap and socat. */
  sandbox?: readonly string[];
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

  /**
   * git with hooks off and the Owner's config, only for what reads no branch content: talking to
   * origin, whose credential helper is in that config, and naming refs.
   */
  private git(cwd: string, args: readonly string[]): string {
    const at = { projectDir: cwd, now: () => new Date(), env: this.options.env };
    return git(at, ['-c', 'core.hooksPath=/dev/null', ...args]);
  }

  /** git for branch content: `safeGit`, without the Owner's config, hooks or submodules. */
  private isolated(cwd: string, args: readonly string[]): Buffer {
    const result = safeGit(cwd, args, this.options.env);
    if (result.status !== 0) throw new Error(`git ${args[0] ?? ''} failed: ${result.stderr}`);
    return result.stdout;
  }

  /** The project's config in the commit `ref`, read without the Owner's config. */
  private config(project: string, ref: string): ProjectConfig {
    return parseConfig(this.isolated(project, ['show', `${ref}:.factory/config`]).toString());
  }

  /** The verified manifest of the release pinned on main, or why there is none. */
  private manifest(project: string): GuardrailManifest | Unavailable {
    const { mainRef = 'origin/main' } = this.options;
    try {
      return this.options.release(this.config(project, mainRef).factory_release);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      // A tag that exists but is not the Owner's is tampering; one not fetched, or key lists
      // that cannot be read, leave the launcher unavailable.
      const urgent = err instanceof ReleaseTagError && err.reason !== 'missing';
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
    const tree = this.isolated(dir, ['ls-tree', '-r', '-z', ref]).toString().split('\0');
    for (const entry of tree.filter((e) => e !== '')) {
      const [meta = '', path = ''] = entry.split('\t');
      if (!coversHashed(path)) continue;
      const [mode, , oid = ''] = meta.split(' ');
      if (mode !== '100644' && mode !== '100755')
        return { ok: false, urgent: true, reason: `${where}: ${path} is not a regular file` };
      const blob = this.isolated(dir, ['cat-file', 'blob', oid]);
      found[path] = sha256(blob);
      if (path === SETTINGS) settings = blob;
    }
    return settings === undefined ? { found } : { found, settings };
  }

  async available(project: string): Promise<Availability> {
    const manifest = this.manifest(project);
    if ('ok' in manifest) return manifest;
    const { mainRef = 'origin/main' } = this.options;
    const main = step('reading main', () => this.treeFiles(project, mainRef, 'main'));
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

  /**
   * Main and the branch fetched into the factory's own clone, by hash. Only this keeps the
   * Owner's config, for its credential helper: `ls-remote` and a fetch write no working tree, so
   * no attribute applies.
   */
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
    const pin = step(`the release pinned at ${base}`, () => this.config(project, base));
    try {
      return this.options.release(pin.factory_release);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      // A tag that is not the Owner's is tampering. One git cannot read, and any other failure,
      // are errors.
      if (err instanceof ReleaseTagError && err.reason !== 'missing')
        throw new LaunchRefused(`the release pinned at ${base} cannot be trusted: ${why}`, true);
      throw new EnvironmentError(`no local session started: the release pinned at ${base}: ${why}`);
    }
  }

  /**
   * A fresh clone for the session, from the factory's own clone at exactly the checked commits,
   * its `origin` the project's GitHub remote, never fetched. Each launch gets a folder of its own,
   * named with its session id: a clone path the Owner once trusted in Claude Code would otherwise
   * load the pinned release's allow rules into a later session.
   */
  private clone(project: string, repo: string, branch: string, heads: Heads, session: string) {
    const { home } = this.options;
    const name = branch === 'main' ? 'main' : branch.slice('claude/'.length);
    const dir = join(realpathSync(home), 'factory-work', ...repo.split('/'), `${name}-${session}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dirname(dir), { recursive: true });
    this.isolated(home, ['init', '-q', '-b', 'main', dir]);
    const refs = [
      `+${heads.main}:refs/remotes/origin/main`,
      ...(heads.onOrigin ? [`+${heads.head}:refs/remotes/origin/${branch}`] : []),
    ];
    const url = this.git(project, ['remote', 'get-url', 'origin']);
    const clone = (args: readonly string[]) => this.isolated(dir, args);
    clone(['fetch', '-q', '--no-tags', project, ...refs]);
    clone(['remote', 'add', 'origin', url]);
    if (branch === 'main') clone(['checkout', '-q', '-f', '--detach', heads.main]);
    else clone(['checkout', '-q', '-f', '-B', branch, heads.head]);
    clone(['clean', '-q', '-ffdx']);
    return dir;
  }

  async launch(request: LaunchRequest): Promise<{ sessionId: string }> {
    if (!launchable(request.branch))
      throw new LaunchRefused(
        `no local session started: ${request.branch} is not a session branch`,
      );
    if (request.feature !== expectedFeature(request))
      throw new LaunchRefused(
        `no local session started: ${JSON.stringify(request.feature)} is not the feature folder of ${request.role} on ${request.branch}`,
      );
    if (this.running) throw new LaunchRefused('a local session is already running');
    this.running = true;
    try {
      const heads = step('fetching main and the branch into the factory’s own clone', () =>
        this.heads(request.project, request.branch),
      );
      const manifest = this.history(request.project, request.branch, heads);
      const { repo, inbox_issue } = step("reading main's config", () =>
        this.config(request.project, heads.main),
      );
      const token = runsGh(factoryPolicy(), request.role)
        ? step("reading the project's gh token", () => this.ghToken(request.role, repo))
        : undefined;
      const files = step("making the session's folder", () => this.sessionFolder());
      const cwd = step("making the session's clone", () =>
        this.clone(request.project, repo, request.branch, heads, files.id),
      );
      // Claude Code loads these from every folder above where it runs, whatever the settings say.
      const memory = step('reading the folders above the clone', () => memoryAbove(cwd));
      if (memory.length > 0)
        throw new LaunchRefused(
          `no local session started: Claude Code would load ${memory.map(visible).join(', ')}, above the session's clone; move it away`,
          true,
        );
      // The tree first: a symlinked `.claude` would pass a walk of the files it points at.
      const tree = step("reading the session's clone", () =>
        this.treeFiles(cwd, 'HEAD', request.branch),
      );
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
      const roleFile = join(cwd, '.claude', 'agents', `${request.role}.md`);
      if (!existsSync(roleFile))
        throw new LaunchRefused(
          `no local session started: ${request.branch} has no .claude/agents/${request.role}.md`,
        );
      // One value, matched to the release with the role file, for --model and the record.
      const role = readFileSync(roleFile);
      const model = roleModel(role.toString('utf8'));
      if (model === undefined)
        throw new LaunchRefused(
          `no local session started: ${request.branch}'s .claude/agents/${request.role}.md names no model a session may run`,
        );
      // git's identity in the clone's own config: the session's git reads no global config.
      step("setting git's identity in the session's clone", () => {
        this.isolated(cwd, ['config', 'user.name', `Factory ${request.role}`]);
        this.isolated(cwd, ['config', 'user.email', `${request.role}@factory.invalid`]);
      });
      const tmp = step("making the session's temporary folder", () => this.tmpFolder(request.item));
      try {
        const env = step("building the session's environment", () =>
          this.sessionEnv(request, files.id, tmp, token),
        );
        // The session's own PATH: what Claude Code finds there is what the session runs.
        const folders = env.PATH.split(':').filter((folder) => folder !== '');
        for (const program of this.options.sandbox ?? ['bwrap', 'socat'])
          if (located(program, folders) === undefined)
            throw new LaunchRefused(
              `no local session started: ${program}, which Claude Code's sandbox needs, is not on the session's PATH (${env.PATH}); install it`,
            );
        await this.shellNames(cwd, env);
        await this.claudeVersion(cwd, env);
        step("writing the session's settings and record", () => {
          const tests = this.testFiles(cwd);
          this.writeSettings(request, files, { clone: cwd, tmp, tests, folders });
          const record = {
            ...{ role: request.role, item: request.item, station: request.station },
            ...{ feature: request.feature, files: request.files, clone: cwd, model },
            role_version: roleVersion(manifest.release, role),
            ...{
              repo,
              inbox_issue,
              branch: request.branch,
              head: heads.head,
              tests,
            },
          };
          writeFileSync(files.record, `${JSON.stringify(record, null, 2)}\n`, WRITE_ONCE);
        });
        const result = await this.run('claude', localInvocation(request, files, model), {
          cwd,
          env,
        });
        if (result.status !== 0)
          throw new EnvironmentError(
            `claude exited ${String(result.status)}: ${result.stderr.trim()}`,
          );
        let reported: unknown;
        try {
          reported = (JSON.parse(result.stdout) as { session_id?: unknown }).session_id;
        } catch {
          reported = undefined;
        }
        if (reported !== files.id)
          throw new EnvironmentError(
            `claude reported session ${JSON.stringify(reported)}, not ${files.id} as launched`,
          );
        return { sessionId: files.id };
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * The functions and aliases of a login and an interactive shell, with the session's own
   * environment, since T125's A8 matched neither to the session's: none may have the name of a
   * command any role's shell column starts with, or of a wrapper the command guard sees through.
   */
  private async shellNames(cwd: string, env: NodeJS.ProcessEnv) {
    const commands = Object.values(factoryPolicy().roles).flatMap((row) => row.shell);
    const names = new Set([...commands.map((prefix) => prefix.split(' ')[0] ?? ''), ...WRAPPERS]);
    for (const mode of ['-lc', '-ic']) {
      let result: Awaited<ReturnType<Runner>>;
      try {
        result = await this.run('bash', [mode, 'compgen -A function -A alias || true'], {
          cwd,
          env,
        });
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        throw new EnvironmentError(`no local session started: bash ${mode}: ${visible(why)}`);
      }
      if (result.status !== 0)
        throw new EnvironmentError(
          `no local session started: bash ${mode} exited ${String(result.status)}: ${visible(result.stderr.trim())}`,
        );
      const clash = result.stdout.split('\n').filter((name) => names.has(name.trim()));
      if (clash.length > 0)
        throw new LaunchRefused(
          `no local session started: bash ${mode} defines ${clash.map(visible).join(', ')} as a function or alias, the name of a command a session runs; remove it from your shell's startup files`,
        );
    }
  }

  /**
   * Claude Code as the session runs it: the version the release was probed on, 2.1.309, or later;
   * 2.1.295 is only the floor for `onFailure: "block"`, and the guards rely on more (T082).
   */
  private async claudeVersion(cwd: string, env: NodeJS.ProcessEnv) {
    let result: Awaited<ReturnType<Runner>>;
    try {
      result = await this.run('claude', ['--version'], { cwd, env });
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      throw new EnvironmentError(`no local session started: claude --version: ${visible(why)}`);
    }
    const [major = 0, minor = 0, patch = 0] = (/^(\d+)\.(\d+)\.(\d+)/.exec(result.stdout) ?? [])
      .slice(1)
      .map(Number);
    const [floorMajor = 0, floorMinor = 0, floorPatch = 0] =
      CLAUDE_CODE_VERSION.split('.').map(Number);
    const old =
      major * 1e8 + minor * 1e4 + patch < floorMajor * 1e8 + floorMinor * 1e4 + floorPatch;
    if (result.status !== 0 || old)
      throw new LaunchRefused(
        `no local session started: the session's claude reports ${JSON.stringify(visible(result.stdout.trim()))}; local sessions need Claude Code ${CLAUDE_CODE_VERSION} or later`,
      );
  }

  /** The project's gh token, for a role with `gh` in its shell. */
  private ghToken(role: RoleName, repo: string): string {
    const file = tokenFile(this.options.home, repo);
    const token = existsSync(file) ? readFileSync(file, 'utf8').trim() : undefined;
    if (token === undefined)
      throw new LaunchRefused(
        `no local session started: ${role} runs gh, and no gh token is set up for ${repo}: save in ${file} ${tokenSetup(repo)}. A session never gets your own gh login`,
      );
    if (!FINE_GRAINED.test(token))
      throw new LaunchRefused(
        `no local session started: ${file} holds no fine-grained token (github_pat_…); save there ${tokenSetup(repo)}`,
      );
    return token;
  }

  /** The session's environment, from the allowlist alone; no Spec Kit variables (T171). */
  private sessionEnv(request: LaunchRequest, id: string, tmp: string, token?: string) {
    const { env } = this.options;
    const home = realpathSync(this.options.home);
    const outside = [join(home, 'factory-work'), dirname(tmp), ...SHARED_TMP];
    return {
      ...{ PATH: sessionPath(env.PATH, outside), HOME: home },
      // Every Bash command starts in the clone, a second layer beside the guard's refusal of cd.
      CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: '1',
      ...(env.LANG === undefined ? {} : { LANG: env.LANG }),
      ...(env.TERM === undefined ? {} : { TERM: env.TERM }),
      // Define works for the project, not an item: it gets a station and no item.
      ...(request.item > 0 ? { FACTORY_ITEM: String(request.item) } : {}),
      FACTORY_STATION: String(request.station),
      // What the MCP server takes its session from; the hooks read it from their input.
      ...{ FACTORY_ROLE: request.role, FACTORY_SESSION: id },
      ...(token === undefined ? {} : { GH_TOKEN: token }),
      ...(NO_ADVISOR.has(request.role) ? { CLAUDE_CODE_DISABLE_ADVISOR_TOOL: '1' } : {}),
      // Home is unreadable to sandboxed shells (T183): their temporary files and npm's cache here.
      ...{ TMPDIR: tmp, CLAUDE_CODE_TMPDIR: tmp, npm_config_cache: join(tmp, 'npm') },
    };
  }

  /** The session's own folder under `~/.factory/sessions/`, made for this launch alone. */
  private sessionFolder(): SessionFiles {
    const id = (this.options.sessionId ?? randomUUID)();
    const dir = join(this.options.home, '.factory', 'sessions', id);
    mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      throw new LaunchRefused(`no local session started: the session folder ${dir} already exists`);
    }
    const at = (name: string) => join(dir, name);
    return { id, settings: at('settings.json'), mcp: at('mcp.json'), record: at('session.json') };
  }

  /** The test files at the clone's head, read without the Owner's config (T070). */
  private testFiles(clone: string): string[] {
    const paths = this.isolated(clone, ['ls-tree', '-r', '-z', '--name-only', 'HEAD']);
    return paths
      .toString()
      .split('\0')
      .filter((path) => path !== '' && isTestFile(path));
  }

  /** A fresh, short temporary folder for the session, by its real path (T061). */
  private tmpFolder(item: number): string {
    const root = this.options.tmpRoot ?? '/tmp';
    return realpathSync(mkdtempSync(join(root, `factory-${String(item)}-`)));
  }

  /**
   * The real folder of every program on the role's shell list that the sandbox would not read,
   * to open read-only, such as Security's semgrep under `~/.local`; a program not on the
   * session's PATH refuses the launch by name, since the session could not run it (T061).
   */
  private programFolders(role: RoleName, folders: readonly string[], opened: readonly string[]) {
    const home = realpathSync(this.options.home);
    const programs = new Set(factoryPolicy().roles[role].shell.map((p) => p.split(' ')[0] ?? ''));
    const out: string[] = [];
    for (const program of programs) {
      const real = located(program, folders);
      if (real === undefined)
        throw new LaunchRefused(
          `no local session started: ${program}, on the ${role} role's shell list, is not on the session's PATH (${folders.join(':')}); install it`,
        );
      const folder = dirname(real);
      const denied = [home, ...UNREAD].some((root) => under(folder, root));
      if (denied && ![...opened, ...out].some((open) => under(folder, open))) out.push(folder);
    }
    return out;
  }

  /** The session's `--settings` file and the factory's MCP config, from the installed factory. */
  private writeSettings(
    request: LaunchRequest,
    files: SessionFiles,
    at: { clone: string; tmp: string; tests: readonly string[]; folders: readonly string[] },
  ) {
    const policy = factoryPolicy();
    const factory = JSON.parse(factoryFile('settings/settings.json')) as Settings;
    const named = /^tools: (.*)$/m.exec(factoryFile(`roles/${request.role}.md`))?.[1] ?? '';
    const mcp = named.split(', ').filter((tool) => tool.startsWith('mcp__factory__'));
    // The roles whose shell runs npm read node's own folder, which may lie under home.
    const npm = policy.roles[request.role].shell.some((prefix) => /^(npm|npx)\b/.test(prefix));
    const node = dirname(dirname(realpathSync(process.execPath)));
    const home = realpathSync(this.options.home);
    const opened = npm ? [node] : [];
    const tools = [...opened, ...this.programFolders(request.role, at.folders, opened)];
    const paths = { home, clone: at.clone, tmp: at.tmp, tools };
    const { role, feature, files: task } = request;
    const input = { role, paths, feature, files: task, tests: at.tests, factory, mcp };
    const settings = renderSessionSettings(policy, input);
    writeFileSync(files.settings, `${JSON.stringify(settings, null, 2)}\n`, WRITE_ONCE);
    writeFileSync(files.mcp, MCP_JSON, WRITE_ONCE);
  }
}
