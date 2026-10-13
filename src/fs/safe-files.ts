// The factory's own writes and reads in folders that code it does not trust can write to too: the
// test workspace, which every sandboxed run can write anywhere in, a release folder, and the
// checkout's `coverage/` (T069, T164; Owner decisions 2026-10-13). A no-follow open guards only a
// path's last part, so every folder on the way must be a real folder; a file is created only if
// nothing is there, and read only if it is a regular file under a size cap. A planted file or
// link makes the write or read refuse; nothing outside is written or read through one.
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { RefusedError } from '../cli/env.js';

const code = (err: unknown) => (err as NodeJS.ErrnoException).code;

/** `path` as a real folder, made when missing; no part of it may be a link. */
export function realFolder(path: string): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined) {
    realFolder(dirname(path));
    mkdirSync(path);
  } else if (!stat.isDirectory() || realpathSync(path) !== path)
    throw new RefusedError(`${path} is not a folder: refusing to write through it`);
}

/** Makes `path`, a new folder in a real one; refuses, saying `why`, if anything is there. */
export function freshFolder(path: string, why: string): void {
  realFolder(dirname(path));
  try {
    mkdirSync(path);
  } catch (err) {
    if (code(err) === 'EEXIST') throw new RefusedError(`${path} was already there: ${why}`);
    throw err;
  }
}

const CREATE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

/** Creates `path` in a real folder, never over or through anything already there. */
export function createFile(path: string, data: string | Uint8Array, mode = 0o644): void {
  realFolder(dirname(path));
  let fd: number;
  try {
    fd = openSync(path, CREATE, mode);
  } catch (err) {
    if (code(err) === 'EEXIST' || code(err) === 'ELOOP')
      throw new RefusedError(`${path} was already there: refusing to write over it`);
    throw err;
  }
  try {
    writeSync(fd, typeof data === 'string' ? Buffer.from(data) : data);
    fchmodSync(fd, mode);
  } finally {
    closeSync(fd);
  }
}

/** Replaces the regular file at `path`, or a link there, without following it. */
export function replaceFile(path: string, data: string): void {
  realFolder(dirname(path));
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat?.isDirectory() === true)
    throw new RefusedError(`${path} is a folder: refusing to replace it`);
  if (stat !== undefined) unlinkSync(path);
  createFile(path, data);
}

// Non-blocking, so a FIFO planted in place of a file is refused rather than waited on.
const READ = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/**
 * The regular file at `path` in a real folder, as text; undefined when nothing is there. A link,
 * anything but a regular file, or a file over `cap` bytes is refused.
 */
export function readCapped(path: string, cap: number): string | undefined {
  const folder = dirname(path);
  const stat = lstatSync(folder, { throwIfNoEntry: false });
  if (stat === undefined) return undefined;
  if (!stat.isDirectory() || realpathSync(folder) !== folder)
    throw new RefusedError(`${folder} is not a folder: refusing to read through it`);
  let fd: number;
  try {
    fd = openSync(path, READ);
  } catch (err) {
    if (code(err) === 'ENOENT') return undefined;
    if (code(err) === 'ELOOP')
      throw new RefusedError(`${path} is a link: refusing to read through it`);
    throw err;
  }
  try {
    const file = fstatSync(fd);
    if (!file.isFile()) throw new RefusedError(`${path} is not a regular file`);
    // One byte past the cap tells a file that grew after the check from one that fits.
    const buffer = Buffer.alloc(Math.min(file.size, cap) + 1);
    let size = 0;
    for (let n = 1; n > 0 && size < buffer.length; size += n)
      n = readSync(fd, buffer, size, buffer.length - size, null);
    if (size > cap) throw new RefusedError(`${path} is larger than ${String(cap)} bytes`);
    return buffer.subarray(0, size).toString('utf8');
  } finally {
    closeSync(fd);
  }
}
