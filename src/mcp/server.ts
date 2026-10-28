// The factory MCP server (contracts/mcp-tools.md, FR-022, research R7): `advance_item`,
// `log_event` and `request_split` for agent sessions. The tools write events and requests only;
// the dispatcher's code decides every move and is the only writer of `state:` labels.
//
// The session's facts come from its record under `~/.factory/sessions/<session_id>/`, as the
// guards' do (src/hooks/session.ts), never from the clone. A hook reads the session id from its
// input; an MCP server has no such input, so the launcher passes it, and the role, as
// `FACTORY_SESSION` and `FACTORY_ROLE`. Every call is refused unless the id is a session id, its
// record reads, the role is the record's and the session-start check passed; once the record
// reads, a refusal is logged as `blocked`, so a session the launcher misnamed leaves a trace. The
// tools' events go to the session's own log. Like every event, they are telemetry (data-model.md
// § Event), never a gate input.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { homedir } from 'node:os';
import { RefusedError } from '../cli/env.js';
import { appendEvent } from '../events/append.js';
import {
  hasPassed,
  logBlocked,
  readSessionRecord,
  sessionEvents,
  sessionId,
} from '../hooks/session.js';
import { advanceItem } from './tools/advance-item.js';
import {
  InvalidInput,
  toolEvent,
  toolName,
  type McpContext,
  type ToolSession,
} from './tools/input.js';
import { logEvent } from './tools/log-event.js';
import { requestSplit } from './tools/request-split.js';

const TOOLS = [advanceItem, logEvent, requestSplit];

/** The role and session id the launcher set; without them no tool can name its session. */
export function launchedAs(env: NodeJS.ProcessEnv): { role: string; session: string } {
  const { FACTORY_ROLE: role, FACTORY_SESSION: session } = env;
  if (role === undefined || role === '' || session === undefined || session === '')
    throw new RefusedError(
      'no session context: the launcher sets FACTORY_ROLE and FACTORY_SESSION for factory sessions',
    );
  return { role, session };
}

/**
 * The session from its record, checked on every call: the record is written before launch. Throws
 * while there is no record to log against; after that, says why the call is refused.
 */
async function toolSession(ctx: McpContext, tool: string): Promise<ToolSession | string> {
  const launched = launchedAs(ctx.env);
  const home = ctx.env.HOME ?? homedir();
  const session = sessionId(launched.session);
  const record = readSessionRecord(home, session);
  const refused =
    launched.role !== record.role
      ? `FACTORY_ROLE ${JSON.stringify(launched.role)} is not the session's role ${record.role}`
      : !hasPassed(home, session)
        ? 'the session-start check has not passed for this session'
        : undefined;
  if (refused === undefined) return { record, session, log: sessionEvents(home, session) };
  const fields = { tool: toolName(tool), input_summary: refused };
  return refused + (await logBlocked(record, home, session, fields, ctx.now));
}

const result = (value: unknown, isError = false): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
  ...(isError ? { isError } : {}),
});

/**
 * The tool handlers sit on McpServer's underlying protocol server: `registerTool` takes zod
 * schemas, and zod is not a dependency of ours. Each tool checks its own input, so a bad call
 * can be logged as `blocked` and caller-sent session fields ignored.
 */
export function createServer(ctx: McpContext): McpServer {
  const mcp = new McpServer({ name: 'factory', version: '1.0.0' }, { capabilities: { tools: {} } });
  const { server } = mcp;
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    let s: ToolSession | string;
    try {
      s = await toolSession(ctx, name);
    } catch (err) {
      return result({ error: err instanceof Error ? err.message : String(err) }, true);
    }
    if (typeof s === 'string') return result({ error: s }, true);
    try {
      const tool = TOOLS.find((t) => t.name === name);
      if (tool === undefined) throw new InvalidInput([`unknown tool ${name}`]);
      return result(await tool.call(args, s, ctx));
    } catch (err) {
      if (!(err instanceof InvalidInput))
        return result({ error: err instanceof Error ? err.message : String(err) }, true);
      const fields = { kind: 'blocked', tool: toolName(name), input_summary: err.message } as const;
      await appendEvent(s.log, toolEvent(s, fields), ctx.now);
      throw new McpError(ErrorCode.InvalidParams, `${name}: ${err.message}`);
    }
  });
  return mcp;
}

/** Serves until the transport closes; refuses at once without the session context. */
export async function serve(ctx: McpContext, transport: Transport): Promise<void> {
  launchedAs(ctx.env);
  const server = createServer(ctx);
  const closed = new Promise<void>((resolve) => {
    server.server.onclose = resolve;
  });
  await server.connect(transport);
  await closed;
}
