// Which issues the line may act on (FR-016b, AC-006, AC-008, AC-055): only those a verified
// `owner:approved` record covers, in every repository, including the public factory repository
// where anyone may open an issue. Authorship never counts, because agents act through the
// Owner's GitHub account, and nothing is admitted before main has the Owner-signed merge of the
// Define pull request (`Factory-Merge: define`, src/git/merges.ts).
import type { Verdict } from '../approvals/verify.js';
import { asList, Fields, gh, repoArg, type GhOptions } from '../github/gh.js';

export interface IssueSummary {
  number: number;
  title: string;
  author: string;
  body: string;
  labels: string[];
}

/** Open issues, lowest number first. */
export async function listOpenIssues(
  repo: string,
  options: GhOptions = {},
): Promise<IssueSummary[]> {
  const args = ['issue', 'list', '--repo', repoArg(repo), '--state', 'open'];
  args.push('--json', 'number,title,author,body,labels', '--limit', '1000');
  return asList(await gh(args, { ...options, json: true }), 'issues')
    .map((value) => {
      const f = Fields.of(value, 'issue');
      return {
        number: f.num('number'),
        title: f.str('title'),
        author: f.login('author'),
        body: f.str('body'),
        labels: f.list('labels').map((l) => Fields.of(l, 'label').str('name')),
      };
    })
    .sort((a, b) => a.number - b.number);
}

/** Why the issue is not admitted, or undefined when it is. */
export function notAdmitted(approved: Verdict, briefMerged: boolean): string | undefined {
  if (!briefMerged)
    return 'nothing is admitted while waiting for the Owner to merge the Define pull request';
  return approved.ok ? undefined : 'no verified owner:approved';
}
