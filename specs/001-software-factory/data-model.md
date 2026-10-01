# Data Model: Software Factory v1

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md) | **Date**: 2026-10-01

The factory has no database. Each entity below names where it is stored. Types are given as
TypeScript-style shapes; they become the types in `src/model/`.

---

## Project config

Stored at `.factory/config` (YAML) in the project repo. Guardrail file.

| Field | Type | Rules |
|-------|------|-------|
| `factory_release` | string (tag, e.g. `v1.0.0`) | Required; matches a tag of the public factory repo |
| `agents` | `cloud` \| `local` | Required before any cloud session (FR-004, AC-002) |
| `profile` | `typescript` | Only approved profile (FR-008) |
| `repo` | `owner/name` | Must be private (AC-003) |
| `inbox_issue` | number | Pinned Owner inbox issue (FR-034a) |
| `parallel_sessions` | number, default 1 | > 1 only with an Owner waiver record (FR-030) |
| `retry_limit` | number, default 3 | FR-012 |
| `size_limit_lines` | number, default 400 | QG-6 |
| `coverage_min` | number, default 90 | QG-3 |

## Work item

Stored as one GitHub issue plus its labels, comments and feature folder.

| Field | Source | Rules |
|-------|--------|-------|
| `issue` | issue number | Unique per repo |
| `slug` | derived from title, kebab-case, ≤ 40 chars | Fixed at approval |
| `branch` | `claude/<issue>-<slug>` | Created only by the dispatcher (AC-066) |
| `feature_dir` | `specs/<issue>-<slug>/` | On `branch` |
| `type` | `feature` \| `bug` \| `debt` \| `security` \| `dependency` \| `copy` | Set by Intake |
| `priority` | `p0`–`p3` | Set by Intake; security critical/high → `p0` |
| `tier` | `1` \| `2` \| `3` | From `tier:` label; confirmed only by the `owner:approved` record |
| `state` | one `state:` label | See state machine below |
| `owner_labels` | set of `owner:approved` / `owner:spec-approved` / `owner:waiver` | Valid only with a verifying record |
| `attempts` | map station → count | From gate-result events; ≥ `retry_limit` → `escalated` |
| `pr` | number | One draft PR, opened at Specify (FR-016a) |
| `author` | GitHub login | Item admitted only if Owner-authored or `owner:approved` |

### State machine (FR-011)

```text
new ─▶ triaged ─▶ specified ─▶ spec-approved ─▶ planned ─▶ building ─▶ verifying ─▶ integrating ─▶ releasing ─▶ done
 any ─▶ blocked   (question to Owner; resumes to the state it left)
 any ─▶ escalated (retry limit hit, tampering, usage limit)
```

| Transition | Guard (checked by dispatcher code) |
|------------|------------------------------------|
| new → triaged | `owner:approved` with verifying record (gate `approved`, tier) |
| triaged → specified | `spec.md` exists with problem, ACs, non-goals, affected areas; draft PR open |
| specified → spec-approved | `owner:spec-approved` record verifying against current `spec.md` hash; **or** Owner-confirmed `tier:1` (skim path, AC-010/AC-069) |
| spec-approved → planned | `plan.md`, `tasks.md` present; Constitution Check passes; every AC mapped; test tasks first |
| planned → building | always (dispatcher assigns the next task) |
| building → verifying | all tasks done; failing-then-passing evidence per new test |
| verifying → integrating | `reports/verify.md` all checks pass; blocking review findings resolved |
| integrating → releasing | branch rebased, CI green, **merged by Owner** with a `factory merge` verification record |
| releasing → done | release notes and rollback path on `claude/factory-log`; Owner ran `factory deploy` |
| X → earlier station | gate failed; target = earliest station able to fix (from failure report) |

Global guards: no transition while `pause:line` is in effect; no entry to a paused station;
no transition on an item with an unverified `owner:` label (→ `escalated`, tampering alert).

## Approval record

Signed text stored as a fenced block in an issue comment and as an event line.

```text
factory-approve/v1
repo: <owner>/<name>
issue: <number>
gate: approved | spec-approved | waiver | resume
tier: 1 | 2 | 3            (gates approved, spec-approved, waiver)
branch: claude/<issue>-<slug>   (gates spec-approved, waiver)
spec_sha: <git blob sha>   (gate spec-approved only)
scope: line | <station>    (gate resume only; issue = inbox issue)
waives: <gate or check id> (gate waiver only)
timestamp: <RFC 3339 UTC>
nonce: <32 hex chars>
```

Rules: lines in the fixed order above, LF endings, no trailing spaces, absent fields omitted
(not empty). Signature = `ssh-keygen -Y sign -n factory-approve` over the exact bytes.
Valid iff signature verifies against the matched key pair (pinned + routine copies identical),
every field matches the item it is checked against, and the nonce backs no earlier label event.

## Approval key

Laptop-only, `~/.factory/keys/approve_ed25519` (+ `.pub`). Passphrase required. Path is
denied to every role (settings deny + path guard, AC-074). Public half in the release's
`allowed_signers` and in the routine's `FACTORY_ALLOWED_SIGNERS`.

## Pause state (FR-029, FR-029a)

Derived, never stored. Input: inbox issue timeline (`labeled`/`unlabeled` events for
`pause:*`) + resume records in inbox comments.

```text
paused(scope) = ∃ labeled(pause:scope) at t1
                ∧ ¬∃ valid resume record for scope at t2 > t1
```

If `paused(scope)` and the label is absent → re-apply label, urgent alert (AC-076).

## Event

One JSON object per line in `specs/<feature>/events.jsonl` (pre-merge) or
`.factory/events/<yyyy-mm>.jsonl` on `claude/factory-log` (post-merge).

| Field | Type | Notes |
|-------|------|-------|
| `ts` | RFC 3339 | |
| `item` | number | |
| `station` | 0–8 | |
| `role` | role name | |
| `role_version` | string | Factory release + role file hash |
| `session` | string | Session id |
| `model` | string | Must not be a Fable model |
| `kind` | `tool_call` \| `blocked` \| `gate_result` \| `approval` \| `alert` \| `usage` \| `split` \| `advance_request` \| `owner_comment` | |
| `tool` / `input_summary` | string | Secrets redacted before write |
| `gate` / `pass` / `evidence` | for `gate_result` | |
| `usage` | `{ sessions, est_share }` | FR-035 |

Append-only (R12).

## Gate result

An Event with `kind: gate_result`; attempts per station are counted from these.

## Role

`.claude/agents/<role>.md` frontmatter (`name`, `model`, `tools`, `version`) + body.
Permission row in `.claude/settings.json` and in `src/guard/policy.ts` (generated from one
source table, `factory/policy/roles.yaml`). Twelve roles, fixed set.

## Station manifest

`specs/<feature>/.station.json`, written by the dispatcher before each session; no role may
write it.

```json
{ "item": 42, "station": 4, "role": "builder", "branch": "claude/42-add-login",
  "task": "T007", "files": ["src/auth/login.ts", "tests/unit/login.test.ts"],
  "issued_at": "2026-10-01T09:00:00Z" }
```

## Guardrail manifest

`guardrails.manifest.json` in each factory release: `{ "release": "v1.0.0", "files":
{ "<path>": "<sha256>" } }`. Protected paths: `.claude/**`, `.mcp.json`, `.claude/hooks/**`,
`.github/workflows/**`, `.factory/config`, `.specify/memory/constitution.md`,
`.factory/lockfile-policy`.

## Owner inbox entry

Comment on the inbox issue: `<!-- factory-alert id=<ulid> urgency=urgent|info kind=<kind> -->`
+ human text + evidence links. Read state: `~/.factory/inbox-read` (ids).

## Security finding

Issue labelled `security` with hidden key `<!-- finding rule=<id> location=<path:line> -->`;
dedup key = (rule, location). Dismissal entry in `.factory/security/dismissals.md`: rule,
location, reason (Security role), Owner approval record (`waiver`), re-check date.

## Health summary, incident note, metrics report, lesson, release notes

Markdown files on `claude/factory-log`:
`.factory/ops/health/<ts>.md` (version, status, checks), `.factory/ops/incidents/<id>.md`,
`.factory/ops/metrics/<yyyy-Www>.md` (nine metrics, AC-047), `.factory/lessons/<role>.md`
(append sections), `.factory/releases/<version>.md` (notes + rollback path).

## Benchmark item

In the private benchmark repo: `items/<id>/` with the item's issue text, spec, the commit it
started from, expected gate outcomes. Add-only; retired only by an Owner commit outside any
Coach PR (AC-051).
