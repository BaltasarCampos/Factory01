import { defineConfig } from 'vitest/config';

const setupFiles = ['tests/helpers/setup.ts'];

export default defineConfig({
  test: {
    // Vitest's default workers, on CI too: every core of the runner made build-test slower,
    // 10m48s to 13m35s (Owner decision 2026-11-11, T174).
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
