// Which issues the line may act on (FR-016b, AC-008, AC-055): those the Owner wrote, and those
// a verified `owner:approved` record covers. Everything else is never picked, in any
// repository, including the public factory repository where anyone may open an issue.
//
// Define's seed issues are an exception to Owner authorship (AC-006): under a local launcher
// Define files them as the Owner, so they wait until the Define pull request is merged and each
// has its own verified `owner:approved`.
import type { Verdict } from '../approvals/verify.js';
import { asList, Fields, gh, repoArg, type GhOptions } from '../github/gh.js';
import { isSeed, type SeedLists } from '../stations/checks/define.js';

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

/** The Owner's login: the owner of the project repository. */
export function ownerLogin(repo: string): string {
  return repoArg(repo).split('/')[0] ?? '';
}

/** Why the issue is not admitted, or undefined when it is. */
export function notAdmitted(
  issue: IssueSummary,
  owner: string,
  approved: Verdict,
  seeds: SeedLists = { onMain: new Set(), listed: new Set() },
): string | undefined {
  if (isSeed(issue.body) || seeds.listed.has(issue.number)) {
    if (!seeds.onMain.has(issue.number))
      return 'Define seed issue: waiting for the Owner to merge the Define pull request';
    return approved.ok ? undefined : 'Define seed issue with no verified owner:approved';
  }
  if (issue.author === owner || approved.ok) return undefined;
  return `opened by ${issue.author}, not the Owner, and no verified owner:approved`;
}
