// Contract tests for the Spec Kit commands the release ships as `factory/skills/<name>/SKILL.md`
// (T171, T172; design v1.8 § Tech stack): each takes the feature folder from the station prompt,
// and none runs a script, follows an extension hook, sends out a subagent, edits an ignore file
// or waits for an answer. Their frontmatter has only the keys the release uses, since Claude Code
// honours keys that would break the rules (Owner decision 2026-10-19). The release's `.specify/`
// holds only what the commands read.
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
  ['asks a question in the conversation', /would you like|do you want|shall I|\(yes\/no\)/i],
  ['names a command for the session to call', /\/speckit-[a-z]/],
];

/**
 * The frontmatter keys a shipped command may have. Claude Code also honours `allowed-tools`
 * (pre-approves tools), `context: fork` with `agent` (runs the command as a subagent), `model`
 * (switches the model, Fable included) and `hooks` (adds hooks): none is allowed.
 */
const KEYS = [
  'argument-hint',
  'description',
  'disable-model-invocation',
  'metadata',
  'name',
  'user-invocable',
];

/** Each frontmatter key that is not the release's. */
const strayKeys = (front: Record<string, unknown> | null) =>
  Object.keys(front ?? {}).filter((key) => !KEYS.includes(key));

const frontmatter = (text: string) =>
  parseYaml(/^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '') as Record<string, unknown> | null;

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
  return { name, text, front: frontmatter(text) };
});

describe('the release’s Spec Kit commands (T171, T172)', () => {
  it('ships its own six: specify, clarify, plan, tasks, analyze and implement', () => {
    expect(commands.map((c) => c.name).sort()).toEqual(
      ['analyze', 'clarify', 'implement', 'plan', 'specify', 'tasks'].map((n) => `speckit-${n}`),
    );
  });

  it.each(commands)('$name: has exactly the frontmatter keys the release uses', (c) => {
    expect(Object.keys(c.front ?? {}).sort()).toEqual(KEYS);
  });

  it.each([
    ['allowed-tools', 'allowed-tools: Bash(git push:*)'],
    ['context', 'context: fork'],
    ['agent', 'agent: general-purpose'],
    ['model', 'model: claude-fable-5-1'],
    ['hooks', 'hooks:\n  Stop:\n    - command: echo'],
  ])('the check refuses the frontmatter key %s', (key, line) => {
    const front = frontmatter(`---\nname: x\ndescription: y\n${line}\n---\nBody.\n`);
    expect(strayKeys(front)).toEqual([key]);
  });

  it.each(commands)('$name: names itself and takes the feature folder from the prompt', (c) => {
    expect(c.front?.name).toBe(c.name);
    expect(c.front?.description).toMatch(/\S/);
    expect(c.text).toMatch(/feature folder your station prompt names/);
  });

  it.each(commands)('$name: runs no script, hook or subagent, and waits for nothing', (c) => {
    expect(problems(c.text)).toEqual([]);
  });

  it.each(commands)(
    '$name: ends the session only on questions or a stop, so a next step can follow',
    (c) => {
      expect(c.text).not.toMatch(/end your\s+session with/i);
      expect(c.text).toMatch(/[Ff]inish this step\s+with|End with the report/);
    },
  );

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
    ['asks a question in the conversation', 'Would you like me to suggest remediation edits?'],
    ['names a command for the session to call', 'If questions remain, run `/speckit-clarify`.'],
  ])('the check finds a command that %s', (what, line) => {
    expect(problems(`---\nname: x\n---\n${line}\n`)).toContain(what);
  });
});

describe('each command’s own rules (T172; T124 wording, T072)', () => {
  const text = (name: string) => commands.find((c) => c.name === name)?.text ?? '';

  it('speckit-plan and speckit-tasks write only their own files, from the release’s templates', () => {
    expect(text('speckit-plan')).toContain('.specify/templates/plan-template.md');
    expect(text('speckit-tasks')).toContain('.specify/templates/tasks-template.md');
    expect(text('speckit-tasks')).toMatch(/Write nothing but `tasks\.md`/);
  });

  it('speckit-tasks puts the test tasks first, a file list on every task and maps every criterion', () => {
    expect(text('speckit-tasks')).toContain('### Tests …');
    expect(text('speckit-tasks')).toContain('· Files:');
    expect(text('speckit-tasks')).toMatch(/Every `AC-###` in the spec has at least one test/);
  });

  it('speckit-analyze is read-only and ends with its report', () => {
    expect(text('speckit-analyze')).toMatch(/read-only: it writes no file/);
    expect(text('speckit-analyze')).toMatch(/End with the report, and ask nothing/);
  });

  it('speckit-specify never asks what is settled, takes reasonable defaults, and asks least at tier 1', () => {
    const specify = commands.find((c) => c.name === 'speckit-specify')?.text ?? '';
    expect(specify).toMatch(
      /Never ask what the description, the brief or the\s+constitution already settles/,
    );
    expect(specify).toMatch(/reasonable default, listed under `## Assumptions`/);
    expect(specify).toMatch(/At tier 1, ask only when no reasonable default exists/);
  });

  it('speckit-implement and speckit-tasks ask for exactly one AC-### in each test’s own title', () => {
    expect(text('speckit-implement')).toMatch(/exactly one `AC-###` in its\s+own title/);
    expect(text('speckit-tasks')).toMatch(/its own title carries exactly one `AC-###`/);
  });

  it('speckit-implement builds one task and never edits tasks.md', () => {
    expect(text('speckit-implement')).toMatch(/Build this one task, and no other/);
    expect(text('speckit-implement')).toMatch(/Never edit `tasks\.md`/);
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
