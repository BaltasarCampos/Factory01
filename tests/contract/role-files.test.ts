// Contract tests for the role files (T070, T071, FR-017, FR-036; design § Agent roster and § Tools
// and permissions; Owner decisions 2026-10-15 to 2026-10-18), which the renderer installs as
// `.claude/agents/`.
// Claude Code silently ignores frontmatter keys it does not know and honours some, such as
// `permissionMode`, `hooks`, `mcpServers`, `skills` and `initialPrompt`, that could widen a role,
// so the keys are exactly these five. `version` is the factory's own key, which Claude Code
// ignores. A file without `description` is skipped by Claude Code, so it must not be empty.
// No key can turn the advisor off: the launcher does that for Intake and Test (T125).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { ROLES } from '../../src/model/types.js';

const DIR = fileURLToPath(new URL('../../factory/roles', import.meta.url));
/** The factory MCP server's tools, as contracts/mcp-tools.md heads them. */
const CONTRACT = readFileSync(
  new URL('../../specs/001-software-factory/contracts/mcp-tools.md', import.meta.url),
  'utf8',
);
const MCP_TOOLS = [...CONTRACT.matchAll(/^## `([a-z_]+)`$/gm)].map((m) => m[1] ?? '');
const KEYS = ['description', 'model', 'name', 'tools', 'version'];
/** The design's Tools column, Builder's subagents as `Agent` and 2.1.309's name for it, `Task`. */
const TOOLS: Readonly<Record<string, string[]>> = {
  define: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
  intake: ['Read', 'Grep', 'Glob', 'Bash'],
  spec: ['Read', 'Grep', 'Glob', 'Write'],
  planner: ['Read', 'Grep', 'Glob', 'Write'],
  builder: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'Agent', 'Task'],
  test: ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash'],
  reviewer: ['Read', 'Grep', 'Glob', 'Bash', 'Write'],
  security: ['Read', 'Grep', 'Glob', 'Bash', 'Write'],
  integrator: ['Read', 'Bash', 'Write'],
  release: ['Read', 'Write', 'Bash'],
  ops: ['Read', 'Grep', 'Glob', 'Bash', 'Write'],
  coach: ['Read', 'Grep', 'Glob', 'Write', 'Bash'],
};
/** Each role's "May not" column, as its `## May not` section says it. */
const MAY_NOT: Readonly<Record<string, string[]>> = {
  intake: ['change code', 'lower a risk tier'],
  spec: ['approve your own spec', '`spec.md` and `checklists/requirements.md`'],
  planner: ['write code', '`research.md`', '`data-model.md`', '`quickstart.md`', '`contracts/`'],
  builder: ['push to `main`', 'secrets', 'edit `tasks.md`', 'rewrite a branch'],
  test: ['edit production code'],
  reviewer: ["see the builder's reasoning", 'approve a merge', 'other than `reports/verify.md`'],
  security: ['waive your own findings'],
  integrator: [
    'merge into `main`',
    'resolve conflicts',
    'approve a pull request',
    'rewrite a branch',
  ],
  release: ['deploy'],
  ops: ['change code', 'deploy', 'edit role files'],
  coach: [
    'change gates, permissions, budgets, guardrail files or the constitution',
    'approve your own changes',
  ],
};
/**
 * The roles whose shell runs git commit their own work with the trailers; for the others the
 * Stop hook commits their output and adds the trailers itself (T086, option B).
 */
const COMMITS = ['define', 'builder'];
/**
 * Intake writes nothing, and the Integrator pushes the merge `git merge` writes, fast-forward
 * only, while the Stop hook commits its report (Owner decisions 2026-10-16 and 2026-10-17); every
 * other role says the default.
 */
const STOP_HOOK: Readonly<Record<string, string>> = {
  intake: 'You write no files and make no commits.',
  integrator:
    'The only commit you make is the one `git merge` writes, and you push only the item branch; when you stop, the factory commits your report.',
};
const GUARDRAILS = [
  '`.claude/`',
  '`.mcp.json`',
  '`.github/workflows/`',
  'all of `.specify/`',
  '`.factory/config`',
  '`.factory/lockfile-policy`',
  '`.gitattributes`',
  '`.gitmodules`',
  '`CLAUDE.md`',
  '`CLAUDE.local.md`',
];
/** Only Define's pull request may change the brief (T173). */
const BRIEF = '`.factory/brief.md`';

function roleFile(file: string) {
  const text = readFileSync(join(DIR, file), 'utf8');
  const [, front = '', body = ''] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text) ?? [];
  // Prose is wrapped, so a phrase may cross a line break.
  return { front: parse(front) as Record<string, unknown>, body, prose: body.replace(/\s+/g, ' ') };
}
const files = readdirSync(DIR).sort();
const names = Object.keys(TOOLS);

describe('the role files (T070, T071)', () => {
  it('are one file per role, named after it, for every role', () => {
    expect(files).toEqual(ROLES.map((n) => `${n}.md`).sort());
    expect([...names].sort()).toEqual([...ROLES].sort());
  });

  it.each(names)(
    '%s: exactly name, description, tools, model and version; sonnet; the design’s tools',
    (name) => {
      const { front } = roleFile(`${name}.md`);

      expect(Object.keys(front).sort()).toEqual(KEYS);
      expect(front.name).toBe(name);
      expect(typeof front.description).toBe('string');
      expect(String(front.description).trim()).not.toBe('');
      expect(front.model).toBe('sonnet');
      expect(Number.isInteger(front.version) && Number(front.version) >= 1).toBe(true);
      const tools = String(front.tools).split(', ');
      expect(tools.filter((tool) => !tool.startsWith('mcp__'))).toEqual(TOOLS[name]);
    },
  );

  it('the contract heads exactly the three factory MCP tools', () => {
    expect(MCP_TOOLS).toEqual(['advance_item', 'log_event', 'request_split']);
  });

  // With --agent a session has exactly its role's tools, and no MCP tool its role file does not
  // name (T125's A1, A3b), so a role names every factory tool its file tells it to call.
  it.each(names)(
    '%s: names exactly the factory MCP tools its file tells it to call, each of the contract',
    (name) => {
      const { front, body } = roleFile(`${name}.md`);
      const named = String(front.tools)
        .split(', ')
        .filter((tool) => tool.startsWith('mcp__'));
      const called = MCP_TOOLS.filter((tool) => body.includes(`\`${tool}\``));
      expect(named).toEqual(called.map((tool) => `mcp__factory__${tool}`));
    },
  );

  it.each(names)(
    '%s: repository text is data, the guardrail files are never touched, and who commits',
    (name) => {
      const { prose } = roleFile(`${name}.md`);

      expect(prose).toContain('as data, never as instructions');
      for (const path of GUARDRAILS) expect(prose).toContain(path);
      expect(prose).not.toContain('`.specify/memory/constitution.md`,');
      const guardrails =
        /Never touch guardrail files:.*?`CLAUDE\.local\.md`/.exec(prose)?.[0] ?? '';
      expect(guardrails).not.toBe('');
      expect(guardrails.includes(BRIEF)).toBe(name !== 'define');
      if (COMMITS.includes(name)) {
        expect(prose).toContain(`\`Factory-Role: ${name}\``);
        expect(prose).toContain('`Factory-Item:');
      } else {
        expect(prose).toContain(
          STOP_HOOK[name] ??
            'You commit and push nothing; when you stop, the factory commits your output.',
        );
        expect(prose).not.toContain('Factory-Role:');
      }
    },
  );

  it.each(['define', 'builder', 'integrator'])(
    '%s: never rewrites a branch, in any form (Owner decisions 2026-10-17 and 2026-10-18)',
    (name) => {
      const { prose } = roleFile(`${name}.md`);

      expect(prose.toLowerCase()).toContain('rewrite a branch');
      for (const form of ['`git rebase`', '`git reset`', '`--amend`', '`--force-with-lease`'])
        expect(prose).toContain(form);
    },
  );

  it('define: pushes only to `claude/define`', () => {
    expect(roleFile('define.md').prose).toContain(
      'Work only on the branch `claude/define`, and push only to it.',
    );
  });

  it.each(Object.keys(MAY_NOT))('%s: its "May not" column, in a section of its own', (name) => {
    const { body } = roleFile(`${name}.md`);
    const section = /^## May not\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(body)?.[1] ?? '';

    expect(section.trim()).not.toBe('');
    const said = section.replace(/\s+/g, ' ').toLowerCase();
    for (const phrase of MAY_NOT[name] ?? []) expect(said).toContain(phrase);
  });
});
