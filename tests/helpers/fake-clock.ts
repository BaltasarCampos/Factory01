// Injected clock for time-dependent code (resume timestamps, caps, retries).

export interface Clock {
  now(): Date;
}

export class FakeClock implements Clock {
  private ms: number;

  constructor(start: string | Date = '2026-10-02T09:00:00Z') {
    this.ms = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.ms);
  }

  advance(ms: number): void {
    this.ms += ms;
  }

  set(time: string | Date): void {
    this.ms = new Date(time).getTime();
  }
}
