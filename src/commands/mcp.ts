// `factory mcp` (contracts/cli.md, contracts/mcp-tools.md): the factory MCP server over stdio,
// started by Claude Code from the project's `.mcp.json`. Stdout carries the protocol only.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CommandContext } from '../cli/commands.js';
import { ExitCode } from '../cli/env.js';
import { serve, sessionInput } from '../mcp/server.js';

export async function mcp(ctx: CommandContext): Promise<number> {
  sessionInput(ctx.env);
  const transport = new StdioServerTransport();
  // The transport does not close when stdin ends; the server must not outlive its session.
  process.stdin.once('end', () => void transport.close());
  await serve({ cwd: ctx.cwd, env: ctx.env, now: ctx.now }, transport);
  return ExitCode.Ok;
}
