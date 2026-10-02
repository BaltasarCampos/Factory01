# Feature Specification: Software Factory v1

**Feature Branch**: `001-software-factory`

**Created**: 2026-10-01

**Status**: Approved

**Work item**: Owner-authored source document `software-factory-spec-v1.5.txt` ("Software Factory — Specification v1.5 (kill switch)", derived from "Software Factory — Design v1.5"; companion constitution 2.4.0). Originally generated from v1.2; updated to v1.5 on 2026-10-01. No GitHub issue yet.

**Risk tier**: 3 — High (the factory defines permission rules, guardrail protection and the merge/release path for every project; agents MUST NOT lower it)

**Owner approval**: Approved by the Owner on 2026-10-01, including the "Risks" section (recorded in chat; signed approvals do not exist yet; see plan Complexity Tracking #2). Amended to spec v1.6 on 2026-10-02 (Clarifications § Session 2026-10-02), agreed by the Owner in chat.

**Input**: User description: "take software-factory-spec-v1.2.txt as source for generating this spec"

**Traceability**: Each requirement below cites the source requirement it derives from as `[src X]`, for example `[src FR-3.6]`. Source IDs remain the stable cross-reference; the `FR-###` IDs here are this spec's own. Unless marked otherwise, `[src …]` refers to source v1.5. Requirements first added by the 2026-10-01 clarifications and later adopted by source v1.5 cite both. Requirements added or changed on 2026-10-02 cite `[clarified 2026-10-02]`; they go beyond source v1.5, and the next source revision should adopt them.

## Clarifications

### Session 2026-10-01

- Q: Since agents can never write to main, which branch holds a work item's feature folder and its append-only event log from the moment Intake starts the item? → A: One branch per item, `claude/<issue>-<slug>`, created by the dispatcher (not an agent) when the Owner approves the item; its folder is `specs/<issue>-<slug>/`. The dispatcher names the branch in every station prompt for stations 2–6. One draft pull request per item is opened at Specify and carries spec approval, CI, reports and the Owner's merge, which brings code and full trail into main together. One item = one branch = one PR; work too big for one PR is split by the Planner into several work items. Intake logs to issue comments, which the dispatcher copies as the first lines of `specs/<feature>/events.jsonl` when it creates the branch. Post-merge events, release notes, `.factory/ops/` and lessons go to one long-lived data branch, `claude/factory-log`, written only through the log-event control operation; CI rejects any push that edits or deletes existing lines; the Owner merges it into main weekly when reviewing Coach proposals.
- Q: Should the Owner's `approved` label keep that name, with the post-spec-approval state renamed? → A: Yes, and every label kind gets its own prefix: `owner:` gate labels (`owner:approved`, `owner:spec-approved`, `owner:waiver`) set only by the Owner via `factory approve`; `state:` labels set only by the dispatcher via advance-item; `tier:` labels proposed by Intake and confirmed by the Owner at item approval. Each gate passes only on its own label, never inferred from a state or another gate's label; the tier 1 skim exception applies only to an Owner-confirmed `tier:1`. Because agents act on GitHub as the Owner, a label cannot prove who set it: the command guard blocks agents from adding or removing any `owner:`/`state:` label; `factory approve <issue> [spec|waiver]` runs only on the laptop, applies the label and records the approval; the dispatcher accepts an `owner:` label only with a matching approval record, and otherwise stops the item as tampered and alerts the Owner.
- Q: What makes a `factory approve` record impossible for an agent to forge, while the cloud routine can still check it? → A: A digital signature. A passphrase-protected ed25519 SSH key used only for approvals is kept on the laptop alone, and agents are denied its path. The public key is published in the pinned factory release (`allowed_signers`) and in an Owner-only environment variable on the cloud routine; the two copies must match. `factory approve` signs (with `ssh-keygen -Y sign`) the repo, issue, gate, confirmed tier, item branch, the `spec.md` commit hash for spec approval, a timestamp and a nonce, so a record verifies for one item and one spec version only and can be stored anywhere. `factory dispatch` verifies with `ssh-keygen -Y verify` as plain code, deciding by exit code. A second check runs on the laptop: the Owner merges with `factory merge <pr>` and deploys with `factory deploy`, and both re-verify the item's whole approval chain. Residual risks are accepted: local mode relies on the passphrase (a hardware key is optional); a key rotation needs both `factory upgrade` and the routine variable; the GitHub merge button remains, so the dispatcher flags any merge without a matching verification record.
- Q: Where does Define's output live before the Owner approves it, given agents cannot push to main? → A: On a dispatcher-named branch `claude/define` with one draft pull request; the Owner's merge of that pull request approves the brief and skeleton. Release, Ops and Coach push only to `claude/factory-log`; Intake pushes nothing. (Added during `/speckit-analyze` remediation.)
- Q: How is `factory deploy` protected from an agent sharing the laptop in local mode? → A: Like approvals: it asks for the signing key's passphrase and signs a `deployed` record before pulling main, and the command guard blocks agents from invoking any Owner-only `factory` command or `ssh-keygen -Y sign`.
- Q: How should the factory reach the Owner when the spec says "notify at once" or "alert the Owner"? → A: Every alert is written to a pinned "Owner inbox" issue (the record); urgent alerts also fail a dedicated `owner-alert` CI job so GitHub emails the Owner; every `factory` command on the laptop shows unread alerts first.
- Q: Where does the kill-switch label live, and who may set or remove it? → A: `pause:line` or `pause:<station>` labels on the pinned Owner inbox issue (a `pause:` prefix, not `owner:`, so `owner:` always means a signed approval). Anyone may add a pause — the Owner (GitHub app/web, or `factory pause [station]`) or any agent (e.g. Security or Ops on a secret leak). Only `factory resume [station]` ends one, by signing a record (scope, timestamp, nonce) and then removing the label. The dispatcher derives pause state from the issue's label history: a scope is paused if a `pause:` label for it was ever added with no later valid signed resume; a label removed without one is put back and the Owner alerted. Whole-line pause: the routine exits at once, no new sessions start, advance-item refuses every move, running sessions finish their step but cannot advance. Station pause: items wait on reaching it. `factory merge`/`factory deploy` warn during a pause and ask the Owner to confirm. A single item is paused with `state:blocked`.

### Session 2026-10-02

These answers supersede the 2026-10-01 answers where they differ (the "used only for approvals" key, the merge-verification record, and flagging merges by record).

- Q: Can CI results be trusted when deciding a merge? → A: Only after `factory merge` has checked on the laptop that the pull request touches no protected file, because a `pull_request` run uses the PR's own workflow files. CI then builds the `factory` CLI from the release commit pinned on main and runs every check through it, with the release's configs, thresholds and test-path patterns, never the project's own scripts or configs.
- Q: How does `factory merge` decide what may be merged? → A: It computes its own checks on the laptop for every pull request, with a diff that ignores renames, external diff tools, text filters and `.gitattributes`. Item and Define PRs that touch a protected path, `.gitattributes`, `.gitmodules` or `.factory/config` are refused outright. Upgrade PRs must equal the manifest of a release tag the Owner signed. `claude/factory-log` PRs may only append lines at the end of regular text files under `.factory/events/`, `.factory/ops/`, `.factory/lessons/` and `.factory/releases/`. It then makes a signed merge commit of exactly the commit it checked, pushes main, closes the PR if its head moved, and deletes the item branch; it refuses while a session for the item is running.
- Q: What proves the Owner merged? → A: Every commit on main's first-parent history must be signed with the Owner's key (git SSH signing). That replaces the `merged` record and the "flag merges without a record" rule: a GitHub-button merge or a direct push leaves an unsigned commit, which stops the dispatcher and makes `factory merge` and `factory deploy` refuse. Adopted repos record their last unsigned commit as `baseline`; `factory new` starts from a signed root commit. `.factory/config` changes only through `factory config set` (a signed commit on main) or the pin line of an upgrade.
- Q: How are releases pinned and trusted? → A: Projects pin `<tag>@<sha>`. The Owner signs each release tag on the laptop with `factory release`, after reviewing the diff since the last signed tag. `factory upgrade` refuses an unsigned or wrongly signed tag; the upgrade waiver names `<tag>@<sha>`. The factory repository's own merges also go through `factory merge`.
- Q: How do key rotation and key compromise work? → A: The release's `allowed_signers` lists every key ever used, so old records keep verifying; compromised keys go into a `revoked_keys` file read by `ssh-keygen -Y verify -r`. Records are always checked against main's pinned copy, never a PR's. The routine's variable must equal the newest key; after an upgrade that adds a key, the dispatcher stays stopped in "key rotation pending" until the Owner updates it. On compromise the Owner changes the routine variable first, which halts the cloud side at once, then releases a revocation.
- Q: Can the event log decide anything? → A: No. Agents with a shell run as the same user as the hooks, so the event log is untrusted telemetry for metrics, the Coach and escalation timing. "Tests seen failing first" is proven by a CI check instead: every acceptance criterion needs a tagged test that fails at the merge base and passes at the head; test-only diffs skip it; refactors need a waiver bound to the head commit. Gate waivers stop counting when the head changes.

## User Scenarios & Testing *(mandatory)*

The single user is **the Owner**: the one human who is product owner, code owner and on-call
for every product the factory builds [src C-1]. The Owner sets intent and approves every spec
(tier 2–3), merge and release; agent roles do everything else.

Stories follow the source roadmap: P1 stories together make up Phase 0 (Gate A: "a sample pitch
runs end to end"), P2 stories make up Phases 1–2, and P3 stories make up Phase 3.

### User Story 1 - Start a project from a pitch (Priority: P1)

The Owner types a pitch of a few sentences, or points the factory at an existing repository.
The factory reminds the Owner that agents will clone the code into cloud VMs, records the
Owner's choice of cloud or local agents, creates (or attaches to) a private project
repository, and installs every guardrail file from the pinned factory release. The Define role
then asks its clarifying questions in one batch and produces a product brief, a walking
skeleton that runs and deploys, and a seed backlog of 5–10 issues. Nothing enters the line
until the Owner approves the brief and the backlog.

**Why this priority**: Without a project, a brief and a backlog there is nothing for the line
to work on. This is the entry point of every product.

**Independent Test**: Run "new" with a sample pitch on a throwaway project. Check that the
consent prompt appears, that the config records the choice, that guardrail files match the
pinned release, that Define asks questions before writing anything, and that the seed issues
stay out of the line until the Owner approves them.

**Acceptance Scenarios**:

1. **AC-001** — **Given** the Owner runs "new" with a pitch, **When** the command starts, **Then** before anything is created the Owner is told that agents will clone the project's code into provider-managed cloud VMs, and is asked to choose cloud or local; the answer is saved in the project config.
2. **AC-002** — **Given** a project config without a cloud/local setting, **When** the dispatcher is asked to start a cloud session for it, **Then** it refuses and tells the Owner why.
3. **AC-003** — **Given** consent is recorded, **When** "new" or "adopt" completes, **Then** the project repository is private and contains the factory config (with the pinned release), the constitution and every other guardrail file byte-identical to the pinned release, the project labels and the CI workflows, a pinned Owner inbox issue, and a working copy exists on the laptop.
4. **AC-004** — **Given** a fresh project, **When** Define runs, **Then** it asks between 1 and 5 clarifying questions in a single batch before producing any output, and its brief contains no statement that is not traceable to the pitch, the existing code or an Owner answer.
5. **AC-005** — **Given** the Owner has answered, **When** Define finishes, **Then** the project contains a brief with problem, users, core use cases, non-goals, success measures and risk areas; a walking skeleton that runs, has one passing test, passes CI and deploys on the laptop; and 5–10 issues, each with a risk tier.
6. **AC-006** — **Given** the brief and seed issues exist but are not approved, **When** the line runs, **Then** no seed issue is picked up; **When** the Owner approves (by merging Define's `claude/define` pull request and approving the seed issues), **Then** the issues move into Intake.
7. **AC-007** — **Given** an existing repository, **When** the Owner runs "adopt", **Then** the same consent, installation and Define steps run, with the existing code as Define's input.

---

### User Story 2 - Ship one work item through the line (Priority: P1)

The Owner files (or approves) a small work item. The line triages it, writes a spec, plans
tasks with tests first, builds on a separate branch, verifies with CI, scans and an
independent review, rebases, and asks the Owner to merge. After the merge, the Release role
writes release notes and a rollback path, and the Owner deploys with a single command that
reports the app's health. At every Owner gate the Owner sees a short summary.

**Why this priority**: This is the factory's core value: a request becomes reviewed, tested,
deployed software with the Owner only approving. Gate A requires it.

**Independent Test**: On the sample project, file one tier 1 item and run the line to a
deployed release. Check that every station leaves its hand-off file, every gate is enforced,
and the item can be traced from request to deployment.

**Acceptance Scenarios**:

1. **AC-008** — **Given** an issue neither authored nor approved by the Owner, **When** the line runs, **Then** the item is not picked up, in any repository.
2. **AC-009** — **Given** an Owner-approved item, **When** Intake runs, **Then** the item gets a type, priority and risk tier, and a duplicate of an existing item is marked as such instead of entering the line twice.
3. **AC-010** — **Given** a triaged item, **When** Specify runs, **Then** a spec exists with problem, acceptance criteria, non-goals and affected areas, and each acceptance criterion is testable; tier 2–3 specs wait for Owner approval (`owner:spec-approved`); only items whose `tier:1` the Owner confirmed skip that wait and are presented to the Owner to skim.
4. **AC-011** — **Given** an approved spec, **When** Plan runs, **Then** every task is under the size limit and lists the files it may touch, every acceptance criterion maps to at least one test, and test tasks come before implementation tasks.
5. **AC-012** — **Given** a planned task, **When** Build runs, **Then** its commits land on the item's own branch `claude/<issue>-<slug>` (never on main or any other branch), each acceptance criterion's tagged tests fail at the merge base and pass at the head (the red-green check, FR-042), and the commits appear on the item's draft pull request (opened at Specify, FR-016a).
6. **AC-013** — **Given** a pull request, **When** Verify runs, **Then** a verification report is attached that shows CI green, changed-line coverage ≥ 90%, clean static-analysis, vulnerability, secret and licence scans, and an independent review whose blocking findings are resolved; if any of these fails the item does not move on.
7. **AC-014** — **Given** a verified branch, **When** Integrate runs, **Then** the branch is rebased on main with CI green, and only the Owner can merge it, through `factory merge`, which first re-verifies the item's signed approvals and its own laptop checks, then makes an Owner-signed merge commit of exactly the commit it checked.
8. **AC-015** — **Given** a merge to main, **When** Release runs, **Then** release notes and a rollback path exist; **When** the Owner runs the deploy command, **Then** it asks for the passphrase and signs a `deployed` record, re-verifies the signed approvals of every item it ships and refuses on any failure, and only then main is pulled, built and restarted on the laptop and a health summary is written; no agent can trigger a deploy.
9. **AC-016** — **Given** any Owner gate, **When** approval is requested, **Then** the request includes what changed, how it maps to the spec, test and review results, usage spent and known risks.
10. **AC-017** — **Given** a deployed change, **When** the Owner looks it up, **Then** the request, spec, plan, tasks, commits, review, tests and release can be followed in both directions, and each agent commit names its role and work item.

---

### User Story 3 - Guardrails hold without supervision (Priority: P1)

The Owner trusts the line to run with the laptop closed because each agent role can only do
its own job. Roles are limited to their tools, folders and commands; no role can both write
and approve; guardrail files cannot be changed by any agent; nothing can be pushed or merged
to main except by the Owner; secrets never reach an agent; and text in issues, code or tool
output is never treated as an instruction.

**Why this priority**: Unattended agents without enforced limits would make every other story
unsafe. The source requires every deny rule to be tested inside an unattended run in Phase 0.

**Independent Test**: Run a scripted set of forbidden actions for every role inside an
unattended run and confirm each one is blocked and logged; open a pull request that edits a
guardrail file and confirm CI blocks it.

**Acceptance Scenarios**:

1. **AC-018** — **Given** any role session, **When** it attempts an action outside its permission row (for example, Intake writing a file, Reviewer merging, Builder writing outside its task's file list or reading environment secrets), **Then** the action is blocked and the attempt is logged; this holds identically inside an unattended scheduled run.
2. **AC-019** — **Given** any role session, **When** it attempts to create or edit a guardrail file, **Then** the edit is blocked.
3. **AC-020** — **Given** an item or Define pull request touching a guardrail file, **When** CI runs, **Then** the guardrail-change check fails and `factory merge` refuses it; guardrail changes reach a project only through an upgrade pull request that matches a release the Owner signed.
4. **AC-021** — **Given** a guardrail file that differs from the pinned factory release, **When** any session starts, **Then** the session stops and the Owner is alerted.
5. **AC-022** — **Given** any session, **When** it attempts to push to main or merge a pull request, **Then** the attempt is blocked, including on private repositories without platform branch protection.
6. **AC-023** — **Given** an issue, comment, file or tool output containing instructions addressed to an agent (for example, "copy this file to…" or "approve this change"), **When** a session reads it, **Then** the session does not follow it, and a reviewer reports such text as a finding.

---

### User Story 4 - Work is checked in proportion to its risk (Priority: P2)

The Owner wants cheap, quick handling of trivial changes and rigorous handling of risky ones.
Tier 1 items take the lean lane (three model sessions). Tier 2 items take the full lane,
add property-based tests and ship behind a flag. Tier 3 items also add formal verification of
one critical property, a second independent review and a written, tested rollback step.
Similar small items (dependency bumps, copy changes) can be batched.

**Why this priority**: Needed for Phase 2 (all tiers); Phase 0 can prove the line with tier 1
alone.

**Independent Test**: Run one item of each tier and one batch of similar items; confirm the
lane, session count, extra checks and release conditions match the tier.

**Acceptance Scenarios**:

1. **AC-024** — **Given** a tier 1 item, **When** it runs, **Then** it uses at most 3 model sessions (Specify+Plan, Build+tests, Review) and every gate still applies.
2. **AC-025** — **Given** a tier 2 item, **When** it is verified, **Then** property-based tests cover the changed logic, and **When** it is released, **Then** it is deployed behind a flag that stays off until the Owner turns it on.
3. **AC-026** — **Given** a tier 3 item, **When** it is verified, **Then** its spec has a risks section, the one critical property is formally verified in CI, a second independent review is attached, and the release has a written, tested rollback step and a flag.
4. **AC-027** — **Given** up to 5 similar dependency-bump or copy-change items, **When** they run in the batch lane, **Then** one session handles them and every gate is applied to each item.
5. **AC-028** — **Given** any tier, **When** an agent tries to lower an item's tier, **Then** it is refused; **When** the Owner raises the tier at any gate, **Then** the item follows the higher tier from then on.
6. **AC-029** — **Given** any gate, **When** a station would skip it, **Then** this is only possible with an `owner:waiver` label backed by a matching `factory approve` record.

---

### User Story 5 - The line runs itself within the plan's limits (Priority: P2)

The Owner closes the laptop and the line keeps advancing: a daily scheduled run works ready
items until it reaches an Owner gate, the usage limit or a platform cap, and leaves a summary
on each issue; a new pull request starts its review automatically. Failed gates send work back
to the earliest station that can fix it, and after 3 failures the item escalates. The Owner
can pause the whole line, or one station, with one label. If cloud sessions are unavailable,
the same stations run locally.

**Why this priority**: Needed to reach 3–5 items per week without the Owner driving each step,
but Phase 0 can run on demand.

**Independent Test**: Schedule a daily run on the sample project with items at different
states; confirm it stops at Owner gates, caps and the kill switch, and leaves summaries.

**Acceptance Scenarios**:

1. **AC-030** — **Given** ready items and the laptop closed, **When** the daily run fires, **Then** it advances items one station at a time until an Owner gate, the usage limit or a cap, and leaves a summary on each issue it touched.
2. **AC-031** — **Given** a pull request is opened, **When** the trigger fires, **Then** the review starts without Owner action.
3. **AC-032** — **Given** a gate fails, **When** the line reacts, **Then** the item goes back to the earliest station that can fix it with the failure report; **When** it fails a third time, **Then** it moves to "escalated" and the Owner is notified with evidence.
4. **AC-033** — **Given** a station needs an Owner answer, **When** it asks, **Then** the item moves to "blocked" and no usage is consumed until the Owner answers.
5. **AC-034** — **Given** `pause:line` (or `pause:<station>`) was added to the Owner inbox issue with no later signed resume, **When** the dispatcher runs, **Then** no new session starts and no item advances for the line (or no item enters that station while others keep moving).
6. **AC-035** — **Given** a scheduled-run or trigger cap is reached, **When** the dispatcher runs, **Then** it stops cleanly, records why, and resumes on the next allowed run without losing work.
7. **AC-036** — **Given** a session nears the usage limit, **When** this is detected, **Then** the session stops and escalates instead of continuing with reduced quality.
8. **AC-037** — **Given** a session nears its context limit or compacts once, **When** this happens, **Then** it hands the task back to Plan to be split and stops.
9. **AC-038** — **Given** a project set to local agents, or cloud sessions unavailable, **When** the line runs, **Then** the same station prompts run locally on the laptop, one at a time.
10. **AC-039** — **Given** a station is about to wait on the Owner, **When** it pauses, **Then** its result is already written to the repository or the issue, so reclaiming the idle session loses nothing.

---

### User Story 6 - Security findings are fixed through the line (Priority: P2)

Scanner findings and dependency alerts become deduplicated security issues. Once the Owner
approves one, it is fixed with a regression test and re-scanned before the Owner reviews it.
Critical and high findings notify the Owner at once and jump the queue. False positives are
dismissed only with a written reason and Owner approval. A leaked secret pauses the line.

**Why this priority**: Required for routine maintenance in v1 scope, but not for Gate A.

**Independent Test**: Introduce a known vulnerable dependency and a known false positive in
the sample project; confirm issue creation, deduplication, fix with regression test, re-scan,
and a recorded dismissal.

**Acceptance Scenarios**:

1. **AC-040** — **Given** a finding from CI, the weekly scan or a dependency alert, **When** Intake files it, **Then** one issue labelled "security" exists per rule and location; a repeat finding does not create a second issue.
2. **AC-041** — **Given** a critical or high finding, **When** it is filed, **Then** the Owner is notified at once, and once approved it takes the full lane ahead of other queued items.
3. **AC-042** — **Given** an approved security item, **When** it is fixed, **Then** the change includes a regression test that reproduces the finding, and the Security role re-runs the scanner on the branch showing the finding gone before Owner review.
4. **AC-043** — **Given** a false positive, **When** it is dismissed, **Then** the dismissal record contains the Security role's written reason, the Owner's approval and a re-check date; the Security role cannot dismiss its own finding alone.
5. **AC-044** — **Given** a secret leak is detected, **When** the line reacts, **Then** the line pauses, the Owner is asked to rotate the secret, and an incident note records the cause and the new check that would have caught it.
6. **AC-045** — **Given** a pull request adds a dependency, **When** the new-dependency gate runs, **Then** it checks that the package exists, is not a near-name of a popular package, and has real age and usage, and the dependency waits for Owner approval.

---

### User Story 7 - The Owner sees how the line and the product are doing (Priority: P3)

The Ops role reads deploy health summaries and the event log, files incidents as new work
items, writes incident notes, and produces a weekly metrics report: lead time, throughput by
tier, autonomy rate, first-pass gate rate per station, escaped defects, Owner review minutes,
plan usage per item, change failure rate and time to restore.

**Why this priority**: Needed for Phase 3 and to set targets after a baseline month.

**Independent Test**: Run a week of sample activity with one unhealthy deploy; confirm an
incident issue and note exist and the weekly report contains every listed metric.

**Acceptance Scenarios**:

1. **AC-046** — **Given** a deploy whose health summary shows a failure, **When** Ops runs, **Then** an incident is filed at Intake and an incident note is written.
2. **AC-047** — **Given** a week of activity, **When** the weekly report is produced, **Then** it reports every metric listed above, with first-pass gate rate per station and per role version, and the plan usage per shipped item.
3. **AC-048** — **Given** any work item, **When** its event log is read, **Then** it contains, for every session, the station, inputs, outputs, model, tool calls, gate results and usage, in append-only order.

---

### User Story 8 - The factory learns from its own work, safely (Priority: P3)

Weekly, the Coach reads the event log and Owner review comments, writes lessons per role, and
proposes changes to role instructions, checklists, skills or lint rules as pull requests to the
factory repository (role files are guardrail files in every project, so changes reach projects
only through "upgrade").
Each proposal is replayed on a benchmark of past items and is adopted only if it does not
lower the first-pass gate rate and the Owner approves it. The Coach can never touch gates,
permissions, budgets, guardrails or the constitution, and cannot shrink the benchmark.

**Why this priority**: Phase 3; depends on enough history to learn from.

**Independent Test**: Seed the log with a repeated failure; confirm the Coach opens a pull
request with an instruction change and a benchmark result, and that a Coach change touching a
gate or removing a benchmark item is refused.

**Acceptance Scenarios**:

1. **AC-049** — **Given** a week of events, **When** the Coach runs, **Then** it writes lessons per role (what failed, what the Owner corrected, what repeated) to `.factory/lessons/` on `claude/factory-log`, and opens any proposed role-file, checklist, skill or lint-rule change as a pull request to the factory repository.
2. **AC-050** — **Given** a Coach proposal, **When** it is evaluated, **Then** the changed role is replayed on the benchmark and the result shows whether first-pass gate rate is kept; a proposal that lowers it is not presented as adoptable.
3. **AC-051** — **Given** a Coach change, **When** it touches gates, permissions, budgets, guardrail files, the constitution or removes/edits a benchmark item, **Then** it is blocked; only the Owner retires a benchmark item, in a separate change.
4. **AC-052** — **Given** an adopted role change causes a regression, **When** the Owner reverts, **Then** the previous role version is restored in one step.
5. **AC-053** — **Given** a lesson that applies beyond the project, **When** it is proposed to the public factory repository, **Then** it contains no project code, brief details or benchmark items, and waits for the Owner's check.

---

### User Story 9 - Projects move to new factory releases deliberately (Priority: P3)

Each project runs a pinned factory release. When the Owner wants a newer release, "upgrade"
proposes it as a pull request the Owner approves; outside contributions to the public factory
repository never trigger agents.

**Why this priority**: Needed once more than one release exists.

**Independent Test**: Tag a second factory release that changes a role file and a guardrail
file; run "upgrade" on the sample project and confirm a single Owner-approvable pull request.

**Acceptance Scenarios**:

1. **AC-054** — **Given** a project pinned to release N, **When** the Owner runs "upgrade" to N+1, **Then** one pull request contains the updated guardrail and factory files of the Owner-signed release N+1 and the new pin `<tag>@<sha>`, and nothing changes until the Owner merges it with `factory merge`.
2. **AC-055** — **Given** an issue or pull request on the public factory repository from anyone other than the Owner, **When** the line runs, **Then** no agent acts on it.

---

### Edge Cases

- **AC-056** — A Define session receives a pitch with no gaps: it still asks at least one confirming question and does not proceed without the Owner's answer.
- **AC-057** — A task grows beyond the size limit during Build: the Builder hands it back to Plan, which splits the work into several work items (each with its own branch and pull request) instead of opening an oversized pull request.
- **AC-065** — A push to `claude/factory-log` edits or deletes an existing line or file: CI rejects it; only additions pass.
- **AC-066** — An item is approved: the dispatcher creates `claude/<issue>-<slug>` and copies the Intake issue-comment events into `specs/<issue>-<slug>/events.jsonl` as its first lines; no agent session creates a work-item branch.
- **AC-067** — An agent session tries to add or remove any `owner:` or `state:` label: the command guard blocks it and logs the attempt.
- **AC-068** — An `owner:` label appears on an issue with no matching `factory approve` record: the dispatcher stops the item, treats it as tampering and alerts the Owner.
- **AC-069** — Intake proposes `tier:1` but the Owner has not confirmed it: the spec still waits for `owner:spec-approved`.
- **AC-070** — A valid approval record is copied from one item to another, or its content is edited: signature verification fails and the dispatcher treats the label as tampering.
- **AC-079** — A valid approval or resume record is submitted a second time (replay): its one-time nonce has already been used, so both the dispatcher and `factory merge` reject it.
- **AC-080** — An agent session tries to push to a `claude/` branch other than the one named in its station prompt: the command guard blocks it and logs the attempt.
- **AC-071** — `spec.md` changes after `owner:spec-approved` was signed: the approval no longer verifies and the item waits for a fresh spec approval.
- **AC-072** — The newest key in the pinned release's `allowed_signers` and the routine's environment-variable key differ (outside a pending rotation): verification fails for every record and the dispatcher stops and alerts the Owner.
- **AC-073** — A pull request is merged with the GitHub button instead of `factory merge`: the merge commit is not signed by the Owner, so the dispatcher raises a tampering alert and moves no item, and `factory merge` and `factory deploy` refuse to run (AC-087).
- **AC-081** — A `claude/factory-log` pull request adds a file outside `.factory/events/`, `.factory/ops/`, `.factory/lessons/` and `.factory/releases/` (for example a source file or a workflow): `factory merge` refuses it, whatever CI reports.
- **AC-082** — A `claude/factory-log` pull request contains a binary file, a symlink, an executable bit, a gitlink, a `.git*` file, a renamed file, or a line inserted before existing lines of a file: `factory merge` refuses it.
- **AC-083** — An upgrade pull request whose protected files differ from the manifest of the named release, or whose tag is unsigned, signed by an unknown or revoked key, or now resolves to another commit: `factory merge` refuses it even with a signed waiver.
- **AC-084** — A release adds a new Owner key: the upgrade's waiver and merge commit verify with main's currently pinned keys; after the merge, until the routine's variable equals the newest key, the dispatcher stays stopped in "key rotation pending" with one urgent alert and no tampering escalation; records signed with older keys keep verifying.
- **AC-085** — A release lists a key in `revoked_keys`: every record and commit signed with it fails verification, and `factory upgrade` lists the in-flight items that need re-approval.
- **AC-086** — An item or Define pull request touches a protected path, `.gitattributes`, `.gitmodules` or `.factory/config`: `factory merge` refuses it outright; no waiver allows it.
- **AC-087** — A commit on main's first-parent history after the baseline is not signed by a non-revoked Owner key: the dispatcher raises an urgent tampering alert and moves no item; `factory merge` and `factory deploy` refuse to run.
- **AC-088** — An item's PR head moves after `factory merge` checked it: only the checked commit is merged, the PR is closed with a comment naming the merged commit, and the item branch is deleted; a later push that recreates the branch raises a tampering alert. `factory merge` refuses while a session for that item is still running.
- **AC-089** — A checked acceptance criterion (FR-042) has no tagged test, or its tagged tests already pass at the merge base: `ci / red-green` fails; on a tier 1 branch, deleting the criterion from `spec.md` does not remove it from the check without an Owner waiver. A diff touching only the release's test paths skips the check; a refactor passes only with a `gate:red-green` waiver whose `head` is the current head, and a waiver for an older head does not count.
- **AC-090** — A session starts on a branch whose own commits changed `.factory/config` (relative to its merge base with main): the session is blocked and the Owner alerted; a branch created before an upgrade or a config change still starts sessions and picks up the change at Integrate's rebase; the Owner changes config only with `factory config set`, which makes a signed commit on main.
- **AC-074** — An agent session tries to read the approval-key path: the action is blocked and logged.
- **AC-075** — An urgent alert is raised (for example a critical finding or a tampered label): an entry appears in the pinned "Owner inbox" issue, the `owner-alert` CI job fails so GitHub emails the Owner, and the next `factory` command on the laptop shows the alert first.
- **AC-076** — A `pause:` label is removed from the Owner inbox issue without a signed `factory resume` record for that scope: the dispatcher re-applies it, keeps the scope paused and alerts the Owner.
- **AC-077** — An agent adds `pause:line`: the line pauses at once; only a signed `factory resume` ends it.
- **AC-078** — The Owner runs `factory merge` or `factory deploy` during a pause: the command warns and proceeds only after the Owner confirms.
- **AC-058** — A rebase in Integrate produces conflicts that cannot be resolved without changing behavior: the item goes back to Build with the conflict report; it is never merged with unverified conflict resolutions.
- **AC-059** — Two Owner-approved items are ready at once: the dispatcher runs one session at a time unless the Owner has approved parallel sessions.
- **AC-060** — A deploy leaves the app unhealthy: the health summary says so and the documented rollback path is offered to the Owner.
- **AC-061** — A flaky test is detected: it is fixed or quarantined with an Owner-visible issue; no agent deletes, weakens or skips it without Owner approval.
- **AC-062** — The weekly scan finds the same issue already open: the existing issue is updated, not duplicated.
- **AC-063** — A station's stop check finds its output file missing or incomplete: the session continues instead of ending.
- **AC-064** — The Owner revises the product vision: Define re-runs and its new backlog again waits for Owner approval.

## Requirements *(mandatory)*

### Functional Requirements

**Repositories and the factory command**

- **FR-001**: The factory MUST consist of one public, reusable factory repository (MIT) holding generic material only, one private project repository per product, and one private benchmark repository; project code, briefs, lessons and benchmark items MUST never be placed in the public repository. [src FR-3.1–3.3, SEC-0.7]
- **FR-002**: The factory MUST be installable once on the laptop and provide one "factory" command. [src FR-3.4]
- **FR-003**: "new" MUST create a private project repository from a pitch; "adopt" MUST attach to an existing repository. Both MUST, after cloud consent, initialize the spec workflow, write the project config, install every guardrail file from the pinned release, install project labels and CI workflows, create the pinned Owner inbox issue (FR-034a), and set up the laptop working copy. [src FR-3.5, FR-8.24]
- **FR-004**: "new" and "adopt" MUST show the cloud-cloning reminder and record the Owner's cloud/local choice before creating anything; the dispatcher MUST NOT start a cloud session for a project lacking that setting. [src FR-3.6, FR-9.4]
- **FR-005**: "run" MUST work the project backlog through stations 1–8. [src FR-3.7]
- **FR-006**: "upgrade" MUST deliver a new factory release to a project only as an Owner-approved pull request; each project MUST pin the release it runs as `<tag>@<sha>`; "upgrade" MUST refuse a tag that is not signed by a non-revoked Owner key in main's pinned `allowed_signers`, and MUST list in-flight items whose approvals use a key the new release revokes. [src FR-3.8, SEC-2.2; clarified 2026-10-02]
- **FR-007**: "deploy" MUST run only on the laptop, ask for the signing key's passphrase and sign a `deployed` record naming the main commit it deploys, and MUST first refuse if main's first-parent history has an unsigned commit (FR-016g) and re-verify the signed approvals of every item it ships (FR-016f), then pull main, build, restart the app on the laptop and write a health summary; only the Owner runs it, and running it is the release approval. [src FR-3.9, FR-8.21, SEC-0.1]
- **FR-007a**: "approve `<issue|pr>` [spec | waiver `<waives>`]" MUST run only on the laptop; it asks for the signing key's passphrase, signs an approval record (FR-016e), applies the matching `owner:` label (with no argument, `owner:approved`, confirming the item's `tier:`; with `waiver`, the target forms of the data model's waiver table), and posts the signed record as an issue comment and in the item's event log (FR-016d). [src FR-3.11; clarified 2026-10-01, 2026-10-02]
- **FR-007b**: "merge `<pr>`" MUST run only on the laptop and is the only merge path, for project and factory repositories alike. It MUST compute its own checks for the pull request's head branch (in a project: item, Define, upgrade or `claude/factory-log`, any other refused; in the factory repository: any branch, under the factory-repository rule) with a diff that ignores renames, external diff tools, text filters and `.gitattributes`; for an item, re-verify the chain of signed approvals; require the CI checks green on the checked commit; then make an Owner-signed merge commit of exactly that commit and push main. It MUST refuse while a session for the item is running, close the pull request if its head moved after the check, and delete the merged item branch; on any failure it MUST refuse and report why. [src FR-3.12; clarified 2026-10-01, 2026-10-02]
- **FR-007c**: "pause [station]" MUST add `pause:line` (no argument) or `pause:<station>` to the Owner inbox issue; it needs no signature. [src FR-3.13]
- **FR-007d**: "resume [station]" MUST run only on the laptop; it asks for the signing key's passphrase, signs a resume record (FR-029), posts it to the Owner inbox issue and then removes the pause label. Because the record's timestamp (laptop clock) is compared with GitHub's label times, "resume" MUST read the latest `pause:<scope>` label-add time from the inbox timeline and set the timestamp to the later of the laptop's current time and that time plus one second, and MUST warn when the laptop clock differs from GitHub's by more than 60 seconds. [src FR-3.14; clarified 2026-10-02]
- **FR-007e**: "release `<tag>`" MUST run only on the laptop in the factory repository; it MUST show the diff since the last signed tag and ask the Owner to confirm, build the guardrail manifest, and create the tag signed with the Owner's key. CI MUST NOT create or sign release tags. [clarified 2026-10-02]
- **FR-007f**: "config set `<key>` `<value>`" MUST run only on the laptop and change one `.factory/config` field (never `factory_release`, which changes only through an upgrade) as an Owner-signed commit on main. [clarified 2026-10-02]
- **FR-008**: The factory MUST ship one stack profile (TypeScript) as a set of templates and tool settings; adding a profile MUST NOT require changes to the stations. [src FR-3.10]

**Stations and flow**

- **FR-009**: The factory MUST implement Station 0 (Define, once per project) and stations 1–8 with the inputs, outputs, exit gates and owners in the source station table. [src §4]
- **FR-010**: Define MUST always ask up to 5 clarifying questions in one batch, MUST NOT fill gaps with its own assumptions, and MUST output the brief, the walking skeleton and a 5–10 item tiered backlog; approval moves the backlog into Intake. Define commits the brief and skeleton to the branch `claude/define` and opens one draft pull request for them; the Owner's merge of that pull request is the brief approval, and the Owner approves each seed issue with `factory approve`. [src FR-4.1–4.6; clarified 2026-10-01]
- **FR-011**: Work items MUST move through the states new → triaged → specified → spec-approved → planned → building → verifying → integrating → releasing → done, with "blocked" and "escalated" reachable from any state; one `state:` label per state (e.g. `state:spec-approved`), set only by the dispatcher. An item MUST enter `state:triaged` only after `owner:approved`. [src §4.3, FR-8.3; clarified 2026-10-01]
- **FR-012**: A failed gate MUST return the item, with its failure report, to the earliest station able to fix it; after 3 failed attempts the item MUST escalate to the Owner with evidence. [src FR-4.8, P-8]
- **FR-013**: Any station MUST be able to raise a question; the item then waits in "blocked" without consuming usage. [src FR-4.9]
- **FR-014**: The factory MUST support the lean (tier 1, 3 sessions), full (tier 2–3, 6–8 sessions) and batch (up to 5 similar items, 1 session) lanes; combining sessions MUST NOT skip a gate, and skipping a gate MUST require an Owner-recorded waiver. [src §4.2, FR-4.7, QG-10]
- **FR-015**: Intake MUST propose the risk tier as a `tier:` label, and the Owner confirms it when approving the item; the Owner MAY raise it at any gate; agents MUST NOT lower it. [src FR-4.10; clarified 2026-10-01]
- **FR-016**: The route between stations MUST be decided by the orchestrator, never by an agent; the orchestrator MUST only act on items the Owner authored or approved (the `owner:approved` label), in every repository. [src FR-8.1, SEC-0.7]
- **FR-016b**: Labels MUST fall into four prefixed kinds — the fourth, `pause:`, is defined in FR-029: Owner gates — `owner:approved` (admits the item and confirms its tier), `owner:spec-approved`, `owner:waiver` — set only by the Owner through `factory approve`; workflow state — `state:new` … `state:done`, `state:blocked`, `state:escalated` — set only by the dispatcher through the advance-item control operation; risk tier — `tier:1`, `tier:2`, `tier:3` — proposed by Intake and confirmed by the Owner when approving the item. Merge and release have no labels: the Owner's merge and `factory deploy` are those approvals. [src §8.2; clarified 2026-10-01]
- **FR-016c**: Each Owner gate MUST pass only on its own `owner:` label; the dispatcher MUST NOT infer a gate from a `state:` label or from another gate's label (e.g. it moves an item to `state:spec-approved` only on `owner:spec-approved`). The tier 1 spec-skim exception MUST apply only to a `tier:1` the Owner confirmed. [src FR-8.14; clarified 2026-10-01]
- **FR-016d**: Because agent sessions act on GitHub as the Owner's account, a label alone MUST NOT count as proof of Owner action: the command guard MUST block every agent from adding or removing any `owner:` or `state:` label; `factory approve <issue|pr> [spec | waiver <waives>]` MUST run only on the laptop, apply the label and record the approval in the item's event log; the dispatcher MUST accept an `owner:` label only with a matching `factory approve` record, and MUST treat a label without one as tampering — stop the item and alert the Owner. [src FR-8.15, FR-8.16, FR-6.4; clarified 2026-10-01]
- **FR-016e**: Approval records MUST be digitally signed. The signing key MUST be an ed25519 SSH key used only for Owner approvals and the Owner's signed commits and release tags (namespaces `factory-approve` and `git`), passphrase-protected, kept only on the laptop and never placed in a cloud environment, repository or secret store; permission rules MUST deny every agent access to its path, and `factory approve` MUST ask for the passphrase each time without leaving the key unlocked. The record MUST be made with `ssh-keygen -Y sign` under namespace `factory-approve` and MUST contain repo, issue number, gate, confirmed tier, item branch, a timestamp, a one-time nonce, and for spec approval the commit hash of `spec.md`, so it verifies for no other item and stops verifying once `spec.md` changes; a nonce MUST NOT be accepted twice. The public keys MUST be published in the pinned factory release: `allowed_signers` lists every key the Owner has used, and `revoked_keys` lists compromised ones, whose signatures MUST fail. Records MUST be verified against the copy pinned on main, never a pull request's. The newest non-revoked key MUST also be set in an environment variable on the cloud routine, set only by the Owner at claude.ai; verification MUST fail unless the two match, except that after an upgrade adds a key the dispatcher MUST report "key rotation pending" (stopped, one urgent alert) rather than tampering. A waiver for a gate checked against code (red-green, coverage, size, an acceptance criterion, a CI job) MUST carry the pull request head it covers and stops counting when the head changes; a waiver for a pre-build gate is bound to the item only. Record timestamps are set by the key holder and MUST NOT be relied on for anything beyond ordering. A record is valid wherever it is stored (issue comment, event log). [src FR-8.17–8.19; clarified 2026-10-01, 2026-10-02]
- **FR-016f**: Signatures MUST be verified by deterministic code, never by model judgement: `factory dispatch` checks each record with `ssh-keygen -Y verify` and decides by exit code. Because the routine is still an agent with a shell, `factory merge <pr>` and `factory deploy` MUST re-verify, on the laptop, the full chain of signed approvals of every item they merge or ship, and refuse on any failure. `factory merge` also merges the three non-item pull requests (Define's `claude/define`, upgrade `factory/upgrade-<tag>`, the weekly `claude/factory-log`) under the per-branch checks in the data model; any other pull request with no work item is refused. CI results MUST count only after `factory merge` has confirmed that no protected file changed. The dispatcher's own gate decisions are advisory; only signed records, signed commits and laptop checks decide what reaches main or the laptop. [src FR-8.20–8.22; clarified 2026-10-01, 2026-10-02]
- **FR-016g**: Every commit on main's first-parent history after the recorded `baseline` (adopted repos) or from the root (repos made by "new") MUST be signed with a non-revoked Owner key; the Owner's commits come only from "new", "adopt", "merge" and "config set". On any unsigned commit the dispatcher MUST raise a tampering alert and move no item, and "merge" and "deploy" MUST refuse to run. The factory repository follows the same rule. [clarified 2026-10-02]
- **FR-016a**: When the Owner approves an item, the dispatcher (never an agent) MUST create its work-item branch `claude/<issue>-<slug>`, MUST set the spec workflow's feature name so the specify command writes into that branch instead of creating its own, and MUST name that branch in every station prompt for stations 2–6; each session checks it out and commits there. One draft pull request per item MUST be opened at Specify and carry spec approval, CI, verify and review reports, and the Owner's merge. Each item MUST map to exactly one branch and one pull request; work that would exceed the size limit MUST be split by the Planner into several work items, never several pull requests for one item. The merge brings the code and its whole trail into main together. [src FR-8.9–8.11; clarified 2026-10-01]

**Agent roles and permissions**

- **FR-017**: The factory MUST define twelve roles — Define, Intake, Spec, Planner, Builder, Test, Reviewer, Security, Integrator, Release, Ops, Coach — each a separate session with its own instructions and permissions, run one at a time by default; no role may both write and approve a change. [src §5]
- **FR-018**: Each role's tools, writable paths, permitted shell commands and blocked actions MUST match the source per-role permission table, and every role MUST be denied writes to guardrail files. [src §6.2, FR-6.4]
- **FR-019**: Agents MUST use the agent runtime's own tools; the factory MUST NOT build its own agent harness or core tool set. [src FR-6.1]
- **FR-020**: Permissions MUST be enforced by three layers committed to each project — role definitions, permission rules and hooks — and every deny rule MUST be proven to hold inside an unattended scheduled run. [src FR-6.2, FR-6.3]
- **FR-021**: Hooks MUST: guard paths and commands before each tool call (writes only inside the role's folders and the task's file list; block pushes to main or to any branch other than the one named in the station prompt, merges, secret reads, adding or removing `owner:`/`state:` labels, and removing `pause:` labels); format and type-check touched files after edits; append one event per tool call (to `events.jsonl` on the item's branch, or to `claude/factory-log` after merge); verify the station output on stop; and verify guardrail integrity at session start, including that the branch's own commits did not change `.factory/config`, a protected file, `.gitattributes` or `.gitmodules`. Because agents with a shell run as the same user as the hooks, hook path rules are defence in depth; the enforcement that holds is the laptop check in "merge". [src FR-6.5–6.9; clarified 2026-10-02]
- **FR-022**: The factory MUST provide three control operations to sessions — ask the dispatcher to advance an item to its next `state:` label (the dispatcher's code checks the gate and verifies the signed record behind any `owner:` label first), log a structured event, and hand an oversized task back to Plan. [src FR-6.10]

**Context and hand-offs**

- **FR-023**: Each station MUST run in a fresh session; hand-offs MUST be files in the repository, never conversation history; a session MUST load only the short project guide, its role file, the work item and its hand-off file, opening other files only when needed; codebase exploration MUST run in sub-sessions that return short summaries. [src FR-7.1–7.4]
- **FR-024**: A session nearing its context limit or compacting once MUST request a split and stop. [src FR-7.5]
- **FR-025**: Per work item, artifacts MUST live in one feature folder `specs/<issue>-<slug>/` (matching the work-item branch name) holding spec, plan, tasks, reports and `events.jsonl`, on the work-item branch; they reach main only through the Owner's merge of the item's pull request. Reports MUST also be posted on the pull request. [src §7.1, FR-8.4; clarified 2026-10-01]
- **FR-026**: Spec workflow commands MUST be written in one form across all documents, confirmed against the installed version in Phase 0. [src FR-7.6]

**Control plane, hosting and capacity**

- **FR-027**: The orchestrator MUST pick the next ready item by label and start its current station as a cloud session (or local session per FR-031); the same logic MUST run as a daily scheduled run so the line advances with the laptop closed. [src FR-8.1, FR-8.2, FR-13.8]
- **FR-028**: Work items MUST be tracked one per issue with a project board; each item MUST have an append-only event log in the repository plus issue comments. Before the work-item branch exists, Intake logs to issue comments; on creating the branch the dispatcher MUST copy them as the first lines of `specs/<issue>-<slug>/events.jsonl`. The event log is untrusted telemetry: it feeds metrics, the Coach and escalation timing, and no merge, deploy or gate decision may rely on its content. [src FR-8.3, FR-8.5, FR-8.12; clarified 2026-10-01, 2026-10-02]
- **FR-028a**: Stations 7–8 MUST write only to one long-lived data branch per project, `claude/factory-log`, holding post-merge event lines, release notes and rollback paths, `.factory/ops/` (health summaries, incident notes, metrics reports) and `.factory/lessons/`; its only agent writers are Release, Ops and Coach, by additions only; CI MUST reject any push to it that edits or deletes an existing line or file; the Owner merges it into main weekly with "merge", when reviewing the Coach's proposals, and "merge" MUST accept only lines appended at the end of regular text files under `.factory/events/`, `.factory/ops/`, `.factory/lessons/` and `.factory/releases/`. [src §8.1, FR-8.13, FR-3.2; clarified 2026-10-01, 2026-10-02]
- **FR-029**: The kill switch MUST be a `pause:line` (whole line) or `pause:<station>` (`pause:intake`, `pause:specify`, `pause:plan`, `pause:build`, `pause:verify`, `pause:integrate`, `pause:release`, `pause:operate`) label on the pinned Owner inbox issue. Anyone MAY add a pause without a signature: the Owner (GitHub app or web, or `factory pause [station]`) or any agent. A pause MUST end only through `factory resume [station]` (FR-007d), which signs a record under namespace `factory-approve` with gate `resume`, the scope, a timestamp and a nonce (FR-016e) and then removes the label; the command guard MUST block agents from removing `pause:` labels. [src FR-8.8, FR-8.25–8.27, FR-6.4; clarified 2026-10-01]
- **FR-029a**: The dispatcher MUST derive pause state from the inbox issue's label history, not from current labels: a scope is paused if a `pause:` label for it was ever added and no valid signed resume record for that scope came after. A pause label removed without such a record MUST be re-applied and the Owner alerted. [src FR-8.28; clarified 2026-10-01]
- **FR-029b**: During a whole-line pause the routine MUST exit at once, the dispatcher MUST start no new session, and advance-item MUST refuse every move; running sessions MAY finish their current step but cannot advance (the Owner stops one immediately by archiving it at claude.ai). During a station pause, items MUST wait on reaching that station while all others keep moving. `factory merge` and `factory deploy` MUST warn during any pause and require Owner confirmation, so a fix can still ship. A single item is paused with `state:blocked`. [src FR-8.29, FR-8.30; clarified 2026-10-01]
- **FR-030**: The dispatcher MUST run one station at a time by default; parallel sessions MUST require Owner approval. [src FR-9.1, P-9]
- **FR-031**: When cloud sessions are unavailable or the project is set to local, the same station prompts MUST run locally, one at a time. [src FR-9.5]
- **FR-032**: The factory MUST degrade gracefully when scheduled-run or trigger caps are reached; each station MUST write its result to the repository or issue before waiting on the Owner. [src FR-9.2, FR-9.3]
- **FR-033**: A pull request opening MUST trigger the Reviewer automatically; each scheduled run MUST work ready items until an Owner gate, the usage limit or a cap, then leave a summary on the issue. [src FR-13.8]
- **FR-034**: The product's local data MUST be backed up daily. [src FR-9.6]
- **FR-034a**: Every Owner notification or alert MUST be written to one pinned "Owner inbox" issue per project, created by "new" and "adopt" [src FR-8.24]. Urgent alerts — escalations, critical/high security findings, guardrail mismatches, tampering (failed signatures, unverified `owner:` labels, unsigned commits on main, recreated merged branches, removed `pause:` labels), key rotation pending, secret leaks — MUST also fail a dedicated `owner-alert` CI job so that GitHub emails the Owner. Every `factory` command on the laptop MUST show unread alerts before its own output. GitHub @mentions or comments alone MUST NOT count as notification, because agents act as the Owner's account. [Clarified 2026-10-01]
- **FR-035**: Usage MUST be logged per work item; agents MUST stop and escalate when a session nears the usage limit. [src NFR-10.2, NFR-10.10]
- **FR-036**: Stations MUST run on the plan's mid-tier model with the top-tier model as advisor; Intake and Test MUST use the mid-tier model alone; the Coach runs weekly; any move to a stronger model MUST be recorded with a reason; the excluded model family (Fable) MUST NOT be used as main model or advisor, and usage credits MUST stay off. [src NFR-10.3–10.5]
- **FR-037**: CI minute use on private repositories MUST be logged. [src NFR-10.8]

**Quality gates**

- **FR-038**: Every merge, in every tier, MUST pass: build and full suite; every acceptance criterion mapped to at least one passing test; ≥ 90% coverage on changed lines; clean lint, type check, static analysis, secret scan and licence scan; an attached independent review with blocking findings resolved; and a diff under the size limit (target under 400 changed lines) or split. [src QG-1–QG-6, P-2]
- **FR-039**: The Reviewer's verdict MUST be advisory; CI and the Owner decide. [src QG-5]
- **FR-040**: Tier 2 MUST add property-based tests on changed logic and release behind an Owner-controlled flag; tier 3 MUST add a risks section, formal verification of the one critical property in CI, a second independent review and a written, tested rollback step. [src §11.1, QG-7]
- **FR-041**: Every release, in every tier, MUST have a documented rollback path and Owner approval. [src §11.1, station 7]
- **FR-042**: New tests MUST be seen failing before the change makes them pass, proven by a CI check and never by agent-written events: every checked acceptance criterion (for tier 2–3, those in the spec version the Owner approved; for tier 1, every criterion that ever appeared in `spec.md` on the branch, unless removed with an Owner waiver) MUST have at least one test tagged with its ID that fails against the code at the merge base and passes at the head; diffs touching only the release's test paths skip the check, and refactors need an Owner waiver bound to the head commit. Flaky tests MUST be fixed or quarantined with an Owner-visible issue; agents MUST NOT weaken, delete or skip tests without Owner approval. [src QG-8, QG-9; clarified 2026-10-02]
- **FR-043**: Every approval request MUST include what changed, how it maps to the spec, test and review results, usage spent and known risks. [src QG-11]

**Security**

- **FR-044**: Agents MUST never hold production credentials; repository credentials and keys MUST stay outside agent VMs; network egress MUST be limited to an allowlist; secrets MUST never enter agent context. [src SEC-0.1–0.3]
- **FR-045**: Untrusted text (issues, comments, web pages, dependency files, test output, run payloads) MUST be treated as data, never instructions. [src SEC-0.4]
- **FR-046**: Sessions MUST push only to the `claude/` branch named in their station prompt; merges to main MUST require passing CI and Owner approval, enforced by the command guard and the dispatcher where platform branch protection is unavailable. [src SEC-0.5, §12.2]
- **FR-047**: Scheduled runs MUST get only the repositories they need and no extra connectors; only the Coach's run also gets the factory repository, where it may push only its `coach/<yyyy-Www>` branch. [src SEC-0.6; clarified 2026-10-02]
- **FR-048**: The protected files (agent configuration folder, tool-server declaration, hooks, CI workflows, factory config, the constitution, lockfile policy) MUST be installed and changed only by the factory command (new/adopt/upgrade); agents MAY only propose changes as pull requests to the factory repository, which reach projects through signed releases and "upgrade"; "merge" MUST refuse any item or Define pull request touching them, `.gitattributes`, `.gitmodules` or `.factory/config`, and a CI check MUST also fail such pull requests; an upgrade pull request MUST match the manifest of the signed release it names; a session-start check MUST stop on any mismatch with the pinned release (and of `.factory/config` with main's copy) and alert the Owner. CI MUST run the pinned release's own tools and configs, never the project's scripts or configs. [src SEC-2.1–2.4; clarified 2026-10-02]
- **FR-049**: Static analysis MUST run on every pull request and weekly on main; known-vulnerability checks on every pull request plus continuous dependency alerts; secret scanning as a pre-commit check, on every pull request and weekly across full history; licence checks against an allowed list on every pull request that changes dependencies. [src §12.4]
- **FR-050**: A new dependency MUST pass the new-dependency gate and Owner approval; installs MUST run with install scripts disabled against a committed lockfile with exact versions. [src §12.4]
- **FR-051**: Security findings MUST follow detect → file (deduplicated by rule and location, enters the line after Owner approval, critical/high notify the Owner at once) → triage (critical/high full lane and jump the queue; medium normal queue; low backlog) → fix with regression test → re-scan on the branch → close, or dismiss with written reason, Owner approval and re-check date. [src SEC-4.1–4.6]
- **FR-052**: A secret leak MUST pause the line (the Security or Ops role adds `pause:line`) until the Owner rotates the secret and runs `factory resume`, and Ops MUST write an incident note with the cause and the new check. [src SEC-4.7]
- **FR-053**: Every work item MUST have a full audit trail (prompts, tool calls, diffs, reports, approvals); agent commits MUST name role and work item; risk tiers and approval rules MUST be kept as reviewed policy files. [src GOV-1–GOV-3]

**Operate, learn and improve**

- **FR-054**: Ops MUST read health summaries and the event log, file incidents at Intake, write incident notes, and write the weekly metrics report covering the metrics in AC-047. [src §5, §14]
- **FR-055**: Each station MUST log gate results, rework loops and Owner review comments; the Coach MUST weekly write project lessons per role to `.factory/lessons/` on `claude/factory-log`, and propose role-instruction, checklist, skill or lint-rule changes as pull requests to the factory repository from its weekly branch `coach/<yyyy-Www>` there (role files are guardrail files in every project), which reach projects only through "upgrade". [src FR-13.1–13.3, §5; clarified 2026-10-02]
- **FR-056**: A Coach change MUST be replayed on the benchmark (starting with 5–10 past items) and MUST NOT lower first-pass gate rate; the Owner decides adoption; role instructions MUST be versioned so a regression reverts in one step. [src FR-13.4, FR-13.5]
- **FR-057**: Project lessons MUST stay in the project; general lessons MUST go to the factory repository as pull requests, scrubbed of project details and checked by the Owner, and pass the replay benchmark. [src FR-13.6, SEC-0.7]
- **FR-058**: The Coach MUST NOT change gates, permissions, budgets, guardrail files or the constitution, MUST NOT approve its own changes, and MUST NOT remove or edit benchmark items; only the Owner retires a benchmark item, in a separate change. [src FR-13.7]

**Phase 0 verifications**

- **FR-059**: Phase 0 MUST, on a throwaway sample project: confirm the installed spec-workflow command naming; confirm how the spec workflow is told which feature folder and branch to use (FR-016a); confirm whether telemetry export works from cloud sessions; confirm that `ssh-keygen -Y verify` is available in the cloud environment and that forged, edited and replayed approval records are rejected by both the dispatcher and `factory merge`; confirm that pause state is read from label history and that removing a `pause:` label without a signed resume leaves the line paused and the label restored; confirm that a failed `owner-alert` run triggered by a routine actually emails the Owner; confirm that `git verify-commit` with an SSH allowed-signers file works in the cloud environment; dry-run a key rotation on the sample project; and test every deny rule inside a scheduled run. [src §16, §17; clarified 2026-10-02]

### Key Entities

- **Owner**: The single human; the only party who approves specs (tier 2–3), merges, releases, waivers, dependencies, guardrail changes, dismissals, upgrades and Coach changes.
- **Factory release**: A tag of the factory repository signed by the Owner with `factory release`, pinned by projects as `<tag>@<sha>`: command, station contracts, role instructions, skills, gate policy, stack profiles, CI templates and CI configs, constitution, general lessons, guardrail manifest, `allowed_signers` and `revoked_keys`.
- **Project**: A private repository for one product, with its config (pinned release, cloud/local choice), brief, lessons, ops records, security dismissals, constitution and feature folders.
- **Work item**: One issue with type, priority, a `tier:` label, one `state:` label, any `owner:` gate labels, and an event log; belongs to one project.
- **Approval record**: The signed record written by `factory approve`, `factory resume` or `factory deploy` on the laptop (namespace `factory-approve`; repo, issue, gate, confirmed tier, item branch, `spec.md` blob hash for spec approval, waived target and head commit for waivers, timestamp, single-use nonce, SSH signature); the only thing that makes an `owner:` label valid; may be stored anywhere.
- **Owner key**: The Owner's passphrase-protected ed25519 SSH signing key, laptop-only; signs approval records, the Owner's commits on main and release tags. All public keys ever used are listed in the release's `allowed_signers`, compromised ones in `revoked_keys`; the newest is mirrored in the routine's Owner-only environment variable.
- **Signed main history**: Main's first-parent commits after the `baseline`, each signed by the Owner; the proof that every merge and config change was the Owner's.
- **Feature folder**: The hand-off artifacts of a work item, `specs/<issue>-<slug>/`: spec, plan, tasks, reports and `events.jsonl`.
- **Work-item branch**: `claude/<issue>-<slug>`, one per work item, created by the dispatcher on Owner approval; paired with exactly one draft pull request opened at Specify.
- **Factory-log branch**: The long-lived, append-only data branch `claude/factory-log` holding post-merge events, release notes, ops records and lessons; written only by Release, Ops and Coach, additions only; merged into main weekly by the Owner.
- **Station**: A step with an input, an output and an exit gate, served by one role.
- **Role**: An agent identity with instructions, model, allowed tools, writable paths and blocked actions; versioned.
- **Gate result**: Pass/fail of a station's exit gate for an attempt, with evidence; counted for retries and metrics.
- **Event**: One append-only structured record: item, station, role and version, model, tool call or gate result, usage, timestamp.
- **Guardrail file**: A protected file installed only by the factory command and verified against the pinned release.
- **Waiver**: An Owner-recorded exception to a gate, with reason; carried as `owner:waiver` plus its approval record.
- **Security finding**: A scanner or alert result, deduplicated by rule and location, with severity, linked issue and optional dismissal (reason, approval, re-check date).
- **Health summary**: The result of a deploy: version deployed, health status, written by the deploy command.
- **Lesson**: A Coach finding scoped to a project or general.
- **Owner inbox**: One pinned issue per project holding every alert and notification for the Owner, with read/unread state shown by the `factory` command; also carries the `pause:` labels whose history defines pause state.
- **Resume record**: A signed record from `factory resume` (namespace `factory-approve`, gate `resume`) naming the scope (line or station), with timestamp and single-use nonce; the only thing that ends a pause.
- **Benchmark item**: A past work item used for replay; only added, retired only by the Owner.
- **Metrics report**: The weekly Ops report of flow, quality, cost and reliability metrics.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001** (Gate A): A sample pitch on a throwaway project goes from "new" to a deployed walking skeleton, and one Owner-approved work item goes from Intake to a deployed release, with every gate enforced and every hand-off file present.
- **SC-002**: 100% of the deny rules in the per-role permission table are shown blocked inside an unattended scheduled run in Phase 0, and 100% of attempted guardrail-file edits by agents are blocked.
- **SC-003**: Zero commits reach main without an Owner merge, and zero deploys happen without the Owner running the deploy command, across all projects.
- **SC-004**: The line ships 3–5 work items per week once the target is raised after shadow mode.
- **SC-005**: Extra spend stays at zero beyond the existing plan subscription, and weekly usage stays well below the plan's weekly limit during two weeks of shadow mode before the target rises.
- **SC-006**: 100% of shipped items can be traced from request to release and back, and 100% of agent commits name their role and work item.
- **SC-007**: Each change presented for merge is reviewable by the Owner in under 30 minutes (target under 400 changed lines).
- **SC-008**: Every approval request contains all five summary elements (change, spec mapping, test/review results, usage, risks).
- **SC-009** (Gate C): The replay benchmark holds at least 5 past items, and no adopted Coach change lowers first-pass gate rate on it.
- **SC-010**: No merged change has changed-line coverage below 90% or an acceptance criterion without a passing test.
- **SC-011**: Critical and high security findings notify the Owner at the moment they are filed, and every dismissal carries a reason, Owner approval and re-check date.
- **SC-012**: The weekly metrics report is produced every week once Phase 3 starts and contains all nine listed metrics.
- **SC-013** (Gate B): Pull request acceptance rate in shadow mode meets the target set from baseline data.

## Risks *(mandatory for tier 3; optional for tier 1–2)*

- **Critical property**: No change reaches main, and no release reaches the laptop, without the Owner's explicit action (merge, or running deploy) — regardless of what any agent, issue text or scheduled run does. To be formally verified as a state-machine property of the work-item workflow and dispatcher (item states, gates, `owner:` labels with their signed approval records, signed merge commits on main, kill switch).
- **Failure modes**: An unblocked deny rule lets an agent push to main or edit a guardrail file; prompt injection in an issue or dependency makes an agent exfiltrate data; an agent (acting on GitHub as the Owner's account) forges an `owner:` label to pass a gate; an agent removes a `pause:` label to restart a stopped line; an agent rewrites `events.jsonl` or `claude/factory-log` history; a malicious or lookalike dependency is installed; the Reviewer is talked into a favourable verdict; lesson poisoning weakens role instructions; a malicious pull request to the public factory repo reaches projects; a pull request edits a workflow or test configuration so its own CI passes; an agent pushes or button-merges an unsigned commit to main; a moved or forged release tag swaps the checker or the guardrails; the log branch carries code into main; usage is exhausted mid-week, stalling the Owner's own chats.
- **Accepted residual risks** (clarified 2026-10-01): with `agents: local`, agent sessions share the laptop with the approval key, so the passphrase is its only protection (a touch-to-sign hardware key is optional, at extra cost); a laptop compromise compromises approvals; rotating the key needs two deliberate Owner actions (`factory upgrade` and the routine's environment variable); the GitHub merge button stays available on GitHub Free, so `factory merge` is a habit backed by after-the-fact detection of unsigned commits (AC-073, AC-087). [src FR-8.23] Added 2026-10-02: until the release that revokes a stolen key is merged, the pinned `allowed_signers` still trusts it, so its holder could sign tags and waivers for their own upgrade; changing the routine's variable first halts every cloud-side verification at once, leaving only laptop actions, which fall under laptop compromise. The event log is untrusted telemetry and decides nothing. Test files are pull-request code: a test can assert nothing, or fail at the base for an irrelevant reason, and still pass red-green; the independent review is the control for test quality (mutation testing is a deferred option, research R20).
- **Blast radius**: All projects pinned to an affected factory release; on private repositories without platform branch protection, main is protected only by the factory's own guards.
- **Irreversible or outward-facing actions**: Creating private repositories and installing the provider's repository app (code cloned into provider-managed VMs — gated by per-project consent); deploys on the laptop; publishing general lessons to the public repository. Each needs Owner action or approval.
- **Rollback**: Factory releases are pinned per project; a bad release is rolled back by pinning the previous tag via an Owner-approved pull request. Role instructions are versioned and revert in one step. Product releases each carry a documented rollback path; tier 3 a tested one.
- **Feature flag**: Not applicable to the factory itself; the `pause:line` / `pause:<station>` labels pause the whole line or one station, and only a signed `factory resume` lifts them. Tier 2–3 product changes ship behind flags the Owner turns on.

## Assumptions

- This spec covers the factory v1 as a whole; delivery is phased per the source roadmap, and P1 stories alone form the Phase 0 MVP (Gate A).
- The current repository is the factory repository; projects and the benchmark repository are separate.
- Platform choices named in the source (Claude Pro plan and Claude Code cloud sessions/routines, GitHub Free, TypeScript profile, the listed scanners and verification tools, a 4 GB Crostini laptop) are Owner constraints [src C-1–C-6, §15], not open design choices; they are detailed in the plan, not here.
- Products built are used only by the Owner; no outside users, no compliance regime. [src C-4, C-6]
- One active project at a time; tickets are small to medium (under a day of human work). [src §1.5]
- Out of scope for v1: greenfield architecture without Owner sign-off, changes to auth/billing/data deletion without the Owner as named reviewer, mobile store releases, infrastructure provisioning. [src §1.6]
- Platform branch protection (paid plan) is optional; the factory's own guards are sufficient by default. [src NFR-10.9]
- An LLM gateway is deferred; the dispatcher is the control layer. [src §19]
- Deferred to shadow-mode data (not open questions for this spec): token budgets per role, project guide size, larger-context needs, retry count (default 3), security fix target times, metric targets, Gate B threshold, whether the advisor model pays off, the account's actual scheduled-run cap. [src §17]
- The companion constitution is v2.6.0, which uses the same `owner:` / `state:` / `tier:` / `pause:` label scheme as this spec, the `claude/define` brief branch, signed main history and the key list with revocation; the earlier divergence from v2.1.0 (Owner label named `approved`) is resolved.
- Phase 0 finding, resolved: the installed spec-workflow version (1.0.13) exposes its commands as hyphenated skills (`/speckit-specify`); constitution v2.5.0 adopts that form (FR-026). The source document still uses the dot form (`/speckit.specify`).
