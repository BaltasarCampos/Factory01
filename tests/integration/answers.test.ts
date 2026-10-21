// The Owner's answers on a branch (T182): `answers.md` counts only when every commit since the
// merge base that changed it has one parent, changes only that file and is signed by a key the
// lists pinned on main accept. Real git and real `ssh-keygen` signatures.
import { beforeAll, describe, expect, it } from 'vitest';
import { signedAnswers } from '../../src/git/answers.js';
import { makeRepo, type TestRepo } from '../helpers/git-repo.js';
import { makeKeys, makeOtherKeys, writeKeyFiles, type TestKeys } from '../helpers/keys.js';

const PATH = 'specs/2-add-login/answers.md';
const BRANCH = 'claude/2-add-login';

let owner: TestKeys;
let other: TestKeys;
beforeAll(() => {
  owner = makeKeys();
  other = makeOtherKeys();
});

describe('signed answers (T182, AC-033)', { timeout: 60_000 }, () => {
  /** A project whose item branch, checked out, starts from main. */
  const project = () => {
    const repo = makeRepo({ files: { 'README.md': 'x\n' }, signWith: owner });
    repo.checkout(BRANCH, { create: true });
    repo.commit({ 'specs/2-add-login/spec.md': '# Spec\n' }, 'Spec');
    return repo;
  };
  const read = (repo: TestRepo) =>
    signedAnswers({
      ...{ repo: repo.path, tip: repo.revParse('HEAD'), base: repo.revParse('main') },
      ...{ path: PATH, keys: writeKeyFiles([owner]) },
    });

  it('a branch without answers.md has no answers, and no tampering', () => {
    expect(read(project())).toEqual({ text: undefined });
  });

  it('AC-033: answers in a commit the Owner signed that changes only answers.md count', () => {
    const repo = project();
    repo.commit({ [PATH]: 'A1. B\n' }, 'Answers', { signWith: owner });
    repo.commit({ 'src/login.ts': 'export {};\n' }, 'later work');
    repo.commit({ [PATH]: 'A1. B\nA2. one week\n' }, 'More answers', { signWith: owner });
    expect(read(repo)).toEqual({ text: 'A1. B\nA2. one week\n' });
  });

  it.each<[string, (r: TestRepo) => string, RegExp]>([
    ['unsigned', (r) => r.commit({ [PATH]: 'A1. B\n' }, 'Answers'), /not signed by a listed/],
    [
      'signed by a key the lists do not name',
      (r) => r.commit({ [PATH]: 'A1. B\n' }, 'Answers', { signWith: other }),
      /not signed by a listed/,
    ],
    [
      'signed, but also changing another file',
      (r) => r.commit({ [PATH]: 'A1. B\n', 'src/x.ts': 'x\n' }, 'Answers', { signWith: owner }),
      /also changes src\/x\.ts/,
    ],
  ])('an answers commit %s counts as no answers and names the commit', (_name, write, why) => {
    const repo = project();
    repo.commit({ [PATH]: 'A1. A\n' }, 'Owner answers', { signWith: owner });
    const bad = write(repo);
    const verdict = read(repo);
    expect(verdict).toMatchObject({ tampered: { commit: bad } });
    expect('tampered' in verdict ? verdict.tampered.reason : '').toMatch(why);
  });

  it('a merge that brings answers.md in counts as no answers', () => {
    const repo = project();
    repo.checkout('side', { create: true });
    repo.commit({ [PATH]: 'A1. B\n' }, 'Answers on a side branch', { signWith: owner });
    repo.checkout(BRANCH);
    repo.git(['merge', '-q', '--no-ff', '--no-edit', 'side']);
    const verdict = read(repo);
    expect('tampered' in verdict ? verdict.tampered.reason : '').toMatch(/a merge changes/);
  });

  it('a later merge of main leaves the Owner’s answers counting', () => {
    const repo = project();
    repo.commit({ [PATH]: 'A1. B\n' }, 'Answers', { signWith: owner });
    repo.checkout('main');
    repo.commit({ 'src/main.ts': 'x\n' }, 'main moves', { signWith: owner });
    repo.checkout(BRANCH);
    repo.git(['merge', '-q', '--no-ff', '--no-edit', 'main']);
    expect(read(repo)).toEqual({ text: 'A1. B\n' });
  });

  it('a git failure throws: an unknown tip is never read as no answers', () => {
    const repo = project();
    expect(() =>
      signedAnswers({
        ...{ repo: repo.path, tip: 'f'.repeat(40), base: repo.revParse('main') },
        ...{ path: PATH, keys: writeKeyFiles([owner]) },
      }),
    ).toThrow(/git/);
  });
});
