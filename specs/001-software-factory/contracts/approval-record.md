# Contract: signed approval and resume records

Format and field rules: [data-model.md § Approval record](../data-model.md#approval-record).

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
3. Load pinned `allowed_signers` and the second copy (routine env or laptop); reject unless
   identical (AC-072).
4. `ssh-keygen -Y verify -n factory-approve -I owner -f <allowed_signers> -s <sig>` with the
   record on stdin; reject on non-zero exit.
5. Check fields against the item: repo, issue, gate, tier, branch, and for `spec-approved`
   the current `spec.md` blob hash (AC-070, AC-071).
6. Check nonce: the record backs exactly one label-add event — the first matching one after
   the comment; any other use → replay (AC-079). Laptop also checks `~/.factory/nonces.log`.

Any failure → item stops, urgent alert "tampering", event logged (AC-068).

## Merge verification record

Written by `factory merge` after a successful merge: same envelope, `gate: merged`, plus
`pr` and `merge_sha`. The dispatcher alerts on any merge to main without one (AC-073).
