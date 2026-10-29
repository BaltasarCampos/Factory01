// The path guard (T085): whether a role's session may Write or Edit a file, from the role table
// and the station manifest, which the hook wiring reads (slice 28): never from the hook input,
// which the session controls. It fails closed. Only inside the clone, by the named path and by its
// real location, so a symlinked folder pointing outside is refused. Never `deny_write`, the
// guardrail files, the station manifest and the event logs, nor the relative `deny_read` patterns
// such as `.env*`, compared lower-cased. Then only the role's `write` patterns: `{feature}` is the
// item's feature folder, `{task}` the manifest's files, compared as written since a session's
// `tasks.md` lists them, and `{tests}` a new test file, by the installed release's patterns, never
// one the session's record lists as there at launch, so Test only adds tests. The Builder never writes
// `tasks.md`, which the dispatcher ticks (T174). Reasons go through `visible()`.
import { posix } from 'node:path';
import { visible } from '../notify/summary.js';
import { ROLES, type RoleName } from '../model/types.js';
import { isTestFile } from '../stations/edges.js';
import { absolute, inside, PathError, realPath } from './paths.js';
import { deniedWrites, matchesPath, type Policy } from './policy.js';

export type GuardDecision<Rule extends string> =
  { allowed: true } | { allowed: false; rule: Rule; reason: string };
export type PathRule = 'no-write' | 'unresolved' | 'outside' | 'protected' | 'not-writable';

export interface WriteInput {
  role: string;
  /** The tool input's `file_path`. */
  path: string;
  /** The hook input's `cwd`, the clone, and the home folder `~` stands for. */
  cwd: string;
  clone: string;
  home: string;
  /** From the station manifest: the item's feature folder, `specs/<issue>-<slug>`, and its files. */
  feature: string;
  files: string[];
  /** From the session's record: the test files the clone had at launch. */
  tests: readonly string[];
}

class Refused<Rule extends string> extends Error {
  constructor(
    readonly rule: Rule,
    why: string,
  ) {
    super(why);
  }
}

/** Runs `check`, turning a refusal or a path that cannot be resolved into a decision. */
export function decide<Rule extends string>(
  unresolved: Rule,
  check: (refuse: (rule: Rule, why: string) => never) => void,
): GuardDecision<Rule> {
  try {
    check((rule, why) => {
      throw new Refused(rule, why);
    });
    return { allowed: true };
  } catch (error) {
    if (error instanceof PathError)
      return { allowed: false, rule: unresolved, reason: visible(`refused: ${error.message}`) };
    if (!(error instanceof Refused)) throw error;
    return {
      allowed: false,
      rule: error.rule as Rule,
      reason: visible(`refused: ${error.message}`),
    };
  }
}

export function checkWrite(policy: Policy, input: WriteInput): GuardDecision<PathRule> {
  return decide<PathRule>('unresolved', (refuse) => {
    const role = input.role as RoleName;
    const row = (ROLES as readonly string[]).includes(input.role) ? policy.roles[role] : undefined;
    if (row === undefined || !row.tools.some((tool) => tool === 'Write' || tool === 'Edit'))
      return refuse('no-write', `the ${input.role} role writes no files`);
    const named = absolute(input.path, input.cwd, input.home);
    const paths = [inside(input.clone, named), inside(realPath(input.clone), realPath(named))];
    const [relative = '', real = ''] = paths;
    if (paths.some((path) => path === undefined))
      refuse('outside', `${input.path}: outside the repository; write only inside it`);
    const denied = deniedWrites(policy, role)
      .concat(policy.denyRead.filter((pattern) => !pattern.startsWith('~/')))
      .find((pattern) =>
        [relative, real].some((p) => matchesPath(pattern.toLowerCase(), p.toLowerCase())),
      );
    if (denied !== undefined) refuse('protected', `${relative}: no session writes it (${denied})`);
    const tasks = `${input.feature}/tasks.md`.toLowerCase();
    if (role === 'builder' && [relative, real].some((p) => p.toLowerCase() === tasks))
      refuse(
        'protected',
        `${relative}: the dispatcher ticks tasks.md; the Builder never writes it`,
      );
    const files = input.files.map((file) => posix.normalize(file).replace(/^\.\//, ''));
    const may = (path: string) =>
      row.write.some((pattern) =>
        pattern === '{task}'
          ? files.includes(path)
          : pattern === '{tests}'
            ? isTestFile(path) && !input.tests.includes(path)
            : matchesPath(pattern.replaceAll('{feature}', input.feature), path),
      );
    if (!may(relative) || !may(real))
      refuse(
        'not-writable',
        `${relative}: not a file the ${role} role writes; it writes ${row.write
          .join(', ')
          .replaceAll('{feature}', input.feature)
          .replaceAll('{task}', files.join(', ') || 'no task files')}`,
      );
  });
}
