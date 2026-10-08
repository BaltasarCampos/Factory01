// How the dispatcher starts a station session (research R8): a cloud session for the project's
// repo and item branch, or `claude -p` on the laptop (T061). Tests use a fake.
import { RefusedError } from '../../cli/env.js';
import type { AgentsMode, RoleName, Station } from '../../model/types.js';

export interface LaunchRequest {
  role: RoleName;
  station: Station;
  /** Issue number of the work item. */
  item: number;
  /** The branch the session checks out and pushes to. */
  branch: string;
  prompt: string;
}

/** Whether a session can start now; if not, why, and whether it is tampering (urgent). */
export type Availability = { ok: true } | { ok: false; reason: string; urgent?: boolean };

export interface SessionLauncher {
  readonly mode: AgentsMode;
  launch(request: LaunchRequest): Promise<{ sessionId: string }>;
  /** Not ok during a cloud outage, without the `claude` binary, or before the guards exist. */
  available(): Promise<Availability>;
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
