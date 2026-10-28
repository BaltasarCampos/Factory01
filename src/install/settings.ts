// The project's `.claude/settings.json` (T082), rendered from the role table so the two never
// drift: deny rules that copy the denials common to every role, the factory's hooks, the advisor
// model and the models a session may run. Settings apply to every session in the project, so a
// denial open to one role, such as Define's brief, is left to the guards.
//
// Checked against Claude Code's documentation for v2.1.309 (code.claude.com/docs/en/permissions,
// hooks, settings-reference and tools-reference, read 2026-10-23). A deny rule naming a tool that
// does not exist only warns at startup, so the generator refuses one instead (T124's finding).
// The hooks run in exec form, with no shell, and a guard that cannot run blocks the action
// (`onFailure: "block"`, Claude Code v2.1.295 or later); it has no effect on Stop.
import { RefusedError } from '../cli/env.js';
import { deniedWrites, type Policy } from '../guard/policy.js';
import { ROLES, type RoleName } from '../model/types.js';

/** The version whose tool names the deny rules are checked against. */
export const CLAUDE_CODE_VERSION = '2.1.309';

/**
 * Claude Code's built-in tools in that version, from its tools reference and the tools a session
 * listed in T125's A3c, which added `Task`, the subagent tool's name there, and `DesignSync`.
 */
export const CLAUDE_CODE_TOOLS = [
  ...['Agent', 'Artifact', 'AskUserQuestion', 'Bash', 'CronCreate', 'CronDelete', 'CronList'],
  ...['DesignSync', 'Task'],
  ...['Edit', 'EndConversation', 'EnterPlanMode', 'EnterWorktree', 'ExitPlanMode', 'ExitWorktree'],
  ...['Glob', 'Grep', 'ListAgents', 'ListMcpResourcesTool', 'LSP', 'Monitor', 'NotebookEdit'],
  ...['PowerShell', 'PushNotification', 'Read', 'ReadMcpResourceTool', 'RemoteTrigger'],
  ...['ReportFindings', 'ScheduleWakeup', 'SendFeedback', 'SendMessage', 'SendUserFile'],
  ...['ShareOnboardingGuide', 'Skill', 'SubagentHandback', 'TaskCreate', 'TaskGet', 'TaskList'],
  ...['TaskStop', 'TaskUpdate', 'TodoWrite', 'ToolSearch', 'WaitForMcpServers', 'WebFetch'],
  ...['WebSearch', 'Workflow', 'Write'],
] as const;

/** The factory MCP server's tools (contracts/mcp-tools.md), which every session may call. */
export const MCP_TOOLS = ['advance_item', 'log_event', 'request_split'];

interface Hook {
  type: 'command';
  command: 'factory';
  args: string[];
  onFailure?: 'block';
}
interface HookGroup {
  matcher?: string;
  hooks: Hook[];
}
type HookEvent = 'SessionStart' | 'PreToolUse' | 'PostToolUse' | 'Stop' | 'PreCompact';

export interface Settings {
  permissions: { allow: string[]; deny: string[]; blockReadsOutsideWorkingDirectories: true };
  disableClaudeAiConnectors: true;
  remoteControlAtStartup: false;
  crossSessionInbound: 'refuse';
  enableArtifact: false;
  hooks: Record<HookEvent, HookGroup[]>;
  advisorModel: 'opus';
  availableModels: string[];
}

/** `factory hook <name>`, blocking the action when it cannot run if `guard` is set. */
const hook = (name: string, guard: boolean, matcher?: string): HookGroup => ({
  ...(matcher === undefined ? {} : { matcher }),
  hooks: [
    {
      ...{ type: 'command', command: 'factory', args: ['hook', name] },
      ...(guard ? { onFailure: 'block' } : {}),
    },
  ],
});

/** A table path as a permission rule's: home and any-depth paths as they are, others from the root. */
const rulePath = (path: string) =>
  path.startsWith('~/') || path.startsWith('**/') ? path : `/${path}`;

/**
 * The tools a session of `role` is denied, for its own settings: every tool of the version but its
 * role's and the kept ones, so a subagent tool only the Builder has stays denied to the others.
 */
export function deniedTools(
  policy: Policy,
  role: RoleName,
  tools: readonly string[] = CLAUDE_CODE_TOOLS,
): string[] {
  const open = new Set([...policy.roles[role].tools, ...Object.keys(policy.keepTools)]);
  return tools.filter((tool) => !open.has(tool));
}

export function renderSettings(
  policy: Policy,
  tools: readonly string[] = CLAUDE_CODE_TOOLS,
): Settings {
  // Default-no: every tool of the version is denied but the roles' own and the kept ones.
  const open = new Set([
    ...Object.values(policy.roles).flatMap((row) => row.tools),
    ...Object.keys(policy.keepTools),
  ]);
  for (const tool of open)
    if (!tools.includes(tool))
      throw new RefusedError(`${tool} is not a tool of Claude Code ${CLAUDE_CODE_VERSION}`);
  const everyRole = deniedWrites(policy, ROLES[0]).filter((path) =>
    ROLES.every((role) => deniedWrites(policy, role).includes(path)),
  );
  const deny = [
    ...tools.filter((tool) => !open.has(tool)),
    ...everyRole.map((path) => `Edit(${rulePath(path)})`),
    ...policy.denyRead.map((path) => `Read(${rulePath(path)})`),
    ...policy.denyShell.map((command) => `Bash(${command} *)`),
  ];
  for (const rule of deny) {
    const tool = rule.split('(', 1)[0] ?? '';
    if (!tools.includes(tool))
      throw new RefusedError(
        `deny rule ${rule} names no tool of Claude Code ${CLAUDE_CODE_VERSION}`,
      );
  }
  return {
    permissions: {
      allow: MCP_TOOLS.map((name) => `mcp__factory__${name}`),
      deny,
      blockReadsOutsideWorkingDirectories: true,
    },
    // The Owner's own setup stays out of sessions: claude.ai connectors, Remote Control,
    // messages from other sessions and the Artifact tool.
    disableClaudeAiConnectors: true,
    remoteControlAtStartup: false,
    crossSessionInbound: 'refuse',
    enableArtifact: false,
    hooks: {
      SessionStart: [hook('session-start', true)],
      PreToolUse: [
        hook('gate', true, '*'),
        hook('path-guard', true, 'Write|Edit'),
        hook('read-guard', true, 'Read|Grep|Glob'),
        hook('command-guard', true, 'Bash'),
      ],
      PostToolUse: [hook('post-edit', false, 'Write|Edit'), hook('log', false, '*')],
      Stop: [hook('stop', false)],
      PreCompact: [hook('pre-compact', true)],
    },
    advisorModel: 'opus',
    availableModels: ['sonnet', 'opus'],
  };
}
