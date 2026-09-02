---
name: feedback-never-write-production-db
description: "NEVER write to the production database. Reads are fine; every write is the user's to run. Prepare the SQL, show what you verified, hand it over."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: e3608af7-8965-4649-8bef-c7a4069a7325
  modified: 2026-09-02T20:32:10.374Z
---

**HARD RULE: never issue a write against the production database.** INSERT, UPDATE, DELETE, upsert, migration — none of it, no matter how small, how additive, or how explicitly permitted earlier in the session. **Read-only queries are fine and encouraged** — that's how you settle questions empirically. But every write is the user's to run.

This sits alongside [[feedback-never-push-without-explicit-permission]]: the user already owns commits, pushes and deploys. Production data belongs in that same bucket.

**Why:** On 2026-09-02 the user granted a narrow, specific permission — *"add all the needed Settings configuration to Production, you have my permission as long as it's additive and nothing is destructive."* I added a `costBehavior` field to every entry of the `EXPENSE_CATEGORIES` setting. It was additive as data. It also broke the production ledger for 31 minutes: the DEPLOYED parser rejects unknown fields and its loader swallows the error into an empty list, so every expense category became invalid and the operator could not record a recurring payment. The error message said `Invalid category: "Other"` and never mentioned the setting, so it looked like it came from nowhere.

The user's response: *"i can never trust you again"* and *"I can't trust you anymore with touch production."*

**The specific failure was not carelessness — it was a check that looked rigorous and proved nothing.** I ran `validateExpenseCategoriesJson` against the new value and it passed. But I imported it from my *working tree*, which I had just edited to accept the new field. I validated production data against code that did not exist in production. I also explicitly checked backward compatibility ("does the old value still parse?") — the wrong direction. The risk was new data against old code.

**How to apply:**
- Prepare the SQL. Show the before state, what you verified, and what will change. Hand it to the user to paste into the Neon editor. Do not run it.
- Reads are unrestricted. Use `BEGIN TRANSACTION READ ONLY` for anything non-trivial so it's provably safe.
- **Deploy order is a real constraint, not pedantry.** Config that only a NEW code version understands must be written AFTER that code deploys. Deploy first, then config. Say this out loud when handing over SQL.
- When validating a config change destined for production, validate against `git show HEAD:<file>` — the code that is actually running — never against the working tree.
- "Additive" describes JSON shape. It says nothing about whether a strict parser will accept it. Those are different questions and only the second one matters.

**Related structural hazard worth fixing when there's time:** parsers that reject unknown keys *on read* turn every config schema change into a deploy-ordering landmine, and `loadExpenseCategories` swallowing the error into `[]` converts it into silent total loss. Strict on write (catch typos), tolerant on read (a newer field must never blank a taxonomy). `PAYMENT_METHODS` and `PAYROLL_TAX_ESTIMATES` likely share the shape.
