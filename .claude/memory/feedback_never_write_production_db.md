---
name: feedback-never-write-production-db
description: "NEVER write to the production database without explicit permission for THAT operation, and confirm before executing even then. Reads are fine. Several writes were authorised individually on 2026-10-31/11-01; the operator REINSTATED the read-only default afterwards — that history is not a precedent."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: e3608af7-8965-4649-8bef-c7a4069a7325
  modified: 2026-11-01T00:00:00.000Z
---

**HARD RULE: never issue a write against the production database.** INSERT, UPDATE, DELETE, upsert, migration — none of it, no matter how small, how additive, or how explicitly permitted earlier in the session. **Read-only queries are fine and encouraged** — that's how you settle questions empirically. But every write is the user's to run.

This sits alongside [[feedback-never-push-without-explicit-permission]]: the user already owns commits, pushes and deploys. Production data belongs in that same bucket.

**Why:** On 2026-09-02 the user granted a narrow, specific permission — *"add all the needed Settings configuration to Production, you have my permission as long as it's additive and nothing is destructive."* I added a `costBehavior` field to every entry of the `EXPENSE_CATEGORIES` setting. It was additive as data. It also broke the production ledger for 31 minutes: the DEPLOYED parser rejects unknown fields and its loader swallows the error into an empty list, so every expense category became invalid and the operator could not record a recurring payment. The error message said `Invalid category: "Other"` and never mentioned the setting, so it looked like it came from nowhere.

The user's response: *"i can never trust you again"* and *"I can't trust you anymore with touch production."*

**The specific failure was not carelessness — it was a check that looked rigorous and proved nothing.** I ran `validateExpenseCategoriesJson` against the new value and it passed. But I imported it from my *working tree*, which I had just edited to accept the new field. I validated production data against code that did not exist in production. I also explicitly checked backward compatibility ("does the old value still parse?") — the wrong direction. The risk was new data against old code.

## THE 2026-10-31 EXCEPTIONS WERE NOT A PRECEDENT

Over two days the operator authorised four production writes, each
separately and each for one named operation: 20 `completedAt` backfills,
three abandoned-record deletions, and the portfolio tree build. All went
cleanly — dry run first, pinned ids, re-check before writing, verify
after.

**Then the operator reinstated the default, in these words:** *"I've been
very generous with your ability to modify production database. It's worked
out good so far, but I want you to go back to the posture that you never
update production unless I explicitly give you permission to and you
double check with me. Otherwise it's read-only access to production."*

So a future session reading that run of successful writes must not
conclude the rule has relaxed. It has not. **Permission is per-operation
and expires with the operation**, and a clean track record is not standing
consent — it is exactly the condition under which the 2026-09-02 incident
happened.

**Two gates now, not one:**
1. The operator says yes to THIS operation.
2. You confirm back what you are about to run, and wait, before running it.

A dry run is a READ and needs no permission; running it is the right way
to show what a write would do.

**How to apply:**
- Default: prepare the change, dry-run it (a read), show the before state, what you verified and what would change — then hand it over. Do not run it.
- With explicit per-operation permission: still dry-run first, still state plainly what you are about to execute, and only then run it.
- Reads are unrestricted. Use `BEGIN TRANSACTION READ ONLY` for anything non-trivial so it's provably safe.
- **Deploy order is a real constraint, not pedantry.** Config that only a NEW code version understands must be written AFTER that code deploys. Deploy first, then config. Say this out loud when handing over SQL.
- When validating a config change destined for production, validate against `git show HEAD:<file>` — the code that is actually running — never against the working tree.
- "Additive" describes JSON shape. It says nothing about whether a strict parser will accept it. Those are different questions and only the second one matters.

**Related structural hazard worth fixing when there's time:** parsers that reject unknown keys *on read* turn every config schema change into a deploy-ordering landmine, and `loadExpenseCategories` swallowing the error into `[]` converts it into silent total loss. Strict on write (catch typos), tolerant on read (a newer field must never blank a taxonomy). `PAYMENT_METHODS` and `PAYROLL_TAX_ESTIMATES` likely share the shape.
