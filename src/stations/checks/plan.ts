// Plan output check (AC-011; data-model.md § State machine, spec-approved → planned):
// `plan.md` estimates its changed lines within the size limit and its Constitution Check has no
// failing row; in `tasks.md` every task lists the files it may touch, each a plain path, since
// they become the Build session's Edit rules (T061), every acceptance criterion
// of the spec maps to a test task, and in every phase the test tasks come before the
// implementation tasks. A test task is one under a `### Tests …` heading, as in the template.
// Plan's own questions wait for the Owner as the spec's do (T180). As the template has them,
// `## Clarifications` holds a question or is deleted, and `## Assumptions` is there (T173).
import type { CheckResult } from '../../hooks/stop.js';
import { parseConfig } from '../../model/config.js';
import { isPlainPath } from '../../model/naming.js';
import { committed, featureFiles } from './feature.js';
import { questionsIn } from './questions.js';
import { checkSpec, committedAnswers, section, withQuestions } from './spec.js';

export interface PlanInput {
  spec: string;
  plan: string;
  tasks: string;
  /** Main's `size_limit_lines`: the release's limit or lower. */
  sizeLimit: number;
  /** The Owner's `answers.md`; without it no applied answer is the Owner's. */
  answers?: ReadonlyMap<number, string>;
}

/** The template's own placeholder line, refused by its exact text so a bracketed default passes. */
const ASSUMPTION_PLACEHOLDER = '- [The default taken, and why it is low-impact]';

function planProblems(plan: string, sizeLimit: number): string[] {
  const missing: string[] = [];
  const cell = /^\|\s*Estimated changed lines\s*\|([^|\n]*)\|/im.exec(plan)?.[1]?.trim() ?? '';
  const estimate = /^\[.*\]$/.test(cell) ? undefined : /\d[\d,]*/.exec(cell)?.[0];
  if (estimate === undefined) missing.push('plan.md: no estimated changed lines');
  else {
    const lines = Number(estimate.replace(/,/g, ''));
    if (lines > sizeLimit)
      missing.push(
        `plan.md: estimates ${String(lines)} changed lines; the limit is ${String(sizeLimit)}; split the work item`,
      );
  }
  const check = /^## Constitution Check\b[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(plan);
  if (!check) missing.push('plan.md: no Constitution Check');
  else if ((check[1] ?? '').includes('❌'))
    missing.push('plan.md: Constitution Check has a failing row (❌)');
  const lines = plan.split('\n');
  if (section(lines, 'Clarifications') !== undefined && questionsIn(plan, 'plan.md').length === 0)
    missing.push('plan.md: ## Clarifications has no question; delete it when Plan asks nothing');
  const assumptions = section(lines, 'Assumptions')
    ?.join('\n')
    .replace(/<!--[\s\S]*?-->/g, '');
  if (assumptions === undefined)
    missing.push('plan.md: no ## Assumptions; write None when Plan took no default');
  else if (assumptions.trim() === '')
    missing.push('plan.md: ## Assumptions is empty; write None when Plan took no default');
  else if (assumptions.split('\n').some((l) => l.trim() === ASSUMPTION_PLACEHOLDER))
    missing.push("plan.md: ## Assumptions still holds the template's placeholder");
  return missing;
}

export interface Task {
  id: string;
  text: string;
  test: boolean;
  phase: number;
}

export function parseTasks(tasks: string): Task[] {
  const parsed: Task[] = [];
  let phase = 0;
  let test = false;
  for (const line of tasks.split('\n')) {
    if (/^## /.test(line)) {
      phase += 1;
      test = false;
    } else if (/^### /.test(line)) test = /^###\s+Tests\b/i.test(line);
    const m = /^\s*- \[[ xX]\] (T\d+)\b(.*)$/.exec(line);
    if (m) parsed.push({ id: m[1] ?? '', text: m[2] ?? '', test, phase });
  }
  return parsed;
}

/** The paths of a task's `· Files:` list, its parenthesised notes dropped. */
export function taskFiles(text: string): string[] {
  const list = /·\s*Files:(.*)$/.exec(text)?.[1] ?? '';
  return list
    .replace(/\([^)]*\)/g, '')
    .split(',')
    .map((f) => f.trim().replace(/^`|`$/g, ''))
    .filter((f) => f !== '');
}

export function checkPlan(input: PlanInput): CheckResult & { missing: string[] } {
  const missing = planProblems(input.plan, input.sizeLimit);
  const tasks = parseTasks(input.tasks);
  if (tasks.length === 0) missing.push('tasks.md: no tasks');

  const lastImpl = new Map<number, string>();
  const tested = new Set<string>();
  for (const t of tasks) {
    if (!/·\s*Files:\s*\S/.test(t.text)) missing.push(`tasks.md: ${t.id} has no · Files: list`);
    for (const file of taskFiles(t.text).filter((f) => !isPlainPath(f)))
      missing.push(
        `tasks.md: ${t.id} lists ${JSON.stringify(file)}, not a plain path in the repository`,
      );
    if (!t.test) {
      lastImpl.set(t.phase, t.id);
      continue;
    }
    const before = lastImpl.get(t.phase);
    if (before !== undefined)
      missing.push(`tasks.md: ${t.id} is a test task after implementation task ${before}`);
    for (const [ac] of t.text.matchAll(/AC-\d+/g)) tested.add(ac);
  }
  for (const ac of checkSpec(input.spec).acs)
    if (!tested.has(ac)) missing.push(`tasks.md: ${ac} has no test task`);
  // Plan's questions are numbered on from the spec's, so one answers.md serves both (T180).
  const last = Math.max(0, ...questionsIn(input.spec, 'spec.md').map((q) => q.n));
  for (const q of questionsIn(input.plan, 'plan.md'))
    if (q.n <= last)
      missing.push(
        `plan.md: Q${String(q.n)} is numbered within spec.md's questions; number on from Q${String(last + 1)}`,
      );
  const asked = withQuestions(input.plan, 'plan.md', missing, input.answers ?? new Map());
  return { ...asked, complete: asked.missing.length === 0 };
}

/** The stop hook's check for Plan, against the size limit in the committed project config. */
export function planStopCheck(cwd: string): CheckResult {
  const files = featureFiles(cwd, ['spec.md', 'plan.md', 'tasks.md']);
  const { 'spec.md': spec, 'plan.md': plan, 'tasks.md': tasks } = files.text;
  if (spec === undefined || plan === undefined || tasks === undefined)
    return { complete: false, missing: files.missing };
  const config = parseConfig(committed(cwd, '.factory/config') ?? '');
  const answers = committedAnswers(cwd);
  return checkPlan({ spec, plan, tasks, sizeLimit: config.size_limit_lines, answers });
}
