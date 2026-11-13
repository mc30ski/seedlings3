# Date Handling — the canonical reference

**Read this BEFORE writing any date code.**

The business operates in **Eastern Time (America/New_York)**. The Vercel
servers run in **UTC**. Browsers run in **the user's local timezone**, which
may or may not be ET. Every date-related bug in this codebase has been the
result of mixing those three frames.

This document is the single source of truth. The helper files
[`apps/api/src/lib/dates.ts`](../apps/api/src/lib/dates.ts) and
[`apps/web/src/lib/dates.ts`](../apps/web/src/lib/dates.ts) implement the rules
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
| Web (browser) | [`apps/web/src/lib/dates.ts`](../apps/web/src/lib/dates.ts) | `bizDateKey`, `bizToday`, `bizTomorrow`, `bizYesterday`, `bizAddDays`, `bizAddMonths`, `bizAddYears`, `bizYearOf`, `bizMondayOnOrBefore`, `bizStartOfMonth`, `bizStartOfYear`, `bizHour`, `bizMonth`, `bizInstantFromEtParts`, `fmtDate`, `fmtDateTime`, `fmtDateWeekday`, `fmtDateOpts`, `fmtTimeOpts` |

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
| `new Date("YYYY-MM-DD")` for ET-anchored data | Parses as UTC midnight — **the previous calendar day in ET**. *Shipped 2026-11-10: every resume of a paused repeating job occurrence landed a day early.* | API: `parseUserDate(str)` (or `etMidnight(str)`). **Gate rule 29** now fails the build on `new Date(body.…)`. |
| `.setDate(getDate() + n)` / `.setMonth(getMonth() + n)` for fixed-duration windows | Server-local. `setMonth` also has [crazy overflow behavior](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date/setMonth) (March 31 → February 31 → March 3). | API: `etAddDays(str, n)` on string keys. Web: `bizAddDays(key, n)`. |
| `new Intl.DateTimeFormat(...)` inline at a callsite | Easy to typo. Easy to forget the `timeZone` parameter. | Add a helper to the canonical file. |
| `new Date(d.getTime() + 86_400_000)` for "tomorrow" | Breaks on DST boundaries (most days have 86_400_000 ms, two have 86_400_000 ± 3_600_000). | API: `etAddDays(str, 1)` + `etMidnight`. Web: `bizTomorrow()` or `bizAddDays`. |
| `dateKey + "T09:00:00"` (no zone) for "9 AM on date X" | Interpreted in whatever zone the code runs in. *Shipped: the server is UTC on Vercel, so every task and follow-up landed at **4 AM ET**.* | Web: `bizInstantFromEtParts(dateKey, "09:00")`. API: `etInstantFromParts`. **Gate rule 30.** |
| `dateKey + "T13:00:00Z"` — a hard-coded UTC hour standing in for an ET wall-clock hour | Correct in one half of the year only. *Shipped: 13:00Z is 9 AM EDT but **8 AM EST**, so reminders set in summer fired an hour early all winter.* | Same helpers. **Gate rule 30.** The ONE allowed literal is `T12:00:00Z` — UTC noon is the same calendar day in every US zone, so it is the safe anchor for handing a date key to a formatter. |
| `bizDateKey(x)` where `x` is ALREADY a date key | It reads its argument as an **instant**, so a bare `YYYY-MM-DD` parses as UTC midnight — the previous calendar day in ET. No throw, no empty string; the key simply comes back a day early. *Shipped 2026-11-13: a workday left open on **Wednesday** was announced as "you didn't end your workday on **Tuesday**", and the picker defaulted to 6pm on that Tuesday — before the workday had started — so the dialog's own before-start guard refused every submission.* | Pass the key through; it is already what you want. Where it may be either, `bizDateKeyOf(x)`. **Gate rule 31**, and the stronger guard: `bizDateKey` now REFUSES a branded `EtDateKey` at compile time. |
| A date-key field typed as a plain `string` | The brand is what makes the row above a compile error rather than a regex's problem. An unbranded field opts out of it silently. | Type it `EtDateKey` on **both** sides. `WorkdaySummary.workdayDate` is the worked example; `PayrollPeriod`'s three keys and `StatementRow`'s two followed on 2026-11-13. |
| A date-key field branded on the API and plain `string` in the web copy | The two are separate declarations that never meet, so both compile and the drift is invisible. This is the layer *under* every rule in this document: the helpers, the gate and the brand all sit downstream of a copy that silently stopped matching its source. | `mirror-types-build-gate.test.ts` compares each declared mirror field for field. It found this exact asymmetry the hour it was written. |
| A field NAMED like a date key that holds formatted text | `receipt.ts`'s `serviceDate` is `fmtDate()` output — `"11/13/2026"`, or `"—"`. `statement.ts`'s identically-named field IS a key. Branding by name would be a false claim that compiles once somebody adds a cast. | Read the producer, not the name. Both are now commented to say which they are. |
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

> **A rule in this document is not enforcement.** Both shapes above were
> already listed as forbidden here, correctly, and both still shipped — the
> gate simply had no pattern for either. **If you add a row to the tables
> above, add the matching `FORBIDDEN_PATTERNS` entry in the same change**, or
> you have written documentation, not a rule. (Rules 29 and 30 were added
> 2026-11-10, after the two bugs, to close exactly this gap. Rule 31
> followed on 2026-11-13, after a third.)

> **And where the TYPE can say it, let the type say it.** Rule 31's regex
> matches argument NAMES, so it only ever catches the spellings somebody
> thought of. The real guard for that bug is the signature: `bizDateKey`
> takes `(string & { __brand?: undefined }) | IsoInstant | Date`, so handing
> it a branded `EtDateKey` fails `tsc` whatever the variable is called. A
> regex is the fallback for values the brand cannot reach — a date-key field
> still typed `string`, or one arriving through `as any`.
> `web-date-helpers.test.ts` holds both the signature and the brand in place;
> widening either would delete the compile error without failing anything
> else.


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

The helpers in `apps/api/src/lib/dates.ts` and `apps/web/src/lib/dates.ts`
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
