// The Stop hook's commit for the roles that commit nothing themselves (T086, slices 28-5b and
// 28-5b-2): their output read in the read-only sandbox, committed in the factory's own clone with
// plumbing, the passing head recorded apart, and the second stop; with the real bwrap and git.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hookOutput, readOutput } from '../../src/hooks/output-commit.js';
import { passedRef, sessionRef, UnreadableHead } from '../../src/hooks/session-commits.js';
import { passedPath, readSessionRecord } from '../../src/hooks/session.js';
import { runStop } from '../../src/hooks/stop.js';
import { visible } from '../../src/notify/summary.js';
import { makeRepo, runGit } from '../helpers/git-repo.js';
import { tempDir } from '../helpers/keys.js';
import { dispatcherClone, recordSession, SESSION_ID } from '../helpers/session.js';

const FEATURE = 'specs/42-add-login';
const BRANCH = 'claude/42-add-login';
const CONFIG = `factory_release: v1.0.0@${'a'.repeat(40)}\nagents: local\nprofile: typescript\nrepo: owner/project\ninbox_issue: 1\n`;
const VERIFY = '| Check | Result |\n|---|---|\n| Review | pass |\n';
const REPORT = `${FEATURE}/reports/verify.md`;

/** The item branch issued on origin, the dispatcher's clone of it, and a session of `role`. */
function issued(role = 'reviewer', station = 5) {
  const r = makeRepo({ files: { '.factory/config': CONFIG, 'src/login.ts': 'a\n' } });
  r.checkout(BRANCH, { create: true });
  r.commit({ [`${FEATURE}/.station.json`]: '{}\n' }, 'manifest');
  r.push();
  const head = r.revParse('HEAD');
  const project = dispatcherClone(r);
  const { home, env, log } = recordSession({ role, station, clone: r.path, head, project });
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(r.path, path)), { recursive: true });
    writeFileSync(join(r.path, path), text);
  };
  const record = () => readSessionRecord(home, SESSION_ID);
  const output = () => hookOutput(record(), home, SESSION_ID, { ...process.env, ...env });
  const ref = (name: string) => runGit(project, ['for-each-ref', '--format=%(objectname)', name]);
  const stop = (again = false) =>
    runStop(
      { session_id: SESSION_ID, cwd: r.path, hook_event_name: 'Stop', stop_hook_active: again },
      { cwd: r.path, now: () => new Date(), env },
    );
  const passed = () => {
    writeFileSync(passedPath(home, SESSION_ID), `${JSON.stringify({ session: SESSION_ID })}\n`);
  };
  const events = () =>
    readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { kind: string; input_summary: string });
  return { r, head, home, env, project, write, record, output, ref, stop, passed, events };
}

describe("the Stop hook commits a non-committing role's output (T086, 28-5b)", () => {
  it('commits only its paths on the head it was issued, as the factory, with the trailers', () => {
    const t = issued();
    t.write(REPORT, VERIFY);
    const out = t.output();
    expect(out.commit).not.toBe(t.head);
    const git = (args: string[]) => runGit(t.project, args);
    expect(git(['rev-parse', `${out.commit}^`])).toBe(t.head);
    expect(git(['diff-tree', '--no-commit-id', '--name-only', '-r', out.commit])).toBe(REPORT);
    expect(git(['show', `${out.commit}:${REPORT}`])).toBe(VERIFY.trim());
    expect(git(['log', '-1', '--format=%an <%ae>|%cn <%ce>', out.commit])).toBe(
      'Factory reviewer <reviewer@factory.invalid>|Factory reviewer <reviewer@factory.invalid>',
    );
    expect(git(['log', '-1', '--format=%(trailers:only,unfold)', out.commit])).toBe(
      'Factory-Role: reviewer\nFactory-Item: 42-add-login',
    );
    expect(t.ref(sessionRef(SESSION_ID))).toBe(out.commit);
    expect(out.outside).toEqual([]);
    // Nothing written in the session's clone, its HEAD and index as they were.
    expect(t.r.revParse('HEAD')).toBe(t.head);
    expect(t.r.git(['status', '--porcelain'])).toBe(`?? ${FEATURE}/reports/`);
  });

  it("names a change outside its paths and never commits it, with no global or system config, and the commit's encoding pinned", () => {
    const t = issued();
    const latin1 = '[i18n]\n\tcommitEncoding = ISO-8859-1\n';
    writeFileSync(
      join(t.home, '.gitconfig'),
      `[user]\n\tname = Owner\n\temail = owner@example.com\n${latin1}`,
    );
    runGit(t.project, ['config', 'i18n.commitEncoding', 'ISO-8859-1']);
    t.write(REPORT, VERIFY);
    t.write('src/login.ts', 'changed\n');
    t.write('src/new.ts', 'x\n');
    const out = t.output();
    expect(out.outside.sort()).toEqual(['src/login.ts', 'src/new.ts']);
    expect(
      runGit(t.project, ['diff-tree', '--name-only', '-r', '--no-commit-id', out.commit]),
    ).toBe(REPORT);
    expect(runGit(t.project, ['log', '-1', '--format=%an', out.commit])).toBe('Factory reviewer');
    expect(runGit(t.project, ['cat-file', '-p', out.commit])).not.toMatch(/^encoding /m);
  });

  it('walks a folder its write column names, and gives the head itself when nothing changed', () => {
    const t = issued('planner', 3);
    expect(t.output().commit).toBe(t.head);
    t.write(`${FEATURE}/contracts/api.md`, 'a\n');
    t.write(`${FEATURE}/contracts/v2/events.md`, 'e\n');
    const out = t.output();
    expect(
      runGit(t.project, ['diff-tree', '--name-only', '-r', '--no-commit-id', out.commit]).split(
        '\n',
      ),
    ).toEqual([`${FEATURE}/contracts/api.md`, `${FEATURE}/contracts/v2/events.md`]);
  });

  it('refuses a link at a path or in a folder above it, anything but a regular file, and a protected path', () => {
    const outside = join(tempDir(), 'secret');
    writeFileSync(outside, 'key\n');
    const cases: [string, (t: ReturnType<typeof issued>) => void, RegExp][] = [
      [
        'a link as the file',
        (t) => {
          mkdirSync(join(t.r.path, FEATURE, 'reports'), { recursive: true });
          symlinkSync(outside, join(t.r.path, REPORT));
        },
        /reports\/verify\.md \(a link at specs\/42-add-login\/reports\/verify\.md\)/,
      ],
      [
        'a link above it',
        (t) => {
          const elsewhere = tempDir();
          mkdirSync(join(elsewhere, 'reports'));
          writeFileSync(join(elsewhere, 'reports', 'verify.md'), VERIFY);
          rmFeature(t);
          symlinkSync(elsewhere, join(t.r.path, FEATURE));
        },
        /reports\/verify\.md \(a link at specs\/42-add-login\)/,
      ],
      [
        'a fifo',
        (t) => {
          mkdirSync(join(t.r.path, FEATURE, 'reports'), { recursive: true });
          execFileSync('mkfifo', [join(t.r.path, REPORT)]);
        },
        /reports\/verify\.md \(not a regular file\)/,
      ],
    ];
    for (const [name, make, why] of cases) {
      const t = issued();
      make(t);
      expect(t.output, name).toThrow(UnreadableHead);
      expect(t.output, name).toThrow(why);
      expect(t.ref(sessionRef(SESSION_ID)), name).toBe('');
    }
    const p = issued('planner', 3);
    p.write(`${FEATURE}/contracts/.gitattributes`, '* -diff\n');
    expect(p.output).toThrow(/contracts\/\.gitattributes \(a protected path\)/);
  });

  // CLAUDE.MD documents existing behaviour: isProtected lower-cases the path.
  it.each([
    ['.git/HEAD', 'a path no role may write'],
    ['.GIT/x', 'a path no role may write'],
    ['.station.json', 'a path no role may write'],
    ['CLAUDE.MD', 'a protected path'],
    ['.git./HEAD', 'a path git refuses'],
    ['notes./x', 'a name ending in a dot'],
    ['.env.example', 'a path no role may write'],
    ['git~1/x', 'not a plain path'],
    ['.g\u200cit/x', 'not a plain path'],
  ])('refuses the Planner a %s under its contracts/ folder: %s', (path, why) => {
    const p = issued('planner', 3);
    p.write(`${FEATURE}/contracts/${path}`, 'x\n');
    expect(p.output).toThrow(UnreadableHead);
    expect(p.output).toThrow(visible(`contracts/${path} (${why})`));
    expect(p.ref(sessionRef(SESSION_ID))).toBe('');
  });

  it('refuses output past its cap, reading none of it into the commit', () => {
    const t = issued();
    t.write(REPORT, 'x'.repeat(4096));
    const box = join(t.home, 'box');
    mkdirSync(box);
    expect(() => readOutput(t.record(), box, { ...process.env, ...t.env }, 1024)).toThrow(
      /its output holds more than the 1024 bytes a role may write/,
    );
  });
});

/** Removes the feature folder the manifest commit left in the clone's working tree. */
function rmFeature(t: ReturnType<typeof issued>) {
  execFileSync('rm', ['-rf', join(t.r.path, FEATURE)]);
}

describe('the passing head and the second stop (T086, 28-5b-2)', () => {
  it('records the passing head only for a session whose start passed, and never for a failing check', async () => {
    const t = issued();
    t.write(REPORT, VERIFY.replace('pass', 'fail'));
    t.passed();
    expect((await t.stop()).block).toBe(true);
    expect(t.ref(passedRef(SESSION_ID))).toBe('');
    t.write(REPORT, VERIFY);
    expect(await t.stop()).toEqual({ block: false });
    expect(t.ref(passedRef(SESSION_ID))).toBe(t.ref(sessionRef(SESSION_ID)));
    // A later stop that fails removes it: the ref names the commit the last stop passed at.
    t.write(REPORT, VERIFY.replace('pass', 'fail'));
    expect((await t.stop()).block).toBe(true);
    expect(t.ref(passedRef(SESSION_ID))).toBe('');
    // A start record naming another session is not a passed start.
    t.write(REPORT, VERIFY);
    writeFileSync(passedPath(t.home, SESSION_ID), '{"session":"another"}\n');
    expect(await t.stop()).toEqual({ block: false });
    expect(t.ref(passedRef(SESSION_ID))).toBe('');

    const u = issued();
    u.write(REPORT, VERIFY);
    expect(await u.stop()).toEqual({ block: false });
    expect(u.ref(sessionRef(SESSION_ID))).not.toBe('');
    expect(u.ref(passedRef(SESSION_ID))).toBe('');
  });

  it('checks again at the second stop, recording a passing head, and never blocks it', async () => {
    const t = issued();
    t.passed();
    t.write(REPORT, VERIFY.replace('pass', 'fail'));
    expect(await t.stop(true)).toEqual({ block: false });
    expect(t.ref(passedRef(SESSION_ID))).toBe('');
    expect(t.events().at(-1)).toMatchObject({
      kind: 'alert',
      input_summary: expect.stringMatching(
        /^second stop, ended with no passing head: .*Review: fail/,
      ) as string,
    });
    t.write(REPORT, VERIFY);
    expect(await t.stop(true)).toEqual({ block: false });
    expect(t.ref(passedRef(SESSION_ID))).toBe(t.ref(sessionRef(SESSION_ID)));
  });

  it("logs a failure of the factory's own at the second stop, never reading it as passing", async () => {
    const t = issued();
    t.passed();
    t.write(REPORT, VERIFY);
    execFileSync('rm', ['-rf', t.project]);
    expect(await t.stop(true)).toEqual({ block: false });
    expect(t.events().at(-1)).toMatchObject({
      kind: 'alert',
      input_summary: expect.stringMatching(
        /^second stop, ended with no passing head: the factory's own check failed: git /,
      ) as string,
    });
  });

  it("runs no fsmonitor command the clone's config names, and no git status in a submodule", () => {
    const t = issued();
    t.write(REPORT, VERIFY);
    t.r.git(['update-index', '--add', '--cacheinfo', `160000,${t.head},sub`]);
    // A submodule whose own config fails a git status run inside it.
    const sub = join(t.r.path, 'sub');
    execFileSync('git', ['init', '-q', sub]);
    const who = ['-c', 'user.name=x', '-c', 'user.email=x@x'];
    execFileSync('git', ['-C', sub, ...who, 'commit', '-q', '--allow-empty', '-m', 's']);
    execFileSync('git', ['-C', sub, 'config', 'status.showUntrackedFiles', 'bogus']);
    // Set last: the test's own git would run it too; git appends its arguments after the `:`.
    t.r.git(['config', 'core.fsmonitor', 'kill -9 $PPID; :']);
    expect(t.output()).toMatchObject({ outside: [] });
    expect(t.output().unlisted).toBeUndefined();
  });

  it('commits the output when git status fails, and says it could not list the outside changes', async () => {
    const cases: [string, (t: ReturnType<typeof issued>) => void, RegExp][] = [
      [
        'a process filter that kills git',
        (t) => {
          mkdirSync(join(t.r.path, '.git', 'info'), { recursive: true });
          writeFileSync(join(t.r.path, '.git', 'info', 'attributes'), '* filter=k\n');
          t.r.git(['config', 'filter.k.process', 'kill -9 $PPID; :']);
          // The same size, a new time: git re-reads the file through its filter.
          t.write('src/login.ts', 'b\n');
          utimesSync(join(t.r.path, 'src/login.ts'), new Date(0), new Date(0));
        },
        /git status in its clone failed/,
      ],
      [
        "a submodule config git can't parse",
        (t) => {
          t.r.git(['update-index', '--add', '--cacheinfo', `160000,${t.head},sub`]);
          execFileSync('git', ['init', '-q', join(t.r.path, 'sub')]);
          writeFileSync(join(t.r.path, 'sub', '.git', 'config'), '[[[\n');
        },
        /bad config line 1/,
      ],
    ];
    for (const [name, make, why] of cases) {
      const t = issued();
      t.write(REPORT, VERIFY);
      make(t);
      expect(await t.stop(), name).toEqual({ block: false });
      const commit = t.ref(sessionRef(SESSION_ID));
      expect(runGit(t.project, ['show', `${commit}:${REPORT}`]), name).toBe(VERIFY.trim());
      const alerts = t.events().filter((e) => e.kind === 'alert');
      expect(alerts, name).toHaveLength(1);
      expect(alerts[0]?.input_summary, name).toMatch(
        /^the factory could not list the changes outside the reviewer's paths: /,
      );
      expect(alerts[0]?.input_summary, name).toMatch(why);
    }
  });

  it("logs a change outside the role's paths once, as an alert, and Test's stop fails closed until 28-5b-3b", async () => {
    const t = issued();
    t.write(REPORT, VERIFY.replace('pass', 'fail'));
    t.write('src/login.ts', 'changed\n');
    expect((await t.stop()).block).toBe(true);
    t.write(REPORT, VERIFY);
    expect(await t.stop()).toEqual({ block: false });
    expect(t.events().filter((e) => e.kind === 'alert')).toEqual([
      expect.objectContaining({
        kind: 'alert',
        input_summary: "changed outside the reviewer's paths, never committed: src/login.ts",
      }),
    ]);
    const u = issued();
    u.write(REPORT, VERIFY);
    u.r.git(['mv', 'src/login.ts', 'src/moved.ts']);
    u.write('src/a\u001bb.ts', 'x\n');
    expect(await u.stop()).toEqual({ block: false });
    expect(u.events().at(-1)?.input_summary).toBe(
      "changed outside the reviewer's paths, never committed: src/login.ts, src/moved.ts, src/a\\u{1b}b.ts",
    );
    const test = issued('test');
    test.write('tests/new.test.ts', 'x\n');
    const refused = await test.stop();
    expect(refused.block).toBe(true);
    expect(refused.reason).toMatch(
      /Test's output, which the factory commits only from slice 28-5b-3/,
    );
  });
});
