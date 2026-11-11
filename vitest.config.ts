import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';

const setupFiles = ['tests/helpers/setup.ts'];

export default defineConfig({
  test: {
    // On CI every core of the runner: the suite's total work now sets build-test's time, and
    // Vitest's default leaves one core idle (Owner decision 2026-11-11, T174). The default
    // elsewhere, so the laptop keeps its own caps.
    ...(process.env.CI ? { maxWorkers: availableParallelism() } : {}),
    reporters: ['default', 'json'],
    outputFile: { json: 'coverage/vitest-results.json' },
    coverage: {
      provider: 'v8',
      reporter: ['lcov', 'json-summary', 'text-summary'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
    },
    projects: [
      { test: { name: 'unit', include: ['tests/unit/**/*.test.ts'], setupFiles } },
      { test: { name: 'property', include: ['tests/property/**/*.test.ts'], setupFiles } },
      { test: { name: 'contract', include: ['tests/contract/**/*.test.ts'], setupFiles } },
      { test: { name: 'integration', include: ['tests/integration/**/*.test.ts'], setupFiles } },
      { test: { name: 'e2e', include: ['tests/e2e/**/*.test.ts'], setupFiles, testTimeout: 0 } },
    ],
  },
});
