// Which issues the line may act on (FR-016b, AC-006, AC-008, AC-055): only those a verified
// `owner:approved` record covers, in every repository, including the public factory repository
// where anyone may open an issue. Authorship never counts, because agents act through the
// Owner's GitHub account, and nothing is admitted before main has the Owner-signed merge of the
// Define pull request (`Factory-Merge: define`, src/git/merges.ts).
//
// The dispatcher reads only open issues carrying an `owner:` label, one bounded REST query per
// label, never search: anyone may open an issue on a public repository, but only the Owner and
// sessions add labels. An issue with another `owner:` label and no `owner:approved` is still
// read, since a label without a record is tampering (FR-016d, AC-068).
import type { Verdict } from '../approvals/verify.js';
import { asList, Fields, gh, repoArg, type GhOptions } from '../github/gh.js';

export interface IssueSummary {
  number: number;
  title: string;
  author: string;
  body: string;
  labels: string[];
}

const OWNER_LABELS = ['owner:approved', 'owner:spec-approved', 'owner:waiver'] as const;
/** GitHub's largest page: a label's query that fills it is refused, since there may be more. */
const PAGE = 100;

/** A label's query came back full: the line stops until fewer issues carry the label. */
export class TooManyOpen extends Error {
  constructor(label: string) {
    super(
      `at least ${String(PAGE)} open issues and pull requests carry ${label}, a full page, so there may be more: close them or remove the label until fewer than ${String(PAGE)} are open`,
    );
  }
}

/**
 * The open issues carrying an `owner:` label, lowest number first; the pull requests the same
 * queries return are left out. A failed query throws, never reading as no issues.
 */
export async function listOpenIssues(
  repo: string,
  options: GhOptions = {},
): Promise<IssueSummary[]> {
  const found = new Map<number, IssueSummary>();
  for (const label of OWNER_LABELS) {
    const query = `state=open&labels=${encodeURIComponent(label)}&per_page=${String(PAGE)}`;
    const path = `repos/${repoArg(repo)}/issues?${query}`;
    const page = asList(await gh(['api', path], { ...options, json: true }), 'issues');
    if (page.length >= PAGE) throw new TooManyOpen(label);
    for (const value of page) {
      const f = Fields.of(value, 'issue');
      if (f.has('pull_request')) continue;
      found.set(f.num('number'), {
        number: f.num('number'),
        title: f.str('title'),
        author: f.has('user') ? f.login('user') : '',
        // GitHub gives null for an empty body.
        body: f.has('body') ? f.str('body') : '',
        labels: f.list('labels').map((l) => Fields.of(l, 'label').str('name')),
      });
    }
  }
  return [...found.values()].sort((a, b) => a.number - b.number);
}

/** Why the issue is not admitted, or undefined when it is. */
export function notAdmitted(approved: Verdict, briefMerged: boolean): string | undefined {
  if (!briefMerged)
    return 'nothing is admitted while waiting for the Owner to merge the Define pull request';
  return approved.ok ? undefined : 'no verified owner:approved';
}
