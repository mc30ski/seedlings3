---
name: feedback-fmtdate-eats-date-keys
description: "Historical fmtDate() date-key off-by-one bug — FIXED at the runtime layer. Every web date formatter auto-routes YYYY-MM-DD strings through a UTC-noon anchor so the calendar day never rolls. Build gate now catches 15+ shipped date anti-patterns mechanically."
metadata:
  node_type: memory
  type: feedback
  originSessionId: d1686705-f7d7-47c4-8f20-2cd1389e185a
  modified: 2026-08-21T19:20:52.926Z
---

## The bug (historical — now fixed at the runtime layer)

`fmtDate("2026-08-12")` used to return `"8/11/2026"` — off by one, EARLIER — because:

1. JS spec parses date-only ISO strings (`"YYYY-MM-DD"`) as UTC midnight → `2026-08-12T00:00:00.000Z`.
2. The formatter ran `.toLocaleDateString("en-US", { timeZone: "America/New_York" })`.
3. UTC midnight in ET is 8pm the PREVIOUS day (EDT UTC-4) / 7pm previous (EST UTC-5).
4. Display rolled back to `"8/11/2026"`.

## The fix (Phase 1, runtime auto-route)

Every web-side date formatter (`fmtDate`, `fmtDateKey`, `fmtDateTime`, `fmtDateWeekday`, `fmtDateOpts`, `fmtTimeOpts`, `prettyDate`, plus new `fmtDateShort` and `fmtDateLong`) now routes through a shared `toDisplayInstant` helper that:

- Detects the `YYYY-MM-DD` shape and anchors it at UTC noon (calendar day never rolls under any timezone offset).
- Passes Dates and full ISO datetime strings through unchanged.
- Rejects nonsense keys (`"2026-13-45"`, `"2026-02-30"`) after month/day range check + round-trip verify → renders `"—"`.

Any caller that passes any of the three shapes gets the correct display. No coordination required.

## Related shipped fixes (session `d1686705`)

The audit that spawned this fix found and closed 8 HIGH + 9 MED bugs. Notable classes:
- Bare `.toLocaleDateString()` / `.toLocaleTimeString()` (no args) — used browser/server locale, wrong for non-ET viewers. Fixed 7+ sites; build-gate rule #15 catches future ones.
- Template-string `new Date(\`${date}T${time}:00\`)` browser-local parse — fixed in VehiclesTab; build-gate rule #11 now catches template variants.
- Reschedule paths hard-coding `T09:00:00Z` (5 AM ET) — dropped source's ET wall-clock time. Fixed in JobsTab + PreviewRoutesTab via new `bizHourMinute` helper that extracts the source's ET time-of-day.
- Hard-coded `T04:00:00Z` in policyPredicate.ts — broken across DST. Now uses `etMidnight(dueKey)` (auto-DST).
- Spelled-out `24 * 3600 * 1000` day-in-ms — bypassed build gate. Rule #10b now catches the variant.

## Enforcement — build gate rules

`apps/api/src/services/date-handling-build-gate.test.ts` FORBIDDEN_PATTERNS. Currently 15 rules; every one caught a real shipped bug. Additions from this session:
- Rule #10b extended: `24 * 3600 * 1000` variant.
- Rule #11 extended: template-string `T${var}` form.
- Rule #15 new: bare `.toLocaleDateString()` / `.toLocaleTimeString()`.

Retired: earlier `fmtDate(*Key)` rule — no longer a bug now that formatters auto-route.

## Style guideline (not enforced, but preferred)

At NEW callsites, use the most specific helper for readability:
- `fmtDateKey(k)` when `k` is definitely a YYYY-MM-DD calendar key.
- `fmtDate(x)` when `x` may be either shape or you don't want to think about it.
- `fmtDateShort(x)` for "Aug 12", `fmtDateLong(x)` for "Aug 12, 2026" — instead of defining a local wrapper.

Do NOT define local `fmtDate` / `fmtDateTime` in a file — shadows the canonical helper and broadens future blast radius. If you need a specialized format that isn't in the exported set, name it distinctively (`fmtInvoiceDate`, `fmtDateWithWeekdayShort`, etc.) so it doesn't shadow the canonical name.

## Phase 2 (SHIPPED)

Branded types `EtDateKey` and `IsoInstant` shipped 2026-08-01 — miscalls become compile errors, not just runtime-safe. Details in [[feedback-date-branded-types]]. The `docs/PHASE_2_BRANDED_DATE_TYPES.md` proposal was executed.

**Sibling:** [[date-handling-reference]] — the canonical date-handling policy doc. [[feedback-date-branded-types]] — the Phase 2 compile-time-typing follow-up. [[feedback-run-build-gate-after-changes]] — the enforcement that catches new violations.
