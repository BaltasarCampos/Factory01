// The protected set at merge time (T173): all of `.specify/`, every `CLAUDE.md` and
// `CLAUDE.local.md` at any depth, and `.factory/brief.md`, which only a Define pull request may
// change. Real git repositories, with the inputs `factory merge` passes to src/merge/rules.ts.
import { mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { mergeRules, type MergeRulesInput } from '../../src/merge/rules.js';
import { makeRepo, type Files, type TestRepo } from '../helpers/git-repo.js';
import { makeKeys, writeKeyFiles, type TestKeys } from '../helpers/keys.js';

const REPO = 'owner/project';
const FACTORY_REPO = 'BaltasarCampos/Factory01';
const PIN = `v1.0.0@${'a'.repeat(40)}`;
const BRIEF = '.factory/brief.md';

let owner: TestKeys;
beforeAll(() => {
  owner = makeKeys();
});

/**
 * A project with a signed main holding a brief, a `CLAUDE.md` and the constitution; or, without
 * `.factory/config`, the factory.
 */
function project(factory = false): { repo: TestRepo; main: string } {
  const files: Files = factory
    ? { 'src/a.ts': 'a\n' }
    : {
        '.factory/config': `factory_release: ${PIN}\nrepo: ${REPO}\ninbox_issue: 1\nagents: local\n`,
        [BRIEF]: '# Brief\n',
        ...{ 'CLAUDE.md': '# Notes\n', '.specify/memory/constitution.md': '# Constitution\n' },
        'src/a.ts': 'a\n',
      };
  const repo = makeRepo({ files, signWith: owner });
  if (factory) repo.git(['remote', 'set-url', 'origin', `git@github.com:${FACTORY_REPO}.git`]);
  return { repo, main: repo.revParse('main') };
}

/** `name` off main with `files` committed, or `change` made, checked as `factory merge` does. */
function merge(name: string, change: Files | ((repo: TestRepo) => void), factory = false) {
  const { repo, main } = project(factory);
  repo.checkout(name, { create: true });
  if (typeof change === 'function') change(repo);
  const head = repo.commit(typeof change === 'function' ? {} : change, `work on ${name}`);
  repo.checkout('main');
  const keys = writeKeyFiles([owner]);
  const input: MergeRulesInput = {
    ...{ repo: repo.path, branch: name, head, main, keys, laptopKeys: keys },
    ...{ secondCopy: owner.publicKey, factory: repo.path, factoryRepo: FACTORY_REPO },
  };
  return mergeRules(input);
}

describe('merge rules: the protected set of T173', { timeout: 60_000 }, () => {
  it.each([
    '.specify/templates/plan-template.md',
    '.specify/feature.json',
    'CLAUDE.md',
    'docs/deep/CLAUDE.md',
    'src/CLAUDE.local.md',
    BRIEF,
  ])('an item pull request touching %s is refused', (path) => {
    const result = merge('claude/12-add-login', { [path]: 'changed\n', 'src/b.ts': 'b\n' });

    expect(result.rule).toBe('item');
    expect(result.problems).toEqual([expect.stringContaining(`${path}: `) as string]);
  });

  it('an item pull request touching the brief is told that only Define may change it', () => {
    expect(merge('claude/12-add-login', { [BRIEF]: '# Changed\n' }).problems).toEqual([
      `${BRIEF}: the project brief, which only a Define pull request may change`,
    ]);
  });

  it('a Define pull request may change the brief, and nothing else protected', () => {
    expect(merge('claude/define', { [BRIEF]: '# Brief, revised\n' })).toEqual({
      rule: 'define',
      problems: [],
    });
    const result = merge('claude/define', {
      ...{ [BRIEF]: '# Brief, revised\n', 'CLAUDE.md': '@docs/x.md\n' },
      '.specify/templates/spec-template.md': '# Spec\n',
    });
    expect(result.problems).toEqual([
      expect.stringMatching(/^\.specify\/templates\/spec-template\.md: a protected path/) as string,
      expect.stringMatching(/^CLAUDE\.md: a protected path/) as string,
    ]);
  });

  const at = (repo: TestRepo, path: string) => join(repo.path, path);
  it.each<[string, (repo: TestRepo) => void, string[]]>([
    ['deleting CLAUDE.md', (r) => r.git(['rm', '-q', 'CLAUDE.md']), ['CLAUDE.md']],
    ['renaming CLAUDE.md out', (r) => r.git(['mv', 'CLAUDE.md', 'NOTES.md']), ['CLAUDE.md']],
    [
      'renaming a file in as docs/CLAUDE.md',
      (r) => {
        mkdirSync(at(r, 'docs'));
        r.git(['mv', 'src/a.ts', 'docs/CLAUDE.md']);
      },
      ['docs/CLAUDE.md'],
    ],
    [
      'replacing CLAUDE.md with a symlink',
      (r) => {
        rmSync(at(r, 'CLAUDE.md'));
        symlinkSync('AGENTS.md', at(r, 'CLAUDE.md'));
      },
      ['CLAUDE.md'],
    ],
    ['deleting the brief', (r) => r.git(['rm', '-q', BRIEF]), [BRIEF]],
  ])('an item pull request %s is refused', (_name, change, paths) => {
    const result = merge('claude/12-add-login', change);

    expect(result.problems).toEqual(paths.map((p) => expect.stringContaining(`${p}: `) as string));
  });

  it('a Define pull request touching the constitution, or making the brief a symlink, is refused', () => {
    const constitution = '.specify/memory/constitution.md';
    expect(merge('claude/define', { [constitution]: '# Mine\n' }).problems).toEqual([
      `${constitution}: a protected path, which no item or Define pull request may change`,
    ]);
    const linked = merge('claude/define', (r) => {
      rmSync(at(r, BRIEF));
      symlinkSync('../README.md', at(r, BRIEF));
    });
    expect(linked.problems).toEqual([`${BRIEF}: not a regular file (mode 120000)`]);
  });

  it('a log pull request touching the brief is refused', () => {
    const result = merge('claude/factory-log', { [BRIEF]: '# Changed\n' });

    expect(result.rule).toBe('factory-log');
    expect(result.problems.join('\n')).toContain(BRIEF);
  });

  it('an upgrade pull request touching the brief is refused', () => {
    const result = merge('factory/upgrade-v1.0.0', { [BRIEF]: '# Changed\n' });

    expect(result.rule).toBe('upgrade');
    expect(result.problems).toContain(`${BRIEF}: outside the protected set and .factory/config`);
  });

  it.each(['.specify/templates/overrides/plan-template.md', 'CLAUDE.md'])(
    'in the factory repository, any pull request touching %s is refused',
    (path) => {
      const result = merge('owner-work', { [path]: 'changed\n' }, true);

      expect(result.rule).toBe('factory-repository');
      expect(result.problems).toEqual([expect.stringMatching(/signed commit$/) as string]);
    },
  );
});
