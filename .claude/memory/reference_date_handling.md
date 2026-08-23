---
name: date-handling-reference
description: Canonical reference for all date handling in the app — ET-anchored helpers in apps/api/src/lib/dates.ts (server) and apps/web/src/lib/dates.ts (browser); forbidden patterns + full decision tables documented in docs/DATE_HANDLING.md.
metadata: 
  node_type: memory
  type: reference
  originSessionId: d1686705-f7d7-47c4-8f20-2cd1389e185a
  modified: 2026-08-21T19:24:16.364Z
---

`docs/DATE_HANDLING.md` is the canonical reference for all date handling
in this codebase. Read it before writing any date code or reviewing any
date-related diff.

**Canonical helper files** — every date manipulation in the codebase MUST
route through one of these (no inline `.toISOString().slice(0,10)`, no
`.toLocaleDateString()`, no `.setDate(getDate()+n)`, etc.):

- API side: `apps/api/src/lib/dates.ts` — `etMidnight`, `etEndOfDay`,
  `etToday`, `etTomorrow`, `etFormatDate`, `etAddDays`,
  `etMondayOnOrBefore`, `etSundayOnOrBefore`, `etStartOfMonth`,
  `etStartOfYear`, `parseUserDate`. File header has the strict
  forbidden-pattern list + decision table.

- Web side: `apps/web/src/lib/dates.ts` — `bizDateKey`, `bizToday`,
  `bizTomorrow`, `bizYesterday`, `bizAddDays`, `bizMondayOnOrBefore`,
  `bizStartOfMonth`, `bizStartOfYear`, `bizHour`, `bizMonth`,
  `bizInstantFromEtParts`, `fmtDate`, `fmtDateTime`, `fmtDateWeekday`,
  `fmtDateOpts`, `fmtTimeOpts`. File header has the same strict
  policy.

**Why this matters**: the business is in Eastern Time (NC). Vercel runs
in UTC. Browsers run in whatever the user is in. Most date bugs in this
project's history are from mixing those frames. Every helper above is
explicitly ET-anchored.

**Mechanical enforcement** — three layers, all wired through `apps/api/`'s
`test:build-gate` script (which runs on every API build via
`turbo.json` `build.dependsOn test`):

1. **Pattern scan**: `apps/api/src/services/date-handling-build-gate.test.ts`
   greps every `.ts`/`.tsx` file under `apps/api/src`, `apps/api/prisma`,
   `apps/web/src`, and `apps/web/pages` against ~18 forbidden-pattern regexes
   (`.toISOString().slice(0,10)`, `.toLocaleDateString(undefined`,
   inline `new Intl.DateTimeFormat`, `.setDate(getDate()+N)`,
   `86_400_000`, spelled-out millisecond chains like
   `1000 * 60 * 60 * 24`, `.toDateString()`, `.toTimeString()`,
   `.getTimezoneOffset()`, hardcoded ET offsets `4 * 3600000`,
   `useMemo([])` caching `bizToday`/`bizTomorrow`/`bizYesterday`, UTC
   slicing variants `.substring(0,10)`/`.split("T")[0]`/`.toJSON()`,
   etc.). Fails CI on any violation. Per-line suppression via
   `// date-handling-allow: <reason>` for documented exceptions.

2. **Helper unit tests**: `apps/api/src/lib/dates.test.ts` and
   `apps/api/src/lib/web-date-helpers.test.ts` lock in:
   - DST spring-forward + fall-back (both `etMidnight` and `bizInstantFromEtParts`)
   - Leap years (Feb 29 → next year clamped)
   - Month overflow (Jan 31 + 1 month → Feb 28/29, NOT Mar 3)
   - Year boundaries (Dec 31 + 1 day → Jan 1)
   - Invalid-input handling (every string helper returns `""` / `NaN` for
     malformed input; display helpers return `"—"` rather than
     `"Invalid Date"`)
   - Non-existent spring-forward gap times (`bizInstantFromEtParts("2026-03-08", "02:30")`)
   - Ambiguous fall-back times (`bizInstantFromEtParts("2026-11-01", "01:30")`)
   - The `etMidnight + etEndOfDay` range invariant (end > start, even
     on short DST days)
   The web tests cross-import via the `@web-lib` alias declared in
   `apps/api/vitest.config.ts`.

3. **Project CLAUDE.md** (`./CLAUDE.md`): tells future Claude Code
   sessions to route every date manipulation through a helper, run
   the build gate after edits, and never disable the test.

Don't disable or bypass any of these — fix the callsite or add a
documented allow-comment. If you find a forbidden pattern the gate
doesn't catch, ADD it to `FORBIDDEN_PATTERNS` so the next reintroduction
is caught.

**Important pattern lesson**: every time the user asks me to sweep for
date bugs, more surface. This includes bugs in my OWN recent "fixes" —
the round-trip verifier for `bizInstantFromEtParts` was needed because
my first fix to `etMidnight` (probe at 1 AM UTC) didn't transfer to
`bizInstantFromEtParts`, leaving a 1-hour drift for early-morning
times on DST days. When fixing one helper, audit ALL related helpers
for the same class of bug.

**Pattern lesson on invalid-input propagation**: every string helper
must return a sentinel (`""` for strings, `NaN` for numbers, Invalid
Date for Dates) on malformed input, NOT throw or produce garbage. The
sentinels propagate cleanly through downstream calls so a single
invalid value upstream surfaces as a single visible "—" downstream
rather than crashing the page.

**Pattern lesson on stale memoization**: `useMemo(() => <date-fn>(), [])`
caches the value indefinitely. If the function returns a time-dependent
value (today's date, "last month" preset, etc.), the cache is stale the
moment the process crosses midnight ET. The gate now catches the
direct calls AND wrapper functions (`bizAddYears(bizToday(), -1)`,
`computeDatesFromPreset("lastMonth")`, etc.). Same for module-level
`const X = bizToday()` — captured at module load and never refreshed.
Fix: compute inline (these helpers run in µs), or document with
`// date-handling-allow: fixed-constant` if intentionally static.

**When you see (or write) a date bug**, the fix is almost always to
route through one of the helpers above. If the need doesn't fit an
existing helper, ADD a new helper to the canonical file (with a clear
name + doc comment) rather than reinventing the math at the callsite.
After adding a new helper, also add a forbidden-pattern rule to the
build-gate test so future code routes through it.

**Legitimate exceptions** to "use the helper":
- `<input type="datetime-local">` values MUST be browser-local (HTML
  spec). See `OccurrenceDialog.toDateTimeLocal` etc. — they're named
  with `Local` to signal the intentional choice.
- iCalendar `LAST-MODIFIED:` MUST be a UTC instant (RFC 5545).
  See `public.ts:fmtDtUtc`.
- Recurrence-scheduler `.setDate(+7)` / `.setMonth(+1)` on an existing
  Date instant is acceptable when "preserve the instant, not the wall
  clock" is the right semantics — DST drift is ≤1 hour and our jobs
  are day-anchored.

Document is at `docs/DATE_HANDLING.md`. Update it whenever the helpers
change or a new pattern needs to be added to the forbidden list.

Related: [[feedback-fmtdate-eats-date-keys]] (Phase 1 runtime auto-router), [[feedback-date-branded-types]] (Phase 2 compile-time brands), [[feedback-run-build-gate-after-changes]] (running the enforcement gate after edits).
