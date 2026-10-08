# Software Factory — Design v1.8

Sep 29, 2026 · @Ballesteros

## Status and how to review

This is v1.8: it records the decisions made while building slice 15. Only a signed approval admits work, nothing is admitted before the brief is merged, approval summaries are built per gate by the CLI, and telemetry never blocks or allows anything. The station design is unchanged.

- **Direction (confirmed):** "software factory" means an agent-driven assembly line that turns a product request into tested, deployed software, with humans owning intent and the release gates.&#32;
- **How we iterate:** comment on any section, or answer the open questions at the end. Each round bumps the version and records what changed.
- **Out of this version:** detailed APIs, data schemas, sizing and cost figures.

**What changed in v1.8**

- Admission needs your signed `owner:approved` and nothing else: issue authorship never counts, because agents act through your GitHub account. The tier is proposed by the agent that files the issue or given by you with `--tier`; Intake runs after approval and may only propose raising it.
- No item of any kind is admitted until the Define pull request's signed merge is on `main`.
- `factory merge` writes a `Factory-Merge:` trailer into every signed merge commit; the once-only rule and the brief rule read only those trailers. A failure found after an item's merge never sends it back: it moves on to `releasing` with an alert and becomes a new issue.
- Criterion lines are defined; the checked set is the approved spec's IDs (tier 2–3) or every ID that ever appeared on the branch (tier 1); an empty set fails.
- Approval summaries: the per-gate list is a constant in the factory code; usage is never required; a spec re-approval shows the diff from the last approved spec; quoted text is cleaned by Unicode category.
- Retries are counted only from gate failures the dispatcher sees itself, never from the event log, so a session cannot delay its own escalation by reporting nothing.
- The laptop's diff reads git's raw tree and blob data, because plain git diff still applies a pull request's own .gitattributes and could hide changed lines.
- v1.7 changes (red-green per criterion, waivers bound to the head and their exact target, signed first commits, branches closed after merge) are recorded in the Decisions log.

## Vision and scope

The factory takes a written product request in and ships a reviewed, tested, deployed change out, with every step traceable back to the request.

**Constraints:** one human (you) is product owner, code owner and on-call; budget is the Claude Pro plan you already pay for, so no extra spend; everything runs on your daily laptop (Crostini, 4 GB RAM) plus GitHub; no compliance regime to meet; target 3–5 shipped items a week; the product is used only by you.

**Inputs:** a product pitch of a few sentences (starts a new project), feature requests, bug reports, tech-debt tickets, dependency and security updates.

**Outputs:** merged pull requests, release notes, updated docs and tests, a deployment to production behind a flag.

**In scope for v1:**

- One factory repository, applied to any number of project repositories, one active at a time on your laptop
- Web backend and frontend work of small to medium size (a ticket a human would finish in under a day, so it fits within plan usage limits)
- Bug fixes and routine maintenance end to end

**Out of scope for v1:**

- Greenfield architecture decisions without human sign-off
- Changes to auth, billing or data-deletion paths without a named human reviewer
- Mobile store releases and infrastructure provisioning

## Design principles

1. **Spec is the source of truth.** Every change starts from a written spec with acceptance criteria; code, tests and docs are derived from it.
2. **Small batches.** Work is cut into units you can review in under 30 minutes (target: under 400 changed lines).
3. **Verification over generation.** More effort goes into checking work than producing it: tests, static analysis, independent review, and formal verification where it pays.
4. **Independent checkers.** The agent that verifies never shares context with the agent that built the change.
5. **You own intent and every merge.** You approve specs for tier 2–3 work (and skim tier 1), every merge and every release; agents do the rest.
6. **Everything is an event.** Each station logs structured events so any output can be traced to its request, prompts, tools used and reviews.
7. **Stations are replaceable.** Each station has a contract (inputs, outputs, gate), so a model, tool or person can be swapped in without redesign.
8. **Fail safe, not silent.** A station that cannot meet its gate escalates to you with its evidence rather than retrying forever.
9. **Frugal by design.** One agent runs at a time, cheap steps come first, and nothing is hosted beyond GitHub, your laptop and the Claude Code cloud sessions included in your plan.
10. **Learn from every item.** Each finished item feeds back into agent instructions, through changes you approve.

## Architecture overview

After a once-per-project Station 0 (Define), each work item flows through eight stations like an assembly line; a shared control plane moves it forward and records everything.

&#91;embedded content: factory architecture · 8 stations on one control plane\]

A failed verification loops back to Build with its report, and production signals from station 8 re-enter as new work at Intake.

## Reusable factory and Station 0

The factory is its own versioned repository; you apply it to a project repository, and a pitch of a few sentences is enough to start a new product.

&#91;embedded content: reusable factory · how a project starts and where things live\]

Everything generic lives in the factory repo; a project holds only its code and a small `.factory/` folder, so one factory can run many products and improve across all of them.

**How it is applied**

1. **Install once:** clone the factory repo on your laptop; it provides a `factory` command-line tool.
2. **Start a project:** `factory new "<your few sentences>"` creates a private repo, or `factory adopt <repo>` attaches to an existing one. Before creating anything, it reminds you that agents will clone this project's code into Anthropic-managed cloud VMs through the Claude GitHub App, and asks you to choose cloud or the local fallback; the answer is saved as `agents: cloud` or `agents: local` in `.factory/config`, and the dispatcher will not start a cloud session for a project without it. It then runs `specify init`, writes `.factory/`, installs every guardrail file from the pinned factory release (including the constitution), installs GitHub labels and CI workflows, creates the pinned Owner inbox issue, and sets up the working copy on the laptop. No agent installs or edits guardrail files.
3. **Define (Station 0):** the Define agent turns the pitch into a brief and a starter; you approve.
4. **Run:** `factory run` works the project's backlog through stations 1–8.
5. **Upgrade:** a new factory release is pulled into a project with `factory upgrade`, opened as a pull request you approve; each project pins the version it runs.

**Station 0, Define** (runs once per project, and again whenever you revise the vision)

|  | Content |
| --- | --- |
| Input | Your pitch of a few sentences; or, with `adopt`, the existing code |
| Questions | Always asks: up to 5 clarifying questions in one batch; it never fills gaps with its own assumptions |
| Output: brief | `.factory/brief.md`: problem, users, core use cases, non-goals, success measures, risk areas |
| Output: starter | A walking skeleton from the stack profile: runs, has one test, passes CI and deploys on the laptop |
| Output: backlog | 5–10 first work items as GitHub issues, each tagged with a risk tier |
| Gate | You approve the brief by merging the claude/define pull request with factory merge; each seed issue then needs its own owner:approved; no item of any kind is admitted until that merge is on main |

**Stack profiles:** the factory ships a TypeScript profile first (tools listed under Tech stack). A profile is a folder of templates and tool settings, so other languages can be added later without changing the stations.

**Lessons at two levels:** the Coach files project-specific lessons ("this app's dates are always UTC") in the project's `.factory/lessons`; general lessons ("specs need an error-handling section") become pull requests to the factory repo and must pass its replay benchmark, which draws on past items from every project and is kept in a private repo, never in the public factory.

## Capacity: 3–5 items a week fits Pro

3–5 items a week needs roughly 10 to 30 model sessions, which leaves room inside Pro for your own chats; the lean lane is kept for tier 1 items only.

**Why:** Pro meters a rolling 5-hour window plus a weekly cap, shared by Claude Code and your own chats; Anthropic publishes no fixed numbers. One guide puts Pro at roughly 1 to 3 hours of Claude Code a day ([Continuum](https://continuumcode.ai/guides/claude-pro-usage-limit/)). Spread over a week, 10 to 30 short sessions sits well inside that.

| Lane | Used for | Model sessions per item | Runs without a model |
| --- | --- | --- | --- |
| Lean | Tier 1 | 3: Spec + Plan · Build + tests · Review | Intake rules, lint, type check, tests, coverage, scanners, rebase, deploy |
| Full | Tier 2 and tier 3 | 6–8: every station, plus formal checks on tier 3 | Same scripted checks |
| Batch | Dependency bumps, copy changes | 1 session for up to 5 similar items | Same scripted checks |

**Keeping usage low, with the advisor tool:** stations run on Sonnet with Opus as the advisor. Sonnet does the routine turns and consults Opus before committing to an approach, when an error keeps recurring, and before declaring the work done. Advisor calls count toward your Pro limits but cost less than running Opus throughout. Fable is never used, as main model or advisor, and usage credits stay off, since both can bill beyond the plan. Intake and Test use Sonnet alone; any move to a stronger model is recorded with a reason; parallel sessions need your approval. Each role reads only its task, the spec and the files it touches; the Coach runs weekly. The advisor is experimental, so Phase 1 measures whether it pays off.

**Check in shadow mode:** log usage per item for two weeks and confirm the weekly bar stays well below the cap before raising the target.

## Stations in detail

Each station is a contract: it accepts a defined input, produces a defined output, and passes work on only when its gate is met. In the lean lane, stations 2–3 share one session and station 5 is scripted checks plus one review session; the gates stay the same.

| # | Station | Input | Output | Exit gate | Owner |
| --- | --- | --- | --- | --- | --- |
| 0 | Define (once per project) | Your pitch of a few sentences, or an existing repo | Product brief, walking-skeleton starter, 5–10 seed issues | You merge claude/define with factory merge (brief approval); each seed issue gets owner:approved | Define agent + you |
| 1 | Intake | Ticket, bug report, alert, scanner finding, Dependabot alert | Triaged work item with type, priority, risk tier | Enters the line only once you approve it with a signed owner:approved; then classified and deduplicated; Intake may propose raising the tier, never lowering it | Intake agent |
| 2 | Specify | Work item + product brief | Spec: problem, acceptance criteria, non-goals, affected areas | Criteria testable; you approve the spec (tier 2–3) or skim it (tier 1) | Spec agent + you |
| 3 | Plan | Approved spec | Task list with dependencies, test plan, file list per task | Each task under size limit, every criterion mapped to a test, test tasks before implementation | Planner agent |
| 4 | Build | One task + repo snapshot | Branch with code, tests, docs | Tests seen failing first, then passing (factory ci red-green) | Builder agent (one task at a time) |
| 5 | Verify | Branch | Verification report | CI green; coverage ≥ 90% of changed lines; SAST, SCA, secret and licence scans clean; independent review done and blocking findings resolved | Test, Reviewer, Security agents |
| 6 | Integrate | Verified branch | Rebased branch, ready for your merge | CI green on the rebased branch; you merge with factory merge, which re-verifies the item's signed approvals | Integrator agent + you |
| 7 | Release | Main at a commit | Release notes, rollback path, deployment (behind a flag for tier 2–3) | Rollback path documented; you approve by running `factory deploy`; app healthy after deploy | Release agent + you |
| 8 | Operate and learn | Health summaries from each deploy, event log, your review comments | New work items, incident notes, lessons for the Coach | Incidents filed at Intake; lessons passed to the Coach | Ops and Coach agents + you |

## Agent roster

Twelve agent roles, all run as Claude Code cloud sessions on your Claude Pro plan. Each role is a separate session with its own instructions and tool permissions, run one at a time by default; no role can both write and approve a change. Exact tools per role are in Tools and permissions.

| Agent | Job | Works with | May not |
| --- | --- | --- | --- |
| Define | Turn your pitch (or an existing codebase) into the brief, starter and seed backlog; always ask its clarifying questions | Stack profile, Issues, code search | Start the line before you approve; pick a stack outside the approved profiles; touch guardrail files |
| Intake | Classify, deduplicate, assign risk tier; file scanner findings as issues | GitHub Issues, code search | Change code; lower a risk tier |
| Spec | Draft spec and acceptance criteria, ask you clarifying questions | Issues, brief, code search | Approve its own spec |
| Planner | Break the spec into tasks with file lists and a test plan | Spec, code search | Write code |
| Builder | Implement one task on a branch, tests first | Sandbox shell, repo (branch only), package registry | Push to main, touch secrets |
| Test | Write and run extra tests, property-based tests and formal checks | Test runners, coverage, proof and model-checking tools | Edit production code |
| Reviewer | Independent, advisory review against spec and standards | Diff, repo read, style guide | See the builder's reasoning; approve a merge |
| Security | Scan for vulnerabilities, secrets, licence issues; re-check fixes | SAST, dependency and secret scanners | Waive its own findings |
| Integrator | Rebase, resolve conflicts, prepare the merge | Repo, CI | Merge |
| Release | Write release notes and the rollback path; prepare the deploy | Release notes, `gh release` | Deploy (you run `factory deploy`) |
| Ops | Read health summaries and the event log; file incidents; write incident notes and the weekly metrics report | Event log, health summaries, Issues | Change code; deploy; edit role files |
| Coach | Run retrospectives, propose instruction and checklist changes | Event log, review comments, `.factory/lessons/`; role-file changes as pull requests to the factory repo | Change gates, permissions, budgets, guardrail files or the constitution; approve its own changes |

A **plain orchestrator script** (not an agent with judgement) routes work between them; see Control plane.

## Tools and permissions

The factory uses Claude Code's own tools (Read, Write, Edit, Bash, Grep, Glob, subagents) and does not define its own. What it defines is who may use which tool, on which files, and what runs around each call.

**Why not our own tool set:** our own tools mean our own agent program on the paid API. Your Pro plan covers Claude Code, cloud sessions and routines, not API calls from our code, so a custom tool set would break the budget and lose cloud sessions.

**Three layers, all committed to each project repo so cloud sessions pick them up:**

1. **Role definitions** in `.claude/agents/<role>.md`: instructions, model, and the `tools` each role may call.
2. **Permission rules** in `.claude/settings.json`: allow and deny lists for tools, file paths and shell commands.
3. **Hooks:** small scripts that Claude Code runs before and after each tool call, and when a session tries to stop.

Routines run without permission prompts, so these layers are the real guardrails, not the prompt. Phase 0 tests that each deny rule holds inside a routine.

| Role | Tools | Shell limited to | Always blocked |
| --- | --- | --- | --- |
| Intake | Read, Grep, Glob, Bash | `gh issue` (comments, `tier:` proposal) | Write, Edit; `owner:` and `state:` labels |
| Define | Read, Write, Edit, Bash, Grep, Glob | npm, git, `gh issue` | Push to main |
| Spec | Read, Grep, Glob, Write (`spec.md` in its feature folder only) | `gh issue` | Edits outside its `spec.md` |
| Planner | Read, Grep, Glob, Write (`plan.md` and `tasks.md` in its feature folder only) | none | Source code edits |
| Builder | Read, Write, Edit, Bash, Grep, Glob, subagents | npm, vitest, git on the item's branch | Push to main or any other branch, reading `.env`, files outside the task's list |
| Test | Read, Grep, Glob, Write and Edit (test files only), Bash | test runners, coverage | Edits to source files |
| Reviewer | Read, Grep, Glob, Bash, Write (`reports/` only) | `git diff`, `gh pr comment` | Edits to code, specs or tests; `gh pr merge`, `gh pr review --approve` |
| Security | Read, Grep, Glob, Bash | semgrep, gitleaks, npm audit | Write, Edit |
| Integrator | Read, Bash | `git rebase`, `gh pr` (except merge) | `gh pr merge` |
| Release | Read, Write (release and rollback notes on `claude/factory-log` only), Bash | `gh release` | Deploy commands (you run `factory deploy`) |
| Ops | Read, Grep, Glob, Bash, Write (`.factory/ops/` on `claude/factory-log` only) | `gh issue` | Code and spec edits; deploy commands |
| Coach | Read, Grep, Glob, Write (`.factory/lessons/` on `claude/factory-log` only), Bash | `gh pr create` (role-file proposals to the factory repo) | Editing settings, hooks, role files, gate policy or the constitution in a project |

Every agent is also blocked from adding or removing `owner:` and `state:` labels and from removing `pause:` labels, and denied any access to the approval signing key's path. Any agent may add a `pause:` label.

On top of the table, every role is denied Write and Edit on the guardrail files: `.claude/`, `.mcp.json`, hooks, `.github/workflows/`, `.factory/config` and `.specify/memory/constitution.md` (see Security: threats, supply chain and response).

**Hooks**

- **Before a tool call:** a path guard blocks writes outside the role's folders and the task's file list, and blocks every role from writing `events.jsonl` and `.factory/events/` directly; a command guard blocks pushes to main or to any branch other than the one named in the station prompt, merges, reads of secrets, changes to `owner:` and `state:` labels, and removal of `pause:` labels. For roles with a shell, these guards are defence in depth: the laptop checks at merge are what enforce.
- **After an edit:** format and type-check the touched file, so errors surface at once.
- **After every call:** append one line to the work item's event log (`events.jsonl` on the item's branch, or `.factory/events/` on `claude/factory-log` after merge); the hook fills in the timestamp.
- **When the session tries to stop:** check that the station's output file exists and is complete; if not, the session keeps going.

**Factory tools via MCP:** one small factory server, declared in the repo's `.mcp.json`, adds three tools: `advance_item` (asks the dispatcher to move the issue to the next `state:` label; the dispatcher's code checks the gate and verifies the signed record behind any `owner:` label first), `log_event`, and `request_split` (hand an oversized task back to the Planner). Everything else goes through Claude Code's tools and the `gh` CLI.

## Context management

Every station starts with a clean context and hands work on through files in the repo, never through conversation history; token budgets per role wait for real numbers from shadow mode.

**Rules**

1. **One station, one fresh session.** No session carries over from one station to the next.
2. **Hand-offs are files.** Each station writes a named file, and the next station reads only that file (table below).
3. **Load the minimum.** A session starts with a short `CLAUDE.md`, its role file, the work item and the hand-off file; it opens other files only when the task needs them.
4. **Explore in subagents.** Searching the codebase happens in a subagent with its own context, which returns a short summary.
5. **Full context means a task that is too big.** If a session gets near its limit or compacts once, it calls `request_split` and stops, rather than working on in a compressed context.

**How a work item flows through the files**

| Station | Reads | Writes |
| --- | --- | --- |
| 0 Define | Your pitch, the stack profile, the installed constitution | On `claude/define`: `.factory/brief.md`, starter code, `.factory/define/`; seed issues |
| 1 Intake | The issue, `brief.md` | Issue comments (first event entries), proposed `tier:` label |
| 2 Specify (`/speckit-specify`, `/speckit-clarify`) | The issue, `brief.md` | `specs/<issue>-<slug>/spec.md` |
| 3 Plan (`/speckit-plan`, `/speckit-tasks`, `/speckit-analyze`) | `spec.md` | `plan.md`, `tasks.md`: tasks, each with its file list and tests |
| 4 Build (`/speckit-implement`) | One task from `tasks.md`, the files it lists | Commits on the item's branch |
| 5 Verify | The pull request diff, `spec.md` | `reports/verify.md`, posted as a PR comment |
| 6 Integrate | Verify report, CI status | Rebased branch, ready for your merge |
| 7 Release | Merged commits, specs | Release notes and rollback path under `.factory/releases/` on `claude/factory-log` |
| 8 Operate and learn | Health summaries, event log, your review comments | New issues; incident notes and metrics report (`.factory/ops/`), lessons (`.factory/lessons/`) and event lines (`.factory/events/`) on `claude/factory-log` |

Stations 2–6 write inside the feature folder `specs/<issue>-<slug>/` on the item's branch `claude/<issue>-<slug>`; stations 7–8 write only to `claude/factory-log`.

Stations 2–6 write inside the feature folder `specs/<issue>-<slug>/` on the item's branch `claude/<issue>-<slug>`; stations 7–8 write only to `claude/factory-log`.

All paths after Station 0 are inside the feature folder `specs/<feature>/`.

**To decide later, from shadow-mode data:** token budgets per role, the size of `CLAUDE.md`, and whether any role needs a larger context window.

## Control plane

A small orchestrator script drives each work item through the stations; all state lives in GitHub and the repository, so nothing extra needs hosting. Agents do the work inside a step but never decide the route.

**Components**

- **Orchestrator:** the `factory` CLI. It picks the next ready issue by label and starts that item's current station as a Claude Code cloud session (`claude --cloud`) with the station's prompt; when the gate passes it moves the label on. The same logic runs in a daily cloud routine, so the line moves without the laptop.
- **Work item store:** GitHub Issues plus a Project board; one issue per work item; `owner:`, `state:` and `tier:` labels (see Branches, labels and records).
- **Artifact store:** the repository itself, in Spec Kit's layout: one feature folder per item, `specs/<issue>-<slug>/`, on the item's branch, holding `spec.md`, `plan.md`, `tasks.md` and `reports/` (verify and review reports, also posted as pull request comments).
- **Event log:** append-only `events.jsonl` in the item's feature folder until merge, then lines under `.factory/events/` on `claude/factory-log`; Intake's entries start as issue comments. Untrusted telemetry: it feeds metrics and the Coach, never a retry count, merge or gate decision.
- **Sandbox:** each cloud session's own isolated VM; GitHub credentials stay outside it, and network access uses the Trusted allowlist (package registries and common development hosts).
- **Model access:** your Claude Pro plan; Sonnet as the main model with an Opus advisor (see Capacity); the plan's usage limits are the spending cap.
- **Knowledge layer:** `CLAUDE.md`, the constitution (`.specify/memory/constitution.md`), Spec Kit templates in `.specify/templates/`, role instruction files and subagent definitions in `.claude/agents/`, architecture decision records in `/docs/adr`; cloud sessions pick these up from the cloned repo.

**Work item states**

`state:new → state:triaged → state:specified → state:spec-approved → state:planned → state:building → state:verifying → state:integrating → state:releasing → state:done`, with `state:blocked` and `state:escalated` reachable from any state. An item enters at `state:triaged` only after `owner:approved` (see Branches, labels and records).

**Retry policy:** a failed gate returns the item to the earliest station that can fix it, with the failure report; after 3 failed attempts it escalates to you (count to confirm in shadow mode). The dispatcher counts attempts only from gate failures it sees itself (a failed required check, a failing verify report), never from the event log, so a session that reports nothing still escalates.

## Branches, labels and records

Every work item lives on one branch of its own from your approval to your merge, everything written after a merge lands on one append-only data branch, and only approvals that come through the factory tool count.

### Branches

| Branch | Holds | Who writes | Reaches `main` |
| --- | --- | --- | --- |
| `claude/<issue>-<slug>`, one per work item | The feature folder `specs/<issue>-<slug>/` (`spec.md`, `plan.md`, `tasks.md`, `reports/`, `events.jsonl`) and the item's code and tests | Stations 2–6, each checking out the branch named in its prompt | When you merge the item's pull request with `factory merge` |
| `claude/define`, one per project, created by `factory new` / `factory adopt` | `.factory/brief.md`, the walking skeleton, `.factory/define/` | Define | When you merge Define's pull request with `factory merge`; that merge is the brief approval |
| `claude/factory-log`, one per project, long-lived | Post-merge event lines (`.factory/events/`), release notes (`.factory/releases/`), `.factory/ops/`, `.factory/lessons/` | Release, Ops and Coach; additions only | When you merge it with `factory merge`, weekly, alongside the Coach review |
| `factory/upgrade-<tag>`, created by `factory upgrade` on your laptop | The guardrail files of release `<tag>` and the new `factory_release` line | Only the factory tool; no agent may push to it | When you merge it with `factory merge` |
| `main` | Everything merged | Only you: signed merge commits and signed config commits | — |

- **Created by the dispatcher, not an agent:** when you approve an item (`owner:approved`), the dispatcher creates its branch and points Spec Kit at that feature, so `/speckit-specify` writes into that branch instead of creating its own. Phase 0 confirms how the installed Spec Kit (1.0.13) is told which feature and branch to use.
- **One item, one branch, one pull request:** a draft pull request opens at Specify; spec approval, CI, the verify and review reports and your merge all happen on it. Your merge brings the code and its whole trail into `main` together. The item stays under the size limit; bigger work is split by the Planner into more work items, never into several pull requests for one item.
- **Before the branch exists:** Intake logs to the issue's comments; when the dispatcher creates the branch it copies those entries as the first lines of `events.jsonl`.
- **After the merge:** stations 7–8 write only to `claude/factory-log`. `factory merge` checks that branch's diff on your laptop (additions only, allowed paths only, regular text files only); a CI job reports the same early.
- **Every merge is local and signed:** see Merging and verification on your laptop.

### Labels and approvals

| Kind | Labels | Set by |
| --- | --- | --- |
| Your gates | `owner:approved` (the item may enter the line; confirms its tier), `owner:spec-approved`, `owner:waiver` | Only you, through `factory approve` |
| Workflow state | `state:new`, `state:triaged`, `state:specified`, `state:spec-approved`, `state:planned`, `state:building`, `state:verifying`, `state:integrating`, `state:releasing`, `state:done`, `state:blocked`, `state:escalated` | Only the dispatcher, through `advance_item` |
| Risk tier | `tier:1`, `tier:2`, `tier:3` | Proposed by the agent that files the issue, or given by you with factory approve --tier; you confirm it when you approve; Intake may only propose raising it |
| Pause | `pause:line`, `pause:<station>`, on the Owner inbox issue | Added by you or any agent; lifted only by `factory resume` (see Pause and resume) |

Merge and release need no labels: your merge and your `factory deploy` are the approvals.

- **Each gate passes only on its own label.** The dispatcher moves an item to `state:spec-approved` only when it sees `owner:spec-approved` with a valid signed record; it never infers a gate from a state label or another gate's label. The tier 1 exception (spec skimmed, not approved) applies only to a `tier:1` you confirmed in a signed record.
- **A label alone proves nothing.** Cloud sessions and routines act on GitHub as you, so GitHub cannot tell your label from an agent's. The command guard blocks every agent from adding or removing `owner:` and `state:` labels, but that hook is only the first defence: an approval counts only with a signed record that no agent can produce (below).

### Signed approvals

An approval counts only if it carries your signature, made with a key that exists only on your laptop; anyone can check it, no agent can create it, and the irreversible steps (merge and deploy) are re-checked on your laptop.

| Piece | How it works |
| --- | --- |
| Signing key | One SSH key (`ed25519`), with a passphrase, stored only on your laptop. It signs approvals (namespace `factory-approve`) and git commits and tags (namespace `git`); a signature for one namespace never verifies for the other. It never enters a cloud environment, a repo or a secret store; Claude Code permission rules deny every agent access to its path, and it is never left unlocked in memory. |
| Public keys | The `allowed_signers` file in the pinned factory release lists every key you have used; a revocation file ships next to it. The newest key (the last line not revoked) must also match an environment variable on the cloud routine, which only you set at claude.ai. Rotation and compromise: see Merging and verification on your laptop. |
| Signed record | `factory approve` signs a short record with OpenSSH's built-in signing (`ssh-keygen -Y sign`, namespace `factory-approve`): repository, issue number, gate, confirmed tier, item branch, for spec approval the commit hash of `spec.md`, for a waiver its exact target (`waives: <target>`) and, for gate and test waivers, the head commit (`head: <sha>`), a timestamp and a one-time number. The passphrase is asked for every time. |
| Where it lives | Posted as an issue comment, where it stays; it is never copied into the event log, which is telemetry and proves nothing. Location does not matter: a copied, edited or replayed record fails verification. In the cloud, replay is prevented by what the record is bound to (item, gate, branch, spec hash); the one-time-number ledger lives on the laptop. |

**What the signed content blocks:** a record for one item does not verify for another; a spec approval stops verifying as soon as `spec.md` changes; a waiver covers only the exact target it names, so a `dep:` waiver or a dismissal never satisfies a gate, and a waiver for one gate never satisfies another; a waiver bound to a head stops counting as soon as the head moves; a one-time number cannot be used twice.

**Which waivers are bound to the head:** gate waivers (`waives: gate:<name>`) and test-removal waivers (`waives: test:<path>#<title>`) carry `head: <sha>`, and one without a head is rejected. `dep:` waivers are already tied to a package version, the upgrade waiver to `<tag>@<sha>`, and dismissals and `parallel_sessions` do not depend on code, so those stay as they are. Integrate's rebase changes the head, so a waiver signed earlier stops counting. `factory merge` then shows only the item's own changes since the waiver (`git range-diff <old-base>..<waived-head> <new-base>..<head>`), not the other items merged to `main` meanwhile, and asks you to re-sign in the same step, the same pattern as a spec approval tied to the spec's hash.

**Two independent checks:**

1. **The dispatcher, as code:** `factory dispatch` verifies every `owner:` label with `ssh-keygen -Y verify` and decides by exit code, never by model judgement. A label without a valid record stops the item and alerts you. These cloud-side decisions are advisory: they control what runs next, not what reaches `main`.
2. **Your laptop, before anything irreversible:** `factory merge <pr>` re-verifies the item's whole chain of signed approvals, checks the diff, and makes a signed local merge commit; `factory deploy` re-checks every item it ships. If the cloud-side checks were bypassed, a forged approval could at most spend usage and open a pull request that your laptop refuses to merge.

**Residual risks, accepted:**

- **Local mode:** with `agents: local`, agent sessions run on the same laptop as the key; the passphrase protects it. A hardware security key needing a physical touch is an optional upgrade at extra cost.
- **Laptop compromise:** the laptop is the single anchor of trust; if it is compromised, so are approvals.
- **Stolen key before revocation lands:** until the release revoking it is merged, the pinned key list still trusts it. Changing the routine's environment variable halts the cloud side at once; what remains is anything done on the laptop, which falls under laptop compromise.
- **The GitHub merge button stays available** on GitHub Free; a merge made with it produces an unsigned commit on `main`, which `factory merge`, `factory deploy` and the dispatcher detect.

### Pause and resume (the kill switch)

Anyone in the factory can stop the line at once with an unsigned `pause:` label on the pinned Owner inbox issue; only you can restart it, with a signed `factory resume`.

**Owner inbox issue:** one pinned issue per project, created by `factory new` and `factory adopt`. It holds the pause labels and receives every alert: tampering, failed signatures, unsigned merges, critical findings, escalations.

| Label | Scope |
| --- | --- |
| `pause:line` | The whole line |
| `pause:<station>` (`pause:intake`, `pause:specify`, `pause:plan`, `pause:build`, `pause:verify`, `pause:integrate`, `pause:release`, `pause:operate`) | One station |

**Who may pause and resume:**

- **Add a pause:** you (from the GitHub web or mobile app, or `factory pause [station]`) or any agent, for example Security or Ops on a secret leak. A pause only stops work, so no signature is needed and the worst misuse costs time.
- **Lift a pause:** only `factory resume [station]` on your laptop. It signs a record (namespace `factory-approve`, gate `resume`, the scope, a timestamp and a one-time number), posts it to the inbox issue and removes the label. The command guard blocks agents from removing `pause:` labels.

**A removed label does not end a pause.** The dispatcher works out pause state from the inbox issue's label history: a scope is paused if a `pause:` label for it was ever added and no valid signed resume record for that scope came after. If the label disappears without one, the dispatcher puts it back and alerts you.

**What a pause does:**

- **Whole line:** the routine exits at once on every run; the dispatcher starts no new session; `advance_item` refuses every move. Sessions already running finish their current step but cannot advance; to stop one at once, archive it at claude.ai.
- **One station:** items wait when they reach it; everything else keeps moving.
- **Your laptop commands:** `factory merge` and `factory deploy` warn during a pause and ask you to confirm, so you can still ship a fix (for example after rotating a leaked secret).
- **One item:** no pause label needed; `state:blocked` covers it.

### Merging and verification on your laptop

CI and the event log can both be shaped by the pull request or the agent that produced them, so neither decides anything on its own: every merge is checked and signed on your laptop, and only signed history, signed records and laptop checks count.

**What can be trusted:**

| Source | Trusted for decisions? | Why |
| --- | --- | --- |
| Signed records and signed commits | Yes | Made with a key that exists only on your laptop |
| Checks `factory merge` runs on your laptop | Yes | Computed from the exact commit being merged, outside any agent session |
| CI on a pull request | Only after the laptop check passes | GitHub runs the pull request's own workflow files; once the laptop confirms no protected file changed, CI ran the pinned workflows |
| The event log (`events.jsonl`, `.factory/events/`) | No: telemetry only | Written inside agent sessions, where any agent with a shell can write any file; useful for metrics and the Coach, never for a retry count, a merge or a gate decision |
| Agent path rules (path guard) | Defence in depth | They cover Claude Code's Write and Edit tools, not a shell |

The dispatcher's own gate decisions are therefore advisory, and it counts retries only from gate failures it sees itself: a forged event can neither delay escalation nor merge anything.

**Signed history on `main`:**

- **`factory merge` merges locally.** It fetches the commit it checked, makes the merge commit with `git merge --no-ff -S <sha>`, and pushes it to `main`. GitHub's own merge would sign with GitHub's key, not yours. If `main` moved meanwhile, the push is rejected, so exactly the checked commit is merged. If the pull request's head moved after the check, GitHub cannot mark it merged; `factory merge` closes it with a note naming the merged commit, and the extra commits never reach `main`. After the merge it deletes the item's branch.
- **Each item merges once.** `factory merge` refuses any pull request whose issue already has a signed merge commit on `main`, so a re-created branch cannot replay the item's old approvals into a second merge. `factory merge` writes a `Factory-Merge: #<issue>` trailer into the signed merge commit (`Factory-Merge: define`, `upgrade <tag>` or `factory-log` for the other pull requests); only trailers on your signed first-parent commits after the baseline count. A gate failure found after the merge never sends the item back to an earlier station: it moves on to `releasing` with an alert, and the dispatcher files the problem as a new issue.
- **After a merge, the branch is closed for good.** Any new push to a merged item's branch, or its re-creation, is treated as tampering: the dispatcher alerts you on the Owner inbox issue. This rests only on the merge, the branch deletion and GitHub's push events, none of which is telemetry.
- **A running session is a warning, not a block:** if a session for the item appears to be running, `factory merge` warns you and asks you to confirm. That can only be read from telemetry (dispatcher comments, `.station.json`), which is not trusted for decisions, so it can neither allow nor block a merge on its own. It only spares you false tampering alerts from a late but honest push. If telemetry lies, the worst outcome is a false alert or a merge you chose to delay, never an unchecked merge.
- **Every first-parent commit on `main` must be signed by you.** That covers merge commits from `factory merge` and config commits from `factory config set`. `factory merge` and `factory deploy` refuse to run if one is not, and the dispatcher raises a tampering alert on the Owner inbox issue. A commit pushed straight to `main`, or a merge made with the GitHub button, is caught here.
- **Starting point:** `factory new` creates the GitHub repository empty (no auto-generated README) and pushes a signed first commit, so the rule holds from the very first commit. `factory adopt` records the hash of the last unsigned commit as `baseline` in `.factory/config`, and its own signed commit comes right after it; every first-parent commit after the baseline must be signed. The dispatcher fetches enough first-parent history to reach it; the laptop checks incrementally from the last commit it verified.
- **No separate merge record:** the signed merge commit is the record. Only deploys, which make no commit, keep a signed `deployed` record.

**What `factory merge` checks on the laptop, for every pull request:** CI green on the checked commit, every approval in the item's chain verified, and the diff computed by the laptop itself against `main` from git's raw data: the changed files from `git diff-tree -r -z --no-renames`, and each file's lines from a blob-to-blob diff with `--text --no-ext-diff --no-textconv`. Plain `git diff` would still apply the pull request's own `.gitattributes`, so a `-diff` or binary marking could hide changed lines. Read raw, the diff cannot be hidden by any attribute, binary marking or diff driver. On that diff it checks:

- **Protected paths:** no protected path is touched (see Guardrail protection), except in an upgrade pull request; no waiver overrides this.
- **`.factory/config`:** protected but not hashed against the release; outside an upgrade pull request it may not change at all, and in one only the `factory_release` line may change. Other changes (`agents`, `parallel_sessions`) are your signed commits on `main`, made with `factory config set`.

**Non-item pull requests:** three pull requests belong to no work item; any other pull request without a work item is refused.

| Head branch | Extra checks by `factory merge` | Effect |
| --- | --- | --- |
| `claude/define` | Define output check: the brief has all required sections; the starter runs, has one test and passes CI; 5–10 seed issues, each with a proposed tier; no protected path touched | Brief approved. Until this merge is on main the dispatcher admits no item at all; afterwards each seed issue still needs `owner:approved` (its own signed approval). When you revise the vision, the previous Define pull request must be merged or closed first. |
| `factory/upgrade-<tag>` | The tag's signature verifies with the currently pinned key list; the tag still points to the commit you approved; the whole protected set at the pull request's head equals the release manifest at that commit, every file present with a matching hash and no extra protected file; a signed `owner:waiver` for `guardrail-change@<tag>@<sha>` | Release `<tag>@<sha>` pinned; if the newest key changed, the line stops in "key rotation pending" until the routine's environment variable is updated |
| `claude/factory-log` | Every changed line is an addition at the end of an existing file or in a new file; every path is under `.factory/events/`, `.factory/ops/`, `.factory/lessons/` or `.factory/releases/`; only regular text files (no binary, symlink, executable bit, submodule, or `.git*` file); no protected path, and no waiver overrides this | Weekly log merge |

**CI as an early warning:** workflows call `factory ci test`, `coverage`, `lint`, `scan`, `ac-map`, `red-green`, `append-only` and `guardrail-change` directly, never `npm test` or the project's own configs (those stay for local development). The Vitest, ESLint, Semgrep and gitleaks configs, the licence allowlist and every threshold ship in the pinned factory release. CI checks out the factory repo at the pinned commit and builds it with its own build script; dependencies install with scripts off; the project's `devDependencies` never supply the checker.

**Tests seen failing first, made checkable:** `factory ci red-green` and `factory ci ac-map` share one rule, and nothing an agent declares can switch it off. They run only on item pull requests; `claude/define`, `claude/factory-log` and upgrade pull requests have no spec and follow their own rules (see the table above).

- **A spec without IDs fails:** both checks fail if the item's spec has no `AC-###` IDs, or if any acceptance-criterion line lacks one. This holds at every tier, including tier 1, where the spec is skimmed rather than signed. **Criterion lines** are every list item under Acceptance Scenarios or Edge Cases and, elsewhere, any line with two or more of Given/When/Then or one of them in bold; each must start with exactly one `**AC-###**`. **The checked set** is, at tier 2–3, the IDs in the spec you approved and, at tier 1, every ID that ever appeared in `spec.md` on the branch, so deleting a criterion needs your `gate:ac-<id>` waiver. An empty checked set fails both checks, and `factory merge` repeats them.
- **One rule per criterion:** every criterion needs at least one test whose own title carries its ID, and that test must fail at the merge base and pass at the head. `ac-map` checks the tagged test exists; `red-green` checks it goes from failing to passing. Other new tests may pass at the base (they describe behaviour that already exists).
- **IDs are matched strictly:** one ID per test, matched as a whole word in the test's own title (a `describe` block's title does not count), so `AC-0011` never counts for `AC-001`. A test whose title carries more than one ID counts for none of them and is listed for review.
- **Changed tests count by their new version:** a changed test counts if its head version fails when run against the base code. In that run, files under the test paths come from the head and everything else from the base.
- **Test paths are defined by the release:** the `include` patterns minus the `exclude` patterns of the release's Vitest config, the same config CI runs. The project never defines them. Setup files (`setupFiles`, `globalSetup`) and helpers outside those patterns count as non-test files.
- **Test-only items are detected from the diff:** if no file outside the test paths changed, `red-green` is skipped (`ac-map` still runs). This automatic skip is the one gate skip that needs no waiver.
- **Refactors need your signed waiver** for `gate:red-green`, bound to the head commit (see Signed approvals). Item type is set by Intake and is not covered by your signature, so it never decides this.
- **Weakened tests need your waiver:** `factory merge` lists every test the pull request skips, focuses, retries or deletes (`.skip`, `.todo`, a `.only` that excludes others, an added retry, a removed test block or test file), every removed assertion, and every changed setup or helper file. Each of these needs your signed waiver (`waives: test:<path>#<title>`, bound to the head), so no item, test-only or not, quietly drops or weakens an earlier item's tests. A removed assertion fails even when it only moved into a helper; you waive those cases. **Quarantining a flaky test is no exception:** it needs the same waiver plus a `quarantine #<n>` note next to the skip naming an open issue, and when that issue closes the dispatcher flags any skip still pointing to it. A test waiver never waives `gate:red-green`: a skipped test cannot cover the item's own criteria.

**What red-green cannot prove:** that the right thing changed. An agent can tag a test that fails at the base for an irrelevant reason, such as importing a symbol that does not exist there yet, and then asserts little. Red-green shows that something changed between base and head; independent review stays the defence for whether it is the right thing. Mutation testing is a deferred option.

**Releases and keys:**

- **`factory release <tag>`** runs on the laptop: it shows the diff since the last signed tag and asks you to confirm it, builds the manifest, signs the tag (git's SSH signing, same key, namespace `git`) and pushes it. CI only attaches files to the release. Projects pin `factory_release: <tag>@<sha>`; the session-start check fetches the manifest by commit hash.
- **Which key verifies a tag:** `factory upgrade` uses the currently pinned key list; `factory new`, with no pin yet, uses the laptop's own list.
- **Key list and revocation:** `allowed_signers` keeps every key you have used, each line limited to the namespaces `git` and `factory-approve`; a revocation file ships next to it and is passed to `ssh-keygen -Y verify -r` and git's `gpg.ssh.revocationFile`. The newest key is the last line that is not revoked; the two-copy check compares it with the routine's environment variable.
- **Rotation:** `factory keygen --rotate` adds a new key; you keep the old one until the upgrade carrying the new key list is merged (its merge commit is signed with the old key), then the old private key is deleted. Records signed with old, unrevoked keys keep verifying, so items in progress are unaffected. If the routine's variable still holds the previous key, the dispatcher enters "key rotation pending": one urgent alert, no tampering alarms.
- **Compromise:** the new release revokes the stolen key; everything signed with it stops verifying, and `factory upgrade` lists the items you must approve again. Changing the routine's environment variable first halts the cloud side at once, because the two-copy check then fails for every record.
- **Revocations only accumulate:** `factory upgrade` refuses any release (including an older one used for rollback) whose revocation file lacks an entry the current one has.

**The factory repo's own `main`:** the same rules apply. Merges are made with `factory merge` on the laptop after a laptop check of the factory repo's protected paths (its own workflows and the factory's self-protection files) and CI green on the checked commit; its first-parent history is signed. Signing can start during bootstrap: set git's `gpg.format` to `ssh` and merge from the laptop. The first signed release is the anchor of trust, so before signing it you review the whole tree, not just the latest diff.

## Considered and deferred: LLM gateway

An LLM gateway (a proxy between Claude Code and the model, for routing, access control, budgets, logging, guardrails and fallbacks) was considered on 1 October 2026 and deferred: it cannot see the factory's main traffic, it works against the budget, and the design already covers most of what it offers.

**Why deferred**

- **It can't sit in front of cloud sessions.** Stations run as Claude Code cloud sessions and routines on Anthropic's infrastructure, which call the model from there. A gateway would cover only the local fallback path.
- **It fights the budget.** Most gateway features need a gateway credential, and requests carrying one are billed per token instead of drawing on the Pro plan. It also needs hosting the 4 GB laptop can't spare, and upkeep as Claude Code adds features.
- **Most capabilities are already covered:**

| Capability | Covered today by |
| --- | --- |
| Model routing | Model per role; Sonnet with Opus advisor (gateways can't route Claude Code to non-Claude models) |
| Security and access control | Credentials kept outside cloud VMs; permissions per role; network allowlist |
| Cost and rate limits | Pro plan limits as the hard cap; usage logged per item; one session at a time; kill switch |
| Logging and tracing | Event log written by hooks; session transcripts (the one real gap: full prompt and response capture) |
| Guardrails | Hooks and deny rules where tools actually run |
| Fallbacks and retries | Claude Code's built-in retries; dispatcher retry and escalation; local fallback |

**What we do instead**

- The `factory` dispatcher is the control layer: usage budget per item, retries, kill switch.
- Phase 0 checks whether Claude Code's OpenTelemetry export can send traces from cloud sessions; if it can, that closes the tracing gap.
- All model settings stay in Claude Code's own configuration, so adding a gateway later is a configuration change, not a redesign.

**Revisit when** the factory moves to API billing, gains a second user, needs to switch providers, or falls under a compliance regime that requires central logging of every request. Options then: Anthropic's self-hosted Claude apps gateway, or a third-party gateway exposing an Anthropic-format endpoint.

## Hosting: agents in the cloud, app on the laptop

Every agent session runs as a Claude Code cloud session on an Anthropic-managed VM, so the 4 GB Crostini laptop never runs a model session; it only dispatches work, receives your approvals and runs the app.

| Where | What runs there | Why |
| --- | --- | --- |
| Claude Code cloud sessions | Every station's agent: clone the repo, edit, run the full test suite, push a `claude/` branch, open or update the pull request | Included in Pro with no compute charge; isolated VM per session; keeps running when the laptop sleeps |
| Cloud routines | A daily routine that advances the line; a GitHub trigger that starts review when a pull request opens | Self-running with the laptop closed |
| GitHub-hosted runners | CI on every pull request: tests, type check, lint, scanners, Playwright, TLA+ and Dafny | A second, independent check of what the session reports |
| Laptop (Crostini) | `factory` dispatcher (`claude --cloud` under the hood), your approvals, the app (Node.js + SQLite) | Light: no model runs locally |

**Limits to respect:**

- Cloud sessions share your Pro usage limits; parallel sessions use them up faster, so the dispatcher runs one station at a time by default.
- Routines have a daily cap on scheduled runs per account (shown at claude.ai/code/routines); one-off runs don't count toward it. GitHub triggers have hourly caps. Both features are in research preview.
- Idle sessions are reclaimed; a session waiting for your answer can be reopened, but background work in it is not restored, so each station writes its result to GitHub before it waits.
- Private project repos need the Claude GitHub App installed for cloning and triggers; `factory new` and `factory adopt` ask for your consent to this on every project.

**Fallback:** if cloud sessions are unavailable, the same station prompts run locally in Claude Code on the laptop, one at a time, as in v0.7; a larger machine remains a later option.

## Quality gates and human-in-the-loop

You approve every merge; the risk tier decides how much verification happens before the change reaches you.

| Risk tier | Examples | Spec | Verification before you review | Release |
| --- | --- | --- | --- | --- |
| 1 — Low | Copy changes, dependency patch bumps, test-only changes | One-line spec, you skim it | Standard checks | Rollback path documented; you deploy after merge |
| 2 — Medium | New endpoint, UI feature, schema addition | Full spec, you approve | Standard checks + property-based tests on changed logic | Rollback path documented; behind a flag you turn on |
| 3 — High | Auth, billing, data deletion, migrations, public API changes | Full spec + risks section, you approve | Tier 2 + formal verification of the critical property + a second independent review | Written, tested rollback step; behind a flag you turn on |

Intake assigns the tier; you may raise it at any gate; agents never lower it.

**Automated checks at every merge (all tiers):**

- [ ] Build and full test suite pass
- [ ] Every acceptance criterion maps to at least one passing test, and new tests were seen failing before the change made them pass
- [ ] Coverage on changed lines at least 90%
- [ ] Lint, type check, SAST, secret scan and licence scan clean
- [ ] Independent review report attached and blocking findings resolved (the Reviewer's verdict is advisory; CI and you decide)
- [ ] Diff under size limit, or split

**Also in force:** flaky tests are defects, fixed or quarantined with an issue you can see; agents never weaken, delete or skip tests without your approval; skipping any gate needs a waiver you record, except the automatic test-only skip of `red-green` (see Merging and verification); every approval request comes with a summary whose required fields depend on the gate (below).

**Approval summaries, per gate:** each gate's list is a constant in the factory code, so it ships with the pinned release, and marks every field as required or not applicable. A field is in one of three states:

- **Present:** shown to you.
- **Not applicable (—):** only the gate's list can say this. Nothing in the summary can mark a required field as not applicable.
- **Missing:** a required field that is absent or empty. `factory approve` and `factory merge` refuse to sign. An empty field never counts as "none": a field with nothing to report says so explicitly (for example, "none identified" for risks).

| Gate | What changed | Spec mapping | Tests and review | Usage | Known risks |
| --- | --- | --- | --- | --- | --- |
| Admission (`factory approve <issue>`) | The request: issue title and body (authorship is not shown as a fact: agents act through your account) | — | — | Shown when available: estimate for the proposed lane, and weekly headroom left | The tier (proposed label or --tier); type and priority labels only if present, since Intake runs after approval |
| Spec approval | The spec at the commit being signed; on re-approval, the diff from the last approved spec | Acceptance criteria with their IDs (no test tasks yet: Plan runs after this gate) | — | Spent so far, and estimate to finish | Risks (a risks section at tier 3) |
| Waiver | The target and what it skips; for head-bound waivers, the diffstat since the merge base and, after a rebase, the range-diff since the waived head | Criteria affected | The result being waived | — | Why the waiver is safe |
| Merge (`factory merge`) | Diff at the checked commit; removed or skipped tests; changed setup files | Criterion-to-test map | CI results for that commit; review verdict | Spent, against the estimate | Open findings; waivers in force |
| Deploy (`factory deploy`) | Items and commits shipped | — | CI on main's head (the deploy record is signed before anything runs; health checks follow in the health summary) | — | Rollback step |
| Resume (`factory resume`) | What was paused, and why | — | — | — | What changed since the pause; alerts raised during it |

**Where the fields come from:** the command fetches once, resolves the branch to one commit, and builds every field itself from the issue and the files at that commit, never from a summary an agent wrote; the summary prints the commit. Each field is labelled with its source: computed on your laptop (diffs, AC counts, `ac-map` and `red-green` run locally, your signed tier), or quoted agent text with its file and commit. **Usage is never required:** it comes from `events.jsonl`, which is telemetry, so when it is missing the summary says "unavailable (telemetry missing)" and carries on; telemetry never blocks or allows a signature. Merges of `claude/define`, upgrade and log pull requests use the merge row, with that branch's own check as tests and review (Define output check, manifest equality, append-only) and, for an upgrade, the keys it revokes and the in-flight items that used them as risks. Every quoted text is cleaned by Unicode category (control, format, line and paragraph separators removed; newline kept), so no text can hide or fake a line.

**Formal verification, where it pays:** used on small, critical parts only (state machines, permission rules, money calculations). The Test agent writes a model or proof of the one property that matters (for example "a refund never exceeds the original charge") and checks it with a model checker or proof tool. Everything else relies on tests and property-based testing; the tools are TLA+ and Dafny (see Tech stack).

**Escalation:** any station can raise a question to you; the item waits in `blocked` without consuming budget.

## Security, governance and cost controls

Agents run with least privilege in disposable sandboxes, and every action is logged and attributable.

**Security**

- Agents never hold production credentials; deploys run on your laptop through the factory deploy command, outside any agent session.
- Sandboxes are ephemeral cloud VMs, with network egress limited to the Trusted allowlist.
- Secrets are injected only at runtime into CI, never into agent context.
- Untrusted text (tickets, issue comments, web pages, dependency READMEs) is treated as data; agents cannot act on instructions found in it without a human.
- Merges to main need your signed local merge through `factory merge`, and every first-parent commit on `main` must carry your signature (see Merging and verification on your laptop). GitHub Free offers no branch protection on private repos, so this signed history, not GitHub, is what protects `main`.

**Cloud sessions**

- Each session runs in its own isolated VM; GitHub credentials and keys stay outside it, and a proxy authenticates on its behalf.
- Sessions push only to `claude/` branches; `main` is guarded by the command-guard hook, so nothing merges without your approval.
- Routines run without permission prompts, so each routine gets only the repositories it needs and no extra connectors.
- Text passed to a routine from outside (issue bodies, API payloads) is treated as untrusted data by default; station prompts keep it that way.

**Public factory repo**

- It holds only generic material: code, role instructions, templates, profiles. No project code, briefs, lessons or benchmark items ever go into it.
- The replay benchmark lives in a separate private repo that the factory reads at run time.
- General lessons are rewritten by the Coach without project details before they become a pull request to the factory; you check that before approving.
- In every repository, the orchestrator acts only on work items you approved with a signed record (`owner:approved`, applied through `factory approve`). Issues Intake files from scanner findings or Dependabot alerts wait for that approval, and so do issues you write yourself: authorship never counts, because agents act through your GitHub account. Nothing is admitted until the brief is merged; other people's issues and pull requests on the public repo are data to read, never instructions.
- Licence: MIT.

**Governance**

- Full audit trail per work item: prompts, tool calls, diffs, reports, approvals.
- Agent-authored commits are labelled with agent role and work item id.
- Policy as code for risk tiers and approval rules, reviewed like any other code.

**Cost**

- **Extra cost: £0.** The factory runs on the Claude Pro plan you already have (US$20 a month, about £19.50 to £21 in the UK with VAT). Claude Code is included and shares one usage pool with your own chats. No pay-as-you-go API spend.
- **GitHub Free:** the public factory repo gets unlimited Actions minutes; private project repos share 2,000 free minutes a month on GitHub-hosted runners, plenty for 3–5 items a week if CI runs once per pull request update. The runner's minute use is logged so it never surprises you.
- **Usage is the real budget:** see Capacity for how the pipeline fits Pro's limits.
- **Kill switch:** a `pause:line` or `pause:<station>` label on the pinned Owner inbox issue stops the line or one station at once; only a signed `factory resume` lifts it (see Pause and resume).

## Security: threats, supply chain and response

The factory is most exposed where three things meet: agents that can read private code, content they cannot trust (repo text, dependencies, test output, web pages), and any way to send data out. The defences below keep those three apart, stop agents from changing their own guardrails, and turn every finding into a tracked fix.

### Threat model

| Threat | Example | Main defences |
| --- | --- | --- |
| Prompt injection from content | A README, code comment or test output tells the agent to copy a file somewhere | Content is data, never instructions; no secrets inside sessions; network allowlist; path and command guards |
| Guardrail tampering | An agent edits `.claude/settings.json` or a CI workflow to lift a block | No role may edit guardrail files; `factory merge` refuses any pull request touching a protected path, computed on your laptop |
| CI that approves itself | A pull request edits a workflow, a test script or a tool config so its own checks pass | Laptop protected-path check before CI is trusted; CI calls `factory ci` built from the pinned commit, with configs and thresholds from the release, never `npm test` or project configs |
| Forged approval | An agent adds `owner:approved` or `owner:spec-approved`, which GitHub records as you | Command guard blocks agents from `owner:` and `state:` labels; approvals need a record signed with a key only your laptop holds; the dispatcher verifies it as code, and `factory merge` and `factory deploy` re-verify on your laptop |
| Stretched waiver | A waiver for a dependency, another gate or an earlier head is presented for `red-green` | Records sign the exact target (`waives: <target>`) and, for gate and test waivers, `head: <sha>`; after a rebase you re-sign against a range-diff of the item's own changes |
| Replayed merge | An agent re-creates a merged item's branch and opens a new pull request with the old approvals | `factory merge` refuses an issue that already has a signed merge on `main`; re-creating the branch raises a tampering alert |
| Unauthorized resume | An agent removes a `pause:` label to restart a stopped line | Command guard blocks removing `pause:` labels; pause state comes from label history, so only a signed `factory resume` lifts it; a missing label is restored and you are alerted |
| Bypassing the merge | An agent pushes a commit straight to `main`, or a merge is made with the GitHub button | Every first-parent commit on `main` must be signed by you; `factory merge`, `factory deploy` and the dispatcher detect any that is not |
| Moved or forged release tag | An agent moves a factory release tag to its own commit | Tags are signed on your laptop by `factory release`; projects pin `<tag>@<sha>`; `factory merge` refuses an upgrade whose tag moved or whose files differ from the manifest at that commit |
| Rollback to a revoked key | A downgrade pins an older release that still trusts a stolen key | Revocations only accumulate: `factory upgrade` refuses a release missing any current revocation |
| Secret exfiltration | Code or a workflow sends a token to an outside host | Secrets never enter cloud VMs; deploy runs on your laptop, not in Actions; workflow changes refused at merge |
| Fake or malicious dependency | An agent adds a lookalike or non-existent package | New-dependency gate; install scripts off; lockfile committed |
| Reviewer manipulation | The diff contains text telling the Reviewer to approve | Reviewer verdict is advisory; CI and your approval decide |
| Red-green dodge | An agent writes criteria without IDs, tags one test with every ID, or deletes or skips earlier tests | A spec without IDs fails; one ID per test, matched strictly; test paths from the release; removed or skipped tests each need your signed waiver |
| Weak tests | A tagged test fails at the base for an irrelevant reason (a missing import), then asserts little | `red-green` proves that something changed, not the right thing; independent review is the only defence for that |
| Lesson poisoning | Untrusted text in the logs becomes a "lesson" | Coach changes are pull requests you review; lessons can never touch guardrails |
| Log tampering | An agent rewrites history in `events.jsonl` or `claude/factory-log` | The log is telemetry, never trusted for decisions; `factory merge` accepts only additions under allowed paths |
| Factory supply chain | A malicious pull request to the public factory repo | Factory-repo merges are signed local merges after a laptop check; releases are signed tags you review; projects pin `<tag>@<sha>`; outside pull requests never trigger agents |

### Guardrail protection

- **Protected files:** `.claude/`, `.mcp.json`, the hooks folder, `.github/workflows/`, `.factory/config`, `.specify/memory/constitution.md`, the lockfile policy, and every `.gitattributes` and `.gitmodules` anywhere in the repo. Every role is denied Write and Edit on them. `.factory/config` is protected but not hashed against the release (see Merging and verification on your laptop).
- **Only the factory tool changes them:** `factory new` and `factory adopt` install them from the pinned factory release when a project starts, and `factory upgrade` updates them through a `factory/upgrade-<tag>` pull request you merge. No agent installs or edits them; an agent may only propose a change (for example a constitution amendment) as a pull request to the factory repo, which reaches projects in a later release.
- **Merge check:** `factory merge` refuses any pull request that touches a protected file, computed on your laptop, except an upgrade pull request that matches its release manifest. The `guardrail-change` CI job reports the same problem early, but cannot be trusted on its own, because a pull request can change the workflow that runs it.
- **Integrity at start-up:** a session-start hook compares the guardrail files with the manifest of the pinned release, fetched by commit hash, and compares `.factory/config` with `main`'s copy; any mismatch stops the session and alerts you.

### Scanning and supply chain

| Check | Tool | When |
| --- | --- | --- |
| SAST (code patterns) | Semgrep Community Edition | Every pull request; weekly on `main` |
| SCA (known vulnerabilities in dependencies) | npm audit, Dependabot alerts | Every pull request; Dependabot watches continuously |
| Secret leaks | gitleaks | Before each commit (hook), every pull request, weekly across full history |
| Licences | license-checker against an allowed-licence list | Every pull request that changes dependencies |
| New-dependency gate | Factory check: package exists, is not a near-name of a popular one, has real age and usage; then your approval | Whenever a pull request adds a dependency |
| Install safety | `npm ci --ignore-scripts`, committed lockfile, exact versions | Always |

Dependabot alerts and security updates are free on private repos. GitHub's own secret scanning and CodeQL are paid for private repos, so gitleaks and Semgrep cover those at no cost. In CI every scanner runs through `factory ci scan`, with configs and the licence allowlist from the pinned factory release, never from the project.

### Agent-assisted triage and remediation

1. **Detect:** a finding comes from CI, the weekly scan of `main`, or a Dependabot alert.
2. **File:** Intake turns each finding into an issue labelled `security`, deduplicated by rule and location; it enters the line once you approve it with `factory approve`, and critical or high findings notify you at once.
3. **Triage:** severity sets the lane and a target time: critical and high go to the full lane and jump the queue (targets such as 2 days and 1 week, to confirm in shadow mode); medium joins the normal queue; low goes to the backlog.
4. **Fix:** the Builder updates the dependency or patches the code, and adds a regression test that reproduces the finding.
5. **Verify:** the Security agent re-runs the scanner on the branch; the finding must be gone and CI green before it reaches you.
6. **Close or dismiss:** dismissing a false positive needs a written reason from the Security agent and your approval, recorded in `.factory/security/dismissals.md` with a date to re-check.

**If a secret leaks:** Security or Ops adds `pause:line`, you rotate the secret, the Ops agent writes a short incident note with the cause and the new check that would have caught it, and you lift the pause with `factory resume`.

## Self-improving, self-running agents

Every finished item teaches the factory something: the Coach agent turns lessons into instruction changes, and a change is kept only if you approve it and it does no worse on a replay of past work.

**The improvement loop**

1. **Capture.** Each station logs its gate result, rework loops and your review comments to the event log.
2. **Retrospect.** Weekly (to save usage), the Coach reads the log and writes lessons per role: what failed, what you corrected, what repeated.
3. **Propose.** Project-specific lessons go to `.factory/lessons/` on `claude/factory-log`. Changes to role instructions, checklists, skills or lint rules are pull requests to the factory repo, because role files are guardrail files in every project; they reach projects through `factory upgrade`.
4. **Evaluate.** The changed role is replayed on a small benchmark of past items (start with 5 to 10) and compared with the current version on first-pass gate rate.
5. **Adopt or discard.** You approve or reject; role instructions are versioned, so a regression rolls back with one revert.

**Self-running:** a daily cloud routine runs the orchestrator logic on Anthropic's infrastructure, laptop closed or not; a GitHub trigger starts the Reviewer when a pull request opens. Each run works ready items until it reaches one of your approval gates or the usage limit, then leaves a summary on the issue.

**Guardrails:** the Coach can edit instructions, not gates, permissions, budgets, guardrail files or the constitution; it cannot approve its own pull requests. The replay benchmark only grows: items are added, never removed or edited inside a Coach change; only you may retire an obsolete item, in a separate change of your own.

## Metrics

The factory is judged on flow, quality and cost; targets are to be set after a baseline month.

| Metric | Measures | Why it matters |
| --- | --- | --- |
| Lead time (request to production) | Flow | The headline speed number |
| Throughput per week, by risk tier | Flow | Capacity of the line |
| Autonomy rate | Flow | Share of items that ship with no human rework beyond approvals |
| First-pass gate rate, per station | Quality | Where the line jams or loops; tracked per role version to show if the Coach helps |
| Escaped defects and rollbacks per 100 releases | Quality | Whether gates actually work |
| Human review minutes per item | Cost | Load the factory puts on you |
| Plan usage per shipped item | Cost | How many items the £20 plan buys |
| Change failure rate and time to restore | Reliability | Standard DORA comparison with the human baseline |

## Tech stack

TypeScript end to end (confirmed): one typed language across front and back end lets the compiler catch agent mistakes early and keeps the tool list short.

| Layer | Choice | Cost |
| --- | --- | --- |
| Language and app | TypeScript (Node.js back end, a web front end), SQLite | £0 |
| Agent runtime | Claude Code cloud sessions (Anthropic-managed VMs) on your existing Pro plan; local Claude Code as fallback | Already paid |
| Models | Sonnet as main model, Opus as advisor (`advisorModel: opus` in the repo's Claude settings) | Already paid |
| Orchestration | `factory` TypeScript CLI on the laptop dispatching via `claude --cloud`; a daily cloud routine; a GitHub trigger on new pull requests | £0 |
| Repos | Public factory repo; private project repos with the Claude GitHub App; private benchmark repo | £0 |
| Work items and CI | GitHub Free: Issues, Projects, pull requests, Actions on GitHub-hosted runners | £0 within free minutes |
| Cloud environment | Trusted network allowlist; a setup script that installs Node.js dependencies and Playwright browsers (cached between sessions) | £0 |
| Scanners | Semgrep Community Edition, gitleaks, npm audit, license-checker, Dependabot alerts; weekly scan of main | £0 |
| Tests | Vitest, Playwright, fast-check, run in the cloud session and again in CI | £0 |
| Formal verification | TLA+ for workflows and state machines; Dafny for small critical functions; in CI | £0 |
| Release | `factory deploy` pulls main, builds and restarts the app on the laptop; feature flags in config | £0 |
| Observability | JSONL event log + a weekly metrics report written by the Ops agent | £0 |

**Spec workflow:** GitHub's Spec Kit (1.0.13) drives stations 2–4 through its hyphenated commands (`/speckit-specify`, `/speckit-clarify`, `/speckit-plan`, `/speckit-tasks`, `/speckit-analyze`, `/speckit-implement`), with artifacts in `specs/<issue>-<slug>/`. The constitution sits in `.specify/memory/constitution.md`, installed by the factory tool and protected as a guardrail file. Spec Kit's plan, spec and tasks templates are updated in Phase 0 to enforce its principles. CI calls `factory ci` commands built from the pinned factory commit (see Merging and verification on your laptop).

## Phased roadmap

The factory starts in shadow mode and grows in scope, never in merge rights: you approve every merge in every phase.

&#91;embedded content: roadmap · 4 phases, 3 gates, durations to be set\]

Durations and gate thresholds are left open until shadow mode gives us baseline metrics.

## Decisions and open questions

Eleven review rounds produced the frozen v1.0; v1.1 recorded the Spec Kit alignment and the gateway decision; v1.2 the alignment check; v1.3 the branch, label and approval model; v1.4 signed approvals; v1.5 the kill switch; v1.6 laptop-verified, signed merges; v1.7 closed the ways around those checks.

**Decisions so far**

| Question | Decision | Where it landed |
| --- | --- | --- |
| Agent-driven or platform-engineering factory? | Agent-driven | Whole design |
| What does it build? | One product | Vision and scope |
| Team size and roles | One human: you play product owner, code owner and on-call | Stations, Agent roster |
| Autonomy in v1 | You approve every merge | Quality gates, Roadmap |
| Compliance | None | Security |
| Budget | About £20 a month | Cost controls, Tech stack |
| Who does Spec talk to? | Only the product owner (you) | Stations |
| Your proposal: self-improving agents | Adopted | Self-improving, self-running agents |
| Your edits: formal verification, 90% coverage, GitHub | Adopted | Principles, Quality gates, Tech stack |

| v0.2 question | Decision | Where it landed |
| --- | --- | --- |
| Stack and hosting | Hosted locally; language not yet named, TypeScript recommended | Hosting on your laptop, Tech stack |
| Public or private repository | Either; project repos private, factory public (v0.5); CI on GitHub-hosted runners (v0.6) | Cost controls, Tech stack |
| What does the £20 cover? | The Claude Pro plan you already have | Cost controls |
| Items per week | 3-5 | Capacity |

| v0.3 question | Decision | Where it landed |
| --- | --- | --- |
| Language | TypeScript | Tech stack |
| Always-on machine or laptop? | Your daily laptop | Hosting on your laptop, Self-running |
| Outside users? | No | Hosting on your laptop |
| Lower target or paid credits if Pro runs short? | Moot: target lowered to 3–5 items a week | Capacity |

| v0.4 question | Decision | Where it landed |
| --- | --- | --- |
| What is the product? | Not defined now: the factory must be reusable | Reusable factory and Station 0 |
| Separate factory repo? | Yes, applied to any project repo | Reusable factory and Station 0 |
| First step from a few sentences? | Yes: Station 0, Define | Stations in detail, Agent roster |
| Start Phase 0 now? | Not yet | Phased roadmap |

| v0.5 question | Decision | Where it landed |
| --- | --- | --- |
| Laptop | Crostini, 4 GB RAM | Hosting, Tech stack |
| Factory repo public or private? | Public | Security: Public factory repo |
| Station 0 questions or assumptions? | Always asks clarifying questions | Reusable factory and Station 0 |
| Second stack profile? | TypeScript only for now | Tech stack |

| v0.6 question | Decision | Where it landed |
| --- | --- | --- |
| More memory or a larger machine? | Larger machine and more memory possibly later | Hosting |
| Licence | MIT | Security: Public factory repo |

| v0.7 proposal | Decision | Where it landed |
| --- | --- | --- |
| Escalate hard decisions with the advisor tool | Adopted: Sonnet main, Opus advisor | Capacity, Tech stack |
| Async, cloud-delegated agents | Adopted: every station runs as a Claude Code cloud session; routines make the line self-running | Hosting, Control plane, Security, Tech stack |

| v0.8 question | Decision | Where it landed |
| --- | --- | --- |
| Project code in Anthropic cloud VMs? | Yes, with a reminder and a cloud-or-local choice at every new project | Reusable factory and Station 0, Hosting |

| v0.9 question | Decision | Where it landed |
| --- | --- | --- |
| Claude Code's tools or our own? | Claude Code's own tools, restricted per role; factory adds three MCP tools | Tools and permissions |
| Context window: now or later? | Rules now, token budgets after shadow mode | Context management |

| v0.10 question | Decision | Where it landed |
| --- | --- | --- |
| SAST, SCA, dependency and secret leaks covered? | Mostly; added scheduled scans, Dependabot, licence check, dependency gate | Security: scanning and supply chain |
| Prompt injection and agent attack surfaces? | Partly; added threat model and guardrail protection | Security: threat model, guardrail protection |
| Agent-assisted triage and remediation? | Pieces only; added a six-step flow | Security: triage and remediation |

| v0.11 question | Decision | Where it landed |
| --- | --- | --- |
| Freeze as v1.0? | Yes | Status |

| v1.0 question | Decision | Where it landed |
| --- | --- | --- |
| Does the Spec Kit constitution suit the design? | Partly; amended to 2.0.0 (named Owner gates, plan-usage budgets, lanes, two new principles) | Tech stack, Guardrail protection |
| Folder layout | Spec Kit's `specs/<feature>/` layout adopted | Control plane, Context management |
| Add an LLM gateway? | Considered and deferred | Considered and deferred: LLM gateway |

| v1.1 alignment check | Decision | Where it landed |
| --- | --- | --- |
| Ops agent used but not defined | Ops added as the twelfth role | Agent roster, Tools and permissions |
| Who installs guardrail files | Only `factory new`, `adopt`, `upgrade`; never an agent | Reusable factory, Guardrail protection |
| A: rollback for every release | Adopted from the constitution | Stations, Quality gates |
| B: `/speckit.constitution` at Station 0 | Design wins: the constitution is installed, not generated | Reusable factory, Context management |
| C: licence and secret-scan timing | Design wins | Scanning and supply chain |
| D: who may give agents work | "Authored or approved", in every repo | Security: public factory repo, Triage |
| E: retiring benchmark items | Only you, in a separate change | Self-improving agents |
| Constitution's extra rules | Adopted into the design | Quality gates, Capacity, Agent roster |
| Spec Kit command names | Documented dot form; checked in Phase 0 | Tech stack |

| v1.2 question | Decision | Where it landed |
| --- | --- | --- |
| Which branch holds a work item before merge? | `claude/<issue>-<slug>`, created by the dispatcher on approval; one item, one branch, one pull request | Branches, labels and records |
| Where do post-merge records go? | `claude/factory-log`, additions only, merged by you weekly | Branches, labels and records |
| `approved` label vs `approved` state | Prefixed labels: `owner:approved` vs `state:spec-approved` | Branches, labels and records; Control plane |
| Can an agent forge an approval label? | It could; now blocked by the command guard, `factory approve` records and dispatcher checks | Labels and approvals; Threat model |
| Coach writing protected role files | Proposals go to the factory repo as pull requests | Self-improving agents; Tools and permissions |

| v1.3 question | Decision | Where it landed |
| --- | --- | --- |
| Could an agent forge a `factory approve` record? | Yes as written in v1.3; records are now signed with a laptop-only key | Signed approvals |
| Where is the signature checked? | By the dispatcher's code in the cloud, and again on your laptop by `factory merge` and `factory deploy` | Signed approvals; Stations |

| v1.4 question | Decision | Where it landed |
| --- | --- | --- |
| Where does the kill switch live? | `pause:` labels on a pinned Owner inbox issue | Pause and resume |
| `owner:pause` or `pause:`? | `pause:`, because `owner:` labels must be signed and pauses must not need a signature | Pause and resume; Labels and approvals |
| Who may pause and resume? | Anyone may pause; only a signed `factory resume` lifts it | Pause and resume |
| Can deleting the label end a pause? | No: pause state comes from label history and signed resume records | Pause and resume; Threat model |

| v1.5 question | Decision | Where it landed |
| --- | --- | --- |
| How does Define's output reach `main`? | `claude/define`, merged with `factory merge`; that merge is the brief approval | Branches; Merging and verification |
| Can CI be trusted on a pull request? | Only after the laptop protected-path check; CI calls `factory ci` from the pinned commit | Merging and verification |
| What protects `main` without branch protection? | Signed first-parent history; local signed merges | Merging and verification |
| Is the event log evidence? | No: telemetry only; red-green is checked by CI instead | Merging and verification; Control plane |
| How are releases and keys trusted? | Signed tags, `<tag>@<sha>` pins, key list with revocation that only grows | Merging and verification |
| Spec Kit command names | Hyphenated, as installed (1.0.13) | Tech stack; Context management |

| v1.6 question | Decision | Where it landed |
| --- | --- | --- |
| Who decides when red-green is skipped? | Never an agent: one rule with `ac-map`; a spec without IDs fails; one ID per test; test-only detected from the diff with the release's test paths; refactors need your waiver | Merging and verification |
| Can tests be dropped quietly? | No: `factory merge` lists removed or skipped tests and changed setup files; each removed or skipped test needs your signed waiver | Merging and verification |
| How is a waiver kept from covering other things? | Records sign the exact target; gate and test waivers carry `head: <sha>`; after a rebase you re-sign against a range-diff of the item's own changes | Signed approvals |
| What anchors a new repository's signed history? | `factory new` creates it empty and pushes a signed first commit | Merging and verification |
| What about pushes after the merge check, or a second merge? | Never merged; the pull request is closed; the branch is deleted, any later push raises an alert, and an issue merges only once. A running session is a warning you confirm | Merging and verification |

| v1.7 question | Decision | Where it landed |
| --- | --- | --- |
| Does authoring an issue admit it? | No: agents act through your account; only a signed `owner:approved` admits. Tier proposed by the filing agent or given with `--tier`; Intake may only raise it | Security; Stations; Labels |
| Can work start before the brief is merged? | No: nothing is admitted until the Define merge is on `main`, read from its `Factory-Merge: define` trailer | Merging and verification |
| What happens to a failure found after an item's merge? | It moves on to `releasing` with an alert and becomes a new issue; nothing sends a merged item back | Merging and verification |
| What is a criterion line, and which IDs are checked? | Acceptance list items, plus lines with two Given/When/Then or one in bold; approved IDs at tier 2–3, every ID ever seen at tier 1; an empty set fails | Merging and verification |
| Can telemetry block an approval? | No: usage is shown when present and never required | Quality gates |
| Who counts retries? | The dispatcher, from gate failures it sees itself (failed required checks, failing verify reports); events a session writes never count, so a silent session still escalates | Control plane; Merging and verification |

**Still open**

- [ ] Phase 0: confirm how the installed Spec Kit (1.0.13) is told which feature folder and branch to use, so it writes into the dispatcher's `claude/<issue>-<slug>` branch instead of creating its own.
- [ ] Phase 0: confirm that `ssh-keygen -Y verify` and `git verify-commit` (with `gpg.ssh.allowedSignersFile` and `gpg.ssh.revocationFile`) work in the cloud environment, and that a forged label, an edited record, a replayed record and an unsigned commit on `main` are each rejected by both the dispatcher and `factory merge`.

## Sources

- [Claude plans and pricing](https://claude.com/pricing): Claude Code is included in paid plans and shares their usage limits
- [Claude Pro pricing, UK guide](https://aitoolsreview.co.uk/guides/claude-pro-pricing-2026-uk-guide): US$20 a month plus VAT, about £19.50 to £21
- [GitHub pricing](https://github.com/pricing) and [GitHub Actions billing](https://docs.github.com/billing/managing-billing-for-github-actions/about-billing-for-github-actions): 2,000 free Actions minutes a month on Free for private repositories; public repositories free

* [Claude Pro usage limits guide (Continuum)](https://continuumcode.ai/guides/claude-pro-usage-limit/) and [Claude Help Center on usage limits](https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work): 5-hour window plus weekly cap, one pool for chat and Claude Code, roughly 1 to 3 hours of Claude Code a day on Pro
* [GitHub: postponing self-hosted runner billing](https://github.com/orgs/community/discussions/182186) and [CICDCost](https://cicdcost.com/github-actions-pricing): self-hosted runners remain free; the fee is postponed, not cancelled

- [Claude Code advanced setup](https://code.claude.com/docs/en/setup): supported on Debian 10+ (Crostini's base), needs 4 GB+ RAM

* [Use Claude Code in the cloud](https://code.claude.com/docs/en/claude-code-on-the-web): cloud sessions on Pro, isolated VMs, shared rate limits, no separate compute charge
* [Automate work with routines](https://code.claude.com/docs/en/routines): schedule, API and GitHub triggers; daily run cap; research preview
* [Escalate hard decisions with the advisor tool](https://code.claude.com/docs/en/advisor): available to subscription accounts, counts toward plan limits, experimental

- [GitHub security plans](https://github.com/security/plans) and [GitHub Secret Scanning overview (AppSec Santa)](https://appsecsanta.com/github-secret-scanning): secret scanning is free on public repos and paid (Secret Protection) on private ones; Dependabot alerts are free
- [GitHub pricing](https://github.com/pricing): Pro at US$4 a month adds protected branches for private repos

* [Claude Code: Other LLM gateways](https://code.claude.com/docs/en/llm-gateway): gateway credentials replace the subscription login and are billed per token; non-Claude models not supported

- [Spec Kit slash commands reference (DeepWiki)](https://deepwiki.com/github/spec-kit/5-slash-commands-reference): commands documented as `/speckit.*`
