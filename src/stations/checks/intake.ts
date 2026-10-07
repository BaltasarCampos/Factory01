// Intake output check (FR-015, AC-009). Intake pushes nothing: its output is the item's labels
// and comments. A triaged item has exactly one `type:`, one `priority:` and one proposed `tier:`
// label (the Owner confirms the tier in the signed `approved` record, never through this label).
// Intake runs after approval and may keep the confirmed tier or propose a higher one, never a
// lower one (AC-009).
// A duplicate gets no labels: it is closed with a `<!-- duplicate-of #<n> -->` comment, so it
// never enters the line twice.
import { gh, Fields, GhError, numberArg, repoArg, type GhOptions } from '../../github/gh.js';
import { ITEM_TYPES, type ItemType, type Priority, type Tier } from '../../model/types.js';
import type { CheckResult } from '../../hooks/stop.js';

export const PRIORITIES: readonly Priority[] = ['p0', 'p1', 'p2', 'p3'];

export interface IntakeIssue {
  number: number;
  state: string;
  labels: readonly string[];
  comments: readonly { body: string }[];
  /** The tier in the Owner's verified `approved` record. */
  confirmedTier: Tier;
}

export interface IntakeResult extends CheckResult {
  missing: string[];
  /** Set when exactly one valid label of the kind is on the item. */
  type?: ItemType | undefined;
  priority?: Priority | undefined;
  tier?: Tier | undefined;
  /** The item is a duplicate of this issue and leaves the line. */
  duplicateOf?: number;
}

/** The issue a `<!-- duplicate-of #<n> -->` marker names. */
export function duplicateOf(body: string): number | undefined {
  const n = /<!--\s*duplicate-of #(\d+)\s*-->/.exec(body)?.[1];
  return n === undefined ? undefined : Number(n);
}

/** The one value of a label kind, or why there is not exactly one valid value. */
function single<T extends string>(
  labels: readonly string[],
  kind: string,
  allowed: readonly T[],
  what: string,
): { value?: T; problem?: string } {
  const values = labels
    .filter((l) => l.startsWith(`${kind}:`))
    .map((l) => l.slice(kind.length + 1));
  if (values.length === 0) return { problem: `no ${kind}: label` };
  if (values.length > 1)
    return { problem: `${String(values.length)} ${kind}: labels; exactly one` };
  const [value] = values as [string];
  const ok = allowed.find((a) => a === value);
  return ok === undefined ? { problem: `${kind}:${value} is not ${what}` } : { value: ok };
}

export function checkIntake(issue: IntakeIssue): IntakeResult {
  const at = `#${String(issue.number)}`;
  const done = (missing: string[], fields: Partial<IntakeResult> = {}): IntakeResult => ({
    complete: missing.length === 0,
    missing,
    ...fields,
  });

  const marked = [...new Set(issue.comments.flatMap((c) => duplicateOf(c.body) ?? []))];
  if (marked.length > 1)
    return done([
      `${at}: marked a duplicate of ${marked.map((n) => `#${String(n)}`).join(' and ')}; name one`,
    ]);
  const [original] = marked;
  if (original !== undefined) {
    if (original === issue.number) return done([`${at}: marked a duplicate of itself`]);
    const open = issue.state === 'OPEN';
    const missing = open
      ? [`${at}: marked a duplicate of #${String(original)} but still open; close it`]
      : [];
    return done(missing, { duplicateOf: original });
  }

  const missing = issue.state === 'OPEN' ? [] : [`${at}: closed without a duplicate-of comment`];
  const type = single(issue.labels, 'type', ITEM_TYPES, `a type (${ITEM_TYPES.join(', ')})`);
  const priority = single(issue.labels, 'priority', PRIORITIES, 'p0–p3');
  const tier = single(issue.labels, 'tier', ['1', '2', '3'] as const, '1–3');
  for (const p of [type.problem, priority.problem, tier.problem])
    if (p !== undefined) missing.push(`${at}: ${p}`);
  if (tier.value !== undefined && Number(tier.value) < issue.confirmedTier)
    missing.push(
      `${at}: tier:${tier.value} is lower than the confirmed tier ${String(issue.confirmedTier)}; Intake may only raise it`,
    );
  return done(missing, {
    type: type.value,
    priority: priority.value,
    tier: tier.value === undefined ? undefined : (Number(tier.value) as Tier),
  });
}

/** Read the item from GitHub and check it; a duplicate must name an existing issue. */
export async function checkIntakeIssue(
  repo: string,
  issue: number,
  confirmedTier: Tier,
  options: GhOptions = {},
): Promise<IntakeResult> {
  const view = (n: number, fields: string) =>
    gh(['issue', 'view', numberArg(n), '--repo', repoArg(repo), '--json', fields], {
      ...options,
      json: true,
    });
  const f = Fields.of(await view(issue, 'number,state,labels,comments'), 'issue');
  const result = checkIntake({
    number: f.num('number'),
    state: f.str('state'),
    labels: f.list('labels').map((l) => Fields.of(l, 'label').str('name')),
    comments: f.list('comments').map((c) => ({ body: Fields.of(c, 'comment').str('body') })),
    confirmedTier,
  });
  if (result.duplicateOf === undefined) return result;
  try {
    await view(result.duplicateOf, 'number');
  } catch (error) {
    if (!(error instanceof GhError)) throw error;
    result.missing.push(`#${String(result.duplicateOf)}: no such issue`);
    result.complete = false;
  }
  return result;
}
