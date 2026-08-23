
/** A YYYY-MM-DD ET calendar-day string. Produced by every helper below
 *  (bizToday, bizAddDays, bizDateKey, …) and by every Prisma schema
 *  String field whose intent is a date-key (workdayDate,
 *  nextStartOverride, inServiceDate, entryDate). Consumers that do
 *  calendar arithmetic on keys (bizAddDays, bizDaysBetween, etAddDays,
 *  etMidnight, etInstantFromParts) REQUIRE this brand — a raw `string`
 *  won't type-check without an explicit `etDateKey()` cast. */
const BIZ_TZ = "America/New_York";

function isValidDateInput(d: string | Date): boolean {
  const dt = typeof d === "string" ? new Date(d) : d;
  return !isNaN(dt.getTime());
}

export type EtDateKey = string & { readonly __brand: "EtDateKey" };

/** A full ISO datetime string with a time component (unambiguous
 *  UTC instant). Produced by every Prisma DateTime field's JSON
 *  serialization + every helper that returns an instant. */
export type IsoInstant = string & { readonly __brand: "IsoInstant" };

/** Validate + brand a string as an EtDateKey. Throws on bad shape (not
 *  YYYY-MM-DD, not a real calendar day like "2026-02-30"). Use this at
 *  trusted boundaries where the shape is genuinely known but the type
 *  hasn't been branded yet (e.g. a hard-coded literal, a URL param
 *  after regex validation). Never cast (`as EtDateKey`) directly. */
export function etDateKey(s: string): EtDateKey {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(`etDateKey: not a YYYY-MM-DD string: ${s}`);
  }
  const [y, m, d] = s.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) {
    throw new Error(`etDateKey: month/day out of range: ${s}`);
  }
  // Round-trip verify against JS Date to catch impossible dates
  // (Feb 30, Apr 31, etc.).
  const probe = new Date(Date.UTC(y, m - 1, d, 12));
  if (probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    throw new Error(`etDateKey: not a real calendar day: ${s}`);
  }
  return s as EtDateKey;
}

/** Validate + brand a string as an IsoInstant. Throws on non-parseable
 *  input. Use at trusted boundaries where the string is guaranteed to
 *  be an ISO datetime (e.g. Prisma DateTime serialization). */
export function isoInstant(s: string): IsoInstant {
  if (isNaN(new Date(s).getTime())) {
    throw new Error(`isoInstant: not a parseable date string: ${s}`);
  }
  return s as IsoInstant;
}

/** Regex for a YYYY-MM-DD ET calendar-day KEY (no time component).
 *  When a formatter sees this shape, it MUST route through the
 *  date-key path — parsing the string with `new Date()` treats it as
 *  UTC midnight, and formatting that instant in ET (UTC-4/-5) rolls
 *  the wall-clock BACK to 8pm the previous calendar day. That produced
 *  operator-facing off-by-one bugs. This regex is the branch discriminator
 *  every formatter below shares. */
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Turn any legal date-shaped input into a Date instant that formatters
 *  can safely feed to `Intl.DateTimeFormat({ timeZone: BIZ_TZ })` without
 *  rolling the calendar day. Two branches:
 *
 *    1. If `d` is a YYYY-MM-DD string, build a Date at UTC noon of that
 *       day. Noon UTC lands squarely mid-day in any timezone — the
 *       calendar day never rolls under ET or any other offset.
 *
 *    2. Otherwise (Date object OR ISO string with a time component),
 *       parse as-is. Full ISO strings carry a `T` and are unambiguous;
 *       Date objects are already instants.
 *
 *  Returns null on invalid input so the formatter can render "—". */
function toDisplayInstant(d: string | Date): Date | null {
  if (typeof d === "string") {
    if (DATE_KEY_RE.test(d)) {
      const [y, m, day] = d.split("-").map(Number);
      // Reject nonsense month/day values before construction — JS Date
      // would silently roll them (e.g. "2026-13-45" becomes 2027-02-14
      // via month + day overflow). We want invalid input to render "—",
      // not a wrong-but-plausible date.
      if (m < 1 || m > 12 || day < 1 || day > 31) return null;
      // UTC-noon anchor guarantees no calendar-day roll under any TZ.
      const utcNoon = new Date(Date.UTC(y, m - 1, day, 12));
      // Round-trip verify — catches dates that don't exist in a given
      // month (Feb 30, Apr 31, etc.) which the range check above misses.
      if (
        utcNoon.getUTCFullYear() !== y ||
        utcNoon.getUTCMonth() !== m - 1 ||
        utcNoon.getUTCDate() !== day
      ) {
        return null;
      }
      return utcNoon;
    }
    const parsed = new Date(d);
    return isNaN(parsed.getTime()) ? null : parsed;
  }
  return isNaN(d.getTime()) ? null : d;
}

/** Format a date as a short date string in business timezone (Eastern).
 *  Accepts a Date, a full ISO datetime string, OR a YYYY-MM-DD calendar
 *  key — all three shapes render correctly. Callers do not need to
 *  distinguish key from instant; the helper does. */
export function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return "—";
  const instant = toDisplayInstant(d);
  if (!instant) return "—";
  return instant.toLocaleDateString("en-US", { timeZone: BIZ_TZ });
}

/** Format a YYYY-MM-DD ET calendar-day string as a short display date
 *  ("8/12/2026") in the business timezone. Prefer this over `fmtDate()`
 *  when you know your input is a date-key — it makes intent explicit
 *  at the callsite AND is stricter (rejects anything non-YYYY-MM-DD).
 *
 *  `fmtDate()` will also produce the correct display for a date-key
 *  input (it routes through the same path internally), so a mistaken
 *  call there is not a bug. This exported helper is for clarity, not
 *  correctness. */
export function fmtDateKey(key: string | null | undefined): string {
  if (!key || !DATE_KEY_RE.test(key)) return "—";
  const [y, m, d] = key.split("-").map(Number);
  const utcNoon = new Date(Date.UTC(y, m - 1, d, 12));
  return utcNoon.toLocaleDateString("en-US", { timeZone: BIZ_TZ });
}

/** Format a date+time string in business timezone (Eastern). Accepts
 *  every shape fmtDate does; a bare YYYY-MM-DD key renders with the
 *  time as 8am ET (UTC-noon anchor). */
export function fmtDateTime(d: string | Date | null | undefined): string {
  if (!d) return "—";
  const instant = toDisplayInstant(d);
  if (!instant) return "—";
  return instant.toLocaleString("en-US", { timeZone: BIZ_TZ });
}

/** Format a date with weekday in business timezone. Same shape-agnostic
 *  behavior as fmtDate. */
export function fmtDateWeekday(d: string | Date | null | undefined, opts?: { year?: boolean }): string {
  if (!d) return "—";
  const instant = toDisplayInstant(d);
  if (!instant) return "—";
  return instant.toLocaleDateString("en-US", {
    timeZone: BIZ_TZ,
    weekday: "long",
    month: "short",
    day: "numeric",
    ...(opts?.year ? { year: "numeric" } : {}),
  });
}

/** "Aug 12" — short month + day, no year. Convenience wrapper over
 *  fmtDateOpts. Use this instead of defining a local `fmtDate` helper
 *  in your file with the same options; local redefinitions shadow the
 *  canonical helper and broaden the blast radius of every future
 *  date-shape mistake. Same shape-agnostic input handling as fmtDate. */
export function fmtDateShort(d: string | Date | null | undefined): string {
  return fmtDateOpts(d, { month: "short", day: "numeric" });
}

/** "Aug 12, 2026" — short month + day + year. Same rationale as
 *  fmtDateShort above: use this named export instead of a local wrapper. */
export function fmtDateLong(d: string | Date | null | undefined): string {
  return fmtDateOpts(d, { month: "short", day: "numeric", year: "numeric" });
}

/** Flexible escape hatch for one-off display formats. Always ET-anchored
 *  (timeZone is forced). Use this when fmtDate / fmtDateWeekday don't
 *  produce the exact shape you need — for example "Jun 6" without the
 *  weekday. NEVER call `.toLocaleDateString(undefined, ...)` directly.
 *  Same shape-agnostic input handling as fmtDate. */
export function fmtDateOpts(
  d: string | Date | null | undefined,
  opts: Intl.DateTimeFormatOptions,
): string {
  if (!d) return "—";
  const instant = toDisplayInstant(d);
  if (!instant) return "—";
  return instant.toLocaleDateString("en-US", { timeZone: BIZ_TZ, ...opts });
}

/** Flexible escape hatch for one-off time formats. Always ET-anchored.
 *  A bare YYYY-MM-DD key renders as 8am ET (UTC-noon anchor); prefer
 *  fmtDate for date-only display since a time on a date-key is
 *  meaningless. */
export function fmtTimeOpts(
  d: string | Date | null | undefined,
  opts: Intl.DateTimeFormatOptions,
): string {
  if (!d) return "—";
  const instant = toDisplayInstant(d);
  if (!instant) return "—";
  return instant.toLocaleTimeString("en-US", { timeZone: BIZ_TZ, ...opts });
}

/** Extract the ET wall-clock time-of-day as "HH:MM" (24h) from an
 *  instant. Use when you need to preserve the source's time-of-day
 *  across a date-shift operation — e.g. rescheduling a 2 PM ET job
 *  to a different day should still land at 2 PM ET, not at some
 *  arbitrary UTC-anchored hour.
 *
 *  Pair with `bizInstantFromEtParts(newDateKey, bizHourMinute(source))`
 *  to build a new instant that inherits the source's ET wall-clock. */
export function bizHourMinute(d: Date | string): string {
  return new Date(d).toLocaleTimeString("en-GB", {
    timeZone: BIZ_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** Current hour in ET (0-23). Use this for "is it morning?" / "good
 *  evening" / time-of-day-aware UI logic instead of `new Date().getHours()`
 *  (which would use the browser's local timezone — wrong for a user
 *  outside ET). Falls back to 12 (midday) if Intl is unavailable so the
 *  fallback never produces a wildly different result.
 *
 *  Uses `hourCycle: "h23"` to force the 0-23 range. Without it, `en-US`
 *  with `hour12: false` reports midnight as "24" (h24 cycle), which
 *  fails the "0-23" contract every day at midnight ET. */
export function bizHour(): number {
  try {
    return parseInt(
      new Intl.DateTimeFormat("en-US", {
        timeZone: BIZ_TZ,
        hour: "2-digit",
        hourCycle: "h23",
      }).format(new Date()),
      10,
    );
  } catch {
    return 12;
  }
}

/** Current month (1-12) in ET. Use this for season/quarter detection
 *  instead of `new Date().getMonth() + 1`. */
export function bizMonth(): number {
  try {
    return parseInt(
      new Intl.DateTimeFormat("en-US", {
        timeZone: BIZ_TZ,
        month: "2-digit",
      }).format(new Date()),
      10,
    );
  } catch {
    return 1;
  }
}

/** Build a `<input type="datetime-local">` value (YYYY-MM-DDTHH:mm) from
 *  any Date / ISO string, ET-anchored. Pair with
 *  `bizParseLocalInputValue` on submit so the round-trip is consistent.
 *
 *  The HTML spec says `<input type="datetime-local">` `value` is in the
 *  user's local timezone. For an ET-anchored business, we instead show
 *  ET-equivalent wall-clock time so the operator sees what they expect
 *  regardless of their device clock. */
export function bizToLocalInputValue(d: Date | string): string {
  if (!d) return "";
  const date = bizDateKey(d);
  // bizDateKey returns "" for invalid input — propagate that here rather
  // than emitting "TInvalid Date" which would break <input type="datetime-local">.
  if (!date) return "";
  const time = new Date(d).toLocaleTimeString("en-GB", {
    timeZone: BIZ_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${date}T${time}`;
}

/** Parse a `<input type="datetime-local">` value as an ET wall-clock
 *  time, returning a UTC ISO instant. The naive
 *  `new Date(value).toISOString()` interprets the value in the browser's
 *  local timezone — fine when the operator is in ET, wrong everywhere
 *  else. Always route datetime-local submissions through this helper.
 *
 *  Returns `""` for empty input. Throws if the value can't be split into
 *  date + time parts. */
export function bizParseLocalInputValue(value: string): string {
  if (!value) return "";
  const [date, time] = value.split("T");
  if (!date || !time) {
    throw new Error(`bizParseLocalInputValue: not a valid YYYY-MM-DDTHH:mm value: ${value}`);
  }
  // `date` comes from the value's own split — the input contract guarantees
  // YYYY-MM-DD. Safe to brand at this trusted boundary.
  return bizInstantFromEtParts(date as EtDateKey, time);
}

/** Build a UTC ISO instant from an ET wall-clock date + time.
 *
 *  Use when the operator types something like "9:00 on June 6" in a
 *  date+time picker and we need an absolute instant for storage. The
 *  naive `new Date(date + "T" + time).toISOString()` interprets the
 *  string in the BROWSER's local timezone — fine when the operator is
 *  in ET, wrong if they're traveling or the dialog is open on a
 *  worker/client device in another zone. This helper always anchors
 *  the wall-clock interpretation to America/New_York, automatically
 *  picking the EDT (UTC-4) vs EST (UTC-5) offset for the given date.
 *
 *  Returns an ISO string ending in `.000Z` (UTC) so the backend can
 *  store it as a Prisma DateTime without any further conversion. */
export function bizInstantFromEtParts(dateKey: EtDateKey, time: string): string {
  // dateKey: "YYYY-MM-DD", time: "HH:MM" (24-hour) or "HH:MM:SS"
  if (!dateKey || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return "";
  const [y, m, d] = dateKey.split("-").map(Number);
  const timeParts = time.split(":").map(Number);
  const hh = timeParts[0] ?? 0;
  const mm = timeParts[1] ?? 0;
  const ss = timeParts[2] ?? 0;
  // Try BOTH candidate offsets (EDT and EST) and verify which one
  // round-trips to the requested wall-clock time when formatted in ET.
  // A naive single-probe approach (e.g. "probe noon UTC and pick the
  // offset that applies") gets the WRONG answer for times before 2 AM
  // on a DST spring-forward day, because the noon-UTC probe is on the
  // AFTER-shift side while the requested time is on the BEFORE-shift
  // side. The round-trip check is correct in every case.
  //
  // Ambiguous fall-back times (e.g. 1:30 AM on Nov 1) match BOTH
  // candidates. We deterministically prefer the EARLIER occurrence
  // (EDT, the first 1:30) so the round-trip is predictable.
  // Non-existent spring-forward times (e.g. 2:30 AM on Mar 8) match
  // NEITHER candidate. We fall back to EDT (the offset that would have
  // applied had the shift not happened) so we don't throw.
  const expected =
    String(hh).padStart(2, "0") + ":" +
    String(mm).padStart(2, "0") + ":" +
    String(ss).padStart(2, "0");
  const verifier = new Intl.DateTimeFormat("en-CA", {
    timeZone: BIZ_TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
  // Try EDT first so ambiguous fall-back times pick the earlier instance.
  for (const offsetHours of [4, 5]) {
    const candidate = new Date(Date.UTC(y, m - 1, d, hh + offsetHours, mm, ss));
    const parts = Object.fromEntries(
      verifier.formatToParts(candidate).map((p) => [p.type, p.value]),
    );
    const formattedKey = `${parts.year}-${parts.month}-${parts.day}`;
    // Intl returns "24" for midnight in some browsers; normalize.
    const hourStr = parts.hour === "24" ? "00" : parts.hour;
    const formattedTime = `${hourStr}:${parts.minute}:${parts.second}`;
    if (formattedKey === dateKey && formattedTime === expected) {
      return candidate.toISOString();
    }
  }
  // Spring-forward gap (the requested time doesn't exist). Fall back to
  // the EDT interpretation — that's what the user would get if they
  // typed the same value 5 minutes later.
  return new Date(Date.UTC(y, m - 1, d, hh + 4, mm, ss)).toISOString();
}

/** Get the YYYY-MM-DD date string in business timezone (Eastern). The
 *  canonical key format for date inputs, URL params, localStorage keys,
 *  and any string-based date comparison.
 *
 *  ALWAYS use this instead of `.toISOString().slice(0, 10)` or
 *  `${y}-${m}-${d}` template literals built from `.getDate()` etc. */
export function bizDateKey(d: string | Date): EtDateKey {
  const dt = typeof d === "string" ? new Date(d) : d;
  // Invalid input yields "" rather than the literal string "Invalid Date"
  // — silent failure here surfaces upstream as the canonical "no value"
  // signal that the rest of the helpers (fmtDate etc.) already treat as
  // missing.
  if (isNaN(dt.getTime())) return "" as EtDateKey;
  return dt.toLocaleDateString("en-CA", { timeZone: BIZ_TZ }) as EtDateKey; // en-CA gives YYYY-MM-DD
}

/** Today's date as YYYY-MM-DD in Eastern Time. */
export function bizToday(): EtDateKey {
  return bizDateKey(new Date());
}

/** Tomorrow's date as YYYY-MM-DD in Eastern Time. Routes through
 *  bizAddDays on the bizToday() key — the previous `Date.now() + 86_400_000`
 *  pattern was DST-fragile when invoked within an hour of midnight ET on
 *  spring-forward / fall-back days (adding exactly 24 hours could land on
 *  the day-after-tomorrow or stay on today). */
export function bizTomorrow(): EtDateKey {
  return bizAddDays(bizToday(), 1);
}

/** Yesterday's date as YYYY-MM-DD in Eastern Time. Same DST-safety
 *  rationale as bizTomorrow above. */
export function bizYesterday(): EtDateKey {
  return bizAddDays(bizToday(), -1);
}

/** Add N days to a YYYY-MM-DD string, returning a new YYYY-MM-DD string.
 *  Handles month/year boundary rollover via the JS Date constructor's
 *  natural overflow semantics. Works in UTC noon to dodge DST edges.
 *  Returns "" if the input key isn't a valid YYYY-MM-DD — propagates
 *  the "invalid input" signal rather than producing a garbage Date that
 *  crashes Intl.format downstream. */
export function bizAddDays(key: EtDateKey, n: number): EtDateKey {
  if (!key || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return "" as EtDateKey;
  const [y, m, d] = key.split("-").map(Number);
  const utcNoon = new Date(Date.UTC(y, m - 1, d + n, 12));
  return new Intl.DateTimeFormat("en-CA", { timeZone: BIZ_TZ }).format(utcNoon) as EtDateKey;
}

/** Add N calendar months to a YYYY-MM-DD string. Day-of-month is CLAMPED
 *  to the last valid day of the target month — "the same day next month,
 *  or the last day of next month if that day doesn't exist." Use this
 *  instead of `d.setMonth(d.getMonth() + n)` on browser-local Date
 *  instants.
 *
 *  Examples:
 *    bizAddMonths("2026-01-31", 1) → "2026-02-28"  (clamped, not Mar 3)
 *    bizAddMonths("2024-01-31", 1) → "2024-02-29"  (clamped, leap year)
 *    bizAddMonths("2026-03-31", 1) → "2026-04-30"  (clamped, April has 30)
 *    bizAddMonths("2026-06-15", 1) → "2026-07-15"  (normal case)
 *    bizAddMonths("2025-12-15", 1) → "2026-01-15"  (year boundary)
 */
export function bizAddMonths(key: EtDateKey, n: number): EtDateKey {
  if (!key || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return "" as EtDateKey;
  const [y, m, d] = key.split("-").map(Number);
  // The last day of the target month: pass day 0 of (target + 1) — JS
  // Date constructor interprets day 0 as the last day of the prior month.
  // Use UTC throughout to dodge DST + browser-local quirks.
  const lastDayOfTargetMonth = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  const clampedDay = Math.min(d, lastDayOfTargetMonth);
  const utcNoon = new Date(Date.UTC(y, m - 1 + n, clampedDay, 12));
  return new Intl.DateTimeFormat("en-CA", { timeZone: BIZ_TZ }).format(utcNoon) as EtDateKey;
}

/** Add N calendar years to a YYYY-MM-DD string. Day-of-month is CLAMPED:
 *  Feb 29 in a leap year + 1 year → Feb 28 of the next (non-leap) year,
 *  NOT Mar 1 (which is what JS Date overflow would produce).
 *
 *  Examples:
 *    bizAddYears("2024-02-29", 1) → "2025-02-28"  (clamped, non-leap)
 *    bizAddYears("2024-02-29", 4) → "2028-02-29"  (target is also leap)
 *    bizAddYears("2026-06-15", 1) → "2027-06-15"  (normal case)
 */
export function bizAddYears(key: EtDateKey, n: number): EtDateKey {
  if (!key || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return "" as EtDateKey;
  const [y, m, d] = key.split("-").map(Number);
  const lastDayOfTargetMonth = new Date(Date.UTC(y + n, m, 0)).getUTCDate();
  const clampedDay = Math.min(d, lastDayOfTargetMonth);
  const utcNoon = new Date(Date.UTC(y + n, m - 1, clampedDay, 12));
  return new Intl.DateTimeFormat("en-CA", { timeZone: BIZ_TZ }).format(utcNoon) as EtDateKey;
}

/** Extract the year portion of a YYYY-MM-DD key as a number. Pure string
 *  math — no timezone risk. Use this instead of `new Date(key).getFullYear()`. */
export function bizYearOf(key: EtDateKey): number {
  if (!key || !/^\d{4}/.test(key)) return NaN;
  return parseInt(key.slice(0, 4), 10);
}

/** Number of calendar days from `fromKey` to `toKey`, ET-anchored. Returns
 *  a signed integer: positive if `toKey` is later, negative if earlier.
 *
 *  Use this instead of `Math.round((d1.getTime() - d2.getTime()) / 86_400_000)`
 *  — that pattern silently drifts by an hour across DST boundaries and can
 *  round up / down to the wrong day count.
 *
 *  Both inputs MUST be YYYY-MM-DD strings (no time component). For mixed
 *  Date / ISO inputs, convert via `bizDateKey(d)` first. */
export function bizDaysBetween(fromKey: EtDateKey, toKey: EtDateKey): number {
  if (!fromKey || !toKey || !/^\d{4}-\d{2}-\d{2}$/.test(fromKey) || !/^\d{4}-\d{2}-\d{2}$/.test(toKey)) return NaN;
  const [fy, fm, fd] = fromKey.split("-").map(Number);
  const [ty, tm, td] = toKey.split("-").map(Number);
  // Use UTC noon for both ends so DST has no effect: noon UTC × 24h is
  // always exactly 86_400_000 ms apart.
  const fromUtc = Date.UTC(fy, fm - 1, fd, 12);
  const toUtc = Date.UTC(ty, tm - 1, td, 12);
  return Math.round((toUtc - fromUtc) / 86_400_000);
}

/** The Monday on-or-before today, as YYYY-MM-DD in Eastern Time. The
 *  canonical week-start for the operator's calendar. */
export function bizMondayOnOrBefore(): EtDateKey {
  const today = bizToday();
  const [y, m, d] = today.split("-").map(Number);
  const utcNoon = new Date(Date.UTC(y, m - 1, d, 12));
  const dow = utcNoon.getUTCDay(); // 0 = Sun ... 6 = Sat
  const daysBack = dow === 0 ? 6 : dow - 1;
  return bizAddDays(today, -daysBack);
}

/** First day of the current month as YYYY-MM-DD in Eastern Time. */
export function bizStartOfMonth(): EtDateKey {
  return `${bizToday().slice(0, 7)}-01` as EtDateKey;
}

/** January 1st of the current year as YYYY-MM-DD in Eastern Time. */
export function bizStartOfYear(): EtDateKey {
  return `${bizToday().slice(0, 4)}-01-01` as EtDateKey;
}

export function prettyDate(iso?: string | null) {
  if (!iso) return "—";
  const instant = toDisplayInstant(iso);
  if (!instant) return "—";
  try {
    // ET-anchored. `toLocaleString([], opts)` defaults to the browser's
    // local timezone — that emits PST/CST/etc. text for non-ET users,
    // which contradicts the rest of the app's ET pinning. Always force
    // `timeZone: BIZ_TZ` here, same as fmtDateTime + friends. Accepts
    // any shape fmtDate does (Date, ISO datetime string, YYYY-MM-DD key).
    return instant.toLocaleString("en-US", {
      timeZone: BIZ_TZ,
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso || "—";
  }
}
