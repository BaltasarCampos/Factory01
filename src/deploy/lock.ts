// One deploy at a time (T069, slice 23b-2a; Owner decision 2026-10-13): `~/.factory/deploy.lock`,
// outside every app folder, holds the running deploy's PID. A second deploy refuses while that
// process runs; a lock left by one that no longer runs is refused too, naming the file, since
// taking it over could let two deploys both think they hold it.
import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { RefusedError } from '../cli/env.js';

const CREATE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

const running = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export async function withDeployLock<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const path = join(home, '.factory', 'deploy.lock');
  mkdirSync(dirname(path), { recursive: true });
  let fd: number;
  try {
    fd = openSync(path, CREATE, 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const pid = Number(readFileSync(path, 'utf8').trim());
    throw new RefusedError(
      Number.isInteger(pid) && pid > 0 && running(pid)
        ? `another factory deploy is running (pid ${String(pid)}); nothing was deployed`
        : `a factory deploy that is no longer running (pid ${String(pid)}) left ${path}; remove it if no deploy is running`,
    );
  }
  try {
    writeSync(fd, String(process.pid));
  } finally {
    closeSync(fd);
  }
  try {
    return await fn();
  } finally {
    rmSync(path, { force: true });
  }
}
