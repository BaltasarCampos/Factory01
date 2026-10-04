// How the dispatcher starts a station session (research R8): a cloud session for the project's
// repo and item branch, or `claude -p` on the laptop (T061). Tests use a fake.
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

export interface SessionLauncher {
  readonly mode: AgentsMode;
  launch(request: LaunchRequest): Promise<{ sessionId: string }>;
  /** False during a cloud outage or without the `claude` binary. */
  available(): Promise<boolean>;
}

export type Launchers = Partial<Record<AgentsMode, SessionLauncher>>;
