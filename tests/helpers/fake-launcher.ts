// Fake session launcher: records every launch instead of starting a Claude Code session.
// Mirrors the `SessionLauncher` interface of src/dispatcher/launcher/types.ts (T037), and refuses
// as the local launcher does when `starting` throws: a `LaunchRefused` for that item alone, with
// nothing launched.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LaunchRefused, type Availability } from '../../src/dispatcher/launcher/types.js';
import { visible } from '../../src/notify/summary.js';
import { ROLE_VERSION } from './session.js';

/** The fake local launcher's `n`th session id, a UUID as the local launcher's are. */
export const fakeLocalId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

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
  starting?: (session: string, head: string) => void;
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
  /** What a launch for one request throws before `starting`, such as an item's own refusal. */
  refusalFor?: (request: LaunchRequest) => LaunchRefused | undefined;
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

  /** As the local launcher does before the spawn: the session's record, and its log, empty. */
  private record(request: LaunchRequest, id: string, head: string) {
    const folder = join(this.home, '.factory', 'sessions', id);
    mkdirSync(folder, { recursive: true });
    const record = {
      ...{ role: request.role, item: request.item, station: request.station },
      ...{ feature: request.feature, files: request.files, clone: request.project },
      ...{ project: request.project, model: 'sonnet', role_version: ROLE_VERSION },
      ...{ repo: 'owner/project', inbox_issue: 1, branch: request.branch, head, tests: [] },
    };
    try {
      writeFileSync(join(folder, 'session.json'), JSON.stringify(record), { flag: 'wx' });
    } catch (err) {
      // A row that wrote its own record keeps it.
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    writeFileSync(join(folder, 'events.jsonl'), '', { flag: 'a' });
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
    const refusal = this.refusal ?? this.refusalFor?.(request);
    if (refusal !== undefined) return Promise.reject(refusal);
    const n = this.launches.length + 1;
    const sessionId = this.mode === 'local' ? fakeLocalId(n) : `fake-cloud-${String(n)}`;
    this.beforeStart?.();
    try {
      if (request.starting !== undefined) {
        // The branch's head on origin now, as the local launcher fetches and checks it.
        const ref = `refs/heads/${request.branch}`;
        const listed = execFileSync('git', ['ls-remote', 'origin', ref], { cwd: request.project });
        const head = listed.toString().split('\t')[0] ?? '';
        request.starting(sessionId, head);
        this.record(request, sessionId, head);
      }
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      const message = `no local session started: ${visible(why)}`;
      return Promise.reject(new LaunchRefused(message, false, undefined, true));
    }
    this.launches.push({ ...request, mode: this.mode, sessionId });
    this.afterStart?.();
    for (const beat of this.beats) request.heartbeat?.(beat);
    // As the local launcher does at settle, once no process of the session remains.
    if (request.starting !== undefined)
      writeFileSync(join(this.home, '.factory', 'sessions', sessionId, 'ended'), '');
    return this.failure === undefined
      ? Promise.resolve({ sessionId })
      : Promise.reject(this.failure);
  }
}
