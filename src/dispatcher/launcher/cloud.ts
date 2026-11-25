// Cloud sessions (research R8): a Claude Code cloud session for the project's repo and the item
// branch. Cloud sessions are refused until after Gate A (Owner decision 2026-11-24): the launcher
// is unavailable and starts nothing, an `agents: cloud` project waits, and the dispatcher tells
// the Owner once (Owner decision 2026-10-07).
import { RefusedError } from '../../cli/env.js';
import type { Availability, LaunchRequest, SessionLauncher } from './types.js';

/**
 * The `claude` arguments that start a cloud session for `request`: none until after Gate A (Owner
 * decision 2026-11-24). A cloud launcher changes only this function.
 */
export const cloudInvocation: (request: LaunchRequest) => readonly string[] | undefined = () =>
  undefined;

/** Why every cloud launch is refused, and until when. */
const CLOUD_REFUSED = 'cloud sessions are refused until after Gate A (Owner decision 2026-11-24)';

export class CloudLauncher implements SessionLauncher {
  readonly mode = 'cloud';

  available(): Promise<Availability> {
    return Promise.resolve({ ok: false, reason: CLOUD_REFUSED });
  }

  launch(request: LaunchRequest): Promise<{ sessionId: string }> {
    void cloudInvocation(request);
    return Promise.reject(new RefusedError(`no cloud session started: ${CLOUD_REFUSED}`));
  }
}
