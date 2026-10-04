import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExitCode, EnvironmentError } from '../../src/cli/env.js';
import { listComments, postComment } from '../../src/github/comments.js';
import { Fields, gh, GhError, parseJsonStream } from '../../src/github/gh.js';
import { addLabel, ensureLabels, removeLabel } from '../../src/github/labels.js';
import * as prs from '../../src/github/prs.js';
import { cloneRepo, createRepo, visibility } from '../../src/github/repo.js';
import { labelEvents, timeline } from '../../src/github/timeline.js';
import { calls, readState, seedState, type FakeLabelEvent } from '../helpers/fake-gh.js';
import { tempDir } from '../helpers/keys.js';

const REPO = 'owner/project';
const { closePr, createDraftPr, listPrs, viewPr } = prs;

const labelled = (
  event: 'labeled' | 'unlabeled',
  name: string,
  at: string,
  login = 'owner',
): FakeLabelEvent => ({ event, label: { name }, actor: { login }, created_at: at });

function seed(extra: Parameters<typeof seedState>[0] = {}) {
  return seedState({
    repos: {
      [REPO]: {
        labels: [{ name: 'pause:line', color: 'b60205', description: '' }],
        issues: [{ number: 1, title: 'Owner inbox' }],
      },
    },
    ...extra,
  });
}

describe('gh wrapper (AC-076)', () => {
  it('returns raw stdout, or parsed JSON with { json: true }', async () => {
    seed();
    expect(await gh(['issue', 'view', '1', '--repo', REPO])).toBe('Owner inbox\n');
    expect(
      await gh(['issue', 'view', '1', '--repo', REPO, '--json', 'number,title'], { json: true }),
    ).toEqual({ number: 1, title: 'Owner inbox' });
  });

  it('a non-zero gh exit becomes a typed GhError carrying args, exit code and stderr', async () => {
    seed();
    const err = await gh(['issue', 'view', '99', '--repo', REPO]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GhError);
    const ghErr = err as GhError;
    expect(ghErr.args).toEqual(['issue', 'view', '99', '--repo', REPO]);
    expect(ghErr.exitCode).toBe(1);
    expect(ghErr.stderr).toMatch(/Could not resolve/);
    expect(ghErr.message).toMatch(/gh issue view 99.*Could not resolve/s);
  });

  it('output that is not JSON in json mode is a GhError, never a partial value', async () => {
    seed();
    await expect(gh(['issue', 'view', '1', '--repo', REPO], { json: true })).rejects.toThrow(
      GhError,
    );
  });

  it('a missing gh binary is an environment error (exit 3)', async () => {
    const err = await gh(['--version'], { env: { PATH: tempDir() } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnvironmentError);
    expect((err as EnvironmentError).code).toBe(ExitCode.Environment);
  });

  it('typed fields reject output of the wrong shape (fail closed)', () => {
    const f = Fields.of({ n: 1, s: 'x', b: true, author: { login: 'me' }, list: [] }, 'thing');
    expect([f.num('n'), f.str('s'), f.bool('b'), f.login('author'), f.list('list')]).toEqual([
      1,
      'x',
      true,
      'me',
      [],
    ]);
    expect(() => f.num('s')).toThrow(/thing\.s/);
    expect(() => f.str('missing')).toThrow(GhError);
    expect(() => f.login('s')).toThrow(GhError);
    expect(() => f.list('n')).toThrow(GhError);
    expect(() => Fields.of([], 'thing')).toThrow(GhError);
    expect(() => Fields.of(null, 'thing')).toThrow(GhError);
  });

  describe('--paginate output', () => {
    it('back-to-back pages merge into one array; brackets inside strings do not split', () => {
      expect(parseJsonStream('[1,2][3]\n[]')).toEqual([1, 2, 3]);
      expect(parseJsonStream('[{"s":"]["},{"t":"\\"]"}]')).toEqual([{ s: '][' }, { t: '"]' }]);
      expect(parseJsonStream(' {"a":1} ')).toEqual({ a: 1 });
    });

    it('refuses several values that are not all arrays, and truncated output', () => {
      expect(() => parseJsonStream('{"a":1}{"b":2}')).toThrow(GhError);
      expect(() => parseJsonStream('[1,2')).toThrow(GhError);
      expect(() => parseJsonStream('[1,,2]')).toThrow(GhError);
      expect(() => parseJsonStream('')).toThrow(GhError);
    });
  });

  describe('timeline', () => {
    it('reads every page of label events in created_at order with their actors', async () => {
      seed({
        pageSize: 2,
        repos: {
          [REPO]: {
            issues: [
              {
                number: 1,
                events: [
                  labelled('labeled', 'pause:line', '2026-10-02T09:00:03Z', 'agent'),
                  labelled('labeled', 'pause:build', '2026-10-02T09:00:01Z'),
                  labelled('unlabeled', 'pause:line', '2026-10-02T09:00:05Z', 'agent'),
                  labelled('unlabeled', 'pause:build', '2026-10-02T09:00:02Z'),
                  labelled('labeled', 'pause:line', '2026-10-02T09:00:04Z'),
                ],
              },
            ],
          },
        },
      });
      const events = await timeline(REPO, 1);
      expect(events.map((e) => [e.event, e.label, e.createdAt, e.actor])).toEqual([
        ['labeled', 'pause:build', '2026-10-02T09:00:01Z', 'owner'],
        ['unlabeled', 'pause:build', '2026-10-02T09:00:02Z', 'owner'],
        ['labeled', 'pause:line', '2026-10-02T09:00:03Z', 'agent'],
        ['labeled', 'pause:line', '2026-10-02T09:00:04Z', 'owner'],
        ['unlabeled', 'pause:line', '2026-10-02T09:00:05Z', 'agent'],
      ]);
      expect(calls()).toEqual([['api', `repos/${REPO}/issues/1/timeline`, '--paginate']]);
    });

    it('keeps only label events, sorts pages that arrive out of order, keeps ties stable', () => {
      const events = labelEvents([
        { event: 'labeled', label: { name: 'b' }, actor: null, created_at: '2026-10-02T09:00:02Z' },
        { event: 'commented', body: 'pause:line', created_at: '2026-10-02T09:00:00Z' },
        { event: 'labeled', label: { name: 'a' }, actor: null, created_at: '2026-10-02T09:00:01Z' },
        { event: 'unlabeled', label: { name: 'c' }, created_at: '2026-10-02T09:00:02Z' },
      ]);
      expect(events).toEqual([
        { event: 'labeled', label: 'a', createdAt: '2026-10-02T09:00:01Z' },
        { event: 'labeled', label: 'b', createdAt: '2026-10-02T09:00:02Z' },
        { event: 'unlabeled', label: 'c', createdAt: '2026-10-02T09:00:02Z' },
      ]);
      expect(() => labelEvents([{ event: 'labeled', created_at: 'x' }])).toThrow(GhError);
    });
  });

  describe('arguments are checked before gh runs', () => {
    it.each([
      ['-R/evil', 1],
      ['no-slash', 1],
      ['owner/../x', 1],
      [REPO, 0],
      [REPO, -1],
      [REPO, 1.5],
    ])('repo %j, number %j → refused', async (repo, n) => {
      seed();
      await expect(timeline(repo, n)).rejects.toThrow(GhError);
      expect(calls()).toEqual([]);
    });

    it.each(['owner:approved,state:done', '', '--help'])(
      'label %j → refused (gh splits commas into several labels)',
      async (label) => {
        seed();
        await expect(addLabel(REPO, 1, label)).rejects.toThrow(GhError);
        expect(calls()).toEqual([]);
      },
    );
  });
});

describe('GitHub helpers (T028)', () => {
  it('labels: add and remove leave label events; ensureLabels creates only missing ones', async () => {
    seed();
    await addLabel(REPO, 1, 'pause:line');
    await removeLabel(REPO, 1, 'pause:line');
    expect(readState().repos[REPO]?.issues[0]?.events.map((e) => e.event)).toEqual([
      'labeled',
      'unlabeled',
    ]);
    const wanted = [
      { name: 'pause:line', color: 'b60205', description: 'Kill switch' },
      { name: 'tier:1', color: 'c2e0c6', description: 'Risk tier 1' },
    ];
    expect(await ensureLabels(REPO, wanted)).toEqual(['tier:1']);
    expect(await ensureLabels(REPO, wanted)).toEqual([]);
    expect(readState().repos[REPO]?.labels.map((l) => l.name)).toEqual(['pause:line', 'tier:1']);
    expect(calls().filter((c) => c[1] === 'list')[0]).toContain('--limit');
  });

  it('comments: bodies go through stdin verbatim and list back typed', async () => {
    seed();
    const body = '--body x\n```factory-record\n`$(rm -rf ~)`\n```\n';
    const url = await postComment(REPO, 1, body);
    expect(url).toMatch(/issues\/1#issuecomment-\d+$/);
    expect(calls().flat()).not.toContain(body);
    const [comment] = await listComments(REPO, 1);
    expect(comment).toEqual({
      id: expect.any(String) as string,
      author: 'owner',
      body,
      createdAt: '2026-10-02T09:00:00Z',
    });
  });

  it('comments: pull request threads too', async () => {
    seed({ repos: { [REPO]: { prs: [{ number: 7, headRefName: 'claude/7-x' }] } } });
    await postComment(REPO, 7, 'waiver', { thread: 'pr' });
    expect((await listComments(REPO, 7, { thread: 'pr' })).map((c) => c.body)).toEqual(['waiver']);
  });

  it('pull requests: one draft PR is created, viewed by number or branch, listed, closed', async () => {
    seed({ repos: { [REPO]: {} } });
    const n = await createDraftPr(REPO, {
      head: 'claude/5-add-login',
      base: 'main',
      title: '#5 Add login',
      body: 'Closes #5',
    });
    const pr = await viewPr(REPO, n);
    expect(pr).toMatchObject({
      number: n,
      title: '#5 Add login',
      body: 'Closes #5',
      author: 'owner',
      headRefName: 'claude/5-add-login',
      baseRefName: 'main',
      isDraft: true,
      state: 'OPEN',
    });
    expect(await viewPr(REPO, 'claude/5-add-login')).toEqual(pr);
    expect(await listPrs(REPO, { head: 'claude/5-add-login' })).toEqual([pr]);
    expect(await listPrs(REPO, { head: 'claude/other' })).toEqual([]);
    await closePr(REPO, n, { comment: 'Superseded', deleteBranch: true });
    expect(await listPrs(REPO)).toEqual([]);
    expect((await listPrs(REPO, { state: 'all' }))[0]?.state).toBe('CLOSED');
    expect(calls().at(-3)).toEqual([
      'pr',
      'close',
      String(n),
      '--repo',
      REPO,
      '--comment',
      'Superseded',
      '--delete-branch',
    ]);
  });

  it('an unknown repository visibility or PR state is refused, not mapped to a default', async () => {
    const bin = tempDir();
    const pr = { number: 1, title: '', body: '', author: { login: 'o' }, headRefName: 'h' };
    const out = { ...pr, baseRefName: 'main', headRefOid: '', isDraft: false, url: '' };
    writeFileSync(
      join(bin, 'gh'),
      `#!/bin/sh\necho '${JSON.stringify({ ...out, state: 'LOCKED', visibility: 'secret' })}'\n`,
      { mode: 0o755 },
    );
    const env = { PATH: bin };
    await expect(visibility(REPO, { env })).rejects.toThrow(/visibility "secret"/);
    await expect(viewPr(REPO, 1, { env })).rejects.toThrow(/state "LOCKED"/);
  });

  it('pull requests: no helper merges — merges are local and Owner-signed', () => {
    expect(Object.keys(prs).filter((name) => /merge/i.test(name))).toEqual([]);
  });

  it('repo: visibility, private creation, clone', async () => {
    const root = tempDir();
    seed({
      gitRoot: root,
      repos: { [REPO]: { visibility: 'private' }, 'owner/factory': { visibility: 'public' } },
    });
    expect(await visibility(REPO)).toBe('private');
    expect(await visibility('owner/factory')).toBe('public');
    expect(await createRepo('owner/sample')).toBe('owner/sample');
    expect(await visibility('owner/sample')).toBe('private');
    expect(calls().find((c) => c[1] === 'create')).toContain('--private');
    const dir = join(root, 'clone');
    await cloneRepo('owner/sample', dir);
    expect(existsSync(join(dir, '.git'))).toBe(true);
  });
});
