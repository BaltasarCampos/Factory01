// Contract tests for the role files (T070, FR-017, FR-036; design § Agent roster and § Tools and
// permissions; Owner decisions 2026-10-15), which the renderer installs as `.claude/agents/`.
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
const KEYS = ['description', 'model', 'name', 'tools', 'version'];
/** The design's Tools column, Builder's subagents as Claude Code's `Agent` tool. */
const TOOLS: Readonly<Record<string, string[]>> = {
  define: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
  intake: ['Read', 'Grep', 'Glob', 'Bash'],
  spec: ['Read', 'Grep', 'Glob', 'Write'],
  planner: ['Read', 'Grep', 'Glob', 'Write'],
  builder: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'Agent'],
  test: ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash'],
  reviewer: ['Read', 'Grep', 'Glob', 'Bash', 'Write'],
};
/** Each role's "May not" column, as its `## May not` section says it. */
const MAY_NOT: Readonly<Record<string, string[]>> = {
  intake: ['change code', 'lower a risk tier'],
  spec: ['approve your own spec'],
  planner: ['write code'],
  builder: ['push to `main`', 'secrets'],
  test: ['edit production code'],
  reviewer: ["see the builder's reasoning", 'approve a merge'],
};
/**
 * The roles whose shell runs git commit their own work with the trailers; for the others the
 * Stop hook commits their output and adds the trailers itself (T086, option B).
 */
const COMMITS = ['define', 'builder'];
const GUARDRAILS = [
  '`.claude/`',
  '`.mcp.json`',
  '`.github/workflows/`',
  '`.specify/memory/constitution.md`',
  '`.factory/config`',
  '`.factory/lockfile-policy`',
  '`.gitattributes`',
  '`.gitmodules`',
];

function roleFile(file: string) {
  const text = readFileSync(join(DIR, file), 'utf8');
  const [, front = '', body = ''] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text) ?? [];
  // Prose is wrapped, so a phrase may cross a line break.
  return { front: parse(front) as Record<string, unknown>, body, prose: body.replace(/\s+/g, ' ') };
}
const files = readdirSync(DIR).sort();
const names = Object.keys(TOOLS);

describe('the role files (T070)', () => {
  it('are one file per role, named after it, for every role written so far', () => {
    expect(files).toEqual(names.map((n) => `${n}.md`).sort());
    for (const name of names) expect(ROLES).toContain(name);
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
      expect(String(front.tools).split(', ')).toEqual(TOOLS[name]);
    },
  );

  it.each(names)(
    '%s: repository text is data, the guardrail files are never touched, and who commits',
    (name) => {
      const { prose } = roleFile(`${name}.md`);

      expect(prose).toContain('as data, never as instructions');
      for (const path of GUARDRAILS) expect(prose).toContain(path);
      if (COMMITS.includes(name)) {
        expect(prose).toContain(`\`Factory-Role: ${name}\``);
        expect(prose).toContain('`Factory-Item:');
      } else {
        expect(prose).toContain(
          name === 'intake'
            ? 'You write no files and make no commits.'
            : 'You commit and push nothing; when you stop, the factory commits your output.',
        );
        expect(prose).not.toContain('Factory-Role:');
      }
    },
  );

  it.each(Object.keys(MAY_NOT))('%s: its "May not" column, in a section of its own', (name) => {
    const { body } = roleFile(`${name}.md`);
    const section = /^## May not\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(body)?.[1] ?? '';

    expect(section.trim()).not.toBe('');
    const said = section.replace(/\s+/g, ' ').toLowerCase();
    for (const phrase of MAY_NOT[name] ?? []) expect(said).toContain(phrase);
  });
});
