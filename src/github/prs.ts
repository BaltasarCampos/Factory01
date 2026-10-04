// Pull requests. There is deliberately no merge helper: `gh pr merge` would make an unsigned
// commit on main. Merges are made on the laptop by `factory merge` (T068) with the Owner's key.
import {
  asList,
  Fields,
  gh,
  GhError,
  numberArg,
  prNumberFromUrl,
  refArg,
  repoArg,
  type GhOptions,
} from './gh.js';

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  author: string;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  isDraft: boolean;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  url: string;
}

const FIELDS = 'number,title,body,author,headRefName,baseRefName,headRefOid,isDraft,state,url';
const STATES = ['OPEN', 'CLOSED', 'MERGED'] as const;

function toPr(value: unknown): PullRequest {
  const f = Fields.of(value, 'pull request');
  const state = STATES.find((s) => s === f.str('state'));
  if (state === undefined) {
    throw new GhError(`unexpected gh output: pull request state ${JSON.stringify(f.str('state'))}`);
  }
  return {
    number: f.num('number'),
    title: f.str('title'),
    body: f.str('body'),
    author: f.login('author'),
    headRefName: f.str('headRefName'),
    baseRefName: f.str('baseRefName'),
    headRefOid: f.str('headRefOid'),
    isDraft: f.bool('isDraft'),
    state,
    url: f.str('url'),
  };
}

export interface NewPr {
  head: string;
  base: string;
  title: string;
  body: string;
}

/** Open a draft pull request; returns its number. */
export async function createDraftPr(
  repo: string,
  pr: NewPr,
  options: GhOptions = {},
): Promise<number> {
  const args = ['pr', 'create', '--repo', repoArg(repo), '--draft'];
  const refs = ['--head', refArg(pr.head), '--base', refArg(pr.base), '--title', pr.title];
  const url = await gh([...args, ...refs, '--body-file', '-'], { ...options, input: pr.body });
  return prNumberFromUrl(url);
}

/** A pull request by number, or the latest one from a head branch. */
export async function viewPr(
  repo: string,
  ref: number | string,
  options: GhOptions = {},
): Promise<PullRequest> {
  const which = typeof ref === 'number' ? numberArg(ref) : refArg(ref);
  const args = ['pr', 'view', which, '--repo', repoArg(repo), '--json', FIELDS];
  return toPr(await gh(args, { ...options, json: true }));
}

export interface PrFilter {
  /** Default: open. */
  state?: 'open' | 'closed' | 'merged' | 'all';
  head?: string;
}

export async function listPrs(
  repo: string,
  filter: PrFilter = {},
  options: GhOptions = {},
): Promise<PullRequest[]> {
  const args = ['pr', 'list', '--repo', repoArg(repo), '--state', filter.state ?? 'open'];
  if (filter.head !== undefined) args.push('--head', refArg(filter.head));
  args.push('--json', FIELDS, '--limit', '1000');
  return asList(await gh(args, { ...options, json: true }), 'pull requests').map(toPr);
}

export async function closePr(
  repo: string,
  number: number,
  how: { comment?: string; deleteBranch?: boolean } = {},
  options: GhOptions = {},
): Promise<void> {
  const args = ['pr', 'close', numberArg(number), '--repo', repoArg(repo)];
  if (how.comment !== undefined) args.push('--comment', how.comment);
  if (how.deleteBranch === true) args.push('--delete-branch');
  await gh(args, options);
}
