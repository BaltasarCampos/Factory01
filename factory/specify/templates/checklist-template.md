# Spec Quality Checklist: [FEATURE NAME]

**Purpose**: Check `spec.md` is complete and testable before the Owner approves it
**Created**: [DATE]
**Feature**: [link to spec.md]

## Content

- [ ] `## Problem`, `## Non-goals` and `## Affected areas` are filled in
- [ ] It says what users need and why, not how to build it
- [ ] Every mandatory section is complete; sections that do not apply are deleted
- [ ] No placeholder or template comment is left

## Acceptance criteria

- [ ] Every criterion is one line starting with exactly one `**AC-###**` ID, numbered with no gaps or repeats
- [ ] Every criterion reads Given … When … Then …, observable from outside, testable as written
- [ ] No vague word ("fast", "easy", "robust") without a measurable threshold
- [ ] Edge cases and failures have criteria too

## Scope

- [ ] The scope is bounded by the non-goals
- [ ] Every gap that changes behaviour, cost or risk is a question under `## Clarifications`, never an assumption
- [ ] Smaller defaults are listed under `## Assumptions`

## Notes

- [one line per item left unticked, naming the open question that blocks it]
