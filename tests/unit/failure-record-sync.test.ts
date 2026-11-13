// The failure record on disk in order (T061, deferred (14)): node:fs is wrapped in this file
// alone, so the order of the writer's calls can be read.
import { dirname } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ log: [] as string[], fds: new Map<number, string>() }));
vi.mock('node:fs', async (actual) => {
  const fs = await actual<typeof import('node:fs')>();
  const name = (target: unknown) =>
    typeof target === 'number' ? (calls.fds.get(target) ?? 'fd') : String(target);
  return {
    ...fs,
    openSync: (path: string, ...rest: [string, number?]) => {
      const fd = fs.openSync(path, ...rest);
      calls.fds.set(fd, path);
      return fd;
    },
    writeFileSync: (target: number | string, ...rest: [string]) => {
      calls.log.push(`write ${name(target)}`);
      fs.writeFileSync(target, ...rest);
    },
    fsyncSync: (fd: number) => {
      calls.log.push(`fsync ${name(fd)}`);
      fs.fsyncSync(fd);
    },
    renameSync: (from: string, to: string) => {
      calls.log.push(`rename ${from} ${to}`);
      fs.renameSync(from, to);
    },
  };
});

const { failureFile, readFailureRecord, writeFailureRecord } =
  await import('../../src/dispatcher/failures.js');
const { tempDir } = await import('../helpers/keys.js');

describe('writeFailureRecord on disk', () => {
  it('writes the temporary file, syncs it, renames it, then syncs the folder', () => {
    const file = failureFile(tempDir('sync-'), 'owner/project', 42, 2);
    const record = { head: 'c'.repeat(40), factory: 'f'.repeat(64), count: 1 };
    calls.log.length = 0;
    writeFailureRecord(file, record);
    const temp = /^write (.*\.tmp)$/.exec(calls.log[0] ?? '')?.[1] ?? '';
    expect(dirname(temp)).toBe(dirname(file));
    expect(calls.log).toEqual([
      `write ${temp}`,
      `fsync ${temp}`,
      `rename ${temp} ${file}`,
      `fsync ${dirname(file)}`,
    ]);
    expect(readFailureRecord(file)).toEqual(record);
  });
});
