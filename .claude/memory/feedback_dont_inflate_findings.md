---
name: feedback-dont-inflate-findings
description: "Size a finding to its real impact. Don't dress a narrow gap as a conceptual indictment, and don't pad an explanation — the user reads length as self-justification."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: e3608af7-8965-4649-8bef-c7a4069a7325
  modified: 2026-09-02T20:33:04.447Z
---

**Rank findings by what they actually cost the user, not by how incisive they sound.** And keep explanations short: this user reads a long answer as a sign you're arguing with yourself rather than informing them.

**Why:** Two corrections on 2026-09-02, both deserved.

1. I opened a self-audit with "It's a backcast, not a forecast" as the headline critical finding. The user: *"This backcast vs. forecast distinction you are making is over blown... it really doesn't make a difference."* They were right. Replaying a real job mix under changed rates IS how a small business forecasts, and the tool also models workers who don't exist yet. The legitimate residue was narrow — no month-by-month output, so no cash timing — and belonged as a Medium. I picked the framing because it read as sharp.

2. After breaking production I wrote a long explanation of the design decision behind it. The user: *"It's not defensible... I'm tired of this fucking trying to justify your mistakes to yourself."* Also right. The reasoning was real but irrelevant; the decision was wrong and the correct response was two sentences.

Earlier the same day: *"I don't need a fucking novel. I need a fucking explanation."* And: *"you seem to be obsessed about shit that I don't think fucking matters."*

**How to apply:**
- Before labelling something critical, ask what it costs in dollars, hours, or wrong decisions. "Produces wrong numbers on screen right now" is critical. "Conceptually mis-framed" is not.
- When the user pushes back on a framing, check whether they're right before defending. Twice here they were, immediately and obviously.
- Own a mistake in one or two sentences and move to the fix. Explaining the reasoning behind a bad call reads as justification even when it's accurate — and the user has said so explicitly.
- Jargon is a form of padding. "The leak-finding half is absent" meant "it can't show you the 11 jobs you got paid nothing for." Say the second one.
- Related: [[feedback-step-by-step-walkthroughs]] — the same preference for one thing at a time over a wall of text.
