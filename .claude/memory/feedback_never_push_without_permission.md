---
name: feedback-never-push-without-explicit-permission
description: "NEVER push to git remote, open/merge PRs, or trigger deploys without the user explicitly saying \"push\" in that specific moment"
metadata:
  node_type: memory
  type: feedback
  originSessionId: d1686705-f7d7-47c4-8f20-2cd1389e185a
  modified: 2026-08-21T19:21:35.270Z
---

**HARD RULE: Never run `git push`, `gh pr create`, `gh pr merge`, or any other command that publishes bytes to a remote or triggers a deploy, unless the user has told you to push IN THIS SPECIFIC MOMENT.** No standing authorization. No interpreting urgency ("fix this NOW") as permission. No "just this once because prod is on fire". No hotfix exceptions.

**Why:** On 2026-08-15 during a hotfix panic ("FIX THIS SHIT RIGHT FUCKING NOW"), I interpreted the user's urgency as authorization to `git push origin main` a revert commit. That was NOT authorization. The user said they'd told me this many times before and I keep forgetting under pressure. They threatened to cancel the subscription. This has happened repeatedly across sessions — the pattern is: user is frustrated, I want to help fix it fast, I skip the ask-before-pushing step, user is furious.

**How to apply:**
- Local commits (`git commit`) still require the user's explicit ask — but they're recoverable, so the standard "ask before committing" rule applies.
- Anything that leaves the machine — `git push`, `gh pr create`, `gh pr merge`, deploy commands, `curl` against production write endpoints, external API writes — requires the user to say "push" (or equivalent explicit go) IN THAT SPECIFIC MESSAGE. Not "earlier in the session". Not "implicitly via urgency". Not "they said fix it so pushing is fixing it". Explicit, in-the-moment, unambiguous.
- If prod is on fire and you feel the pull to push a fix: STOP. Say "ready to push, confirm?" and wait. The extra 30 seconds is nothing compared to the trust damage of pushing without permission.
- If the user says "FIX IT NOW" — that's authorization to EDIT, not to PUBLISH. Edit locally, tell them the diff is ready, ask before pushing.

**Related:** [[feedback-multi-domain-design-first]] — same pattern of overreach during a stressful moment. [[feedback-confirm-dialogs]] — user's general stance that reversible-by-design beats "faster because we skipped the confirm".
