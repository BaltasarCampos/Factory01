// The read guard (T085): whether a role's session may Read a file or Grep or Glob a folder, from
// the role table, with the role from the station manifest through the hook wiring (slice 28). It
// fails closed. Never a path `deny_read` names, by the named path or its real location; never a
// search folder that holds a home path `deny_read` names, such as home itself, nor a Grep `glob`
// that a relative pattern such as `.env*` matches. A Glob's `pattern` is checked too: its leading
// part without glob characters, from `path` or `cwd`, is the folder it searches, and the pattern
// is refused when absolute, when it leaves the clone with `..`, when it has braces, or when a
// relative `deny_read` pattern matches it. The Reviewer never reads `events.jsonl` or
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
  /** Glob's `pattern`, relative to `path`. */
  pattern?: string;
  cwd: string;
  clone: string;
  home: string;
}

const EVENTS = ['**/events.jsonl', '.factory/events/**'];
const GLOB_CHARACTERS = /[*?[\]{}]/;

export function checkRead(policy: Policy, input: ReadInput): GuardDecision<ReadRule> {
  return decide<ReadRule>('unresolved', (refuse) => {
    let shown = input.path ?? input.cwd;
    const pattern = input.tool === 'Glob' ? input.pattern : undefined;
    if (pattern !== undefined) {
      if (pattern.startsWith('/') || pattern.startsWith('~'))
        refuse(
          'search',
          `the pattern ${pattern} is absolute; give the folder as path and a pattern relative to it`,
        );
      // The pattern is compared as text, so braces, which Glob expands, are refused.
      if (/[{}]/.test(pattern))
        refuse('secret', `the pattern ${pattern} has braces; give one pattern without braces`);
      const denied = policy.denyRead.find((p) => !p.startsWith('~/') && matchesPath(p, pattern));
      if (denied !== undefined)
        refuse('secret', `the pattern ${pattern} names files no session reads (${denied})`);
      const parts = pattern.split('/');
      const at = parts.findIndex((part) => GLOB_CHARACTERS.test(part));
      const leading = at < 0 ? parts : parts.slice(0, at);
      if (parts.slice(leading.length).includes('..'))
        refuse('search', `the pattern ${pattern} has .. after a glob character; leave it out`);
      shown = posix.join(shown, ...leading);
    }
    const named = absolute(shown, input.cwd, input.home);
    const paths = [named, realPath(named)];
    const inClone = (path: string) =>
      path === input.clone || inside(input.clone, path) !== undefined;
    if (pattern?.split('/').includes('..') === true && !paths.every(inClone))
      refuse('search', `the pattern ${pattern} leaves the clone with ..; search inside it`);
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
    // The glob is compared as text, so braces, which Grep expands, are refused.
    if (/[{}]/.test(glob))
      refuse('secret', `the glob ${glob} has braces; give one pattern without braces`);
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
