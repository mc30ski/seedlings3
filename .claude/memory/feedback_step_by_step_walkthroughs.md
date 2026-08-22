---
name: feedback-step-by-step-walkthroughs
description: "When walking user through a UI or procedure, give one step at a time and wait — never dump the full sequence as a wall of text."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: d1686705-f7d7-47c4-8f20-2cd1389e185a
---

When the user asks me to "walk them through" a UI, procedure, or setup:
give **one step**, then stop and wait for them to complete it or confirm.
Do NOT drop a numbered list of every step, tables of fields, code blocks
of everything to paste, etc.

**Why:** User explicitly called this out — "I don't want a novel of things
to do." A wall of steps is worse than useless: they don't read it, they
lose track, and I've failed the ask (which was for guidance, not
documentation).

**How to apply:**
- A small batch per turn — one screen / one dialog / one logical unit
  of work (e.g., "fill these 3 fields and click Create"). Not per-field
  micro-steps ("treated like a baby") and not the full sequence upfront.
- Wait for their "done" / next question / screenshot before advancing.
- If a step needs a chunk of content pasted (like a markdown body), that's
  fine — but only surface it in the step where it's needed, not upfront.
- Applies to: UI walkthroughs, install/setup procedures, migration
  playbooks, anything sequenced.
- Does NOT apply to: research summaries, code review findings, or answers
  to "list everything you found" — those still get one full response.
