// A session's record under a fresh home, as the launcher writes it before launch (slice 28-4), for
// tests of the hooks that take the session's facts from it (src/hooks/session.ts).
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './keys.js';

export const SESSION_ID = '0b6c7f3e-2a4d-4c1e-9f00-1234567890ab';
export const ROLE_VERSION = 'v1.0.0+0123456789ab';

export function recordSession(
  record: { role: string; station: number; clone: string } & Record<string, unknown>,
) {
  const home = realpathSync(tempDir());
  const folder = join(home, '.factory', 'sessions', SESSION_ID);
  mkdirSync(folder, { recursive: true });
  const launch = {
    item: 42,
    feature: 'specs/42-add-login',
    files: [],
    model: 'sonnet',
    role_version: ROLE_VERSION,
    repo: 'owner/project',
    inbox_issue: 1,
    branch: 'claude/42-add-login',
    head: 'c'.repeat(40),
    tests: [],
  };
  writeFileSync(join(folder, 'session.json'), JSON.stringify({ ...launch, ...record }));
  return { home, log: join(folder, 'events.jsonl'), env: { HOME: home } };
}
