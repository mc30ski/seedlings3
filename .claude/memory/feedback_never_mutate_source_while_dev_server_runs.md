---
name: feedback-never-mutate-source-while-dev-server-runs
description: "Mutation-testing gate rules by editing real source files breaks the user's running app — the dev server caches the mutated module even after the file is restored."
metadata:
  type: feedback
---

# Never mutation-test against live source while the dev server is running

Verifying a build-gate rule by temporarily breaking a real source file and
restoring it is standard practice here (see
[[feedback-run-build-gate-after-changes]]) — but it is **not safe while the
user has `npm run dev` up**, which is almost always.

**What happened (2026-09-20):** to prove a new gate caught an unhoisted
loading gate, I injected `if (loading) return <Spinner/>` into `AuditTab.tsx`,
ran the gate, then restored the file with `mv AuditTab.tsx.bak AuditTab.tsx`.
The file on disk was byte-identical afterwards and `tsc` passed. The user then
reported **"Records Audit tab is broken (crashes)"** — `loading is not
defined`. Next's dev server had compiled the mutated module and the `mv` did
not retrigger a rebuild, so the app kept serving the broken chunk. Nothing in
git, tsc or the gate could see it.

**Why:** an atomic rename swaps the inode. The watcher can miss it, and the
restored file has an *older* mtime than the compiled chunk, so nothing looks
stale.

## Do this instead

- Prefer mutating a **copy** and pointing the gate at it, when the rule reads
  files by path.
- If a real file must be touched: **write** the restore (`open(p,"w")`), never
  `mv`/`cp` a backup over it, and then force a rebuild by rewriting the file
  once more so mtime moves forward.
- **Verify the app, not just the file** — after any mutation round, load the
  affected tab and check for console/page errors before reporting done. A
  clean `git diff` is not evidence the running app is clean.

Related: [[feedback-never-build-while-dev-server-runs]] (same shared-`.next`
failure class), [[feedback-never-ship-a-red-spec]].
