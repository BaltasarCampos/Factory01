// The one way the factory talks to GitHub (research R3): the `gh` CLI, run without a shell, so
// no token ever enters the factory's code. JSON output is parsed and then read through `Fields`,
// which refuses any value of the wrong shape rather than guessing.
import { execFile, type ExecFileException } from 'node:child_process';
import { EnvironmentError } from '../cli/env.js';

export class GhError extends Error {
  readonly args: readonly string[];
  /** gh's exit code; null when gh never exited normally or the output was unusable. */
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(
    message: string,
    args: readonly string[] = [],
    exitCode: number | null = null,
    stderr = '',
  ) {
    super(message);
    this.name = 'GhError';
    this.args = args;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export interface GhOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Written to gh's stdin (bodies go through `--body-file -`, never argv). */
  input?: string;
}

/** Timelines of long-lived issues (the Owner inbox) outgrow execFile's 1 MB default. */
const MAX_BUFFER = 64 * 1024 * 1024;

export function gh(args: readonly string[], options: GhOptions & { json: true }): Promise<unknown>;
export function gh(
  args: readonly string[],
  options?: GhOptions & { json?: false },
): Promise<string>;
export function gh(
  args: readonly string[],
  options: GhOptions & { json?: boolean } = {},
): Promise<unknown> {
  const env = { ...(options.env ?? process.env), GH_PROMPT_DISABLED: '1' };
  return new Promise((resolve, reject) => {
    const child = execFile(
      'gh',
      args,
      { env, cwd: options.cwd, maxBuffer: MAX_BUFFER, encoding: 'utf8' },
      (err: ExecFileException | null, stdout: string, stderr: string) => {
        if (err?.code === 'ENOENT') {
          reject(new EnvironmentError('`gh` not found on PATH; install it and try again'));
        } else if (err) {
          const code = typeof err.code === 'number' ? err.code : null;
          const why = stderr.trim() === '' ? err.message : stderr.trim();
          reject(new GhError(`gh ${args.join(' ')} failed: ${why}`, args, code, stderr));
        } else if (options.json === true) {
          try {
            resolve(parseJsonStream(stdout));
          } catch (parseErr) {
            const why = parseErr instanceof Error ? parseErr.message : String(parseErr);
            reject(new GhError(`gh ${args.join(' ')}: ${why}`, args, 0, stderr));
          }
        } else {
          resolve(stdout);
        }
      },
    );
    // gh may exit before reading stdin (EPIPE); its exit code already reports the failure.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(options.input ?? '');
  });
}

/**
 * Parse gh's JSON output. `gh api --paginate` prints each page's array back to back
 * (`[…][…]`); those are merged into one array. Several values that are not all arrays, or
 * truncated output, are refused.
 */
export function parseJsonStream(text: string): unknown {
  const values: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      if (depth === 0) throw new GhError('unexpected JSON output: a bare string');
    } else if (ch === '[' || ch === '{') {
      if (depth++ === 0) start = i;
    } else if (ch === ']' || ch === '}') {
      if (--depth < 0) throw new GhError('unexpected JSON output: unbalanced brackets');
      if (depth === 0) values.push(parseOne(text.slice(start, i + 1)));
    } else if (depth === 0 && ch !== undefined && !/\s/.test(ch)) {
      throw new GhError('unexpected JSON output: not an array or object');
    }
  }
  if (depth !== 0 || inString) throw new GhError('unexpected JSON output: truncated');
  if (values.length === 1) return values[0];
  if (values.length === 0) throw new GhError('unexpected JSON output: empty');
  if (!values.every(Array.isArray)) throw new GhError('unexpected JSON output: several values');
  return (values as unknown[][]).flat();
}

function parseOne(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new GhError(`unexpected JSON output: ${err instanceof Error ? err.message : ''}`);
  }
}

/** Typed reads from one JSON object; any missing or mistyped field is a GhError. */
export class Fields {
  private constructor(
    private readonly obj: Record<string, unknown>,
    private readonly what: string,
  ) {}

  static of(value: unknown, what: string): Fields {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new GhError(`unexpected gh output: ${what} is not an object`);
    }
    return new Fields(value as Record<string, unknown>, what);
  }

  private get<T>(key: string, type: string, ok: (v: unknown) => v is T): T {
    const value = this.obj[key];
    if (!ok(value)) throw new GhError(`unexpected gh output: ${this.what}.${key} is not a ${type}`);
    return value;
  }

  str(key: string): string {
    return this.get(key, 'string', (v): v is string => typeof v === 'string');
  }

  num(key: string): number {
    return this.get(key, 'number', (v): v is number => typeof v === 'number');
  }

  bool(key: string): boolean {
    return this.get(key, 'boolean', (v): v is boolean => typeof v === 'boolean');
  }

  /** An id that gh prints as a string (GraphQL node id) or a number (REST). */
  id(key: string): string {
    const isId = (v: unknown): v is string | number =>
      typeof v === 'string' || typeof v === 'number';
    return String(this.get(key, 'string or number', isId));
  }

  list(key: string): unknown[] {
    return this.get(key, 'list', Array.isArray);
  }

  /** A nested object. */
  field(key: string): Fields {
    return Fields.of(this.obj[key], `${this.what}.${key}`);
  }

  /** `{ "login": … }` objects such as `author` and `actor`. */
  login(key: string): string {
    return this.field(key).str('login');
  }

  has(key: string): boolean {
    return this.obj[key] !== undefined && this.obj[key] !== null;
  }
}

export function asList(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new GhError(`unexpected gh output: ${what} is not a list`);
  return value;
}

// Arguments are checked before gh runs: a value starting with `-` would be read as a flag, and
// gh splits label lists on commas, so `a,owner:approved` would add two labels.

const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;

export function repoArg(repo: string): string {
  if (!REPO_RE.test(repo) || repo.endsWith('/.') || repo.endsWith('/..')) {
    throw new GhError(`invalid repository ${JSON.stringify(repo)}; expected owner/name`);
  }
  return repo;
}

export function numberArg(n: number): string {
  if (!Number.isSafeInteger(n) || n < 1)
    throw new GhError(`invalid issue or PR number ${String(n)}`);
  return String(n);
}

export function labelArg(label: string): string {
  if (label === '' || label.startsWith('-') || label.includes(',')) {
    throw new GhError(`invalid label ${JSON.stringify(label)}`);
  }
  return label;
}

export function refArg(ref: string): string {
  if (ref === '' || ref.startsWith('-')) throw new GhError(`invalid ref ${JSON.stringify(ref)}`);
  return ref;
}

/** The PR number at the end of the URL `gh pr create` prints. */
export function prNumberFromUrl(url: string): number {
  const match = /\/pull\/(\d+)\s*$/.exec(url);
  if (!match) throw new GhError(`unexpected gh output: no PR number in ${JSON.stringify(url)}`);
  return Number(match[1]);
}
