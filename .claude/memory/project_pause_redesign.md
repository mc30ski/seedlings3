---
name: project_pause_redesign
description: Job-service pause REMOVED (it was archive under another name); holding work is a reason-coded pause on the repeating occurrence
metadata:
  node_type: memory
  type: project
  originSessionId: e3608af7-8965-4649-8bef-c7a4069a7325
  modified: 2026-09-28T18:12:43.721Z
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
holds the button cluster, the five-mode dialog (pause / update / resume /
pause-many / resume-many), the single-row and selection controllers, the
writes and the reason filter; no tab may wire `StreamPauseDialog` itself, and
each names the controller `streamControls`. Gated in
`job-materials-build-gate.test.ts` + `repeating-build-gate.test.ts`. Three
things share the spelling "paused" across two enums — `JobOccurrenceStatus.PAUSED`
is the worker's timer mid-visit, `STREAM_PAUSED` is the stream on hold — so never
find-and-replace on it. See also [[reference_tab_blend_pattern]] and
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
