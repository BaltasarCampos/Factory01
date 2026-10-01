---

description: "Task list template for feature implementation"
---

# Tasks: [FEATURE NAME]

**Input**: Design documents from `/specs/[###-feature-name]/`

**Work item**: [#issue] | **Risk tier**: [1 / 2 / 3] | **Lane**: [Lean / Full / Batch]

**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Tests**: Test tasks are MANDATORY (Principle III). Every acceptance criterion (AC-###) maps to at
least one test task, and each test task comes before the implementation tasks it covers. Tests
are run and seen failing before the implementation makes them pass.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description · Files: <paths>`

- **[P]**: Can run in parallel (different files, no dependencies). Sessions still run one at a
  time unless the Owner approves parallel sessions.
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- **Files**: The exact files the task may create or modify. The Builder MUST NOT touch files
  outside this list; if more are needed, the task goes back to planning.
- **Test tasks** also name the criterion they cover, e.g., `(AC-001)`.
- No task may touch guardrail files (`.claude/`, `.mcp.json`, hooks, `.github/workflows/`,
  `.factory/config`, `.specify/memory/constitution.md`, lockfile policy).
- Each task fits one fresh session. A session that nears its context limit, or compacts once,
  stops and hands the task back to planning to be split.

## Path Conventions

- **Single project**: `src/`, `tests/` at repository root
- **Web app**: `backend/src/`, `frontend/src/`
- Paths shown below assume a single TypeScript project - adjust based on plan.md structure

<!--
  ============================================================================
  IMPORTANT: The tasks below are SAMPLE TASKS for illustration purposes only.

  The /speckit-tasks command MUST replace these with actual tasks based on:
  - User stories and acceptance criteria (AC-###) from spec.md (with their priorities P1, P2, P3...)
  - Feature requirements and the "Acceptance Criteria → Tests" table from plan.md
  - Entities from data-model.md
  - Endpoints from contracts/

  Tasks MUST be organized by user story so each story can be:
  - Implemented independently
  - Tested independently
  - Delivered as an MVP increment

  DO NOT keep these sample tasks in the generated tasks.md file.
  ============================================================================
-->

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and basic structure

- [ ] T001 Create project structure per implementation plan · Files: [paths]
- [ ] T002 Initialize TypeScript project with [framework] dependencies (only dependencies approved in plan.md; installs run with scripts disabled against the committed lockfile) · Files: package.json, [lockfile]
- [ ] T003 [P] Configure linting and formatting tools · Files: [paths]

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before ANY user story can be implemented

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

Examples of foundational tasks (adjust based on your project):

- [ ] T004 Setup database schema and migrations framework · Files: [paths]
- [ ] T005 [P] Implement authentication/authorization framework · Files: [paths]
- [ ] T006 [P] Setup API routing and middleware structure · Files: [paths]
- [ ] T007 Create base models/entities that all stories depend on · Files: [paths]
- [ ] T008 Configure structured logging, error handling and health signals (Principle VI) · Files: [paths]
- [ ] T009 Setup environment configuration management (no secrets in the repository) · Files: [paths]

**Checkpoint**: Foundation ready - user story implementation can now begin

---

## Phase 3: User Story 1 - [Title] (Priority: P1) 🎯 MVP

**Goal**: [Brief description of what this story delivers]

**Independent Test**: [How to verify this story works on its own]

### Tests for User Story 1 (MANDATORY — write first, run, see them FAIL) ⚠️

- [ ] T010 [P] [US1] Contract test for [endpoint] (AC-001) · Files: tests/contract/[name].test.ts
- [ ] T011 [P] [US1] Integration test for [user journey] (AC-002) · Files: tests/integration/[name].test.ts
- [ ] T012 [P] [US1] *(tier 2–3)* Property-based test for [changed logic] · Files: tests/property/[name].test.ts
- [ ] T013 [US1] *(tier 3)* Formal model of [critical property] in TLA+ or Dafny, checked in CI · Files: specs/[###-feature]/formal/[name].[tla|dfy]

### Implementation for User Story 1

- [ ] T014 [P] [US1] Create [Entity1] model · Files: src/models/[entity1].ts
- [ ] T015 [P] [US1] Create [Entity2] model · Files: src/models/[entity2].ts
- [ ] T016 [US1] Implement [Service] (depends on T014, T015) · Files: src/services/[service].ts
- [ ] T017 [US1] Implement [endpoint/feature] · Files: src/[location]/[file].ts
- [ ] T018 [US1] Add validation and error handling · Files: [paths]
- [ ] T019 [US1] Add structured logging for user story 1 operations · Files: [paths]

**Checkpoint**: User Story 1 tests pass; User Story 1 is functional and testable independently

---

## Phase 4: User Story 2 - [Title] (Priority: P2)

**Goal**: [Brief description of what this story delivers]

**Independent Test**: [How to verify this story works on its own]

### Tests for User Story 2 (MANDATORY — write first, run, see them FAIL) ⚠️

- [ ] T020 [P] [US2] Contract test for [endpoint] (AC-003) · Files: tests/contract/[name].test.ts
- [ ] T021 [P] [US2] Integration test for [user journey] (AC-00x) · Files: tests/integration/[name].test.ts

### Implementation for User Story 2

- [ ] T022 [P] [US2] Create [Entity] model · Files: src/models/[entity].ts
- [ ] T023 [US2] Implement [Service] · Files: src/services/[service].ts
- [ ] T024 [US2] Implement [endpoint/feature] · Files: src/[location]/[file].ts
- [ ] T025 [US2] Integrate with User Story 1 components (if needed) · Files: [paths]

**Checkpoint**: User Stories 1 AND 2 tests pass; both work independently

---

## Phase 5: User Story 3 - [Title] (Priority: P3)

**Goal**: [Brief description of what this story delivers]

**Independent Test**: [How to verify this story works on its own]

### Tests for User Story 3 (MANDATORY — write first, run, see them FAIL) ⚠️

- [ ] T026 [P] [US3] Contract test for [endpoint] (AC-004) · Files: tests/contract/[name].test.ts
- [ ] T027 [P] [US3] Integration test for [user journey] (AC-00x) · Files: tests/integration/[name].test.ts

### Implementation for User Story 3

- [ ] T028 [P] [US3] Create [Entity] model · Files: src/models/[entity].ts
- [ ] T029 [US3] Implement [Service] · Files: src/services/[service].ts
- [ ] T030 [US3] Implement [endpoint/feature] · Files: src/[location]/[file].ts

**Checkpoint**: All user stories tests pass; each is independently functional

---

[Add more user story phases as needed, following the same pattern]

---

## Phase N: Polish & Release Readiness

**Purpose**: Improvements that affect multiple user stories, and the evidence the Verify and
Release stations need

- [ ] TXXX [P] Documentation updates · Files: docs/[paths]
- [ ] TXXX Code cleanup and refactoring (no test weakened, deleted or skipped) · Files: [paths]
- [ ] TXXX Confirm full suite passes and coverage on changed lines is ≥ 90% · Files: [test paths, if tests are added]
- [ ] TXXX Add feature flag for tier 2–3 behavior (off by default; the Owner turns it on) · Files: [paths]
- [ ] TXXX Document the rollback path (tier 3: add the tested rollback step) · Files: [paths]
- [ ] TXXX Run quickstart.md validation · Files: specs/[###-feature]/quickstart.md

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **User Stories (Phase 3+)**: All depend on Foundational phase completion
  - Proceed sequentially in priority order (P1 → P2 → P3); parallel sessions only with Owner approval
- **Polish (Final Phase)**: Depends on all desired user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational (Phase 2) - No dependencies on other stories
- **User Story 2 (P2)**: Can start after Foundational (Phase 2) - May integrate with US1 but should be independently testable
- **User Story 3 (P3)**: Can start after Foundational (Phase 2) - May integrate with US1/US2 but should be independently testable

### Within Each User Story

- Test tasks MUST be written, run and seen FAILING before any implementation task in the story
- Models before services
- Services before endpoints
- Core implementation before integration
- Story complete (its tests passing) before moving to next priority

### Parallel Opportunities

- [P] marks tasks with no shared files and no dependencies; they MAY be batched in one session
- Running separate agent sessions in parallel requires Owner approval (Principle V)

---

## Parallel Example: User Story 1

```bash
# Test tasks for User Story 1 that can be written together:
Task: "Contract test for [endpoint] (AC-001) · Files: tests/contract/[name].test.ts"
Task: "Integration test for [user journey] (AC-002) · Files: tests/integration/[name].test.ts"

# Models for User Story 1 that can be written together (after the tests fail):
Task: "Create [Entity1] model · Files: src/models/[entity1].ts"
Task: "Create [Entity2] model · Files: src/models/[entity2].ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL - blocks all stories)
3. Complete Phase 3: User Story 1 (tests first)
4. **STOP and VALIDATE**: Test User Story 1 independently
5. Open the pull request from the `claude/` branch for Verify; the Owner merges and deploys

### Incremental Delivery

1. Complete Setup + Foundational → Foundation ready
2. Add User Story 1 → Test independently → Pull request (MVP!)
3. Add User Story 2 → Test independently → Pull request
4. Add User Story 3 → Test independently → Pull request
5. Each story adds value without breaking previous stories; each increment stays under ~400
   changed lines so review takes under 30 minutes

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label and AC-### IDs map tasks to the spec for traceability
- Each user story should be independently completable and testable
- Verify tests fail before implementing
- Commit after each task or logical group; commits carry the agent role and work item id
- Push only to `claude/` branches; never to main
- Stop at any checkpoint to validate story independently
- Avoid: vague tasks, tasks without a Files list, same file conflicts, cross-story dependencies that break independence
