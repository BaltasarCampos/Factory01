# Implementation Plan: Software Factory v1

**Branch**: `001-software-factory` (work is currently on `main`; see Complexity Tracking) | **Date**: 2026-10-01 | **Spec**: [spec.md](spec.md)

**Work item**: none yet (source documents: "Software Factory — Design v1.8" `.specify/memory/design.md`, the source of truth, and `software-factory-spec-v1.8.txt`) | **Risk tier**: 3 | **Lane**: Full

**Input**: Feature specification from `specs/001-software-factory/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command; its definition describes the execution workflow.

## Summary

Build the factory repository: a TypeScript `factory` CLI plus the material it installs into
projects (role files, permission rules, hooks, CI workflows, Spec Kit templates, constitution,
TypeScript stack profile). The CLI has three faces:

1. **Laptop commands** for the Owner — `new`, `adopt`, `approve`, `merge`, `deploy`,
   `pause`, `resume`, `upgrade`, `inbox`, `keygen`, `config set`, `release`. `merge` is the
   only merge path: it computes its own checks and makes an Owner-signed merge commit.
2. **Dispatcher** — `factory dispatch` / `run`: a deterministic state machine over GitHub
   issue labels that verifies SSH-signed Owner records and main's signed history, derives
   pause state from label history, and launches one Claude Code session per station (cloud or
   local). Its decisions are advisory; the laptop checks decide.
3. **In-session enforcement** — `factory hook …` (path, read and command guards, logging,
   stop and session-start checks) and `factory mcp` (`advance_item`, `log_event`,
   `request_split`).

The critical property — nothing reaches main or the laptop without the Owner — is modelled in
TLA+ and checked in CI, and the TypeScript transition table is property-tested against the
same invariants. Enforcement does not rest on in-session hooks alone: every commit on main is
Owner-signed, releases are Owner-signed tags pinned by commit, CI runs only the pinned
release's tools, and `factory merge` re-checks every pull request on the laptop. Delivery
follows the source roadmap: Phase 0 (P1 stories, Gate A) first. Updated 2026-10-02 for spec
v1.6 (research R18–R20).

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 24 LTS, ESM ([research R1](research.md#r1-runtime-and-language-version))

**Primary Dependencies**: `gh` CLI, OpenSSH `ssh-keygen -Y`, Claude Code, GitHub Spec Kit
1.0.13 (external tools); npm: `@modelcontextprotocol/sdk`, `yaml` (runtime); `typescript`,
`vitest`, `@vitest/coverage-v8`, `fast-check`, `eslint`, `typescript-eslint`, `prettier`,
`@types/node` (dev). See New Dependencies.

**Storage**: No database. GitHub issues/labels/comments/PRs, repository files
(`events.jsonl`, `.factory/`, `claude/factory-log`), laptop `~/.factory/` (nonce ledger,
read alerts, Owner key, last verified main commit per repo) ([R15](research.md#r15-storage))

**Testing**: Vitest (unit, integration, contract), fast-check (property), TLA+/TLC (formal,
CI), scripted attack suite inside a routine (Phase 0, SC-002)

**Target Platform**: Owner's laptop (Crostini, 4 GB) for the CLI and Owner commands; Claude
Code cloud sessions and routines for the dispatcher and stations; GitHub-hosted runners for CI

**Project Type**: CLI + installable project template (single TypeScript package)

**Performance Goals**: A dispatcher pass completes in < 60 s of wall time excluding the
session it starts; hooks add < 300 ms per tool call (they run on every call)

**Constraints**: GBP 0 extra spend; Pro plan usage; one session at a time; laptop RAM 4 GB
(no local model, no long-running services besides the product); GitHub Free (no branch
protection on private repos); fail closed on every guard

**Scale/Scope**: One active project, 3–5 items/week, 12 roles, 9 stations, 90 acceptance
criteria; factory code re-estimated 2026-10-03 at ~30k changed lines including tests
(slices 1–2 measured; [reports/slice-estimates.md](reports/slice-estimates.md)) over ~44 work items

## Plan Usage Budget

| Item | Value |
|------|-------|
| Model sessions planned | Built interactively by the Owner with Claude Code (the factory cannot build itself before Phase 0 exists); per work item ≈ Spec+Plan 1 · Build 1–2 · Review 1–2 (tier 3: 2) |
| Estimated share of weekly plan limit | ~20–30% per week during Phase 0 build-out; re-measured in shadow mode |
| Models | Sonnet main, Opus advisor; no Fable |
| Parallel sessions | None |
| Estimated changed lines | ~30k total including tests → split into ~44 work items of < 1,000 lines during bootstrapping (see Delivery slices, Complexity Tracking #3) |

## New Dependencies

Each still passes the new-dependency gate and needs Owner approval before it lands; usage
and age figures are filled by the gate, not guessed here.

| Package | Version | Licence | Maintenance | Usage / age | Why not existing code or stdlib | Gate passed | Owner approval |
|---------|---------|---------|-------------|-------------|---------------------------------|-------------|----------------|
| typescript | 5.x exact | Apache-2.0 | Microsoft | gate | Required by the approved profile | pending | pending |
| @modelcontextprotocol/sdk | 1.x exact | MIT | Anthropic | gate | MCP protocol; hand-rolling it is riskier (R7) | pending | pending |
| yaml | 2.x exact | ISC | active | gate | `.factory/config` and role policy are YAML; no YAML in stdlib | pending | pending |
| vitest, @vitest/coverage-v8 | 3.x exact | MIT | active | gate | Profile test runner; lcov for changed-line coverage | pending | pending |
| fast-check | 3.x exact | MIT | active | gate | Property tests (tier 2–3, guard tokenizer, transitions) | pending | pending |
| eslint, typescript-eslint, prettier | exact | MIT | active | gate | Lint and format (QG-4, FR-021 post-edit hook) | pending | pending |
| @types/node | 24.x exact | MIT | DefinitelyTyped | gate | Node 24 typings for strict TypeScript; not shipped with Node | pending | pending |

External tools (not npm): `gh`, OpenSSH, TLA+ `tla2tools.jar` (MIT, CI only), Semgrep CE,
gitleaks, license-checker (profile CI only).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| # | Principle | Check | Status |
|---|-----------|-------|--------|
| I | Owner Holds Intent and the Keys | No scope beyond this spec (source design v1.8 / spec v1.8, with the clarifications of 2026-10-01, 2026-10-02 and 2026-10-05); every merge is an Owner-signed commit made on the laptop; open points (R5, R8, R9, R10, R4 spec-hash interpretation) raised as Phase 0 probes, not assumed; spec approved by the Owner on 2026-10-01 | ✅ |
| II | Spec-Driven Assembly Line | Spec exists; the whole factory is far above one slice → delivered as ~44 work items of < 1,000 lines | ⚠️ deviation (Complexity Tracking #1, #3) |
| III | Test-Gated Delivery | Every AC mapped below; ≥ 90% changed-line coverage enforced by `factory ci coverage`; property tests for guards and transitions; TLA+ model of critical property | ✅ |
| IV | Independent Agent Review | Each slice reviewed by a fresh session; two reviews (tier 3) | ✅ |
| V | Frugal by Design | No paid service; deps minimal; stdlib first (parseArgs, crypto, child_process, node:sqlite); one session at a time | ✅ |
| VI | Traceable and Observable Work | Event schema, hook logging, commit trailer `Factory-Role:` / `Factory-Item:`, health summaries | ✅ |
| VII | Bounded Autonomy and Safe Operations | This plan *creates* guardrail files in the factory repo (their source of truth), never in a project by an agent; secrets kept off sessions; fail-closed guards; rollback below | ⚠️ deviation (Complexity Tracking #2) |
| VIII | Fresh Context, File Hand-offs | Station manifest + feature-folder hand-offs; slices sized for one session | ✅ |
| IX | Learning Within Limits | No `.factory/lessons/` yet; Coach confined by path guard and CI | ✅ |
| — | Risk tier and lane | Tier 3, Full lane, matches spec | ✅ |

**Gate result**: passes; both recorded deviations approved by the Owner on 2026-10-01; no ❌.

**Post-design re-check (after Phase 1, repeated 2026-10-02)**: unchanged. The design adds no
gate relaxation; the dispatcher never moves an item on a label alone; every Owner-only action
requires a laptop TTY and a passphrase signature (a record, a signed commit or a signed tag);
in-session hooks are defence in depth, and the binding checks run on the laptop in
`factory merge` and `factory deploy`. Constitution v2.6.0 (2026-10-02) states the key list,
revocation, rotation-pending exception and signed main history, so the design and the
constitution agree.

**Re-check against constitution v2.7.0 (2026-10-05, design v1.8)**: passes; no gate is relaxed.
The spec now states admission by a signed `owner:approved` only and none before the brief is
merged (FR-016), `Factory-Merge:` trailers and the once-only merge (FR-007b, AC-088), a running
session as a warning (AC-088), per-gate approval summaries built by the CLI (FR-043,
AC-091–AC-096), criterion lines and the empty checked set (FR-042, AC-097), and per-test
waivers (AC-061, T151). Still to align, as tasks rather than deviations: test paths come from
the `include` minus `exclude` of the release's Vitest config (T140, T136 and ci-checks.md still
name `test-paths.json`); a test carrying several IDs counts for none (ac-map, red-green); changed
setup and helper files need a test waiver at merge (T058's detector, T068).

### Acceptance Criteria → Tests

Test files are under `tests/`; task IDs come from `tasks.md` (`/speckit-tasks`).

| Criteria (spec) | Test type | Test file | Task |
|-----------------|-----------|-----------|------|
| AC-001, AC-002, AC-003, AC-007 | integration (fake `gh`, temp git repos) | tests/integration/new-adopt.test.ts | tasks.md |
| AC-004, AC-005, AC-006, AC-056, AC-064 | integration + e2e on sample project | tests/integration/define.test.ts, tests/e2e/gate-a.test.ts | tasks.md |
| AC-008, AC-009, AC-055 | unit + integration (admission by approval only, dedup, Intake tier rule) | tests/unit/intake.test.ts, tests/integration/dispatcher-core.test.ts | T152 |
| AC-010, AC-011, AC-069 | unit + property (transitions) | tests/unit/transitions.test.ts, tests/property/transitions.prop.test.ts | tasks.md |
| AC-012, AC-066, AC-080 | integration (branch creation, manifest, guard) | tests/integration/branch.test.ts | tasks.md |
| AC-012, AC-089 | contract (red-green) | tests/contract/red-green.test.ts | T135 |
| AC-013, AC-042 | contract (CI checks) | tests/contract/ci-checks.test.ts | tasks.md |
| AC-014, AC-015, AC-073, AC-078, AC-081–AC-083, AC-086, AC-088 | integration (merge/deploy with fake `gh`, temp repos, real `ssh-keygen`) | tests/integration/merge-deploy.test.ts | T053 |
| AC-073, AC-087, AC-088 | integration (signed main history) | tests/integration/signed-history.test.ts | T134 |
| AC-081, AC-082 | contract (safe diff, append-only) | tests/contract/git-diff.test.ts, tests/contract/append-only.test.ts | T133, T052 |
| AC-083 | integration (release tags) | tests/integration/release.test.ts | T131 |
| AC-084, AC-085 | integration (rotation, revocation) | tests/integration/rotation.test.ts | T144 |
| AC-090 | integration (config set, session-start) | tests/integration/config-set.test.ts, tests/integration/session-start.test.ts | T137, T078 |
| FR-048, FR-049 (CI independent of the PR) | contract | tests/contract/ci-release-tools.test.ts | T136 |
| FR-037 (CI minutes) | integration | tests/integration/ops.test.ts | T108 |
| SC-009 (benchmark ≥ 5 items) | integration | tests/integration/benchmark.test.ts | T149 |
| FR-034 (daily product backup) | integration | tests/integration/backup.test.ts | T129 |
| AC-016, AC-017, AC-048, AC-091–AC-096 | unit + integration (per-gate summary, trace, events) | tests/unit/summary.test.ts, tests/unit/events.test.ts, tests/integration/approve-pause.test.ts, tests/integration/merge-deploy.test.ts | T054, T155, T053 |
| AC-097 | unit + contract (criterion lines, empty checked set) | tests/unit/station-checks.test.ts, tests/contract/ci-checks.test.ts, tests/contract/red-green.test.ts | T152, T051, T135 |
| AC-018, AC-019, AC-022, AC-067, AC-074 | unit + property (guards) + routine attack suite | tests/unit/guards.test.ts, tests/property/command-guard.prop.test.ts, tests/e2e/attack-suite.test.ts | tasks.md |
| AC-020, AC-021 | contract + integration | tests/contract/guardrail-change.test.ts, tests/integration/session-start.test.ts | tasks.md |
| AC-023 | e2e (injection fixtures) | tests/e2e/injection.test.ts | tasks.md |
| AC-024–AC-029 | unit + integration (lanes, tiers, waivers) | tests/unit/lanes.test.ts | tasks.md |
| AC-030–AC-039, AC-059 | integration (dispatcher with fake launcher/clock) | tests/integration/dispatcher.test.ts | tasks.md |
| AC-034, AC-076, AC-077 | unit + property (pause derivation) | tests/property/pause.prop.test.ts | tasks.md |
| AC-040–AC-045, AC-062 | integration + contract | tests/integration/security.test.ts, tests/contract/new-deps.test.ts | tasks.md |
| AC-046, AC-047, AC-060 | integration (ops, metrics) | tests/integration/ops.test.ts | tasks.md |
| AC-049–AC-053 | integration (coach, benchmark replay) | tests/integration/coach.test.ts | tasks.md |
| AC-054 | integration (upgrade) | tests/integration/upgrade.test.ts | tasks.md |
| AC-057, AC-058, AC-061, AC-063 | unit (split, conflict routing, flaky, stop hook) | tests/unit/station-edges.test.ts | tasks.md |
| AC-065 | contract (append-only) | tests/contract/append-only.test.ts | tasks.md |
| AC-068, AC-070, AC-071, AC-072, AC-079 | unit + property (records) + real `ssh-keygen` | tests/unit/approvals.test.ts, tests/property/records.prop.test.ts | tasks.md |
| AC-075 | integration (notify) + Phase 0 manual probe | tests/integration/notify.test.ts | tasks.md |
| Critical property | formal | formal/Dispatcher.tla, formal/Dispatcher.cfg | tasks.md |

### Rollback Path

- **Feature flag**: Not applicable to the factory (spec Risks). Kill switch: `pause:line`.
- **Rollback steps**: Projects pin a signed release as `<tag>@<sha>`; roll back by
  `factory upgrade <previous-tag>` (an Owner-approved PR merged with `factory merge`). Within the factory repo, each slice is one PR revertable with
  `git revert -m 1 <merge>`. Role files are versioned; reverting one is one commit.
- **Tier 3**: Written rollback test — `tests/e2e/upgrade-rollback.test.ts` upgrades the
  sample project to a broken tag, then pins back and checks the guardrail manifest matches
  the previous release and the dispatcher resumes.

## Project Structure

### Documentation (this feature)

```text
specs/001-software-factory/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── cli.md
│   ├── mcp-tools.md
│   ├── hooks.md
│   ├── approval-record.md
│   └── ci-checks.md
├── tasks.md              # /speckit-tasks
└── reports/
```

### Source Code (repository root)

```text
src/
├── cli/                  # entry point, sub-command table (parseArgs), laptop-only checks
├── commands/             # new, adopt, run, dispatch, approve, merge, deploy, pause,
│                         # resume, upgrade, inbox, keygen, config, release, benchmark, ci,
│                         # hook, mcp
├── dispatcher/           # transitions.ts (pure table), dispatch.ts, launcher/{cloud,local}.ts,
│                         # history-audit.ts, rotation.ts, branch.ts, evidence.ts
├── approvals/            # record.ts (canonical format), sign.ts, verify.ts, nonces.ts, keys.ts
├── git/                  # diff.ts (safe diff), sign.ts (signed commits), history.ts (signed main)
├── merge/                # rules.ts (per-branch checks), local-merge.ts
├── release/              # tag.ts (signed release tags)
├── stations/             # checks/ (per-station output checks), edges.ts
├── security/, ops/, coach/  # Phase 1–3 modules (US6–US8)
├── pause/                # derive.ts (label-history → pause state)
├── guard/                # policy.ts (from roles.yaml), tokenizer.ts, path-guard.ts,
│                         # command-guard.ts, read-guard.ts
├── hooks/                # session-start, post-edit, log, stop, pre-compact
├── mcp/                  # server.ts, tools/{advance-item,log-event,request-split}.ts
├── github/               # gh.ts wrapper, labels, timeline, comments, PRs
├── events/               # schema, append, redact
├── notify/               # inbox, owner-alert
├── ci/                   # test, lint, scan, coverage, red-green, size, ac-map, append-only,
│                         # guardrail-change, new-deps
├── install/              # render templates, guardrail manifest, labels, inbox issue
└── model/                # shared types (data-model.md)

factory/                  # material installed into projects (source of truth for guardrails)
├── roles/                # 12 role files → .claude/agents/<role>.md
├── policy/roles.yaml     # per-role permission table (generates settings.json + guard policy)
├── settings/             # .claude/settings.json template (deny rules, hooks, advisorModel)
├── workflows/            # .github/workflows/*.yml templates
├── speckit/              # Spec Kit template overrides
├── constitution.md       # installed as .specify/memory/constitution.md
├── prompts/              # station prompts 0–8
└── profiles/typescript/  # walking skeleton, tool settings, ci/ (CI configs, thresholds,
                          # test-path patterns used only by `factory ci`)

formal/                   # Dispatcher.tla, Dispatcher.cfg (TLC in CI)
allowed_signers           # every Owner public key ever used (release artifact)
revoked_keys              # compromised Owner keys (release artifact)
docs/                     # operator docs, routine setup, rollback
scripts/                  # tlc.sh

tests/
├── unit/
├── property/
├── contract/
├── integration/          # fake gh (PATH shim), temp git repos, fake launcher, real ssh-keygen
└── e2e/                  # sample-project runs (Phase 0, manual trigger in CI)
```

**Structure Decision**: Single TypeScript package. `src/` is the CLI; `factory/` is the
installable material that becomes guardrail files in projects. Keeping both in one repo
lets one release tag pin code and guardrails together, which the integrity check relies on.

### Delivery slices (each one work item, < 1,000 changed lines during bootstrapping, own PR)

Re-cut 2026-10-03 for the 1,000-line bootstrapping limit (Complexity Tracking #3); slice
numbers are kept and split slices take a letter, so earlier references stay valid. The
task-level mapping is in tasks.md § Incremental Delivery; size estimates are in
[reports/slice-estimates.md](reports/slice-estimates.md).

Phase 0 (P1, Gate A), 35 slices (2 done): 1 repo skeleton + CI (done) · 2 types, config, CLI shell
(done) · 3a record format + signing · 3b record verification · 4 pause derivation + TLA+
model · 5 transition table · 6a `gh` wrapper + GitHub helpers · 6b Owner inbox · 7 events +
hook entry · 8 dispatcher core · 9 `approve`/`pause`/`resume` · 10 `factory release` + tag
verification · 11a install steps (manifest, render, labels, inbox) · 11b `new`/`adopt` ·
12 Define + profile skeleton · 13 factory copies · 14 station checks · 15 summary, trace, edge
rules · 15b admission by approval, criterion lines, `resume` summary · 16a item branch, draft PR, evidence · 16b launchers, `dispatch`/`run` · 17 MCP server · 18a safe diff + append-only ·
18b coverage, size, ac-map · 19a red-green · 19b release-shipped CI + workflows · 20 signed
main history + `config set` · 21 merge rules · 21b `test:` waivers · 22 `factory merge` · 23 `factory deploy` +
backups · 24 role files + station prompts · 25a role policy + settings · 25b tokenizer ·
25c guards · 27 `guardrail-change` · 28 session-start + guard hooks · 29 Gate A e2e +
injection + attack suite. Phase 1–2 (P2): 30 lanes/tiers/batch · 31a findings + gates ·
31b new-deps gate + security workflows · 32a retry, limits, pause enforcement · 32b launcher
fallback, review trigger. Phase 3 (P3): 33 ops/metrics · 34 coach + benchmark · 35 upgrade ·
36 key rotation.

## Complexity Tracking

| Deviation | Principle | Why Needed | Simpler Alternative Rejected Because | Owner approval |
|-----------|-----------|------------|-------------------------------------|----------------|
| One spec covers the whole factory (8–11k lines), above the 400-line slice | II | The spec is the v1 system definition; it is delivered as ~36 slices, each its own PR under the limit | Re-specifying each slice as a separate spec now would duplicate the cross-cutting requirements (signatures, pause, guards) that must stay consistent | Approved by the Owner, 2026-10-01 (chat) |
| The factory is built outside its own line: no issue, no `claude/<issue>-<slug>` branch, no signed approvals, work currently on `main`; guardrail files are authored here by an agent session | VII, II | Bootstrapping: the guards, dispatcher and signing do not exist until Phase 0 ships. Mitigation: every slice is a PR the Owner merges locally with a signed merge commit (`git merge --no-ff -S`) until `factory merge` exists, so main's history is signed from the start; guardrail sources live under `factory/` (not this repo's live `.claude/`); once Gate A passes, the factory repo adopts itself (`factory adopt`) and further work goes through the line | Waiting for a line that cannot exist yet is impossible; hand-writing everything without agents defeats the goal | Approved by the Owner, 2026-10-01 (chat) |
| Bootstrapping slices of the factory repository may change up to 1,000 lines, above the 400-line target of FR-038 / SC-007. Slices 1 (1,346 lines) and 2 (1,446 lines) were merged before this limit and are recorded here as accepted over-limit slices; slice 7 (1,116 lines: 516 source, 600 tests) was accepted over the limit by the Owner on 2026-10-04, and slice 15 (1,146 lines: 558 source, 588 tests) on 2026-10-05; slice 15's fix-up from the Owner's review is its own pull request stacked on slice 15, merged back to back with it: estimated ~700, measured 1,068 lines (546 source, 522 tests), plus 196 lines of the byte-for-byte constitution 2.7.0 copy (T042): 1,264 lines, accepted over the limit by the Owner on 2026-10-06 once the fixes from the Owner's second review were in; those fixes add 337 lines (287 added, 50 removed) and the third review's 213 (127 added, 86 removed), so the fix-up PR totals about 1,814, accepted by the Owner on 2026-10-06; slice 16a (split from slice 16, which measured ~1,440) measured 882 lines and 1,104 once the tests asked for in the Owner's review were in (evidence and manifest branch coverage), accepted over the limit by the Owner on 2026-10-07. From 2026-10-07 slices are planned at about 750 estimated lines, since estimates have run about 30% under actual and review fixes add more | II | Slices 1–2 measured 2.4× the plan's estimate: the tasks require one test per rule and tests count toward size, so the factory is ~30k changed lines, not 8–11k. At 400 lines Phase 0 needs ~65 slices (13–22 weeks); at 1,000 it needs ~33. Applies only to this repository until it adopts itself after Gate A; projects keep the release's 400-line limit, which `factory ci size` enforces and this deviation does not change | Keeping 400 roughly doubles review sessions and plan usage; counting test lines at a discount is not allowed by the spec; a slice near 1,000 lines may exceed the 30-minute review target, so the Owner may ask for any slice to be split | Approved by the Owner, 2026-10-03 (chat) |
