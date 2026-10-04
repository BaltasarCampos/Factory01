// Which issues the line may act on (FR-016b, AC-008, AC-055): those the Owner wrote, and those
// a verified `owner:approved` record covers. Everything else is never picked, in any
// repository, including the public factory repository where anyone may open an issue.
import type { Verdict } from '../approvals/verify.js';
import { asList, Fields, gh, repoArg, type GhOptions } from '../github/gh.js';

export interface IssueSummary {
  number: number;
  title: string;
  author: string;
  labels: string[];
}

/** Open issues, lowest number first. */
export async function listOpenIssues(
  repo: string,
  options: GhOptions = {},
): Promise<IssueSummary[]> {
  const args = ['issue', 'list', '--repo', repoArg(repo), '--state', 'open'];
  args.push('--json', 'number,title,author,labels', '--limit', '1000');
  return asList(await gh(args, { ...options, json: true }), 'issues')
    .map((value) => {
      const f = Fields.of(value, 'issue');
      return {
        number: f.num('number'),
        title: f.str('title'),
        author: f.login('author'),
        labels: f.list('labels').map((l) => Fields.of(l, 'label').str('name')),
      };
    })
    .sort((a, b) => a.number - b.number);
}

/** The Owner's login: the owner of the project repository. */
export function ownerLogin(repo: string): string {
  return repoArg(repo).split('/')[0] ?? '';
}

/** Why the issue is not admitted, or undefined when it is. */
export function notAdmitted(
  issue: IssueSummary,
  owner: string,
  approved: Verdict,
): string | undefined {
  if (issue.author === owner || approved.ok) return undefined;
  return `opened by ${issue.author}, not the Owner, and no verified owner:approved`;
}
