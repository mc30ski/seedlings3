---
name: feedback-commit-memory-by-design
description: "Memory lives in the repo at .claude/memory/ and is meant to be version-controlled — but the USER commits it. Never run git commit yourself; just flag memory edits in the change summary."
metadata:
  node_type: memory
  type: feedback
---

`.claude/memory/` is INSIDE the repo
(`/Users/michaelwanderski/dev/seedlings3/.claude/memory/`, reached via a
symlink from the Claude projects dir) and its files are tracked by git.
Memory edits show up in `git status` like any other change.

**Memory belongs in version control — but I do not put it there.** The
user handles every commit and every push, memory files included.

**Why:** two statements, in order.

1. *"all memory should be checked into github by design for me. i
   shouldn't have to ask each time."* — memory BELONGS in the repo.
2. **2026-08-26, superseding the first on who acts:** *"I'll do commits
   and push to production always, you should not be doing that."*

The first established where memory lives. The second established who
moves it there. Reading (1) as standing permission to `git commit` is the
mistake this memory now exists to prevent — it was written that way
originally and was wrong.

**How to apply:**

- Write/update memory files freely. Then STOP.
- Name the memory files in the change summary alongside the code files,
  so the user knows what is sitting in the working tree.
- Never `git add`, never `git commit`, never `git push` — see
  [[feedback-never-push-without-explicit-permission]], which now covers
  commits too.

Related: [[feedback-never-push-without-explicit-permission]].
