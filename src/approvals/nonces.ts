// Single use of record nonces (contracts/approval-record.md step 6, research R4).
//
// Verification is stateless and derived from history: a nonce counts only at its first
// occurrence. The laptop also keeps `~/.factory/nonces.log`, binding each nonce to the comment
// it was first seen in, so a record deleted and reposted elsewhere is a replay even if GitHub
// history were edited.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ApprovalRecord } from '../model/types.js';

/** Split records, given in posting order, into first uses of a nonce and later replays. */
export function firstUses<T extends { record: ApprovalRecord }>(
  posted: readonly T[],
): { first: T[]; replays: T[] } {
  const seen = new Set<string>();
  const first: T[] = [];
  const replays: T[] = [];
  for (const entry of posted) {
    if (seen.has(entry.record.nonce)) replays.push(entry);
    else {
      seen.add(entry.record.nonce);
      first.push(entry);
    }
  }
  return { first, replays };
}

export function nonceLedgerPath(home: string): string {
  return join(home, '.factory', 'nonces.log');
}

/** `~/.factory/nonces.log`: one `<nonce> <ref>` line per nonce, append only. */
export class NonceLedger {
  constructor(readonly path: string) {}

  private entries(): Map<string, string> {
    let text = '';
    try {
      text = readFileSync(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const map = new Map<string, string>();
    for (const line of text.split('\n')) {
      const m = /^([0-9a-f]{32}) (\S+)$/.exec(line);
      if (m?.[1] !== undefined && m[2] !== undefined && !map.has(m[1])) map.set(m[1], m[2]);
      else if (line !== '' && !m) throw new Error(`${this.path}: malformed line: ${line}`);
    }
    return map;
  }

  /**
   * True when `nonce` is new (now recorded against `ref`) or already recorded against `ref`;
   * false when it was recorded against another ref, which is a replay.
   */
  claim(nonce: string, ref: string): boolean {
    const seen = this.entries().get(nonce);
    if (seen !== undefined) return seen === ref;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    appendFileSync(this.path, `${nonce} ${ref}\n`, { mode: 0o600 });
    return true;
  }
}
