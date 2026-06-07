# Date Handling — the canonical reference

**Read this BEFORE writing any date code.**

The business operates in **Eastern Time (America/New_York)**. The Vercel
servers run in **UTC**. Browsers run in **the user's local timezone**, which
may or may not be ET. Every date-related bug in this codebase has been the
result of mixing those three frames.

This document is the single source of truth. The helper files
[`apps/api/src/lib/dates.ts`](../apps/api/src/lib/dates.ts) and
[`apps/web/src/lib/lib.ts`](../apps/web/src/lib/lib.ts) implement the rules
described here; their file headers mirror this guide.

---

## TL;DR — the rules

1. **All calendar days are in ET.** A "day" is "the day the operator (or
   worker, or client) in NC saw on their wall clock." Never UTC. Never
   server-local. Never browser-local.

2. **All instants are stored as UTC** (Prisma `DateTime`, ISO strings on
   the wire). They are only converted to a calendar day at the moment of
   display or comparison, and that conversion always goes through a
   canonical helper.

3. **Never invent date math at a callsite.** Every date manipulation must
   either use a canonical helper or be a tiny, justified pass-through
   (e.g. an `<input type="datetime-local">` value, which the HTML spec
   requires in browser-local time).

4. **If a new helper would be useful, add it to the canonical file.**
   Don't write a local one in the component. That's how we've ended up
   with 15 slightly-different `fmtDate()` functions over the project's
   history, each with its own bugs.

---

## The two canonical helper files

| Layer | File | What it exports |
|---|---|---|
| API (server) | [`apps/api/src/lib/dates.ts`](../apps/api/src/lib/dates.ts) | `etMidnight`, `etEndOfDay`, `etToday`, `etTomorrow`, `etFormatDate`, `etFormatDateOpts`, `etFormatTimeOpts`, `etIcalLocalDateTime`, `etHourMinute`, `etAddDays`, `etMondayOnOrBefore`, `etSundayOnOrBefore`, `etStartOfMonth`, `etStartOfYear`, `parseUserDate` |
| Web (browser) | [`apps/web/src/lib/lib.ts`](../apps/web/src/lib/lib.ts) | `bizDateKey`, `bizToday`, `bizTomorrow`, `bizYesterday`, `bizAddDays`, `bizAddMonths`, `bizAddYears`, `bizYearOf`, `bizMondayOnOrBefore`, `bizStartOfMonth`, `bizStartOfYear`, `bizHour`, `bizMonth`, `bizInstantFromEtParts`, `fmtDate`, `fmtDateTime`, `fmtDateWeekday`, `fmtDateOpts`, `fmtTimeOpts` |

Two files for two reasons:
- The web can't import server code directly (different bundle).
- The shape of the API is slightly different — the server hands out instants
  for storage; the web hands out display strings for the user's screen.

The naming differs by prefix (`et*` server-side, `biz*` / `fmt*` client-side)
but the semantics line up exactly.

---

## Decision tables

### API (server) — `apps/api/src/`

| I want to… | Use… |
|---|---|
| Get today / tomorrow as YYYY-MM-DD | `etToday()` / `etTomorrow()` |
| Format any Date as YYYY-MM-DD in ET | `etFormatDate(d)` |
| Format any Date with custom options ("MMM D, YYYY") | `etFormatDateOpts(d, opts)` |
| Format time only ("9:30 AM") | `etFormatTimeOpts(d, opts)` |
| Format an iCal `TZID=America/New_York` datetime | `etIcalLocalDateTime(d)` (specialized for iCal feed) |
| Get the ET hour:minute as "HH:MM" | `etHourMinute(d)` (for "is this at default 9 AM" checks) |
| Construct a Date at ET midnight | `etMidnight("YYYY-MM-DD")` |
| Construct a Date at ET 23:59:59.999 | `etEndOfDay("YYYY-MM-DD")` |
| Parse a YYYY-MM-DD or full ISO string | `parseUserDate(str)` |
| Add N days to a YYYY-MM-DD string | `etAddDays(str, n)` |
| This week's Monday / Sunday | `etMondayOnOrBefore()` / `etSundayOnOrBefore()` |
| First of month / year | `etStartOfMonth()` / `etStartOfYear()` |

### Web (browser) — `apps/web/`

| I want to… | Use… |
|---|---|
| Today's YYYY-MM-DD (input value, URL param, localStorage key, comparison) | `bizToday()` |
| Tomorrow / yesterday | `bizTomorrow()` / `bizYesterday()` |
| Format a Date or ISO string for display ("6/6/2026") | `fmtDate(d)` |
| Format with time ("6/6/2026, 9:30 AM") | `fmtDateTime(d)` |
| Format with weekday ("Mon, Jun 6") | `fmtDateWeekday(d)` |
| Custom display format (any `Intl.DateTimeFormatOptions`) | `fmtDateOpts(d, options)` |
| Time-of-day only | `fmtTimeOpts(d, options)` |
| Current ET hour (0–23) for time-of-day-aware UI | `bizHour()` |
| Current ET month (1–12) for season/quarter logic | `bizMonth()` |
| YYYY-MM-DD from a Date/ISO string | `bizDateKey(d)` |
| Add N days to a YYYY-MM-DD string | `bizAddDays(key, n)` |
| Add N calendar months / years to a YYYY-MM-DD string | `bizAddMonths(key, n)` / `bizAddYears(key, n)` |
| Extract the year from a YYYY-MM-DD string (pure string math) | `bizYearOf(key)` |
| This week's Monday / first of month or year | `bizMondayOnOrBefore()` / `bizStartOfMonth()` / `bizStartOfYear()` |
| Build a UTC instant from "ET date + ET wall-clock time" (e.g. operator picks "9 AM on June 6 ET") | `bizInstantFromEtParts(dateKey, time)` |

---

## Forbidden patterns

Each row below is something we've been bitten by. If you find yourself
about to write one of these, use the canonical helper from the decision
table instead.

| ❌ Forbidden | Why it's wrong | ✅ Use instead |
|---|---|---|
| `d.toISOString().slice(0, 10)` | UTC. Wrong calendar day near midnight ET. | API: `etFormatDate(d)`. Web: `bizDateKey(d)`. |
| `d.toLocaleDateString(undefined, ...)` | Browser/server locale. On Vercel that's UTC. | API: `Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", ... })`. Web: `fmtDate(d)` / `fmtDateOpts(d, opts)`. |
| `d.toLocaleString(...)` / `d.toLocaleTimeString(...)` | Same. | Same. (`fmtDateTime(d)` / `fmtTimeOpts(d, opts)` on web.) |
| `d.getFullYear()` / `d.getMonth()` / `d.getDate()` chains for YYYY-MM-DD | Browser/server local time. | API: `etFormatDate(d)`. Web: `bizDateKey(d)`. **Exception**: building a value for `<input type="datetime-local">` REQUIRES browser-local time per the HTML spec. |
| `d.getHours()` for "is it morning?" | Same. | Web: `bizHour()`. |
| `d.getMonth()` for season/quarter | Same. | Web: `bizMonth()`. |
| `d.setHours(0,0,0,0)` / `d.setUTCHours(0,0,0,0)` | Wrong timezone for midnight. | API: `etMidnight(etToday())`. |
| `new Date(YYYY, MM, DD)` | Server-local midnight. | API: `etMidnight("YYYY-MM-DD")`. |
| `new Date("YYYY-MM-DD")` for ET-anchored data | Parses as UTC midnight. | API: `etMidnight(str)` / `parseUserDate(str)`. |
| `.setDate(getDate() + n)` / `.setMonth(getMonth() + n)` for fixed-duration windows | Server-local. `setMonth` also has [crazy overflow behavior](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date/setMonth) (March 31 → February 31 → March 3). | API: `etAddDays(str, n)` on string keys. Web: `bizAddDays(key, n)`. |
| `new Intl.DateTimeFormat(...)` inline at a callsite | Easy to typo. Easy to forget the `timeZone` parameter. | Add a helper to the canonical file. |
| `new Date(d.getTime() + 86_400_000)` for "tomorrow" | Breaks on DST boundaries (most days have 86_400_000 ms, two have 86_400_000 ± 3_600_000). | API: `etAddDays(str, 1)` + `etMidnight`. Web: `bizTomorrow()` or `bizAddDays`. |
| `new Date(dateKey + "T09:00")` / `.toISOString()` for "9 AM on date X" | The `T09:00` is interpreted in the browser's local timezone. A user in PST creating a job for "9 AM" results in a stored instant of 9 AM PST = 12 PM ET. | Web: `bizInstantFromEtParts(dateKey, "09:00")`. |
| A local `fmtDate()` / `dateKey()` / `pad()` helper inside a component | That's how we end up with 15 slightly-different formatters, each with their own bugs. | Add it to the canonical file with a clear name. Use it from there. |

---

## Legitimate exceptions

These are the cases where browser-local or UTC formatting is actually
correct. They're rare. Document the reason at the callsite.

### `<input type="datetime-local">` value

The HTML spec requires this input's `value` to be a string in the form
`YYYY-MM-DDThh:mm` in **the user's local timezone**. You MUST use
`.getFullYear()` / `.getMonth()` / `.getDate()` / `.getHours()` /
`.getMinutes()` to build it. See `OccurrenceDialog.toDateTimeLocal()`
and the matching helpers in `JobsTab.tsx` / `CompleteJobDialog.tsx` —
all clearly named `toDateTimeLocal` to signal the intentional choice.

### iCalendar UTC instants (`LAST-MODIFIED:`)

RFC 5545 requires `LAST-MODIFIED:` to be a UTC instant (`YYYYMMDDTHHMMSSZ`).
Use `.toISOString()` directly. See `apps/api/src/routes/public.ts:fmtDtUtc`.

For `DTSTART:` / `DTEND:` on timed events, prefer the ET-anchored
`fmtDtLocalEt` paired with `TZID=America/New_York` + a VTIMEZONE block.

### Recurrence scheduling that preserves an instant, not a wall-clock time

If a job is scheduled at `2026-03-07 09:00 ET` (= `13:00 UTC`) and we
schedule the next occurrence one week later, mutating with `.setDate(+7)`
on the UTC instant gives `2026-03-14 13:00 UTC` = `09:00 EDT` (one hour
later in wall-clock terms across the DST boundary). For the lawn-care
app this is acceptable because jobs are day-anchored, not hour-precise.
If you ever need DST-precise wall-clock-preserving recurrence, build a
helper that converts to ET, adds days as a string, then converts back.
**Do not invent the math at the callsite.**

---

## How this rule is enforced — automated build gate

The forbidden patterns above are **mechanically enforced** by a test in
[`apps/api/src/services/date-handling-build-gate.test.ts`](../apps/api/src/services/date-handling-build-gate.test.ts).
That test:

- Walks every `.ts` / `.tsx` file in `apps/api/src/`, `apps/web/src/`,
  and `apps/web/pages/`.
- Greps each non-comment line against ~10 forbidden-pattern regexes
  (`.toISOString().slice(0, 10)`, `.toLocaleDateString(undefined`,
  inline `new Intl.DateTimeFormat`, `setDate(getDate()...)`,
  `86_400_000`, etc.).
- Fails the test if any match is found in a file not on the per-pattern
  allow-list.
- Runs as part of the API `test:build-gate` npm script — i.e. **every
  API build, every CI run, every `turbo build`**.

A failing test prints the file:line, the offending snippet, the rule
that caught it, and the canonical helper to migrate to. The diff can't
merge until either the callsite is migrated or the suppression marker
is added (see below).

### Per-line suppression — `date-handling-allow:`

When a pattern is genuinely legitimate (elapsed-time math, recurrence
schedulers, etc.) and the linter catches it as a false positive, add a
`date-handling-allow: <reason>` comment marker on the line or anywhere
in the immediately-preceding comment block:

```ts
// date-handling-allow: elapsed-time — "X days ago" cosmetic label,
// ≤1-hour DST drift is irrelevant for human-readable bucket counts.
const daysSince = Math.floor((Date.now() - then) / 86_400_000);
```

Use sparingly. Every suppression is a documented design choice. If you
find yourself adding more than ~2 per PR, the rule itself probably
needs tightening or the helper file needs a new export.

### Extending — when a new bug pattern is found

1. Fix the existing site(s) to use a canonical helper.
2. Add a new entry to `FORBIDDEN_PATTERNS` in
   [`date-handling-build-gate.test.ts`](../apps/api/src/services/date-handling-build-gate.test.ts).
3. Document the rule + the canonical replacement in the "Forbidden
   patterns" table above.

The build gate will then catch any future reintroduction.

## Manual verification (still required for runtime-only bugs)

The build gate catches syntactic patterns. It does NOT detect runtime
bugs where the pattern looks fine but the data feeding it is mis-shaped
(wrong field, wrong timezone in the source data, etc.). Smoke-test
manually for these:

- **Run the export flow late in the evening** (after ~8 PM ET, when the
  UTC date has rolled forward but ET hasn't). Confirm the CSV's Pay
  Period End matches the date the operator picked.
- **Run reports that use date filters** near midnight ET. Same check.
- **Use the iCal feed in a non-ET calendar app**. Confirm events show at
  the right ET wall-clock time, not at the UTC equivalent.
- **Open a job-edit dialog from a non-ET timezone**. Confirm the
  datetime-local input shows the ET wall-clock time (not the
  browser-local time) and that submitting unchanged doesn't re-write
  the timestamp.

---

## When you change a date helper

The helpers in `apps/api/src/lib/dates.ts` and `apps/web/src/lib/lib.ts`
are public-API-shaped: many files depend on them. Before changing the
behavior of a helper:

1. Search the codebase for every caller. Confirm the new behavior is
   correct at each one.
2. Update this document.
3. Update the file headers in both `dates.ts` and `lib.ts` if the
   decision tables or forbidden-patterns lists need amending.
4. Re-run the build gate + a manual smoke test of one export + one P&L
   report run.

---

## When you find a date bug in production

1. **Don't patch the callsite in isolation.** Search for every other
   instance of the same pattern with `grep` (the forbidden-patterns
   table is your starting point).
2. **Add a regression test** if the math is testable at the unit level
   (most date bugs are not — they're timezone bugs that only show up
   at runtime with the wrong server config).
3. **Update this document** if the bug reveals a pattern that should
   be added to the forbidden list.
