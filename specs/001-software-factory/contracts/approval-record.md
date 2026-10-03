# Contract: signed approval and resume records

Format and field rules: [data-model.md § Approval record](../data-model.md#approval-record).
Keys, revocation and rotation: [data-model.md § Keys and rotation](../data-model.md#keys-and-rotation).

## Posting format (issue comment)

````text
<!-- factory-record v1 -->
**Owner approval**: spec-approved for #42 (tier 2)

```factory-record
factory-approve/v1
repo: baltisark/sample
issue: 42
gate: spec-approved
tier: 2
branch: claude/42-add-login
spec_sha: 3b18e512dba79e4c8300dd08aeb37f8e728b8dad
timestamp: 2026-10-01T09:12:44Z
nonce: 9f2c1e0a7b4d4e8f8a1b2c3d4e5f6a7b
```

```factory-signature
-----BEGIN SSH SIGNATURE-----
...
-----END SSH SIGNATURE-----
```
````

## Verification algorithm (dispatcher and laptop share `src/approvals/verify.ts`)

1. Extract record and signature blocks; reject if either is missing or malformed.
2. Re-serialise the record canonically; reject if bytes differ from the posted block.
3. Load `allowed_signers` and `revoked_keys` from the factory release pinned **on main**
   (never from a pull request's copy). Reject unless the second copy equals the newest key.
   The second copy is the routine's `FACTORY_ALLOWED_SIGNERS` in the cloud, and on the laptop
   the public half of the key it currently signs with (`~/.factory/keys/approve_ed25519.pub`).
   If the newest key changed through a signed upgrade merge and the second copy still holds
   the previous key, report **key rotation pending** instead of tampering (AC-072, AC-084).
4. `ssh-keygen -Y verify -n factory-approve -I owner -f <allowed_signers> -r <revoked_keys>
   -s <sig>` with the record on stdin; reject on non-zero exit (AC-085).
5. Check fields against the item: repo, issue, gate, tier, branch, and for `spec-approved`
   the current `spec.md` blob hash (AC-070, AC-071). For code-gate waivers, `head` must equal
   the PR's current head commit (AC-089); pre-build gate waivers carry no `head`. For `check:guardrail-change@<tag>@<sha>` waivers, the
   PR must be the upgrade PR for that release.
6. Check single use and freshness:
   - `approved`, `spec-approved`, `waiver`: the nonce backs exactly one label-add event — the
     first matching one after the comment; any other use → replay.
   - `resume`: the record lifts only `pause:<scope>` label-add events whose time is **before
     the record's `timestamp`**; a pause added after that timestamp is never lifted by it,
     however late the record is posted. Its nonce must be the first occurrence among all
     record comments on the inbox issue.
   - `deployed`: the nonce must be the first occurrence among all records in the repo.
   Laptop commands also keep `~/.factory/nonces.log`, one `<nonce> <repo>#<issue>/<comment id>`
   line per nonce, appended the first time the laptop issues or sees it. A nonce already
   recorded against another comment → replay (AC-079); the same comment verifies again, so
   `factory merge` can re-verify records that `factory approve` wrote.

Each failure has a kind, and the kind decides what happens:

| Kind | Cause | Effect |
|------|-------|--------|
| `tampering` | Step 1–4 failure; an identity field (repo, issue, gate, tier, branch, scope, waiver target) does not match; an `owner:` label not backed by a verified record; a guardrail-change waiver outside the upgrade PR for its release; a deploy record for another head | Item stops, urgent alert "tampering", event logged (AC-068) |
| `replay` | Step 6 failure | Same as tampering (AC-079) |
| `stale` | A genuine record that no longer covers the item: `spec.md` changed since `spec-approved` (AC-071), or the PR head moved past a code-gate waiver's `head` (AC-089) | No alert; the item waits for a fresh signature (`factory merge` offers to re-sign a stale waiver) |
| `rotation-pending` | Step 3 rotation case | Line halts, one urgent alert naming the key to update (AC-084) |
| `missing` | No `owner:` label yet, or no verified waiver for the target asked about | The item waits for the Owner |

## Signed merge commits (replace the earlier `merged` record)

`factory merge` makes the merge commit itself, on the laptop, signed with the Owner key under
git's SSH signing (namespace `git`), and pushes it to main. The signed commit is the merge
approval; there is no separate record. Verification: `git verify-commit` with
`gpg.ssh.allowedSignersFile` = main's pinned `allowed_signers`, revoked keys excluded. Rules
for main's first-parent history: [data-model.md § Signed main history](../data-model.md#signed-main-history).

## Deploy record

Signed by `factory deploy` **before** it pulls main: `gate: deployed`, `head` (the main
commit being deployed), posted to the Owner inbox issue. If signing fails, nothing is pulled,
built or restarted.

## Release tags

`factory release <tag>` (factory repository, laptop only) shows the diff since the last signed
tag, asks the Owner to confirm, builds `guardrails.manifest.json`, and creates the tag with
`git tag -s` (SSH, namespace `git`). `factory upgrade` and `factory merge` accept a release only
if its tag verifies against main's pinned `allowed_signers` (the laptop's key list for
`factory new`) and still resolves to the commit named in the pin or waiver (AC-083).
