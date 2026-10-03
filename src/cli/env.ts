// Exit codes, typed CLI errors, and the environment checks of contracts/cli.md.
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

export const ExitCode = {
  Ok: 0,
  /** Gate, signature or consent refused — also any unexpected failure (fail closed). */
  Refused: 1,
  Usage: 2,
  /** Missing `gh`, `ssh-keygen`, network. */
  Environment: 3,
} as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

export class CliError extends Error {
  readonly code: ExitCode;

  constructor(code: ExitCode, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class RefusedError extends CliError {
  constructor(message: string) {
    super(ExitCode.Refused, message);
  }
}

export class UsageError extends CliError {
  constructor(message: string) {
    super(ExitCode.Usage, message);
  }
}

export class EnvironmentError extends CliError {
  constructor(message: string) {
    super(ExitCode.Environment, message);
  }
}

export type Tool = 'gh' | 'git' | 'ssh-keygen';

/**
 * Cloud session marker. Phase 0 probe T125 confirms the variable name (research R5/R8); any
 * value, even an empty one, counts as set.
 */
export const CLOUD_MARKER = 'CLAUDE_CODE_REMOTE';

/**
 * Refuse an Owner-only command off the laptop: inside a cloud session, or without a terminal
 * on stdin (agents run commands without one, and the passphrase prompt needs it).
 */
export function assertLaptop(command: string, env: NodeJS.ProcessEnv, stdinIsTTY: boolean): void {
  const refuse = (why: string) =>
    new RefusedError(`factory ${command} runs only on the Owner's laptop: ${why}`);
  if (env[CLOUD_MARKER] !== undefined) throw refuse(`${CLOUD_MARKER} is set (cloud session)`);
  if (!stdinIsTTY) throw refuse('stdin is not a terminal');
}

/** Absolute path of an executable on PATH, or undefined. */
export function findOnPath(tool: string, pathVar: string | undefined): string | undefined {
  for (const dir of (pathVar ?? '').split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, tool);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return undefined;
}

export function assertTools(tools: readonly Tool[], env: NodeJS.ProcessEnv): void {
  for (const tool of tools) {
    if (findOnPath(tool, env.PATH) === undefined) {
      throw new EnvironmentError(`\`${tool}\` not found on PATH; install it and try again`);
    }
  }
}
