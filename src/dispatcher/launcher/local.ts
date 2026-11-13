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
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  accessSync,
  appendFileSync,
  constants,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EnvironmentError, RefusedError } from '../../cli/env.js';
import { SERVED_HOOKS } from '../../commands/hook.js';
import { WRAPPERS } from '../../guard/command-guard.js';
import { isFable, roleVersion } from '../../events/schema.js';
import { hasPassed, sessionEvents } from '../../hooks/session.js';
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
import { hashOnce } from '../failures.js';
import { installDependencies, installs, type Installer } from './deps.js';
import {
  LaunchRefused,
  SessionCapped,
  SessionFailed,
  SessionUnknown,
  type Availability,
  type LaunchRequest,
  type LaunchResult,
  type LocalSessionLauncher,
  type Notice,
} from './types.js';

export type Runner = (
  program: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    /** In ms; kills the program's whole process group when it is reached. */
    timeout?: number;
    /** Runs the program in a process group of its own, as a timeout does. */
    group?: boolean;
    /** In ms; stops the run, group and all, once its output has been silent that long. */
    silence?: number;
    /** Each line of its output as it comes; a reason returned stops the run, group and all. */
    line?: (line: string) => string | undefined;
    /** Called on each chunk of its output, as the watchdog hears it. */
    chunk?: () => void;
    /** The program's pid once it has started: for a grouped run, its process group's id. */
    started?: (pid: number) => void;
    /** Bubblewrap's arguments to run the program inside, as a session's claude runs (`CONTAIN`). */
    contain?: readonly string[];
  },
) => Promise<{
  status: number | null;
  /** The signal that ended the program, if one did. */
  signal?: NodeJS.Signals;
  /** Stopped by `silence`. */
  silent?: boolean;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}>;

/**
 * How long a program's output may drain once it has exited, in ms: a check's is short, and an
 * untimed run's, such as a session's, longer, so its last lines are not lost.
 */
const DRAIN = { timed: 200, untimed: 2000 };

/**
 * The bubblewrap a session's claude runs in (T061, T125's findings 2 and 3): the host as it is, but
 * a PID namespace of its own, with its own /proc, ending with the factory. Claude Code starts each
 * Bash command, a background task's included, in a session and process group of its own, outside
 * claude's; inside this namespace every one of them ends once its first process does, nested
 * namespaces included, and that process ends with this bwrap, which the launcher starts and
 * records as the session's group: so a factory SIGKILLed, or this bwrap killed alone, leaves
 * nothing of the session running.
 */
export const CONTAIN = [
  ...['--dev-bind', '/', '/', '--proc', '/proc'],
  ...['--unshare-pid', '--die-with-parent', '--'],
] as const;
/** Claude Code's own sandbox, in the shape each Bash command starts it, for the nested probe. */
const NESTED = [
  ...['--new-session', '--die-with-parent', '--unshare-net', '--unshare-pid'],
  ...['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', 'true'],
];
/** How long the nested probe may run, in ms, killed with SIGKILL past it. */
const PROBE = 30_000;
/** The longest line `line` is given, in characters; a longer one is cut there, the rest skipped. */
export const MAX_LINE = 4 * 1024 * 1024;
/** The signals that end the factory, each with its exit status, 128 and the signal's number. */
const SIGNALS = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const;
/** How long a group stopped by a signal has after SIGTERM before SIGKILL, in ms. */
const GRACE = 3000;
/** The longest a session's Bash command may run, in ms, which the launcher sets itself (T061). */
export const BASH_MAX_TIMEOUT = 600_000;
/** How long a session's stream may be silent, in ms: above the longest command a role runs. */
export const SILENCE = 12 * 60_000;

/** The prompt's line for a Builder or Define whose clone's install failed; no npm output in it. */
export const UNINSTALLED =
  "The factory could not install this repository's dependencies before the session: run npm ci, or npm install if package-lock.json is out of step with package.json.";

/**
 * The prompt's line for a Builder or Define whose install npm never ran: the first finding,
 * fenced and through visible(), what to change, and no npm ci, which would run the same prepare.
 */
function refusedLine(why: string): string {
  const text = visible(why);
  const fence = '`'.repeat(Math.max(3, ...(text.match(/`+/g) ?? []).map((r) => r.length + 1)));
  return [
    "The factory did not install this repository's dependencies, and npm never ran, because:",
    `${fence}text\n${text}\n${fence}`,
    'Change that first: a registry version, with its integrity, for a git, file or link dependency, or remove a committed node_modules or npm-shrinkwrap.json. Do not run npm ci or npm install before then: they would run what the factory refused.',
  ].join('\n');
}

/** How often `factory run` hears from a running session, in ms. */
const HEARTBEAT = 60_000;

/**
 * A program with stdin from /dev/null, so nothing it runs can wait for input. It has finished
 * when it exits, whatever it leaves running: a child that keeps the output pipes open, such as one
 * a startup file starts with `setsid`, cannot hold the launch. The output drains for a moment, then
 * the pipes are destroyed; with a timeout, the program runs in a process group of its own, and what
 * is left of the group is stopped then too. On timeout the group is stopped and the run settles,
 * and so it does as soon as `line` asks. Once it has settled, nothing later changes the result.
 * While a grouped run is active, a signal that ends the factory stops the group first, SIGTERM and
 * SIGKILL after a grace, and the factory's own exit SIGKILLs it, so nothing it started runs on
 * with nobody reading it, such as a session on the Owner's plan after a Ctrl-C (T061); a signal
 * that comes while the output drains ends the factory as the run settles. `started` is called once
 * every listener is in place, and if it throws, the group is stopped and the run rejects.
 */
export const runProcess: Runner = (program, args, options) =>
  new Promise((resolve, reject) => {
    const { timeout, group, silence, line, chunk: heard, contain, ...spawned } = options;
    const grouped = timeout !== undefined || group === true;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let silent = false;
    let quiet: NodeJS.Timeout | undefined;
    let settled = false;
    let drain: NodeJS.Timeout | undefined;
    let pending = '';
    let skipping = false;
    let pid: number | undefined = undefined;
    const signalGroup = (signal: NodeJS.Signals) => {
      try {
        if (grouped && pid !== undefined) process.kill(-pid, signal);
      } catch {
        // The group has already ended.
      }
    };
    const signalPid = (member: number, signal: NodeJS.Signals) => {
      try {
        process.kill(member, signal);
      } catch {
        // It has already ended.
      }
    };
    const stopGroup = () => {
      signalGroup('SIGKILL');
    };
    let ending: number | undefined;
    const handlers = (Object.keys(SIGNALS) as (keyof typeof SIGNALS)[]).map((signal) => {
      const end = () => {
        ending = SIGNALS[signal];
        // A contained run's leader is bwrap, which neither handles nor forwards SIGTERM: killed,
        // it would end the namespace at once. Its group's other members get the SIGTERM, claude
        // among them, and the whole group SIGKILL once the grace is over, at the factory's exit.
        if (contain === undefined || pid === undefined) signalGroup('SIGTERM');
        else
          for (const member of new ProcScan().members(pid))
            if (member !== pid) signalPid(member, 'SIGTERM');
        setTimeout(() => process.exit(ending), GRACE);
      };
      return [signal, end] as const;
    });
    const unwatch = () => {
      process.off('exit', stopGroup);
      for (const [signal, handler] of handlers) process.off(signal, handler);
    };
    // A run that never started: a signal caught during the spawn is read in the next poll
    // phase, and only the second check phase from here is sure to come after it, so the
    // handlers stay until then and the signal still ends the factory (T061, deferred (5)).
    const abandon = () => setImmediate(() => setImmediate(unwatch));
    // Before the spawn: a signal that came before its handler would end the factory at once,
    // leaving the group running; once handled, it waits for the event loop, by when `pid` is set.
    if (grouped) {
      process.on('exit', stopGroup);
      for (const [signal, handler] of handlers) process.on(signal, handler);
    }
    const child = (() => {
      try {
        const argv =
          contain === undefined ? [program, ...args] : ['bwrap', ...contain, program, ...args];
        return spawn(argv[0] ?? program, argv.slice(1), {
          ...spawned,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: grouped,
        });
      } catch (error) {
        abandon();
        throw error;
      }
    })();
    pid = child.pid;
    // Out of file descriptors (EMFILE, ENFILE), the child may have no pipes: its own error, if
    // any, is the one this rejects with.
    const pipes: { stdout: unknown; stderr: unknown } = child;
    if (pipes.stdout === null || pipes.stderr === null) {
      child.on('error', () => undefined);
      if (pid !== undefined) signalPid(grouped ? -pid : pid, 'SIGKILL');
      abandon();
      reject(new Error(`${program} has no output pipes, most likely out of file descriptors`));
      return;
    }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const take = (text: string) => {
      if (line?.(text) !== undefined) settle(null);
    };
    const close = () => {
      settled = true;
      unwatch();
      clearTimeout(timer);
      clearTimeout(drain);
      clearTimeout(quiet);
      child.stdout.destroy();
      child.stderr.destroy();
      stopGroup();
      // A signal to the factory before the run settled, such as during the drain: it ends now.
      if (ending !== undefined) process.exit(ending);
    };
    const settle = (status: number | null, signal?: NodeJS.Signals | null) => {
      if (settled) return;
      close();
      const ended = signal ? { signal } : {};
      const why = { ...(timedOut ? { timedOut } : {}), ...(silent ? { silent } : {}) };
      resolve({ status, ...ended, stdout, stderr, ...why });
    };
    const listen = () => {
      if (silence === undefined) return;
      clearTimeout(quiet);
      quiet = setTimeout(() => {
        // The program has exited and its output drains: it settles as the drain does.
        if (drain !== undefined) return;
        silent = true;
        settle(null);
      }, silence);
    };
    listen();
    const timer =
      timeout === undefined
        ? undefined
        : setTimeout(() => {
            if (drain !== undefined) return;
            timedOut = true;
            settle(null);
          }, timeout);
    // Only the new chunk is searched for a line's end; what remains is flushed when it ends.
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      listen();
      heard?.();
      if (line === undefined) return;
      let from = 0;
      for (let at = chunk.indexOf('\n'); at !== -1 && !settled; at = chunk.indexOf('\n', from)) {
        const text = pending + chunk.slice(from, at);
        pending = '';
        from = at + 1;
        // The rest of a line cut at the cap is skipped, never given as a line of its own.
        if (skipping) skipping = false;
        else take(text);
      }
      if (settled || skipping) return;
      pending += chunk.slice(from);
      if (pending.length <= MAX_LINE) return;
      take(pending);
      pending = '';
      skipping = true;
    });
    const flush = () => {
      if (pending !== '' && !settled) take(pending);
      pending = '';
    };
    child.stdout.on('end', flush);
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    child.on('error', (error) => {
      if (settled) return;
      close();
      reject(error);
    });
    child.on('exit', (status, signal) => {
      // Ended by a signal to the factory: the group goes, and so does the factory.
      if (ending !== undefined) {
        stopGroup();
        process.exit(ending);
      }
      if (settled) return;
      // A session, grouped with a wall-clock cap, drains as long as an untimed run.
      const wait = timeout === undefined || group === true ? DRAIN.untimed : DRAIN.timed;
      drain = setTimeout(() => {
        flush();
        settle(status, signal);
      }, wait);
    });
    child.on('close', (status, signal) => {
      settle(status, signal);
    });
    if (grouped && child.pid !== undefined)
      try {
        options.started?.(child.pid);
      } catch (error) {
        close();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
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
 * `text` written once at `file`, whole or not at all: a temporary file linked to its name, which
 * fails if it exists, so a crash leaves no torn file there, only a temporary one beside it.
 */
export function writeWhole(file: string, text: string): void {
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, text, WRITE_ONCE);
  try {
    linkSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

/**
 * The `claude` arguments for a local session (T061): its id, its own settings, only the project's
 * settings besides, only the factory's MCP server and `dontAsk`, so a tool call no rule allows is
 * refused; never auto mode, a resume or a skipped permission check.
 */
export const localInvocation = (
  request: LaunchRequest,
  files: SessionFiles,
  model: string,
  turns: number,
): readonly string[] => [
  ...['-p', '--agent', request.role, '--model', model, '--max-turns', String(turns)],
  ...['--output-format', 'stream-json', '--verbose'],
  ...['--session-id', files.id, '--settings', files.settings, '--setting-sources', 'project'],
  ...['--strict-mcp-config', '--mcp-config', files.mcp, '--permission-mode', 'dontAsk'],
  request.prompt,
];

/** The installed factory's root, holding `factory/` and its code's folder, `dist/` or `src/`. */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
/** The folder the code runs from, below the root: `dist/` installed, `src/` under the tests. */
const CODE = relative(ROOT, fileURLToPath(import.meta.url)).split(sep)[0] ?? '';
let installed: (() => string) | undefined;
/** The installed `factory/`'s files, read with the hash, by their path from the root. */
let installedFiles: ReadonlyMap<string, Buffer> = new Map();
/**
 * At `factory dispatch` or `factory run`'s start, the installed factory's hash, and `factory/`
 * read in the same walk, so a release installed while it runs never gives the code it started
 * with the new release's hash, policy, role files or settings (T061, deferred (17)). Code that
 * runs from neither `dist/` nor `src/` has no hash; like any failure to take it, that is an error
 * only when a local pass asks for it. `root` is the tests' own, for a factory they set up.
 */
export function snapshotFactory(root = ROOT): void {
  const files = new Map<string, Buffer>();
  installedFiles = files;
  installed =
    CODE === 'dist' || CODE === 'src'
      ? hashOnce(root, [CODE, 'factory'], files)
      : () => {
          throw new EnvironmentError(
            `the installed factory cannot be hashed: its code runs from ${visible(CODE)} below ${ROOT}, not dist/ or src/; reinstall the pinned release`,
          );
        };
}
/** The installed factory's hash, the one taken at the start; none taken is an error. */
export const installedHash = (): string => {
  if (installed === undefined)
    throw new EnvironmentError(
      'the installed factory was not read at start, so it has no hash to record; run factory dispatch or factory run again',
    );
  return installed();
};
/**
 * A file of the installed factory as the start read it, never the release a branch pins, nor
 * one installed since; with no snapshot taken, or one that failed, an error.
 */
export const factoryFile = (path: string): string => {
  installedHash();
  const bytes = installedFiles.get(`factory/${path}`);
  if (bytes === undefined)
    throw new EnvironmentError(
      `the installed factory has no file factory/${path}; reinstall the pinned release`,
    );
  return bytes.toString('utf8');
};
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
/** The model families a role file may name, whose init message must name a model of it. */
const FAMILIES = ['sonnet', 'opus', 'haiku'];
/** A full Claude model id, with no extended-context variant such as `[1m]` (T061). */
const PLAIN_ID = /^claude-[a-z0-9]+(-[a-z0-9.]+)*$/;
/**
 * A plain family or a full Claude id: no alias such as `opusplan` and no extended-context variant
 * such as `sonnet[1m]`, on purpose, since such a variant follows instructions no better as its
 * context grows (design rev 998, T061).
 */
const MODEL = new RegExp(`^(sonnet|opus|haiku|${PLAIN_ID.source.slice(1, -1)})$`);

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
/** What Claude Code loads from a `.claude` folder above where it runs, in any letter case. */
const RULES = /^(claude(\.local)?\.md|rules)$/i;

const errno = (error: unknown) => (error as NodeJS.ErrnoException).code;

/**
 * `/proc`, read for the sessions' process groups (T061, deferred (1) and (2)): one scan of every
 * process for a launch's still-running check, made at most once, and a fresh one for each later
 * question. `root` is `/proc`, or a folder a test sets up in its place.
 */
export class ProcScan {
  /** How many times every process was read. */
  scans = 0;
  private groups: Map<string, number[]> | undefined;
  constructor(
    readonly root = '/proc',
    private readonly read = (file: string) => readFileSync(file, 'utf8'),
  ) {}

  /**
   * The fields of `<pid>/stat` from the third on, read after the last `)`, since the command's
   * name may hold spaces: `[0]` its state, `[2]` its process group, `[19]` its start time in clock
   * ticks since boot. Undefined once the process has gone, and, when `others`, for a process whose
   * stat cannot be read, as another user's under a /proc mounted with hidepid=1, EPERM (hidepid=2
   * hides its folder): a session's processes are all the Owner's. Any other failure, or a stat that cannot be parsed, is an error.
   */
  stat(pid: number, others = false): string[] | undefined {
    const file = join(this.root, String(pid), 'stat');
    let text: string;
    try {
      text = this.read(file);
    } catch (err) {
      if (errno(err) === 'ENOENT' || errno(err) === 'ESRCH') return undefined;
      const denied = errno(err) === 'EPERM' || errno(err) === 'EACCES';
      if (others && denied) return undefined;
      const hidepid = denied ? ', as under a /proc mounted with hidepid' : '';
      throw new EnvironmentError(
        `${file} cannot be read (${visible(String(errno(err)))})${hidepid}, so no session's process group can be checked; mount /proc so the Owner's processes can be read`,
      );
    }
    const end = text.lastIndexOf(')');
    const fields = end === -1 ? [] : text.slice(end + 2).split(' ');
    if (fields.length < 20)
      throw new EnvironmentError(`${file} cannot be parsed: ${visible(text.slice(0, 80))}`);
    return fields;
  }

  /** The kernel's boot id, which tells a recorded leader from a later process given its pid. */
  boot(): string {
    const file = join(this.root, 'sys', 'kernel', 'random', 'boot_id');
    try {
      return readFileSync(file, 'utf8').trim();
    } catch (err) {
      throw new EnvironmentError(
        `${file} cannot be read (${visible(String(errno(err)))}), so no session's process group can be told from a later one`,
      );
    }
  }

  /** The live processes of process group `pgid`, a zombie not counted. */
  members(pgid: number): number[] {
    if (this.groups === undefined) {
      this.scans += 1;
      this.groups = new Map();
      for (const name of readdirSync(this.root).filter((n) => /^\d+$/.test(n))) {
        const stat = this.stat(Number(name), true);
        if (stat === undefined || stat[0] === 'Z') continue;
        this.groups.set(stat[2] ?? '', [...(this.groups.get(stat[2] ?? '') ?? []), Number(name)]);
      }
    }
    return this.groups.get(String(pgid)) ?? [];
  }
}

/**
 * A session's process group as recorded in its folder: its id, and its leader's start time and
 * the kernel's boot id, read before the spawn, which together tell that leader from a later
 * process given its pid (T061).
 */
export function groupRecord(pgid: number, boot = new ProcScan().boot(), scan = new ProcScan()) {
  const start = scan.stat(pgid)?.[19];
  if (start === undefined) throw new Error(`process ${String(pgid)} has no start time`);
  return { pgid, start, boot };
}

/** Whether `done` holds within about a second, asked every 50 ms. */
async function until(done: () => boolean): Promise<boolean> {
  for (let tries = 0; tries < 20; tries++) {
    if (done()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return done();
}

/** Whether `path` exists; anything but its absence throws, naming it. */
function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (err) {
    if (errno(err) === 'ENOENT') return false;
    throw new EnvironmentError(`${path} cannot be read: ${visible(String(errno(err)))}`);
  }
}

/**
 * The way out when a branch's release lacks what a session needs: main's pin moves; an item
 * branch keeps the release pinned at its merge base until main is merged into it (T061).
 */
const keptOut = (branch: string) =>
  branch === 'main'
    ? 're-pin main to a release that has it'
    : 'close this item and file it again, since the branch keeps the release pinned at its merge base';

/**
 * Why session `id` still runs, or undefined when it does not, read fail-closed from its folder
 * (T061): `ended`, written once nothing of its group remained, or `not-spawned`, written when it
 * failed before the spawn, reads as ended, as does no folder at all, or a folder with no
 * `session.json`, written once before the attempt is counted and claude spawns; `group.json` alone
 * is checked in `/proc`; both markers' kinds together, or `session.json` with none of the three, as
 * when a factory stopped between the spawn and the group's record, stop the pass, naming the way
 * out.
 */
export function sessionRunning(
  home: string,
  id: string,
  scan = new ProcScan(),
): string | undefined {
  const dir = join(home, '.factory', 'sessions', id);
  const file = join(dir, 'group.json');
  const out = `remove ${visible(dir)} once ps -eo pid,pgid,args shows nothing of session ${visible(id)}`;
  const grouped = present(file);
  const unspawned = present(join(dir, 'not-spawned'));
  if (grouped && unspawned)
    throw new EnvironmentError(`${visible(dir)} records a process group and no spawn both; ${out}`);
  if (unspawned || present(join(dir, 'ended')) || !present(dir)) return undefined;
  if (!grouped) {
    // Never counted and never spawned: its folder was made before the checks, its record after.
    if (!present(join(dir, 'session.json'))) return undefined;
    throw new SessionUnknown(
      `whether session ${visible(id)} still runs is unknown: ${visible(dir)} records no process group and no end, as when a factory stops after session.json is written and before claude spawns, or after claude spawns and before its group is recorded; ${out}`,
    );
  }
  return groupRunning(file, id, scan);
}

/** Why the group recorded in `file` for session `id` still runs, or undefined when it does not. */
function groupRunning(file: string, id: string, scan = new ProcScan()): string | undefined {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    // No group recorded; any other failure never reads as a session that has ended.
    if (errno(err) === 'ENOENT') return undefined;
    const why = err instanceof Error ? err.message : String(err);
    throw new EnvironmentError(
      `${file} cannot be read: ${visible(why)}; remove it once ps -eo pid,pgid,args shows nothing of session ${visible(id)}`,
    );
  }
  let group: Message;
  try {
    group = JSON.parse(text) as Message;
    const { pgid, start, boot } = group;
    // A group id of 0, as kernel threads have, or less, would match no session's group.
    const valid = typeof pgid === 'number' && Number.isSafeInteger(pgid) && pgid > 0;
    if (!valid || typeof start !== 'string' || typeof boot !== 'string')
      throw new Error('it is not a process group record');
  } catch (err) {
    // The parse message quotes the file's text.
    const why = err instanceof Error ? err.message : String(err);
    throw new EnvironmentError(
      `${file} cannot be read: ${visible(why)}; remove it once ps -eo pid,pgid,args shows nothing of session ${visible(id)}`,
    );
  }
  const pgid = group.pgid as number;
  if (group.boot !== scan.boot()) return undefined;
  const leader = scan.stat(pgid);
  if (leader !== undefined && leader[19] !== group.start) return undefined;
  if (leader !== undefined && leader[0] !== 'Z')
    return `no local session started: session ${visible(id)} is still running (this or another factory) as process group ${String(pgid)}; if no factory runs it, stop it with kill -TERM -${String(pgid)}, then run the factory again`;
  const members = scan.members(pgid);
  if (members.length > 0)
    return `no local session started: session ${visible(id)}'s bubblewrap has ended, but processes ${members.join(', ')} of its process group ${String(pgid)} still run (this or another factory); look at them with ps -o pid,pgid,lstart,args -g ${String(pgid)}, stop them with kill -TERM -${String(pgid)}, then run the factory again`;
  return undefined;
}

/**
 * The names in `dir` that `match`; none when it is missing. A folder that can be searched but not
 * listed, such as a parent of mode 711, is checked for the `exact` names alone, by lstat.
 */
function namesIn(dir: string, match: RegExp, exact: readonly string[]): string[] {
  try {
    return readdirSync(dir).filter((name) => match.test(name));
  } catch (error) {
    if (errno(error) === 'ENOENT' || errno(error) === 'ENOTDIR') return [];
    if (errno(error) !== 'EACCES') throw error;
    return exact.filter((name) => {
      try {
        lstatSync(join(dir, name));
        return true;
      } catch (missing) {
        if (errno(missing) === 'ENOENT') return false;
        throw missing;
      }
    });
  }
}

/**
 * The memory files Claude Code would load from every folder above `clone`, up to `/`: each one's
 * `CLAUDE.md` and `CLAUDE.local.md`, and those and `rules/` in its `.claude` but home's,
 * which the per-session settings' `claudeMdExcludes` keep out (T061).
 */
function memoryAbove(clone: string, home: string): string[] {
  const found: string[] = [];
  for (let dir = dirname(clone); ; dir = dirname(dir)) {
    found.push(...namesIn(dir, MEMORY, ['CLAUDE.md', 'CLAUDE.local.md']).map((n) => join(dir, n)));
    const claude = join(dir, '.claude');
    if (dir !== home)
      found.push(
        ...namesIn(claude, RULES, ['CLAUDE.md', 'CLAUDE.local.md', 'rules']).map((n) =>
          join(claude, n),
        ),
      );
    if (dir === '/') return found;
  }
}

/**
 * Folders the sandbox denies besides home: the shared temporary ones, and those Claude Code
 * denies under `blockReadsOutsideWorkingDirectories`.
 */
const UNREAD = ['/home', '/root', '/mnt', '/media', '/srv', ...SHARED_TMP];

/**
 * The first `program` on `folders` the Owner can run, as found there and where it really is;
 * undefined for none.
 */
function located(program: string, folders: readonly string[]) {
  const at = folders.map((folder) => join(folder, program)).find(executable);
  return at === undefined ? undefined : { at, real: realpathSync(at) };
}

/** How long a check before launch may run, in ms. */
const CHECK_TIMEOUT = 10_000;
/**
 * Shell words the session's commands rely on that a startup file could redefine: Claude Code's
 * own wrapper runs some of them, and rvm and some nvm setups override `cd`.
 */
const SHELL_WORDS = ['cd', 'pwd', 'source', 'eval', 'exec', 'exit'];

/** Whether `path` is a file the Owner can run. */
function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The factory MCP tools the installed role file names, as `mcp__factory__<tool>`. */
function namedMcp(role: RoleName): string[] {
  const named = /^tools: (.*)$/m.exec(factoryFile(`roles/${role}.md`))?.[1] ?? '';
  return named.split(', ').filter((tool) => tool.startsWith('mcp__factory__'));
}

/** The tools a session of `role` has, which its init message must list exactly (T061). */
export function sessionTools(role: RoleName): string[] {
  const policy = factoryPolicy();
  const tools = [...policy.roles[role].tools, ...Object.keys(policy.keepTools), ...namedMcp(role)];
  return [...new Set(tools)];
}

type Message = Record<string, unknown>;

/** A stream the launcher cannot read as the session's: a failed session, not urgent. */
const streamFailed = (why: string) => new SessionFailed(why, false);

/** Any failure once claude has spawned: a failed session, not urgent unless it says so. */
const asFailed = (err: unknown) =>
  err instanceof SessionFailed
    ? err
    : streamFailed(
        `the launcher failed while it ran: ${visible(err instanceof Error ? err.message : String(err))}`,
      );

/** A line of the session's `stream-json`; one that is not a JSON object fails the session. */
function message(line: string): Message {
  if (line.length > MAX_LINE)
    throw streamFailed(`its stream has a line longer than ${String(MAX_LINE)} characters`);
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    value = undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw streamFailed(
      `its stream has a line that is not a JSON object: ${visible(line.slice(0, 200))}`,
    );
  return value as Message;
}

/**
 * Whether `m` is the main session's init message, read in order: the first system/init line,
 * before any assistant, user or result line, carrying the launched session id. Other system lines,
 * such as a hook's, may come before it, and no subagent starts before the main session's first
 * assistant message, so it is never a subagent's (T061).
 */
function isInit(m: Message, id: string): boolean {
  if (m.type !== 'system')
    throw streamFailed(
      `its stream has a line of type ${visible(String(m.type))} before its init message`,
    );
  if (m.subtype !== 'init') return false;
  if (m.session_id !== id)
    throw new SessionFailed(
      `its init message reports session ${visible(JSON.stringify(m.session_id ?? null))}, not ${id} as launched`,
      true,
    );
  return true;
}

/**
 * The session's `stream-json`, one message a line: its init message, as `isInit` reads it, and
 * its result, the final line. Any other stream is a failed session, never an empty one (T061).
 */
function readStream(stdout: string, id: string) {
  const messages = stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map(message);
  const init = messages.find((m) => isInit(m, id));
  if (init === undefined) throw streamFailed('its stream has no init message');
  const result = messages.at(-1);
  if (result?.type !== 'result')
    throw streamFailed(
      messages.some((m) => m.type === 'result')
        ? 'its stream goes on after its result line'
        : 'its stream has no result line',
    );
  return { init, result };
}

/** The strings of a list, or a field of each entry. */
const strings = (value: unknown, field?: string) =>
  (Array.isArray(value) ? (value as unknown[]) : [])
    .map((entry) => (field === undefined ? entry : (entry as Message | null)?.[field]))
    .filter((entry): entry is string => typeof entry === 'string');

/** An assistant message's input, cache reads and writes included. */
function context(m: Message): number {
  const usage = ((m.message as Message | null)?.usage ?? {}) as Message;
  const input = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
  return input.reduce((sum, field) => {
    const tokens = usage[field];
    return sum + (typeof tokens === 'number' ? tokens : 0);
  }, 0);
}

/** What the live check read of a session: its init and result messages, as far as it got. */
interface Read {
  init?: Message;
  result?: Message;
  /** The largest input of any assistant message. */
  peak: number;
  /** The longest line, in characters, from which MAX_LINE is set. */
  longest: number;
  /** The main session's assistant messages so far, by distinct message id, never a subagent's. */
  turns: number;
  /** The main session's assistant lines, one per content block, which `turns` counts by id. */
  lines: number;
  ids: Set<string>;
  /** Each assistant message's usage, subagents' included, by message id, so each counts once. */
  usage: Map<string, Message>;
  /** Whether its PreCompact hook blocked a compaction, null when its log cannot tell. */
  full?: boolean | null;
  /** The longest the watchdog heard nothing, from the spawn to the end, in ms. */
  silence: number;
}

/** The token fields of a usage, the result's per-model totals by their own names. */
const TOKENS = {
  input: ['input_tokens', 'inputTokens'],
  output: ['output_tokens', 'outputTokens'],
  cache_read: ['cache_read_input_tokens', 'cacheReadInputTokens'],
  cache_creation: ['cache_creation_input_tokens', 'cacheCreationInputTokens'],
} as const;

/**
 * The session's token totals (T097's per-item budget), each field on its own: the result line's
 * per-model totals when every entry has a number for it, else the factory's own sum over the
 * assistant messages that have one, each id once, a lower bound, since the advisor's calls are
 * not in the stream; null when neither has it, never 0. `source` says which.
 */
function tokens(result: Message, usage: Map<string, Message>) {
  const models = result.modelUsage;
  const entries = typeof models === 'object' && models !== null ? Object.values(models) : [];
  const value = (entry: unknown, names: readonly string[]) =>
    names.map((name) => (entry as Message | null)?.[name]).find(Number.isFinite) as
      number | undefined;
  const total = (names: readonly string[]) => {
    const counted = entries.map((entry) => value(entry, names));
    if (counted.length > 0 && counted.every((n): n is number => n !== undefined))
      return { total: counted.reduce((sum, n) => sum + n, 0), source: 'result' };
    const streamed = [...usage.values()].flatMap((entry) => value(entry, names) ?? []);
    if (streamed.length === 0) return null;
    return { total: streamed.reduce((sum, n) => sum + n, 0), source: 'stream' };
  };
  return {
    input: total(TOKENS.input),
    output: total(TOKENS.output),
    cache_read: total(TOKENS.cache_read),
    cache_creation: total(TOKENS.cache_creation),
  };
}

/**
 * What the session reported, kept in its folder for every session that spawned, failed or not:
 * the model id and version its init message names, how many calls were refused, the models it
 * used, an Opus one being the advisor's, which no tool list shows (T125's A3d, T097), its peak
 * context, from which each role's ceiling is set (design rev 998), its longest line, its turns,
 * its assistant lines and the result's own count, from which with the durations, the result's and
 * the factory's, each role's caps are tuned after Gate A, and the longest silence, the watchdog's.
 */
function reported({ init = {}, result = {}, ...read }: Read, elapsed: number) {
  const usage = result.modelUsage;
  const models = typeof usage === 'object' && usage !== null ? Object.keys(usage) : [];
  return {
    model: typeof init.model === 'string' ? init.model : null,
    claude_code_version:
      typeof init.claude_code_version === 'string' ? init.claude_code_version : null,
    permission_denials: Array.isArray(result.permission_denials)
      ? result.permission_denials.length
      : 0,
    models,
    advisor: models.some((name) => /opus/i.test(name)),
    peak_context: read.peak,
    longest_line: read.longest,
    turns: read.turns,
    assistant_lines: read.lines,
    num_turns: typeof result.num_turns === 'number' ? result.num_turns : null,
    duration_ms: typeof result.duration_ms === 'number' ? result.duration_ms : null,
    // The factory's own, since a session stopped at a cap has no result and so no duration.
    elapsed_ms: elapsed,
    longest_silence_ms: read.silence,
    tokens: tokens(result, read.usage),
    context_full: read.full ?? null,
  };
}

/** Agent and Task are one tool: 2.1.309's init lists Task where a role file names Agent (A3c). */
const tool = (name: string) => (name === 'Agent' ? 'Task' : name);

/**
 * How the init message differs from the launch: no tool beyond the role's, no MCP server but the
 * factory's, `permissionMode` `dontAsk`, and the role file's model, a family by a model of it and a
 * full id by itself, never Fable, since the hook input has no model field (T061, T078). A missing
 * tool can only take something away, so it is not a problem, only `missing`.
 */
function initCheck(init: Message, role: RoleName, model: string) {
  const problems: string[] = [];
  const tools = new Set(strings(init.tools).map(tool));
  const expected = new Set(sessionTools(role).map(tool));
  const extra = [...tools].filter((name) => !expected.has(name));
  if (extra.length > 0)
    problems.push(`it has ${extra.join(', ')}, beyond the ${role} role's tools`);
  const servers = strings(init.mcp_servers, 'name').filter((name) => name !== 'factory');
  if (servers.length > 0)
    problems.push(`it has the MCP server ${servers.join(', ')}, which is not the factory's`);
  if (init.permissionMode !== 'dontAsk')
    problems.push(`its permission mode ${JSON.stringify(init.permissionMode)}, not dontAsk`);
  const id = typeof init.model === 'string' ? init.model : '';
  const family = FAMILIES.includes(model);
  if (isFable(id)) problems.push(`its model ${id} is a Fable model`);
  else if (!PLAIN_ID.test(id))
    problems.push(
      `its model ${id || 'none'} is not a plain model id, such as an extended-context variant`,
    );
  else if (family ? !id.split('-').includes(model) : id !== model)
    problems.push(`its model ${id || 'none'} is not ${family ? `of the ${model} family` : model}`);
  const missing = [...expected].filter((name) => !tools.has(name));
  return { problems: problems.map((problem) => visible(problem)), missing };
}

const mismatch = (problems: readonly string[]) =>
  new SessionFailed(`its init message does not match its launch: ${problems.join('; ')}`, true);

/**
 * A session log's `blocked` events from the hook of `tool`, each by its summary, undefined for
 * one with none, such as a guard's internal error, and the non-empty lines that do not parse; a
 * missing log has none, and one that cannot be read says why.
 */
function blocked(log: string, tool: string) {
  let text = '';
  let missing = false;
  try {
    text = readFileSync(log, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
      return { error: visible(err instanceof Error ? err.message : String(err)) };
    missing = true;
  }
  const unread: number[] = [];
  const refusals = text.split('\n').flatMap((line, at) => {
    if (line.trim() === '') return [];
    try {
      const e = JSON.parse(line) as Message;
      const summary = e.input_summary;
      if (e.kind !== 'blocked' || e.tool !== tool) return [];
      return [typeof summary === 'string' ? summary : undefined];
    } catch {
      unread.push(at + 1);
      return [];
    }
  });
  return { refusals, unread, missing };
}

/** The lines of a log that do not parse: the first few, then how many more. */
function unparsed(unread: readonly number[]): string {
  const shown = unread.slice(0, 3).join(', ');
  if (unread.length === 1) return `line ${shown} of it does not parse`;
  const more = unread.length > 3 ? ` and ${String(unread.length - 3)} more` : '';
  return `lines ${shown}${more} of it do not parse`;
}

/**
 * Whether the session's PreCompact hook blocked a compaction, from its own log, by any blocked
 * event, with a summary or none: its context was full, so its item is too big for one session
 * (T061). Until T125's part (7) tells a subagent's compaction apart, a subagent's counts too.
 * Null when the log cannot tell: missing, since a start that passed always leaves one, unreadable,
 * or with a line that does not parse.
 */
function contextFull(home: string, id: string): boolean | null {
  const read = blocked(sessionEvents(home, id), 'PreCompact');
  // A start that passed leaves a log, empty or not: none means the hooks never ran, so unknown.
  if ('error' in read || read.missing) return null;
  if (read.refusals.length > 0) return true;
  return read.unread.length === 0 ? false : null;
}

/**
 * Why a session's start failed, from its own log (T061): the session-start hook's last refusal,
 * through `visible()`, or that it logged none, and where the log is.
 */
function startRefusal(home: string, id: string): string {
  const log = sessionEvents(home, id);
  const read = blocked(log, 'SessionStart');
  if ('error' in read) return `its log ${log} cannot be read: ${read.error}`;
  const { refusals, unread } = read;
  // A hook killed mid-write leaves a line that does not parse, which may be its refusal.
  const cut =
    unread.length === 0 ? '' : `; ${unparsed(unread)}, which may be a refusal cut off mid-write`;
  const refused = refusals.filter((summary) => summary !== undefined).at(-1);
  if (refused !== undefined)
    return `the session-start hook refused it: ${visible(refused)}; fix that before this item's next session (its log is ${log}${cut})`;
  // A refusal with no summary, such as a guard's internal error: it ran, and refused.
  return refusals.length > 0
    ? `the session-start hook refused it without a readable reason (its log is ${log}${cut}); find why before this item's next session`
    : `the session-start hook logged no refusal that can be read in ${log}${cut}, so it failed before it could or never ran; find why before this item's next session`;
}

/**
 * The checks made while the session runs, so one that did not start as launched is stopped at
 * once, not after it has run (T061): each line in order, the init check as soon as the init
 * message comes, and the passed record at the first assistant message, by when the SessionStart
 * hook has run, whatever order T125 shows, and before any tool call. `failure` is why it stopped.
 */
function liveCheck(
  id: string,
  role: RoleName,
  model: string,
  passed: () => boolean,
  refusal: () => string,
) {
  let assistant = false;
  const check: Read & {
    failure?: SessionFailed;
    line: (line: string) => string | undefined;
  } = {
    peak: 0,
    longest: 0,
    turns: 0,
    lines: 0,
    ids: new Set(),
    usage: new Map(),
    silence: 0,
    line: (text) => {
      check.longest = Math.max(check.longest, text.length);
      if (text.trim() === '') return undefined;
      try {
        const m = message(text);
        if (check.init === undefined) {
          if (!isInit(m, id)) return undefined;
          check.init = m;
          const { problems } = initCheck(m, role, model);
          if (problems.length > 0) throw mismatch(problems);
        } else if (m.type === 'assistant') {
          check.peak = Math.max(check.peak, context(m));
          const body = (m.message ?? {}) as Message;
          const key = typeof body.id === 'string' ? body.id : `line ${String(check.usage.size)}`;
          if (typeof body.usage === 'object' && body.usage !== null)
            check.usage.set(key, body.usage as Message);
          // stream-json sends a line per content block, each with its message's id.
          if (typeof m.parent_tool_use_id !== 'string') {
            check.lines += 1;
            const id = (m.message as Message | null)?.id;
            check.ids.add(typeof id === 'string' ? id : `line ${String(check.lines)}`);
            check.turns = check.ids.size;
          }
          if (!assistant && !passed())
            throw new SessionFailed(
              `its start check did not pass: it has no passed record by its first assistant message; ${refusal()}`,
              true,
            );
          assistant = true;
        } else if (m.type === 'result') {
          check.result = m;
          // Urgent, and checked here, so it holds whatever claude's exit status.
          if (m.session_id !== id)
            throw new SessionFailed(
              `claude reported session ${visible(JSON.stringify(m.session_id ?? null))}, not ${id} as launched`,
              true,
            );
        }
        return undefined;
      } catch (err) {
        check.failure = asFailed(err);
        return check.failure.message;
      }
    },
  };
  return check;
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
const STOPPED = 'no local session started: ';

function step<T>(what: string, run: () => T): T {
  try {
    return run();
  } catch (err) {
    // A refusal, an error that already says no session started, or a `SessionUnknown`, whose id
    // the unknown-session alert keeps, keeps its own words; any other text, git's included, is
    // named by its step and shown through visible().
    if (err instanceof LaunchRefused || err instanceof SessionUnknown) throw err;
    if (err instanceof EnvironmentError && err.message.startsWith(STOPPED)) throw err;
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
const NO_HOOKS = 'installs no factory hooks';
/** Only main's pin can wait for the guards: a branch that kept another release is filed again. */
const WAIT = '; local sessions wait for the guards (slice 28)';
/** Main's way out for each reason; a branch's is its own (`guardrailCheck`). */
const WAYS = {
  // An old pin: only a release that installs them helps.
  hooks: 're-pin main to a release that installs the factory hooks',
  // The release's own settings break the rule: installing it cannot help.
  repin: "re-pin main to a release whose settings register each hook as the installed factory's do",
  // The pin and the installed factory disagree on what is served.
  agree: "install the pinned release, or re-pin main to the installed factory's release",
} as const;
type Problem = { why: string; way: keyof typeof WAYS; wait?: true };
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
function hookProblem(settings: Buffer | undefined): Problem | undefined {
  const none: Problem = { why: NO_HOOKS, way: 'hooks', wait: true };
  const repin = (why: string): Problem => ({ why, way: 'repin' });
  const agree = (why: string): Problem => ({ why, way: 'agree' });
  let hooks: unknown;
  try {
    hooks = (JSON.parse(settings?.toString('utf8') ?? '') as { hooks?: unknown }).hooks;
  } catch {
    return none;
  }
  if (typeof hooks !== 'object' || hooks === null) return none;
  const byEvent = hooks as Record<string, unknown>;
  const missing = HOOK_EVENTS.find((event) => list(byEvent[event] ?? []).length === 0);
  if (missing !== undefined) return { why: `registers no ${missing} hook`, way: 'hooks' };
  const events = hookEvents();
  for (const [event, groups] of Object.entries(byEvent))
    for (const group of list(groups))
      for (const one of list((group as { hooks?: unknown } | null)?.hooks)) {
        const hook = (one ?? {}) as { type?: unknown; command?: unknown; args?: unknown };
        const args = list(hook.args);
        if (hook.type !== 'command' || hook.command !== 'factory' || args.length !== 2)
          return repin(`registers a ${event} hook that is not factory hook <name> in exec form`);
        if (args[0] !== 'hook' || typeof args[1] !== 'string')
          return repin(`registers a ${event} hook that is not factory hook <name> in exec form`);
        if (!SERVED_HOOKS.includes(args[1]))
          return agree(
            `registers the ${event} hook factory hook ${visible(args[1])}, which the installed factory does not serve`,
          );
        const served = events.get(args[1]) ?? new Set<string>();
        if (!served.has(event))
          return agree(
            `registers factory hook ${args[1]} under ${visible(event)}; the installed factory serves it under ${[...served].join(', ') || 'no event'}`,
          );
        if (GUARD_EVENTS.has(event) && (one as { onFailure?: unknown }).onFailure !== 'block')
          return repin(
            `registers the ${event} guard factory hook ${visible(args[1])} without onFailure: "block"`,
          );
      }
  return undefined;
}

/**
 * The protected files found (path → SHA-256) against the manifest, in both directions: every
 * manifest file present with its hash, and every hashed protected file listed. Then the hooks,
 * with the way out: main's for main, or, for a branch that `kept` from its merge base another
 * release than main's pin, to file the item again, since neither a pin nor an install changes
 * what the branch carries until main is merged into it.
 */
export function guardrailCheck(
  found: Readonly<Record<string, string>>,
  settings: Buffer | undefined,
  manifest: GuardrailManifest,
  where: string,
  kept = false,
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
  if (problem === undefined) return { ok: true };
  const way = kept
    ? `${where} keeps release ${manifest.release} from its merge base until main is merged into it: close the item and file it again`
    : WAYS[problem.way];
  const why = `${problem.why}${problem.wait === true && !kept ? WAIT : ''}`;
  return { ok: false, reason: `release ${manifest.release} ${why}; ${way}` };
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
  /** How long the shell check and `claude --version` may run, in ms; default 10 s. */
  checkTimeout?: number;
  /** A fresh session id for each launch; default a random UUID. */
  sessionId?: () => string;
  /** Where the session's temporary folder is made, kept short (T061); default `/tmp`. */
  tmpRoot?: string;
  /** `/proc`, or a folder a test sets up in its place. */
  proc?: string;
  /** A cap's minute, the watchdog's silence and the heartbeat, in ms; tests shorten them. */
  minute?: number;
  silence?: number;
  heartbeat?: number;
  /** The clone's install; tests give their own, so no row needs bwrap or pasta. */
  install?: Installer;
}

export class LocalLauncher implements LocalSessionLauncher {
  readonly mode = 'local';
  private running = false;
  private readonly options: LocalOptions;
  private readonly run: Runner;

  constructor(options: LocalOptions) {
    this.options = options;
    this.run = options.run ?? runProcess;
  }

  /** Where its sessions' folders are, and so the failure records that count them (T061). */
  get home(): string {
    return this.options.home;
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
  private manifest(project: string, main: string): GuardrailManifest | Unavailable {
    try {
      return this.options.release(this.config(project, main).factory_release);
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
    const { mainRef = 'origin/main' } = this.options;
    // What refuses every item, before any manifest is pushed (T061); the launch looks again last.
    try {
      this.stillRunning();
    } catch (err) {
      if (!(err instanceof LaunchRefused)) throw err;
      const kind = err.kind === undefined ? {} : { kind: err.kind };
      return { ok: false, reason: err.message, urgent: err.urgent, ...kind };
    }
    // Once, first: a fetch while it is checked cannot make it name a commit it did not check.
    let head: string;
    try {
      head = this.git(project, ['rev-parse', '--verify', `${mainRef}^{commit}`]);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `${mainRef} cannot be resolved: ${visible(why)}` };
    }
    const manifest = this.manifest(project, head);
    if ('ok' in manifest) return manifest;
    const main = step('reading main', () => this.treeFiles(project, head, 'main'));
    if ('ok' in main) return main;
    const guardrails = guardrailCheck(main.found, main.settings, manifest, 'main');
    // The pin's hooks fail the check: once per main head, with the reason's own way out (T061).
    if (!guardrails.ok && guardrails.urgent !== true)
      return { ok: false, reason: `main at ${head.slice(0, 12)}: ${guardrails.reason}` };
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
   * merge base change no protected path; the release pinned at the merge base, and its manifest.
   */
  private history(project: string, branch: string, heads: Heads) {
    const { env } = this.options;
    const base = step('the merge base with main', () =>
      mergeBase(project, heads.main, heads.head, env),
    );
    const changes = step(`the changes since ${base}`, () =>
      safeDiff(project, base, heads.head, env),
    );
    const problems = pathRule(changes, branch === DEFINE_BRANCH);
    // Only this item: it holds, and the pass goes on to the next (T061).
    if (problems.length > 0)
      throw new LaunchRefused(
        `no local session started: ${branch}'s own commits change ${problems.map(visible).join('; ')}; close this item and file it again`,
        true,
        undefined,
        true,
      );
    const pin = step(`the release pinned at ${base}`, () => this.config(project, base));
    try {
      return { manifest: this.options.release(pin.factory_release), pin: pin.factory_release };
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
  private clonePath(repo: string, branch: string, session: string) {
    const name = branch === 'main' ? 'main' : branch.slice('claude/'.length);
    const home = realpathSync(this.options.home);
    return join(home, 'factory-work', ...repo.split('/'), `${name}-${session}`);
  }

  private clone(project: string, dir: string, branch: string, heads: Heads) {
    const { home } = this.options;
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dirname(dir), { recursive: true });
    this.isolated(home, ['init', '-q', '-b', 'main', dir]);
    // The install's folder is never part of a commit; 28-6's push check is the backstop.
    mkdirSync(join(dir, '.git', 'info'), { recursive: true });
    appendFileSync(join(dir, '.git', 'info', 'exclude'), '/node_modules/\n');
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

  async launch(request: LaunchRequest): Promise<LaunchResult> {
    if (!launchable(request.branch))
      throw new LaunchRefused(
        `no local session started: ${request.branch} is not a session branch`,
      );
    if (request.feature !== expectedFeature(request))
      throw new LaunchRefused(
        `no local session started: ${JSON.stringify(request.feature)} is not the feature folder of ${request.role} on ${request.branch}`,
      );
    // A session at stations 1–6 is counted in its failure record before it can run (T061).
    if (request.station >= 1 && request.station <= 6 && request.starting === undefined)
      throw new LaunchRefused(
        `no local session started: the ${request.role} session at station ${String(request.station)} has no failure record to count it in, and a session the count cannot see never starts; it is the factory's own error, so reinstall the pinned release`,
      );
    if (this.running) throw new LaunchRefused('a local session is already running');
    this.running = true;
    let at: string | undefined;
    // Its folder, once made, says how it ended, so a later launch never reads a crash as ended.
    let folder: string | undefined;
    /** Its clone, made for this launch alone. */
    let clone: string | undefined;
    const ran = { spawned: false, started: false };
    try {
      step('looking for a session still running', () => {
        this.stillRunning();
      });
      const heads = step('fetching main and the branch into the factory’s own clone', () =>
        this.heads(request.project, request.branch),
      );
      at = heads.head;
      const { manifest, pin } = this.history(request.project, request.branch, heads);
      const { repo, inbox_issue, factory_release } = step("reading main's config", () =>
        this.config(request.project, heads.main),
      );
      // A branch made before main's pin moved keeps the release pinned at its merge base.
      const kept = pin.tag !== factory_release.tag || pin.sha !== factory_release.sha;
      const token = runsGh(factoryPolicy(), request.role)
        ? step("reading the project's gh token", () => this.ghToken(request.role, repo))
        : undefined;
      const files = step("making the session's folder", () => this.sessionFolder());
      folder = dirname(files.record);
      const cwd = step("making the session's clone", () => {
        clone = this.clonePath(repo, request.branch, files.id);
        return this.clone(request.project, clone, request.branch, heads);
      });
      // Claude Code loads these from every folder above where it runs, whatever the settings say.
      const memory = step('reading the folders above the clone', () =>
        memoryAbove(cwd, realpathSync(this.options.home)),
      );
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
        'ok' in tree
          ? tree
          : guardrailCheck(tree.found, tree.settings, manifest, request.branch, kept);
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
      const check = guardrailCheck(found, settings, manifest, request.branch, kept);
      // Hooks the installed factory refuses are this branch's: only it holds (T061). Main's own
      // pin is refused in `available()`, before any item.
      if (!check.ok)
        throw new LaunchRefused(
          `no local session started: ${check.reason}`,
          check.urgent,
          undefined,
          check.urgent !== true,
        );
      const roleFile = join(cwd, '.claude', 'agents', `${request.role}.md`);
      // What the branch's release lacks refuses only this item, with the way out its branch has.
      const lacks = (what: string) =>
        new LaunchRefused(
          `no local session started: ${what}; ${keptOut(request.branch)}`,
          false,
          undefined,
          true,
        );
      if (!existsSync(roleFile))
        throw lacks(`${request.branch} has no .claude/agents/${request.role}.md`);
      // One value, matched to the release with the role file, for --model and the record.
      const role = readFileSync(roleFile);
      const model = roleModel(role.toString('utf8'));
      if (model === undefined)
        throw lacks(
          `${request.branch}'s .claude/agents/${request.role}.md names no model a session may run`,
        );
      // git's identity in the clone's own config: the session's git reads no global config.
      step("setting git's identity in the session's clone", () => {
        this.isolated(cwd, ['config', 'user.name', `Factory ${request.role}`]);
        this.isolated(cwd, ['config', 'user.email', `${request.role}@factory.invalid`]);
      });
      const tmp = step("making the session's temporary folder", () => this.tmpFolder(request.item));
      try {
        const uninstalled = step("installing the clone's dependencies", () =>
          this.dependencies(request, cwd, tmp),
        );
        const env = step("building the session's environment", () =>
          this.sessionEnv(request, files.id, tmp, token),
        );
        // The session's own PATH: what Claude Code finds there is what the session runs.
        const folders = env.PATH.split(':').filter((folder) => folder !== '');
        for (const program of ['bwrap', 'socat'])
          if (located(program, folders) === undefined)
            throw new LaunchRefused(
              `no local session started: ${program}, which Claude Code's sandbox needs, is not on the session's PATH (${env.PATH}); install it`,
            );
        // An empty folder of the check's own, in the session's: a tool manager a startup file
        // activates, such as mise, asdf or nvm's auto-use, reads its configuration from where the
        // shell starts and the folders above it, every one the Owner's but /home and /.
        const empty = step("making the shell check's folder", () => {
          const folder = join(dirname(files.record), 'shell-check');
          mkdirSync(folder, { mode: 0o700 });
          return folder;
        });
        await this.shellNames(empty, env);
        await this.claudeVersion(cwd, env);
        this.nested(env);
        const proc = () => new ProcScan(this.options.proc);
        // Before the spawn: once claude runs, a failure here would stop it unrecorded.
        const boot = step("reading the kernel's boot id", () => proc().boot());
        step("writing the session's settings and record", () => {
          const tests = this.testFiles(cwd);
          this.writeSettings(request, files, { clone: cwd, tmp, tests, folders });
          const record = {
            ...{ role: request.role, item: request.item, station: request.station },
            ...{ feature: request.feature, files: request.files, clone: cwd, model },
            project: realpathSync(request.project),
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
        const live = liveCheck(
          files.id,
          request.role,
          model,
          () => {
            try {
              return hasPassed(this.options.home, files.id);
            } catch (err) {
              const why = err instanceof Error ? err.message : String(err);
              throw new SessionFailed(`its passed record could not be read: ${visible(why)}`, true);
            }
          },
          () => startRefusal(this.options.home, files.id),
        );
        // In a process group of its own, so stopping it stops what it started; its leader is kept,
        // so a later launch sees one the factory could not stop, such as after a SIGKILL.
        const group = join(dirname(files.record), 'group.json');
        // The installed factory's caps, never the clone's (T061).
        const { caps } = factoryPolicy().roles[request.role];
        const silence = this.options.silence ?? SILENCE;
        const began = Date.now();
        let heard = began;
        // From the spawn to the return, every failure is a session that ran on the Owner's plan.
        const session = async (): Promise<LaunchResult> => {
          let result: Awaited<ReturnType<Runner>>;
          // Its id in its failure record first: a session the count cannot see never starts.
          try {
            request.starting?.(files.id, heads.head);
          } catch (err) {
            const why = err instanceof Error ? err.message : String(err);
            throw new LaunchRefused(
              `no local session started: ${visible(why)}`,
              false,
              undefined,
              true,
            );
          }
          try {
            const prompt =
              uninstalled === undefined ? request.prompt : `${request.prompt}\n\n${uninstalled}`;
            const invocation = localInvocation({ ...request, prompt }, files, model, caps.turns);
            result = await this.run('claude', invocation, {
              ...{ cwd, env, group: true, line: live.line, contain: CONTAIN },
              chunk: () => {
                live.silence = Math.max(live.silence, Date.now() - heard);
                heard = Date.now();
              },
              ...{ timeout: caps.minutes * (this.options.minute ?? 60_000), silence },
              started: (pgid) => {
                ran.spawned = true;
                ran.started = true;
                writeWhole(group, `${JSON.stringify(groupRecord(pgid, boot, proc()))}\n`);
              },
            });
          } catch (err) {
            if (ran.spawned) throw err;
            const why = err instanceof Error ? err.message : String(err);
            throw new EnvironmentError(`no local session started: claude: ${visible(why)}`);
          }
          ran.spawned = true;
          if (live.failure !== undefined) throw live.failure;
          // A cap: the group is stopped, nothing is pushed, and one info alert names it.
          if (result.timedOut === true)
            throw new SessionCapped(
              `it ran past its wall-clock cap of ${String(caps.minutes)} minutes`,
            );
          if (result.silent === true)
            throw new SessionCapped(
              `its stream was silent for ${String(silence / 60_000)} minutes`,
            );
          if (live.result?.subtype === 'error_max_turns')
            throw new SessionCapped(`it reached its turn cap of ${String(caps.turns)} turns`);
          if (result.status !== 0) {
            const ended = result.signal
              ? `was ended by ${result.signal}`
              : `exited ${String(result.status)}`;
            const after =
              live.result === undefined
                ? ''
                : ` after its result ${visible(JSON.stringify(live.result.subtype ?? null))}`;
            throw streamFailed(`claude ${ended}${after}: ${visible(result.stderr.trim())}`);
          }
          const { init, result: last } = readStream(result.stdout, files.id);
          if (live.init === undefined)
            throw streamFailed('its init message was not read while it ran');
          if (last.subtype !== 'success' || last.is_error !== false)
            throw streamFailed(
              `its result is ${visible(JSON.stringify(last.subtype ?? null))}${last.is_error === false ? '' : ', an error'}, not a success`,
            );
          // Checked live above, and again on the whole stream.
          const { problems, missing } = initCheck(init, request.role, model);
          if (problems.length > 0) throw mismatch(problems);
          const notices: Notice[] = [];
          if (missing.length > 0)
            notices.push({
              kind: 'session-tools',
              text: `a ${request.role} session ran without ${missing.join(', ')}, which its role has; set the expected tools from T125's part (7)`,
            });
          // No role in the text, so the inbox gets one alert per version.
          const version = init.claude_code_version;
          if (version !== CLAUDE_CODE_VERSION)
            notices.push({
              kind: 'claude-version',
              text: `Claude Code ${visible(String(version))} ran a session; the release was checked against ${CLAUDE_CODE_VERSION}, so re-run T125's A8`,
            });
          return { sessionId: files.id, ...(notices.length > 0 ? { notices } : {}) };
        };
        let outcome: LaunchResult | undefined;
        let failure: SessionFailed | undefined;
        const beat = setInterval(() => {
          request.heartbeat?.({ elapsed: Date.now() - began, turns: live.turns });
        }, this.options.heartbeat ?? HEARTBEAT);
        try {
          outcome = await session();
        } catch (err) {
          if (!ran.spawned) throw err;
          failure = asFailed(err);
        } finally {
          clearInterval(beat);
        }
        // Ended only once nothing of its group remains, by the check a later launch makes; not
        // written, the folder reads by its group in /proc, or as unknown, never as ended.
        try {
          // A runner that never reported a group, as the tests' fake one, has returned: ended.
          const gone = () =>
            !ran.started ||
            (existsSync(group) && groupRunning(group, files.id, proc()) === undefined);
          if (await until(gone)) writeWhole(join(folder, 'ended'), '');
        } catch {
          // Its group cannot be read now: a later launch reads it, and stops if it still cannot.
        }
        // A blocked compaction: the item is too big for one session, which no retry changes.
        live.full = contextFull(this.options.home, files.id);
        if (failure !== undefined && live.full) {
          failure.message += `; its PreCompact hook blocked a compaction, so its context was full: the item is too big for one session; split it`;
          failure.contextFull = true;
        }
        // What it reported, kept for every session that spawned, a failed one too.
        try {
          const ended = Date.now();
          live.silence = Math.max(live.silence, ended - heard);
          const text = JSON.stringify(reported(live, ended - began), null, 2);
          writeFileSync(join(dirname(files.record), 'result.json'), `${text}\n`, WRITE_ONCE);
        } catch (err) {
          const why = `its result.json could not be written: ${visible(err instanceof Error ? err.message : String(err))}`;
          // Added to the failure, which keeps its kind, its urgency and its full context.
          if (failure === undefined) failure = streamFailed(why);
          else failure.message += `; ${why}`;
        }
        if (outcome === undefined) throw failure ?? streamFailed('it ended with no outcome');
        if (failure !== undefined) throw failure;
        return outcome;
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    } catch (err) {
      // A refusal that repeats on every pass alerts once per branch head (T061).
      if (err instanceof LaunchRefused && at !== undefined) err.head ??= at;
      if (folder !== undefined && !ran.spawned)
        try {
          writeWhole(join(folder, 'not-spawned'), '');
        } catch {
          // Unwritten, the folder reads as unknown, which stops the next pass naming it.
        }
      // Nothing spawned, so nothing needs the clone, and a held item retried every pass would
      // leave one each time; its session folder and marker stay (T061). A removal that fails is
      // named in the refusal, never hiding it.
      if (clone !== undefined && !ran.spawned)
        try {
          rmSync(clone, { recursive: true, force: true });
        } catch (thrown) {
          const why = visible(thrown instanceof Error ? thrown.message : String(thrown));
          if (err instanceof Error)
            err.message += `; its clone ${clone} could not be removed: ${why}`;
        }
      throw err;
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
    for (const name of SHELL_WORDS) names.add(name);
    // An end line no startup file can know, so one that exits or starts another shell is seen.
    const end = `factory-shell-check-${randomUUID()}`;
    for (const mode of ['-lc', '-ic']) {
      const command = `compgen -A function -A alias; echo ${end}`;
      const result = await this.checked(`bash ${mode}`, 'bash', [mode, command], cwd, env);
      const lines = result.stdout.split('\n').map((line) => line.trim());
      if (!lines.includes(end))
        throw new EnvironmentError(
          `no local session started: bash ${mode} printed no end line, so its startup files may exit or start another shell first; the check cannot read its functions and aliases`,
        );
      if (result.status !== 0)
        throw new EnvironmentError(
          `no local session started: bash ${mode} exited ${String(result.status)}: ${visible(result.stderr.trim())}`,
        );
      const clash = lines.slice(0, lines.indexOf(end)).filter((name) => names.has(name));
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
    const result = await this.checked('claude --version', 'claude', ['--version'], cwd, env);
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

  /**
   * A check before launch, run with stdin from /dev/null and a short timeout that kills it: one
   * that cannot start or does not finish is an error, never a pass.
   */
  private async checked(
    what: string,
    program: string,
    args: readonly string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
  ) {
    const timeout = this.options.checkTimeout ?? CHECK_TIMEOUT;
    let result: Awaited<ReturnType<Runner>>;
    try {
      result = await this.run(program, args, { cwd, env, timeout });
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      throw new EnvironmentError(`no local session started: ${what}: ${visible(why)}`);
    }
    if (result.timedOut === true)
      throw new EnvironmentError(
        `no local session started: ${what} did not finish within ${String(timeout / 1000)} s`,
      );
    return result;
  }

  /**
   * A session an earlier factory started and could not stop, such as one SIGKILLed, or one another
   * factory runs now, refuses the launch with an urgent alert. It is never stopped here: the Owner
   * is told how (T061).
   */
  private stillRunning() {
    const sessions = join(this.options.home, '.factory', 'sessions');
    let entries;
    try {
      entries = readdirSync(sessions, { withFileTypes: true });
    } catch (err) {
      if (errno(err) === 'ENOENT') return;
      throw err;
    }
    // Anything else, a symlink to a live session's folder included, could hide a running group.
    const odd = entries.find((entry) => !entry.isDirectory());
    if (odd !== undefined)
      throw new EnvironmentError(
        `no local session started: ${join(sessions, visible(odd.name))} is not a session's folder; remove it, then run the factory again`,
      );
    // One scan of /proc for every folder (deferred (1)).
    const scan = new ProcScan(this.options.proc);
    for (const id of entries.map((entry) => entry.name)) {
      const running = sessionRunning(this.options.home, id, scan);
      if (running !== undefined) throw new LaunchRefused(running, true, 'session-running');
    }
  }

  /**
   * Claude's bubblewrap with Claude Code's own nested inside it, as every Bash command starts, run
   * before every spawn (T061): if it fails, no session starts, so none runs uncontained or without
   * its sandbox.
   */
  private nested(env: NodeJS.ProcessEnv) {
    const argv = [...CONTAIN, 'bwrap', ...NESTED];
    const probe = spawnSync('bwrap', argv, {
      ...{ env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      ...{ timeout: PROBE, killSignal: 'SIGKILL' },
    });
    if (probe.error === undefined && probe.status === 0) return;
    const why =
      probe.error?.message ??
      (probe.signal === null ? probe.stderr.trim() : `ended by ${probe.signal}`);
    throw new LaunchRefused(
      `no local session started: claude runs in a bubblewrap of the factory's, with Claude Code's own sandbox nested inside it, and that failed: ${visible(why)}; check that bwrap ${argv.join(' ')} runs on this machine`,
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

  /**
   * For T125's short run alone (Owner decision 2026-11-05): a session's folder, temporary folder,
   * environment, settings and MCP files and `claude` arguments, by the same steps `launch()`
   * takes, for a role in `clone`. It writes no record, gives no gh token and starts nothing; when
   * it throws, it leaves neither folder it made.
   */
  sessionShape(request: LaunchRequest, clone: string, model: string) {
    const files = this.sessionFolder();
    let tmp: string | undefined;
    try {
      tmp = this.tmpFolder(request.item);
      const env = this.sessionEnv(request, files.id, tmp);
      const folders = env.PATH.split(':').filter((folder) => folder !== '');
      this.writeSettings(request, files, { clone, tmp, tests: this.testFiles(clone), folders });
      const { caps } = factoryPolicy().roles[request.role];
      const argv = localInvocation(request, files, model, caps.turns);
      return { files, tmp, env, argv, contain: CONTAIN };
    } catch (err) {
      if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true });
      rmSync(dirname(files.record), { recursive: true, force: true });
      throw err;
    }
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
      // The factory's own, never the Owner's: the watchdog's silence is set above it.
      BASH_MAX_TIMEOUT_MS: String(BASH_MAX_TIMEOUT),
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
      // No script runs and npx installs nothing; the command guard refuses the flags that beat these.
      ...{ npm_config_yes: 'false', npm_config_ignore_scripts: 'true' },
    };
  }

  /**
   * The clone's dependencies, for Define, the Builder and Test when it has a package-lock.json;
   * for the Builder or Define after a failed install, who start anyway, the prompt's line (T061).
   * Test holds: its head passed CI's npm ci, so a failed npm is most likely the registry's or the
   * network's, and a clone npm must not run on needs a new item. A sandbox that could not start ran
   * no npm: a refusal that ends the pass. A timeout is an error.
   */
  private dependencies(request: LaunchRequest, clone: string, tmp: string): string | undefined {
    if (!installs(request.role, clone)) return undefined;
    const { env } = this.options;
    const git = located('git', (env.PATH ?? '').split(':').filter(Boolean));
    if (git === undefined)
      throw new LaunchRefused("no local session started: no git on the factory's PATH for npm ci");
    let failed: ReturnType<typeof installDependencies>;
    try {
      failed = installDependencies(clone, tmp, git.real, env, this.options.install);
    } catch (err) {
      if (!(err instanceof RefusedError) || err instanceof LaunchRefused) throw err;
      throw new LaunchRefused(`no local session started: ${visible(err.message)}`);
    }
    if (failed === undefined) return undefined;
    if (request.role !== 'test') return failed.npm ? UNINSTALLED : refusedLine(failed.why);
    const once = 'tried again each pass and alerted once per head';
    throw new LaunchRefused(
      failed.npm
        ? `no local session started: the test session's npm ci failed (${failed.why}); the head passed CI's npm ci, so most likely the registry or the network is down: the item holds until they are back, ${once}`
        : `no local session started: the test session's npm ci never ran: ${visible(failed.why)}; nothing at Test makes a new head, so close the item and file it again; it holds, ${once}`,
      false,
      undefined,
      true,
    );
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
   * The folders of every program on the role's shell list that the sandbox would not read, to
   * open read-only, such as Security's semgrep under `~/.local`, through the sandbox's own check
   * that no opened folder overlaps a denied one; a program not on the
   * session's PATH refuses the launch by name, since the session could not run it (T061).
   */
  private programFolders(role: RoleName, folders: readonly string[], opened: readonly string[]) {
    const home = realpathSync(this.options.home);
    const programs = new Set(factoryPolicy().roles[role].shell.map((p) => p.split(' ')[0] ?? ''));
    const out: string[] = [];
    for (const program of programs) {
      const found = located(program, folders);
      if (found === undefined)
        throw new LaunchRefused(
          `no local session started: ${program}, on the ${role} role's shell list, is not on the session's PATH (${folders.join(':')}); install it`,
        );
      // A virtual environment's root, which its bin needs, and the PATH folder of a link to it,
      // such as pipx's ~/.local/bin/semgrep, which the shell reads first.
      const bin = dirname(found.real);
      const venv = existsSync(join(dirname(bin), 'pyvenv.cfg')) ? dirname(bin) : bin;
      for (const folder of new Set([dirname(found.at), venv])) {
        const denied = [home, ...UNREAD].some((root) => under(folder, root));
        if (denied && ![...opened, ...out].some((open) => under(folder, open))) out.push(folder);
      }
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
    const mcp = namedMcp(request.role);
    // The roles whose shell runs npm read node's own folder, which may lie under home.
    const npm = policy.roles[request.role].shell.some((prefix) => /^(npm|npx)\b/.test(prefix));
    const node = dirname(dirname(realpathSync(process.execPath)));
    const home = realpathSync(this.options.home);
    const opened = npm ? [node] : [];
    const tools = [...opened, ...this.programFolders(request.role, at.folders, opened)];
    const paths = { home, clone: at.clone, tmp: at.tmp, tools };
    const { role, feature, files: task } = request;
    const input = { role, paths, feature, files: task, tests: at.tests, factory, mcp };
    // The Bash cap in the settings' env as well as the session's, so either alone still sets it.
    const env = { BASH_MAX_TIMEOUT_MS: String(BASH_MAX_TIMEOUT) };
    const settings = { ...renderSessionSettings(policy, input), env };
    writeFileSync(files.settings, `${JSON.stringify(settings, null, 2)}\n`, WRITE_ONCE);
    writeFileSync(files.mcp, MCP_JSON, WRITE_ONCE);
  }
}
