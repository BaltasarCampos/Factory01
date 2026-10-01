# Implementation Plan: [FEATURE]

**Branch**: `[###-feature-name]` | **Date**: [DATE] | **Spec**: [link]

**Work item**: [#issue] | **Risk tier**: [1 / 2 / 3, copied from the spec] | **Lane**: [Lean / Full / Batch]

**Input**: Feature specification from `/specs/[###-feature-name]/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command; its definition describes the execution workflow.

## Summary

[Extract from feature spec: primary requirement + technical approach from research]

## Technical Context

<!--
  ACTION REQUIRED: Replace the content in this section with the technical details
  for the project. The structure here is presented in advisory capacity to guide
  the iteration process.
-->

**Language/Version**: TypeScript [version] (the only approved stack profile; any other needs a
constitution amendment)

**Primary Dependencies**: [existing dependencies used, or NEEDS CLARIFICATION]

**Storage**: [if applicable, e.g., SQLite, files or N/A]

**Testing**: [e.g., Vitest + fast-check for property-based tests or NEEDS CLARIFICATION]

**Target Platform**: Owner's laptop, deployed by the Owner with `factory deploy`

**Project Type**: [e.g., library/cli/web-service or NEEDS CLARIFICATION]

**Performance Goals**: [domain-specific, e.g., 1000 req/s or N/A]

**Constraints**: [domain-specific, e.g., <200ms p95, offline-capable or N/A]

**Scale/Scope**: [domain-specific, e.g., 10k users, 50 screens or NEEDS CLARIFICATION]

## Plan Usage Budget

<!-- Principle V: budgets are plan usage on the Owner's Claude Pro plan, never API spend. -->

| Item | Value |
|------|-------|
| Model sessions planned (per station) | [e.g., Build 1 · Review 1 (tier 3: 2) · Test 1] |
| Estimated share of weekly plan limit | [e.g., ~5%] |
| Models | Sonnet main, Opus advisor (Intake/Test: Sonnet only); [any escalation + reason] |
| Parallel sessions | None [or: Owner approval reference] |
| Estimated changed lines | [target < 400; otherwise split the work item] |

## New Dependencies

<!--
  Principle VII and Operating Constraints: every addition needs the dependency gate and Owner
  approval. Prefer existing code → standard library → established dependency → new code.
  Write "None" if nothing is added.
-->

| Package | Version | Licence | Maintenance | Usage / age | Why not existing code or stdlib | Gate passed | Owner approval |
|---------|---------|---------|-------------|-------------|---------------------------------|-------------|----------------|
| [name] | [x.y.z] | [MIT] | [last release, maintainers] | [weekly downloads, first release] | [reason] | [yes/no] | [pending/link] |

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Mark each item ✅ pass, ❌ fail (blocks the plan) or ⚠️ deviation (record in Complexity Tracking
with Owner approval).

| # | Principle | Check | Status |
|---|-----------|-------|--------|
| I | Owner Holds Intent and the Keys | Plan adds no scope beyond the approved spec; open questions are raised to the Owner, not assumed; spec approved (tier 2–3) or skimmed (tier 1) | [ ] |
| II | Spec-Driven Assembly Line | Input spec exists and passed its gate; work is one independently releasable slice (< 400 changed lines, reviewable in < 30 min) | [ ] |
| III | Test-Gated Delivery | Every acceptance criterion maps to an automated test (see table below); coverage ≥ 90% on changed lines is achievable; tier 2: property-based tests planned; tier 3: formal verification of the critical property planned (TLA+ or Dafny) | [ ] |
| IV | Independent Agent Review | Review by a separate fresh session planned; tier 3: second independent review planned | [ ] |
| V | Frugal by Design | Usage budget stated above; no API credits or new paid services; dependencies minimal and justified | [ ] |
| VI | Traceable and Observable Work | Trace links request → spec → plan → tasks are present; structured logs and health signals for new behavior are planned | [ ] |
| VII | Bounded Autonomy and Safe Operations | No guardrail file changes (`.claude/`, `.mcp.json`, hooks, `.github/workflows/`, `.factory/config`, constitution, lockfile policy); no secrets; new dependencies gated; irreversible actions flagged for the Owner; rollback path defined (tier 3: written and tested) | [ ] |
| VIII | Fresh Context, File Hand-offs | Each task fits one fresh session; hand-offs only via repository artifacts | [ ] |
| IX | Learning Within Limits | Relevant `.factory/lessons/` entries consulted; no changes to gates, permissions or budgets | [ ] |
| — | Risk tier and lane | Tier matches the spec (agents never lower it); lane allowed for the tier | [ ] |

### Acceptance Criteria → Tests

<!-- Station 3 gate: every criterion in the spec maps to at least one automated test. -->

| Criterion (spec) | Test type | Test file | Task |
|------------------|-----------|-----------|------|
| [AC-001] | [unit / integration / contract / property / formal] | [tests/...] | [T0xx] |

### Rollback Path

<!-- Release gate for every tier (Principle VII). Tier 2–3 ship behind a flag the Owner turns on. -->

- **Feature flag**: [flag name, or "none (tier 1)"]
- **Rollback steps**: [how to revert: disable flag, revert release, data/schema reversal]
- **Tier 3 only**: [written rollback step and the test that exercises it]

## Project Structure

### Documentation (this feature)

```text
specs/[###-feature]/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md        # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── contracts/           # Phase 1 output (/speckit-plan command)
├── tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
└── reports/             # Station 5+ output (verify.md, review reports)
```

### Source Code (repository root)
<!--
  ACTION REQUIRED: Replace the placeholder tree below with the concrete layout
  for this feature. Delete unused options and expand the chosen structure with
  real paths (e.g., apps/admin, packages/something). The delivered plan must
  not include Option labels.
-->

```text
# [REMOVE IF UNUSED] Option 1: Single project (DEFAULT)
src/
├── models/
├── services/
├── cli/
└── lib/

tests/
├── contract/
├── integration/
├── property/
└── unit/

# [REMOVE IF UNUSED] Option 2: Web application (when "frontend" + "backend" detected)
backend/
├── src/
│   ├── models/
│   ├── services/
│   └── api/
└── tests/

frontend/
├── src/
│   ├── components/
│   ├── pages/
│   └── services/
└── tests/

# [REMOVE IF UNUSED] Tier 3 formal verification
specs/[###-feature]/formal/   # TLA+ (.tla) or Dafny (.dfy) models, checked in CI
```

**Structure Decision**: [Document the selected structure and reference the real
directories captured above]

## Complexity Tracking

> **Fill ONLY if Constitution Check has deviations that must be justified. Each row needs
> Owner approval before the plan passes its gate.**

| Deviation | Principle | Why Needed | Simpler Alternative Rejected Because | Owner approval |
|-----------|-----------|------------|-------------------------------------|----------------|
| [e.g., 600 changed lines] | [II] | [current need] | [why splitting is not possible] | [pending/link] |
