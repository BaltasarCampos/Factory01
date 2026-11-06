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
  /** Called about once a minute while a local session runs, for `factory run`'s heartbeat. */
  heartbeat?: (progress: { elapsed: number; turns: number }) => void;
  /** Called with the session's id just before claude spawns; if it throws, claude never does. */
  starting?: (session: string) => void;
}

/** Whether a session can start now; if not, why, and whether it is tampering (urgent). */
export type Availability = { ok: true } | { ok: false; reason: string; urgent?: boolean };

/** An info alert for the Owner about a session that ran, such as another Claude Code version. */
export interface Notice {
  kind: 'claude-version' | 'session-tools';
  text: string;
}

/** A session that ran, with its notices. */
export interface LaunchResult {
  sessionId: string;
  notices?: readonly Notice[];
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

/** A launcher on the laptop: its sessions' folders, and so their failure records, under `home`. */
export interface LocalSessionLauncher extends SessionLauncher {
  readonly home: string;
}

export interface Launchers {
  local?: LocalSessionLauncher;
  cloud?: SessionLauncher;
}

/**
 * A launch the launcher refused; `urgent` when the branch's guardrail files were tampered with,
 * or `kind` names another urgent alert, such as a session still running. `head` is the branch's
 * head it was refused at, once fetched, so a refusal that repeats alerts once per head.
 */
export class LaunchRefused extends RefusedError {
  readonly urgent: boolean;
  readonly kind?: string;
  head?: string;

  constructor(message: string, urgent = false, kind?: string) {
    super(message);
    this.urgent = urgent;
    if (kind !== undefined) this.kind = kind;
  }
}

/**
 * A session that ran, used the Owner's plan and failed, never "no session started": every failure
 * once claude has spawned. Nothing of it is pushed. `urgent` when it did not run as launched, such
 * as an init message naming another permission mode or session, or no passed record or one that
 * cannot be read; a stream that cannot be read, or claude exiting with an error, is not (T061,
 * T086).
 */
export class SessionFailed extends RefusedError {
  readonly urgent: boolean;
  /** Its PreCompact hook blocked a compaction: the item is too big for one session (T061). */
  contextFull?: boolean;

  constructor(message: string, urgent: boolean) {
    super(message);
    this.urgent = urgent;
  }
}

/** A session stopped at one of its caps, turns, wall clock or silence: a failed one, not urgent. */
export class SessionCapped extends SessionFailed {
  constructor(message: string) {
    super(message, false);
  }
}
