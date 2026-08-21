---
name: feedback-exports-default-range
description: "For any window-based Super Money export/reconcile surface, default to THIS calendar week's Mon-Sun (the week containing today). NOT last completed week, NOT rolling today-7."
metadata:
  node_type: memory
  type: feedback
  originSessionId: d1686705-f7d7-47c4-8f20-2cd1389e185a
  modified: 2026-08-21T19:20:36.264Z
---

**Historical note (2026-08-21):** the original `ExportsTab.tsx` was
replaced by `ReconcileTab.tsx` (see [[project-tab-refactor-2026-08-21]] and
the "Reconcile" comment block in `apps/web/pages/index.tsx` — Reconcile
subsumes the old Exports + P&L Report tabs). The date-range default
preference below still applies to any Super window-based
export/reconcile surface.

Any date range on a Super Money export/reconcile surface MUST default to **this week's Monday → Sunday** — the calendar week containing today.

- Start = most recent Monday on or before today (`mondayOnOrBefore(today)`)
- End = Sunday 6 days after that Monday

Examples:
- Today is Saturday 6/6 → default range is Mon 6/1 – Sun 6/7 (Sunday is tomorrow, that's fine)
- Today is Sunday 6/7 → default range is Mon 6/1 – Sun 6/7 (ends today)
- Today is Monday 6/8 → default range is Mon 6/8 – Sun 6/14 (new week starts today; operator clicks "Last weekly" preset for the just-ended week if they want it)

**Why:** The user's standard workflow is to open the Exports tab DURING the week (often Saturday or Sunday) to pull what's happened so far in the current calendar week. Opening on Saturday and seeing "last week" pre-selected was wrong and frustrating.

**How to apply:**
- Use `mondayOnOrBefore(new Date())` directly — NO `addDays(..., -7)` offset.
- The cadence-loading useEffect must NOT overwrite the date range. It can only call `setCadence(v)`.

**History (don't undo this):**
- Iteration 1 — defaulted to "snap to last weekly" via cadence useEffect. User got mad ("WTF").
- Iteration 2 — defaulted to rolling today-7 → today. User overrode it on the next request.
- Iteration 3 — defaulted to PREVIOUS completed Mon-Sun (today-7 week). User got mad ("absolutely NOT WHAT I ASKED FOR" when today was Sat 6/6 and default was 5/25).
- Iteration 4 (CURRENT) — this week's Mon-Sun. This is what the user actually wants.
