// The factory MCP server (contracts/mcp-tools.md, FR-022, research R7): `advance_item`,
// `log_event` and `request_split` for agent sessions. The tools write events and requests only;
// the dispatcher's code decides every move and is the only writer of `state:` labels.
//
// The session's facts come from where its hooks get them (src/hooks/log.ts `resolveSession`):
// the role file, `.station.json` for an item role, and the launcher's `FACTORY_ITEM` and
// `FACTORY_STATION`. A hook reads the role and session id from its input; an MCP server has no
// such input, so the launcher passes them as `FACTORY_ROLE` and `FACTORY_SESSION`. Like every
// event, what these tools write is telemetry (data-model.md § Event), never a gate input.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { RefusedError } from '../cli/env.js';
import { appendEvent } from '../events/append.js';
import { AGENT_FIELD, eventInput, resolveSession, type HookInput } from '../hooks/log.js';
import { advanceItem } from './tools/advance-item.js';
import { InvalidInput, toolName, type McpContext, type ToolSession } from './tools/input.js';
import { logEvent } from './tools/log-event.js';
import { requestSplit } from './tools/request-split.js';

const TOOLS = [advanceItem, logEvent, requestSplit];

/** The role and session id the launcher set; without them no tool can name its session. */
export function sessionInput(env: NodeJS.ProcessEnv): HookInput {
  const { FACTORY_ROLE: role, FACTORY_SESSION: session } = env;
  if (role === undefined || role === '' || session === undefined || session === '')
    throw new RefusedError(
      'no session context: the launcher sets FACTORY_ROLE and FACTORY_SESSION for factory sessions',
    );
  return { [AGENT_FIELD]: role, session_id: session };
}

async function toolSession(ctx: McpContext): Promise<ToolSession> {
  const session = await resolveSession(sessionInput(ctx.env), ctx);
  if (typeof session.log === 'string') throw new RefusedError(session.log);
  return { session, log: session.log };
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
    let s: ToolSession;
    try {
      s = await toolSession(ctx);
    } catch (err) {
      return result({ error: err instanceof Error ? err.message : String(err) }, true);
    }
    try {
      const tool = TOOLS.find((t) => t.name === name);
      if (tool === undefined) throw new InvalidInput([`unknown tool ${name}`]);
      return result(await tool.call(args, s, ctx));
    } catch (err) {
      if (!(err instanceof InvalidInput))
        return result({ error: err instanceof Error ? err.message : String(err) }, true);
      const fields = { kind: 'blocked', tool: toolName(name), input_summary: err.message } as const;
      await appendEvent(s.log, eventInput(s.session, fields), ctx.now);
      throw new McpError(ErrorCode.InvalidParams, `${name}: ${err.message}`);
    }
  });
  return mcp;
}

/** Serves until the transport closes; refuses at once without the session context. */
export async function serve(ctx: McpContext, transport: Transport): Promise<void> {
  sessionInput(ctx.env);
  const server = createServer(ctx);
  const closed = new Promise<void>((resolve) => {
    server.server.onclose = resolve;
  });
  await server.connect(transport);
  await closed;
}
