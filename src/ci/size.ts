// `factory ci size` (contracts/ci-checks.md, QG-6): changed lines from the safe diff, added
// plus removed, as every slice is measured, against the stricter of the release's limit and
// main's `size_limit_lines`. Outside the count: `specs/**`, and lockfiles and generated files,
// which are listed as not counted. A file without lines to count (binary, symlink, gitlink, an
// executable-bit flip) counts 1 and is listed; an executable bit set with other changes is listed
// too; a byte-identical move counts 0 and is listed (Owner decisions 2026-10-08).
import { posix } from 'node:path';
import type { FileChange } from '../git/diff.js';

const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml'];
/** Build and coverage output, as the TypeScript profile writes it. */
const GENERATED = ['dist/', 'coverage/'];

/** Lockfiles and generated files: not counted, but listed. */
const notCounted = (path: string) =>
  LOCKFILES.includes(posix.basename(path)) || GENERATED.some((dir) => path.startsWith(dir));

export interface Size {
  lines: number;
  /** Files not counted by their lines, and executable-bit changes, each with why. */
  listed: string[];
}

export function measureSize(changes: readonly FileChange[]): Size {
  const listed = changes
    .filter((c) => !c.path.startsWith('specs/') && notCounted(c.path))
    .map((c) => `not counted: ${c.path}`);
  const counted = changes.filter((c) => !c.path.startsWith('specs/') && !notCounted(c.path));
  // Moves: each deleted path pairs with at most one added path holding the same blob and mode.
  const moved = new Set<FileChange>();
  for (const gone of counted.filter((c) => c.status === 'deleted')) {
    const to = counted.find(
      (c) =>
        c.status === 'added' &&
        !moved.has(c) &&
        c.newOid === gone.oldOid &&
        c.newMode === gone.oldMode,
    );
    if (to === undefined) continue;
    moved.add(gone).add(to);
    listed.push(`moved: ${gone.path} → ${to.path}`);
  }
  let lines = 0;
  for (const change of counted) {
    if (moved.has(change)) continue;
    if (change.type !== 'regular') {
      lines += 1;
      listed.push(`${change.type}: ${change.path}`);
      continue;
    }
    const changed = change.added.length + change.removed.length;
    const flipped =
      (change.status === 'modified' && change.oldMode !== change.newMode) ||
      (change.status === 'added' && change.newMode === '100755');
    lines += changed > 0 ? changed : flipped ? 1 : 0;
    if (flipped) listed.push(`executable bit: ${change.path}`);
  }
  return { lines, listed };
}
