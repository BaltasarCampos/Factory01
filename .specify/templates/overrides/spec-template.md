# Feature Specification: [FEATURE NAME]

**Feature Branch**: `[###-feature-name]`

**Created**: [DATE]

**Status**: Draft

**Work item**: [#issue, authored or approved (`approved` label) by the Owner]

**Risk tier**: [1 — Low / 2 — Medium / 3 — High, as assigned by Intake; agents MUST NOT lower it]

**Owner approval**: [Pending — tier 2–3 need explicit approval; tier 1 is skimmed]

**Input**: User description: "$ARGUMENTS"

<!--
  Tier 1 (copy changes, dependency patch bumps, test-only changes): a one-line spec is enough.
  Fill in the summary line below, one acceptance scenario, and delete the other sections.
  Tier 2–3: fill in every mandatory section. Tier 3 also fills in "Risks".
-->

**Summary (tier 1 one-line spec)**: [What changes and how it is verified]

## User Scenarios & Testing *(mandatory)*

<!--
  IMPORTANT: User stories should be PRIORITIZED as user journeys ordered by importance.
  Each user story/journey must be INDEPENDENTLY TESTABLE - meaning if you implement just ONE of them,
  you should still have a viable MVP (Minimum Viable Product) that delivers value.

  Assign priorities (P1, P2, P3, etc.) to each story, where P1 is the most critical.
  Think of each story as a standalone slice of functionality that can be:
  - Developed independently
  - Tested independently
  - Deployed independently
  - Demonstrated to users independently

  Every acceptance scenario is an acceptance criterion (Principle III): it MUST be testable,
  observable from outside, and MUST map to at least one automated test in the plan. Give each
  one an ID (AC-###) so the plan, tasks and tests can trace to it. Avoid vague words such as
  "fast", "easy" or "intuitive" unless a measurable threshold is given.
-->

### User Story 1 - [Brief Title] (Priority: P1)

[Describe this user journey in plain language]

**Why this priority**: [Explain the value and why it has this priority level]

**Independent Test**: [Describe how this can be tested independently - e.g., "Can be fully tested by [specific action] and delivers [specific value]"]

**Acceptance Scenarios**:

1. **AC-001** — **Given** [initial state], **When** [action], **Then** [expected outcome]
2. **AC-002** — **Given** [initial state], **When** [action], **Then** [expected outcome]

---

### User Story 2 - [Brief Title] (Priority: P2)

[Describe this user journey in plain language]

**Why this priority**: [Explain the value and why it has this priority level]

**Independent Test**: [Describe how this can be tested independently]

**Acceptance Scenarios**:

1. **AC-003** — **Given** [initial state], **When** [action], **Then** [expected outcome]

---

### User Story 3 - [Brief Title] (Priority: P3)

[Describe this user journey in plain language]

**Why this priority**: [Explain the value and why it has this priority level]

**Independent Test**: [Describe how this can be tested independently]

**Acceptance Scenarios**:

1. **AC-004** — **Given** [initial state], **When** [action], **Then** [expected outcome]

---

[Add more user stories as needed, each with an assigned priority]

### Edge Cases

<!--
  ACTION REQUIRED: The content in this section represents placeholders.
  Fill them out with the right edge cases. Each edge case with defined behavior is also an
  acceptance criterion and gets an AC-### ID.
-->

- **AC-0xx** — What happens when [boundary condition]?
- **AC-0xx** — How does system handle [error scenario]?

## Requirements *(mandatory)*

<!--
  ACTION REQUIRED: The content in this section represents placeholders.
  Fill them out with the right functional requirements.
-->

### Functional Requirements

- **FR-001**: System MUST [specific capability, e.g., "allow users to create accounts"]
- **FR-002**: System MUST [specific capability, e.g., "validate email addresses"]
- **FR-003**: Users MUST be able to [key interaction, e.g., "reset their password"]
- **FR-004**: System MUST [data requirement, e.g., "persist user preferences"]
- **FR-005**: System MUST [behavior, e.g., "log all security events"]

*Example of marking unclear requirements:*

- **FR-006**: System MUST authenticate users via [NEEDS CLARIFICATION: auth method not specified - email/password, SSO, OAuth?]
- **FR-007**: System MUST retain user data for [NEEDS CLARIFICATION: retention period not specified]

### Key Entities *(include if feature involves data)*

- **[Entity 1]**: [What it represents, key attributes without implementation]
- **[Entity 2]**: [What it represents, relationships to other entities]

## Success Criteria *(mandatory)*

<!--
  ACTION REQUIRED: Define measurable success criteria.
  These must be technology-agnostic and measurable.
-->

### Measurable Outcomes

- **SC-001**: [Measurable metric, e.g., "Users can complete account creation in under 2 minutes"]
- **SC-002**: [Measurable metric, e.g., "System handles 1000 concurrent users without degradation"]
- **SC-003**: [User satisfaction metric, e.g., "90% of users successfully complete primary task on first attempt"]
- **SC-004**: [Business metric, e.g., "Reduce support tickets related to [X] by 50%"]

## Risks *(mandatory for tier 3; optional for tier 1–2)*

<!--
  ACTION REQUIRED for tier 3 (auth, billing, data deletion, migrations, public API changes).
  The Owner approves the spec with this section in view.
-->

- **Critical property**: [The one property that must never be violated, e.g., "a deleted account's data is never readable again". It is formally verified (TLA+ for workflows and state machines, Dafny for small critical functions).]
- **Failure modes**: [What could go wrong and what the user or data would experience]
- **Blast radius**: [Who and what is affected if it fails]
- **Irreversible or outward-facing actions**: [Data deletion, destructive migrations, external communications, spending; each needs Owner approval]
- **Rollback**: [How the change is reversed; tier 3 needs a written, tested rollback step]
- **Feature flag**: [Flag name; the Owner turns it on]

## Assumptions

<!--
  ACTION REQUIRED: The content in this section represents placeholders.
  List only low-impact defaults. Any gap that changes user-visible behavior, cost or risk is
  NOT an assumption: mark it [NEEDS CLARIFICATION] so the Owner answers it (Principle I).
-->

- [Assumption about target users, e.g., "Users have stable internet connectivity"]
- [Assumption about scope boundaries, e.g., "Mobile support is out of scope for v1"]
- [Assumption about data/environment, e.g., "Existing authentication system will be reused"]
- [Dependency on existing system/service, e.g., "Requires access to the existing user profile API"]
