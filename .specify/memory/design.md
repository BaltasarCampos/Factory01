# Software Factory — Design v1.2

Sep 29, 2026 · @Ballesteros

## Status and how to review

This is v1.2, a consistency revision of the v1.0 baseline: it fixes contradictions found when checking the design against the spec and the constitution, adds the Ops role, and adopts the constitution's stricter rules. The station design is unchanged.

- **Direction (confirmed):** "software factory" means an agent-driven assembly line that turns a product request into tested, deployed software, with humans owning intent and the release gates.&#32;
- **How we iterate:** comment on any section, or answer the open questions at the end. Each round bumps the version and records what changed.
- **Out of this version:** detailed APIs, data schemas, sizing and cost figures.

**What changed in v1.2**

- New Ops role (twelve roles): station 8 monitoring, incident notes and the weekly metrics report now have an owner.
- Guardrail files, including the constitution, are installed only by `factory new`, `factory adopt` and `factory upgrade`, never by an agent.
- Every release needs a documented rollback path and your approval (you run `factory deploy`); tier 3 still needs a written, tested rollback step.
- Agents act only on work items you authored or approved (your `approved` label), in every repository.
- Only you may retire a replay-benchmark item, in a separate change of your own.
- One coverage rule (90% of changed lines); the Reviewer's verdict is advisory everywhere; tier 1 specs are skimmed, tier 2–3 specs approved.
- Agent roster and architecture diagram brought in line with the permissions table and laptop deploys.
- Constitution rules adopted into the design: tests seen failing first, gate waivers, tiers never lowered by agents, no Fable and no usage credits, recorded model escalations, parallel sessions need approval, approval summaries, flaky-test rule.
- Spec Kit commands written in their documented form (`/speckit.specify`); the installed form is checked in Phase 0.

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
2. **Start a project:** `factory new "<your few sentences>"` creates a private repo, or `factory adopt <repo>` attaches to an existing one. Before creating anything, it reminds you that agents will clone this project's code into Anthropic-managed cloud VMs through the Claude GitHub App, and asks you to choose cloud or the local fallback; the answer is saved as `agents: cloud` or `agents: local` in `.factory/config`, and the dispatcher will not start a cloud session for a project without it. It then runs `specify init`, writes `.factory/`, installs every guardrail file from the pinned factory release (including the constitution), installs GitHub labels and CI workflows, and sets up the working copy on the laptop. No agent installs or edits guardrail files.
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
| Gate | You approve the brief and the backlog; approval moves the issues into Intake |

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
| 0 | Define (once per project) | Your pitch of a few sentences, or an existing repo | Product brief, walking-skeleton starter, 5–10 seed issues | You approve brief and backlog | Define agent + you |
| 1 | Intake | Ticket, bug report, alert, scanner finding, Dependabot alert | Triaged work item with type, priority, risk tier | Classified and deduplicated; enters the line once you authored or approved it | Intake agent |
| 2 | Specify | Work item + product brief | Spec: problem, acceptance criteria, non-goals, affected areas | Criteria testable; you approve the spec (tier 2–3) or skim it (tier 1) | Spec agent + you |
| 3 | Plan | Approved spec | Task list with dependencies, test plan, file list per task | Each task under size limit, every criterion mapped to a test, test tasks before implementation | Planner agent |
| 4 | Build | One task + repo snapshot | Branch with code, tests, docs | Tests seen failing first, then passing | Builder agent (one task at a time) |
| 5 | Verify | Branch | Verification report | CI green; coverage ≥ 90% of changed lines; SAST, SCA, secret and licence scans clean; independent review done and blocking findings resolved | Test, Reviewer, Security agents |
| 6 | Integrate | Verified branch | Rebased branch, ready for your merge | CI green on the rebased branch; you approve and merge | Integrator agent + you |
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
| Coach | Run retrospectives, propose instruction and checklist changes | Event log, review comments, role instruction files (via PR) | Change gates, permissions, budgets, guardrail files or the constitution; approve its own changes |

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
| Intake | Read, Grep, Glob, Bash | `gh issue` | Write, Edit |
| Define | Read, Write, Edit, Bash, Grep, Glob | npm, git, `gh issue` | Push to main |
| Spec | Read, Grep, Glob, Write (`spec.md` in its feature folder only) | `gh issue` | Edits outside its `spec.md` |
| Planner | Read, Grep, Glob, Write (`plan.md` and `tasks.md` in its feature folder only) | none | Source code edits |
| Builder | Read, Write, Edit, Bash, Grep, Glob, subagents | npm, vitest, git on its branch | Push to main, reading `.env`, files outside the task's list |
| Test | Read, Grep, Glob, Write and Edit (test files only), Bash | test runners, coverage | Edits to source files |
| Reviewer | Read, Grep, Glob, Bash, Write (`reports/` only) | `git diff`, `gh pr comment` | Edits to code, specs or tests; `gh pr merge`, `gh pr review --approve` |
| Security | Read, Grep, Glob, Bash | semgrep, gitleaks, npm audit | Write, Edit |
| Integrator | Read, Bash | `git rebase`, `gh pr` (except merge) | `gh pr merge` |
| Release | Read, Write (release notes and rollback notes only), Bash | `gh release` | Deploy commands (you run `factory deploy`) |
| Ops | Read, Grep, Glob, Bash, Write (`.factory/ops/` only) | `gh issue` | Code and spec edits; deploy commands |
| Coach | Read, Grep, Glob, Write (role files only), Bash | `gh pr create` | Editing settings, hooks, gate policy or the constitution |

On top of the table, every role is denied Write and Edit on the guardrail files: `.claude/`, `.mcp.json`, hooks, `.github/workflows/`, `.factory/config` and `.specify/memory/constitution.md` (see Security: threats, supply chain and response).

**Hooks**

- **Before a tool call:** a path guard blocks writes outside the role's folders and the task's file list; a command guard blocks pushes to main, merges and reads of secrets.
- **After an edit:** format and type-check the touched file, so errors surface at once.
- **After every call:** append one line to the work item's event log.
- **When the session tries to stop:** check that the station's output file exists and is complete; if not, the session keeps going.

**Factory tools via MCP:** one small factory server, declared in the repo's `.mcp.json`, adds three tools: `advance_item` (move the issue to the next station once its gate passes), `log_event`, and `request_split` (hand an oversized task back to the Planner). Everything else goes through Claude Code's tools and the `gh` CLI.

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
| 0 Define | Your pitch, the stack profile, the installed constitution | `.factory/brief.md`, starter code, seed issues |
| 1 Intake | The issue, `brief.md` | Labels and risk tier on the issue |
| 2 Specify (`/speckit.specify`, `/speckit.clarify`) | The issue, `brief.md` | `specs/<feature>/spec.md` |
| 3 Plan (`/speckit.plan`, `/speckit.tasks`, `/speckit.analyze`) | `spec.md` | `plan.md`, `tasks.md`: tasks, each with its file list and tests |
| 4 Build (`/speckit.implement`) | One task from `tasks.md`, the files it lists | Commits on a `claude/` branch, a pull request |
| 5 Verify | The pull request diff, `spec.md` | `reports/verify.md`, posted as a PR comment |
| 6 Integrate | Verify report, CI status | Rebased branch, ready for your merge |
| 7 Release | Merged commits, specs | Release notes and rollback path |
| 8 Operate and learn | Health summaries, event log, your review comments | New issues, incident notes, metrics report (`.factory/ops/`), lessons files |

All paths after Station 0 are inside the feature folder `specs/<feature>/`.

**To decide later, from shadow-mode data:** token budgets per role, the size of `CLAUDE.md`, and whether any role needs a larger context window.

## Control plane

A small orchestrator script drives each work item through the stations; all state lives in GitHub and the repository, so nothing extra needs hosting. Agents do the work inside a step but never decide the route.

**Components**

- **Orchestrator:** the `factory` CLI. It picks the next ready issue by label and starts that item's current station as a Claude Code cloud session (`claude --cloud`) with the station's prompt; when the gate passes it moves the label on. The same logic runs in a daily cloud routine, so the line moves without the laptop.
- **Work item store:** GitHub Issues plus a Project board; one label per state, one issue per work item.
- **Artifact store:** the repository itself, in Spec Kit's layout: one folder per feature, `specs/<feature>/`, holding `spec.md`, `plan.md`, `tasks.md` and `reports/` (verify and review reports, also posted as pull request comments).
- **Event log:** an append-only JSONL file per work item in the repo, plus issue comments; feeds metrics and the coach.
- **Sandbox:** each cloud session's own isolated VM; GitHub credentials stay outside it, and network access uses the Trusted allowlist (package registries and common development hosts).
- **Model access:** your Claude Pro plan; Sonnet as the main model with an Opus advisor (see Capacity); the plan's usage limits are the spending cap.
- **Knowledge layer:** `CLAUDE.md`, the constitution (`.specify/memory/constitution.md`), Spec Kit templates in `.specify/templates/`, role instruction files and subagent definitions in `.claude/agents/`, architecture decision records in `/docs/adr`; cloud sessions pick these up from the cloned repo.

**Work item states**

`new → triaged → specified → approved → planned → building → verifying → integrating → releasing → done`, with `blocked` and `escalated` reachable from any state.

**Retry policy:** a failed gate returns the item to the earliest station that can fix it, with the failure report; after 3 failed attempts it escalates to you (count to confirm in shadow mode).

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

**Also in force:** flaky tests are defects, fixed or quarantined with an issue you can see; agents never weaken, delete or skip tests without your approval; skipping any gate needs a waiver you record; every approval request comes with a short summary (what changed, how it maps to the spec, test and review results, usage spent, known risks).

**Formal verification, where it pays:** used on small, critical parts only (state machines, permission rules, money calculations). The Test agent writes a model or proof of the one property that matters (for example "a refund never exceeds the original charge") and checks it with a model checker or proof tool. Everything else relies on tests and property-based testing; the tools are TLA+ and Dafny (see Tech stack).

**Escalation:** any station can raise a question to you; the item waits in `blocked` without consuming budget.

## Security, governance and cost controls

Agents run with least privilege in disposable sandboxes, and every action is logged and attributable.

**Security**

- Agents never hold production credentials; deploys run on your laptop through the factory deploy command, outside any agent session.
- Sandboxes are ephemeral cloud VMs, with network egress limited to the Trusted allowlist.
- Secrets are injected only at runtime into CI, never into agent context.
- Untrusted text (tickets, issue comments, web pages, dependency READMEs) is treated as data; agents cannot act on instructions found in it without a human.
- Merges to main need passing CI and your approval. GitHub Free offers branch protection only on public repos, so on private project repos the command guard and the dispatcher enforce this (see Security: threats, supply chain and response).

**Cloud sessions**

- Each session runs in its own isolated VM; GitHub credentials and keys stay outside it, and a proxy authenticates on its behalf.
- Sessions push only to `claude/` branches; `main` is guarded by the command-guard hook, so nothing merges without your approval.
- Routines run without permission prompts, so each routine gets only the repositories it needs and no extra connectors.
- Text passed to a routine from outside (issue bodies, API payloads) is treated as untrusted data by default; station prompts keep it that way.

**Public factory repo**

- It holds only generic material: code, role instructions, templates, profiles. No project code, briefs, lessons or benchmark items ever go into it.
- The replay benchmark lives in a separate private repo that the factory reads at run time.
- General lessons are rewritten by the Coach without project details before they become a pull request to the factory; you check that before approving.
- In every repository, the orchestrator acts only on work items you authored or approved (your `approved` label). Issues Intake files from scanner findings or Dependabot alerts wait for that label; other people's issues and pull requests on the public repo are data to read, never instructions.
- Licence: MIT.

**Governance**

- Full audit trail per work item: prompts, tool calls, diffs, reports, approvals.
- Agent-authored commits are labelled with agent role and work item id.
- Policy as code for risk tiers and approval rules, reviewed like any other code.

**Cost**

- **Extra cost: £0.** The factory runs on the Claude Pro plan you already have (US$20 a month, about £19.50 to £21 in the UK with VAT). Claude Code is included and shares one usage pool with your own chats. No pay-as-you-go API spend.
- **GitHub Free:** the public factory repo gets unlimited Actions minutes; private project repos share 2,000 free minutes a month on GitHub-hosted runners, plenty for 3–5 items a week if CI runs once per pull request update. The runner's minute use is logged so it never surprises you.
- **Usage is the real budget:** see Capacity for how the pipeline fits Pro's limits.
- **Kill switch:** pause the whole line or a single station with one label.

## Security: threats, supply chain and response

The factory is most exposed where three things meet: agents that can read private code, content they cannot trust (repo text, dependencies, test output, web pages), and any way to send data out. The defences below keep those three apart, stop agents from changing their own guardrails, and turn every finding into a tracked fix.

### Threat model

| Threat | Example | Main defences |
| --- | --- | --- |
| Prompt injection from content | A README, code comment or test output tells the agent to copy a file somewhere | Content is data, never instructions; no secrets inside sessions; network allowlist; path and command guards |
| Guardrail tampering | An agent edits `.claude/settings.json` or a CI workflow to lift a block | No role may edit guardrail files; CI flags any change to them; you approve |
| Secret exfiltration | Code or a workflow sends a token to an outside host | Secrets never enter cloud VMs; deploy runs on your laptop, not in Actions; workflow changes flagged |
| Fake or malicious dependency | An agent adds a lookalike or non-existent package | New-dependency gate; install scripts off; lockfile committed |
| Reviewer manipulation | The diff contains text telling the Reviewer to approve | Reviewer verdict is advisory; CI and your approval decide |
| Lesson poisoning | Untrusted text in the logs becomes a "lesson" | Coach changes are pull requests you review; lessons can never touch guardrails |
| Factory supply chain | A malicious pull request to the public factory repo | Projects pin a tagged factory release; outside pull requests never trigger agents; upgrades arrive as pull requests you review |
| Unprotected `main` | GitHub Free offers branch protection only on public repos, so private project repos lack it | Command guard blocks pushes to `main`; sessions push only `claude/` branches; optional GitHub Pro (US$4 a month) adds GitHub-enforced protection |

### Guardrail protection

- **Protected files:** `.claude/`, `.mcp.json`, the hooks folder, `.github/workflows/`, `.factory/config`, `.specify/memory/constitution.md` and the lockfile policy. Every role is denied Write and Edit on them.
- **Only the factory tool changes them:** `factory new` and `factory adopt` install them from the pinned factory release when a project starts, and `factory upgrade` updates them in a pull request you approve. No agent installs or edits them; an agent may only propose a change (for example a constitution amendment) as a pull request you approve.
- **CI check:** any pull request that touches a protected file fails a `guardrail-change` check until you approve it explicitly.
- **Integrity at start-up:** a session-start hook compares the guardrail files with the pinned factory release; any mismatch stops the session and alerts you.

### Scanning and supply chain

| Check | Tool | When |
| --- | --- | --- |
| SAST (code patterns) | Semgrep Community Edition | Every pull request; weekly on `main` |
| SCA (known vulnerabilities in dependencies) | npm audit, Dependabot alerts | Every pull request; Dependabot watches continuously |
| Secret leaks | gitleaks | Before each commit (hook), every pull request, weekly across full history |
| Licences | license-checker against an allowed-licence list | Every pull request that changes dependencies |
| New-dependency gate | Factory check: package exists, is not a near-name of a popular one, has real age and usage; then your approval | Whenever a pull request adds a dependency |
| Install safety | `npm ci --ignore-scripts`, committed lockfile, exact versions | Always |

Dependabot alerts and security updates are free on private repos. GitHub's own secret scanning and CodeQL are paid for private repos, so gitleaks and Semgrep cover those at no cost.

### Agent-assisted triage and remediation

1. **Detect:** a finding comes from CI, the weekly scan of `main`, or a Dependabot alert.
2. **File:** Intake turns each finding into an issue labelled `security`, deduplicated by rule and location; it enters the line once you approve it, and critical or high findings notify you at once.
3. **Triage:** severity sets the lane and a target time: critical and high go to the full lane and jump the queue (targets such as 2 days and 1 week, to confirm in shadow mode); medium joins the normal queue; low goes to the backlog.
4. **Fix:** the Builder updates the dependency or patches the code, and adds a regression test that reproduces the finding.
5. **Verify:** the Security agent re-runs the scanner on the branch; the finding must be gone and CI green before it reaches you.
6. **Close or dismiss:** dismissing a false positive needs a written reason from the Security agent and your approval, recorded in `.factory/security/dismissals.md` with a date to re-check.

**If a secret leaks:** the line pauses, you rotate the secret, and the Ops agent writes a short incident note with the cause and the new check that would have caught it.

## Self-improving, self-running agents

Every finished item teaches the factory something: the Coach agent turns lessons into instruction changes, and a change is kept only if you approve it and it does no worse on a replay of past work.

**The improvement loop**

1. **Capture.** Each station logs its gate result, rework loops and your review comments to the event log.
2. **Retrospect.** Weekly (to save usage), the Coach reads the log and writes lessons per role: what failed, what you corrected, what repeated.
3. **Propose.** Lessons become edits to that role's instruction file, checklist, skills or lint rules, opened as a pull request.
4. **Evaluate.** The orchestrator replays the changed role on a small benchmark of past items (start with 5 to 10) and compares first-pass gate rate with the current version.
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

**Spec workflow:** GitHub's Spec Kit drives stations 2–4 (`/speckit.specify`, `/speckit.clarify`, `/speckit.plan`, `/speckit.tasks`, `/speckit.analyze`, `/speckit.implement`), with artifacts in `specs/<feature>/`. Command names follow Spec Kit's documentation; Phase 0 checks the form your install actually uses and aligns all documents. The constitution (2.1.0) sits in `.specify/memory/constitution.md`, installed by the factory tool and protected as a guardrail file. Spec Kit's plan, spec and tasks templates are updated in Phase 0 to enforce its principles.

## Phased roadmap

The factory starts in shadow mode and grows in scope, never in merge rights: you approve every merge in every phase.

&#91;embedded content: roadmap · 4 phases, 3 gates, durations to be set\]

Durations and gate thresholds are left open until shadow mode gives us baseline metrics.

## Decisions and open questions

Eleven review rounds produced the frozen v1.0; v1.1 recorded the Spec Kit alignment and the gateway decision; v1.2 records the alignment check against the spec and constitution.

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

**Still open**

- [ ] Phase 0: confirm whether your Spec Kit install names its commands `/speckit.specify` or `/speckit-specify`, and align the design, spec and constitution to it.

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
