// What every factory MCP tool shares (contracts/mcp-tools.md): the session it runs for and the
// checks on its caller's arguments. A tool rejects bad input with InvalidInput, which the server
// turns into an MCP error and a `blocked` event.
import type { LogTarget } from '../../events/append.js';
import type { Session } from '../../hooks/log.js';

export interface McpContext {
  /** The session's working copy. */
  cwd: string;
  /** The session's environment, set by the launcher; also passed to `gh`. */
  env: NodeJS.ProcessEnv;
  now: () => Date;
}

/** A session whose events have somewhere to go. */
export interface ToolSession {
  session: Session;
  log: LogTarget;
}

export type Args = Record<string, unknown>;

export interface FactoryTool {
  name: string;
  description: string;
  inputSchema: { type: 'object'; [key: string]: unknown };
  call(args: Args, s: ToolSession, ctx: McpContext): Promise<unknown>;
}

export class InvalidInput extends Error {
  override name = 'InvalidInput';
  readonly problems: string[];

  constructor(problems: string[]) {
    super(problems.join('; '));
    this.problems = problems;
  }
}

/** The name Claude Code gives the tool: `.mcp.json` declares the server as `factory`. */
export const toolName = (name: string) => `mcp__factory__${name}`;

/** Free text up to `max` characters, never empty. */
export const isText = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.trim() !== '' && v.length <= max;

/** Throws InvalidInput listing every problem: unknown keys, an item other than the session's. */
export function check(args: Args, keys: readonly string[], s: ToolSession, more: string[]): void {
  const problems = Object.keys(args)
    .filter((key) => !keys.includes(key))
    .map((key) => `${key}: unknown field`);
  const { item } = args;
  if (!Number.isSafeInteger(item)) problems.push('item: issue number required');
  else if (item !== s.session.item)
    problems.push(`item ${String(item)} is not this session's item ${String(s.session.item)}`);
  problems.push(...more);
  if (problems.length > 0) throw new InvalidInput(problems);
}
