// The guards over a table of cases (T075). The command guard (T084): each role's shell runs only
// its own commands, and the guard fails closed on whatever it cannot check, with a reason that
// says what to do instead. The path and read guards' cases are slice 25f's.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkBash, WRAPPERS } from '../../src/guard/command-guard.js';
import { loadPolicy } from '../../src/guard/policy.js';
import { ROLES } from '../../src/model/types.js';

const policy = loadPolicy(
  readFileSync(new URL('../../factory/policy/roles.yaml', import.meta.url), 'utf8'),
);
const check = (role: string, command: string) => checkBash(policy, { role, command });
const refusal = (role: string, command: string) => {
  const decision = check(role, command);
  return decision.allowed ? 'allowed' : `${decision.rule}: ${decision.reason}`;
};

describe('the command guard: each role runs its own commands (T084, T075)', () => {
  it.each([
    ['builder', 'npm test'],
    ['builder', 'npm run lint && npm run typecheck'],
    ['builder', 'git status; git add src/a.ts && git commit -m "Add a"'],
    ['builder', 'npx vitest run tests/a.test.ts 2>&1'],
    ['builder', 'git --no-pager log --oneline -5'],
    ['builder', 'npm test >/dev/null 2>/dev/null'],
    ['builder', 'CI=1 npm test'],
    ['builder', 'env CI=1 NO_COLOR=1 npm test'],
    ['builder', 'timeout 300 npm test'],
    ['builder', 'npm test | npx vitest --help'],
    ['test', 'npm run test -- --reporter=dot'],
    ['reviewer', 'git diff origin/main'],
    ['reviewer', 'gh pr comment 7 --body-file reports/verify.md'],
    ['integrator', 'git merge origin/main'],
    ['integrator', 'git merge --abort'],
    ['integrator', 'git diff --name-only'],
    ['intake', 'gh issue view 12 >&2'],
    ['define', 'gh issue create --title x --body y'],
    ['release', 'git log --oneline origin/main'],
    ['security', 'gitleaks detect --no-git'],
    ['coach', 'gh pr list --state merged'],
  ])('allows %s: %j', (role, command) => {
    expect(check(role, command)).toEqual({ allowed: true });
  });

  it.each([
    [
      'intake',
      'cat .env',
      /allowlist: refused: cat \.env: not a command the intake role's shell runs; it runs gh issue/,
    ],
    ['builder', 'cat .env', /allowlist: .*it runs npm, npx vitest, vitest, git/],
    ['builder', 'ls', /allowlist/],
    [
      'reviewer',
      'gh pr merge 7',
      /deny-shell: .*no session runs gh pr merge; only the Owner runs it/,
    ],
    [
      'reviewer',
      'gh pr review 7 --approve',
      /blocked: .*the reviewer role may not run gh pr review/,
    ],
    ['reviewer', 'git log', /allowlist: .*it runs git diff, gh pr comment/],
    ['integrator', 'git merge origin/other', /allowlist/],
    ['integrator', 'git commit -m x', /blocked/],
    ['test', 'npm install left-pad', /allowlist/],
    ['coach', 'gh pr view 1 && gh issue edit 1', /allowlist: refused: gh issue edit 1/],
    ['release', 'git tag v1', /blocked: .*the release role may not run git tag$/],
  ])('refuses %s: %j', (role, command, reason) => {
    expect(refusal(role, command)).toMatch(reason);
  });

  it("refuses every role the pushes and the Owner's commands of deny_shell, saying who runs them", () => {
    for (const role of ROLES.filter((r) => policy.roles[r].shell.length > 0)) {
      expect(refusal(role, 'git push origin HEAD'), role).toMatch(
        /deny-shell: .*commit your work, and the factory pushes it/,
      );
      expect(refusal(role, 'gh pr create --draft'), role).toMatch(/deny-shell/);
      expect(refusal(role, 'factory approve 12'), role).toMatch(/deny-shell: .*only the Owner/);
      expect(refusal(role, 'ssh-keygen -Y sign -f k -n file x'), role).toMatch(/deny-shell/);
    }
  });

  it('gives a role with no shell, and an unknown role, no shell at all', () => {
    for (const role of ['spec', 'planner', 'nobody', ''] as string[])
      expect(refusal(role, 'git status'), role).toMatch(/^no-shell: .*has no shell; use the Read/);
  });

  it('refuses no-rewrite prefixes with what to do instead', () => {
    expect(refusal('builder', 'git reset --hard HEAD~1')).toMatch(
      /blocked: .*no role rewrites a branch, so make a new commit instead/,
    );
    expect(refusal('define', 'git rebase origin/main')).toMatch(/blocked/);
  });
});

describe('the command guard: what it refuses before the allowlist (T084, T075)', () => {
  it.each([
    // What the tokenizer cannot analyse, each with what to do instead.
    ['git $(echo push)', /unanalysable: .*cannot check; write the value out/],
    [
      'ls *.ts',
      /unanalysable: refused: a glob character \*, .*quote the pattern, or use the Glob tool/,
    ],
    ['git commit -F- <<EOF', /unanalysable: .*write the text to a file with the Write tool/],
    ['(npm test)', /unanalysable: .*run each command on its own/],
    ["bash -c 'npm test'", /unanalysable: .*not through eval or a shell/],
    ['source .env', /unanalysable: .*builtins that run code are refused/],
    ['npm test {a,b}', /unanalysable: .*write each word out/],
    // A command in the background, or one that changes the folder.
    ['npm test &', /background: .*run it in the foreground/],
    [
      'cd src && npm test',
      /cd: refused: cd, which changes the folder; run each command from the repository's root/,
    ],
    ['pushd src', /^cd: /],
    ['popd', /^cd: /],
    ['command cd /', /^cd: /],
    ['builtin cd src', /^cd: /],
    // Leading assignments, default-no.
    [
      'PATH=/tmp/x npm test',
      /assignment: refused: the assignment PATH=\/tmp\/x, .*\(allowed: CI, NO_COLOR\)/,
    ],
    ['GIT_DIR=../other/.git git status', /^assignment: /],
    ['CI=1 LD_PRELOAD=./x.so npm test', /assignment: .*LD_PRELOAD/],
    ['env GIT_SSH_COMMAND=x git status', /assignment: .*GIT_SSH_COMMAND/],
    ['PATH=/tmp/x; git status', /assignment: .*PATH/],
    ['CI=1; npm test', /assignment: refused: an assignment on its own/],
    // Names the allowlist has only through its prototype.
    ['toString=1 npm test', /^assignment: /],
    ['constructor=x npm test', /^assignment: /],
    ['env __proto__=x npm test', /^assignment: /],
    // Redirections: only /dev/null and descriptor copies.
    [
      'npm test > out.txt',
      /redirection: refused: the redirection >out\.txt; write a file with the Write tool or read one with the Read tool/,
    ],
    ['npm test 2>>log', /redirection: .*2>>log/],
    ['git commit -F - < ~/.ssh/id_ed25519', /^redirection: /],
    ['npm test >&out', /^redirection: /],
    ['npm test <>/dev/null', /^redirection: /],
    ['npm test >/dev/tcp/example.com/80', /redirection: .*which opens a network connection/],
    ['npm test 2>/dev/udp/1.2.3.4/53', /network connection/],
    // Programs by name only.
    [
      './node_modules/.bin/vitest',
      /path: refused: the program \.\/node_modules\/\.bin\/vitest by its path; run it by its name/,
    ],
    ['/usr/bin/git status', /^path: /],
    ['env /usr/bin/git status', /^path: /],
    // Wrappers without options, and git without global options.
    ['env -S "git push"', /wrapper: refused: env -S: run the command without env's options/],
    ['env -i git status', /^wrapper: /],
    ['env -C .. git status', /^wrapper: /],
    ['command -p git status', /^wrapper: /],
    ['timeout -s KILL 5 npm test', /^wrapper: /],
    ['nice -n 5 npm test', /^wrapper: /],
    [
      'git -C ../other status',
      /git-option: refused: git's global option -C; run git from the repository without it/,
    ],
    ['git -c core.pager=x log', /git-option: .*-c/],
    ['git --git-dir=../x/.git status', /git-option/],
    ['git --work-tree=/ status', /git-option/],
    ['git --exec-path=. status', /git-option/],
  ])('refuses the builder %j', (command, reason) => {
    expect(refusal('builder', command)).toMatch(reason);
  });

  it("sees through the wrappers and git's global options to the command they run", () => {
    expect(refusal('builder', 'env git push')).toMatch(/^deny-shell: refused: git push: /);
    expect(refusal('builder', 'command nohup timeout 5 git push')).toMatch(/^deny-shell: /);
    expect(refusal('builder', 'nice builtin git --no-pager push')).toMatch(/^deny-shell: /);
    expect(refusal('builder', 'git -P reset --hard')).toMatch(/^blocked: /);
    expect(refusal('integrator', 'git --no-pager merge origin/main')).toBe('allowed');
    expect(refusal('builder', 'env')).toMatch(/allowlist: refused: a command with no program/);
    expect(WRAPPERS).toEqual(['env', 'command', 'builtin', 'nohup', 'nice', 'timeout']);
  });

  it('checks every command of a line, and refuses the line for any one', () => {
    expect(refusal('builder', 'npm test && git status && git push')).toMatch(/^deny-shell: /);
    expect(refusal('builder', 'git status\ncurl -s x')).toMatch(/allowlist: refused: curl -s x/);
    expect(refusal('builder', 'npm test || cat .env')).toMatch(/allowlist: refused: cat \.env/);
  });

  it("shows the session's own text in a reason only through visible()", () => {
    const decision = check('builder', 'cat "a\u001b[2Jb‮"');
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toContain('a\\u{1b}[2Jb\\u{202e}');
    expect(decision.reason).not.toMatch(/[\u001b‮]/);
  });
});
