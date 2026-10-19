// Contract tests for the Spec Kit commands the release ships as `factory/skills/<name>/SKILL.md`
// (T171, T172; design v1.8 § Tech stack): each takes the feature folder from the station prompt,
// and none runs a script, follows an extension hook, sends out a subagent, edits an ignore file
// or waits for an answer. The release's `.specify/` holds only what the commands read.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const FACTORY = fileURLToPath(new URL('../../factory', import.meta.url));
const SKILLS = join(FACTORY, 'skills');

/** What no shipped command may do, each with the pattern that finds it. */
const FORBIDDEN: readonly [string, RegExp][] = [
  ['runs a script', /\.specify\/scripts|\.sh\b|```(?:bash|sh|shell|powershell)\b/],
  ['follows extension hooks', /extensions\.ya?ml|EXECUTE_COMMAND|\b(?:before|after)_[a-z]+\b/],
  ['sends out a subagent', /sub-?agents?\b|\b(?:Task|Agent) tool\b|`(?:Task|Agent)`/i],
  ['edits an ignore file', /\.[a-z]*ignore\b/],
  ['waits for an answer', /\bwait/i],
  ['reads the folder from anywhere but the prompt', /feature\.json|SPECIFY_FEATURE|init-options/],
];

/** Each forbidden step a command's text names. */
function problems(text: string): string[] {
  return FORBIDDEN.flatMap(([what, pattern]) => (pattern.test(text) ? [what] : []));
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

const commands = readdirSync(SKILLS).map((name) => {
  const text = readFileSync(join(SKILLS, name, 'SKILL.md'), 'utf8');
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '';
  return { name, text, front: parseYaml(front) as Record<string, unknown> | null };
});

describe('the release’s Spec Kit commands (T171)', () => {
  it('ships its own speckit-specify and speckit-clarify', () => {
    expect(commands.map((c) => c.name)).toEqual(
      expect.arrayContaining(['speckit-specify', 'speckit-clarify']),
    );
  });

  it.each(commands)('$name: names itself and takes the feature folder from the prompt', (c) => {
    expect(c.front?.name).toBe(c.name);
    expect(c.front?.description).toMatch(/\S/);
    expect(c.text).toMatch(/feature folder your station prompt names/);
  });

  it.each(commands)('$name: runs no script, hook or subagent, and waits for nothing', (c) => {
    expect(problems(c.text)).toEqual([]);
  });

  it.each(commands)('$name: reads under .specify/ only what the release ships', (c) => {
    for (const [path] of c.text.matchAll(/\.specify\/[\w./-]*\w/g)) {
      const shipped =
        path === '.specify/memory/constitution.md'
          ? join(FACTORY, 'constitution.md')
          : join(FACTORY, 'specify', path.slice('.specify/'.length));
      expect(() => statSync(shipped), path).not.toThrow();
    }
  });

  it.each(['speckit-specify', 'speckit-clarify'])(
    '%s: writes its questions under ## Clarifications in spec.md and ends the session',
    (name) => {
      const text = commands.find((c) => c.name === name)?.text ?? '';
      expect(text).toContain('## Clarifications');
      expect(text).toMatch(/end (?:the|your) session/i);
    },
  );

  it.each([
    ['runs a script', 'Run `.specify/scripts/bash/check-prerequisites.sh --json`.'],
    ['runs a script', '```bash\nnpm test\n```'],
    ['follows extension hooks', 'Check `.specify/extensions.yml` for `hooks.before_specify`.'],
    ['sends out a subagent', 'Dispatch one research subagent per unknown.'],
    ['sends out a subagent', 'Use the Task tool for each question.'],
    ['edits an ignore file', 'Create `.dockerignore` if Docker is used.'],
    ['waits for an answer', '**Your choice**: _[Wait for user response]_'],
    ['reads the folder from anywhere but the prompt', 'Read `.specify/feature.json`.'],
  ])('the check finds a command that %s', (what, line) => {
    expect(problems(`---\nname: x\n---\n${line}\n`)).toContain(what);
  });
});

describe('the release’s .specify/ (T171)', () => {
  it('holds the four templates and nothing else: no scripts, presets or extensions', () => {
    const root = join(FACTORY, 'specify');
    expect(
      files(root)
        .map((p) => relative(root, p))
        .sort(),
    ).toEqual([
      'templates/checklist-template.md',
      'templates/plan-template.md',
      'templates/spec-template.md',
      'templates/tasks-template.md',
    ]);
  });
});
