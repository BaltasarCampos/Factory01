// Contract tests for `factory ci append-only <base> <head>` (T052, contracts/ci-checks.md,
// research R12): event logs only grow at the end (AC-065), and `claude/factory-log` holds only
// regular text files under the log paths (AC-081, AC-082).
import { chmodSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkAppendOnly } from '../../src/ci/append-only.js';
import { runCli } from '../../src/cli/commands.js';
import { gitEnv, makeRepo, type Files, type TestRepo } from '../helpers/git-repo.js';

const EVENTS = 'specs/42-add-login/events.jsonl';
const LINE1 = '{"ts":"2026-10-08T09:00:00Z","kind":"tool_call"}\n';
const LINE2 = '{"ts":"2026-10-08T09:01:00Z","kind":"tool_call"}\n';
const LINE3 = '{"ts":"2026-10-08T09:02:00Z","kind":"usage"}\n';
const OPS = '.factory/ops/health/2026-10-08.md';
const LOG = 'claude/factory-log';

/** main with an item's event log and the log branch's files; returns the base commit. */
function setup(files: Files = {}) {
  const repo = makeRepo({
    files: { [EVENTS]: LINE1 + LINE2, [OPS]: '# Health\nok\n', 'src/a.ts': 'a\n', ...files },
  });
  return { repo, base: repo.revParse('HEAD') };
}

async function ci(repo: TestRepo, args: string[]) {
  const out: string[] = [];
  const code = await runCli(['ci', 'append-only', ...args], {
    stdout: { write: (s: string) => void out.push(s) },
    stderr: { write: (s: string) => void out.push(s) },
    env: gitEnv,
    stdinIsTTY: false,
    cwd: repo.path,
    unreadAlerts: () => Promise.reject(new Error('ci must not read the inbox')),
  });
  return { code, output: out.join('') };
}

describe('factory ci append-only: event logs (AC-065)', () => {
  it('passes lines appended at the end, and a PR changing other files freely', async () => {
    const { repo, base } = setup();
    const head = repo.commit({ [EVENTS]: LINE1 + LINE2 + LINE3, 'src/a.ts': 'b\n' }, 'more');

    expect(checkAppendOnly(repo.path, base, head, { logBranch: false })).toEqual([]);
    expect(await ci(repo, [base, head])).toEqual({ code: 0, output: 'append-only: pass\n' });
  });

  it.each<[string, Files, RegExp]>([
    ['an edited line', { [EVENTS]: LINE1 + LINE3 }, /events\.jsonl: an existing line/],
    ['a deleted line', { [EVENTS]: LINE1 }, /events\.jsonl: an existing line/],
    ['a line inserted before existing lines', { [EVENTS]: LINE3 + LINE1 + LINE2 }, /existing line/],
    ['a deleted file', { [EVENTS]: null }, /events\.jsonl: deleted/],
  ])('fails %s', async (_name, change, finding) => {
    const { repo, base } = setup();
    const head = repo.commit(change, 'change');

    const findings = checkAppendOnly(repo.path, base, head, { logBranch: false });
    expect(findings.join('\n')).toMatch(finding);
    const r = await ci(repo, [base, head]);
    expect(r.code).toBe(1);
    expect(r.output).toMatch(finding);
  });

  it('checks a pull request from its merge base, so later commits on main do not count', () => {
    const { repo, base } = setup();
    repo.checkout('claude/42-add-login', { create: true });
    const head = repo.commit({ [EVENTS]: LINE1 + LINE2 + LINE3 }, 'item');
    repo.checkout('main');
    const main = repo.commit({ 'src/a.ts': 'main moved\n' }, 'main');

    expect(checkAppendOnly(repo.path, main, head, { logBranch: false })).toEqual([]);
    expect(base).not.toBe(main);
  });

  it('checks every events.jsonl under specs/, not other files', () => {
    const { repo, base } = setup({ 'specs/7-x/events.jsonl': LINE1, 'docs/events.jsonl': LINE1 });
    const head = repo.commit({ 'specs/7-x/events.jsonl': LINE2, 'docs/events.jsonl': LINE2 }, 'c');
    expect(checkAppendOnly(repo.path, base, head, { logBranch: false })).toEqual([
      'specs/7-x/events.jsonl: an existing line was edited, deleted or moved',
    ]);
  });
});

describe('factory ci append-only --branch claude/factory-log (AC-065, AC-081, AC-082)', () => {
  it('passes appended lines and new regular text files under the log paths', async () => {
    const { repo, base } = setup();
    const head = repo.commit(
      {
        [OPS]: '# Health\nok\nstill ok\n',
        '.factory/events/2026-10.jsonl': LINE1,
        '.factory/lessons/builder.md': '- lesson\n',
        '.factory/releases/v1.0.1.md': '# v1.0.1\n',
      },
      'log',
    );
    expect(checkAppendOnly(repo.path, base, head, { logBranch: true })).toEqual([]);
    expect((await ci(repo, [base, head, '--branch', LOG])).code).toBe(0);
  });

  it('applies the line rule to every file on the branch, not only events.jsonl', () => {
    const { repo, base } = setup();
    const head = repo.commit({ [OPS]: '# Health\nfine\n' }, 'edit');
    expect(checkAppendOnly(repo.path, base, head, { logBranch: true })).toEqual([
      `${OPS}: an existing line was edited, deleted or moved`,
    ]);
  });

  it.each<[string, Files, RegExp]>([
    ['a file outside the log paths', { 'src/b.ts': 'b\n' }, /src\/b\.ts: outside/],
    ['a protected path', { '.factory/config': 'x\n' }, /\.factory\/config: outside/],
    [
      'a binary file',
      { '.factory/ops/x.bin': 'a\0b' },
      /x\.bin: not a regular text file \(binary\)/,
    ],
    [
      'a .git* file',
      { '.factory/ops/.gitattributes': '* -diff\n' },
      /\.gitattributes: \.git\* file/,
    ],
  ])('fails %s', async (_name, change, finding) => {
    const { repo, base } = setup();
    const head = repo.commit(change, 'change');
    expect(checkAppendOnly(repo.path, base, head, { logBranch: true }).join('\n')).toMatch(finding);
    expect((await ci(repo, [base, head, '--branch', LOG])).code).toBe(1);
  });

  it('fails a symlink, an executable bit, a gitlink and a rename', () => {
    const { repo, base } = setup();
    symlinkSync('health/2026-10-08.md', join(repo.path, '.factory/ops/latest'));
    chmodSync(join(repo.path, OPS), 0o755);
    mkdirSync(join(repo.path, '.factory/events'));
    repo.git(['mv', EVENTS, '.factory/events/moved.jsonl']);
    repo.git(['add', '-A']);
    repo.git(['update-index', '--add', '--cacheinfo', `160000,${base},.factory/ops/sub`]);
    repo.git(['commit', '-q', '--no-gpg-sign', '-m', 'types']);

    const findings = checkAppendOnly(repo.path, base, repo.revParse('HEAD'), { logBranch: true });

    expect(findings).toEqual(
      expect.arrayContaining([
        '.factory/ops/latest: not a regular text file (symlink)',
        `${OPS}: executable bit`,
        '.factory/ops/sub: not a regular text file (gitlink)',
        `${EVENTS}: deleted`,
      ]),
    );
  });

  it.each<[string, Files]>([
    ['a deleted file', { [OPS]: null }],
    ['a file that shrank', { [OPS]: '# Health\n' }],
  ])('fails %s', (_name, change) => {
    const { repo, base } = setup();
    const head = repo.commit(change, 'change');
    expect(checkAppendOnly(repo.path, base, head, { logBranch: true })).toEqual([
      change[OPS] === null
        ? `${OPS}: deleted`
        : `${OPS}: an existing line was edited, deleted or moved`,
    ]);
  });

  it('checks the branch’s first push (an all-zeros base) from its merge base with main', async () => {
    const { repo } = setup();
    repo.checkout(LOG, { create: true });
    const head = repo.commit({ '.factory/events/2026-10.jsonl': LINE1 }, 'log 1');
    const first = '0'.repeat(40);

    expect(checkAppendOnly(repo.path, first, head, { logBranch: true })).toEqual([]);
    expect((await ci(repo, [first, head, '--branch', LOG])).code).toBe(0);

    const edited = repo.commit({ [OPS]: '# Health\nfine\n' }, 'edit');
    expect(checkAppendOnly(repo.path, first, edited, { logBranch: true })).toEqual([
      `${OPS}: an existing line was edited, deleted or moved`,
    ]);
    expect(() => checkAppendOnly(repo.path, first, head, { logBranch: false })).toThrow(
      /not a commit/,
    );
  });

  it('fails a push that rewrote the branch’s history', () => {
    const { repo } = setup();
    repo.checkout(LOG, { create: true });
    const before = repo.commit({ '.factory/events/2026-10.jsonl': LINE1 }, 'log 1');
    repo.git(['reset', '-q', '--hard', 'HEAD~1']);
    const after = repo.commit({ '.factory/events/2026-10.jsonl': LINE2 }, 'rewritten');

    expect(checkAppendOnly(repo.path, before, after, { logBranch: true })).toEqual([
      `history rewritten: ${before} is not an ancestor of ${after}`,
    ]);
  });
});

describe('factory ci append-only: usage', () => {
  it('needs a base and a head', async () => {
    const { repo } = setup();
    expect((await ci(repo, ['HEAD'])).code).toBe(2);
  });

  it('refuses a ref that is not a commit', async () => {
    const { repo, base } = setup();
    const r = await ci(repo, [base, 'no-such-ref']);
    expect(r.code).toBe(1);
    expect(r.output).toMatch(/no-such-ref/);
  });
});
