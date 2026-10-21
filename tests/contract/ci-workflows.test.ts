// Contract tests for the project's CI workflow templates (T066's checklist, T136, FR-048,
// FR-049): ci.yml, append-only.yml and security.yml as the renderer installs them. Every job builds
// the factory CLI at the pinned commit and calls only `factory ci <check>`; each command is parsed
// by the CLI itself, so a renamed flag fails here rather than in a project's CI. The workflows'
// own shell scripts run here against test repositories and a fake `gh`.
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { runCli } from '../../src/cli/commands.js';
import { renderTree } from '../../src/install/render.js';
import { gitEnv, makeRepo } from '../helpers/git-repo.js';
import { tempDir } from '../helpers/keys.js';

interface Step {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  with?: Record<string, string | number | boolean>;
  run?: string;
  env?: Record<string, string>;
}
interface Job {
  'runs-on'?: string;
  if?: string;
  needs?: string;
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  steps: Step[];
}
interface Workflow {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  env: Record<string, string>;
  jobs: Record<string, Job>;
}

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NAMES = ['ci', 'append-only', 'security'] as const;

/** The workflows as `factory new` installs them under `.github/workflows/`. */
function rendered() {
  const release = tempDir('factory-release-');
  cpSync(join(ROOT, 'factory', 'workflows'), join(release, 'workflows'), { recursive: true });
  mkdirSync(join(release, 'settings'));
  writeFileSync(join(release, 'settings', 'settings.json'), '{}\n');
  writeFileSync(join(release, 'constitution.md'), '# Constitution\n');
  const tree = renderTree(release, {});
  const text = Object.fromEntries(
    NAMES.map((n) => [n, tree.get(`.github/workflows/${n}.yml`)?.toString('utf8') ?? '']),
  );
  const flows = Object.fromEntries(NAMES.map((n) => [n, parse(text[n] ?? '') as Workflow]));
  const all = [...tree].filter(([path]) => path.startsWith('.github/workflows/'));
  return { text, flows, all: all.map(([, bytes]) => bytes.toString('utf8')) };
}
const { text: TEXT, flows: FLOWS, all: ALL } = rendered();
const flow = (name: (typeof NAMES)[number]) => FLOWS[name] as Workflow;
const job = (name: (typeof NAMES)[number], id: string) => flow(name).jobs[id] as Job;
const allJobs = NAMES.flatMap((n) => Object.entries(flow(n).jobs).map(([id, j]) => ({ n, id, j })));
const allSteps = allJobs.flatMap(({ n, id, j }) => j.steps.map((s) => ({ n, id, s })));

/** The `factory ci …` lines of a job's scripts. */
const commands = (j: Job) =>
  j.steps
    .flatMap((s) => (s.run ?? '').split('\n').map((l) => l.trim()))
    .filter((l) => l.startsWith('factory ci '));

const SAMPLE = {
  BASE_SHA: 'a'.repeat(40),
  HEAD_SHA: 'b'.repeat(40),
  HEAD_REF: 'claude/42-add-login',
  BEFORE: 'c'.repeat(40),
  AFTER: 'd'.repeat(40),
  TIER: '2',
};

/** A `factory ci` line as bash expands it: the arguments `factory` would get. */
function expand(line: string, env: Record<string, string> = SAMPLE): string[] {
  const r = spawnSync('bash', ['-c', `factory() { printf '%s\\0' "$@"; }\n${line}`], {
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf8',
  });
  expect(r.status).toBe(0);
  return r.stdout.split('\0').slice(0, -1);
}

/** Runs one of the workflows' scripts as Actions does (`shell: bash`), with GITHUB_OUTPUT. */
function script(run: string, cwd: string, env: NodeJS.ProcessEnv) {
  const out = join(tempDir('factory-output-'), 'output');
  writeFileSync(out, '');
  const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', run], {
    cwd,
    env: { ...gitEnv, ...env, GITHUB_OUTPUT: out },
    encoding: 'utf8',
  });
  const outputs = Object.fromEntries(
    readFileSync(out, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
  return { status: r.status, stderr: r.stderr, outputs };
}

const stepNamed = (j: Job, pattern: RegExp) => j.steps.findIndex((s) => pattern.test(s.name ?? ''));
/** Why a job's `runs-on` is not pinned: a `-latest` label moves to a new OS image unannounced. */
const runnerProblem = (runsOn: string | undefined) =>
  runsOn !== undefined && /^[a-z]+-\d+(?:\.\d+)*(?:-arm)?$/.test(runsOn)
    ? undefined
    : `runs-on ${String(runsOn)} is not an explicit runner version`;
/**
 * Why a setup-node step may cache on its own: it does whenever the workspace's package.json names
 * npm as its package manager, unless the step sets `cache:` or `package-manager-cache: false`.
 */
const cacheProblem = (s: Step) =>
  s.with?.cache !== undefined || s.with?.['package-manager-cache'] === false
    ? undefined
    : `${s.name ?? s.uses ?? 'a setup-node step'} sets neither cache: nor package-manager-cache: false`;
const isCheckout = (s: Step) => s.uses?.startsWith('actions/checkout@') === true;

describe('project CI workflow templates (T066)', () => {
  it('(1) every job that calls factory ci checks out the factory at the pinned SHA, builds the CLI from it, installs with npm ci --ignore-scripts and runs nothing through npm', () => {
    for (const n of NAMES) expect(flow(n).env.FACTORY_REPO).toMatch(/^[\w.-]+\/[\w.-]+$/);
    const checking = allJobs.filter(({ j }) => commands(j).length > 0);
    expect(checking.map(({ n, id }) => `${n}/${id}`).sort()).toEqual(
      [
        'append-only/append-only',
        ...['build-test', 'coverage', 'ac-map', 'red-green', 'weakened', 'size'].map(
          (id) => `ci/${id}`,
        ),
        'security/gitleaks',
        'security/semgrep',
        'security/npm-audit',
        'security/licences',
      ].sort(),
    );
    for (const { j } of checking) {
      const pin = stepNamed(j, /^Pinned factory commit$/);
      const factory = j.steps.findIndex((s) => isCheckout(s) && s.with?.path === 'factory');
      const cli = stepNamed(j, /^Build the factory CLI$/);
      const first = j.steps.findIndex((s) => s.run?.includes('factory ci ') === true);
      expect([pin >= 0, pin < factory, factory < cli, cli < first]).toEqual([
        true,
        true,
        true,
        true,
      ]);
      expect(j.steps[factory]?.with).toMatchObject({
        repository: '${{ env.FACTORY_REPO }}',
        ref: '${{ steps.pin.outputs.sha }}',
      });
    }
    // The shared steps are written out in each job; every copy is the same.
    const shared = ['Check out the head', 'Check out the factory at the pinned commit'];
    for (const name of [...shared, 'Pinned factory commit', 'Build the factory CLI'])
      expect(
        new Set(allSteps.filter(({ s }) => s.name === name).map(({ s }) => JSON.stringify(s))).size,
      ).toBe(1);
    for (const { s } of allSteps)
      for (const line of (s.run ?? '').split('\n')) {
        // npm runs only to install the factory, and to install itself at the pinned version (T169).
        expect(line).not.toMatch(
          /\b(?:npx|yarn|pnpm)\b|\bnpm (?!ci --ignore-scripts$|install -g --ignore-scripts "npm@\$NPM_VERSION"$|--version$)/,
        );
        expect(line).not.toMatch(/^\s*node (?!node_modules\/typescript\/bin\/tsc -p \.$)/);
      }
  });

  it('(2) the pin is main’s, or the pull request’s own on factory/upgrade-*, and always a full SHA', () => {
    const pins = allSteps
      .filter(({ s }) => s.name === 'Pinned factory commit')
      .map(({ s }) => s.run);
    expect(new Set(pins).size).toBe(1);
    const run = pins[0] ?? '';
    const main = '1'.repeat(40);
    const pr = '2'.repeat(40);
    const config = (sha: string) => `factory_release: v1.0.0@${sha}\nrepo: owner/project\n`;
    const repo = makeRepo({ files: { '.factory/config': config(main) } });
    repo.checkout('claude/42-add-login', { create: true });
    const head = repo.commit({ '.factory/config': config(pr) }, 'change the pin');

    const pin = (ref: string) => script(run, repo.path, { HEAD_REF: ref, HEAD_SHA: head });

    expect(pin('claude/42-add-login').outputs).toEqual({ sha: main });
    expect(pin('claude/factory-log').outputs).toEqual({ sha: main });
    expect(pin('claude/7-factory/upgrade-v1.1.0').outputs).toEqual({ sha: main });
    expect(pin('factory/upgrade-v1.1.0').outputs).toEqual({ sha: pr });
    repo.commit({ '.factory/config': 'factory_release: v1.1.0\n' }, 'a tag alone');
    const bare = script(run, repo.path, {
      HEAD_REF: 'factory/upgrade-v1.1.0',
      HEAD_SHA: repo.revParse('HEAD'),
    });
    expect(bare.status).not.toBe(0);
    expect(bare.stderr).toContain('no factory_release pin');
  });

  it('(3) every checkout of the project fetches the full history, append-only’s included', () => {
    const project = allSteps.filter(({ s }) => isCheckout(s) && s.with?.path === 'project');
    expect(project.map(({ n, id }) => `${n}/${id}`)).toContain('append-only/append-only');
    for (const { s } of project) expect(s.with?.['fetch-depth']).toBe(0);
  });

  it('(4) ac-map and red-green pass --branch and the tier label, which only selects the CI rule', () => {
    const run = job('ci', 'item').steps[0]?.run ?? '';
    const bin = tempDir('factory-gh-');
    writeFileSync(
      join(bin, 'gh'),
      `#!/bin/sh\n[ "$*" = "issue view 42 --repo owner/project --json labels --jq .labels[].name" ] || exit 9\nprintf '%s' "$FAKE_LABELS"\n`,
    );
    chmodSync(join(bin, 'gh'), 0o755);
    const tier = (labels: string) =>
      script(run, bin, {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HEAD_REF: 'claude/42-add-login',
        GITHUB_REPOSITORY: 'owner/project',
        FAKE_LABELS: labels,
      }).outputs;

    expect(tier('type:feature\ntier:2\n')).toEqual({ issue: '42', tier: '2' });
    expect(tier('type:feature\n')).toEqual({ issue: '42', tier: '' });
    expect(tier('tier:1\ntier:3\n')).toEqual({ issue: '42', tier: '' });
    expect(tier('tier:4\n')).toEqual({ issue: '42', tier: '' });
    for (const id of ['ac-map', 'red-green']) {
      const j = job('ci', id);
      expect(j.env?.TIER).toBe('${{ needs.item.outputs.tier }}');
      const line = commands(j).find((l) => l.startsWith(`factory ci ${id} `)) ?? '';
      expect(expand(line)).toEqual(expect.arrayContaining(['--branch', SAMPLE.HEAD_REF]));
      expect(expand(line).join(' ')).toContain('--tier 2');
      expect(expand(line, { ...SAMPLE, TIER: '' })).not.toContain('--tier');
    }
  });

  it('(5) coverage and ac-map delete coverage/ before running the tests for their reports', () => {
    for (const id of ['coverage', 'ac-map']) {
      const lines = job('ci', id).steps.flatMap((s) =>
        (s.run ?? '').split('\n').map((l) => l.trim()),
      );
      const rm = lines.indexOf('rm -rf coverage');
      const test = lines.findIndex((l) => l.startsWith('factory ci test '));
      const check = lines.findIndex((l) => l.startsWith(`factory ci ${id} `));
      expect([rm >= 0, rm < test, test < check]).toEqual([true, true, true]);
    }
  });

  it('(6) a weakened job runs factory ci weakened on every pull request', () => {
    const j = job('ci', 'weakened');
    expect(j.if).toBe("github.event_name == 'pull_request'");
    expect(commands(j)).toEqual([
      'factory ci weakened "$BASE_SHA" "$HEAD_SHA" --install node_modules',
    ]);
  });

  it('(7) ac-map and red-green run only on a claude/<issue>-<slug> head branch', () => {
    const run = job('ci', 'item').steps[0]?.run ?? '';
    for (const id of ['ac-map', 'red-green']) {
      expect(job('ci', id)).toMatchObject({ needs: 'item', if: "needs.item.outputs.issue != ''" });
    }
    const outputs = (ref: string) => script(run, ROOT, { HEAD_REF: ref, PATH: '/usr/bin:/bin' });
    for (const ref of ['claude/define', 'claude/factory-log', 'factory/upgrade-v1.1.0', 'main'])
      expect(outputs(ref)).toMatchObject({ status: 0, outputs: {} });
    expect(outputs('claude/42-x; touch pwned')).toMatchObject({ status: 0, outputs: {} });
  });

  it('(8) append-only runs with --push on claude/factory-log and with the base, the head and --branch on a pull request', () => {
    const w = flow('append-only');
    expect(w.on).toEqual({
      push: { branches: ['claude/factory-log'] },
      pull_request: { paths: ['**/events.jsonl'] },
    });
    const steps = job('append-only', 'append-only').steps.filter((s) =>
      s.run?.startsWith('factory'),
    );
    expect(steps.map((s) => [s.if, s.run?.trim()])).toEqual([
      [
        "github.event_name == 'push'",
        'factory ci append-only "$BEFORE" "$AFTER" --branch claude/factory-log --push',
      ],
      [
        "github.event_name == 'pull_request'",
        'factory ci append-only "$BASE_SHA" "$HEAD_SHA" --branch "$HEAD_REF"',
      ],
    ]);
    expect(steps[0]?.env).toEqual({
      BEFORE: '${{ github.event.before }}',
      AFTER: '${{ github.event.after }}',
    });
  });

  it('(9) jobs get contents: read and no secrets; only the item job, which checks out nothing, reads issues; no pull_request_target; inputs reach scripts through env', () => {
    for (const n of NAMES) {
      expect(flow(n).permissions).toEqual({ contents: 'read' });
      expect(Object.keys(flow(n).on)).not.toContain('pull_request_target');
      expect(TEXT[n]).not.toMatch(/secrets\./);
    }
    for (const { n, id, j } of allJobs)
      if (`${n}/${id}` !== 'ci/item') expect(j.permissions).toBeUndefined();
    const item = job('ci', 'item');
    expect(item.permissions).toEqual({ issues: 'read' });
    expect(item.steps.some((s) => s.uses !== undefined)).toBe(false);
    expect(
      Object.values(TEXT)
        .join('')
        .match(/github\.token/g),
    ).toHaveLength(1);
    for (const { s } of allSteps) expect(s.run ?? '').not.toContain('${{');
  });

  it('(10) the factory’s own CI installs the pinned semgrep and gitleaks before its tests, which then require them; security.yml installs the same, without bubblewrap', () => {
    const pins = JSON.parse(
      readFileSync(join(ROOT, 'factory', 'profiles', 'typescript', 'ci', 'tools.json'), 'utf8'),
    ) as { semgrep: string; gitleaks: string; npm: string };
    const self = parse(readFileSync(join(ROOT, 'factory', 'self', 'ci.yml'), 'utf8')) as Workflow;
    for (const w of [self, flow('security')])
      expect(w.env).toMatchObject({
        SEMGREP_VERSION: pins.semgrep,
        GITLEAKS_VERSION: pins.gitleaks,
        GITLEAKS_SHA256: self.env.GITLEAKS_SHA256,
      });
    expect(self.env.GITLEAKS_SHA256).toMatch(/^[0-9a-f]{64}$/);
    const steps = (self.jobs['build-test'] as Job).steps;
    const install = stepNamed({ steps }, /^Install semgrep and gitleaks/);
    const test = steps.findIndex((s) => s.run === 'npm test');
    expect([install >= 0, install < test]).toEqual([true, true]);
    expect(JSON.stringify(steps.slice(install))).not.toMatch(/"CI"/);
    const runs = [self, flow('security')].flatMap((w) =>
      Object.values(w.jobs).flatMap((j) => j.steps.map((s) => s.run ?? '')),
    );
    expect(runs.filter((r) => r.includes('pipx install "semgrep==$SEMGREP_VERSION"'))).toHaveLength(
      2,
    );
    const checked = '"$GITLEAKS_SHA256  gitleaks.tar.gz" | sha256sum -c -';
    expect(runs.filter((r) => r.includes(checked))).toHaveLength(2);
    // The audit's npm is pinned too (T169); only security.yml runs it.
    expect(flow('security').env.NPM_VERSION).toBe(pins.npm);
    const npm = stepNamed(job('security', 'npm-audit'), /^Install npm \(pinned\)$/);
    const audit = stepNamed(job('security', 'npm-audit'), /^npm audit$/);
    expect([npm >= 0, npm < audit]).toEqual([true, true]);
    for (const n of NAMES) expect(TEXT[n]).not.toContain('bubblewrap');
  });

  it('(11) every checkout, the project’s and the factory’s, leaves no credentials behind', () => {
    const checkouts = allSteps.filter(({ s }) => isCheckout(s));
    expect(checkouts.length).toBeGreaterThanOrEqual(18);
    for (const { s } of checkouts) expect(s.with?.['persist-credentials']).toBe(false);
  });

  it('(12) every action, in the rendered workflows and in the factory’s own CI, is pinned to a full commit SHA', () => {
    const self = readFileSync(join(ROOT, 'factory', 'self', 'ci.yml'), 'utf8');
    const pinned = /^\s*(?:- )?uses: [\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/;
    for (const text of [...ALL, self]) {
      const uses = text.split('\n').filter((l) => /^\s*(?:- )?uses:/.test(l));
      for (const line of uses) expect(line).toMatch(pinned);
      const steps = Object.values((parse(text) as Workflow).jobs).flatMap((j) => j.steps);
      expect(uses).toHaveLength(steps.filter((s) => s.uses !== undefined).length);
    }
    expect(ALL.length).toBeGreaterThanOrEqual(4);
    for (const loose of [
      '      - uses: actions/checkout@v7',
      '      - uses: actions/checkout@3d3c42e # v7.0.1',
      `      - uses: actions/checkout@${'a'.repeat(40)}`,
    ])
      expect(loose).not.toMatch(pinned);
  });

  it('(13) every job, in the rendered workflows and in the factory’s own CI, runs on an explicit runner version, never a moving label', () => {
    const self = readFileSync(join(ROOT, 'factory', 'self', 'ci.yml'), 'utf8');
    for (const text of [...ALL, self]) {
      const jobs = Object.values((parse(text) as Workflow).jobs);
      expect(jobs.length).toBeGreaterThan(0);
      for (const j of jobs) expect(runnerProblem(j['runs-on'])).toBeUndefined();
    }
    expect(runnerProblem('ubuntu-24.04')).toBeUndefined();
    for (const moving of ['ubuntu-latest', 'ubuntu-24.04-latest', '${{ matrix.os }}', undefined])
      expect(runnerProblem(moving)).toMatch(/not an explicit runner version/);
  });

  it('(14) every setup-node step either names its cache or turns automatic caching off, in the rendered workflows and in the factory’s own CI', () => {
    const self = readFileSync(join(ROOT, 'factory', 'self', 'ci.yml'), 'utf8');
    const steps = [...ALL, self].flatMap((text) =>
      Object.values((parse(text) as Workflow).jobs).flatMap((j) => j.steps),
    );
    const setups = steps.filter((s) => s.uses?.startsWith('actions/setup-node@') === true);
    expect(setups.length).toBeGreaterThanOrEqual(13);
    for (const s of setups) expect(cacheProblem(s)).toBeUndefined();
    expect(cacheProblem({ uses: 'actions/setup-node@x', with: { cache: 'npm' } })).toBeUndefined();
    for (const loose of [{ 'node-version': 24 }, { 'package-manager-cache': true }, undefined])
      expect(
        cacheProblem({ uses: 'actions/setup-node@x', ...(loose ? { with: loose } : {}) }),
      ).toMatch(/neither cache: nor package-manager-cache: false/);
  });

  it('every factory ci command parses as the CLI defines it: no usage error, no unimplemented check', async () => {
    const run = async (args: string[]) => {
      const out: string[] = [];
      const code = await runCli(args, {
        stdout: { write: (s: string) => void out.push(s) },
        stderr: { write: (s: string) => void out.push(s) },
        // Not a repository: a command that parses refuses at its first git call.
        env: { ...gitEnv, GITHUB_ACTIONS: 'true' },
        stdinIsTTY: false,
        cwd: tempDir('factory-nowhere-'),
        unreadAlerts: () => Promise.reject(new Error('ci must not read the inbox')),
      });
      return { code, output: out.join('') };
    };
    const lines = allJobs.flatMap(({ j }) => commands(j));
    const checks = lines.map((l) => {
      const [, check = '', tool = ''] = expand(l);
      return check === 'scan' ? `scan ${tool}` : check;
    });
    expect(new Set(checks)).toEqual(
      new Set([
        ...['lint', 'test', 'coverage', 'ac-map', 'red-green', 'weakened', 'size', 'append-only'],
        ...['scan semgrep', 'scan gitleaks', 'scan markers', 'scan audit', 'licences'],
      ]),
    );
    for (const line of lines) {
      const r = await run(expand(line));
      expect({ line, ...r }).toMatchObject({ line, code: 1 });
      expect(r.output).not.toMatch(/usage|not implemented/i);
    }
    // The same harness catches a renamed flag.
    expect(await run(expand(lines[0]?.replace('--install', '--installs') ?? ''))).toMatchObject({
      code: 2,
    });
  });
});
