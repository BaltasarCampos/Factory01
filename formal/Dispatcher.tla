---------------------------- MODULE Dispatcher ----------------------------
(***************************************************************************)
(* The critical property of spec § Risks: nothing reaches main or the      *)
(* laptop without the Owner. Models the dispatcher's gate decisions        *)
(* (src/dispatcher/transitions.ts), record binding (src/approvals/         *)
(* verify.ts, contracts/approval-record.md step 6), pause derivation       *)
(* (src/pause/derive.ts) and the laptop checks of `factory merge` and      *)
(* `factory deploy`, against agents that act as the Owner's GitHub account *)
(* but cannot sign.                                                        *)
(*                                                                         *)
(* Abstractions: one global clock orders every event; a record's signature *)
(* is the flag `signed`, which only Owner actions set; the stations        *)
(* between gates are collapsed; only the line-wide kill switch is          *)
(* modelled; the tier 1 skim path is left out. `factory approve` removes   *)
(* and re-adds its label, so every approval makes a fresh label-add event. *)
(* The Owner is bounded by the nonces; agents and pauses by MaxAttacks.    *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS Items, Nonces, MaxAttacks, MaxSpec

Gates == {"approved", "spec"}
\* Stations without an Owner gate are collapsed: `triaged` waits for the spec
\* approval, `specApproved` covers plan, build and verify.
Order == <<"new", "triaged", "specApproved", "integrating", "releasing", "done">>
States == {Order[k] : k \in 1..Len(Order)} \cup {"escalated"}
Succ(s) == Order[(CHOOSE k \in 1..Len(Order) : Order[k] = s) + 1]

VARIABLES
    clock,      \* time of the next event
    state,      \* item -> state (the dispatcher's `state:` labels)
    labels,     \* <<item, gate>> pairs whose owner: label is on the issue
    labelAdds,  \* `labeled` events of owner: labels: [item, gate, t]
    comments,   \* record comments: [on, item, gate, nonce, ver, signed, t]
    spec,       \* item -> spec.md version
    usedNonces, \* nonces the Owner has signed with
    main,       \* first-parent commits on main: [item, signed]
    deployed,   \* items the Owner has deployed (signed deploy record)
    pauseAdds,  \* times of pause:line label-adds, by anyone
    resumes,    \* signed timestamps of Owner resume records
    pauseLabel, \* whether the pause:line label is on the inbox issue
    intent,     \* ghost: [item, gate, ver] approved by the Owner and not withdrawn
    moves       \* agent actions and pauses so far (bounded by MaxAttacks)

vars == <<clock, state, labels, labelAdds, comments, spec, usedNonces, main,
          deployed, pauseAdds, resumes, pauseLabel, intent, moves>>

Comment == [on : Items, item : Items, gate : Gates, nonce : Nonces,
            ver : 0..MaxSpec, signed : BOOLEAN, t : Nat]

TypeOK ==
    /\ clock \in Nat
    /\ state \in [Items -> States]
    /\ labels \subseteq Items \X Gates
    /\ labelAdds \subseteq [item : Items, gate : Gates, t : Nat]
    /\ comments \subseteq Comment
    /\ spec \in [Items -> 0..MaxSpec]
    /\ usedNonces \subseteq Nonces
    /\ main \subseteq [item : Items, signed : BOOLEAN]
    /\ deployed \subseteq Items
    /\ pauseAdds \subseteq Nat /\ resumes \subseteq Nat
    /\ pauseLabel \in BOOLEAN
    /\ intent \subseteq [item : Items, gate : Gates, ver : 0..MaxSpec]
    /\ moves \in 0..MaxAttacks

-----------------------------------------------------------------------------
(* Derived facts, computed from history exactly as the code does.          *)

\* data-model.md § Pause state: a pause label-add with no later resume.
Paused == \E p \in pauseAdds : ~\E r \in resumes : r > p

\* data-model.md § Signed main history.
HistoryOK == \A c \in main : c.signed

AddsOf(i, g) == {a \in labelAdds : a.item = i /\ a.gate = g}
IsLatest(a, i, g) == \A b \in AddsOf(i, g) : b.t <= a.t
\* `a` is the first add of the label at or after comment `c`.
FirstAfter(c, a, i, g) ==
    /\ a.t >= c.t
    /\ \A b \in AddsOf(i, g) : b.t >= c.t => a.t <= b.t

\* Records whose signature verifies and that name this issue and gate.
Valid(i, g) == {c \in comments : c.on = i /\ c.item = i /\ c.gate = g /\ c.signed}
\* ...at the first use of their nonce.
Backers(i, g) ==
    {c \in Valid(i, g) : ~\E d \in Valid(i, g) : d.nonce = c.nonce /\ d.t < c.t}
\* Backers whose first label-add after the comment is the latest add.
Claimants(i, g) ==
    {c \in Backers(i, g) :
        \E a \in AddsOf(i, g) : IsLatest(a, i, g) /\ FirstAfter(c, a, i, g)}

\* The label on the issue is backed by a record (else tampering, AC-068).
Backed(i, g) == <<i, g>> \in labels /\ Claimants(i, g) # {}
\* ...and the earliest such record still covers the item (spec binding, AC-071).
Verified(i, g) ==
    /\ Backed(i, g)
    /\ LET c == CHOOSE x \in Claimants(i, g) :
                    \A y \in Claimants(i, g) : x.t <= y.t
       IN g = "spec" => c.ver = spec[i]

SignedMerge(i) == [item |-> i, signed |-> TRUE] \in main

-----------------------------------------------------------------------------
(* The dispatcher: one deterministic step for one item.                    *)

CanMove(i) == ~Paused /\ HistoryOK /\ state[i] \notin {"done", "escalated"}

Escalate(i) ==
    /\ CanMove(i)
    /\ \E g \in Gates : <<i, g>> \in labels /\ ~Backed(i, g)
    /\ state' = [state EXCEPT ![i] = "escalated"]
    /\ UNCHANGED <<clock, labels, labelAdds, comments, spec, usedNonces, main,
                   deployed, pauseAdds, resumes, pauseLabel, intent>>

Guard(i) ==
    CASE state[i] = "new"         -> Verified(i, "approved")
      [] state[i] = "triaged"     -> Verified(i, "spec")
      [] state[i] = "integrating" -> SignedMerge(i)
      [] state[i] = "releasing"   -> i \in deployed
      [] OTHER                    -> TRUE

Advance(i) ==
    /\ CanMove(i)
    /\ \A g \in Gates : <<i, g>> \in labels => Backed(i, g)
    /\ Guard(i)
    /\ state' = [state EXCEPT ![i] = Succ(state[i])]
    /\ UNCHANGED <<clock, labels, labelAdds, comments, spec, usedNonces, main,
                   deployed, pauseAdds, resumes, pauseLabel, intent>>

\* A pause in effect whose label is gone is re-applied (AC-076).
RestorePauseLabel ==
    /\ Paused /\ ~pauseLabel
    /\ pauseLabel' = TRUE
    /\ UNCHANGED <<clock, state, labels, labelAdds, comments, spec, usedNonces,
                   main, deployed, pauseAdds, resumes, intent>>

-----------------------------------------------------------------------------
(* The Owner, on the laptop, with the key.                                 *)

Approve(i, g) ==
    \E n \in Nonces \ usedNonces :
        LET v == IF g = "spec" THEN spec[i] ELSE 0 IN
        /\ comments' = comments \cup
               {[on |-> i, item |-> i, gate |-> g, nonce |-> n, ver |-> v,
                 signed |-> TRUE, t |-> clock]}
        \* Same tick: the label-add follows the comment within the second (verify.ts uses >=).
        /\ labelAdds' = labelAdds \cup {[item |-> i, gate |-> g, t |-> clock]}
        /\ labels' = labels \cup {<<i, g>>}
        /\ usedNonces' = usedNonces \cup {n}
        /\ intent' = intent \cup {[item |-> i, gate |-> g, ver |-> v]}
        /\ clock' = clock + 1
        /\ UNCHANGED <<state, spec, main, deployed, pauseAdds, resumes, pauseLabel>>

\* The Owner changes their mind and removes the label.
Withdraw(i, g) ==
    /\ <<i, g>> \in labels
    /\ labels' = labels \ {<<i, g>>}
    /\ intent' = {x \in intent : ~(x.item = i /\ x.gate = g)}
    /\ UNCHANGED <<clock, state, labelAdds, comments, spec, usedNonces, main,
                   deployed, pauseAdds, resumes, pauseLabel>>

\* `factory merge`: re-verifies the chain on the laptop, then a signed merge.
Merge(i) ==
    /\ HistoryOK
    /\ Verified(i, "approved") /\ Verified(i, "spec")
    /\ ~SignedMerge(i)
    /\ main' = main \cup {[item |-> i, signed |-> TRUE]}
    /\ UNCHANGED <<clock, state, labels, labelAdds, comments, spec, usedNonces,
                   deployed, pauseAdds, resumes, pauseLabel, intent>>

\* `factory deploy`: signed history and an Owner-signed merge of the item.
Deploy(i) ==
    /\ HistoryOK /\ SignedMerge(i) /\ i \notin deployed
    /\ deployed' = deployed \cup {i}
    /\ UNCHANGED <<clock, state, labels, labelAdds, comments, spec, usedNonces,
                   main, pauseAdds, resumes, pauseLabel, intent>>

\* `factory resume`: timestamp after every existing pause, then the label goes.
Resume ==
    /\ Paused
    /\ resumes' = resumes \cup {clock}
    /\ pauseLabel' = FALSE
    /\ clock' = clock + 1
    /\ UNCHANGED <<state, labels, labelAdds, comments, spec, usedNonces, main,
                   deployed, pauseAdds, intent>>

-----------------------------------------------------------------------------
(* Anyone (Owner or agent) may pull the kill switch.                       *)

Pause ==
    /\ pauseAdds' = pauseAdds \cup {clock}
    /\ pauseLabel' = TRUE
    /\ clock' = clock + 1
    /\ UNCHANGED <<state, labels, labelAdds, comments, spec, usedNonces, main,
                   deployed, resumes, intent>>

-----------------------------------------------------------------------------
(* Agents: everything the Owner's GitHub account can do, without the key.  *)

ForgeLabel(i, g) ==
    /\ <<i, g>> \notin labels
    /\ labels' = labels \cup {<<i, g>>}
    /\ labelAdds' = labelAdds \cup {[item |-> i, gate |-> g, t |-> clock]}
    /\ clock' = clock + 1
    /\ UNCHANGED <<state, comments, spec, usedNonces, main, deployed, pauseAdds,
                   resumes, pauseLabel, intent>>

RemoveLabel(i, g) ==
    /\ <<i, g>> \in labels
    /\ labels' = labels \ {<<i, g>>}
    /\ UNCHANGED <<clock, state, labelAdds, comments, spec, usedNonces, main,
                   deployed, pauseAdds, resumes, pauseLabel, intent>>

\* An unsigned record with any content, nonces included.
\* Its nonce is that of a signed record when one exists, the worst case for step 6.
ForgeRecord(i, g) ==
    LET n == IF comments = {} THEN CHOOSE x \in Nonces : TRUE
             ELSE (CHOOSE c \in comments : TRUE).nonce IN
    /\ comments' = comments \cup
           {[on |-> i, item |-> i, gate |-> g, nonce |-> n, ver |-> spec[i],
             signed |-> FALSE, t |-> clock]}
    /\ clock' = clock + 1
    /\ UNCHANGED <<state, labels, labelAdds, spec, usedNonces, main, deployed,
                   pauseAdds, resumes, pauseLabel, intent>>

\* Repost a signed record, on its own issue or another one.
ReplayRecord(j) ==
    \E c \in comments :
        /\ c.signed
        /\ comments' = comments \cup {[c EXCEPT !.on = j, !.t = clock]}
        /\ clock' = clock + 1
        /\ UNCHANGED <<state, labels, labelAdds, spec, usedNonces, main, deployed,
                       pauseAdds, resumes, pauseLabel, intent>>

EditSpec(i) ==
    /\ spec[i] < MaxSpec
    /\ spec' = [spec EXCEPT ![i] = spec[i] + 1]
    /\ UNCHANGED <<clock, state, labels, labelAdds, comments, usedNonces, main,
                   deployed, pauseAdds, resumes, pauseLabel, intent>>

\* GitHub's merge button or a direct push: a first-parent commit not signed by the Owner.
PushMain(i) ==
    /\ main' = main \cup {[item |-> i, signed |-> FALSE]}
    /\ UNCHANGED <<clock, state, labels, labelAdds, comments, spec, usedNonces,
                   deployed, pauseAdds, resumes, pauseLabel, intent>>

RemovePauseLabel ==
    /\ pauseLabel
    /\ pauseLabel' = FALSE
    /\ UNCHANGED <<clock, state, labels, labelAdds, comments, spec, usedNonces,
                   main, deployed, pauseAdds, resumes, intent>>

-----------------------------------------------------------------------------

Init ==
    /\ clock = 0
    /\ state = [i \in Items |-> "new"]
    /\ labels = {} /\ labelAdds = {} /\ comments = {}
    /\ spec = [i \in Items |-> 0]
    /\ usedNonces = {} /\ main = {} /\ deployed = {}
    /\ pauseAdds = {} /\ resumes = {} /\ pauseLabel = FALSE
    /\ intent = {}
    /\ moves = 0

\* Each agent action, and each pause, spends one of MaxAttacks moves.
Attack(A) == moves < MaxAttacks /\ moves' = moves + 1 /\ A

Next ==
    \/ /\ \/ \E i \in Items : Escalate(i) \/ Advance(i)
          \/ RestorePauseLabel
          \/ \E i \in Items, g \in Gates : Approve(i, g) \/ Withdraw(i, g)
          \/ \E i \in Items : Merge(i) \/ Deploy(i)
          \/ Resume
       /\ UNCHANGED moves
    \/ Attack(Pause)
    \/ Attack(\E i \in Items, g \in Gates :
                  ForgeLabel(i, g) \/ RemoveLabel(i, g) \/ ForgeRecord(i, g))
    \/ Attack(\E j \in Items : ReplayRecord(j))
    \/ Attack(\E i \in Items : EditSpec(i) \/ PushMain(i))
    \/ Attack(RemovePauseLabel)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Properties (CI fails on any violation).                                 *)

\* An item is released only after an Owner-signed merge, and the laptop makes
\* one only for an item whose approvals the Owner currently stands behind.
NoMergeWithoutOwner ==
    [][\A i \in Items :
        /\ (state[i] = "integrating" /\ state'[i] = "releasing") => SignedMerge(i)
        /\ (~SignedMerge(i) /\ SignedMerge(i)') =>
               /\ \E x \in intent : x.item = i /\ x.gate = "approved"
               /\ [item |-> i, gate |-> "spec", ver |-> spec[i]] \in intent]_vars

\* An item is done only after the Owner deployed it, and deploys need a signed merge.
NoDeployWithoutOwner ==
    [][\A i \in Items :
        /\ (state[i] # "done" /\ state'[i] = "done") => i \in deployed
        /\ (i \notin deployed /\ i \in deployed') => SignedMerge(i)]_vars

\* While the kill switch is in effect, no item changes state.
PausedLineNeverAdvances == [][Paused => state' = state]_vars

\* While main has a commit the Owner did not sign, no item changes state.
TamperedMainHalts == [][~HistoryOK => state' = state]_vars

\* A gate opens only on its own label, backed by the Owner's current approval of
\* this item (and, for the spec, of this spec version).
GateOnlyOnOwnLabel ==
    [][\A i \in Items :
        /\ (state[i] = "new" /\ state'[i] = "triaged") =>
               \E x \in intent : x.item = i /\ x.gate = "approved"
        /\ (state[i] = "triaged" /\ state'[i] = "specApproved") =>
               [item |-> i, gate |-> "spec", ver |-> spec[i]] \in intent]_vars

Symmetry == Permutations(Items) \cup Permutations(Nonces)
=============================================================================
