---
name: project_pause_redesign
description: Job-service pause REMOVED (it was archive under another name); pausing work is a reason-coded pause on the repeating occurrence. Dialog is THREE modes since 2026-11-10 (the two bulk modes went with Repeating's multi-select).
metadata:
  node_type: memory
  type: project
  originSessionId: e3608af7-8965-4649-8bef-c7a4069a7325
  modified: 2026-11-10T19:00:00.000Z
---

2026-09-28. Job-level pause is gone. `JobStatus.PAUSED` was dropped from the
Prisma enum and from the web `JOB_STATUS` union — pausing a job service ran the
same delete-scheduled-visits + rebuild-chain helpers as archiving, so it was
Archive wearing a gentler label. Archive is how a service ends; **Unarchive** is
the way back (returns it to ACCEPTED and regenerates the next visit — exactly
what unpause used to do).

Holding work is now only `JobOccurrence.status = STREAM_PAUSED`, with a
**mandatory reason code** from the `REPEATING_JOB_OCCURRENCE_PAUSE_REASONS`
Setting (a JSON taxonomy, per [[feedback_config_driven_taxonomies]]; the key
was `STREAM_PAUSE_REASONS` — it doubles as the Settings card title, and
"stream" is our word, not the operator's), optional free-text note,
and a reminder date pre-filled from the reason's `defaultReminderDays`. Every
pause writes a `JobOccurrencePauseEvent` with the label **snapshotted**, so
renaming a reason never rewrites history; resume closes the row rather than
deleting it.

**Why:** the operator needs to find held work again by reason next spring. Free
text alone can't be filtered or counted, and the one pre-taxonomy pause in
production sat silent for three months because it had no reminder.

**How to apply:** THREE tabs now show these rows — Services, Work→Jobs and
Work→Repeating ([[project_repeating_tab]], 2026-11-09) — and all three must
use the SAME components. `apps/web/src/ui/components/StreamPauseControls.tsx`
holds the button cluster, the **three-mode** dialog (pause / update /
resume), the controller, the writes and the reason filter; no tab may wire
`StreamPauseDialog` itself, and each names the controller `streamControls`.
Gated in `job-materials-build-gate.test.ts` + `repeating-build-gate.test.ts`.

> **2026-11-10:** the dialog's `pause-many` / `resume-many` modes and
> `useStreamPauseSelection` were REMOVED with Work → Repeating's
> multi-select — the book is one screenful. Gone in all five layers and
> gated so; see [[project_repeating_tab]].

Three things share the spelling "paused" across two enums —
`JobOccurrenceStatus.PAUSED` is the worker's timer mid-visit (**rendered
"Timer paused"**), `STREAM_PAUSED` is the repeating stopped (**rendered
"Paused repeating"**, never bare "Paused", and never "Held") — so never
find-and-replace on it. See [[feedback_names_carry_meaning]]. See also [[reference_tab_blend_pattern]] and
[[feedback_confirm_dialogs]].

## Vocabulary settled 2026-11-09

The operator-facing name is **"repeating job occurrence"**, everywhere in the
staff app: the shared dialog, Services, Work→Jobs, Repeating, Clients, Crews,
Settings and the Tasks card. It had been a mix of "repeating service" (wrong —
one service carries several, and each is held separately) and "repeating
visit" (accurate but a second word for one thing).

**It stops at the customer portal.** `routes/client.ts` still tells a customer
"Only recurring visits can be skipped", and should — "job occurrence" is the
vocabulary of the people running the business, not of the homeowner reading
it. Recorded in `docs/features/repeating.md`.

One phrase deliberately untouched: Services' "The recurring services
themselves — the job behind the visits" genuinely means the Job there.

## Two more invented words, settled 2026-11-10

The 2026-11-09 pass fixed the NOUN. The operator then found two more on
Work → Repeating, both by asking "what is this?":

- **"Held" → "Paused repeating".** Used nowhere else in the product, while
  the button on the same row said *Pause repeating*. Action and state were
  two words for one thing.
- **"due a check-back" → "to review".** The header alert and the Tasks
  section that LINK to this screen both already said *"Paused repeating to
  review"*.

Two words survive in their right places: the **date** is a *"Reminder date"*
(the dialog's own field label), the **work item** its arrival creates is a
*review*.

Gated: a scan of every operator-facing string in the tab and its service for
both retired words. See [[feedback_names_carry_meaning]] for the pattern —
grep the rest of the product for the concept before naming it.
