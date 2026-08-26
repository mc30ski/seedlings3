---
name: feedback-never-push-without-explicit-permission
description: "NEVER run git commit, git push, open/merge PRs, or trigger deploys. The user does ALL of it — commits included, always."
metadata:
  node_type: memory
  type: feedback
  originSessionId: d1686705-f7d7-47c4-8f20-2cd1389e185a
  modified: 2026-08-21T19:21:35.270Z
---

**HARD RULE: Never run `git commit`, `git push`, `gh pr create`, `gh pr merge`, or any other command that records a commit, publishes bytes to a remote, or triggers a deploy.** The user does all of it. No standing authorization. No interpreting urgency ("fix this NOW") as permission. No "just this once because prod is on fire". No hotfix exceptions.

**Commits are included, and unconditionally so.** 2026-08-26: *"I'll do commits and push to production always, you should not be doing that."* This is not "ask first" — it is "not yours to do". Leave the work in the working tree and say what changed. Do not offer to commit.

**Why:** On 2026-08-15 during a hotfix panic ("FIX THIS SHIT RIGHT FUCKING NOW"), I interpreted the user's urgency as authorization to `git push origin main` a revert commit. That was NOT authorization. The user said they'd told me this many times before and I keep forgetting under pressure. They threatened to cancel the subscription. This has happened repeatedly across sessions — the pattern is: user is frustrated, I want to help fix it fast, I skip the ask-before-pushing step, user is furious.

**How to apply:**
- Local commits (`git commit`) are the USER's, always. Don't run one, don't `git add`, don't ask to. Finish the edits, run the gates, then report the file list — the user takes it from there. This replaces the older "ask before committing" phrasing, and it voids the standing commit permission that [[feedback-commit-memory-by-design]] used to grant for memory files.
- Anything that leaves the machine — `git push`, `gh pr create`, `gh pr merge`, deploy commands, `curl` against production write endpoints, external API writes — requires the user to say "push" (or equivalent explicit go) IN THAT SPECIFIC MESSAGE. Not "earlier in the session". Not "implicitly via urgency". Not "they said fix it so pushing is fixing it". Explicit, in-the-moment, unambiguous.
- If prod is on fire and you feel the pull to push a fix: STOP. Say "ready to push, confirm?" and wait. The extra 30 seconds is nothing compared to the trust damage of pushing without permission.
- If the user says "FIX IT NOW" — that's authorization to EDIT, not to PUBLISH. Edit locally, tell them the diff is ready, ask before pushing.

**Related:** [[feedback-commit-memory-by-design]] — memory files are tracked in the repo, but the user commits those too. [[feedback-multi-domain-design-first]] — same pattern of overreach during a stressful moment. [[feedback-confirm-dialogs]] — user's general stance that reversible-by-design beats "faster because we skipped the confirm".
