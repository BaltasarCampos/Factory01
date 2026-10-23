// The command tokenizer (T083): a small hand-written POSIX tokenizer for the command guard
// (T084), which splits a Bash command into simple commands, each with its assignments, words and
// redirections, and the operator that follows it. Anything it cannot fully analyse is
// `Unanalysable`, so the guard fails closed (research.md R6): every expansion, whose value it
// cannot know; unquoted glob characters, which could expand to a flag; brace expansion; `~user`;
// subshells, groups and shell keywords; here-documents and process substitution. Plain `~` and
// `~/…` stay as written, for the guards to treat as home. `&` is parsed, and the guard refuses
// it. `eval`, `sh -c` and aliases are slice 25b-2's.

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

/** Reads a redirection at `i`, taking the word before it as its descriptor if it is all digits. */
function redirect(text: string, i: number, word: Word | null, tokens: Token[]): number {
  let fd: number | null = null;
  if (word !== null) {
    // `{name}>file` makes bash put a new descriptor in `name`, and drops the word.
    if (/^\{\w+\}$/.test(word.bare)) refuse(`a named descriptor ${word.text}`);
    if (/^\d+$/.test(word.bare)) fd = Number(word.text);
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
      commands.push(command);
      command = { assignments: [], words: [], redirections: [], then: null };
    }
  }
  if (pending !== null) refuse('a redirection with no target');
  if (!empty()) commands.push(command);
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
