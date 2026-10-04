// The Owner inbox issue (FR-034a): one pinned issue per project that carries alerts, pause
// labels and resume records. Its number goes into `.factory/config` as `inbox_issue`.
import { gh, GhError, numberArg, repoArg, type GhOptions } from '../github/gh.js';

export const INBOX_TITLE = 'Factory inbox';

const INBOX_BODY = `Owner inbox of the software factory.

- Alerts arrive here as comments; \`factory inbox\` lists the unread ones.
- \`factory pause [station]\` adds a \`pause:\` label here; only a signed \`factory resume\` lifts it.
- Do not close or unpin this issue.
`;

/** Create and pin the inbox issue; returns its number. */
export async function createInboxIssue(repo: string, options: GhOptions = {}): Promise<number> {
  const args = ['issue', 'create', '--repo', repoArg(repo), '--title', INBOX_TITLE];
  const url = (await gh([...args, '--body-file', '-'], { ...options, input: INBOX_BODY })).trim();
  const match = /\/issues\/(\d+)$/.exec(url);
  if (!match) throw new GhError(`unexpected gh output: no issue number in ${JSON.stringify(url)}`);
  const issue = Number(match[1]);
  await gh(['issue', 'pin', numberArg(issue), '--repo', repo], options);
  return issue;
}
