// Property tests for the command guard (T076, T084): generated lines of the commands each role's
// shell runs are allowed; a denied command, alone or behind the wrappers and git's global options,
// as any command of such a line, refuses the line for every role, by a deny rule even where the
// Builder's prefixes would admit it; and any construct the tokenizer cannot fully analyse refuses
// it as unanalysable (AC-022, AC-067).
import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { checkBash } from '../../src/guard/command-guard.js';
import { loadPolicy } from '../../src/guard/policy.js';
import { tokenize } from '../../src/guard/tokenizer.js';
import { ROLES, type RoleName } from '../../src/model/types.js';

const policy = loadPolicy(
  readFileSync(new URL('../../factory/policy/roles.yaml', import.meta.url), 'utf8'),
);
const check = (role: string, command: string) =>
  checkBash(policy, { role, command, cwd: '/w/clone', home: '/home/o' });
const SHELLS = ROLES.filter((role) => policy.roles[role].shell.length > 0);
const EXCLUDE = "-- ':(exclude)*events.jsonl' ':(exclude).factory/events'";
const OPERATORS = [' && ', '; ', ' || ', ' | ', '\n'];

/** A plain argument, never a word the tokenizer refuses wherever it stands, such as `sh`. */
const arg = fc.stringMatching(/^[a-z0-9]{1,6}$/).filter((word) => tokenize(`x ${word}`).ok);

/** A command the role's shell runs: one of its prefixes, with plain arguments. */
const allowed = (role: RoleName) =>
  fc
    .tuple(fc.constantFrom(...policy.roles[role].shell), fc.array(arg, { maxLength: 3 }))
    .map(([prefix, args]) =>
      [prefix, ...args, ...(role === 'reviewer' && prefix === 'git diff' ? [EXCLUDE] : [])].join(
        ' ',
      ),
    );

/** A line of such commands, as the parts between its operators. */
const line = (role: RoleName) => fc.array(allowed(role), { minLength: 1, maxLength: 4 });
const join = (commands: string[], operators: number[]) =>
  commands
    .map((c, i) => c + (i < commands.length - 1 ? (OPERATORS[(operators[i] ?? 0) % 5] ?? '') : ''))
    .join('');

// Denied whatever the role. ADMITTED are refused by a deny rule even where a Builder prefix would
// admit them; an assignment stays in front, since behind nohup it would be the program's name.
const ADMITTED = ['git push', 'git push origin HEAD:main', 'git commit --amend']
  .concat(['git commit -a --amen', 'git log --output=x', 'npm test --script-shell=x'])
  .concat(['git show HEAD:.env', 'git diff ~/.ssh/id_ed25519', 'PATH=/x git status'])
  .concat(['npm test >x', 'git status &', 'git reset --hard', 'npm run x -- --outputFile=y']);
const DENIED = ADMITTED.concat(['gh pr merge 1', 'factory approve 1', 'npx factory merge 2'])
  .concat(['node dist/cli/main.js deploy', 'ssh-keygen -Y sign x', 'xargs git push'])
  .concat(['gh issue edit 1 --add-label state:x', 'gh issue edit 1 --remove-label pause:x'])
  .concat(['cd ..']);
const WRAPPED = ['', 'env ', 'env CI=1 ', 'command ', 'nohup ', 'nice ', 'timeout 5 '];
/** A denied command, behind any wrappers, git's kept global options before its subcommand. */
const denied = (from: string[]) =>
  fc
    .tuple(
      fc.constantFrom(...from),
      fc.array(fc.constantFrom(...WRAPPED), { maxLength: 2 }),
      fc.boolean(),
    )
    .map(([command, wrappers, pager]) =>
      command.includes('=') && /^[A-Z]/.test(command)
        ? command
        : wrappers.join('') + (pager ? command.replace(/^git /, 'git --no-pager ') : command),
    );

const UNANALYSABLE = ['git $(x)', 'ls *', 'git `x`', '(npm test)', 'eval x', "sh -c 'x'"].concat([
  'source x',
  'gh issue view <<<y',
  'diff <(x) y',
  'git {a,b}',
  'if true',
]);

/** The line with `command` as its command at `at`, among the role's own commands. */
const withCommand = (commands: string[], command: string, at: number) => {
  const i = at % (commands.length + 1);
  return [...commands.slice(0, i), command, ...commands.slice(i)];
};
const role = fc.constantFrom(...SHELLS);

describe('the command guard: properties (T076, T084)', () => {
  it("allows every line of the commands a role's shell runs", () => {
    fc.assert(
      fc.property(
        role.chain((r) => fc.tuple(fc.constant(r), line(r), fc.array(fc.nat()))),
        ([r, commands, operators]) => {
          expect(check(r, join(commands, operators))).toEqual({ allowed: true });
        },
      ),
      { numRuns: 500 },
    );
  });

  it('refuses a line with a denied command anywhere, behind any wrappers, for every role', () => {
    fc.assert(
      fc.property(
        role.chain((r) => fc.tuple(fc.constant(r), line(r), fc.array(fc.nat()))),
        denied(DENIED),
        fc.nat(),
        fc.constantFrom<string>(...ROLES, 'nobody'),
        ([r, commands, operators], command, at, other) => {
          const text = join(withCommand(commands, command, at), operators);
          expect(check(r, text).allowed, text).toBe(false);
          expect(check(other, text).allowed, `${other}: ${text}`).toBe(false);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('refuses those a Builder prefix admits by a deny rule, not only for being off the list', () => {
    fc.assert(
      fc.property(
        line('builder'),
        fc.array(fc.nat()),
        denied(ADMITTED),
        fc.nat(),
        (commands, operators, command, at) => {
          const decision = check('builder', join(withCommand(commands, command, at), operators));
          expect(decision.allowed).toBe(false);
          if (!decision.allowed) expect(decision.rule, command).not.toBe('allowlist');
        },
      ),
      { numRuns: 500 },
    );
  });

  it('refuses a line with any construct it cannot fully analyse as unanalysable', () => {
    fc.assert(
      fc.property(
        role.chain((r) => fc.tuple(fc.constant(r), line(r), fc.array(fc.nat()))),
        fc.constantFrom(...UNANALYSABLE),
        fc.nat(),
        ([r, commands, operators], command, at) => {
          const decision = check(r, join(withCommand(commands, command, at), operators));
          expect(decision.allowed ? 'allowed' : decision.rule).toBe('unanalysable');
        },
      ),
      { numRuns: 300 },
    );
  });
});
