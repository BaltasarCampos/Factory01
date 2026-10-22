// The protected set at merge time (T173): all of `.specify/`, every `CLAUDE.md` and
// `CLAUDE.local.md` at any depth, and `.factory/brief.md`, which only a Define pull request may
// change. Real git repositories, with the inputs `factory merge` passes to src/merge/rules.ts.
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

/** A project with a signed main holding a brief; or, without `.factory/config`, the factory. */
function project(factory = false): { repo: TestRepo; main: string } {
  const files: Files = factory
    ? { 'src/a.ts': 'a\n' }
    : {
        '.factory/config': `factory_release: ${PIN}\nrepo: ${REPO}\ninbox_issue: 1\nagents: local\n`,
        [BRIEF]: '# Brief\n',
        'src/a.ts': 'a\n',
      };
  const repo = makeRepo({ files, signWith: owner });
  if (factory) repo.git(['remote', 'set-url', 'origin', `git@github.com:${FACTORY_REPO}.git`]);
  return { repo, main: repo.revParse('main') };
}

/** `name` off main with `files` committed, checked as `factory merge` checks it. */
function merge(name: string, files: Files, factory = false) {
  const { repo, main } = project(factory);
  repo.checkout(name, { create: true });
  const head = repo.commit(files, `work on ${name}`);
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
