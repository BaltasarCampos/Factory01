// Fake session launcher: records every launch instead of starting a Claude Code session.
// Mirrors the `SessionLauncher` interface of src/dispatcher/launcher/types.ts (T037).

export interface LaunchRequest {
  role: string;
  station: number;
  item: number;
  branch: string;
  prompt: string;
}

export interface LaunchRecord extends LaunchRequest {
  mode: 'cloud' | 'local';
  sessionId: string;
}

export class FakeLauncher {
  readonly mode: 'cloud' | 'local';
  readonly launches: LaunchRecord[] = [];
  private isAvailable = true;

  constructor(mode: 'cloud' | 'local' = 'cloud') {
    this.mode = mode;
  }

  /** Make the launcher report itself unavailable (cloud outage, missing `claude` binary). */
  setUnavailable(unavailable = true): void {
    this.isAvailable = !unavailable;
  }

  available(): Promise<{ ok: true } | { ok: false; reason: string }> {
    return Promise.resolve(
      this.isAvailable ? { ok: true } : { ok: false, reason: `${this.mode} launcher unavailable` },
    );
  }

  launch(request: LaunchRequest): Promise<{ sessionId: string }> {
    if (!this.isAvailable) return Promise.reject(new Error(`${this.mode} launcher unavailable`));
    const sessionId = `fake-${this.mode}-${String(this.launches.length + 1)}`;
    this.launches.push({ ...request, mode: this.mode, sessionId });
    return Promise.resolve({ sessionId });
  }
}
