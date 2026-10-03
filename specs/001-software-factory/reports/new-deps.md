# New-dependency gate — slice 1 (T002)

**Date**: 2026-10-02 · **Owner approval**: 2026-10-02 (chat, "Approve all")

Installed with `npm install --ignore-scripts --save-exact`; `.npmrc` sets `ignore-scripts=true`
and `save-exact=true`. Versions are the newest release within the major named in plan.md
§ New Dependencies, read from the npm registry on the gate date.

| Package | Version | Kind | Exists | Near-name of a popular package | First published | Weekly downloads | Licence | Gate |
|---------|---------|------|--------|--------------------------------|-----------------|------------------|---------|------|
| @modelcontextprotocol/sdk | 1.32.0 | runtime | yes | no (canonical name) | 2024-11-11 | 70,197,758 | MIT | pass |
| yaml | 2.9.1 | runtime | yes | no (canonical name) | 2011-04-15 | 253,931,049 | ISC | pass |
| typescript | 5.9.3 | dev | yes | no (canonical name) | 2012-10-01 | 348,005,389 | Apache-2.0 | pass |
| vitest | 3.2.7 | dev | yes | no (canonical name) | 2021-12-03 | 132,365,337 | MIT | pass |
| @vitest/coverage-v8 | 3.2.7 | dev | yes | no (canonical name) | 2023-06-06 | 48,207,779 | MIT | pass |
| fast-check | 3.23.2 | dev | yes | no (canonical name) | 2017-12-28 | 56,081,839 | MIT | pass |
| eslint | 9.39.5 | dev | yes | no (canonical name) | 2013-07-04 | 190,282,295 | MIT | pass |
| typescript-eslint | 8.71.0 | dev | yes | no (canonical name) | 2019-08-13 | 106,996,180 | MIT | pass |
| prettier | 3.9.9 | dev | yes | no (canonical name) | 2017-01-10 | 162,586,725 | MIT | pass |
| @types/node | 24.19.1 | dev | yes | no (canonical name) | 2016-05-17 | 525,862,422 | MIT | pass |

## Audit

- `npm audit --omit=dev`: 0 vulnerabilities in runtime dependencies.
- `npm audit` (all): 1 moderate advisory in `@vitest/mocker` (transitive, dev only, range
  2.1.0–4.1.10). The fix requires a Vitest major upgrade beyond the 3.x pinned by plan.md;
  not applied. It does not ship in the CLI. Revisit when the plan moves Vitest to a new major.

## Notes

- Newer majors exist (TypeScript 7, Vitest 5, fast-check 4, ESLint 10). plan.md pins the
  majors above; moving to them is a plan change for the Owner.
