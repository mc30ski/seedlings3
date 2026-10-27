# History

Records of one-off production data migrations, kept as evidence of exactly
what moved. **Nothing here runs.**

They are stored as `.txt` deliberately. They used to live in
`apps/api/scripts/` as `.ts`, which made them look like tools somebody could
run again — and by the time they were found, both had stopped compiling
against the current schema (they still referenced the deleted `UserRole`
model). A half-running purge against live data is the failure shape this
directory exists to prevent, and `apps/api/scripts/` is now typechecked, so
a record that cannot compile does not belong there.

| File | What it did |
|---|---|
| `purge-mark-baliff.ts.txt` | Reassigned 748 rows — 53 job assignments across 23 clients, 47 payment splits, 132 photos, 14 checkouts — from a duplicate login to the owner, with `ownerEarnings: true`. Nothing deleted: the splits sit on $3,740 of real client revenue, so removing them would have erased income and broken payment conservation. |
| `purge-matthew-wanderski.ts.txt` | The same treatment for the second test login. |

Context, and the open question about David's W-2 wages, is in
`.claude/memory/project_mark_baliff_purge.md`.
