// The command guard (T084): decides whether a role's session may run a Bash command, from the
// role table (`factory/policy/roles.yaml`) and the tokenizer (T083). It fails closed: a command the
// tokenizer cannot fully analyse is refused, and each simple command must pass every rule, in
// this order. No background `&`, and no `cd`, `pushd` or `popd`, so every path stays relative to
// the clone. Leading assignments only for names on the table's `assignments` allowlist, and never
// an assignment on its own, which changes the variable for the rest of the line. Redirections
// only to `/dev/null` and descriptor copies such as `2>&1`. Programs by name, never by path. The
// wrappers it sees through, `env`, `command`, `builtin`, `nohup`, `nice` and `timeout`, only
// without options but `timeout`'s duration, and git without global options but `--no-pager`, so
// `git -C`, `-c` or `--git-dir` cannot hide a subcommand. Then `deny_shell` and the role's
// `blocked` prefixes, and last the role's shell column, by prefix. Every reason says what to do
// instead, so a session does not retry the same refused shape, and goes through `visible()`, since
// it quotes the session's own command.
import { visible } from '../notify/summary.js';
import { ROLES, type RoleName } from '../model/types.js';
import type { Policy } from './policy.js';
import { tokenize, type Redirection, type SimpleCommand } from './tokenizer.js';

export type CommandRule =
  | 'unanalysable'
  | 'no-shell'
  | 'background'
  | 'cd'
  | 'assignment'
  | 'redirection'
  | 'path'
  | 'wrapper'
  | 'git-option'
  | 'deny-shell'
  | 'blocked'
  | 'allowlist';

export type CommandDecision =
  { allowed: true } | { allowed: false; rule: CommandRule; reason: string };

/** Wrappers the guard sees through to the command they run (also the launcher's alias check). */
export const WRAPPERS = ['env', 'command', 'builtin', 'nohup', 'nice', 'timeout'] as const;
const FOLDERS = new Set(['cd', 'pushd', 'popd']);
const GIT_KEPT = new Set(['--no-pager', '-P']);
const NAME_VALUE = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** The `deny_shell` entries the factory runs for a session; the others are the Owner's alone. */
const FACTORY_RUNS = new Set(['git push', 'gh pr create', 'gh pr ready']);
const DURATION = /^\d+(?:\.\d+)?[smhd]?$/;

/** What to do instead of each construct the tokenizer refuses, by the start of its reason. */
const INSTEAD: [RegExp, string][] = [
  [/^an expansion/, 'write the value out'],
  [/^a backquote/, 'run the inner command on its own, then write its output out'],
  [/^a glob/, 'quote the pattern, or use the Glob tool'],
  [/^a brace expansion/, 'write each word out'],
  [/^a tilde expansion/, 'write the path out, relative to the repository'],
  [/^a here-(document|string)/, 'write the text to a file with the Write tool'],
  [/^(a subshell|the keyword|a process substitution)/, 'run each command on its own'],
  [/^(eval|the shell)/, 'run the program itself, not through eval or a shell'],
  [/^the builtin/, 'run an allowed program directly; the shell builtins that run code are refused'],
];

class Refused extends Error {
  constructor(
    readonly rule: CommandRule,
    why: string,
  ) {
    super(why);
  }
}
const refuse = (rule: CommandRule, why: string): never => {
  throw new Refused(rule, why);
};

const startsWith = (words: string[], prefix: string) => {
  const parts = prefix.split(' ');
  return parts.every((part, i) => words[i] === part);
};

function checkAssignment(policy: Policy, name: string, written: string) {
  if (!Object.hasOwn(policy.assignments, name))
    refuse(
      'assignment',
      `the assignment ${written}, which can change what the command runs; write the value out as an argument, or leave it out (allowed: ${Object.keys(policy.assignments).join(', ')})`,
    );
}

function checkRedirection({ fd, op, target }: Redirection) {
  const written = `${fd ?? ''}${op}${target}`;
  if (op === '>&' || op === '<&') {
    if (/^(\d+|-)$/.test(target)) return;
  } else if (target === '/dev/null' && op !== '<>') return;
  if (/^\/dev\/(tcp|udp)\//.test(target))
    refuse('redirection', `the redirection ${written}, which opens a network connection`);
  refuse(
    'redirection',
    `the redirection ${written}; write a file with the Write tool or read one with the Read tool (only /dev/null and descriptor copies such as 2>&1 are allowed)`,
  );
}

/** The command a wrapper runs, refusing the wrapper's options and checking `env`'s assignments. */
function unwrap(policy: Policy, words: string[]): string[] {
  let rest = words;
  for (;;) {
    const [first = '', ...after] = rest;
    if (!(WRAPPERS as readonly string[]).includes(first)) return rest;
    let i = 0;
    if (first === 'timeout' && DURATION.test(after[0] ?? '')) i = 1;
    while (first === 'env' && NAME_VALUE.test(after[i] ?? '')) {
      const written = after[i] ?? '';
      checkAssignment(policy, written.slice(0, written.indexOf('=')), written);
      i += 1;
    }
    if (after[i]?.startsWith('-'))
      refuse('wrapper', `${first} ${after[i]}: run the command without ${first}'s options`);
    rest = after.slice(i);
  }
}

/** git's words without the kept global options, refusing every other global option. */
function gitWords(words: string[]): string[] {
  const rest = words.slice(1).filter((word, i, all) => {
    const global = all.slice(0, i + 1).every((w) => w.startsWith('-'));
    if (!global) return true;
    if (!GIT_KEPT.has(word))
      refuse('git-option', `git's global option ${word}; run git from the repository without it`);
    return false;
  });
  return ['git', ...rest];
}

function checkCommand(policy: Policy, role: RoleName, command: SimpleCommand) {
  if (command.then === '&')
    refuse('background', 'a command run in the background with &; run it in the foreground');
  for (const { name, value } of command.assignments)
    checkAssignment(policy, name, `${name}=${value}`);
  if (command.words.length === 0 && command.assignments.length > 0)
    refuse(
      'assignment',
      'an assignment on its own, which changes the variable for the rest of the line; write the value out where it is needed',
    );
  for (const redirection of command.redirections) checkRedirection(redirection);
  let words = unwrap(policy, command.words);
  const program = words[0] ?? '';
  if (FOLDERS.has(program))
    refuse(
      'cd',
      `${program}, which changes the folder; run each command from the repository's root, with paths relative to it`,
    );
  if (program.includes('/'))
    refuse('path', `the program ${program} by its path; run it by its name`);
  if (program === 'git') words = gitWords(words);
  const shown = words.join(' ');
  for (const prefix of policy.denyShell)
    if (startsWith(words, prefix))
      refuse(
        'deny-shell',
        `${shown}: no session runs ${prefix}; ${FACTORY_RUNS.has(prefix) ? 'commit your work, and the factory pushes it and opens the pull request' : 'only the Owner runs it'}`,
      );
  const row = policy.roles[role];
  for (const prefix of row.blocked)
    if (startsWith(words, prefix))
      refuse(
        'blocked',
        `${shown}: the ${role} role may not run ${prefix}${/^git (rebase|reset|commit --amend)/.test(prefix) ? '; no role rewrites a branch, so make a new commit instead' : ''}`,
      );
  if (!row.shell.some((prefix) => startsWith(words, prefix)))
    refuse(
      'allowlist',
      `${shown || 'a command with no program'}: not a command the ${role} role's shell runs; it runs ${row.shell.join(', ')}`,
    );
}

/** Whether `role`'s session may run `command`, and if not, the rule that refused it and why. */
export function checkBash(
  policy: Policy,
  input: { role: string; command: string },
): CommandDecision {
  const role = input.role as RoleName;
  try {
    if (!(ROLES as readonly string[]).includes(input.role) || policy.roles[role].shell.length === 0)
      refuse('no-shell', `the ${input.role} role has no shell; use the Read, Grep and Glob tools`);
    const result = tokenize(input.command);
    if (!result.ok) {
      const instead =
        INSTEAD.find(([start]) => start.test(result.reason))?.[1] ??
        'write the command out plainly';
      return refuse('unanalysable', `${result.reason}, which the guard cannot check; ${instead}`);
    }
    for (const command of result.commands) checkCommand(policy, role, command);
    return { allowed: true };
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    return { allowed: false, rule: error.rule, reason: visible(`refused: ${error.message}`) };
  }
}
