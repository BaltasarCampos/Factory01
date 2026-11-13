// runProcess when the spawn itself fails (T061, deferred (5)): spawn is replaced in this file
// alone, so a throw or a child with no pipes can be made on demand.
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

  it('rejects, kills the child and keeps no handler when it has no output pipes (EMFILE)', async () => {
    const before = listeners();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const on = vi.fn();
    spawned.next = () => ({ pid: 4242, stdout: null, stderr: null, on });
    await expect(runProcess('claude', [], GROUPED)).rejects.toThrow(
      'claude has no output pipes, most likely out of file descriptors',
    );
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGKILL');
    // Its error event, if one comes, is handled, never an uncaught one.
    expect(on).toHaveBeenCalledWith('error', expect.any(Function));
    await turn();
    expect(listeners()).toEqual(before);
  });
});
