// The release's ESLint config for TypeScript projects (T141): `factory ci lint` passes it with
// --config, in a tree that holds the release's tsconfig.json and none of the project's configs.
// Nothing in the pull request can silence a rule: inline configuration is off, and so is every
// TypeScript comment that hides a type error (Owner decision 2026-10-10).
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig({
  files: ['src/**/*.{ts,mts,cts}', 'tests/**/*.{ts,mts,cts}'],
  extends: [tseslint.configs.strictTypeChecked],
  linterOptions: { noInlineConfig: true },
  languageOptions: {
    parserOptions: { project: './tsconfig.json', tsconfigRootDir: process.cwd() },
  },
  rules: {
    '@typescript-eslint/ban-ts-comment': [
      'error',
      { 'ts-expect-error': true, 'ts-ignore': true, 'ts-nocheck': true, 'ts-check': false },
    ],
  },
});
