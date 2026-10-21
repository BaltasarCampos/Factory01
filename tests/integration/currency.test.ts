// Report currency (T178, Owner decisions 2026-10-18): a report counts only while every later
// first-parent commit is a report, the dispatcher's manifest, one task ticked, or a clean merge of
// main as git recomputes it; decided by content, never by author or trailer.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  branchGit,
  cleanMainMerge,
  reportAt,
  reportCurrent,
} from '../../src/dispatcher/currency.js';
import { makeRepo, type TestRepo } from '../helpers/git-repo.js';

const ITEM = 'claude/42-add-login';
const DIR = 'specs/42-add-login';
const TASKS = '# Tasks\n\n- [X] T001 write the test\n- [ ] T002 make it pass\n- [ ] T003 docs\n';

describe('report currency (T178)', { timeout: 60_000 }, () => {
  let repo: TestRepo;
  const at = () => branchGit({ projectDir: repo.path, now: () => new Date() });
  /** Main's first-parent commits, as the signed-history walk would verify them. */
  const verifiedMain = () => new Set(repo.git(['rev-list', '--first-parent', 'main']).split('\n'));
  const current = (verified = verifiedMain()) =>
    reportCurrent(at(), repo.revParse(ITEM), DIR, 'reports/integrate.md', verified);
  const onMain = (files: Record<string, string>) => {
    repo.checkout('main');
    repo.commit(files, 'main moves');
    repo.checkout(ITEM);
  };
  const mergeMain = () => repo.git(['merge', '-q', '--no-ff', '--no-edit', 'main']);

  beforeEach(() => {
    repo = makeRepo({ files: { 'src/shared.ts': 'export const a = 1;\n' } });
    repo.checkout(ITEM, { create: true });
    repo.commit({ [`${DIR}/tasks.md`]: TASKS, 'src/login.ts': 'export const login = 1;\n' }, 'b');
    repo.commit({ [`${DIR}/reports/integrate.md`]: '## Conflicts\n\n- src/shared.ts\n' }, 'r');
  });

  it('a report with no later commit is current; a file never written is not', () => {
    expect(current()).toBe(true);
    const tip = repo.revParse(ITEM);
    expect(reportCurrent(at(), tip, DIR, 'reports/verify.md', verifiedMain())).toBe(false);
  });

  it.each<[string, (r: TestRepo) => void]>([
    [
      'another report',
      (r) => r.commit({ [`${DIR}/reports/verify.md`]: '| Review | pass |\n' }, 'v'),
    ],
    ['the station manifest', (r) => r.commit({ [`${DIR}/.station.json`]: '{}\n' }, 'Dispatcher')],
    [
      'one task ticked',
      (r) => r.commit({ [`${DIR}/tasks.md`]: TASKS.replace('[ ] T002', '[X] T002') }, 't'),
    ],
    ['a clean merge of main', () => (onMain({ 'src/other.ts': 'x\n' }), mergeMain())],
    [
      'the Owner’s answers.md alone (T180)',
      (r) => r.commit({ [`${DIR}/answers.md`]: 'A1. B\n' }, 'Answers'),
    ],
  ])('stays current after %s', (_name, later) => {
    later(repo);
    expect(current()).toBe(true);
  });

  it.each<[string, (r: TestRepo) => void]>([
    ['a code commit', (r) => r.commit({ 'src/login.ts': 'export const login = 2;\n' }, 'fix')],
    [
      'answers.md and code together',
      (r) => r.commit({ [`${DIR}/answers.md`]: 'A1. B\n', 'src/x.ts': 'x\n' }, 'both'),
    ],
    [
      'a report and code together',
      (r) => r.commit({ [`${DIR}/reports/verify.md`]: 'x\n', 'src/x.ts': 'x\n' }, 'both'),
    ],
    [
      'two tasks ticked at once',
      (r) => r.commit({ [`${DIR}/tasks.md`]: TASKS.replace(/\[ \]/g, '[X]') }, 't'),
    ],
    [
      'a tick that edits the task',
      (r) =>
        r.commit({ [`${DIR}/tasks.md`]: TASKS.replace('[ ] T002 make', '[X] T002 skip') }, 't'),
    ],
    [
      'a task unticked',
      (r) => r.commit({ [`${DIR}/tasks.md`]: TASKS.replace('[X] T001', '[ ] T001') }, 't'),
    ],
    [
      'the manifest and code together',
      (r) => r.commit({ [`${DIR}/.station.json`]: '{}\n', 'src/y.ts': 'y\n' }, 'Dispatcher'),
    ],
  ])('goes stale after %s', (_name, later) => {
    later(repo);
    expect(current()).toBe(false);
  });

  it('goes stale after a merge of main that resolves a conflict', () => {
    onMain({ 'src/shared.ts': 'export const a = 2;\n' });
    repo.commit({ 'src/shared.ts': 'export const a = 3;\n' }, 'item edits the same line');
    repo.commit(
      { [`${DIR}/reports/integrate.md`]: '## Conflicts\n\n- src/shared.ts, again\n' },
      'r2',
    );
    expect(() => mergeMain()).toThrow();
    repo.commit({ 'src/shared.ts': 'export const a = 23;\n' }, 'resolve the conflict');

    expect(current()).toBe(false);
  });

  it('goes stale after a merge of main whose tree adds a change of its own', () => {
    onMain({ 'src/other.ts': 'x\n' });
    mergeMain();
    const parents = repo.git(['rev-list', '--parents', '-n', '1', 'HEAD']).split(' ').slice(1);
    repo.commit({ 'src/login.ts': 'export const login = 3;\n' }, 'slipped in');
    const tree = repo.revParse('HEAD^{tree}');
    const [ours = '', theirs = ''] = parents;
    const forged = repo.git(['commit-tree', tree, '-p', ours, '-p', theirs, '-m', 'Merge main']);
    repo.git(['reset', '-q', '--hard', forged]);

    expect(current()).toBe(false);
  });

  it('goes stale after a clean merge of a branch that is not on main’s verified history', () => {
    repo.checkout('side', { create: true });
    repo.git(['reset', '-q', '--hard', 'main']);
    repo.commit({ 'src/side.ts': 'side\n' }, 'not on main');
    repo.checkout(ITEM);
    repo.git(['merge', '-q', '--no-ff', '--no-edit', 'side']);

    expect(current()).toBe(false);
  });

  it('goes stale after a clean merge of main when main’s commit is not verified', () => {
    onMain({ 'src/other.ts': 'x\n' });
    mergeMain();

    expect(current(new Set())).toBe(false);
  });

  it('T179: reportAt names the commit that wrote the report and the first later one that made it stale', () => {
    const wrote = repo.revParse(ITEM);
    repo.commit({ [`${DIR}/.station.json`]: '{}\n' }, 'Dispatcher');
    const first = repo.commit({ 'src/login.ts': 'export const login = 2;\n' }, 'fix');
    repo.commit({ 'src/login.ts': 'export const login = 3;\n' }, 'fix again');
    const tip = repo.revParse(ITEM);

    expect(reportAt(at(), tip, DIR, 'reports/integrate.md', verifiedMain())).toEqual({
      wrote,
      staleAt: first,
    });
    expect(reportAt(at(), wrote, DIR, 'reports/integrate.md', verifiedMain())).toEqual({ wrote });
    expect(reportAt(at(), tip, DIR, 'reports/verify.md', verifiedMain())).toBeUndefined();
  });

  it('cleanMainMerge refuses a commit with one parent or three', () => {
    onMain({ 'src/other.ts': 'x\n' });
    mergeMain();
    const head = repo.revParse('HEAD');
    const [ours = '', theirs = ''] = repo
      .git(['rev-list', '--parents', '-n', '1', head])
      .split(' ')
      .slice(1);
    const main = verifiedMain();

    expect(cleanMainMerge(at(), head, [ours, theirs], main)).toBe(true);
    expect(cleanMainMerge(at(), head, [ours], main)).toBe(false);
    expect(cleanMainMerge(at(), head, [ours, theirs, theirs], main)).toBe(false);
  });
});
