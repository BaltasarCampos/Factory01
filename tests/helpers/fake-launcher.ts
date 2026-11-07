// Fake session launcher: records every launch instead of starting a Claude Code session.
// Mirrors the `SessionLauncher` interface of src/dispatcher/launcher/types.ts (T037), and refuses
// as the local launcher does when `starting` throws: a `LaunchRefused`, with nothing launched.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LaunchRefused, type Availability } from '../../src/dispatcher/launcher/types.js';
import { visible } from '../../src/notify/summary.js';

export interface LaunchRequest {
  project: string;
  role: string;
  station: number;
  item: number;
  branch: string;
  feature: string;
  files: readonly string[];
  prompt: string;
  heartbeat?: (progress: { elapsed: number; turns: number }) => void;
  starting?: (session: string) => void;
}

export interface LaunchRecord extends LaunchRequest {
  mode: 'cloud' | 'local';
  sessionId: string;
}

export class FakeLauncher {
  readonly mode: 'cloud' | 'local';
  readonly launches: LaunchRecord[] = [];
  private isAvailable = true;
  /** What every launch throws once the session has run, such as a `SessionFailed`. */
  failure?: Error;
  /** What every launch throws before `starting`, as the local launcher's checks refuse. */
  refusal?: LaunchRefused;
  /** Runs before `starting`, as anything else may between the manifest's issue and the start. */
  beforeStart?: () => void;
  /** Runs once `starting` has passed, as anything may while the session runs. */
  afterStart?: () => void;
  /** The heartbeats every launch gives while its session runs. */
  beats: { elapsed: number; turns: number }[] = [];

  /** Where a local launcher keeps its sessions, and so their failure records. */
  readonly home: string;

  constructor(mode: 'cloud' | 'local' = 'cloud', home?: string) {
    this.mode = mode;
    this.home = home ?? mkdtempSync(join(tmpdir(), 'fake-launcher-'));
  }

  /** Make the launcher report itself unavailable (cloud outage, missing `claude` binary). */
  setUnavailable(unavailable = true): void {
    this.isAvailable = !unavailable;
  }

  /** The projects whose availability was asked. */
  readonly asked: string[] = [];

  available(project: string): Promise<Availability> {
    this.asked.push(project);
    return Promise.resolve(
      this.isAvailable ? { ok: true } : { ok: false, reason: `${this.mode} launcher unavailable` },
    );
  }

  launch(request: LaunchRequest): Promise<{ sessionId: string }> {
    if (!this.isAvailable) return Promise.reject(new Error(`${this.mode} launcher unavailable`));
    if (this.refusal !== undefined) return Promise.reject(this.refusal);
    const sessionId = `fake-${this.mode}-${String(this.launches.length + 1)}`;
    this.beforeStart?.();
    try {
      request.starting?.(sessionId);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      return Promise.reject(new LaunchRefused(`no local session started: ${visible(why)}`));
    }
    this.launches.push({ ...request, mode: this.mode, sessionId });
    this.afterStart?.();
    for (const beat of this.beats) request.heartbeat?.(beat);
    return this.failure === undefined
      ? Promise.resolve({ sessionId })
      : Promise.reject(this.failure);
  }
}
