// Fake GitHub CLI. The `tests/helpers/bin/gh` shim runs this file with Node's type stripping,
// so it uses erasable TypeScript only and imports nothing local. State lives in the JSON file
// named by FAKE_GH_STATE; every invocation is appended to `<state>.calls.jsonl`.
//
// Tests import the exported helpers (`seedState`, `readState`, `calls`) instead of running it.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface FakeLabelEvent {
  event: 'labeled' | 'unlabeled';
  label: { name: string };
  actor: { login: string };
  created_at: string;
}

export interface FakeComment {
  id: number;
  author: string;
  body: string;
  createdAt: string;
}

export interface FakeIssue {
  number: number;
  title: string;
  body: string;
  author: string;
  state: 'OPEN' | 'CLOSED';
  labels: string[];
  comments: FakeComment[];
  events: FakeLabelEvent[];
  isPinned: boolean;
  createdAt: string;
}

export interface FakePr {
  number: number;
  title: string;
  body: string;
  author: string;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  isDraft: boolean;
  state: 'OPEN' | 'CLOSED';
  comments: FakeComment[];
  createdAt: string;
}

export interface FakeLabel {
  name: string;
  color: string;
  description: string;
}

export interface FakeRepo {
  visibility: 'private' | 'public';
  /** Bare git repository standing in for the GitHub remote. */
  origin?: string;
  labels: FakeLabel[];
  issues: FakeIssue[];
  prs: FakePr[];
  workflowRuns: { workflow: string; inputs: Record<string, string>; createdAt: string }[];
  /** Canned responses for other `gh api` paths, keyed by path without the leading slash. */
  api: Record<string, unknown>;
}

export interface FakeGhState {
  /** Login of the authenticated user; FAKE_GH_USER overrides it per call. */
  user: string;
  /** Repository used when no `--repo` is given and GH_REPO is unset. */
  defaultRepo: string;
  /** GitHub's clock; every mutation stamps this time, then advances it one second. */
  clock: string;
  /** Page size for `gh api --paginate`. */
  pageSize: number;
  /** Where `gh repo create` puts new bare repositories (none when unset). */
  gitRoot?: string;
  nextNumber: number;
  nextCommentId: number;
  repos: Record<string, FakeRepo>;
}

export type DeepPartialRepo = Partial<Omit<FakeRepo, 'issues' | 'prs'>> & {
  issues?: (Partial<FakeIssue> & { number: number })[];
  prs?: (Partial<FakePr> & { number: number; headRefName: string })[];
};

export type SeedState = Partial<Omit<FakeGhState, 'repos'>> & {
  repos?: Record<string, DeepPartialRepo>;
};

const DEFAULT_CLOCK = '2026-10-02T09:00:00Z';

function normaliseRepo(repo: DeepPartialRepo, clock: string): FakeRepo {
  return {
    visibility: repo.visibility ?? 'private',
    ...(repo.origin === undefined ? {} : { origin: repo.origin }),
    labels: repo.labels ?? [],
    workflowRuns: repo.workflowRuns ?? [],
    api: repo.api ?? {},
    issues: (repo.issues ?? []).map((i) => ({
      number: i.number,
      title: i.title ?? `Issue ${String(i.number)}`,
      body: i.body ?? '',
      author: i.author ?? 'owner',
      state: i.state ?? 'OPEN',
      labels: i.labels ?? [],
      comments: i.comments ?? [],
      events: i.events ?? [],
      isPinned: i.isPinned ?? false,
      createdAt: i.createdAt ?? clock,
    })),
    prs: (repo.prs ?? []).map((p) => ({
      number: p.number,
      title: p.title ?? `PR ${String(p.number)}`,
      body: p.body ?? '',
      author: p.author ?? 'owner',
      headRefName: p.headRefName,
      baseRefName: p.baseRefName ?? 'main',
      headRefOid: p.headRefOid ?? '',
      isDraft: p.isDraft ?? false,
      state: p.state ?? 'OPEN',
      comments: p.comments ?? [],
      createdAt: p.createdAt ?? clock,
    })),
  };
}

function normalise(seed: SeedState): FakeGhState {
  const clock = seed.clock ?? DEFAULT_CLOCK;
  const repos: Record<string, FakeRepo> = {};
  for (const [name, repo] of Object.entries(seed.repos ?? {}))
    repos[name] = normaliseRepo(repo, clock);
  const numbers = Object.values(repos).flatMap((r) => [
    ...r.issues.map((i) => i.number),
    ...r.prs.map((p) => p.number),
  ]);
  const commentIds = Object.values(repos).flatMap((r) =>
    [...r.issues, ...r.prs].flatMap((x) => x.comments.map((c) => c.id)),
  );
  return {
    user: seed.user ?? 'owner',
    defaultRepo: seed.defaultRepo ?? Object.keys(repos)[0] ?? 'owner/project',
    clock,
    pageSize: seed.pageSize ?? 100,
    ...(seed.gitRoot === undefined ? {} : { gitRoot: seed.gitRoot }),
    nextNumber: seed.nextNumber ?? Math.max(0, ...numbers) + 1,
    nextCommentId: seed.nextCommentId ?? Math.max(1000, ...commentIds) + 1,
    repos,
  };
}

// ---------------------------------------------------------------- helpers for tests

/**
 * Write a fresh state file (defaults filled in), point FAKE_GH_STATE at it, and return its path.
 * Pass `path` to reuse a location.
 */
export function seedState(seed: SeedState = {}, path?: string): string {
  const file = path ?? join(mkdtempSync(join(tmpdir(), 'fake-gh-')), 'state.json');
  writeFileSync(file, JSON.stringify(normalise(seed), null, 2));
  writeFileSync(`${file}.calls.jsonl`, '');
  process.env.FAKE_GH_STATE = file;
  return file;
}

function statePath(path?: string): string {
  const file = path ?? process.env.FAKE_GH_STATE;
  if (!file) throw new Error('FAKE_GH_STATE is not set; call seedState() first');
  return file;
}

export function readState(path?: string): FakeGhState {
  return JSON.parse(readFileSync(statePath(path), 'utf8')) as FakeGhState;
}

/** Every recorded `gh` invocation (argument vectors), oldest first. */
export function calls(path?: string): string[][] {
  const file = `${statePath(path)}.calls.jsonl`;
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as string[]);
}

// ---------------------------------------------------------------- CLI implementation

class GhFailure extends Error {
  readonly code: number;
  constructor(message: string, code = 1) {
    super(message);
    this.code = code;
  }
}

interface Parsed {
  positional: string[];
  flags: Map<string, string[]>;
}

const BOOLEAN_FLAGS = new Set([
  'draft',
  'paginate',
  'private',
  'public',
  'force',
  'delete-branch',
  'web',
]);
const SHORT_FLAGS: Record<string, string> = {
  R: 'repo',
  t: 'title',
  b: 'body',
  F: 'body-file',
  l: 'label',
  q: 'jq',
  f: 'raw-field',
  X: 'method',
  H: 'head',
  B: 'base',
  d: 'draft',
  L: 'limit',
  s: 'state',
  A: 'author',
  c: 'comment',
};

function parse(args: readonly string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  const add = (key: string, value: string) => {
    flags.set(key, [...(flags.get(key) ?? []), value]);
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      if (eq !== -1) add(key, arg.slice(eq + 1));
      else if (BOOLEAN_FLAGS.has(key)) add(key, 'true');
      else add(key, args[++i] ?? '');
    } else if (arg.startsWith('-') && arg.length === 2) {
      const key = SHORT_FLAGS[arg.slice(1)] ?? arg.slice(1);
      if (BOOLEAN_FLAGS.has(key)) add(key, 'true');
      else add(key, args[++i] ?? '');
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function flag(p: Parsed, key: string): string | undefined {
  const values = p.flags.get(key);
  return values?.[values.length - 1];
}

function listFlag(p: Parsed, key: string): string[] {
  return (p.flags.get(key) ?? [])
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter((v) => v !== '');
}

function tick(state: FakeGhState): string {
  const now = state.clock;
  state.clock = new Date(Date.parse(now) + 1000).toISOString().replace('.000Z', 'Z');
  return now;
}

function actor(state: FakeGhState): string {
  return process.env.FAKE_GH_USER ?? state.user;
}

function repoName(state: FakeGhState, p: Parsed): string {
  return flag(p, 'repo') ?? process.env.GH_REPO ?? state.defaultRepo;
}

function getRepo(state: FakeGhState, name: string): FakeRepo {
  const repo = state.repos[name];
  if (!repo)
    throw new GhFailure(`GraphQL: Could not resolve to a Repository with the name '${name}'.`);
  return repo;
}

function body(p: Parsed): string {
  const file = flag(p, 'body-file');
  if (file !== undefined) return readFileSync(file === '-' ? 0 : file, 'utf8');
  return flag(p, 'body') ?? '';
}

function gitOut(cwd: string, args: readonly string[]): string | undefined {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  } catch {
    return undefined;
  }
}

function headOid(repo: FakeRepo, branch: string): string | undefined {
  if (!repo.origin) return undefined;
  return gitOut(repo.origin, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`]);
}

function isMerged(repo: FakeRepo, pr: FakePr): boolean {
  if (!repo.origin || pr.headRefOid === '') return false;
  try {
    execFileSync(
      'git',
      ['merge-base', '--is-ancestor', pr.headRefOid, `refs/heads/${pr.baseRefName}`],
      {
        cwd: repo.origin,
        stdio: 'ignore',
      },
    );
    return true;
  } catch {
    return false;
  }
}

function commentJson(c: FakeComment) {
  return { id: c.id, author: { login: c.author }, body: c.body, createdAt: c.createdAt };
}

function issueJson(repoFull: string, i: FakeIssue): Record<string, unknown> {
  return {
    number: i.number,
    title: i.title,
    body: i.body,
    author: { login: i.author },
    state: i.state,
    labels: i.labels.map((name) => ({ name })),
    comments: i.comments.map(commentJson),
    isPinned: i.isPinned,
    createdAt: i.createdAt,
    url: `https://github.com/${repoFull}/issues/${String(i.number)}`,
  };
}

function prJson(repoFull: string, repo: FakeRepo, pr: FakePr): Record<string, unknown> {
  const live = headOid(repo, pr.headRefName);
  if (live !== undefined && pr.state === 'OPEN') pr.headRefOid = live;
  const merged = isMerged(repo, pr);
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body,
    author: { login: pr.author },
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
    headRefOid: pr.headRefOid,
    isDraft: pr.isDraft,
    state: merged ? 'MERGED' : pr.state,
    comments: pr.comments.map(commentJson),
    createdAt: pr.createdAt,
    url: `https://github.com/${repoFull}/pull/${String(pr.number)}`,
  };
}

function pick(obj: Record<string, unknown>, fields: string | undefined): Record<string, unknown> {
  if (fields === undefined || fields === '') return obj;
  const out: Record<string, unknown> = {};
  for (const field of fields.split(',').map((f) => f.trim())) {
    if (!(field in obj)) throw new GhFailure(`Unknown JSON field: "${field}"`);
    out[field] = obj[field];
  }
  return out;
}

function findIssue(repo: FakeRepo, ref: string | undefined): FakeIssue {
  const n = Number((ref ?? '').replace(/^#/, ''));
  const issue = repo.issues.find((i) => i.number === n);
  if (!issue)
    throw new GhFailure(
      `GraphQL: Could not resolve to an issue or pull request with the number of ${ref ?? ''}.`,
    );
  return issue;
}

function findPr(repo: FakeRepo, ref: string | undefined): FakePr {
  const n = Number((ref ?? '').replace(/^#/, ''));
  const pr =
    Number.isInteger(n) && n > 0
      ? repo.prs.find((p) => p.number === n)
      : [...repo.prs].reverse().find((p) => p.headRefName === ref);
  if (!pr) throw new GhFailure(`no pull requests found for branch "${ref ?? ''}"`);
  return pr;
}

function ensureLabelExists(repo: FakeRepo, name: string): void {
  if (!repo.labels.some((l) => l.name === name)) {
    throw new GhFailure(`could not add label: '${name}' not found`);
  }
}

function applyLabels(
  state: FakeGhState,
  repo: FakeRepo,
  issue: FakeIssue,
  add: string[],
  remove: string[],
): void {
  for (const name of add) {
    ensureLabelExists(repo, name);
    if (issue.labels.includes(name)) continue;
    issue.labels.push(name);
    issue.events.push({
      event: 'labeled',
      label: { name },
      actor: { login: actor(state) },
      created_at: tick(state),
    });
  }
  for (const name of remove) {
    if (!issue.labels.includes(name)) continue;
    issue.labels = issue.labels.filter((l) => l !== name);
    issue.events.push({
      event: 'unlabeled',
      label: { name },
      actor: { login: actor(state) },
      created_at: tick(state),
    });
  }
}

function addComment(
  state: FakeGhState,
  target: { comments: FakeComment[] },
  text: string,
): FakeComment {
  const comment = {
    id: state.nextCommentId++,
    author: actor(state),
    body: text,
    createdAt: tick(state),
  };
  target.comments.push(comment);
  return comment;
}

function issueCommand(state: FakeGhState, sub: string | undefined, p: Parsed, out: string[]): void {
  const full = repoName(state, p);
  const repo = getRepo(state, full);
  const json = flag(p, 'json');
  switch (sub) {
    case 'view': {
      const issue = findIssue(repo, p.positional[0]);
      out.push(
        json === undefined ? issue.title : JSON.stringify(pick(issueJson(full, issue), json)),
      );
      return;
    }
    case 'list': {
      const wantState = (flag(p, 'state') ?? 'open').toUpperCase();
      const labels = listFlag(p, 'label');
      const author = flag(p, 'author');
      const limit = Number(flag(p, 'limit') ?? '30');
      const issues = repo.issues
        .filter((i) => wantState === 'ALL' || i.state === wantState)
        .filter((i) => labels.every((l) => i.labels.includes(l)))
        .filter((i) => author === undefined || i.author === author)
        .sort((a, b) => b.number - a.number)
        .slice(0, limit);
      out.push(JSON.stringify(issues.map((i) => pick(issueJson(full, i), json))));
      return;
    }
    case 'create': {
      const issue: FakeIssue = {
        number: state.nextNumber++,
        title: flag(p, 'title') ?? '',
        body: body(p),
        author: actor(state),
        state: 'OPEN',
        labels: [],
        comments: [],
        events: [],
        isPinned: false,
        createdAt: tick(state),
      };
      repo.issues.push(issue);
      applyLabels(state, repo, issue, listFlag(p, 'label'), []);
      out.push(`https://github.com/${full}/issues/${String(issue.number)}`);
      return;
    }
    case 'edit': {
      const issue = findIssue(repo, p.positional[0]);
      const title = flag(p, 'title');
      if (title !== undefined) issue.title = title;
      if (p.flags.has('body') || p.flags.has('body-file')) issue.body = body(p);
      applyLabels(state, repo, issue, listFlag(p, 'add-label'), listFlag(p, 'remove-label'));
      out.push(`https://github.com/${full}/issues/${String(issue.number)}`);
      return;
    }
    case 'comment': {
      const issue = findIssue(repo, p.positional[0]);
      const c = addComment(state, issue, body(p));
      out.push(
        `https://github.com/${full}/issues/${String(issue.number)}#issuecomment-${String(c.id)}`,
      );
      return;
    }
    case 'close': {
      const issue = findIssue(repo, p.positional[0]);
      const text = flag(p, 'comment');
      if (text !== undefined) addComment(state, issue, text);
      issue.state = 'CLOSED';
      return;
    }
    case 'pin': {
      findIssue(repo, p.positional[0]).isPinned = true;
      return;
    }
    default:
      throw new GhFailure(`unknown command "issue ${sub ?? ''}"`);
  }
}

function labelCommand(state: FakeGhState, sub: string | undefined, p: Parsed, out: string[]): void {
  const repo = getRepo(state, repoName(state, p));
  switch (sub) {
    case 'create': {
      const name = p.positional[0] ?? '';
      const existing = repo.labels.find((l) => l.name === name);
      const label = {
        name,
        color: flag(p, 'color') ?? 'ededed',
        description: flag(p, 'description') ?? '',
      };
      if (existing && flag(p, 'force') !== 'true')
        throw new GhFailure(
          `label with name "${name}" already exists; use \`--force\` to update its color and description`,
        );
      if (existing) Object.assign(existing, label);
      else repo.labels.push(label);
      return;
    }
    case 'list': {
      const json = flag(p, 'json');
      out.push(JSON.stringify(repo.labels.map((l) => pick({ ...l }, json))));
      return;
    }
    default:
      throw new GhFailure(`unknown command "label ${sub ?? ''}"`);
  }
}

function prCommand(state: FakeGhState, sub: string | undefined, p: Parsed, out: string[]): void {
  const full = repoName(state, p);
  const repo = getRepo(state, full);
  const json = flag(p, 'json');
  switch (sub) {
    case 'create': {
      const head = flag(p, 'head') ?? '';
      if (
        repo.prs.some((x) => x.headRefName === head && x.state === 'OPEN' && !isMerged(repo, x))
      ) {
        throw new GhFailure(
          `a pull request for branch "${head}" into branch "${flag(p, 'base') ?? 'main'}" already exists`,
        );
      }
      const pr: FakePr = {
        number: state.nextNumber++,
        title: flag(p, 'title') ?? '',
        body: body(p),
        author: actor(state),
        headRefName: head,
        baseRefName: flag(p, 'base') ?? 'main',
        headRefOid: headOid(repo, head) ?? '',
        isDraft: flag(p, 'draft') === 'true',
        state: 'OPEN',
        comments: [],
        createdAt: tick(state),
      };
      repo.prs.push(pr);
      out.push(`https://github.com/${full}/pull/${String(pr.number)}`);
      return;
    }
    case 'view': {
      const pr = findPr(repo, p.positional[0]);
      out.push(json === undefined ? pr.title : JSON.stringify(pick(prJson(full, repo, pr), json)));
      return;
    }
    case 'list': {
      const wantState = (flag(p, 'state') ?? 'open').toUpperCase();
      const head = flag(p, 'head');
      const limit = Number(flag(p, 'limit') ?? '30');
      const rows = repo.prs
        .map((pr) => prJson(full, repo, pr))
        .filter((pr) => wantState === 'ALL' || pr.state === wantState)
        .filter((pr) => head === undefined || pr.headRefName === head)
        .sort((a, b) => Number(b.number) - Number(a.number))
        .slice(0, limit);
      out.push(JSON.stringify(rows.map((r) => pick(r, json))));
      return;
    }
    case 'close': {
      const pr = findPr(repo, p.positional[0]);
      const text = flag(p, 'comment');
      if (text !== undefined) addComment(state, pr, text);
      pr.state = 'CLOSED';
      if (flag(p, 'delete-branch') === 'true' && repo.origin) {
        gitOut(repo.origin, ['update-ref', '-d', `refs/heads/${pr.headRefName}`]);
      }
      return;
    }
    case 'comment': {
      const pr = findPr(repo, p.positional[0]);
      const c = addComment(state, pr, body(p));
      out.push(`https://github.com/${full}/pull/${String(pr.number)}#issuecomment-${String(c.id)}`);
      return;
    }
    default:
      throw new GhFailure(`unknown command "pr ${sub ?? ''}"`);
  }
}

function apiCommand(state: FakeGhState, p: Parsed, out: string[]): void {
  const path = (p.positional[0] ?? '').replace(/^\//, '');
  const paginate = flag(p, 'paginate') === 'true';
  const timeline = /^repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/timeline$/.exec(path);
  if (timeline) {
    const repo = getRepo(state, timeline[1] ?? '');
    const n = Number(timeline[2]);
    const item = repo.issues.find((i) => i.number === n);
    if (!item) throw new GhFailure('Not Found (HTTP 404)');
    const events = [...item.events].sort((a, b) => a.created_at.localeCompare(b.created_at));
    const pages: FakeLabelEvent[][] = [];
    for (let i = 0; i < events.length; i += state.pageSize)
      pages.push(events.slice(i, i + state.pageSize));
    if (pages.length === 0) pages.push([]);
    // `gh api --paginate` prints each page's JSON array back to back.
    out.push((paginate ? pages : pages.slice(0, 1)).map((page) => JSON.stringify(page)).join(''));
    return;
  }
  if (path === 'user') {
    out.push(JSON.stringify({ login: actor(state) }));
    return;
  }
  const repoMatch = /^repos\/([^/]+\/[^/]+)$/.exec(path);
  if (repoMatch) {
    const full = repoMatch[1] ?? '';
    const repo = getRepo(state, full);
    out.push(
      JSON.stringify({
        full_name: full,
        private: repo.visibility === 'private',
        visibility: repo.visibility,
      }),
    );
    return;
  }
  const owner = /^repos\/([^/]+\/[^/]+)\//.exec(path);
  const canned = owner ? state.repos[owner[1] ?? '']?.api[path] : undefined;
  if (canned === undefined) throw new GhFailure('Not Found (HTTP 404)');
  out.push(JSON.stringify(canned));
}

function repoCommand(state: FakeGhState, sub: string | undefined, p: Parsed, out: string[]): void {
  switch (sub) {
    case 'create': {
      const arg = p.positional[0] ?? '';
      const full = arg.includes('/') ? arg : `${actor(state)}/${arg}`;
      if (state.repos[full])
        throw new GhFailure(`GraphQL: Name already exists on this account (createRepository)`);
      const repo = normaliseRepo(
        { visibility: flag(p, 'public') === 'true' ? 'public' : 'private' },
        state.clock,
      );
      if (state.gitRoot !== undefined) {
        const origin = join(state.gitRoot, `${full}.git`);
        execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', origin], {
          stdio: 'ignore',
        });
        repo.origin = origin;
      }
      state.repos[full] = repo;
      out.push(`https://github.com/${full}`);
      return;
    }
    case 'clone': {
      const full = p.positional[0] ?? '';
      const repo = getRepo(state, full);
      if (!repo.origin) throw new GhFailure(`repository ${full} has no git origin in the fake`);
      const dir = p.positional[1] ?? full.split('/')[1] ?? full;
      execFileSync('git', ['clone', '-q', repo.origin, dir], { stdio: 'pipe' });
      return;
    }
    case 'view': {
      const full = p.positional[0] ?? repoName(state, p);
      const repo = getRepo(state, full);
      const row = {
        nameWithOwner: full,
        visibility: repo.visibility.toUpperCase(),
        isPrivate: repo.visibility === 'private',
      };
      out.push(JSON.stringify(pick(row, flag(p, 'json'))));
      return;
    }
    default:
      throw new GhFailure(`unknown command "repo ${sub ?? ''}"`);
  }
}

function workflowCommand(state: FakeGhState, sub: string | undefined, p: Parsed): void {
  if (sub !== 'run') throw new GhFailure(`unknown command "workflow ${sub ?? ''}"`);
  const repo = getRepo(state, repoName(state, p));
  const inputs: Record<string, string> = {};
  for (const kv of p.flags.get('raw-field') ?? []) {
    const eq = kv.indexOf('=');
    inputs[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
  repo.workflowRuns.push({ workflow: p.positional[0] ?? '', inputs, createdAt: tick(state) });
}

/** Run one fake `gh` invocation against the state file. Returns the exit code. */
export function runFakeGh(args: readonly string[]): {
  code: number;
  stdout: string;
  stderr: string;
} {
  const file = process.env.FAKE_GH_STATE;
  if (file === undefined || !existsSync(file)) {
    return { code: 4, stdout: '', stderr: 'fake gh: FAKE_GH_STATE does not name a state file\n' };
  }
  appendFileSync(`${file}.calls.jsonl`, `${JSON.stringify(args)}\n`);
  if (args[0] === '--version') return { code: 0, stdout: 'gh version 2.99.0 (fake)\n', stderr: '' };
  const state = readState(file);
  const out: string[] = [];
  try {
    const [group, sub, ...rest] = args;
    const p = parse(group === 'api' ? args.slice(1) : rest);
    switch (group) {
      case 'issue':
        issueCommand(state, sub, p, out);
        break;
      case 'label':
        labelCommand(state, sub, p, out);
        break;
      case 'pr':
        prCommand(state, sub, p, out);
        break;
      case 'api':
        apiCommand(state, p, out);
        break;
      case 'repo':
        repoCommand(state, sub, p, out);
        break;
      case 'workflow':
        workflowCommand(state, sub, p);
        break;
      default:
        throw new GhFailure(`unknown command "${group ?? ''}" for "gh"`);
    }
  } catch (err) {
    if (err instanceof GhFailure) return { code: err.code, stdout: '', stderr: `${err.message}\n` };
    throw err;
  }
  writeFileSync(file, JSON.stringify(state, null, 2));
  return { code: 0, stdout: out.map((line) => `${line}\n`).join(''), stderr: '' };
}

if (import.meta.main) {
  const result = runFakeGh(process.argv.slice(2));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.code;
}
