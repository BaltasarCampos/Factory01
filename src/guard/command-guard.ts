// The command guard (T084): decides whether a role's session may run a Bash command, from the
// role table (`factory/policy/roles.yaml`) and the tokenizer (T083). It fails closed: a command the
// tokenizer cannot fully analyse is refused, and each simple command must pass every rule, in
// this order. No background `&`, and no `cd`, `pushd` or `popd`, so every path stays relative to
// the clone. Leading assignments only for names on the table's `assignments` allowlist, and never
// an assignment on its own, which changes the variable for the rest of the line. Redirections
// only to `/dev/null` and descriptor copies such as `2>&1`. Programs by name, never by path. The
// wrappers it sees through, `env`, `command`, `builtin`, `nohup`, `nice` and `timeout`, only
// without options but `timeout`'s duration, and git without global options but `--no-pager`, so
// `git -C`, `-c` or `--git-dir` cannot hide a subcommand. Then the deny rules: the Owner's commands
// in any form, `deny_shell`, a rewrite in any form, the role's `blocked` prefixes, `xargs` into git
// or gh, an `owner:` or `state:` label added or removed or a `pause:` label removed, an option
// that writes a file or runs a program, any program's, and a path no session may read, `~` after
// `=` or `:` as home, `/proc`, `/sys` and `/dev` among them, since they show the session's
// environment and its gh token; gh's options that read a file only for one in the clone; `npm
// run env`; Test's snapshot updates; the Reviewer's `git diff` must leave out the event logs. Last
// the role's shell column, by prefix. An empty line is refused. Every reason says what to do
// instead, so a session does not retry the same refused shape, and goes through `visible()`, since
// it quotes the session's own command.
import { visible } from '../notify/summary.js';
import { ROLES, type RoleName } from '../model/types.js';
import { absolute, deniedRead, inside, PathError, realPath, systemFolder } from './paths.js';
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
  | 'empty'
  | 'owner-only'
  | 'rewrite'
  | 'xargs'
  | 'label'
  | 'option'
  | 'read'
  | 'environment'
  | 'pathspec'
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
const OWNER = new Set(['approve', 'merge', 'deploy', 'resume', 'keygen']);
/** The factory's command, by name, as a package or as its built entry point. */
const FACTORY = /(^|\/)factory(@[^/]*)?$|(^|\/)cli\/main\.js$/;
/** git subcommands that rewrite a branch or the repository's refs. */
const REWRITES = new Set([
  'rebase',
  'reset',
  'update-ref',
  'filter-branch',
  'filter-repo',
  'replace',
  'cherry-pick',
  'notes',
]);
/**
 * Options that move or recreate a branch, by subcommand: the letter, in any cluster, and the long
 * form with the shortest prefix git accepts (`--forc`, since `--for` could be `--format`).
 */
const FORCES: Record<string, { letters: string; long?: string; shortest?: number }> = {
  // -M and -C rename and copy over an existing branch; their long forms add --force.
  branch: { letters: 'fMC', long: '--force', shortest: 6 },
  checkout: { letters: 'B' },
  switch: { letters: 'C', long: '--force-create', shortest: 8 },
};
/** A word's cluster of short options: git reads on past digits, as in `-3O<program>`. */
const cluster = (word: string) =>
  word.startsWith('--') ? '' : (/^-([A-Za-z0-9]+)/.exec(word)?.[1] ?? '');
/** Long options that write a file, by part of their name, such as `--outputFile`. */
const WRITES = /output|outfile|out-?dir|report-?path|reports-?dir/i;
/** Long options that run a program or read settings from elsewhere; git and npm take a prefix. */
const RUNS = [
  '--script-shell',
  '--node-options',
  '--prefix',
  '--userconfig',
  '--globalconfig',
].concat(['--call', '--upload-pack', '--receive-pack', '--exec', '--open-files-in-pager']);
/**
 * Short options that write a file or run a program, by program, `o` for every program; any letter
 * of a cluster such as `-qo` counts, an attached argument such as `-O<program>` with it.
 */
const SHORT: Record<string, string> = { git: 'O', gitleaks: 'r', npm: 'cC' };
const EXCLUDES = [':(exclude)*events.jsonl', ':(exclude).factory/events'];
/** What to use instead of a command off the role's list, by its first words. */
const BRANCH = 'nothing: the session stays on the branch the factory checked out';
const SCRIPT = 'npm run, with a script in package.json';
const USE: [string, string][] = [
  ['git checkout', 'git restore for a file; the session stays on its branch'],
  ['git switch', BRANCH],
  ['git branch', BRANCH],
  ['git fetch', 'nothing: the factory fetches'],
  ['git pull', 'nothing: the factory fetches'],
  ['git config', "nothing: the factory sets git's config"],
  ['git clean', 'git rm or git restore'],
  ['npm i', 'npm install'],
  ['npm t', 'npm test'],
  ['npm run-script', 'npm run'],
  ['npm exec', SCRIPT],
  ['npm x', SCRIPT],
  ['npx', SCRIPT],
  ['npm init', 'the Write tool for package.json'],
];

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
    if (/^(\d+|-)$/.test(target) || (op === '>&' && target === '/dev/null')) return;
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

/** Where the session runs: the hook input's `cwd`, its clone and the home folder `~` stands for. */
interface Places {
  cwd: string;
  clone: string;
  home: string;
}

/** The Owner's commands in any form: `npx factory approve`, `node dist/cli/main.js merge`. */
function checkOwner(words: string[]) {
  const at = words.findIndex((word) => FACTORY.test(word));
  const command = words.slice(at + 1).find((word) => OWNER.has(word));
  if (at >= 0 && command !== undefined)
    refuse('owner-only', `factory ${command}: only the Owner runs it`);
  const keygen = words.findIndex((word) => /(^|\/)ssh-keygen$/.test(word));
  const rest = words.slice(keygen + 1);
  if (keygen >= 0 && rest.some((w, i) => w === '-Ysign' || (w === '-Y' && rest[i + 1] === 'sign')))
    refuse('owner-only', 'ssh-keygen -Y sign: only the Owner signs');
}

/** A label change the factory and the Owner make: `owner:` and `state:`, or removing `pause:`. */
function checkLabels(words: string[]) {
  if (words[0] !== 'gh') return;
  const why = 'only the factory and the Owner change owner:, state: and pause: labels';
  if (words[1] === 'api' && words.some((word) => /labels/i.test(word)))
    refuse('label', `gh api on labels; ${why}`);
  // Only `list` filters by label; options before the subcommand, `-R <repo>` too, are skipped.
  let at = 2;
  while (words[at]?.startsWith('-')) at += words[at] === '-R' || words[at] === '--repo' ? 2 : 1;
  if (words[at] === 'list') return;
  words.forEach((word, i) => {
    const option =
      /^(--add-label|--remove-label|--label|-l)(?:=(.*))?$/.exec(word) ?? /^(-l)(.+)$/.exec(word);
    if (option === null) return;
    const removing = option[1] === '--remove-label';
    for (const label of (option[2] ?? words[i + 1] ?? '').split(',').map((l) => l.trim()))
      if (/^(owner|state):/i.test(label) || (removing && /^pause:/i.test(label)))
        refuse('label', `${removing ? 'removing' : 'adding'} the label ${label}; ${why}`);
  });
}

/** Options that write a file or run a program, for every program. */
function checkOptions(words: string[]) {
  const program = words[0] ?? '';
  const refused = `o${Object.hasOwn(SHORT, program) ? (SHORT[program] ?? '') : ''}`;
  for (const word of words.slice(1)) {
    const name = word.split('=')[0] ?? '';
    const long = name.startsWith('--') && name.length >= 4;
    if ((long && WRITES.test(name)) || (long && '--output'.startsWith(name)))
      refuse('option', `the option ${word}, which writes a file; write files with the Write tool`);
    const at = cluster(word)
      .split('')
      .findIndex((letter) => refused.includes(letter));
    if (long ? RUNS.some((run) => run.startsWith(name)) : at >= 0)
      refuse(
        'option',
        `the option ${word}, which writes a file or runs a program; ${at > 0 ? "if this is the option's value, put it in a separate word, such as git log -S foo; otherwise leave the option out" : 'leave it out'}`,
      );
  }
}

/**
 * A path no session may read, in a word, after its `=`, `:` or `@` or after a short option's
 * letter or cluster, `~` there as home: `deny_read`, and `/proc`, `/sys` and `/dev`, which show the session's
 * environment, for every program.
 */
function checkReads(policy: Policy, { cwd, home }: Places, words: string[]) {
  for (const word of words.slice(1)) {
    const attached = /^-[A-Za-z]+?([/~.].*)$/.exec(word)?.[1] ?? /^-[A-Za-z](.+)$/.exec(word)?.[1];
    for (const part of [word, ...word.split(/[=:@]/).slice(1), attached ?? '']) {
      if (part === '') continue;
      const path = absolute(part, cwd, home);
      const denied = deniedRead(policy, home, path);
      if (denied !== undefined)
        refuse('read', `${word}, a path no session may read (${denied}); leave it out`);
      if (systemFolder(path) !== undefined)
        refuse('read', `${word}: no session reads /proc, /sys or /dev, which show its environment`);
    }
  }
}

/**
 * gh's options that read a file whose text it posts: `--body-file` and `-F` on issue and pr
 * commands, `--input` and a `-F`/`--field` value `<key>=@<path>` on gh api. The file must be in
 * the clone, by its named and its real path, so no comment carries a file from elsewhere (T061).
 */
function checkGhFiles({ cwd, clone, home }: Places, words: string[]) {
  if (words[0] !== 'gh') return;
  const api = words[1] === 'api';
  words.forEach((word, i) => {
    const long = /^(--[a-z-]+)(?:=(.*))?$/s.exec(word);
    // A short-option cluster, such as `-wF<file>`, with the file attached or as the next word.
    const short = /^-[A-Za-z]*F(.*)$/s.exec(word);
    const reads = api ? ['--input', '--field'] : ['--body-file'];
    let value = short === null ? undefined : short[1] || words[i + 1];
    if (long !== null && reads.includes(long[1] ?? '')) value = long[2] ?? words[i + 1];
    const field = api && long?.[1] !== '--input';
    const file = field ? /=@(.*)$/s.exec(value ?? '')?.[1] : value;
    if (file === undefined || file === '-') return;
    const named = absolute(file, cwd, home);
    let real: string;
    try {
      real = realPath(named);
    } catch (error) {
      if (!(error instanceof PathError)) throw error;
      return refuse('read', `${word}: ${error.message}`);
    }
    if ([named, real].some((path) => path !== clone && inside(clone, path) === undefined))
      refuse('read', `${word}: gh reads ${file}, outside the repository; give a file inside it`);
  });
}

/** Test's runs that update snapshots: `-u` or `--update` rewrite existing ones (T070). */
const updatesSnapshots = (words: string[]) =>
  words.slice(1).some((word) => {
    const name = word.split('=')[0] ?? '';
    return name === '--update' || name === '--u' || cluster(word).includes('u');
  });

function checkCommand(policy: Policy, role: RoleName, places: Places, command: SimpleCommand) {
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
  checkOwner(words);
  for (const prefix of policy.denyShell)
    if (startsWith(words, prefix))
      refuse(
        'deny-shell',
        `${shown}: no session runs ${prefix}; ${FACTORY_RUNS.has(prefix) ? 'commit your work, and the factory pushes it and opens the pull request' : 'only the Owner runs it'}`,
      );
  const amend = words.some((w) => w.length >= 4 && '--amend'.startsWith(w.split('=')[0] ?? ''));
  const sub = words[1] ?? '';
  const force = Object.hasOwn(FORCES, sub) ? FORCES[sub] : undefined;
  const forced =
    force !== undefined &&
    words.slice(2).some((word) => {
      const name = word.split('=')[0] ?? '';
      const prefix = name.length >= (force.shortest ?? 0) && force.long?.startsWith(name) === true;
      return (
        cluster(word)
          .split('')
          .some((l) => force.letters.includes(l)) || prefix
      );
    });
  if (words[0] === 'git' && (REWRITES.has(sub) || (sub === 'commit' && amend) || forced))
    refuse('rewrite', `${shown}: no role rewrites a branch; make a new commit instead`);
  const row = policy.roles[role];
  for (const prefix of row.blocked)
    if (startsWith(words, prefix))
      refuse(
        'blocked',
        `${shown}: the ${role} role may not run ${prefix}${/^git (rebase|reset|commit --amend)/.test(prefix) ? '; no role rewrites a branch, so make a new commit instead' : ''}`,
      );
  if (words[0] === 'xargs' && words.some((word) => /(^|\/)(git|gh)$/.test(word)))
    refuse('xargs', `${shown}: xargs into git or gh; run the git or gh command itself`);
  checkLabels(words);
  checkOptions(words);
  checkReads(policy, places, words);
  checkGhFiles(places, words);
  if (words[0] === 'npm' && ['run', 'run-script', 'rum', 'urn'].includes(sub))
    if (words.slice(2).includes('env'))
      refuse(
        'environment',
        `${shown}: npm run env prints the environment, which holds the session's credentials; run a script from package.json`,
      );
  if (role === 'test' && updatesSnapshots(words))
    refuse(
      'option',
      `${shown}: -u and --update rewrite existing snapshots, which Test may not change; run the tests without them`,
    );
  if (role === 'reviewer' && startsWith(words, 'git diff')) {
    const after = words.slice(words.indexOf('--') + 1);
    if (!words.includes('--') || !EXCLUDES.every((pathspec) => after.includes(pathspec)))
      refuse(
        'pathspec',
        `${shown}: the Reviewer's git diff leaves out the event logs; end it with -- ':(exclude)*events.jsonl' ':(exclude).factory/events'`,
      );
  }
  if (!row.shell.some((prefix) => startsWith(words, prefix))) {
    const use = USE.find(([start]) => startsWith(words, start))?.[1];
    refuse(
      'allowlist',
      `${shown || 'a command with no program'}: not a command the ${role} role's shell runs; ${use === undefined ? '' : `use ${use}; `}it runs ${row.shell.join(', ')}`,
    );
  }
}

/** Whether `role`'s session may run `command`, and if not, the rule that refused it and why. */
export function checkBash(
  policy: Policy,
  input: { role: string; command: string } & Places,
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
    if (result.commands.length === 0)
      refuse('empty', 'an empty command, with nothing to run; send the command itself');
    for (const command of result.commands) checkCommand(policy, role, input, command);
    return { allowed: true };
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    return { allowed: false, rule: error.rule, reason: visible(`refused: ${error.message}`) };
  }
}
