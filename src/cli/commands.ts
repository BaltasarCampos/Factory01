// Sub-command table and dispatch for the `factory` CLI (contracts/cli.md).
import { createInterface } from 'node:readline/promises';
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { adopt } from '../commands/adopt.js';
import { approve } from '../commands/approve.js';
import { ci } from '../commands/ci.js';
import { dispatch } from '../commands/dispatch.js';
import { hook } from '../commands/hook.js';
import { inbox } from '../commands/inbox.js';
import { keygen } from '../commands/keygen.js';
import { mcp } from '../commands/mcp.js';
import { newProject } from '../commands/new.js';
import { pause } from '../commands/pause.js';
import { release } from '../commands/release.js';
import { resume } from '../commands/resume.js';
import { run } from '../commands/run.js';
import type { Launchers } from '../dispatcher/launcher/types.js';
import { alertLines } from '../notify/inbox.js';
import type { Alert } from '../model/types.js';
import {
  assertLaptop,
  assertTools,
  CliError,
  ExitCode,
  RefusedError,
  UsageError,
  type Tool,
} from './env.js';

export interface Output {
  write(chunk: string): void;
}

export type OptionValues = Record<string, string | boolean | (string | boolean)[] | undefined>;

export interface CommandContext {
  name: string;
  positionals: string[];
  options: OptionValues;
  io: { stdout: Output; stderr: Output };
  env: NodeJS.ProcessEnv;
  stdinIsTTY: boolean;
  /** The directory the command runs in (the project clone, if any). */
  cwd: string;
  /** All of stdin (hook input JSON). */
  readStdin: () => Promise<string>;
  /** The laptop's clock. */
  now: () => Date;
  /** Ask the Owner a question on the terminal; resolves to the typed line. */
  ask: (question: string) => Promise<string>;
  /** Session launchers by `agents:` mode. */
  launchers: Launchers;
}

export interface CommandSpec {
  summary: string;
  usage: string;
  /** Owner-only: refused in cloud sessions and without a terminal. */
  laptopOnly: boolean;
  /** External tools checked before running (exit 3 when missing). */
  requires: readonly Tool[];
  options: ParseArgsOptionsConfig;
  positionals: { min: number; max: number };
  /**
   * Print unread Owner-inbox alerts first (default true). Off for `hook`, `mcp` and `ci`,
   * whose stdout is a protocol read by Claude Code or CI, not by the Owner.
   */
  showsAlerts?: boolean;
  /** Absent until the command's delivery slice lands. */
  run?: (ctx: CommandContext) => Promise<number>;
}

export interface CliDeps {
  stdout: Output;
  stderr: Output;
  env: NodeJS.ProcessEnv;
  stdinIsTTY: boolean;
  /** Default: process.cwd(). */
  cwd?: string;
  /** Default: read process.stdin to the end. */
  readStdin?: () => Promise<string>;
  /** Default: the system clock. */
  now?: () => Date;
  /** Default: a prompt on the process's terminal. */
  ask?: (question: string) => Promise<string>;
  /** Default: none; `dispatch` and `run` then use the local and cloud launchers (T061). */
  launchers?: Launchers;
  /** Unread Owner-inbox alerts (src/notify/inbox.ts `projectUnreadAlerts` in main.ts). */
  unreadAlerts: () => Promise<readonly Alert[]>;
  /** Override the command table (tests). */
  commands?: Readonly<Record<string, CommandSpec>>;
}

const OWNER: readonly Tool[] = ['gh', 'git', 'ssh-keygen'];
const ANY = Number.POSITIVE_INFINITY;

export const COMMANDS: Readonly<Record<string, CommandSpec>> = {
  new: {
    summary: 'Create a private project repo from a pitch and run Define',
    usage: 'factory new "<pitch>" [--name <repo>]',
    laptopOnly: false,
    requires: OWNER,
    options: { name: { type: 'string' } },
    positionals: { min: 1, max: 1 },
    run: newProject,
  },
  adopt: {
    summary: 'Attach the factory to an existing private repo',
    usage: 'factory adopt <owner/repo>',
    laptopOnly: false,
    requires: OWNER,
    options: {},
    positionals: { min: 1, max: 1 },
    run: adopt,
  },
  run: {
    summary: 'Run the dispatcher loop until an Owner gate, limit, cap or pause',
    usage: 'factory run [--once]',
    laptopOnly: false,
    requires: ['gh', 'git'],
    options: { once: { type: 'boolean' } },
    positionals: { min: 0, max: 0 },
    run,
  },
  dispatch: {
    summary: 'One dispatcher pass',
    usage: 'factory dispatch [--attack-suite]',
    laptopOnly: false,
    requires: ['gh', 'git'],
    options: { 'attack-suite': { type: 'boolean' } },
    positionals: { min: 0, max: 0 },
    run: dispatch,
  },
  approve: {
    summary: 'Sign an approval record and apply its owner: label',
    usage: 'factory approve <issue|pr> [spec|waiver <waives>] [--tier <1|2|3>]',
    laptopOnly: true,
    requires: ['gh', 'ssh-keygen', 'git'],
    options: { tier: { type: 'string' } },
    positionals: { min: 1, max: 3 },
    run: approve,
  },
  merge: {
    summary: 'Check a pull request on the laptop and merge it with a signed commit',
    usage: 'factory merge <pr>',
    laptopOnly: true,
    requires: OWNER,
    options: {},
    positionals: { min: 1, max: 1 },
  },
  deploy: {
    summary: 'Sign a deployed record, then pull, build and restart main',
    usage: 'factory deploy',
    laptopOnly: true,
    requires: OWNER,
    options: {},
    positionals: { min: 0, max: 0 },
  },
  pause: {
    summary: 'Pause the line or one station',
    usage: 'factory pause [station]',
    laptopOnly: false,
    requires: ['gh'],
    options: {},
    positionals: { min: 0, max: 1 },
    run: pause,
  },
  resume: {
    summary: 'Sign a resume record and lift a pause',
    usage: 'factory resume [station]',
    laptopOnly: true,
    requires: ['gh', 'ssh-keygen'],
    options: {},
    positionals: { min: 0, max: 1 },
    run: resume,
  },
  upgrade: {
    summary: 'Open a pull request moving the project to a signed factory release',
    usage: 'factory upgrade <tag>',
    laptopOnly: false,
    requires: OWNER,
    options: {},
    positionals: { min: 1, max: 1 },
  },
  inbox: {
    summary: 'List Owner-inbox alerts and mark them read',
    usage: 'factory inbox [--all]',
    laptopOnly: false,
    requires: ['gh'],
    options: { all: { type: 'boolean' } },
    positionals: { min: 0, max: 0 },
    // It prints the alerts itself, then marks them read.
    showsAlerts: false,
    run: inbox,
  },
  mcp: {
    summary: 'Factory MCP server over stdio (sessions)',
    usage: 'factory mcp',
    laptopOnly: false,
    requires: [],
    options: {},
    positionals: { min: 0, max: 0 },
    showsAlerts: false,
    run: mcp,
  },
  hook: {
    summary: 'Claude Code hook entry point (sessions)',
    usage: 'factory hook <event>',
    laptopOnly: false,
    requires: [],
    options: {},
    positionals: { min: 1, max: 1 },
    showsAlerts: false,
    run: hook,
  },
  ci: {
    summary: 'CI checks built from the pinned release (GitHub Actions)',
    usage:
      'factory ci <check> [args...] [--branch <name>] [--push] [--tier <1|2|3>] [--install <dir>]',
    laptopOnly: false,
    requires: ['git'],
    options: {
      branch: { type: 'string' },
      push: { type: 'boolean' },
      tier: { type: 'string' },
      install: { type: 'string' },
    },
    positionals: { min: 1, max: ANY },
    showsAlerts: false,
    run: ci,
  },
  keygen: {
    summary: 'Create or rotate the Owner signing key',
    usage: 'factory keygen [--rotate [--finish]]',
    laptopOnly: true,
    requires: ['ssh-keygen', 'git'],
    options: { rotate: { type: 'boolean' }, finish: { type: 'boolean' } },
    positionals: { min: 0, max: 0 },
    run: keygen,
  },
  config: {
    summary: 'Change one .factory/config field as a signed commit on main',
    usage: 'factory config set <key> <value>',
    laptopOnly: true,
    requires: ['git', 'ssh-keygen'],
    options: {},
    positionals: { min: 3, max: 3 },
  },
  release: {
    summary: 'Build the guardrail manifest and sign a factory release tag',
    usage: 'factory release <tag>',
    laptopOnly: true,
    requires: ['git', 'ssh-keygen'],
    options: {},
    positionals: { min: 1, max: 1 },
    run: release,
  },
  benchmark: {
    summary: 'Create the benchmark repo or add a merged item to it',
    usage: 'factory benchmark init | factory benchmark add <issue>',
    laptopOnly: true,
    requires: OWNER,
    options: {},
    positionals: { min: 1, max: 2 },
  },
};

function usageText(commands: Readonly<Record<string, CommandSpec>>): string {
  const width = Math.max(...Object.values(commands).map((c) => c.usage.length));
  const lines = Object.values(commands).map((c) => `  ${c.usage.padEnd(width)}  ${c.summary}`);
  return `Usage: factory <command> [args]\n\nCommands:\n${lines.join('\n')}\n`;
}

function alertText(alerts: readonly Alert[]): string {
  const noun = alerts.length === 1 ? 'alert' : 'alerts';
  return `Owner inbox: ${String(alerts.length)} unread ${noun}\n${alertLines(alerts)}Run \`factory inbox\` to mark them read.\n\n`;
}

async function readProcessStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function askTerminal(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/** Run one `factory` invocation; returns the exit code. Never throws. */
export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  const commands = deps.commands ?? COMMANDS;
  const [name, ...rest] = argv;

  if (name === '--help' || name === '-h') {
    deps.stdout.write(usageText(commands));
    return ExitCode.Ok;
  }
  const spec = name === undefined ? undefined : commands[name];
  if (name === undefined || spec === undefined) {
    const why = name === undefined ? 'no command given' : `unknown command: ${name}`;
    deps.stderr.write(`factory: ${why}\n\n${usageText(commands)}`);
    return ExitCode.Usage;
  }

  try {
    let parsed: { values: OptionValues; positionals: string[] };
    try {
      parsed = parseArgs({
        args: rest,
        options: { ...spec.options, help: { type: 'boolean', short: 'h' } },
        allowPositionals: true,
        strict: true,
      });
    } catch (err) {
      throw new UsageError(err instanceof Error ? err.message : String(err));
    }
    if (parsed.values.help === true) {
      deps.stdout.write(`Usage: ${spec.usage}\n\n${spec.summary}\n`);
      return ExitCode.Ok;
    }
    const count = parsed.positionals.length;
    if (count < spec.positionals.min) throw new UsageError('missing argument');
    if (count > spec.positionals.max)
      throw new UsageError(
        `unexpected argument: ${parsed.positionals[spec.positionals.max] ?? ''}`,
      );

    if (spec.showsAlerts !== false) {
      try {
        const alerts = await deps.unreadAlerts();
        if (alerts.length > 0) deps.stdout.write(alertText(alerts));
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        deps.stderr.write(`warning: could not read the Owner inbox: ${why}\n`);
      }
    }

    if (spec.laptopOnly) assertLaptop(name, deps.env, deps.stdinIsTTY);
    assertTools(spec.requires, deps.env);
    if (!spec.run) throw new RefusedError(`factory ${name} is not implemented in this build yet`);

    return await spec.run({
      name,
      positionals: parsed.positionals,
      options: parsed.values,
      io: { stdout: deps.stdout, stderr: deps.stderr },
      env: deps.env,
      stdinIsTTY: deps.stdinIsTTY,
      cwd: deps.cwd ?? process.cwd(),
      readStdin: deps.readStdin ?? readProcessStdin,
      now: deps.now ?? (() => new Date()),
      ask: deps.ask ?? askTerminal,
      launchers: deps.launchers ?? {},
    });
  } catch (err) {
    if (err instanceof UsageError) {
      deps.stderr.write(`factory ${name}: ${err.message}\nUsage: ${spec.usage}\n`);
      return err.code;
    }
    if (err instanceof CliError) {
      deps.stderr.write(`${err.message}\n`);
      return err.code;
    }
    const why = err instanceof Error ? err.message : String(err);
    deps.stderr.write(`factory ${name}: unexpected error: ${why}\n`);
    return ExitCode.Refused;
  }
}
