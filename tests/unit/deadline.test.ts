// A program bounded by the Stop hook's deadline that times out ends with the deadline's refusal,
// decided by `bound()` alone, never by a second reading of the clock (T086, Owner decision
// 2026-11-19): spawn's own timer can fire while `Date.now()` is still a moment short of the
// deadline. The clock is frozen 1 ms before it here, so no row depends on timing.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeBwrap } from '../../src/ci/sandbox.js';
import { withDeadline } from '../../src/cli/deadline.js';
import { gitOut } from '../../src/git/answers.js';
import { safeGit } from '../../src/git/diff.js';
import { gh } from '../../src/github/gh.js';
import { tempDir } from '../helpers/keys.js';

const NOW = 1_800_000_000_000;
afterEach(() => {
  vi.restoreAllMocks();
});

/** A PATH whose `git`, `gh` and `bwrap` each sleep, so every run of one times out. */
function sleepers() {
  const bin = tempDir('sleepers-');
  for (const name of ['git', 'gh', 'bwrap'])
    writeFileSync(join(bin, name), '#!/bin/sh\nexec sleep 5\n', { mode: 0o755 });
  return { PATH: `${bin}:${process.env.PATH ?? ''}` };
}

/** `run` under a deadline of `ms`, the clock reading `NOW + ms - before` while it runs. */
function at<T>(ms: number, before: number, run: () => Promise<T>): Promise<T> {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW);
  return withDeadline(ms, () => {
    clock.mockReturnValue(NOW + ms - before);
    return run();
  });
}

const DEADLINE = /^the Stop hook ran past its 2 s limit/;

describe("the deadline's refusal for a program that timed out on it (T086, 28-5c-4b)", () => {
  const env = sleepers();
  const repo = tempDir('repo-');

  it.each<[string, () => unknown]>([
    ['safeGit', () => safeGit(repo, ['status'], env)],
    ['gitOut', () => gitOut(repo, ['status'], env)],
    ['the bubblewrap probe', () => probeBwrap([], env, 'bwrap failed')],
    ['gh', () => gh(['issue', 'list'], { env })],
  ])('is what %s throws with the clock 1 ms before the deadline', async (_name, run) => {
    await expect(at(2000, 1, () => Promise.resolve().then(run))).rejects.toThrow(DEADLINE);
  });

  it('is never what a program stopped by its own shorter cap throws, which keeps its own message', async () => {
    const run = () => safeGit(repo, ['status'], env, undefined, undefined, { timeout: 50 });
    await expect(at(10_000, 5000, () => Promise.resolve().then(run))).rejects.toThrow(
      /^git status in .* did not finish within its 0\.05 s limit/,
    );
  });
});
