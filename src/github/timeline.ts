// Label history of an issue (research R3): every page of the timeline, reduced to `labeled` /
// `unlabeled` events in `created_at` order. Pause state and gate checks are derived from this
// history, never from the labels an issue carries now (AC-076).
import type { LabelEvent } from '../pause/derive.js';
import { asList, Fields, gh, GhError, numberArg, repoArg, type GhOptions } from './gh.js';

export async function timeline(
  repo: string,
  issue: number,
  options: GhOptions = {},
): Promise<LabelEvent[]> {
  const path = `repos/${repoArg(repo)}/issues/${numberArg(issue)}/timeline`;
  return labelEvents(
    asList(await gh(['api', path, '--paginate'], { ...options, json: true }), path),
  );
}

/** Label events among raw timeline items, sorted by time; ties keep their page order. */
export function labelEvents(items: readonly unknown[]): LabelEvent[] {
  const events: LabelEvent[] = [];
  for (const item of items) {
    const f = Fields.of(item, 'timeline event');
    const event = f.has('event') ? f.str('event') : '';
    if (event !== 'labeled' && event !== 'unlabeled') continue;
    const createdAt = f.str('created_at');
    if (Number.isNaN(Date.parse(createdAt))) {
      throw new GhError(`unexpected gh output: timeline event time ${JSON.stringify(createdAt)}`);
    }
    events.push({
      event,
      label: f.field('label').str('name'),
      createdAt,
      // A deleted account shows as a null actor.
      ...(f.has('actor') ? { actor: f.login('actor') } : {}),
    });
  }
  return events
    .map((e, i) => ({ e, i, t: Date.parse(e.createdAt) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map(({ e }) => e);
}
