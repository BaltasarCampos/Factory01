# Implementation Plan: Software Factory v1

**Branch**: `001-software-factory` (work is currently on `master`; see Complexity Tracking) | **Date**: 2026-10-01 | **Spec**: [spec.md](spec.md)

**Work item**: none yet (source document `software-factory-spec-v1.5.txt`) | **Risk tier**: 3 | **Lane**: Full

**Input**: Feature specification from `specs/001-software-factory/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command; its definition describes the execution workflow.

## Summary

Build the factory repository: a TypeScript `factory` CLI plus the material it installs into
projects (role files, permission rules, hooks, CI workflows, Spec Kit templates, constitution,
TypeScript stack profile). The CLI has three faces:

1. **Laptop commands** for the Owner — `new`, `adopt`, `approve`, `merge`, `deploy`,
   `pause`, `resume`, `upgrade`, `inbox`, `keygen`.
2. **Dispatcher** — `factory dispatch` / `run`: a deterministic state machine over GitHub
   issue labels that verifies SSH-signed Owner records, derives pause state from label
   history, and launches one Claude Code session per station (cloud or local).
3. **In-session enforcement** — `factory hook …` (path, read and command guards, logging,
   stop and session-start checks) and `factory mcp` (`advance_item`, `log_event`,
   `request_split`).

The critical property — nothing reaches main or the laptop without the Owner — is modelled in
TLA+ and checked in CI, and the TypeScript transition table is property-tested against the
same invariants. Delivery follows the source roadmap: Phase 0 (P1 stories, Gate A) first.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 24 LTS, ESM ([research R1](research.md#r1-runtime-and-language-version))

**Primary Dependencies**: `gh` CLI, OpenSSH `ssh-keygen -Y`, Claude Code, GitHub Spec Kit
1.0.13 (external tools); npm: `@modelcontextprotocol/sdk`, `yaml` (runtime); `typescript`,
`vitest`, `@vitest/coverage-v8`, `fast-check`, `eslint`, `typescript-eslint`, `prettier`
(dev). See New Dependencies.

**Storage**: No database. GitHub issues/labels/comments/PRs, repository files
(`events.jsonl`, `.factory/`, `claude/factory-log`), laptop `~/.factory/` (nonce ledger,
read alerts, approval key) ([R15](research.md#r15-storage))

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

**Scale/Scope**: One active project, 3–5 items/week, 12 roles, 9 stations, ~80 acceptance
criteria; factory code estimated 6–9k lines over ~22 work items

## Plan Usage Budget

| Item | Value |
|------|-------|
| Model sessions planned | Built interactively by the Owner with Claude Code (the factory cannot build itself before Phase 0 exists); per work item ≈ Spec+Plan 1 · Build 1–2 · Review 1–2 (tier 3: 2) |
| Estimated share of weekly plan limit | ~20–30% per week during Phase 0 build-out; re-measured in shadow mode |
| Models | Sonnet main, Opus advisor; no Fable |
| Parallel sessions | None |
| Estimated changed lines | 6–9k total → split into ~22 work items of < 400 lines (see Delivery slices) |

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

External tools (not npm): `gh`, OpenSSH, TLA+ `tla2tools.jar` (MIT, CI only), Semgrep CE,
gitleaks, license-checker (profile CI only).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| # | Principle | Check | Status |
|---|-----------|-------|--------|
| I | Owner Holds Intent and the Keys | No scope beyond spec v1.5 + clarifications; open points (R5, R8, R9, R10, R4 spec-hash interpretation) raised as Phase 0 probes, not assumed; spec approved by the Owner on 2026-10-01 | ✅ |
| II | Spec-Driven Assembly Line | Spec exists; the whole factory is far above one slice → delivered as ~22 work items | ⚠️ deviation (Complexity Tracking #1) |
| III | Test-Gated Delivery | Every AC mapped below; ≥ 90% changed-line coverage enforced by `factory ci coverage`; property tests for guards and transitions; TLA+ model of critical property | ✅ |
| IV | Independent Agent Review | Each slice reviewed by a fresh session; two reviews (tier 3) | ✅ |
| V | Frugal by Design | No paid service; deps minimal; stdlib first (parseArgs, crypto, child_process, node:sqlite); one session at a time | ✅ |
| VI | Traceable and Observable Work | Event schema, hook logging, commit trailer `Factory-Role:` / `Factory-Item:`, health summaries | ✅ |
| VII | Bounded Autonomy and Safe Operations | This plan *creates* guardrail files in the factory repo (their source of truth), never in a project by an agent; secrets kept off sessions; fail-closed guards; rollback below | ⚠️ deviation (Complexity Tracking #2) |
| VIII | Fresh Context, File Hand-offs | Station manifest + feature-folder hand-offs; slices sized for one session | ✅ |
| IX | Learning Within Limits | No `.factory/lessons/` yet; Coach confined by path guard and CI | ✅ |
| — | Risk tier and lane | Tier 3, Full lane, matches spec | ✅ |

**Gate result**: passes; both recorded deviations approved by the Owner on 2026-10-01; no ❌.

**Post-design re-check (after Phase 1)**: unchanged. The design adds no gate relaxation; the
dispatcher never moves an item on a label alone; every Owner-only action requires a laptop
TTY and a passphrase-signed record; CI duplicates every in-session guard.

### Acceptance Criteria → Tests

Test files are under `tests/`; task IDs come from `tasks.md` (`/speckit-tasks`).

| Criteria (spec) | Test type | Test file | Task |
|-----------------|-----------|-----------|------|
| AC-001, AC-002, AC-003, AC-007 | integration (fake `gh`, temp git repos) | tests/integration/new-adopt.test.ts | tasks.md |
| AC-004, AC-005, AC-006, AC-056, AC-064 | integration + e2e on sample project | tests/integration/define.test.ts, tests/e2e/gate-a.test.ts | tasks.md |
| AC-008, AC-009, AC-055 | unit (admission, dedup) | tests/unit/intake.test.ts | tasks.md |
| AC-010, AC-011, AC-069 | unit + property (transitions) | tests/unit/transitions.test.ts, tests/property/transitions.prop.test.ts | tasks.md |
| AC-012, AC-066, AC-080 | integration (branch creation, manifest, guard) | tests/integration/branch.test.ts | tasks.md |
| AC-013, AC-042 | contract (CI checks) | tests/contract/ci-checks.test.ts | tasks.md |
| AC-014, AC-015, AC-073, AC-078 | integration (merge/deploy with fake `gh`) | tests/integration/merge-deploy.test.ts | tasks.md |
| AC-016, AC-017, AC-048 | unit (summary, trace, events) | tests/unit/summary.test.ts, tests/unit/events.test.ts | tasks.md |
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
- **Rollback steps**: Projects pin a release tag; roll back by `factory upgrade <previous-tag>`
  (an Owner-approved PR). Within the factory repo, each slice is one PR revertable with
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
│                         # resume, upgrade, inbox, keygen
├── dispatcher/           # transitions.ts (pure table), dispatch.ts, launcher/{cloud,local}.ts
├── approvals/            # record.ts (canonical format), sign.ts, verify.ts, nonces.ts
├── pause/                # derive.ts (label-history → pause state)
├── guard/                # policy.ts (from roles.yaml), tokenizer.ts, path-guard.ts,
│                         # command-guard.ts, read-guard.ts
├── hooks/                # session-start, post-edit, log, stop, pre-compact
├── mcp/                  # server.ts, tools/{advance-item,log-event,request-split}.ts
├── github/               # gh.ts wrapper, labels, timeline, comments, PRs
├── events/               # schema, append, redact
├── notify/               # inbox, owner-alert
├── ci/                   # coverage, size, ac-map, append-only, guardrail-change, new-deps
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
└── profiles/typescript/  # walking skeleton, tool settings, CI fragments

formal/                   # Dispatcher.tla, Dispatcher.cfg (TLC in CI)
allowed_signers           # Owner approval public key (release artifact)

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

### Delivery slices (each one work item, < 400 changed lines, own PR)

Phase 0 (P1, Gate A): 1 repo skeleton + CI · 2 approval records (sign/verify/nonces) ·
3 pause derivation · 4 transitions table + TLA+ model · 5 guard policy + tokenizer ·
6 path/command/read guards · 7 hooks + events · 8 MCP server · 9 gh wrapper + notify ·
10 install (`new`/`adopt`, manifest, labels, inbox) · 11 dispatcher + launchers ·
12 `approve`/`merge`/`deploy`/`pause`/`resume` · 13 role files + station prompts ·
14 CI checks (`coverage`, `size`, `ac-map`, `append-only`, `guardrail-change`) ·
15 TypeScript profile skeleton · 16 attack suite + Phase 0 probes.
Phase 1–2 (P2): 17 lanes/tiers/batch · 18 security flow + new-deps gate · 19 routine +
review trigger. Phase 3 (P3): 20 ops/metrics · 21 coach + benchmark · 22 upgrade.

## Complexity Tracking

| Deviation | Principle | Why Needed | Simpler Alternative Rejected Because | Owner approval |
|-----------|-----------|------------|-------------------------------------|----------------|
| One spec covers the whole factory (6–9k lines), above the 400-line slice | II | The spec is the v1 system definition; it is delivered as ~22 slices, each its own PR under the limit | Re-specifying each slice as a separate spec now would duplicate the cross-cutting requirements (signatures, pause, guards) that must stay consistent | Approved by the Owner, 2026-10-01 (chat) |
| The factory is built outside its own line: no issue, no `claude/<issue>-<slug>` branch, no signed approvals, work currently on `master`; guardrail files are authored here by an agent session | VII, II | Bootstrapping: the guards, dispatcher and signing do not exist until Phase 0 ships. Mitigation: every slice is a PR the Owner merges; guardrail sources live under `factory/` (not this repo's live `.claude/`); once Gate A passes, the factory repo adopts itself (`factory adopt`) and further work goes through the line | Waiting for a line that cannot exist yet is impossible; hand-writing everything without agents defeats the goal | Approved by the Owner, 2026-10-01 (chat) |
