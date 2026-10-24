// The command tokenizer (T083): a small hand-written POSIX tokenizer for the command guard
// (T084), which splits a Bash command into simple commands, each with its assignments, words and
// redirections, and the operator that follows it. Anything it cannot fully analyse is
// `Unanalysable`, so the guard fails closed (research.md R6): every expansion, whose value it
// cannot know; unquoted glob characters, which could expand to a flag; brace expansion; `~user`;
// subshells, groups and shell keywords; here-documents and process substitution. A command is
// `Unanalysable` too if it runs text the tokenizer cannot see: `eval` or a shell as any of its
// words, so no wrapper such as `env`, `xargs` or `find -exec` hides one, or, where it starts, a
// builtin that runs text or a file as code or changes how later commands are read, such as
// `source`, `trap` or `alias`, or that evaluates a variable name, such as `read` or `printf -v`.
// Plain `~` and `~/…` stay as written, for the guards to treat as home. `&` is parsed, and the
// guard refuses it.

export type Operator = ';' | '&&' | '||' | '|' | '|&' | '&';

export interface Redirection {
  fd: number | null;
  op: '>' | '>>' | '>&' | '>|' | '<' | '<&' | '<>' | '&>' | '&>>';
  target: string;
}

export interface SimpleCommand {
  assignments: { name: string; value: string }[];
  words: string[];
  redirections: Redirection[];
  /** The operator after the command; a newline reads as `;`, and the last command has none. */
  then: Operator | null;
}

export interface Unanalysable {
  ok: false;
  reason: string;
}

export type Tokenized = { ok: true; commands: SimpleCommand[] } | Unanalysable;

/** A word, and the same word with every quoted or escaped character as `\0`. */
interface Word {
  text: string;
  bare: string;
}
type Token =
  | { kind: 'word'; word: Word }
  | { kind: 'op'; op: Operator | '\n' }
  | { kind: 'redirect'; fd: number | null; op: Redirection['op'] };

/** Words that start a compound command or negate one where a command starts. */
const KEYWORDS = new Set(
  ['if', 'then', 'else', 'elif', 'fi', 'case', 'esac', 'for', 'select', 'while', 'until'].concat([
    'do',
    'done',
    'function',
    'time',
    'coproc',
    '{',
    '}',
    '[[',
    ']]',
    '!',
  ]),
);
const REDIRECTS = ['&>>', '&>', '>>', '>&', '>|', '<&', '<>', '>', '<'] as const;
/** Shells, by a word's last path part: `sh -c`, a script or standard input runs unseen text. */
const SHELLS = new Set(
  'sh bash rbash dash ash zsh ksh mksh yash posh csh tcsh fish busybox'.split(' '),
);
/** Builtins that run text or a file as code, or change how later commands are read or run. */
const CODE = 'source . trap fc bind compgen complete alias unalias shopt set enable hash';
/**
 * Builtins that evaluate a variable name or arithmetic, where a quoted `a[$(…)]` runs a command:
 * bash 5.2 runs it for `let`, `read`, `test -v`, `printf -v`, `declare`, `typeset` and `local`.
 */
const NAMES =
  'let read test [ printf declare typeset local export readonly unset mapfile readarray' +
  ' getopts wait';
const BUILTINS = new Map([
  ...CODE.split(' ').map((name) => [name, 'runs text as code or changes the shell'] as const),
  ...NAMES.split(' ').map((name) => [name, 'evaluates variable names'] as const),
]);
const QUOTED = '\0';

class Refusal extends Error {}
const refuse = (reason: string): never => {
  throw new Refusal(reason);
};

/** The lexer: words, operators and redirections, refusing what it cannot know. */
function lex(text: string): Token[] {
  if (text.includes(QUOTED)) refuse('a NUL character');
  const tokens: Token[] = [];
  let word: Word | null = null;
  const add = (char: string, quoted: boolean) => {
    word ??= { text: '', bare: '' };
    word.text += char;
    word.bare += quoted ? QUOTED : char;
  };
  const end = () => {
    if (word !== null) tokens.push({ kind: 'word', word: checked(word) });
    word = null;
  };
  let i = 0;
  while (i < text.length) {
    const char = text.charAt(i);
    const next = text.charAt(i + 1);
    if (char === ' ' || char === '\t') {
      end();
      i += 1;
    } else if (char === '\n') {
      end();
      tokens.push({ kind: 'op', op: '\n' });
      i += 1;
    } else if (char === '#' && word === null) {
      while (i < text.length && text.charAt(i) !== '\n') i += 1;
    } else if (char === '\\') {
      if (i + 1 >= text.length) refuse('a trailing backslash');
      if (next !== '\n') add(next, true);
      i += 2;
    } else if (char === "'") {
      const close = text.indexOf("'", i + 1);
      if (close < 0) refuse("an unterminated ' quote");
      word ??= { text: '', bare: '' };
      for (const quoted of text.slice(i + 1, close)) add(quoted, true);
      i = close + 1;
    } else if (char === '"') {
      word ??= { text: '', bare: '' };
      i += 1;
      for (;;) {
        if (i >= text.length) refuse('an unterminated " quote');
        const inner = text.charAt(i);
        if (inner === '"') break;
        if (inner === '$') refuse('an expansion ($)');
        if (inner === '`') refuse('a backquote command substitution');
        if (inner === '\\' && '$`"\\\n'.includes(text.charAt(i + 1))) {
          if (text.charAt(i + 1) !== '\n') add(text.charAt(i + 1), true);
          i += 2;
        } else {
          add(inner, true);
          i += 1;
        }
      }
      i += 1;
    } else if (char === '$') {
      refuse('an expansion ($)');
    } else if (char === '`') {
      refuse('a backquote command substitution');
    } else if ('*?['.includes(char)) {
      refuse(`a glob character ${char}`);
    } else if (char === '(' || char === ')') {
      refuse(`a subshell or group ${char}`);
    } else if (char === '<' || char === '>' || (char === '&' && next === '>')) {
      i = redirect(text, i, word, tokens);
      word = null;
    } else if (char === ';' || char === '&' || char === '|') {
      end();
      const pair = char + next;
      if (pair === ';;' || pair === ';&') refuse(`the case operator ${pair}`);
      const op = (['&&', '||', '|&'] as string[]).includes(pair) ? (pair as Operator) : char;
      tokens.push({ kind: 'op', op });
      i += op.length;
    } else {
      add(char, false);
      i += 1;
    }
  }
  end();
  return tokens;
}

/**
 * Reads a redirection at `i`, taking the word before it as its descriptor if it is all digits
 * and the operator takes one: bash reads `2&>x` as the word `2` and `&>x`.
 */
function redirect(text: string, i: number, word: Word | null, tokens: Token[]): number {
  let fd: number | null = null;
  if (word !== null) {
    // `{name}>file` makes bash put a new descriptor in `name`, and drops the word.
    if (/^\{\w+\}$/.test(word.bare)) refuse(`a named descriptor ${word.text}`);
    if (/^\d+$/.test(word.bare) && text.charAt(i) !== '&') fd = Number(word.text);
    else tokens.push({ kind: 'word', word: checked(word) });
  }
  if (text.startsWith('<<<', i)) refuse('a here-string <<<');
  if (text.startsWith('<<', i)) refuse('a here-document <<');
  if (text.startsWith('<(', i) || text.startsWith('>(', i)) refuse('a process substitution');
  const op =
    REDIRECTS.find((candidate) => text.startsWith(candidate, i)) ?? refuse('a redirection');
  tokens.push({ kind: 'redirect', fd, op });
  return i + op.length;
}

/** Refuses a finished word that the shell would still expand: braces or a `~user`. */
function checked(word: Word): Word {
  if (/\{[^{}]*(,|\.\.)[^{}]*\}/.test(word.bare)) refuse(`a brace expansion in ${word.text}`);
  if (/(^|[=:])~[^/\0]/.test(word.bare)) refuse(`a tilde expansion in ${word.text}`);
  return word;
}

/** Refuses a command that runs text the tokenizer cannot see, through any wrapper. */
function checkRuns({ words }: SimpleCommand) {
  for (const word of words) {
    const program = word.slice(word.lastIndexOf('/') + 1);
    if (program === 'eval') refuse(`eval in ${word}, which runs its arguments as a command`);
    if (SHELLS.has(program)) refuse(`the shell ${word}, which runs a command line of its own`);
  }
  // `command` and `builtin` run a builtin too; other wrappers run only programs.
  let start = 0;
  while (words[start] === 'command' || words[start] === 'builtin') {
    start += 1;
    while (words[start]?.startsWith('-')) start += 1;
  }
  const first = words[start] ?? '';
  const why = BUILTINS.get(first);
  if (why !== undefined) refuse(`the builtin ${first}, which ${why}`);
}

const assignment = (word: Word) => /^[A-Za-z_][A-Za-z0-9_]*=/.exec(word.bare)?.[0];

/** The parser: simple commands between operators, each redirection with its target. */
function parse(tokens: Token[]): SimpleCommand[] {
  const commands: SimpleCommand[] = [];
  let command: SimpleCommand = { assignments: [], words: [], redirections: [], then: null };
  let pending: Omit<Redirection, 'target'> | null = null;
  const empty = () =>
    command.assignments.length + command.words.length + command.redirections.length === 0;
  for (const token of tokens) {
    if (token.kind === 'word') {
      const { text, bare } = token.word;
      const name = assignment(token.word);
      if (pending !== null) {
        command.redirections.push({ ...pending, target: text });
        pending = null;
      } else if (command.words.length === 0 && name !== undefined) {
        command.assignments.push({ name: name.slice(0, -1), value: text.slice(name.length) });
      } else {
        if (command.words.length === 0 && KEYWORDS.has(bare)) refuse(`the keyword ${bare}`);
        command.words.push(text);
      }
    } else if (token.kind === 'redirect') {
      if (pending !== null) refuse('a redirection with no target');
      pending = { fd: token.fd, op: token.op };
    } else {
      if (pending !== null) refuse('a redirection with no target');
      // A newline after nothing, or after an operator that needs more, is only a line break.
      if (token.op === '\n' && empty()) continue;
      if (empty()) refuse(`an empty command before ${token.op}`);
      command.then = token.op === '\n' ? ';' : token.op;
      checkRuns(command);
      commands.push(command);
      command = { assignments: [], words: [], redirections: [], then: null };
    }
  }
  if (pending !== null) refuse('a redirection with no target');
  if (!empty()) {
    checkRuns(command);
    commands.push(command);
  }
  const last = commands.at(-1)?.then;
  if (empty() && last !== undefined && last !== null && last !== ';' && last !== '&')
    refuse(`a command that ends with ${last}`);
  return commands;
}

/** Splits `text` into simple commands, or says why it cannot fully analyse it. */
export function tokenize(text: string): Tokenized {
  try {
    return { ok: true, commands: parse(lex(text)) };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, reason: error.message };
    throw error;
  }
}
