// The Stop hook's commit for the roles that commit nothing themselves (T086, slices 28-5b and
// 28-5b-2): their output read in the read-only sandbox, committed in the factory's own clone with
// plumbing, the passing head recorded apart, and the second stop; with the real bwrap and git.
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hookOutput, readOutput, walkClone, walkRoots } from '../../src/hooks/output-commit.js';
import { passedRef, sessionRef, UnreadableHead } from '../../src/hooks/session-commits.js';
import { passedPath, readSessionRecord, sessionEvents } from '../../src/hooks/session.js';
import { runStop } from '../../src/hooks/stop.js';
import { visible } from '../../src/notify/summary.js';
import { makeRepo, runGit } from '../helpers/git-repo.js';
import { tempDir } from '../helpers/keys.js';
import { dispatcherClone, recordSession, SESSION_ID } from '../helpers/session.js';
import { checkSpawns, timed } from '../helpers/timed-spawns.js';

// Every program a stop starts carries its deadline (slice 28-5c-2).
vi.mock('node:child_process', async (real) =>
  (await import('../helpers/timed-spawns.js')).timedSpawns(real),
);
afterEach(checkSpawns);

const FEATURE = 'specs/42-add-login';
const BRANCH = 'claude/42-add-login';
const CONFIG = `factory_release: v1.0.0@${'a'.repeat(40)}\nagents: local\nprofile: typescript\nrepo: owner/project\ninbox_issue: 1\n`;
const VERIFY = '| Check | Result |\n|---|---|\n| Review | pass |\n';
const REPORT = `${FEATURE}/reports/verify.md`;

/** The item branch issued on origin, the dispatcher's clone of it, and a session of `role`. */
function issued(
  role = 'reviewer',
  station = 5,
  files: Record<string, string> = {},
  tests: string[] = [],
  prepare?: (r: ReturnType<typeof makeRepo>) => void,
) {
  const r = makeRepo({ files: { '.factory/config': CONFIG, 'src/login.ts': 'a\n', ...files } });
  prepare?.(r);
  r.checkout(BRANCH, { create: true });
  r.commit({ [`${FEATURE}/.station.json`]: '{}\n' }, 'manifest');
  r.push();
  const head = r.revParse('HEAD');
  const project = dispatcherClone(r);
  const { home, env, log } = recordSession({
    role,
    station,
    clone: r.path,
    head,
    project,
    tests,
  });
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
    (existsSync(log) ? readFileSync(log, 'utf8') : '')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { kind: string; input_summary: string });
  /** The one parent of the commit `name` names, or '' when it has another number of them. */
  const parentOf = (name: string) => {
    const [, ...parents] = runGit(project, ['rev-list', '--parents', '-n', '1', name]).split(' ');
    return parents.length === 1 ? (parents[0] ?? '') : '';
  };
  return {
    r,
    head,
    home,
    env,
    log,
    project,
    write,
    record,
    output,
    ref,
    parentOf,
    stop,
    passed,
    events,
  };
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

describe("the Stop hook's own deadline (T086, 28-5c-1)", () => {
  it("fails with its limit, never git's, when its git runs together pass it", async () => {
    const t = issued();
    t.write(REPORT, VERIFY);
    const bin = tempDir('slow-git-');
    const git = execFileSync('sh', ['-c', 'command -v git']).toString().trim();
    writeFileSync(join(bin, 'git'), `#!/bin/sh\nsleep 2\nexec ${git} "$@"\n`, { mode: 0o755 });
    const env = { ...t.env, PATH: `${bin}:${process.env.PATH ?? ''}` };
    const input = { session_id: SESSION_ID, cwd: t.r.path, hook_event_name: 'Stop' };
    const ctx = { cwd: t.r.path, now: () => new Date(), env };
    await expect(runStop(input, ctx, undefined, 1000)).rejects.toThrow(
      /^the Stop hook ran past its 1 s limit, so the factory could not check the session's output/,
    );
    expect(t.events().at(-1)).toMatchObject({
      kind: 'blocked',
      input_summary: expect.stringMatching(/ran past its 1 s limit/) as string,
    });
    // The second stop is never blocked, and logs the same reason.
    expect(await runStop({ ...input, stop_hook_active: true }, ctx, undefined, 1000)).toEqual({
      block: false,
    });
    expect(t.events().at(-1)?.input_summary).toMatch(/ran past its 1 s limit/);
    expect(await runStop(input, { ...ctx, env: t.env })).toEqual({ block: false });
  }, 60_000);

  it("bounds every program a stop starts, Intake's gh included, and stops a slow gh at the deadline", async () => {
    timed.splice(0);
    const t = tested();
    t.write(NEW, 'it("b")\n');
    await t.stop();
    expect(timed).toEqual(expect.arrayContaining(['spawnSync bwrap', 'spawnSync git']));
    const bin = tempDir('gh-');
    const r = makeRepo({ files: { '.factory/config': CONFIG } });
    const { env } = recordSession({
      role: 'intake',
      station: 1,
      clone: r.path,
      head: r.revParse('HEAD'),
    });
    const input = { session_id: SESSION_ID, cwd: r.path, hook_event_name: 'Stop' };
    const stop = (wait: number, limit?: number) => {
      writeFileSync(
        join(bin, 'gh'),
        `#!/bin/sh\nsleep ${String(wait)}\necho '{"number":42,"state":"OPEN","labels":[],"comments":[]}'\n`,
        {
          mode: 0o755,
        },
      );
      // Intake's check runs gh with the process's own environment.
      vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
      const ctx = { cwd: r.path, now: () => new Date(), env };
      return runStop(input, ctx, undefined, limit).finally(() => vi.unstubAllEnvs());
    };
    timed.splice(0);
    expect((await stop(0)).block).toBe(true);
    expect(timed).toContain('execFile gh');
    await expect(stop(3, 1000)).rejects.toThrow(/^the Stop hook ran past its 1 s limit/);
    // A gh that ignores SIGTERM is killed at the deadline all the same.
    writeFileSync(join(bin, 'gh'), "#!/bin/sh\ntrap '' TERM\nsleep 30\n", { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
    const started = Date.now();
    const ctx = { cwd: r.path, now: () => new Date(), env };
    await expect(
      runStop(input, ctx, undefined, 1000).finally(() => vi.unstubAllEnvs()),
    ).rejects.toThrow(/^the Stop hook ran past its 1 s limit/);
    expect(Date.now() - started).toBeLessThan(5000);
  }, 60_000);
});

describe('the events commit the passing head names (T086, 28-5c-3b)', () => {
  const EVENTS = `${FEATURE}/events.jsonl`;
  // Two lines already on the branch, the last cut short, with bytes JSON.parse would rewrite.
  const OLD = '{"kind":"seed","note":"caf\u00e9 \\u00e9"}\n{"kind":"cut"';

  it('has the checked commit as its one parent, changes only the log, and appends the lines', async () => {
    const t = issued('reviewer', 5, { [EVENTS]: OLD });
    t.passed();
    t.write(REPORT, VERIFY.replace('pass', 'fail'));
    expect((await t.stop()).block).toBe(true);
    t.write(REPORT, VERIFY);
    expect(await t.stop()).toEqual({ block: false });

    const passed = t.ref(passedRef(SESSION_ID));
    const checked = t.ref(sessionRef(SESSION_ID));
    expect(passed).not.toBe(checked);
    expect(t.parentOf(passed)).toBe(checked);
    const changed = ['diff-tree', '--no-commit-id', '--name-only', '-r', passed];
    expect(runGit(t.project, changed)).toBe(EVENTS);
    const shown = execFileSync('git', ['-C', t.project, 'show', `${passed}:${EVENTS}`]);
    expect(shown.toString('utf8')).toBe(`${OLD}\n${readFileSync(t.log, 'utf8')}`);
    expect(t.events().map((e) => e.kind)).toEqual(['blocked']);
    const trailers = ['log', '-1', '--format=%an|%(trailers:only,unfold)', passed];
    expect(runGit(t.project, trailers)).toBe(
      'Factory reviewer|Factory-Role: reviewer\nFactory-Item: 42-add-login',
    );
  });

  /** The passing stop's outcome: no passing head, the session ref kept, an alert saying why. */
  const unmade = (t: ReturnType<typeof issued>, why: RegExp) => {
    expect(t.ref(passedRef(SESSION_ID))).toBe('');
    expect(t.ref(sessionRef(SESSION_ID))).not.toBe('');
    const last = t.events().at(-1);
    expect(last?.kind).toBe('alert');
    expect(last?.input_summary).toMatch(
      /^no passing head: the factory could not append the session's log to the item's event log, its own error, which this session cannot fix: /,
    );
    expect(last?.input_summary).toMatch(why);
  };

  it('records no passing head, and an alert says why, for a log line that is not an event', async () => {
    const t = issued();
    t.passed();
    t.write(REPORT, VERIFY);
    writeFileSync(t.log, '{"kind":"blocked"}\n', { flag: 'a' });
    expect(await t.stop()).toEqual({ block: false });
    unmade(t, /line 1 of the session's log is not an event/);
  });

  it('records no passing head, and an alert says why, for a log on the branch that is a folder', async () => {
    const t = issued('reviewer', 5, { [`${EVENTS}/x`]: 'x\n' });
    t.passed();
    t.write(REPORT, VERIFY.replace('pass', 'fail'));
    expect((await t.stop()).block).toBe(true);
    t.write(REPORT, VERIFY);
    expect(await t.stop()).toEqual({ block: false });
    unmade(t, /events\.jsonl at \w+ is not a regular file/);
  });
});

/** Removes the feature folder the manifest commit left in the clone's working tree. */
function rmFeature(t: ReturnType<typeof issued>) {
  execFileSync('rm', ['-rf', join(t.r.path, FEATURE)]);
}

describe('the passing head and the second stop (T086, 28-5b-2)', () => {
  it.each([sessionRef(SESSION_ID), passedRef(SESSION_ID)])(
    'fails, never overwriting it, when another hook moves %s under it',
    async (ref) => {
      const t = issued();
      t.passed();
      t.write(REPORT, VERIFY);
      const bin = tempDir('racing-git-');
      const git = execFileSync('sh', ['-c', 'command -v git']).toString().trim();
      const race = `case " $* " in *" update-ref ${ref} "*) ${git} update-ref ${ref} ${t.head};; esac`;
      writeFileSync(join(bin, 'git'), `#!/bin/sh\n${race}\nexec ${git} "$@"\n`, { mode: 0o755 });
      const env = { ...t.env, PATH: `${bin}:${process.env.PATH ?? ''}` };
      const input = { session_id: SESSION_ID, cwd: t.r.path, hook_event_name: 'Stop' };
      await expect(runStop(input, { cwd: t.r.path, now: () => new Date(), env })).rejects.toThrow(
        /^another run of the Stop hook wrote .* at the same time: the factory's own error, which this session cannot fix; check that the pin registers each hook once \(git: .*(already exists|but expected)/,
      );
      expect(t.ref(ref)).toBe(t.head);
    },
  );

  it('fails, never removing it, when another hook moves the passing head before its removal', async () => {
    const t = issued();
    t.passed();
    t.write(REPORT, VERIFY);
    expect(await t.stop()).toEqual({ block: false });
    const ref = passedRef(SESSION_ID);
    expect(t.ref(ref)).not.toBe(t.head);
    const bin = tempDir('racing-git-');
    const git = execFileSync('sh', ['-c', 'command -v git']).toString().trim();
    const race = `case " $* " in *" update-ref -d ${ref} "*) ${git} update-ref ${ref} ${t.head};; esac`;
    writeFileSync(join(bin, 'git'), `#!/bin/sh\n${race}\nexec ${git} "$@"\n`, { mode: 0o755 });
    const env = { ...t.env, PATH: `${bin}:${process.env.PATH ?? ''}` };
    const input = { session_id: SESSION_ID, cwd: t.r.path, hook_event_name: 'Stop' };
    await expect(runStop(input, { cwd: t.r.path, now: () => new Date(), env })).rejects.toThrow(
      /^another run of the Stop hook wrote refs\/.* at the same time: .*check that the pin registers each hook once/,
    );
    expect(t.ref(ref)).toBe(t.head);
  });

  it('names a leftover ref lock and the way out, never a lost race', async () => {
    const t = issued();
    t.passed();
    t.write(REPORT, VERIFY);
    const common = runGit(t.project, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    const lock = join(common, `${sessionRef(SESSION_ID)}.lock`);
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, '');
    const refused = t.stop();
    await expect(refused).rejects.toThrow(
      /^the factory could not write refs\/factory\/sessions\/\S+ in .*\(git: .*\.lock.*\); if no git is running, remove the \.lock file git names$/,
    );
    await expect(refused).rejects.not.toThrow(/another run of the Stop hook/);
  });

  it('names a leftover packed-refs.lock on the removal of the passing head, keeping it', async () => {
    const t = issued();
    t.passed();
    t.write(REPORT, VERIFY);
    expect(await t.stop()).toEqual({ block: false });
    const at = t.ref(passedRef(SESSION_ID));
    const common = runGit(t.project, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    writeFileSync(join(common, 'packed-refs.lock'), '');
    await expect(t.stop()).rejects.toThrow(
      /^the factory could not write refs\/factory\/passed\/\S+ in .*packed-refs\.lock.*; if no git is running, remove the \.lock file git names$/,
    );
    expect(t.ref(passedRef(SESSION_ID))).toBe(at);
  });

  it.each([sessionRef(SESSION_ID), passedRef(SESSION_ID)])(
    'refuses a broken %s, never reading it as absent',
    async (ref) => {
      const t = issued();
      t.passed();
      t.write(REPORT, VERIFY);
      const common = runGit(t.project, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
      mkdirSync(dirname(join(common, ref)), { recursive: true });
      writeFileSync(join(common, ref), 'not a commit\n');
      await expect(t.stop()).rejects.toThrow(
        new RegExp(`^the factory could not read ${ref} in .*, which this session cannot fix: `),
      );
      expect(readFileSync(join(common, ref), 'utf8')).toBe('not a commit\n');
    },
  );

  it("keeps the note that the blocked event was not written on the factory's own error", async () => {
    const t = issued();
    t.write(REPORT, VERIFY);
    const log = sessionEvents(t.home, SESSION_ID);
    rmSync(log, { force: true });
    mkdirSync(log, { recursive: true });
    const input = { session_id: SESSION_ID, cwd: t.r.path, hook_event_name: 'Stop' };
    const ctx = { cwd: t.r.path, now: () => new Date(), env: t.env };
    await expect(runStop(input, ctx, { 5: () => ({ complete: true }) })).rejects.toThrow(
      /passed without reading the session's output.* \(the blocked event was not written: /,
    );
  });

  it('records the passing head only for a session whose start passed, and never for a failing check', async () => {
    const t = issued();
    t.write(REPORT, VERIFY.replace('pass', 'fail'));
    t.passed();
    expect((await t.stop()).block).toBe(true);
    expect(t.ref(passedRef(SESSION_ID))).toBe('');
    t.write(REPORT, VERIFY);
    expect(await t.stop()).toEqual({ block: false });
    // The events commit on the head the check passed (28-5c-3b).
    expect(t.parentOf(passedRef(SESSION_ID))).toBe(t.ref(sessionRef(SESSION_ID)));
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
    // The events commit on the head the check passed (28-5c-3b).
    expect(t.parentOf(passedRef(SESSION_ID))).toBe(t.ref(sessionRef(SESSION_ID)));
  });

  it('passes with a stale packed-refs lock in the factory clone when there is no passing head to remove', async () => {
    const t = issued();
    t.passed();
    t.write(REPORT, VERIFY);
    const common = runGit(t.project, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    writeFileSync(join(common, 'packed-refs.lock'), '');
    expect(await t.stop()).toEqual({ block: false });
    expect(t.ref(passedRef(SESSION_ID))).toBe(t.ref(sessionRef(SESSION_ID)));
  });

  it("is the factory's error when a check passes without reading the output, but Intake's", async () => {
    const t = issued();
    t.write(REPORT, VERIFY);
    const input = { session_id: SESSION_ID, cwd: t.r.path, hook_event_name: 'Stop' };
    const ctx = { cwd: t.r.path, now: () => new Date(), env: t.env };
    await expect(runStop(input, ctx, { 5: () => ({ complete: true }) })).rejects.toThrow(
      /the station verify check passed without reading the session's output/,
    );
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

  it("logs a change outside the role's paths once, as an alert", async () => {
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
  });
});

const EXISTING = 'tests/login.test.ts';
const NEW = 'tests/new.test.ts';
const SNAPSHOT = 'tests/__snapshots__/new.test.ts.snap';

/** A Test session on a branch whose head has one test file, `EXISTING`, its record's `tests`. */
const tested = () => issued('test', 5, { [EXISTING]: 'it("a")\n' }, [EXISTING]);

describe("Test's output: only new test files, and their snapshots (T086, 28-5b-3b)", () => {
  it('commits an added test and the snapshot beside it, the existing test unchanged', async () => {
    const t = tested();
    t.passed();
    t.write(NEW, 'it("b")\n');
    t.write(SNAPSHOT, 'exports[`b`] = 1;\n');
    expect(await t.stop()).toEqual({ block: false });
    const commit = t.ref(passedRef(SESSION_ID));
    const git = (args: string[]) => runGit(t.project, args);
    expect(git(['diff-tree', '--no-commit-id', '--name-only', '-r', commit]).split('\n')).toEqual([
      SNAPSHOT,
      NEW,
    ]);
    expect(git(['log', '-1', '--format=%an|%(trailers:only,unfold)', commit])).toBe(
      'Factory test|Factory-Role: test\nFactory-Item: 42-add-login',
    );
    expect(t.events()).toEqual([]);
  });

  it.each([
    [
      'changed',
      (t: ReturnType<typeof tested>) => {
        t.write(EXISTING, 'it("weaker")\n');
      },
    ],
    [
      'deleted',
      (t: ReturnType<typeof tested>) => {
        execFileSync('rm', [join(t.r.path, EXISTING)]);
      },
    ],
  ])('blocks the stop when an existing test file is %s, committing nothing', async (_n, make) => {
    const t = tested();
    t.write(NEW, 'it("b")\n');
    make(t);
    const { block, reason } = await t.stop();
    expect(block).toBe(true);
    expect(reason).toContain(
      `an existing test file changed or deleted, never committed: ${EXISTING}; restore it; Test's output is only new test files`,
    );
    expect(t.ref(sessionRef(SESSION_ID))).toBe('');
  });

  it('names a snapshot with no added test, a helper and other changes in the alert, never committing them', async () => {
    const t = tested();
    t.write(NEW, 'it("b")\n');
    t.write('tests/__snapshots__/login.test.ts.snap', 'x\n');
    t.write('tests/helper.ts', 'x\n');
    t.write('src/login.ts', 'changed\n');
    t.write('node_modules/x/a.test.ts', 'x\n');
    t.write('tests/node_modules/b.test.ts', 'x\n');
    expect(await t.stop()).toEqual({ block: false });
    const commit = t.ref(sessionRef(SESSION_ID));
    expect(runGit(t.project, ['diff-tree', '--no-commit-id', '--name-only', '-r', commit])).toBe(
      NEW,
    );
    expect(t.events().at(-1)?.input_summary).toMatch(
      /^changed outside the test's paths, never committed: .*tests\/__snapshots__\/login\.test\.ts\.snap/,
    );
    expect(t.events().at(-1)?.input_summary).toMatch(/tests\/helper\.ts/);
  });

  it('ends incomplete when it added no test file, and refuses a link named as one', async () => {
    const t = tested();
    expect((await t.stop()).reason).toMatch(/a new test file: this session added none/);
    symlinkSync(join(t.r.path, EXISTING), join(t.r.path, NEW));
    expect((await t.stop()).reason).toMatch(
      /tests\/new\.test\.ts \(a link at tests\/new\.test\.ts\)/,
    );
  });

  it("is the factory's error when the record names a test its head lacks", () => {
    const t = issued('test', 5, {}, ['tests/gone.test.ts']);
    t.write(NEW, 'it("b")\n');
    expect(t.output).toThrow(/names tests its head .* does not have, tests\/gone\.test\.ts/);
  });

  it("refuses a clone past the entries it walks, counting only under the patterns' roots", () => {
    const t = tested();
    const box = join(t.home, 'box');
    mkdirSync(box);
    for (const name of ['a', 'b', 'c', 'd']) t.write(`dist/${name}.js`, 'x\n');
    const env = { ...process.env, ...t.env };
    expect(walkClone(t.record(), box, env, 3).paths).toEqual([EXISTING]);
    for (const name of ['a', 'b', 'c']) t.write(`tests/${name}.test.ts`, 'x\n');
    expect(() => walkClone(t.record(), box, env, 3)).toThrow(
      /its clone holds more than the 3 entries the factory walks for Test's output, under tests\//,
    );
    expect(walkRoots(['tests/**/*.test.ts', 'tests/unit/*.test.ts', 'e2e/x/*.spec.ts'])).toEqual([
      'tests',
      'e2e/x',
    ]);
    expect(walkRoots(['**/*.test.ts', 'tests/*.test.ts'])).toEqual(['']);
    expect(walkRoots(['tests/@(a|b)/*.test.ts', 'e2e/+(x)/*.test.ts'])).toEqual(['tests', 'e2e']);
  });

  it.each([
    [
      'a file above it',
      { 'tests/a/helper': 'x\n' },
      (t: ReturnType<typeof tested>) => {
        rmSync(join(t.r.path, 'tests/a/helper'));
        t.write('tests/a/helper/x.test.ts', 'it("b")\n');
      },
      'tests/a/helper/x.test.ts (the head has a file, folder or submodule there; remove it)',
    ],
    [
      'a folder at it',
      { 'tests/dir.test.ts/a.txt': 'x\n' },
      (t: ReturnType<typeof tested>) => {
        rmSync(join(t.r.path, 'tests/dir.test.ts'), { recursive: true });
        t.write('tests/dir.test.ts', 'it("b")\n');
      },
      'tests/dir.test.ts (the head has a file, folder or submodule there; remove it)',
    ],
    [
      'a submodule above it',
      {},
      (t: ReturnType<typeof tested>) => {
        t.write('tests/sub/x.test.ts', 'it("b")\n');
      },
      'tests/sub (the head has a submodule there; remove what is in it)',
    ],
    [
      'the same path in another letter case',
      {},
      (t: ReturnType<typeof tested>) => {
        t.write('tests/Login.test.ts', 'it("b")\n');
      },
      'tests/Login.test.ts (the head has tests/login.test.ts, which a case-folding file system would overwrite; rename it)',
    ],
  ])(
    'refuses an added test where the head has %s, naming it, never as its own error',
    async (_n, files, make, why) => {
      const t = issued('test', 5, { [EXISTING]: 'it("a")\n', ...files }, [EXISTING], (r) => {
        mkdirSync(join(r.path, 'tests/sub'), { recursive: true });
        r.git(['update-index', '--add', '--cacheinfo', `160000,${r.revParse('HEAD')},tests/sub`]);
        r.git(['commit', '-q', '-m', 'sub']);
      });
      make(t);
      const { block, reason } = await t.stop();
      expect(block).toBe(true);
      expect(reason).toContain(
        `station verify output cannot be read: its output cannot be committed: ${why}`,
      );
      expect(t.ref(sessionRef(SESSION_ID))).toBe('');
    },
  );

  it.each([
    [
      'a link',
      (path: string) => {
        symlinkSync(tempDir(), path);
      },
    ],
    [
      'not a folder',
      (path: string) => {
        writeFileSync(path, 'x\n');
      },
    ],
  ])(
    'refuses a walk root that is %s, where tests would vanish as none added',
    async (what, make) => {
      const t = issued('test', 5);
      make(join(t.r.path, 'tests'));
      expect((await t.stop()).reason).toContain(
        `the factory could not read tests in its clone for Test's output (${what}): make it a folder, or remove it`,
      );
    },
  );

  it('refuses a folder or a test it cannot read, naming the way out', async () => {
    const t = tested();
    t.write(NEW, 'it("b")\n');
    chmodSync(join(t.r.path, NEW), 0o000);
    expect((await t.stop()).reason).toContain(
      `${NEW} (cannot be read (EACCES): make it readable, or remove it)`,
    );
    chmodSync(join(t.r.path, NEW), 0o644);
    mkdirSync(join(t.r.path, 'tests/locked'));
    chmodSync(join(t.r.path, 'tests/locked'), 0o000);
    try {
      expect((await t.stop()).reason).toContain(
        "the factory could not read tests/locked in its clone for Test's output (EACCES): make it readable, or remove it",
      );
    } finally {
      chmodSync(join(t.r.path, 'tests/locked'), 0o755);
    }
  });

  it("takes a head whose test files pass the command line's limit", async () => {
    // About 2.5 MB of paths: on the command line, spawn fails with E2BIG.
    const many = Object.fromEntries(
      Array.from({ length: 12_000 }, (_, i) => [
        `tests/${String(i).padStart(5, '0')}${'x'.repeat(190)}.test.ts`,
        'it("a")\n',
      ]),
    );
    const t = issued('test', 5, many, []);
    t.passed();
    t.write(NEW, 'it("b")\n');
    expect(await t.stop()).toEqual({ block: false });
    expect(
      runGit(t.project, [
        'diff-tree',
        '--no-commit-id',
        '--name-only',
        '-r',
        t.ref(passedRef(SESSION_ID)),
      ]),
    ).toBe(NEW);
  }, 120_000);
});
