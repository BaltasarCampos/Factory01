import { describe, expect, it } from 'vitest';
import { runLoop } from '../../src/commands/run.js';
import type { PassResult } from '../../src/dispatcher/dispatch.js';
import { CloudLauncher, cloudInvocation } from '../../src/dispatcher/launcher/cloud.js';
import { LocalLauncher, type Runner } from '../../src/dispatcher/launcher/local.js';

const REQUEST = {
  role: 'spec',
  station: 2,
  item: 42,
  branch: 'claude/42-add-login',
  prompt: 'Station 2 (specify) for owner/project#42 on branch claude/42-add-login.',
} as const;

function fakeRunner(status = 0, stdout = '{"session_id":"s-123"}') {
  const calls: { program: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv }[] =
    [];
  const run: Runner = (program, args, options) => {
    calls.push({ program, args, ...options });
    return Promise.resolve({ status, stdout, stderr: status === 0 ? '' : 'boom' });
  };
  return { calls, run };
}

describe('LocalLauncher (research R8, R9)', () => {
  it('runs claude -p with the role agent and Sonnet in the working copy, with the Spec Kit feature set', async () => {
    const { calls, run } = fakeRunner();
    const launcher = new LocalLauncher({ cwd: '/work/project', env: { PATH: '/bin' }, run });

    const { sessionId } = await launcher.launch(REQUEST);

    expect(sessionId).toBe('s-123');
    const launch = calls.at(-1);
    expect(launch?.program).toBe('claude');
    expect(launch?.args).toEqual([
      ...['-p', '--agent', 'spec', '--model', 'sonnet', '--output-format', 'json'],
      REQUEST.prompt,
    ]);
    expect(launch?.cwd).toBe('/work/project');
    expect(launch?.env).toMatchObject({
      PATH: '/bin',
      SPECIFY_FEATURE: '42-add-login',
      SPECIFY_FEATURE_DIRECTORY: 'specs/42-add-login',
    });
  });

  it('sets no feature for a session on main', async () => {
    const { calls, run } = fakeRunner();
    const launcher = new LocalLauncher({ cwd: '/w', env: {}, run });

    await launcher.launch({ ...REQUEST, role: 'intake', station: 1, branch: 'main' });

    expect(calls.at(-1)?.env.SPECIFY_FEATURE).toBeUndefined();
  });

  it('runs one session at a time', async () => {
    let finish: () => void = () => undefined;
    const run: Runner = () =>
      new Promise((resolve) => {
        finish = () => {
          resolve({ status: 0, stdout: '{"session_id":"s-1"}', stderr: '' });
        };
      });
    const launcher = new LocalLauncher({ cwd: '/w', env: {}, run });

    const first = launcher.launch(REQUEST);
    await expect(launcher.launch(REQUEST)).rejects.toThrow(/already running/);
    finish();
    await expect(first).resolves.toEqual({ sessionId: 's-1' });
  });

  it('is available only when claude runs, and a failed session is an error', async () => {
    expect(await new LocalLauncher({ cwd: '/w', env: {}, run: fakeRunner().run }).available()).toBe(
      true,
    );
    const failing = new LocalLauncher({ cwd: '/w', env: {}, run: fakeRunner(1).run });
    expect(await failing.available()).toBe(false);
    await expect(failing.launch(REQUEST)).rejects.toThrow(/boom/);
    const missing: Runner = () => Promise.reject(new Error('spawn claude ENOENT'));
    expect(await new LocalLauncher({ cwd: '/w', env: {}, run: missing }).available()).toBe(false);
  });
});

describe('CloudLauncher until the Phase 0 probe (T125)', () => {
  it('is unavailable and starts nothing: the cloud command is not confirmed', async () => {
    const launcher = new CloudLauncher();
    expect(launcher.mode).toBe('cloud');
    expect(cloudInvocation(REQUEST)).toBeUndefined();
    expect(await launcher.available()).toBe(false);
    await expect(launcher.launch(REQUEST)).rejects.toThrow(/T125/);
  });
});

describe('factory run loop (FR-005)', () => {
  const pass = (r: Partial<PassResult>): PassResult => ({ moves: [], skipped: [], ...r });
  const launched = pass({
    launched: { issue: 2, station: 2, role: 'spec', branch: 'b', mode: 'local', sessionId: 's' },
  });
  const passes = (...results: PassResult[]) => {
    let n = 0;
    return () => Promise.resolve(results[Math.min(n++, results.length - 1)] ?? pass({}));
  };

  it('keeps passing while sessions run, and stops when a pass starts nothing (an Owner gate or no work)', async () => {
    const stop = await runLoop(passes(launched, launched, pass({})), { once: false });
    expect(stop).toEqual({
      passes: 3,
      reason: 'nothing to start: waiting for the Owner or for work',
    });
  });

  it('stops at a halt or a refused launch', async () => {
    expect(await runLoop(passes(launched, pass({ halted: 'pause:line in effect' })), {})).toEqual({
      passes: 2,
      reason: 'pause:line in effect',
    });
    expect(await runLoop(passes(pass({ refused: 'no launcher' })), {})).toEqual({
      passes: 1,
      reason: 'no launcher',
    });
  });

  it('--once runs one pass, and the loop stops at its pass cap', async () => {
    expect(await runLoop(passes(launched), { once: true })).toEqual({
      passes: 1,
      reason: '--once',
    });
    expect(await runLoop(passes(launched), { limit: 3 })).toEqual({
      passes: 3,
      reason: 'pass cap of 3 reached',
    });
  });
});
