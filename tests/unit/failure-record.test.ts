import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  factoryHash,
  hashOnce,
  failureFile,
  readFailureRecord,
  recordIssued,
  writeFailureRecord,
} from '../../src/dispatcher/failures.js';
import { installedHash } from '../../src/dispatcher/launcher/local.js';
import { tempDir } from '../helpers/keys.js';

const HEAD = 'c'.repeat(40);
const FACTORY = 'f'.repeat(64);

describe('the failure record of local sessions (T061)', () => {
  it('is one file per item and station, written by rename where no session can reach', () => {
    const home = tempDir();
    const file = failureFile(home, 'owner/project', 42, 4);
    expect(file).toBe(join(home, '.factory', 'failures', 'owner', 'project', '42-4.json'));
    expect(readFailureRecord(file)).toBeUndefined();

    recordIssued(
      { home, factory: () => FACTORY },
      { repo: 'owner/project', item: 42, station: 4 },
      HEAD,
      'b'.repeat(40),
    );

    expect(readFailureRecord(file)).toEqual({ head: HEAD, factory: FACTORY, count: 0 });
    expect(readdirSync(join(file, '..'))).toEqual(['42-4.json']);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(file, '..')).mode & 0o777).toBe(0o700);
    // Another station of the same item has a record of its own.
    expect(readFailureRecord(failureFile(home, 'owner/project', 42, 5))).toBeUndefined();
  });

  it.each([
    ['not JSON', '{"head":', /is not JSON: .*; delete it, by its path, to start its count again$/],
    ['an array', '[]', /is malformed; delete it/],
    ['a count that is not a whole number', { count: 0.5 }, /is malformed/],
    ['a negative count', { count: -1 }, /is malformed/],
    ['a head that is not a commit', { head: 'main' }, /is malformed/],
    ['a factory that is not a hash', { factory: '' }, /is malformed/],
    ['a last failure that is not text', { last: 1 }, /is malformed/],
    ['a field of its own', { extra: true }, /is malformed/],
  ] as const)('stops, naming the file, at a record that is %s', (_name, change, why) => {
    const home = tempDir();
    const file = failureFile(home, 'owner/project', 42, 4);
    const record = { head: HEAD, factory: FACTORY, count: 1, last: 'it exited 1' };
    mkdirSync(join(file, '..'), { recursive: true });
    const text = typeof change === 'string' ? change : JSON.stringify({ ...record, ...change });
    writeFileSync(file, text);
    expect(() => readFailureRecord(file)).toThrow(file);
    expect(() => readFailureRecord(file)).toThrow(why);
  });

  it('stops, naming the file, at one that cannot be read or written, never reading it as none', () => {
    const home = tempDir();
    const file = failureFile(home, 'owner/project', 42, 4);
    mkdirSync(file, { recursive: true });
    expect(() => readFailureRecord(file)).toThrow(
      new RegExp(`^the failure record ${file} cannot be read: .*EISDIR.*; delete it, by its path`),
    );
    // A file where its folder goes: nothing is written, and the error names the record.
    const blocked = tempDir();
    writeFileSync(join(blocked, '.factory'), '');
    const on = failureFile(blocked, 'owner/project', 42, 4);
    expect(() => {
      writeFailureRecord(on, { head: HEAD, factory: FACTORY, count: 0 });
    }).toThrow(
      new RegExp(`^the failure record ${on} cannot be written: .*; check that .* free space`),
    );
    // One the reader would refuse is never written.
    expect(() => {
      writeFailureRecord(file, { head: 'main', factory: FACTORY, count: 0 });
    }).toThrow(`the failure record ${file} is not written: {"head":"main",`);
    rmSync(file, { recursive: true });
    expect(() => {
      writeFailureRecord(file, { head: HEAD, factory: FACTORY, count: -1 });
    }).toThrow(/is malformed$/);
    expect(readFailureRecord(file)).toBeUndefined();
    expect(() => {
      recordIssued(undefined, { repo: 'owner/project', item: 42, station: 4 }, HEAD, HEAD);
    }).toThrow(/no failure records are set up/);
  });

  it.each(['owner/..', 'owner/.', '../project', 'owner/project/x', 'owner', 'own er/project'])(
    'has no file for %j, which is not a GitHub owner/name',
    (repo) => {
      expect(() => failureFile(tempDir(), repo, 42, 4)).toThrow(/is not a GitHub owner\/name/);
    },
  );

  it('keeps one record for a repo whatever its case, as GitHub does', () => {
    const home = tempDir();
    expect(failureFile(home, 'Owner/Project.Name', 42, 4)).toBe(
      failureFile(home, 'owner/project.name', 42, 4),
    );
  });

  it('replaces a record whole, so a reader sees the old one or the new one', () => {
    const home = tempDir();
    const file = failureFile(home, 'owner/project', 42, 4);
    writeFailureRecord(file, { head: HEAD, factory: FACTORY, count: 2, last: 'capped' });
    writeFailureRecord(file, { head: 'd'.repeat(40), factory: FACTORY, count: 0 });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      head: 'd'.repeat(40),
      factory: FACTORY,
      count: 0,
    });
    expect(readdirSync(join(file, '..'))).toEqual(['42-4.json']);
  });
});

describe("the installed factory's hash (T061)", () => {
  /** A factory of the test's own: its built code and its factory/ folder. */
  function installed() {
    const root = tempDir();
    mkdirSync(join(root, 'dist', 'cli'), { recursive: true });
    mkdirSync(join(root, 'factory', 'policy'), { recursive: true });
    writeFileSync(join(root, 'dist', 'cli', 'main.js'), 'run();\n');
    writeFileSync(join(root, 'factory', 'policy', 'roles.yaml'), 'roles: {}\n');
    return { root, hash: () => factoryHash(root, ['dist', 'factory']) };
  }

  it('changes with any file of its code or its factory folder: its contents, its name or its place', () => {
    const t = installed();
    const first = t.hash();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(t.hash()).toBe(first);
    const at = (...path: string[]) => join(t.root, ...path);
    const seen = new Set([first]);
    writeFileSync(at('dist', 'cli', 'main.js'), 'run(); \n');
    seen.add(t.hash());
    // Renamed, moved in its folder, and moved to the other folder, its contents the same.
    const moves = [
      [at('dist', 'cli', 'main.js'), at('dist', 'cli', 'm.js')],
      [at('dist', 'cli', 'm.js'), at('dist', 'm.js')],
      [at('dist', 'm.js'), at('factory', 'm.js')],
    ] as const;
    for (const [from, to] of moves) {
      renameSync(from, to);
      seen.add(t.hash());
    }
    writeFileSync(at('factory', 'new.md'), '');
    seen.add(t.hash());
    expect(seen.size).toBe(6);
    // Files outside the two folders are not the factory's.
    const before = t.hash();
    writeFileSync(join(t.root, 'README.md'), 'x\n');
    expect(t.hash()).toBe(before);
    // The real one: the folder this code runs from and factory/.
    expect(installedHash()).toMatch(/^[0-9a-f]{64}$/);
    expect(installedHash()).not.toBe(factoryHash(join(import.meta.dirname, '../..'), ['factory']));
  });

  it('hashes a symlink as its link, never following it', () => {
    const t = installed();
    const outside = tempDir();
    writeFileSync(join(outside, 'a.js'), 'a\n');
    writeFileSync(join(outside, 'b.js'), 'b\n');
    symlinkSync(join(outside, 'a.js'), join(t.root, 'dist', 'link.js'));
    const linked = t.hash();
    writeFileSync(join(outside, 'a.js'), 'changed\n');
    expect(t.hash()).toBe(linked);
    rmSync(join(t.root, 'dist', 'link.js'));
    symlinkSync(join(outside, 'b.js'), join(t.root, 'dist', 'link.js'));
    expect(t.hash()).not.toBe(linked);
  });

  it('stops, naming it, at a file it cannot read or one that is not a file, never a partial hash', () => {
    const t = installed();
    const fifo = join(t.root, 'factory', 'pipe');
    execFileSync('mkfifo', [fifo]);
    expect(t.hash).toThrow(
      `the installed factory cannot be hashed: ${fifo}: it is not a regular file, a folder or a symlink; reinstall the pinned release, or remove that file if it is not the factory's`,
    );
    rmSync(fifo);
    const secret = join(t.root, 'dist', 'cli', 'main.js');
    chmodSync(secret, 0o000);
    // Root reads it anyway; the check holds for every other user, CI's included.
    if (process.getuid?.() !== 0)
      expect(t.hash).toThrow(
        new RegExp(`^the installed factory cannot be hashed: ${secret}: .*EACCES`),
      );
    chmodSync(secret, 0o644);
    expect(() => factoryHash(t.root, ['dist', 'missing'])).toThrow(/missing: .*ENOENT/);
  });

  it('takes the hash once, so a release installed later does not change it', () => {
    const t = installed();
    const hash = hashOnce(t.root, ['dist', 'factory']);
    writeFileSync(join(t.root, 'factory', 'policy', 'roles.yaml'), 'roles: { new: {} }\n');
    expect(hash()).not.toBe(t.hash());
    // One that cannot be taken is an error only once the hash is needed.
    const broken = hashOnce(t.root, ['dist', 'missing']);
    expect(broken).toThrow(/cannot be hashed: .*missing: .*ENOENT/);
  });
});
