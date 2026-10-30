// How the dispatcher starts a station session (research R8): a cloud session for the project's
// repo and item branch, or `claude -p` on the laptop (T061). Tests use a fake.
import { RefusedError } from '../../cli/env.js';
import type { AgentsMode, RoleName, Station } from '../../model/types.js';

export interface LaunchRequest {
  /** The Owner's clone of the project the session works for; the session never runs in it. */
  project: string;
  role: RoleName;
  station: Station;
  /** Issue number of the work item. */
  item: number;
  /** The branch the session checks out and pushes to. */
  branch: string;
  /** The item's feature folder, `specs/<issue>-<slug>`; empty for a role on a fixed branch. */
  feature: string;
  /** The task's files from the station manifest, or a conflict session's; empty for none. */
  files: readonly string[];
  prompt: string;
}

/** Whether a session can start now; if not, why, and whether it is tampering (urgent). */
export type Availability = { ok: true } | { ok: false; reason: string; urgent?: boolean };

/** A session that ran; `notices` are info alerts for the Owner, such as another Claude Code version. */
export interface LaunchResult {
  sessionId: string;
  notices?: readonly string[];
}

export interface SessionLauncher {
  readonly mode: AgentsMode;
  launch(request: LaunchRequest): Promise<LaunchResult>;
  /**
   * Whether a session for the project cloned at `project` can start. Not ok during a cloud
   * outage, without the `claude` binary, or before the guards exist.
   */
  available(project: string): Promise<Availability>;
}

export type Launchers = Partial<Record<AgentsMode, SessionLauncher>>;

/** A launch the launcher refused; `urgent` when the branch's guardrail files were tampered with. */
export class LaunchRefused extends RefusedError {
  readonly urgent: boolean;

  constructor(message: string, urgent = false) {
    super(message);
    this.urgent = urgent;
  }
}

/**
 * A session that ran but did not run as launched, such as an init message naming another
 * permission mode: a failure with an urgent alert, and nothing of it is pushed (T061, T086).
 */
export class SessionFailed extends LaunchRefused {
  constructor(message: string) {
    super(message, true);
  }
}
