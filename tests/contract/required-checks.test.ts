// The required jobs `factory merge` reads from the release (T068, slice 22a-3) are data, tied here
// to the workflow templates they name: every listed job exists with the listed `if:` and path
// filter, every job a pull request triggers is listed or exempt, and a job that runs only for an
// item is required only for items. No `if:` condition or path filter is interpreted at merge time.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { loadRequiredChecks, requiredJobs } from '../../src/merge/ci.js';

const FACTORY = join(import.meta.dirname, '..', '..', 'factory');
const LIST = loadRequiredChecks(
  readFileSync(join(FACTORY, 'profiles', 'typescript', 'ci', 'required-checks.json'), 'utf8'),
);
const ITEM_ONLY = "needs.item.outputs.issue != ''";

interface Workflow {
  on: { pull_request?: { paths?: string[] } | null };
  jobs: Record<string, { if?: string; name?: string }>;
}
const workflow = (path: string) => parse(readFileSync(join(FACTORY, path), 'utf8')) as Workflow;
const named = (path: string, job: string) => `${path}#${job}`;

describe('required-checks.json against the workflow templates (T068)', () => {
  it.each(LIST.jobs.map((j) => [named(j.workflow, j.job), j] as const))(
    '%s exists with the listed if: and path filter',
    (_, listed) => {
      const w = workflow(listed.workflow);
      expect(Object.keys(w.on)).toContain('pull_request');
      expect(w.jobs[listed.job]).toBeDefined();
      expect(w.jobs[listed.job]?.if ?? null).toBe(listed.if);
      // No name: of its own, so GitHub reports the job by its id, the name merge looks for.
      expect(w.jobs[listed.job]?.name).toBeUndefined();
      // Installed where factory new/adopt put it; the factory repository's own CI as factory-self.yml.
      expect(listed.installed).toBe(
        listed.workflow === 'self/ci.yml'
          ? '.github/workflows/factory-self.yml'
          : listed.workflow.replace(/^workflows\//, '.github/workflows/'),
      );
      expect(w.on.pull_request?.paths ?? null).toEqual(listed.paths ?? null);
      // A job that runs only for items is required only for items, and the other way round.
      expect(listed.if === ITEM_ONLY).toBe(listed.kinds.join() === 'item');
    },
  );

  it('lists or exempts every job a pull request triggers', () => {
    const accounted = new Set([...LIST.jobs, ...LIST.exempt].map((j) => named(j.workflow, j.job)));
    const paths = [
      ...['ci.yml', 'append-only.yml', 'security.yml'].map((f) => `workflows/${f}`),
      'self/ci.yml',
    ];
    const triggered = paths
      .filter((p) => 'pull_request' in workflow(p).on)
      .flatMap((p) => Object.keys(workflow(p).jobs).map((job) => named(p, job)));
    expect(triggered.filter((j) => !accounted.has(j))).toEqual([]);
  });

  it('requires append-only only when the pull request changes an events.jsonl', () => {
    const names = (kind: Parameters<typeof requiredJobs>[1], changed: string[]) =>
      requiredJobs(LIST, kind, changed).map((j) => j.job);
    expect(names('item', ['src/a.ts'])).not.toContain('append-only');
    expect(names('log', ['.factory/events/2026-10.jsonl'])).not.toContain('append-only');
    expect(names('item', ['specs/7-x/events.jsonl'])).toContain('append-only');
    expect(names('log', ['events.jsonl'])).toContain('append-only');
    expect(names('define', [])).toEqual([
      'build-test',
      'coverage',
      'weakened',
      'size',
      'semgrep',
      'gitleaks',
    ]);
  });

  it.each([
    ['a path pattern other than **/<file name>', { paths: ['specs/**'] }],
    ['an unknown branch kind', { kinds: ['release'] }],
    ['a job installed outside .github/workflows', { installed: 'ci.yml' }],
  ])('refuses a list with %s', (_, change) => {
    const [first] = LIST.jobs;
    const text = JSON.stringify({ ...LIST, jobs: [{ ...first, ...change }] });
    expect(() => loadRequiredChecks(text)).toThrow(/required-checks\.json/);
  });
});
