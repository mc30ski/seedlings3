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
**mandatory reason code** from the `STREAM_PAUSE_REASONS` Setting (a JSON
taxonomy, per [[feedback_config_driven_taxonomies]]), optional free-text note,
and a reminder date pre-filled from the reason's `defaultReminderDays`. Every
pause writes a `JobOccurrencePauseEvent` with the label **snapshotted**, so
renaming a reason never rewrites history; resume closes the row rather than
deleting it.

**Why:** the operator needs to find held work again by reason next spring. Free
text alone can't be filtered or counted, and the one pre-taxonomy pause in
production sat silent for three months because it had no reminder.

**How to apply:** Services and Work→Jobs must use the SAME components —
`apps/web/src/ui/components/StreamPauseControls.tsx` holds the button cluster,
the three-mode dialog, the writes and the reason filter; neither tab may wire
`StreamPauseDialog` itself. Gated in `job-materials-build-gate.test.ts`. Three
things share the spelling "paused" across two enums — `JobOccurrenceStatus.PAUSED`
is the worker's timer mid-visit, `STREAM_PAUSED` is the stream on hold — so never
find-and-replace on it. See also [[reference_tab_blend_pattern]] and
[[feedback_confirm_dialogs]].
