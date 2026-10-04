// Issue labels. Adding or removing one is a timeline event; gates and pauses are read from that
// history (src/github/timeline.ts), not from the labels themselves.
import { asList, Fields, gh, labelArg, numberArg, repoArg, type GhOptions } from './gh.js';

export interface LabelSpec {
  name: string;
  /** Six hex digits, no `#`. */
  color: string;
  description: string;
}

export async function addLabel(
  repo: string,
  issue: number,
  label: string,
  options: GhOptions = {},
): Promise<void> {
  await editLabels(repo, issue, '--add-label', label, options);
}

export async function removeLabel(
  repo: string,
  issue: number,
  label: string,
  options: GhOptions = {},
): Promise<void> {
  await editLabels(repo, issue, '--remove-label', label, options);
}

async function editLabels(
  repo: string,
  issue: number,
  flag: '--add-label' | '--remove-label',
  label: string,
  options: GhOptions,
): Promise<void> {
  const args = ['issue', 'edit', numberArg(issue), '--repo', repoArg(repo), flag, labelArg(label)];
  await gh(args, options);
}

/** Create the labels the repository lacks; returns their names. Existing ones are left alone. */
export async function ensureLabels(
  repo: string,
  labels: readonly LabelSpec[],
  options: GhOptions = {},
): Promise<string[]> {
  const listArgs = ['label', 'list', '--repo', repoArg(repo), '--json', 'name', '--limit', '1000'];
  const existing = new Set(
    asList(await gh(listArgs, { ...options, json: true }), 'labels').map((l) =>
      Fields.of(l, 'label').str('name'),
    ),
  );
  const created: string[] = [];
  for (const label of labels) {
    if (existing.has(label.name)) continue;
    const args = ['label', 'create', labelArg(label.name), '--repo', repo];
    await gh([...args, '--color', label.color, '--description', label.description], options);
    existing.add(label.name);
    created.push(label.name);
  }
  return created;
}
