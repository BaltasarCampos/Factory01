# Slice size re-estimate

**Date**: 2026-10-03 · **Basis**: measured slices 1–2 · **Rule**: FR-038 / SC-007, a diff
reviewable in under 30 minutes, target under 400 changed lines. `factory ci size` excludes
`specs/**`, lockfiles and generated files, so **tests count**.

## Decision (2026-10-03)

The Owner approved a **1,000-line limit** for this repository's bootstrapping slices
(plan.md Complexity Tracking #3). Projects keep the release's 400-line limit. The slices were
re-cut to fit (plan.md § Delivery slices, tasks.md § Incremental Delivery): **44 work items in
total, 42 remaining** (33 to Gate A, 9 in Phases 1–3), against 82 at 400 lines and 34 in the
original plan. Note A is resolved by giving the verbatim copies a slice of their own (13) and
moving the skeleton to slice 12. Note B is resolved (2026-10-04): the `stop` hook ships in slice 7 and fails closed. The tables below are
the 400-line analysis that led to the decision.

## What the first two slices measured

| Slice | Tasks | Planned | Measured | Source | Tests / helpers | Config, docs |
|-------|-------|---------|----------|--------|-----------------|--------------|
| 1 | T001–T010 | < 400 | 1,346 | 0 | 1,054 (fake `gh` 768) | 292 |
| 2 | T011–T012, T024–T026 | < 400 | 1,446 | 758 | 688 | 0 |

Calibration taken from slice 2:

- Tests run at **about 0.9× the source** they cover. The tasks ask for one test case per rule,
  and the rules are many (config: 10 fields → 259 test lines for 135 source lines).
- A "module with a rule table" (config loader) is ~130 source lines; a "command table / shell"
  is ~300–400.
- plan.md's 8–11k lines for the whole factory was most likely source only. Counting tests, the
  whole factory comes to roughly **28–32k changed lines**, not 8–11k.

## Re-estimate of the remaining slices

Estimates are judgment, scaled from the slice 2 ratios above. They count source + tests;
markdown role files and prompts count too (they are reviewed). "New slices" is the count
needed to stay near 400.

| Slice (plan) | Tasks | Source | Tests | Total | New slices |
|--------------|-------|--------|-------|-------|------------|
| 3 Approval records + git signing | T016–T017, T031–T033, T147–T148 | 700 | 750 | 1,450 | 4 |
| 4 Pause derivation | T018, T034 | 80 | 150 | 230 | 1 |
| 5 Transition table + TLA+ | T019–T021, T035 | 580 | 600 | 1,180 | 3 |
| 6 `gh` wrapper, GitHub helpers, inbox | T013, T015, T027–T028, T030 | 550 | 450 | 1,000 | 3 |
| 7 Events + hook entry | T014, T029, T064 | 450 | 350 | 800 | 2 |
| 8 Dispatcher core | T022, T037 | 350 | 350 | 700 | 2 |
| 9 `approve` / `pause` / `resume` | T023, T036 | 350 | 400 | 750 | 2 |
| 10 `factory release` + tag verification | T131–T132 | 250 | 250 | 500 | 2 |
| 11 Install: `new` / `adopt` | T038, T040–T041, T043–T044 | 770 | 500 | 1,270 | 4 |
| 12 Define station | T039, T045–T046 | 320 | 350 | 670 | 2 |
| 13 Factory copies + skeleton | T042, T047 | 150 (+958 verbatim copies) | 20 | 170 / 1,128 | 1 (see note A) |
| 14 Station output checks | T048–T049, T057 | 350 | 350 | 700 | 2 |
| 15 Summary, trace, edge rules | T054–T055, T058, T067 | 350 | 350 | 700 | 2 |
| 16 Item branch, launchers, `dispatch`/`run` | T050, T059–T062 | 500 | 400 | 900 | 3 |
| 17 MCP server | T056, T063 | 250 | 250 | 500 | 2 |
| 18 Safe diff + CI checks | T133, T138, T051–T052, T065 | 650 | 600 | 1,250 | 4 |
| 19 Red-green, release CI, workflows | T135–T136, T140–T141, T066 | 850 | 500 | 1,350 | 4 |
| 20 Signed history + `config set` | T134, T137, T139, T142 | 300 | 350 | 650 | 2 |
| 21–22 `factory merge` | T053, T068, T143 | 750 | 700 | 1,450 | 4 |
| 23 `factory deploy` + backups | T069, T129–T130 | 350 | 350 | 700 | 2 |
| 24 Role files + station prompts | T070–T072 | 870 (markdown) | 0 | 870 | 3 |
| 25–26 Policy, tokenizer, guards | T074–T076, T081–T085 | 1,200 | 900 | 2,100 | 6 |
| 27 `guardrail-change` | T077, T087 | 150 | 200 | 350 | 1 |
| 28 Session-start + guard hooks | T078, T086 | 300 | 350 | 650 | 2 |
| 29 Gate A e2e, injection, attack suite | T073, T079–T080, T088 | 300 | 500 | 800 | 2 |
| **Phase 0 (Gate A) subtotal** | | | | **~21,700** | **65** (plan: 27) |
| 30 Lanes and tiers (US4) | T089–T093 | 350 | 400 | 750 | 2 |
| 31 Security flow (US6) | T102–T107 | 600 | 450 | 1,050 | 3 |
| 32 Routine and limits (US5) | T094–T101 | 500 | 500 | 1,000 | 3 |
| 33 Ops and metrics (US7) | T108–T110 | 400 | 300 | 700 | 2 |
| 34 Coach and benchmark (US8) | T111–T113, T149–T150 | 500 | 450 | 950 | 3 |
| 35 Upgrade (US9) | T114–T115 | 300 | 250 | 550 | 2 |
| 36 Key rotation | T144–T145 | 250 | 300 | 550 | 2 |
| **Phases 1–3 subtotal** | | | | **~5,550** | **17** (plan: 7) |
| **Remaining total** | | | | **~27,250** | **~82** (plan: 34) |

Polish tasks (T116–T123, ~500 lines) ride with the slices they verify, as planned.

## Proposed splits for the next four slices

| New slice | Tasks (parts) | Est. lines |
|-----------|---------------|------------|
| 3a Record format | T031; T017; T016 cases for canonical form, field order, `gate` set, nonce shape | ~400 |
| 3b Signing + git signing | T032 (`sign`, `keygen`), T148; T147; T016 sign cases | ~450 |
| 3c Key lists + signature verify | T033 steps 1–4 (`keys.ts`, `ssh-keygen -Y verify`, two-copy check, rotation-pending); T016 cases AC-072, AC-084, AC-085 | ~350 |
| 3d Field match + single use | T033 steps 5–6 (`verify.ts` field match, `nonces.ts`); T016 cases AC-068, AC-070, AC-071, AC-079, AC-089 | ~300 |
| 4 Pause derivation | unchanged | ~230 |
| 5a TLA+ model | T021 | ~300 |
| 5b Transition table, forward rows | T035 rows new → done; T019 per-row cases | ~450 |
| 5c Global guards + property tests | T035 global guards, `blocked`, `escalated`; T019 guard cases; T020 | ~430 |

## Notes

- **A. Verbatim copies.** Slice 13 copies the constitution and three Spec Kit templates
  byte for byte (958 lines). T123 asserts they are identical, so reviewing them takes seconds,
  not 30 minutes. Counting them as generated would need the Owner to say so; otherwise slice 13
  becomes 3–4 slices of pure copying.
- **B. A dependency to fix in planning.** T064 (slice 7) builds the `stop` hook, which runs the
  station output checkers that only arrive in slice 14 (T045, T057). Either move the `stop`
  hook to slice 14 or ship it with an empty checker registry in slice 7.
  **Resolved 2026-10-04 (Owner):** ship it in slice 7 with an empty registry; a station without
  a checker blocks stop (fail closed) until slice 14 registers its checker.
- **C. Budget impact.** About 82 slices instead of 34 means about two and a half times the review sessions
  and plan usage in plan.md § Plan Usage Budget; at 3–5 slices a week, Gate A (65 slices) moves from about
  6–9 weeks to about 13–22 weeks.
- **D. Levers if that is too slow** (Owner decisions, not recommendations to weaken a gate):
  approve a higher limit for factory bootstrapping only (for example 800 lines, recorded in
  Complexity Tracking); or count test lines at a discount, which the spec does not allow today.
