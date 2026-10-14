// The rollback steps of each item a deploy ships (T069, slice 23c-1b; Owner decisions 2026-10-14):
// from the release notes, `.factory/releases/*.md`, at main's verified head and at
// `origin/claude/factory-log` as fetched once at the start of the deploy, read from git objects,
// never a checkout. Only regular files count. A note covers item N when it names `#N` not followed
// by a digit, and its steps are the non-blank lines of its `## Rollback` section; an empty section
// counts as none. Main's notes win: the factory-log branch's are shown for an item only when no
// note on main gives it steps (Owner decision 2026-10-14). That branch is agent-written and not
// merged, so its notes say so; judging the steps is the Owner's.
import { RefusedError } from '../cli/env.js';
import { safeGit } from '../git/diff.js';
import type { MainContext } from '../merge/context.js';
import { visible } from '../notify/summary.js';

const NOTHING = 'nothing was deployed';
const FOLDER = '.factory/releases/';
const MAX = 64 * 1024;
/** `ls-tree --long`: mode, type, object, size, then the path after a tab. */
const ENTRY = /^(\d{6}) blob ([0-9a-f]{40}) +(\d+)\t(.+)$/s;

export interface ReleaseNote {
  path: string;
  /** Where it was read: `main at <sha12>`, or the factory-log branch, not merged. */
  source: string;
  /** Read at main's verified head; a note on main wins over the factory-log branch's. */
  onMain: boolean;
  text: string;
}

export interface Rollback {
  issue: number;
  notes: { path: string; source: string; steps: string[] }[];
}

/** The notes on main and on the fetched factory-log branch; a note the same on both is read once. */
export function releaseNotes(at: MainContext, log: string | undefined): ReleaseNote[] {
  const sources = [
    { commit: at.main, source: `main at ${at.main.slice(0, 12)}` },
    ...(log === undefined
      ? []
      : [{ commit: log, source: `origin/claude/factory-log at ${log.slice(0, 12)}, not merged` }]),
  ];
  const seen = new Set<string>();
  const notes: ReleaseNote[] = [];
  for (const { commit, source } of sources) {
    const listed = safeGit(at.cwd, ['ls-tree', '-z', '--long', commit, '--', FOLDER], at.env);
    if (listed.status !== 0)
      throw new RefusedError(`cannot list ${FOLDER} at ${commit}: ${listed.stderr}; ${NOTHING}`);
    for (const entry of listed.stdout.toString('utf8').split('\0')) {
      const [, mode = '', blob = '', size = '', path = ''] = ENTRY.exec(entry) ?? [];
      // A link is a blob too, of mode 120000: only regular files are notes.
      if (!['100644', '100755'].includes(mode) || !path.endsWith('.md')) continue;
      if (seen.has(`${path}\0${blob}`)) continue;
      seen.add(`${path}\0${blob}`);
      if (Number(size) > MAX)
        throw new RefusedError(`${visible(path)} on ${source}, is over 64 KiB; ${NOTHING}`);
      const shown = safeGit(at.cwd, ['cat-file', 'blob', blob], at.env);
      if (shown.status !== 0)
        throw new RefusedError(`cannot read ${visible(path)} on ${source}; ${NOTHING}`);
      notes.push({ path, source, onMain: commit === at.main, text: shown.stdout.toString('utf8') });
    }
  }
  return notes;
}

/** The `## Rollback` section's non-blank lines, up to the next heading of level one or two. */
export function rollbackSection(text: string): string[] | undefined {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trimEnd() === '## Rollback');
  if (start === -1) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#{1,2}(?:\s|$)/.test(l));
  return rest.slice(0, end === -1 ? undefined : end).filter((l) => l.trim() !== '');
}

/** Each item's steps; an item no note gives steps for refuses, naming every note that names it. */
export function rollbackFor(notes: readonly ReleaseNote[], issues: readonly number[]): Rollback[] {
  return issues.map((issue) => {
    const naming = notes.filter((n) => new RegExp(`#${String(issue)}(?!\\d)`).test(n.text));
    const covering = naming.flatMap((n) => {
      const steps = rollbackSection(n.text) ?? [];
      return steps.length === 0 ? [] : [{ ...n, steps }];
    });
    // Main's notes, when one gives steps; the unmerged branch's only when main has none.
    const main = covering.filter((n) => n.onMain);
    const shown = (main.length > 0 ? main : covering).map(({ path, source, steps }) => ({
      path,
      source,
      steps,
    }));
    if (shown.length > 0) return { issue, notes: shown };
    const why = naming.map(
      (n) =>
        `${visible(n.path)} on ${n.source}, has ${rollbackSection(n.text) === undefined ? 'no' : 'an empty'} ## Rollback section`,
    );
    throw new RefusedError(
      `no release note on main or origin/claude/factory-log gives rollback steps for #${String(issue)}${why.length > 0 ? `: ${why.join('; ')}` : ''}; ${NOTHING}`,
    );
  });
}
