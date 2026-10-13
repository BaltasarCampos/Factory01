// The factory's own writes and reads in folders a sandboxed run can also write to (T164, slice
// 23a-2; Owner decisions 2026-10-13): a planted file or link makes the write or read refuse, and
// nothing outside is written or read through it.
import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RefusedError } from '../../src/cli/env.js';
import {
  createFile,
  freshFolder,
  readCapped,
  realFolder,
  replaceFile,
} from '../../src/fs/safe-files.js';
import { tempDir } from '../helpers/keys.js';

/** A file outside every folder under test, and its content, which must never change. */
function outsideFile(text = 'the Owner’s key\n') {
  const path = join(tempDir(), 'approve_ed25519');
  writeFileSync(path, text);
  return path;
}

describe('createFile', () => {
  it('creates a new file with the given mode', () => {
    const path = join(tempDir(), 'config.mjs');
    createFile(path, 'export default {};\n');
    expect(readFileSync(path, 'utf8')).toBe('export default {};\n');
    expect(statSync(path).mode & 0o777).toBe(0o644);
  });

  it.each([
    [
      'a regular file',
      (path: string) => {
        writeFileSync(path, 'planted\n');
      },
    ],
    [
      'a link to a file outside',
      (path: string) => {
        symlinkSync(outsideFile(), path);
      },
    ],
    [
      'a dangling link',
      (path: string) => {
        symlinkSync(join(tempDir(), 'new-file'), path);
      },
    ],
  ])('refuses when %s is already there, and writes nothing through it', (_, plant) => {
    const dir = tempDir();
    const path = join(dir, 'vitest.config.mjs');
    plant(path);
    const before = lstatSync(path).isSymbolicLink() ? undefined : readFileSync(path, 'utf8');

    expect(() => {
      createFile(path, 'factory text');
    }).toThrow(RefusedError);
    expect(() => {
      createFile(path, 'factory text');
    }).toThrow(`${path} was already there`);
    if (before !== undefined) expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('refuses to write through a folder that is a link', () => {
    const outside = tempDir();
    const dir = tempDir();
    symlinkSync(outside, join(dir, 'config'));

    expect(() => {
      createFile(join(dir, 'config', 'reporter.mjs'), 'x');
    }).toThrow(/not a folder/);
    expect(readdirSync(outside)).toEqual([]);
  });
});

describe('readCapped', () => {
  it('reads a regular file; a missing one is undefined', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'results.json'), '{"testResults":[]}');
    expect(readCapped(join(dir, 'results.json'), 1024)).toBe('{"testResults":[]}');
    expect(readCapped(join(dir, 'lcov.info'), 1024)).toBeUndefined();
  });

  it('refuses a link, even to a file that looks like results, and reads nothing through it', () => {
    const dir = tempDir();
    symlinkSync(outsideFile('{"testResults":[]}'), join(dir, 'results.json'));
    expect(() => readCapped(join(dir, 'results.json'), 1024)).toThrow(/is a link/);
  });

  it('refuses a file in a folder that is a link', () => {
    const outside = tempDir();
    writeFileSync(join(outside, 'lcov.info'), 'TN:\n');
    const dir = tempDir();
    symlinkSync(outside, join(dir, 'coverage'));
    expect(() => readCapped(join(dir, 'coverage', 'lcov.info'), 1024)).toThrow(/not a folder/);
  });

  it('refuses a folder or a FIFO in place of a file, without waiting on the FIFO', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'results.json'));
    execFileSync('mkfifo', [join(dir, 'lcov.info')]);
    expect(() => readCapped(join(dir, 'results.json'), 1024)).toThrow(/not a regular file/);
    expect(() => readCapped(join(dir, 'lcov.info'), 1024)).toThrow(/not a regular file/);
  });

  it('refuses a file over the cap', () => {
    const path = join(tempDir(), 'results.json');
    writeFileSync(path, 'x'.repeat(2048));
    expect(() => readCapped(path, 1024)).toThrow(/larger than 1024 bytes/);
  });
});

describe('freshFolder and realFolder', () => {
  it('freshFolder makes a new folder and refuses one that is already there, or a link', () => {
    const work = tempDir();
    freshFolder(join(work, 'base'), 'an earlier sandboxed run made it');
    expect(statSync(join(work, 'base')).isDirectory()).toBe(true);

    expect(() => {
      freshFolder(join(work, 'base'), 'an earlier sandboxed run made it');
    }).toThrow(`${join(work, 'base')} was already there: an earlier sandboxed run made it`);
    symlinkSync(tempDir(), join(work, 'head'));
    expect(() => {
      freshFolder(join(work, 'head'), 'an earlier sandboxed run made it');
    }).toThrow(RefusedError);
  });

  it('realFolder refuses a link anywhere on the way', () => {
    const outside = tempDir();
    const work = tempDir();
    symlinkSync(outside, join(work, 'base'));
    expect(() => {
      realFolder(join(work, 'base', 'tree'));
    }).toThrow(/not a folder/);
    expect(readdirSync(outside)).toEqual([]);
  });
});

describe('replaceFile', () => {
  it('replaces an old report, and removes a link in its place without writing through it', () => {
    const outside = outsideFile();
    const dir = join(tempDir(), 'coverage');
    replaceFile(join(dir, 'lcov.info'), 'old\n');
    replaceFile(join(dir, 'lcov.info'), 'new\n');
    symlinkSync(outside, join(dir, 'vitest-results.json'));

    replaceFile(join(dir, 'vitest-results.json'), '{}');

    expect(readFileSync(join(dir, 'lcov.info'), 'utf8')).toBe('new\n');
    expect(lstatSync(join(dir, 'vitest-results.json')).isFile()).toBe(true);
    expect(readFileSync(outside, 'utf8')).toBe('the Owner’s key\n');
  });

  it('refuses a reports folder that is a link, and writes nothing through it', () => {
    const outside = tempDir();
    const repo = tempDir();
    symlinkSync(outside, join(repo, 'coverage'));

    expect(() => {
      replaceFile(join(repo, 'coverage', 'lcov.info'), 'TN:\n');
    }).toThrow(/not a folder/);
    expect(readdirSync(outside)).toEqual([]);
  });
});
