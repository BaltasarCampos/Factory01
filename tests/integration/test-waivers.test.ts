// `factory approve <item> waiver test:<path>[#<title>]` (T151, AC-061): the laptop runs the
// weakened check itself, in the sandbox, at the one commit it resolved the item branch to; the
// waiver covers exactly the findings it names there, and re-signing shows what changed since the
// waived head. One project serves every case, so one weakened run per head serves them all; the
// cases at the end move the branch and main, so they run last and in order.
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { extractFromComment, newNonce, parse, renderComment } from '../../src/approvals/record.js';
import { ownerKeyPath, sign } from '../../src/approvals/sign.js';
import { verifySignature } from '../../src/approvals/verify.js';
import { runCli } from '../../src/cli/commands.js';
import type { ApprovalRecord } from '../../src/model/types.js';
import { readState, seedState } from '../helpers/fake-gh.js';
import { makeRepo, mergeBrief, signedReleaseTag, type TestRepo } from '../helpers/git-repo.js';
import { makeKeys, tempDir, writeKeyFiles, type TestKeys } from '../helpers/keys.js';

vi.setConfig({ testTimeout: 240_000, hookTimeout: 60_000 });

const REPO = 'owner/project';
const ITEM = 7;
const BRANCH = 'claude/7-add-login';
const AT = '2026-10-01T08:00:00Z';
const SPEC = `# Add login

## Problem

Visitors cannot sign in.

## Affected areas

- \`src/calc.ts\`

1. **AC-001** — **Given** two numbers, **When** they are added, **Then** the sum is right.
`;
const ESC_TITLE = 'esc \u001b[2J and\nnewline';
const calcTests = (lines: string[]) =>
  [
    "import { expect, it } from 'vitest';",
    "import { add } from '../src/calc.js';",
    ...lines,
    '',
  ].join('\n');
const MAIN_CALC = calcTests([
  "it('adds', () => { expect(add(1, 2)).toBe(3); });",
  "it('adds zero', () => { expect(add(1, 0)).toBe(1); });",
  "it('a # title', () => { expect(add(2, 2)).toBe(4); });",
  `it(${JSON.stringify(ESC_TITLE)}, () => { expect(add(0, 0)).toBe(0); });`,
]);
// At the head: one test skipped, one removed, the escaped one skipped, one unchanged.
const ITEM_CALC = calcTests([
  "it.skip('adds', () => { expect(add(1, 2)).toBe(3); });",
  "it('adds zero', () => { expect(add(1, 0)).toBe(1); });",
  `it.skip(${JSON.stringify(ESC_TITLE)}, () => { expect(add(0, 0)).toBe(0); });`,
]);

let owner: TestKeys;
let project: TestRepo;
let factory: TestRepo;
let home: string;
/** The item branch's head every case before the last three reads. */
let first: string;

beforeAll(() => {
  owner = makeKeys();
  factory = makeRepo({
    files: { allowed_signers: `${owner.allowedSignersLine}\n`, revoked_keys: '' },
  });
  signedReleaseTag(factory, owner);
  const config = `factory_release: v1.0.0@${factory.revParse('HEAD')}\nrepo: ${REPO}\ninbox_issue: 1\nagents: local\n`;
  project = makeRepo({
    files: {
      '.factory/config': config,
      '.gitignore': 'node_modules/\ncoverage/\n',
      'src/calc.ts': 'export const add = (a: number, b: number) => a + b;\n',
      'tests/calc.test.ts': MAIN_CALC,
      'tests/other.test.ts':
        "import { expect, it } from 'vitest';\nit('kept', () => { expect(1).toBe(1); });\n",
    },
    signWith: owner,
  });
  mergeBrief(project, { signWith: owner });
  project.checkout(BRANCH, { create: true });
  first = project.commit(
    {
      'specs/7-add-login/spec.md': SPEC,
      'tests/calc.test.ts': ITEM_CALC,
    },
    'build',
  );
  project.push(BRANCH);
  project.checkout('main');
  home = tempDir('factory-home-');
  mkdirSync(join(home, '.factory', 'keys'), { recursive: true });
  writeFileSync(join(home, '.factory', 'allowed_signers'), `${owner.allowedSignersLine}\n`);
  copyFileSync(owner.privateKey, ownerKeyPath(home));
  chmodSync(ownerKeyPath(home), 0o600);
  copyFileSync(owner.publicKeyPath, `${ownerKeyPath(home)}.pub`);
});

const comment = (id: number, record: ApprovalRecord) => ({
  id,
  author: 'owner',
  body: renderComment(record, sign(record, owner.privateKey, { stdinIsTTY: true })),
  createdAt: AT,
});

/** A fresh GitHub: the approved item, its PR at `head`, and any earlier waiver records. */
function seed(head: string, earlierWaiver?: { waives: string; head: string }) {
  const approved: ApprovalRecord = {
    ...{ repo: REPO, issue: ITEM, gate: 'approved', tier: 2, branch: BRANCH },
    ...{ timestamp: AT, nonce: newNonce() },
  };
  const comments = [comment(900, approved)];
  if (earlierWaiver !== undefined)
    comments.push(
      comment(901, {
        ...{ repo: REPO, issue: ITEM, gate: 'waiver', tier: 2, branch: BRANCH },
        ...earlierWaiver,
        ...{ timestamp: AT, nonce: newNonce() },
      }),
    );
  const labels = ['owner:approved', 'owner:waiver', 'tier:2'].map((name) => ({
    name,
    color: 'ededed',
    description: '',
  }));
  seedState({
    repos: {
      [REPO]: {
        labels,
        issues: [
          { number: 1, title: 'Owner inbox' },
          {
            number: ITEM,
            title: 'Add login',
            labels: ['tier:2', 'owner:approved'],
            comments,
            events: [
              {
                event: 'labeled' as const,
                label: { name: 'owner:approved' },
                actor: { login: 'owner' },
                created_at: '2026-10-01T08:01:00Z',
              },
            ],
          },
        ],
        prs: [{ number: 8, headRefName: BRANCH, headRefOid: head, isDraft: true }],
      },
    },
  });
}

async function approve(waives: string) {
  const out: string[] = [];
  const err: string[] = [];
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, FACTORY_SOURCE: factory.path };
  delete env.CLAUDE_CODE_REMOTE;
  const code = await runCli(['approve', String(ITEM), 'waiver', waives], {
    stdout: { write: (s: string) => void out.push(s) },
    stderr: { write: (s: string) => void err.push(s) },
    ...{ env, stdinIsTTY: true, cwd: project.path },
    unreadAlerts: () => Promise.resolve([]),
    now: () => new Date('2026-10-02T09:00:00Z'),
  });
  return { code, stdout: out.join(''), stderr: err.join('') };
}

const item = () => readState().repos[REPO]?.issues.find((i) => i.number === ITEM);
/** The record in the item's newest comment, after checking its signature. */
function posted(): ApprovalRecord {
  const signed = extractFromComment(item()?.comments.at(-1)?.body ?? '');
  expect(verifySignature(signed, writeKeyFiles([owner]))).toBe(true);
  return parse(signed.text);
}

describe('test: waivers (T151, AC-061)', () => {
  it('signs a titled waiver bound to the head the laptop ran the weakened check at', async () => {
    seed(first);

    const r = await approve('test:tests/calc.test.ts#adds');

    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(
      `weakened tests at ${first.slice(0, 12)} this waiver covers (run on this laptop):`,
    );
    expect(r.stdout).toContain(
      'test:tests/calc.test.ts#adds: passed at the base, skipped at the head',
    );
    expect(posted()).toMatchObject({
      ...{ gate: 'waiver', waives: 'test:tests/calc.test.ts#adds', head: first },
      ...{ tier: 2, branch: BRANCH },
    });
    expect(item()?.labels).toContain('owner:waiver');
  });

  // A # in a path is covered in tests/unit/approvals.test.ts: Vitest does not run such a file,
  // so no fixture here could make it a finding.
  it('a # in a title is part of the exact target', async () => {
    seed(first);
    const r = await approve('test:tests/calc.test.ts#a # title');
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(posted().waives).toBe('test:tests/calc.test.ts#a # title');
  });

  it('a file-wide waiver lists every finding of exactly that path, untrusted titles shown visibly', async () => {
    seed(first);

    const r = await approve('test:tests/calc.test.ts');

    expect(r.code).toBe(0);
    const listed = r.stdout.split('\n').filter((l) => l.includes(': passed at the base,'));
    expect(listed).toEqual([
      '  test:tests/calc.test.ts#adds: passed at the base, skipped at the head',
      '  test:tests/calc.test.ts#a # title: passed at the base, missing at the head',
      '  test:tests/calc.test.ts#esc \\u{1b}[2J and\\nnewline: passed at the base, skipped at the head',
    ]);
    expect(r.stdout).not.toContain('\u001b');
    expect(r.stdout).toContain('What it lets through: 3 weakened tests, listed above');
  });

  it.each([
    'test:tests/other.test.ts',
    'test:tests/calc.test.ts#adds zero',
    'test:tests/calc.test.ts#add',
    'test:tests/calc',
  ])('refuses %s, which covers no finding at that head', async (waives) => {
    seed(first);

    const r = await approve(waives);

    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`nothing to waive: ${waives} covers no weakened test at`);
    expect(item()?.comments).toHaveLength(1);
  });

  it.each([
    ['a bidi override in a title', 'test:tests/calc.test.ts#safe‮txt.exe'],
    ['a zero-width character in a path', 'test:tests/ca​lc.test.ts'],
    ['an escaped title the summary would have to clean', `test:tests/calc.test.ts#${ESC_TITLE}`],
  ])('refuses a target with %s: rename the test', async (_name, waives) => {
    seed(first);

    const r = await approve(waives);

    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/would have to clean.*rename the test/s);
    expect(item()?.comments).toHaveLength(1);
  });

  it('when the waived head is gone, says so and shows the full diff from the merge base', async () => {
    const gone = 'e'.repeat(40);
    seed(first, { waives: 'test:tests/calc.test.ts#adds', head: gone });

    const r = await approve('test:tests/calc.test.ts#adds');

    expect(r.code).toBe(0);
    expect(r.stdout).toContain(
      `the waived head ${gone} is gone, so this is the full diff from the merge base:`,
    );
    expect(r.stdout).toContain("> +it.skip('adds', () => { expect(add(1, 2)).toBe(3); });");
  });

  it('after a commit on the branch, shows the plain diff since the waived head', async () => {
    project.checkout(BRANCH);
    const second = project.commit({ 'src/extra.ts': 'export const extra = 1;\n' }, 'later');
    project.push(BRANCH);
    project.checkout('main');
    seed(second, { waives: 'test:tests/calc.test.ts#adds', head: first });

    const r = await approve('test:tests/calc.test.ts#adds');

    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`diff since the waived head ${first}:`);
    expect(r.stdout).toContain('> +export const extra = 1;');
    expect(r.stdout).not.toContain("> +it.skip('adds'");
    expect(posted().head).toBe(second);
  });

  it('after a rebase onto a moved main, shows the interdiff of the item’s own changes', async () => {
    project.checkout('main');
    project.commit({ 'src/main-only.ts': 'export const fromMain = 1;\n' }, 'main moves', {
      signWith: owner,
    });
    project.push('main');
    project.checkout(BRANCH);
    project.git(['rebase', '-q', 'main']);
    const third = project.revParse('HEAD');
    project.push(BRANCH, { force: true });
    project.checkout('main');
    seed(third, { waives: 'test:tests/calc.test.ts#adds', head: first });

    const r = await approve('test:tests/calc.test.ts#adds');

    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`interdiff since the waived head ${first}:`);
    expect(r.stdout).toContain('+export const extra = 1;');
    expect(r.stdout).not.toContain('fromMain');
    expect(posted().head).toBe(third);
  });
});
