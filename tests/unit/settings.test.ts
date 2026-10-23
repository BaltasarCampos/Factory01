// The project's `.claude/settings.json` (T082, T074): rendered from the role table, so its deny
// rules copy the denials common to every role, and the release's copy never drifts from it.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadPolicy } from '../../src/guard/policy.js';
import { CLAUDE_CODE_TOOLS, renderSettings, type Settings } from '../../src/install/settings.js';

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
    expect(deny).toEqual(expect.arrayContaining(policy.denyTools));
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

  it('refuses a deny rule naming no tool of the Claude Code version the release targets', () => {
    expect(CLAUDE_CODE_TOOLS).not.toContain('MultiEdit');
    expect(() =>
      renderSettings({ ...policy, denyTools: [...policy.denyTools, 'MultiEdit'] }),
    ).toThrow(/deny rule MultiEdit names no tool of Claude Code 2\.1\.309/);
  });
});
