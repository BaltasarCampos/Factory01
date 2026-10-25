// The read guard (T085): whether a role's session may Read a file or Grep or Glob a folder, from
// the role table, with the role from the station manifest through the hook wiring (slice 28). It
// fails closed. Never a path `deny_read` names, by the named path or its real location; never a
// search folder that holds a home path `deny_read` names, such as home itself, nor a Grep `glob`
// that a relative pattern such as `.env*` matches. The Reviewer never reads `events.jsonl` or
// `.factory/events/**`, and greps no folder that holds them, so "may not see the Builder's
// reasoning" is not only a prompt. Claude Code applies its own Read deny rules only to the folder a
// Grep searches, and Grep skips gitignored files: a Grep over a folder holding a `.env` file git
// does not ignore is beyond both. Reasons go through `visible()`.
import { posix } from 'node:path';
import { absolute, deniedRead, inside, realPath } from './paths.js';
import { decide, type GuardDecision } from './path-guard.js';
import { matchesPath, type Policy } from './policy.js';

export type ReadRule = 'unresolved' | 'secret' | 'search' | 'events';

export interface ReadInput {
  role: string;
  tool: 'Read' | 'Grep' | 'Glob';
  /** The tool input's `file_path` for Read, `path` for Grep and Glob; a search defaults to `cwd`. */
  path?: string;
  /** Grep's `glob`, the files it searches. */
  glob?: string;
  cwd: string;
  clone: string;
  home: string;
}

const EVENTS = ['**/events.jsonl', '.factory/events/**'];

export function checkRead(policy: Policy, input: ReadInput): GuardDecision<ReadRule> {
  return decide<ReadRule>('unresolved', (refuse) => {
    const shown = input.path ?? input.cwd;
    const named = absolute(shown, input.cwd, input.home);
    const paths = [named, realPath(named)];
    for (const path of paths) {
      const denied = deniedRead(policy, input.home, path);
      if (denied !== undefined) refuse('secret', `${shown}: no session reads it (${denied})`);
    }
    const search = input.tool !== 'Read';
    const held = policy.denyRead
      .filter((pattern) => pattern.startsWith('~/'))
      .find((pattern) => {
        const base = input.home + pattern.slice(1).replace(/\/\*\*$/, '');
        return paths.some((path) => path === base || inside(path, base) !== undefined);
      });
    if (search && held !== undefined)
      refuse(
        'search',
        `${shown}: it holds ${held}, which no session reads; search inside the repository`,
      );
    const glob = input.tool === 'Grep' ? (input.glob ?? '') : '';
    const globbed = policy.denyRead.find((p) => !p.startsWith('~/') && matchesPath(p, glob));
    if (globbed !== undefined)
      refuse('secret', `the glob ${glob} names files no session reads (${globbed})`);
    if (input.role !== 'reviewer') return;
    const clones = [input.clone, realPath(input.clone)];
    const relatives = paths.map((path, i) => posix.relative(clones[i] ?? '', path));
    const why = "the Reviewer does not read the event logs, which hold the Builder's reasoning";
    if (relatives.some((r) => EVENTS.some((pattern) => matchesPath(pattern, r))))
      refuse('events', `${shown}: ${why}`);
    const holds = (r: string) =>
      r === '' || r === 'specs' || /^specs\/[^/]+$/.test(r) || r === '.factory';
    if (
      input.tool === 'Grep' &&
      (relatives.some(holds) || EVENTS.some((p) => matchesPath(p, glob)))
    )
      refuse(
        'events',
        `a Grep over ${shown} reads the event logs; ${why}, so give a path such as src`,
      );
  });
}
