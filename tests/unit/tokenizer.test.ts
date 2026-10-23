// The command tokenizer (T083): a hand-written POSIX tokenizer for the command guard, which
// splits a Bash command into simple commands and returns `Unanalysable` for anything it cannot
// fully analyse, so the guard fails closed (research.md R6).
import { describe, expect, it } from 'vitest';
import { tokenize, type SimpleCommand } from '../../src/guard/tokenizer.js';

const commands = (text: string): SimpleCommand[] => {
  const result = tokenize(text);
  if (!result.ok) throw new Error(`${text}: unanalysable, ${result.reason}`);
  return result.commands;
};
const words = (text: string) => commands(text).map((command) => command.words);
const refused = (text: string) => {
  const result = tokenize(text);
  return result.ok ? 'parsed' : result.reason;
};

describe('the command tokenizer: words and quotes (T083)', () => {
  it.each([
    ['git status', ['git', 'status']],
    ['  git \t log   --oneline  ', ['git', 'log', '--oneline']],
    ["git commit -m 'a b; c && d'", ['git', 'commit', '-m', 'a b; c && d']],
    ['git commit -m "a b | c"', ['git', 'commit', '-m', 'a b | c']],
    [`echo 'it'"'"'s'`, ['echo', "it's"]],
    ['echo a\\ b \\; \\$HOME \\*', ['echo', 'a b', ';', '$HOME', '*']],
    ['echo "a\\"b" "c\\\\d" "e\\f"', ['echo', 'a"b', 'c\\d', 'e\\f']],
    ["echo 'a\\b' \"\" ''", ['echo', 'a\\b', '', '']],
    ['git \\\n  status', ['git', 'status']],
    ['\'g\'it pu"sh" origin', ['git', 'push', 'origin']],
    ['git status # a comment; rm -rf x', ['git', 'status']],
    ['echo a#b "#c"', ['echo', 'a#b', '#c']],
    ['cat ~/notes.md ~', ['cat', '~/notes.md', '~']],
    ['git stash show stash@{0}', ['git', 'stash', 'show', 'stash@{0}']],
    ['echo if then {', ['echo', 'if', 'then', '{']],
    ["'if' x", ['if', 'x']],
  ])('%j', (text, expected) => {
    expect(words(text)).toEqual([expected]);
  });

  it('gives no command for an empty line, blank lines or a comment', () => {
    expect(commands('')).toEqual([]);
    expect(commands('\n  \n# only a comment')).toEqual([]);
  });
});

describe('the command tokenizer: operators (T083)', () => {
  it('splits on ; && || | |& & and newlines, and records the operator after each command', () => {
    const parsed = commands('a 1; b && c || d | e |& f & g\nh');
    expect(parsed.map((c) => [c.words.join(' '), c.then])).toEqual([
      ['a 1', ';'],
      ['b', '&&'],
      ['c', '||'],
      ['d', '|'],
      ['e', '|&'],
      ['f', '&'],
      ['g', ';'],
      ['h', null],
    ]);
  });

  it('needs no spaces around operators, and accepts a trailing ; or & and a newline after &&', () => {
    expect(words('a;b&&c|d')).toEqual([['a'], ['b'], ['c'], ['d']]);
    expect(commands('npm test &').map((c) => c.then)).toEqual(['&']);
    expect(commands('git add x;').map((c) => c.then)).toEqual([';']);
    expect(words('npm test &&\n  git status')).toEqual([
      ['npm', 'test'],
      ['git', 'status'],
    ]);
  });

  it.each([
    ['; git push', /empty command before ;/],
    ['a && && b', /empty command before &&/],
    ['| b', /empty command before \|/],
    ['a ||', /ends with \|\|/],
    ['a |', /ends with \|/],
    ['a ;; b', /;;/],
    ['a ;& b', /;&/],
  ])('refuses %j', (text, reason) => {
    expect(refused(text)).toMatch(reason);
  });
});

describe('the command tokenizer: redirections and assignments (T083)', () => {
  it('reads each redirection with its descriptor, operator and target, apart from the words', () => {
    const [command] = commands('npm test >out.txt 2>&1 <in 3>>log &>all &>>more >|clobber 4<>rw');
    expect(command?.words).toEqual(['npm', 'test']);
    expect(command?.redirections).toEqual([
      { fd: null, op: '>', target: 'out.txt' },
      { fd: 2, op: '>&', target: '1' },
      { fd: null, op: '<', target: 'in' },
      { fd: 3, op: '>>', target: 'log' },
      { fd: null, op: '&>', target: 'all' },
      { fd: null, op: '&>>', target: 'more' },
      { fd: null, op: '>|', target: 'clobber' },
      { fd: 4, op: '<>', target: 'rw' },
    ]);
    expect(commands('echo a2>f')[0]?.words).toEqual(['echo', 'a2']);
    expect(commands('echo "2">f')[0]?.words).toEqual(['echo', '2']);
  });

  it('reads leading NAME=value words as assignments, and the same words later as arguments', () => {
    const [command] = commands(`FOO=bar B='x y' C= git -c X=1 status`);
    expect(command?.assignments).toEqual([
      { name: 'FOO', value: 'bar' },
      { name: 'B', value: 'x y' },
      { name: 'C', value: '' },
    ]);
    expect(command?.words).toEqual(['git', '-c', 'X=1', 'status']);
    expect(commands('X=1')[0]).toMatchObject({
      assignments: [{ name: 'X', value: '1' }],
      words: [],
    });
    expect(words(`1A=x cmd`)).toEqual([['1A=x', 'cmd']]);
    expect(words(`'A'=x cmd`)).toEqual([['A=x', 'cmd']]);
  });

  it.each([
    ['echo >', /redirection with no target/],
    ['echo > ; ls', /redirection with no target/],
    ['cat <<EOF', /here-document/],
    ['cat <<-EOF', /here-document/],
    ['cat <<<word', /here-string/],
    ['diff <(ls a) b', /process substitution/],
    ['tee >(cat)', /process substitution/],
  ])('refuses %j', (text, reason) => {
    expect(refused(text)).toMatch(reason);
  });
});

describe('the command tokenizer: what it cannot fully analyse (T083, R6)', () => {
  it.each([
    ['git $(echo push)', /expansion/],
    ['git `echo push`', /backquote/],
    ['git $CMD', /expansion/],
    ['git "${CMD}"', /expansion/],
    ['echo $((1 + 1))', /expansion/],
    ['echo "a`b`"', /backquote/],
    ['X=$(id) git status', /expansion/],
    ['ls *.ts', /glob/],
    ['gi? push', /glob/],
    ['/usr/bin/[g]it push', /glob/],
    ['git {push,status}', /brace expansion/],
    ['touch a{1..3}', /brace expansion/],
    ['cat ~root/.ssh/id', /tilde/],
    ['X=~other/x cmd', /tilde/],
    ['(git push)', /subshell/],
    ['git push origin main)', /subshell/],
    ['{ git push; }', /keyword {/],
    ['if true; then git push; fi', /keyword if/],
    ['ls; for x in a; do git push; done', /keyword for/],
    ['! git push', /keyword !/],
    ["echo 'unterminated", /unterminated '/],
    ['echo "unterminated', /unterminated "/],
    ['echo trailing\\', /trailing backslash/],
    ['git {fd}>x push', /named descriptor \{fd\}/],
    ['git\0 push', /NUL/],
  ])('%j', (text, reason) => {
    expect(refused(text)).toMatch(reason);
  });

  it('keeps quoted characters literal: no expansion, glob, brace or tilde inside quotes', () => {
    expect(words(`echo '$(x)' '*' "{a,b}" '~root' "\\$HOME"`)).toEqual([
      ['echo', '$(x)', '*', '{a,b}', '~root', '$HOME'],
    ]);
  });
});
