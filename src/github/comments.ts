// Issue and pull request comments. Bodies travel on stdin (`--body-file -`) so a record or
// alert never lands in argv, where it could be read as a flag or show up in `ps`.
import type { PostedComment } from '../approvals/verify.js';
import { Fields, gh, numberArg, repoArg, type GhOptions } from './gh.js';

export interface IssueComment extends PostedComment {
  author: string;
}

export interface ThreadOptions extends GhOptions {
  /** Waiver records are posted on pull requests. Default: issue. */
  thread?: 'issue' | 'pr';
}

/** Every comment on the thread, oldest first. */
export async function listComments(
  repo: string,
  number: number,
  options: ThreadOptions = {},
): Promise<IssueComment[]> {
  const args = [options.thread ?? 'issue', 'view', numberArg(number), '--repo', repoArg(repo)];
  const out = await gh([...args, '--json', 'comments'], { ...options, json: true });
  return Fields.of(out, 'thread')
    .list('comments')
    .map((c) => {
      const f = Fields.of(c, 'comment');
      return {
        id: f.id('id'),
        author: f.login('author'),
        body: f.str('body'),
        createdAt: f.str('createdAt'),
      };
    });
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
