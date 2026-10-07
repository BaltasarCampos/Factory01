// Item trace (AC-017; Principle VI): a deployed change can be followed from the request through
// spec, plan, tasks, commits, review and tests to the release, and back. Every step names the
// item itself, so a lookup can start at any of them: the feature folder is `specs/<feature>`,
// commits carry `Factory-Role:` and `Factory-Item:` trailers, test titles carry the spec's
// `AC-###` IDs and the release notes name `#<issue>`. Pure: the caller reads git and GitHub.
//
// For review and alerts only, never a gate input: trailers, titles and notes are agent-written,
// so a well-formed trail is not an authentic one. Merges and deploys rely on signed records and
// Owner-signed commits alone.
import { ROLES } from '../model/types.js';
import { checkSpec } from '../stations/checks/spec.js';

export const TRACE_STEPS = [
  'request',
  'spec',
  'plan',
  'tasks',
  'commits',
  'review',
  'tests',
  'release',
] as const;
export type TraceStep = (typeof TRACE_STEPS)[number];

export interface TraceCommit {
  sha: string;
  message: string;
  /** Number of parents; merge commits are the Owner's, not an agent's. */
  parents: number;
  /** Files the commit changes; needed to accept a dispatcher commit. */
  paths?: readonly string[];
}

/** Not a role: the dispatcher's own commits on an item branch (src/dispatcher/branch.ts). */
export const DISPATCHER = 'dispatcher';

/** The only files a dispatcher commit may change. */
const dispatcherFile = (path: string, feature: string) =>
  path === '.specify/feature.json' ||
  path === `specs/${feature}/events.jsonl` ||
  path === `specs/${feature}/.station.json`;

export interface TraceInput {
  issue: number;
  title: string;
  /** `<issue>-<slug>`, the feature folder and the `Factory-Item:` value. */
  feature: string;
  /** Feature files as committed, by role in the trail. */
  files: { spec?: string; plan?: string; tasks?: string; verify?: string };
  /** The item's commits, oldest first. */
  commits: readonly TraceCommit[];
  /** Full titles of the tests that ran (`describe › it`). */
  tests: readonly string[];
  release?: { version: string; notes: string } | undefined;
}

export interface TraceLink {
  step: TraceStep;
  /** What was found at this step; empty when the chain breaks here. */
  refs: string[];
}

export interface Trace {
  links: TraceLink[];
  /** Each break in the chain, as `<step>: <what is missing>`. */
  gaps: string[];
  /** Agent commits without well-formed trailers, as `<sha12> <subject>: <problem>`. */
  untrailered: string[];
}

/** Trailers of the message's last paragraph, by key. */
function trailers(message: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const last =
    message
      .trim()
      .split(/\n\s*\n/)
      .at(-1) ?? '';
  for (const line of last.split('\n')) {
    const m = /^([A-Za-z][\w-]*):\s*(.+?)\s*$/.exec(line);
    if (m) found.set(m[1] ?? '', [...(found.get(m[1] ?? '') ?? []), m[2] ?? '']);
  }
  return found;
}

const names = (value: string, feature: string) =>
  value === feature || value.startsWith(`${feature}/`);

function commitProblems(commit: TraceCommit, feature: string): string[] {
  if (commit.parents > 1) return [];
  const t = trailers(commit.message);
  const problems: string[] = [];
  const roles = t.get('Factory-Role') ?? [];
  if (roles.length === 0) problems.push('no Factory-Role: trailer');
  for (const role of roles) {
    if (role === DISPATCHER) {
      const others = commit.paths?.filter((p) => !dispatcherFile(p, feature));
      if (others === undefined)
        problems.push(`Factory-Role: ${role} on a commit whose changed files are unknown`);
      else if (others.length > 0)
        problems.push(`Factory-Role: ${role} on a commit that changes ${others.join(', ')}`);
    } else if (!(ROLES as readonly string[]).includes(role))
      problems.push(`Factory-Role: ${role} is not a factory role`);
  }
  const items = t.get('Factory-Item') ?? [];
  if (items.length === 0) problems.push('no Factory-Item: trailer');
  for (const item of items)
    if (!names(item, feature)) problems.push(`Factory-Item: ${item} is not ${feature}`);
  const subject = commit.message.split('\n', 1)[0] ?? '';
  return problems.map((p) => `${commit.sha.slice(0, 12)} ${subject}: ${p}`);
}

/** Agent commits (not merges) lacking a well-formed `Factory-Role:` or `Factory-Item:` trailer. */
export function untrailered(commits: readonly TraceCommit[], feature: string): string[] {
  return commits.flatMap((c) => commitProblems(c, feature));
}

export function trace(input: TraceInput): Trace {
  const dir = `specs/${input.feature}`;
  const links: TraceLink[] = [];
  const gaps: string[] = [];
  const link = (step: TraceStep, refs: string[], gap: string[]) => {
    links.push({ step, refs });
    gaps.push(...gap.map((g) => `${step}: ${g}`));
  };
  const file = (step: TraceStep, text: string | undefined, name: string) => {
    link(
      step,
      text === undefined ? [] : [`${dir}/${name}`],
      text === undefined ? [`no ${name} in ${dir}`] : [],
    );
  };

  link('request', [`#${String(input.issue)} ${input.title}`], []);
  file('spec', input.files.spec, 'spec.md');
  file('plan', input.files.plan, 'plan.md');
  file('tasks', input.files.tasks, 'tasks.md');

  const own = input.commits.filter((c) =>
    (trailers(c.message).get('Factory-Item') ?? []).some((v) => names(v, input.feature)),
  );
  link(
    'commits',
    own.map((c) => c.sha.slice(0, 12)),
    own.length === 0 ? ['no commit names the item in Factory-Item:'] : [],
  );
  file('review', input.files.verify, 'reports/verify.md');

  const acs = input.files.spec === undefined ? [] : checkSpec(input.files.spec).acs;
  const named = (title: string) => acs.some((ac) => new RegExp(`\\b${ac}\\b`).test(title));
  link(
    'tests',
    input.tests.filter(named),
    acs
      .filter((ac) => !input.tests.some((t) => new RegExp(`\\b${ac}\\b`).test(t)))
      .map((ac) => `${ac} has no test naming it`),
  );

  const release = input.release;
  const issueRef = new RegExp(`#${String(input.issue)}(?!\\d)`);
  if (release === undefined) link('release', [], ['not released yet']);
  else if (!issueRef.test(release.notes))
    link('release', [], [`the notes of ${release.version} do not name #${String(input.issue)}`]);
  else link('release', [release.version], []);

  return { links, gaps, untrailered: untrailered(input.commits, input.feature) };
}

/**
 * The trail from the step holding `ref` back to the request, nearest first; a commit may be
 * named by any prefix of its hash. Empty when no step holds `ref`.
 */
export function traceBack(t: Trace, ref: string): TraceLink[] {
  const at = t.links.findIndex((l) =>
    l.refs.some(
      (r) =>
        r === ref ||
        (l.step === 'commits' && ref.length >= 7 && (r.startsWith(ref) || ref.startsWith(r))),
    ),
  );
  return at === -1 ? [] : t.links.slice(0, at + 1).reverse();
}
