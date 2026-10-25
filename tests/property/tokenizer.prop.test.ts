// Property tests for the command tokenizer (T076, T083): generated commands mixing quoting,
// assignments, redirections, `;`, `&&`, `||`, pipes, `&` and newlines come back word for word,
// and every construct the tokenizer cannot fully analyse, put anywhere in such a command, makes
// it `Unanalysable`, so the command guard fails closed (research.md R6). The guard's own
// properties are slice 25c's. Lines of words are also read by bash itself, and compared.
import { execFileSync } from 'node:child_process';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  tokenize,
  type Operator,
  type Redirection,
  type SimpleCommand,
} from '../../src/guard/tokenizer.js';

/** Characters bash reads specially somewhere, and some plain ones. */
const CHARS = 'aZ09_-./=:,+@%~#!;&|<>()$`"\'\\{}[]*? \t\n'.split('');
/** Characters a word may carry unquoted without bash reading them specially. */
const SAFE = /^[A-Za-z0-9_./,+@%:-]$/;
const OPERATORS = [';', '&&', '||', '|', '|&', '&', '\n'] as const;
const REDIRECTS = ['>', '>>', '>&', '>|', '<', '<&', '<>', '&>', '&>>'] as const;

type Style = 'bare' | 'single' | 'double' | 'escape';
interface Written<T> {
  expected: T;
  written: string;
}

/** A word's text, and one way of writing it, part by part, that bash reads back as that text. */
const word: fc.Arbitrary<Written<string>> = fc
  .array(
    fc.tuple(
      fc.constantFrom(...CHARS),
      fc.constantFrom<Style>('bare', 'single', 'double', 'escape'),
    ),
    { maxLength: 6 },
  )
  .map((parts) => {
    // A special character is never bare, a newline never escaped, and a ' never single-quoted.
    const styled = parts.map(([char, style]): [string, Style] => {
      const quoted = style === 'bare' && !SAFE.test(char) ? 'escape' : style;
      const kept = quoted === 'escape' && char === '\n' ? 'single' : quoted;
      return [char, kept === 'single' && char === "'" ? 'double' : kept];
    });
    let written = '';
    for (const [i, [char, style]] of styled.entries()) {
      const open = styled[i - 1]?.[1] !== style;
      const close = styled[i + 1]?.[1] !== style;
      const quote = style === 'single' ? "'" : '"';
      if (style === 'bare') written += char;
      else if (style === 'escape') written += `\\${char}`;
      else {
        const escaped = style === 'double' && '$`"\\'.includes(char) ? `\\${char}` : char;
        written += `${open ? quote : ''}${escaped}${close ? quote : ''}`;
      }
    }
    return { expected: styled.map(([char]) => char).join(''), written: written || "''" };
  })
  // The alphabet spells no keyword, shell or builtin but the builtins `.` and `[`.
  .filter(({ expected }) => !['.', '['].includes(expected.split('/').pop() ?? ''));

const redirection: fc.Arbitrary<Written<Redirection>> = fc
  .record({
    fd: fc.option(fc.integer({ min: 0, max: 9 }), { nil: null }),
    op: fc.constantFrom(...REDIRECTS),
    target: word,
    space: fc.constantFrom('', ' '),
  })
  .map(({ fd, op, target, space }) => {
    const descriptor = op.startsWith('&') ? null : fd;
    return {
      expected: { fd: descriptor, op, target: target.expected },
      written: ` ${descriptor ?? ''}${op}${space}${target.written}`,
    };
  });

const assignment = fc
  .record({ name: fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,4}$/), value: word })
  .map(({ name, value }) => ({
    expected: { name, value: value.expected },
    written: ` ${name}=${value.written}`,
  }));

type Item = { word: Written<string> } | { redirection: Written<Redirection> };

/** A simple command: assignments, then words and redirections in any order, never empty. */
const command: fc.Arbitrary<Written<Omit<SimpleCommand, 'then'>>> = fc
  .record({
    assignments: fc.array(assignment, { maxLength: 2 }),
    items: fc.array(
      fc.oneof(
        word.map((w): Item => ({ word: w })),
        redirection.map((r): Item => ({ redirection: r })),
      ),
      { maxLength: 5 },
    ),
  })
  .filter(({ assignments, items }) => assignments.length + items.length > 0)
  .map(({ assignments, items }) => ({
    written:
      assignments.map((a) => a.written).join('') +
      items.map((i) => ('word' in i ? ` ${i.word.written}` : i.redirection.written)).join(''),
    expected: {
      assignments: assignments.map((a) => a.expected),
      words: items.flatMap((i) => ('word' in i ? [i.word.expected] : [])),
      redirections: items.flatMap((i) => ('redirection' in i ? [i.redirection.expected] : [])),
    },
  }));

/** A command line: commands, each with what follows it, its operator or the line's end. */
const line = fc
  .record({
    commands: fc.array(
      fc.record({
        command,
        op: fc.constantFrom(...OPERATORS),
        space: fc.constantFrom('', ' ', '\t '),
      }),
      { minLength: 1, maxLength: 4 },
    ),
    end: fc.constantFrom<Operator | '\n' | null>(null, ';', '&', '\n'),
  })
  .map(({ commands, end }) =>
    commands.map(({ command, op, space }, i) => {
      const then = i === commands.length - 1 ? end : op;
      const expected: SimpleCommand = { ...command.expected, then: then === '\n' ? ';' : then };
      return { text: command.written, tail: `${space}${then ?? ''}`, expected };
    }),
  );

const join = (parts: { text: string; tail: string }[]) =>
  parts.map((p) => p.text + p.tail).join('');

// Each put as a word of a command, where its own rule applies.
const WORDS = ['$(id)', '`id`', '$HOME', '${X}', '$((1))', '"a$X"', '"`id`"', '*', 'a?', '[ab]']
  .concat(['{a,b}', 'x{1..3}', '~root', '--x=~root', '<(id)', '>(id)', '<<EOF', '<<<w', '{fd}>x'])
  .concat(['(', ')', 'sh', 'bash', '/bin/dash', "'zsh'", 'eval', "e'val'"]);
// Each put as a command of its own.
const COMMANDS = ['eval x', "sh -c 'git push'", 'source x', '. ./x', "trap 'x' EXIT", 'alias g=x']
  .concat(['shopt -s expand_aliases', 'set -k', 'command source x', 'builtin trap x'])
  .concat(["let 'a[$(id)]'", "read 'a[$(id)]'", "printf -v 'a[$(id)]' x", "test -v 'a[$(id)]'"])
  .concat(['if true', '{ x', '! x']);

describe('the command tokenizer: properties (T076, T083)', () => {
  it('reads back every generated command line: its assignments, words, redirections and operators', () => {
    fc.assert(
      fc.property(line, (parts) => {
        expect(tokenize(join(parts))).toEqual({ ok: true, commands: parts.map((p) => p.expected) });
      }),
      { numRuns: 2000 },
    );
  });

  it('refuses a line with any construct it cannot fully analyse, as a word of any command', () => {
    fc.assert(
      fc.property(line, fc.constantFrom(...WORDS), fc.nat(), (parts, fragment, at) => {
        const i = at % parts.length;
        const withIt = parts.map((p, j) => (j === i ? { ...p, text: `${p.text} ${fragment}` } : p));
        expect(tokenize(join(withIt)).ok).toBe(false);
      }),
      { numRuns: 1000 },
    );
  });

  it('refuses a line with eval, a shell, or a builtin that runs text as code, as any command', () => {
    fc.assert(
      fc.property(line, fc.constantFrom(...COMMANDS), fc.nat(), (parts, fragment, at) => {
        const i = at % (parts.length + 1);
        const it = { text: `\n${fragment}`, tail: '\n' };
        expect(tokenize(join([...parts.slice(0, i), it, ...parts.slice(i)])).ok).toBe(false);
      }),
      { numRuns: 1000 },
    );
  });

  // Compared with bash itself, so a reading the generator and the tokenizer share by mistake
  // shows up (Owner decision 2026-10-24, T084). The printf program, since the tokenizer refuses
  // the builtin, which can assign a variable.
  it('reads a line of words as bash does', () => {
    fc.assert(
      fc.property(fc.array(word, { minLength: 1, maxLength: 5 }), (words) => {
        const line = `/usr/bin/printf '%s\\0' ${words.map((w) => w.written).join(' ')}`;
        const out = execFileSync('bash', ['--norc', '--noprofile', '-c', line], {
          encoding: 'utf8',
          env: { PATH: process.env.PATH },
        });
        const parsed = tokenize(line);
        expect(parsed.ok && parsed.commands[0]?.words.slice(2)).toEqual(
          out.split('\0').slice(0, -1),
        );
      }),
      { numRuns: 300 },
    );
  });

  it('never throws, never gives an empty command, and says why when it refuses', () => {
    const text = fc.oneof(
      fc.string({ unit: fc.constantFrom(...CHARS) }),
      fc.string({ unit: 'binary' }),
    );
    fc.assert(
      fc.property(text, (input) => {
        const result = tokenize(input);
        if (!result.ok) expect(result.reason).not.toBe('');
        else
          for (const c of result.commands)
            expect(c.assignments.length + c.words.length + c.redirections.length).toBeGreaterThan(
              0,
            );
      }),
      { numRuns: 2000 },
    );
  });
});
