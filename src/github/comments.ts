// Issue and pull request comments. Bodies travel on stdin (`--body-file -`) so a record or
// alert never lands in argv, where it could be read as a flag or show up in `ps`.
import type { PostedComment } from '../approvals/verify.js';
import { asList, Fields, gh, GhError, numberArg, repoArg, type GhOptions } from './gh.js';

export interface IssueComment extends PostedComment {
  /** The login that posted it; empty for a deleted account. */
  author: string;
  /** Posted through a GitHub App (`performed_via_github_app`). */
  viaApp: boolean;
}

export interface ThreadOptions extends GhOptions {
  /** Waiver records are posted on pull requests. Default: issue. */
  thread?: 'issue' | 'pr';
}

/**
 * Every comment on an issue or pull request, oldest first, every page. The id is the GraphQL node
 * id, which the laptop's nonce ledger names a record's comment by.
 */
export async function listComments(
  repo: string,
  number: number,
  options: GhOptions = {},
): Promise<IssueComment[]> {
  const path = `repos/${repoArg(repo)}/issues/${numberArg(number)}/comments?per_page=100`;
  const out = await gh(['api', path, '--paginate'], { ...options, json: true });
  return asList(out, 'comments').map((c) => {
    const f = Fields.of(c, 'comment');
    return {
      id: f.str('node_id'),
      author: f.has('user') ? f.login('user') : '',
      viaApp: f.nullable('performed_via_github_app') !== null,
      body: f.str('body'),
      createdAt: f.str('created_at'),
    };
  });
}

/** The login gh posts as, with the token these options give it. */
export async function postingAccount(options: GhOptions = {}): Promise<string> {
  const user = Fields.of(await gh(['api', 'user'], { ...options, json: true }), 'user');
  const login = user.str('login');
  if (login === '') throw new GhError('unexpected gh output: user.login is empty');
  return login;
}

export interface Sorted {
  /** Posted by the posting account itself, not through an App. */
  own: IssueComment[];
  /** How many were left out as another account's. */
  otherAccount: number;
  /** How many were left out as posted through a GitHub App, with the posting account's login. */
  viaApp: number;
}

/**
 * The comments the factory may take as its own, for the uses where only their author vouches for
 * them (T030): a signed record is vouched for by its signature and is not sorted here. A session
 * on the laptop posts with the same account, so this keeps out outsiders and Apps only. gh is
 * asked for the account only when there is a comment to sort, and a failed read throws.
 */
export async function ownComments(
  comments: readonly IssueComment[],
  options: GhOptions = {},
): Promise<Sorted> {
  if (comments.length === 0) return { own: [], otherAccount: 0, viaApp: 0 };
  const account = await postingAccount(options);
  const mine = comments.filter((c) => c.author === account);
  const own = mine.filter((c) => !c.viaApp);
  return {
    own,
    otherAccount: comments.length - mine.length,
    viaApp: mine.length - own.length,
  };
}

/** Post a comment; returns its URL. */
export async function postComment(
  repo: string,
  number: number,
  body: string,
  options: ThreadOptions = {},
): Promise<string> {
  const args = [options.thread ?? 'issue', 'comment', numberArg(number), '--repo', repoArg(repo)];
  return (await gh([...args, '--body-file', '-'], { ...options, input: body })).trim();
}
