// Contract tests for `factory ci weakened` (T161, AC-061): a test that passed at the merge base
// (base tests on base sources) and is skipped, todo or missing at the head (head tests on head
// sources) is a finding named by its `test:<path>#<title>` target; a deleted test file is one
// `test:<path>` finding. CI reads no waivers, so each finding names the waiver that would cover it.
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/commands.js';
import { gitEnv, makeRepo, type TestRepo } from '../helpers/git-repo.js';

const laptop: NodeJS.ProcessEnv = { ...gitEnv, GITHUB_ACTIONS: undefined };

const CALC_TESTS = (body: string[]) =>
  [
    "import { describe, expect, it } from 'vitest';",
    "import { add } from '../src/calc.js';",
    "describe('math', () => {",
    ...body,
    '});',
    '',
  ].join('\n');

/** main: passing tests in two files, and one already failing; the item branch checked out. */
function project() {
  const repo = makeRepo({
    files: {
      '.gitignore': 'node_modules/\ncoverage/\n',
      'src/calc.ts': 'export const add = (a: number, b: number) => a + b;\n',
      'tests/calc.test.ts': CALC_TESTS([
        "  it('adds', () => { expect(add(1, 2)).toBe(3); });",
        "  it('adds zero', () => { expect(add(1, 0)).toBe(1); });",
        "  it('adds negatives', () => { expect(add(-1, -2)).toBe(-3); });",
        "  it('stays', () => { expect(add(0, 0)).toBe(0); });",
        "  it('breaks at the head', () => { expect(add(2, 2)).toBe(4); });",
        "  it('already failing', () => { expect(add(1, 1)).toBe(3); });",
        "  it('adds twos', () => { expect(add(2, 3)).toBe(5); });",
        "  it('adds threes', () => { expect(add(3, 3)).toBe(6); });",
        "  it.fails('inverted at the base', () => { expect(add(1, 1)).toBe(3); });",
      ]),
      'tests/old.test.ts':
        "import { expect, it } from 'vitest';\nit('old one', () => { expect(1).toBe(1); });\nit('old two', () => { expect(2).toBe(2); });\n",
    },
  });
  const base = repo.revParse('HEAD');
  repo.checkout('claude/42-calc', { create: true });
  return { repo, base };
}

async function ci(repo: TestRepo, args: string[]) {
  const out: string[] = [];
  const code = await runCli(['ci', 'weakened', ...args], {
    stdout: { write: (s: string) => void out.push(s) },
    stderr: { write: (s: string) => void out.push(s) },
    env: laptop,
    stdinIsTTY: false,
    cwd: repo.path,
    unreadAlerts: () => Promise.reject(new Error('ci must not read the inbox')),
  });
  return { code, output: out.join('') };
}

const RUN = 120_000;

describe('factory ci weakened (AC-061)', () => {
  it(
    'AC-061: a test passing at the base and skipped, todo, missing, in fails mode or passing only after a retry at the head is a finding by its test:<path>#<title> target',
    async () => {
      const { repo, base } = project();
      const head = repo.commit(
        {
          'src/calc.ts':
            'export const add = (a: number, b: number) => a + b + (a === 2 ? 1 : 0);\n',
          'tests/calc.test.ts': CALC_TESTS([
            "  it.skip('adds', () => { expect(add(1, 2)).toBe(3); });",
            "  it.todo('adds zero');",
            "  it('stays', () => { expect(add(0, 0)).toBe(0); });",
            "  it('breaks at the head', () => { expect(add(2, 2)).toBe(4); });",
            "  it.skip('already failing', () => { expect(add(1, 1)).toBe(3); });",
            // The code is broken for 2, and the test inverted so it still reports a pass.
            "  it.fails('adds twos', () => { expect(add(2, 3)).toBe(5); });",
            '  let tries = 0;',
            "  it('adds threes', { retry: 3 }, () => { tries += 1; expect(tries).toBe(2); });",
            "  it.fails('inverted at the base', () => { expect(add(1, 1)).toBe(3); });",
          ]),
          // The project's own config cannot hide the tests: the factory's Vitest runs them.
          'vitest.config.ts': 'export default { test: { include: ["nothing/**"] } };\n',
        },
        'weaken',
      );

      const r = await ci(repo, [base, head]);

      expect(r.code).toBe(1);
      const waiver = (target: string) => `a ${target} waiver for ${head} covers it`;
      expect(r.output).toContain(
        `test:tests/calc.test.ts#math adds: passed at the base, skipped at the head; ${waiver('test:tests/calc.test.ts#math adds')}`,
      );
      expect(r.output).toContain(
        'test:tests/calc.test.ts#math adds zero: passed at the base, todo at the head',
      );
      expect(r.output).toContain(
        'test:tests/calc.test.ts#math adds negatives: passed at the base, missing at the head',
      );
      expect(r.output).toContain(
        'test:tests/calc.test.ts#math adds twos: passed at the base, in fails mode at the head',
      );
      expect(r.output).toContain(
        'test:tests/calc.test.ts#math adds threes: passed at the base, passed only after 1 retry at the head',
      );
      // Failing at the head is the test job's finding; failing at the base was never weakened.
      expect(r.output).not.toMatch(/#math stays|#math breaks|#math already failing|#math inverted/);
      expect(r.output).toContain('9 tests passed at the merge base');
    },
    RUN,
  );

  it(
    'AC-061: a deleted test file is one test:<path> finding; an unchanged branch passes',
    async () => {
      const { repo, base } = project();
      expect(await ci(repo, [base, 'HEAD'])).toMatchObject({ code: 0 });
      const head = repo.commit({ 'tests/old.test.ts': null }, 'delete');

      const r = await ci(repo, [base, head]);

      expect(r.code).toBe(1);
      expect(r.output).toContain(
        `test:tests/old.test.ts: passed at the base, file deleted; a test:tests/old.test.ts waiver for ${head} covers it`,
      );
      expect(r.output).not.toContain('#old');
    },
    RUN,
  );
});
