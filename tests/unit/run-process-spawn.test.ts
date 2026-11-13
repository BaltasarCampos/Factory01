// runProcess when the spawn itself fails (T061, deferred (5)): spawn is replaced in this file
// alone, so a throw or a child with no pipes can be made on demand.
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawned = vi.hoisted(() => ({ next: (): unknown => undefined }));
vi.mock('node:child_process', async (actual) => ({
  ...(await actual<typeof import('node:child_process')>()),
  spawn: () => spawned.next(),
}));

const { runProcess } = await import('../../src/dispatcher/launcher/local.js');

const GROUPED = { cwd: '/', env: {}, group: true };
const turn = () => new Promise((done) => setImmediate(() => setImmediate(done)));
const listeners = () =>
  ['SIGINT', 'SIGTERM', 'SIGHUP', 'exit'].map((e) => process.listenerCount(e));

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('runProcess when the spawn fails', () => {
  it('ends the factory on a signal caught during a spawn that then throws', async () => {
    const before = listeners();
    // Keeps this worker alive whatever runProcess does with the signal.
    const keep = () => undefined;
    process.on('SIGTERM', keep);
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    spawned.next = () => {
      process.kill(process.pid, 'SIGTERM');
      throw Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN' });
    };
    try {
      await expect(runProcess('claude', [], GROUPED)).rejects.toThrow(/EAGAIN/);
      await vi.waitFor(async () => {
        await turn();
        vi.advanceTimersByTime(3000);
        expect(exit).toHaveBeenCalledWith(143);
      });
    } finally {
      process.off('SIGTERM', keep);
    }
    await turn();
    expect(listeners()).toEqual(before);
  });

  // As Node gives it on EMFILE: no pid, no pipes, the error on the next tick.
  const piped = (error?: Error) => () => {
    const child = Object.assign(new EventEmitter(), { pid: undefined, stdout: null, stderr: null });
    if (error !== undefined) process.nextTick(() => child.emit('error', error));
    return child;
  };

  it("rejects with the child's own error when it has no output pipes (EMFILE), keeping no handler", async () => {
    const before = listeners();
    const kill = vi.spyOn(process, 'kill');
    const emfile = Object.assign(new Error('spawn EMFILE'), { code: 'EMFILE' });
    spawned.next = piped(emfile);
    await expect(runProcess('claude', [], GROUPED)).rejects.toBe(emfile);
    // No pid, so nothing to kill.
    expect(kill).not.toHaveBeenCalled();
    await turn();
    expect(listeners()).toEqual(before);
  });

  it('rejects naming the cause when a child with no output pipes gives no error', async () => {
    spawned.next = piped();
    await expect(runProcess('claude', [], GROUPED)).rejects.toThrow(
      'claude has no output pipes, most likely out of file descriptors',
    );
  });
});
