// Local sessions (research R8, FR-031): `claude -p` on the laptop, one at a time, each in a
// fresh clone of its own under `~/factory-work/<repo>/<name>`, never in the Owner's working copy
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
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { EnvironmentError } from '../../cli/env.js';
import { mergeBase, safeDiff, safeGit } from '../../git/diff.js';
import { loadPolicy } from '../../guard/policy.js';
import { buildManifest, coversHashed } from '../../install/manifest.js';
import { DEFINE_BRANCH } from '../../install/project.js';
import { MCP_JSON } from '../../install/render.js';
import { renderSessionSettings } from '../../install/session-settings.js';
import type { Settings } from '../../install/settings.js';
import { pathRule } from '../../merge/rules.js';
import { parseConfig } from '../../model/config.js';
import { branchFeatureDir } from '../../model/naming.js';
import { visible } from '../../notify/summary.js';
import type { GuardrailManifest, ProjectConfig, ReleasePin } from '../../model/types.js';
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

/** The session's own files, in its folder under `~/.factory/sessions/`. */
export interface SessionFiles {
  id: string;
  settings: string;
  mcp: string;
}

/**
 * The `claude` arguments for a local session (T061): its id, its own settings, only the project's
 * settings besides, only the factory's MCP server and `dontAsk`, so a tool call no rule allows is
 * refused; never auto mode, a resume or a skipped permission check.
 */
export const localInvocation = (request: LaunchRequest, files: SessionFiles): readonly string[] => [
  ...['-p', '--agent', request.role, '--model', 'sonnet', '--output-format', 'json'],
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
   * its `origin` the project's GitHub remote, never fetched.
   */
  private clone(project: string, branch: string, heads: Heads): string {
    const { home } = this.options;
    const repo = this.config(project, heads.main).repo;
    const name = branch === 'main' ? 'main' : branch.slice('claude/'.length);
    const dir = join(realpathSync(home), 'factory-work', ...repo.split('/'), name);
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
      const cwd = step("making the session's clone", () =>
        this.clone(request.project, request.branch, heads),
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
      // No Spec Kit variables: the release's commands take the feature folder from the prompt.
      const env = {
        ...this.options.env,
        // Define works for the project, not an item: it gets a station and no item.
        ...(request.item > 0 ? { FACTORY_ITEM: String(request.item) } : {}),
        FACTORY_STATION: String(request.station),
      };
      const files = step("making the session's folder", () => this.sessionFolder());
      const tmp = step("making the session's temporary folder", () => this.tmpFolder(request.item));
      try {
        step("writing the session's settings", () => {
          this.writeSettings(request, files, { clone: cwd, tmp });
        });
        const result = await this.run('claude', localInvocation(request, files), { cwd, env });
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
    return { id, settings: join(dir, 'settings.json'), mcp: join(dir, 'mcp.json') };
  }

  /** A fresh, short temporary folder for the session, by its real path (T061). */
  private tmpFolder(item: number): string {
    const root = this.options.tmpRoot ?? '/tmp';
    return realpathSync(mkdtempSync(join(root, `factory-${String(item)}-`)));
  }

  /** The session's `--settings` file and the factory's MCP config, from the installed factory. */
  private writeSettings(
    request: LaunchRequest,
    files: SessionFiles,
    at: { clone: string; tmp: string },
  ) {
    const policy = factoryPolicy();
    const factory = JSON.parse(factoryFile('settings/settings.json')) as Settings;
    const tools = /^tools: (.*)$/m.exec(factoryFile(`roles/${request.role}.md`))?.[1] ?? '';
    const mcp = tools.split(', ').filter((tool) => tool.startsWith('mcp__factory__'));
    // The roles whose shell runs npm read node's own folder, which may lie under home.
    const npm = policy.roles[request.role].shell.some((prefix) => /^(npm|npx)\b/.test(prefix));
    const node = dirname(dirname(realpathSync(process.execPath)));
    const paths = {
      ...{ home: realpathSync(this.options.home), ...at },
      tools: npm ? [node] : [],
    };
    const { role, feature, files: task } = request;
    const input = { role, paths, feature, files: task, factory, mcp };
    const settings = renderSessionSettings(policy, input);
    const write = { flag: 'wx', mode: 0o600 } as const;
    writeFileSync(files.settings, `${JSON.stringify(settings, null, 2)}\n`, write);
    writeFileSync(files.mcp, MCP_JSON, write);
  }
}
