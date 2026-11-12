// The session's head read out of its clone only inside the factory's bubblewrap sandbox, as a pack
// the factory's own clone indexes with git's object checks and checks whole (T086, slice 28-5a;
// Owner decision 2026-11-12), with the real bwrap and git.
import { execFileSync } from 'node:child_process';
import { readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  sessionOutput,
  sessionRef,
  UnreadableHead,
  type ReadClone,
} from '../../src/hooks/session-commits.js';
import { readSessionRecord } from '../../src/hooks/session.js';
import { makeRepo, runGit } from '../helpers/git-repo.js';
import { tempDir } from '../helpers/keys.js';
import { dispatcherClone, recordSession, SESSION_ID } from '../helpers/session.js';

const BRANCH = 'claude/42-add-login';

/** The item branch issued on origin, the dispatcher's clone of it, and the session's clone. */
function issued() {
  const r = makeRepo({ files: { 'src/login.ts': 'a\n' } });
  r.checkout(BRANCH, { create: true });
  r.commit({ 'specs/42-add-login/.station.json': '{}\n' }, 'manifest');
  r.push();
  const head = r.revParse('HEAD');
  const project = dispatcherClone(r);
  const { home, env } = recordSession({
    role: 'builder',
    station: 4,
    clone: r.path,
    head,
    project,
  });
  const read = (reader?: ReadClone) => () =>
    sessionOutput(
      readSessionRecord(home, SESSION_ID),
      home,
      SESSION_ID,
      { ...process.env, ...env },
      reader,
    );
  const ref = () =>
    runGit(project, ['for-each-ref', '--format=%(objectname)', sessionRef(SESSION_ID)]);
  return { r, head, home, project, read, ref };
}

/** A loose object written in `repo` with no checks, as a session can. */
const literally = (repo: string, type: string, body: string) =>
  execFileSync('git', ['hash-object', '-t', type, '-w', '--literally', '--stdin'], {
    cwd: repo,
    input: body,
  })
    .toString()
    .trim();

/** A reader that packs exactly `objects` from the clone and claims `tip`, as a forged clone could. */
const packing =
  (repo: string, objects: string[], tip: string): ReadClone =>
  (_clone, _head, pack) => {
    writeFileSync(
      pack,
      execFileSync('git', ['pack-objects', '--stdout', '-q'], {
        cwd: repo,
        input: `${objects.join('\n')}\n`,
      }),
    );
    return tip;
  };

const leftovers = (home: string) => readdirSync(join(home, '.factory', 'sessions', SESSION_ID));

describe("the session's head, read from its clone only inside the sandbox (T086, 28-5a)", () => {
  it("lands a good pack in the factory's own clone under refs/factory/sessions/<id>", () => {
    const { r, head, home, project, read, ref } = issued();
    const first = r.commit({ 'src/login.ts': 'b\n' }, 'Add login');
    const tip = r.commit({ 'src/login.ts': 'c\n' }, 'Fix login');

    expect(read()()).toEqual({
      repo: project,
      commit: tip,
      head,
      feature: 'specs/42-add-login',
      branch: BRANCH,
    });
    expect(ref()).toBe(tip);
    expect(runGit(project, ['cat-file', '-t', first])).toBe('commit');
    // Its working folder under the session's own is gone.
    expect(leftovers(home)).toEqual(['session.json']);
  });

  it('with no commit of its own, the session ref names the head it was issued', () => {
    const { head, read, ref } = issued();
    expect(read()().commit).toBe(head);
    expect(ref()).toBe(head);
  });

  it('refuses a pack with an object index-pack --strict rejects, which a bundle fetch on git 2.39 lets in', () => {
    const { r, head, read, ref } = issued();
    const tree = r.git(['write-tree']);
    const bad = literally(
      r.path,
      'commit',
      `tree ${tree}\nparent ${head}\nauthor no email\ncommitter x <x@x> 1 +0000\n\nx\n`,
    );
    r.git(['update-ref', `refs/heads/${BRANCH}`, bad]);

    expect(read()).toThrow(UnreadableHead);
    expect(read()).toThrow(/do not pass git's object checks: .*missingEmail/);
    expect(ref()).toBe('');
  });

  it('refuses a pack whose commit names a tree that exists nowhere', () => {
    const { r, head, read, ref } = issued();
    const ghost = literally(
      r.path,
      'commit',
      `tree ${'1'.repeat(40)}\nparent ${head}\nauthor a <a@a> 1 +0000\ncommitter a <a@a> 1 +0000\n\nx\n`,
    );

    expect(read(packing(r.path, [ghost], ghost))).toThrow(UnreadableHead);
    expect(read(packing(r.path, [ghost], ghost))).toThrow(
      /1111111111111111111111111111111111111111/,
    );
    expect(ref()).toBe('');
  });

  it('never trusts the head the clone claims: one that is not in the pack it indexed is refused', () => {
    const { r, read, ref } = issued();
    const work = r.commit({ 'src/login.ts': 'b\n' }, 'Add login');
    const blob = r.git(['rev-parse', `${work}:src/login.ts`]);

    // It packs only the blob and claims the commit, which the factory's clone never received.
    expect(read(packing(r.path, [blob], work))).toThrow(/is not a commit its own commits hold/);
    expect(ref()).toBe('');
  });

  it('refuses a head that does not follow the commit the session was issued', () => {
    const { r, read, ref } = issued();
    r.git(['reset', '-q', '--hard', 'HEAD~1']);
    r.commit({ 'src/login.ts': 'b\n' }, 'Add login');

    expect(read()).toThrow(
      /does not follow [0-9a-f]{12}, the commit it was issued: add commits, never rewrite/,
    );
    expect(ref()).toBe('');
  });

  it('sees nothing of home but the clone: objects borrowed from a folder outside it cannot be read', () => {
    const { r, read } = issued();
    const elsewhere = makeRepo({ files: { 'x.txt': 'x\n' } });
    writeFileSync(
      join(r.path, '.git', 'objects', 'info', 'alternates'),
      `${realpathSync(join(elsewhere.path, '.git', 'objects'))}\n`,
    );
    r.git(['update-ref', `refs/heads/${BRANCH}`, elsewhere.revParse('HEAD')]);

    expect(read()).toThrow(/git rev-parse in its clone failed/);
  });

  it('refuses, naming bubblewrap, when the sandbox cannot start, and leaves no working folder', () => {
    const { home } = issued();
    const run = () =>
      sessionOutput(readSessionRecord(home, SESSION_ID), home, SESSION_ID, {
        HOME: home,
        PATH: tempDir(),
      });

    expect(run).toThrow(/only inside bubblewrap, which failed/);
    expect(leftovers(home)).toEqual(['session.json']);
  });
});
