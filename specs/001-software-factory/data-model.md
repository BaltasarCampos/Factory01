# Data Model: Software Factory v1

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md) | **Date**: 2026-10-01 (updated 2026-10-02)

The factory has no database. Each entity below names where it is stored. Types are given as
TypeScript-style shapes; they become the types in `src/model/`.

---

## Project config

Stored at `.factory/config` (YAML) in the project repo. Protected file, but its content is
per project, so it is **not** hashed against the release manifest. Instead:

- `factory merge` refuses any change to it in a pull request, except in an upgrade pull
  request, where only the `factory_release` line may change.
- The Owner changes any other field with `factory config set` on the laptop, which makes a
  signed commit on main.
- The session-start check refuses a branch whose own commits (since its merge base with main)
  changed it. A branch created before an upgrade or `config set` keeps its merge base's copy
  until Integrate rebases it.
- The dispatcher and CI always read it from main.

| Field | Type | Rules |
|-------|------|-------|
| `factory_release` | string `<tag>@<sha>` (e.g. `v1.0.0@3f9a…`, 40-hex commit) | Required; the pinned factory release, by signed tag and its commit hash. CI builds the factory CLI from this commit |
| `baseline` | 40-hex commit, optional | Adopted repos only: the last unsigned commit on main. Every first-parent commit after it must be signed by the Owner. Absent for repos made by `factory new` (signed from the root commit) |
| `agents` | `cloud` \| `local` | Required before any cloud session (FR-004, AC-002) |
| `profile` | `typescript` | Only approved profile (FR-008) |
| `repo` | `owner/name` | Must be private (AC-003) |
| `inbox_issue` | number | Pinned Owner inbox issue (FR-034a) |
| `parallel_sessions` | number, default 1 | > 1 only through `factory config set` (an Owner-signed commit on main, FR-030) |
| `retry_limit` | number, default 3 | FR-012 |
| `size_limit_lines` | number, default = the release's limit (400) | QG-6; may only be **lowered** below the release's limit, through `factory config set` |
| `coverage_min` | number, default = the release's floor (90) | QG-3; may only be **raised** above the release's floor, through `factory config set` |

CI applies the stricter of the release's value and main's config value; a lower coverage or a
higher size limit in config is rejected when the config is loaded.

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
| `tier` | `1` \| `2` \| `3` | Proposed by the filing agent's `tier:` label or given with `factory approve --tier`; confirmed only by the `owner:approved` record; Intake may only propose raising it |
| `state` | one `state:` label | See state machine below |
| `owner_labels` | set of `owner:approved` / `owner:spec-approved` / `owner:waiver` | Valid only with a verifying record |
| `attempts` | map station → count | From gate-result events (telemetry; affects only escalation timing, never a merge); ≥ `retry_limit` → `escalated` |
| `pr` | number | One draft PR, opened at Specify (FR-016a) |
| `author` | GitHub login | Informational only: agents act through the Owner's account, so authorship never admits an item |

### State machine (FR-011)

```text
new ─▶ triaged ─▶ specified ─▶ spec-approved ─▶ planned ─▶ building ─▶ verifying ─▶ integrating ─▶ releasing ─▶ done
 any ─▶ blocked   (question to Owner; resumes to the state it left)
 any ─▶ escalated (retry limit hit, tampering, usage limit)
```

| Transition | Guard (checked by dispatcher code) |
|------------|------------------------------------|
| new → triaged | `owner:approved` with verifying record (gate `approved`, tier); Intake's output check passes; no proposed `tier:` above the confirmed tier (a raise waits for a new `factory approve --tier`) |
| triaged → specified | `spec.md` exists with problem, ACs, non-goals, affected areas; draft PR open |
| specified → spec-approved | `owner:spec-approved` record verifying against current `spec.md` hash; **or** Owner-confirmed `tier:1` (skim path, AC-010/AC-069) |
| spec-approved → planned | `plan.md`, `tasks.md` present; Constitution Check passes; every AC mapped; test tasks first |
| planned → building | always (dispatcher assigns the next task) |
| building → verifying | all tasks done; `ci / red-green` green on the branch head (never event evidence) |
| verifying → integrating | `reports/verify.md` all checks pass; blocking review findings resolved |
| integrating → releasing | branch rebased, CI green, **merged by the Owner**: an Owner-signed merge of the item (`Factory-Merge: #<issue>`, § Merge trailers) of its checked head on main's first-parent history |
| releasing → done | release notes and rollback path on `claude/factory-log`; Owner ran `factory deploy` |
| X → earlier station | gate failed; target = earliest station able to fix (from failure report); never once main has an Owner-signed merge of the item (`Factory-Merge: #<issue>`, § Merge trailers): a later failure moves it on to, or keeps it in, `releasing` with an alert, and the dispatcher files a follow-up issue |

Global guards: no item is admitted, and none moves, until main's first-parent history has an
Owner-signed merge of `claude/define` (`Factory-Merge: define`, § Signed main history); if that
signature, or main's pinned `allowed_signers` or `revoked_keys`, cannot be checked, the brief
counts as not merged and nothing is admitted; a `Factory-Merge:` trailer whose signature or key
list cannot be checked moves no item and raises an alert, as with an unsigned first-parent
commit; no transition while `pause:line` is in effect; no entry to a paused station; no
transition on an item with an unverified `owner:` label (→ `escalated`, tampering alert);
no transition at all while main has an unsigned first-parent commit or a key rotation is
pending (§ Keys and rotation).

The dispatcher is itself an agent session with a shell, so its gate decisions are advisory.
Only signed records and the checks `factory merge` and `factory deploy` compute on the laptop
decide what reaches main and the laptop.

## Approval record

Signed text stored as a fenced block in an issue comment and as an event line.

```text
factory-approve/v1
repo: <owner>/<name>
issue: <number>
gate: approved | spec-approved | waiver | resume | deployed
tier: 1 | 2 | 3                 (approved, spec-approved; waiver when issue is a work item)
branch: claude/<issue>-<slug>   (approved, spec-approved; waiver when item- or PR-scoped)
spec_sha: <git blob sha>        (spec-approved only)
scope: line | <station>         (resume only; issue = inbox issue)
waives: <waiver target>         (waiver only; see § Waiver targets)
head: <40 hex>                  (code-gate waivers: the PR head commit waived; deployed: the main commit deployed)
timestamp: <RFC 3339 UTC>
nonce: <32 hex chars>
```

Rules: lines in the fixed order above, LF endings, no trailing spaces, absent fields omitted
(not empty). Signature = `ssh-keygen -Y sign -n factory-approve` over the exact bytes.
Valid iff the signature verifies against a non-revoked key in main's pinned `allowed_signers`
(§ Keys and rotation), every field matches the item it is checked against, and the
single-use and freshness rules of [contracts/approval-record.md](contracts/approval-record.md)
step 6 hold.

There is no `merged` record: the Owner-signed merge commit on main is the merge approval
(§ Signed main history).

`timestamp` is set by whoever holds the key, so it proves nothing on its own; it only orders
records signed by a key that has not been stolen. A stolen key is handled by revocation, not by
timestamps.

The slug is fixed by the `approved` record's `branch` field: the dispatcher creates exactly
that branch and never re-derives the slug from the issue title.

For `deployed` records, `repo` names the project and `issue` is the Owner inbox issue.

### Waiver targets

| `waives` value | `issue` field | Used by |
|----------------|---------------|---------|
| `gate:<gate>` | work item | Gate skip (AC-029). **Code gates** (`red-green`, `coverage`, `size`, `ac-<id>`, `ci-<job>`) carry `head` and count only while the PR head equals it. **Pre-build gates** (for example `spec-approved`, `plan`) carry no `head` and are bound to the item only |
| `check:guardrail-change@<tag>@<sha>` | upgrade PR number (PRs are issues) | Upgrade PRs only (AC-020, AC-054); names the signed release the PR must match |
| `dep:<name>@<version>` | PR adding the dependency | New-dependency gate (AC-045) |
| `finding:<rule>@<path:line>` | security issue | Dismissal (AC-043) |

`tier` and `branch` are present only when `issue` is a work item; for PR-scoped waivers
`branch` is the PR's head branch. When Integrate's rebase changes the head, `factory merge`
shows the diff between a code-gate waiver's head and the current head and asks the Owner to
sign a new waiver in the same step.

Waivers for weakened tests (`test:<path>#<title>`, AC-061) are not yet a target form:
`factory approve` refuses `test:` targets, and a diff that weakens a test blocks until the form
exists (T151, which also replaces the re-sign diff above with a range-diff).

## Pull request merge checks

`factory merge` merges every pull request on the laptop, after checks it computes itself. CI
results count only after these checks pass, because a `pull_request` run uses the workflow
files of the pull request: once the laptop confirms no protected file changed, CI ran the
pinned workflows.

Every diff is computed with `git -c core.attributesFile=/dev/null diff --no-renames
--no-ext-diff --no-textconv <main>...<checked head>`, ignoring `.gitattributes`, so a rename is
a deletion plus an addition and no filter hides content.

| Head branch | Checks (all computed on the laptop) | Effect |
|-------------|-------------------------------------|--------|
| `claude/<issue>-<slug>` (work item) | Full approval chain verifies; no earlier Owner-signed merge with `Factory-Merge: #<issue>` on main; checked set of acceptance criteria not empty and every criterion line has an ID (FR-042); no weakened test without a covering waiver (AC-061); no protected path, `.gitattributes`, `.gitmodules` or `.factory/config` touched; required CI checks green on the checked commit | Item merged, once |
| `claude/define` | Same path rule as items; CI green; Define output check passes | Brief merged (`Factory-Merge: define`): from now on the dispatcher admits items, each still needing its own `owner:approved` |
| `factory/upgrade-<tag>` | Tag carries a valid Owner signature (verified with main's pinned `allowed_signers`) and still resolves to `<sha>`; a verified `check:guardrail-change@<tag>@<sha>` waiver; the full protected set at the PR head equals the manifest of `<tag>@<sha>` (every file present with its hash, no extra protected file); `.factory/config` differs from main only in the `factory_release` line, set to `<tag>@<sha>` | New factory release pinned |
| `claude/factory-log` | Only additions; in an existing file, new lines only after the old ones; every touched path under `.factory/events/`, `.factory/ops/`, `.factory/lessons/` or `.factory/releases/`; regular text files only (no binary, symlink, executable bit, gitlink or `.git*` file); no protected path (no waiver can allow one) | Weekly log merge |

A pull request from any other branch with no work item is refused. For every merge,
`factory merge` warns while the dispatcher shows a session for that item running and continues
only after the Owner confirms (the signal is telemetry, so it must never block a merge), shows
the approval summary (§ Approval summary), then:

1. fetches the checked commit and makes the merge commit locally with
   `git merge --no-ff -S <checked sha>` (Owner-signed, passphrase prompted), whose message ends
   with the trailer `Factory-Merge: #<issue>` (item), `define`, `upgrade <tag>` or
   `factory-log`;
2. pushes main; the push is rejected if main moved, so exactly the checked commit is merged;
3. if the PR head moved after the check, closes the PR with a comment naming the merged commit;
4. deletes the head branch (except `claude/factory-log` and `claude/define`, which persist).

Any later push that recreates a deleted item branch raises a tampering alert.

**Once only.** An item is merged at most once: `factory merge` refuses a work-item pull request
whose issue already has a `Factory-Merge: #<issue>` merge on main. Only trailers on Owner-signed
first-parent commits after `baseline` count (§ Signed main history), so no agent-written text
can fake or hide a merge. This makes `ownerMerge` final for the dispatcher and stops a recreated
branch from replaying old approvals into a second merge.

## Approval summary (FR-043)

Every signing command shows a summary before it asks for the passphrase. The command builds each
part itself from signed records, git and GitHub, never from an agent's summary; agent-written
text (issue, spec, reports) is shown as "quoted from <file> at <commit>", and every line has each
Unicode `Cc`, `Cf`, `Zl` and `Zp` character removed except newline (tab included). `approve`
reads the item branch once, at one resolved commit, and refuses a code-gate waiver when the PR
head is another commit. A spec re-approval finds the last approval with main's pinned
`allowed_signers` and `revoked_keys`; when that spec.md blob is not available (after a rebase or
force-push), it shows the full current spec instead of refusing. The list below is the constant
in `src/notify/summary.ts`, pinned with the release.

**R** required (missing → the command refuses) · **—** not applicable · **S** shown when
available, never required: usage comes from `events.jsonl`, which is telemetry, so when it is
missing the summary says "unavailable (telemetry missing)" and goes on.

| Gate | What changed | Spec mapping | Tests and review | Usage spent | Known risks |
|------|--------------|--------------|------------------|-------------|-------------|
| Item approval (`approve <issue>`) | R: the request (issue title and body) | — | — | S: estimate for the proposed lane and weekly headroom left | R: the tier (the proposed `tier:` label or `--tier`); other labels shown only if present |
| Spec approval (`approve <issue> spec`) | R: first approval — Problem and Affected areas; re-approval — `spec.md` diff from the previously approved blob to the one signed | R: each `AC-###` listed; none → refuse | — | S | R: tier; at tier 3 the spec's Risks section (none → refuse) |
| Waiver, pre-build `gate:` | R: target | — | — | S | R: tier |
| Waiver, code `gate:` | R: target; PR head (= the commit read); diffstat since the merge base; after a rebase, the range-diff since the waived head (T151) | R: each `AC-###` → its test tasks | R: the waived gate's result | S | R: tier; what the waiver lets through, computed from the waived check (for `red-green`, the criteria whose tests do not go from failing to passing) |
| Waiver, other targets (`finding:`, `dep:`, `check:`) | R: target | — | — | — | R: what stays unfixed or accepted |
| Merge, item | R: diffstat of the checked head; every changed test file, even when its counts net to zero; every removed, skipped, focused or retried test, removed assertion and changed setup or helper file (AC-061), each with the `test:` waiver that covers it, or "none" | R: each `AC-###` → its tagged tests | R: CI on the checked head; verify report | S | R: tier; open findings; waivers in force |
| Merge, Define / upgrade / log | R: diffstat of the checked head | — | R: the branch's own check: Define output check, manifest equality, append-only | — | R: upgrade — the keys it revokes and the in-flight items whose approvals used them; Define and log — the per-branch check results |
| Deploy | R: items merged since the last deploy | — | R: CI on main's head | S | R: rollback step from the release notes |
| Resume | R: items whose state changed since the pause | — | — | — | R: what was paused, when and by whom (label history), and the alerts raised during the pause |

## Keys and rotation

- **Private keys**: laptop only, `~/.factory/keys/approve_ed25519` (+ `.pub`), passphrase
  required, never in an `ssh-agent`. The path is denied to every role (settings deny + path
  guard, AC-074). The key signs approval records (namespace `factory-approve`) and the Owner's
  git commits and release tags (namespace `git`); SSH signatures are namespace-bound, so one
  kind cannot pass as the other.
- **`allowed_signers`** (in each factory release): every public key the Owner has ever used,
  oldest first, each with `namespaces="factory-approve,git"`. Old keys stay listed so records
  and commits signed with them keep verifying. The **newest key** is the last line not in the
  revocation file.
- **`revoked_keys`** (in each factory release): keys reported compromised; passed to
  `ssh-keygen -Y verify -r`, so everything signed with them fails.
- **Which copy verifies**: always the `allowed_signers` and `revoked_keys` of the release
  pinned **on main**, never a pull request's copy. For `factory new` (no pin yet) the laptop's
  own key list is used.
- **Two-copy check**: the routine's `FACTORY_ALLOWED_SIGNERS` must equal the newest key.
- **Planned rotation**: `factory keygen --rotate` creates a new key and prints the line to add
  to the factory repo's `allowed_signers`; the Owner releases and upgrades. The upgrade merge
  commit is signed with the old key (still pinned). After the merge, the dispatcher sees the
  newest key changed through a signed upgrade merge while the routine variable holds the
  previous key: it enters **key rotation pending** (no session, no transition, one urgent
  alert naming the variable to update), not a tampering state. The laptop is in the same state:
  its second copy is the public half of the key it signs with
  (`~/.factory/keys/approve_ed25519.pub`), still the old one, so `factory merge`, `deploy`,
  `approve` and `resume` refuse with a "finish the rotation" message. The Owner updates the
  routine variable first, then runs `factory keygen --rotate --finish`, which makes the new key
  the signing key, deletes the old private key, and ends rotation-pending on the laptop.
- **Compromise**: the Owner first changes the routine variable (the cloud side then fails the
  two-copy check and halts at once), then releases with the old key in `revoked_keys`;
  `factory upgrade` lists every in-flight item whose approvals were signed with it, for
  re-approval.

## Signed main history

Every commit on main's first-parent history after `baseline` (or from the root, for repos made
by `factory new`) must be signed with a non-revoked Owner key (`git verify-commit` with
`gpg.ssh.allowedSignersFile` = main's pinned `allowed_signers`). Owner commits come only from
`factory new`/`adopt`, `factory merge` and `factory config set`. A merge through the GitHub
button (signed by GitHub, not the Owner) or a direct push fails the rule:

- the dispatcher raises an urgent tampering alert and moves no item;
- `factory merge` and `factory deploy` refuse to run.

The dispatcher fetches main's first-parent history back to `baseline` (cheap for one product
repo). The laptop verifies incrementally from `~/.factory/verified/<repo>` (last verified
commit). The factory repository follows the same rule: its merges go through `factory merge`
(laptop check refusing changes to its own live `.github/workflows/`, `.gitattributes` and
`.gitmodules`, CI green on the checked commit, signed local merge; sources under
`factory/self/` are ordinary reviewed files the Owner copies into place), and its releases are tags signed by `factory release`.

**Merge trailers.** Every merge commit `factory merge` makes ends with `Factory-Merge: <what>`:
`#<issue>` for an item, `define`, `upgrade <tag>` or `factory-log`. Read only from Owner-signed
first-parent commits after `baseline`, they answer two questions without agent-written markers:
whether the brief is merged (admission, § State machine) and whether an item was already merged
(once-only rule, § Pull request merge checks). If a signature, or main's pinned
`allowed_signers` or `revoked_keys`, cannot be checked, the trailer does not count: the brief
counts as not merged, and an item counts as already merged, so `factory merge` refuses. Both
directions fail toward refusing. For the dispatcher, a trailer whose signature or key list
cannot be checked moves no item and raises an alert, as with an unsigned first-parent commit,
so an unverifiable "already merged" never moves an item to `releasing`.

## Pause state (FR-029, FR-029a)

Derived, never stored. Input: inbox issue timeline (`labeled`/`unlabeled` events for
`pause:*`) + resume records in inbox comments.

```text
paused(scope) = ∃ labeled(pause:scope) at t1
                ∧ ¬∃ valid resume record r for scope with r.timestamp > t1
```

A resume record lifts only pauses added before its signed `timestamp`, so reposting an old
record after a new pause never lifts it. The comparison mixes two clocks (the laptop's in the
record, GitHub's on label events), so `factory resume` sets `timestamp` to the later of the
laptop's current time and the latest `pause:<scope>` label-add time plus one second, read from
the inbox timeline before signing. A slow laptop clock therefore cannot produce a resume that
lifts nothing; a fast one only makes the record lift pauses that already exist. `factory resume`
also warns when the laptop clock differs from GitHub's (`Date` header of the API response) by
more than 60 seconds.

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
| `kind` | `tool_call` \| `blocked` \| `gate_result` \| `approval` \| `alert` \| `usage` \| `split` \| `advance_request` \| `owner_comment` \| `cap` | |
| `tool` / `input_summary` | string | Secrets redacted before write |
| `gate` / `pass` / `evidence` | for `gate_result` | |
| `usage` | `{ sessions, est_share }` | FR-035 |

Append-only (R12). Only the log hook and the `log_event` tool add lines, and they fill `ts`
themselves; the path guard denies every role direct writes to `events.jsonl` and
`.factory/events/**`.

**The event log is untrusted telemetry.** Agents with a shell run as the same user as the
hooks, so neither the path guard nor the hook can guarantee who wrote a line or that `ts` is
true. Events feed metrics, the Coach and escalation timing; no merge, deploy or gate decision
on the laptop relies on their content.

## Gate result

An Event with `kind: gate_result`; attempts per station are counted from these.

## Role

`.claude/agents/<role>.md` frontmatter (`name`, `model`, `tools`, `version`) + body.
Permission row in `.claude/settings.json` and in `src/guard/policy.ts` (generated from one
source table, `factory/policy/roles.yaml`). Twelve roles, fixed set.

Each role row has a `branch` field naming where the role may push:

| `branch` | Roles | Allowed push target |
|----------|-------|---------------------|
| `item` | Spec, Planner, Builder, Test, Reviewer, Security, Integrator | The branch in `.station.json` |
| `claude/factory-log` | Release, Ops | `claude/factory-log` only |
| `claude/factory-log` + `coach/<yyyy-Www>` | Coach | `claude/factory-log` in the project; `coach/<yyyy-Www>` in the factory repository only |
| `claude/define` | Define | `claude/define` only |
| `none` | Intake | No pushes, no file writes |

The session-start check requires `.station.json` only for `item` roles; for the others the
guard's allowed push branch is the role's fixed branch.

Against the factory repository the Coach may only push `coach/<yyyy-Www>` and run
`gh pr create --draft --head coach/<yyyy-Www> --repo <factory repo>`. It is the only role given
the factory repository; FR-047 lists it as the Coach routine's one extra repository. Its pull
requests are merged by the Owner with `factory merge` under the factory-repository rule.

## Station manifest

`specs/<feature>/.station.json`, written by the dispatcher before each session; no role may
write it.

```json
{ "item": 42, "station": 4, "role": "builder", "branch": "claude/42-add-login",
  "task": "T007", "files": ["src/auth/login.ts", "tests/unit/login.test.ts"],
  "issued_at": "2026-10-01T09:00:00Z" }
```

## Guardrail manifest

`guardrails.manifest.json` in each factory release, built and signed into the tag by
`factory release`: `{ "release": "v1.0.0", "commit": "<sha>", "files": { "<path>": "<sha256>" } }`.

Protected paths (refused in any item or Define pull request):

- hashed against the manifest: `.claude/**`, `.mcp.json`, `.claude/hooks/**`,
  `.github/workflows/**`, `.specify/memory/constitution.md`, `.factory/lockfile-policy`;
- not hashed (content is per project or must never appear): `.factory/config` (rules in
  § Project config), and `.gitattributes` / `.gitmodules` anywhere in the tree (files already
  on main, for example in an adopted repo, stay allowed; pull requests may not add, change or
  delete them).

CI never runs the project's own test, lint or scan configuration: workflows call
`factory ci test|coverage|lint|scan|red-green`, built from the pinned release commit, with the
configs, thresholds and test-path patterns shipped in that release
(`factory/profiles/typescript/ci/`). The project's own configs are for local development only.

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
