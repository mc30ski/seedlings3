---
name: feedback-commit-memory-by-design
description: "Memory lives in the repo at .claude/memory/ and is meant to be version-controlled. Commit memory changes as part of the work — the user should never have to ask."
metadata:
  node_type: memory
  type: feedback
---

`.claude/memory/` is INSIDE the repo (`/Users/michaelwanderski/dev/seedlings3/.claude/memory/`)
and its files are tracked by git. Memory edits show up in `git status`
like any other change.

**When I write or update a memory file, I commit it as part of that
work.** The user should not have to ask each time.

**Why:** the user stated it directly — *"all memory should be checked
into github by design for me. i shouldn't have to ask each time."*
Memory that only exists on one machine defeats the purpose: it's meant
to survive sessions, machines, and context resets.

**How to apply:**

- After writing/updating memory, `git add` the memory files and commit
  them with a clear message. Don't leave them dangling in the working
  tree.
- Keep the memory commit SEPARATE from unrelated code changes when
  practical, so the history stays readable.
- **Pushing is still gated.** This standing permission covers `git
  commit`, NOT `git push`. The hard rule in
  [[feedback-never-push-without-explicit-permission]] is unchanged and
  absolute: nothing leaves the machine without an explicit, in-the-moment
  "push" from the user. "Checked into github by design" establishes that
  memory BELONGS in version control — it does not pre-authorize the
  publish step. Commit freely; ask before pushing.

Related: [[feedback-never-push-without-explicit-permission]].
