// The second-copy check `factory merge` and `factory deploy` run first, so a key that is no longer
// the newest fails before any slow step: this laptop's key must be the newest listed, non-revoked
// key of the release pinned on main.
import type { MainContext } from '../merge/context.js';
import { RefusedError } from '../cli/env.js';
import { keyOf, newestKey, secondCopy } from './keys.js';
import { ownerKeyPath } from './sign.js';

/** Refuses, ending with `nothing`, unless this laptop signs with the newest key at main's pin. */
export function assertNewestKey(at: MainContext, nothing: string): void {
  const mine = keyOf(secondCopy(at.env, at.home) ?? '');
  if (mine === undefined || mine !== newestKey(at.keys))
    throw new RefusedError(
      `finish the rotation: ${ownerKeyPath(at.home)}.pub is not the newest listed, non-revoked key of the release pinned on main (factory keygen --rotate --finish); ${nothing}`,
    );
}
