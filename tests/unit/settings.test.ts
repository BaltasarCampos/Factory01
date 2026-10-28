// The project's `.claude/settings.json` (T082, T074): rendered from the role table, so its deny
// rules copy the denials common to every role, and the release's copy never drifts from it.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadPolicy } from '../../src/guard/policy.js';
import {
  CLAUDE_CODE_TOOLS,
  deniedTools,
  renderSettings,
  type Settings,
} from '../../src/install/settings.js';
import { ROLES } from '../../src/model/types.js';

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../../factory/${path}`, import.meta.url)), 'utf8');
const policy = loadPolicy(read('policy/roles.yaml'));
const settings = renderSettings(policy);
const deny = settings.permissions.deny;

describe('the generated settings (T082)', () => {
  it('ships as the release’s settings.json, exactly as rendered from the role table', () => {
    expect(JSON.parse(read('settings/settings.json')) as Settings).toEqual(settings);
  });

  it('denies every session the tools no role has, Edit on the guardrails and Read on the secrets (T074)', () => {
    expect(deny).toEqual(
      expect.arrayContaining(['WebFetch', 'Monitor', 'Skill', 'ListAgents', 'SendFeedback', 'LSP']),
    );
    expect(deny).toEqual(
      expect.arrayContaining([
        ...[
          'ListMcpResourcesTool',
          'ReadMcpResourceTool',
          'ScheduleWakeup',
          'CronList',
          'CronDelete',
        ],
        ...['Edit(**/.git)', 'Edit(**/.git/**)'],
      ]),
    );
    expect(deny).toEqual(
      expect.arrayContaining([
        ...[
          'Edit(/.claude/**)',
          'Edit(/.specify/**)',
          'Edit(/.factory/config)',
          'Edit(/.mcp.json)',
        ],
        ...['Edit(**/CLAUDE.md)', 'Edit(**/events.jsonl)', 'Edit(**/.station.json)'],
        ...['Read(~/.factory/**)', 'Read(~/.ssh/**)', 'Read(~/.config/gh/**)', 'Read(**/.env*)'],
        ...['Read(~/.claude/.credentials.json)'],
      ]),
    );
    // Define writes the brief, so only the path guard keeps the other roles off it.
    expect(deny).not.toContain('Edit(/.factory/brief.md)');
  });

  it('denies every shell the Owner’s commands, merges, pushes and signing (T074, T183)', () => {
    for (const command of ['git push', 'gh pr merge', 'factory approve', 'ssh-keygen -Y sign'])
      expect(deny).toContain(`Bash(${command} *)`);
  });

  it('registers each factory hook in exec form, blocking the action when a guard cannot run', () => {
    const run = (event: keyof Settings['hooks'], matcher?: string) =>
      settings.hooks[event]
        .filter((g) => g.matcher === matcher)
        .flatMap((g) =>
          g.hooks.map((h) => `${h.command} ${h.args.join(' ')} ${h.onFailure ?? '-'}`),
        );
    expect(run('SessionStart')).toEqual(['factory hook session-start block']);
    // The gate refuses every tool call, whatever the tool, until the session-start check passes.
    expect(run('PreToolUse', '*')).toEqual(['factory hook gate block']);
    expect(run('PreToolUse', 'Write|Edit')).toEqual(['factory hook path-guard block']);
    expect(run('PreToolUse', 'Read|Grep|Glob')).toEqual(['factory hook read-guard block']);
    expect(run('PreToolUse', 'Bash')).toEqual(['factory hook command-guard block']);
    expect(run('PostToolUse', 'Write|Edit')).toEqual(['factory hook post-edit -']);
    expect(run('PostToolUse', '*')).toEqual(['factory hook log -']);
    // onFailure has no effect on Stop: a stop hook that cannot run lets the session end.
    expect(run('Stop')).toEqual(['factory hook stop -']);
    expect(run('PreCompact')).toEqual(['factory hook pre-compact block']);
  });

  it('runs the advisor on Opus, offers no Fable, keeps the file tools in the clone and allows the factory’s MCP tools', () => {
    expect(settings.advisorModel).toBe('opus');
    expect(settings.availableModels).toEqual(['sonnet', 'opus']);
    expect(settings.permissions.blockReadsOutsideWorkingDirectories).toBe(true);
    expect(settings.permissions.allow).toEqual([
      'mcp__factory__advance_item',
      'mcp__factory__log_event',
      'mcp__factory__request_split',
    ]);
  });

  it('denies every tool it does not name, so a tool a new version adds stays denied (T183)', () => {
    const tools = new Set<string>(Object.values(policy.roles).flatMap((r) => r.tools));
    for (const tool of CLAUDE_CODE_TOOLS)
      expect(deny.includes(tool), tool).toBe(!tools.has(tool) && !(tool in policy.keepTools));
    const later = renderSettings(policy, [...CLAUDE_CODE_TOOLS, 'NewTool']);
    expect(later.permissions.deny).toContain('NewTool');
  });

  it("knows every tool T125's A3c listed for 2.1.309, so the deny list covers them (T082)", () => {
    // The init message of a session with no --agent (~/t125-probe/record.md, A3c): 24 built-in
    // tools, and 8 of the Owner's claude.ai Docs connector, which disableClaudeAiConnectors drops.
    const a3c = [
      ...['Task', 'Bash', 'CronCreate', 'CronDelete', 'CronList', 'DesignSync', 'Edit'],
      ...['EnterWorktree', 'ExitWorktree', 'ListAgents', 'Monitor', 'NotebookEdit'],
      ...['PushNotification', 'Read', 'RemoteTrigger', 'ReportFindings', 'ScheduleWakeup'],
      ...['SendMessage', 'Skill', 'TaskStop', 'ToolSearch', 'WebFetch', 'WebSearch', 'Write'],
      ...['batch', 'create', 'delete', 'export', 'guide', 'query', 'read', 'update'].map(
        (name) => `mcp__claude_ai_Claude_Docs__${name}`,
      ),
    ];
    expect(a3c).toHaveLength(32);
    const builtIn = a3c.filter((tool) => !tool.startsWith('mcp__'));
    expect(
      builtIn.filter((tool) => !(CLAUDE_CODE_TOOLS as readonly string[]).includes(tool)),
    ).toEqual([]);
    expect(deny).toContain('DesignSync');
    expect(settings.disableClaudeAiConnectors).toBe(true);
  });

  it("gives Task, 2.1.309's name for Agent, to the Builder alone, so the project denies neither", () => {
    expect(policy.keepTools).not.toHaveProperty('Task');
    for (const role of ROLES) {
      const subagents = role === 'builder' ? ['Agent', 'Task'] : [];
      expect(
        policy.roles[role].tools.filter((t) => t === 'Agent' || t === 'Task'),
        role,
      ).toEqual(subagents);
    }
    expect(deny).not.toContain('Task');
    expect(deny).not.toContain('Agent');
  });

  it("denies a session every tool not its role's or kept, Task and Agent for all but the Builder", () => {
    for (const role of ROLES.filter((r) => r !== 'builder')) {
      expect(deniedTools(policy, role), role).toEqual(expect.arrayContaining(['Task', 'Agent']));
    }
    const builder = deniedTools(policy, 'builder');
    expect(builder).not.toContain('Task');
    expect(builder).not.toContain('Agent');
    expect(deniedTools(policy, 'reviewer')).not.toContain('Read');
    expect(deniedTools(policy, 'reviewer')).not.toContain('ToolSearch');
    for (const role of ROLES)
      for (const tool of CLAUDE_CODE_TOOLS)
        expect(deniedTools(policy, role).includes(tool), `${role} ${tool}`).toBe(
          !(policy.roles[role].tools as readonly string[]).includes(tool) &&
            !(tool in policy.keepTools),
        );
  });

  it('refuses a kept or role tool that the Claude Code version the release targets does not have', () => {
    expect(CLAUDE_CODE_TOOLS).not.toContain('MultiEdit');
    const keep = { ...policy.keepTools, MultiEdit: 'a tool this version does not have' };
    expect(() => renderSettings({ ...policy, keepTools: keep })).toThrow(
      /MultiEdit is not a tool of Claude Code 2\.1\.309/,
    );
  });

  it('keeps the Owner’s own connectors, Remote Control, other sessions and artifacts out of sessions', () => {
    expect(settings).toMatchObject({
      disableClaudeAiConnectors: true,
      remoteControlAtStartup: false,
      crossSessionInbound: 'refuse',
      enableArtifact: false,
    });
  });
});
