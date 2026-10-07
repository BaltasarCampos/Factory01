// Define station output check (FR-010, AC-004–AC-006, AC-056, AC-064), used by the stop hook
// and the dispatcher, and later by `factory merge` for the Define pull request.
//
// Everything is read from git objects on `claude/define`, never the work tree, so only what
// was committed counts. Order is read from history: the questions are asked in one commit, the
// Owner's answers come after them, and the brief and backlog come after the answers.
//
// The seed marker and the backlog list are trace information: admission waits for the Owner's
// signed `Factory-Merge: define` and each issue's own `owner:approved` (src/dispatcher).
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { EnvironmentError } from '../../cli/env.js';
import { gh, Fields, numberArg, repoArg, type GhOptions } from '../../github/gh.js';
import { listPrs } from '../../github/prs.js';
import { DEFINE_BRANCH } from '../../install/project.js';
import { loadConfig } from '../../model/config.js';
import type { CheckResult } from '../../hooks/stop.js';

export const QUESTIONS_PATH = '.factory/define/questions.md';
export const ANSWERS_PATH = '.factory/define/answers.md';
export const BRIEF_PATH = '.factory/brief.md';
export const BACKLOG_PATH = '.factory/define/backlog.md';
/** In the body of every issue Define files. */
export const SEED_MARKER = '<!-- factory-seed -->';
export const BRIEF_SECTIONS = [
  'Problem',
  'Users',
  'Core use cases',
  'Non-goals',
  'Success measures',
  'Risk areas',
] as const;
const MAX_QUESTIONS = 5;
const SEEDS_MIN = 5;
const SEEDS_MAX = 10;

export interface DefineResult extends CheckResult {
  /** Questions asked and nothing else yet: a valid stop, waiting for the Owner's answers. */
  waiting: boolean;
}

export interface DefineCheck {
  /** A clone of the project. */
  workdir: string;
  repo: string;
  /** Default `HEAD`, which must be `claude/define`. */
  ref?: string;
  /** Default `origin/main`. */
  mainRef?: string;
  gh?: GhOptions;
}

function git(cwd: string, args: readonly string[]): { ok: boolean; out: string } {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    encoding: 'utf8',
  });
  if (result.error) throw new EnvironmentError(`could not run git: ${result.error.message}`);
  return { ok: result.status === 0, out: result.stdout.trim() };
}

/** A file at a commit, or undefined when it is not there. */
function show(cwd: string, ref: string, path: string): string | undefined {
  const result = git(cwd, ['show', `${ref}:${path}`]);
  return result.ok ? `${result.out}\n` : undefined;
}

/** Commits in `range` touching `path`, oldest first. */
function commitsTouching(cwd: string, range: string, path: string): string[] {
  const out = git(cwd, ['rev-list', '--reverse', range, '--', path]).out;
  return out === '' ? [] : out.split('\n');
}

/** Numbers of `Q<n>.` (or `A<n>.`) items, in order. */
function numbered(text: string, letter: 'Q' | 'A'): number[] {
  const pattern = new RegExp(`^${letter}(\\d+)[.:]\\s`);
  return text.split('\n').flatMap((line) => {
    const n = pattern.exec(line)?.[1];
    return n === undefined ? [] : [Number(n)];
  });
}

/** Problems with the question batch; the question numbers are returned when it is valid. */
export function checkQuestions(text: string): { questions: number[]; missing: string[] } {
  const questions = numbered(text, 'Q');
  if (questions.length === 0) return { questions, missing: [`${QUESTIONS_PATH}: no questions`] };
  if (questions.length > MAX_QUESTIONS) {
    const n = String(questions.length);
    return { questions, missing: [`${QUESTIONS_PATH}: ${n} questions; ask 1–5`] };
  }
  if (questions.some((q, i) => q !== i + 1))
    return {
      questions,
      missing: [`${QUESTIONS_PATH}: questions must be numbered Q1, Q2, … without gaps`],
    };
  return { questions, missing: [] };
}

/** Sections, and a source tag on every statement that names a question or a file. */
export function checkBrief(
  text: string,
  questions: readonly number[],
  inTree: (path: string) => boolean,
): string[] {
  const missing: string[] = [];
  const lines = text.split('\n');
  const headings = lines
    .filter((l) => l.startsWith('## '))
    .map((l) => l.slice(3).trim().toLowerCase());
  for (const section of BRIEF_SECTIONS)
    if (!headings.includes(section.toLowerCase()))
      missing.push(`${BRIEF_PATH}: no section "${section}"`);
  lines.forEach((line, i) => {
    if (line.trim() === '' || line.startsWith('#')) return;
    const at = `${BRIEF_PATH}:${String(i + 1)}`;
    const tags = [...line.matchAll(/\[(pitch|code:([^\]\s]+)|answer:Q(\d+))\]/g)];
    if (tags.length === 0) missing.push(`${at}: no source tag`);
    for (const [tag, , path, q] of tags) {
      if (q !== undefined && !questions.includes(Number(q)))
        missing.push(`${at}: ${tag} names no question`);
      if (path !== undefined && !inTree(path)) missing.push(`${at}: ${tag} is not in the tree`);
    }
  });
  return missing;
}

/** Issue numbers listed as `- #<n> …` lines. */
export function backlogIssues(text: string | undefined): number[] {
  return (text ?? '').split('\n').flatMap((line) => {
    const n = /^- #(\d+)\b/.exec(line)?.[1];
    return n === undefined ? [] : [Number(n)];
  });
}

export const isSeed = (body: string): boolean => body.includes(SEED_MARKER);

async function seedProblems(repo: string, issue: number, options: GhOptions): Promise<string[]> {
  const args = ['issue', 'view', numberArg(issue), '--repo', repoArg(repo)];
  const f = Fields.of(
    await gh([...args, '--json', 'body,labels,state'], { ...options, json: true }),
    'issue',
  );
  const at = `#${String(issue)}`;
  const tiers = f
    .list('labels')
    .filter((l) => Fields.of(l, 'label').str('name').startsWith('tier:'));
  return [
    ...(f.str('state') === 'OPEN' ? [] : [`${at}: not open`]),
    ...(isSeed(f.str('body')) ? [] : [`${at}: no ${SEED_MARKER} marker`]),
    ...(tiers.length === 1 ? [] : [`${at}: ${String(tiers.length)} tier: labels; exactly one`]),
  ];
}

async function prProblems(repo: string, sha: string, options: GhOptions): Promise<string[]> {
  const prs = await listPrs(repo, { head: DEFINE_BRANCH }, options);
  if (prs.length === 0) return [`pull request: none open from ${DEFINE_BRANCH}`];
  if (prs.length > 1)
    return [`pull request: ${String(prs.length)} open from ${DEFINE_BRANCH}; exactly one`];
  const [pr] = prs as [(typeof prs)[number]];
  const at = `pull request #${String(pr.number)}`;
  return [
    ...(pr.isDraft ? [] : [`${at} is not a draft`]),
    ...(pr.baseRefName === 'main' ? [] : [`${at} targets ${pr.baseRefName}, not main`]),
    ...(pr.headRefOid === sha
      ? []
      : [`${at} is at ${pr.headRefOid}, not the checked commit ${sha}; push it`]),
  ];
}

function skeletonProblems(cwd: string, sha: string): string[] {
  const missing: string[] = [];
  const pkg = show(cwd, sha, 'package.json');
  let test: unknown;
  try {
    test = (JSON.parse(pkg ?? '{}') as { scripts?: Record<string, unknown> }).scripts?.test;
  } catch {
    missing.push('skeleton: package.json is not JSON');
  }
  if (typeof test !== 'string' || test === '')
    missing.push('skeleton: package.json has no test script');
  const files = git(cwd, ['ls-tree', '-r', '--name-only', sha, '--', 'tests']).out.split('\n');
  if (!files.some((f) => /^tests\/.+\.test\.ts$/.test(f)))
    missing.push('skeleton: no tests/**/*.test.ts');
  return missing;
}

export async function checkDefine(input: DefineCheck): Promise<DefineResult> {
  const { workdir: cwd, repo } = input;
  const options = input.gh ?? {};
  const ref = input.ref ?? 'HEAD';
  const done = (missing: string[], waiting = false): DefineResult => ({
    complete: missing.length === 0 && !waiting,
    waiting: waiting && missing.length === 0,
    missing,
  });
  const missing: string[] = [];
  if (ref === 'HEAD') {
    const branch = git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']).out;
    if (branch !== DEFINE_BRANCH)
      missing.push(`not on ${DEFINE_BRANCH} (on ${branch || 'no branch'})`);
  }
  const sha = git(cwd, ['rev-parse', '--verify', `${ref}^{commit}`]).out;
  const base = git(cwd, ['merge-base', sha, input.mainRef ?? 'origin/main']).out;
  const range = `${base}..${sha}`;

  const asked = commitsTouching(cwd, range, QUESTIONS_PATH);
  const questionsText = show(cwd, sha, QUESTIONS_PATH);
  if (asked.length === 0 || questionsText === undefined)
    return done([...missing, `${QUESTIONS_PATH}: not asked in this run`]);
  const { questions, missing: badQuestions } = checkQuestions(questionsText);
  missing.push(...badQuestions);
  if (asked.length > 1)
    missing.push(`${QUESTIONS_PATH}: changed in ${String(asked.length)} commits; ask in one batch`);

  const answered = commitsTouching(cwd, range, ANSWERS_PATH);
  const outputs = [BRIEF_PATH, BACKLOG_PATH].flatMap((p) => commitsTouching(cwd, range, p));
  const isAncestor = (a: string, b: string) => git(cwd, ['merge-base', '--is-ancestor', a, b]).ok;
  const firstAnswer = answered[0];
  if (firstAnswer === undefined) {
    if (outputs.length > 0)
      return done([...missing, `output written before the Owner's answers in ${ANSWERS_PATH}`]);
    // A valid stop: the Owner reads the questions in the draft pull request and answers.
    return done([...missing, ...(await prProblems(repo, sha, options))], true);
  }
  if (outputs.some((c) => !isAncestor(firstAnswer, c)))
    missing.push(`output written before the Owner's answers in ${ANSWERS_PATH}`);
  if (asked.some((c) => !isAncestor(c, firstAnswer)))
    missing.push(`${ANSWERS_PATH}: committed before the questions`);
  const answers = new Set(numbered(show(cwd, sha, ANSWERS_PATH) ?? '', 'A'));
  for (const q of questions)
    if (!answers.has(q)) missing.push(`${ANSWERS_PATH}: no answer to Q${String(q)}`);

  const brief = show(cwd, sha, BRIEF_PATH);
  if (brief === undefined) missing.push(`${BRIEF_PATH}: missing`);
  else
    missing.push(
      ...checkBrief(brief, questions, (p) => git(cwd, ['cat-file', '-e', `${sha}:${p}`]).ok),
    );
  missing.push(...skeletonProblems(cwd, sha));

  const listed = backlogIssues(show(cwd, sha, BACKLOG_PATH));
  const onMain = backlogIssues(show(cwd, base, BACKLOG_PATH));
  for (const n of onMain)
    if (!listed.includes(n)) missing.push(`backlog: drops seed issue #${String(n)} listed on main`);
  const fresh = listed.filter((n) => !onMain.includes(n));
  if (fresh.length < SEEDS_MIN || fresh.length > SEEDS_MAX)
    missing.push(`backlog: ${String(fresh.length)} new seed issues; Define files 5–10`);
  for (const n of fresh) missing.push(...(await seedProblems(repo, n, options)));

  missing.push(...(await prProblems(repo, sha, options)));
  return done(missing);
}

/** The stop hook's check: a Define session may stop when done or waiting for answers. */
export async function defineStopCheck(cwd: string): Promise<CheckResult> {
  const { repo } = await loadConfig(join(cwd, '.factory', 'config'));
  const result = await checkDefine({ workdir: cwd, repo });
  return result.waiting ? { complete: true } : result;
}
