# Contract: CI workflows installed in every project

All are guardrail files under `.github/workflows/`, rendered from the TypeScript profile.

**What CI can and cannot prove.** A `pull_request` run uses the workflow files of the pull
request itself, so CI results count only after `factory merge` has confirmed on the laptop
that no protected file changed (data-model § Pull request merge checks). Even then, the
PR's code runs inside CI, so every job is built to depend on nothing the PR controls:

- Each workflow checks out the **factory repository at the pinned commit** (`<sha>` from main's
  `.factory/config`, not the PR's) and builds the `factory` CLI from it; dependency installs
  use `npm ci --ignore-scripts`. **Exception:** for an upgrade PR (head
  `factory/upgrade-<tag>`), workflows build the CLI from the PR's own pin, because the new
  release's workflows may call checks the old CLI lacks. This is safe because CI results count
  only after `factory merge` has verified the tag's signature and that the PR equals the
  release manifest. An item PR cannot use this path: `factory merge` accepts items only from
  `claude/<issue>-<slug>` and refuses any config change from them.
- Jobs call `factory ci <check>`, never `npm test` or other `package.json` scripts, and use the
  configs, thresholds and test-path patterns shipped in that release
  (`factory/profiles/typescript/ci/`), never the project's own configs.
- Every diff is the safe diff (`safeDiff`): changed files from
  `git diff-tree -r -z --no-renames <base> <head>`; lines from blob-to-blob
  `git diff --text --no-ext-diff --no-textconv`; file types and append-only on the raw blob
  bytes. A plain `git diff`, even with `core.attributesFile=/dev/null`, still applies the pull
  request's `.gitattributes` from the working tree. Every git call runs without the global and
  system config (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`) and without any inherited `GIT_*` variable,
  with `--no-color`,
  `--diff-algorithm=myers` and an explicit `-U`.

What remains: test files are PR code. A test can assert nothing, or fail at the base for an
irrelevant reason, and still count. Test code runs with the job's permissions, so it can also
reach and rewrite the results files the checks read (accepted, 2026-10-09). The independent
review is the control for test quality (spec Risks).

| Workflow / job | Trigger | Passes when | Spec |
|----------------|---------|-------------|------|
| `ci / build-test` | PR, push to `claude/**` | `factory ci test` (build, type check, Vitest with the release's config) and `factory ci lint` green | QG-1, QG-4 |
| `ci / coverage` | PR | `factory ci coverage` ≥ the stricter of the release's floor and `coverage_min` in main's config, on changed lines | QG-3 |
| `ci / red-green` | PR | Every checked acceptance criterion (below) has at least one test tagged with its `AC-###` that fails against the code at the merge base and passes at the head (for a changed test, its head version is run against the base code). Skipped when the diff touches only the release's test code (`paths` in `test-paths.json`), apart from the item's own feature folder and `.specify/feature.json`. A tagged test is red at the base when it fails or its file fails to load, never when skipped; it must pass at the head. A refactor passes only with a verified `gate:red-green` waiver whose `head` is the current head | FR-042, AC-012, AC-089 |
| `ci / ac-map` | PR | Every checked acceptance criterion has a passing tagged test | QG-2 |
| `ci / size` | PR | Changed lines ≤ the stricter of the release's limit and `size_limit_lines` in main's config | QG-6 |
| `ci / formal` | PR touching `formal/**` or tier 3 | TLC / Dafny checks pass | QG-7 |
| `security / semgrep` | PR, weekly on main | `factory ci scan semgrep` with the release's rules: no new findings | FR-049 |
| `security / npm-audit` | PR | No known-vulnerable deps at/above threshold | FR-049 |
| `security / gitleaks` | PR, weekly full history | `factory ci scan gitleaks` with the release's config: no secrets | FR-049 |
| `security / licences` | PR changing deps | All licences on the release's allowed list | FR-049 |
| `security / new-deps` | PR adding deps | Gate checks pass; job stays failed until a signed Owner waiver for the dependency | FR-050, AC-045 |
| `guardrail-change` | PR | Item and Define PRs: no protected path, `.gitattributes`, `.gitmodules` or `.factory/config` touched (no waiver can allow it). Upgrade PRs: protected set equals the manifest of the signed release named in the PR | FR-048, AC-020, AC-086 |
| `append-only` | push to `claude/factory-log`, PR touching `events.jsonl` | No existing line edited or deleted; new lines only at the end of existing files; on `claude/factory-log`, every path under the allowed log paths and only regular text files | FR-028a, AC-065, AC-081, AC-082 |
| `owner-alert` | `workflow_dispatch` | Always fails, so GitHub emails the Owner | FR-034a, AC-075 |
| `review-trigger` | PR opened | (Routine/GitHub trigger) starts Reviewer session | FR-033, AC-031 |

**Checked acceptance criteria** (red-green and ac-map). Tier 2–3: the `AC-###` IDs in the
`spec.md` whose blob hash the verified `spec-approved` record names. Tier 1 (no spec approval):
every `AC-###` ID that ever appeared in `spec.md` in any commit on the branch, so an agent
cannot pass the checks by deleting criteria; removing one needs a `gate:ac-<id>` waiver.
An empty checked set fails both checks, and so does a criterion line without an ID (FR-042,
AC-097). Criterion lines are found by the one parser in `src/stations/checks/spec.ts`, which
the Specify check, ac-map and red-green share: every list item under Acceptance Scenarios or
Edge Cases, and elsewhere each line with two or more of Given/When/Then or any one in bold.
`factory merge` repeats both checks.

`guardrail-change` and `append-only` give early feedback only; `factory merge` repeats both
checks on the laptop and trusts only its own result.

The release workflow of the **factory** repo only attaches `guardrails.manifest.json`,
`allowed_signers` and `revoked_keys` to a tag the Owner has already signed with
`factory release`; CI never creates or signs a tag.
