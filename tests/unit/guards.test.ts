// The guards over a table of cases (T075). The command guard (T084): each role's shell runs only
// its own commands, and the guard fails closed on whatever it cannot check, with a reason that
// says what to do instead; the deny rules come first. The path and read guards' cases are slice
// 25f's.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkBash, WRAPPERS } from '../../src/guard/command-guard.js';
import { loadPolicy } from '../../src/guard/policy.js';
import { ROLES } from '../../src/model/types.js';

const policy = loadPolicy(
  readFileSync(new URL('../../factory/policy/roles.yaml', import.meta.url), 'utf8'),
);
const PLACES = { cwd: '/w/clone', home: '/home/o' };
const check = (role: string, command: string) => checkBash(policy, { role, command, ...PLACES });
const EXCLUDE = "-- ':(exclude)*events.jsonl' ':(exclude).factory/events'";
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
    ['reviewer', `git diff origin/main ${EXCLUDE}`],
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
    ['intake', 'cat .env', /read: refused: \.env, a path no session may read \(\*\*\/\.env\*\)/],
    [
      'intake',
      'cat notes.md',
      /allowlist: refused: cat notes\.md: not a command the intake role's shell runs; it runs gh issue/,
    ],
    ['builder', 'cat notes.md', /allowlist: .*it runs npm test, npm run, npm ci, npm install, npx/],
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
      expect(refusal(role, 'factory approve 12'), role).toMatch(/owner-only: .*only the Owner/);
      expect(refusal(role, 'ssh-keygen -Y sign -f k -n file x'), role).toMatch(/owner-only/);
    }
  });

  it('gives a role with no shell, and an unknown role, no shell at all', () => {
    for (const role of ['spec', 'planner', 'nobody', ''] as string[])
      expect(refusal(role, 'git status'), role).toMatch(/^no-shell: .*has no shell; use the Read/);
  });

  it('refuses a rewrite with what to do instead', () => {
    expect(refusal('builder', 'git reset --hard HEAD~1')).toMatch(
      /rewrite: .*no role rewrites a branch; make a new commit instead/,
    );
    expect(refusal('define', 'git rebase origin/main')).toMatch(/^rewrite: /);
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
    expect(refusal('builder', 'git -P reset --hard')).toMatch(/^rewrite: /);
    expect(refusal('integrator', 'git --no-pager merge origin/main')).toBe('allowed');
    expect(refusal('builder', 'env')).toMatch(/allowlist: refused: a command with no program/);
    expect(WRAPPERS).toEqual(['env', 'command', 'builtin', 'nohup', 'nice', 'timeout']);
  });

  it('checks every command of a line, and refuses the line for any one', () => {
    expect(refusal('builder', 'npm test && git status && git push')).toMatch(/^deny-shell: /);
    expect(refusal('builder', 'git status\ncurl -s x')).toMatch(/allowlist: refused: curl -s x/);
    expect(refusal('builder', 'npm test || cat x')).toMatch(/allowlist: refused: cat x/);
  });

  it("shows the session's own text in a reason only through visible()", () => {
    const decision = check('builder', 'cat "a\u001b[2Jb‮"');
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toContain('a\\u{1b}[2Jb\\u{202e}');
    expect(decision.reason).not.toMatch(/[\u001b‮]/);
  });
});

describe('the command guard: the deny rules, and what to use instead (T084, T075)', () => {
  it.each([
    // An empty line, and >&/dev/null, the same as &>/dev/null.
    ['builder', '', /^empty: refused: an empty command, with nothing to run/],
    ['builder', '  \n\t\n', /^empty: /],
    ['builder', '# only a comment', /^empty: /],
    ['builder', 'npm test >&/dev/null', /^allowed$/],
    // Options that write a file, any program's.
    [
      'reviewer',
      `git diff --output=.station.json HEAD ${EXCLUDE}`,
      /option: refused: the option --output=\.station\.json, which writes a file; write files with the Write tool/,
    ],
    ['release', 'git log --output=/tmp/x', /^option: .*writes a file/],
    ['security', 'semgrep --output x', /^option: .*writes a file/],
    ['security', 'gitleaks detect --report-path x', /^option: .*writes a file/],
    ['security', 'semgrep -o x', /^option: /],
    ['security', 'semgrep --sarif-output=x', /^option: .*writes a file/],
    ['security', 'gitleaks detect -r x', /^option: /],
    ['builder', 'git log --outp=x', /^option: .*writes a file/],
    ['builder', 'git format-patch -o out HEAD~1', /^option: /],
    ['builder', 'git diff --output-directory=x', /^option: .*writes a file/],
    ['builder', 'npx vitest run --outputFile=x.json', /^option: .*writes a file/],
    ['test', 'npm test -- --coverage.reportsDirectory=x', /^option: .*writes a file/],
    // Options that run a program or read settings from elsewhere, shortened too.
    ['builder', 'npm test --script-shell=python3', /option: .*runs a program; leave it out/],
    ['builder', 'npm test --script-sh=python3', /^option: /],
    ['builder', 'npm --prefix ../other test', /^option: /],
    ['builder', 'npm -C ../other test', /^option: /],
    ['builder', 'npm run x --node-options=--require=y', /^option: /],
    ['builder', 'git grep -O x', /^option: /],
    ['builder', 'git grep --open-files-in-pager=x y', /^option: /],
    // Short options in a cluster, an attached argument with them, and the same spelled apart.
    ['security', 'semgrep -qo x', /option: refused: the option -qo, /],
    ['security', 'semgrep -q -o x', /^option: /],
    ['security', 'gitleaks detect -vr x', /^option: /],
    ['security', 'gitleaks detect -v -r x', /^option: /],
    ['builder', 'git grep -hOless x', /option: refused: the option -hOless, .*runs a program/],
    ['define', 'git grep -h -O less x', /^option: /],
    // Digits in a cluster, which git reads on past, as click and pflag may.
    ['builder', 'git grep -3Oecho x', /^option: /],
    ['define', 'git grep -n3Oecho x', /^option: /],
    ['security', 'semgrep -1o x', /^option: /],
    ['security', 'gitleaks detect -5r x', /^option: /],
    // A refused letter after another letter: perhaps a value, so the reason says to split it.
    [
      'builder',
      'git log -Sfoo',
      /option: .*put the option's value in a separate word, such as git log -S foo$/,
    ],
    ['builder', 'git commit -m x -docs', /put the option's value in a separate word/],
    ['builder', 'git grep -O x', /option: .*runs a program; leave it out$/],
    ['builder', 'git log -S foo', /^allowed$/],
    ['builder', 'git log -n5 --oneline', /^allowed$/],
    ['security', 'semgrep -q --metrics=off x', /^allowed$/],
    // The Owner's commands in any form.
    [
      'builder',
      'npx factory approve 3',
      /owner-only: refused: factory approve: only the Owner runs it/,
    ],
    ['builder', 'npm exec factory merge 3', /^owner-only: /],
    ['builder', 'npx factory@1.2.0 resume', /^owner-only: /],
    ['builder', 'node dist/cli/main.js deploy', /^owner-only: /],
    ['intake', 'gh issue view 1 && npx --yes factory keygen', /^owner-only: /],
    [
      'builder',
      'ssh-keygen -f k -Y sign -n file x',
      /owner-only: refused: ssh-keygen -Y sign: only the Owner signs/,
    ],
    ['builder', 'ssh-keygen -Ysign x', /^owner-only: /],
    // Rewrites in any form, shortened options too.
    ['builder', 'git commit -a --amend', /^rewrite: /],
    ['builder', 'git commit --amen -m x', /^rewrite: /],
    ['builder', 'git commit --am', /^rewrite: /],
    ['builder', 'git update-ref refs/heads/x HEAD', /^rewrite: /],
    ['builder', 'git replace a b', /^rewrite: /],
    ['builder', 'git filter-branch', /^rewrite: /],
    ['builder', 'git commit --allow-empty -m x', /^allowed$/],
    // Named as rewrites, so a wider list later still refuses them.
    ['builder', 'git branch -f main HEAD~1', /^rewrite: /],
    ['builder', 'git checkout -B x', /^rewrite: /],
    ['builder', 'git switch -C x', /^rewrite: /],
    ['builder', 'git cherry-pick abc', /^rewrite: /],
    ['define', 'git notes add -m x', /^rewrite: /],
    // The force options in a cluster, and in git's shortened long forms, no shorter than git takes.
    ['builder', 'git branch -vf x y', /^rewrite: /],
    ['builder', 'git checkout -qB x', /^rewrite: /],
    ['builder', 'git switch -qC x', /^rewrite: /],
    ['builder', 'git branch --forc x y', /^rewrite: /],
    ['builder', 'git branch --force x y', /^rewrite: /],
    ['builder', 'git switch --force- x', /^rewrite: /],
    ['builder', 'git switch --force-c x', /^rewrite: /],
    ['builder', 'git branch --for x y', /^allowlist: /],
    ['builder', 'git switch --force x', /^allowlist: /],
    // Names an option table has only through its prototype.
    ['builder', 'git constructor -f x', /^allowlist: /],
    ['builder', 'git toString -B x', /^allowlist: /],
    // xargs into git or gh.
    ['builder', 'xargs git push', /xargs: refused: xargs git push: xargs into git or gh/],
    ['intake', 'xargs -n1 gh issue close', /^xargs: /],
    // Labels the factory and the Owner change.
    [
      'intake',
      'gh issue edit 1 --add-label state:approved',
      /label: refused: adding the label state:approved; only the factory and the Owner/,
    ],
    ['ops', 'gh issue edit 1 --add-label=Owner:me', /^label: /],
    [
      'ops',
      'gh issue edit 1 --remove-label pause:line',
      /label: refused: removing the label pause:line/,
    ],
    ['ops', 'gh issue edit 1 --remove-label state:x', /^label: /],
    ['define', 'gh issue create -t x -b y -l state:x', /^label: /],
    ['define', 'gh issue create -t x -b y -lSTATE:x', /^label: /],
    ['define', 'gh issue create -t x -b y --label bug,state:x', /^label: /],
    [
      'intake',
      "gh api repos/o/r/issues/1/labels -f 'labels[]=x'",
      /label: refused: gh api on labels/,
    ],
    ['ops', 'gh issue edit 1 --add-label pause:line', /^allowed$/],
    ['ops', 'gh issue edit 1 --add-label bug', /^allowed$/],
    ['ops', 'gh issue -R o/r edit 1 --add-label state:x', /^label: /],
    ['ops', 'gh issue --repo o/r edit 1 --add-label=owner:x', /^label: /],
    ['intake', 'gh issue list --label state:approved', /^allowed$/],
    ['intake', 'gh issue -R o/r list -l state:approved', /^allowed$/],
    // Paths no session may read, ~ after = or : as home.
    ['builder', 'git show HEAD:.env', /read: refused: HEAD:\.env, a path no session may read/],
    [
      'builder',
      'git diff --no-index ~/.factory/keys/approve_ed25519 x',
      /read: .*\(~\/\.factory\/\*\*\)/,
    ],
    ['builder', 'git diff a=~/.gitconfig', /^read: /],
    ['builder', 'git log x:~/.ssh/id_ed25519', /^read: /],
    ['builder', 'git grep x -- ../../home/o/.ssh/id_ed25519', /^read: .*\(~\/\.ssh\/\*\*\)/],
    ['builder', 'git add src/.env.local', /^read: /],
    ['builder', 'git show HEAD:src/env.ts', /^allowed$/],
    // The Reviewer's git diff leaves out the event logs.
    [
      'reviewer',
      'git diff origin/main',
      /pathspec: .*end it with -- ':\(exclude\)\*events\.jsonl' ':\(exclude\)\.factory\/events'/,
    ],
    ['reviewer', "git diff origin/main -- ':(exclude)*events.jsonl'", /^pathspec: /],
    [
      'reviewer',
      "git diff origin/main ':(exclude)*events.jsonl' ':(exclude).factory/events'",
      /^pathspec: /,
    ],
    // A command off the list, with what to use instead.
    [
      'builder',
      'git checkout -- src/a.ts',
      /allowlist: .*use git restore for a file; the session stays on its branch; it runs/,
    ],
    ['builder', 'git switch -c x', /use nothing: the session stays on the branch/],
    ['builder', 'git fetch origin main', /use nothing: the factory fetches/],
    ['builder', 'git config alias.x status', /use nothing: the factory sets git's config/],
    ['builder', 'npm i left-pad', /use npm install;/],
    ['builder', 'npx tsc', /use npm run, with a script in package\.json;/],
  ])('%s: %j', (role, command, expected) => {
    expect(refusal(role, command)).toMatch(expected);
  });

  it('refuses each program that runs a string of its own, for the Builder and Define', () => {
    for (const role of ['builder', 'define'])
      for (const command of [
        "env -S 'git status'",
        "npm exec -c 'git status'",
        "npm x -c 'git status'",
      ].concat(["npx -c 'git status'", 'npm exec -- npm test']))
        expect(check(role, command).allowed, `${role}: ${command}`).toBe(false);
  });
});
