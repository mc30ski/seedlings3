---
name: reference-build-gates-roster
description: "Full roster of the seven build gates wired into `apps/api` test:build-gate, including the three (observer-filter, recurrence-series, promotions) that had no memory or CLAUDE.md coverage. Read before relaxing or deleting any gate assertion."
metadata: 
  node_type: memory
  type: reference
  originSessionId: e3608af7-8965-4649-8bef-c7a4069a7325
  modified: 2026-08-21T19:40:45.515Z
---

# Build-gate roster

`cd apps/api && npm run test:build-gate` runs **15 test files / 416
tests in ~630 ms** (verified 2026-08-21). Seven of those files are
*build gates* — mechanical enforcement of a rule that a real shipped
bug motivated. The rest are ordinary unit suites (`payments.test.ts`,
`exports.test.ts`, `dates.test.ts`, `web-date-helpers.test.ts`,
`receiptNumber.test.ts`, `clientBackup.test.ts`, `promotions.test.ts`,
`promotions-scenarios.test.ts`, `vanityPages.test.ts`).

**Universal rule across every gate: if one fails, the fix is almost
never to relax the assertion.** Legitimate exceptions are a documented
policy change (update the paired doc in the same commit) or a helper
rename (update gate + helper together).

## Documented elsewhere

| Gate | Memory / doc |
|---|---|
| `payments-build-gate.test.ts` | [[feedback-payments-build-gate]], `docs/FINANCIAL_SYSTEM.md` |
| `date-handling-build-gate.test.ts` | [[date-handling-reference]], `docs/DATE_HANDLING.md` |
| `view-as-endpoints-build-gate.test.ts` | [[reference-view-as-endpoints]], `docs/VIEW_AS_ENDPOINTS.md` |
| `policies-build-gate.test.ts` | [[reference-worker-compliance-ui]], `docs/features/compliance.md` |

## The three that had no coverage (documented here)

### `observer-filter-build-gate.test.ts` (1 test)

A **SQL three-valued-logic** gate. Scans `apps/api/src` for:

```
role: { not: "observer" }      // Prisma field-level not
NOT: { role: "observer" }      // Prisma object-level NOT
```

Both compile to `role != 'observer'`, and in Postgres
`NULL != 'observer'` is UNKNOWN — **not** TRUE. So every
`JobOccurrenceAssignee` with `role = NULL` (the ordinary
"regular worker, no special role" case) is silently dropped.

**The shipped bug:** Reconcile → Payroll silently omitted every
worker with a null role.

**The correct form**, used everywhere else in the codebase:

```ts
where: { OR: [{ role: null }, { role: { not: "observer" } }] }
```

The gate looks 4 lines back and 2 forward for a `{ role: null }`
companion. Suppress an intentional NULL-excluding filter with
`// observer-filter-allow: <reason>` on the immediately preceding
line.

### `recurrence-series-build-gate.test.ts` (3 tests)

Text-scans `apps/api/src/routes/admin.ts` to keep the "Due to record"
panel from forking a recurring expense series into phantom siblings.
Three assertions:

1. `POST /admin/business-expenses` references `recurrenceSeriesId` at
   least twice in the handler window (mint + persist). Without it no
   series id is written and the panel falls back to the fragile legacy
   `(type, description, vendor)` key.
2. The same handler reads `sourceExpenseId` **and**
   `source.recurrenceSeriesId` — the Record-flow inheritance path.
   Dropping it mints a new series id on every Record and instantly
   splits the stream.
3. Both `/admin/business-expenses/due-soon` and `…/due-soon/count`
   key their dedup Map by `recurrenceSeriesId` with a `sid::` prefix
   so series-keyed entries can't collide with legacy keys.

**The shipped bug:** the Vercel recurring expense split into duplicate
streams on 2026-07-13.

Because these are coarse token scans against one file, **a refactor
that moves the create route into a service will fail the gate** — that
is intentional (fail loud). Update `FILE_PATH` + tokens to match the
new location; the concept ("inheriting series id must be code-visible
in the create path") stays.

### `promotions-build-gate.test.ts` (66 tests — the largest gate)

Pure invariants over `services/promotions.ts` helpers — no DB, no HTTP.
Guards customer-facing promo dispatch and CAN-SPAM posture. Invariants
run **A through Q** (the file's own header comment only lists A–H and
is itself stale):

- **A, H** — opt-out URL is a static `/opt-out` page with no HMAC token
  and no query string, so nothing leaks when a recipient forwards a
  message. The landing page collects the identifier client-side.
- **B, C** — Zod save-payload schema requires content for every enabled
  channel *and* surface, and rejects trigger-less dispatch or a promo
  with zero channels and zero surfaces.
- **D** — email footer always substitutes `{{businessAddress}}` and
  `{{unsubscribeLink}}`; an empty address becomes an empty string
  rather than shipping a raw `{{…}}` literal in real mail.
- **E** — SMS segment counter matches Twilio billing thresholds
  (160/153 GSM-7, 70/67 UCS-2), including the **silent-inflation
  guards**: an em dash or curly quote forces UCS-2. A regression here
  bills the operator 2–3× per send with no visible symptom.
- **F, G** — `renderSmsPromoBody` assembles body → CTA+URL → footer and
  never emits a naked CTA; `buildContentSnapshot` always returns a
  non-empty body or throws, because `PromotionDelivery.contentSnapshot`
  is the audit record.
- **I, M** — click-token HMAC **flavor isolation**: a delivery-flavor
  token must not verify as promo-flavor or vice versa (cross-replay).
- **J, N, O** — wrapper URLs keep their exact prefixes
  (`/api/public/promotion/click/d/` and `/p/`), while short URLs live
  at bare `/mo/<slug>[/<code>]` with no `/api/public/` prefix.
- **K, P, Q** — slug generator is deterministic, URL-safe, ≤64 chars,
  never empty; short slugs ≤40 chars kebab-only; short codes are
  exactly 4 chars from an unambiguous alphabet (no `0/o/1/l/i`).
- **L** — every `verify*` returns `false` rather than throwing on a
  missing/short secret (500-safety on the public click endpoint), while
  `sign*` still throws so misconfiguration is loud at build time.

## Related

[[feedback-run-build-gate-after-changes]] — run the gate after every
API edit (and after web edits, since the date-handling scan covers
`apps/web` too). [[reference-feature-specs]] — the doc + gate + e2e
triple that new features follow.

## alert-ordering-build-gate (added 2026-08-26)

`apps/api/src/services/alert-ordering-build-gate.test.ts` — 5 tests.

The operator's pending work is listed TWICE: the header alerts dropdown
(`apps/web/pages/index.tsx`) and the Tasks page
(`apps/web/src/ui/pages/TasksPage.tsx`). Separate files, separate
hand-maintained lists. TasksPage carried a comment claiming "Section order
mirrors the alerts dropdown's push order" — it had been false for a long
time: four entries were out of order and "Unlinked client accounts" was a
Tasks section with NO dropdown alert at all.

The gate parses both files and asserts they agree, in both directions,
against each other's REAL source (not just against its own mapping table —
an earlier draft did that and a mutation test showed deleting a dropdown
push left it green).

`ALERT_TO_TASKS` is the canonical order. Labels differ by design ("Overdue"
vs "Overdue jobs"), so the mapping is explicit. `"Payments to review"` is
the only sanctioned one-to-many entry (one dropdown row, two Tasks
sections) and the gate asserts it stays the only one.

**Adding a new alert means adding it to BOTH files and to `ALERT_TO_TASKS`.**
That is the intended friction.
