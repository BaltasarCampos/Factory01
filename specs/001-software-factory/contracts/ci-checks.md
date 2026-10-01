# Contract: CI workflows installed in every project

All are guardrail files under `.github/workflows/`, rendered from the TypeScript profile.

| Workflow / job | Trigger | Passes when | Spec |
|----------------|---------|-------------|------|
| `ci / build-test` | PR, push to `claude/**` | `npm ci --ignore-scripts`, build, lint, type check, Vitest (+ Playwright where present) green | QG-1, QG-4 |
| `ci / coverage` | PR | `factory ci coverage --min 90` on changed lines | QG-3 |
| `ci / ac-map` | PR | Every AC in the item spec has a passing test | QG-2 |
| `ci / size` | PR | Changed lines ≤ limit | QG-6 |
| `ci / formal` | PR touching `formal/**` or tier 3 | TLC / Dafny checks pass | QG-7 |
| `security / semgrep` | PR, weekly on main | No new findings | FR-049 |
| `security / npm-audit` | PR | No known-vulnerable deps at/above threshold | FR-049 |
| `security / gitleaks` | PR, weekly full history | No secrets | FR-049 |
| `security / licences` | PR changing deps | All licences on allowed list | FR-049 |
| `security / new-deps` | PR adding deps | Gate checks pass; job stays failed until signed Owner waiver for the dependency | FR-050, AC-045 |
| `guardrail-change` | PR | No protected path touched, or signed Owner waiver for this PR | FR-048, AC-020 |
| `append-only` | push to `claude/factory-log`, PR touching `events.jsonl` | No existing line edited or deleted | FR-028a, AC-065 |
| `owner-alert` | `workflow_dispatch` | Always fails, so GitHub emails the Owner | FR-034a, AC-075 |
| `review-trigger` | PR opened | (Routine/GitHub trigger) starts Reviewer session | FR-033, AC-031 |

The Release workflow of the **factory** repo additionally builds `guardrails.manifest.json`
and `allowed_signers` into each tag.
