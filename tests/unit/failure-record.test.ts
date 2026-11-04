import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  failureFile,
  readFailureRecord,
  recordIssued,
  writeFailureRecord,
} from '../../src/dispatcher/failures.js';
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
    }).toThrow(new RegExp(`^the failure record ${on} cannot be written: `));
    expect(() => {
      recordIssued(undefined, { repo: 'owner/project', item: 42, station: 4 }, HEAD);
    }).toThrow(/no failure records are set up/);
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
