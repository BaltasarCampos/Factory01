// `factory ci lint` (T141, contracts/ci-checks.md, QG-4): the factory's own ESLint with the
// release's config, its type-aware rules on the release's tsconfig, on a tree written from raw
// blobs without the project's configs or ignore files. Inline configuration is off, so every
// message counts, its own warning about an `eslint-disable` comment included. The profile takes
// TypeScript only, without JSX: a JavaScript or `.tsx` file would escape lint and the type check
// (beside a hand-written `.d.ts`), so each is a finding (Owner decision 2026-10-10).
import { join, relative } from 'node:path';
import { RefusedError } from '../cli/env.js';
import { TEST_CONFIG } from '../stations/edges.js';
import { factoryRoot } from './sandbox.js';
import { RELEASE_CI, writeTsconfig } from './test.js';
import { inWorkspace, type Isolation } from './vitest-run.js';

const NOT_TYPESCRIPT = /\.(?:js|mjs|cjs|jsx|tsx)$/;
/** Outside the install and the build output, which lint leaves alone. */
const linted = (path: string) => !/(?:^|\/)node_modules\//.test(path) && !path.startsWith('dist/');

interface EslintFile {
  filePath: string;
  messages: { line?: number; ruleId: string | null; message: string }[];
}

export function lintHead(
  repo: string,
  head: string,
  options: { isolation: Isolation; env: NodeJS.ProcessEnv },
): { findings: string[]; files: number } {
  return inWorkspace(repo, head, { ...options, config: TEST_CONFIG }, (ws) => {
    const written = ws.write('head', head);
    const tree = ws.tree('head');
    writeTsconfig(tree);
    const eslint = ws.run('head', [
      process.execPath,
      join(factoryRoot(), 'node_modules', 'eslint', 'bin', 'eslint.js'),
      ...['--config', join(RELEASE_CI, 'eslint.config.mjs')],
      ...['--format', 'json', '--no-error-on-unmatched-pattern', '.'],
    ]);
    // ESLint exits 1 for lint messages and 2 when it could not lint.
    if (eslint.status !== 0 && eslint.status !== 1)
      throw new RefusedError(
        `eslint failed: ${(eslint.stderr || eslint.stdout).trim().slice(-2000)}`,
      );
    const files = JSON.parse(eslint.stdout) as EslintFile[];
    const other = written.filter((p) => linted(p) && NOT_TYPESCRIPT.test(p));
    const findings = other.map((p) => `${p}: the TypeScript profile takes TypeScript only`);
    findings.push(
      ...files.flatMap((file) =>
        file.messages.map(
          (m) =>
            `${relative(tree, file.filePath)}:${String(m.line ?? 0)}: ${m.ruleId ?? 'eslint'} ${m.message}`,
        ),
      ),
    );
    return { findings, files: files.length };
  });
}
