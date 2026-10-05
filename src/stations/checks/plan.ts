// Plan output check (AC-011; data-model.md § State machine, spec-approved → planned):
// `plan.md` estimates its changed lines within the size limit and its Constitution Check has no
// failing row; in `tasks.md` every task lists the files it may touch, every acceptance criterion
// of the spec maps to a test task, and in every phase the test tasks come before the
// implementation tasks. A test task is one under a `### Tests …` heading, as in the template.
import type { CheckResult } from '../../hooks/stop.js';
import { parseConfig } from '../../model/config.js';
import { committed, featureFiles } from './feature.js';
import { checkSpec } from './spec.js';

export interface PlanInput {
  spec: string;
  plan: string;
  tasks: string;
  /** Main's `size_limit_lines`: the release's limit or lower. */
  sizeLimit: number;
}

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
  return missing;
}

interface Task {
  id: string;
  text: string;
  test: boolean;
  phase: number;
}

function parseTasks(tasks: string): Task[] {
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

export function checkPlan(input: PlanInput): CheckResult & { missing: string[] } {
  const missing = planProblems(input.plan, input.sizeLimit);
  const tasks = parseTasks(input.tasks);
  if (tasks.length === 0) missing.push('tasks.md: no tasks');

  const lastImpl = new Map<number, string>();
  const tested = new Set<string>();
  for (const t of tasks) {
    if (!/·\s*Files:\s*\S/.test(t.text)) missing.push(`tasks.md: ${t.id} has no · Files: list`);
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
  return { complete: missing.length === 0, missing };
}

/** The stop hook's check for Plan, against the size limit in the committed project config. */
export function planStopCheck(cwd: string): CheckResult {
  const files = featureFiles(cwd, ['spec.md', 'plan.md', 'tasks.md']);
  const { 'spec.md': spec, 'plan.md': plan, 'tasks.md': tasks } = files.text;
  if (spec === undefined || plan === undefined || tasks === undefined)
    return { complete: false, missing: files.missing };
  const config = parseConfig(committed(cwd, '.factory/config') ?? '');
  return checkPlan({ spec, plan, tasks, sizeLimit: config.size_limit_lines });
}
