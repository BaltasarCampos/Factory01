// `factory approve <issue|pr> [spec | waiver <waives>]` (contracts/cli.md, FR-016d, FR-016e):
// sign a record on the laptop, post it on the issue, then apply its `owner:` label. The record
// lives only in that comment: the dispatcher never copies it into `events.jsonl`, which is
// telemetry, and it verifies wherever it lives (Owner decision 2026-10-07). The approval summary
// (FR-043, AC-016) is shown first, read at the one commit the record signs, and nothing is signed
// while a required part is missing. Nothing is posted or labelled unless signing succeeds. Approving an item before main
// has the Owner-signed Define merge warns: the dispatcher admits nothing until then (AC-006).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mainKeys, secondCopy, type ReleaseKeys } from '../approvals/keys.js';
import { NonceLedger, nonceLedgerPath } from '../approvals/nonces.js';
import {
  extractFromComment,
  isCodeGateWaiver,
  newNonce,
  parse,
  RecordError,
  recordTimestamp,
  renderComment,
  serialise,
} from '../approvals/record.js';
import { ownerKeyPath, sign } from '../approvals/sign.js';
import { specBlobSha, verifyGate, verifySignature } from '../approvals/verify.js';
import type { CommandContext } from '../cli/commands.js';
import { briefMerged, verifiedMerges } from '../git/merges.js';
import { ExitCode, RefusedError, UsageError } from '../cli/env.js';
import { listComments, postComment } from '../github/comments.js';
import { Fields, gh, numberArg, repoArg } from '../github/gh.js';
import { addLabel, removeLabel } from '../github/labels.js';
import { viewPr } from '../github/prs.js';
import { timeline } from '../github/timeline.js';
import { itemBranch, slugify } from '../model/naming.js';
import type { ApprovalGate, ApprovalRecord, Tier } from '../model/types.js';
import { configOnMain } from '../model/config.js';
import { buildSummary, type SummaryFacts } from '../notify/summary.js';
import { projectHere } from './pause.js';

type Project = Awaited<ReturnType<typeof projectHere>>;
type RecordFields = Pick<ApprovalRecord, 'tier' | 'branch' | 'spec_sha' | 'waives' | 'head'>;
type Issue = SummaryFacts['issue'];

/** Sign a record, post it on its issue and claim its nonce in the laptop ledger. */
export async function postSigned(
  ctx: CommandContext,
  project: Project,
  record: ApprovalRecord,
): Promise<void> {
  const signed = sign(record, ownerKeyPath(project.home), {
    stdinIsTTY: ctx.stdinIsTTY,
    env: ctx.env,
  });
  const body = renderComment(record, signed);
  await postComment(project.repo, record.issue, body, project);
  const comments = await listComments(project.repo, record.issue, project);
  const posted = comments.findLast((c) => c.body.trim() === body.trim());
  if (posted === undefined)
    throw new RefusedError(`the record posted on #${String(record.issue)} could not be read back`);
  const ref = `${project.repo}#${String(record.issue)}/${posted.id}`;
  new NonceLedger(nonceLedgerPath(project.home)).claim(record.nonce, ref);
}

async function viewIssue(project: Project, issue: number) {
  const args = ['issue', 'view', numberArg(issue), '--repo', repoArg(project.repo)];
  const f = Fields.of(
    await gh([...args, '--json', 'title,body,labels'], { ...project, json: true }),
    'issue',
  );
  return {
    number: issue,
    title: f.str('title'),
    body: f.str('body'),
    labels: f.list('labels').map((l) => Fields.of(l, 'label').str('name')),
  };
}

function confirmedTier(option: unknown, labels: readonly string[], issue: number): Tier {
  if (option !== undefined) {
    if (typeof option !== 'string' || !/^[123]$/.test(option))
      throw new UsageError('--tier must be 1, 2 or 3');
    return Number(option) as Tier;
  }
  const proposed = labels.filter((l) => /^tier:[123]$/.test(l));
  const [only] = proposed;
  if (only === undefined || proposed.length > 1)
    throw new RefusedError(
      `#${String(issue)} has ${proposed.length === 0 ? 'no' : 'several'} proposed tier: labels; ` +
        'confirm the tier with --tier <1|2|3>',
    );
  return Number(only.slice('tier:'.length)) as Tier;
}

/** Tier and branch from the item's `approved` record, verified with main's pinned key lists. */
async function approvedRecord(
  project: Project,
  issue: number,
  keys: ReleaseKeys,
): Promise<{ tier: Tier; branch: string }> {
  const comments = await listComments(project.repo, issue, project);
  const labelAdds = (await timeline(project.repo, issue, project)).filter(
    (e) => e.event === 'labeled',
  );
  const verdict = verifyGate({
    keys,
    secondCopy: secondCopy(project.env ?? {}, project.home),
    expected: { repo: project.repo, issue, gate: 'approved' },
    comments,
    labelAdds,
    ledger: new NonceLedger(nonceLedgerPath(project.home)),
  });
  if (!verdict.ok)
    throw new RefusedError(
      `#${String(issue)} has no verified owner:approved (${verdict.reason}); approve the item first`,
    );
  const { tier, branch } = verdict.record;
  // The record format requires both for an approved record.
  if (tier === undefined || branch === undefined) throw new RefusedError('malformed approval');
  return { tier, branch };
}

/** Fetch the item branch from origin; the error text, or undefined once fetched. */
function fetchBranch(project: Project, branch: string): string | undefined {
  const fetched = spawnSync('git', ['-C', project.cwd, 'fetch', '-q', 'origin', branch], {
    env: project.env,
    encoding: 'utf8',
  });
  return fetched.status === 0 ? undefined : fetched.stderr.trim() || 'git fetch failed';
}

/** The item branch as read once: the commit it resolved to, and the feature files at it. */
interface BranchView {
  commit: string;
  files: NonNullable<SummaryFacts['files']>;
}

const git = (project: Project, args: readonly string[]) =>
  spawnSync('git', ['-C', project.cwd, ...args], { env: project.env, encoding: 'utf8' });

/**
 * Fetch the item branch once, resolve it to one commit, and read every summary file at that
 * commit, so what the Owner sees is what the record signs. The error text when it cannot.
 */
function readBranch(project: Project, branch: string): BranchView | string {
  const failed = fetchBranch(project, branch);
  if (failed !== undefined) return `cannot fetch ${branch}: ${failed}`;
  const rev = git(project, ['rev-parse', '--verify', `origin/${branch}^{commit}`]);
  if (rev.status !== 0) return `cannot resolve origin/${branch}`;
  const commit = rev.stdout.trim();
  const dir = `specs/${branch.slice('claude/'.length)}`;
  const show = (name: string) => {
    const r = git(project, ['show', `${commit}:${dir}/${name}`]);
    return r.status === 0 ? r.stdout : undefined;
  };
  return {
    commit,
    files: {
      spec: show('spec.md'),
      tasks: show('tasks.md'),
      verify: show('reports/verify.md'),
      events: show('events.jsonl'),
    },
  };
}

/**
 * The diff from the spec the Owner last approved for this item (a signed `spec-approved` record,
 * checked by signature alone since a changed spec makes it stale) to the one about to be signed.
 */
async function previousSpec(
  project: Project,
  issue: number,
  blob: string,
  keys: ReleaseKeys,
): Promise<SummaryFacts['previousSpec']> {
  const comments = await listComments(project.repo, issue, project);
  for (const comment of [...comments].reverse()) {
    let record: ApprovalRecord;
    try {
      const signed = extractFromComment(comment.body);
      record = parse(signed.text);
      if (record.gate !== 'spec-approved' || record.repo !== project.repo) continue;
      if (record.issue !== issue || !verifySignature(signed, keys, project.env)) continue;
    } catch {
      continue;
    }
    const old = record.spec_sha ?? '';
    if (old === blob) return { blob: old, diff: '' };
    const diff = git(project, ['diff', '--no-ext-diff', '--no-textconv', old, blob]);
    return { blob: old, diff: diff.status === 0 ? diff.stdout.replace(/\n$/, '') : undefined };
  }
  return undefined;
}

interface Gathered {
  fields: RecordFields;
  info: Issue;
  view?: BranchView;
  previous?: SummaryFacts['previousSpec'];
}

async function fieldsFor(
  ctx: CommandContext,
  project: Project,
  issue: number,
  gate: ApprovalGate,
  waives: string | undefined,
  keys: () => ReleaseKeys,
): Promise<Gathered> {
  const info = await viewIssue(project, issue);
  if (gate === 'approved') {
    const tier = confirmedTier(ctx.options.tier, info.labels, issue);
    return { fields: { tier, branch: itemBranch(issue, slugify(info.title)) }, info };
  }
  if (gate === 'spec-approved') {
    const { tier, branch } = await approvedRecord(project, issue, keys());
    const view = readBranch(project, branch);
    if (typeof view === 'string') throw new RefusedError(view);
    let spec_sha: string;
    try {
      spec_sha = specBlobSha(project.cwd, view.commit, `specs/${branch.slice('claude/'.length)}`);
    } catch (err) {
      throw new RefusedError(err instanceof Error ? err.message : String(err));
    }
    const previous = await previousSpec(project, issue, spec_sha, keys());
    return { fields: { tier, branch, spec_sha }, info, view, previous };
  }
  const target = waives ?? '';
  if (target.startsWith('test:'))
    throw new RefusedError(
      'test: waiver targets are not supported yet (T151); a weakened test blocks until then',
    );
  if (target.startsWith('check:') || target.startsWith('dep:'))
    throw new RefusedError(
      `waivers on pull requests (${target.split(':')[0] ?? ''}:) are not supported in this build yet`,
    );
  if (!target.startsWith('gate:')) return { fields: { waives: target }, info };
  const { tier, branch } = await approvedRecord(project, issue, keys());
  const view = readBranch(project, branch);
  if (!isCodeGateWaiver(target)) {
    const read = typeof view === 'string' ? {} : { view };
    return { fields: { tier, branch, waives: target }, info, ...read };
  }
  // A code-gate waiver binds the PR head; it must be the very commit the summary was read at.
  const head = (await viewPr(project.repo, branch, project)).headRefOid;
  if (typeof view === 'string' || view.commit !== head)
    throw new RefusedError(
      `PR head ${head.slice(0, 12)} is not the commit read from origin/${branch} (${typeof view === 'string' ? view : view.commit.slice(0, 12)}); fetch again and retry`,
    );
  return { fields: { tier, branch, waives: target, head }, info, view };
}

/** Warn while main has no Owner-signed `Factory-Merge: define`; never refuses. */
function warnBriefUnmerged(ctx: CommandContext, project: Project, keys: () => ReleaseKeys): void {
  let why: string;
  try {
    const keyLists = keys();
    const { baseline } = configOnMain(project.cwd);
    const env = project.env ?? process.env;
    if (briefMerged(verifiedMerges(project.cwd, keyLists, { baseline, env }))) return;
    why = 'main has no Owner-signed Factory-Merge: define';
  } catch (err) {
    why = `cannot tell whether the brief is merged (${err instanceof Error ? err.message : String(err)})`;
  }
  ctx.io.stderr.write(
    `warning: ${why}; the dispatcher admits no item until the Define pull request is merged\n`,
  );
}

const GATE_OF: Record<string, SummaryFacts['gate'] | undefined> = {
  spec: 'spec-approved',
  waiver: 'waiver',
};

export async function approve(ctx: CommandContext): Promise<number> {
  const [target = '', kind, waives] = ctx.positionals;
  if (!/^[1-9]\d*$/.test(target)) throw new UsageError(`not an issue or PR number: ${target}`);
  const issue = Number(target);
  const gate = kind === undefined ? 'approved' : GATE_OF[kind];
  if (gate === undefined) throw new UsageError(`expected spec or waiver, got ${kind ?? ''}`);
  if (gate === 'waiver' && waives === undefined)
    throw new UsageError('waiver needs a target, e.g. gate:coverage');
  if (gate !== 'waiver' && waives !== undefined)
    throw new UsageError(`unexpected argument: ${waives}`);
  if (gate !== 'approved' && ctx.options.tier !== undefined)
    throw new UsageError('--tier is confirmed only when approving the item itself');

  const project = await projectHere(ctx);
  // Main's pinned key lists, read once and only by the gates that verify a record.
  const scratch = mkdtempSync(join(tmpdir(), 'factory-keys-'));
  let keys: ReleaseKeys | undefined;
  const mainKeyLists = () => (keys ??= mainKeys(project.cwd, project.env ?? process.env, scratch));
  let gathered: Gathered;
  try {
    gathered = await fieldsFor(ctx, project, issue, gate, waives, mainKeyLists);
    if (gate === 'approved') warnBriefUnmerged(ctx, project, mainKeyLists);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const { fields, info, view, previous } = gathered;
  const summary = buildSummary({
    gate,
    issue: info,
    ...fields,
    commit: view?.commit,
    files: view?.files,
    previousSpec: previous,
  });
  if (!summary.ok)
    throw new RefusedError(
      `not signing: the approval summary is incomplete:\n  ${summary.missing.join('\n  ')}`,
    );
  ctx.io.stdout.write(`${summary.text}\n`);
  const record: ApprovalRecord = {
    repo: project.repo,
    issue,
    gate,
    ...fields,
    timestamp: recordTimestamp(ctx.now()),
    nonce: newNonce(),
  };
  let text: string;
  try {
    text = serialise(record);
  } catch (err) {
    if (err instanceof RecordError) throw new UsageError(err.message);
    throw err;
  }
  ctx.io.stdout.write(`Signing for ${project.repo}#${String(issue)}:\n\n${text}\n`);

  await postSigned(ctx, project, record);
  // A fresh label-add after the record, so the new record is the one backing the label.
  const label = `owner:${gate}`;
  if (info.labels.includes(label)) await removeLabel(project.repo, issue, label, project);
  await addLabel(project.repo, issue, label, project);
  ctx.io.stdout.write(`Applied ${label} to #${String(issue)}.\n`);
  return ExitCode.Ok;
}
