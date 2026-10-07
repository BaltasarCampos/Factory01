// Cloud sessions (research R8): a Claude Code cloud session for the project's repo and the item
// branch. The command that starts one is not confirmed yet, so until the Phase 0 probe (T125)
// names it the launcher is unavailable and starts nothing: an `agents: cloud` project waits,
// and the dispatcher tells the Owner once (Owner decision 2026-10-07).
import { RefusedError } from '../../cli/env.js';
import type { Availability, LaunchRequest, SessionLauncher } from './types.js';

/**
 * The `claude` arguments that start a cloud session for `request`, or undefined while T125 has
 * not confirmed them. T125 changes only this function.
 */
export const cloudInvocation: (request: LaunchRequest) => readonly string[] | undefined = () =>
  undefined;

export class CloudLauncher implements SessionLauncher {
  readonly mode = 'cloud';

  available(): Promise<Availability> {
    return Promise.resolve({ ok: false, reason: 'the cloud launch command awaits the T125 probe' });
  }

  launch(request: LaunchRequest): Promise<{ sessionId: string }> {
    void cloudInvocation(request);
    return Promise.reject(
      new RefusedError('no cloud session started: the launch command awaits the T125 probe'),
    );
  }
}
