# Contract: local sessions

The lifecycle of a session the local launcher starts (`agents: local` in main's `.factory/config`,
T061), as the code on main stands after slice 28-4c-4b-3c-2b. Every slice that changes it keeps
this page current in its notes commit. Code: `src/dispatcher/failures.ts`, `evidence.ts`
(`tipState`, `spentTip`, `intakeBound`), `dispatch.ts` (`startSession`, `held`, `hold`),
`manifest.ts` (`testEnded`), `launcher/local.ts` (`launch`, `sessionRunning`, `stillRunning`),
`src/commands/run.ts`.

`R` is `retry_limit` from main's `.factory/config`, a positive integer, 3 by default. Stations
2–6 are the item-branch stations, the ones this lifecycle counts; Intake (1) is counted too, with
a record of its own and no manifest (section 2, Intake); Define (0) is started by hand through
`factory new` and `factory adopt`, and Release and Ops start no session yet. Cloud mode keeps
T059's rule: a tip that is a dispatcher manifest for the item's station is a session still
running, and nothing relaunches.

## 1. What the factory keeps

`~` is the local launcher's home; the dispatcher, the evidence and the launcher read one home.
No session can reach `~/.factory/` (T183).

| File or ref | Written by, when | How | Deleted by |
|---|---|---|---|
| `~/.factory/sessions/<id>/` | Launcher, after the request, still-running, fetch, history, config and token checks, before the clone; `<id>` a fresh UUID | `mkdir` 0700, exclusive: an existing folder refuses the launch | Never by the factory. The Owner, only when an error names the folder, once `ps -eo pid,pgid,args` shows nothing of the session |
| `session.json` | Launcher, after every check and `claude --version`, just before `starting()` and the spawn: role, item, station, feature, files, clone, model, `role_version`, repo, `inbox_issue`, branch, head, tests | Once, `wx` 0600, not by rename | With its folder |
| `settings.json`, `mcp.json` | Launcher, in the same step, just before `session.json` | Once, `wx` 0600 | With its folder |
| `group.json` | Launcher, when the runner reports claude's process group: `pgid`, the leader's start time, the boot id | `writeWhole`: a `wx` 0600 temporary file linked to its name, so whole and exclusive | With its folder |
| `not-spawned` | Launcher, on any failure after the folder was made and before claude spawned, a `starting()` refusal included | `writeWhole`, empty; unwritten, the folder reads as below | With its folder |
| `ended` | Launcher, at settle, once no process of the group remains within about a second, by the check `sessionRunning` makes; not on the kill alone, never when the group cannot be read, and not when the factory exits on a signal | `writeWhole`, empty | With its folder |
| `result.json` | Launcher, at settle, for every session that spawned, failed or capped included; skipped on a signal to the factory | Once, `wx` 0600; one that cannot be written is added to the failure, and turns a session that succeeded into `session-failed` | With its folder |
| `shell-check/` | Launcher, before the shell check, which runs in it | `mkdir` 0700, empty | With its folder |
| `passed.json`, `events.jsonl` | The session's hooks: the start check's record (removed at each check, renamed into place when it passes) and the session's own log, which the launcher reads for a failed start and a full context | Rename; append | With its folder |
| `~/factory-work/<owner>/<repo>/<name>-<id>`, the session's clone; `<name>` is `main` or the branch without `claude/` | Launcher, after the session folder: `git init`, a fetch from the dispatcher's clone of main and the branch at the heads step 6 fetched, a checkout, `git clean -ffdx`, all without the Owner's config | Whole for this launch, its path new with the id; a leftover at it is removed first | The launcher, when the launch fails before claude spawns, keeping the session folder and its `not-spawned` marker; a removal that fails is named in the refusal ("; its clone <path> could not be removed: <why>"). Once claude spawned, never by the factory |
| `/tmp/factory-<item>-<random>/`, the session's temporary folder | Launcher, before the session's environment, which names it as `TMPDIR` | `mkdtemp` | The launcher, at the end of the launch; not when the factory exits on a signal |
| `~/.factory/failures/<owner>/<repo>/<item>-<station>.json`, the failure record | Dispatcher: `recordIssued` before a new manifest's push; `recordSession`, the `starting()` callback the launcher calls just before the spawn, which makes Intake's (`<item>-1.json`) at its first count; `recordOutcome` after the launch returns | A `wx` 0600 temporary file renamed into place, folder 0700, checked with the reader's own checks first: a reader sees the old record or the new, never half | Never by the factory, but for Intake's, which the dispatcher deletes before any move out of `new`, a failed delete stopping the pass with the item still in `new`; `recordIssued` replaces it at a new manifest. The Owner, to start the count again |
| `refs/factory/build/<branch>`, the issued ref | Dispatcher, in its own clone, after a Build manifest's push succeeds | `git update-ref` | Never by the factory. The Owner restores it with the command a `manifest-held` alert names |
| `refs/factory/test/<branch>`, the Test ref | Dispatcher, in its own clone, after a Test manifest's push succeeds (T181) | `git update-ref` | Never by the factory. Verify's Test session has ended only when this commit is in the tip's history, is not the tip, and the issued ref, if any, is its ancestor, never by a commit subject; missing or older, Test runs once more; a git failure reading it, other than exit 1, stops the pass |

The record's repo is exactly `owner/name` in GitHub's name characters, neither part `.` or `..`,
both lower-cased; any other is an error. Its fields, and nothing else:

| Field | Meaning |
|---|---|
| `head` | The dispatcher's own manifest commit the record counts at, 40 or 64 hex; absent in Intake's record alone, told by its name, since main moving never resets it: a head there, or none in another, is malformed |
| `factory` | The installed factory's hash when the record was last counted: SHA-256 over `dist/` (or `src/` under the tests) and `factory/`, taken once when `factory dispatch` or `factory run` starts |
| `count` | Attempts at `head` (at Intake, for the item) under that hash, each counted when it starts, before the spawn |
| `session` | The id of the last session started at `head`, whose group tells whether it still runs |
| `outcome` | `failed` or `ended`, for the last attempt that settled; absent while one runs or when none was recorded |
| `last` | The last failure's text, session text through `visible()` once; kept across attempts; never in a prompt |
| `context_full` | For a failed attempt, true or null only: true when its log has a blocked PreCompact event, null covering both not full and unknown; `result.json` keeps false apart from null |

A missing record is no record. Any other read failure, text that is not JSON, or a record that
fails these checks stops the pass, naming the file and "delete it, by its path, to start its
count again"; it never reads as none.

## 2. States

**The session folder** (`sessionRunning`), read for the record's last session by the evidence and
for every folder under `~/.factory/sessions/` by the launcher before every launch. Any entry there
that is not a folder, and any marker that cannot be `lstat`ed for a reason other than its absence,
stops the pass, naming it.

| # | `group.json` | `not-spawned` | `ended` | `session.json` | Reads as |
|---|---|---|---|---|---|
| 1 | yes | — | yes | any | Ended, with no `/proc` scan |
| 2 | yes | — | — | any | `/proc`: on the same boot, running while the leader with its recorded start time lives, or, the leader gone, a live member of its group (zombies not counted); else ended. An unreadable or malformed `group.json` stops the pass |
| 3 | — | yes | any | any | Ended: nothing spawned |
| 4 | yes | yes | any | any | Error naming the folder: stops the pass |
| 5 | — | — | yes | any | Ended: the run returned (only the tests' fake runner gets here) |
| 6 | — | — | — | no | Ended: never counted, never spawned |
| 7 | — | — | — | yes | Unknown (`SessionUnknown`): stops the pass, naming the session id, both causes (a stop after `session.json` is written, before claude spawns, or after it spawns, before `group.json`), the `ps` check and removing the folder |

No folder at all reads as ended. Running, to the evidence, makes the tip running; to the launcher,
it refuses the launch with an urgent `session-running` alert naming the group and how to stop it.

**The tip** of the item's branch, in local mode at stations 2–6 (`tipState`):

| Record | The record's session | Tip | What follows |
|---|---|---|---|
| None, or naming another commit | — | New | The station's evidence decides; a session it needs gets a new manifest |
| Names the tip | Its group runs (row 2) | Running | The item waits: no session, no Build round, tick or conflict |
| Names the tip | None recorded, or not running | Spent | Below |

The count read is the record's under the same installed hash, else 0, with nothing written.

**Intake** (`intakeBound`), in local mode, read only while Intake's output is incomplete; the
record's last session is read through `sessionRunning`, in all seven states:

| Last session | Record | Leads to |
|---|---|---|
| — | None | An Intake session |
| Running (row 2) | — | The item waits: no session |
| Row 4 or 7 | — | Stops the pass, naming it |
| Ended | `failed` with `context_full` true | Hold: `context-full`, under any installed hash |
| Ended | Count past `R` under this hash | Hold: `retry-limit`, naming the last session and how it ended: failed with its failure, ended well with what Intake's output still lacks, or no outcome recorded |
| Ended | Otherwise | An Intake session, counted, after one that ended well too |

**A spent tip** (`spentTip`), checked in this order:

| Outcome | `context_full` | Count | Manifest at the tip | Leads to |
|---|---|---|---|---|
| `ended` | — | any | — | Wait, silently, until 28-6's push gives a new head |
| `failed` | true | any | — | Hold: `context-full` |
| `failed` or none | not true | > R | — | Hold: `retry-limit` |
| `failed` or none | as above | ≤ R | Readable, naming the item, the station and the branch | Relaunch on the same commit, no new manifest |
| `failed` or none | as above | ≤ R | Unreadable, or naming another | Hold: `manifest-unreadable` |

The manifest is read by `pendingManifest`: the tip's subject `Dispatcher: station <n>`, its first
changed path exactly `specs/<issue>-<slug>/.station.json`, a 100644 blob of at most 64 KiB read by
the oid `ls-tree --literal-pathspecs` gave, a JSON object naming a station 1–7 and a role. A git
failure there stops the pass. A relaunch takes from the manifest only the role, the task, the
files and the failure line; the rest of the prompt, the Owner's signed answers included, is
rebuilt as for a first attempt.

## 3. One launch, in order

| # | Step | A crash or refusal here leaves | The next pass reads |
|---|---|---|---|
| 1 | Evidence: the branch fetched, the record and the record's session folder read, the spent tip decided | Nothing | A bad record, `group.json`, row 4 or 7 stops every pass until fixed (`pass-threw`) |
| 2 | Holds alerted; `needsSession` and no `pause:<station>` make a target; `available()` | Nothing | The same |
| 3 | `createItemBranch` (only when missing), `ensureDraftPr` | A branch or draft PR | The same evidence |
| 4a | New: `writeStationManifest` makes the commit on the fetched tip; `recordIssued` reads the record, refuses when it names that tip (`StackRefused`), else writes count 0 at the new commit | Refused: nothing pushed, the item held. Write or hash failure: nothing pushed, the pass throws | Refused: held again, alerted once. Failure: the same tip, new |
| 4b | The push, fast-forward only; at Build `update-ref` of the issued ref | Before the push: a record naming an unpushed commit; a rejected push the same, and the pass throws. After the push, before `update-ref`: the manifest at the tip, the ref older | The old tip, new: a new manifest, its record replacing. The manifest spent with count 0: relaunched. At Build the older ref only steers the round: the open task may be issued again, counted in Build's cap |
| 4c | Relaunch: no commit; the attempt is on the record's head | Nothing | The same |
| 5 | The prompt rendered from the pinned release, read from the factory clone | Refused (`ReleaseIncomplete`, alerted as `release-incomplete`, its reason opening with `release <tag> (<sha12>): `) when the factory clone lacks the pinned commit, the release lacks the file, or a template is not correct (`$ARGUMENTS` outside its input block, a placeholder with no value): no session, the item holds and the pass goes on. Any other git failure, in the factory clone or reading the Owner's answers or Verify's changed files from the project, which are read before the prompt: an error, and the pass throws | Spent, count unchanged: tried again, alerted once per pin and head |
| 6 | Launcher: the request (session branch, feature folder, a `starting()` at stations 1–6), the still-running scan, the fetch of main and the branch, the history and guardrail checks, config, gh token | Refused (`LaunchRefused`) or an error; no folder | Not counted: tried again. A refusal tied to the item, a protected path in the branch's own commits, no role file or no allowed model, holds it, once per branch head, and the pass goes on; any other refusal alerts once per branch head, or once per text before the fetch, and ends the pass; an error throws the pass |
| 7 | The session folder, the clone at the fetched head, the clone's checks, environment, PATH, shell check, `claude --version` | Refused or an error, `not-spawned` written and the clone removed (a refusal tied to the item: hooks the installed factory refuses in a release the branch kept from its merge base); a crash: a folder with no `session.json`, and the clone | Row 3 or 6: ended. Not counted |
| 8 | `settings.json`, `mcp.json`, `session.json` | A crash after `session.json`: no marker | Row 7: unknown, every pass stops until the Owner removes the folder; never counted |
| 9 | `starting(id, head)` → `recordSession`: at stations 2–6 the record must name the manifest and the clone must be at it, else refused; at Intake the record is made at the first count and the clone is not compared; the count + 1 (from 0 under a new hash) and the id, by rename. A record that cannot be read or written refuses too: an info `LaunchRefused`, never a thrown pass | Refused, `not-spawned`, the record unchanged; the item holds and the pass goes on; a crash after the write: counted, no marker | Refused: not counted; a moved branch reads as a new head. Crash: row 7 until removed, then spent with no outcome: relaunched, the attempt counted |
| 10 | claude spawned in its own process group; `group.json` | Spawn failure: counted, `not-spawned`, the pass throws. A crash: `group.json` alone | Spawn failure: spent, no outcome, relaunched. Crash: running while the group lives, then spent, relaunched |
| 11 | The session, under its turn, wall-clock and silence caps | — | — |
| 12 | Settle: `ended` once the group is gone, `context_full` from the log, `result.json` | A group still alive: no `ended` | Row 2: running until it goes |
| 13 | `recordOutcome`: a failure (`SessionFailed`, `SessionCapped`) keeps `last` and `context_full`; a success records `ended` | A failure alerted; a failure to record it is named in that alert and throws. A crash, or a failed `ended` write: no outcome | Failed: hold or relaunch. No outcome: spent, relaunched, one more counted session even after one that ended well |

A hold lets the pass go on to the next target: a `StackRefused`, a spent tip's hold read with the
evidence, a prompt refusal, and a `LaunchRefused` tied to one item (`item`: a protected path in the
branch's own commits, no role file, no allowed model, hooks the installed factory refuses in a
release the branch kept, `recordSession`'s refusals). A held item is
alerted once per head, the head the launcher refused at or else the branch's as fetched (main's for
Intake), and tried again each pass, uncounted. Any other `LaunchRefused`, one that hits every item,
and a failed session end the pass: `startSession` returns, and `dispatchOnce` returns from its
target loop, so no later item is tried that pass.

A new head (anyone's commit at the tip), a newly installed factory hash or a deleted record ends
the count: a new head or a deleted record gets a new manifest, one commit per reset; a new hash
reads count 0 and relaunches on the same commit, though a `context-full` hold stays.

## 4. Bounds

| Bound | Rule |
|---|---|
| The count | Attempts at one manifest commit under one installed hash, each counted at step 9, before the spawn, so a factory stopped mid-session still has it counted |
| `R` | One meaning everywhere: a first try and `R` more. A manifest holds once its count is past `R`, after `R` + 1 sessions; Build holds once a task's Build manifests on the branch since main are past `R` (`buildIssues`, T174) |
| Build | (`R` + 1) × (`R` + 1) Builder sessions per task, 16 at 3: each red-CI round is a new manifest with its own count. The conflict session counts the same way, as the task-less manifests. T096 replaces both counts with one retry policy |
| Stations 2, 3, 5, 6 | `R` + 1 sessions per manifest. A new manifest needs a new head, which before 28-6 only another commit or a deleted record gives; past that, T096 and T097's per-item budget |
| Intake | `R` + 1 sessions per item, whatever their outcome, main moving or not; a deleted record, a newly installed hash (but not a `context-full` hold) or a move out of `new` starts the count again |
| Not counted | A `LaunchRefused`, a `StackRefused` hold, a prompt refusal and any error before step 9: no session ran, nothing was spent, and a fix outside the branch (PATH, pin, installed factory, token) takes effect with no new commit. Define, and cloud mode |
| Counted with no session | A claude that fails to spawn after step 9: what was attempted, so the hold comes instead of a retry every pass |
| `factory run` | Stops on a failed session, a refusal, a halt, or a pass that starts nothing, and after 20 passes: a relaunch needs another `factory run` or `factory dispatch` |
| One dispatcher | Assumed until 28b. The launcher's `running` flag is per process, the still-running scan sees another factory's session only from its `group.json`, and the cap is checked at step 1 while `recordSession` adds one without checking again: two processes can each relaunch one spent manifest, over the cap by at most the number of processes (deferred (29)). 28b's lock, from before the evidence is read, closes it |

## 5. Holds and alerts

Every alert below is posted once per kind and text, against the inbox's posted alerts, so "once
per" is what the text holds. Not every text carries `#<issue>`: the holds start with it, a failed
session names `<repo>#<issue>`, and a refusal names the repository and, after the fetch, the
branch and its head, but no issue. A refusal tied to one item holds it, alerted as `#<issue>
holds: <refusal>; <branch> is at <head>`, keeping the refusal's kind and urgency, and the pass goes
on; any other refusal ends the pass.

| Kind | Urgency | Raised when | Once per | Way out it names |
|---|---|---|---|---|
| `retry-limit` | info | A spent tip's count is past `R`; at Intake, the item's | Head (with the count, the last failure, the record's path); at Intake, the item and its last session, with how that session ended | Delete the record, push a new head, or install a new factory release; at Intake, delete the record |
| `context-full` | info | A spent tip's failed attempt had a full context; at Intake, the last session's | Head and last failure; at Intake, the item and its last session | Split the item, then delete the record |
| `manifest-unreadable` | urgent | The record names the tip and its manifest cannot be read as the item's | Tip and record | Reinstall the pinned release, or delete the record |
| `manifest-held` | info | `recordIssued` refuses a manifest on the record's own spent one | Parent head; at Build, the issued ref's state | Delete the record; at Build also `git -C <the dispatcher's clone> update-ref refs/factory/build/<branch> <sha>` when the ref is missing or elsewhere |
| `session-failed`, `session-capped` | info, urgent for an urgent failure | A session that spawned failed or hit a cap; nothing of it is pushed | Its text: role, item, failure | The failure's own; the item relaunches or holds as above |
| `session-running` | urgent | The still-running scan finds a live group | Session and group | `kill -TERM -<pgid>` if no factory runs it, then run again. The pass ends there |
| `launcher-unavailable`, `tampering` | info, urgent | A `LaunchRefused` with no kind of its own, `recordSession`'s refusals included; `available()`'s refusals too, unless they carry a kind of their own | Text and branch head; a refusal before the fetch carries no head, so once per text | Its own: run the factory again for a moved branch; for a protected path in the branch's own commits, a role file or model the branch's release lacks, or hooks the installed factory refuses in a release the branch kept, close the item and file it again (on main: re-pin main to a release that has it). A refusal tied to one item holds it; any other ends the pass |
| `release-incomplete` | info | The factory clone lacks the pinned commit, or the release lacks the station's prompt or commands or has one that is not correct | The pin, its tag and sha, and the head | Fetch the factory clone; pin a release on main that has the file; or, for a template, pin a release on main with a correct `factory/<path>`. The reason through `visible()`. The item holds and the pass goes on |
| `pass-threw` | urgent | `factory run`'s pass throws: a bad record or `group.json` read with the evidence, rows 4 and 7, a record `recordIssued` cannot write, no hash, a spawn failure, an unrecorded outcome | Main's head, the error's kind and first line, with no temporary path, id (but row 7's), pid or time | The error's own: delete the record, remove the folder after `ps`, reinstall the release, free the disk |
| `checks-unreadable` | info | CI's `build-test` at the Builder's head, or Verify's required checks, cannot be read | Head and reason | None but waiting: the item waits until they can be read |
| `build-failed` | info | Build's cap, or a conflict git does not find | Head and task | Close the item and file it again, until T096 |
| `tampering` | urgent | The issued ref's manifest is not in the branch's history | Text | Close the item and file it again |
| `session-tools`, `claude-version` | info | A session ran without a role's tool, or on another Claude Code version | Text | Set the expected tools from T125's part (7); re-run T125's A8 |

`factory dispatch` runs one pass and alerts nothing when it throws; only `factory run` posts
`pass-threw`. A held item is alerted before the station-pause check, so it alerts during
`pause:<station>` too (deferred (32)); a hold never starts a session and the pass goes on to the
next item.
